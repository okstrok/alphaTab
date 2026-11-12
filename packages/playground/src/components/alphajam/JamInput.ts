import { GuitarInput, type InputState } from '../devtest/GuitarInput';
import { PitchDetector } from '../devtest/PitchDetector';
import { type Onset, OnsetDetector } from './OnsetDetector';
import type { AnalysisFrame } from './PitchJudge';
import { Spectrum } from './Spectrum';

/** Analysis hop: strikes are timed to this resolution, in ms. */
const HOP_MS = 10;
/** Pitch and spectrum are computed on every n-th hop. */
const PITCH_EVERY = 2;
/** FFT size of the chord check: ~5.9 Hz per bin at 48 kHz. */
export const SPECTRUM_SIZE = 8192;
/** Samples of the level window per hop. */
const LEVEL_SECONDS = 0.01;
/** Samples of the monophonic pitch window. */
const PITCH_SAMPLES = 2048;
/** How long analysis frames are kept for the judge, in ms. */
const KEEP_MS = 3000;

export interface JamInputListener {
    onStrike(onset: Onset): void;
    onStateChanged(state: InputState, error?: string): void;
}

/** What the input hears right now, for the meter and the note display. */
export interface InputSnapshot {
    rms: number;
    frequency: number | null;
}

/**
 * Live guitar input of alphaJam: strike times, monophonic pitch and spectra of the last seconds.
 *
 * Like the tuner it turns off the browser's voice processing. It polls an `AnalyserNode` every
 * 10 ms; every frame is stamped with `performance.now()`, the constant delay of the input path
 * is left to the latency calibration.
 */
export class JamInput {
    private _context: AudioContext | null = null;
    private _stream: MediaStream | null = null;
    private _analyser: AnalyserNode | null = null;
    private _buffer: Float32Array<ArrayBuffer> = new Float32Array(0);
    private _detector: PitchDetector | null = null;
    private _spectrum = new Spectrum(SPECTRUM_SIZE);
    private _onsets = new OnsetDetector();
    private _frames: AnalysisFrame[] = [];
    private _timer: number | undefined;
    private _hop = 0;
    private _state: InputState = 'idle';
    private _snapshot: InputSnapshot = { rms: 0, frequency: null };

    public constructor(private readonly _listener: JamInputListener) {}

    public get state(): InputState {
        return this._state;
    }

    public get sampleRate(): number {
        return this._context?.sampleRate ?? 48000;
    }

    /** The audio context of the input, also used to play the calibration clicks. */
    public get context(): AudioContext | null {
        return this._context;
    }

    public get snapshot(): InputSnapshot {
        return this._snapshot;
    }

    /** Analysis frames of the last seconds, oldest first. */
    public get frames(): readonly AnalysisFrame[] {
        return this._frames;
    }

    public static listInputs(): Promise<MediaDeviceInfo[]> {
        return GuitarInput.listInputs();
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
            this._detector = new PitchDetector({ sampleRate: context.sampleRate, minFrequency: 60 });
            const analyser = context.createAnalyser();
            analyser.fftSize = SPECTRUM_SIZE;
            analyser.smoothingTimeConstant = 0;
            context.createMediaStreamSource(this._stream).connect(analyser);
            this._analyser = analyser;
            this._buffer = new Float32Array(SPECTRUM_SIZE);
            this._timer = window.setInterval(() => this._analyse(), HOP_MS);
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
        this._frames = [];
        this._onsets.reset();
        this._snapshot = { rms: 0, frequency: null };
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
        const context = this._context;
        if (!analyser || !detector || !context) {
            return;
        }
        const time = performance.now();
        analyser.getFloatTimeDomainData(this._buffer);
        const buffer = this._buffer;
        const levelSamples = Math.round(context.sampleRate * LEVEL_SECONDS);
        const rms = PitchDetector.rms(buffer.subarray(buffer.length - levelSamples));

        let midi: number | null | undefined;
        if (this._hop++ % PITCH_EVERY === 0) {
            const pitch = detector.detect(buffer.subarray(buffer.length - PITCH_SAMPLES));
            const frequency = pitch?.frequency ?? null;
            midi = frequency === null ? null : Math.round(69 + 12 * Math.log2(frequency / 440));
            this._frames.push({ time, frequency, spectrum: this._spectrum.magnitudes(buffer) });
            while (this._frames.length > 0 && this._frames[0].time < time - KEEP_MS) {
                this._frames.shift();
            }
            this._snapshot = { rms, frequency };
        } else {
            this._snapshot = { ...this._snapshot, rms };
        }

        const onset = this._onsets.process(time, rms, midi);
        if (onset) {
            this._listener.onStrike(onset);
        }
    }

    private _setState(state: InputState, error?: string): void {
        this._state = state;
        this._listener.onStateChanged(state, error);
    }
}

function describeError(e: unknown): string {
    if (e instanceof DOMException) {
        switch (e.name) {
            case 'NotAllowedError':
                return 'Audio input access was denied. Allow it in the browser’s site settings and try again.';
            case 'NotFoundError':
            case 'OverconstrainedError':
                return 'The selected audio input was not found. Plug it in or pick another input.';
            case 'NotReadableError':
                return 'The audio input is busy or unavailable. Close other apps using it and try again.';
        }
    }
    return e instanceof Error ? e.message : String(e);
}
