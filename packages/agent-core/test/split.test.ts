// Protocol version 6 (docs/ui-v3.md section 10): the SETTINGS view (hold ARP), SPLIT keys (filters, a frozen paged task
// row, white sessions), host-resolved OCT single/double, task pins, persistence and the fallback to RANKED below 6.
import { describe, expect, test } from "bun:test";
import { AgentConsole } from "../src/console";
import { fixtureToSnapshot, type FixtureFile } from "../src/fixtures";
import { sessionKey, taskKey } from "../src/identity";
import { MockAdapter } from "../src/mock-adapter";
import { parseSession } from "../src/validate";
import { ARP_HOLD_MS, OCT_DOUBLE_MS, taskTag, taskTags, validSplit, WHITE_KEYS, type KeyMode, type SplitState } from "../src/split";
import type { DeviceView } from "../src/view";
import type { Session } from "../src/types";
import { allSupported } from "../src/capabilities";
import { FakeTimers, RIG_EPOCH } from "./helpers";

const B = { backendId: "b", hostId: "h" };
const P = "proj";
const sk = (taskId: string, sessionId: string): string => sessionKey({ ...B, projectId: P, taskId, sessionId });
const tk = (taskId: string): string => taskKey({ ...B, projectId: P, taskId });

type S = FixtureFile["sessions"][number];
const sess = (taskId: string, sessionId: string, state: string | null, ago: number, extra: Partial<S> = {}): S => ({
  projectId: P,
  taskId,
  sessionId,
  title: `${sessionId} title`,
  provider: "claude",
  runtime: "chat",
  workspace: "/w",
  createdAt: RIG_EPOCH - ago,
  observed: { state, at: RIG_EPOCH - ago },
  ...extra,
});

const TASKS: [string, string][] = [
  ["voice", "Voice composer"],
  ["fw", "Firmware v5"],
  ["alpha", "Alpha task"],
  ["docs", "Docs pass"],
  ["dogs", "Dogs park"],
  ["six", "Task six"],
  ["seven", "Task seven"],
  ["eight", "Task eight"],
  ["nine", "Task nine"],
  ["ten", "Task ten"],
  ["quiet", "Quiet one"],
];

/**
 * Ten tasks in ACTIVE (voice T1, fw T2 + T4, alpha T3, the rest working by newest activity) and a quiet idle task
 * (RECENT only). 17 sessions in ACTIVE, so the white keys have 2 pages (15 + 2) and the task row 2 pages (8 + 2).
 */
function fixture(more: S[] = []): FixtureFile {
  return {
    name: "split",
    ...B,
    projects: [{ projectId: P, name: "console" }],
    tasks: TASKS.map(([taskId, title], i) => ({ projectId: P, taskId, title, updatedAt: RIG_EPOCH - 1000 * (i + 1) })),
    sessions: [
      sess("voice", "voice-q", "waiting_input", 10_000),
      sess("fw", "fw-a", "failed", 60_000),
      sess("fw", "fw-b", "working", 50_000),
      sess("alpha", "alpha-1", "completed_unread", 5_000),
      sess("docs", "docs-1", "working", 30_000),
      sess("dogs", "dogs-1", "working", 25_000),
      sess("six", "six-1", "working", 100_000),
      sess("seven", "seven-1", "working", 110_000),
      sess("eight", "eight-1", "working", 120_000),
      sess("nine", "nine-1", "working", 130_000),
      sess("ten", "ten-1", "working", 140_000),
      ...[2, 3, 4, 5, 6, 7].map((n) => sess("ten", `ten-${n}`, "working", 140_000 + n * 1000)),
      sess("quiet", "quiet-1", "idle", 200_000),
      ...more,
    ],
    approvals: [],
  };
}

function parseOk(raw: S): Session {
  const { projectId, taskId, sessionId, observed, inferred, raw: r, ...rest } = raw;
  const p = parseSession({ ...rest, ref: { ...B, projectId, taskId, sessionId }, status: { observed, inferred, raw: r ?? null } });
  if (!p.ok) throw new Error(p.error);
  return p.value;
}

interface R {
  toasts: string[];
  c: AgentConsole;
  a: MockAdapter;
  t: FakeTimers;
  settingsSaved: { keys: KeyMode }[];
  splitSaved: SplitState[];
}

async function rig(
  opts: { keys?: KeyMode; proto?: number; layout?: "buddy" | "list" | "grouped"; pins?: string[]; split?: Partial<SplitState>; more?: S[]; adapter?: MockAdapter } = {},
): Promise<R> {
  const a = opts.adapter ?? new MockAdapter(fixtureToSnapshot(fixture(opts.more)));
  const t = new FakeTimers();
  const settingsSaved: { keys: KeyMode }[] = [];
  const splitSaved: SplitState[] = [];
  const c = new AgentConsole({
    adapter: a,
    timers: t,
    now: () => RIG_EPOCH + t.now,
    pins: opts.pins,
    layouts: { sessions: opts.layout ?? "buddy" },
    settings: { keys: opts.keys ?? "split" },
    onSettingsChanged: (s) => settingsSaved.push(s),
    split: opts.split,
    onSplitChanged: (s) => splitSaved.push(s),
  });
  await c.start();
  c.setProtocol(opts.proto ?? 6);
  return { c, a, t, settingsSaved, splitSaved, toasts: [] };
}

/** Every input goes through here so the toast it produced (COMMAND_RESULT text) is kept for the assertions. */
async function input(r: R, i: Parameters<AgentConsole["handleInput"]>[0]) {
  const acts = await r.c.handleInput(i);
  if (r.c.state.notice) r.toasts.push(r.c.state.notice.text);
  return acts;
}
const down = (r: R, button: string) => input(r, { kind: "button", button: button as never, edge: "down" });
const up = (r: R, button: string) => input(r, { kind: "button", button: button as never, edge: "up" });
const press = async (r: R, button: string): Promise<void> => {
  await down(r, button);
  await up(r, button);
};
const turn = (r: R, encoder: string, delta = 1) => input(r, { kind: "encoder", encoder: encoder as never, delta });
const key = (r: R, k: number, gesture: "single" | "double" | "long" = "single") => input(r, { kind: "key", key: k, gesture });
const white = (r: R): (string | null)[] => [...r.c.state.layouts.sessions.slots];
const toast = (r: R): string | undefined => r.toasts.at(-1);
const v = (r: R): DeviceView => r.c.view();
const slot = (r: R, k: number) => v(r).slots[k];

