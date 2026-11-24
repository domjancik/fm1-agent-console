import { effectiveState, type AgentEvent, type MdBlock, type Session, type SessionDetails, type Task } from "@fm1/agent-core";
import type { NormalizedAgent, NormalizedTask } from "../normalize";
import type { A2aReply, PromptCapability } from "./a2a-delivery";
import type { ChatChannel } from "./chat-channel";
import { cleanOutcomeDetail, messageBlocks, summaryFor } from "./chat-details";
import type { NotificationRow } from "./feeds";
import { taskRefOf, toSession, toTask } from "./mapping";
import { cleanTranscriptText, LAST_MESSAGE_MAX } from "./terminal-transcript";
import { deriveStatus, emptyFacts, statusSignature, type OutcomeFact, type SessionFacts, type TurnOutcome } from "./state-model";

/** agent-core `SessionDetails` plus the last a2a reply captured from a terminal agent's transcript. */
export type TraycerSessionDetails = SessionDetails & { reply?: A2aReply };
/** agent-core `Session` plus how (and whether) this session takes a console prompt. */
export type TraycerSession = Session & { prompt?: PromptCapability; details?: TraycerSessionDetails };

const key = (epicId: string, agentId: string): string => `${epicId}\u0000${agentId}`;
/** What makes an upsert worth emitting: the derived status (no timestamps) and the chat details. */
const signatureOf = (s: TraycerSession): string =>
  `${statusSignature(s.status)}|${s.details === undefined ? "" : JSON.stringify(s.details)}|${s.parentKey ?? ""}|${s.prompt === undefined ? "" : JSON.stringify(s.prompt)}`;
const TERMINAL_TURN: ReadonlySet<string> = new Set(["completed", "stopped", "interrupted", "errored"]);

/**
 * The adapter's catalog: tasks, agents and the per-agent facts behind each
 * session's status. Emits `session_upserted` only when a session's derived
 * status (ignoring timestamps) actually changes, and `session_removed` /
 * `task_removed` when the host says an agent or task is gone.
 */
export class SessionBook {
  private hostId = "";
  private readonly tasks = new Map<string, NormalizedTask>();
  private readonly agents = new Map<string, NormalizedAgent>();
  private readonly facts = new Map<string, SessionFacts>();
  private readonly signatures = new Map<string, string>();
  private readonly notifInterviews = new Map<string, Set<string>>();
  private readonly chatInterviews = new Map<string, Set<string>>();
  private readonly notifOutcome = new Map<string, string>();
  /** Feed facts that arrived before the agent was listed; applied when it appears. */
  private lastActivity: { byEpic: Record<string, { working: string[]; turn: string[] }>; servedBy: string; at: number } | null = null;
  private readonly earlyOutcomes = new Map<string, OutcomeFact>();
  /** Chat details from the stream (kept after it closes, minus what was in progress). */
  private readonly chatDetails = new Map<string, { details: SessionDetails; at: number }>();
  private approvalsFor: (epicId: string, chatId: string) => Set<string> = () => new Set();
  private promptOf: ((agent: NormalizedAgent) => PromptCapability) | null = null;
  /** Last a2a reply per terminal agent, read from its transcript after a console prompt. */
  private readonly replies = new Map<string, A2aReply & { blocks?: MdBlock[] }>();

  constructor(
    private readonly emit: (event: AgentEvent) => void,
    private readonly now: () => number,
  ) {}

  setHost(hostId: string): void {
    this.hostId = hostId;
  }

  setPromptPolicy(policy: (agent: NormalizedAgent) => PromptCapability): void {
    this.promptOf = policy;
  }

