// Integration: the real TraycerAgentAdapter (against the adapter package's fake host, a real WebSocket
// server) behind the Companion, driven only through the simulated FM-1 over the device link.
import { afterEach, describe, expect, test } from "bun:test";
import { LoopbackPair, NO_REQ_SEQ } from "@fm1/device-protocol";
import { ScriptedDriver, SimDevice } from "@fm1/device-simulator";
import type { FakeStreamSub } from "../../../packages/agent-adapter-traycer/test/fake-host";
import { chatSnapshot, makeHarness, standardWorld, turnFrame, until, USER, type Harness } from "../../../packages/agent-adapter-traycer/test/scenario";
import { Companion } from "../src/companion";
import { DEFAULT_CONFIG } from "../src/config";
import { FixtureCapture, loadFixtureAudio } from "../src/voice/capture";
import { ScriptedTranscriber } from "../src/voice/transcriber";
import { AUDIO_DIR, SMOKE_TEXT } from "./rig";

interface Setup {
  h: Harness;
  companion: Companion;
  device: SimDevice;
  driver: ScriptedDriver;
  stop(): Promise<void>;
}

let cur: Setup | null = null;
afterEach(async () => {
  await cur?.stop();
  cur = null;
});

/** Answers `send` the way host 1.5.4 does: actionAck, messageAccepted, then the turn runs and completes. */
function answerSend(sub: FakeStreamSub, frame: Record<string, unknown>): void {
  if (frame.kind !== "send") return;
  const mid = String(frame.messageId);
  sub.send({ kind: "actionAck", epicId: frame.epicId, chatId: frame.chatId, clientActionId: frame.clientActionId, action: "send", status: "accepted", reason: null, code: null });
  sub.send({
    kind: "messageAccepted",
    epicId: frame.epicId,
    chatId: frame.chatId,
    message: { role: "user", messageId: mid, sender: { type: "user", userId: USER }, message: { kind: "user", content: frame.content, browserAnnotations: [] }, timestamp: 1, sessionAnchor: null },
  });
  sub.send(turnFrame(sub, "running", mid, "turn-live"));
  setTimeout(() => sub.send(turnFrame(sub, "completed", mid, "turn-live")), 50);
}

async function setup(): Promise<Setup> {
  const h = makeHarness({
    world: standardWorld(),
    config: { firstActivityWaitMs: 2_000 },
    host: {
      onSubscribe: (sub) => {
        if (sub.method === "agent.activity.subscribe") setTimeout(() => sub.send({ kind: "state", servedBy: "local", byEpic: {} }), 30);
        if (sub.method === "chat.subscribe") {
          const p = sub.params as { epicId: string; chatId: string };
          sub.send(chatSnapshot(p.epicId, p.chatId));
        }
      },
      onClientFrame: answerSend,
    },
  });
  const audio = await loadFixtureAudio(`${AUDIO_DIR}smoke-16k.wav`);
  let n = 0;
  const companion = new Companion({
    adapter: h.adapter,
    capture: () => new FixtureCapture(audio, undefined, "smoke-16k.wav"),
    transcriber: new ScriptedTranscriber(SMOKE_TEXT),
    newRequestId: () => `it-${++n}`,
    tickMs: 0,
    // Flat keys: in the Grouped default (docs/ui-v3.md section 9.2) quiet tasks fold into one task row.
    config: { ...DEFAULT_CONFIG, layouts: { sessions: "buddy", inbox: "list" } },
  });
  await companion.start();
  // The fake host's chats are old and idle (T7): KNOB1 to ALL so they get keys.
  for (let i = 0; i < 2; i++) await companion.handleInput({ kind: "encoder", encoder: "K1", delta: 1 }, NO_REQ_SEQ);
  const pair = new LoopbackPair();
  companion.device.attach(pair.host, "loopback");
  const device = new SimDevice({ transport: pair.device });
  device.start();
  const driver = new ScriptedDriver(device);
  await driver.waitFor((s) => s.link.phase === "connected" && s.slots.some((x) => x.label !== ""), 3_000);
  return {
    h,
    companion,
    device,
    driver,
    async stop() {
      device.stop();
      await companion.stop();
      h.host.stop();
    },
  };
}

function slotOf(s: Setup, sessionId: string): number {
  const e = s.companion.console.registry.sessions().find((x) => x.session.ref.sessionId === sessionId);
  if (!e) throw new Error(`no session ${sessionId}`);
  const i = s.companion.console.state.layouts.sessions.slots.indexOf(e.key);
  if (i < 0) throw new Error(`${sessionId} is not in the sessions layout`);
  return i % 27;
}

const chatSubs = (s: Setup, chatId: string) =>
  s.h.host.subs.filter((x) => x.method === "chat.subscribe" && (x.params as { chatId: string }).chatId === chatId);

describe("companion + TraycerAgentAdapter (fake host) over the device link", () => {
  test("resync lists chats as observed idle, not unknown (first activity frame awaited)", async () => {
    cur = await setup();
    const entry = cur.companion.console.registry.sessions().find((e) => e.session.ref.sessionId === "c2");
    expect(entry?.session.status.observed.state).toBe("idle");
    const slot = slotOf(cur, "c2");
    await cur.driver.waitFor((d) => d.slots[slot]?.state === "idle", 2_000);
  });

  test("key select opens chat.subscribe for that chat only; switching releases the previous watch", async () => {
    cur = await setup();
    const s = cur;
    await s.driver.press(slotOf(s, "c2"));
    await s.driver.waitFor((d) => d.slots[slotOf(s, "c2")]?.flags.selected === true);
    await until(() => chatSubs(s, "c2").some((x) => !x.closed), 3_000, "watch c2");
    expect(chatSubs(s, "c1")).toHaveLength(0);
    await s.driver.press(slotOf(s, "c1"));
    await until(() => chatSubs(s, "c1").some((x) => !x.closed), 3_000, "watch c1");
    await until(() => chatSubs(s, "c2").every((x) => x.closed), 3_000, "release c2");
  });

  test("select -> REC -> review -> SAVE sends exactly one prompt to the selected chat and the device shows delivered", async () => {
    cur = await setup();
    const s = cur;
    await s.driver.press(slotOf(s, "c2"));
    await s.driver.waitFor((d) => d.slots[slotOf(s, "c2")]?.flags.selected === true);
    await s.driver.hold("REC", 800);
    await s.driver.waitFor((d) => d.voice.voice === "reviewing", 3_000);
    await s.driver.tap("SAVE");
    await s.driver.waitFor((d) => d.voice.voice === "delivered" && d.lastResult?.result === "acknowledged", 5_000);
    const sends = s.h.host.subs.filter((x) => x.method === "chat.subscribe").flatMap((x) => x.clientFrames.filter((f) => f.kind === "send"));
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ epicId: "e1", chatId: "c2", sender: { type: "user", userId: USER } });
    expect(JSON.stringify(sends[0]?.content)).toContain("decode frame");
    expect(s.companion.relay.stages().map((x) => x.stage)).toContain("backend_acknowledged");
  });
});
