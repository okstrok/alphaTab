import * as alphaTab from '@coderline/alphatab';
import { describe, expect, it } from 'vitest';
import { CLICKS, evaluateCalibration, LEAD_IN } from '../../src/components/alphajam/Calibration';
import { addResult, EMPTY_STATS, JamMatcher, type PitchVerdict } from '../../src/components/alphajam/JamMatcher';
import { detectPresentNotes } from '../../src/components/alphajam/NotePresence';
import { OnsetDetector } from '../../src/components/alphajam/OnsetDetector';
import { type AnalysisFrame, judgeFrames } from '../../src/components/alphajam/PitchJudge';
import { SongClock } from '../../src/components/alphajam/SongClock';
import {
    collectExpectedEvents,
    type ExpectedEvent,
    isGuitarTrack,
    ticksPerMs
} from '../../src/components/alphajam/SongNotes';
import { Spectrum } from '../../src/components/alphajam/Spectrum';
import { midiToFrequency } from '../../src/components/devtest/Notes';
import { PitchDetector } from '../../src/components/devtest/PitchDetector';

const SAMPLE_RATE = 48000;
const FFT_SIZE = 8192;
const OPTIONS = { sampleRate: SAMPLE_RATE, fftSize: FFT_SIZE };

function loadTex(tex: string) {
    const settings = new alphaTab.Settings();
    const importer = new alphaTab.importer.AlphaTexImporter();
    importer.initFromString(tex, settings);
    const score = importer.readScore();
    const handler = new alphaTab.midi.AlphaSynthMidiFileHandler(new alphaTab.midi.MidiFile());
    const generator = new alphaTab.midi.MidiFileGenerator(score, settings, handler);
    generator.generate();
    return { score, lookup: generator.tickLookup };
}

/** A DI-like guitar signal: each note a plucked string with decaying harmonics, plus a little noise. */
function strum(midis: number[], size: number, noise = 0.002): Float32Array {
    const frame = new Float32Array(size);
    let seed = 42;
    const random = () => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647 - 0.5;
    };
    const harmonics = [1, 0.7, 0.5, 0.35, 0.25, 0.18, 0.12, 0.08];
    for (const [n, midi] of midis.entries()) {
        const f = midiToFrequency(midi);
        for (let i = 0; i < size; i++) {
            let v = 0;
            harmonics.forEach((amp, h) => {
                if (f * (h + 1) < SAMPLE_RATE / 2) {
                    v += amp * Math.sin((2 * Math.PI * f * (h + 1) * i) / SAMPLE_RATE + n + h);
                }
            });
            frame[i] += (0.15 * v) / midis.length;
        }
    }
    for (let i = 0; i < size; i++) {
        frame[i] += noise * random();
    }
    return frame;
}

const spectrum = new Spectrum(FFT_SIZE);
const present = (played: number[], asked: number[]) =>
    detectPresentNotes(spectrum.magnitudes(strum(played, FFT_SIZE)), asked, OPTIONS);

describe('SongNotes', () => {
    it('collects attacks in playback order with absolute ticks, merging chords', () => {
        const { score, lookup } = loadTex(
            '\\track "Guitar" \\tuning E4 B3 G3 D3 A2 E2 . :4 0.6 3.5 (0.6 2.5 2.4) r | 5.6 5.6 :2 5.6'
        );
        const events = collectExpectedEvents(lookup, 0);
        expect(events.map(e => e.tick)).toEqual([0, 960, 1920, 3840, 4800, 5760]);
        expect(events.map(e => e.notes.map(n => n.midi))).toEqual([[40], [48], [40, 47, 52], [45], [45], [45]]);
        expect(isGuitarTrack(score.tracks[0])).toBe(true);
        score.tracks[0].playbackInfo.program = 73; // a flute with a guitar tuning, as in many GP files
        expect(isGuitarTrack(score.tracks[0])).toBe(false);
    });

    it('expands repeats and skips tied notes', () => {
        const { lookup } = loadTex('\\ro :2 0.1 0.1 | \\rc 2 :1 3.1 | :2 3.1 3.1{-} ');
        const events = collectExpectedEvents(lookup, 0);
        // Bars 1-2 twice, then bar 3 whose second note is tied: 4 + 1 + ... events.
        expect(events.map(e => e.notes[0].midi)).toEqual([64, 64, 67, 64, 64, 67, 67]);
        expect(new Set(events.map(e => e.tick)).size).toBe(events.length);
    });

    it('converts tempo to ticks per millisecond', () => {
        expect(ticksPerMs(120)).toBeCloseTo(1.92);
    });
});

