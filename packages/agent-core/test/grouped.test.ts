// Protocol version 5 GROUPED round (docs/ui-v3.md section 9): the grouped frozen layout, folded tasks, sub-agents,
// pins v2 (task pins, the Pinned group, the pinned-source hook; no limit and need-you-first since 2026-11-19), the
// PINNED scope, the reader and its auto-return.
import { describe, expect, test } from "bun:test";
import { AgentConsole, type PinLists } from "../src/console";
import { NOTICE, PINNED_EMPTY, groupCount, groupTitle, groupedRowTitle, READER_AUTO_RETURN_MS } from "../src/copy";
import { fixtureToSnapshot, type FixtureFile } from "../src/fixtures";
import { MAX_PINS_PER_KIND, NEW_GROUP, PINNED_GROUP, groupedLayout, nestChildren, taskGroup, type Ranked } from "../src/focus";
import { sessionKey, taskKey } from "../src/identity";
import { MockAdapter } from "../src/mock-adapter";
import { parseSession } from "../src/validate";
import type { PinnedRequest, PinnedResult, Session } from "../src/types";
import { FakeTimers, RIG_EPOCH } from "./helpers";

const B = { backendId: "b", hostId: "h" };
const P = "proj";
const sk = (taskId: string, sessionId: string): string => sessionKey({ ...B, projectId: P, taskId, sessionId });
const tk = (taskId: string): string => taskKey({ ...B, projectId: P, taskId });
const DAY = 86_400_000;

type S = FixtureFile["sessions"][number] & { parentKey?: string };
const sess = (taskId: string, sessionId: string, state: string | null, ago: number, extra: Partial<S> = {}): S => ({
  projectId: P,
  taskId,
  sessionId,
  title: `${sessionId} title words`,
  provider: "claude",
  runtime: "chat",
  workspace: "/w",
  createdAt: RIG_EPOCH - ago,
  observed: { state, at: RIG_EPOCH - ago },
  ...extra,
});

/** Voice (T1), Firmware (T2 + T4 + an idle sub-agent), Docs (idle only: folds), Old (10 days: ALL only, folds). */
function fixture(more: S[] = []): FixtureFile {
  return {
    name: "grouped",
    ...B,
    projects: [{ projectId: P, name: "console" }],
    tasks: [
      { projectId: P, taskId: "fw", title: "Firmware v5", updatedAt: RIG_EPOCH - 60_000 },
      { projectId: P, taskId: "docs", title: "Docs pass", updatedAt: RIG_EPOCH - 30_000 },
      { projectId: P, taskId: "voice", title: "Voice composer", updatedAt: RIG_EPOCH - 10_000 },
      { projectId: P, taskId: "old", title: "Old task", updatedAt: RIG_EPOCH - 10 * DAY },
    ],
    sessions: [
      sess("fw", "fw-a", "failed", 60_000),
      sess("fw", "fw-b", "working", 50_000),
      sess("fw", "fw-sub", "idle", 40_000, { parentKey: sk("fw", "fw-b") }),
      sess("docs", "docs-1", "idle", 30_000),
      sess("docs", "docs-2", null, 20_000),
      sess("voice", "voice-q", "waiting_input", 10_000),
      sess("old", "old-1", "idle", 10 * DAY),
      ...more,
    ],
    approvals: [],
  };
}

class PinnedMock extends MockAdapter {
  calls: PinnedRequest[] = [];
  reply: PinnedResult = { sessions: [], tasks: [], gone: [] };
  fail = false;
  async fetchPinned(req: PinnedRequest): Promise<PinnedResult> {
    this.calls.push(req);
    if (this.fail) throw new Error("boom");
    return this.reply;
  }
}

interface G {
  c: AgentConsole;
  a: MockAdapter;
  t: FakeTimers;
}

