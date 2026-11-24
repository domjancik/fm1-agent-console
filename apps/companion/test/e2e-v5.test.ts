// The LIST layout over the device link (docs/ui-v3.md section 8, protocol version 5): SEQ toggles Buddy and List per
// view, the companion remembers it, the slots carry row titles and ages, and a version 4 device sees none of it.
// Section 9 made Grouped the Sessions default; these section 8 tests start Sessions in Buddy (BUDDY below).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceView } from "@fm1/agent-core";
import { buttonLeds } from "@fm1/device-simulator";
import { DEFAULT_CONFIG, DEFAULT_LAYOUTS, loadConfig, mergeConfig, saveConfig, serializable, ConfigError } from "../src/config";
import { diffFrames, framesFor, fullFrames, slotFrame, viewFrame } from "../src/device/render";
import { rig, type Rig } from "./rig";

let r: Rig | undefined;
const BUDDY = { layouts: { sessions: "buddy", inbox: "list" } } as const;
const BUDDY_LAYOUTS = { sessions: "buddy", inbox: "list" } as const;
afterEach(async () => {
  await r?.stop();
  r = undefined;
});

const selectFw = async (x: Rig): Promise<number> => {
  const k = x.slotOf("s-claude-fw");
  await x.driver.press(k);
  await x.driver.waitFor((d) => d.slots[k]?.flags.selected === true);
  return k;
};

describe("protocol version 5 end to end", () => {
  test("the simulator agrees 5; slots carry title and age; Sessions starts in Buddy, TO DO in List", async () => {
    r = await rig(BUDDY);
    const x = r;
    expect(x.device.state.link.proto).toBe(5);
    expect(x.device.state.view.layout).toBe("buddy");
    const k = x.slotOf("s-claude-fw");
    // (the slots follow the HELLO_ACK resync as one coalesced diff once the console knows the version)
    const slot = (await x.driver.waitFor((d) => (d.slots[k]?.title ?? "") !== "")).slots[k];
    expect(slot?.title?.length).toBeGreaterThan(0);
    expect(slot?.title?.length).toBeLessThanOrEqual(20);
    expect(slot?.age?.length).toBeGreaterThan(0);
    expect(slot?.age?.length).toBeLessThanOrEqual(3);
    await x.driver.tap("GLO");
    await x.driver.waitFor((d) => d.view.view === "inbox");
    expect(x.device.state.view.layout).toBe("list");
    expect(buttonLeds(x.device.state, 0).SEQ).toBe("glow"); // LED language v2 (docs/ui-v3.md section 9.9)
  });

  test("SEQ: all four SET_TEXT groups before SET_VIEW(list); selection kept; the choice saved in the config", async () => {
    r = await rig(BUDDY);
    const x = r;
    const k = await selectFw(x);
    const from = x.hostFrames.length;
    await x.driver.tap("SEQ");
    await x.driver.waitFor((d) => d.view.layout === "list");
    const sent = x.hostFrames.slice(from).map((f) => f.message);
    const viewAt = sent.findIndex((m) => m.kind === "SET_VIEW" && m.layout === "list");
    expect(viewAt).toBeGreaterThanOrEqual(4);
    expect(sent.slice(0, viewAt).filter((m) => m.kind === "SET_TEXT").map((m) => (m.kind === "SET_TEXT" ? m.row : -1))).toEqual([0, 3, 6, 9]);
    // a toggle needs no slot traffic: the row fields are already there
    expect(sent.some((m) => m.kind === "SET_SLOT")).toBe(false);
    expect(x.device.state.slots[k]?.flags.selected).toBe(true);
    expect((x.device.state.text[1]?.text.length ?? 99) <= 24).toBe(true);
    expect(x.companion.config.layouts).toEqual({ sessions: "list", inbox: "list" });
    expect(buttonLeds(x.device.state, 0).SEQ).toBe("glow"); // LED language v2 (docs/ui-v3.md section 9.9)
    await x.driver.tap("SEQ");
    await x.driver.waitFor((d) => d.view.layout === "grouped");
    // (section 9.1: Sessions cycles Buddy -> List -> Grouped)
    expect(x.companion.config.layouts).toEqual({ sessions: "grouped", inbox: "list" });
  });

  test("a version 4 device never gets a layout byte or row fields, and SEQ does nothing", async () => {
    r = await rig({ ...BUDDY, deviceMax: 4 });
    const x = r;
    expect(x.device.state.link.proto).toBe(4);
    await selectFw(x);
    await x.driver.tap("SEQ");
    await x.driver.tap("GLO");
    await x.driver.waitFor((d) => d.view.view === "inbox");
    await x.sleep(200);
    for (const { message: m } of x.hostFrames) {
      if (m.kind === "SET_VIEW") expect("layout" in m).toBe(false);
      if (m.kind === "SET_SLOT") expect("title" in m || "age" in m).toBe(false);
    }
    expect(x.device.state.view.layout).toBeUndefined();
    expect(x.companion.config.layouts).toEqual(BUDDY_LAYOUTS);
  });
});

