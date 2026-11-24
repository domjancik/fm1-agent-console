// Protocol version 6 on the simulated device (docs/ui-v3.md section 10.7-10.8, 10.11): the SPLIT black row on Buddy,
// List and Grouped, compact black boxes in voice/confirm, the SETTINGS screen, help tables, the CHOSEN LED (checked
// against fixtures/device/led-v2.json), ARP lit in view 6, SPLIT transitions, and RANKED unchanged under protocol 6.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { SlotState } from "@fm1/device-protocol";
import { HELP_TEXT } from "../../agent-core/src/control-map";
import { buttonLeds, keyLed, type LedLevel } from "../src/leds";
import { applyHostMessage, initialState, type DeviceState, type Slot } from "../src/state";
import { blackRow, chipBox, groupedWindow, HELP4, keyBox4, listWindow, renderV4, SPLIT, usesSplit } from "../src/v4/screen";
import { detectTransition } from "../src/v4/transitions";
import { rgb565 } from "../src/v4/raster";

const WHITE = rgb565([255, 255, 255]);
const BLACK = 0;
const BLACK_KEYS = [1, 3, 5, 8, 10, 13, 15, 17, 20, 22, 25];
const WHITE_KEYS = [0, 2, 4, 6, 7, 9, 11, 12, 14, 16, 18, 19, 21, 23, 24, 26];

const slot = (state: SlotState, over: Partial<Slot> & { chosen?: boolean; selected?: boolean; pinned?: boolean } = {}): Slot => ({
  state,
  flags: { selected: over.selected ?? false, codex: false, stale: false, pinned: over.pinned ?? false, ...(over.chosen ? { chosen: true } : {}) },
  label: over.label ?? "",
  title: over.title ?? "",
  age: "",
});

/** A connected v6 device in SPLIT Sessions: ALL chosen, PIN empty, YOU failed, 5 tasks, 4 white sessions (one selected). */
function splitState(layout: "buddy" | "list" | "grouped" = "buddy", proto = 6): DeviceState {
  let s = initialState(proto);
  s = { ...s, link: { ...s.link, phase: "connected", proto } };
  s = applyHostMessage(s, { kind: "SET_VIEW", view: "sessions", page: 0, pages: 1, title: "ACTIVE 4", layout, keys: "split", taskPage: 0, taskPages: 2 }, 0);
  const black: [number, Slot][] = [
    [1, slot("idle", { label: "ALL", chosen: true, title: "All" })],
    [3, slot("empty", { label: "PIN", title: "Pinned" })],
    [5, slot("failed", { label: "YOU", title: "Needs you" })],
    [8, slot("waiting_input", { label: "VCO", title: "Voice composer" })],
    [10, slot("failed", { label: "FV5", pinned: true, title: "Firmware v5" })],
    [13, slot("working", { label: "ATA", title: "Alpha task" })],
    [15, slot("disconnected", { label: "DPA", title: "Dogs park" })],
    [17, slot("idle", { label: "DP5", title: "Docs pass" })],
  ];
  const slots = s.slots.slice();
  for (const [k, sl] of black) slots[k] = sl;
  const whites: Slot[] = [
    slot("waiting_input", { label: "voice-q", title: "voice-q title", selected: true }),
    slot("failed", { label: "fw-a", title: "fw-a title" }),
    slot("working", { label: "fw-b", title: "fw-b title" }),
    slot("completed_unread", { label: "alpha-1", title: "alpha-1 title" }),
  ];
  whites.forEach((w, i) => (slots[WHITE_KEYS[i] ?? 0] = layout === "grouped" ? { ...w, row: { indent: 1, start: i === 0 || i === 1, task: false }, head: i <= 1 ? { state: w.state, pinned: false, title: `T${i}`, count: "1" } : undefined } : w));
  s = { ...s, slots, detail: { provider: "claude", state: "waiting_input", lines: ["", "", "", "SAVE answer"] } };
  s = { ...s, text: s.text.map((r, i) => (i === 0 ? { style: "heading" as const, text: "Asks you" } : i >= 1 && i <= 5 ? { style: "body" as const, text: `line ${i}` } : r)) };
  return s;
}

const px = (fb: { px: Uint16Array | number[] }, x: number, y: number): number => fb.px[y * 240 + x] ?? -1;

