import { midiToFrequency } from '../devtest/Notes';

/**
 * Score-informed note presence for chords.
 *
 * Telling which notes sound in an arbitrary guitar chord (blind polyphonic transcription) is hard
 * even with a clean DI signal: the partials of chord notes overlap. alphaJam only needs to verify
 * what the score expects, so it asks, for each expected note, whether the spectrum has a harmonic
 * series at that pitch standing out of the noise floor, and whether its fundamental is a real
 * spectral peak. The fundamental carries the octave: a note an octave higher shares only the even
 * harmonics of the expected one, and the overtones of other chord notes can imitate the upper
 * partials of a missing note, but rarely its fundamental. A DI signal keeps the fundamental strong.
 */

export interface PresenceOptions {
    sampleRate: number;
    /** FFT size the magnitudes were computed with. */
    fftSize: number;
    a4?: number;
}

/** Harmonics weighed per note, and their weights (the fundamental counts most). */
const HARMONIC_WEIGHTS = [1, 0.8, 0.7, 0.5, 0.4, 0.3];
/** Search radius around each harmonic in cents. */
const SEARCH_CENTS = 40;
/** Average dB above the noise floor over all harmonics for a note to count as sounding. */
const MIN_SERIES_DB = 12;
/** dB above the floor the fundamental needs. */
const MIN_FUNDAMENTAL_DB = 14;
/** The fundamental may be at most this many dB below the loudest bin of the spectrum. */
const MAX_FUNDAMENTAL_BELOW_PEAK_DB = 30;
/** Notes quieter than this many dB below the loudest expected note are treated as not played. */
const MAX_BELOW_LOUDEST_DB = 30;
/** Range the noise floor is measured in. */
const FLOOR_RANGE_HZ = [60, 5000] as const;

export interface NoteSalience {
    midi: number;
    /** Weighted mean dB above the noise floor over the harmonic series. */
    seriesDb: number;
    /** dB above the floor of the fundamental; 0 when there is no spectral peak at the fundamental. */
    fundamentalDb: number;
    /** Magnitude of the fundamental's peak, 0 when there is none. */
    fundamental: number;
}

function toDb(ratio: number): number {
    return 20 * Math.log10(Math.max(ratio, 1e-6));
}

/** Median magnitude in the floor range: most bins between partials hold only noise. */
export function noiseFloor(magnitudes: Float32Array, options: PresenceOptions): number {
    const binWidth = options.sampleRate / options.fftSize;
    const from = Math.max(1, Math.floor(FLOOR_RANGE_HZ[0] / binWidth));
    const to = Math.min(magnitudes.length - 1, Math.ceil(FLOOR_RANGE_HZ[1] / binWidth));
    const values = Array.from(magnitudes.subarray(from, to + 1)).sort((a, b) => a - b);
    return Math.max(values[values.length >> 1] ?? 0, 1e-9);
}

/**
 * The largest magnitude around `frequency`. With `localPeak`, only local maxima of the spectrum
 * count whose interpolated frequency is within the search radius, so neither the slope of a strong
 * neighbouring partial nor a peak a semitone away is taken for the note.
 */
function peakAround(magnitudes: Float32Array, frequency: number, binWidth: number, localPeak = false): number {
    const ratio = 2 ** (SEARCH_CENTS / 1200);
    const from = Math.max(1, Math.floor(Math.min(frequency / ratio / binWidth, frequency / binWidth - 1)));
    const to = Math.min(
        magnitudes.length - 2,
        Math.ceil(Math.max((frequency * ratio) / binWidth, frequency / binWidth + 1))
    );
    let peak = 0;
    for (let i = from; i <= to; i++) {
        const m = magnitudes[i];
        if (localPeak) {
            const a = magnitudes[i - 1];
            const c = magnitudes[i + 1];
            if (m < a || m < c) {
                continue;
            }
            // Parabolic interpolation on the log magnitudes for the true peak frequency.
            const la = Math.log(a + 1e-12);
            const lb = Math.log(m + 1e-12);
            const lc = Math.log(c + 1e-12);
            const denominator = la - 2 * lb + lc;
            const offset = denominator === 0 ? 0 : (0.5 * (la - lc)) / denominator;
            const cents = 1200 * Math.log2(((i + offset) * binWidth) / frequency);
            if (Math.abs(cents) > SEARCH_CENTS) {
                continue;
            }
        }
        peak = Math.max(peak, m);
    }
    return peak;
}

export function noteSalience(
    magnitudes: Float32Array,
    midi: number,
    options: PresenceOptions,
    floor: number = noiseFloor(magnitudes, options)
): NoteSalience {
    const binWidth = options.sampleRate / options.fftSize;
    const f0 = midiToFrequency(midi, options.a4 ?? 440);
    const nyquist = options.sampleRate / 2;
    let weighted = 0;
    let weights = 0;
    HARMONIC_WEIGHTS.forEach((weight, i) => {
        const frequency = f0 * (i + 1);
        if (frequency >= nyquist) {
            return;
        }
        const db = Math.max(0, toDb(peakAround(magnitudes, frequency, binWidth) / floor));
        weighted += weight * db;
        weights += weight;
    });
    const fundamental = peakAround(magnitudes, f0, binWidth, true);
    return {
        midi,
        seriesDb: weights > 0 ? weighted / weights : 0,
        fundamentalDb: fundamental > 0 ? Math.max(0, toDb(fundamental / floor)) : 0,
        fundamental
    };
}

/** For each of `midis`, whether that note sounds in the spectrum. */
export function detectPresentNotes(magnitudes: Float32Array, midis: number[], options: PresenceOptions): boolean[] {
    const floor = noiseFloor(magnitudes, options);
    let peak = 0;
    for (let i = 1; i < magnitudes.length; i++) {
        peak = Math.max(peak, magnitudes[i]);
    }
    const saliences = midis.map(m => noteSalience(magnitudes, m, options, floor));
    const loudest = Math.max(0, ...saliences.map(s => s.seriesDb));
    return saliences.map(
        s =>
            s.seriesDb >= MIN_SERIES_DB &&
            s.fundamentalDb >= MIN_FUNDAMENTAL_DB &&
            toDb(s.fundamental / Math.max(peak, 1e-9)) >= -MAX_FUNDAMENTAL_BELOW_PEAK_DB &&
            s.seriesDb >= loudest - MAX_BELOW_LOUDEST_DB
    );
}
