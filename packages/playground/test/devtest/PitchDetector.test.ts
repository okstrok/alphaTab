import { describe, expect, it } from 'vitest';
import { centsFrom, closestString, frequencyToNote, midiToFrequency } from '../../src/components/devtest/Notes';
import { PitchDetector } from '../../src/components/devtest/PitchDetector';

const SAMPLE_RATE = 48000;

/** A plucked-string-like tone: fundamental plus decaying harmonics, optionally with noise. */
function pluck(frequency: number, size: number, options: { noise?: number; fundamental?: number } = {}): Float32Array {
    const frame = new Float32Array(size);
    const harmonics = [options.fundamental ?? 1, 0.6, 0.4, 0.25, 0.15, 0.1];
    let seed = 1234;
    const random = () => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647 - 0.5;
    };
    for (let i = 0; i < size; i++) {
        let v = 0;
        harmonics.forEach((amp, h) => {
            v += amp * Math.sin((2 * Math.PI * frequency * (h + 1) * i) / SAMPLE_RATE + h);
        });
        frame[i] = 0.2 * v + (options.noise ?? 0) * random();
    }
    return frame;
}

function detect(frequency: number, options?: { noise?: number; fundamental?: number }) {
    const detector = new PitchDetector({ sampleRate: SAMPLE_RATE });
    return detector.detect(pluck(frequency, 4096, options));
}

describe('PitchDetector', () => {
    // Standard guitar strings, a bass low E and the 24th fret of the high E string.
    const cases = [41.2, 82.41, 110, 146.83, 196, 246.94, 329.63, 440, 1318.51];
    for (const frequency of cases) {
        it(`detects ${frequency} Hz within 2 cents`, () => {
            const result = detect(frequency);
            expect(result).not.toBeNull();
            expect(Math.abs(1200 * Math.log2(result!.frequency / frequency))).toBeLessThan(2);
        });
    }

    it('does not jump an octave when the fundamental is weaker than the harmonics', () => {
        const result = detect(82.41, { fundamental: 0.3 });
        expect(result).not.toBeNull();
        expect(Math.abs(1200 * Math.log2(result!.frequency / 82.41))).toBeLessThan(5);
    });

    it('still detects with moderate noise', () => {
        const result = detect(196, { noise: 0.1 });
        expect(result).not.toBeNull();
        expect(Math.abs(1200 * Math.log2(result!.frequency / 196))).toBeLessThan(5);
    });

    it('returns null for silence', () => {
        const detector = new PitchDetector({ sampleRate: SAMPLE_RATE });
        expect(detector.detect(new Float32Array(4096))).toBeNull();
    });

    it('returns null for white noise', () => {
        const detector = new PitchDetector({ sampleRate: SAMPLE_RATE });
        const frame = new Float32Array(4096);
        let seed = 42;
        for (let i = 0; i < frame.length; i++) {
            seed = (seed * 16807) % 2147483647;
            frame[i] = seed / 2147483647 - 0.5;
        }
        expect(detector.detect(frame)).toBeNull();
    });

    it('needs a frame that fits the lowest frequency twice', () => {
        const detector = new PitchDetector({ sampleRate: SAMPLE_RATE, minFrequency: 40 });
        expect(detector.requiredFrameSize).toBe(2400);
    });
});

describe('Notes', () => {
    it('names A4 and middle C', () => {
        expect(frequencyToNote(440)).toMatchObject({ midi: 69, name: 'A', octave: 4 });
        expect(frequencyToNote(261.63)).toMatchObject({ midi: 60, name: 'C', octave: 4 });
        expect(frequencyToNote(82.41)).toMatchObject({ midi: 40, name: 'E', octave: 2 });
    });

    it('measures cents', () => {
        expect(centsFrom(440, 69)).toBeCloseTo(0, 5);
        expect(centsFrom(midiToFrequency(69.1), 69)).toBeCloseTo(10, 5);
        expect(frequencyToNote(432, 432).cents).toBeCloseTo(0, 5);
    });

    it('finds the closest string of standard tuning', () => {
        const standard = [40, 45, 50, 55, 59, 64];
        expect(closestString(83, standard)).toBe(0);
        expect(closestString(108, standard)).toBe(1);
        expect(closestString(250, standard)).toBe(4);
        expect(closestString(320, standard)).toBe(5);
    });
});
