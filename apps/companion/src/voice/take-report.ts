// Per-take diagnostics: one "voice" log line and the kept recording's sidecar. Never puts transcript text in the log.
import { takeStats, type AudioStats, type TakeStats } from "@fm1/speech";
import type { CapturedAudio } from "./capture";
import type { TranscriptOutcome } from "./transcriber";

/** What became of the take: a transcript reached the composer, the pipeline failed it, or FX discarded it. */
export type TakeOutcome = "transcript" | "failed" | "cancelled";

export function statsOf(audio: CapturedAudio): TakeStats {
  return takeStats(audio.pcm, audio.sampleRate, audio.raw);
}

const db = (v: number): string => v.toFixed(1);
const levels = (s: AudioStats): string => `rms ${db(s.rmsDbfs)} peak ${db(s.peakDbfs)} dBFS voiced ${s.voicedMs} ms`;

export function takeLine(stats: TakeStats, r: TranscriptOutcome, outcome: TakeOutcome, device: string | undefined, kept: string | null): string {
  const parts = [`take ${(stats.durationMs / 1000).toFixed(2)} s, ${stats.sampleRate} Hz x${stats.channels}${device ? ` (${device})` : ""}`];
  for (const c of stats.perChannel) parts.push(`${c.label} ${levels(c)}`);
  parts.push(`mono ${stats.mono.sampleRate} Hz ${levels(stats.mono)}`);
  const d = r.detail;
  parts.push(`gate ${d?.gate ?? "?"}`, `engine ${d?.engine ?? "?"}`, `asr ${d?.asrMs ?? 0} ms`, `transcript ${d?.chars ?? 0} chars`);
  parts.push(outcome === "failed" && !r.ok ? `outcome failed (${r.reason})` : `outcome ${outcome}`);
  if (kept) parts.push(`kept ${kept}`);
  return parts.join("; ");
}

/** The JSON stored next to a kept recording. The transcript text is included only when the take succeeded. */
export function takeSidecar(stats: TakeStats, r: TranscriptOutcome, outcome: TakeOutcome, device: string | undefined): Record<string, unknown> {
  return {
    version: 1,
    device: device ?? null,
    outcome,
    ...(r.ok ? {} : { reason: r.reason }),
    gate: r.detail?.gate ?? null,
    engine: r.detail?.engine ?? null,
    asrMs: r.detail?.asrMs ?? null,
    chars: r.detail?.chars ?? 0,
    stats,
    gateStats: r.detail?.gateStats ?? null,
    ...(r.ok && outcome === "transcript" ? { transcript: r.text } : {}),
  };
}
