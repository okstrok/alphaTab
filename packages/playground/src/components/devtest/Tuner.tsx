import * as alphaTab from '@coderline/alphatab';
import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GuitarInput, type InputFrame, type InputState } from './GuitarInput';
import { centsFrom, closestString, frequencyToNote, midiToFrequency, midiToName } from './Notes';
import styles from './tuner.module.scss';

/** Cents within which a string counts as in tune. */
const IN_TUNE_CENTS = 3;
/** Needle range of the gauge in cents, each side. */
const GAUGE_RANGE = 50;
const STORAGE_KEY = 'alphatab-devtest-tuner';
const CHROMATIC = 'chromatic';

interface TuningOption {
    id: string;
    name: string;
    /** MIDI notes, lowest string first. Empty for chromatic mode. */
    strings: number[];
}

/** alphaTab's built-in tuning presets, lowest string first. */
function tuningOptions(): TuningOption[] {
    const options: TuningOption[] = [{ id: CHROMATIC, name: 'Chromatic (any note)', strings: [] }];
    for (const count of [6, 7, 4, 5]) {
        alphaTab.model.Tuning.getPresetsFor(count).forEach((tuning, i) => {
            options.push({
                id: `${count}-${i}`,
                name: `${tuning.name} (${count} strings)`,
                strings: [...tuning.tunings].reverse()
            });
        });
    }
    return options;
}

interface StoredSettings {
    deviceId?: string;
    tuningId?: string;
    a4?: number;
}

function loadSettings(): StoredSettings {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as StoredSettings;
    } catch {
        return {};
    }
}

function saveSettings(settings: StoredSettings): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
        // Storage may be unavailable (private mode); settings then last for this page only.
    }
}

