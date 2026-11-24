// Suggested next prompts over the device link (docs/ui-v3.md section 11): the bubble's `Next:` row, the short REC tap
// (host-timed from the BUTTON edges), the review label, SAVE through the normal dispatch, and `No suggestion`.
import { afterEach, describe, expect, test } from "bun:test";
import { sessionKey } from "@fm1/agent-core";
import { buildUiState } from "../src/ui-bridge/ui-state";
import { rig, type Rig } from "./rig";

let r: Rig | undefined;
afterEach(async () => {
  await r?.stop();
  r = undefined;
});

const NEXT = ["Run the full test suite", "Open a PR"];

async function selectIdle(x: Rig, suggestions: string[] | null): Promise<void> {
  await x.driver.press(x.slotOf("s-claude-idle"));
  await x.driver.waitFor((s) => s.slots[x.slotOf("s-claude-idle")]?.flags.selected === true);
  const ref = x.adapter.snapshotNow().sessions.find((s) => s.ref.sessionId === "s-claude-idle")?.ref;
  if (!ref) throw new Error("fixture changed");
  x.adapter.setSuggestions(ref, suggestions);
  await x.sleep(50);
}

describe("suggested next prompt on the device", () => {
  test("Buddy shows `Next:`; a REC tap loads it into review (labelled), no transcription; SAVE sends it once", async () => {
    r = await rig({ layouts: { sessions: "buddy", inbox: "list" } });
    const x = r;
    await selectIdle(x, NEXT);
    expect(x.device.state.text.some((t) => t.style === "heading" && t.text === "Next: Run the full test")).toBe(true);
    expect(x.device.state.detail.lines[3]).toBe("REC next  PLAY open");

    await x.driver.tap("REC"); // 40 ms: a short tap
    await x.driver.waitFor((s) => s.voice.voice === "reviewing", 2000);
    expect(x.device.state.text[1]).toEqual({ style: "heading", text: "Suggested 1/2  PRESETS next" });
    expect(x.device.state.text[2]?.text).toBe("Run the full test suite");
    expect(x.transcriber.calls).toBe(0); // the take was dropped, never transcribed
    expect(x.captures.length).toBeLessThanOrEqual(1);
    const ui = buildUiState(x.companion, null);
    expect(ui.voice).toMatchObject({ state: "reviewing", transcript: "Run the full test suite", canSave: true });
    expect(x.adapter.deliveries).toHaveLength(0);

    x.driver.turn("PRESETS", 1);
    await x.driver.waitFor((s) => s.text[2]?.text === "Open a PR");
    expect(x.device.state.text[1]?.text).toBe("Suggested 2/2  PRESETS next");

    await x.driver.tap("SAVE");
    await x.driver.waitFor((s) => s.voice.voice === "delivered", 3000);
    await x.companion.idle();
    const target = x.adapter.snapshotNow().sessions.find((s) => s.ref.sessionId === "s-claude-idle")!;
    expect(x.adapter.deliveries).toEqual([{ requestId: "req-1", kind: "prompt", key: sessionKey(target.ref), text: "Open a PR" }]);
  });

  test("a hold still records and transcribes exactly as before", async () => {
    r = await rig({ layouts: { sessions: "buddy", inbox: "list" } });
    const x = r;
    await selectIdle(x, NEXT);
    await x.driver.hold("REC", 1200);
    await x.driver.waitFor((s) => s.voice.voice === "reviewing", 3000);
    expect(x.transcriber.calls).toBe(1);
    expect(x.companion.console.composer.state.source).toBe("voice");
  });

  test("no suggestion and no canned response: a tap toasts `No suggestion/canned` and the screen stays on Sessions", async () => {
    r = await rig({ layouts: { sessions: "buddy", inbox: "list" }, canned: [] });
    const x = r;
    await selectIdle(x, null);
    expect(x.device.state.detail.lines[3]).toBe("REC reply  PLAY open");
    await x.driver.tap("REC");
    await x.driver.waitFor((s) => s.lastResult?.text === "No suggestion/canned", 2000);
    await x.sleep(100);
    expect(x.device.state.view.view).toBe("sessions");
    expect(x.device.state.voice.voice).toBe("ready");
    expect(x.transcriber.calls).toBe(0);
    expect(x.adapter.deliveries).toHaveLength(0);
  });
});
