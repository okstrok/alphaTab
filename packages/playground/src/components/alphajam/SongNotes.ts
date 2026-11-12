import type * as alphaTab from '@coderline/alphatab';

/** One note the player is expected to play. */
export interface ExpectedNote {
    /** `Note.id`, to find the note head on screen. */
    noteId: number;
    /** Sounding pitch as MIDI note, capo and transposing staves included. */
    midi: number;
}

/**
 * Everything the player has to strike at one moment of the song: a single note or a chord.
 * Notes of all voices that start on the same tick are merged into one event.
 */
export interface ExpectedEvent {
    /** Position in playback order, 0-based. A repeated bar produces new events. */
    index: number;
    /** Absolute playback tick of the attack, in the space of `PositionChangedEventArgs.currentTick`. */
    tick: number;
    /** The beats the event consists of, to find them on screen. */
    beats: alphaTab.model.Beat[];
    notes: ExpectedNote[];
}

/** A note is played (attacked) unless it continues a tie or is a dead (muted) note. */
function isAttacked(note: alphaTab.model.Note): boolean {
    return !note.isTieDestination && !note.isDead && !note.isPercussion;
}

/**
 * Collects the notes of `trackIndex` in playback order, repeats and jumps expanded, from the tick
 * lookup the player built for the current song.
 */
export function collectExpectedEvents(lookup: alphaTab.midi.MidiTickLookup, trackIndex: number): ExpectedEvent[] {
    const byTick = new Map<number, ExpectedEvent>();
    for (const masterBar of lookup.masterBars) {
        for (let beatLookup = masterBar.firstBeat; beatLookup; beatLookup = beatLookup.nextBeat) {
            for (const item of beatLookup.highlightedBeats) {
                // A beat spanning several lookup slices is listed in each of them; only its first slice is the attack.
                if (item.playbackStart !== beatLookup.start) {
                    continue;
                }
                const beat = item.beat;
                if (beat.voice.bar.staff.track.index !== trackIndex || beat.isRest) {
                    continue;
                }
                const notes = beat.notes.filter(isAttacked);
                if (notes.length === 0) {
                    continue;
                }
                // Beat lookup ticks are relative to their master bar.
                const tick = masterBar.start + item.playbackStart;
                let event = byTick.get(tick);
                if (!event) {
                    event = { index: 0, tick, beats: [], notes: [] };
                    byTick.set(tick, event);
                }
                if (!event.beats.includes(beat)) {
                    event.beats.push(beat);
                }
                for (const note of notes) {
                    const midi = note.realValue;
                    if (!event.notes.some(n => n.midi === midi)) {
                        event.notes.push({ noteId: note.id, midi });
                    }
                }
            }
        }
    }
    const events = [...byTick.values()].sort((a, b) => a.tick - b.tick);
    events.forEach((e, i) => {
        e.index = i;
        e.notes.sort((a, b) => a.midi - b.midi);
    });
    return events;
}

/** General MIDI programs 24-31 are the guitars (nylon, steel, jazz, clean, muted, overdriven, distortion, harmonics). */
const GUITAR_PROGRAMS = { from: 24, to: 31 };

/**
 * Whether `track` is a guitar: a General MIDI guitar sound on a pitched staff with six or more
 * strings. The tuning alone is not enough, Guitar Pro gives every track one, voices included.
 */
export function isGuitarTrack(track: alphaTab.model.Track): boolean {
    const program = track.playbackInfo.program;
    return (
        program >= GUITAR_PROGRAMS.from &&
        program <= GUITAR_PROGRAMS.to &&
        track.staves.some(s => !s.isPercussion && s.tuning.length >= 6)
    );
}

/** MIDI ticks per quarter note of alphaTab's generated MIDI. */
export const TICKS_PER_QUARTER = 960;

/** Playback ticks per millisecond at `bpm` (the tempo with the playback speed applied). */
export function ticksPerMs(bpm: number): number {
    return (TICKS_PER_QUARTER * bpm) / 60000;
}
