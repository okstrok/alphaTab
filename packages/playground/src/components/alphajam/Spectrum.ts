/**
 * Magnitude spectrum of a Hann-windowed frame with an in-place radix-2 FFT.
 *
 * Computed in JavaScript rather than with `AnalyserNode.getFloatFrequencyData` so the chord check
 * sees exactly the same numbers live and in the unit tests. DOM-free.
 */
export class Spectrum {
    public readonly size: number;
    private readonly _window: Float32Array;
    private readonly _re: Float32Array;
    private readonly _im: Float32Array;
    private readonly _cos: Float32Array;
    private readonly _sin: Float32Array;
    private readonly _reversed: Uint32Array;

    public constructor(size: number) {
        if (size < 2 || (size & (size - 1)) !== 0) {
            throw new Error(`Spectrum size must be a power of two, got ${size}`);
        }
        this.size = size;
        this._window = new Float32Array(size);
        for (let i = 0; i < size; i++) {
            this._window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
        }
        this._re = new Float32Array(size);
        this._im = new Float32Array(size);
        this._cos = new Float32Array(size / 2);
        this._sin = new Float32Array(size / 2);
        for (let i = 0; i < size / 2; i++) {
            this._cos[i] = Math.cos((-2 * Math.PI * i) / size);
            this._sin[i] = Math.sin((-2 * Math.PI * i) / size);
        }
        const bits = Math.log2(size);
        this._reversed = new Uint32Array(size);
        for (let i = 0; i < size; i++) {
            let r = 0;
            for (let b = 0; b < bits; b++) {
                r = (r << 1) | ((i >> b) & 1);
            }
            this._reversed[i] = r;
        }
    }

    /** Hz per bin at `sampleRate`. */
    public binWidth(sampleRate: number): number {
        return sampleRate / this.size;
    }

    /**
     * Magnitudes of bins `0..size/2` of the last `size` samples of `frame` (zero-padded when shorter).
     * Writes into `out` when given.
     */
    public magnitudes(frame: Float32Array, out?: Float32Array): Float32Array {
        const n = this.size;
        const re = this._re;
        const im = this._im;
        const offset = frame.length - n;
        for (let i = 0; i < n; i++) {
            const source = offset + i;
            const value = source >= 0 ? frame[source] * this._window[i] : 0;
            const j = this._reversed[i];
            re[j] = value;
            im[j] = 0;
        }
        for (let half = 1; half < n; half <<= 1) {
            const step = n / (half * 2);
            for (let start = 0; start < n; start += half * 2) {
                for (let k = 0; k < half; k++) {
                    const c = this._cos[k * step];
                    const s = this._sin[k * step];
                    const a = start + k;
                    const b = a + half;
                    const tr = re[b] * c - im[b] * s;
                    const ti = re[b] * s + im[b] * c;
                    re[b] = re[a] - tr;
                    im[b] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                }
            }
        }
        const bins = n / 2 + 1;
        const result = out && out.length === bins ? out : new Float32Array(bins);
        for (let i = 0; i < bins; i++) {
            result[i] = Math.hypot(re[i], im[i]);
        }
        return result;
    }
}
