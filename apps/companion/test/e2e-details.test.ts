import { afterEach, describe, expect, test } from "bun:test";
import { rig, type Rig } from "./rig";

let r: Rig | undefined;
afterEach(async () => {
  await r?.stop();
  r = undefined;
});

describe("DETAILS page end to end (docs/ux-v2.md section 7, a protocol version 3 device)", () => {
  test("LFO opens the page with the chat details, PRESETS pages, LFO closes", async () => {
    r = await rig({ deviceMax: 3 });
    const x = r;
    expect(x.device.state.link.proto).toBe(3);
    const s = x.adapter.snapshotNow().sessions.find((v) => v.ref.sessionId === "s-claude-fw");
    if (!s) throw new Error("fixture changed");
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    x.adapter.upsertSession({ ...s, summary: "editing view.ts", details: { activity: "editing view.ts", model: "opus-4-5", contextPct: 42, turns: 7, lastMessage: `All done. ${long}`, lastMessageAt: s.createdAt } });
    await x.driver.press(x.slotOf("s-claude-fw"));
    await x.driver.waitFor((d) => d.slots[x.slotOf("s-claude-fw")]?.flags.selected === true);
    await x.driver.waitFor((d) => d.detail.lines[2].endsWith("editing view.ts"));
    await x.driver.tap("LFO");
    await x.driver.waitFor((d) => d.view.view === "detail");
    const st = x.device.state;
    expect(st.view.title).toBe("DETAILS fw codec");
    expect(st.view.pages).toBeGreaterThan(1);
    expect(st.text[0]?.style).toBe("heading");
    expect(st.text.map((t) => t.text)).toContain("Now: editing view.ts");
    expect(st.text.map((t) => t.text)).toContain("Context 42%  turns 7");
    expect(st.legend).toEqual(["", "", "", ""]);
    expect(x.hostFrames.filter((f) => f.message.kind === "SET_TEXT").length).toBeGreaterThanOrEqual(4);
    x.device.turn("PRESETS", 1);
    await x.driver.waitFor((d) => d.view.page === 1);
    expect(x.device.state.text[0]?.style).not.toBe(undefined);
    await x.driver.tap("LFO");
    await x.driver.waitFor((d) => d.view.view === "sessions");
    expect(x.device.state.legend).toEqual(["SHOW", "REPO", "TASK", "TALK"]);
  });
});