describe("SPLIT Buddy (docs/ui-v3.md section 10.7)", () => {
  test("chip geometry: centres 22...218 on two staggered lines, 26 x 16 boxes, line A stems", () => {
    const cs = BLACK_KEYS.map((_, i) => chipBox(i, 168).x + 13);
    expect(cs).toEqual([22, 36, 50, 78, 92, 120, 134, 148, 176, 190, 218]);
    expect(BLACK_KEYS.map((_, i) => chipBox(i, 168).y)).toEqual([168, 184, 168, 184, 168, 184, 168, 184, 168, 184, 168]);
    // every line A stem lies outside every line B box
    for (let a = 0; a < 11; a += 2) {
      const st = chipBox(a, 168).stem;
      expect(st).not.toBeNull();
      for (let b = 1; b < 11; b += 2) {
        const bx = chipBox(b, 168);
        expect(st!.x < bx.x || st!.x >= bx.x + bx.w).toBe(true);
      }
    }
    expect(chipBox(1, 168).stem).toBeNull();
  });

  test("the chosen chip is white with a white stem; a task chip filled in its colour; an empty task slot a dash", () => {
    const s = splitState();
    expect(usesSplit(s)).toBe(true);
    const fb = renderV4(s, 0);
    // ALL chosen: box at x0 9, y 168 filled white (the tag pixels are black)
    expect(px(fb, 9, 168)).toBe(WHITE);
    expect(px(fb, 34, 183)).toBe(WHITE);
    expect(px(fb, 22, 190)).toBe(WHITE); // stem
    // FV5 (failed, i = 4 line A, x0 79): red fill, pin dot in the tag colour at (x0 + 23, y0 + 1)
    expect(px(fb, 80, 182)).toBe(rgb565([240, 48, 48]));
    // empty task slot (k 20, i 8, line A, x0 163): the dash only
    expect(px(fb, 163 + 11, 168 + 7)).toBe(rgb565([48, 48, 48]));
    expect(px(fb, 163, 168)).toBe(BLACK);
    // a filter not chosen and empty: a 1 px frame in the outline colour (PIN, i 1, line B, x0 23)
    expect(px(fb, 23, 184)).toBe(rgb565([48, 48, 48]));
    expect(px(fb, 48, 199)).toBe(rgb565([48, 48, 48]));
  });

  test("the bubble has 4 body rows (frame 92 high), the more wedge 16 px up; white minis stay at y 202", () => {
    const s = splitState();
    const fb = renderV4(s, 0);
    // bubble bottom edge at y 165 (74 + 92 - 1), nothing of the v4 bubble below it
    const border = px(fb, 100, 165);
    expect(border).not.toBe(BLACK);
    expect(px(fb, 106, 181)).toBe(BLACK); // between the FV5 and ATA chips, where the v4 bubble had its bottom rows
    // row 5 non-empty: the wedge at y 162
    expect(px(fb, 227, 162)).toBe(WHITE);
    // the selected white mini (F3) frame at the v4 position
    const k0 = keyBox4(0);
    expect(k0.y).toBe(202);
    expect(px(fb, k0.x, k0.y)).toBe(WHITE);
    // row 5 of the bubble text is not drawn as a body row (only rows 1-4 at y 96...159)
    const plain = renderV4({ ...s, text: s.text.map((r, i) => (i === 5 ? { ...r, text: "" } : r)) }, 0);
    let diff = 0;
    for (let y = 160; y < 168; y++) for (let x = 0; x < 240; x++) if (px(plain, x, y) !== px(fb, x, y)) diff++;
    expect(diff).toBeGreaterThan(0);
    for (let y = 176; y < 182; y++) for (let x = 0; x < 240; x++) expect(px(plain, x, y)).toBe(px(fb, x, y));
  });

  test("task page dots: n = min(pages, 8), current white, at x 234", () => {
    const s = splitState();
    const fb = renderV4(s, 0);
    expect(px(fb, 234, 169)).toBe(WHITE);
    expect(px(fb, 234, 173)).toBe(rgb565([128, 128, 128]));
    expect(px(fb, 234, 177)).toBe(BLACK);
  });

  test("voice over SPLIT: the v4 strip with compact black boxes (chosen white fill, task fill, empty dash)", () => {
    const s0 = splitState();
    const s = applyHostMessage(s0, { kind: "SET_VIEW", view: "voice", page: 0, pages: 1, title: "TALK", layout: "buddy", keys: "split", taskPage: 0, taskPages: 2 }, 0);
    const fb = renderV4(s, 0);
    const all = keyBox4(1);
    expect(all.y).toBe(184);
    expect(px(fb, all.x + 1, all.y + 1)).toBe(WHITE);
    const fw = keyBox4(10);
    expect(px(fb, fw.x + 6, fw.y + 6)).toBe(rgb565([240, 48, 48]));
    const e = keyBox4(20);
    expect(px(fb, e.x + 5, e.y + 6)).toBe(rgb565([32, 32, 32]));
  });
});

