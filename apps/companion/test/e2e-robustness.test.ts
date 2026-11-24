import { afterEach, describe, expect, test } from "bun:test";
import { capabilitiesFrom } from "@fm1/agent-core";
import { CC, CC_STATUS, FRAME_CONTROL, FrameAssembler, decode, encode, payloadToMidi } from "@fm1/device-protocol";
import { rig, type Rig } from "./rig";

let r: Rig | undefined;
afterEach(async () => {
  await r?.stop();
  r = undefined;
});

const resultsAfter = (x: Rig, n: number) => x.results().slice(n);

describe("targets and capabilities", () => {
  test("target removed while recording -> TARGET_UNAVAILABLE, no dispatch; pressing the stale key -> COMMAND_RESULT target_unavailable", async () => {
    r = await rig();
    const x = r;
    const ref = x.adapter.snapshotNow().sessions.find((s) => s.ref.sessionId === "s-claude-idle")?.ref;
    if (!ref) throw new Error("fixture changed");
    await x.driver.press(x.slotOf("s-claude-idle"));
    x.device.button("REC", true);
    await x.driver.waitFor((s) => s.voice.voice === "recording");
    x.adapter.removeSession(ref);
    await x.sleep(500);
    x.device.button("REC", false);
    await x.driver.waitFor((s) => s.voice.voice === "target_unavailable", 3000);
    await x.driver.tap("SAVE");
    await x.companion.idle();
    expect(x.adapter.deliveries).toHaveLength(0);

    await x.driver.tap("FX");
    await x.driver.waitFor((s) => s.voice.voice === "cancelled" && s.view.view === "sessions");
    const slot = x.slotOf("s-claude-idle");
    await x.driver.waitFor((s) => s.slots[slot]?.flags.stale === true);
    const n = x.results().length;
    await x.driver.press(slot);
    await x.driver.waitFor((s) => s.lastResult?.result === "target_unavailable");
    expect(resultsAfter(x, n).filter((c) => c.result !== "accepted_locally")).toMatchObject([{ result: "target_unavailable", text: "Chat is gone" }]);
  });

  test("unsupported focus -> no PLAY in the hint, and double press answers COMMAND_RESULT unsupported", async () => {
    r = await rig({
      capabilities: capabilitiesFrom({ supported: true, verified: "code" }, { focus: { supported: false, reason: "needs Desktop deep link", verified: "none" } }),
    });
    const x = r;
    await x.driver.press(x.slotOf("s-claude-fw"));
    await x.driver.waitFor((s) => s.slots[x.slotOf("s-claude-fw")]?.flags.selected === true);
    expect(x.device.state.legend).toEqual(["SHOW", "REPO", "TASK", "TALK"]);
    // (version 5: PRESETS read, then the SEQ pair, each where it fits, docs/ui-v3.md section 9.11; Sessions is Grouped)
    expect(x.device.state.detail.lines[3]).toBe("ENV stop  SEQ buddy");
    const n = x.results().length;
    await x.driver.press(x.slotOf("s-claude-fw"), "double");
    await x.driver.waitFor((s) => s.lastResult?.result === "unsupported");
    expect(resultsAfter(x, n)).toMatchObject([{ result: "unsupported", text: "Not supported" }]);
    expect(x.adapter.focusCalls).toHaveLength(0);
  });

  test("supported focus: same double press reaches the adapter once and reports completed", async () => {
    r = await rig();
    const x = r;
    await x.driver.press(x.slotOf("s-claude-fw"));
    await x.driver.waitFor((s) => s.detail.lines[3] === "ENV stop  PLAY open");
    await x.driver.press(x.slotOf("s-claude-fw"), "double");
    await x.driver.waitFor((s) => s.lastResult?.result === "completed");
    expect(x.adapter.focusCalls).toEqual([x.keyOf("s-claude-fw")]);
  });

  test("approval: SAVE opens the confirm view, a second SAVE approves exactly once", async () => {
    r = await rig();
    const x = r;
    await x.driver.press(x.slotOf("s-codex-fw"));
    await x.driver.waitFor((s) => s.slots[x.slotOf("s-codex-fw")]?.flags.selected === true);
    await x.driver.tap("SAVE");
    await x.driver.waitFor((s) => s.view.view === "confirm");
    expect(x.device.state.detail.lines.slice(0, 3)).toEqual(["Approve?", "fw review", ""]);
    expect(x.device.state.view.title).toBe("CHECK BEFORE DOING");
    expect(x.device.state.legend).toEqual(["", "", "", ""]);
    expect(x.adapter.approvalCalls).toHaveLength(0);
    await x.driver.tap("SAVE");
    await x.driver.waitFor((s) => s.view.view === "sessions" && s.lastResult?.result === "completed");
    expect(x.adapter.approvalCalls).toMatchObject([{ approvalId: "appr-1", decision: "approve" }]);
    await x.driver.tap("SAVE"); // nothing pending any more
    await x.companion.idle();
    expect(x.adapter.approvalCalls).toHaveLength(1);
  });

  test("FX in the confirm view cancels: nothing is sent", async () => {
    r = await rig();
    const x = r;
    await x.driver.press(x.slotOf("s-codex-fw"));
    await x.driver.tap("SAVE");
    await x.driver.waitFor((s) => s.view.view === "confirm");
    await x.driver.tap("FX");
    await x.driver.waitFor((s) => s.view.view === "sessions");
    expect(x.adapter.approvalCalls).toHaveLength(0);
  });
});