/** Task row order in ACTIVE: voice (T1), fw (T2), alpha (T3), then working by newest activity. */
const ROW = ["voice", "fw", "alpha", "dogs", "docs", "six", "seven", "eight", "nine", "ten"].map(tk);

describe("SETTINGS view (docs/ui-v3.md section 10.2)", () => {
  test("ARP tap toasts how to open; a 1 s hold opens SETTINGS on the timer, over the current base view", async () => {
    const r = await rig({ keys: "ranked" });
    await press(r, "ARP");
    expect(toast(r)).toBe("Hold ARP: settings");
    expect(v(r).view).toBe("sessions");
    await down(r, "ARP");
    r.t.advance(ARP_HOLD_MS - 1);
    expect(v(r).view).toBe("sessions");
    r.t.advance(1);
    expect(v(r).view).toBe("settings");
    await up(r, "ARP");
    expect(v(r).view).toBe("settings");
    expect(r.c.state.settingsFrom).toBe("sessions");
  });

  test("protocol 5: ARP does nothing (no toast, no SETTINGS)", async () => {
    const r = await rig({ keys: "ranked", proto: 5 });
    await press(r, "ARP");
    expect(toast(r)).toBeUndefined();
    await down(r, "ARP");
    r.t.advance(2000);
    expect(v(r).view).toBe("sessions");
    expect(v(r).keys).toBeUndefined();
  });

  test("not from DETAILS: ARP hold there does nothing", async () => {
    const r = await rig({ keys: "ranked" });
    await turn(r, "SELECT", 1);
    await press(r, "LFO");
    expect(v(r).view).toBe("detail");
    await down(r, "ARP");
    r.t.advance(2000);
    expect(v(r).view).toBe("detail");
  });

  test("the SETTINGS view: title, cursor row, 26-wide item row, description, hint, empty legend, layout 0", async () => {
    const r = await rig({ keys: "ranked", layout: "grouped" });
    await down(r, "ARP");
    r.t.advance(ARP_HOLD_MS);
    const view = v(r);
    expect(view.view).toBe("settings");
    expect(view.title).toBe("SETTINGS");
    expect([view.page, view.pages]).toEqual([0, 1]);
    expect(view.text?.[0]?.text).toBe("Keys                Ranked");
    expect(view.text?.[0]?.text.length).toBe(26);
    expect(view.text?.[9]).toEqual({ style: "muted", text: "Every key is a session" });
    expect(view.text?.slice(1, 9).every((x) => x.text === "")).toBe(true);
    expect(view.detail.lines[3]).toBe("SAVE set  HOME back");
    expect(view.legend).toEqual(["", "", "", ""]);
    expect(view.layout).toBe("buddy");
    expect(view.keys).toBe("ranked");
  });

  test("SAVE toggles Keys, applies it at once under SETTINGS (slots re-laid, keys split), saves and toasts", async () => {
    const r = await rig({ keys: "ranked" });
    await down(r, "ARP");
    r.t.advance(ARP_HOLD_MS);
    await press(r, "SAVE");
    expect(toast(r)).toBe("Keys: split");
    expect(r.settingsSaved).toEqual([{ keys: "split" }]);
    const view = v(r);
    expect(view.view).toBe("settings");
    expect(view.keys).toBe("split");
    expect(view.text?.[0]?.text).toBe("Keys                 Split");
    expect(view.text?.[9]?.text).toBe("Black keys: filters, tasks");
    expect(view.slots[1]?.label).toBe("ALL");
    expect(view.slots[1]?.chosen).toBe(true);
    expect(view.slots[8]?.label).toBe("VCO");
    await press(r, "SAVE");
    expect(toast(r)).toBe("Keys: ranked");
    expect(r.settingsSaved.at(-1)).toEqual({ keys: "ranked" });
    expect(v(r).keys).toBe("ranked");
  });

  test("SELECT is clamped; HOME closes to Sessions (re-sort); LFO and ARP close back to the view it opened over", async () => {
    const r = await rig({ keys: "ranked" });
    await press(r, "GLO");
    await down(r, "ARP");
    r.t.advance(ARP_HOLD_MS);
    await up(r, "ARP");
    await turn(r, "SELECT", 1);
    expect(r.c.state.settingsCursor).toBe(0);
    await turn(r, "SELECT", -1);
    expect(r.c.state.settingsCursor).toBe(0);
    await press(r, "LFO");
    expect(v(r).view).toBe("inbox");
    await down(r, "ARP");
    r.t.advance(ARP_HOLD_MS);
    await up(r, "ARP");
    await press(r, "ARP");
    expect(v(r).view).toBe("inbox");
    await down(r, "ARP");
    r.t.advance(ARP_HOLD_MS);
    await up(r, "ARP");
    await press(r, "HOME");
    expect(v(r).view).toBe("sessions");
  });

  test("nothing else acts in SETTINGS: keys, OCT, FX, ENV, PLAY, REC, SEQ, EDIT, GLO, knobs", async () => {
    const r = await rig({ keys: "ranked" });
    await down(r, "ARP");
    r.t.advance(ARP_HOLD_MS);
    await up(r, "ARP");
    const before = JSON.stringify({ ...r.c.state, lastInputAt: 0, notice: null });
    for (const b of ["OCT_UP", "OCT_DOWN", "FX", "ENV", "PLAY", "REC", "SEQ", "EDIT", "GLO"]) {
      const acts = await down(r, b);
      expect(acts).toEqual([]);
      await up(r, b);
    }
    for (const e of ["K1", "K2", "K3", "K4", "ALGORITHM", "PRESETS"]) await turn(r, e, 1);
    expect(await key(r, 0)).toEqual([]);
    expect(JSON.stringify({ ...r.c.state, lastInputAt: 0, notice: null })).toBe(before);
    expect(v(r).view).toBe("settings");
  });
});

