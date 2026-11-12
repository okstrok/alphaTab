/**
 * Latency calibration: clicks are played, the player strikes the strings on each click, and the
 * median delay between the audible click and the detected strike is the latency of the loop.
 * DOM-free apart from the Web Audio calls in `playClicks`.
 */

/** Clicks per calibration run; the first `LEAD_IN` are only for getting into the beat. */
export const CLICKS = 12;
export const LEAD_IN = 4;
export const CLICK_INTERVAL_MS = 600;
/** A strike further than this from every click is ignored, in ms. */
const MAX_PAIR_MS = 280;
/** Measured clicks needed for a result. */
export const MIN_PAIRS = 4;

/**
 * Plays the calibration clicks on `context` and returns their audible times as `performance.now()`
 * values. The first click sounds about `startDelayMs` from now.
 */
export function playClicks(context: AudioContext, startDelayMs = 800): number[] {
    const start = context.currentTime + startDelayMs / 1000;
    const times: number[] = [];
    // Maps context time to the moment the sound leaves the speakers.
    const stamp = context.getOutputTimestamp?.();
    const toPerformance = (contextTime: number) =>
        stamp?.contextTime !== undefined && stamp.performanceTime !== undefined && stamp.performanceTime > 0
            ? stamp.performanceTime + (contextTime - stamp.contextTime) * 1000
            : performance.now() +
              (contextTime - context.currentTime + (context.outputLatency || context.baseLatency || 0)) * 1000;

    for (let i = 0; i < CLICKS; i++) {
        const t = start + (i * CLICK_INTERVAL_MS) / 1000;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.frequency.value = i < LEAD_IN ? 1000 : 1600;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.6, t + 0.002);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(t);
        oscillator.stop(t + 0.06);
        times.push(toPerformance(t));
    }
    return times;
}

export interface CalibrationResult {
    /** Median delay from click to strike in ms, or null with too few measured clicks. */
    latencyMs: number | null;
    /** Clicks a strike was found for. */
    pairs: number;
    /** Spread of the delays (median absolute deviation) in ms, a hint how steady the strikes were. */
    spreadMs: number | null;
}

/** Pairs each measured click with the closest strike and returns the median delay. */
export function evaluateCalibration(clickTimes: number[], strikeTimes: number[]): CalibrationResult {
    const delays: number[] = [];
    for (const click of clickTimes.slice(LEAD_IN)) {
        let best: number | null = null;
        for (const strike of strikeTimes) {
            const delay = strike - click;
            if (Math.abs(delay) <= MAX_PAIR_MS && (best === null || Math.abs(delay) < Math.abs(best))) {
                best = delay;
            }
        }
        if (best !== null) {
            delays.push(best);
        }
    }
    if (delays.length < MIN_PAIRS) {
        return { latencyMs: null, pairs: delays.length, spreadMs: null };
    }
    const latency = median(delays);
    return {
        latencyMs: Math.round(latency),
        pairs: delays.length,
        spreadMs: Math.round(median(delays.map(d => Math.abs(d - latency))))
    };
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
