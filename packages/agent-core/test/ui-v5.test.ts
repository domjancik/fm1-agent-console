// Protocol version 5 host content (docs/ui-v3.md section 8): the LIST layout of Sessions and TO DO. SEQ toggles it per
// view, the slots carry a row title and age, the header is one 24-column line, and version 4 output stays as it was.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { capabilitiesFrom } from "../src/capabilities";
import { AgentConsole } from "../src/console";
import { DEFAULT_SCREEN } from "../src/context";
import { HELP_LINE_MAX, HELP_TEXT } from "../src/control-map";
import { LIST_HEAD_COLS, LIST_NONE_SELECTED, listHeadRows, NOTICE, ROW_AGE_MAX, ROW_TITLE_MAX, rowAge, rowTitle } from "../src/copy";
import type { SessionDetails } from "../src/types";
import { keyOf, mockFrom, rig, RIG_EPOCH, slotOf, FakeTimers, type Rig } from "./helpers";

const press = (r: Rig, button: string) => r.console.handleInput({ kind: "button", button: button as never, edge: "down" });
const turn = (r: Rig, encoder: string, delta = 1) => r.console.handleInput({ kind: "encoder", encoder: encoder as never, delta });
const tap = (r: Rig, k: number) => r.console.handleInput({ kind: "key", key: k, gesture: "single" });

const LONG = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
const DETAILS: SessionDetails = { lastMessage: `Renamed parseDeviceFrame to decodeFrame in 4 files. ${LONG}`, lastMessageAt: RIG_EPOCH - 120_000 };

async function v5(proto = 5): Promise<Rig> {
  const r = await rig("mixed", { scope: "recent" });
  // These are the section 8 tests (Buddy <-> List); since section 9 Sessions defaults to Grouped.
  r.console.setLayouts({ sessions: "buddy" });
  r.console.setProtocol(proto);
  const e = r.console.registry.get(keyOf(r, "s-claude-fw"));
  if (!e) throw new Error("missing");
  r.adapter.upsertSession({ ...e.session, details: DETAILS });
  await tap(r, slotOf(r, "s-claude-fw"));
  return r;
}

describe("list copy (docs/ui-v3.md section 8.4 and 8.6)", () => {
  test("row title: ASCII, cut at a word to 20, (untitled) when empty; age capped at 3", () => {
    expect(rowTitle("Voice tests for the push-to-talk path")).toBe("Voice tests for the");
    expect(rowTitle("")).toBe("(untitled)");
    expect(rowTitle("café build")).toBe("caf build");
    expect(rowAge(0)).toBe("now");
    expect(rowAge(12 * 60_000)).toBe("12m");
    expect(rowAge(200 * 7 * 86_400_000)).toBe("99w");
    for (const ms of [0, 59_000, 3_600_000, 47 * 3_600_000, 13 * 86_400_000, 99 * 7 * 86_400_000]) expect(rowAge(ms).length).toBeLessThanOrEqual(ROW_AGE_MAX);
  });

  test("header rows: caption, the line at the scroll step, the next line or empty", () => {
    const lines = ["one", "two", "three"].map((text) => ({ style: "body" as const, text }));
    expect(listHeadRows("Working, 2m", lines, 0).map((r) => r.text)).toEqual(["Working, 2m", "one", "two"]);
    expect(listHeadRows("Working, 2m", lines, 2).map((r) => r.text)).toEqual(["Working, 2m", "three", ""]);
    expect(listHeadRows("Working, 2m", lines, 99).map((r) => r.text)).toEqual(["Working, 2m", "three", ""]);
    expect(LIST_NONE_SELECTED.length).toBe(LIST_HEAD_COLS);
  });
});

