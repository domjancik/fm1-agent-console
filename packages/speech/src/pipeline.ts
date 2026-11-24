import { ASR_SAMPLE_RATE, loadWavFor16k } from "./audio/load";
import { resample } from "./audio/resample";
import { encodeWav } from "./audio/wav";
import type { AsrEngine } from "./asr/engine";
import { gate, type AudioStats, type GateOptions, type RejectReason } from "./gate";
import { postprocess } from "./postprocess";
import type { VocabularyEntry } from "./text/vocabulary";

export interface PipelineOptions {
  engine: AsrEngine;
  language?: string;
  gate?: Partial<GateOptions>;
  vocabulary?: readonly VocabularyEntry[];
  spokenPunctuation?: boolean;
  /** Write the 16 kHz input to this WAV path. Off by default: no audio is persisted unless asked. */
  keepAudioPath?: string;
  signal?: AbortSignal;
}

export interface Timings {
  loadMs: number;
  asrMs: number;
  totalMs: number;
}

export interface PipelineResult {
  text: string;
  raw: string;
  engine: string;
  language: string;
  timings: Timings;
  audio: AudioStats;
  rejected?: RejectReason;
}

/** Gate -> engine -> post-process, on PCM at any sample rate (mono, 16-bit). */
export async function transcribePcm(pcm: Int16Array, sampleRate: number, options: PipelineOptions): Promise<PipelineResult> {
  if (!Number.isFinite(sampleRate) || sampleRate < 1) throw new RangeError(`invalid sample rate: ${sampleRate}`);
  const started = performance.now();
  const language = options.language ?? "en";
  const pcm16k = resample(pcm, sampleRate, ASR_SAMPLE_RATE);
  if (options.keepAudioPath) await Bun.write(options.keepAudioPath, encodeWav(pcm16k, ASR_SAMPLE_RATE));

  const verdict = gate(pcm16k, ASR_SAMPLE_RATE, options.gate);
  const base = { engine: options.engine.id, language, audio: verdict.stats };
  if (!verdict.accepted) {
    return { ...base, text: "", raw: "", rejected: verdict.reason, timings: { loadMs: 0, asrMs: 0, totalMs: performance.now() - started } };
  }

  const load = await options.engine.load();
  const result = await options.engine.transcribe(pcm16k, { language, signal: options.signal });
  const text = postprocess(result.text, { vocabulary: options.vocabulary, spokenPunctuation: options.spokenPunctuation });
  return {
    ...base,
    text,
    raw: result.text,
    timings: { loadMs: load.ms, asrMs: result.ms, totalMs: performance.now() - started },
  };
}

export async function transcribeFile(path: string, options: PipelineOptions): Promise<PipelineResult> {
  const audio = await loadWavFor16k(path);
  return transcribePcm(audio.pcm, audio.sampleRate, options);
}