describe("SPLIT List and Grouped (docs/ui-v3.md section 10.7)", () => {
  test("List: band at y 60, 8 rows from y 94, only white keys are rows", () => {
    const s = splitState("list");
    expect(listWindow(s).entries).toEqual([0, 2, 4, 6]);
    const fb = renderV4(s, 0);
    expect(px(fb, 9, 60)).toBe(WHITE); // ALL chosen, line A at y0 60
    expect(px(fb, 22, 80)).toBe(WHITE); // its stem
    expect(px(fb, 100, 94)).toBe(rgb565([48, 48, 48])); // selected row background (row 0 at y 94)
    expect(px(fb, 100, 93)).toBe(BLACK);
  });

  test("List window: 8 rows; the selection on entry 9 shows window 2", () => {
    const s0 = splitState("list");
    const slots = s0.slots.map((x) => ({ ...x, flags: { ...x.flags, selected: false } }));
    for (let i = 0; i < 12; i++) slots[WHITE_KEYS[i] ?? 0] = slot("working", { label: `s${i}`, title: `s${i}`, selected: i === 9 });
    const s = { ...s0, slots };
    expect(listWindow(s).top).toBe(8);
    const fb = renderV4(s, 0);
    // scroll thumb: L 12 > 8, top 8 -> y = 94 + 128 * 8 / 12 = 179
    expect(px(fb, 237, 179)).toBe(rgb565([128, 128, 128]));
    expect(px(fb, 237, 120)).toBe(BLACK);
  });

  test("Grouped: entries from white keys only, headers before start rows", () => {
    const s = splitState("grouped");
    expect(groupedWindow(s).entries).toEqual([
      { k: 0, kind: "H" },
      { k: 0, kind: "S" },
      { k: 2, kind: "H" },
      { k: 2, kind: "S" },
      { k: 4, kind: "S" },
      { k: 6, kind: "S" },
    ]);
    const fb = renderV4(s, 0);
    expect(px(fb, 9, 60)).toBe(WHITE);
  });
});