function view(over: Partial<DeviceView> = {}): DeviceView {
  return {
    view: "sessions",
    page: 0,
    pages: 1,
    title: "ACTIVE 0",
    slots: Array.from({ length: 27 }, () => ({ state: "empty" as const, label: "", selected: false, provider: null, stale: false, pinned: false, title: "", age: "" })),
    detail: { provider: null, state: "empty", lines: ["", "", "", ""] },
    voice: { state: "ready", level: 0, elapsedDs: 0, target: "" },
    legend: ["SHOW", "REPO", "TASK", "TALK"],
    status: { link: "ok", attentionCount: 0, text: "" },
    text: Array.from({ length: 12 }, () => ({ style: "body" as const, text: "" })),
    layout: "buddy",
    ...over,
  };
}

describe("selection moves on the wire (review fix 2026-11-18)", () => {
  test("the new selection goes out first and in the same flush as the deselect: the device never shows none selected", async () => {
    r = await rig(BUDDY);
    const x = r;
    const k = await selectFw(x);
    await x.driver.tap("SEQ");
    await x.driver.waitFor((d) => d.view.layout === "list");
    await x.sleep(500);
    for (const dir of [1, -1]) {
      const from = x.hostFrames.length;
      const at: number[] = [];
      const push = x.hostFrames.push.bind(x.hostFrames);
      x.hostFrames.push = (...items) => {
        for (const _ of items) at.push(x.clock.now());
        return push(...items);
      };
      x.driver.turn("SELECT", dir);
      await x.driver.waitFor((d) => d.slots.filter((s) => s.flags.selected).length === 1 && d.slots[k]?.flags.selected === (dir === -1));
      await x.sleep(200);
      x.hostFrames.push = push;
      const slots = x.hostFrames.slice(from).flatMap((f, i) => (f.message.kind === "SET_SLOT" ? [{ m: f.message, at: at[i] ?? 0 }] : []));
      expect(slots.length).toBe(2);
      expect(slots[0]?.m.flags.selected).toBe(true);
      expect(slots[1]?.m.flags.selected).toBe(false);
      // one flush (back to back at the link's pace), not the 50 ms coalescing interval apart
      expect((slots[1]?.at ?? 0) - (slots[0]?.at ?? 0)).toBeLessThan(40);
      await x.sleep(200);
    }
  });
});

