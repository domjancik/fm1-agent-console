import { describe, expect, test } from "bun:test";
import { BACKEND_ACTIONS } from "../src/controller";
import { DETAIL_COLS, DETAIL_ROWS, detailRows, factLines, MAX_DETAIL_PAGES, NO_DETAILS, paginate, padPage } from "../src/details";
import type { SessionEntry } from "../src/registry";
import type { SessionDetails } from "../src/types";
import { parseDetails, parseSession } from "../src/validate";
import { keyOf, rig, RIG_EPOCH, slotOf, type Rig } from "./helpers";

const press = (r: Rig, button: string) => r.console.handleInput({ kind: "button", button: button as never, edge: "down" });
const turn = (r: Rig, encoder: string, delta = 1) => r.console.handleInput({ kind: "encoder", encoder: encoder as never, delta });
const tap = (r: Rig, k: number) => r.console.handleInput({ kind: "key", key: k, gesture: "single" });

const LONG = Array.from({ length: 90 }, (_, i) => `word${i}`).join(" ");
const DETAILS: SessionDetails = {
  lastMessage: `Renamed parseDeviceFrame to decodeFrame in 4 files. ${LONG}`,
  lastMessageAt: RIG_EPOCH - 120_000,
  activity: "editing view.ts",
  contextPct: 42,
  model: "opus-4-5",
  turns: 12,
  files: { count: 3, names: ["view.ts", "copy.ts", "focus.ts"] },
};

/** Gives a fixture session chat details, as the Traycer adapter does for the watched chat. */
function withDetails(r: Rig, sessionId: string, details: SessionDetails, summary?: string): void {
  const e = r.console.registry.get(keyOf(r, sessionId));
  if (!e) throw new Error("missing");
  r.adapter.upsertSession({ ...e.session, details, ...(summary ? { summary } : {}) });
}

async function opened(sessionId = "s-claude-fw"): Promise<Rig> {
  const r = await rig("mixed", { scope: "recent" });
  r.console.setDetailsPage(true);
  withDetails(r, sessionId, DETAILS, "editing view.ts");
  await tap(r, slotOf(r, sessionId));
  return r;
}

describe("detailRows (docs/ux-v2.md section 7.5)", () => {
  const entry = (details?: SessionDetails, state: "working" | "failed" | "approval_required" | "idle" = "working"): SessionEntry => ({
    key: "k",
    slot: 0,
    stale: false,
    session: {
      ref: { backendId: "b", hostId: "h", projectId: "p", taskId: "t", sessionId: "s" },
      title: "Rename the device frame parser and run the whole test suite",
      provider: "claude",
      runtime: "chat",
      workspace: "/w",
      createdAt: 0,
      lastActivityAt: 1_000,
      status: { observed: { state, at: 0 }, raw: null },
      ...(details ? { details } : {}),
    },
  }) as unknown as SessionEntry;

  test("heading, title, task, activity, facts, last message; every row <= 29 ASCII", () => {
    const rows = detailRows({ entry: entry({ ...DETAILS, lastMessageAt: 0 }), state: "working", taskTitle: "FM1 console", now: 61_000 });
    expect(rows[0]).toEqual({ style: "heading", text: "WORKING, 1m" });
    expect(rows.slice(1, 3).map((r) => r.text)).toEqual(["Rename the device frame", "parser and run the whole test"]);
    expect(rows[3]).toEqual({ style: "muted", text: "Task: FM1 console" });
    expect(rows[4]).toEqual({ style: "body", text: "Now: editing view.ts" });
    expect(rows.slice(5, 8)).toEqual([
      { style: "muted", text: "Claude opus-4-5" },
      { style: "muted", text: "Context 42%  turns 12" },
      { style: "muted", text: "Files 3: view.ts, copy.ts" },
    ]);
    expect(rows[8]).toEqual({ style: "heading", text: "Last message 1m" });
    expect(rows[9]?.text).toBe("Renamed parseDeviceFrame to");
    for (const r of rows) {
      expect(r.text.length).toBeLessThanOrEqual(DETAIL_COLS);
      expect(r.text).toMatch(/^[\x20-\x7e]*$/);
    }
    const pages = paginate(rows);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.length).toBeLessThanOrEqual(MAX_DETAIL_PAGES);
    expect(pages.every((p) => p.length <= DETAIL_ROWS)).toBe(true);
  });

  test("failed shows the error; approval shows the target and what it does", () => {
    const failed = detailRows({ entry: entry({ failure: "Tests failed: 3" }, "failed"), state: "failed", now: 2_000 });
    expect(failed.map((r) => r.text)).toContain("Error: Tests failed: 3");
    const approval = { id: "a", sessionRef: entry().session.ref, summary: "Bash", createdAt: 0 };
    const rows = detailRows({ entry: entry({ approval: { target: "rm -rf build/" } }, "approval_required"), state: "approval_required", approval, now: 3_600_000 });
    expect(rows[0]?.text).toBe("NEEDS APPROVAL, 1h");
    expect(rows.map((r) => r.text)).toContain("Approve: rm -rf build/");
    expect(rows.map((r) => r.text)).toContain("Bash");
  });

  test("no details: title rows and a muted note", () => {
    const rows = detailRows({ entry: entry(undefined, "idle"), state: "idle", now: 2_000 });
    expect(rows.at(-1)).toEqual({ style: "muted", text: NO_DETAILS });
    expect(paginate(rows)).toHaveLength(1);
    expect(padPage(paginate(rows)[0])).toHaveLength(DETAIL_ROWS);
  });

  test("factLines: only known facts", () => {
    expect(factLines("codex", { turns: 3 })).toEqual(["Turns 3"]);
    expect(factLines("codex", { contextPct: 7 })).toEqual(["Context 7%"]);
    expect(factLines("claude", {})).toEqual([]);
  });
});