describe('NotePresence', () => {
    const E_MAJOR = [40, 47, 52, 56, 59, 64];

    it('finds every note of a full chord', () => {
        expect(present(E_MAJOR, E_MAJOR)).toEqual(E_MAJOR.map(() => true));
    });

    it('notices a note that is not played', () => {
        // E5 power chord asked as E major: the third (G#3 = 56) is missing.
        expect(present([40, 47, 52], [40, 47, 52, 56])).toEqual([true, true, true, false]);
    });

    it('tells a minor from a major chord', () => {
        // A minor (A2 E3 A3 C4 E4) asked as A major (C#4 = 61 instead of C4 = 60).
        expect(present([45, 52, 57, 60, 64], [45, 52, 57, 61, 64])).toEqual([true, true, true, false, true]);
    });

    it('finds the notes of an open G chord', () => {
        const G = [43, 47, 50, 55, 59, 67];
        expect(present(G, G)).toEqual(G.map(() => true));
    });

    it('treats an octave error as a miss', () => {
        expect(present([57], [45])).toEqual([false]);
        expect(present([45], [45])).toEqual([true]);
    });

    it('finds nothing in silence', () => {
        expect(detectPresentNotes(spectrum.magnitudes(new Float32Array(FFT_SIZE)), [40, 52], OPTIONS)).toEqual([
            false,
            false
        ]);
    });
});

describe('PitchJudge', () => {
    function frames(midis: number[], from: number, to: number): AnalysisFrame[] {
        const signal = strum(midis, FFT_SIZE);
        const detector = new PitchDetector({ sampleRate: SAMPLE_RATE, minFrequency: 60 });
        const pitch = detector.detect(signal.subarray(FFT_SIZE - 2048));
        const magnitudes = spectrum.magnitudes(signal);
        const result: AnalysisFrame[] = [];
        for (let t = from; t <= to; t += 20) {
            result.push({
                time: t,
                frequency: midis.length === 1 ? (pitch?.frequency ?? null) : null,
                spectrum: magnitudes
            });
        }
        return result;
    }

    it('judges single notes by their exact pitch', () => {
        expect(judgeFrames(frames([45], 0, 300), 0, [45], OPTIONS)).toEqual({ present: [true], played: 45 });
        expect(judgeFrames(frames([57], 0, 300), 0, [45], OPTIONS).present).toEqual([false]);
    });

    it('judges chords by the spectrum', () => {
        expect(judgeFrames(frames([40, 47, 52], 0, 300), 0, [40, 47, 52], OPTIONS).present).toEqual([true, true, true]);
    });

    it('only looks at the frames after the strike', () => {
        expect(judgeFrames(frames([45], 0, 300), 1000, [45], OPTIONS).present).toEqual([false]);
    });
});

describe('OnsetDetector', () => {
    it('finds picks and legato pitch changes, not sustain', () => {
        const detector = new OnsetDetector();
        const onsets: string[] = [];
        const level = (t: number) => (t < 100 ? 0.0001 : 0.2 * Math.exp(-(t - 100) / 800));
        for (let t = 0; t < 1000; t += 10) {
            // Pitch readings every 20 ms: 40 until 500 ms, then a hammer-on to 42.
            const midi = t % 20 === 0 ? (t < 100 ? null : t < 500 ? 40 : 42) : undefined;
            const onset = detector.process(t, level(t), midi);
            if (onset) {
                onsets.push(`${onset.kind}@${t}`);
            }
        }
        expect(onsets).toEqual(['attack@100', 'pitch@520']);
    });
});

