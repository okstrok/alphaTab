/**
 * Monophonic pitch detection with the YIN algorithm (de Cheveigné & Kawahara, 2002).
 *
 * Pure and DOM-free so it can run on the main thread today and move into an AudioWorklet
 * later, when DevTest grows from a tuner into note-by-note play-along scoring.
 */

export interface PitchDetectorOptions {
    /** Sample rate of the analysed signal in Hz. */
    sampleRate: number;
    /** Lowest detectable frequency in Hz. 40 Hz covers a 4-string bass low E (41.2 Hz). */
    minFrequency?: number;
    /** Highest detectable frequency in Hz. 1400 Hz covers the 24th fret of a high E string. */
    maxFrequency?: number;
    /**
     * YIN absolute threshold on the cumulative mean normalized difference. Lower is stricter;
     * 0.1–0.15 is typical for plucked strings.
     */
    threshold?: number;
    /** Frames whose RMS is below this level are treated as silence. */
    minRms?: number;
}

export interface PitchResult {
    /** Detected fundamental frequency in Hz. */
    frequency: number;
    /** How periodic the frame is, 0..1 (1 - YIN aperiodicity at the chosen lag). */
    clarity: number;
    /** RMS level of the frame, 0..1 for a normalized float signal. */
    rms: number;
}

export class PitchDetector {
    public readonly sampleRate: number;
    private readonly _minLag: number;
    private readonly _maxLag: number;
    private readonly _threshold: number;
    private readonly _minRms: number;
    private _diff: Float32Array = new Float32Array(0);

    public constructor(options: PitchDetectorOptions) {
        this.sampleRate = options.sampleRate;
        const minFrequency = options.minFrequency ?? 40;
        const maxFrequency = options.maxFrequency ?? 1400;
        this._minLag = Math.max(2, Math.floor(this.sampleRate / maxFrequency));
        this._maxLag = Math.ceil(this.sampleRate / minFrequency);
        this._threshold = options.threshold ?? 0.12;
        this._minRms = options.minRms ?? 0.01;
    }

    /** The number of samples a frame needs so the lowest frequency fits twice. */
    public get requiredFrameSize(): number {
        return this._maxLag * 2;
    }

    /** Detects the fundamental of `frame`, or returns `null` for silence or noise. */
    public detect(frame: Float32Array): PitchResult | null {
        const rms = PitchDetector.rms(frame);
        if (rms < this._minRms) {
            return null;
        }

        const window = Math.floor(frame.length / 2);
        const maxLag = Math.min(this._maxLag, window - 1);
        if (maxLag <= this._minLag) {
            return null;
        }
        if (this._diff.length !== maxLag + 1) {
            this._diff = new Float32Array(maxLag + 1);
        }
        const d = this._diff;

        // Step 2: difference function d(tau).
        d[0] = 0;
        for (let tau = 1; tau <= maxLag; tau++) {
            let sum = 0;
            for (let i = 0; i < window; i++) {
                const delta = frame[i] - frame[i + tau];
                sum += delta * delta;
            }
            d[tau] = sum;
        }

        // Step 3: cumulative mean normalized difference d'(tau), in place.
        d[0] = 1;
        let runningSum = 0;
        for (let tau = 1; tau <= maxLag; tau++) {
            runningSum += d[tau];
            d[tau] = runningSum === 0 ? 1 : (d[tau] * tau) / runningSum;
        }

        // Step 4: first dip below the threshold, walked down to its local minimum.
        let lag = -1;
        for (let tau = this._minLag; tau <= maxLag; tau++) {
            if (d[tau] < this._threshold) {
                while (tau + 1 <= maxLag && d[tau + 1] < d[tau]) {
                    tau++;
                }
                lag = tau;
                break;
            }
        }
        if (lag < 0) {
            return null;
        }

        // Step 5: parabolic interpolation around the minimum for sub-sample accuracy.
        let refinedLag = lag;
        if (lag > 1 && lag < maxLag) {
            const s0 = d[lag - 1];
            const s1 = d[lag];
            const s2 = d[lag + 1];
            const denominator = s0 + s2 - 2 * s1;
            if (denominator !== 0) {
                refinedLag = lag + (s0 - s2) / (2 * denominator);
            }
        }

        return {
            frequency: this.sampleRate / refinedLag,
            clarity: Math.max(0, Math.min(1, 1 - d[lag])),
            rms
        };
    }

    public static rms(frame: Float32Array): number {
        let sum = 0;
        for (let i = 0; i < frame.length; i++) {
            sum += frame[i] * frame[i];
        }
        return Math.sqrt(sum / frame.length);
    }
}
