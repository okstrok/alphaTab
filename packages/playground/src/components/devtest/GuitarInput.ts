import { PitchDetector, type PitchResult } from './PitchDetector';

/** One analysis step of the live input. `pitch` is null while the input is silent or noisy. */
export interface InputFrame {
    /** Smoothed pitch, held briefly after the note fades so the display doesn't flicker. */
    pitch: PitchResult | null;
    /** Raw RMS level of the current frame, for the input meter. */
    rms: number;
}

export type InputState = 'idle' | 'starting' | 'running' | 'error';

export interface GuitarInputListener {
    onFrame(frame: InputFrame): void;
    onStateChanged(state: InputState, error?: string): void;
}

/** How often the pitch is analysed, in milliseconds (~30 per second). */
const ANALYSIS_INTERVAL_MS = 33;
/** Number of detections the median runs over. */
const SMOOTHING_WINDOW = 5;
/** How long the last pitch stays on screen after the signal drops, in milliseconds. */
const HOLD_MS = 600;

/**
 * Captures a guitar from an audio input (audio interface, USB guitar cable or microphone)
 * and runs pitch detection on it.
 *
 * The browser's voice processing (echo cancellation, noise suppression, auto gain) is turned
 * off: it is tuned for speech and squashes or gates sustained instrument notes.
 */
export class GuitarInput {
    private _context: AudioContext | null = null;
    private _stream: MediaStream | null = null;
    private _analyser: AnalyserNode | null = null;
    private _detector: PitchDetector | null = null;
    private _buffer: Float32Array<ArrayBuffer> = new Float32Array(0);
    private _timer: number | undefined;
    private _recent: number[] = [];
    private _lastPitch: PitchResult | null = null;
    private _lastPitchTime = 0;
    private _state: InputState = 'idle';

    public constructor(private readonly _listener: GuitarInputListener) {}

    public get state(): InputState {
        return this._state;
    }

    public get sampleRate(): number | undefined {
        return this._context?.sampleRate;
    }

    /** Lists audio inputs. Labels are only filled in after the user granted microphone access. */
    public static async listInputs(): Promise<MediaDeviceInfo[]> {
        if (!navigator.mediaDevices?.enumerateDevices) {
            return [];
        }
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter(d => d.kind === 'audioinput');
    }

    public async start(deviceId?: string): Promise<void> {
        await this.stop();
        this._setState('starting');
        try {
            if (!navigator.mediaDevices?.getUserMedia) {
                throw new Error('This browser does not support audio input (getUserMedia).');
            }
            this._stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    deviceId: deviceId ? { exact: deviceId } : undefined,
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            });

            const context = new AudioContext({ latencyHint: 'interactive' });
            this._context = context;
            if (context.state === 'suspended') {
                await context.resume();
            }

            this._detector = new PitchDetector({ sampleRate: context.sampleRate });
            const analyser = context.createAnalyser();
            analyser.fftSize = nextPowerOfTwo(this._detector.requiredFrameSize);
            analyser.smoothingTimeConstant = 0;
            context.createMediaStreamSource(this._stream).connect(analyser);
            this._analyser = analyser;
            this._buffer = new Float32Array(analyser.fftSize);

            this._timer = window.setInterval(() => this._analyse(), ANALYSIS_INTERVAL_MS);
            this._setState('running');
        } catch (e) {
            await this.stop();
            this._setState('error', describeError(e));
        }
    }

    public async stop(): Promise<void> {
        if (this._timer !== undefined) {
            window.clearInterval(this._timer);
            this._timer = undefined;
        }
        for (const track of this._stream?.getTracks() ?? []) {
            track.stop();
        }
        this._stream = null;
        this._analyser = null;
        this._detector = null;
        this._recent = [];
        this._lastPitch = null;
        const context = this._context;
        this._context = null;
        if (context && context.state !== 'closed') {
            await context.close();
        }
        if (this._state !== 'idle' && this._state !== 'error') {
            this._setState('idle');
        }
    }

    private _analyse(): void {
        const analyser = this._analyser;
        const detector = this._detector;
        if (!analyser || !detector) {
            return;
        }
        analyser.getFloatTimeDomainData(this._buffer);
        const raw = detector.detect(this._buffer);
        const now = performance.now();

        let pitch: PitchResult | null = null;
        if (raw) {
            this._recent.push(raw.frequency);
            if (this._recent.length > SMOOTHING_WINDOW) {
                this._recent.shift();
            }
            pitch = { ...raw, frequency: median(this._recent) };
            this._lastPitch = pitch;
            this._lastPitchTime = now;
        } else {
            this._recent = [];
            if (this._lastPitch && now - this._lastPitchTime < HOLD_MS) {
                pitch = this._lastPitch;
            }
        }

        this._listener.onFrame({ pitch, rms: PitchDetector.rms(this._buffer) });
    }

    private _setState(state: InputState, error?: string): void {
        this._state = state;
        this._listener.onStateChanged(state, error);
    }
}

function nextPowerOfTwo(value: number): number {
    // AnalyserNode accepts 32..32768.
    let size = 32;
    while (size < value && size < 32768) {
        size *= 2;
    }
    return size;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function describeError(e: unknown): string {
    if (e instanceof DOMException) {
        switch (e.name) {
            case 'NotAllowedError':
                return 'Microphone access was denied. Allow it in the browser’s site settings and try again.';
            case 'NotFoundError':
            case 'OverconstrainedError':
                return 'The selected audio input was not found. Plug it in or pick another input.';
            case 'NotReadableError':
                return 'The audio input is busy or unavailable. Close other apps using it and try again.';
        }
    }
    return e instanceof Error ? e.message : String(e);
}