describe("SPLIT key assignment and lists (docs/ui-v3.md sections 10.3-10.4)", () => {
  test("black row: filters ALL/PIN/YOU on 1, 3, 5; tasks on 8...25 in row order with tags; whites the ALL list", async () => {
    const r = await rig();
    const view = v(r);
    expect(view.keys).toBe("split");
    expect([view.taskPage, view.taskPages]).toEqual([0, 2]);
    expect(r.c.state.taskRow.keys).toEqual(ROW);
    expect([1, 3, 5].map((k) => view.slots[k]?.label)).toEqual(["ALL", "PIN", "YOU"]);
    expect([8, 10, 13, 15, 17, 20, 22, 25].map((k) => view.slots[k]?.label)).toEqual(["VCO", "FV5", "ATA", "DPA", "DP5", "TSI", "TSE", "TEI"]);
    // whites: the RANKED ALL order (tiers), page 1 holds 15 and G5 stays free
    const w = white(r);
    expect(w.slice(0, 4)).toEqual([sk("voice", "voice-q"), sk("fw", "fw-a"), sk("alpha", "alpha-1"), sk("dogs", "dogs-1")]);
    expect(w[15]).toBeNull();
    expect(view.pages).toBe(2);
    expect(view.slots[0]?.label).toBe("voice-q");
    expect(view.slots[24]?.label).not.toBe("");
    expect(view.slots[26]?.state).toBe("empty");
    // no black key is ever selected
    await turn(r, "SELECT", 1);
    expect(view.slots.filter((s, k) => !WHITE_KEYS.includes(k as never) && s.selected)).toEqual([]);
  });

  test("black slots: state per LED table, flags pinned/chosen, title and age; a filter has no age", async () => {
    const r = await rig({ pins: [tk("fw"), sk("quiet", "quiet-1")] });
    const view = v(r);
    expect(view.slots[1]).toMatchObject({ state: "idle", chosen: true, title: "All", age: "" });
    expect(view.slots[3]).toMatchObject({ state: "idle", label: "PIN", title: "Pinned" });
    // NEEDS YOU: the most urgent of T0-T3 (failed outranks a question, bubble.ts URGENCY)
    expect(view.slots[5]).toMatchObject({ state: "failed", label: "YOU", title: "Needs you" });
    // the pinned task comes first on the row, its chip shows its most urgent session
    expect(r.c.state.taskRow.keys[0]).toBe(tk("fw"));
    expect(view.slots[8]).toMatchObject({ label: "FV5", state: "failed", pinned: true, chosen: false, title: "Firmware v5", selected: false });
    expect(view.slots[8]?.age).toBe("now"); // the task record was updated 2 s ago (newest activity)
    const empty = (await rig()).c.view().slots[3];
    expect(empty?.state).toBe("empty");
    // Task pins alone leave the PIN filter empty: they take no white key (operator decision 2026-11-19).
    expect((await rig({ pins: [tk("fw")] })).c.view().slots[3]?.state).toBe("empty");
  });

  test("tags: initials of 3 words, then letters of the last word; collisions on a page take the slot number", () => {
    expect(taskTag("Firmware v5")).toBe("FV5");
    expect(taskTag("Docs pass")).toBe("DPA");
    expect(taskTag("Firmware")).toBe("FIR");
    expect(taskTag("Über café run")).toBe("UCR");
    expect(taskTag("!!!")).toBe("?");
    expect(taskTag("a b")).toBe("AB");
    expect(taskTags(["Docs pass", null, "Dogs park", "Dots pal"])).toEqual(["DPA", null, "DP3", "DP4"]);
  });

  test("PINNED: every session pin across scope, those that need you first; task pins take no white key; KNOB2 inert", async () => {
    const r = await rig({ pins: [sk("quiet", "quiet-1"), sk("fw", "fw-b"), tk("fw"), sk("voice", "voice-q")] });
    await key(r, 3);
    expect(toast(r)).toBe("Show: pinned (3)");
    expect(white(r)).toEqual([sk("voice", "voice-q"), sk("fw", "fw-b"), sk("quiet", "quiet-1")]);
    expect(v(r).legend).toEqual(["SHOW", "", "TASK", "TALK"]);
    expect(v(r).title).toBe("PINNED 3");
    const repo = r.c.state.repoFilter;
    await turn(r, "K2", 1);
    expect(r.c.state.repoFilter).toBe(repo);
  });

  test("NEEDS YOU: T0-T3 in tier order; title and chip; tapping it again goes back to ALL", async () => {
    const r = await rig();
    await key(r, 5);
    expect(toast(r)).toBe("Needs you (3)");
    expect(white(r)).toEqual([sk("voice", "voice-q"), sk("fw", "fw-a"), sk("alpha", "alpha-1")]);
    expect(v(r).title).toBe("NEEDS YOU 3");
    expect(v(r).slots[5]?.chosen).toBe(true);
    expect(v(r).slots[1]?.chosen).toBe(false);
    await key(r, 5);
    expect(toast(r)).toBe("Show: all");
    expect(r.c.state.split.chosen).toBe("all");
  });

  test("tapping ALL when it is chosen does nothing; empty task slots do nothing", async () => {
    const r = await rig();
    const before = white(r);
    expect(await key(r, 1)).toEqual([]);
    expect(white(r)).toEqual(before);
    await press(r, "OCT_UP");
    await press(r, "OCT_UP");
    expect(r.c.state.split.taskPage).toBe(1);
    expect(v(r).slots[13]?.state).toBe("empty");
    expect(await key(r, 13)).toEqual([]);
  });

  test("a task: its sessions, pinned first; the chosen task again goes back to ALL; title cut at a word", async () => {
    const r = await rig({ pins: [sk("ten", "ten-5")] });
    await key(r, 25); // task slot 8 of page 1: "eight"
    expect(r.c.state.split).toMatchObject({ chosen: "task", task: tk("eight") });
    expect(toast(r)).toBe("Task: Task eight");
    await press(r, "OCT_UP");
    await press(r, "OCT_UP");
    expect(r.c.state.split.taskPage).toBe(1);
    // the chosen task is on page 1: no chosen key on page 2, the whites stay
    expect(v(r).slots.some((s) => s.chosen)).toBe(false);
    expect(white(r)).toEqual([sk("eight", "eight-1")]);
    await key(r, 10); // page 2 slot 2: ten
    expect(white(r)[0]).toBe(sk("ten", "ten-5"));
    expect(white(r)).toHaveLength(7);
    expect(v(r).title).toBe("Task ten 7");
    await key(r, 10);
    expect(r.c.state.split.chosen).toBe("all");
  });

  test("KNOB1 cycles ACTIVE -> RECENT -> ALL (no PINNED); legend (KNOB3 TASK since 2026-11-19)", async () => {
    const r = await rig();
    expect(v(r).legend).toEqual(["SHOW", "REPO", "TASK", "TALK"]);
    await turn(r, "K1", 1);
    expect(r.c.state.scope).toBe("recent");
    expect(r.c.state.taskRow.keys).toContain(tk("quiet"));
    await turn(r, "K1", 1);
    expect(r.c.state.scope).toBe("all");
    await turn(r, "K1", 1);
    expect(r.c.state.scope).toBe("all");
    expect(r.c.state.taskFilter).toBeNull();
  });

  test("switching to SPLIT under PINNED: scope ACTIVE, choice PINNED", async () => {
    const r = await rig({ keys: "ranked", pins: [tk("fw")] });
    for (let i = 0; i < 3; i++) await turn(r, "K1", 1);
    expect(r.c.state.scope).toBe("pinned");
    r.c.setSettings({ keys: "split" });
    expect(r.c.state.scope).toBe("active");
    expect(r.c.state.split.chosen).toBe("pinned");
    expect(v(r).slots[3]?.chosen).toBe(true);
  });

  test("Grouped in SPLIT: groups never fold, a chosen task is one group with its header", async () => {
    const r = await rig({ layout: "grouped" });
    await turn(r, "K1", 1); // RECENT: the quiet task would fold in RANKED
    expect(white(r)).toContain(sk("quiet", "quiet-1"));
    expect(white(r).some((k) => k !== null && k.split("/").length === 4)).toBe(false);
    await key(r, 10); // fw
    const view = v(r);
    expect(view.slots[0]?.row).toEqual({ indent: 1, start: true, task: false });
    expect(view.slots[0]?.head?.title).toContain("Firmware v5");
    expect(view.slots[2]?.row?.start).toBe(false);
    expect(view.slots[1]?.row).toEqual({ indent: 0, start: false, task: false });
    expect(view.slots[1]?.head).toBeUndefined();
  });

  test("empty white list: the bubble says why (NEEDS YOU, PINNED, a task or ALL)", async () => {
    const r = await rig({ more: [] });
    await key(r, 3);
    expect(v(r).text?.slice(0, 2)).toEqual([{ style: "heading", text: "No pins yet" }, { style: "muted", text: "hold a key to pin" }]);
  });

  test("Buddy bubble has 4 body rows; nothing selected the hint names ARP", async () => {
    const r = await rig();
    expect(v(r).detail.lines[3]).toBe("SCL help  ARP setup");
    await turn(r, "SELECT", 1);
    const t = v(r).text ?? [];
    expect(t.length).toBe(12);
    expect(t.slice(6).every((x) => x.text === "")).toBe(true);
  });
});

