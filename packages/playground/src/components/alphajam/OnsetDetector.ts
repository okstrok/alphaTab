/**
 * Finds the moments a note is struck in the live input. DOM-free.
 *
 * Picked notes and strums show as a quick rise of the signal level. Hammer-ons, pull-offs and
 * slides barely raise the level, so a change of the stable detected pitch counts as a strike too.
 */

export interface OnsetDetectorOptions {
    /** Rise in dB over the recent minimum that marks a strike. */
    riseDb?: number;
    /** Level below which nothing counts as a strike, in dBFS. */
    minDb?: number;
    /** How far back the recent minimum reaches, in milliseconds. */
    lookbackMs?: number;
    /** Shortest time between two strikes, in milliseconds. */
    refractoryMs?: number;
}

export type OnsetKind = 'attack' | 'pitch';

export interface Onset {
    /** `performance.now()` time of the frame the strike was found in. */
    time: number;
    kind: OnsetKind;
}

interface LevelSample {
    time: number;
    db: number;
}

export function rmsToDb(rms: number): number {
    return 20 * Math.log10(Math.max(rms, 1e-9));
}

export class OnsetDetector {
    private readonly _riseDb: number;
    private readonly _minDb: number;
    private readonly _lookbackMs: number;
    private readonly _refractoryMs: number;
    private _history: LevelSample[] = [];
    private _lastOnset = Number.NEGATIVE_INFINITY;
    private _candidateMidi: number | null = null;
    private _candidateCount = 0;
    private _stableMidi: number | null = null;

    public constructor(options: OnsetDetectorOptions = {}) {
        this._riseDb = options.riseDb ?? 6;
        this._minDb = options.minDb ?? -48;
        this._lookbackMs = options.lookbackMs ?? 50;
        this._refractoryMs = options.refractoryMs ?? 70;
    }

    public reset(): void {
        this._history = [];
        this._lastOnset = Number.NEGATIVE_INFINITY;
        this._candidateMidi = null;
        this._candidateCount = 0;
        this._stableMidi = null;
    }

    /**
     * Feeds the level of one short hop (~10 ms) and the detected pitch as rounded MIDI note: `null` for
     * no pitch, `undefined` when no new pitch reading was taken at this hop.
     * Returns the onset found at this hop, if any.
     */
    public process(time: number, rms: number, midi?: number | null): Onset | null {
        const db = rmsToDb(rms);
        let baseline = Number.POSITIVE_INFINITY;
        for (const sample of this._history) {
            if (sample.time >= time - this._lookbackMs) {
                baseline = Math.min(baseline, sample.db);
            }
        }
        this._history.push({ time, db });
        while (this._history.length > 0 && this._history[0].time < time - this._lookbackMs) {
            this._history.shift();
        }

        const loudEnough = db >= this._minDb;
        const ready = time - this._lastOnset >= this._refractoryMs;
        let onset: Onset | null = null;

        if (loudEnough && ready && baseline !== Number.POSITIVE_INFINITY && db - baseline >= this._riseDb) {
            onset = { time, kind: 'attack' };
        }

        // Pitch onsets: a new note held for two pitch readings while the string keeps ringing.
        if (!loudEnough) {
            this._candidateMidi = null;
            this._candidateCount = 0;
            this._stableMidi = null;
        } else if (midi === undefined) {
            // No new pitch reading at this hop.
        } else if (midi === null) {
            this._candidateMidi = null;
            this._candidateCount = 0;
        } else if (midi === this._candidateMidi) {
            this._candidateCount++;
        } else {
            this._candidateMidi = midi;
            this._candidateCount = 1;
        }
        if (
            midi != null &&
            this._candidateMidi !== null &&
            this._candidateCount === 2 &&
            this._candidateMidi !== this._stableMidi
        ) {
            const changed = this._stableMidi !== null;
            this._stableMidi = this._candidateMidi;
            if (!onset && changed && ready) {
                onset = { time, kind: 'pitch' };
            }
        }

        if (onset) {
            this._lastOnset = time;
        }
        return onset;
    }
}