async function grouped(opts: { pins?: string[]; scope?: "active" | "recent" | "all"; proto?: number; more?: S[]; adapter?: MockAdapter } = {}): Promise<G> {
  const a = opts.adapter ?? new MockAdapter(fixtureToSnapshot(fixture(opts.more)));
  const t = new FakeTimers();
  const c = new AgentConsole({ adapter: a, timers: t, now: () => RIG_EPOCH + t.now, pins: opts.pins });
  await c.start();
  c.setProtocol(opts.proto ?? 5);
  const g = { c, a, t };
  if (opts.scope === "recent") await turn(g, "K1", 1);
  if (opts.scope === "all") {
    await turn(g, "K1", 1);
    await turn(g, "K1", 1);
  }
  return g;
}

const press = (g: G, button: string) => g.c.handleInput({ kind: "button", button: button as never, edge: "down" });
const turn = (g: G, encoder: string, delta = 1) => g.c.handleInput({ kind: "encoder", encoder: encoder as never, delta });
const key = (g: G, k: number, gesture: "single" | "double" | "long" = "single") => g.c.handleInput({ kind: "key", key: k, gesture });
const keys = (g: G): (string | null)[] => [...g.c.state.layouts.sessions.slots];
const at = (g: G, k: string): number => keys(g).indexOf(k);

describe("grouped frozen layout (docs/ui-v3.md section 9.2)", () => {
  test("Sessions defaults to Grouped with protocol 5: tasks by best tier, sessions by tier, sub-agent after its parent, quiet task folded", async () => {
    const g = await grouped({ scope: "recent" });
    expect(g.c.view().layout).toBe("grouped");
    expect(keys(g)).toEqual([sk("voice", "voice-q"), sk("fw", "fw-a"), sk("fw", "fw-b"), sk("fw", "fw-sub"), tk("docs")]);
    const groups = g.c.state.layouts.sessions.groups ?? {};
    expect(groups[sk("fw", "fw-sub")]).toBe(taskGroup(tk("fw")));
    expect(groups[tk("docs")]).toBe(taskGroup(tk("docs")));
  });

  test("ACTIVE folds nothing (every task shown has a T0-T4 session); ALL folds the old task too", async () => {
    const a = await grouped();
    expect(keys(a)).toEqual([sk("voice", "voice-q"), sk("fw", "fw-a"), sk("fw", "fw-b")]);
    const all = await grouped({ scope: "all" });
    expect(keys(all).slice(-2)).toEqual([tk("docs"), tk("old")]);
  });

  test("protocol 4 or Buddy/List lay keys out flat (no task rows, no groups)", async () => {
    const g4 = await grouped({ scope: "recent", proto: 4 });
    expect(g4.c.state.layouts.sessions.groups).toBeUndefined();
    expect(keys(g4).some((k) => k !== null && k.split("/").length === 4)).toBe(false);
    const g = await grouped({ scope: "recent" });
    await press(g, "SEQ"); // grouped -> buddy
    expect(g.c.view().layout).toBe("buddy");
    expect(g.c.state.layouts.sessions.groups).toBeUndefined();
    expect(keys(g)).toHaveLength(6);
  });

  test("nestChildren: children follow their parent, a parent cycle still emits everyone once", () => {
    const r = (key: string, tier = 5): Ranked => ({ key, tier: tier as Ranked["tier"], order: 0, activity: 0, projectId: P, taskKey: "t" });
    const parents: Record<string, string> = { c1: "p", c2: "p", x: "y", y: "x" };
    const out = nestChildren([r("c1"), r("p"), r("c2"), r("x"), r("y"), r("z")], (k) => parents[k]).map((m) => m.key);
    expect(out).toEqual(["p", "c1", "c2", "z", "x", "y"]);
  });
});

