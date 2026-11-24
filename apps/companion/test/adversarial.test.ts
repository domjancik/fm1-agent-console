// Adversarial review regressions: destination change during transcription, double SAVE from device + UI,
// and no capture/transcription left running after stop().
import { afterEach, describe, expect, test } from "bun:test";
import type { CapturedAudio } from "../src/voice/capture";
import type { TranscriptOutcome } from "../src/voice/transcriber";
import { rig, SMOKE_TEXT, type Rig } from "./rig";

let r: Rig | undefined;
afterEach(async () => {
  await r?.stop();
  r = undefined;
});

/** Makes the rig's transcriber wait until `release()` (or abort), recording the signal it got. */
function gateTranscriber(x: Rig): { release: () => void; signals: AbortSignal[] } {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const signals: AbortSignal[] = [];
  const inner = x.transcriber.transcribe.bind(x.transcriber);
  x.transcriber.transcribe = async (audio: CapturedAudio, signal?: AbortSignal): Promise<TranscriptOutcome> => {
    if (signal) signals.push(signal);
    await new Promise<void>((resolve) => {
      void gate.then(resolve);
      signal?.addEventListener("abort", () => resolve());
    });
    if (signal?.aborted) return { ok: false, reason: "aborted" };
    return inner(audio);
  };
  return { release: open, signals };
}

describe("adversarial companion flows", () => {
  test("selecting another session while the take is transcribing does not move the destination", async () => {
    r = await rig();
    const x = r;
    const gate = gateTranscriber(x);
    await x.driver.press(x.slotOf("s-claude-idle"));
    await x.driver.waitFor((s) => s.slots[x.slotOf("s-claude-idle")]?.flags.selected === true);
    await x.driver.hold("REC", 1200);
    await x.driver.waitFor((s) => s.voice.voice === "transcribing", 3000);
    await x.driver.press(x.slotOf("s-claude-fw"));
    await x.driver.waitFor((s) => s.slots[x.slotOf("s-claude-fw")]?.flags.selected === true);
    gate.release();
    await x.driver.waitFor((s) => s.voice.voice === "reviewing", 3000);
    expect(x.device.state.voice.target).toBe("refund impl");
    await x.driver.tap("SAVE");
    await x.driver.waitFor((s) => s.voice.voice === "delivered", 3000);
    await x.companion.idle();
    expect(x.adapter.deliveries.map((d) => [d.key, d.text])).toEqual([[x.keyOf("s-claude-idle"), SMOKE_TEXT]]);
  });

  test("double SAVE (device tap + UI SAVE + second tap) dispatches exactly once", async () => {
    r = await rig();
    const x = r;
    await x.driver.press(x.slotOf("s-claude-idle"));
    await x.driver.hold("REC", 1200);
    await x.driver.waitFor((s) => s.voice.voice === "reviewing", 3000);
    await Promise.all([x.driver.tap("SAVE"), x.companion.pressButton("SAVE"), x.driver.tap("SAVE")]);
    await x.driver.waitFor((s) => s.voice.voice === "delivered", 3000);
    await x.companion.idle();
    expect(x.adapter.deliveries).toHaveLength(1);
  });

  test("every byte the companion writes in a full flow is a channel-16 CC (no SysEx on any send path)", async () => {
    r = await rig();
    const x = r;
    const written: number[][] = [];
    const prev = x.pair.host.tap;
    x.pair.host.tap = (m) => {
      written.push([...m]);
      return prev ? prev(m) : m;
    };
    await x.driver.press(x.slotOf("s-claude-idle"));
    await x.driver.hold("REC", 1200);
    await x.driver.waitFor((s) => s.voice.voice === "reviewing", 3000);
    await x.driver.tap("SAVE");
    await x.driver.waitFor((s) => s.voice.voice === "delivered", 3000);
    await x.companion.idle();
    expect(written.length).toBeGreaterThan(20);
    expect(written.filter((m) => m.length !== 3 || m[0] !== 0xbf || m.includes(0xf0) || m.includes(0xf7))).toEqual([]);
  });

  test("stop() while recording closes the capture", async () => {
    r = await rig();
    const x = r;
    await x.driver.press(x.slotOf("s-claude-idle"));
    x.device.button("REC", true);
    await x.driver.waitFor((s) => s.voice.voice === "recording");
    const cap = x.captures.at(-1);
    if (!cap) throw new Error("no capture started");
    expect(cap["active"]).toBe(true);
    x.device.stop();
    await x.companion.stop();
    r = undefined;
    expect(cap["active"]).toBe(false);
  });

  test("stop() while transcribing aborts the transcription and sends nothing", async () => {
    r = await rig();
    const x = r;
    const gate = gateTranscriber(x);
    await x.driver.press(x.slotOf("s-claude-idle"));
    await x.driver.hold("REC", 1200);
    await x.driver.waitFor((s) => s.voice.voice === "transcribing", 3000);
    expect(gate.signals).toHaveLength(1);
    x.device.stop();
    await x.companion.stop();
    r = undefined;
    expect(gate.signals[0]?.aborted).toBe(true);
    expect(x.captures.every((c) => c["active"] === false)).toBe(true);
    expect(x.adapter.deliveries).toHaveLength(0);
  });
});