describe("render (version 5)", () => {
  test("SET_VIEW carries the layout only when the view has one; SET_SLOT the row fields only with version 5", () => {
    expect(viewFrame(view()).layout).toBe("buddy");
    expect("layout" in viewFrame(view({ layout: null }))).toBe(false);
    expect(slotFrame(0, view().slots[0], true)).toMatchObject({ title: "", age: "" });
    expect("title" in slotFrame(0, { state: "idle", label: "x", selected: false, provider: null, stale: false, pinned: false })).toBe(false);
  });

  test("framesFor strips the version 5 fields for a device below 5, and keeps them for 5", () => {
    const frames = fullFrames(view({ layout: "list" }));
    const v4 = framesFor(4, frames);
    expect(v4.some((f) => (f.kind === "SET_VIEW" && "layout" in f) || (f.kind === "SET_SLOT" && ("title" in f || "age" in f)))).toBe(false);
    expect(v4).toHaveLength(frames.length);
    expect(framesFor(5, frames)).toEqual(frames);
    expect(framesFor(2, frames).some((f) => f.kind === "SET_TEXT")).toBe(false);
  });

  test("a layout change sends all four SET_TEXT groups before SET_VIEW, even unchanged ones", () => {
    const d = diffFrames(view(), view({ layout: "list" }));
    expect(d.frames.map((f) => f.kind)).toEqual(["SET_TEXT", "SET_TEXT", "SET_TEXT", "SET_TEXT", "SET_VIEW"]);
    expect(d.slots).toEqual([]);
    expect(diffFrames(view(), view()).frames).toEqual([]);
  });
});

describe("config layouts (docs/ui-v3.md section 8.7)", () => {
  test("validated: only sessions/inbox, buddy/list (Sessions also grouped, section 9.12)", () => {
    expect(DEFAULT_CONFIG.layouts).toEqual({ sessions: "grouped", inbox: "list" });
    expect(DEFAULT_LAYOUTS).toEqual(DEFAULT_CONFIG.layouts);
    expect(mergeConfig(DEFAULT_CONFIG, { layouts: { sessions: "buddy" } }).layouts).toEqual({ sessions: "buddy", inbox: "list" });
    expect(() => mergeConfig(DEFAULT_CONFIG, { layouts: { inbox: "grouped" } })).toThrow(ConfigError);
    expect(mergeConfig(DEFAULT_CONFIG, { layouts: { sessions: "list" } }).layouts).toEqual({ sessions: "list", inbox: "list" });
    expect(() => mergeConfig(DEFAULT_CONFIG, { layouts: { tasks: "list" } })).toThrow(ConfigError);
    expect(() => mergeConfig(DEFAULT_CONFIG, { layouts: { inbox: "grid" } })).toThrow(ConfigError);
    expect(() => mergeConfig(DEFAULT_CONFIG, { layouts: "list" })).toThrow(ConfigError);
  });

  test("saved only when not the default, so an older companion still reads the file; round-trips", async () => {
    expect("layouts" in serializable(DEFAULT_CONFIG)).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "fm1-cfg-"));
    const path = join(dir, "config.json");
    await saveConfig(DEFAULT_CONFIG, path);
    expect(JSON.parse(readFileSync(path, "utf8")).layouts).toBeUndefined();
    const changed = mergeConfig(DEFAULT_CONFIG, { layouts: { sessions: "list", inbox: "buddy" } });
    await saveConfig(changed, path);
    expect(JSON.parse(readFileSync(path, "utf8")).layouts).toEqual({ sessions: "list", inbox: "buddy" });
    expect((await loadConfig(path)).layouts).toEqual({ sessions: "list", inbox: "buddy" });
  });
});

describe("layouts from the desktop UI config (docs/ui-v3.md section 8.7)", () => {
  test("setConfig applies the layouts to the console at once, without a re-sort", async () => {
    r = await rig(BUDDY);
    const x = r;
    await selectFw(x);
    const layouts = x.companion.console.state.layouts;
    x.companion.setConfig(mergeConfig(x.companion.config, { layouts: { sessions: "list" } }));
    await x.driver.waitFor((d) => d.view.layout === "list");
    expect(x.companion.console.state.layouts).toEqual(layouts);
    expect(x.companion.console.state.screen).toEqual({ sessions: "list", inbox: "list" });
  });
});