describe("SETTINGS screen and help (docs/ui-v3.md sections 10.2 and 10.11)", () => {
  function settings(): DeviceState {
    let s = initialState(6);
    s = { ...s, link: { ...s.link, phase: "connected", proto: 6 } };
    s = applyHostMessage(s, { kind: "SET_VIEW", view: "settings", page: 0, pages: 1, title: "SETTINGS", layout: "buddy", keys: "ranked" }, 0);
    s = applyHostMessage(s, { kind: "SET_TEXT", row: 0, lines: [{ style: "body", text: "Keys                Ranked" }, { style: "body", text: "" }, { style: "body", text: "" }] }, 0);
    s = applyHostMessage(s, { kind: "SET_TEXT", row: 9, lines: [{ style: "muted", text: "Every key is a session" }, { style: "body", text: "" }, { style: "body", text: "" }] }, 0);
    return { ...s, detail: { ...s.detail, lines: ["", "", "", "SAVE set  HOME back"] } };
  }

  test("cursor row background, the > glyph, rows past the count black, description at y 204", () => {
    const s = settings();
    const fb = renderV4(s, 0);
    expect(px(fb, 200, 22)).toBe(rgb565([48, 48, 48]));
    expect(px(fb, 200, 41)).toBe(rgb565([48, 48, 48]));
    expect(px(fb, 200, 42)).toBe(BLACK);
    let desc = 0;
    for (let y = 204; y < 220; y++) for (let x = 4; x < 180; x++) if (px(fb, x, y) !== BLACK) desc++;
    expect(desc).toBeGreaterThan(0);
    // no page number in the top bar even with pages > 1
    const two = renderV4(applyHostMessage(s, { kind: "SET_VIEW", view: "settings", page: 1, pages: 2, title: "SETTINGS", layout: "buddy", keys: "ranked" }, 0), 0);
    expect(px(two, 200, 42)).toBe(rgb565([48, 48, 48]));
    let top = 0;
    for (let y = 1; y < 17; y++) for (let x = 150; x < 225; x++) if (px(two, x, y) !== BLACK) top++;
    expect(top).toBe(0);
  });

  test("LEDs in view 6: ARP lit, SAVE / HOME / LFO glow (active controls), every other button off", () => {
    const s = settings();
    const leds = buttonLeds({ ...s, status: { ...s.status, attentionCount: 3 } }, 0);
    expect(leds.ARP).toBe("full");
    expect(Object.entries(leds).filter(([, l]) => l === "glow").map(([b]) => b).sort()).toEqual(["HOME", "LFO", "SAVE"]);
    expect(Object.entries(leds).filter(([b, l]) => !["ARP", "SAVE", "HOME", "LFO"].includes(b) && l !== "off")).toEqual([]);
  });

  test("help tables equal agent-core HELP_TEXT; SPLIT6 in SPLIT Sessions, SETTINGS6 in view 6, BASE6 otherwise", () => {
    expect([...HELP4.base6]).toEqual([...HELP_TEXT.base6]);
    expect([...HELP4.split6]).toEqual([...HELP_TEXT.split6]);
    expect([...HELP4.settings6]).toEqual([...HELP_TEXT.settings6]);
    const help = (s: DeviceState) => renderV4({ ...s, local: { ...s.local, help: true } }, 0);
    const split = help(splitState());
    const ranked = help({ ...splitState(), view: { ...splitState().view, keys: "ranked" } });
    const v5 = help({ ...splitState("buddy", 5), view: { ...splitState().view, keys: undefined } });
    const row = (fb: ReturnType<typeof renderV4>, y: number): number[] => Array.from({ length: 240 * 16 }, (_, i) => px(fb, i % 240, y + Math.floor(i / 240)));
    // line 1 (y 20): SPLIT6 and BASE6 share it, BASE5 differs; line 2 (y 36) differs between SPLIT6 and BASE6
    expect(row(split, 20)).toEqual(row(ranked, 20));
    expect(row(ranked, 20)).not.toEqual(row(v5, 20));
    expect(row(split, 36)).not.toEqual(row(ranked, 36));
    expect(row(ranked, 36)).toEqual(row(v5, 36));
    const sh = help(settings());
    let grid = 0;
    for (let y = 120; y < 220; y++) for (let x = 0; x < 240; x++) if (px(sh, x, y) !== BLACK) grid++;
    expect(grid).toBe(0); // no knob lines, no who-is-who grid
  });
});

describe("LEDs (docs/ui-v3.md section 10.8)", () => {
  test("CHOSEN timeline equals fixtures/device/led-v2.json `chosen`, whatever the state; always breathes with the selection", () => {
    const data = JSON.parse(readFileSync(new URL("../../../fixtures/device/led-v2.json", import.meta.url), "utf8")) as {
      chosen: { name: string; state: SlotState; chosen: boolean; samples: [number, LedLevel][] }[];
    };
    expect(data.chosen.length).toBeGreaterThanOrEqual(8);
    for (const c of data.chosen) {
      const s = slot(c.state, { chosen: c.chosen });
      for (const [t, level] of c.samples) expect(keyLed(s, t, true, 6)).toBe(level);
      for (let t = 0; t < 3000; t += 10) expect(keyLed(s, t, true, 6)).toBe("breath");
    }
  });

  test("black keys not chosen follow the state timelines (YOU failed: slow glow/off; empty task: off)", () => {
    expect(keyLed(slot("failed"), 0, true, 6)).toBe("glow");
    expect(keyLed(slot("failed"), 1600, true, 6)).toBe("off");
    expect(keyLed(slot("empty"), 0, true, 6)).toBe("off");
  });
});

