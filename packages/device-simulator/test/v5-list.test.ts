// The simulator's LIST layout (docs/ui-v3.md sections 8.2-8.3), checked without the firmware shots: which keys are
// rows, the window of 10, the selected row's colour, the scroll thumb, the SEQ LED, and Buddy left as it was.
import { describe, expect, test } from "bun:test";
import type { HostMessage, SlotFlags } from "@fm1/device-protocol";
import { buttonLeds } from "../src/leds";
import { applyHostMessage, initialState, type DeviceState } from "../src/state";
import { rgb565 } from "../src/v4/raster";
import { LIST, listWindow, renderV4, usesList } from "../src/v4/screen";

const NO: SlotFlags = { selected: false, codex: false, stale: false, pinned: false };

function state(n: number, selectedIdx: number, layout: "buddy" | "list" = "list", proto = 5): DeviceState {
  let s = initialState(5);
  s = { ...s, link: { ...s.link, phase: "connected", proto } };
  const msgs: HostMessage[] = [{ kind: "SET_VIEW", view: "sessions", page: 0, pages: 1, title: "ACTIVE", layout }];
  // entries on every other key, so the rows are not simply keys 0..n-1
  for (let i = 0; i < n; i++) {
    msgs.push({ kind: "SET_SLOT", key: i * 2 <= 26 ? i * 2 : 2 * i - 27, state: "idle", flags: { ...NO, selected: i === selectedIdx }, label: `C${i}`, title: `Chat ${i}`, age: `${i}m` });
  }
  for (const m of msgs) s = applyHostMessage(s, m, 0);
  return s;
}

describe("LIST layout in the simulator", () => {
  test("rows are the non-empty keys in key order; the window is 10 entries around the selection", () => {
    const s = state(14, 11);
    const w = listWindow(s);
    expect(w.entries).toHaveLength(14);
    expect([...w.entries].sort((a, b) => a - b)).toEqual(w.entries);
    expect(w.top).toBe(10);
    expect(listWindow(state(14, 3)).top).toBe(0);
    expect(listWindow(state(14, -1)).top).toBe(0);
  });

  test("the selected row is filled RGB(48,48,48) to x 235; the thumb shows past 10 entries", () => {
    const s = state(14, 11);
    const fb = renderV4(s, 1000);
    const row1y = LIST.rowsY + LIST.rowH; // entry 11 is row 1 of the window starting at 10
    expect(fb.get(230, row1y + 15)).toBe(rgb565([48, 48, 48]));
    expect(fb.get(236, row1y + 15)).toBe(0);
    expect(fb.get(237, LIST.rowsY + Math.floor((160 * 10) / 14))).toBe(rgb565([128, 128, 128]));
    const few = renderV4(state(5, 0), 1000);
    for (let y = 60; y < 224; y++) expect(few.get(237, y)).toBe(0);
  });

  test("List only with version 5, layout list, in Sessions or TO DO; the SEQ LED follows", () => {
    expect(usesList(state(3, 0))).toBe(true);
    expect(usesList(state(3, 0, "buddy"))).toBe(false);
    expect(usesList(state(3, 0, "list", 4))).toBe(false);
    expect(buttonLeds(state(3, 0), 0).SEQ).toBe("glow"); // LED language v2 (docs/ui-v3.md section 9.9)
    expect(buttonLeds(state(3, 0, "buddy"), 0).SEQ).toBe("off");
    const tasks = applyHostMessage(state(3, 0), { kind: "SET_VIEW", view: "tasks", page: 0, pages: 1, title: "", layout: "list" }, 0);
    expect(usesList(tasks)).toBe(false);
  });

  test("a version 4 SET_VIEW (no layout byte) keeps the state as before: no layout, no row fields", () => {
    let s = initialState(4);
    s = applyHostMessage(s, { kind: "SET_VIEW", view: "inbox", page: 0, pages: 1, title: "TO DO 1" }, 0);
    s = applyHostMessage(s, { kind: "SET_SLOT", key: 0, state: "failed", flags: NO, label: "x" }, 0);
    expect(s.view).toEqual({ view: "inbox", page: 0, pages: 1, title: "TO DO 1" });
    expect(s.slots[0]).toEqual({ state: "failed", flags: NO, label: "x" });
  });
});