describe("version 5 view (docs/ui-v3.md section 8.6)", () => {
  test("every slot carries a title <= 20 and an age <= 3; empty slots carry empty strings", async () => {
    const r = await v5();
    const v = r.console.view();
    expect(v.layout).toBe("buddy");
    for (const s of v.slots) {
      expect(typeof s.title).toBe("string");
      expect(typeof s.age).toBe("string");
      expect(s.title?.length ?? 99).toBeLessThanOrEqual(ROW_TITLE_MAX);
      expect(s.age?.length ?? 99).toBeLessThanOrEqual(ROW_AGE_MAX);
      if (s.state === "empty") expect([s.title, s.age]).toEqual(["", ""]);
      else expect(s.title).not.toBe("");
    }
  });

  test("version 4 output is unchanged: no layout, no row fields, the same frames as before", async () => {
    const r4 = await v5(4);
    const v4 = r4.console.view();
    expect(v4.layout).toBeNull();
    for (const s of v4.slots) expect("title" in s || "age" in s).toBe(false);
    // Version 5 in Buddy differs only by the row fields, the layout byte and the SEQ hint pair.
    r4.console.setProtocol(5);
    const v5v = r4.console.view();
    expect(v5v.text).toEqual(v4.text);
    expect(v5v.slots.map(({ title: _t, age: _a, ...rest }) => rest)).toEqual(v4.slots);
    expect(v5v.detail.lines.slice(0, 3)).toEqual(v4.detail.lines.slice(0, 3));
  });

  test("TO DO defaults to List (Sessions to Grouped since section 9); the layout byte is buddy in every other view", async () => {
    expect(DEFAULT_SCREEN).toEqual({ sessions: "grouped", inbox: "list" });
    const r = await v5();
    expect(r.console.view().layout).toBe("buddy");
    await press(r, "GLO");
    expect(r.console.view().view).toBe("inbox");
    expect(r.console.view().layout).toBe("list");
    await press(r, "EDIT");
    expect(r.console.view().layout).toBe("buddy");
  });

  test("List header: caption, one line wrapped at 24, the next line; rows 3-11 empty; nothing selected says how", async () => {
    const r = await v5();
    await press(r, "SEQ");
    const t = r.console.view().text ?? [];
    expect(t[0]?.style).toBe("heading");
    expect(t[1]?.text.startsWith("Renamed")).toBe(true);
    for (const row of t.slice(1, 3)) expect(row.text.length).toBeLessThanOrEqual(LIST_HEAD_COLS);
    expect(t[2]?.text).not.toBe("");
    for (const row of t.slice(3)) expect(row.text).toBe("");
    const none = new AgentConsole({ adapter: mockFrom("mixed"), timers: new FakeTimers(), now: () => RIG_EPOCH });
    await none.start();
    none.setProtocol(5);
    await none.handleInput({ kind: "button", button: "GLO", edge: "down" });
    const nt = none.view().text ?? [];
    expect(none.view().slots.every((s) => !s.selected)).toBe(true);
    expect(nt[1]).toEqual({ style: "muted", text: LIST_NONE_SELECTED });
    expect(nt[2]?.text).toBe("");
  });
});

