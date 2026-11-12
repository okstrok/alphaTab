import * as alphaTab from '@coderline/alphatab';
import type { JamInput } from './JamInput';
import { SPECTRUM_SIZE } from './JamInput';
import { type EventResult, JamMatcher } from './JamMatcher';
import type { Onset } from './OnsetDetector';
import { judgeFrames, SETTLE_MS } from './PitchJudge';
import { SongClock } from './SongClock';
import { collectExpectedEvents, type ExpectedEvent, ticksPerMs } from './SongNotes';

export interface JamSessionListener {
    /** An event of the song was judged. */
    onResult(result: EventResult): void;
    /** Scoring starts over at `tick`: playback started, was sought or a loop restarted. */
    onRestart(tick: number, fromStart: boolean): void;
    /** The song played to its end. */
    onFinished(): void;
    /** The notes to play changed (new song or track). */
    onEventsChanged(events: readonly ExpectedEvent[]): void;
}

export interface JamSessionOptions {
    /** Delay of the whole loop, from the player's position to a strike detected in the input, in ms. */
    latencyMs: number;
    /** Timing window around each note, in ms. */
    toleranceMs: number;
    a4: number;
}

/** How often pending events are checked, in ms. */
const UPDATE_MS = 25;

/**
 * Scores the player against one track while alphaTab plays: keeps the song clock in step with the
 * player, places each detected strike on the song's time axis and judges the notes as their timing
 * windows close.
 */
export class JamSession {
    private readonly _clock = new SongClock();
    private _matcher: JamMatcher | null = null;
    private _trackIndex: number | null = null;
    private _playing = false;
    private _timer: number | undefined;
    private readonly _unsubscribe: (() => void)[] = [];
    private _firstEventTick = 0;
    /** Tempo of the latest playback, in ticks per ms, for judging the last notes after the end. */
    private _lastRate = 0;
    /** While the last notes are judged after the end, the player's jump back to the start is ignored. */
    private _finishing = false;

    public constructor(
        private readonly _api: alphaTab.AlphaTabApi,
        private readonly _input: JamInput,
        private readonly _listener: JamSessionListener,
        private _options: JamSessionOptions
    ) {
        this._unsubscribe.push(
            _api.midiLoaded.on(() => this._rebuild()),
            _api.playerPositionChanged.on(e => this._onPosition(e)),
            _api.playerStateChanged.on(e => this._onState(e)),
            _api.playerFinished.on(() => this._onFinished())
        );
        this._playing = _api.playerState === alphaTab.synth.PlayerState.Playing;
        this._timer = window.setInterval(() => this._update(), UPDATE_MS);
    }

    public get events(): readonly ExpectedEvent[] {
        return this._matcher?.events ?? [];
    }

    public setOptions(options: JamSessionOptions): void {
        this._options = options;
        if (this._matcher) {
            this._matcher.options = { toleranceMs: options.toleranceMs, settleMs: SETTLE_MS };
        }
    }

    public setTrack(index: number | null): void {
        this._trackIndex = index;
        this._rebuild();
    }

    /** A strike detected by the input. */
    public strike(onset: Onset): void {
        if (!this._matcher || !this._clock.isRunning) {
            return;
        }
        const tick = this._clock.tickAt(onset.time - this._options.latencyMs);
        if (tick !== null) {
            this._matcher.addStrike(onset.time, tick);
        }
    }

    public dispose(): void {
        window.clearInterval(this._timer);
        for (const unsubscribe of this._unsubscribe) {
            unsubscribe();
        }
    }

    private _rebuild(): void {
        const lookup = this._api.tickCache;
        const events = lookup && this._trackIndex !== null ? collectExpectedEvents(lookup, this._trackIndex) : [];
        this._firstEventTick = events[0]?.tick ?? 0;
        this._matcher = new JamMatcher(
            events,
            (time, midis) =>
                judgeFrames(this._input.frames, time, midis, {
                    sampleRate: this._input.sampleRate,
                    fftSize: SPECTRUM_SIZE,
                    a4: this._options.a4
                }),
            { toleranceMs: this._options.toleranceMs, settleMs: SETTLE_MS }
        );
        this._matcher.restart(this._api.tickPosition);
        this._listener.onEventsChanged(events);
    }

    private _onPosition(e: alphaTab.synth.PositionChangedEventArgs): void {
        const update = this._clock.update(performance.now(), e.currentTick, e.modifiedTempo, this._playing, e.isSeek);
        if (update.jumped) {
            this._restart(update.tick);
        }
    }

    private _onState(e: alphaTab.synth.PlayerStateChangedEventArgs): void {
        const playing = e.state === alphaTab.synth.PlayerState.Playing;
        if (playing === this._playing) {
            return;
        }
        this._playing = playing;
        if (playing) {
            // Starting playback begins a new take from the current position.
            this._clock.reset();
            this._restart(this._api.tickPosition);
        } else {
            this._update();
            this._clock.update(performance.now(), this._api.tickPosition, 0, false);
        }
    }

    private _restart(tick: number): void {
        if (!this._matcher || this._finishing) {
            return;
        }
        // A strike a little ahead of a note right at the restart point still counts for it.
        const rate = this._clock.rate || this._lastRate || ticksPerMs(120);
        this._matcher.restart(tick - this._options.toleranceMs * rate);
        this._listener.onRestart(tick, tick <= this._firstEventTick);
    }

    private _update(): void {
        if (!this._matcher || !this._clock.isRunning || this._finishing) {
            return;
        }
        const now = this._clock.tickAt(performance.now() - this._options.latencyMs);
        if (now === null) {
            return;
        }
        this._lastRate = this._clock.rate;
        for (const result of this._matcher.update(now, this._clock.rate)) {
            this._listener.onResult(result);
        }
    }

    private _onFinished(): void {
        // Judge the last notes with the tempo they were played at, then report the end.
        const matcher = this._matcher;
        const rate = this._lastRate;
        if (matcher && rate > 0) {
            this._finishing = true;
            window.setTimeout(
                () => {
                    this._finishing = false;
                    if (matcher !== this._matcher) {
                        return;
                    }
                    for (const result of matcher.update(Number.POSITIVE_INFINITY, rate)) {
                        this._listener.onResult(result);
                    }
                    matcher.restart(this._api.tickPosition);
                    this._listener.onFinished();
                },
                this._options.toleranceMs + SETTLE_MS + Math.max(0, this._options.latencyMs)
            );
        } else {
            this._listener.onFinished();
        }
    }
}
