// Defence in depth for live smoke runs: every state-changing AgentAdapter call is checked against the
// disposable allowlist (and --live) before it reaches the real adapter, and is logged.
import type {
  AdapterCapabilities,
  AgentAdapter,
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  CommandResult,
  CreateSessionRequest,
  CreateSessionResult,
  CreateTaskRequest,
  CreateTaskResult,
  Project,
  Session,
  SessionRef,
  Task,
  Unsubscribe,
} from "@fm1/agent-core";
import { SMOKE_PROJECT_ID, type Allowlist } from "./allowlist";

export interface Mutation {
  op: string;
  target: string;
  requestId: string;
  at: number;
  stage: string | null;
}

export class GuardRefusal extends Error {
  override name = "GuardRefusal";
}

type Watchable = { watchSession(ref: SessionRef): () => void };
type PromptRouted = { promptCapability(ref: SessionRef): { via: string | null; senderAgentId?: string } | null };

export class GuardedAdapter implements AgentAdapter {
  readonly mutations: Mutation[] = [];
  readonly refusals: string[] = [];
  private readonly injected = new Set<(e: AgentEvent) => void>();

  constructor(
    readonly inner: AgentAdapter,
    private readonly allowlist: Allowlist,
    private readonly live: boolean,
  ) {}

  get id(): string {
    return this.inner.id;
  }

  connect(): Promise<void> {
    return this.inner.connect();
  }
  disconnect(): Promise<void> {
    return this.inner.disconnect();
  }
  getCapabilities(): AdapterCapabilities {
    return this.inner.getCapabilities();
  }
  listProjects(): Promise<Project[]> {
    return this.inner.listProjects();
  }
  listTasks(projectId?: string): Promise<Task[]> {
    return this.inner.listTasks(projectId);
  }
  listSessions(taskId?: string): Promise<Session[]> {
    return this.inner.listSessions(taskId);
  }
  listApprovals(): Promise<ApprovalRequest[]> {
    return this.inner.listApprovals();
  }

  subscribe(listener: (event: AgentEvent) => void): Unsubscribe {
    this.injected.add(listener);
    const off = this.inner.subscribe(listener);
    return () => {
      this.injected.delete(listener);
      off();
    };
  }

  /** T9: delivers a crafted (possibly hostile) event to subscribers exactly as a backend event would arrive. */
  inject(event: unknown): void {
    for (const fn of [...this.injected]) fn(event as AgentEvent);
  }

  watchSession(ref: SessionRef): () => void {
    const w = this.inner as Partial<Watchable>;
    return typeof w.watchSession === "function" ? w.watchSession.call(this.inner, ref) : () => undefined;
  }

  async sendPrompt(target: SessionRef, text: string, requestId: string): Promise<CommandResult> {
    // A Traycer a2a prompt (terminal agent) also acts as a sender agent: that agent must be disposable too.
    const refused = this.refuseRef(target);
    if (refused) return this.refused("sendPrompt", `${target.taskId}/${target.sessionId}`, requestId, refused);
    // The route is unknown (null) until the inner adapter has loaded the task's agents, and the inner sendPrompt would
    // then resolve the agent and pick a sender unchecked. Load first (a read), then check the sender.
    if (this.routeOf(target) === null) await this.inner.listSessions(target.taskId).catch(() => undefined);
    const why = this.refuseA2aSender(target);
    if (why) return this.refused("sendPrompt", `${target.taskId}/${target.sessionId}`, requestId, why);
    return this.mutate("sendPrompt", target, requestId, () => this.inner.sendPrompt(target, text, requestId));
  }

  interrupt(session: SessionRef, requestId: string): Promise<CommandResult> {
    return this.mutate("interrupt", session, requestId, () => this.inner.interrupt(session, requestId));
  }

  focus(session: SessionRef, requestId: string): Promise<CommandResult> {
    return this.mutate("focus", session, requestId, () => this.inner.focus(session, requestId));
  }

