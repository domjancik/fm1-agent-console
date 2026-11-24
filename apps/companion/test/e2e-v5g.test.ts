// The GROUPED round over the device link (docs/ui-v3.md section 9): Sessions starts Grouped with protocol 5, every
// slot carries the row byte (and the header on a group's first key), a version 4 device sees none of it, the reader
// opens on PRESETS, the config keeps the pins (two lists since 2026-11-19) and the Grouped layout.
import { afterEach, describe, expect, test } from "bun:test";
import type { DeviceView } from "@fm1/agent-core";
import { buttonLeds } from "@fm1/device-simulator";
import { DEFAULT_CONFIG, mergeConfig, serializable } from "../src/config";
import { diffFrames, framesFor, fullFrames, slotFrame } from "../src/device/render";
import { rig, type Rig } from "./rig";

let r: Rig | undefined;
afterEach(async () => {
  await r?.stop();
  r = undefined;
});

describe("GROUPED end to end (docs/ui-v3.md sections 9.1-9.5)", () => {
  test("Sessions is Grouped by default: SET_VIEW layout 2, each group's first key carries the header, rows carry indents", async () => {
    r = await rig();
    const x = r;
    const d = await x.driver.waitFor((s) => s.view.layout === "grouped" && s.slots.some((sl) => sl.head !== undefined));
    expect(d.link.proto).toBe(5);
    const used = d.slots.filter((s) => s.state !== "empty");
    expect(used.every((s) => s.row !== undefined)).toBe(true);
    expect(used[0]?.row?.start).toBe(true);
    for (const s of d.slots) expect(s.head !== undefined).toBe(s.row?.start === true);
    const heads = d.slots.filter((s) => s.head).map((s) => s.head?.title);
    expect(new Set(heads).size).toBe(heads.length);
    expect(buttonLeds(d, 0).SEQ).toBe("glow");
    await x.driver.waitFor((s) => s.legend[0] === "SHOW");
    expect(x.device.state.legend).toEqual(["SHOW", "REPO", "TASK", "TALK"]);
  });

  test("a version 4 device never gets the row byte, the header or layout 2", async () => {
    r = await rig({ deviceMax: 4 });
    const x = r;
    await x.sleep(300);
    for (const { message: m } of x.hostFrames) {
      if (m.kind === "SET_VIEW") expect("layout" in m).toBe(false);
      if (m.kind === "SET_SLOT") expect("row" in m || "head" in m || "title" in m).toBe(false);
    }
    expect(x.companion.console.state.layouts.sessions.groups).toBeUndefined();
  });

  test("PRESETS opens the reader; LFO returns to Grouped", async () => {
    r = await rig();
    const x = r;
    await x.driver.waitFor((s) => s.view.layout === "grouped");
    const k = x.slotOf("s-claude-fw");
    await x.driver.press(k);
    await x.driver.waitFor((s) => s.slots[k]?.flags.selected === true);
    x.driver.turn("PRESETS", 1);
    await x.driver.waitFor((s) => s.view.view === "detail");
    expect(x.device.state.view.page).toBe(0);
    await x.driver.tap("LFO");
    await x.driver.waitFor((s) => s.view.view === "sessions" && s.view.layout === "grouped");
  });

  test("KNOB1 to PINNED: the title says PINNED, KNOB2/3 legend cells empty, the empty state in the header", async () => {
    r = await rig({ scope: "all" });
    const x = r;
    x.driver.turn("K1", 1);
    await x.driver.waitFor((s) => s.view.title.startsWith("PINNED") && s.legend[1] === "");
    expect(x.device.state.legend).toEqual(["SHOW", "", "", "TALK"]);
    await x.driver.waitFor((s) => s.text[0]?.text === "No pins yet");
    expect(x.device.state.text[1]?.text).toBe("hold a key to pin");
  });
});

function view(over: Partial<DeviceView> = {}): DeviceView {
  return {
    view: "sessions",
    page: 0,
    pages: 1,
    title: "ACTIVE 2",
    slots: Array.from({ length: 27 }, () => ({ state: "empty" as const, label: "", selected: false, provider: null, stale: false, pinned: false, title: "", age: "", row: { indent: 0 as const, start: false, task: false } })),
    detail: { provider: null, state: "empty", lines: ["", "", "", ""] },
    voice: { state: "ready", level: 0, elapsedDs: 0, target: "" },
    legend: ["SHOW", "REPO", "TASK", "TALK"],
    status: { link: "ok", attentionCount: 0, text: "" },
    text: Array.from({ length: 12 }, () => ({ style: "body" as const, text: "" })),
    layout: "grouped",
    ...over,
  };
}

