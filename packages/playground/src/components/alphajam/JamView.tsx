import * as alphaTab from '@coderline/alphatab';
import { useAlphaTabApi } from '@coderline/alphatab-react';
import {
    IconUpload,
    PlayerView,
    type ScoreDocumentState,
    Segmented,
    usePersistedState,
    usePlayerControls,
    usePlayerSelector
} from '@coderline/alphatab-ui';
import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InputState } from '../devtest/GuitarInput';
import { frequencyToNote, midiToName } from '../devtest/Notes';
import styles from './alphajam.module.scss';
import { CalibrationDialog, SummaryDialog } from './Dialogs';
import { JamInput } from './JamInput';
import { accuracy, addResult, EMPTY_STATS, type EventResult, type JamStats } from './JamMatcher';
import { JamSession } from './JamSession';
import { NoteMarks } from './NoteMarks';
import { rmsToDb } from './OnsetDetector';
import { isGuitarTrack } from './SongNotes';

type ViewMode = 'sliding' | 'sheet';
type Staves = 'scoreTab' | 'tab' | 'score';

interface JamPreferences {
    view: ViewMode;
    staves: Staves;
    deviceId: string;
    latencyMs: number;
    toleranceMs: number;
    /** Volume of the played track in the backing, 0 mutes it. */
    guideVolume: number;
}

const DEFAULT_PREFERENCES: JamPreferences = {
    view: 'sliding',
    staves: 'scoreTab',
    deviceId: '',
    latencyMs: 60,
    toleranceMs: 100,
    guideVolume: 0
};

const TOLERANCES = [
    { ms: 60, label: 'Strict (±60 ms)' },
    { ms: 100, label: 'Normal (±100 ms)' },
    { ms: 150, label: 'Relaxed (±150 ms)' }
];
const SPEEDS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1];
const FILE_ACCEPT = '.gp,.gp3,.gp4,.gp5,.gpx,.gp7,.gp8,.xml,.musicxml,.mxl,.capx,.alphatex,.atex,.tex,.txt';
/** Where the playhead sits in the sliding view, in px from the left edge of the notation. */
const SLIDING_PLAYHEAD_PX = 220;

/** The settings of the sliding and sheet views on top of the base settings of the player. */
function viewLayer(view: ViewMode, staves: Staves) {
    return (settings: alphaTab.Settings) => {
        // The note marks need the positions of the note heads.
        settings.core.includeNoteBounds = true;
        settings.display.layoutMode = view === 'sliding' ? alphaTab.LayoutMode.Horizontal : alphaTab.LayoutMode.Page;
        settings.display.staveProfile =
            staves === 'tab'
                ? alphaTab.StaveProfile.Tab
                : staves === 'score'
                  ? alphaTab.StaveProfile.Score
                  : alphaTab.StaveProfile.ScoreTab;
        if (view === 'sliding') {
            // The notation glides under a fixed playhead instead of jumping bar by bar.
            settings.player.scrollMode = alphaTab.ScrollMode.Smooth;
            settings.player.nativeBrowserSmoothScroll = false;
            settings.player.scrollOffsetX = -SLIDING_PLAYHEAD_PX;
        } else {
            settings.player.scrollMode = alphaTab.ScrollMode.Continuous;
            settings.player.nativeBrowserSmoothScroll = true;
            settings.player.scrollOffsetX = -10;
        }
    };
}