describe("SPLIT gestures, freeze and pins (docs/ui-v3.md sections 10.3-10.4)", () => {
  test("SELECT and ALGORITHM move over white keys only; the selection never lands on a black key", async () => {
    const r = await rig();
    const seen = new Set<number>();
    for (let i = 0; i < 20; i++) {
      await turn(r, "SELECT", 1);
      v(r).slots.forEach((s, k) => s.selected && seen.add(k));
    }
    for (const k of seen) expect(WHITE_KEYS).toContain(k as never);
    await turn(r, "ALGORITHM", 1);
    v(r).slots.forEach((s, k) => s.selected && expect(WHITE_KEYS).toContain(k as never));
  });

  test("hold a task: pin, unpin, task pins capped apart from session pins (200 each); the row re-sorts with the page holding it", async () => {
    const r = await rig();
    await key(r, 15); // dogs (slot 4)
    expect(toast(r)).toBe("Task: Dogs park");
    await key(r, 15, "long");
    expect(toast(r)).toBe("Task pinned");
    expect(r.c.state.pins).toEqual([tk("dogs")]);
    expect(r.c.state.taskRow.keys[0]).toBe(tk("dogs"));
    expect(v(r).slots[8]).toMatchObject({ label: "DPA", pinned: true, chosen: true });
    await key(r, 8, "long");
    expect(toast(r)).toBe("Task unpinned");
    expect(r.c.state.pins).toEqual([]);
    // 200 session pins do not block a task pin; 200 task pins do (the old shared limit of 9 is gone)
    const r2 = await rig();
    const fakeSessions = Array.from({ length: 200 }, (_, i) => sk("t", `s${i}`));
    r2.c.state = { ...r2.c.state, pins: fakeSessions };
    await key(r2, 10, "long");
    expect(toast(r2)).toBe("Task pinned");
    const fakeTasks = Array.from({ length: 200 }, (_, i) => tk(`t${i}`));
    r2.c.state = { ...r2.c.state, pins: [...fakeSessions, ...fakeTasks] };
    await key(r2, 13, "long");
    expect(toast(r2)).toBe("Task pins full (200)");
    expect(r2.c.state.pins).toHaveLength(400);
  });

  test("unpinning a task on page 2 keeps the task page on the page holding it", async () => {
    const r = await rig();
    await press(r, "OCT_UP");
    await press(r, "OCT_UP");
    expect(r.c.state.split.taskPage).toBe(1);
    await key(r, 8, "long"); // nine: pinned -> row first, page 1
    expect(r.c.state.split.taskPage).toBe(0);
    expect(r.c.state.taskRow.keys[0]).toBe(tk("nine"));
  });

  test("double tap a task opens its first session (white-key order) on the Mac; no focus capability: nothing", async () => {
    const r = await rig();
    const acts = await key(r, 10, "double"); // fw
    expect(acts).toEqual([{ type: "focus", ref: { ...B, projectId: P, taskId: "fw", sessionId: "fw-a" } }]);
    expect(r.c.state.split.chosen).toBe("all"); // a double never chooses
    const caps = { ...allSupported("code"), focus: { supported: false, verified: "code" as const } };
    const r2 = await rig({ adapter: new MockAdapter(fixtureToSnapshot(fixture()), { capabilities: caps }) });
    expect(await key(r2, 10, "double")).toEqual([]);
  });

  test("filters ignore double and long", async () => {
    const r = await rig();
    expect(await key(r, 3, "double")).toEqual([]);
    expect(await key(r, 5, "long")).toEqual([]);
    expect(r.c.state.pins).toEqual([]);
  });

  test("freeze: a state change updates keys in place; HOME re-sorts both rows; the task page follows the chosen task", async () => {
    const r = await rig();
    await press(r, "OCT_UP");
    await press(r, "OCT_UP");
    await key(r, 10); // ten (page 2)
    const before = white(r);
    r.a.setState({ ...B, projectId: P, taskId: "ten", sessionId: "ten-7" }, "waiting_input");
    expect(white(r)).toEqual(before);
    expect(r.c.state.taskRow.keys).toEqual(ROW);
    await press(r, "HOME");
    expect(toast(r)).toBe("Sorted");
    expect(r.c.state.taskRow.keys.indexOf(tk("ten"))).toBe(1); // T1 now: after voice (T1 since earlier)
    expect(r.c.state.split.taskPage).toBe(0);
    expect(white(r)[0]).toBe(sk("ten", "ten-7"));
  });

  test("a task that loses its last session keeps its key, calm, until the re-sort; then the choice falls back to ALL", async () => {
    const r = await rig();
    await key(r, 15); // dogs
    r.a.removeSession({ ...B, projectId: P, taskId: "dogs", sessionId: "dogs-1" });
    r.c.pruneStale(true);
    expect(r.c.state.taskRow.keys[3]).toBe(tk("dogs"));
    expect(v(r).slots[15]?.state).toBe("disconnected");
    await press(r, "HOME");
    expect(r.c.state.taskRow.keys).not.toContain(tk("dogs"));
    expect(r.c.state.split.chosen).toBe("all");
  });

  test("arrivals: a new session needing you in the current choice takes G5; another choice's never arrives", async () => {
    const r = await rig();
    expect(white(r)[15]).toBeNull();
    r.a.upsertSession(parseOk(sess("fw", "fw-new", "failed", 0, { createdAt: RIG_EPOCH + 5_000 })));
    expect(white(r)[15]).toBe(sk("fw", "fw-new"));
    expect(v(r).slots[26]?.label).toBe("fw-new");
    await key(r, 8); // voice chosen
    r.a.upsertSession(parseOk(sess("docs", "docs-new", "failed", 0, { createdAt: RIG_EPOCH + 6_000 })));
    expect(white(r)).not.toContain(sk("docs", "docs-new"));
  });

  test("auto re-sort after 60 s quiet re-sorts both rows keeping both page indices (clamped)", async () => {
    const r = await rig();
    await press(r, "OCT_UP");
    await press(r, "OCT_UP");
    r.t.advance(OCT_DOUBLE_MS);
    r.a.setState({ ...B, projectId: P, taskId: "nine", sessionId: "nine-1" }, "waiting_input");
    expect(r.c.state.taskRow.keys).toEqual(ROW);
    r.t.advance(61_000);
    expect(r.c.tick()).toBe(true);
    expect(r.c.state.taskRow.keys.indexOf(tk("nine"))).toBeLessThan(3);
    expect(r.c.state.split.taskPage).toBe(1);
  });

  test("the Tasks view: a task tap goes to Sessions with that task chosen, on the task page that holds it", async () => {
    const r = await rig();
    await press(r, "EDIT");
    const tasks = r.c.state.layouts.tasks.slots;
    const k = tasks.indexOf(tk("ten"));
    await key(r, k);
    expect(v(r).view).toBe("sessions");
    expect(r.c.state.split).toMatchObject({ chosen: "task", task: tk("ten"), taskPage: 1 });
    expect(r.c.state.taskFilter).toBeNull();
  });

  test("DETAILS over SPLIT: a black tap chooses and the reader stays on its chat", async () => {
    const r = await rig();
    await turn(r, "SELECT", 1);
    await press(r, "LFO");
    expect(v(r).view).toBe("detail");
    await key(r, 5);
    expect(r.c.state.split.chosen).toBe("needs");
    expect(v(r).view).toBe("detail");
  });

  test("TALK new chat goes to the chosen task", async () => {
    const r = await rig();
    await key(r, 13); // alpha
    await turn(r, "K4", 1); // claude-chat
    const acts = await down(r, "REC");
    expect(acts[0]).toMatchObject({ type: "voiceStart", destination: { mode: "new-session", task: { taskId: "alpha" } } });
  });
});

