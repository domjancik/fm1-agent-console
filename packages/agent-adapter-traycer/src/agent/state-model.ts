import type { InferredFacts, NormalizedState, Runtime, SessionStatus } from "@fm1/agent-core";

/**
 * Facts gathered about one Traycer agent from the different feeds, and the
 * pure function that turns them into agent-core's SessionStatus.
 *
 * Observed (a backend fact) vs inferred (a heuristic) is kept apart:
 *  - GUI chats: `agent.activity.subscribe` `turn`/`working` membership and the
 *    chat stream's `runStatus`/`activeTurn` are host facts => observed.
 *  - Terminal (TUI) agents: activity is output-based (the host marks a TUI
 *    "active" while its PTY produces output), so it is only ever inferred.
 *  - Approval/interview requests and agent.stopped outcomes are host
 *    notifications => observed.
 */
export type TurnOutcome = "completed" | "stopped" | "interrupted" | "errored" | "stalled";

export interface OutcomeFact {
  readonly status: TurnOutcome;
  readonly at: number;
  readonly source: "chat" | "notification";
  /** The host notification row was already read (e.g. in Traycer Desktop). */
  readonly readInTraycer: boolean;
  readonly detail?: string;
}

export interface ActivityFact {
  readonly inTurn: boolean;
  readonly working: boolean;
  readonly servedBy: string;
  readonly at: number;
}

export interface ChatRunFact {
  readonly runStatus: string;
  readonly turnStatus: string | null;
  readonly at: number;
}

export interface SessionFacts {
  readonly runtime: Runtime;
  activity: ActivityFact | null;
  /** Present only while the chat stream for this session is open. */
  chat: ChatRunFact | null;
  outcome: OutcomeFact | null;
  approvalIds: ReadonlySet<string>;
  interviewIds: ReadonlySet<string>;
  tuiSessionState: string | null;
  /** Last time the console marked this session viewed (focus/markViewed). */
  viewedAt: number;
  /** Activity went from in-turn to idle with no outcome reported since. */
  turnEndedUnreported: number | null;
}

export function emptyFacts(runtime: Runtime): SessionFacts {
  return {
    runtime,
    activity: null,
    chat: null,
    outcome: null,
    approvalIds: new Set(),
    interviewIds: new Set(),
    tuiSessionState: null,
    viewedAt: 0,
    turnEndedUnreported: null,
  };
}

const TERMINAL_TURN = new Set(["completed", "stopped", "interrupted", "errored"]);

/** An active turn's own status wins: host 1.5.4 reports `runStatus:"running"` beside a `completed` turn. */
function chatRunning(chat: ChatRunFact): boolean {
  if (chat.turnStatus !== null) return !TERMINAL_TURN.has(chat.turnStatus);
  return chat.runStatus === "running" || chat.runStatus === "stopping";
}

function outcomeState(outcome: OutcomeFact, viewedAt: number): NormalizedState {
  switch (outcome.status) {
    case "errored":
    case "interrupted":
    case "stalled":
      return "failed";
    case "stopped":
      return "idle";
    case "completed":
      return outcome.readInTraycer || viewedAt >= outcome.at ? "completed_read" : "completed_unread";
  }
}

export function deriveStatus(facts: SessionFacts, now: number): SessionStatus {
  const raw = rawOf(facts);
  const observed = (state: NormalizedState | null, detail?: string): SessionStatus["observed"] =>
    detail === undefined ? { state, at: now } : { state, at: now, detail };

  if (facts.approvalIds.size > 0) {
    return { observed: observed("approval_required", `approval ${[...facts.approvalIds][0]} pending`), raw };
  }
  if (facts.interviewIds.size > 0) {
    return { observed: observed("waiting_input", "agent asked a question (interview)"), raw };
  }

  if (facts.runtime === "terminal") {
    let state: NormalizedState | null = null;
    let detail: string | undefined;
    if (facts.outcome?.status === "errored" || facts.outcome?.status === "stalled") {
      state = "failed";
      detail = facts.outcome.detail ?? `terminal agent ${facts.outcome.status}`;
    } else if (facts.tuiSessionState === "stopped") {
      state = "idle";
      detail = "terminal process stopped";
    }
    const status: SessionStatus = { observed: observed(state, detail), raw };
    const inferred = inferTerminal(facts);
    if (inferred !== undefined) status.inferred = inferred;
    return status;
  }

  const running = facts.chat !== null ? chatRunning(facts.chat) : facts.activity !== null && (facts.activity.inTurn || facts.activity.working);
  if (running) return { observed: observed("working", facts.chat !== null ? "chat turn running" : "activity: turn in flight"), raw };
  if (facts.outcome !== null) {
    return { observed: observed(outcomeState(facts.outcome, facts.viewedAt), `last turn ${facts.outcome.status}`), raw };
  }
  if (facts.chat !== null || facts.activity !== null) {
    const status: SessionStatus = { observed: observed("idle"), raw };
    if (facts.turnEndedUnreported !== null && facts.viewedAt < facts.turnEndedUnreported) {
      status.inferred = { state: "completed_unread", reason: "turn ended per activity stream; host reported no outcome" };
    }
    return status;
  }
  return { observed: observed(null), raw };
}

function inferTerminal(facts: SessionFacts): InferredFacts | undefined {
  if (facts.activity !== null && (facts.activity.working || facts.activity.inTurn)) {
    return { state: "working", reason: "terminal output activity (output-based, not a turn signal)" };
  }
  if (facts.tuiSessionState === "running" || facts.tuiSessionState === "sleeping") {
    return { state: "idle", reason: "terminal process alive with no recent output" };
  }
  return undefined;
}

function rawOf(facts: SessionFacts): Record<string, unknown> {
  return {
    runtime: facts.runtime,
    activity:
      facts.activity === null
        ? null
        : { inTurn: facts.activity.inTurn, working: facts.activity.working, servedBy: facts.activity.servedBy },
    chat: facts.chat === null ? null : { runStatus: facts.chat.runStatus, turnStatus: facts.chat.turnStatus },
    outcome: facts.outcome,
    approvals: [...facts.approvalIds],
    interviews: [...facts.interviewIds],
    tuiSessionState: facts.tuiSessionState,
  };
}

/** Status comparison that ignores timestamps, to avoid re-emitting identical upserts. */
export function statusSignature(status: SessionStatus): string {
  return JSON.stringify([status.observed.state, status.observed.detail ?? null, status.inferred ?? null, status.raw]);
}
