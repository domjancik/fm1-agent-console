// Deterministic in-memory AgentAdapter for tests and simulator demos.
import { markdownBlocks } from "./markdown";
import { allSupported } from "./capabilities";
import { loadFixture, type LoadedFixture } from "./fixtures";
import { sessionKey, taskKey } from "./identity";
import { observedStatus } from "./status";
import type {
  AdapterCapabilities,
  AgentAdapter,
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  CapabilityName,
  CommandResult,
  CreateSessionRequest,
  CreateSessionResult,
  CreateTaskRequest,
  CreateTaskResult,
  NormalizedState,
  Project,
  Session,
  SessionRef,
  Snapshot,
  Task,
} from "./types";

/** immediate: backend acks at once. sent: only "sent"; call ack() later. fail: "failed". hang: resolves on release(). */
export type AckMode = "immediate" | "sent" | "fail" | "hang";

export interface MockOptions {
  capabilities?: AdapterCapabilities;
  /** The backend name device copy uses; default "Traycer", since the fixtures replay Traycer-shaped snapshots. */
  displayName?: string;
  ackMode?: AckMode;
  now?: () => number;
}

export interface Delivery {
  requestId: string;
  kind: "prompt" | "createTask" | "createSession";
  key: string;
  text: string;
}

export class MockAdapter implements AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  capabilities: AdapterCapabilities;
  ackMode: AckMode;
  readonly deliveries: Delivery[] = [];
  readonly focusCalls: string[] = [];
  readonly interruptCalls: string[] = [];
  readonly approvalCalls: ApprovalDecision[] = [];
  /** A send drops the target's suggestions (Traycer GUI chats); false models a terminal transcript that keeps them. */
  clearSuggestionsOnSend = true;
  private connected = false;
  /** When false, connect() rejects (backend unreachable). */
  reachable: boolean;
  private projects: Project[];
  private tasks = new Map<string, Task>();
  private sessions = new Map<string, Session>();
  private approvals = new Map<string, ApprovalRequest>();
  private listeners = new Set<(e: AgentEvent) => void>();
  private results = new Map<string, CommandResult>();
  private hanging = new Map<string, (r: CommandResult) => void>();
  private seq = 0;
  private readonly now: () => number;

  constructor(
    private readonly fixture: LoadedFixture,
    opts: MockOptions = {},
  ) {
    this.id = `mock:${fixture.name}`;
    this.displayName = opts.displayName ?? "Traycer";
    this.capabilities = opts.capabilities ?? allSupported("code");
    this.ackMode = opts.ackMode ?? "immediate";
    this.reachable = fixture.connected;
    let t = 1_800_000_000_000;
    this.now = opts.now ?? (() => (t += 1000));
    this.projects = fixture.snapshot.projects;
    for (const x of fixture.snapshot.tasks) this.tasks.set(taskKey(x.ref), x);
    for (const x of fixture.snapshot.sessions) this.sessions.set(sessionKey(x.ref), withMarkdown(x));
    for (const x of fixture.snapshot.approvals) this.approvals.set(x.id, x);
  }

  static fromFixture(path: string, opts?: MockOptions): MockAdapter {
    return new MockAdapter(loadFixture(path), opts);
  }

  async connect(): Promise<void> {
    if (!this.reachable) throw new Error("backend unreachable");
    this.connected = true;
    this.emit({ type: "connection", state: "connected" });
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.emit({ type: "connection", state: "disconnected" });
  }

  getCapabilities(): AdapterCapabilities {
    return this.capabilities;
  }

  private guard(cap: CapabilityName): void {
    if (!this.connected) throw new Error("not connected");
    if (!this.capabilities[cap].supported) throw new Error(`${cap} unsupported`);
  }

  async listProjects(): Promise<Project[]> {
    this.guard("listProjects");
    return [...this.projects];
  }
  async listTasks(projectId?: string): Promise<Task[]> {
    this.guard("listTasks");
    return [...this.tasks.values()].filter((t) => projectId === undefined || t.ref.projectId === projectId);
  }
  async listSessions(taskId?: string): Promise<Session[]> {
    this.guard("listSessions");
    return [...this.sessions.values()].filter((s) => taskId === undefined || s.ref.taskId === taskId);
  }
  async listApprovals(): Promise<ApprovalRequest[]> {
    this.guard("listSessions");
    return [...this.approvals.values()];
  }

  subscribe(listener: (e: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Emits any value, including malformed ones, to exercise validation downstream. */
  emit(event: AgentEvent | Record<string, unknown>): void {
    for (const l of this.listeners) l(event as AgentEvent);
  }

  private preflight(cap: CapabilityName, requestId: string): CommandResult | null {
    const prior = this.results.get(requestId);
    if (prior) return prior; // idempotent per requestId, like a backend clientActionId
    if (!this.capabilities[cap].supported) return { requestId, stage: "unsupported", message: this.capabilities[cap].reason };
    if (!this.connected) return { requestId, stage: "failed", message: "backend disconnected" };
    return null;
  }

  private finish(requestId: string, ok: CommandResult): Promise<CommandResult> {
    const r: CommandResult =
      this.ackMode === "fail" ? { requestId, stage: "failed", message: "mock failure" }
      : this.ackMode === "sent" || this.ackMode === "hang" ? { requestId, stage: "sent" }
      : ok;
    // A failed request had no backend effect, so only successes are remembered for idempotency.
    if (r.stage !== "failed") this.results.set(requestId, r);
    if (this.ackMode !== "hang") return Promise.resolve(r);
    return new Promise((resolve) => this.hanging.set(requestId, resolve));
  }

  async sendPrompt(target: SessionRef, text: string, requestId: string): Promise<CommandResult> {
    const pre = this.preflight("sendPrompt", requestId);
    if (pre) return pre;
    const key = sessionKey(target);
    const s = this.sessions.get(key);
    if (!s) return { requestId, stage: "target_unavailable", message: "no such session" };
    if (this.ackMode !== "fail") {
      this.deliveries.push({ requestId, kind: "prompt", key, text });
      // Like Traycer's host, a send drops the chat's suggested next prompts (docs/ui-v3.md section 11).
      if (this.clearSuggestionsOnSend && s.details?.suggestions !== undefined) this.setSuggestions(target, null);
      if (this.ackMode === "immediate") this.setState(target, "working");
    }
    return this.finish(requestId, { requestId, stage: "backend_acknowledged" });
  }

  async createTask(req: CreateTaskRequest): Promise<CreateTaskResult> {
    const pre = this.preflight("createTask", req.requestId);
    if (pre) return pre;
    const ref = { ...req.project, taskId: `task-${++this.seq}` };
    const task: Task = { ref, title: req.title, updatedAt: this.now() };
    this.tasks.set(taskKey(ref), task);
    this.deliveries.push({ requestId: req.requestId, kind: "createTask", key: taskKey(ref), text: req.prompt ?? "" });
    this.emit({ type: "task_upserted", task });
    this.addSession({ ...ref, sessionId: `session-${++this.seq}` }, req.title, req.provider);
    return { ...(await this.finish(req.requestId, { requestId: req.requestId, stage: "backend_acknowledged" })), task };
  }

  async createSession(req: CreateSessionRequest): Promise<CreateSessionResult> {
    const pre = this.preflight("createSession", req.requestId);
    if (pre) return pre;
    if (!this.tasks.has(taskKey(req.task))) return { requestId: req.requestId, stage: "target_unavailable", message: "no such task" };
    const session = this.addSession({ ...req.task, sessionId: `session-${++this.seq}` }, `${req.provider} ${this.seq}`, req.provider);
    this.deliveries.push({ requestId: req.requestId, kind: "createSession", key: sessionKey(session.ref), text: req.prompt ?? "" });
    return { ...(await this.finish(req.requestId, { requestId: req.requestId, stage: "backend_acknowledged" })), session };
  }

  private addSession(ref: SessionRef, title: string, provider: Session["provider"]): Session {
    const session: Session = {
      ref, title, provider, runtime: "chat", workspace: "/mock", createdAt: this.now(),
      status: observedStatus("working", this.now(), { mock: "working" }),
    };
    this.upsertSession(session);
    return session;
  }

  async respondToApproval(d: ApprovalDecision): Promise<CommandResult> {
    const pre = this.preflight("respondToApproval", d.requestId);
    if (pre) return pre;
    if (!this.approvals.has(d.approvalId)) return { requestId: d.requestId, stage: "target_unavailable", message: "approval not pending" };
    this.approvalCalls.push(d);
    this.approvals.delete(d.approvalId);
    this.emit({ type: "approval_resolved", approvalId: d.approvalId });
    this.setState(d.sessionRef, d.decision === "approve" ? "working" : "idle");
    return this.finish(d.requestId, { requestId: d.requestId, stage: "completed" });
  }

  async interrupt(ref: SessionRef, requestId: string): Promise<CommandResult> {
    const pre = this.preflight("interrupt", requestId);
    if (pre) return pre;
    if (!this.sessions.has(sessionKey(ref))) return { requestId, stage: "target_unavailable" };
    this.interruptCalls.push(sessionKey(ref));
    this.setState(ref, "idle");
    return this.finish(requestId, { requestId, stage: "completed" });
  }

  async focus(ref: SessionRef, requestId: string): Promise<CommandResult> {
    const pre = this.preflight("focus", requestId);
    if (pre) return pre;
    if (!this.sessions.has(sessionKey(ref))) return { requestId, stage: "target_unavailable" };
    this.focusCalls.push(sessionKey(ref));
    return this.finish(requestId, { requestId, stage: "completed" });
  }

  // --- test controls -------------------------------------------------------

  /** Backend acknowledges a request previously answered with "sent". */
  ack(requestId: string): void {
    const r: CommandResult = { requestId, stage: "backend_acknowledged" };
    this.results.set(requestId, r);
    this.emit({ type: "command_progress", requestId, stage: "backend_acknowledged" });
  }

  /** Resolves a hanging request with its recorded result. */
  release(requestId: string, stage: CommandResult["stage"] = "backend_acknowledged"): void {
    const resolve = this.hanging.get(requestId);
    this.hanging.delete(requestId);
    const r: CommandResult = { requestId, stage };
    this.results.set(requestId, r);
    resolve?.(r);
  }

  upsertSession(session0: Session): void {
    const session = withMarkdown(session0);
    this.sessions.set(sessionKey(session.ref), session);
    this.emit({ type: "session_upserted", session });
  }

  removeSession(ref: SessionRef): void {
    this.sessions.delete(sessionKey(ref));
    this.emit({ type: "session_removed", ref });
  }

  setState(ref: SessionRef, state: NormalizedState | null, inferred?: { state: NormalizedState; reason: string }): void {
    const s = this.sessions.get(sessionKey(ref));
    if (!s) return;
    const status = observedStatus(state, this.now(), { mock: state });
    if (inferred) status.inferred = inferred;
    this.upsertSession({ ...s, status });
  }

  /** Sets (or with null / [] clears) a session's suggested next prompts, `Session.details.suggestions`. */
  setSuggestions(ref: SessionRef, suggestions: readonly string[] | null): void {
    const s = this.sessions.get(sessionKey(ref));
    if (!s) return;
    const { suggestions: _old, ...rest } = s.details ?? {};
    const details = suggestions && suggestions.length > 0 ? { ...rest, suggestions: [...suggestions] } : rest;
    this.upsertSession({ ...s, details });
  }

  requestApproval(approval: ApprovalRequest): void {
    this.approvals.set(approval.id, approval);
    this.emit({ type: "approval_requested", approval });
  }

  /** Simulates a transport drop: no events, calls fail until restore(). */
  dropConnection(): void {
    this.connected = false;
    this.emit({ type: "connection", state: "disconnected" });
  }

  snapshotNow(): Snapshot {
    return {
      projects: [...this.projects],
      tasks: [...this.tasks.values()],
      sessions: [...this.sessions.values()],
      approvals: [...this.approvals.values()],
    };
  }

  /** Silently changes backend state while disconnected (what a reconnect must discover). */
  mutateOffline(fn: (m: { sessions: Map<string, Session>; approvals: Map<string, ApprovalRequest> }) => void): void {
    fn({ sessions: this.sessions, approvals: this.approvals });
  }
}

/**
 * The mock reads `details.lastMessage` as Markdown, like the Traycer adapter reads a chat (docs/ui-v3.md section 13):
 * `lastBlocks` is added when the fixture gave none.
 */
function withMarkdown(s: Session): Session {
  const d = s.details;
  if (d?.lastMessage === undefined || d.lastBlocks !== undefined) return s;
  const blocks = markdownBlocks(d.lastMessage);
  return blocks.length > 0 ? { ...s, details: { ...d, lastBlocks: blocks } } : s;
}
