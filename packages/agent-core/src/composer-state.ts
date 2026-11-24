// Pure voice composer reducer (spec section 8). Side effects live in composer.ts.
import type { DeliveryStage, ProjectRef, Provider, SessionRef, TaskRef } from "./types";

export const VOICE_STATES = [
  "ready",
  "recording",
  "transcribing",
  "reviewing",
  "submitting",
  "delivered",
  "cancelled",
  "failed",
  "target_unavailable",
] as const;
export type VoiceState = (typeof VOICE_STATES)[number];

export type Destination =
  | { mode: "continue-session"; target: SessionRef; label: string }
  | { mode: "new-session"; task: TaskRef; provider: Provider; label: string }
  | { mode: "new-task"; project: ProjectRef; provider: Provider; label: string };

export interface ComposerState {
  state: VoiceState;
  /** Fixed at record start. Only an explicit retarget after TARGET_UNAVAILABLE changes it. */
  destination: Destination | null;
  transcript: string;
  edited: boolean;
  level: number;
  startedAt: number | null;
  elapsedDs: number;
  /** Assigned on first submit, reused by every retry so the backend can dedupe. */
  requestId: string | null;
  stage: DeliveryStage | null;
  error: string | null;
  retryable: boolean;
  attempts: number;
  targetLost: boolean;
  /**
   * Where the transcript came from: `voice` (dictated) or `suggested` (a session's suggested next prompt, loaded by a
   * short REC tap; docs/ui-v3.md section 11) or `canned` (a canned response, docs/ui-v3.md section 12). Suggested and
   * canned texts are sent exactly like a dictated one.
   */
  source: "voice" | "suggested" | "canned";
  /**
   * For a suggested text: which suggestion (0-based) of how many the session offered. For a canned text: which entry of
   * how many canned responses (counted within the canned list, not the combined one).
   */
  suggestion: { index: number; count: number } | null;
  /** For a canned text: the entry's id (its uses count goes up when SAVE sends it); null otherwise. */
  cannedId: string | null;
}

export type ComposerEvent =
  | { type: "start"; destination: Destination; now: number }
  | { type: "level"; level: number; now: number }
  | { type: "stop"; now: number }
  | { type: "transcribed"; text: string }
  | { type: "transcription_failed"; error: string }
  | { type: "edit"; text: string }
  | { type: "submit"; requestId: string }
  | { type: "progress"; requestId: string; stage: DeliveryStage; message?: string }
  | { type: "timeout"; requestId: string }
  | { type: "target_lost" }
  | { type: "retarget"; destination: Destination }
  | { type: "cancel" }
  | { type: "reset" }
  /**
   * A suggested prompt (or, with `cannedId`, a canned response) goes to review: from recording, a startable state, or a
   * suggested / canned review (PRESETS cycles).
   */
  | { type: "suggest"; destination: Destination; text: string; index: number; count: number; cannedId?: string }
  /** A short REC tap with nothing to suggest: the take is dropped, nothing changes (recording -> ready). */
  | { type: "discard" };

export type Reduction = { ok: true; state: ComposerState } | { ok: false; state: ComposerState; error: string };

export const initialComposer: ComposerState = {
  state: "ready",
  destination: null,
  transcript: "",
  edited: false,
  level: 0,
  startedAt: null,
  elapsedDs: 0,
  requestId: null,
  stage: null,
  error: null,
  retryable: false,
  attempts: 0,
  targetLost: false,
  source: "voice",
  suggestion: null,
  cannedId: null,
};

const STAGE_RANK: Record<DeliveryStage, number> = {
  accepted_locally: 0,
  sent: 1,
  backend_acknowledged: 2,
  completed: 3,
  failed: 4,
  unsupported: 4,
  target_unavailable: 4,
};

const STARTABLE: readonly VoiceState[] = ["ready", "delivered", "cancelled", "failed", "target_unavailable"];
/** A new take can start (else the composer is busy: recording, transcribing, reviewing or submitting). */
export const canStartTake = (state: VoiceState): boolean => STARTABLE.includes(state);
const CANCELLABLE: readonly VoiceState[] = ["recording", "transcribing", "reviewing", "failed", "target_unavailable"];

const elapsed = (s: ComposerState, now: number): number =>
  s.startedAt === null ? s.elapsedDs : Math.max(0, Math.floor((now - s.startedAt) / 100));

export function isDelivered(stage: DeliveryStage | null): boolean {
  return stage === "backend_acknowledged" || stage === "completed";
}