describe("grouped rows on the wire (docs/ui-v3.md sections 9.3 and 9.5)", () => {
  test("row byte and header: start on each group's first key, indent 1 / 2, folded task row with its count", async () => {
    const g = await grouped({ scope: "recent" });
    const v = g.c.view();
    const s = v.slots;
    expect(s[0]?.row).toEqual({ indent: 1, start: true, task: false });
    expect(s[0]?.head).toEqual({ state: "waiting_input", pinned: false, title: "Voice composer", count: "1 need you" });
    expect(s[1]?.row).toEqual({ indent: 1, start: true, task: false });
    expect(s[1]?.head).toMatchObject({ state: "failed", title: "Firmware v5", count: "1 need you" });
    expect(s[2]?.row).toEqual({ indent: 1, start: false, task: false });
    expect(s[2]?.head).toBeUndefined();
    expect(s[3]?.row).toEqual({ indent: 2, start: false, task: false });
    expect(s[3]?.title?.length).toBeLessThanOrEqual(18);
    expect(s[4]).toMatchObject({ state: "idle", selected: false, row: { indent: 0, start: true, task: true }, head: { state: "idle", title: "Docs pass", count: "2 quiet" } });
    expect(s[4]?.title).toBe("Docs pass");
    for (const e of s.slice(5)) expect(e).toMatchObject({ state: "empty", row: { indent: 0, start: false, task: false } });
    expect(s.every((x) => (x.head !== undefined) === (x.row?.start ?? false))).toBe(true);
  });

  test("header copy: count rules, title fits 25 columns with the count, indent cuts titles", () => {
    expect(groupCount({ attention: 2, working: 1, total: 4, folded: false })).toBe("2 need you");
    expect(groupCount({ attention: 0, working: 1, total: 4, folded: false })).toBe("1 working");
    expect(groupCount({ attention: 0, working: 0, total: 4, folded: false })).toBe("all quiet");
    expect(groupCount({ attention: 0, working: 0, total: 140, folded: true })).toBe("99 quiet");
    expect(groupCount({ attention: 0, working: 0, total: 0, folded: true })).toBe("no chats");
    expect(groupCount({ attention: 120, working: 0, total: 120, folded: false }).length).toBeLessThanOrEqual(11);
    const t = groupTitle("Refactor the device protocol codec", "2 need you");
    expect(t.length + 1 + "2 need you".length).toBeLessThanOrEqual(25);
    expect(groupTitle("", "all quiet")).toBe("(untitled)");
    expect(groupedRowTitle("Voice tests for the push-to-talk path", 2).length).toBeLessThanOrEqual(18);
  });

  test("an arrival between re-sorts forms the New group with its own header", async () => {
    const g = await grouped();
    g.a.upsertSession(parseOk(sess("docs", "docs-new", "failed", 0, { createdAt: RIG_EPOCH + 5_000 })));
    const k = at(g, sk("docs", "docs-new"));
    expect(k).toBeGreaterThanOrEqual(0);
    expect(g.c.state.layouts.sessions.groups?.[sk("docs", "docs-new")]).toBeUndefined();
    const slot = g.c.view().slots[k];
    expect(slot?.row?.start).toBe(true);
    expect(slot?.head).toMatchObject({ title: "New", state: "failed", count: "1 need you" });
    expect(NEW_GROUP).toBe("new");
  });

  test("a group continued on the next page repeats its header on the page's first key", async () => {
    const many = Array.from({ length: 30 }, (_, i) => sess("big", `big-${String(i).padStart(2, "0")}`, "failed", 1000 + i));
    const f = fixture(many);
    f.tasks.push({ projectId: P, taskId: "big", title: "Big task", updatedAt: RIG_EPOCH });
    const g = await grouped({ adapter: new MockAdapter(fixtureToSnapshot(f)) });
    expect(g.c.view().pages).toBeGreaterThan(1);
    await press(g, "OCT_UP");
    const first = g.c.view().slots[0];
    expect(first?.row?.start).toBe(true);
    expect(g.c.state.layouts.sessions.groups?.[keys(g)[27] ?? ""]).toBe(taskGroup(tk("big")));
    expect(first?.head).toMatchObject({ title: "Big task", count: "30 need you" });
  });
});

function parseOk(raw: S): Session {
  const { projectId, taskId, sessionId, observed, inferred, raw: r, ...rest } = raw;
  const p = parseSession({ ...rest, ref: { ...B, projectId, taskId, sessionId }, status: { observed, inferred, raw: r ?? null } });
  if (!p.ok) throw new Error(p.error);
  return p.value;
}