describe("OCT single versus double (docs/ui-v3.md section 10.5)", () => {
  test("single: the white page turns 300 ms after release, once", async () => {
    const r = await rig();
    await press(r, "OCT_UP");
    expect(r.c.state.pages.sessions).toBe(0);
    r.t.advance(OCT_DOUBLE_MS - 1);
    expect(r.c.state.pages.sessions).toBe(0);
    r.t.advance(1);
    expect(r.c.state.pages.sessions).toBe(1);
    r.t.advance(5000);
    expect(r.c.state.pages.sessions).toBe(1);
    expect(r.c.state.split.taskPage).toBe(0);
  });

  test("double: a second press within 300 ms of the first release turns the task page (wraps), not the white page", async () => {
    const r = await rig();
    await press(r, "OCT_UP");
    r.t.advance(OCT_DOUBLE_MS);
    // (the single fired: one page)
    expect(r.c.state.pages.sessions).toBe(1);
    await press(r, "OCT_UP");
    r.t.advance(299);
    await press(r, "OCT_UP");
    expect(toast(r)).toBe("Tasks 2/2");
    expect(r.c.state.split.taskPage).toBe(1);
    r.t.advance(1000);
    expect(r.c.state.pages.sessions).toBe(1);
    await press(r, "OCT_DOWN");
    r.t.advance(100);
    await press(r, "OCT_DOWN");
    expect(r.c.state.split.taskPage).toBe(0);
    await press(r, "OCT_DOWN");
    await press(r, "OCT_DOWN");
    expect(toast(r)).toBe("Tasks 2/2");
    expect(r.c.state.split.taskPage).toBe(1); // wrapped
    expect(r.c.state.pages.sessions).toBe(1);
  });

  test("a second press after the window: two singles", async () => {
    const r = await rig();
    await press(r, "OCT_UP");
    r.t.advance(OCT_DOUBLE_MS + 1);
    await press(r, "OCT_DOWN");
    r.t.advance(OCT_DOUBLE_MS);
    expect(r.c.state.pages.sessions).toBe(0);
    expect(r.c.state.split.taskPage).toBe(0);
  });

  test("the other OCT within the window resolves the first press as a single first", async () => {
    const r = await rig();
    await press(r, "OCT_UP");
    await press(r, "OCT_DOWN");
    expect(r.c.state.pages.sessions).toBe(1); // OCT_UP single acted at once
    r.t.advance(OCT_DOUBLE_MS);
    expect(r.c.state.pages.sessions).toBe(0);
    expect(r.c.state.split.taskPage).toBe(0);
  });

  test("any other input while pending: the single first, then that input", async () => {
    const r = await rig();
    await press(r, "OCT_UP");
    await turn(r, "SELECT", 1);
    expect(r.c.state.octPending).toBeNull();
    // SELECT picked the first white of page 1 (the page turned first, then SELECT moved to the first live key)
    expect(r.c.state.pages.sessions).toBe(0);
    r.t.advance(1000);
    expect(r.c.state.split.taskPage).toBe(0);
  });

  test("a single press never pages twice and never pages both rows (a held press: pending until release)", async () => {
    const r = await rig();
    await down(r, "OCT_UP");
    r.t.advance(1000);
    expect(r.c.state.pages.sessions).toBe(0);
    await up(r, "OCT_UP");
    r.t.advance(OCT_DOUBLE_MS);
    expect(r.c.state.pages.sessions).toBe(1);
    r.t.advance(OCT_DOUBLE_MS * 4);
    expect(r.c.state.pages.sessions).toBe(1);
    expect(r.c.state.split.taskPage).toBe(0);
  });

  test("one task page: double OCT toasts No more tasks", async () => {
    const small: FixtureFile = { ...fixture(), sessions: fixture().sessions.filter((x) => ["voice", "fw"].includes(x.taskId)) };
    const one = await rig({ adapter: new MockAdapter(fixtureToSnapshot(small)) });
    expect(one.c.view().taskPages).toBe(1);
    await press(one, "OCT_UP");
    await press(one, "OCT_UP");
    expect(toast(one)).toBe("No more tasks");
    expect(one.c.state.split.taskPage).toBe(0);
    expect(one.c.state.pages.sessions).toBe(0);
  });

  test("RANKED keeps the immediate page turn", async () => {
    const r = await rig({ keys: "ranked", more: Array.from({ length: 20 }, (_, i) => sess("ten", `x-${i}`, "working", 150_000 + i)) });
    await down(r, "OCT_UP");
    expect(r.c.state.pages.sessions).toBe(1);
    expect(r.c.state.octPending).toBeNull();
  });
});