/** The DevTest tuner: live input from a guitar, detected note, cents gauge and string targets. */
export function Tuner() {
    const options = useMemo(tuningOptions, []);
    const stored = useMemo(loadSettings, []);

    const [state, setState] = useState<InputState>('idle');
    const [error, setError] = useState<string | undefined>();
    const [frame, setFrame] = useState<InputFrame>({ pitch: null, rms: 0 });
    const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
    const [deviceId, setDeviceId] = useState(stored.deviceId ?? '');
    const [tuningId, setTuningId] = useState(options.some(o => o.id === stored.tuningId) ? stored.tuningId! : '6-0');
    const [a4, setA4] = useState(stored.a4 ?? 440);
    /** Index into `tuning.strings` the user locked onto, or null to follow the closest string. */
    const [lockedString, setLockedString] = useState<number | null>(null);

    const input = useRef<GuitarInput | null>(null);

    useEffect(() => {
        const created = new GuitarInput({
            onFrame: setFrame,
            onStateChanged: (next, message) => {
                setState(next);
                setError(message);
                if (next === 'running') {
                    // Device labels become readable once access is granted.
                    GuitarInput.listInputs().then(setDevices);
                }
            }
        });
        input.current = created;
        GuitarInput.listInputs().then(setDevices);
        const refresh = () => GuitarInput.listInputs().then(setDevices);
        navigator.mediaDevices?.addEventListener('devicechange', refresh);
        return () => {
            navigator.mediaDevices?.removeEventListener('devicechange', refresh);
            created.stop();
            input.current = null;
        };
    }, []);

    useEffect(() => saveSettings({ deviceId, tuningId, a4 }), [deviceId, tuningId, a4]);

    const running = state === 'running' || state === 'starting';
    const toggle = useCallback(() => {
        if (running) {
            input.current?.stop();
        } else {
            input.current?.start(deviceId || undefined);
        }
    }, [running, deviceId]);

    const changeDevice = useCallback(
        (id: string) => {
            setDeviceId(id);
            if (running) {
                input.current?.start(id || undefined);
            }
        },
        [running]
    );

    const tuning = options.find(o => o.id === tuningId) ?? options[0];
    const pitch = frame.pitch;

    // What the needle measures against: the locked string, the closest string, or the nearest note.
    let targetIndex: number | null = null;
    let targetMidi: number | null = null;
    if (pitch && tuning.strings.length > 0) {
        targetIndex = lockedString ?? closestString(pitch.frequency, tuning.strings, a4);
        targetMidi = tuning.strings[targetIndex];
    } else if (lockedString !== null && tuning.strings.length > 0) {
        targetIndex = lockedString;
    }
    const note = pitch ? frequencyToNote(pitch.frequency, a4) : null;
    if (pitch && targetMidi === null && note) {
        targetMidi = note.midi;
    }
    const cents = pitch && targetMidi !== null ? centsFrom(pitch.frequency, targetMidi, a4) : null;
    const inTune = cents !== null && Math.abs(cents) <= IN_TUNE_CENTS;
    const needle = cents === null ? 0 : Math.max(-GAUGE_RANGE, Math.min(GAUGE_RANGE, cents));
    const target = targetMidi !== null ? midiToName(targetMidi) : null;

    let hint = '';
    if (cents !== null) {
        if (inTune) {
            hint = 'In tune';
        } else if (cents < 0) {
            hint = cents < -GAUGE_RANGE ? 'Much too low – tune up' : 'Too low – tune up';
        } else {
            hint = cents > GAUGE_RANGE ? 'Much too high – tune down' : 'Too high – tune down';
        }
    }

    return (
        <div className={styles.page}>
            <header className={styles.header}>
                <div>
                    <h1 className={styles.title}>DevTest · Tuner</h1>
                    <p className={styles.subtitle}>
                        Plug in your guitar (audio interface or USB cable) or play near the microphone.
                    </p>
                </div>
            </header>

            <section className={styles.controls}>
                <label className={styles.field}>
                    <span>Input</span>
                    <select value={deviceId} onChange={e => changeDevice(e.target.value)}>
                        <option value="">Default input</option>
                        {devices
                            .filter(d => d.deviceId && d.deviceId !== 'default')
                            .map((d, i) => (
                                <option key={d.deviceId} value={d.deviceId}>
                                    {d.label || `Input ${i + 1}`}
                                </option>
                            ))}
                    </select>
                </label>
                <label className={styles.field}>
                    <span>Tuning</span>
                    <select
                        value={tuningId}
                        onChange={e => {
                            setTuningId(e.target.value);
                            setLockedString(null);
                        }}>
                        {options.map(o => (
                            <option key={o.id} value={o.id}>
                                {o.name}
                            </option>
                        ))}
                    </select>
                </label>
                <label className={clsx(styles.field, styles.fieldNarrow)}>
                    <span>A4 (Hz)</span>
                    <input
                        type="number"
                        min={415}
                        max={466}
                        step={1}
                        value={a4}
                        onChange={e => {
                            const value = Number(e.target.value);
                            if (value >= 415 && value <= 466) {
                                setA4(value);
                            }
                        }}
                    />
                </label>
                <button
                    type="button"
                    className={clsx(styles.startButton, running && styles.startButtonActive)}
                    onClick={toggle}
                    disabled={state === 'starting'}>
                    {state === 'starting' ? 'Starting…' : running ? 'Stop' : 'Start tuner'}
                </button>
            </section>

            {error && <p className={styles.error}>{error}</p>}

            <section className={clsx(styles.display, inTune && styles.displayInTune)}>
                <div className={styles.noteBlock}>
                    <div className={styles.note}>
                        {note ? note.name : '–'}
                        {note && <span className={styles.octave}>{note.octave}</span>}
                    </div>
                    <div className={styles.readout}>
                        {pitch ? `${pitch.frequency.toFixed(1)} Hz` : running ? 'Play a string…' : 'Tuner is off'}
                    </div>
                </div>

                <Gauge cents={cents} needle={needle} inTune={inTune} />

                <div className={styles.readoutRow}>
                    <span className={styles.cents}>
                        {cents === null ? '' : `${cents > 0 ? '+' : ''}${cents.toFixed(1)} ¢`}
                    </span>
                    <span className={clsx(styles.hint, inTune && styles.hintInTune)}>{hint}</span>
                    <span className={styles.targetLabel}>
                        {target
                            ? `Target ${target.name}${target.octave} · ${midiToFrequency(targetMidi!, a4).toFixed(1)} Hz`
                            : ''}
                    </span>
                </div>
            </section>

            {tuning.strings.length > 0 && (
                <section className={styles.strings}>
                    <span className={styles.stringsLabel}>
                        {lockedString === null
                            ? 'Auto string detection'
                            : 'Locked to one string – click it again to unlock'}
                    </span>
                    <div className={styles.stringButtons}>
                        {tuning.strings.map((midi, i) => {
                            const name = midiToName(midi);
                            return (
                                <button
                                    key={i}
                                    type="button"
                                    className={clsx(
                                        styles.stringButton,
                                        targetIndex === i && styles.stringButtonActive,
                                        targetIndex === i && inTune && styles.stringButtonInTune,
                                        lockedString === i && styles.stringButtonLocked
                                    )}
                                    title={`String ${tuning.strings.length - i}: ${name.name}${name.octave}`}
                                    onClick={() => setLockedString(lockedString === i ? null : i)}>
                                    {name.name}
                                    <small>{name.octave}</small>
                                </button>
                            );
                        })}
                    </div>
                </section>
            )}

            <section className={styles.meter}>
                <span>Input level</span>
                <div className={styles.meterTrack}>
                    <div className={styles.meterFill} style={{ width: `${levelPercent(frame.rms)}%` }} />
                </div>
                <span className={styles.meterValue}>{running ? `${toDb(frame.rms).toFixed(0)} dB` : ''}</span>
            </section>
        </div>
    );
}

