// Runs the audio side of the voice composer: REC down -> capture, REC up -> transcribe -> REVIEWING.
// The composer (agent-core) owns state and the locked destination; this only feeds it.
import type { AgentConsole } from "@fm1/agent-core";
import type { DiagLog } from "../diag-log";
import type { Capture, CaptureFactory, CapturedAudio } from "./capture";
import type { RecordingStore } from "./recordings";
import { statsOf, takeLine, takeSidecar, type TakeOutcome } from "./take-report";
import type { Transcriber, TranscriptOutcome } from "./transcriber";

export class VoiceController {
  private capture: Capture | null = null;
  private recordings: RecordingStore | null = null;
  private starting: Promise<void> | null = null;
  private take = 0;
  private abort: AbortController | null = null;
  /** Resolves when the current take (capture + transcription) has finished. */
  private work: Promise<void> = Promise.resolve();

  constructor(
    private readonly console: AgentConsole,
    private readonly newCapture: CaptureFactory,
    private readonly transcriber: Transcriber,
    private readonly log: DiagLog,
  ) {}

  /** Called after the console accepted REC down (composer is RECORDING). */
  begin(): void {
    if (this.console.composer.state.state !== "recording") return;
    const take = ++this.take;
    const cap = this.newCapture();
    this.capture = cap;
    this.log.info("voice", `recording (${cap.id}) -> ${this.console.composer.state.destination?.label ?? "?"}`);
    this.starting = cap
      .start((level) => {
        if (take === this.take && this.console.composer.state.state === "recording") this.console.voiceLevel(level);
      })
      .catch((e: unknown) => {
        if (take !== this.take) return;
        this.capture = null;
        this.fail(`microphone: ${e instanceof Error ? e.message : String(e)}`);
      });
  }

  /** Called after REC up moved the composer to TRANSCRIBING. */
  finish(): void {
    const cap = this.capture;
    const take = this.take;
    this.capture = null;
    if (!cap) {
      if (this.console.composer.state.state === "transcribing") this.console.voiceTranscriptionFailed("no audio captured");
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    this.work = this.transcribe(cap, take, abort.signal);
  }

  /** FX while recording/transcribing: discard audio and any pending transcript. */
  cancel(): void {
    this.take++;
    this.abort?.abort();
    this.abort = null;
    const cap = this.capture;
    this.capture = null;
    if (!cap) return;
    void cap.cancel().catch(() => undefined);
    this.log.info("voice", "take cancelled");
  }

  idle(): Promise<void> {
    return this.work;
  }

  /** Kept recordings (voice.keepRecordings); null keeps none. Per-take stats are logged either way. */
  setRecordings(store: RecordingStore | null): void {
    this.recordings = store;
  }

  private async transcribe(cap: Capture, take: number, signal: AbortSignal): Promise<void> {
    try {
      await this.starting;
      const audio = await cap.stop();
      if (take !== this.take) return;
      const r = await this.transcriber.transcribe(audio, signal);
      let outcome: TakeOutcome = "cancelled";
      if (take === this.take && this.console.composer.state.state === "transcribing") {
        if (!r.ok) {
          outcome = "failed";
          this.fail(r.reason);
        } else {
          const applied = this.console.voiceTranscript(r.text);
          if (applied.ok) {
            outcome = "transcript";
            this.log.info("voice", `transcript ready (${r.engine}, ${r.ms} ms, ${r.text.length} chars)`);
          }
        }
      }
      // After the composer got its result, and a macrotask later so the result reaches the device and UI first:
      // stats on a long raw take are ~0.3 s of synchronous CPU. Diagnostics never delay or break dictation.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await this.report(audio, r, outcome);
    } catch (e) {
      if (take === this.take) this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  /** One log line with the take's stats; keeps the recording when configured (not cancelled takes, not REC taps). */
  private async report(audio: CapturedAudio, r: TranscriptOutcome, outcome: TakeOutcome): Promise<void> {
    try {
      const stats = statsOf(audio);
      const store = this.recordings;
      let kept: string | null = null;
      if (store && outcome !== "cancelled" && store.wouldKeep(stats.durationMs)) {
        kept = (await store.save(audio, takeSidecar(stats, r, outcome, audio.device), stats.durationMs))?.file ?? null;
      }
      this.log.info("voice", takeLine(stats, r, outcome, audio.device, kept));
    } catch (e) {
      this.log.warn("voice", `take stats failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private fail(reason: string): void {
    const c = this.console.composer;
    if (c.state.state === "recording") c.stop();
    if (c.state.state === "transcribing") this.console.voiceTranscriptionFailed(reason);
    this.log.warn("voice", `voice failed: ${reason}`);
  }
}