describe("render.ts (docs/ui-v3.md section 9.5)", () => {
  const header = { state: "failed" as const, label: "fw", selected: true, provider: "claude" as const, stale: false, pinned: false, title: "fw build", age: "1m", row: { indent: 1 as const, start: true, task: false }, head: { state: "failed" as const, pinned: false, title: "Firmware v5", count: "1 need you" } };
  test("slotFrame carries the row byte and the header; framesFor strips them below 5", () => {
    const f = slotFrame(0, header);
    expect(f.row).toEqual({ indent: 1, start: true, task: false });
    expect(f.head).toEqual(header.head);
    const member = slotFrame(1, { ...header, row: { indent: 2, start: false, task: false }, head: undefined });
    expect(member.head).toBeUndefined();
    const v = view({ slots: [header, ...view().slots.slice(1)] });
    const full = fullFrames(v);
    const s4 = framesFor(4, full).filter((m) => m.kind === "SET_SLOT");
    for (const m of s4) expect("row" in m || "head" in m || "title" in m).toBe(false);
    const s5 = framesFor(5, full).filter((m) => m.kind === "SET_SLOT");
    expect(s5[0]).toMatchObject({ row: { start: true }, head: { title: "Firmware v5" } });
  });

  test("a changed header goes out as one coalesced slot; a layout change to Grouped sends all four SET_TEXT groups first", () => {
    const a = view({ slots: [header, ...view().slots.slice(1)] });
    const b = view({ slots: [{ ...header, head: { ...header.head, count: "2 need you" } }, ...view().slots.slice(1)] });
    expect(diffFrames(a, b).slots.map((s) => s.key)).toEqual([0]);
    const d = diffFrames(view({ layout: "list" }), view());
    expect(d.frames.map((f) => f.kind)).toEqual(["SET_TEXT", "SET_TEXT", "SET_TEXT", "SET_TEXT", "SET_VIEW"]);
  });
});

describe("config (docs/ui-v3.md section 9.12)", () => {
  test("Grouped is the default (not written); a legacy mixed pin list migrates to two lists with every pin kept", () => {
    expect(DEFAULT_CONFIG.layouts.sessions).toBe("grouped");
    expect("layouts" in serializable(DEFAULT_CONFIG)).toBe(false);
    const pins = ["b/h/p/t/s1", "b/h/p/t", "b/h/p/t/s2", "b/h/p/t/s3", "b/h/p/t/s4", "b/h/p/t/s5", "b/h/p/t/s6", "b/h/p/t2", "b/h/p/t/s7"];
    const migrated = mergeConfig(DEFAULT_CONFIG, { pins });
    expect(migrated.sessionPins).toEqual(pins.filter((p) => p.split("/").length === 5));
    expect(migrated.taskPins).toEqual(["b/h/p/t", "b/h/p/t2"]);
    const written = serializable(migrated);
    expect("pins" in written).toBe(false);
    expect(written.sessionPins).toHaveLength(7);
    expect(written.taskPins).toHaveLength(2);
    expect(mergeConfig(DEFAULT_CONFIG, JSON.parse(JSON.stringify(written)))).toEqual(migrated);
    // no pins: neither key is written (an older companion keeps reading the file)
    expect("sessionPins" in serializable(DEFAULT_CONFIG) || "taskPins" in serializable(DEFAULT_CONFIG)).toBe(false);
    // a legacy list next to the new keys: merged, no duplicates
    expect(mergeConfig(DEFAULT_CONFIG, { sessionPins: ["b/h/p/t/s1"], pins: ["b/h/p/t/s1", "b/h/p/t/s9", "b/h/p/t3"] })).toMatchObject({ sessionPins: ["b/h/p/t/s1", "b/h/p/t/s9"], taskPins: ["b/h/p/t3"] });
    expect(serializable(mergeConfig(DEFAULT_CONFIG, { layouts: { sessions: "buddy" } })).layouts).toEqual({ sessions: "buddy", inbox: "list" });
  });
});
