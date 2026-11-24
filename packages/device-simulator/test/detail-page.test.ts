import { describe, expect, test } from "bun:test";
import { decode, encode, type HostMessage } from "@fm1/device-protocol";
import { DETAIL_HINT, layoutScreen, TEXT_COLOR, type DrawOp } from "../src/layout";
import { buttonLeds } from "../src/leds";
import { applyHostMessage, initialState, type DeviceState } from "../src/state";

const connected = (proto: number): DeviceState => ({ ...initialState(), link: { ...initialState().link, phase: "connected", proto } });

/** Frames go through the real codec, so the simulator sees what the wire carries. */
function apply(s: DeviceState, ...msgs: HostMessage[]): DeviceState {
  let out = s;
  msgs.forEach((m, i) => {
    const d = decode(encode(m, i));
    if (!d.ok) throw new Error(d.error.code);
    out = applyHostMessage(out, d.value.message as HostMessage, 0);
  });
  return out;
}

const page: HostMessage[] = [
  { kind: "SET_VIEW", view: "detail", page: 0, pages: 2, title: "DETAILS fw codec" },
  { kind: "SET_TEXT", row: 0, lines: [{ style: "heading", text: "WORKING, 2m" }, { style: "body", text: "fw codec in C" }, { style: "muted", text: "Task: Firmware app" }] },
  { kind: "SET_TEXT", row: 3, lines: [{ style: "body", text: "Now: editing view.ts" }, { style: "muted", text: "Claude opus-4-5" }, { style: "body", text: "" }] },
  { kind: "SET_TEXT", row: 6, lines: [{ style: "body", text: "row6" }, { style: "body", text: "row7" }, { style: "body", text: "row8" }] },
  { kind: "SET_TEXT", row: 9, lines: [{ style: "body", text: "row9" }, { style: "body", text: "row10" }, { style: "heading", text: "row11" }] },
];

const texts = (ops: DrawOp[]): { text: string; y: number; color: string }[] =>
  ops.flatMap((o) => (o.t === "text" ? [{ text: o.text, y: o.y, color: o.color }] : []));

describe("DETAILS page (protocol version 3)", () => {
  test("SET_TEXT replaces the named rows only", () => {
    let s = apply(connected(3), ...page);
    expect(s.text[0]).toEqual({ style: "heading", text: "WORKING, 2m" });
    expect(s.text[11]).toEqual({ style: "heading", text: "row11" });
    s = apply(s, { kind: "SET_TEXT", row: 4, lines: [{ style: "body", text: "changed" }] });
    expect(s.text.map((r) => r.text).slice(3, 6)).toEqual(["Now: editing view.ts", "changed", ""]);
  });

  test("12 rows at y = 24 + 16n in their style colours, the hint band, no key strip or legend", () => {
    const s = apply(connected(3), ...page);
    const model = layoutScreen(s, 10_000);
    const all = model.regions.flatMap((r) => texts(r.ops));
    expect(all.find((t) => t.text === "WORKING, 2m")).toEqual({ text: "WORKING, 2m", y: 24, color: TEXT_COLOR.heading });
    expect(all.find((t) => t.text === "Task: Firmware app")).toEqual({ text: "Task: Firmware app", y: 56, color: TEXT_COLOR.muted });
    expect(all.find((t) => t.text === "row11")?.y).toBe(24 + 16 * 11);
    expect(all.map((t) => t.text)).toContain("PRESETS");
    expect(all.map((t) => t.text)).toContain("close");
    expect(DETAIL_HINT).toBe("PRESETS page  LFO close");
    expect(all.some((t) => t.text.startsWith("KNOB"))).toBe(false);
    expect(all.some((t) => t.text.startsWith("DETAILS fw codec"))).toBe(true);
  });

  test("a toast replaces the hint band", () => {
    let s = apply(connected(3), ...page);
    s = applyHostMessage(s, { kind: "COMMAND_RESULT", reqSeq: 1, result: "completed", text: "Opened on Mac" }, 1_000);
    const all = layoutScreen(s, 1_500).regions.flatMap((r) => texts(r.ops)).map((t) => t.text);
    expect(all).toContain("Opened on Mac");
    expect(all).not.toContain("PRESETS");
  });

  test("LFO LED is full on the DETAILS page", () => {
    const s = apply(connected(3), ...page);
    expect(buttonLeds(s, 0).LFO).toBe("full");
    expect(buttonLeds(connected(3), 0).LFO).toBe("off");
  });

  test("a version 2 link never draws the page (the host never sends it)", () => {
    const s = apply(connected(2), ...page);
    const all = layoutScreen(s, 10_000).regions.flatMap((r) => texts(r.ops)).map((t) => t.text);
    expect(all).not.toContain("WORKING, 2m");
  });
});