describe("keys byte per view and empty lists (docs/ui-v3.md sections 10.6 and 10.9)", () => {
  test("keys stays split in DETAILS and SETTINGS opened over SPLIT Sessions; TO DO and Tasks are ranked (flat 27)", async () => {
    const r = await rig();
    await turn(r, "SELECT", 1);
    await press(r, "LFO");
    expect([v(r).view, v(r).keys]).toEqual(["detail", "split"]);
    await press(r, "LFO");
    await down(r, "ARP");
    r.t.advance(ARP_HOLD_MS);
    await up(r, "ARP");
    expect([v(r).view, v(r).keys, v(r).taskPages]).toEqual(["settings", "split", 2]);
    await press(r, "LFO");
    await press(r, "GLO");
    expect([v(r).view, v(r).keys]).toEqual(["inbox", "ranked"]);
    expect(v(r).taskPages).toBeUndefined();
    expect(v(r).slots.some((x) => x.chosen)).toBe(false);
    await press(r, "EDIT");
    expect(v(r).keys).toBe("ranked");
  });

  test("NEEDS YOU with nothing: Nothing needs you / tap ALL or a task; YOU chip empty (LED off)", async () => {
    const quiet: FixtureFile = { ...fixture(), sessions: fixture().sessions.filter((x) => x.observed.state === "working") };
    const r = await rig({ adapter: new MockAdapter(fixtureToSnapshot(quiet)) });
    expect(v(r).slots[5]?.state).toBe("empty");
    await key(r, 5);
    expect(toast(r)).toBe("Needs you (0)");
    expect(v(r).text?.slice(0, 2)).toEqual([{ style: "heading", text: "Nothing needs you" }, { style: "muted", text: "tap ALL or a task" }]);
    expect(v(r).title).toBe("NEEDS YOU 0");
  });

  test("ALL with nothing in scope: No chats here / KNOB1 shows more", async () => {
    const idle: FixtureFile = { ...fixture(), sessions: [sess("quiet", "quiet-1", "idle", 200_000)] };
    const r = await rig({ adapter: new MockAdapter(fixtureToSnapshot(idle)) });
    expect(v(r).text?.slice(0, 2)).toEqual([{ style: "heading", text: "No chats here" }, { style: "muted", text: "KNOB1 shows more" }]);
    expect(v(r).taskPages).toBe(1);
    expect([8, 10, 13, 15, 17, 20, 22, 25].every((k) => v(r).slots[k]?.state === "empty")).toBe(true);
  });
});

describe("persistence and protocol fallback (docs/ui-v3.md sections 10.6 and 10.10)", () => {
  test("the saved choice and task page are restored; a chosen task gone after the first snapshot falls back to ALL", async () => {
    const r = await rig({ split: { chosen: "task", task: tk("ten"), taskPage: 1 } });
    expect(r.c.state.split).toEqual({ chosen: "task", task: tk("ten"), taskPage: 1 });
    expect(white(r)).toHaveLength(7);
    const gone = await rig({ split: { chosen: "task", task: tk("nope"), taskPage: 5 } });
    expect(gone.c.state.split).toEqual({ chosen: "all", task: null, taskPage: 1 });
    gone.t.advance(1000);
    expect(gone.splitSaved.at(-1)).toEqual({ chosen: "all", task: null, taskPage: 1 });
  });

  test("choice changes are saved at most once a second, trailing", async () => {
    const r = await rig();
    await key(r, 5);
    await key(r, 3);
    await key(r, 8);
    expect(r.splitSaved).toEqual([]);
    r.t.advance(1000);
    expect(r.splitSaved).toEqual([{ chosen: "task", task: tk("voice"), taskPage: 0 }]);
  });

  test("validSplit refuses malformed restored values", () => {
    expect(validSplit({ chosen: "task", task: null, taskPage: 2 })).toEqual({ chosen: "all", task: null, taskPage: 2 });
    expect(validSplit({ chosen: "bogus", taskPage: -1 })).toEqual({ chosen: "all", task: null, taskPage: 0 });
    expect(validSplit({ chosen: "needs", task: tk("x"), taskPage: 3 })).toEqual({ chosen: "needs", task: null, taskPage: 3 });
  });

  test("protocol 5 with a saved Split: Sessions is RANKED, no keys byte; reaching 6 lays SPLIT out, back to 5 RANKED again", async () => {
    const r = await rig({ proto: 5 });
    expect(v(r).keys).toBeUndefined();
    expect(v(r).slots.some((s) => s.chosen)).toBe(false);
    expect(r.c.state.layouts.sessions.pageSize).toBeUndefined();
    const ranked = JSON.stringify(v(r));
    r.c.setProtocol(6);
    expect(v(r).keys).toBe("split");
    expect(r.c.state.layouts.sessions.pageSize).toBe(16);
    r.c.setProtocol(5);
    expect(JSON.stringify(v(r))).toBe(ranked);
  });

  test("RANKED with protocol 6: keys ranked and otherwise exactly the version 5 view", async () => {
    const a = await rig({ keys: "ranked", proto: 5 });
    const b = await rig({ keys: "ranked", proto: 6 });
    const { keys, ...rest } = v(b);
    expect(keys).toBe("ranked");
    expect(JSON.stringify(rest)).toBe(JSON.stringify(v(a)));
  });
});