describe('SongClock', () => {
    it('extrapolates between updates and detects jumps', () => {
        const clock = new SongClock();
        const rate = ticksPerMs(120);
        clock.update(1000, 0, 120, true);
        // Not moving yet: a count-in reports "playing" on tick 0.
        expect(clock.tickAt(1500)).toBe(0);
        expect(clock.update(1050, 0, 120, true).jumped).toBe(false);
        expect(clock.isRunning).toBe(false);
        clock.update(1100, 50 * rate, 120, true);
        expect(clock.isRunning).toBe(true);
        expect(clock.tickAt(1600)).toBeCloseTo(550 * rate);
        expect(clock.update(1150, 100 * rate + 5, 120, true).jumped).toBe(false);
        expect(clock.tickAt(1150)).toBeCloseTo(100 * rate + 1);
        expect(clock.update(1200, 9600, 120, true).jumped).toBe(true);
        expect(clock.tickAt(1200)).toBe(9600);
        clock.update(1250, 9600 + 50 * rate, 120, false);
        expect(clock.isRunning).toBe(false);
    });
});

describe('JamMatcher', () => {
    const rate = ticksPerMs(120); // 1.92 ticks/ms, a quarter is 500 ms
    const event = (index: number, tick: number, midis: number[]): ExpectedEvent => ({
        index,
        tick,
        beats: [],
        notes: midis.map((midi, i) => ({ noteId: index * 10 + i, midi }))
    });
    const events = [event(0, 0, [40]), event(1, 960, [45]), event(2, 1920, [40, 47, 52, 56])];
    /** Every strike sounds `heard`. */
    const judgeHearing =
        (heard: number[]) =>
        (_time: number, midis: number[]): PitchVerdict => ({
            present: midis.map(m => heard.includes(m)),
            played: heard[0] ?? null
        });
    const options = { toleranceMs: 100, settleMs: 200 };

    it('scores hits, wrong notes and misses with their timing', () => {
        const matcher = new JamMatcher(events, judgeHearing([40, 47, 52]), options);
        matcher.addStrike(30, 30 * rate); // 30 ms late on E2
        matcher.addStrike(1500, 960 + 40 * rate); // wrong note for A2 (hears E)
        // No strike near the chord at 1000 ms... add one 150 ms off, outside the window.
        matcher.addStrike(1150, 1920 + 150 * rate);
        expect(matcher.update(100 * rate, rate)).toEqual([]);
        const results = matcher.update(4000 * rate, rate);
        expect(results.map(r => r.outcome)).toEqual(['hit', 'wrong', 'missed']);
        expect(results[0].offsetMs).toBeCloseTo(30);
        expect(results[1].played).toBe(40);
    });

    it('accepts a chord with one of four notes missing', () => {
        const matcher = new JamMatcher([events[2]], judgeHearing([40, 47, 52]), options);
        matcher.addStrike(0, 1920);
        expect(matcher.update(1920 + 400 * rate, rate)[0].outcome).toBe('hit');
    });

    it('uses one strike for one note only', () => {
        const close = [event(0, 0, [40]), event(1, 96, [40])]; // 50 ms apart
        const matcher = new JamMatcher(close, judgeHearing([40]), options);
        matcher.addStrike(0, 10);
        expect(matcher.update(2000, rate).map(r => r.outcome)).toEqual(['hit', 'missed']);
    });

    it('skips events before a restart', () => {
        const matcher = new JamMatcher(events, judgeHearing([45]), options);
        matcher.restart(900);
        expect(matcher.pending?.index).toBe(1);
    });

    it('keeps streaks and timing stats', () => {
        const hit = { event: events[0], outcome: 'hit' as const, notes: [true], offsetMs: 50, played: 40 };
        const miss = { event: events[0], outcome: 'missed' as const, notes: [false], offsetMs: null, played: null };
        let stats = EMPTY_STATS;
        for (const r of [hit, hit, miss, hit]) {
            stats = addResult(stats, r, 100);
        }
        expect(stats).toMatchObject({ judged: 4, hits: 3, streak: 1, bestStreak: 2, late: 3, early: 0 });
    });
});

describe('Calibration', () => {
    const clicks = Array.from({ length: CLICKS }, (_, i) => 1000 + i * 600);

    it('takes the median delay of the measured clicks', () => {
        // Lead-in clicks are ignored; one strike is an outlier.
        const strikes = clicks.map((c, i) => c + (i < LEAD_IN ? 500 : i === 6 ? 200 : 80 + (i % 2) * 10));
        expect(evaluateCalibration(clicks, strikes)).toEqual({ latencyMs: 90, pairs: 8, spreadMs: 5 });
    });

    it('needs enough strikes', () => {
        expect(evaluateCalibration(clicks, [clicks[5] + 50, clicks[6] + 50]).latencyMs).toBeNull();
    });
});
