import type {
  AgentAdapter,
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  CommandResult,
  CreateSessionRequest,
  CreateSessionResult,
  CreateTaskRequest,
  CreateTaskResult,
  DeliveryStage,
  PinnedRequest,
  PinnedResult,
  Project,
  Session,
  SessionRef,
  Task,
  Unsubscribe,
} from "@fm1/agent-core";
import { sessionKey, taskKey } from "@fm1/agent-core";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { TraycerAdapter } from "../adapter";
import { CredentialSource } from "../credentials";
import type { ChatRunSettingsValue, NormalizedAgent } from "../normalize";
import type { HostMethod, HostRequest, HostResponse } from "../rpc";
import { openTerminalStream } from "../streams";
import { A2aNotSentError, deliverA2a, PROMPT_COPY, promptCapabilityFor, type PromptCapability } from "./a2a-delivery";
import { ApprovalStore, decideApproval, type ApprovalEntry } from "./approvals";
import { baseCapabilities, CapabilityState, readCapabilityReport, type TraycerCapabilities } from "./capabilities";
import { ChatChannel } from "./chat-channel";
import { parseTaskCreateOutput, spawnRunner, strippedEnv } from "./cli";
import { chatSettingsFor, createTaskArgv, newChatAgent, taskCreateFailure } from "./create-commands";
import { resolveConfig, type CommandRunner, type ResolvedConfig, type TraycerAgentAdapterConfig } from "./config";
import { HostLink, type HostLinkDeps } from "./connection";
import { focusSession } from "./focus";
import { FallbackPoller, LiveFeeds, type FeedName } from "./live-feeds";
import { BACKEND_ID, projectIdOf, sessionRefOf, toProject } from "./mapping";
import { deliverPrompt } from "./prompt-delivery";
import { SessionBook } from "./session-book";
import { TerminalDetails } from "./terminal-transcript";
import { deliverTyped, TYPING_DEFAULTS, type TypingOutcome } from "./terminal-typing";
import type { TypingHarness } from "./tui-screen-state";

const NOT_FOUND = /NOT_FOUND|not found|no such|unknown (chat|epic|agent|task)|deleted/i;
const INCOMPATIBLE_CODES = new Set(["INCOMPATIBLE", "DOWNGRADE_UNSUPPORTED"]);

export interface TraycerAgentAdapterDeps {
  readonly link?: HostLinkDeps;
}

export interface TraycerDiagnostics {
  readonly link: string;
  readonly endpoint: { readonly websocketUrl: string; readonly pid: number; readonly hostId: string; readonly version: string } | null;
  readonly clientKind: string | null;
  readonly lastError: string | null;
  readonly feeds: Record<FeedName, string>;
  readonly pollingFallback: boolean;
  readonly malformed: Record<string, number>;
  readonly watchedSession: string | null;
  readonly openChats: number;
  /** The last terminal transcript read for the selected session: its size only, never its content. */
  readonly lastTranscript: { readonly session: string; readonly chars: number } | null;
  /**
   * The negotiated `chat.subscribe` version (`major.minor`) of an open chat stream, or null when none is open.
   * `suggestedPrompt` needs >= 1.20 (docs/ui-v3.md section 11).
   */
  readonly chatSubscribe: string | null;
}

/**
 * agent-core `AgentAdapter` for the local Traycer host. See
 * docs/traycer-adapter.md for the mapping, state model and capability rules.
 */
export class TraycerAgentAdapter implements AgentAdapter {
  readonly id = BACKEND_ID;
  /** The backend name in device copy (`Traycer offline`, `Gone from Traycer`). */
  readonly displayName = "Traycer";
  private readonly config: ResolvedConfig;
  private readonly credentials: CredentialSource;
  private readonly runCommand: CommandRunner;
  private readonly link: HostLink;
  private readonly caps: CapabilityState;
  private readonly book: SessionBook;
  private readonly approvals: ApprovalStore;
  private readonly feeds: LiveFeeds;
  private readonly poller: FallbackPoller;
  private readonly terminal: TerminalDetails;
  private terminalState: string | null = null;
  private lastTranscript: { session: string; chars: number } | null = null;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly channels = new Map<string, ChatChannel>();
  private readonly results = new Map<string, Promise<CommandResult>>();
  /** Approval ids with a decision in flight: a second decision (other requestId) is refused, never sent. */
  private readonly deciding = new Set<string>();
  private readonly malformed: Record<string, number> = {};
  private readonly scannedEpics = new Set<string>();
  private watched: { key: string; release: () => void } | null = null;
  private notificationsReady: Promise<void>;
  private markNotificationsReady: () => void = () => undefined;
  private activityReady: Promise<void>;
  private markActivityReady: () => void = () => undefined;
  private taskRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Background full session scan (docs/traycer-integration.md "Session scan"): its timer and the run in flight. */
  private fullScanTimer: ReturnType<typeof setInterval> | null = null;
  private fullScanRun: Promise<void> | null = null;
  /** Tasks whose sessions the console was last given (the last unfiltered listSessions, or a full scan's emits). */
  private listedEpics = new Set<string>();
  private wanted = false;
  /** The last `epic.listTasks` listed every task (fewer than the page limit): a task missing from it is gone. */
  private tasksComplete = false;
  /** Set when the host answered INCOMPATIBLE on agent.sendMessage; cleared on the next successful handshake. */
  private a2aLost: string | null = null;
  /** Set when typing cannot run on this host (terminal.subscribe < 1.6, no cache viewer); cleared on the next handshake. */
  private typingLost: string | null = null;

