import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relayout, initialController, type ControllerState, type World } from "../src/context";
import { allSupported } from "../src/capabilities";
import { initialComposer } from "../src/composer-state";
import { compareFocus, FocusLayout, rank, RECENT_WINDOW_MS, RESULT_WINDOW_MS, scopeMembers, tierOf, todoItems } from "../src/focus";
import { sessionKey } from "../src/identity";
import { Inbox } from "../src/inbox";
import { SessionRegistry } from "../src/registry";
import { observedStatus } from "../src/status";
import type { ApprovalRequest, NormalizedState, Project, Session, Task } from "../src/types";

const NOW = 1_800_000_000_000;
const H = 3_600_000;

function mk(id: string, state: NormalizedState | null, ageMs: number, opts: { task?: string; project?: string; inferred?: NormalizedState } = {}): Session {
  const project = opts.project ?? "p1";
  const s: Session = {
    ref: { backendId: "b", hostId: "h", projectId: project, taskId: opts.task ?? "t1", sessionId: id },
    title: `session ${id}`,
    provider: "claude",
    runtime: "chat",
    workspace: "/w",
    createdAt: NOW - ageMs - 1000,
    lastActivityAt: NOW - ageMs,
    status: observedStatus(state, NOW, null),
  };
  if (opts.inferred) s.status.inferred = { state: opts.inferred, reason: "test" };
  return s;
}

function worldOf(sessions: Session[], approvals: ApprovalRequest[] = [], tasks: Task[] = [], projects: Project[] = []): World {
  const registry = new SessionRegistry();
  registry.applySnapshot({ projects, tasks, sessions, approvals }, NOW);
  const inbox = new Inbox();
  inbox.sync(registry, NOW);
  return { registry, inbox, composer: initialComposer, capabilities: allSupported(), now: NOW };
}

const tier = (w: World, id: string): number => {
  const e = w.registry.sessions().find((x) => x.session.ref.sessionId === id);
  if (!e) throw new Error(id);
  return tierOf(e, w.inbox, w.now, w.registry);
};

describe("tiers (section 3.2)", () => {
  test("every rule and window edge", () => {
    const w = worldOf([
      mk("appr", "approval_required", 50 * H),
      mk("q", "waiting_input", 500 * H),
      mk("f-in", "failed", RESULT_WINDOW_MS),
      mk("f-out", "failed", RESULT_WINDOW_MS + 1),
      mk("c-in", "completed_unread", RESULT_WINDOW_MS - 1),
      mk("c-out", "completed_unread", RESULT_WINDOW_MS + 1),
      mk("work", "working", 900 * H),
      mk("idle-in", "idle", RECENT_WINDOW_MS),
      mk("idle-out", "idle", RECENT_WINDOW_MS + 1),
      mk("read-in", "completed_read", 1 * H),
      mk("unk-in", null, 1 * H),
      mk("off-out", "disconnected", 9 * H),
      mk("guess", null, 2 * H, { inferred: "working" }),
    ]);
    expect(
      ["appr", "q", "f-in", "f-out", "c-in", "c-out", "work", "idle-in", "idle-out", "read-in", "unk-in", "off-out", "guess"].map((id) => tier(w, id)),
    ).toEqual([0, 1, 2, 6, 3, 6, 4, 5, 7, 5, 5, 7, 4]);
  });

  test("a pending approval request makes T0 even if the state lags", () => {
    const s = mk("a", "working", 1 * H);
    const w = worldOf([s], [{ id: "ap", sessionRef: s.ref, summary: "rm", createdAt: NOW - 10 }]);
    expect(tier(w, "a")).toBe(0);
  });

  test("a dismissed result drops to T5/T7; a read result is not T3", () => {
    const w = worldOf([mk("f", "failed", 1 * H), mk("c", "completed_unread", 10 * H)]);
    const f = w.inbox.items().find((i) => i.kind === "failure");
    const c = w.inbox.items().find((i) => i.kind === "completed");
    w.inbox.dismiss(f?.id ?? "");
    w.inbox.markRead(c?.id ?? "");
    expect(tier(w, "f")).toBe(5);
    expect(tier(w, "c")).toBe(7);
  });

  test("within-tier order: T0 oldest request first, results newest first, ties by sessionKey", () => {
    const a = mk("a", "approval_required", 1 * H);
    const b = mk("b", "approval_required", 1 * H);
    const w = worldOf(
      [a, b, mk("f1", "failed", 5 * H), mk("f2", "failed", 1 * H), mk("t1", "working", 2 * H), mk("t2", "working", 2 * H)],
      [
        { id: "x", sessionRef: a.ref, summary: "", createdAt: NOW - 100 },
        { id: "y", sessionRef: b.ref, summary: "", createdAt: NOW - 200 },
      ],
    );
    const order = w.registry.sessions().map((e) => rank(e, w)).sort(compareFocus).map((r) => r.key.split("/").at(-1));
    expect(order).toEqual(["b", "a", "f2", "f1", "t1", "t2"]);
  });
});