  /** Records a terminal agent's answer to a console prompt; surfaces as `details.reply` and `details.lastMessage`. */
  setReply(epicId: string, agentId: string, reply: A2aReply): void {
    // The reply is raw transcript text: redact, fold to ASCII and cap it like every other detail before it can reach
    // the device, the companion UI or a log (agent-core PromptReply: ASCII, <= 600).
    const text = cleanTranscriptText(reply.text, LAST_MESSAGE_MAX);
    const blocks = text ? messageBlocks(reply.text) : [];
    this.replies.set(key(epicId, agentId), blocks.length > 0 ? { requestId: reply.requestId, text, at: reply.at, blocks } : { requestId: reply.requestId, text, at: reply.at });
    this.refresh(epicId, agentId);
  }

  /**
   * Details parsed from a terminal agent's transcript (agent.getTranscript; terminal-transcript.ts). Kept like a closed
   * chat stream's details; `at` (when the newest answer was first seen) counts as activity.
   */
  setTranscriptDetails(epicId: string, agentId: string, details: SessionDetails, at: number): void {
    const k = key(epicId, agentId);
    if (!this.agents.has(k)) return;
    this.chatDetails.set(k, { details, at });
    this.refresh(epicId, agentId);
  }

  /**
   * Forgets a session's suggested next prompts (docs/ui-v3.md section 11) when nothing keeps them current any more (its
   * terminal transcript is no longer watched), so a stale list is never offered when the session is selected again.
   */
  dropSuggestions(epicId: string, agentId: string): void {
    const k = key(epicId, agentId);
    const chat = this.chatDetails.get(k);
    if (chat?.details.suggestions === undefined) return;
    const { suggestions: _dropped, ...details } = chat.details;
    this.chatDetails.set(k, { details, at: chat.at });
    this.refresh(epicId, agentId);
  }

  setApprovalSource(source: (epicId: string, chatId: string) => Set<string>): void {
    this.approvalsFor = source;
  }

  task(epicId: string): NormalizedTask | undefined {
    return this.tasks.get(epicId);
  }

  agent(epicId: string, agentId: string): NormalizedAgent | undefined {
    return this.agents.get(key(epicId, agentId));
  }

  allTasks(): NormalizedTask[] {
    return [...this.tasks.values()];
  }

  toTask(task: NormalizedTask): Task {
    return toTask(task, this.hostId);
  }

  /** Full task listing. With `complete`, tasks missing from it are removed (task deleted). */
  setTasks(list: readonly NormalizedTask[], complete: boolean): void {
    const seen = new Set<string>();
    for (const task of list) {
      seen.add(task.epicId);
      this.tasks.set(task.epicId, task);
    }
    if (!complete) return;
    for (const [epicId, task] of [...this.tasks]) {
      if (seen.has(epicId)) continue;
      this.removeTask(task);
    }
  }

  removeTask(task: NormalizedTask): void {
    for (const agent of [...this.agents.values()]) if (agent.epicId === task.epicId) this.removeAgent(agent.epicId, agent.agentId);
    this.tasks.delete(task.epicId);
    this.emit({ type: "task_removed", ref: taskRefOf(task, this.hostId) });
  }

  /** Full agent listing of one task; agents missing from it are removed. */
  setAgents(epicId: string, list: readonly NormalizedAgent[], announce = false): boolean {
    const seen = new Set(list.map((a) => a.agentId));
    let changed = false;
    for (const agent of list) {
      if (!this.agents.has(key(agent.epicId, agent.agentId))) changed = true;
      this.putAgent(agent, announce);
    }
    for (const agent of [...this.agents.values()]) {
      if (agent.epicId === epicId && !seen.has(agent.agentId)) {
        changed = true;
        this.removeAgent(epicId, agent.agentId);
      }
    }
    return changed;
  }