describe("SPLIT transitions and RANKED parity (docs/ui-v3.md sections 10.7 and 10.12)", () => {
  test("task page change: the task wipe over the black row band, 3 steps, direction by wrap", () => {
    const a = splitState();
    const b = applyHostMessage(a, { kind: "SET_VIEW", view: "sessions", page: 0, pages: 1, title: "ACTIVE 4", layout: "buddy", keys: "split", taskPage: 1, taskPages: 2 }, 0);
    const t = detectTransition(a, b, 0);
    expect(t?.kind).toBe("task-wipe");
    expect(t?.steps).toHaveLength(3);
    expect(t?.steps[0]?.rects[0]).toEqual({ x: 0, y: SPLIT.buddyBandY, w: 80, h: 32 });
    const back = detectTransition(b, applyHostMessage(b, { kind: "SET_VIEW", view: "sessions", page: 0, pages: 1, title: "ACTIVE 4", layout: "buddy", keys: "split", taskPage: 0, taskPages: 2 }, 0), 0);
    expect(back?.steps[0]?.rects[0]).toEqual({ x: 0, y: SPLIT.buddyBandY, w: 80, h: 32 }); // 1 -> 0 is +1 mod 2: forward
    const list = splitState("list");
    const lt = detectTransition(list, applyHostMessage(list, { kind: "SET_VIEW", view: "sessions", page: 0, pages: 1, title: "x", layout: "list", keys: "split", taskPage: 1, taskPages: 2 }, 0), 0);
    expect(lt?.steps[0]?.rects[0]?.y).toBe(SPLIT.listBandY);
  });

  test("white page change in SPLIT: the page wipe over the white row (Buddy) or the 8 rows (List)", () => {
    const a = splitState();
    const b = applyHostMessage(a, { kind: "SET_VIEW", view: "sessions", page: 1, pages: 2, title: "x", layout: "buddy", keys: "split", taskPage: 0, taskPages: 2 }, 0);
    const t = detectTransition(a, b, 0);
    expect(t?.kind).toBe("page-wipe");
    expect(t?.steps[0]?.rects[0]).toMatchObject({ y: 200, h: 24 });
    const keys = detectTransition(a, applyHostMessage(a, { kind: "SET_VIEW", view: "sessions", page: 0, pages: 1, title: "x", layout: "buddy", keys: "ranked" }, 0), 0);
    expect(keys?.kind).toBe("layout-wipe");
  });

  test("RANKED with protocol 6 (keys 0) draws exactly the version 5 pixels", () => {
    let s5 = initialState(5);
    s5 = { ...s5, link: { ...s5.link, phase: "connected", proto: 5 } };
    s5 = applyHostMessage(s5, { kind: "SET_VIEW", view: "sessions", page: 0, pages: 2, title: "ACTIVE 30", layout: "buddy" }, 0);
    const slots = s5.slots.map((_, k) => slot(k % 3 === 0 ? "working" : "idle", { label: `k${k}`, title: `t${k}`, selected: k === 4 }));
    s5 = { ...s5, slots };
    let s6: DeviceState = { ...s5, link: { ...s5.link, proto: 6 }, local: { ...s5.local, maxProto: 6 } };
    s6 = applyHostMessage(s6, { kind: "SET_VIEW", view: "sessions", page: 0, pages: 2, title: "ACTIVE 30", layout: "buddy", keys: "ranked" }, 0);
    for (const layout of ["buddy", "list", "grouped"] as const) {
      const a = { ...s5, view: { ...s5.view, layout } };
      const b = { ...s6, view: { ...s6.view, layout } };
      expect(Array.from(renderV4(b, 1234).px)).toEqual(Array.from(renderV4(a, 1234).px));
    }
  });

  test("state: the keys byte is kept only when sent; blackRow draws nothing outside its band", () => {
    const s = applyHostMessage(initialState(6), { kind: "SET_VIEW", view: "sessions", page: 0, pages: 1, title: "", layout: "buddy" }, 0);
    expect(s.view).not.toHaveProperty("keys");
    expect(s.view).not.toHaveProperty("taskPage");
    const fb = renderV4(initialState(6), 0);
    fb.px.fill(0);
    blackRow(fb, splitState(), 168);
    for (let y = 0; y < 240; y++) for (let x = 0; x < 240; x++) if (y < 168 || y >= 200) expect(px(fb, x, y)).toBe(BLACK);
  });
});
