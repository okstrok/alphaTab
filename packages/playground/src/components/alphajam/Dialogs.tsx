import { Dialog } from '@coderline/alphatab-ui';
import { useEffect, useRef, useState } from 'react';
import styles from './alphajam.module.scss';
import {
    type CalibrationResult,
    CLICK_INTERVAL_MS,
    CLICKS,
    evaluateCalibration,
    LEAD_IN,
    MIN_PAIRS,
    playClicks
} from './Calibration';
import { accuracy, type JamStats } from './JamMatcher';

interface CalibrationDialogProps {
    context: AudioContext | null;
    /** Registers a strike listener for the run; returns the unregister function. */
    listenStrikes: (listener: (time: number) => void) => () => void;
    latencyMs: number;
    onApply: (latencyMs: number) => void;
    onClose: () => void;
}

type CalibrationPhase = 'ready' | 'running' | 'done';

/** Click calibration: plays clicks, the player strikes along, the median delay becomes the latency. */
export function CalibrationDialog({ context, listenStrikes, latencyMs, onApply, onClose }: CalibrationDialogProps) {
    const [phase, setPhase] = useState<CalibrationPhase>('ready');
    const [click, setClick] = useState(-1);
    const [result, setResult] = useState<CalibrationResult | null>(null);
    const cleanup = useRef<(() => void) | null>(null);

    useEffect(() => () => cleanup.current?.(), []);

    const start = () => {
        if (!context) {
            return;
        }
        cleanup.current?.();
        const strikes: number[] = [];
        const unlisten = listenStrikes(time => strikes.push(time));
        const clicks = playClicks(context);
        setPhase('running');
        setResult(null);
        const timers: number[] = [];
        clicks.forEach((time, i) => {
            timers.push(window.setTimeout(() => setClick(i), Math.max(0, time - performance.now())));
        });
        timers.push(
            window.setTimeout(
                () => {
                    unlisten();
                    setResult(evaluateCalibration(clicks, strikes));
                    setPhase('done');
                    setClick(-1);
                },
                clicks[clicks.length - 1] - performance.now() + CLICK_INTERVAL_MS
            )
        );
        cleanup.current = () => {
            unlisten();
            for (const t of timers) {
                window.clearTimeout(t);
            }
        };
    };

    const measured = result?.latencyMs ?? null;

    return (
        <Dialog
            title="Calibrate latency"
            onClose={onClose}
            footer={
                <div className={styles.dialogFooter}>
                    <button type="button" className={styles.button} onClick={onClose}>
                        Close
                    </button>
                    <button
                        type="button"
                        className={styles.button}
                        disabled={!context || phase === 'running'}
                        onClick={start}>
                        {phase === 'done' ? 'Run again' : 'Start'}
                    </button>
                    <button
                        type="button"
                        className={styles.primaryButton}
                        disabled={measured === null}
                        onClick={() => {
                            if (measured !== null) {
                                onApply(measured);
                                onClose();
                            }
                        }}>
                        Use {measured ?? '–'} ms
                    </button>
                </div>
            }>
            <div className={styles.dialogBody}>
                <p>
                    You will hear {CLICKS} clicks. The first {LEAD_IN} are a count-in. Then play a short muted strum or
                    single note exactly on each click. alphaJam measures how late your playing arrives through the audio
                    input.
                </p>
                <p className={styles.muted}>
                    Use the speakers or headphones you practice with. If hits still feel early or late in a song,
                    fine-tune the latency slider; the end-of-song summary also suggests a correction.
                </p>
                {!context && <p className={styles.error}>Start the audio input first.</p>}
                <div className={styles.clickRow} aria-hidden="true">
                    {Array.from({ length: CLICKS }, (_, i) => (
                        <span
                            key={i}
                            className={[
                                styles.clickDot,
                                i < LEAD_IN ? styles.clickLeadIn : '',
                                i === click ? styles.clickActive : '',
                                i < click ? styles.clickDone : ''
                            ].join(' ')}
                        />
                    ))}
                </div>
                <p className={styles.calibrationStatus} aria-live="polite">
                    {phase === 'ready' && `Current latency: ${latencyMs} ms.`}
                    {phase === 'running' && (click < LEAD_IN ? 'Get ready…' : 'Play on every click!')}
                    {phase === 'done' &&
                        result &&
                        (result.latencyMs === null
                            ? `Only ${result.pairs} of ${CLICKS - LEAD_IN} clicks were matched (need ${MIN_PAIRS}). Check the input level and try again.`
                            : `Measured ${result.latencyMs} ms over ${result.pairs} clicks (±${result.spreadMs} ms).`)}
                </p>
            </div>
        </Dialog>
    );
}

interface SummaryDialogProps {
    stats: JamStats;
    toleranceMs: number;
    latencyMs: number;
    /** Only the selected bars were played. */
    selection?: boolean;
    onApplyLatency: (latencyMs: number) => void;
    onPlayAgain: () => void;
    onClose: () => void;
}

/** Results at the end of a play-through. */
export function SummaryDialog({
    stats,
    toleranceMs,
    latencyMs,
    selection = false,
    onApplyLatency,
    onPlayAgain,
    onClose
}: SummaryDialogProps) {
    const share = accuracy(stats);
    const misses = stats.judged - stats.hits;
    const averageOffset = stats.hits > 0 ? Math.round(stats.offsetSumMs / stats.hits) : null;
    // A steady offset over many hits is most likely uncorrected latency, not the player's timing.
    const suggestLatency =
        averageOffset !== null && stats.hits >= 8 && Math.abs(averageOffset) >= Math.max(15, toleranceMs / 4);

    return (
        <Dialog
            title={selection ? 'Selection complete' : 'Song complete'}
            onClose={onClose}
            footer={
                <div className={styles.dialogFooter}>
                    <button type="button" className={styles.button} onClick={onClose}>
                        Close
                    </button>
                    <button type="button" className={styles.primaryButton} onClick={onPlayAgain}>
                        Play again
                    </button>
                </div>
            }>
            <div className={styles.dialogBody}>
                <div className={styles.summaryScore}>{share === null ? '–' : `${Math.round(share * 100)}%`}</div>
                <dl className={styles.summaryGrid}>
                    <dt>Notes hit</dt>
                    <dd>
                        {stats.hits} / {stats.judged}
                    </dd>
                    <dt>Missed or wrong</dt>
                    <dd>{misses}</dd>
                    <dt>Best streak</dt>
                    <dd>{stats.bestStreak}</dd>
                    <dt>Average timing</dt>
                    <dd>
                        {averageOffset === null
                            ? '–'
                            : averageOffset === 0
                              ? 'on time'
                              : `${Math.abs(averageOffset)} ms ${averageOffset > 0 ? 'late' : 'early'}`}
                    </dd>
                    <dt>Early / late hits</dt>
                    <dd>
                        {stats.early} / {stats.late}
                    </dd>
                </dl>
                {suggestLatency && averageOffset !== null && (
                    <div className={styles.suggestion}>
                        <span>
                            Your hits were {Math.abs(averageOffset)} ms {averageOffset > 0 ? 'late' : 'early'} on
                            average, which usually means the latency setting is off.
                        </span>
                        <button
                            type="button"
                            className={styles.button}
                            onClick={() => onApplyLatency(latencyMs + averageOffset)}>
                            Set latency to {latencyMs + averageOffset} ms
                        </button>
                    </div>
                )}
            </div>
        </Dialog>
    );
}