describe("SEQ toggles Buddy and List (docs/ui-v3.md section 8.5)", () => {
  test("keeps the selection, the page and the frozen order; only the layout and the header change", async () => {
    const r = await v5();
    const before = r.console.state;
    const v0 = r.console.view();
    await press(r, "SEQ");
    const after = r.console.state;
    expect(after.screen.sessions).toBe("list");
    expect(after.layouts).toEqual(before.layouts);
    expect(after.pages).toEqual(before.pages);
    expect(r.console.registry.selection().key).toBe(keyOf(r, "s-claude-fw"));
    const v1 = r.console.view();
    expect(v1.layout).toBe("list");
    expect(v1.slots).toEqual(v0.slots);
    expect(v1.title).toBe(v0.title);
    // (section 9.1: List -> Grouped re-sorts, Grouped -> Buddy re-sorts back to the flat order)
    await press(r, "SEQ");
    expect(r.console.view().layout).toBe("grouped");
    await press(r, "SEQ");
    expect(r.console.view().layout).toBe("buddy");
    expect(r.console.view().text).toEqual(v0.text);
    expect(r.console.registry.selection().key).toBe(keyOf(r, "s-claude-fw"));
  });

  test("remembered per view: TO DO stays List while Sessions toggles", async () => {
    const r = await v5();
    await press(r, "SEQ");
    await press(r, "GLO");
    expect(r.console.view().layout).toBe("list");
    await press(r, "SEQ");
    expect(r.console.view().layout).toBe("buddy");
    await press(r, "HOME");
    expect(r.console.view().layout).toBe("list");
    expect(r.console.state.screen).toEqual({ sessions: "list", inbox: "buddy" });
  });

  test("does nothing with version 4 or lower; toasts in Tasks; nothing in DETAILS", async () => {
    const r4 = await v5(4);
    const s4 = r4.console.state;
    await press(r4, "SEQ");
    expect(r4.console.state.screen).toEqual(s4.screen);
    expect(r4.console.view().layout).toBeNull();
    const r = await v5();
    const screen = r.console.state.screen;
    await press(r, "EDIT");
    await press(r, "SEQ");
    expect(r.console.state.notice?.text).toBe(NOTICE.noListInTasks);
    expect(r.console.state.screen).toEqual(screen);
    await press(r, "HOME");
    await press(r, "LFO");
    expect(r.console.view().view).toBe("detail");
    await press(r, "SEQ");
    expect(r.console.state.screen).toEqual(screen);
    expect(r.console.view().layout).toBe("buddy");
  });

  test("SELECT still walks the frozen layout in List, and paging is unchanged", async () => {
    const r = await v5();
    await press(r, "SEQ");
    const order = r.console.state.layouts.sessions.slots.filter((k): k is string => k !== null && r.console.registry.get(k)?.stale === false);
    const from = order.indexOf(r.console.registry.selection().key ?? "");
    await turn(r, "SELECT", 1);
    expect(r.console.registry.selection().key).toBe(order[(from + 1) % order.length] ?? null);
    expect(r.console.view().layout).toBe("list");
  });

  test("PRESETS opens the reader from List (section 9.8); LFO returns to the List at the newest line", async () => {
    const r = await v5();
    await press(r, "SEQ");
    const line = (n: number) => r.console.view().text?.[n]?.text;
    const first = line(1);
    await turn(r, "PRESETS", 1);
    expect(r.console.view().view).toBe("detail");
    expect(r.console.view().page).toBe(0);
    await press(r, "LFO");
    expect(r.console.view().layout).toBe("list");
    expect(line(1)).toBe(first);
  });
});

describe("hint line and help (docs/ui-v3.md section 8.8)", () => {
  test("the SEQ pair is appended last and dropped first; nothing selected names SEQ and SCL", async () => {
    const r = await v5();
    const hint = r.console.view().detail.lines[3];
    expect(hint.length).toBeLessThanOrEqual(20);
    if (hint.includes("SEQ")) expect(hint.endsWith("SEQ list")).toBe(true);
    await press(r, "SEQ");
    const h2 = r.console.view().detail.lines[3];
    if (h2.includes("SEQ")) expect(h2.endsWith("SEQ group")).toBe(true);
    const none = new AgentConsole({ adapter: mockFrom("mixed"), timers: new FakeTimers(), now: () => RIG_EPOCH });
    await none.start();
    none.setProtocol(5);
    expect(none.view().slots.every((s) => !s.selected)).toBe(true);
    // (Sessions defaults to Grouped since section 9: SEQ goes to Buddy next)
    expect(none.view().detail.lines[3]).toBe("SEQ buddy  SCL help");
  });

  test("base5 (section 9.11): the SEQ cycle first, PRESETS read, pins; byte-equal to the spec block; every line fits", () => {
    expect(HELP_TEXT.base5[0]).toBe("HELP - SEQ buddy/list/group");
    expect<readonly string[]>(HELP_TEXT.base5.slice(3)).toEqual(HELP_TEXT.base4.slice(3));
    for (const l of HELP_TEXT.base5) expect(l.length).toBeLessThanOrEqual(HELP_LINE_MAX);
    const doc = readFileSync(fileURLToPath(new URL("../../../docs/ui-v3.md", import.meta.url)), "utf8");
    const sec9 = doc.slice(doc.indexOf("## 9."));
    const m = /FM1C_HELP_BASE5\s*\[\s*\d*\s*\]\s*=\s*\{([\s\S]*?)\};/.exec(sec9);
    const lines = [...(m?.[1] ?? "").matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => JSON.parse(`"${x[1]}"`) as string);
    expect(lines).toEqual([...HELP_TEXT.base5]);
  });

  const HEADER = fileURLToPath(new URL("../../../firmware/firmware/src/fm1c_help.h", import.meta.url));
  const src = existsSync(HEADER) ? readFileSync(HEADER, "utf8") : "";
  // The firmware's section 8 table predates section 9.11; the check runs once fm1c_help.h carries the new table.
  test.if(src.includes("HELP - SEQ buddy/list/group"))("firmware fm1c_help.h carries exactly FM1C_HELP_BASE5", () => {
    const m = /FM1C_HELP_BASE5\s*\[\s*\d*\s*\]\s*=\s*\{([\s\S]*?)\};/.exec(src);
    const lines = [...(m?.[1] ?? "").matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => JSON.parse(`"${x[1]}"`) as string);
    expect(lines).toEqual([...HELP_TEXT.base5]);
  });
});