describe("selection and folded rows (docs/ui-v3.md section 9.2)", () => {
  test("SELECT and ALGORITHM skip folded task rows", async () => {
    const g = await grouped({ scope: "recent" });
    await key(g, 3); // fw-sub
    await turn(g, "SELECT", 1);
    expect(g.c.registry.selection().key).toBe(sk("voice", "voice-q"));
    for (let i = 0; i < 6; i++) {
      await turn(g, "ALGORITHM", 1);
      expect(g.c.registry.selection().key?.split("/").length).toBe(5);
    }
  });

  test("tap on a folded row: TASK filter on that task (it expands), toast; tap again on its row clears nothing else", async () => {
    const g = await grouped({ scope: "recent" });
    await key(g, at(g, tk("docs")));
    expect(g.c.state.taskFilter).toBe(tk("docs"));
    expect(g.c.state.notice?.text).toBe("Task: Docs pass");
    expect(keys(g)).toEqual([sk("docs", "docs-2"), sk("docs", "docs-1")]);
    expect(g.c.view().slots[0]?.head).toMatchObject({ title: "Docs pass", count: "all quiet" });
    await key(g, 0, "double");
    expect(g.c.state.taskFilter).toBe(tk("docs"));
  });

  test("long press on a folded row pins the task: it keeps its place (task pins take no session key), flagged", async () => {
    const g = await grouped({ scope: "recent" });
    const before = keys(g);
    await key(g, at(g, tk("docs")), "long");
    expect(g.c.state.pins).toEqual([tk("docs")]);
    expect(g.c.state.notice?.text).toBe(NOTICE.taskPinned);
    expect(keys(g)).toEqual(before);
    const slot = g.c.view().slots[at(g, tk("docs"))];
    expect(slot?.head).toMatchObject({ pinned: true, title: "Docs pass" });
    expect(slot?.pinned).toBe(true);
  });
});

