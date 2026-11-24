// Protocol version 4 host content (docs/ui-v3.md sections 5 and 6.3): the bubble rows, the v4 DETAILS pages, the
// view fields, PRESETS scrolling the bubble, and version 3 output left as it was.
import { describe, expect, test } from "bun:test";
import { BACKEND_ACTIONS } from "../src/controller";
import {
  BUBBLE_BODY_ROWS,
  BUBBLE_COLS,
  bubbleCaption,
  bubbleLines,
  bubbleMaxScroll,
  bubbleRows,
  CAPTION_MAX,
  NO_MESSAGE,
  titleSplit,
  type BubbleInput,
} from "../src/copy";
import { BODY4_ROWS, detailPages4, HEADER4_COLS, MAX_DETAIL_PAGES } from "../src/details";
import type { SessionEntry } from "../src/registry";
import type { NormalizedState, SessionDetails } from "../src/types";
import { NORMALIZED_STATES } from "../src/types";
import type { DeviceView } from "../src/view";
import { keyOf, REC_HOLD, rig, RIG_EPOCH, slotOf, type Rig } from "./helpers";

const press = (r: Rig, button: string) => r.console.handleInput({ kind: "button", button: button as never, edge: "down" });
const turn = (r: Rig, encoder: string, delta = 1) => r.console.handleInput({ kind: "encoder", encoder: encoder as never, delta });
const tap = (r: Rig, k: number) => r.console.handleInput({ kind: "key", key: k, gesture: "single" });

const LONG = Array.from({ length: 70 }, (_, i) => `word${i}`).join(" ");
const DETAILS: SessionDetails = {
  lastMessage: `Renamed parseDeviceFrame to decodeFrame in 4 files. ${LONG}`,
  lastMessageAt: RIG_EPOCH - 120_000,
  activity: "editing view.ts",
  contextPct: 42,
  model: "opus-4-5",
  turns: 12,
};

function withDetails(r: Rig, sessionId: string, details: SessionDetails): void {
  const e = r.console.registry.get(keyOf(r, sessionId));
  if (!e) throw new Error("missing");
  r.adapter.upsertSession({ ...e.session, details });
}

async function v4(sessionId = "s-claude-fw", details: SessionDetails = DETAILS): Promise<Rig> {
  const r = await rig("mixed", { scope: "recent" });
  r.console.setProtocol(4);
  withDetails(r, sessionId, details);
  await tap(r, slotOf(r, sessionId));
  return r;
}

const ascii = /^[\x20-\x7e]*$/;

