// Shared state for one smoke run: the guarded live adapter, a timed event log, transcript reads and evidence files.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { effectiveState, type AgentEvent, type NormalizedState, type Session, type SessionRef } from "@fm1/agent-core";
import { TraycerAdapter, TraycerAgentAdapter, type TraycerAgentAdapterConfig } from "@fm1/agent-adapter-traycer";
import { Allowlist } from "./allowlist";
import { GuardedAdapter } from "./guard";
import type { Versions } from "./record";
import { transcriptText } from "./transcript";

export const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
export const STRIPPED = ["TRAYCER_AGENT_ID", "TRAYCER_EPIC_ID", "TRAYCER_TERMINAL_SPAWN_TOKEN"] as const;

export function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !(STRIPPED as readonly string[]).includes(k)) env[k] = v;
  return env;
}

export interface TimedEvent {
  t: number;
  event: AgentEvent;
}

export interface TimelineEntry {
  t: number;
  type: string;
  state?: string;
  stage?: string;
  detail?: string;
}

export interface Disposable {
  epicId: string;
  claude: Session;
  codex: Session;
}

export class SmokeContext {
  readonly events: TimedEvent[] = [];
  readonly adapter: GuardedAdapter;
  readonly raw: TraycerAgentAdapter;
  readonly allowlist: Allowlist;
  /** TUI prompts go out as the receiver itself (`--a2a-self`, operator decision 2026-11-18 option B), not the allowlist's sender. */
  readonly a2aSelf: boolean;
  versions: Versions = { cli: "?", host: "?" };
  private helperP: Promise<TraycerAdapter> | null = null;
  private readonly waiters = new Set<() => void>();

  constructor(
    readonly live: boolean,
    readonly evidenceDir: string,
    config: TraycerAgentAdapterConfig = {},
    allowlistPath = join(REPO_ROOT, "reports", "disposable-allowlist.json"),
  ) {
    for (const k of STRIPPED) delete process.env[k];
    this.allowlist = Allowlist.load(allowlistPath);
    // TUI prompts (Traycer a2a) go out only as an allowlisted sender named in the allowlist (`a2aSenderId`).
    // `tuiRoute: "a2a"` keeps TUI-A2A testing the a2a route; the typing route has its own smoke (src/tui-typing.ts).
    this.raw = new TraycerAgentAdapter({ sessionScanLimit: 25, a2aSender: this.allowlist.a2aSenders(), tuiRoute: "a2a", ...config });
    this.a2aSelf = config.a2aSelfSend === true && Array.isArray(config.a2aSender) && config.a2aSender.length === 0;
    this.adapter = new GuardedAdapter(this.raw, this.allowlist, live);
    this.raw.subscribe((event) => {
      this.events.push({ t: performance.now(), event });
      for (const w of [...this.waiters]) w();
    });
    mkdirSync(evidenceDir, { recursive: true });
  }

  async start(): Promise<void> {
    await this.adapter.connect();
    this.versions = { cli: await cliVersion(), host: this.raw.diagnostics().endpoint?.version ?? "?" };
  }

  async stop(): Promise<void> {
    await this.adapter.disconnect();
    if (this.helperP) (await this.helperP).close();
  }

  /** The guarded adapter for an AgentConsole that must not close the shared connection on stop(). */
  shared(): GuardedAdapter {
    return new Proxy(this.adapter, {
      get(target, prop) {
        if (prop === "disconnect") return async () => undefined;
        const v: unknown = Reflect.get(target, prop, target);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  }

  /** Read-only RPC helper (transcripts). Separate socket; never used for state changes. */
  private helper(): Promise<TraycerAdapter> {
    this.helperP ??= TraycerAdapter.connect();
    return this.helperP;
  }

  async transcript(ref: Pick<SessionRef, "taskId" | "sessionId">): Promise<string> {
    return transcriptText(await (await this.helper()).getTranscript(ref.taskId, ref.sessionId));
  }

  /** The disposable task's claude and codex chats, as the adapter lists them. */
  async disposable(): Promise<Disposable> {
    const task = this.allowlist.all()[0];
    if (!task) throw new Error("allowlist is empty");
    const sessions = (await this.adapter.listSessions(task.epicId)).filter((s) => task.chatIds.includes(s.ref.sessionId));
    const pick = (p: string): Session => {
      const s = sessions.find((x) => x.provider === p && x.runtime === "chat");
      if (!s) throw new Error(`no allowlisted ${p} chat in ${task.epicId}`);
      return s;
    };
    return { epicId: task.epicId, claude: pick("claude"), codex: pick("codex") };
  }

  /** Resolves with the first event (from index `from`) matching `pred`, or null on timeout. */
  waitEvent(pred: (e: AgentEvent) => boolean, timeoutMs: number, from = 0): Promise<TimedEvent | null> {
    const find = (): TimedEvent | undefined => this.events.slice(from).find((x) => pred(x.event));
    const hit = find();
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => {
      const done = (v: TimedEvent | null): void => {
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(v);
      };
      const check = (): void => {
        const h = find();
        if (h) done(h);
      };
      const timer = setTimeout(() => done(null), timeoutMs);
      this.waiters.add(check);
    });
  }

  waitState(ref: SessionRef, states: readonly NormalizedState[], timeoutMs: number, from = 0): Promise<TimedEvent | null> {
    return this.waitEvent((e) => e.type === "session_upserted" && sameChat(e.session.ref, ref) && states.includes(effectiveState(e.session.status)), timeoutMs, from);
  }

  waitProgress(requestId: string, stages: readonly string[], timeoutMs: number, from = 0): Promise<TimedEvent | null> {
    return this.waitEvent((e) => e.type === "command_progress" && e.requestId === requestId && stages.includes(e.stage), timeoutMs, from);
  }

  writeEvidence(name: string, data: unknown): string {
    const path = join(this.evidenceDir, name);
    writeFileSync(path, typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`);
    return path.replace(`${REPO_ROOT}/`, "");
  }

  /** Session events for one chat since index `from`, for evidence files. */
  timeline(ref: SessionRef, from = 0, t0 = 0): TimelineEntry[] {
    return this.events.slice(from).flatMap(({ t, event: e }): TimelineEntry[] => {
      if (e.type === "session_upserted" && sameChat(e.session.ref, ref)) {
        return [{ t: Math.round(t - t0), type: e.type, state: effectiveState(e.session.status), detail: e.session.status.observed.detail ?? "" }];
      }
      if (e.type === "command_progress") return [{ t: Math.round(t - t0), type: e.type, stage: e.stage, detail: `${e.requestId}${e.message ? ` ${e.message}` : ""}` }];
      if (e.type === "approval_requested" && sameChat(e.approval.sessionRef, ref)) return [{ t: Math.round(t - t0), type: e.type, detail: e.approval.id }];
      if (e.type === "approval_resolved") return [{ t: Math.round(t - t0), type: e.type, detail: e.approvalId }];
      if (e.type === "connection") return [{ t: Math.round(t - t0), type: e.type, state: e.state, detail: e.reason ?? "" }];
      return [];
    });
  }
}

export const sameChat = (a: Pick<SessionRef, "taskId" | "sessionId">, b: Pick<SessionRef, "taskId" | "sessionId">): boolean =>
  a.taskId === b.taskId && a.sessionId === b.sessionId;

export async function cliVersion(): Promise<string> {
  try {
    const p = Bun.spawn(["traycer", "--version"], { env: cleanEnv(), stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(p.stdout).text()).trim();
    return (await p.exited) === 0 ? out : "?";
  } catch {
    return "?";
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