describe("pins v2 (docs/ui-v3.md section 9.6)", () => {
  test("Grouped: the Pinned group first, then groups that need you, then the rest; task pins take no session key", async () => {
    const g = await grouped({ pins: [sk("docs", "docs-1"), tk("old"), sk("old", "old-1")] });
    expect(keys(g)).toEqual([sk("docs", "docs-1"), sk("old", "old-1"), sk("voice", "voice-q"), sk("fw", "fw-a"), sk("fw", "fw-b")]);
    const groups = g.c.state.layouts.sessions.groups ?? {};
    expect(groups[sk("docs", "docs-1")]).toBe(PINNED_GROUP);
    expect(groups[sk("old", "old-1")]).toBe(PINNED_GROUP); // a session pin, whatever SHOW says; not under its pinned task
    expect(g.c.view().slots[0]?.head).toMatchObject({ title: "Pinned", pinned: true });
    expect(groups[sk("voice", "voice-q")]).toBe(taskGroup(tk("voice")));
    expect(new Set(keys(g)).size).toBe(keys(g).length);
  });

  test("Grouped: a pinned session moves to the Pinned group whether it needs you or not", async () => {
    const g = await grouped({ scope: "recent", pins: [sk("voice", "voice-q"), sk("fw", "fw-b")] });
    expect(keys(g)).toEqual([sk("voice", "voice-q"), sk("fw", "fw-b"), sk("fw", "fw-a"), sk("fw", "fw-sub"), tk("docs")]);
    const groups = g.c.state.layouts.sessions.groups ?? {};
    expect(groups[sk("voice", "voice-q")]).toBe(PINNED_GROUP);
    expect(groups[sk("fw", "fw-a")]).toBe(taskGroup(tk("fw")));
    expect(groups[sk("fw", "fw-sub")]).toBe(taskGroup(tk("fw"))); // its parent left the group: an ordinary member
    expect(groups[sk("fw", "fw-b")]).toBe(PINNED_GROUP);
    expect(g.c.view().slots[0]?.pinned).toBe(true);
  });

  test("flat layouts: session pins first, then sessions that need you, then the scope; a pinned task's sessions are not lifted", async () => {
    const g = await grouped({ pins: [tk("old"), sk("docs", "docs-1")], proto: 4 });
    expect(keys(g)).toEqual([sk("docs", "docs-1"), sk("voice", "voice-q"), sk("fw", "fw-a"), sk("fw", "fw-b")]);
    expect(g.c.view().slots[0]?.pinned).toBe(true);
    expect(g.c.view().slots[1]?.pinned).toBe(false);
    expect(g.c.view().slots[3]?.pinned).toBe(false);
  });

  test("no limit of 9: session and task pins counted apart; the Tasks view long press pins a task", async () => {
    const g = await grouped({ scope: "all", proto: 4 });
    for (let i = 0; i < 7; i++) {
      const free = keys(g).findIndex((k) => k !== null && k.split("/").length === 5 && !g.c.state.pins.includes(k));
      await key(g, free, "long");
      expect(g.c.state.notice?.text).toBe("Pinned");
    }
    await press(g, "EDIT");
    for (let i = 0; i < 4; i++) await key(g, i, "long");
    expect(g.c.state.notice?.text).toBe("Task pinned");
    expect(g.c.state.pins).toHaveLength(11);
    expect(g.c.state.pins.filter((k) => k.split("/").length === 4)).toHaveLength(4);
    expect(MAX_PINS_PER_KIND).toBe(200);
  });

  test("restored pins: invalid strings dropped, task keys kept apart; without fetchPinned a missing pin is dropped", async () => {
    const seen: PinLists[] = [];
    const a = new MockAdapter(fixtureToSnapshot(fixture()));
    const c = new AgentConsole({ adapter: a, pins: ["junk", tk("docs"), sk("docs", "gone"), sk("fw", "fw-a")], onPinsChanged: (p) => seen.push(p) });
    expect(c.state.pins).toEqual([sk("docs", "gone"), sk("fw", "fw-a"), tk("docs")]);
    await c.start();
    expect(c.state.pins).toEqual([sk("fw", "fw-a"), tk("docs")]);
    expect(seen.at(-1)).toEqual({ sessions: [sk("fw", "fw-a")], tasks: [tk("docs")] });
    // The split form (config sessionPins / taskPins) restores the same way; a key of the wrong kind is sorted by shape.
    const c2 = new AgentConsole({ adapter: a, pins: { sessions: [sk("fw", "fw-a"), tk("old")], tasks: [tk("docs")] } });
    expect(c2.state.pins).toEqual([sk("fw", "fw-a"), tk("old"), tk("docs")]);
  });

  test("with fetchPinned: pins outside the scan are fetched and kept; only reported-gone pins drop; a failure keeps all", async () => {
    const a = new PinnedMock(fixtureToSnapshot(fixture()));
    const outside = parseOk(sess("far", "far-1", "idle", 1000));
    a.reply = { sessions: [outside], tasks: [{ ref: { ...B, projectId: P, taskId: "far" }, title: "Far away", updatedAt: RIG_EPOCH }], gone: [sk("docs", "dead")] };
    const c = new AgentConsole({ adapter: a, now: () => RIG_EPOCH, pins: [sk("far", "far-1"), sk("docs", "dead"), tk("fw")] });
    await c.start();
    expect(a.calls[0]?.sessions.map((r) => r.sessionId)).toEqual(["far-1", "dead"]);
    // The task fw lies inside the scan (the snapshot listed its sessions): it is not asked for.
    expect(a.calls[0]?.tasks.map((r) => r.taskId)).toEqual([]);
    expect(c.state.pins).toEqual([sk("far", "far-1"), tk("fw")]);
    expect(c.registry.get(sk("far", "far-1"))?.stale).toBe(false);
    a.fail = true;
    await c.resync();
    expect(c.state.pins).toEqual([sk("far", "far-1"), tk("fw")]);
    expect(c.rejectedEvents.some((e) => e.startsWith("fetchPinned failed"))).toBe(true);
  });

  test("Session.parentKey validates: non-empty string <= 1024", () => {
    expect(() => parseOk(sess("fw", "x", "idle", 0, { parentKey: "" }))).toThrow("parentKey");
    expect(parseOk(sess("fw", "x", "idle", 0, { parentKey: sk("fw", "fw-b") })).parentKey).toBe(sk("fw", "fw-b"));
  });
});