interface Stats {
  tiers: { scan25: { recent8h: { byTier: number[]; todo: number; glo: number; live: number; recent: number; all: number } } };
  companionDefaultScan: { sessions: number; byState: Record<string, number> };
}

/** A 279-session set with the measured mix of reports/evidence/ux-v2/session-stats.json (synthetic ids). */
function measured279(): { world: World; stats: Stats } {
  const stats = JSON.parse(readFileSync(fileURLToPath(new URL("../../../reports/evidence/ux-v2/session-stats.json", import.meta.url)), "utf8")) as Stats;
  const by = stats.tiers.scan25.recent8h.byTier;
  const st = stats.companionDefaultScan.byState;
  const sessions: Session[] = [];
  let n = 0;
  const add = (count: number, state: NormalizedState | null, age: (i: number) => number) => {
    for (let i = 0; i < count; i++, n++) {
      const t = `t${n % 25}`;
      sessions.push(mk(`s${String(n).padStart(3, "0")}`, state, age(i), { task: t, project: `p${n % 25 < 20 ? 0 : (n % 5) + 1}` }));
    }
  };
  add(by[2] ?? 0, "failed", (i) => (i + 1) * H);
  add(by[3] ?? 0, "completed_unread", (i) => (i + 2) * H);
  add(by[4] ?? 0, "working", (i) => (i + 1) * H);
  add(by[5] ?? 0, "idle", (i) => (i * 7 + 5) * 60_000);
  const oldFailed = (st.failed ?? 0) - (by[2] ?? 0);
  add(oldFailed, "failed", (i) => (100 + i) * H);
  add((by[6] ?? 0) - oldFailed, "completed_unread", (i) => (200 + i) * H);
  const idleOld = (st.idle ?? 0) - (by[5] ?? 0);
  add(idleOld, "idle", (i) => (24 + i) * H);
  add(st.unknown ?? 0, null, (i) => (800 + i) * H);
  add(st.completed_read ?? 0, "completed_read", (i) => (30 + i) * H);
  const tasks: Task[] = Array.from({ length: 25 }, (_, i) => ({
    ref: { backendId: "b", hostId: "h", projectId: `p${i < 20 ? 0 : (i % 5) + 1}`, taskId: `t${i}` },
    title: `task ${i}`,
    updatedAt: NOW,
  }));
  return { world: worldOf(sessions, [], tasks), stats };
}

describe("the measured 279-session mix", () => {
  test("ACTIVE 20 / RECENT 42 / ALL 279; TO DO 33 with a badge of 16", () => {
    const { world: w, stats } = measured279();
    const expected = stats.tiers.scan25.recent8h;
    expect(w.registry.sessions()).toHaveLength(279);
    const count = (scope: "active" | "recent" | "all") => scopeMembers({ scope, repoFilter: null, taskFilter: null }, w).length;
    expect([count("active"), count("recent"), count("all")]).toEqual([20, 42, 279]);
    expect([expected.live, expected.recent, expected.all]).toEqual([20, 42, 279]);
    expect(todoItems(w)).toHaveLength(expected.glo);
    expect(w.inbox.attentionCount(NOW)).toBe(expected.todo);
    expect(w.inbox.attentionCount(NOW)).toBe(16);
  });

  test("ACTIVE fits page 1 with every result of the last 3 days; RECENT is 2 pages; ALL is 11", () => {
    const { world: w } = measured279();
    const base: ControllerState = { ...initialController };
    const active = relayout(base, w, "sessions");
    const l = new FocusLayout(active.layouts.sessions);
    expect(l.pageCount()).toBe(1);
    expect(l.page(0).filter((k) => k !== null)).toHaveLength(20);
    expect(new FocusLayout(relayout({ ...base, scope: "recent" }, w, "sessions").layouts.sessions).pageCount()).toBe(2);
    expect(new FocusLayout(relayout({ ...base, scope: "all" }, w, "sessions").layouts.sessions).pageCount()).toBe(11);
    const tiers = l.page(0).flatMap((k) => (k === null ? [] : [rank(w.registry.get(k)!, w).tier]));
    expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
    expect(tiers.filter((t) => t === 2 || t === 3)).toHaveLength(16);
  });
});