describe("link robustness", () => {
  test("duplicate device frames are acknowledged again but never dispatch twice", async () => {
    r = await rig();
    const x = r;
    await x.driver.press(x.slotOf("s-claude-idle"));
    await x.driver.hold("REC", 1000);
    await x.driver.waitFor((s) => s.voice.voice === "reviewing", 3000);
    // Replay every device frame of the SAVE press onto the host, as a USB glitch would.
    const asm = new FrameAssembler("device");
    let frame: number[][] = [];
    let duplicated = 0;
    x.pair.device.tap = (m) => {
      frame.push(m);
      const payload = asm.push(m);
      if (payload) {
        const res = decode(payload, "device");
        const copy = frame;
        frame = [];
        if (res.ok && res.value.message.kind === "BUTTON") {
          duplicated++;
          queueMicrotask(() => {
            for (const msg of copy) x.pair.host.deliver(msg);
          });
        }
      }
      return m;
    };
    let saveDowns = 0;
    const handle = x.companion.console.handleInput.bind(x.companion.console);
    x.companion.console.handleInput = (input) => {
      if (input.kind === "button" && input.button === "SAVE" && input.edge === "down") saveDowns++;
      return handle(input);
    };
    await x.driver.tap("SAVE");
    await x.driver.waitFor((s) => s.voice.voice === "delivered", 3000);
    await x.sleep(300);
    x.pair.device.tap = undefined;
    expect(saveDowns).toBe(1); // the link's SEQ+checksum window dropped the replayed frame
    // A second, genuinely new SAVE press after delivery does nothing either.
    await x.driver.tap("SAVE");
    await x.sleep(300);
    await x.companion.idle();
    expect(duplicated).toBe(2);
    expect(x.adapter.deliveries).toHaveLength(1);
    expect(x.companion.log.recent(500).filter((e) => e.text.startsWith("SAVE down -> voiceSubmit"))).toHaveLength(1);
  });

  test("malformed frames are ignored and counted; the link keeps working", async () => {
    r = await rig();
    const x = r;
    const ccs = (control: number, data: number[]): number[][] => [
      [CC_STATUS, CC.deviceControl, FRAME_CONTROL.start],
      ...data.map((b) => [CC_STATUS, CC.deviceData, b]),
      [CC_STATUS, CC.deviceControl, control],
    ];
    const bad = encode({ kind: "BUTTON", button: "SAVE", edge: "down" }, 90);
    bad[bad.length - 1] = ((bad[bad.length - 1] ?? 0) + 1) & 0x7f; // checksum off by one
    const junk: number[][] = [
      ...payloadToMidi(bad, "device"),
      ...ccs(FRAME_CONTROL.end, [0x03, 5, 2, 4]), // KEY with a short body
      ...ccs(FRAME_CONTROL.end, [0x7e, 6, 0, 0x7e ^ 0x2a]), // unknown type
      ...ccs(FRAME_CONTROL.end, Array.from({ length: 120 }, () => 1)), // overlong
      ...ccs(FRAME_CONTROL.abort, [0x02, 7, 2, 9, 1]), // aborted
      [0x90, 60, 100], // note on
      [0xf0, 0x22, 0x24, 0x35, 0x7d, 0xf7], // SysEx (must never be acted on)
      [CC_STATUS, CC.deviceData, 55], // data byte outside a frame
      [CC_STATUS, CC.hostData, 1], // host-direction CC from the device side
    ];
    for (const m of junk) x.pair.host.deliver(m);
    await x.sleep(100);
    await x.companion.idle();
    expect(x.companion.device.status.rxErrors).toBeGreaterThanOrEqual(2);
    expect(x.companion.device.status.phase).toBe("connected");
    expect(x.adapter.deliveries).toHaveLength(0);
    expect(x.adapter.approvalCalls).toHaveLength(0);
    // Still fully usable.
    await x.driver.press(x.slotOf("s-claude-fw"));
    await x.driver.waitFor((s) => s.slots[x.slotOf("s-claude-fw")]?.flags.selected === true);
  });

  test("unplug and replug: the new device boot gets a full resync of the current state", async () => {
    r = await rig();
    const x = r;
    await x.driver.press(x.slotOf("s-claude-fw"));
    await x.driver.tap("GLO");
    await x.driver.waitFor((s) => s.view.view === "inbox");
    const before = x.companion.device.status.resyncs;
    const fresh = x.replug();
    expect(fresh.state.link.phase).toBe("no_host");
    await x.driver.waitFor((s) => s.link.phase === "connected" && s.view.view === "inbox" && s.legend[3] === "TALK" && s.legend[0] === "", 3000);
    await x.sleep(200);
    const v = x.companion.console.view();
    expect(x.companion.device.status.resyncs).toBe(before + 1);
    expect(fresh.state.view).toMatchObject({ view: "inbox", title: v.title });
    expect(fresh.state.slots.map((s) => s.label)).toEqual(v.slots.map((s) => s.label));
    expect(fresh.state.status.attentionCount).toBe(v.status.attentionCount);
    // And it is live: HOME goes back to sessions with the selection kept.
    await x.driver.tap("HOME");
    await x.driver.waitFor((s) => s.view.view === "sessions" && s.slots[x.slotOf("s-claude-fw")]?.flags.selected === true);
  });

  test("link silence: both sides time out, then HELLO renegotiates and the host resyncs", async () => {
    r = await rig();
    const x = r;
    await x.driver.press(x.slotOf("s-claude-voice"));
    x.pair.device.tap = () => null;
    x.pair.host.tap = () => null;
    await x.sleep(4000);
    expect(x.device.state.link.phase).toBe("no_host");
    expect(x.companion.device.status.phase).toBe("lost");
    // Backend changes while the cable is out still reach the device after reconnect.
    const ref = x.adapter.snapshotNow().sessions.find((s) => s.ref.sessionId === "s-claude-fw")?.ref;
    if (!ref) throw new Error("fixture changed");
    x.adapter.setState(ref, "completed_unread");
    const before = x.companion.device.status.resyncs;
    x.pair.device.tap = undefined;
    x.pair.host.tap = undefined;
    await x.driver.waitFor((s) => s.link.phase === "connected", 3000);
    await x.sleep(400);
    expect(x.companion.device.status.resyncs).toBeGreaterThan(before);
    expect(x.device.state.slots[x.slotOf("s-claude-fw")]?.state).toBe("completed_unread");
    expect(x.device.state.slots[x.slotOf("s-claude-voice")]?.flags.selected).toBe(true);
  });
  test("a burst of queued HELLOs from one boot gives one trailing replay instead of one resync each", async () => {
    r = await rig();
    const x = r;
    await x.driver.waitFor((s) => s.link.phase === "connected");
    await x.sleep(100);
    const before = x.companion.device.status.resyncs;
    const bootId = 77; // rig() boots its first SimDevice with 77
    // The real FM-1 delivered about 25 HELLOs in 12 ms on attach (2026-11-18).
    for (let i = 0; i < 20; i++) {
      const hello = encode({ kind: "HELLO", protoMin: 1, protoMax: 1, fwMajor: 0, fwMinor: 1, fwPatch: 0, bootId }, (100 + i) & 0x7f);
      for (const m of payloadToMidi(hello, "device")) x.pair.host.deliver(m);
    }
    await x.sleep(800);
    // All 20 fall within 500 ms of the handshake HELLO, so they are one burst: one replay after it.
    expect(x.companion.device.status.resyncs).toBe(before + 1);
    expect(x.companion.device.status.phase).toBe("connected");
  });
});
