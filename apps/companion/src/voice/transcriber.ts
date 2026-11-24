// Speech -> text. The real path is @fm1/speech (gate -> Parakeet/Apple -> post-process); tests can
// substitute a scripted engine but keep the real silence gate.
import {
  AsrError,
  createEngine,
  gate,
  loadVocabulary,
  transcribePcm,
  type AsrEngine,
  type AudioStats,
  type EngineId,
  type RejectReason,
  type VocabularyEntry,
} from "@fm1/speech";
import type { CapturedAudio } from "./capture";

/** What the pipeline did with a take, for the per-take diagnostics (never the transcript text). */
export interface TakeDetail {
  gate: "accepted" | RejectReason;
  engine: string;
  /** ASR time only (0 when the gate rejected the take). */
  asrMs: number;
  /** Length of the post-processed transcript. */
  chars: number;
  /** The 16 kHz mono stream as the gate measured it. */
  gateStats?: AudioStats;
}

export type TranscriptOutcome = (
  | { ok: true; text: string; engine: string; ms: number }
  | { ok: false; reason: string }
) & { detail?: TakeDetail };

export interface Transcriber {
  readonly id: string;
  transcribe(audio: CapturedAudio, signal?: AbortSignal): Promise<TranscriptOutcome>;
  dispose(): Promise<void>;
}

const REJECT_TEXT: Record<string, string> = { empty: "no audio", too_short: "recording too short", silent: "silent recording" };

export interface SpeechTranscriberOptions {
  engine: EngineId;
  language: string;
  vocabularyFile: string | null;
  /** Inject a ready engine (tests); otherwise one is created lazily on first use. */
  engineInstance?: AsrEngine;
}

export class SpeechTranscriber implements Transcriber {
  readonly id: string;
  private engine: AsrEngine | null;
  private vocabulary: readonly VocabularyEntry[] | null = null;

  constructor(private readonly opts: SpeechTranscriberOptions) {
    this.id = `speech:${opts.engine}`;
    this.engine = opts.engineInstance ?? null;
  }

  /** Loads the model ahead of the first REC (spec 13: cold start should not hit the first prompt). */
  async warm(): Promise<number> {
    return (await this.getEngine().load()).ms;
  }

  async transcribe(audio: CapturedAudio, signal?: AbortSignal): Promise<TranscriptOutcome> {
    try {
      this.vocabulary ??= await loadVocabulary(this.opts.vocabularyFile ?? undefined);
      const r = await transcribePcm(audio.pcm, audio.sampleRate, {
        engine: this.getEngine(),
        language: this.opts.language,
        vocabulary: this.vocabulary,
        signal,
      });
      const detail: TakeDetail = { gate: r.rejected ?? "accepted", engine: r.engine, asrMs: Math.round(r.timings.asrMs), chars: r.text.length, gateStats: r.audio };
      if (r.rejected) return { ok: false, reason: REJECT_TEXT[r.rejected] ?? r.rejected, detail };
      if (r.text.trim().length === 0) return { ok: false, reason: "no speech recognised", detail };
      return { ok: true, text: r.text, engine: r.engine, ms: Math.round(r.timings.totalMs), detail };
    } catch (e) {
      const code = e instanceof AsrError ? `${e.code}: ` : "";
      return { ok: false, reason: `${code}${e instanceof Error ? e.message : String(e)}` };
    }
  }

  async dispose(): Promise<void> {
    await this.engine?.dispose();
    this.engine = null;
  }

  private getEngine(): AsrEngine {
    this.engine ??= createEngine(this.opts.engine);
    return this.engine;
  }
}

/**
 * Deterministic transcriber for tests and demos: the real gate decides silent/too short,
 * anything voiced becomes `text`.
 */
export class ScriptedTranscriber implements Transcriber {
  readonly id = "scripted";
  calls = 0;

  constructor(public text: string) {}

  async transcribe(audio: CapturedAudio): Promise<TranscriptOutcome> {
    this.calls++;
    const v = gate(audio.pcm, audio.sampleRate);
    const detail: TakeDetail = { gate: v.accepted ? "accepted" : (v.reason ?? "empty"), engine: this.id, asrMs: 0, chars: v.accepted ? this.text.length : 0, gateStats: v.stats };
    if (!v.accepted) return { ok: false, reason: REJECT_TEXT[v.reason ?? "empty"] ?? "rejected", detail };
    return { ok: true, text: this.text, engine: this.id, ms: 0, detail };
  }

  async dispose(): Promise<void> {}
}
