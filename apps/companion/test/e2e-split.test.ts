// Protocol version 6 over the device link (docs/ui-v3.md section 10): SPLIT keys reach a version 6 simulator with the
// keys byte, the chosen flag and the black-row chips; SETTINGS opens on a held ARP; a version 5 device sees none of it.
// Also the render guards (strip below 6, order rules) and the config keys `settings` and `split`.
import { afterEach, describe, expect, test } from "bun:test";
import type { DeviceView, SlotView } from "@fm1/agent-core";
import { encode, type HostMessage, type SetView } from "@fm1/device-protocol";
const writeBody = (m: HostMessage): number[] => encode(m, 1);
import { buttonLeds, keyLed, renderV4, SIM_VERSIONS_V6 } from "@fm1/device-simulator";
import { ConfigError, DEFAULT_CONFIG, mergeConfig, serializable } from "../src/config";
import { diffFrames, framesFor, fullFrames, slotFrame, viewFrame } from "../src/device/render";
import { rig, type Rig } from "./rig";

let r: Rig | undefined;
afterEach(async () => {
  await r?.stop();
  r = undefined;
});

const BUDDY = { sessions: "buddy", inbox: "list" } as const;
const WHITE = 0xffff;

describe("protocol version 6 end to end", () => {
  test("a version 6 device with Keys Split: keys byte, chips with the chosen ALL, LEDs, white sessions only", async () => {
    r = await rig({ deviceMax: SIM_VERSIONS_V6.max, layouts: BUDDY, settings: { keys: "split" } });
    const x = r;
    expect(x.device.state.link.proto).toBe(6);
    const st = await x.driver.waitFor((d) => d.view.keys === "split" && d.slots[1]?.label === "ALL" && d.slots[5]?.label === "YOU");
    expect(st.slots[1]?.flags.chosen).toBe(true);
    expect([st.slots[3]?.label, st.slots[5]?.label]).toEqual(["PIN", "YOU"]);
    expect(st.view.taskPages).toBeGreaterThanOrEqual(1);
    // the chosen chip is filled white (x0 = 22 - 13 = 9, line A at y 168), the stem below it too
    const fb = renderV4(st, 0);
    expect(fb.px[170 * 240 + 10]).toBe(WHITE);
    expect(fb.px[190 * 240 + 22]).toBe(WHITE);
    // CHOSEN LED: breathing with the selection (the backlight layer)
    expect(keyLed(st.slots[1]!, 100, true, 6)).toBe("breath");
    expect(keyLed(st.slots[1]!, 800, true, 6)).toBe("breath");
    // every SET_VIEW since the handshake carried the keys byte; no black key was ever selected
    const views = x.hostFrames.map((f) => f.message).filter((m): m is SetView => m.kind === "SET_VIEW");
    expect(views.at(-1)?.keys).toBe("split");
    await x.driver.turn("SELECT", 1);
    const sel = await x.driver.waitFor((d) => d.slots.some((s) => s.flags.selected));
    expect([1, 3, 5, 8, 10, 13, 15, 17, 20, 22, 25].some((k) => sel.slots[k]?.flags.selected)).toBe(false);
  });

  test("hold ARP 1 s opens SETTINGS (view 6, ARP lit); SAVE switches Keys; text before SET_VIEW and all 27 slots", async () => {
    r = await rig({ deviceMax: SIM_VERSIONS_V6.max, layouts: BUDDY });
    const x = r;
    await x.driver.tap("ARP");
    await x.driver.waitFor((d) => d.lastResult?.text === "Hold ARP: settings");
    await x.driver.hold("ARP", 1100);
    const st = await x.driver.waitFor((d) => d.view.view === "settings");
    expect(st.view.title).toBe("SETTINGS");
    expect(st.text[0]?.text).toBe("Keys                Ranked");
    expect(buttonLeds(st, 0).ARP).toBe("full");
    expect(buttonLeds(st, 0).HOME).toBe("glow"); // active controls (docs/ui-v3.md section 9.9): HOME closes SETTINGS
    const fb = renderV4(st, 0);
    expect(fb.px[23 * 240 + 100]).not.toBe(0); // the cursor row's background
    const from = x.hostFrames.length;
    await x.driver.tap("SAVE");
    await x.driver.waitFor((d) => d.view.keys === "split" && d.slots[1]?.label === "ALL");
    await x.sleep(600); // the paced link drains the 27-slot flush
    const sent = x.hostFrames.slice(from).map((f) => f.message);
    const viewAt = sent.findIndex((m) => m.kind === "SET_VIEW" && m.keys === "split");
    expect(sent.slice(0, viewAt).filter((m) => m.kind === "SET_TEXT").map((m) => (m.kind === "SET_TEXT" ? m.row : -1))).toEqual([0, 3, 6, 9]);
    expect(new Set(sent.filter((m) => m.kind === "SET_SLOT").map((m) => (m.kind === "SET_SLOT" ? m.key : -1))).size).toBe(27);
    expect(x.companion.config.settings).toEqual({ keys: "split" });
    expect(x.companion.feedback.at(-1)?.text).toBe("Keys: split");
    await x.driver.tap("LFO");
    await x.driver.waitFor((d) => d.view.view === "sessions" && d.view.keys === "split");
  });

  test("a version 5 device with a saved Split: no keys byte, no chosen flag, no view 6, ARP inert", async () => {
    r = await rig({ layouts: BUDDY, settings: { keys: "split" } });
    const x = r;
    expect(x.device.state.link.proto).toBe(5);
    await x.driver.hold("ARP", 1100);
    await x.sleep(100);
    const msgs = x.hostFrames.map((f) => f.message);
    expect(msgs.some((m) => m.kind === "SET_VIEW" && (m.keys !== undefined || m.view === "settings"))).toBe(false);
    expect(msgs.some((m) => m.kind === "SET_SLOT" && m.flags.chosen !== undefined)).toBe(false);
    expect(x.device.state.view.view).toBe("sessions");
    expect(x.device.state.slots[1]?.label).not.toBe("ALL");
  });
});