describe("DETAILS page controls (section 7.3)", () => {
  test("LFO opens DETAILS for the selected chat and closes it again", async () => {
    const r = await opened();
    await press(r, "LFO");
    const v = r.console.view();
    expect(v.view).toBe("detail");
    expect(v.title).toBe("DETAILS fw codec");
    expect(v.legend).toEqual(["", "", "", ""]);
    expect(v.text).toHaveLength(DETAIL_ROWS);
    expect(v.text?.[0]?.style).toBe("heading");
    expect(v.pages).toBeGreaterThan(1);
    expect(v.page).toBe(0);
    await press(r, "LFO");
    expect(r.console.view().view).toBe("sessions");
    expect(r.console.view().text).toBeNull();
  });

  test("LFO does nothing unless protocol version 3 enabled the page", async () => {
    const r = await rig("mixed", { scope: "recent" });
    await tap(r, slotOf(r, "s-claude-fw"));
    await press(r, "LFO");
    expect(r.console.view().view).toBe("sessions");
    r.console.setDetailsPage(true);
    await press(r, "LFO");
    expect(r.console.view().view).toBe("detail");
    r.console.setDetailsPage(false);
    expect(r.console.view().view).toBe("sessions");
  });

  test("LFO with nothing selected tells to select a chat; in Tasks it does nothing", async () => {
    const r = await rig("mixed", { scope: "recent" });
    r.console.setDetailsPage(true);
    await press(r, "LFO");
    expect(r.console.view().view).toBe("sessions");
    expect(r.console.state.notice?.text).toBe("Select a chat first");
    await press(r, "EDIT");
    await press(r, "LFO");
    expect(r.console.view().view).toBe("tasks");
  });

  test("PRESETS and OCT page through, clamped; HOME closes; EDIT leaves", async () => {
    const r = await opened();
    await press(r, "LFO");
    const pages = r.console.view().pages;
    await turn(r, "PRESETS", 1);
    expect(r.console.view().page).toBe(1);
    await press(r, "OCT_DOWN");
    expect(r.console.view().page).toBe(0);
    await press(r, "OCT_DOWN");
    expect(r.console.view().page).toBe(0);
    for (let i = 0; i < 20; i++) await turn(r, "PRESETS", 1);
    expect(r.console.view().page).toBe(pages - 1);
    expect(r.console.view().text?.every((t) => t.text.length <= DETAIL_COLS)).toBe(true);
    await press(r, "HOME");
    expect(r.console.view().view).toBe("sessions");
    await press(r, "LFO");
    expect(r.console.view().page).toBe(0);
    await press(r, "EDIT");
    expect(r.console.view().view).toBe("tasks");
    await press(r, "HOME");
    expect(r.console.view().view).toBe("sessions");
  });

  test("SELECT shows the next chat from page 1; knobs do nothing", async () => {
    const r = await opened();
    await press(r, "LFO");
    await turn(r, "PRESETS", 1);
    const before = r.console.view().title;
    const actions = await turn(r, "SELECT", 1);
    expect(actions.some((a) => a.type === "select")).toBe(true);
    const v = r.console.view();
    expect(v.view).toBe("detail");
    expect(v.page).toBe(0);
    expect(v.title).not.toBe(before);
    const state = r.console.state;
    for (const k of ["K1", "K2", "K3", "K4"]) {
      const acts = await turn(r, k, 1);
      expect(acts.filter((a) => BACKEND_ACTIONS.has(a.type))).toEqual([]);
    }
    expect(r.console.state.scope).toBe(state.scope);
    expect(r.console.state.talk).toBe(state.talk);
  });

  test("an approval can be read on DETAILS, approved, and the page returns", async () => {
    const r = await rig("mixed", { scope: "recent" });
    r.console.setDetailsPage(true);
    withDetails(r, "s-codex-fw", { approval: { target: "rm -rf build/", summary: "Bash" } });
    await tap(r, slotOf(r, "s-codex-fw"));
    await press(r, "LFO");
    expect(r.console.view().text?.map((t) => t.text)).toContain("Approve: rm -rf build/");
    await press(r, "SAVE");
    expect(r.console.view().view).toBe("confirm");
    await press(r, "FX");
    expect(r.console.view().view).toBe("detail");
  });

  test("DETAILS works over TO DO", async () => {
    const r = await rig("mixed", { scope: "recent" });
    r.console.setDetailsPage(true);
    await press(r, "GLO");
    await turn(r, "SELECT", 1);
    await press(r, "LFO");
    expect(r.console.view().view).toBe("detail");
    await press(r, "LFO");
    expect(r.console.view().view).toBe("inbox");
  });

  test("review: with Traycer offline the page count matches the page shown (no dead turn back)", async () => {
    const r = await rig("mixed", { scope: "recent" });
    r.console.setDetailsPage(true);
    const msg = Array.from({ length: 67 }, (_, i) => `word${i}`).join(" ");
    withDetails(r, "s-codex-fw", { approval: { target: "rm -rf build/ and a few more words to wrap around rows", summary: "Bash" }, lastMessage: msg });
    await tap(r, slotOf(r, "s-codex-fw"));
    await press(r, "LFO");
    expect(r.console.view().pages).toBe(3);
    // Offline: the approval rows go, the page shrinks to 2 pages.
    r.console.registry.setConnection("disconnected");
    expect(r.console.view().pages).toBe(2);
    for (let i = 0; i < 5; i++) await turn(r, "PRESETS", 1);
    expect(r.console.view().page).toBe(1);
    await turn(r, "PRESETS", -1);
    expect(r.console.view().page).toBe(0);
  });

  test("no auto re-sort while DETAILS is open", async () => {
    const r = await opened();
    await press(r, "LFO");
    r.timers.advance(120_000);
    expect(r.console.tick()).toBe(false);
    expect(r.console.view().view).toBe("detail");
  });
});