describe("bubble copy (docs/ui-v3.md section 6.3)", () => {
  const base: BubbleInput = { state: "working", stale: false, inferred: false, ageMs: 120_000 };
  test("caption: state words + age, <= 20 for every state; stale has no age; (guess) only when it fits", () => {
    for (const state of NORMALIZED_STATES) {
      const c = bubbleCaption({ ...base, state });
      expect(c.length).toBeLessThanOrEqual(CAPTION_MAX);
      expect(c).toMatch(ascii);
      expect(c.endsWith(", 2m")).toBe(true);
    }
    expect(bubbleCaption({ ...base, state: "completed_unread" })).toBe("Done, unread, 2m");
    expect(bubbleCaption({ ...base, stale: true, backend: "Traycer" })).toBe("Gone from Traycer");
    expect(bubbleCaption({ ...base, stale: true })).toBe("Gone from Backend");
    expect(bubbleCaption({ ...base, stale: true, backend: "Some Very Long Backend Name" })).toBe("Gone from Some Very");
    expect(bubbleCaption({ ...base, state: "idle", inferred: true })).toBe("Idle, 2m (guess)");
    expect(bubbleCaption({ ...base, state: "approval_required", inferred: true })).toBe("Needs approval, 2m");
  });

  test("body by state: approval, error, now, then the last message; nothing known is a muted No message yet", () => {
    const msg = "The tests pass.";
    expect(bubbleLines({ ...base, state: "approval_required", approvalTarget: "rm -rf build/", approvalSummary: "clean the build tree", lastMessage: msg }).map((r) => r.text)).toEqual([
      "Approve: rm -rf build/",
      "clean the build tree",
      msg,
    ]);
    expect(bubbleLines({ ...base, state: "waiting_input", lastMessage: "Which backoff?" }).map((r) => r.text)).toEqual(["Which backoff?"]);
    expect(bubbleLines({ ...base, state: "failed", failure: "3 tests failed", lastMessage: msg }).map((r) => r.text)).toEqual(["Error: 3 tests failed", msg]);
    expect(bubbleLines({ ...base, state: "working", activity: "editing view.ts", lastMessage: msg }).map((r) => r.text)).toEqual(["Now: editing view.ts", msg]);
    expect(bubbleLines({ ...base, state: "completed_unread", lastMessage: msg }).map((r) => r.text)).toEqual([msg]);
    expect(bubbleLines({ ...base, state: "idle" })).toEqual([{ style: "muted", text: NO_MESSAGE }]);
    expect(bubbleLines({ ...base, state: "idle", summary: "Writing C codec" }).map((r) => r.text)).toEqual(["Writing C codec"]);
  });

  test("rows: 7 rows, caption first, body <= 28 ASCII, row 6 is the next line, scroll steps of 5 and clamps", () => {
    const lines = bubbleLines({ ...base, state: "completed_unread", lastMessage: `${LONG} énd` });
    expect(lines.length).toBeGreaterThan(10);
    const r0 = bubbleRows("Done, 2m", lines, 0);
    expect(r0.length).toBe(7);
    expect(r0[0]).toEqual({ style: "heading", text: "Done, 2m" });
    for (const r of r0) {
      expect(r.text.length).toBeLessThanOrEqual(BUBBLE_COLS);
      expect(r.text).toMatch(ascii);
    }
    expect(r0.slice(1, 6).map((r) => r.text)).toEqual(lines.slice(0, 5).map((r) => r.text));
    expect(r0[6]?.text).toBe(lines[5]?.text);
    const r1 = bubbleRows("Done, 2m", lines, 1);
    expect(r1[1]?.text).toBe(lines[BUBBLE_BODY_ROWS]?.text);
    const max = bubbleMaxScroll(lines.length);
    const last = bubbleRows("Done, 2m", lines, 99);
    expect(last).toEqual(bubbleRows("Done, 2m", lines, max));
    expect(last[6]?.text).toBe("");
    expect(bubbleRows("Done, 2m", lines, -3)).toEqual(r0);
    expect(bubbleRows("x", [], 0)[1]).toEqual({ style: "body", text: "" });
  });

  test("titleSplit with the version 4 head: 11 characters for FONT_L beside the hero", () => {
    expect(titleSplit("Voice tests for the push-to-talk path", 11).head).toBe("Voice tests");
    expect(titleSplit("Voice tests for the push-to-talk path").head).toBe("Voice tests");
    expect(titleSplit("Refund webhook retries", 11).head).toBe("Refund");
    expect(titleSplit("Refund webhook retries").head).toBe("Refund");
    expect(titleSplit("abcdefghijklmnop", 11).head).toBe("abcdefghijk");
  });
});

