import type { ExpectedEvent } from './SongNotes';

/** Which expected notes sound after a strike, as decided from the audio. */
export interface PitchVerdict {
    /** Per note of the event, whether it sounded. */
    present: boolean[];
    /** The single note heard, as rounded MIDI note, when there was one. */
    played: number | null;
}

/**
 * Decides which of `midis` sound after the strike at wall-clock `time`. Called only once the audio
 * up to `time + settleMs` has been analysed.
 */
export type StrikeJudge = (time: number, midis: number[]) => PitchVerdict;

export type EventOutcome =
    /** Struck in time and every required note sounded. */
    | 'hit'
    /** Struck in time, but with wrong or missing notes. */
    | 'wrong'
    /** Not struck within the timing window. */
    | 'missed';

export interface EventResult {
    event: ExpectedEvent;
    outcome: EventOutcome;
    /** Per note of the event, whether it sounded (all false when missed). */
    notes: boolean[];
    /** Strike time minus the expected time in ms; positive is late. Null when missed. */
    offsetMs: number | null;
    /** The single note heard at the strike, if any. */
    played: number | null;
}

export interface MatcherOptions {
    /** A strike counts for a note when it is at most this far off, in ms. */
    toleranceMs: number;
    /** Audio after the strike the judge needs to settle on the pitch, in ms. */
    settleMs: number;
}

/** A detected strike on the latency-corrected song time axis. */
interface Strike {
    /** Wall-clock time of the strike, for the judge. */
    time: number;
    /** Playback tick the strike was meant for. */
    tick: number;
    used: boolean;
}

/** How many notes of a chord must sound for a hit: all of small chords, all but one of big ones. */
export function requiredNotes(count: number): number {
    return count <= 3 ? count : count - 1;
}

/**
 * Compares the expected notes of the song with the strikes of the player. DOM-free.
 *
 * Events are judged in playback order once their timing window and the settle time after it have
 * passed. Each strike counts for at most one event, so a fast run needs one strike per note.
 * (A later "wait for me" mode can reuse this: pause the player while the next event is pending.)
 */
export class JamMatcher {
    private _next = 0;
    private _strikes: Strike[] = [];

    public constructor(
        private readonly _events: ExpectedEvent[],
        private readonly _judge: StrikeJudge,
        public options: MatcherOptions
    ) {}

    public get events(): readonly ExpectedEvent[] {
        return this._events;
    }

    /** The next event waiting to be judged, if any. */
    public get pending(): ExpectedEvent | undefined {
        return this._events[this._next];
    }

    /** Records a strike at wall-clock `time` that the song clock places at playback `tick`. */
    public addStrike(time: number, tick: number): void {
        this._strikes.push({ time, tick, used: false });
    }

    /**
     * Judges every event whose window has closed at playback `nowTick`.
     * @param rate Ticks per millisecond at the current tempo.
     */
    public update(nowTick: number, rate: number): EventResult[] {
        if (rate <= 0) {
            return [];
        }
        const tolerance = this.options.toleranceMs * rate;
        const settle = this.options.settleMs * rate;
        const results: EventResult[] = [];
        while (this._next < this._events.length) {
            const event = this._events[this._next];
            if (nowTick < event.tick + tolerance + settle) {
                break;
            }
            results.push(this._judgeEvent(event, tolerance, rate));
            this._next++;
        }
        // Strikes before the pending event's window can't count for anything any more.
        const pending = this._events[this._next];
        const oldest = pending ? pending.tick - tolerance : nowTick - tolerance;
        this._strikes = this._strikes.filter(s => !s.used && s.tick >= oldest);
        return results;
    }

    /** Starts over at playback `tick`, e.g. after a seek or a loop restart. Earlier events are skipped. */
    public restart(tick: number): void {
        this._strikes = [];
        this._next = this._events.findIndex(e => e.tick >= tick);
        if (this._next < 0) {
            this._next = this._events.length;
        }
    }

    private _judgeEvent(event: ExpectedEvent, tolerance: number, rate: number): EventResult {
        const midis = event.notes.map(n => n.midi);
        const candidates = this._strikes
            .filter(s => !s.used && Math.abs(s.tick - event.tick) <= tolerance)
            .sort((a, b) => Math.abs(a.tick - event.tick) - Math.abs(b.tick - event.tick));
        let best: EventResult | null = null;
        for (const strike of candidates) {
            const verdict = this._judge(strike.time, midis);
            const sounded = verdict.present.filter(Boolean).length;
            const result: EventResult = {
                event,
                outcome: sounded >= requiredNotes(midis.length) ? 'hit' : 'wrong',
                notes: verdict.present,
                offsetMs: (strike.tick - event.tick) / rate,
                played: verdict.played
            };
            if (result.outcome === 'hit') {
                strike.used = true;
                return result;
            }
            best ??= result;
        }
        return best ?? { event, outcome: 'missed', notes: midis.map(() => false), offsetMs: null, played: null };
    }
}

/** Running score of a play-through. */
export interface JamStats {
    judged: number;
    hits: number;
    streak: number;
    bestStreak: number;
    /** Sum of the offsets of the hits, for the average timing. */
    offsetSumMs: number;
    /** Hits that were early or late by more than a third of the tolerance. */
    early: number;
    late: number;
}

export const EMPTY_STATS: JamStats = {
    judged: 0,
    hits: 0,
    streak: 0,
    bestStreak: 0,
    offsetSumMs: 0,
    early: 0,
    late: 0
};

export function addResult(stats: JamStats, result: EventResult, toleranceMs: number): JamStats {
    const hit = result.outcome === 'hit';
    const streak = hit ? stats.streak + 1 : 0;
    const offset = hit ? (result.offsetMs ?? 0) : 0;
    const off = toleranceMs / 3;
    return {
        judged: stats.judged + 1,
        hits: stats.hits + (hit ? 1 : 0),
        streak,
        bestStreak: Math.max(stats.bestStreak, streak),
        offsetSumMs: stats.offsetSumMs + offset,
        early: stats.early + (hit && offset < -off ? 1 : 0),
        late: stats.late + (hit && offset > off ? 1 : 0)
    };
}

export function accuracy(stats: JamStats): number | null {
    return stats.judged === 0 ? null : stats.hits / stats.judged;
}
