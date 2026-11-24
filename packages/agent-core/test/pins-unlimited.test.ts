// Operator decision 2026-11-19, "no limit" on pins (docs/ux-v2.md section 3.5, docs/ui-v3.md sections 9.6 and 10.4):
// session and task pins counted apart (safety cap 200 each); every layout orders pinned sessions first (operator
// decision 2026-11-22, pins first), then the other sessions that need you (T0-T3), then the rest; task pins only order the SPLIT task row; PINNED / PIN list every pin across
// pages; the frozen layout still holds; pins outside the scan are fetched in bounded batches at a slow rate.
import { describe, expect, test } from "bun:test";
import { AgentConsole, PIN_CATCHUP_MS, PIN_FETCH_TASKS, PIN_REFRESH_MS, pinLists } from "../src/console";
import { fixtureToSnapshot, type FixtureFile } from "../src/fixtures";
import { isAttention, MAX_PINS_PER_KIND, PINNED_GROUP, rank } from "../src/focus";
import { isSessionKey, isTaskKey, parseSessionKey, sessionKey, taskKey } from "../src/identity";
import { MockAdapter } from "../src/mock-adapter";
import { parseSession } from "../src/validate";
import type { PinnedRequest, PinnedResult, Session } from "../src/types";
import { FakeTimers, RIG_EPOCH } from "./helpers";

const B = { backendId: "b", hostId: "h" };
const P = "proj";
const sk = (taskId: string, sessionId: string): string => sessionKey({ ...B, projectId: P, taskId, sessionId });
const tk = (taskId: string): string => taskKey({ ...B, projectId: P, taskId });

type S = FixtureFile["sessions"][number];
const sess = (taskId: string, sessionId: string, state: string | null, ago: number): S => ({
  projectId: P,
  taskId,
  sessionId,
  title: `${sessionId} title`,
  provider: "claude",
  runtime: "chat",
  workspace: "/w",
  createdAt: RIG_EPOCH - ago,
  observed: { state, at: RIG_EPOCH - ago },
});

function parseOk(raw: S): Session {
  const { projectId, taskId, sessionId, observed, inferred, raw: r, ...rest } = raw;
  const p = parseSession({ ...rest, ref: { ...B, projectId, taskId, sessionId }, status: { observed, inferred, raw: r ?? null } });
  if (!p.ok) throw new Error(p.error);
  return p.value;
}

/**
 * 12 tasks of 5 sessions: in each task one session needs you (rotating approval-free T1 waiting / T2 failed / T3 unread),
 * one works (T4), three are idle within 8 h (T5). 60 sessions: 12 need you, 12 working, 36 quiet.
 */
function bigFixture(): FixtureFile {
  const need = ["waiting_input", "failed", "completed_unread"];
  const tasks = Array.from({ length: 12 }, (_, i) => `t${String(i).padStart(2, "0")}`);
  const sessions: S[] = [];
  tasks.forEach((t, i) => {
    sessions.push(sess(t, `${t}-need`, need[i % 3] ?? "failed", 1_000 + i * 100));
    sessions.push(sess(t, `${t}-work`, "working", 2_000 + i * 100));
    for (let j = 0; j < 3; j++) sessions.push(sess(t, `${t}-q${j}`, "idle", 3_000 + i * 100 + j * 10));
  });
  return {
    name: "pins-unlimited",
    ...B,
    projects: [{ projectId: P, name: "console" }],
    tasks: tasks.map((t, i) => ({ projectId: P, taskId: t, title: `Task ${t}`, updatedAt: RIG_EPOCH - 1000 * (i + 1) })),
    sessions,
    approvals: [],
  };
}

const quietKeys = (): string[] => bigFixture().sessions.filter((x) => x.sessionId.includes("-q")).map((x) => sk(x.taskId, x.sessionId));

interface R {
  c: AgentConsole;
  t: FakeTimers;
}

async function rig(opts: { pins?: string[]; proto?: number; layout?: "buddy" | "list" | "grouped"; keys?: "ranked" | "split"; adapter?: MockAdapter } = {}): Promise<R> {
  const a = opts.adapter ?? new MockAdapter(fixtureToSnapshot(bigFixture()));
  const t = new FakeTimers();
  const c = new AgentConsole({
    adapter: a,
    timers: t,
    now: () => RIG_EPOCH + t.now,
    pins: opts.pins,
    layouts: { sessions: opts.layout ?? "buddy" },
    settings: { keys: opts.keys ?? "ranked" },
  });
  await c.start();
  c.setProtocol(opts.proto ?? 6);
  return { c, t };
}