describe("review: the choice survives a backend drop, early input and shutdown (docs/ui-v3.md section 10.10)", () => {
  test("HOME while the backend link is down keeps the chosen task (no fallback before a full snapshot)", async () => {
    const r = await rig({ split: { chosen: "task", task: tk("ten"), taskPage: 1 } });
    r.a.dropConnection();
    await press(r, "HOME");
    expect(r.c.state.split).toEqual({ chosen: "task", task: tk("ten"), taskPage: 1 });
    r.t.advance(1000);
    expect(r.splitSaved).toEqual([]);
    await r.c.reconnect();
    await press(r, "HOME");
    expect(r.c.state.split).toEqual({ chosen: "task", task: tk("ten"), taskPage: 1 });
  });

  test("input before the first snapshot does not drop the restored task; the snapshot restores it", async () => {
    const a = new MockAdapter(fixtureToSnapshot(fixture()));
    const t = new FakeTimers();
    const splitSaved: SplitState[] = [];
    const c = new AgentConsole({
      adapter: a,
      timers: t,
      now: () => RIG_EPOCH + t.now,
      layouts: { sessions: "buddy" },
      settings: { keys: "split" },
      split: { chosen: "task", task: tk("ten"), taskPage: 1 },
      onSplitChanged: (s) => splitSaved.push(s),
    });
    c.setProtocol(6);
    await c.handleInput({ kind: "button", button: "HOME", edge: "down" });
    await c.handleInput({ kind: "button", button: "HOME", edge: "up" });
    expect(c.state.split).toEqual({ chosen: "task", task: tk("ten"), taskPage: 1 });
    await c.start();
    expect(c.state.split).toEqual({ chosen: "task", task: tk("ten"), taskPage: 1 });
    expect(c.state.taskRow.keys).toEqual(ROW);
    expect(c.state.layouts.sessions.slots).toHaveLength(7);
    t.advance(2000);
    expect(splitSaved).toEqual([]);
  });

  test("reaching protocol 6 under PINNED before the first snapshot still moves to scope ACTIVE, choice PINNED", async () => {
    const a = new MockAdapter(fixtureToSnapshot(fixture()));
    const t = new FakeTimers();
    const c = new AgentConsole({ adapter: a, timers: t, now: () => RIG_EPOCH + t.now, layouts: { sessions: "buddy" }, settings: { keys: "split" } });
    c.setProtocol(5);
    for (let i = 0; i < 3; i++) await c.handleInput({ kind: "encoder", encoder: "K1", delta: 1 });
    expect(c.state.scope).toBe("pinned");
    c.setProtocol(6);
    expect(c.state.scope).toBe("active");
    expect(c.state.split.chosen).toBe("pinned");
  });

  test("stop() saves a pending choice change at once and leaves no gesture timer behind", async () => {
    const r = await rig();
    await key(r, 5);
    await down(r, "ARP");
    expect(r.splitSaved).toEqual([]);
    await r.c.stop();
    expect(r.splitSaved).toEqual([{ chosen: "needs", task: null, taskPage: 0 }]);
    r.t.advance(5000);
    expect(r.splitSaved).toHaveLength(1);
    expect(r.c.state.settingsFrom).toBeNull();
  });
});

describe("review: a chosen task's attention sessions count as seen at layout (docs/ux-v2.md section 3.4)", () => {
  test("choosing a task that is not pinned marks its T0-T3 sessions seen, so none is promoted to G5 later", async () => {
    const r = await rig();
    await key(r, 10); // fw: fw-a failed (T2), fw-b working
    expect(r.c.state.split).toMatchObject({ chosen: "task", task: tk("fw") });
    expect(r.c.state.layouts.sessions.seen).toContain(sk("fw", "fw-a"));
    expect(r.c.state.layouts.sessions.seen).not.toContain(sk("fw", "fw-b"));
  });
});

