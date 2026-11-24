import type { CannedEntry } from "../src/canned";
import type { Timers } from "../src/composer";
import { AgentConsole, type ReadAloudPort } from "../src/console";
import { relayout } from "../src/context";
import type { Scope } from "../src/copy";
import { fixturePath, loadFixture } from "../src/fixtures";
import { MockAdapter, type MockOptions } from "../src/mock-adapter";
import { observedStatus } from "../src/status";
import type { NormalizedState, Session, SessionRef } from "../src/types";

export class FakeTimers implements Timers {
  private tasks = new Map<number, { at: number; fn: () => void }>();
  private id = 0;
  now = 0;
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.id;
    this.tasks.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.tasks.delete(h as number);
  }
  advance(ms: number): void {
    this.now += ms;
    for (const [id, t] of [...this.tasks].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= this.now) {
        this.tasks.delete(id);
        t.fn();
      }
    }
  }
  get pending(): number {
    return this.tasks.size;
  }
}

export function ref(sessionId: string, taskId = "t1", projectId = "p1"): SessionRef {
  return { backendId: "b", hostId: "h", projectId, taskId, sessionId };
}

export function session(sessionId: string, state: NormalizedState | null = "idle", createdAt = 1, taskId = "t1"): Session {
  return {
    ref: ref(sessionId, taskId),
    title: sessionId,
    provider: "claude",
    runtime: "chat",
    workspace: "/w",
    createdAt,
    status: observedStatus(state, createdAt, { raw: state }),
  };
}

export const snapshot = (sessions: Session[]) => ({ projects: [], tasks: [], sessions, approvals: [] });

export function mockFrom(name: string, opts?: MockOptions): MockAdapter {
  return new MockAdapter(loadFixture(fixturePath(name)), opts);
}

/** How long tests hold REC for a recording: past REC_TAP_MS (350), so the up edge stops and transcribes (a hold). */
export const REC_HOLD = 400;

export interface Rig {
  adapter: MockAdapter;
  console: AgentConsole;
  timers: FakeTimers;
  ids: string[];
}

/** Fixture sessions are created around 1.8e12; the rig clock starts 100 s later, so they are all recent. */
export const RIG_EPOCH = 1_800_000_100_000;

export async function rig(
  name = "mixed",
  opts?: MockOptions & { ackTimeoutMs?: number; scope?: Scope; pins?: string[]; canned?: CannedEntry[]; onCannedChanged?: (c: CannedEntry[]) => void; readAloud?: ReadAloudPort },
): Promise<Rig> {
  const adapter = mockFrom(name, opts);
  const timers = new FakeTimers();
  const ids: string[] = [];
  let n = 0;
  const c = new AgentConsole({
    adapter,
    timers,
    now: () => RIG_EPOCH + timers.now,
    pins: opts?.pins,
    canned: opts?.canned,
    onCannedChanged: opts?.onCannedChanged,
    ...(opts?.readAloud ? { readAloud: opts.readAloud } : {}),
    ackTimeoutMs: opts?.ackTimeoutMs ?? 5000,
    newRequestId: () => {
      const id = `req-${++n}`;
      ids.push(id);
      return id;
    },
  });
  await c.start();
  if (opts?.scope && opts.scope !== "active") c.state = relayout({ ...c.state, scope: opts.scope }, c.world(), "sessions");
  return { adapter, console: c, timers, ids };
}

export const keyOf = (r: Rig, sessionId: string): string => {
  const e = r.console.registry.sessions().find((x) => x.session.ref.sessionId === sessionId);
  if (!e) throw new Error(`no session ${sessionId}`);
  return e.key;
};

/** Key index (0-26) of a session in the frozen sessions layout (its page is not checked). */
export const slotOf = (r: Rig, sessionId: string): number => {
  const i = r.console.state.layouts.sessions.slots.indexOf(keyOf(r, sessionId));
  if (i < 0) throw new Error(`${sessionId} is not in the sessions layout`);
  return i % 27;
};

export const refOf = (r: Rig, sessionId: string): SessionRef => {
  const e = r.console.registry.get(keyOf(r, sessionId));
  if (!e) throw new Error("missing");
  return e.session.ref;
};