const press = (r: R, button: string) => r.c.handleInput({ kind: "button", button: button as never, edge: "down" });
const turn = (r: R, encoder: string, delta = 1) => r.c.handleInput({ kind: "encoder", encoder: encoder as never, delta });
const key = (r: R, k: number, gesture: "single" | "double" | "long" = "single") => r.c.handleInput({ kind: "key", key: k, gesture });
const layoutKeys = (r: R): string[] => r.c.state.layouts.sessions.slots.filter((k): k is string => k !== null);
const tierOf = (r: R, k: string): number => rank(r.c.registry.get(k)!, r.c.world()).tier;

/** 0 = pinned session, 1 = needs you (not pinned), 2 = the rest: the parts must come in this order, the pins first. */
function expectPinNeedRest(r: R, keys: readonly string[]): void {
  const pins = new Set(r.c.state.pins);
  const part = keys.map((k) => (pins.has(k) ? 0 : isAttention(tierOf(r, k)) ? 1 : 2));
  expect(part).toEqual([...part].sort());
  const n = keys.filter((k) => pins.has(k)).length;
  expect(n).toBeGreaterThan(0);
  expect(keys.slice(0, n).every((k) => pins.has(k))).toBe(true);
  expect(part).toContain(1);
}

describe("pin lists: no limit of 9, two kinds, migration", () => {
  test("a legacy mixed list splits by key shape and keeps every pin; the split form restores the same", () => {
    const legacy = [sk("t00", "a"), tk("t01"), sk("t02", "b"), "junk", tk("t01"), sk("t03", "c")];
    expect(pinLists(legacy)).toEqual({ sessions: [sk("t00", "a"), sk("t02", "b"), sk("t03", "c")], tasks: [tk("t01")] });
    expect(pinLists({ sessions: [sk("t00", "a")], tasks: [tk("t01")] })).toEqual({ sessions: [sk("t00", "a")], tasks: [tk("t01")] });
    const many = Array.from({ length: 250 }, (_, i) => sk("t", `s${i}`));
    const tasks = Array.from({ length: 250 }, (_, i) => tk(`t${i}`));
    const out = pinLists({ sessions: many, tasks });
    expect(out.sessions).toHaveLength(MAX_PINS_PER_KIND);
    expect(out.tasks).toHaveLength(MAX_PINS_PER_KIND);
  });

  test("36 session pins and 12 task pins at once (more than 9 of each), counted apart", async () => {
    const pins = [...quietKeys(), ...Array.from({ length: 12 }, (_, i) => tk(`t${String(i).padStart(2, "0")}`))];
    const r = await rig({ pins });
    expect(r.c.state.pins.filter(isSessionKey)).toHaveLength(36);
    expect(r.c.state.pins.filter(isTaskKey)).toHaveLength(12);
  });
});