describe("SPLIT KNOB3 steps the task row (operator brief 2026-11-19, docs/ui-v3.md section 10.9)", () => {
  /** Let the knob rest: the white keys follow KNOB3_REST_MS (300 ms) after the last turn. */
  const rest = (r: R): void => r.t.advance(300);
  const titleOf = (id: string): string => TASKS.find(([t]) => t === id)?.[1] ?? "";

  test("cycle order is the task row order, one task per detent, wrapping at both ends; toast and legend", async () => {
    const r = await rig();
    expect(v(r).legend[2]).toBe("TASK");
    const seen: string[] = [];
    for (let i = 0; i < ROW.length; i++) {
      await turn(r, "K3", 1);
      seen.push(r.c.state.split.task ?? "");
      expect(toast(r)).toBe(`Task: ${titleOf(seen.at(-1)!.split("/").at(-1)!)}`.slice(0, 20).trimEnd());
    }
    expect(seen).toEqual(ROW);
    await turn(r, "K3", 1); // past the last task: the first again
    expect(r.c.state.split).toMatchObject({ chosen: "task", task: ROW[0], taskPage: 0 });
    await turn(r, "K3", -1); // before the first: the last
    expect(r.c.state.split).toMatchObject({ chosen: "task", task: ROW[9], taskPage: 1 });
    expect(r.c.state.taskFilter).toBeNull();
  });

  test("the task page follows the chosen task across the page edge, both ways; the chosen key moves at once", async () => {
    const r = await rig({ split: { chosen: "task", task: tk("eight"), taskPage: 0 } });
    expect(slot(r, 25)?.chosen).toBe(true); // eight: slot 8 of page 1
    await turn(r, "K3", 1);
    expect(r.c.state.split).toMatchObject({ task: tk("nine"), taskPage: 1 });
    expect(v(r).taskPage).toBe(1);
    expect(slot(r, 8)?.chosen).toBe(true); // nine: slot 1 of page 2, before the knob rests
    expect(slot(r, 25)?.state).toBe("empty");
    await turn(r, "K3", -1);
    expect(r.c.state.split).toMatchObject({ task: tk("eight"), taskPage: 0 });
    expect(slot(r, 25)?.chosen).toBe(true);
  });

  test("first turn from ALL, PIN or YOU: the first task clockwise, the last counter-clockwise", async () => {
    for (const [filterKey, dir, want, page] of [
      [1, 1, ROW[0], 0],
      [1, -1, ROW[9], 1],
      [3, 1, ROW[0], 0],
      [3, -1, ROW[9], 1],
      [5, 1, ROW[0], 0],
      [5, -1, ROW[9], 1],
    ] as const) {
      const r = await rig({ pins: [sk("fw", "fw-b")] });
      if (filterKey !== 1) await key(r, filterKey);
      expect(r.c.state.split.chosen).toBe(FILTERS[filterKey]!);
      await turn(r, "K3", dir);
      expect(r.c.state.split).toEqual({ chosen: "task", task: want!, taskPage: page });
    }
  });

  test("debounce: the white keys relayout once per pause, KNOB3_REST_MS after the last turn", async () => {
    const r = await rig();
    const layouts = new Set<unknown>([r.c.state.layouts.sessions]);
    r.c.onView(() => layouts.add(r.c.state.layouts.sessions));
    const before = white(r);
    for (let i = 0; i < 3; i++) {
      await turn(r, "K3", 1); // voice, fw, alpha
      r.t.advance(100);
    }
    expect(r.c.state.split.task).toBe(tk("alpha"));
    expect(white(r)).toEqual(before); // still the ALL list
    expect(slot(r, 13)?.chosen).toBe(true); // alpha's black key is chosen at once
    r.t.advance(199);
    expect(white(r)).toEqual(before);
    r.t.advance(1);
    expect(white(r)).toEqual([sk("alpha", "alpha-1")]);
    expect(layouts.size).toBe(2); // one relayout for the whole pause
    expect(r.c.state.knob3At).toBeNull();
    r.t.advance(1000);
    expect(layouts.size).toBe(2);
    // A second pause: one more relayout.
    await turn(r, "K3", 1);
    await turn(r, "K3", 1);
    rest(r);
    expect(white(r)).toEqual([sk("docs", "docs-1")]);
    expect(layouts.size).toBe(3);
  });

  test("any other input before the knob rests lays the white keys out first (a white key never acts on the old list)", async () => {
    const r = await rig();
    await turn(r, "K3", 1); // voice
    const acts = await turn(r, "SELECT", 1);
    expect(white(r)).toEqual([sk("voice", "voice-q")]);
    expect(acts).toEqual([{ type: "select", key: sk("voice", "voice-q") }]);
    expect(r.c.state.knob3At).toBeNull();
    const laid = r.c.state.layouts.sessions;
    r.t.advance(300); // the rest timer was dropped: no second relayout
    expect(r.c.state.layouts.sessions).toBe(laid);
  });

  test("the chosen task and its page persist (trailing save) and are restored", async () => {
    const r = await rig();
    for (let i = 0; i < 9; i++) await turn(r, "K3", 1); // ... nine (page 2)
    rest(r);
    r.t.advance(1000);
    expect(r.splitSaved.at(-1)).toEqual({ chosen: "task", task: tk("nine"), taskPage: 1 });
    const back = await rig({ split: r.splitSaved.at(-1) });
    expect(back.c.state.split).toEqual({ chosen: "task", task: tk("nine"), taskPage: 1 });
    expect(white(back)).toEqual([sk("nine", "nine-1")]);
  });

  test("unchanged: black taps choose, the chosen task again goes to ALL, double OCT keeps the choice", async () => {
    const r = await rig();
    await turn(r, "K3", 1); // voice
    rest(r);
    await key(r, 8); // the chosen task again: ALL
    expect(r.c.state.split.chosen).toBe("all");
    await turn(r, "K3", -1); // ten, page 2
    await press(r, "OCT_DOWN");
    await press(r, "OCT_DOWN");
    expect(r.c.state.split).toMatchObject({ chosen: "task", task: tk("ten"), taskPage: 0 });
    expect(white(r)).toHaveLength(7);
  });

  test("not in DETAILS over SPLIT; with no task on the row KNOB3 does nothing", async () => {
    const r = await rig();
    await turn(r, "SELECT", 1);
    await press(r, "LFO");
    expect(v(r).view).toBe("detail");
    expect(await turn(r, "K3", 1)).toEqual([]);
    expect(r.c.state.split.chosen).toBe("all");
    const empty = await rig({ adapter: new MockAdapter(fixtureToSnapshot({ ...fixture(), sessions: [] })) });
    await turn(empty, "K3", 1);
    expect(empty.c.state.split.chosen).toBe("all");
    expect(empty.c.state.notice).toBeNull();
  });

  test("RANKED is unchanged: KNOB3 cycles the TASK filter (all reachable again), no SPLIT choice, no rest timer", async () => {
    const r = await rig({ keys: "ranked" });
    expect(v(r).legend).toEqual(["SHOW", "REPO", "TASK", "TALK"]);
    await turn(r, "K3", 1);
    expect(r.c.state.taskFilter).toBe(tk("voice"));
    expect(toast(r)).toBe("Task: Voice composer");
    expect(r.c.state.split.chosen).toBe("all");
    expect(r.c.state.knob3At).toBeNull();
    await turn(r, "K3", -1);
    expect(r.c.state.taskFilter).toBeNull();
    expect(toast(r)).toBe("Task: all");
  });
});

const FILTERS: Record<number, SplitState["chosen"]> = { 1: "all", 3: "pinned", 5: "needs" };