describe("persistence hooks (docs/ui-v3.md section 8.7)", () => {
  test("layouts restore from options and every toggle reports both", async () => {
    const seen: unknown[] = [];
    const c = new AgentConsole({ adapter: mockFrom("mixed"), timers: new FakeTimers(), now: () => RIG_EPOCH, layouts: { inbox: "buddy" }, onLayoutsChanged: (l) => seen.push(l) });
    await c.start();
    expect(c.state.screen).toEqual({ sessions: "grouped", inbox: "buddy" });
    c.setProtocol(5);
    await c.handleInput({ kind: "button", button: "SEQ", edge: "down" });
    expect(seen).toEqual([{ sessions: "buddy", inbox: "buddy" }]);
    await c.handleInput({ kind: "button", button: "SEQ", edge: "up" });
    expect(seen).toHaveLength(1);
    const bad = new AgentConsole({ adapter: mockFrom("mixed"), layouts: { sessions: "grid" as never } });
    expect(bad.state.screen).toEqual(DEFAULT_SCREEN);
  });
});

describe("review fixes (2026-11-18)", () => {
  test("a confirm over the List is the version 4 bubble: wrapped at 28, the same rows as over Buddy", async () => {
    const b = await v5();
    const l = await v5();
    await press(l, "SEQ");
    await press(b, "ENV");
    await press(l, "ENV");
    expect(l.console.view().view).toBe("confirm");
    expect(l.console.view().layout).toBe("buddy");
    // (the List's line step does not carry into the 5-row bubble either: both start at the newest content)
    expect(l.console.view().text).toEqual(b.console.view().text);
    await press(l, "FX");
    expect(l.console.view().layout).toBe("list");
    for (const row of (l.console.view().text ?? []).slice(1, 3)) expect(row.text.length).toBeLessThanOrEqual(LIST_HEAD_COLS);
  });

  test("a TO DO row whose chat is gone (stale slot) has no age", async () => {
    const r = await rig("mixed", { scope: "recent" });
    r.console.setProtocol(5);
    await press(r, "GLO");
    const id = r.console.state.layouts.inbox.slots.find((x): x is string => x !== null);
    const item = id === undefined ? undefined : r.console.inbox.known(id);
    const e = item ? r.console.registry.get(item.sessionKey) : undefined;
    if (!item || !e) throw new Error("fixture has no inbox item");
    const at = r.console.state.layouts.inbox.slots.indexOf(id ?? "");
    r.adapter.removeSession(e.session.ref);
    r.console.pruneStale(true);
    const slot = r.console.view().slots[at];
    expect(slot?.stale).toBe(true);
    expect(slot?.title).not.toBe("");
    expect(slot?.age).toBe("");
  });

  test("the SEQ pair never squeezes the action hint into single spaces", async () => {
    const r = await rig("mixed", { scope: "recent", capabilities: capabilitiesFrom({ supported: true, verified: "code" }, { focus: { supported: false, reason: "n/a", verified: "none" } }) });
    r.console.setProtocol(5);
    await press(r, "GLO");
    const ids = r.console.state.layouts.inbox.slots;
    const k = ids.findIndex((x) => x !== null && !x.startsWith("approval:") && r.console.inbox.get(x) !== undefined);
    expect(k).toBeGreaterThanOrEqual(0);
    await tap(r, k);
    // Without the fix: "FX dismiss SEQ buddy" (20, single-spaced). Since section 9.11 the extras are PRESETS read,
    // then SEQ, each only while everything before it shows intact (or PRESETS read first when the bubble has more).
    expect(r.console.view().detail.lines[3]).toBe("FX dismiss");
    await press(r, "SEQ");
    expect(r.console.view().detail.lines[3]).toBe("FX dismiss  SEQ list");
  });
});