describe("pins > need you > rest in every layout path", () => {
  const somePins = (): string[] => quietKeys().filter((_, i) => i % 3 === 0); // 12 quiet session pins

  test("RANKED flat (Buddy/List), every scope: the pins first (whatever SHOW says), then need you, then the rest", async () => {
    const r = await rig({ pins: [...somePins(), tk("t05")] });
    for (const scope of ["active", "recent", "all"]) {
      expect(r.c.state.scope).toBe(scope as never);
      const keys = layoutKeys(r);
      expectPinNeedRest(r, keys);
      for (const p of somePins()) expect(keys).toContain(p);
      // a task pin takes no session key: its quiet sessions stay with the rest (or out of ACTIVE)
      if (scope === "active") expect(keys.filter((k) => k.includes("/t05/") && tierOf(r, k) > 4)).toEqual(somePins().filter((k) => k.includes("/t05/")));
      await turn(r, "K1", 1);
    }
  });

  test("RANKED Grouped: the Pinned group first (with every pinned session), then groups that need you, then the other tasks", async () => {
    const r = await rig({ layout: "grouped", pins: [...somePins(), sk("t03", "t03-need"), tk("t07")] });
    await turn(r, "K1", 1); // RECENT: every session in scope
    const keys = r.c.state.layouts.sessions.slots.filter((k): k is string => k !== null);
    const groups = r.c.state.layouts.sessions.groups ?? {};
    const firstPinned = keys.findIndex((k) => groups[k] === PINNED_GROUP);
    const lastPinned = keys.length - 1 - [...keys].reverse().findIndex((k) => groups[k] === PINNED_GROUP);
    expect(firstPinned).toBe(0);
    // the pinned T1 leaves its task group for the Pinned group, and leads it (focus order inside the group)
    expect(groups[sk("t03", "t03-need")]).toBe(PINNED_GROUP);
    expect(keys[0]).toBe(sk("t03", "t03-need"));
    expect(keys.slice(0, lastPinned + 1).every((k) => groups[k] === PINNED_GROUP)).toBe(true);
    expect(keys.slice(0, lastPinned + 1).sort()).toEqual([...somePins(), sk("t03", "t03-need")].sort());
    // after the Pinned group: the task groups that still hold a session needing you, then t03 (its T1 is in Pinned)
    const after = keys.slice(lastPinned + 1);
    for (const k of after) expect(groups[k]?.startsWith("task:")).toBe(true);
    const firstT03 = after.findIndex((k) => groups[k] === `task:${tk("t03")}`);
    expect(firstT03).toBeGreaterThan(0);
    expect(after.slice(firstT03).every((k) => groups[k] === `task:${tk("t03")}`)).toBe(true);
    expect(after.slice(firstT03).some((k) => isAttention(tierOf(r, k)))).toBe(false);
    const needGroups = new Set(after.slice(0, firstT03).map((k) => groups[k]));
    expect(needGroups.size).toBe(11);
    for (const gid of needGroups) expect(after.some((k) => groups[k] === gid && isAttention(tierOf(r, k)))).toBe(true);
    expect(r.c.view().slots[0]?.head).toMatchObject({ title: "Pinned", pinned: true });
  });

  test("SPLIT ALL (flat and Grouped) and a chosen task: pins, then need you, then the rest; NEEDS YOU is not changed by pins", async () => {
    const pins = [...somePins(), tk("t09")];
    const flat = await rig({ keys: "split", pins });
    expectPinNeedRest(flat, layoutKeys(flat));
    expect(layoutKeys(flat).filter((k) => tierOf(flat, k) > 4).sort()).toEqual([...somePins()].sort()); // ACTIVE + pins
    // the task row: pinned tasks first; a task pin never takes a white key
    expect(flat.c.state.taskRow.keys[0]).toBe(tk("t09"));
    expect(layoutKeys(flat).some(isTaskKey)).toBe(false);
    // a chosen task (t00, slot 2 on the row after the pinned t09)
    const row = flat.c.state.taskRow.keys;
    await key(flat, [8, 10, 13, 15, 17, 20, 22, 25][row.indexOf(tk("t00"))] ?? -1);
    expect(flat.c.state.split).toMatchObject({ chosen: "task", task: tk("t00") });
    expect(layoutKeys(flat)).toEqual([sk("t00", "t00-q0"), sk("t00", "t00-need"), sk("t00", "t00-work")]); // pin, need you, rest
    // NEEDS YOU: the 12 T0-T3 sessions in tier order, nothing else
    await key(flat, 5);
    expect(layoutKeys(flat)).toHaveLength(12);
    expect(layoutKeys(flat).every((k) => isAttention(tierOf(flat, k)))).toBe(true);

    const grouped = await rig({ keys: "split", layout: "grouped", pins });
    const keys = layoutKeys(grouped);
    const groups = grouped.c.state.layouts.sessions.groups ?? {};
    expect(keys.slice(0, somePins().length).every((k) => groups[k] === PINNED_GROUP)).toBe(true);
    expect(keys.filter((k) => groups[k] === PINNED_GROUP).sort()).toEqual([...somePins()].sort());
  });

  test("PINNED (RANKED) and PIN (SPLIT) list every pin across pages, need you first", async () => {
    const all = bigFixture().sessions.map((x) => sk(x.taskId, x.sessionId)); // 60 session pins
    const r = await rig({ pins: [...all, tk("t01")] });
    for (let i = 0; i < 3; i++) await turn(r, "K1", 1); // -> PINNED
    expect(r.c.state.scope).toBe("pinned");
    expect(r.c.view().pages).toBe(3); // 24 + 27 + 9
    const seen: string[] = [];
    for (let p = 0; p < 3; p++) {
      seen.push(...r.c.state.layouts.sessions.slots.slice(p * 27, p * 27 + 27).filter((k): k is string => k !== null));
      await press(r, "OCT_UP");
    }
    expect(seen.sort()).toEqual([...all].sort());
    expect(r.c.view().title).toBe("PINNED 60");
    const keys = layoutKeys(r);
    expect(keys.slice(0, 12).every((k) => isAttention(tierOf(r, k)))).toBe(true);

    const s = await rig({ keys: "split", pins: [...all, tk("t01")] });
    await key(s, 3);
    expect(s.c.state.split.chosen).toBe("pinned");
    expect(s.c.view().pages).toBe(4); // 15 + 16 + 16 + 13
    expect(layoutKeys(s).sort()).toEqual([...all].sort());
    expect(layoutKeys(s).slice(0, 12).every((k) => isAttention(tierOf(s, k)))).toBe(true);
  });
});