const slot = (over: Partial<SlotView> = {}): SlotView => ({ state: "idle", label: "x", selected: false, provider: null, stale: false, pinned: false, title: "", age: "", ...over });
const view = (over: Partial<DeviceView> = {}): DeviceView => ({
  view: "sessions",
  page: 0,
  pages: 1,
  title: "ACTIVE 1",
  slots: Array.from({ length: 27 }, () => slot()),
  detail: { provider: null, state: "empty", lines: ["", "", "", ""] },
  voice: { state: "ready", level: 0, elapsedDs: 0, target: "" },
  legend: ["SHOW", "REPO", "", "TALK"],
  status: { link: "ok", attentionCount: 0, text: "" },
  text: Array.from({ length: 12 }, () => ({ style: "body" as const, text: "" })),
  layout: "buddy",
  ...over,
});

describe("render: protocol 6 forms (docs/ui-v3.md section 10.6)", () => {
  test("SET_VIEW carries keys (and the task page for split) only with the layout byte; bodies encode", () => {
    const f = viewFrame(view({ keys: "split", taskPage: 1, taskPages: 3 }));
    expect(f).toMatchObject({ layout: "buddy", keys: "split", taskPage: 1, taskPages: 3 });
    expect(writeBody(f).length).toBeGreaterThan(0);
    expect(viewFrame(view({ keys: "ranked" }))).toMatchObject({ keys: "ranked" });
    expect(viewFrame(view({ keys: "ranked" })).taskPage).toBeUndefined();
    expect(viewFrame(view())).not.toHaveProperty("keys");
    const settings = viewFrame(view({ view: "settings", keys: "ranked", title: "SETTINGS" }));
    expect(writeBody(settings).length).toBeGreaterThan(0);
  });

  test("SET_SLOT: chosen only when set (never with selected); RANKED slots byte-identical", () => {
    expect(slotFrame(1, slot({ chosen: true })).flags).toEqual({ selected: false, codex: false, stale: false, pinned: false, chosen: true });
    expect(slotFrame(0, slot()).flags).toEqual({ selected: false, codex: false, stale: false, pinned: false });
    expect(slotFrame(0, slot({ chosen: true, selected: true })).flags.chosen).toBeUndefined();
    expect(writeBody(slotFrame(1, slot({ chosen: true }), true)).length).toBeGreaterThan(0);
  });

  test("below 6: keys/task bytes and chosen stripped, view 6 dropped; at 6 kept", () => {
    const frames: HostMessage[] = [viewFrame(view({ keys: "split", taskPage: 0, taskPages: 2 })), slotFrame(1, slot({ chosen: true }), true), viewFrame(view({ view: "settings", keys: "ranked" }))];
    const v5 = framesFor(5, frames);
    expect(v5).toHaveLength(2);
    expect(v5[0]).not.toHaveProperty("keys");
    expect(v5[0]).not.toHaveProperty("taskPages");
    expect(v5[0]).toHaveProperty("layout");
    expect(v5[1]?.kind === "SET_SLOT" && v5[1].flags).toEqual({ selected: false, codex: false, stale: false, pinned: false });
    expect(framesFor(6, frames)).toEqual(frames);
    expect(framesFor(4, frames)[0]).not.toHaveProperty("layout");
  });

  test("order rules: a keys change sends all text groups before SET_VIEW and all 27 slots; SPLIT view 0 to voice too", () => {
    const a = view({ keys: "ranked" });
    const b = view({ keys: "split", taskPage: 0, taskPages: 1 });
    const d = diffFrames(a, b);
    expect(d.slots).toHaveLength(27);
    const kinds = d.frames.map((f) => f.kind);
    expect(kinds.slice(0, 5)).toEqual(["SET_TEXT", "SET_TEXT", "SET_TEXT", "SET_TEXT", "SET_VIEW"]);
    const voice = diffFrames(b, { ...b, view: "voice" });
    expect(voice.frames.map((f) => f.kind).slice(0, 5)).toEqual(["SET_TEXT", "SET_TEXT", "SET_TEXT", "SET_TEXT", "SET_VIEW"]);
    // RANKED view 0 to voice: only changed groups (as version 5)
    const rv = diffFrames(a, { ...a, view: "voice" });
    expect(rv.frames.filter((f) => f.kind === "SET_TEXT")).toHaveLength(0);
    const full = fullFrames(b);
    expect(full[0]).toMatchObject({ kind: "SET_VIEW", keys: "split" });
  });
});

