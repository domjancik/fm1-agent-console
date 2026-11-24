/** Common interface for local speech recognizers. Input is always 16 kHz mono 16-bit PCM. */

export interface TranscribeOptions {
  /** BCP-47 language tag or ISO 639-1 code, e.g. "en", "en-US". */
  language: string;
  signal?: AbortSignal;
}

export interface Transcription {
  text: string;
  /** Recognition time in milliseconds, excluding model load. */
  ms: number;
}

export interface LoadInfo {
  /** Time spent loading in this call; 0 when the engine was already loaded. */
  ms: number;
}

export interface AsrEngine {
  readonly id: string;
  /** Whether the engine can handle this language at all. */
  supportsLanguage(language: string): boolean;
  load(): Promise<LoadInfo>;
  transcribe(pcm16k: Int16Array, opts: TranscribeOptions): Promise<Transcription>;
  dispose(): Promise<void>;
}

export type AsrErrorCode =
  | "model_missing"
  | "load_failed"
  | "language_unsupported"
  | "worker_crashed"
  | "timeout"
  | "transcribe_failed"
  | "cancelled"
  | "helper_missing"
  | "assets_not_installed"
  | "disposed";

export class AsrError extends Error {
  override name = "AsrError";
  constructor(
    readonly code: AsrErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function baseLanguage(language: string): string {
  return language.toLowerCase().split(/[-_]/)[0] ?? "";
}