  /** Inserts/updates one agent; emits an upsert when `announce` and its task is known. */
  putAgent(agent: NormalizedAgent, announce: boolean): Session | undefined {
    const k = key(agent.epicId, agent.agentId);
    const prior = this.agents.get(k);
    const merged: NormalizedAgent =
      prior === undefined
        ? agent
        : {
            ...agent,
            harnessId: agent.harnessId ?? prior.harnessId,
            model: agent.model ?? prior.model,
            reasoningEffort: agent.reasoningEffort ?? prior.reasoningEffort,
            permissionMode: agent.permissionMode ?? prior.permissionMode,
            profileId: agent.profileId ?? prior.profileId,
          };
    this.agents.set(k, merged);
    let facts = this.facts.get(k);
    if (facts === undefined) {
      facts = emptyFacts(merged.surface === "gui" ? "chat" : "terminal");
      this.seed(facts, k, merged);
    }
    facts.tuiSessionState = merged.sessionState;
    this.facts.set(k, facts);
    if (announce) return this.refresh(merged.epicId, merged.agentId, true);
    const session = this.session(merged.epicId, merged.agentId);
    if (session !== undefined) this.signatures.set(k, signatureOf(session));
    return session;
  }

  removeAgent(epicId: string, agentId: string): void {
    const k = key(epicId, agentId);
    const agent = this.agents.get(k);
    if (agent === undefined) return;
    const session = this.session(epicId, agentId);
    this.agents.delete(k);
    this.facts.delete(k);
    this.signatures.delete(k);
    this.chatDetails.delete(k);
    this.replies.delete(k);
    if (session !== undefined) this.emit({ type: "session_removed", ref: session.ref });
  }