/** The alphaJam play-along: one guitar track, live input, note-by-note scoring. */
export function JamView({ doc }: { doc: ScoreDocumentState }) {
    const api = useAlphaTabApi();
    const controls = usePlayerControls();
    const score = usePlayerSelector(s => s.currentScore);
    const tracks = usePlayerSelector(s => s.tracks);
    const renderedTracks = usePlayerSelector(s => s.renderedTracks);
    const speed = usePlayerSelector(s => s.view.playbackSpeed);
    const isPlaying = usePlayerSelector(s => s.isPlaying);

    const [stored, setPreferences] = usePersistedState<JamPreferences>(
        'alphatab.playground.alphajam.v1',
        DEFAULT_PREFERENCES
    );
    const prefs = { ...DEFAULT_PREFERENCES, ...stored };
    const update = useCallback(
        (patch: Partial<JamPreferences>) => setPreferences(p => ({ ...DEFAULT_PREFERENCES, ...p, ...patch })),
        [setPreferences]
    );

    const guitarTracks = useMemo(() => tracks.filter(isGuitarTrack), [tracks]);
    const [trackIndex, setTrackIndex] = useState<number | null>(null);
    const track = guitarTracks.find(t => t.index === trackIndex) ?? null;

    // Input
    const [inputState, setInputState] = useState<InputState>('idle');
    const [inputError, setInputError] = useState<string | undefined>();
    const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
    const input = useRef<JamInput | null>(null);
    const session = useRef<JamSession | null>(null);
    const strikeListeners = useRef(new Set<(time: number) => void>());

    // Scoring
    const [stats, setStats] = useState<JamStats>(EMPTY_STATS);
    const [results, setResults] = useState<ReadonlyMap<number, EventResult>>(new Map());
    const [lastResult, setLastResult] = useState<EventResult | null>(null);
    const [eventCount, setEventCount] = useState(0);
    const [showSummary, setShowSummary] = useState(false);
    const [showCalibration, setShowCalibration] = useState(false);
    const toleranceRef = useRef(prefs.toleranceMs);
    toleranceRef.current = prefs.toleranceMs;

    useEffect(() => {
        const created = new JamInput({
            onStrike: onset => {
                session.current?.strike(onset);
                for (const listener of strikeListeners.current) {
                    listener(onset.time);
                }
            },
            onStateChanged: (state, error) => {
                setInputState(state);
                setInputError(error);
                if (state === 'running') {
                    JamInput.listInputs().then(setDevices);
                }
            }
        });
        input.current = created;
        JamInput.listInputs().then(setDevices);
        const refresh = () => JamInput.listInputs().then(setDevices);
        navigator.mediaDevices?.addEventListener('devicechange', refresh);
        return () => {
            navigator.mediaDevices?.removeEventListener('devicechange', refresh);
            created.stop();
            input.current = null;
        };
    }, []);

    useEffect(() => {
        if (!api || !input.current) {
            return;
        }
        const created = new JamSession(
            api,
            input.current,
            {
                onResult: result => {
                    setStats(s => addResult(s, result, toleranceRef.current));
                    setLastResult(result);
                    setResults(previous => {
                        const next = new Map(previous);
                        next.set(result.event.index, result);
                        return next;
                    });
                },
                onRestart: (tick, fromStart) => {
                    setShowSummary(false);
                    setLastResult(null);
                    if (fromStart) {
                        setStats(EMPTY_STATS);
                        setResults(new Map());
                    } else {
                        // Practicing a section again: clear its marks, keep the running score.
                        setResults(previous => new Map([...previous].filter(([, r]) => r.event.tick < tick)));
                    }
                },
                onFinished: () => setShowSummary(true),
                onEventsChanged: events => {
                    setEventCount(events.length);
                    setStats(EMPTY_STATS);
                    setResults(new Map());
                    setLastResult(null);
                }
            },
            { latencyMs: prefs.latencyMs, toleranceMs: prefs.toleranceMs, a4: 440 }
        );
        session.current = created;
        return () => {
            created.dispose();
            session.current = null;
        };
        // The session lives as long as the player; options are pushed by the effect below.
    }, [api]);

    useEffect(() => {
        session.current?.setOptions({ latencyMs: prefs.latencyMs, toleranceMs: prefs.toleranceMs, a4: 440 });
    }, [prefs.latencyMs, prefs.toleranceMs]);

    // A new song: keep the chosen guitar track if it has one at the same index, else take the first.
    useEffect(() => {
        if (guitarTracks.length === 0) {
            setTrackIndex(null);
        } else if (!guitarTracks.some(t => t.index === trackIndex)) {
            setTrackIndex(guitarTracks[0].index);
        }
    }, [guitarTracks, trackIndex]);

    // Show only the chosen track...
    useEffect(() => {
        if (controls && track && (renderedTracks.length !== 1 || renderedTracks[0] !== track)) {
            controls.renderTracks([track]);
        }
    }, [controls, track, renderedTracks]);

    // ...and score against it. The session also rebuilds its notes whenever the player loads new MIDI.
    const trackForSession = track?.index ?? null;
    useEffect(() => {
        session.current?.setTrack(trackForSession);
    }, [api, trackForSession, score]);

    // The backing: every other track at full volume, the played one at the guide volume.
    useEffect(() => {
        if (!controls) {
            return;
        }
        for (const t of tracks) {
            const own = t === track;
            controls.setTrackVolume(t, own ? prefs.guideVolume : 1);
            controls.setTrackMute(t, own && prefs.guideVolume === 0);
        }
    }, [controls, tracks, track, prefs.guideVolume]);

    useEffect(() => {
        if (!controls) {
            return;
        }
        return controls.addSettingsLayer(viewLayer(prefs.view, prefs.staves));
    }, [controls, prefs.view, prefs.staves]);

    const running = inputState === 'running' || inputState === 'starting';
    const toggleInput = useCallback(() => {
        if (running) {
            input.current?.stop();
        } else {
            input.current?.start(prefs.deviceId || undefined);
        }
    }, [running, prefs.deviceId]);

    const listenStrikes = useCallback((listener: (time: number) => void) => {
        strikeListeners.current.add(listener);
        return () => {
            strikeListeners.current.delete(listener);
        };
    }, []);

    const fileInputRef = useRef<HTMLInputElement>(null);
    const name = doc.document?.fileName;
    const title = [score?.title?.trim(), score?.artist?.trim()].filter(Boolean).join(' · ');

    const message = doc.loadError
        ? `Could not open ${name}: ${doc.loadError}`
        : !score
          ? `Loading ${name ?? ''}…`
          : guitarTracks.length === 0
            ? 'This song has no guitar track. alphaJam needs a track with six or more strings.'
            : null;

    const share = accuracy(stats);

    return (
        <>
            <PlayerView
                className={styles.page}
                header={
                    <div className={styles.headerArea}>
                        <header className={styles.header}>
                            <div className={styles.brand}>
                                <span className={styles.logo}>alphaJam</span>
                                <span className={styles.song} title={name}>
                                    {title || name || 'No song'}
                                </span>
                            </div>
                            <label className={styles.field}>
                                <span>Track</span>
                                <select
                                    value={track?.index ?? ''}
                                    disabled={guitarTracks.length === 0}
                                    onChange={e => setTrackIndex(Number(e.target.value))}>
                                    {guitarTracks.length === 0 && <option value="">No guitar track</option>}
                                    {guitarTracks.map(t => (
                                        <option key={t.index} value={t.index}>
                                            {t.name || `Track ${t.index + 1}`}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <Segmented<ViewMode>
                                label="View"
                                value={prefs.view}
                                onChange={view => update({ view })}
                                options={[
                                    { v: 'sliding', l: 'Sliding' },
                                    { v: 'sheet', l: 'Sheet' }
                                ]}
                            />
                            <Segmented<Staves>
                                label="Notation"
                                value={prefs.staves}
                                onChange={staves => update({ staves })}
                                options={[
                                    { v: 'scoreTab', l: 'Tab + staff' },
                                    { v: 'tab', l: 'Tab' },
                                    { v: 'score', l: 'Staff' }
                                ]}
                            />
                            <label className={styles.field}>
                                <span>Speed</span>
                                <select
                                    value={speed}
                                    onChange={e => controls?.setPlaybackSpeed(Number(e.target.value))}>
                                    {SPEEDS.map(s => (
                                        <option key={s} value={s}>
                                            {Math.round(s * 100)}%
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <span className={styles.spacer} />
                            <button
                                type="button"
                                className={styles.iconButton}
                                title="Open a song, or drop one onto the notation"
                                aria-label="Open a song"
                                onClick={() => fileInputRef.current?.click()}>
                                <IconUpload size={14} aria-hidden="true" />
                                <span>Open song</span>
                            </button>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept={FILE_ACCEPT}
                                hidden
                                onChange={e => {
                                    const file = e.target.files?.[0];
                                    e.target.value = '';
                                    if (file) {
                                        void doc.openFile(file);
                                    }
                                }}
                            />
                        </header>

                        <div className={styles.jamBar}>
                            <button
                                type="button"
                                className={clsx(styles.primaryButton, running && styles.stopButton)}
                                onClick={toggleInput}
                                disabled={inputState === 'starting'}>
                                {running ? 'Stop input' : 'Start input'}
                            </button>
                            <label className={styles.field}>
                                <span>Input</span>
                                <select
                                    value={prefs.deviceId}
                                    onChange={e => {
                                        update({ deviceId: e.target.value });
                                        if (running) {
                                            input.current?.start(e.target.value || undefined);
                                        }
                                    }}>
                                    <option value="">Default input</option>
                                    {devices.map((d, i) => (
                                        <option key={d.deviceId || i} value={d.deviceId}>
                                            {d.label || `Input ${i + 1}`}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <InputMonitor input={input.current} active={inputState === 'running'} />
                            <label className={clsx(styles.field, styles.rangeField)}>
                                <span>
                                    Latency <b>{prefs.latencyMs} ms</b>
                                </span>
                                <input
                                    type="range"
                                    min={-100}
                                    max={400}
                                    step={5}
                                    value={prefs.latencyMs}
                                    onChange={e => update({ latencyMs: Number(e.target.value) })}
                                />
                            </label>
                            <button
                                type="button"
                                className={styles.button}
                                disabled={inputState !== 'running'}
                                title={inputState !== 'running' ? 'Start the input first' : undefined}
                                onClick={() => setShowCalibration(true)}>
                                Calibrate
                            </button>
                            <label className={styles.field}>
                                <span>Timing</span>
                                <select
                                    value={prefs.toleranceMs}
                                    onChange={e => update({ toleranceMs: Number(e.target.value) })}>
                                    {TOLERANCES.map(t => (
                                        <option key={t.ms} value={t.ms}>
                                            {t.label}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label className={clsx(styles.field, styles.rangeField)}>
                                <span>
                                    Guide{' '}
                                    <b>{prefs.guideVolume === 0 ? 'off' : `${Math.round(prefs.guideVolume * 100)}%`}</b>
                                </span>
                                <input
                                    type="range"
                                    min={0}
                                    max={1}
                                    step={0.05}
                                    value={prefs.guideVolume}
                                    onChange={e => update({ guideVolume: Number(e.target.value) })}
                                />
                            </label>
                            <span className={styles.spacer} />
                            <div className={styles.stats} aria-live="off">
                                <Stat label="Accuracy" value={share === null ? '–' : `${Math.round(share * 100)}%`} />
                                <Stat label="Hits" value={`${stats.hits}/${stats.judged}`} />
                                <Stat label="Streak" value={String(stats.streak)} highlight={stats.streak >= 10} />
                                <Stat label="Best" value={String(stats.bestStreak)} />
                                <LastResult result={lastResult} toleranceMs={prefs.toleranceMs} />
                            </div>
                        </div>
                        {inputError && <p className={styles.error}>{inputError}</p>}
                        {!running && !inputError && score && guitarTracks.length > 0 && (
                            <p className={styles.hint}>
                                Connect your guitar through an audio interface, press <b>Start input</b>, then play.
                                {isPlaying ? '' : ` ${eventCount} notes to play on this track.`}
                            </p>
                        )}
                    </div>
                }
                notationMessage={message}
                scoreOverlay={<NoteMarks results={results} />}
                renderingIndicator
                onDropFile={file => void doc.openFile(file)}
            />
            {showCalibration && (
                <CalibrationDialog
                    context={input.current?.context ?? null}
                    listenStrikes={listenStrikes}
                    latencyMs={prefs.latencyMs}
                    onApply={latencyMs => update({ latencyMs })}
                    onClose={() => setShowCalibration(false)}
                />
            )}
            {showSummary && (
                <SummaryDialog
                    stats={stats}
                    toleranceMs={prefs.toleranceMs}
                    latencyMs={prefs.latencyMs}
                    onApplyLatency={latencyMs => update({ latencyMs })}
                    onPlayAgain={() => {
                        setShowSummary(false);
                        controls?.stop();
                        controls?.play();
                    }}
                    onClose={() => setShowSummary(false)}
                />
            )}
        </>
    );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
    return (
        <div className={clsx(styles.stat, highlight && styles.statHot)}>
            <span className={styles.statValue}>{value}</span>
            <span className={styles.statLabel}>{label}</span>
        </div>
    );
}

function LastResult({ result, toleranceMs }: { result: EventResult | null; toleranceMs: number }) {
    if (!result) {
        return <div className={styles.lastResult} />;
    }
    let text: string;
    if (result.outcome === 'missed') {
        text = 'Missed';
    } else if (result.outcome === 'wrong') {
        const played = result.played !== null ? midiToName(result.played) : null;
        text = played && result.event.notes.length === 1 ? `Wrong (${played.name}${played.octave})` : 'Wrong notes';
    } else {
        const offset = Math.round(result.offsetMs ?? 0);
        text =
            Math.abs(offset) <= toleranceMs / 3 ? 'Perfect' : offset > 0 ? `Late ${offset} ms` : `Early ${-offset} ms`;
    }
    return (
        <div
            key={result.event.index}
            className={clsx(styles.lastResult, result.outcome === 'hit' ? styles.lastHit : styles.lastMiss)}>
            {text}
        </div>
    );
}

/** Input level and the note heard right now, refreshed a few times per second. */
function InputMonitor({ input, active }: { input: JamInput | null; active: boolean }) {
    const [reading, setReading] = useState<{ level: number; note: string | null }>({ level: 0, note: null });
    useEffect(() => {
        if (!active || !input) {
            setReading({ level: 0, note: null });
            return;
        }
        let frame = 0;
        let last = 0;
        const tick = (time: number) => {
            frame = requestAnimationFrame(tick);
            if (time - last < 80) {
                return;
            }
            last = time;
            const { rms, frequency } = input.snapshot;
            // -60 dBFS .. 0 dBFS onto 0..1.
            const level = Math.max(0, Math.min(1, (rmsToDb(rms) + 60) / 60));
            const note = frequency ? frequencyToNote(frequency) : null;
            setReading({ level, note: note ? `${note.name}${note.octave}` : null });
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [input, active]);

    return (
        <div className={styles.monitor} title="Input level and detected note">
            <div className={styles.meter} aria-hidden="true">
                <div
                    className={clsx(styles.meterFill, reading.level > 0.92 && styles.meterClip)}
                    style={{ width: `${reading.level * 100}%` }}
                />
            </div>
            <span className={styles.heard}>{reading.note ?? '–'}</span>
        </div>
    );
}