function Gauge({ cents, needle, inTune }: { cents: number | null; needle: number; inTune: boolean }) {
    // Half circle from -50 (left) to +50 (right) cents; the needle pivots at the bottom center.
    const angle = (needle / GAUGE_RANGE) * 70;
    const ticks = [-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50];
    return (
        <svg className={styles.gauge} viewBox="0 0 300 170" role="img" aria-label="Tuning gauge">
            <path className={styles.gaugeArc} d={arcPath(150, 160, 130, -70, 70)} />
            <path
                className={styles.gaugeZone}
                d={arcPath(
                    150,
                    160,
                    130,
                    -(IN_TUNE_CENTS / GAUGE_RANGE) * 70 - 1.5,
                    (IN_TUNE_CENTS / GAUGE_RANGE) * 70 + 1.5
                )}
            />
            {ticks.map(t => {
                const a = ((t / GAUGE_RANGE) * 70 * Math.PI) / 180;
                const inner = t % 50 === 0 || t === 0 ? 108 : 116;
                return (
                    <line
                        key={t}
                        className={styles.gaugeTick}
                        x1={150 + Math.sin(a) * inner}
                        y1={160 - Math.cos(a) * inner}
                        x2={150 + Math.sin(a) * 124}
                        y2={160 - Math.cos(a) * 124}
                    />
                );
            })}
            <text className={styles.gaugeLabel} x={30} y={166}>
                ♭
            </text>
            <text className={styles.gaugeLabel} x={262} y={166}>
                ♯
            </text>
            <g
                className={clsx(styles.needle, cents === null && styles.needleIdle, inTune && styles.needleInTune)}
                style={{ transform: `rotate(${angle}deg)` }}>
                <line x1={150} y1={160} x2={150} y2={36} />
            </g>
            <circle className={styles.pivot} cx={150} cy={160} r={7} />
        </svg>
    );
}

function arcPath(cx: number, cy: number, r: number, fromDeg: number, toDeg: number): string {
    const point = (deg: number) => {
        const a = (deg * Math.PI) / 180;
        return `${cx + Math.sin(a) * r} ${cy - Math.cos(a) * r}`;
    };
    return `M ${point(fromDeg)} A ${r} ${r} 0 0 1 ${point(toDeg)}`;
}

function toDb(rms: number): number {
    return rms > 0 ? Math.max(-90, 20 * Math.log10(rms)) : -90;
}

function levelPercent(rms: number): number {
    // -60 dB .. 0 dB mapped to 0..100 %.
    return Math.max(0, Math.min(100, ((toDb(rms) + 60) / 60) * 100));
}