describe("PINNED scope (docs/ui-v3.md section 9.4)", () => {
  test("KNOB1 reaches PINNED after ALL: pins only, across tasks, REPO and TASK knobs do nothing, their legend cells are empty", async () => {
    const g = await grouped({ scope: "all", pins: [sk("fw", "fw-a"), sk("old", "old-1"), tk("docs")] });
    await turn(g, "K1", 1);
    expect(g.c.state.scope).toBe("pinned");
    expect(g.c.state.notice?.text).toBe("Show: pinned (2)");
    const v = g.c.view();
    expect(v.title).toBe("PINNED 2");
    expect(v.legend).toEqual(["SHOW", "", "", "TALK"]);
    // Session pins (need you first), then each pinned task as a folded row (Grouped only), so every pin is reachable.
    expect(keys(g)).toEqual([sk("fw", "fw-a"), sk("old", "old-1"), tk("docs")]);
    const before = g.c.state;
    await turn(g, "K2", 1);
    await turn(g, "K3", 1);
    expect(g.c.state.repoFilter).toBe(before.repoFilter);
    expect(g.c.state.taskFilter).toBe(before.taskFilter);
    await turn(g, "K1", 1);
    expect(g.c.state.scope).toBe("pinned");
  });

  test("Buddy and List show PINNED flat: the pins that need you first, then the others; task rows only in Grouped", async () => {
    const g = await grouped({ scope: "all", pins: [tk("docs"), sk("docs", "docs-1"), sk("fw", "fw-b"), sk("fw", "fw-a")] });
    await turn(g, "K1", 1);
    expect(keys(g)).toEqual([sk("fw", "fw-a"), sk("fw", "fw-b"), sk("docs", "docs-1"), tk("docs")]);
    expect(g.c.state.layouts.sessions.groups?.[sk("fw", "fw-b")]).toBe(PINNED_GROUP);
    await press(g, "SEQ"); // -> buddy
    expect(keys(g)).toEqual([sk("fw", "fw-a"), sk("fw", "fw-b"), sk("docs", "docs-1")]);
    expect(g.c.state.layouts.sessions.groups).toBeUndefined();
  });

  test("only task pins: Grouped PINNED lists them as rows (not the empty text); Buddy shows the empty text", async () => {
    const g = await grouped({ scope: "all", pins: [tk("docs")] });
    await turn(g, "K1", 1);
    expect(keys(g)).toEqual([tk("docs")]);
    expect(g.c.view().text?.[0]?.text).not.toBe(PINNED_EMPTY[0]);
    await press(g, "SEQ");
    expect(g.c.view().text?.[0]?.text).toBe(PINNED_EMPTY[0]);
  });

  test("empty state: no keys, the bubble/header says how to pin", async () => {
    const g = await grouped({ scope: "all" });
    await turn(g, "K1", 1);
    const v = g.c.view();
    expect(v.title).toBe("PINNED 0");
    expect(v.slots.every((s) => s.state === "empty")).toBe(true);
    expect(v.text?.slice(0, 2)).toEqual([
      { style: "heading", text: PINNED_EMPTY[0] },
      { style: "muted", text: PINNED_EMPTY[1] },
    ]);
    expect(v.detail.lines[3]).toBe("SEQ buddy  SCL help");
    expect(groupedLayout({ scope: "pinned", repoFilter: null, taskFilter: null, pins: [] }, { registry: g.c.registry, inbox: g.c.inbox, now: RIG_EPOCH }).keys).toEqual([]);
  });
});