  respondToApproval(decision: ApprovalDecision): Promise<CommandResult> {
    return this.mutate(`respondToApproval:${decision.decision}`, decision.sessionRef, decision.requestId, () => this.inner.respondToApproval(decision));
  }

  createSession(request: CreateSessionRequest): Promise<CreateSessionResult> {
    const { requestId, task } = request;
    const why = this.refuseTask(task.taskId);
    if (why) return Promise.resolve(this.refused("createSession", task.taskId, requestId, why));
    return this.logged("createSession", task.taskId, requestId, () => this.inner.createSession(request));
  }

  createTask(request: CreateTaskRequest): Promise<CreateTaskResult> {
    const { requestId, project } = request;
    if (!this.live) return Promise.resolve(this.refused("createTask", project.projectId, requestId, "needs --live"));
    if (project.projectId !== SMOKE_PROJECT_ID) {
      return Promise.resolve(this.refused("createTask", project.projectId, requestId, `project is not the disposable workspace ${SMOKE_PROJECT_ID}`));
    }
    return this.logged("createTask", project.projectId, requestId, () => this.inner.createTask(request));
  }

  /** Why a call against this ref must not run, or null when it may. */
  refuseRef(ref: SessionRef): string | null {
    if (!this.live) return "needs --live";
    if (!this.allowlist.hasChat(ref.taskId, ref.sessionId)) return `${ref.taskId}/${ref.sessionId} is not in the disposable allowlist`;
    return null;
  }

  /**
   * For a prompt the inner adapter would send over agent.sendMessage, or type into the terminal (`terminal.write`) with
   * an a2a fallback: refuse unless the (fallback) sender is allowlisted. The typed-into terminal is the target itself,
   * already checked by refuseRef.
   */
  refuseA2aSender(ref: SessionRef): string | null {
    const route = this.routeOf(ref);
    if (route === null || route === undefined) return null;
    if (route.via === "terminal.write" && route.senderAgentId === undefined) return null;
    if (route.via !== "agent.sendMessage" && route.via !== "terminal.write") return null;
    if (route.senderAgentId === undefined || !this.allowlist.hasChat(ref.taskId, route.senderAgentId)) {
      return `a2a sender ${route.senderAgentId ?? "(none)"} is not in the disposable allowlist for ${ref.taskId}`;
    }
    return null;
  }

  /** The inner adapter's prompt route: undefined when it has no routing (not a Traycer adapter), null when unknown. */
  private routeOf(ref: SessionRef): ReturnType<PromptRouted["promptCapability"]> | undefined {
    const routed = this.inner as Partial<PromptRouted>;
    return typeof routed.promptCapability === "function" ? routed.promptCapability.call(this.inner, ref) : undefined;
  }

  private refuseTask(epicId: string): string | null {
    if (!this.live) return "needs --live";
    return this.allowlist.hasTask(epicId) ? null : `task ${epicId} is not in the disposable allowlist`;
  }

  private mutate<T extends CommandResult>(op: string, ref: SessionRef, requestId: string, run: () => Promise<T>): Promise<T | CommandResult> {
    const why = this.refuseRef(ref);
    if (why) return Promise.resolve(this.refused(op, `${ref.taskId}/${ref.sessionId}`, requestId, why));
    return this.logged(op, `${ref.taskId}/${ref.sessionId}`, requestId, run);
  }

  private async logged<T extends CommandResult>(op: string, target: string, requestId: string, run: () => Promise<T>): Promise<T> {
    const m: Mutation = { op, target, requestId, at: Date.now(), stage: null };
    this.mutations.push(m);
    const r = await run();
    m.stage = r.stage;
    return r;
  }

  private refused(op: string, target: string, requestId: string, why: string): CommandResult {
    this.refusals.push(`${op} ${target}: ${why}`);
    // "unsupported" so callers (and agent-core) treat it as never sent.
    return { requestId, stage: "unsupported", message: `smoke guard refused: ${why}` };
  }
}