describe("the frozen layout still holds with pins", () => {
  test("a pinned session that starts to need you keeps its key until the next re-sort; the re-sort keeps it in the pinned part, first", async () => {
    const pins = quietKeys().slice(0, 20);
    const a = new MockAdapter(fixtureToSnapshot(bigFixture()));
    const r = await rig({ pins, adapter: a });
    const before = [...r.c.state.layouts.sessions.slots];
    const k = pins[10] ?? "";
    const at = before.indexOf(k);
    expect(at).toBeGreaterThan(0);
    expect(before.slice(0, pins.length).sort()).toEqual([...pins].sort()); // the 20 pins come first
    const e = r.c.registry.get(k)!;
    a.upsertSession({ ...e.session, status: { ...e.session.status, observed: { state: "waiting_input", at: RIG_EPOCH + 1 } } });
    expect(r.c.state.layouts.sessions.slots).toEqual(before); // nothing moves between re-sorts
    await press(r, "HOME"); // Sorted
    const after = r.c.state.layouts.sessions.slots;
    expect(after.indexOf(k)).toBe(0); // still in the pinned part; the only pin that needs you leads it (focus order)
    expect(after.slice(0, pins.length).sort()).toEqual([...pins].sort());
    expectPinNeedRest(r, layoutKeys(r));
  });

  test("an arrival takes a free key; pinned keys do not move", async () => {
    const pins = quietKeys().slice(0, 6);
    const a = new MockAdapter(fixtureToSnapshot(bigFixture()));
    const r = await rig({ pins, adapter: a });
    const before = [...r.c.state.layouts.sessions.slots];
    a.upsertSession(parseOk({ ...sess("t00", "t00-new", "failed", 0), createdAt: RIG_EPOCH + 5_000 }));
    const after = r.c.state.layouts.sessions.slots;
    for (const p of pins) expect(after.indexOf(p)).toBe(before.indexOf(p));
    expect(after.indexOf(sk("t00", "t00-new"))).toBeGreaterThanOrEqual(0);
  });
});

/** Answers every requested pin: the session (idle) and the task, so the console can show them. */
class FetchCounter extends MockAdapter {
  calls: PinnedRequest[] = [];
  fail = false;
  gone: string[] = [];
  async fetchPinned(req: PinnedRequest): Promise<PinnedResult> {
    this.calls.push(req);
    if (this.fail) throw new Error("busy");
    const tasks = new Map<string, PinnedResult["tasks"][number]>();
    const sessions: Session[] = [];
    for (const ref of req.sessions) {
      if (this.gone.includes(sessionKey(ref))) continue;
      tasks.set(ref.taskId, { ref: { backendId: ref.backendId, hostId: ref.hostId, projectId: ref.projectId, taskId: ref.taskId }, title: `Far ${ref.taskId}`, updatedAt: RIG_EPOCH - 9_000 });
      sessions.push(parseOk(sess(ref.taskId, ref.sessionId, "idle", 9_000)));
    }
    for (const t of req.tasks) tasks.set(t.taskId, { ref: t, title: `Far ${t.taskId}`, updatedAt: RIG_EPOCH - 9_000 });
    return { sessions, tasks: [...tasks.values()], gone: this.gone.filter((g) => req.sessions.some((r) => sessionKey(r) === g)) };
  }
}

const tasksOf = (req: PinnedRequest): Set<string> => new Set([...req.sessions.map((r) => r.taskId), ...req.tasks.map((t) => t.taskId)]);

