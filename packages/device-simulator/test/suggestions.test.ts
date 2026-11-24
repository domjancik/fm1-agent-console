// Suggested next prompts (docs/ui-v3.md section 11) need no new device feature: the host sends the `Next:` row and the
// review label as SET_TEXT rows in the heading style, which every version 4+ screen already draws in the accent colour.
// These tests pin that the simulator (and so the firmware, see reports/evidence/ui-v3/suggestions/) draws them so.
import { describe, expect, test } from "bun:test";
import type { HostMessage, TextStyle } from "@fm1/device-protocol";
import { applyHostMessage, initialState, type DeviceState } from "../src/state";
import { expand565 } from "../src/v4/raster";
import { renderV4, V4 } from "../src/v4/screen";

type Row = [TextStyle, string];
const text = (rows: Row[]): HostMessage[] => {
  const all = Array.from({ length: 12 }, (_, i): Row => rows[i] ?? ["body", ""]);
  return [0, 3, 6, 9].map((row) => ({ kind: "SET_TEXT", row, lines: all.slice(row, row + 3).map(([style, t]) => ({ style, text: t })) }));
};
const NO = { selected: false, codex: false, stale: false, pinned: false };

function state(proto: number, msgs: HostMessage[]): DeviceState {
  const s0 = initialState(proto);
  const start: DeviceState = { ...s0, link: { ...s0.link, phase: "connected", proto } };
  return msgs.reduce<DeviceState>((a, m) => applyHostMessage(a, m, 0), start);
}

/** Colours present in a band of rows (x 8-231). */
function colours(s: DeviceState, y0: number, y1: number): Set<string> {
  const fb = renderV4(s, 0);
  const out = new Set<string>();
  for (let y = y0; y < y1; y++) for (let x = 8; x < 232; x++) out.add(expand565(fb.px[y * 240 + x] ?? 0).join(","));
  return out;
}
const AMBER = expand565(((255 >> 3) << 11) | ((176 >> 2) << 5) | (0 >> 3)).join(",");
const WHITE = "255,255,255";

const sessions = (proto: number, layout?: "buddy" | "list"): HostMessage[] => [
  { kind: "SET_VIEW", view: "sessions", page: 0, pages: 1, title: "RECENT 7", ...(layout ? { layout } : {}) },
  { kind: "SET_SLOT", key: 3, state: "idle", flags: { ...NO, selected: true }, label: "refund impl", ...(proto >= 5 ? { title: "refund impl", age: "1m" } : {}) },
  { kind: "SET_DETAIL", provider: "claude", state: "idle", lines: ["Refund webhook", "", "", "REC next  PLAY open"] },
];

describe("the Next row and the review label are host text in the accent style", () => {
  for (const proto of [4, 5, 6]) {
    test(`Buddy (protocol ${proto}): body row 1 "Next: ..." is amber, the message below it white`, () => {
      const s = state(proto, [...sessions(proto, proto >= 5 ? "buddy" : undefined), ...text([["heading", "Idle, 1m"], ["heading", "Next: Run the full test"], ["body", "Done. The retry path now"]])]);
      expect(s.text[1]).toEqual({ style: "heading", text: "Next: Run the full test" });
      const next = colours(s, V4.bodyY, V4.bodyY + 16);
      expect(next.has(AMBER)).toBe(true);
      expect(next.has(WHITE)).toBe(false);
      expect(colours(s, V4.bodyY + 16, V4.bodyY + 32).has(WHITE)).toBe(true);
    });
  }

  test("List header (protocol 5): the Next row on header row 1 is amber", () => {
    const s = state(5, [...sessions(5, "list"), ...text([["heading", "Idle, 1m"], ["heading", "Next: Run the full test"], ["body", "Done. The retry"]])]);
    expect(colours(s, 38, 54).has(AMBER)).toBe(true);
  });

  test("voice review: body row 1 carries `Suggested 1/3  PRESETS next` in amber; the text below in white", () => {
    const s = state(6, [
      { kind: "SET_VIEW", view: "voice", page: 0, pages: 1, title: "TALK", layout: "buddy", keys: "ranked" },
      { kind: "SET_DETAIL", provider: "claude", state: "idle", lines: ["", "", "", "SAVE send  FX cancel"] },
      { kind: "SET_VOICE", voice: "reviewing", level: 0, elapsedDs: 0, target: "refund impl" },
      ...text([["body", ""], ["heading", "Suggested 1/3  PRESETS next"], ["body", "Run the full test suite and"], ["body", "fix what fails"]]),
    ]);
    expect(s.voice.voice).toBe("reviewing");
    const label = colours(s, V4.bodyY, V4.bodyY + 16);
    expect(label.has(AMBER)).toBe(true);
    expect(label.has(WHITE)).toBe(false);
    expect(colours(s, V4.bodyY + 16, V4.bodyY + 32).has(WHITE)).toBe(true);
  });
});
