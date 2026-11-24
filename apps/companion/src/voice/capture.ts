// Push-to-talk audio sources. The companion talks to `Capture`; tests inject FixtureCapture (WAV file, no mic).
import { MicCapture, decodeWav, toMono, type RawAudio } from "@fm1/speech";
import { systemClock, type Clock, type Timer } from "@fm1/device-protocol";

export interface CapturedAudio {
  /** Mono PCM: the only audio the gate and the ASR engine see. */
  pcm: Int16Array;
  sampleRate: number;
  /** The raw capture (all channels, input rate) for per-channel diagnostics and kept recordings; never transcribed. */
  raw?: RawAudio;
  /** Input device name, when known. */
  device?: string;
}

/** 0..100 level callback, at most ~10 Hz. */
export type LevelSink = (level: number) => void;

export interface Capture {
  readonly id: string;
  start(onLevel: LevelSink): Promise<void>;
  stop(): Promise<CapturedAudio>;
  cancel(): Promise<void>;
}

export type CaptureFactory = () => Capture;

export const LEVEL_INTERVAL_MS = 100;

/** RMS (0..1 full scale) -> 0..100 on a -60..0 dBFS scale. */
export function levelFromRms(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(100, Math.round(((db + 60) / 60) * 100)));
}

function rmsOf(pcm: Int16Array, start: number, end: number): number {
  let sum = 0;
  const n = Math.max(0, end - start);
  for (let i = start; i < end; i++) {
    const s = (pcm[i] ?? 0) / 32768;
    sum += s * s;
  }
  return n === 0 ? 0 : Math.sqrt(sum / n);
}

/** Reads a WAV once into memory; every capture replays it (levels from the file itself). */
export async function loadFixtureAudio(path: string): Promise<CapturedAudio> {
  const wav = decodeWav(new Uint8Array(await Bun.file(path).arrayBuffer()));
  return { pcm: toMono(wav.samples, wav.channels), sampleRate: wav.sampleRate, raw: { samples: wav.samples, sampleRate: wav.sampleRate, channels: wav.channels } };
}

/** Stands in for the microphone: levels follow the file's loudness, stop() returns the whole file. */
export class FixtureCapture implements Capture {
  readonly id: string;
  private timer: Timer | null = null;
  private pos = 0;
  private active = false;
  startCount = 0;

  constructor(
    private readonly audio: CapturedAudio,
    private readonly clock: Clock = systemClock,
    name = "fixture",
  ) {
    this.id = `fixture:${name}`;
  }

  static async fromFile(path: string, clock?: Clock): Promise<FixtureCapture> {
    return new FixtureCapture(await loadFixtureAudio(path), clock, path.split("/").pop());
  }

  async start(onLevel: LevelSink): Promise<void> {
    if (this.active) throw new Error("capture already running");
    this.active = true;
    this.startCount++;
    this.pos = 0;
    const chunk = Math.round((this.audio.sampleRate * LEVEL_INTERVAL_MS) / 1000);
    const tick = (): void => {
      if (!this.active) return;
      const end = Math.min(this.audio.pcm.length, this.pos + chunk);
      onLevel(levelFromRms(rmsOf(this.audio.pcm, this.pos, end)));
      this.pos = end;
      this.timer = this.clock.schedule(LEVEL_INTERVAL_MS, tick);
    };
    this.timer = this.clock.schedule(LEVEL_INTERVAL_MS, tick);
  }

  async stop(): Promise<CapturedAudio> {
    if (!this.active) throw new Error("capture not running");
    this.halt();
    return { ...this.audio };
  }

  async cancel(): Promise<void> {
    this.halt();
  }

  private halt(): void {
    this.active = false;
    this.timer?.cancel();
    this.timer = null;
  }
}

/** The real microphone via the fm1-mic helper. One MicCapture per take (it is single-use). */
export class MicCaptureSource implements Capture {
  readonly id = "mic";
  private mic: MicCapture | null = null;
  private lastLevelAt = 0;
  private device: string | undefined;

  constructor(private readonly deviceUid?: string) {}

  async start(onLevel: LevelSink): Promise<void> {
    // keepRaw: the helper also hands over the unconverted channels (diagnostics only; ASR still gets the mono stream).
    const mic = new MicCapture({ ...(this.deviceUid ? { deviceUid: this.deviceUid } : {}), keepRaw: true });
    this.mic = mic;
    mic.onLevel((rms) => {
      const now = performance.now();
      if (now - this.lastLevelAt < LEVEL_INTERVAL_MS) return;
      this.lastLevelAt = now;
      onLevel(levelFromRms(rms));
    });
    this.device = (await mic.start()).device?.name;
  }

  async stop(): Promise<CapturedAudio> {
    const mic = this.mic;
    if (!mic) throw new Error("capture not running");
    this.mic = null;
    const r = await mic.stop();
    return { pcm: r.pcm, sampleRate: r.sampleRate, ...(r.raw ? { raw: r.raw } : {}), ...(this.device ? { device: this.device } : {}) };
  }

  async cancel(): Promise<void> {
    const mic = this.mic;
    this.mic = null;
    await mic?.cancel();
  }
}
