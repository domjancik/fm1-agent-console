import { int16ToBytes } from "../audio/pcm";
import { BUILD_HINT, nativeHelperExists, nativeHelperPath } from "../native";
import { AsrError, type AsrEngine, type LoadInfo, type TranscribeOptions, type Transcription } from "./engine";

/** Locales DictationTranscriber resolves for a bare language code. */
const DEFAULT_LOCALE: Record<string, string> = { en: "en_US", he: "he_IL", de: "de_DE", fr: "fr_FR", es: "es_ES", cs: "cs_CZ" };

function toLocale(language: string): string {
  const [lang = "", region] = language.split(/[-_]/);
  if (region) return `${lang.toLowerCase()}_${region.toUpperCase()}`;
  return DEFAULT_LOCALE[lang.toLowerCase()] ?? `${lang.toLowerCase()}_${lang.toUpperCase()}`;
}

interface HelperReply {
  text?: string;
  ms?: number;
  error?: string;
  message?: string;
  assetsInstalled?: boolean;
}

/**
 * Apple on-device dictation (macOS 26+ DictationTranscriber) through the fm1-dictate Swift helper.
 * PCM is piped over stdin; nothing is written to disk. Optional: weaker on identifiers than Parakeet,
 * but it covers locales Parakeet lacks (for example he_IL when its assets are installed).
 */
export class AppleDictationEngine implements AsrEngine {
  readonly id = "apple-dictation";
  private readonly helper: string;

  constructor(helperPath = nativeHelperPath("fm1-dictate")) {
    this.helper = helperPath;
  }

  supportsLanguage(): boolean {
    return true; // checked per call against installed assets
  }

  async load(): Promise<LoadInfo> {
    if (!nativeHelperExists(this.helper)) throw new AsrError("helper_missing", `fm1-dictate not found at ${this.helper}; ${BUILD_HINT}`);
    return { ms: 0 }; // the recognizer lives in a system daemon
  }

  async status(language: string): Promise<{ assetsInstalled: boolean }> {
    await this.load();
    const reply = await this.run(["status", "--locale", toLocale(language)]);
    return { assetsInstalled: reply.assetsInstalled === true };
  }

  async transcribe(pcm16k: Int16Array, opts: TranscribeOptions): Promise<Transcription> {
    await this.load();
    const reply = await this.run(["transcribe", "--locale", toLocale(opts.language), "--rate", "16000"], int16ToBytes(pcm16k), opts.signal);
    if (reply.error === "assets_not_installed") throw new AsrError("assets_not_installed", reply.message ?? "assets not installed");
    if (reply.error || typeof reply.text !== "string") {
      throw new AsrError("transcribe_failed", reply.message ?? reply.error ?? "fm1-dictate returned no text");
    }
    return { text: reply.text.trim(), ms: reply.ms ?? 0 };
  }

  async dispose(): Promise<void> {}

  private async run(args: string[], input?: Uint8Array, signal?: AbortSignal): Promise<HelperReply> {
    const proc = Bun.spawn([this.helper, ...args], { stdin: input ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe" });
    const onAbort = (): void => proc.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (input && proc.stdin) {
        proc.stdin.write(input);
        await proc.stdin.end();
      }
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (signal?.aborted) throw new AsrError("cancelled", "transcription cancelled");
      const line = out.trim().split("\n").pop() ?? "";
      try {
        return JSON.parse(line) as HelperReply;
      } catch {
        throw new AsrError("transcribe_failed", `fm1-dictate gave no JSON (stderr: ${err.trim().slice(0, 200)})`);
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