describe("pins outside the scan: one bounded batch at a slow rate", () => {
  // 150 session pins spread over 75 far tasks (2 each) plus 30 far task pins: 105 tasks outside the scan.
  const farSessions = Array.from({ length: 150 }, (_, i) => sk(`far${Math.floor(i / 2)}`, `fs${i}`));
  const farTasks = Array.from({ length: 30 }, (_, i) => tk(`farT${i}`));
  const inScan = [sk("t00", "t00-q0"), tk("t01")];

  test("resync: one call, at most 25 tasks, pins inside the scan never asked for; then catch-up batches, then steady", async () => {
    const a = new FetchCounter(fixtureToSnapshot(bigFixture()));
    const r = await rig({ pins: [...inScan, ...farSessions, ...farTasks], adapter: a });
    await r.c.idle();
    // One call per resync (start() resyncs, and the mock's first "connected" event resyncs once more).
    const n0 = a.calls.length;
    expect(n0).toBeLessThanOrEqual(2);
    for (const c of a.calls) {
      expect(tasksOf(c).size).toBeLessThanOrEqual(PIN_FETCH_TASKS);
      expect(c.sessions.map(sessionKey)).not.toContain(inScan[0]);
      expect(c.tasks.map(taskKey)).not.toContain(inScan[1]);
    }
    // catch-up: one batch per PIN_CATCHUP_MS while some far pin was never asked for (105 tasks: 5 batches in all)
    r.c.tick();
    await r.c.idle();
    expect(a.calls).toHaveLength(n0); // not due yet
    for (let i = 0; i < 4; i++) {
      r.t.advance(PIN_CATCHUP_MS);
      r.c.tick();
      await r.c.idle();
    }
    expect(a.calls).toHaveLength(n0 + 4); // 105 tasks: 25 at the resync, then 4 catch-up batches (5 s apart)
    const asked = new Set(a.calls.flatMap((c) => [...c.sessions.map(sessionKey), ...c.tasks.map(taskKey)]));
    expect(asked.size).toBe(180);
    for (const c of a.calls) expect(tasksOf(c).size).toBeLessThanOrEqual(PIN_FETCH_TASKS);
    // every far session pin is now live and listed by PINNED, across pages
    for (let i = 0; i < 3; i++) await turn(r, "K1", 1);
    expect(r.c.state.scope).toBe("pinned");
    expect(layoutKeys(r).filter((k) => k.includes("/far"))).toHaveLength(150);
    // steady: nothing before PIN_REFRESH_MS, then one batch of at most 25 tasks per PIN_REFRESH_MS (round robin)
    r.t.advance(PIN_REFRESH_MS - 1);
    r.c.tick();
    await r.c.idle();
    expect(a.calls).toHaveLength(n0 + 4);
    r.t.advance(1);
    r.c.tick();
    await r.c.idle();
    expect(a.calls).toHaveLength(n0 + 5);
    expect(tasksOf(a.calls.at(-1)!).size).toBe(PIN_FETCH_TASKS);
    const rotation = new Set<string>();
    for (let i = 0; i < 5; i++) {
      for (const t of tasksOf(a.calls.at(-1)!)) rotation.add(t);
      r.t.advance(PIN_REFRESH_MS);
      r.c.tick();
      await r.c.idle();
    }
    expect(rotation.size).toBe(105); // ceil(105 / 25) = 5 rounds cover every far task
    expect(r.c.state.pins).toHaveLength(182); // nothing dropped
  });

  test("a failed batch keeps every pin and waits; only pins Traycer reports gone are dropped", async () => {
    const a = new FetchCounter(fixtureToSnapshot(bigFixture()));
    a.fail = true;
    const r = await rig({ pins: farSessions.slice(0, 10), adapter: a });
    await r.c.idle();
    const n0 = a.calls.length;
    expect(r.c.state.pins).toHaveLength(10);
    expect(r.c.rejectedEvents.some((e) => e.startsWith("fetchPinned failed"))).toBe(true);
    r.c.tick();
    await r.c.idle();
    expect(a.calls).toHaveLength(n0); // no retry storm: the failed tasks count as asked, the steady cadence applies
    r.t.advance(PIN_CATCHUP_MS);
    r.c.tick();
    await r.c.idle();
    expect(a.calls).toHaveLength(n0);
    a.fail = false;
    a.gone = [farSessions[3] ?? ""];
    r.t.advance(PIN_REFRESH_MS);
    r.c.tick();
    await r.c.idle();
    expect(a.calls).toHaveLength(n0 + 1);
    expect(r.c.state.pins).toHaveLength(9);
    expect(r.c.state.pins).not.toContain(farSessions[3]);
  });

  test("no batch while the backend is down or with every pin inside the scan", async () => {
    const a = new FetchCounter(fixtureToSnapshot(bigFixture()));
    const r = await rig({ pins: inScan, adapter: a });
    expect(a.calls).toHaveLength(0);
    r.t.advance(PIN_REFRESH_MS * 3);
    r.c.tick();
    await r.c.idle();
    expect(a.calls).toHaveLength(0);
    const b = new FetchCounter(fixtureToSnapshot(bigFixture()));
    const r2 = await rig({ pins: farSessions.slice(0, 4), adapter: b });
    await r2.c.idle();
    const n0 = b.calls.length;
    expect(n0).toBeGreaterThan(0);
    b.dropConnection();
    r2.t.advance(PIN_REFRESH_MS * 3);
    r2.c.tick();
    await r2.c.idle();
    expect(b.calls).toHaveLength(n0);
    expect(parseSessionKey(farSessions[0] ?? "")?.taskId).toBe("far0");
  });
});