describe("detail lines in the base views (section 7.2)", () => {
  test("line 3 carries the adapter summary; PRESETS walks into the last message and facts", async () => {
    const r = await opened();
    const v = r.console.view();
    expect(v.detail.lines[2]).toMatch(/editing view\.ts$/);
    const seen: string[] = [];
    for (let i = 0; i < 60; i++) {
      await turn(r, "PRESETS", 1);
      seen.push(...r.console.view().detail.lines.slice(0, 3));
    }
    expect(seen).toContain("Renamed");
    expect(seen.some((l) => l.startsWith("Context 42%"))).toBe(true);
    expect(seen.some((l) => l.startsWith("Model opus-4-5"))).toBe(true);
    expect(seen.every((l) => l.length <= 20)).toBe(true);
  });
});

describe("Session.details validation", () => {
  test("accepts typed fields, rejects wrong types", () => {
    expect(parseDetails(DETAILS)).toEqual({ ok: true, value: DETAILS });
    expect(parseDetails({ contextPct: 101 }).ok).toBe(false);
    expect(parseDetails({ files: { count: 1, names: [3] } }).ok).toBe(false);
    expect(parseDetails({ approval: { summary: "x" } }).ok).toBe(false);
    expect(parseDetails("x").ok).toBe(false);
    const base = { ref: { backendId: "b", hostId: "h", projectId: "p", taskId: "t", sessionId: "s" }, title: "t", provider: "claude", runtime: "chat", workspace: "/w", createdAt: 1, status: { observed: { state: "idle", at: 1 }, raw: null } };
    expect(parseSession({ ...base, details: { turns: 2 } }).ok).toBe(true);
    expect(parseSession({ ...base, details: { turns: -1 } }).ok).toBe(false);
  });
});
