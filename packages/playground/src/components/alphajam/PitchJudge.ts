import { frequencyToMidi } from '../devtest/Notes';
import type { PitchVerdict } from './JamMatcher';
import { detectPresentNotes, type PresenceOptions } from './NotePresence';

/** One analysis frame of the live input. */
export interface AnalysisFrame {
    /** `performance.now()` time of the frame. */
    time: number;
    /** Monophonic pitch (YIN) in Hz, or null when the frame had no clear single pitch. */
    frequency: number | null;
    /** Magnitude spectrum, on the frames it was computed for. */
    spectrum: Float32Array | null;
}

/** Monophonic pitch readings are taken from this long after the strike (skipping the pick noise)... */
export const PITCH_START_MS = 30;
/** ...up to this long after it. */
export const PITCH_END_MS = 200;
/**
 * Spectra cover the ~170 ms before their frame time, so the chord check uses frames from this long
 * after the strike, when their window holds mostly the new chord...
 */
export const SPECTRUM_START_MS = 140;
/** ...up to this long after it. */
export const SPECTRUM_END_MS = 280;
/** How long after a strike the judge needs audio for. */
export const SETTLE_MS = SPECTRUM_END_MS + 20;
/** Share of the frames a note has to sound in. */
const MIN_SHARE = 0.4;

/**
 * Decides which `midis` sound in the frames after a strike at `strikeTime`. Single notes go by the
 * monophonic pitch (exact octave); chords, and single notes without a clear pitch reading, by the
 * score-informed spectrum check. Matching is by pitch class and octave: an octave error is a miss.
 */
export function judgeFrames(
    frames: readonly AnalysisFrame[],
    strikeTime: number,
    midis: number[],
    options: PresenceOptions
): PitchVerdict {
    const a4 = options.a4 ?? 440;
    const pitchFrames = frames.filter(
        f => f.time >= strikeTime + PITCH_START_MS && f.time <= strikeTime + PITCH_END_MS
    );
    const readings = pitchFrames
        .filter(f => f.frequency !== null)
        .map(f => Math.round(frequencyToMidi(f.frequency!, a4)));
    const played = mostCommon(readings);

    if (midis.length === 1 && readings.length >= 2) {
        const matching = readings.filter(m => m === midis[0]).length;
        return { present: [matching / readings.length >= 0.5], played };
    }

    const spectra = frames.filter(
        f => f.spectrum !== null && f.time >= strikeTime + SPECTRUM_START_MS && f.time <= strikeTime + SPECTRUM_END_MS
    );
    if (spectra.length === 0) {
        return { present: midis.map(() => false), played };
    }
    const counts = midis.map(() => 0);
    for (const frame of spectra) {
        detectPresentNotes(frame.spectrum!, midis, options).forEach((present, i) => {
            if (present) {
                counts[i]++;
            }
        });
    }
    return { present: counts.map(c => c / spectra.length >= MIN_SHARE), played };
}

function mostCommon(values: number[]): number | null {
    const counts = new Map<number, number>();
    let best: number | null = null;
    let bestCount = 0;
    for (const v of values) {
        const count = (counts.get(v) ?? 0) + 1;
        counts.set(v, count);
        if (count > bestCount) {
            best = v;
            bestCount = count;
        }
    }
    return best;
}