  constructor(config: TraycerAgentAdapterConfig = {}, deps: TraycerAgentAdapterDeps = {}) {
    this.config = resolveConfig(config);
    this.credentials = config.credentials ?? new CredentialSource();
    this.runCommand = config.runCommand ?? spawnRunner;
    this.caps = new CapabilityState(baseCapabilities(readCapabilityReport(this.config.capabilityReportPath), this.config.focusDeepLink));
    this.book = new SessionBook((event) => this.emit(event), this.config.now);
    this.approvals = new ApprovalStore({
      onRequested: (entry) => {
        const approval = this.toApprovalRequest(entry);
        if (approval !== null) this.emit({ type: "approval_requested", approval });
        this.book.refresh(entry.epicId, entry.chatId);
      },
      onResolved: (entry, approvalId) => {
        this.emit({ type: "approval_resolved", approvalId });
        if (entry !== null) this.book.refresh(entry.epicId, entry.chatId);
      },
    });
    this.book.setApprovalSource((epicId, chatId) => this.approvals.pendingFor(epicId, chatId));
    this.book.setPromptPolicy((agent) => this.promptPolicy(agent));
    this.notificationsReady = this.newNotificationsGate();
    this.activityReady = this.newActivityGate();
    this.link = new HostLink(
      this.config,
      this.credentials,
      {
        onConnected: (endpoint, info) => {
          this.caps.reset();
          this.a2aLost = null;
          this.typingLost = null;
          this.book.setHost(endpoint.hostId);
          if (!info.first) this.restartDeadFeeds();
          // Host was down when connect() was called: the feeds were never started, so start them now.
          if (this.wanted && !this.feeds.running) this.startFeeds();
          this.emit({ type: "connection", state: "connected" });
          if (this.wanted) void this.fullScan();
        },
        onDisconnected: (reason) => {
          this.notificationsReady = this.newNotificationsGate();
          this.activityReady = this.newActivityGate();
          this.emit({ type: "connection", state: "disconnected", reason });
        },
        onIncompatible: (reason) => {
          this.caps.setHostIncompatible(`host INCOMPATIBLE: ${reason}`);
          this.emit({ type: "connection", state: "disconnected", reason: `INCOMPATIBLE: ${reason}` });
        },
      },
      deps.link,
    );
    this.feeds = new LiveFeeds({
      onActivity: (byEpic, servedBy) => {
        this.book.applyActivity(byEpic, servedBy);
        this.markActivityReady();
      },
      onRecord: (event) => this.onRecord(event),
      onNotification: (event) => {
        if (event.kind === "rows") {
          this.approvals.applyNotifications(event.rows, event.snapshot);
          this.book.applyNotifications(event.rows, event.snapshot);
          if (event.snapshot) this.markNotificationsReady();
        } else if (event.kind === "readState") {
          this.approvals.applyReadState(event.ids, event.resolvedAt);
          this.book.applyReadState(event.ids, event.readAt);
        }
      },
      onMalformed: (feed, why) => {
        this.malformed[feed] = (this.malformed[feed] ?? 0) + 1;
        void why;
      },
      onDrop: (feed, reason) => {
        if (feed === "agent.activity.subscribe") {
          this.book.clearActivity();
          this.activityReady = this.newActivityGate();
        }
        void reason;
        void this.link.verify();
      },
      onOpen: () => this.updatePolling(),
      onDead: (feed, code, reason) => {
        if (feed === "agent.activity.subscribe") {
          this.book.clearActivity();
          this.markActivityReady(); // never coming: do not make listSessions wait for it
        }
        if (INCOMPATIBLE_CODES.has(code)) {
          if (this.feeds.dead("agent.activity.subscribe") && this.feeds.dead("host.chatRecords.subscribe")) {
            this.caps.loseSubscribe(`host INCOMPATIBLE on event streams: ${reason}`);
          }
          this.emit({ type: "connection", state: "degraded", reason: `${feed} INCOMPATIBLE: ${reason}` });
        } else {
          this.link.notifyDrop(`${feed} closed: ${code}`);
        }
        this.updatePolling();
      },
    });
    this.poller = new FallbackPoller(this.config.pollBackoff, () => this.pollOnce());
    this.terminal = new TerminalDetails(
      {
        transcript: async (epicId, agentId) => {
          if (this.link.status !== "connected") return null;
          const r = (await this.link.rpc.call("agent.getTranscript", { epicId, agentId })) as { transcript?: unknown };
          return typeof r.transcript === "string" ? r.transcript : null;
        },
        apply: (epicId, agentId, details, at) => this.book.setTranscriptDetails(epicId, agentId, details, at),
        updatedAt: (epicId, agentId) => this.book.agent(epicId, agentId)?.updatedAt,
        now: this.config.now,
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
        onFetched: (epicId, agentId, chars) => {
          this.lastTranscript = { session: `${epicId}/${agentId}`, chars };
        },
      },
      this.config.terminalRefreshMs,
    );
  }

  // --- lifecycle -------------------------------------------------------------

  async connect(): Promise<void> {
    this.wanted = true;
    await this.link.connect();
    this.startFullScans();
    if (!this.feeds.running) this.feeds.start(await this.link.streams());
  }

  async disconnect(): Promise<void> {
    this.wanted = false;
    if (this.fullScanTimer !== null) clearInterval(this.fullScanTimer);
    this.fullScanTimer = null;
    this.poller.stop();
    this.feeds.stop();
    this.watched?.release();
    this.watched = null;
    this.terminal.stop();
    for (const channel of this.channels.values()) channel.close();
    this.channels.clear();
    if (this.taskRefreshTimer !== null) clearTimeout(this.taskRefreshTimer);
    this.link.close();
    this.emit({ type: "connection", state: "disconnected", reason: "adapter disconnected" });
  }

  getCapabilities(): TraycerCapabilities {
    return this.caps.snapshot();
  }

