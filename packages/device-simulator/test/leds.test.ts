import { describe, expect, test } from "bun:test";
import type { SlotState } from "@fm1/device-protocol";
import { buttonLeds, keyLed, type LedLevel } from "../src/leds";
import { initialState, type DeviceState, type Slot } from "../src/state";

const slot = (state: SlotState, selected = false): Slot => ({
  state,
  flags: { selected, codex: false, stale: false, pinned: false },
  label: "",
});
const sample = (s: Slot, times: number[]): LedLevel[] => times.map((t) => keyLed(s, t, true));

describe("key LED patterns (protocol section 6)", () => {
  test("steady states", () => {
    expect(sample(slot("working"), [0, 500, 1999])).toEqual(["full", "full", "full"]);
    expect(sample(slot("idle"), [0, 900])).toEqual(["glow", "glow"]);
    expect(sample(slot("completed_read"), [0])).toEqual(["glow"]);
    expect(sample(slot("empty"), [0])).toEqual(["off"]);
    expect(sample(slot("disconnected"), [0])).toEqual(["off"]);
  });

  test("timed patterns", () => {
    expect(sample(slot("approval_required"), [0, 499, 500, 999, 1000])).toEqual(["full", "full", "off", "off", "full"]);
    expect(sample(slot("failed"), [0, 149, 150, 299, 300])).toEqual(["full", "full", "off", "off", "full"]);
    expect(sample(slot("waiting_input"), [0, 500])).toEqual(["full", "glow"]);
    expect(sample(slot("completed_unread"), [0, 119, 120, 1999, 2000])).toEqual(["full", "full", "glow", "glow", "full"]);
    expect(sample(slot("unknown"), [0, 119, 120])).toEqual(["off", "off", "glow"]);
  });

  test("selected overrides, but approval keeps a 100 ms dip every second", () => {
    expect(sample(slot("failed", true), [0, 200])).toEqual(["full", "full"]);
    expect(sample(slot("approval_required", true), [0, 99, 100, 600, 1050])).toEqual(["off", "off", "full", "full", "off"]);
  });

  test("no host: every key glows", () => {
    expect(keyLed(slot("working", true), 0, false)).toBe("glow");
    expect(keyLed(slot("empty"), 0, false)).toBe("glow");
  });
});

describe("button LEDs", () => {
  const connected = (patch: Partial<DeviceState> = {}): DeviceState => ({
    ...initialState(),
    link: { ...initialState().link, phase: "connected" },
    ...patch,
  });

  test("no host: only OCT+ blinks slowly", () => {
    const s = initialState();
    const on = buttonLeds(s, 0);
    expect(on.OCT_UP).toBe("full");
    expect(buttonLeds(s, 600).OCT_UP).toBe("off");
    expect(Object.entries(on).filter(([, l]) => l !== "off").map(([b]) => b)).toEqual(["OCT_UP"]);
  });

  test("view buttons, REC, SAVE and GLO attention", () => {
    const base = initialState();
    expect(buttonLeds(connected(), 0).HOME).toBe("full");
    expect(buttonLeds(connected({ view: { ...base.view, view: "tasks" } }), 0).EDIT).toBe("full");
    expect(buttonLeds(connected({ view: { ...base.view, view: "inbox" } }), 600).GLO).toBe("full");
    const attention = connected({ status: { link: "ok", attentionCount: 2, text: "" } });
    expect([buttonLeds(attention, 0).GLO, buttonLeds(attention, 600).GLO]).toEqual(["full", "off"]);
    expect(buttonLeds(connected({ voice: { ...base.voice, voice: "recording" } }), 0).REC).toBe("full");
    const transcribing = connected({ voice: { ...base.voice, voice: "transcribing" } });
    expect([buttonLeds(transcribing, 0).REC, buttonLeds(transcribing, 200).REC]).toEqual(["full", "off"]);
    expect(buttonLeds(connected({ voice: { ...base.voice, voice: "reviewing" } }), 0).SAVE).toBe("full");
  });
});
