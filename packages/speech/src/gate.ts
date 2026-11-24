import { frameLevelsDbfs, peak, rms, toDbfs } from "./audio/level";

export type RejectReason = "empty" | "too_short" | "silent";

export interface GateOptions {
  /** Shorter recordings are rejected as accidental taps. */
  minDurationMs: number;
  /** A 30 ms frame counts as voiced at or above this level. */
  voicedFrameDbfs: number;
  /** Minimum total voiced time. */
  minVoicedMs: number;
}

export const DEFAULT_GATE: GateOptions = { minDurationMs: 300, voicedFrameDbfs: -40, minVoicedMs: 200 };

export interface AudioStats {
  durationMs: number;
  rmsDbfs: number;
  peakDbfs: number;
  voicedMs: number;
}

export interface GateResult {
  accepted: boolean;
  reason?: RejectReason;
  stats: AudioStats;
}

const FRAME_MS = 30;

export function measure(pcm: Int16Array, sampleRate: number, voicedFrameDbfs = DEFAULT_GATE.voicedFrameDbfs): AudioStats {
  const voicedFrames = frameLevelsDbfs(pcm, sampleRate, FRAME_MS).filter((db) => db >= voicedFrameDbfs).length;
  return {
    durationMs: (pcm.length / sampleRate) * 1000,
    rmsDbfs: toDbfs(rms(pcm)),
    peakDbfs: toDbfs(peak(pcm)),
    voicedMs: voicedFrames * FRAME_MS,
  };
}

/** Rejects empty, too-short and near-silent audio before it reaches the ASR engine. */
export function gate(pcm: Int16Array, sampleRate: number, options: Partial<GateOptions> = {}): GateResult {
  const opts = { ...DEFAULT_GATE, ...options };
  const stats = measure(pcm, sampleRate, opts.voicedFrameDbfs);
  if (pcm.length === 0) return { accepted: false, reason: "empty", stats };
  if (stats.durationMs < opts.minDurationMs) return { accepted: false, reason: "too_short", stats };
  if (stats.voicedMs < opts.minVoicedMs) return { accepted: false, reason: "silent", stats };
  return { accepted: true, stats };
}
