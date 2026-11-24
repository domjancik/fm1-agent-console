import { NORMALIZED_STATES, type NormalizedState, type SessionStatus } from "./types";

export function isNormalizedState(v: unknown): v is NormalizedState {
  return typeof v === "string" && (NORMALIZED_STATES as readonly string[]).includes(v);
}

/** Observed facts win; inference only fills a gap; otherwise unknown. */
export function effectiveState(status: SessionStatus): NormalizedState {
  return status.observed.state ?? status.inferred?.state ?? "unknown";
}

export function isInferred(status: SessionStatus): boolean {
  return status.observed.state === null && status.inferred !== undefined;
}

export function observedStatus(state: NormalizedState | null, at: number, raw: unknown, detail?: string): SessionStatus {
  return detail === undefined ? { observed: { state, at }, raw } : { observed: { state, at, detail }, raw };
}

/** States where an interrupt makes sense. */
export function isInterruptible(state: NormalizedState): boolean {
  return state === "working" || state === "waiting_input" || state === "approval_required";
}

/** States that accept a new prompt. */
export function acceptsPrompt(state: NormalizedState): boolean {
  return state !== "disconnected" && state !== "unknown";
}

/** Time of the last activity: the adapter's `lastActivityAt` when given, else creation. */
export function activityAt(session: { createdAt: number; lastActivityAt?: number }): number {
  return Math.max(session.createdAt, session.lastActivityAt ?? 0);
}