describe("FocusLayout (section 3.4)", () => {
  const keys = (n: number, p = "k") => Array.from({ length: n }, (_, i) => `${p}${String(i).padStart(2, "0")}`);

  test("the pin block first (limited by the controller, section 9.6), keys 24-26 empty after relayout, later pages 27 keys each", () => {
    const l = new FocusLayout().relayout(keys(60), ["k50", "k51", "k52", "k53", "k54", "k55", "k56"]);
    const p1 = l.page(0);
    expect(p1.slice(0, 7)).toEqual(["k50", "k51", "k52", "k53", "k54", "k55", "k56"]);
    expect(p1.slice(7, 9)).toEqual(["k00", "k01"]);
    expect(p1.slice(24)).toEqual([null, null, null]);
    expect(l.page(1).every((k) => k !== null)).toBe(true);
    expect(l.pageCount()).toBe(3);
    expect(new Set(l.keys().filter(Boolean)).size).toBe(60);
  });

  test("an arrival fills 24 -> 26, then pendingNew grows; nothing else moves", () => {
    const l = new FocusLayout().relayout(keys(40));
    const before = [...l.keys()];
    expect(l.place(["n1", "n2"])).toEqual(["n1", "n2"]);
    expect(l.page(0).slice(24)).toEqual(["n1", "n2", null]);
    l.place(["n3", "n4", "n5"]);
    expect(l.page(0).slice(24)).toEqual(["n1", "n2", "n3"]);
    expect(l.pendingNew).toBe(2);
    expect(l.keys().filter((k, i) => i < 24 || i >= 27)).toEqual(before.filter((k, i) => i < 24 || i >= 27));
    l.place(["n1"]);
    expect(l.pendingNew).toBe(2);
  });

  test("a short list leaves its free keys (reserved ones included) for arrivals", () => {
    const l = new FocusLayout().relayout(keys(20));
    l.place(keys(8, "n"));
    expect(l.page(0).slice(20)).toEqual(["n00", "n01", "n02", "n03", "n04", "n05", "n06"]);
    expect(l.pendingNew).toBe(1);
  });

  test("a page-2 item that starts needing attention moves to a free key of page 1", () => {
    const l = new FocusLayout().relayout(keys(40));
    expect(l.promote("k30")).toBe(true);
    expect(l.indexOf("k30")).toBe(24);
    expect(l.page(1)).not.toContain("k30");
  });

  test("paging never re-sorts", () => {
    const l = new FocusLayout().relayout(keys(60));
    const snap = JSON.stringify(l.data());
    l.page(1);
    l.page(2);
    l.pageCount();
    expect(JSON.stringify(l.data())).toBe(snap);
  });
});

describe("arrivals between re-sorts (console)", () => {
  test("a session that becomes T0-T3 takes a free key; a state change never moves a key", async () => {
    const { rig } = await import("./helpers");
    const r = await rig("forty", { scope: "all" });
    const before = [...r.console.state.layouts.sessions.slots];
    const idle = r.console.registry.sessions().find((e) => e.session.status.observed.state === "idle" && before.indexOf(e.key) >= 27);
    if (!idle) throw new Error("fixture has no page-2 idle session");
    r.adapter.setState(idle.session.ref, "failed");
    const after = r.console.state.layouts.sessions.slots;
    expect(after.indexOf(idle.key)).toBe(24);
    for (let i = 0; i < 24; i++) expect(after[i]).toBe(before[i] ?? null);
    const pinned = r.console.registry.sessions().find((e) => before.indexOf(e.key) === 3);
    r.adapter.setState(pinned!.session.ref, "working");
    expect(r.console.state.layouts.sessions.slots.indexOf(pinned!.key)).toBe(3);
  });

  test("when the free keys are full the title shows +N new and HOME places them", async () => {
    const { rig, RIG_EPOCH } = await import("./helpers");
    const r = await rig("forty", { scope: "all" });
    const page2 = r.console.state.layouts.sessions.slots.slice(27).filter((k): k is string => k !== null);
    const quiet = page2.filter((k) => {
      const st = r.console.registry.get(k)?.session.status.observed.state;
      return st === "idle" || st === "working" || st === "completed_read";
    });
    for (const k of quiet.slice(0, 5)) r.adapter.setState(r.console.registry.get(k)!.session.ref, "waiting_input");
    expect(r.console.view().title).toBe("ALL 40 +2 new");
    await r.console.handleInput({ kind: "button", button: "HOME", edge: "down" });
    expect(r.console.view().title).toBe("ALL 40");
    expect(RIG_EPOCH).toBeGreaterThan(0);
  });

  test("auto re-sort after 60 s without input, only if the order changes", async () => {
    const { rig } = await import("./helpers");
    const r = await rig();
    await r.console.handleInput({ kind: "key", key: 0, gesture: "single" });
    expect(r.console.tick()).toBe(false);
    r.timers.advance(61_000);
    expect(r.console.tick()).toBe(false); // nothing changed
    const fw = r.console.registry.sessions().find((e) => e.session.ref.sessionId === "s-claude-fw")!;
    r.adapter.setState(fw.session.ref, "idle");
    const k = r.console.state.layouts.sessions.slots.indexOf(fw.key);
    expect(k).toBeGreaterThanOrEqual(0);
    r.timers.advance(10_000);
    expect(r.console.tick()).toBe(true);
    expect(r.console.state.layouts.sessions.slots).not.toContain(fw.key);
  });
});

test("sessionKey tie-break keeps the order deterministic", () => {
  const w = worldOf([mk("b", "working", H), mk("a", "working", H)]);
  const a = scopeMembers({ scope: "active", repoFilter: null, taskFilter: null }, w).map((r) => r.key);
  expect(a).toEqual([sessionKey(mk("a", "working", H).ref), sessionKey(mk("b", "working", H).ref)]);
});
