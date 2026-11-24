import { projectKey, sessionKey, taskKey } from "./identity";
import { SlotTable } from "./slots";
import { parseEvent } from "./validate";
import type {
  AgentEvent,
  ApprovalRequest,
  ConnectionState,
  Project,
  Result,
  Session,
  SessionRef,
  Snapshot,
  Task,
} from "./types";

export interface SessionEntry {
  key: string;
  session: Session;
  stale: boolean;
  staleSince?: number;
  slot: number;
}

export type ResolveError = "unknown" | "stale" | "disconnected";
export type SelectionStatus = "none" | "ok" | "stale";

export interface RegistryOptions {
  /** How long a vanished session keeps its slot (marked stale) before pruneStale frees it. */
  staleRetentionMs?: number;
}

const byCreation = (a: Session, b: Session): number =>
  a.createdAt - b.createdAt || (sessionKey(a.ref) < sessionKey(b.ref) ? -1 : 1);

/** Authoritative session state, fed only by adapter snapshots and validated events. */
export class SessionRegistry {
  private entries = new Map<string, SessionEntry>();
  private slots = new SlotTable();
  private taskMap = new Map<string, Task>();
  private projectMap = new Map<string, Project>();
  private approvalMap = new Map<string, ApprovalRequest>();
  private selectedKey: string | null = null;
  private link: ConnectionState = "disconnected";
  /** True from any drop until the next full snapshot: identities are unverified meanwhile. */
  private awaitingSnapshot = true;
  private rev = 0;
  readonly staleRetentionMs: number;

  constructor(opts: RegistryOptions = {}) {
    this.staleRetentionMs = opts.staleRetentionMs ?? 30_000;
  }

  get revision(): number {
    return this.rev;
  }

  connection(): ConnectionState {
    return this.link;
  }

  setConnection(state: ConnectionState): void {
    if (state !== this.link) this.bump(() => this.setLink(state));
  }

  /** Connected and re-enumerated since the last drop; only then may identities be acted on. */
  ready(): boolean {
    return this.link !== "disconnected" && !this.awaitingSnapshot;
  }

  private setLink(state: ConnectionState): void {
    this.link = state;
    if (state === "disconnected") this.awaitingSnapshot = true;
  }

  /** Full re-enumeration. Sessions missing from it become stale but keep their slot. */
  applySnapshot(snap: Snapshot, now: number): void {
    this.bump(() => {
      const seen = new Set<string>();
      for (const s of [...snap.sessions].sort(byCreation)) {
        seen.add(sessionKey(s.ref));
        this.upsert(s);
      }
      for (const [key, e] of this.entries) if (!seen.has(key)) this.markStale(e, now);
      this.taskMap = new Map(snap.tasks.map((t) => [taskKey(t.ref), t]));
      this.projectMap = new Map(snap.projects.map((p) => [projectKey(p), p]));
      this.approvalMap = new Map(
        snap.approvals.filter((a) => this.isLive(sessionKey(a.sessionRef))).map((a) => [a.id, a]),
      );
      this.link = "connected";
      this.awaitingSnapshot = false;
    });
  }

  /** Validates then applies. A rejected event leaves state untouched. */
  applyEvent(input: unknown, now: number): Result<AgentEvent> {
    const parsed = parseEvent(input);
    if (!parsed.ok) return parsed;
    const ev = parsed.value;
    if (ev.type === "approval_requested" && !this.isLive(sessionKey(ev.approval.sessionRef))) {
      return { ok: false, error: "approval for unknown or stale session" };
    }
    this.bump(() => this.dispatch(ev, now));
    return parsed;
  }

  private dispatch(ev: AgentEvent, now: number): void {
    switch (ev.type) {
      case "session_upserted":
        return this.upsert(ev.session);
      case "session_removed": {
        const e = this.entries.get(sessionKey(ev.ref));
        if (e) this.markStale(e, now);
        return;
      }
      case "task_upserted":
        this.taskMap.set(taskKey(ev.task.ref), ev.task);
        return;
      case "task_removed":
        this.taskMap.delete(taskKey(ev.ref));
        return;
      case "approval_requested":
        this.approvalMap.set(ev.approval.id, ev.approval);
        return;
      case "approval_resolved":
        this.approvalMap.delete(ev.approvalId);
        return;
      case "connection":
        this.setLink(ev.state);
        return;
      case "command_progress":
        return; // tracked by the dispatcher, not the registry
    }
  }