export function reduceComposer(s: ComposerState, ev: ComposerEvent): Reduction {
  const ok = (state: ComposerState): Reduction => ({ ok: true, state });
  const no = (error: string): Reduction => ({ ok: false, state: s, error });

  switch (ev.type) {
    case "start":
      if (!STARTABLE.includes(s.state)) return no(`cannot start recording in ${s.state}`);
      return ok({ ...initialComposer, state: "recording", destination: ev.destination, startedAt: ev.now });
    case "level":
      if (s.state !== "recording") return no("not recording");
      return ok({ ...s, level: Math.max(0, Math.min(100, Math.round(ev.level))), elapsedDs: elapsed(s, ev.now) });
    case "stop":
      if (s.state !== "recording") return no("not recording");
      return ok({ ...s, state: "transcribing", level: 0, elapsedDs: elapsed(s, ev.now), startedAt: null });
    case "transcribed": {
      if (s.state !== "transcribing") return no("not transcribing");
      const transcript = ev.text.trim();
      if (s.targetLost) return ok({ ...s, state: "target_unavailable", transcript, error: "target no longer available" });
      return ok({ ...s, state: "reviewing", transcript });
    }
    case "transcription_failed":
      if (s.state !== "transcribing") return no("not transcribing");
      return ok({ ...s, state: "failed", error: ev.error, retryable: false });
    case "edit":
      if (s.state !== "reviewing") return no("transcript editable only while reviewing");
      return ok({ ...s, transcript: ev.text, edited: true });
    case "submit":
      return reduceSubmit(s, ev.requestId, ok, no);
    case "progress":
      return reduceProgress(s, ev, ok, no);
    case "timeout":
      if (s.state !== "submitting" || ev.requestId !== s.requestId) return no("no matching dispatch");
      if (isDelivered(s.stage)) return no("already delivered");
      return ok({ ...s, state: "failed", error: "timed out waiting for backend acknowledgement", retryable: true });
    case "target_lost":
      if (s.state === "recording" || s.state === "transcribing") return ok({ ...s, targetLost: true });
      if (s.state === "reviewing") return ok({ ...s, state: "target_unavailable", error: "target no longer available" });
      return no(`target loss ignored in ${s.state}`);
    case "retarget":
      if (s.state !== "target_unavailable") return no("retarget only after target became unavailable");
      return ok({ ...s, state: "reviewing", destination: ev.destination, requestId: null, stage: null, error: null, targetLost: false, attempts: 0 });
    case "cancel":
      if (!CANCELLABLE.includes(s.state)) return no(`cannot cancel in ${s.state}`);
      return ok({ ...s, state: "cancelled", level: 0, startedAt: null });
    case "reset":
      if (s.state === "submitting") return no("dispatch in flight");
      return ok(initialComposer);
    case "suggest": {
      const text = ev.text.trim();
      if (!text) return no("empty suggestion");
      const cycling = s.state === "reviewing" && (s.source === "suggested" || s.source === "canned");
      if (s.state !== "recording" && !STARTABLE.includes(s.state) && !cycling) return no(`cannot suggest in ${s.state}`);
      const suggestion = { index: Math.max(0, ev.index), count: Math.max(1, ev.count) };
      const canned = ev.cannedId ?? null;
      return ok({ ...initialComposer, state: "reviewing", destination: ev.destination, transcript: text, source: canned === null ? "suggested" : "canned", suggestion, cannedId: canned });
    }
    case "discard":
      if (s.state !== "recording") return no("not recording");
      return ok(initialComposer);
  }
}

function reduceSubmit(
  s: ComposerState,
  requestId: string,
  ok: (st: ComposerState) => Reduction,
  no: (e: string) => Reduction,
): Reduction {
  if (s.state === "submitting") return no("a dispatch is already in flight");
  const isRetry = s.state === "failed" && s.retryable;
  if (s.state !== "reviewing" && !isRetry) return no(`cannot submit in ${s.state}`);
  if (s.transcript.trim().length === 0) return no("transcript is empty");
  if (!s.destination) return no("no destination");
  return ok({
    ...s,
    state: "submitting",
    requestId: s.requestId ?? requestId,
    stage: s.stage === "failed" ? null : s.stage,
    error: null,
    retryable: false,
    attempts: s.attempts + 1,
  });
}

function reduceProgress(
  s: ComposerState,
  ev: Extract<ComposerEvent, { type: "progress" }>,
  ok: (st: ComposerState) => Reduction,
  no: (e: string) => Reduction,
): Reduction {
  if (ev.requestId !== s.requestId) return no("progress for another request");
  // A late acknowledgement after a timeout (or after the user gave up on it) is still the truth.
  const lateAck = (s.state === "failed" || s.state === "cancelled") && isDelivered(ev.stage);
  if (s.state !== "submitting" && !lateAck) return no(`progress ignored in ${s.state}`);
  if (s.stage !== null && STAGE_RANK[ev.stage] < STAGE_RANK[s.stage]) return no("stage regression ignored");
  const msg = ev.message ?? null;
  switch (ev.stage) {
    case "accepted_locally":
    case "sent":
      return ok({ ...s, stage: ev.stage });
    case "backend_acknowledged":
    case "completed":
      return ok({ ...s, state: "delivered", stage: ev.stage, error: null, retryable: false });
    case "failed":
      return ok({ ...s, state: "failed", stage: ev.stage, error: msg ?? "delivery failed", retryable: true });
    case "unsupported":
      return ok({ ...s, state: "failed", stage: ev.stage, error: msg ?? "not supported by backend", retryable: false });
    case "target_unavailable":
      return ok({ ...s, state: "target_unavailable", stage: ev.stage, error: msg ?? "target unavailable" });
  }
}