describe("detailPages4 (docs/ui-v3.md section 5, DETAILS)", () => {
  const entry = (state: NormalizedState, details?: SessionDetails): SessionEntry =>
    ({
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

  test("the header on every page, the last message right after it, 9 body rows a page, at most 8 pages", () => {
    const pages = detailPages4({ entry: entry("working", { ...DETAILS, lastMessageAt: 0 }), state: "working", taskTitle: "FM1 console", now: 61_000 });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.length).toBeLessThanOrEqual(MAX_DETAIL_PAGES);
    for (const p of pages) {
      expect(p.length).toBeLessThanOrEqual(3 + BODY4_ROWS);
      expect(p[0]).toEqual({ style: "heading", text: "WORKING 1m" });
      for (const r of p.slice(0, 3)) expect(r.text.length).toBeLessThanOrEqual(HEADER4_COLS);
      for (const r of p) expect(r.text.length).toBeLessThanOrEqual(29);
    }
    expect(pages[0]?.[3]).toEqual({ style: "heading", text: "Last message 1m" });
    expect(pages[0]?.[4]?.text.startsWith("Renamed parseDeviceFrame")).toBe(true);
    const all = pages.flatMap((p) => p.slice(3)).map((r) => r.text);
    expect(all.indexOf("Now: editing view.ts")).toBeGreaterThan(all.indexOf("Last message 1m"));
    expect(all.at(-1)).toBe("Task: FM1 console");
  });

  test("a long message is cut at 8 pages; no details -> one page with No chat details yet", () => {
    const huge = Array.from({ length: 400 }, (_, i) => `w${i}`).join(" ");
    expect(detailPages4({ entry: entry("idle", { lastMessage: huge }), state: "idle", now: 0 }).length).toBe(MAX_DETAIL_PAGES);
    const none = detailPages4({ entry: entry("idle"), state: "idle", now: 0 });
    expect(none.length).toBe(1);
    expect(none[0]?.[3]?.text).toBe("No chat details yet");
  });
});

describe("view with protocol version 4", () => {
  test("label <= 11, line 1 the title rest, lines 2-3 empty, SET_TEXT the bubble (12 rows, rows 7-11 empty)", async () => {
    const r = await v4();
    const v = r.console.view();
    const k = slotOf(r, "s-claude-fw");
    expect(v.slots[k]?.label).toBe("fw codec");
    for (const s of v.slots) expect(s.label.length).toBeLessThanOrEqual(11);
    expect(v.detail.lines[1]).toBe("");
    expect(v.detail.lines[2]).toBe("");
    expect(v.detail.lines[3]).not.toBe("");
    expect(v.text?.length).toBe(12);
    expect(v.text?.[0]?.text).toMatch(/^Working, /);
    expect(v.text?.[1]?.text).toBe("Now: editing view.ts");
    expect(v.text?.[2]?.text.startsWith("Renamed parseDeviceFrame")).toBe(true);
    expect(v.text?.[6]?.text).not.toBe("");
    expect(v.text?.slice(7).every((t) => t.text === "")).toBe(true);
  });

  test("Sessions: a chat waiting for approval shows it in the bubble from the registry, as v3 did (no details needed)", async () => {
    const r = await rig("mixed", { scope: "recent" });
    r.console.setProtocol(4);
    await tap(r, slotOf(r, "s-codex-fw"));
    const v = r.console.view();
    expect(v.view).toBe("sessions");
    expect(v.text?.[0]?.text.startsWith("Needs approval")).toBe(true);
    expect(v.text?.slice(1, 6).map((t) => t.text)).toContain("Approve: rm -rf build/");
  });

  test("TO DO and Tasks carry a bubble too; DETAILS uses the v4 pages", async () => {
    const r = await v4();
    await press(r, "GLO");
    expect(r.console.view().text?.[0]?.text).not.toBe(undefined);
    await press(r, "EDIT");
    await turn(r, "SELECT", 1);
    const t = r.console.view();
    expect(t.view).toBe("tasks");
    expect(t.text?.[0]?.text).toMatch(/chat/);
    await press(r, "HOME");
    await tap(r, slotOf(r, "s-claude-fw"));
    await press(r, "LFO");
    const d = r.console.view();
    expect(d.view).toBe("detail");
    expect(d.text?.[3]?.text).toMatch(/^Last message/);
  });

  test("voice: the transcript goes in the bubble rows, lines 1-3 empty, the hero is the target chat", async () => {
    const r = await v4("s-claude-idle", { lastMessage: "Ready." });
    await press(r, "REC");
    r.timers.advance(REC_HOLD);
    await r.console.handleInput({ kind: "button", button: "REC", edge: "up" });
    r.console.voiceTranscript("please rerun the voice tests and tell me what failed");
    const v = r.console.view();
    expect(v.view).toBe("voice");
    expect(v.detail.lines.slice(0, 3)).toEqual(["", "", ""]);
    expect(v.detail.provider).toBe("claude");
    expect(v.text?.[1]?.text).toBe("please rerun the voice tests");
  });

  test("version 3 output is unchanged: no bubble rows outside DETAILS, the v3 lines and labels", async () => {
    const a = await rig("mixed", { scope: "recent" });
    a.console.setDetailsPage(true);
    const b = await rig("mixed", { scope: "recent" });
    b.console.setProtocol(3);
    for (const r of [a, b]) {
      withDetails(r, "s-claude-fw", DETAILS);
      await tap(r, slotOf(r, "s-claude-fw"));
    }
    const strip = (v: DeviceView) => JSON.stringify(v);
    expect(strip(b.console.view())).toBe(strip(a.console.view()));
    expect(b.console.view().text).toBe(null);
    await press(a, "LFO");
    await press(b, "LFO");
    expect(strip(b.console.view())).toBe(strip(a.console.view()));
    expect(b.console.view().text?.[0]?.text).toMatch(/^WORKING, /);
  });
});

describe("controller with protocol version 4", () => {
  test("PRESETS scrolls the bubble a page at a time, clamps at the last page and resets on a selection change", async () => {
    const r = await v4();
    const first = r.console.view().text?.[1]?.text;
    const next = r.console.view().text?.[6]?.text;
    await turn(r, "PRESETS", 1);
    expect(r.console.view().text?.[1]?.text).toBe(next);
    for (let i = 0; i < 20; i++) await turn(r, "PRESETS", 1);
    const last = r.console.state.detailScroll;
    expect(r.console.view().text?.[6]?.text).toBe("");
    await turn(r, "PRESETS", -1);
    expect(r.console.state.detailScroll).toBe(last - 1);
    for (let i = 0; i < 20; i++) await turn(r, "PRESETS", -1);
    expect(r.console.view().text?.[1]?.text).toBe(first);
    await turn(r, "PRESETS", 1);
    await tap(r, slotOf(r, "s-claude-idle"));
    expect(r.console.state.detailScroll).toBe(0);
  });

  test("a selection made elsewhere (the Mac) also starts the bubble at the newest content", async () => {
    const r = await v4();
    withDetails(r, "s-claude-idle", { lastMessage: `Idle chat says hello. ${LONG}` });
    await turn(r, "PRESETS", 1);
    await turn(r, "PRESETS", 1);
    expect(r.console.state.detailScroll).toBe(2);
    // not a key or a knob: the registry's selection moves (Traycer or the Mac app picked another chat)
    expect(r.console.registry.select(keyOf(r, "s-claude-idle")).ok).toBe(true);
    const v = r.console.view();
    expect(v.text?.[1]?.text).toBe("Idle chat says hello. word0");
    // turning back from there moves at once (no hidden steps left over from the other chat)
    await turn(r, "PRESETS", 1);
    expect(r.console.view().text?.[1]?.text).not.toBe("Idle chat says hello. word0");
    await turn(r, "PRESETS", -1);
    expect(r.console.view().text?.[1]?.text).toBe("Idle chat says hello. word0");
  });

  test("voice: PRESETS scrolls the transcript; a new transcript starts again at its first line", async () => {
    const r = await v4("s-claude-idle", { lastMessage: "Ready." });
    await press(r, "REC");
    r.timers.advance(REC_HOLD);
    await r.console.handleInput({ kind: "button", button: "REC", edge: "up" });
    r.console.voiceTranscript(`first take ${LONG}`);
    expect(r.console.view().text?.[1]?.text).toBe("first take word0 word1 word2");
    await turn(r, "PRESETS", 1);
    expect(r.console.view().text?.[1]?.text).not.toBe("first take word0 word1 word2");
    for (let i = 0; i < 10; i++) await turn(r, "PRESETS", 1); // clamps at the last page of the drawn lines
    const lastRow = r.console.view().text?.[1]?.text;
    await turn(r, "PRESETS", -1);
    expect(r.console.view().text?.[1]?.text).not.toBe(lastRow);
    await press(r, "FX"); // cancel, then a new take
    await press(r, "REC");
    r.timers.advance(REC_HOLD);
    await r.console.handleInput({ kind: "button", button: "REC", edge: "up" });
    r.console.voiceTranscript(`second take ${LONG}`);
    expect(r.console.composer.state.transcript.startsWith("second take")).toBe(true);
    expect(r.console.view().text?.[1]?.text).toBe("second take word0 word1");
  });

  test("knobs never act, also in version 4", async () => {
    const r = await v4();
    for (const k of ["K1", "K2", "K3", "K4"]) {
      for (const d of [1, -1]) {
        const actions = await turn(r, k, d);
        expect(actions.some((a) => BACKEND_ACTIONS.has(a.type))).toBe(false);
      }
    }
  });

  test("setProtocol: 4 -> 3 drops the bubble, 2 closes DETAILS", async () => {
    const r = await v4();
    await press(r, "LFO");
    expect(r.console.view().view).toBe("detail");
    r.console.setProtocol(3);
    expect(r.console.view().view).toBe("detail");
    expect(r.console.state.bubble).toBe(false);
    r.console.setProtocol(2);
    expect(r.console.view().view).toBe("sessions");
    expect(r.console.view().text).toBe(null);
  });
});
