// Spec Phase 3 gate: the whole main flow is driven by FM-1 controls only (no mouse, no UI call).
import { afterEach, describe, expect, test } from "bun:test";
import { sessionKey } from "@fm1/agent-core";
import { buildUiState } from "../src/ui-bridge/ui-state";
import { rig, SMOKE_TEXT, type Rig } from "./rig";

let r: Rig | undefined;
afterEach(async () => {
  await r?.stop();
  r = undefined;
});

async function recordInto(x: Rig, sessionId: string, holdMs = 1200): Promise<void> {
  await x.driver.press(x.slotOf(sessionId));
  await x.driver.waitFor((s) => s.slots[x.slotOf(sessionId)]?.flags.selected === true);
  await x.driver.hold("REC", holdMs);
}

describe("main flow over the device link (no mouse)", () => {
  test("select key -> REC hold -> release -> review -> SAVE -> exactly one sendPrompt to the locked target -> delivered", async () => {
    r = await rig();
    const x = r;
    const target = x.adapter.snapshotNow().sessions.find((s) => s.ref.sessionId === "s-claude-idle");
    if (!target) throw new Error("fixture changed");

    await x.driver.press(x.slotOf("s-claude-idle"));
    await x.driver.waitFor((s) => s.slots[x.slotOf("s-claude-idle")]?.flags.selected === true);
    expect(x.device.state.slots[x.slotOf("s-claude-idle")]?.label).toBe("refund impl");
    expect(x.device.state.detail.lines[0]).toBe("Refund webhook");
    expect(x.device.state.detail.lines[3]).toBe("REC reply  PLAY open");

    const levels: number[] = [];
    const off = x.device.on("state", (s) => {
      if (s.voice.voice === "recording") levels.push(s.voice.level);
    });
    x.device.button("REC", true);
    await x.driver.waitFor((s) => s.voice.voice === "recording" && s.view.view === "voice");
    expect(x.device.state.voice.target).toBe("refund impl");
    await x.sleep(1200);
    x.device.button("REC", false);
    off();
    // SET_VOICE carried live mic levels while recording (FixtureCapture, ~10 Hz).
    expect(levels.some((l) => l > 20)).toBe(true);
    expect(x.device.state.voice.elapsedDs).toBeGreaterThanOrEqual(10);

    await x.driver.waitFor((s) => s.voice.voice === "reviewing", 3000);
    expect(x.companion.console.composer.state.transcript).toBe(SMOKE_TEXT);
    expect(x.device.state.detail.lines[3]).toBe("SAVE send  FX cancel");
    expect(x.device.state.legend).toEqual(["", "", "", ""]);
    const ui = buildUiState(x.companion, null);
    expect(ui.voice).toMatchObject({ state: "reviewing", transcript: SMOKE_TEXT, editable: true, canSave: true, target: "refund impl" });
    expect(x.adapter.deliveries).toHaveLength(0); // explicit confirmation first

    await x.driver.tap("SAVE");
    await x.driver.waitFor((s) => s.voice.voice === "delivered" && s.lastResult?.result === "acknowledged", 3000);
    await x.companion.idle();

    expect(x.adapter.deliveries).toEqual([{ requestId: "req-1", kind: "prompt", key: sessionKey(target.ref), text: SMOKE_TEXT }]);
    // The SAVE frame got its delivery stages as COMMAND_RESULTs, ending in "acknowledged".
    const saveStages = x.results().filter((c) => ["accepted_locally", "acknowledged"].includes(c.result) && ["Queued", "Delivered"].includes(c.text));
    expect(saveStages.map((c) => c.result)).toEqual(["accepted_locally", "acknowledged"]);
    expect(new Set(saveStages.map((c) => c.reqSeq)).size).toBe(1);
    expect(x.device.state.lastResult).toMatchObject({ result: "acknowledged", text: "Delivered" });
    expect(buildUiState(x.companion, null).dispatch.stages.map((s) => s.stage)).toEqual(["accepted_locally", "backend_acknowledged"]);
  });

  test("switching session mid-recording keeps the destination locked at REC down", async () => {
    r = await rig();
    const x = r;
    await x.driver.press(x.slotOf("s-claude-idle"));
    x.device.button("REC", true);
    await x.driver.waitFor((s) => s.voice.voice === "recording");
    await x.driver.press(x.slotOf("s-claude-fw")); // a different session while REC is held
    await x.driver.waitFor((s) => s.slots[x.slotOf("s-claude-fw")]?.flags.selected === true);
    await x.sleep(600);
    x.device.button("REC", false);
    await x.driver.waitFor((s) => s.voice.voice === "reviewing", 3000);
    expect(x.device.state.voice.target).toBe("refund impl");
    await x.driver.tap("SAVE");
    await x.driver.waitFor((s) => s.voice.voice === "delivered", 3000);
    expect(x.adapter.deliveries.map((d) => d.key)).toEqual([x.keyOf("s-claude-idle")]);
  });

  test("a silent recording fails without dispatch", async () => {
    r = await rig({ wav: "silent-16k.wav" });
    const x = r;
    await recordInto(x, "s-claude-idle");
    await x.driver.waitFor((s) => s.voice.voice === "failed", 3000);
    expect(x.companion.console.composer.state.error).toBe("silent recording");
    await x.driver.tap("SAVE");
    await x.companion.idle();
    expect(x.adapter.deliveries).toHaveLength(0);
    await x.driver.tap("FX");
    await x.driver.waitFor((s) => s.voice.voice === "cancelled");
  });

  test("FX while recording cancels the take; nothing is transcribed or sent", async () => {
    r = await rig();
    const x = r;
    await x.driver.press(x.slotOf("s-claude-idle"));
    x.device.button("REC", true);
    await x.driver.waitFor((s) => s.voice.voice === "recording");
    await x.driver.tap("FX");
    await x.driver.waitFor((s) => s.voice.voice === "cancelled");
    x.device.button("REC", false);
    await x.sleep(300);
    await x.companion.idle();
    expect(x.transcriber.calls).toBe(0);
    expect(x.adapter.deliveries).toHaveLength(0);
  });

  test("the transcript edited in the UI is what gets sent; UI SAVE mirrors the device button", async () => {
    r = await rig();
    const x = r;
    await recordInto(x, "s-claude-idle");
    await x.driver.waitFor((s) => s.voice.voice === "reviewing", 3000);
    expect(x.companion.editTranscript("run bun test in apps/companion").ok).toBe(true);
    await x.companion.pressButton("SAVE");
    await x.driver.waitFor((s) => s.voice.voice === "delivered" && s.lastResult?.result === "acknowledged", 3000);
    expect(x.adapter.deliveries.map((d) => d.text)).toEqual(["run bun test in apps/companion"]);
    // UI-originated results carry req_seq 127 (no device frame).
    expect(x.results().some((c) => c.reqSeq === 127 && c.result === "acknowledged")).toBe(true);
  });
});
