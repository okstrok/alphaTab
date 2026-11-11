/** Conversions between frequencies, MIDI note numbers and note names for the DevTest tuner. */

const SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

export interface NoteReading {
    /** Nearest MIDI note number (69 = A4). */
    midi: number;
    /** Note name without octave, e.g. `F♯`. */
    name: string;
    /** Scientific pitch octave, e.g. 4 for A4. */
    octave: number;
    /** Deviation from the nearest note in cents, -50..+50. */
    cents: number;
}

export function frequencyToMidi(frequency: number, a4: number = 440): number {
    return 69 + 12 * Math.log2(frequency / a4);
}

export function midiToFrequency(midi: number, a4: number = 440): number {
    return a4 * 2 ** ((midi - 69) / 12);
}

/** Cents from `target` (a MIDI note) to `frequency`; positive means sharp. */
export function centsFrom(frequency: number, targetMidi: number, a4: number = 440): number {
    return (frequencyToMidi(frequency, a4) - targetMidi) * 100;
}

export function midiToName(midi: number): { name: string; octave: number } {
    const rounded = Math.round(midi);
    return {
        name: SHARP_NAMES[((rounded % 12) + 12) % 12],
        octave: Math.floor(rounded / 12) - 1
    };
}

export function frequencyToNote(frequency: number, a4: number = 440): NoteReading {
    const exact = frequencyToMidi(frequency, a4);
    const midi = Math.round(exact);
    return { midi, ...midiToName(midi), cents: (exact - midi) * 100 };
}

/**
 * The string of `tuning` (MIDI notes) closest to `frequency`, measured in cents.
 * Returns the index into `tuning`.
 */
export function closestString(frequency: number, tuning: number[], a4: number = 440): number {
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < tuning.length; i++) {
        const distance = Math.abs(centsFrom(frequency, tuning[i], a4));
        if (distance < bestDistance) {
            bestDistance = distance;
            best = i;
        }
    }
    return best;
}