describe("SEQ cycle and the reader (docs/ui-v3.md sections 9.1 and 9.8)", () => {
  test("Sessions cycles grouped -> buddy -> list -> grouped; entering or leaving Grouped re-sorts and keeps the selection's page", async () => {
    const g = await grouped({ scope: "recent" });
    await key(g, 3);
    const sel = g.c.registry.selection().key;
    await press(g, "SEQ");
    expect(g.c.view().layout).toBe("buddy");
    await press(g, "SEQ");
    expect(g.c.view().layout).toBe("list");
    await press(g, "SEQ");
    expect(g.c.view().layout).toBe("grouped");
    expect(g.c.registry.selection().key).toBe(sel);
    expect(g.c.view().slots[at(g, sel ?? "")]?.selected).toBe(true);
    await press(g, "GLO");
    await press(g, "SEQ");
    expect(g.c.state.screen.inbox).toBe("buddy");
    await press(g, "SEQ");
    expect(g.c.state.screen.inbox).toBe("list");
  });

  test("PRESETS opens the reader on page 0 (either direction); LFO and HOME return with the selection kept", async () => {
    const g = await grouped({ scope: "recent" });
    await turn(g, "PRESETS", 1);
    expect(g.c.view().view).toBe("sessions"); // nothing selected
    await key(g, 1);
    await turn(g, "PRESETS", -1);
    expect(g.c.view()).toMatchObject({ view: "detail", page: 0 });
    await press(g, "LFO");
    expect(g.c.view().view).toBe("sessions");
    await turn(g, "PRESETS", 1);
    await press(g, "HOME");
    expect(g.c.view()).toMatchObject({ view: "sessions", layout: "grouped" });
    expect(g.c.registry.selection().key).toBe(sk("fw", "fw-a"));
  });

  test("auto-return after 20 s without input (5 s tick), not before, never under confirm; protocol 4 keeps PRESETS scrolling", async () => {
    const g = await grouped({ scope: "recent" });
    await key(g, 1);
    await turn(g, "PRESETS", 1);
    g.t.advance(READER_AUTO_RETURN_MS - 5_000);
    g.c.tick();
    expect(g.c.view().view).toBe("detail");
    g.t.advance(5_000);
    g.c.tick();
    expect(g.c.view().view).toBe("sessions");
    await key(g, 2); // fw-b, working: ENV asks to stop it
    await turn(g, "PRESETS", 1);
    await press(g, "ENV");
    expect(g.c.view().view).toBe("confirm");
    g.t.advance(60_000);
    g.c.tick();
    expect(g.c.view().view).toBe("confirm");
    const g4 = await grouped({ scope: "recent", proto: 4 });
    await key(g4, 1);
    await turn(g4, "PRESETS", 1);
    expect(g4.c.view().view).toBe("sessions");
  });

  test("hint: PRESETS read where it fits or first when the bubble has more; SEQ names the next layout", async () => {
    const g = await grouped({ scope: "recent" });
    const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    const e = g.c.registry.get(sk("fw", "fw-sub"));
    if (!e) throw new Error("missing");
    g.a.upsertSession({ ...e.session, details: { lastMessage: long, lastMessageAt: RIG_EPOCH } });
    await key(g, 3);
    expect(g.c.view().detail.lines[3]).toBe("PRESETS read");
    await key(g, 0); // waiting_input: the answer keeps its place
    expect(g.c.view().detail.lines[3].startsWith("REC reply")).toBe(true);
    for (const v of [g.c.view()]) expect(v.detail.lines[3].length).toBeLessThanOrEqual(20);
  });
});