  subscribe(listener: (event: AgentEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  diagnostics(): TraycerDiagnostics {
    const endpoint = this.link.endpoint;
    return {
      link: this.link.status,
      endpoint:
        endpoint === null ? null : { websocketUrl: endpoint.websocketUrl, pid: endpoint.pid, hostId: endpoint.hostId, version: endpoint.version },
      clientKind: this.link.clientKind,
      lastError: this.link.lastError,
      feeds: { ...this.feeds.status },
      pollingFallback: this.poller.running,
      malformed: { ...this.malformed },
      watchedSession: this.watched?.key ?? null,
      openChats: [...this.channels.values()].filter((c) => !c.closed).length,
      lastTranscript: this.lastTranscript === null ? null : { ...this.lastTranscript },
      chatSubscribe: [...this.channels.values()].find((c) => !c.closed)?.chatVersion() ?? null,
    };
  }

  // --- listing ---------------------------------------------------------------

  async listProjects(): Promise<Project[]> {
    if (this.book.allTasks().length === 0) await this.listTasks();
    const hostId = this.link.requireEndpoint().hostId;
    const ids = new Set(this.book.allTasks().map((t) => projectIdOf(t, hostId)));
    return [...ids].sort().map((id) => toProject(id, hostId));
  }

  async listTasks(projectId?: string): Promise<Task[]> {
    const helper = this.helper();
    const limit = 50;
    const tasks = await this.guardRpc("epic.listTasks", () => helper.listTasks({ limit, maxPages: this.config.listTasksMaxPages }));
    this.tasksComplete = tasks.length < limit * this.config.listTasksMaxPages;
    this.book.setTasks(tasks, this.tasksComplete);
    const hostId = this.link.requireEndpoint().hostId;
    return tasks.filter((t) => projectId === undefined || projectIdOf(t, hostId) === projectId).map((t) => this.book.toTask(t));
  }

  async listSessions(taskId?: string): Promise<Session[]> {
    if (this.book.allTasks().length === 0) await this.listTasks();
    const hostId = this.link.requireEndpoint().hostId;
    const epics = taskId !== undefined ? [taskId] : this.scanSelection(hostId);
    if (taskId === undefined) this.listedEpics = new Set(epics);
    const failures: unknown[] = [];
    const firstActivity = this.waitForFirstActivity();
    await mapLimit(epics, 4, (epicId) => this.loadAgents(epicId, false).catch((error: unknown) => failures.push(error)));
    // One unreadable task (e.g. deleted mid-scan) must not hide the others.
    if (epics.length > 0 && failures.length === epics.length) throw failures[0];
    await firstActivity;
    return epics.flatMap((epicId) => this.book.sessions(epicId));
  }

  /**
   * The tasks of the quick scan (docs/traycer-integration.md "Session scan"): every task with an agent working or in a
   * turn in the live activity feed, whatever the limit, then the `sessionScanLimit` tasks with chats on this host ranked
   * by real activity: the newer of the task's `updatedAt` and its newest known agent activity (from the background full
   * scan and earlier quick scans). Task `updatedAt` alone barely moves while agents work.
   */
  private scanSelection(hostId: string): string[] {
    const activity = this.book.activityByEpic();
    const busy = this.book.busyEpics().filter((epicId) => this.book.task(epicId) !== undefined);
    const ranked = this.book
      .allTasks()
      .filter((t) => t.chatHostIds.includes(hostId))
      .map((t) => ({ epicId: t.epicId, at: Math.max(t.updatedAt ?? 0, activity.get(t.epicId) ?? 0) }))
      .sort((a, b) => b.at - a.at)
      .slice(0, this.config.sessionScanLimit)
      .map((t) => t.epicId);
    return [...new Set([...busy, ...ranked])];
  }

  private startFullScans(): void {
    const every = this.config.fullScanIntervalMs;
    if (every <= 0 || this.fullScanTimer !== null) return;
    this.fullScanTimer = setInterval(() => void this.fullScan(), every);
    void this.fullScan();
  }

  /**
   * One background full scan: re-lists the tasks, then reads the agents of every task with chats on this host (four at a
   * time, without blocking listSessions). Never overlaps itself, does nothing while the link is down or after
   * disconnect, and tolerates a task that cannot be read. Agents land in the session book silently (they feed the
   * ranking); the sessions of a task that this scan moves into the quick-scan selection, and new agents of a selected
   * task, are announced with `task_upserted` / `session_upserted` so the console shows them before its next snapshot.
   */
  private fullScan(): Promise<void> {
    if (this.fullScanRun !== null) return this.fullScanRun;
    if (!this.wanted || this.config.fullScanIntervalMs <= 0 || this.link.status !== "connected") return Promise.resolve();
    const run = this.runFullScan()
      .catch(() => undefined)
      .finally(() => {
        if (this.fullScanRun === run) this.fullScanRun = null;
      });
    this.fullScanRun = run;
    return run;
  }

  private async runFullScan(): Promise<void> {
    await this.listTasks();
    const live = (): boolean => this.wanted && this.link.status === "connected";
    if (!live()) return;
    const hostId = this.link.requireEndpoint().hostId;
    const epics = this.book
      .allTasks()
      .filter((t) => t.chatHostIds.includes(hostId))
      .map((t) => t.epicId);
    const known = new Map<string, Set<string>>();
    await mapLimit(epics, 4, async (epicId) => {
      if (!live()) return;
      known.set(epicId, new Set(this.book.agentsOf(epicId).map((a) => a.agentId)));
      try {
        // requireSnapshot: an answer that is not a full listing must not remove agents.
        await this.loadAgents(epicId, false, { track: false, requireSnapshot: true });
      } catch {
        // One unreadable task (deleted mid-scan, busy host) must not stop the others.
      }
    });
    if (!live()) return;
    const selection = this.scanSelection(hostId);
    for (const epicId of selection) {
      const task = this.book.task(epicId);
      if (task === undefined) continue;
      const fresh = !this.listedEpics.has(epicId);
      const before = known.get(epicId);
      if (fresh) this.emit({ type: "task_upserted", task: this.book.toTask(task) });
      for (const agent of this.book.agentsOf(epicId)) {
        if (fresh || (before !== undefined && !before.has(agent.agentId))) this.book.refresh(epicId, agent.agentId, true);
      }
    }
    this.listedEpics = new Set(selection);
  }

  /**
   * Pinned sessions and tasks outside the `sessionScanLimit` scan (docs/ui-v3.md sections 9.6-9.7). Reads the agents of
   * every task that holds a pin (`epic.listChatRecords` + `epic.listTuiAgents`, the same calls as the scan) and returns
   * the pinned sessions and every session of each pinned task. A pin is reported `gone` only when Traycer says so: the
   * agent is missing from its task's listing (deleted) or archived, or the task is missing from a complete task listing
   * (deleted or archived). Anything uncertain (another host, a task that could not be read) keeps its pin. Rejects
   * while the host is disconnected (the console then keeps every pin). One call is one batch: each task is read once
   * (chat records, TUI agents, run settings), whatever the number of pins in it; the console sends the pins of at most
   * 25 tasks per call, at its slow cadence (agent-core console.ts PIN_FETCH_TASKS / PIN_CATCHUP_MS / PIN_REFRESH_MS).
   */
  async fetchPinned(request: PinnedRequest): Promise<PinnedResult> {
    if (this.link.status !== "connected") throw new Error("Traycer host disconnected");
    const hostId = this.link.requireEndpoint().hostId;
    const mine = (r: { backendId: string; hostId: string }): boolean => r.backendId === BACKEND_ID && r.hostId === hostId;
    const sessionsPinned = request.sessions.filter(mine);
    const tasksPinned = request.tasks.filter(mine);
    const epics = [...new Set([...sessionsPinned.map((r) => r.taskId), ...tasksPinned.map((t) => t.taskId)])];
    const out: PinnedResult = { sessions: [], tasks: [], gone: [] };
    if (epics.length === 0) return out;
    if (epics.some((e) => this.book.task(e) === undefined)) await this.listTasks();
    const seen = new Set<string>();
    const add = (session: Session | undefined): void => {
      if (session === undefined) return;
      const k = sessionKey(session.ref);
      if (seen.has(k)) return;
      seen.add(k);
      out.sessions.push(session);
    };
    await mapLimit(epics, 4, async (epicId) => {
      const pinnedHere = sessionsPinned.filter((r) => r.taskId === epicId);
      const taskPins = tasksPinned.filter((t) => t.taskId === epicId);
      const task = this.book.task(epicId);
      if (task === undefined) {
        if (!this.tasksComplete) return;
        for (const r of pinnedHere) out.gone.push(sessionKey(r));
        for (const t of taskPins) out.gone.push(taskKey(t));
        return;
      }
      let raw: NormalizedAgent[];
      try {
        raw = await this.guardRpc("epic.listChatRecords", () => this.helper().listAgents(epicId, true));
      } catch {
        return; // unreadable now: keep the pins, try again at the next snapshot
      }
      const kept = raw.filter((a) => (this.config.includeArchived || !a.archived) && (a.hostId === null || a.hostId === hostId));
      // Not added to `scannedEpics`: the fallback poller re-reads those every round, and its cost must not grow with
      // pins (operator decision 2026-11-19). Out-of-scan pins are refreshed by the console's slow batch only.
      this.book.setAgents(epicId, kept, false);
      for (const r of pinnedHere) {
        const agent = raw.find((a) => a.agentId === r.sessionId);
        if (agent !== undefined && agent.hostId !== null && agent.hostId !== hostId) continue;
        if (agent === undefined || (agent.archived && !this.config.includeArchived)) out.gone.push(sessionKey(r));
        else add(this.book.session(epicId, r.sessionId));
      }
      if (taskPins.length > 0) {
        out.tasks.push(this.book.toTask(task));
        for (const session of this.book.sessions(epicId)) add(session);
      }
    });
    return out;
  }

  async listApprovals(): Promise<ApprovalRequest[]> {
    await Promise.race([this.notificationsReady, sleep(2_000)]);
    return this.approvals.list().flatMap((entry) => {
      const approval = this.toApprovalRequest(entry);
      return approval === null ? [] : [approval];
    });
  }

  /**
   * Watches the session selected on the console (one at a time) and returns a release: a GUI chat opens
   * `chat.subscribe`; a terminal agent has no stream, so its transcript (`agent.getTranscript`) is read now, every
   * `terminalRefreshMs` and when its state changes (terminal-transcript.ts). Never for unselected sessions.
   */
  watchSession(ref: SessionRef): () => void {
    const key = `${ref.taskId}/${ref.sessionId}`;
    if (this.watched?.key === key) return this.watched.release;
    this.watched?.release();
    this.watched = null;
    const agent = this.book.agent(ref.taskId, ref.sessionId);
    if (agent !== undefined && agent.surface === "tui") return this.watchTerminal(key, ref);
    if (agent === undefined || agent.surface !== "gui" || this.caps.isLost("sendPrompt")) return () => undefined;
    const pending = this.channel(ref.taskId, ref.sessionId);
    let release: (() => void) | null = null;
    let cancelled = false;
    // A rejected stream client (credentials gone, endpoint lost) must not become an unhandled
    // rejection: Bun exits the companion on one.
    pending.then(
      (channel) => {
        if (cancelled) return;
        release = channel.retain();
      },
      () => {
        if (this.watched?.key === key) this.watched = null;
      },
    );
    const stop = (): void => {
      cancelled = true;
      release?.();
      if (this.watched?.key === key) this.watched = null;
    };
    this.watched = { key, release: stop };
    return stop;
  }

  private watchTerminal(key: string, ref: SessionRef): () => void {
    const releaseTerminal = this.terminal.start(ref.taskId, ref.sessionId);
    const current = this.book.session(ref.taskId, ref.sessionId);
    this.terminalState = current === undefined ? null : terminalStateOf(current);
    const stop = (): void => {
      releaseTerminal();
      // Unwatched, its transcript is no longer read: a "next steps" list could go stale (docs/ui-v3.md section 11).
      this.book.dropSuggestions(ref.taskId, ref.sessionId);
      if (this.watched?.key === key) this.watched = null;
    };
    this.watched = { key, release: stop };
    return stop;
  }

  /**
   * Whether (and how) a console prompt can reach this session, before any send: GUI chats via `chat.subscribe`; Claude
   * and Codex terminal agents typed into their terminal (`terminal.write`, Claude with the a2a fallback when a sender or
   * self-send applies); with `tuiRoute: "a2a"` Claude terminals via Traycer a2a only; everything else not at all.
   * `null` when the session is not known to the adapter. Also carried on each emitted session as `session.prompt`.
   */
  promptCapability(ref: SessionRef): PromptCapability | null {
    const agent = this.book.agent(ref.taskId, ref.sessionId);
    return agent === undefined ? null : this.promptPolicy(agent);
  }

  /** The console showed this session: a completed turn becomes completed_read. */
  markViewed(ref: SessionRef): void {
    this.book.markViewed(ref.taskId, ref.sessionId);
  }

  // --- commands --------------------------------------------------------------

  sendPrompt(target: SessionRef, text: string, requestId: string): Promise<CommandResult> {
    return this.once(requestId, async () => {
      const blocked = this.precheck("sendPrompt", target, requestId);
      if (blocked !== null) return blocked;
      if (text.trim().length === 0) return { requestId, stage: "failed", message: "empty prompt" };
      const agent = await this.resolveAgent(target);
      if (agent === null) return { requestId, stage: "target_unavailable", message: "session not found on the host" };
      if (agent.archived) return { requestId, stage: "target_unavailable", message: "session is archived" };
      if (agent.surface === "tui") return this.sendTerminalPrompt(target, agent, text, requestId);
      this.progress(requestId, "accepted_locally");
      let settings: ChatRunSettingsValue | null;
      try {
        settings = (await this.call("epic.getChatRunSettings", { epicId: target.taskId, chatId: target.sessionId })).settings;
      } catch (error) {
        return this.commandError(requestId, error);
      }
      if (settings === null) return { requestId, stage: "failed", message: "chat has no stored run settings" };
      const channel = await this.channel(target.taskId, target.sessionId);
      const release = channel.retain();
      try {
        await channel.waitReady(this.config.ackTimeoutMs);
      } catch (error) {
        release();
        return this.commandError(requestId, error);
      }
      const endpoint = this.link.requireEndpoint();
      return deliverPrompt(
        channel,
        release,
        {
          requestId,
          epicId: target.taskId,
          chatId: target.sessionId,
          text,
          userId: await this.credentials.userId(),
          hostId: endpoint.hostId,
          settings,
          ackTimeoutMs: this.config.ackTimeoutMs,
          turnTimeoutMs: this.config.turnTimeoutMs,
        },
        (id, stage, message) => this.progress(id, stage, message),
      );
    });
  }

  /**
   * Terminal (TUI) agent. Route `terminal.write` (default, operator decision 2026-11-19): typed into the agent's Traycer
   * terminal (terminal-typing.ts). If nothing was typed (no terminal, attach refused, not at its idle prompt, ...) a
   * Claude terminal falls back to Traycer a2a; a Codex terminal fails with the reason. Once the text was written the
   * result stands as it is (never re-routed: that could deliver the prompt twice). Route `agent.sendMessage`: a2a only.
   */
  private async sendTerminalPrompt(target: SessionRef, agent: NormalizedAgent, text: string, requestId: string): Promise<CommandResult> {
    const route = this.promptPolicy(agent);
    if (!route.acceptsPrompt || route.via === null || route.via === undefined || route.via === "chat.subscribe") {
      return { requestId, stage: "unsupported", message: route.reason ?? "terminal session cannot take a console prompt" };
    }
    if (route.via === "agent.sendMessage") {
      if (route.senderAgentId === undefined) return { requestId, stage: "unsupported", message: route.reason ?? "no a2a sender" };
      if (this.a2aLost !== null) return { requestId, stage: "unsupported", message: this.a2aLost };
      this.progress(requestId, "accepted_locally");
      return this.sendA2a(target, route.senderAgentId, text, requestId);
    }
    this.progress(requestId, "accepted_locally");
    const harness = (agent.harnessId ?? "claude") as TypingHarness;
    let streams: Awaited<ReturnType<HostLink["streams"]>> | null = null;
    let noStreams = "";
    try {
      streams = await this.link.streams();
    } catch (error) {
      noStreams = errorText(error);
    }
    const client = streams;
    // Only the stream lookup is guarded above: an error after the write must never look like "nothing typed".
    const outcome: TypingOutcome =
      client === null
        ? { written: false, code: "attach_failed", reason: `no stream connection: ${noStreams}` }
        : await deliverTyped(
      {
        terminal: async (epicId, agentId) => {
          if (this.link.status !== "connected") throw new Error("Traycer host disconnected");
          const r = (await this.call("terminal.list", { scope: { kind: "epic", epicId } } as never)) as { sessions?: Array<Record<string, unknown>> };
          const row = (r.sessions ?? []).find((x) => x.sessionId === agentId && x.sessionKind === "terminal-agent");
          if (row === undefined) return null;
          return { sessionId: String(row.sessionId), cols: Number(row.cols), rows: Number(row.rows), status: String(row.status), sessionKind: String(row.sessionKind) };
        },
        open: (sessionId, size, events) => openTerminalStream(client, sessionId, size, events),
        transcript: (epicId, agentId) => this.readTranscript(epicId, agentId),
        progress: (id, stage, message) => this.progress(id, stage, message),
        onReply: (reply) => this.book.setReply(target.taskId, target.sessionId, reply),
        now: this.config.now,
        sleep,
        active: () => this.wanted,
      },
      {
        requestId,
        epicId: target.taskId,
        agentId: target.sessionId,
        harness,
        text,
        ...TYPING_DEFAULTS,
        quietMs: this.config.typeQuietMs,
        confirmTimeoutMs: this.config.typeConfirmTimeoutMs,
        turnTimeoutMs: this.config.turnTimeoutMs,
        pollMs: this.config.a2aPollMs,
      },
    );
    if (outcome.written) return outcome.result;
    if (outcome.code === "old_host") this.typingLost = outcome.reason;
    if (!this.wanted) return { requestId, stage: "failed", message: `adapter stopped before typing (${outcome.reason}); nothing typed, not sent` };
    if (route.fallbackVia === "agent.sendMessage" && route.senderAgentId !== undefined && this.a2aLost === null) {
      // Nothing was typed: Traycer a2a delivers it instead (as an agent message, not a user turn).
      this.progress(requestId, "accepted_locally", `not typed (${outcome.reason}); sending through Traycer a2a`);
      return this.sendA2a(target, route.senderAgentId, text, requestId);
    }
    const who = harness === "codex" ? "Codex terminal" : "terminal agent";
    return { requestId, stage: "failed", message: `${who}: ${outcome.reason}; nothing typed` };
  }

  /** Traycer a2a (`agent.sendMessage`) as `senderAgentId`; delivery and reply read from the transcript. */
  private async sendA2a(target: SessionRef, senderAgentId: string, text: string, requestId: string): Promise<CommandResult> {
    const result = await deliverA2a(
      {
        sendMessage: (params, idempotencyKey) => {
          // Link down before the call: provably not sent (failed, retryable), not an uncertain `sent`.
          if (this.link.status !== "connected") return Promise.reject(new A2aNotSentError("Traycer host disconnected"));
          return this.call("agent.sendMessage", params, { idempotencyKey }) as Promise<{ responseId: string | null }>;
        },
        transcript: (epicId, agentId) => this.readTranscript(epicId, agentId),
        progress: (id, stage, message) => this.progress(id, stage, message),
        onReply: (reply) => this.book.setReply(target.taskId, target.sessionId, reply),
        now: this.config.now,
        sleep,
        active: () => this.wanted,
      },
      {
        requestId,
        epicId: target.taskId,
        receiverAgentId: target.sessionId,
        senderAgentId,
        text,
        expectReply: this.config.a2aExpectReply,
        ackTimeoutMs: this.config.ackTimeoutMs,
        turnTimeoutMs: this.config.turnTimeoutMs,
        pollMs: this.config.a2aPollMs,
      },
    );
    if (result.stage === "unsupported" && /INCOMPATIBLE/.test(result.message ?? "")) {
      this.a2aLost = result.message ?? "host INCOMPATIBLE on agent.sendMessage";
    }
    return result;
  }

  private async readTranscript(epicId: string, agentId: string): Promise<string | null> {
    const r = (await this.link.rpc.call("agent.getTranscript", { epicId, agentId })) as { transcript?: unknown };
    return typeof r.transcript === "string" ? r.transcript : null;
  }

  private promptPolicy(agent: NormalizedAgent): PromptCapability {
    // Typing lost (host too old for a cache viewer): terminals take the a2a route instead.
    const tuiRoute = this.typingLost !== null ? "a2a" : this.config.tuiRoute;
    const base = promptCapabilityFor(agent, { senders: this.config.a2aSenders, selfSend: this.config.a2aSelfSend, tuiRoute });
    if (base.via === "chat.subscribe" && this.caps.isLost("sendPrompt")) {
      return { acceptsPrompt: false, via: null, reason: this.caps.snapshot().sendPrompt.reason ?? "sendPrompt unavailable", ...PROMPT_COPY.lost };
    }
    if (base.via === "agent.sendMessage" && this.a2aLost !== null) return { acceptsPrompt: false, via: null, reason: this.a2aLost, ...PROMPT_COPY.lost };
    if (base.via === "terminal.write" && this.a2aLost !== null && base.fallbackVia !== undefined) return { acceptsPrompt: true, via: "terminal.write" };
    return base;
  }

  respondToApproval(decision: ApprovalDecision): Promise<CommandResult> {
    const { requestId, approvalId, sessionRef } = decision;
    return this.once(requestId, async () => {
      const blocked = this.precheck("respondToApproval", sessionRef, requestId);
      if (blocked !== null) return blocked;
      if (this.approvals.isResolved(approvalId)) {
        return { requestId, stage: "target_unavailable", message: `approval ${approvalId} already resolved` };
      }
      const entry = this.approvals.get(approvalId);
      if (entry !== undefined && (entry.epicId !== sessionRef.taskId || entry.chatId !== sessionRef.sessionId)) {
        return { requestId, stage: "target_unavailable", message: `approval ${approvalId} belongs to another session` };
      }
      // Claimed synchronously (before any await), so two presses cannot both reach the host.
      if (this.deciding.has(approvalId)) {
        return { requestId, stage: "target_unavailable", message: `a decision for approval ${approvalId} is already in flight` };
      }
      this.deciding.add(approvalId);
      try {
        return await this.decide(decision);
      } finally {
        this.deciding.delete(approvalId);
      }
    });
  }

  private async decide(decision: ApprovalDecision): Promise<CommandResult> {
    const { requestId, approvalId, sessionRef } = decision;
    const agent = await this.resolveAgent(sessionRef);
    if (agent === null) return { requestId, stage: "target_unavailable", message: "session not found on the host" };
    if (agent.surface === "tui") return { requestId, stage: "unsupported", message: "terminal sessions have no approval protocol" };
    const channel = await this.channel(sessionRef.taskId, sessionRef.sessionId);
    const release = channel.retain();
    try {
      await channel.waitReady(this.config.ackTimeoutMs);
      this.approvals.applyChannel(channel);
      const result = await decideApproval(channel, {
        requestId,
        approvalId,
        approved: decision.decision === "approve",
        ackTimeoutMs: this.config.ackTimeoutMs,
      });
      if (result.stage === "target_unavailable" || result.stage === "completed") this.approvals.resolve(approvalId);
      return result;
    } catch (error) {
      return this.commandError(requestId, error);
    } finally {
      release();
    }
  }

  interrupt(session: SessionRef, requestId: string): Promise<CommandResult> {
    return this.once(requestId, async () => {
      const blocked = this.precheck("interrupt", session, requestId);
      if (blocked !== null) return blocked;
      const agent = await this.resolveAgent(session);
      if (agent === null) return { requestId, stage: "target_unavailable", message: "session not found on the host" };
      try {
        const response = await this.call("agent.stop", { epicId: session.taskId, agentId: session.sessionId, cascade: false });
        const stopped = (response as { stoppedAgentIds?: unknown }).stoppedAgentIds;
        const hit = Array.isArray(stopped) && stopped.includes(session.sessionId);
        return hit ? { requestId, stage: "completed" } : { requestId, stage: "completed", message: "agent was not running" };
      } catch (error) {
        return this.commandError(requestId, error);
      }
    });
  }

  focus(session: SessionRef, requestId: string): Promise<CommandResult> {
    return this.once(requestId, async () => {
      if (session.backendId !== BACKEND_ID) return { requestId, stage: "target_unavailable", message: "not a Traycer session" };
      const agent = this.book.agent(session.taskId, session.sessionId);
      if (agent !== undefined) {
        this.markViewed(session);
        this.watchSession(session);
      }
      const runtime = agent === undefined ? null : agent.surface === "gui" ? "chat" : "terminal";
      return focusSession(this.runCommand, session, requestId, { deepLink: this.config.focusDeepLink, runtime });
    });
  }

  createTask(request: CreateTaskRequest): Promise<CreateTaskResult> {
    const { requestId } = request;
    return this.once(requestId, async (): Promise<CreateTaskResult> => {
      const cap = this.caps.snapshot().createTask;
      if (!cap.supported) return { requestId, stage: "unsupported", message: cap.reason };
      const model = this.config.models[request.provider];
      if (model === undefined) return { requestId, stage: "unsupported", message: `no harness/model configured for provider ${request.provider}` };
      this.progress(requestId, "accepted_locally");
      let outcome;
      try {
        const run = await this.runCommand(this.config.traycerBin, createTaskArgv(request, model), { env: strippedEnv(), timeoutMs: 120_000 });
        outcome = parseTaskCreateOutput(run.stdout, run.code);
      } catch (error) {
        return { requestId, stage: "failed", message: `traycer CLI failed to start: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (!outcome.ok) return taskCreateFailure(requestId, outcome);
      const task = await this.findNewTask(outcome.taskId, request);
      this.emit({ type: "task_upserted", task });
      if (this.link.status === "connected") void this.loadAgents(outcome.taskId, true).catch(() => undefined);
      return { requestId, stage: "backend_acknowledged", task, ...(outcome.alreadyCreated ? { message: "task already created for this request" } : {}) };
    });
  }

  createSession(request: CreateSessionRequest): Promise<CreateSessionResult> {
    const { requestId } = request;
    return this.once(requestId, async (): Promise<CreateSessionResult> => {
      const cap = this.caps.snapshot().createSession;
      if (!cap.supported) return { requestId, stage: "unsupported", message: cap.reason };
      if (this.link.status !== "connected") return { requestId, stage: "failed", message: "Traycer host disconnected" };
      const model = this.config.models[request.provider];
      if (model === undefined) return { requestId, stage: "unsupported", message: `no harness/model configured for provider ${request.provider}` };
      if (this.book.task(request.task.taskId) === undefined) await this.listTasks().catch(() => []);
      const task = this.book.task(request.task.taskId);
      if (task === undefined) return { requestId, stage: "target_unavailable", message: "task not found on the host" };
      this.progress(requestId, "accepted_locally");
      try {
        const prompt = request.prompt?.trim();
        const created = await this.guardRpc("epic.createChat", () =>
          this.helper().createChat(task.epicId, { settings: chatSettingsFor(model), title: "", ...(prompt ? { initialMessage: prompt } : {}) }),
        );
        const agent = newChatAgent(
          { epicId: task.epicId, chatId: created.chatId, hostId: this.link.requireEndpoint().hostId, userId: await this.credentials.userId(), now: this.config.now() },
          model,
        );
        const session = this.book.putAgent(agent, true);
        return session === undefined ? { requestId, stage: "backend_acknowledged" } : { requestId, stage: "backend_acknowledged", session };
      } catch (error) {
        return this.commandError(requestId, error);
      }
    });
  }

  /** Re-reads the task list (detects deleted tasks). */
  async refreshTasks(): Promise<void> {
    await this.listTasks();
  }

  // --- internals -------------------------------------------------------------

  private emit(event: AgentEvent): void {
    if (event.type === "session_upserted" && event.session.runtime === "terminal") this.onTerminalUpsert(event.session);
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A listener failure must not break the adapter's event loop.
      }
    }
  }

  /** The watched terminal session changed state (turn started or ended): read its transcript again now. */
  private onTerminalUpsert(session: Session): void {
    const { taskId, sessionId } = session.ref;
    if (this.terminal.watching !== `${taskId}/${sessionId}`) return;
    const state = terminalStateOf(session);
    if (state === this.terminalState) return;
    this.terminalState = state;
    this.terminal.poke(taskId, sessionId);
  }

  private progress(requestId: string, stage: DeliveryStage, message?: string): void {
    this.emit(message === undefined ? { type: "command_progress", requestId, stage } : { type: "command_progress", requestId, stage, message });
  }

  /** At most one execution per requestId; repeats get the same result. */
  private once<T extends CommandResult>(requestId: string, run: () => Promise<T>): Promise<T> {
    const prior = this.results.get(requestId);
    if (prior !== undefined) return prior as Promise<T>;
    const promise = run().catch((error: unknown) => this.commandError(requestId, error) as T);
    this.results.set(requestId, promise);
    // A failure with no backend effect may be retried with the same id.
    void promise.then((r) => {
      if (r.stage === "failed" && !/may have|uncertain/i.test(r.message ?? "")) this.results.delete(requestId);
    });
    return promise;
  }

  private precheck(capability: "sendPrompt" | "respondToApproval" | "interrupt", ref: SessionRef, requestId: string): CommandResult | null {
    const cap = this.caps.snapshot()[capability];
    if (!cap.supported) return { requestId, stage: "unsupported", message: cap.reason ?? "unsupported" };
    if (ref.backendId !== BACKEND_ID) return { requestId, stage: "target_unavailable", message: "not a Traycer session" };
    if (this.link.status !== "connected" || this.link.endpoint === null) return { requestId, stage: "failed", message: "Traycer host disconnected" };
    if (ref.hostId !== this.link.endpoint.hostId) return { requestId, stage: "target_unavailable", message: "session belongs to another host" };
    return null;
  }

  private commandError(requestId: string, error: unknown): CommandResult {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof HostRpcError ? error.code : "";
    if (INCOMPATIBLE_CODES.has(code)) return { requestId, stage: "unsupported", message: `host INCOMPATIBLE: ${message}` };
    if (NOT_FOUND.test(`${code} ${message}`)) return { requestId, stage: "target_unavailable", message };
    return { requestId, stage: "failed", message };
  }

  private helper(): TraycerAdapter {
    return new TraycerAdapter(this.link.requireEndpoint(), this.credentials, this.link.clientIdentity, this.link.rpc);
  }

  private call<M extends HostMethod>(method: M, params: HostRequest<M>, options?: { readonly idempotencyKey?: string | null }): Promise<HostResponse<M>> {
    return this.guardRpc(method, () => this.link.rpc.call(method, params, options));
  }

  /** Runs an RPC; INCOMPATIBLE removes the dependent capability, transport errors re-verify the endpoint. */
  private async guardRpc<T>(method: string, run: () => Promise<T>): Promise<T> {
    if (this.link.status !== "connected") throw new Error("Traycer host disconnected");
    try {
      return await run();
    } catch (error) {
      if (error instanceof HostRpcError && INCOMPATIBLE_CODES.has(error.code)) {
        const lost = this.caps.loseMethod(method, error.message);
        if (lost.length > 0) this.emit({ type: "connection", state: "degraded", reason: `${method} INCOMPATIBLE` });
      } else {
        // Cheap: re-reads pid.json and only drops the link if the host moved or died.
        void this.link.verify();
      }
      throw error;
    }
  }

  /**
   * Reads one task's agents into the book. `track` (default) adds the task to the fallback poller's set; the full scan
   * does not, so the poller's cost stays that of the quick scan.
   */
  private async loadAgents(epicId: string, announce: boolean, opts: { track?: boolean; requireSnapshot?: boolean } = {}): Promise<boolean> {
    const hostId = this.link.requireEndpoint().hostId;
    const agents = await this.guardRpc("epic.listChatRecords", () => this.helper().listAgents(epicId, opts.requireSnapshot ?? false));
    const kept = agents.filter((a) => (this.config.includeArchived || !a.archived) && (a.hostId === null || a.hostId === hostId));
    if (opts.track !== false) this.scannedEpics.add(epicId);
    return this.book.setAgents(epicId, kept, announce);
  }

  private async resolveAgent(ref: SessionRef): Promise<NormalizedAgent | null> {
    const known = this.book.agent(ref.taskId, ref.sessionId);
    if (known !== undefined) return known;
    try {
      if (this.book.task(ref.taskId) === undefined) await this.listTasks();
      if (this.book.task(ref.taskId) === undefined) return null;
      await this.loadAgents(ref.taskId, true);
    } catch {
      return null;
    }
    return this.book.agent(ref.taskId, ref.sessionId) ?? null;
  }

  private async channel(epicId: string, chatId: string): Promise<ChatChannel> {
    const key = `${epicId}/${chatId}`;
    const existing = this.channels.get(key);
    if (existing !== undefined && !existing.closed) return existing;
    const client = await this.link.streams();
    const channel = new ChatChannel(
      client,
      epicId,
      chatId,
      (ch) => {
        this.approvals.applyChannel(ch);
        this.book.applyChannel(ch, !ch.closed);
        if (ch.closed && this.channels.get(key) === ch) this.channels.delete(key);
      },
      (ch, event) => {
        if (event.status === "closed" && event.reason?.kind === "fatalError") {
          const code = event.reason.details.code;
          if (INCOMPATIBLE_CODES.has(code)) {
            this.caps.loseMethod("chat.subscribe", event.reason.details.reason);
            this.emit({ type: "connection", state: "degraded", reason: "chat.subscribe INCOMPATIBLE" });
          }
          void ch;
        }
      },
      () => this.config.now(),
    );
    channel.onClose(() => {
      this.book.applyChannel(channel, false);
      if (this.channels.get(key) === channel) this.channels.delete(key);
    });
    this.channels.set(key, channel);
    return channel;
  }

  private onRecord(event: { kind: "upsert"; agent: NormalizedAgent } | { kind: "remove"; epicId: string; agentId: string; reason: string }): void {
    if (event.kind === "remove") {
      this.book.removeAgent(event.epicId, event.agentId);
      if (event.reason === "deleted" && this.book.agentsOf(event.epicId).length === 0) this.scheduleTaskRefresh();
      return;
    }
    const { agent } = event;
    const hostId = this.link.endpoint?.hostId;
    if (agent.archived && !this.config.includeArchived) {
      this.book.removeAgent(agent.epicId, agent.agentId);
      return;
    }
    if (agent.hostId !== null && hostId !== undefined && agent.hostId !== hostId) return;
    if (this.book.task(agent.epicId) === undefined) {
      this.scheduleTaskRefresh(() => this.book.putAgent(agent, true));
      return;
    }
    this.book.putAgent(agent, true);
    if (agent.surface === "gui" && agent.model === null) void this.fillRunSettings(agent);
  }

  private async fillRunSettings(agent: NormalizedAgent): Promise<void> {
    try {
      const settings = await this.helper().chatRunSettings(agent.epicId, [agent.agentId]);
      const value = settings.get(agent.agentId);
      if (value == null) return;
      this.book.putAgent({ ...agent, harnessId: value.harnessId, model: value.model, reasoningEffort: value.reasoningEffort ?? null }, true);
    } catch {
      // Provider stays as derived from the record's harness summary.
    }
  }

  private readonly afterTaskRefresh: Array<() => void> = [];

  private scheduleTaskRefresh(after?: () => void): void {
    if (after !== undefined) this.afterTaskRefresh.push(after);
    if (this.taskRefreshTimer !== null) return;
    this.taskRefreshTimer = setTimeout(() => {
      this.taskRefreshTimer = null;
      const callbacks = this.afterTaskRefresh.splice(0);
      this.listTasks()
        .then(() => {
          for (const cb of callbacks) cb();
        })
        .catch(() => undefined);
    }, 50);
  }

  private async findNewTask(taskId: string, request: CreateTaskRequest): Promise<Task> {
    if (this.link.status === "connected") {
      try {
        await this.listTasks();
        const found = this.book.task(taskId);
        if (found !== undefined) return this.book.toTask(found);
      } catch {
        // fall through to the request's own identity
      }
    }
    return { ref: { ...request.project, taskId }, title: request.title, updatedAt: this.config.now() };
  }

  private toApprovalRequest(entry: ApprovalEntry): ApprovalRequest | null {
    const session = this.book.session(entry.epicId, entry.chatId);
    const task = this.book.task(entry.epicId);
    const hostId = this.link.endpoint?.hostId;
    if (task === undefined || hostId === undefined) return null;
    const ref = session?.ref ?? sessionRefOf({ backendId: BACKEND_ID, hostId, projectId: projectIdOf(task, hostId), taskId: entry.epicId }, entry.chatId);
    return { id: entry.approvalId, sessionRef: ref, summary: entry.summary, createdAt: entry.createdAt };
  }

  private startFeeds(): void {
    this.link.streams().then(
      (client) => {
        if (this.wanted && !this.feeds.running) this.feeds.start(client);
      },
      (error: unknown) => this.emit({ type: "connection", state: "degraded", reason: `event feeds not started: ${errorText(error)}` }),
    );
  }

  private restartDeadFeeds(): void {
    const names: FeedName[] = ["agent.activity.subscribe", "host.chatRecords.subscribe", "host.notifications.subscribe"];
    if (!names.some((n) => this.feeds.dead(n))) return;
    this.feeds.stop();
    this.link.streams().then(
      (client) => {
        if (this.wanted) this.feeds.start(client);
      },
      (error: unknown) => this.emit({ type: "connection", state: "degraded", reason: `event feeds not restarted: ${errorText(error)}` }),
    );
  }

  private updatePolling(): void {
    const needPoll = this.feeds.dead("host.chatRecords.subscribe") || this.feeds.dead("agent.activity.subscribe");
    if (needPoll && this.wanted) this.poller.start();
    else this.poller.stop();
  }

  private async pollOnce(): Promise<boolean> {
    if (this.link.status !== "connected") return false;
    let changed = false;
    for (const epicId of this.scannedEpics) {
      if (await this.loadAgents(epicId, true)) changed = true;
    }
    return changed;
  }

  /** Bounded wait for the first activity state frame (observed idle/working instead of unknown). */
  private waitForFirstActivity(): Promise<void> {
    const wait = this.config.firstActivityWaitMs;
    if (wait <= 0 || !this.feeds.running || this.feeds.dead("agent.activity.subscribe")) return Promise.resolve();
    return Promise.race([this.activityReady, sleep(wait)]);
  }

  private newActivityGate(): Promise<void> {
    return new Promise((resolve) => {
      this.markActivityReady = resolve;
    });
  }

  private newNotificationsGate(): Promise<void> {
    return new Promise((resolve) => {
      this.markNotificationsReady = resolve;
    });
  }
}

/** What counts as a state change of a terminal session (observed and inferred state, no timestamps). */
const terminalStateOf = (session: Session): string => `${session.status.observed.state ?? ""}|${session.status.inferred?.state ?? ""}`;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

