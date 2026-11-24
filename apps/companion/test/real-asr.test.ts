// The device flow with the real speech engine (Parakeet via sherpa-onnx) instead of the scripted one.
import { afterAll, describe, expect, test } from "bun:test";
import { MockAdapter, fixturePath } from "@fm1/agent-core";
import { FakeClock, LoopbackPair } from "@fm1/device-protocol";
import { ScriptedDriver, SimDevice } from "@fm1/device-simulator";
import { locateParakeetModel } from "@fm1/speech";
import { Companion } from "../src/companion";
import { FixtureCapture, loadFixtureAudio } from "../src/voice/capture";
import { SpeechTranscriber } from "../src/voice/transcriber";
import { AUDIO_DIR, clockTimers, ioSleeper } from "./rig";

const haveModel = (() => {
  try {
    locateParakeetModel();
    return true;
  } catch {
    return false;
  }
})();
if (!haveModel) console.warn("real-asr test skipped: Parakeet model not found");

describe.skipIf(!haveModel)("real ASR through the device link", () => {
  const transcriber = new SpeechTranscriber({ engine: "sherpa", language: "en", vocabularyFile: null });
  afterAll(() => transcriber.dispose());

  test("question fixture -> review shows the corrected transcript -> SAVE delivers it", async () => {
    const clock = new FakeClock(0);
    const pair = new LoopbackPair();
    const adapter = MockAdapter.fromFixture(fixturePath("mixed"));
    const audio = await loadFixtureAudio(`${AUDIO_DIR}question-16k.wav`);
    const c = new Companion({ adapter, capture: () => new FixtureCapture(audio, clock), transcriber, clock, timers: clockTimers(clock), now: () => clock.now() });
    await c.start();
    c.device.attach(pair.host, "loopback");
    const device = new SimDevice({ transport: pair.device, clock });
    device.start();
    const d = new ScriptedDriver(device, ioSleeper(clock));
    await d.waitFor((s) => s.link.phase === "connected" && s.slots[0]?.label !== "");
    await d.press(0);
    await d.hold("REC", 800);
    // Real inference runs in a worker process: give it real time while fake time advances.
    const deadline = Date.now() + 20_000;
    while (device.state.voice.voice !== "reviewing" && device.state.voice.voice !== "failed" && Date.now() < deadline) await d.sleeper.sleep(50);
    expect(c.console.composer.state.transcript).toBe("Can you ask Claude Code to fix the null pointer in the voice composer?");
    await d.tap("SAVE");
    await d.waitFor((s) => s.voice.voice === "delivered", 3000);
    expect(adapter.deliveries.map((x) => x.text)).toEqual(["Can you ask Claude Code to fix the null pointer in the voice composer?"]);
    device.stop();
    await c.stop();
  }, 30_000);
});
