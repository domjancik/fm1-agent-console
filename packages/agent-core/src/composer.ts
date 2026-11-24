import {
  initialComposer,
  reduceComposer,
  type ComposerEvent,
  type ComposerState,
  type Destination,
  type Reduction,
} from "./composer-state";
import type { CommandResult, DeliveryStage, Result } from "./types";

export * from "./composer-state";

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
};

export interface ComposerDeps {
  dispatch(requestId: string, dest: Destination, text: string): Promise<CommandResult>;
  /** Returns a blocking result (unsupported / target_unavailable) or null when sending may proceed. */
  precheck(dest: Destination, requestId: string): CommandResult | null;
  /** Whether the destination still resolves; used to detect a target going stale before submit. */
  isTargetLive(dest: Destination): boolean;
  newRequestId(): string;
  now(): number;
  timers?: Timers;
  ackTimeoutMs?: number;
}

/** Stateful wrapper around the pure reducer that owns the single in-flight dispatch. */
export class VoiceComposer {
  private s: ComposerState = initialComposer;
  private timer: unknown = null;
  private listeners = new Set<(s: ComposerState) => void>();
  private readonly timers: Timers;
  private readonly ackTimeoutMs: number;

  constructor(private readonly deps: ComposerDeps) {
    this.timers = deps.timers ?? realTimers;
    this.ackTimeoutMs = deps.ackTimeoutMs ?? 10_000;
  }

  get state(): ComposerState {
    return this.s;
  }

  onChange(fn: (s: ComposerState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private apply(ev: ComposerEvent): Result<ComposerState> {
    const r: Reduction = reduceComposer(this.s, ev);
    if (!r.ok) return { ok: false, error: r.error };
    this.s = r.state;
    if (this.s.state !== "submitting") this.clearTimer();
    for (const fn of this.listeners) fn(this.s);
    return { ok: true, value: this.s };
  }

  start(destination: Destination): Result<ComposerState> {
    if (!this.deps.isTargetLive(destination)) return { ok: false, error: "destination unavailable" };
    return this.apply({ type: "start", destination, now: this.deps.now() });
  }
  level(level: number): Result<ComposerState> {
    return this.apply({ type: "level", level, now: this.deps.now() });
  }
  stop(): Result<ComposerState> {
    return this.apply({ type: "stop", now: this.deps.now() });
  }
  transcribed(text: string): Result<ComposerState> {
    return this.apply({ type: "transcribed", text });
  }
  transcriptionFailed(error: string): Result<ComposerState> {
    return this.apply({ type: "transcription_failed", error });
  }
  edit(text: string): Result<ComposerState> {
    return this.apply({ type: "edit", text });
  }
  cancel(): Result<ComposerState> {
    return this.apply({ type: "cancel" });
  }
  reset(): Result<ComposerState> {
    return this.apply({ type: "reset" });
  }
  /**
   * Loads a suggested prompt (docs/ui-v3.md section 11) or, with `cannedId`, a canned response (section 12) into review;
   * the destination must still resolve.
   */
  suggest(destination: Destination, text: string, index: number, count: number, cannedId?: string): Result<ComposerState> {
    if (!this.deps.isTargetLive(destination)) return { ok: false, error: "destination unavailable" };
    return this.apply({ type: "suggest", destination, text, index, count, ...(cannedId === undefined ? {} : { cannedId }) });
  }
  /** Drops a take that turned out to be a short REC tap with nothing to suggest. */
  discard(): Result<ComposerState> {
    return this.apply({ type: "discard" });
  }
  retarget(destination: Destination): Result<ComposerState> {
    if (!this.deps.isTargetLive(destination)) return { ok: false, error: "destination unavailable" };
    return this.apply({ type: "retarget", destination });
  }

  /** Re-checks the captured destination; call whenever the registry changes. */
  checkTarget(): void {
    const d = this.s.destination;
    if (d && !this.deps.isTargetLive(d)) this.apply({ type: "target_lost" });
  }

  /** Backend progress for a request, from an adapter event. */
  progress(requestId: string, stage: DeliveryStage, message?: string): Result<ComposerState> {
    const ev: ComposerEvent = message === undefined ? { type: "progress", requestId, stage } : { type: "progress", requestId, stage, message };
    return this.apply(ev);
  }

  /** The explicit confirmation. Retries after failure reuse the original requestId. */
  async submit(): Promise<Result<ComposerState>> {
    const dest = this.s.destination;
    if (dest && (this.s.state === "reviewing" || this.s.state === "failed") && !this.deps.isTargetLive(dest)) {
      return this.s.state === "reviewing" ? this.apply({ type: "target_lost" }) : { ok: false, error: "target no longer available" };
    }
    const started = this.apply({ type: "submit", requestId: this.deps.newRequestId() });
    if (!started.ok) return started;
    const { requestId, destination, transcript } = this.s;
    if (requestId === null || destination === null) return { ok: false, error: "internal: missing request" };
    const blocked = this.deps.precheck(destination, requestId);
    if (blocked) return this.apply(toProgress(blocked));
    this.apply({ type: "progress", requestId, stage: "accepted_locally" });
    this.armTimer(requestId);
    const result = await this.deps.dispatch(requestId, destination, transcript);
    if (this.s.requestId !== requestId) return { ok: true, value: this.s };
    const applied = this.apply(toProgress(result));
    return applied.ok ? applied : { ok: true, value: this.s };
  }

  private armTimer(requestId: string): void {
    this.clearTimer();
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.apply({ type: "timeout", requestId });
    }, this.ackTimeoutMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }
}

function toProgress(r: CommandResult): ComposerEvent {
  return r.message === undefined
    ? { type: "progress", requestId: r.requestId, stage: r.stage }
    : { type: "progress", requestId: r.requestId, stage: r.stage, message: r.message };
}