  private upsert(session: Session): void {
    const key = sessionKey(session.ref);
    this.slots.assign([key]);
    const slot = this.slots.positionOf(key) ?? -1;
    this.entries.set(key, { key, session, stale: false, slot });
  }

  private markStale(e: SessionEntry, now: number): void {
    if (!e.stale) {
      e.stale = true;
      e.staleSince = now;
    }
    for (const [id, a] of this.approvalMap) if (sessionKey(a.sessionRef) === e.key) this.approvalMap.delete(id);
  }

  /** Frees slots of sessions stale for at least the retention period. Returns freed keys. */
  pruneStale(now: number, force = false): string[] {
    const freed: string[] = [];
    for (const [key, e] of this.entries) {
      if (e.stale && (force || now - (e.staleSince ?? now) >= this.staleRetentionMs)) freed.push(key);
    }
    if (freed.length > 0) {
      this.bump(() => {
        for (const key of freed) {
          this.entries.delete(key);
          this.slots.release(key);
        }
      });
    }
    return freed;
  }

  private isLive(key: string): boolean {
    const e = this.entries.get(key);
    return e !== undefined && !e.stale;
  }

  get(key: string): SessionEntry | undefined {
    return this.entries.get(key);
  }

  /** The only way to turn a ref into an actionable session. */
  resolve(ref: SessionRef): Result<Session, ResolveError> {
    if (!this.ready()) return { ok: false, error: "disconnected" };
    const e = this.entries.get(sessionKey(ref));
    if (!e) return { ok: false, error: "unknown" };
    if (e.stale) return { ok: false, error: "stale" };
    return { ok: true, value: e.session };
  }

  select(key: string): Result<void> {
    if (!this.isLive(key)) return { ok: false, error: "cannot select unknown or stale session" };
    this.bump(() => (this.selectedKey = key));
    return { ok: true, value: undefined };
  }

  clearSelection(): void {
    this.bump(() => (this.selectedKey = null));
  }

  selection(): { key: string | null; status: SelectionStatus } {
    if (this.selectedKey === null) return { key: null, status: "none" };
    return { key: this.selectedKey, status: this.isLive(this.selectedKey) ? "ok" : "stale" };
  }

  /** Entries in slot order (deterministic). */
  sessions(): SessionEntry[] {
    return this.slots
      .keys()
      .flatMap((k) => (k === null ? [] : [this.entries.get(k)].filter((e): e is SessionEntry => e !== undefined)));
  }

  slotKeys(): readonly (string | null)[] {
    return this.slots.keys();
  }

  pageKeys(page: number): (string | null)[] {
    return this.slots.page(page);
  }

  pageCount(): number {
    return this.slots.pageCount();
  }

  projects(): Project[] {
    return [...this.projectMap.values()].sort((a, b) => a.name.localeCompare(b.name) || (projectKey(a) < projectKey(b) ? -1 : 1));
  }

  tasks(projectId?: string): Task[] {
    return [...this.taskMap.values()]
      .filter((t) => projectId === undefined || t.ref.projectId === projectId)
      .sort((a, b) => a.title.localeCompare(b.title) || (taskKey(a.ref) < taskKey(b.ref) ? -1 : 1));
  }

  task(key: string): Task | undefined {
    return this.taskMap.get(key);
  }

  approvals(): ApprovalRequest[] {
    return [...this.approvalMap.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  }

  approval(id: string): ApprovalRequest | undefined {
    return this.approvalMap.get(id);
  }

  approvalsFor(key: string): ApprovalRequest[] {
    return this.approvals().filter((a) => sessionKey(a.sessionRef) === key);
  }

  private bump(fn: () => void): void {
    fn();
    this.rev++;
  }
}
