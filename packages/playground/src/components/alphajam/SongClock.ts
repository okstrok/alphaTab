import { ticksPerMs } from './SongNotes';

/** A known point of the song: playback `tick` at wall-clock `time` (`performance.now()`), moving at `rate`. */
interface Anchor {
    time: number;
    tick: number;
    /** Ticks per millisecond; 0 while paused. */
    rate: number;
}

/** Position jumps larger than this (in ms of song time) are seeks or loop restarts, not drift. */
const JUMP_MS = 250;
/** How much of the measured drift each position update corrects. */
const CORRECTION = 0.2;
/** How long anchors are kept, so strikes from the recent past map to the tempo they were played in. */
const HISTORY_MS = 4000;

export interface ClockUpdate {
    /** Whether the position jumped (seek, loop restart, stop) instead of moving on. */
    jumped: boolean;
    /** The new position after a jump. */
    tick: number;
}

/**
 * Maps wall-clock time to playback ticks. DOM-free.
 *
 * The player reports its position only every few dozen milliseconds and with jitter; strikes are
 * timed on the input side to within ~10 ms. The clock extrapolates between position updates at the
 * current tempo and corrects drift smoothly, so both sides can be compared on one time axis.
 */
export class SongClock {
    private _anchors: Anchor[] = [];
    private _lastReported: number | null = null;

    public get isRunning(): boolean {
        return (this._last()?.rate ?? 0) > 0;
    }

    /** Ticks per millisecond at the latest position. */
    public get rate(): number {
        return this._last()?.rate ?? 0;
    }

    /**
     * Feeds a position update of the player.
     * @param bpm Tempo with the playback speed applied; ignored while `playing` is false.
     */
    public update(time: number, tick: number, bpm: number, playing: boolean, isSeek = false): ClockUpdate {
        // The clock only runs once the reports show the song moving: while a count-in plays, the
        // player reports "playing" but stays on its tick.
        const moving = playing && this._lastReported !== null && tick > this._lastReported;
        this._lastReported = tick;
        const rate = moving ? ticksPerMs(bpm) : 0;
        const last = this._last();
        let jumped = true;
        let anchorTick = tick;
        if (last && !isSeek) {
            const predicted = last.tick + (time - last.time) * last.rate;
            const errorTicks = tick - predicted;
            const errorMs = Math.abs(errorTicks) / Math.max(rate, last.rate, ticksPerMs(30));
            if (errorMs <= JUMP_MS) {
                jumped = false;
                anchorTick = rate > 0 && last.rate > 0 ? predicted + errorTicks * CORRECTION : tick;
            }
        }
        if (jumped) {
            this._anchors = [];
        }
        this._anchors.push({ time, tick: anchorTick, rate });
        while (this._anchors.length > 2 && this._anchors[1].time < time - HISTORY_MS) {
            this._anchors.shift();
        }
        return { jumped, tick };
    }

    /** The playback tick at wall-clock `time`, or null before the first position update. */
    public tickAt(time: number): number | null {
        if (this._anchors.length === 0) {
            return null;
        }
        // The latest anchor at or before `time`; the first one for times before all of them.
        let anchor = this._anchors[0];
        for (const a of this._anchors) {
            if (a.time <= time) {
                anchor = a;
            } else {
                break;
            }
        }
        return anchor.tick + (time - anchor.time) * anchor.rate;
    }

    private _last(): Anchor | undefined {
        return this._anchors[this._anchors.length - 1];
    }

    public reset(): void {
        this._anchors = [];
        this._lastReported = null;
    }
}
