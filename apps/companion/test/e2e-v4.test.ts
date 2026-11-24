// UI v3 over the device link (docs/ui-v3.md sections 5 and 6.3, protocol version 4): the speech bubble in SET_TEXT,
// PRESETS scrolling it, the order rule on every base <-> DETAILS switch, and a version 3 device left unchanged.
import { afterEach, describe, expect, test } from "bun:test";
import { rig, type Rig } from "./rig";

let r: Rig | undefined;
afterEach(async () => {
  await r?.stop();
  r = undefined;
});

const LONG = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");

async function withMessage(x: Rig): Promise<number> {
  const s = x.adapter.snapshotNow().sessions.find((v) => v.ref.sessionId === "s-claude-fw");
  if (!s) throw new Error("fixture changed");
  x.adapter.upsertSession({ ...s, details: { activity: "editing view.ts", model: "opus-4-5", lastMessage: `All done. ${LONG}`, lastMessageAt: s.createdAt } });
  const k = x.slotOf("s-claude-fw");
  await x.driver.press(k);
  await x.driver.waitFor((d) => d.slots[k]?.flags.selected === true);
  return k;
}

describe("protocol version 4 end to end", () => {
  test("the bubble: caption, the newest content, the more row; label <= 11; lines 2-3 empty", async () => {
    r = await rig({ deviceMax: 4 });
    const x = r;
    expect(x.device.state.link.proto).toBe(4);
    const k = await withMessage(x);
    await x.driver.waitFor((d) => d.text[1]?.text.startsWith("Now: editing view.ts") === true);
    const st = x.device.state;
    expect(st.view.view).toBe("sessions");
    expect(st.text[0]?.text).toMatch(/^(Working|Done|Needs|Idle|Failed|No status)/);
    expect(st.text[2]?.text.startsWith("All done.")).toBe(true);
    expect(st.text[6]?.text).not.toBe("");
    for (const row of st.text) expect(row.text.length).toBeLessThanOrEqual(28);
    expect(st.text.slice(7).every((t) => t.text === "")).toBe(true);
    expect(st.slots[k]?.label.length).toBeLessThanOrEqual(11);
    expect(st.detail.lines[1]).toBe("");
    expect(st.detail.lines[2]).toBe("");
    // SET_TEXT went out in a base view (version 4 only)
    expect(x.hostFrames.some((f) => f.message.kind === "SET_TEXT")).toBe(true);
  });

  test("PRESETS scrolls the bubble 5 rows per step and clamps; a selection change resets it", async () => {
    r = await rig({ deviceMax: 4 });
    const x = r;
    await withMessage(x);
    await x.driver.waitFor((d) => d.text[1]?.text.startsWith("Now:") === true);
    const first = x.device.state.text.slice(1, 6).map((t) => t.text);
    const next = x.device.state.text[6]?.text;
    x.device.turn("PRESETS", 1);
    await x.driver.waitFor((d) => d.text[1]?.text === next);
    for (let i = 0; i < 10; i++) x.device.turn("PRESETS", 1);
    await x.sleep(200);
    expect(x.device.state.text[6]?.text).toBe(""); // the last page: no more wedge
    for (let i = 0; i < 10; i++) x.device.turn("PRESETS", -1); // one step per ENCODER frame (the sign counts)
    await x.driver.waitFor((d) => d.text[1]?.text === first[0]);
    x.device.turn("PRESETS", 1);
    await x.driver.waitFor((d) => d.text[1]?.text === next);
    const other = x.slotOf("s-claude-idle");
    await x.driver.press(other);
    await x.driver.waitFor((d) => d.slots[other]?.flags.selected === true);
    expect(x.companion.console.state.detailScroll).toBe(0);
  });

  test("LFO: all four SET_TEXT groups go before SET_VIEW on the way in and on the way out", async () => {
    r = await rig({ deviceMax: 4 });
    const x = r;
    await withMessage(x);
    await x.driver.waitFor((d) => d.text[1]?.text.startsWith("Now:") === true);
    const mark = x.hostFrames.length;
    await x.driver.tap("LFO");
    await x.driver.waitFor((d) => d.view.view === "detail");
    await x.sleep(100);
    const inbound = x.hostFrames.slice(mark).map((f) => f.message);
    const viewAt = inbound.findIndex((m) => m.kind === "SET_VIEW" && m.view === "detail");
    const groups = inbound.slice(0, viewAt).filter((m) => m.kind === "SET_TEXT").map((m) => (m.kind === "SET_TEXT" ? m.row : -1));
    expect(groups.sort((a, b) => a - b)).toEqual([0, 3, 6, 9]);
    const st = x.device.state;
    expect(st.text[0]?.style).toBe("heading"); // header beside the hero
    expect(st.text[3]?.text.startsWith("Last message")).toBe(true); // the message first
    for (const row of st.text.slice(0, 3)) expect(row.text.length).toBeLessThanOrEqual(22);

    const back = x.hostFrames.length;
    await x.driver.tap("LFO");
    await x.driver.waitFor((d) => d.view.view === "sessions");
    await x.sleep(100);
    const outbound = x.hostFrames.slice(back).map((f) => f.message);
    const backAt = outbound.findIndex((m) => m.kind === "SET_VIEW");
    const groups2 = outbound.slice(0, backAt).filter((m) => m.kind === "SET_TEXT").map((m) => (m.kind === "SET_TEXT" ? m.row : -1));
    expect(groups2.sort((a, b) => a - b)).toEqual([0, 3, 6, 9]);
    expect(x.device.state.text[1]?.text.startsWith("Now:")).toBe(true);
  });

  test("a version 3 device gets no SET_TEXT outside DETAILS and the version 3 lines", async () => {
    r = await rig({ deviceMax: 3 });
    const x = r;
    expect(x.device.state.link.proto).toBe(3);
    await withMessage(x);
    await x.driver.waitFor((d) => d.detail.lines[2].includes("editing view.ts") || d.detail.lines[2] !== "");
    expect(x.hostFrames.some((f) => f.message.kind === "SET_TEXT")).toBe(false);
    expect(x.device.state.detail.lines[0]).not.toBe("");
  });
});

describe("protocol version 4: the companion's frames drawn by the simulated firmware screen", () => {
  test("hero, caption and the 5 bubble body rows get ink", async () => {
    const { renderV4, usesV4 } = await import("@fm1/device-simulator");
    r = await rig({ deviceMax: 4 });
    const x = r;
    await withMessage(x);
    await x.driver.waitFor((d) => d.text[2]?.text.startsWith("All done.") === true);
    const st = x.device.state;
    expect(usesV4(st)).toBe(true);
    const fb = renderV4(st, 0);
    const ink = (x0: number, y0: number, w: number, h: number): number => {
      let n = 0;
      for (let y = y0; y < y0 + h; y++) for (let xx = x0; xx < x0 + w; xx++) if (fb.get(xx, y) !== 0) n++;
      return n;
    };
    expect(ink(4, 20, 48, 48)).toBeGreaterThan(300); // the character
    expect(ink(8, 78, 160, 16)).toBeGreaterThan(50); // the caption
    for (let row = 0; row < 5; row++) expect(ink(8, 96 + 16 * row, 224, 16)).toBeGreaterThan(20); // 5 body rows
  });
});