describe("review fixes: PINNED never leaks filters or foreign arrivals (docs/ui-v3.md section 9.4)", () => {
  test("between re-sorts only a pinned session arrives in PINNED (a pinned task's new session does not)", async () => {
    // A session pin whose session the scan does not list yet (fetchPinned keeps it until Traycer says it is gone).
    const a = new PinnedMock(fixtureToSnapshot(fixture()));
    const g = await grouped({ scope: "all", pins: [sk("fw", "fw-a"), tk("docs"), sk("voice", "voice-late")], adapter: a });
    await turn(g, "K1", 1);
    expect(g.c.state.scope).toBe("pinned");
    const before = keys(g);
    g.a.upsertSession(parseOk(sess("voice", "voice-new", "failed", 0, { createdAt: RIG_EPOCH + 5_000 })));
    expect(at(g, sk("voice", "voice-new"))).toBe(-1);
    g.a.upsertSession(parseOk(sess("docs", "docs-new", "failed", 0, { createdAt: RIG_EPOCH + 6_000 })));
    expect(at(g, sk("docs", "docs-new"))).toBe(-1);
    expect(keys(g)).toEqual(before);
    expect(g.c.view().title).toBe("PINNED 1");
    g.a.upsertSession(parseOk(sess("voice", "voice-late", "failed", 0, { createdAt: RIG_EPOCH + 7_000 })));
    expect(at(g, sk("voice", "voice-late"))).toBeGreaterThanOrEqual(0);
  });

  test("a pinned session arrives in PINNED even outside the REPO / TASK filters set before", async () => {
    const a = new PinnedMock(fixtureToSnapshot(fixture()));
    const g = await grouped({ scope: "all", pins: [sk("old", "old-new")], adapter: a });
    await turn(g, "K3", 1); // TASK filter on the first task (not "old")
    expect(g.c.state.taskFilter).not.toBe(tk("old"));
    await turn(g, "K1", 1);
    g.a.upsertSession(parseOk(sess("old", "old-new", "waiting_input", 0, { createdAt: RIG_EPOCH + 5_000 })));
    expect(at(g, sk("old", "old-new"))).toBeGreaterThanOrEqual(0);
  });

  test("the PINNED title carries no TASK / REPO name", async () => {
    const g = await grouped({ scope: "all", pins: [sk("fw", "fw-a")] });
    await turn(g, "K3", 1);
    expect(g.c.view().title).not.toMatch(/^ALL \d+$/); // the filter name shows in ALL
    await turn(g, "K1", 1);
    expect(g.c.view().title).toBe("PINNED 1");
  });

  test("a folded (no chats) pinned task row in PINNED: a tap sets no hidden TASK filter", async () => {
    const f = fixture();
    f.tasks.push({ projectId: P, taskId: "empty", title: "Empty task", updatedAt: RIG_EPOCH });
    const g = await grouped({ scope: "all", pins: [tk("empty")], adapter: new MockAdapter(fixtureToSnapshot(f)) });
    await turn(g, "K1", 1);
    expect(keys(g)).toEqual([tk("empty")]);
    await key(g, 0);
    expect(g.c.state.taskFilter).toBeNull();
    expect(g.c.state.repoFilter).toBeNull();
    expect(g.c.state.notice).toBeNull();
    await key(g, 0, "long"); // the long press still unpins it
    expect(g.c.state.pins).toEqual([]);
  });

  test("a task tap in the Tasks view under PINNED leaves for ALL, so the chosen task is shown", async () => {
    const g = await grouped({ scope: "all", pins: [tk("docs"), sk("fw", "fw-a")] });
    await turn(g, "K1", 1);
    await press(g, "EDIT");
    const tasks = g.c.state.layouts.tasks.slots;
    const k = tasks.indexOf(tk("docs"));
    expect(k).toBeGreaterThanOrEqual(0);
    await key(g, k);
    expect(g.c.state).toMatchObject({ view: "sessions", scope: "all", taskFilter: tk("docs") });
    expect(keys(g)).toEqual([sk("docs", "docs-2"), sk("docs", "docs-1")]);
  });

  test("ALGORITHM in the Tasks view under PINNED reaches a pinned task of another repo despite a REPO filter", async () => {
    const f = fixture();
    f.projects.push({ projectId: "far", name: "far repo" });
    f.tasks.push({ projectId: "far", taskId: "ft", title: "Far task", updatedAt: RIG_EPOCH });
    f.sessions.push({ ...sess("ft", "ft-q", "waiting_input", 5_000), projectId: "far" });
    const farTask = taskKey({ ...B, projectId: "far", taskId: "ft" });
    const g = await grouped({ scope: "all", pins: [farTask], adapter: new MockAdapter(fixtureToSnapshot(f)) });
    while (g.c.state.repoFilter !== P) await turn(g, "K2", 1);
    await turn(g, "K1", 1);
    await press(g, "EDIT");
    expect(g.c.state.layouts.tasks.slots).toEqual([farTask]);
    await turn(g, "ALGORITHM", 1);
    expect(g.c.state.taskCursor).toBe(farTask);
  });

  test("a malformed restored task pin does not break fetchPinned", async () => {
    const a = new PinnedMock(fixtureToSnapshot(fixture()));
    const c = new AgentConsole({ adapter: a, now: () => RIG_EPOCH, pins: ["%E0%A4%A/h/p/t", tk("nowhere")] });
    await c.start();
    expect(a.calls[0]?.tasks.map((r) => r.taskId)).toEqual(["nowhere"]);
  });
});