describe("config: settings and split (docs/ui-v3.md sections 10.2 and 10.10)", () => {
  test("defaults; validated; written only when not default", () => {
    expect(DEFAULT_CONFIG.settings).toEqual({ keys: "ranked" });
    expect(DEFAULT_CONFIG.split).toEqual({ chosen: "all", task: null, taskPage: 0 });
    expect(serializable(DEFAULT_CONFIG)).not.toHaveProperty("settings");
    expect(serializable(DEFAULT_CONFIG)).not.toHaveProperty("split");
    const c = mergeConfig(DEFAULT_CONFIG, { settings: { keys: "split" }, split: { chosen: "task", task: "b/h/p/t", taskPage: 2 } });
    expect(serializable(c).settings).toEqual({ keys: "split" });
    expect(serializable(c).split).toEqual({ chosen: "task", task: "b/h/p/t", taskPage: 2 });
    expect(() => mergeConfig(DEFAULT_CONFIG, { settings: { keys: "big" } })).toThrow(ConfigError);
    expect(() => mergeConfig(DEFAULT_CONFIG, { settings: { color: "x" } })).toThrow(ConfigError);
    expect(() => mergeConfig(DEFAULT_CONFIG, { split: { chosen: "task", task: null } })).toThrow(ConfigError);
    expect(() => mergeConfig(DEFAULT_CONFIG, { split: { chosen: "all", task: "b/h/p/t" } })).toThrow(ConfigError);
    expect(() => mergeConfig(DEFAULT_CONFIG, { split: { chosen: "task", task: "b/h/p" } })).toThrow(ConfigError);
    expect(() => mergeConfig(DEFAULT_CONFIG, { split: { taskPage: 127 } })).toThrow(ConfigError);
    expect(() => mergeConfig(DEFAULT_CONFIG, { split: { taskPage: 1.5 } })).toThrow(ConfigError);
    expect(() => mergeConfig(DEFAULT_CONFIG, { split: { extra: 1 } })).toThrow(ConfigError);
  });
});