  /**
   * Newest known agent activity per task (docs/traycer-integration.md "Session scan"): per agent the record's
   * created/updated time, the last turn outcome and the chat/transcript details time (the inputs of a session's
   * `lastActivityAt`, minus the live feed, whose busy tasks `busyEpics` reports). Tasks with no known agent are absent.
   */
  activityByEpic(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [k, agent] of this.agents) {
      const facts = this.facts.get(k);
      const at = Math.max(agent.createdAt, agent.updatedAt, facts?.outcome?.at ?? 0, this.chatDetails.get(k)?.at ?? 0);
      if (at > (out.get(agent.epicId) ?? 0)) out.set(agent.epicId, at);
    }
    return out;
  }

  /** Tasks with an agent working or in a turn in the latest `agent.activity.subscribe` state frame. */
  busyEpics(): string[] {
    if (this.lastActivity === null) return [];
    return Object.entries(this.lastActivity.byEpic)
      .filter(([, bucket]) => bucket.working.length > 0 || bucket.turn.length > 0)
      .map(([epicId]) => epicId);
  }

  agentsOf(epicId: string): NormalizedAgent[] {
    return [...this.agents.values()].filter((a) => a.epicId === epicId);
  }

  session(epicId: string, agentId: string): TraycerSession | undefined {
    const k = key(epicId, agentId);
    const agent = this.agents.get(k);
    const task = this.tasks.get(epicId);
    const facts = this.facts.get(k);
    if (agent === undefined || task === undefined || facts === undefined) return undefined;
    const session: TraycerSession = toSession(agent, taskRefOf(task, this.hostId), task, deriveStatus(facts, this.now()));
    if (this.promptOf !== null) session.prompt = this.promptOf(agent);
    const chat = this.chatDetails.get(k);
    const busy = facts.activity !== null && (facts.activity.inTurn || facts.activity.working);
    // Last activity (docs/ux-v2.md sections 3.2 and 7.1): the record's update, the last outcome, the stream's newest
    // turn or activity time, and the activity feed while the agent is busy.
    session.lastActivityAt = Math.max(session.createdAt, agent.updatedAt, facts.outcome?.at ?? 0, chat?.at ?? 0, busy ? (facts.activity?.at ?? 0) : 0);
    if (chat !== undefined) {
      session.details = chat.details;
      const summary = summaryFor(chat.details, effectiveState(session.status));
      if (summary !== undefined) session.summary = summary;
    }
    const reply = this.replies.get(k);
    if (reply !== undefined) {
      if (reply.text) {
        // The reply is the newest message: its own structure (or none) replaces the chat's older one.
        const { lastBlocks: _older, ...rest } = session.details ?? {};
        session.details = { ...rest, lastMessage: reply.text, lastMessageAt: reply.at, reply: { ...reply }, ...(reply.blocks ? { lastBlocks: reply.blocks } : {}) };
      } else session.details = { ...(session.details ?? {}), reply: { ...reply } };
    }
    return session;
  }

  sessions(epicId?: string): Session[] {
    const out: Session[] = [];
    for (const agent of this.agents.values()) {
      if (epicId !== undefined && agent.epicId !== epicId) continue;
      const s = this.session(agent.epicId, agent.agentId);
      if (s !== undefined) out.push(s);
    }
    return out;
  }

  /** Recomputes one session's status; emits an upsert when it changed (or `force`). */
  refresh(epicId: string, agentId: string, force = false): Session | undefined {
    const k = key(epicId, agentId);
    const facts = this.facts.get(k);
    if (facts === undefined) return undefined;
    facts.approvalIds = this.approvalsFor(epicId, agentId);
    facts.interviewIds = new Set([...(this.notifInterviews.get(k) ?? []), ...(this.chatInterviews.get(k) ?? [])]);
    const session = this.session(epicId, agentId);
    if (session === undefined) return undefined;
    const signature = signatureOf(session);
    if (force || this.signatures.get(k) !== signature) {
      this.signatures.set(k, signature);
      this.emit({ type: "session_upserted", session });
    }
    return session;
  }

  refreshAll(): void {
    for (const agent of [...this.agents.values()]) this.refresh(agent.epicId, agent.agentId);
  }

  private seed(facts: SessionFacts, k: string, agent: NormalizedAgent): void {
    if (this.lastActivity !== null) {
      const bucket = this.lastActivity.byEpic[agent.epicId];
      facts.activity = {
        inTurn: bucket?.turn.includes(agent.agentId) ?? false,
        working: bucket?.working.includes(agent.agentId) ?? false,
        servedBy: this.lastActivity.servedBy,
        at: this.lastActivity.at,
      };
    }
    const early = this.earlyOutcomes.get(k);
    if (early !== undefined) {
      this.earlyOutcomes.delete(k);
      const busy = facts.activity !== null && (facts.activity.inTurn || facts.activity.working);
      if (!busy || facts.runtime === "terminal") facts.outcome = early;
    }
  }

  /** `agent.activity.subscribe` state frame: a full replacement across all epics. */
  applyActivity(byEpic: Record<string, { working: string[]; turn: string[] }>, servedBy: string): void {
    const at = this.now();
    this.lastActivity = { byEpic, servedBy, at };
    for (const agent of this.agents.values()) {
      const facts = this.facts.get(key(agent.epicId, agent.agentId));
      if (facts === undefined) continue;
      const bucket = byEpic[agent.epicId];
      const inTurn = bucket?.turn.includes(agent.agentId) ?? false;
      const working = bucket?.working.includes(agent.agentId) ?? false;
      const wasBusy = facts.activity !== null && (facts.activity.inTurn || facts.activity.working);
      if ((inTurn || working) && !wasBusy) {
        // A new turn supersedes the previous outcome.
        if (facts.runtime === "chat") facts.outcome = null;
        facts.turnEndedUnreported = null;
      } else if (!inTurn && !working && wasBusy && facts.runtime === "chat" && (facts.outcome === null || facts.outcome.at < (facts.activity?.at ?? 0))) {
        facts.turnEndedUnreported = at;
      }
      facts.activity = { inTurn, working, servedBy, at };
    }
    this.refreshAll();
  }

  /** Activity stream lost: the absence of an agent from buckets no longer means idle. */
  clearActivity(): void {
    this.lastActivity = null;
    for (const facts of this.facts.values()) facts.activity = null;
    this.refreshAll();
  }

  applyNotifications(rows: readonly NotificationRow[], snapshot: boolean): void {
    if (snapshot) this.notifInterviews.clear();
    const touched = new Set<string>();
    for (const row of rows) {
      if (row.epicId === null || row.chatId === null) continue;
      const k = key(row.epicId, row.chatId);
      touched.add(k);
      if (row.kind === "interview.requested" && row.interviewBlockId !== null) {
        const set = this.notifInterviews.get(k) ?? new Set<string>();
        if (row.resolvedAt === null) set.add(row.interviewBlockId);
        else set.delete(row.interviewBlockId);
        this.notifInterviews.set(k, set);
      } else if (row.kind === "agent.stopped" || row.kind === "agent.stalled") {
        const status: TurnOutcome | null =
          row.kind === "agent.stalled" ? "stalled" : row.outcome === "completed" || row.outcome === "stopped" || row.outcome === "errored" ? row.outcome : null;
        if (status === null) continue;
        this.notifOutcome.set(row.id, k);
        const outcome: OutcomeFact = { status, at: row.updatedAt, source: "notification", readInTraycer: row.readAt !== null };
        this.setOutcome(k, row.detail === null ? outcome : { ...outcome, detail: cleanOutcomeDetail(row.detail) });
      }
    }
    if (snapshot) this.refreshAll();
    else for (const k of touched) this.refreshKey(k);
  }

  applyReadState(ids: readonly string[], readAt: number | null): void {
    for (const id of ids) {
      const k = this.notifOutcome.get(id);
      const facts = k === undefined ? undefined : this.facts.get(k);
      if (k === undefined || facts?.outcome == null || facts.outcome.source !== "notification") continue;
      facts.outcome = { ...facts.outcome, readInTraycer: readAt !== null };
      this.refreshKey(k);
    }
  }

  /** The selected chat's stream: authoritative run state, interviews and turn outcomes. */
  applyChannel(channel: ChatChannel, open: boolean): void {
    const k = key(channel.epicId, channel.chatId);
    const facts = this.facts.get(k);
    if (facts === undefined) return;
    if (!open || channel.ready) {
      const approval = [...channel.pendingApprovals.values()][0];
      this.chatDetails.set(k, { details: channel.details.details(approval), at: channel.details.lastActivityAt() });
    }
    if (!open) {
      facts.chat = null;
      this.chatInterviews.delete(k);
      this.refreshKey(k);
      return;
    }
    if (!channel.ready) return;
    const turn = channel.activeTurn;
    const at = this.now();
    const priorTurn = facts.chat?.turnStatus ?? null;
    facts.chat = { runStatus: channel.runStatus ?? "idle", turnStatus: turn?.status ?? null, at };
    if (turn !== null && !TERMINAL_TURN.has(turn.status)) {
      facts.outcome = null;
      facts.turnEndedUnreported = null;
    } else if (turn !== null && TERMINAL_TURN.has(turn.status) && priorTurn !== turn.status && priorTurn !== null) {
      // Observed live on the stream: this console saw the turn end.
      this.setOutcome(k, { status: turn.status as TurnOutcome, at, source: "chat", readInTraycer: false });
    }
    this.chatInterviews.set(k, new Set(channel.pendingInterviews));
    this.refreshKey(k);
  }

  markViewed(epicId: string, agentId: string): void {
    const facts = this.facts.get(key(epicId, agentId));
    if (facts === undefined) return;
    facts.viewedAt = this.now();
    this.refresh(epicId, agentId);
  }

  private setOutcome(k: string, outcome: OutcomeFact): void {
    const facts = this.facts.get(k);
    if (facts === undefined) {
      const prior = this.earlyOutcomes.get(k);
      if (prior === undefined || prior.at <= outcome.at) this.earlyOutcomes.set(k, outcome);
      return;
    }
    if (facts.outcome !== null && facts.outcome.at > outcome.at) return;
    facts.outcome = outcome;
    facts.turnEndedUnreported = null;
  }

  private refreshKey(k: string): void {
    const [epicId, agentId] = k.split("\u0000") as [string, string];
    this.refresh(epicId, agentId);
  }
}

