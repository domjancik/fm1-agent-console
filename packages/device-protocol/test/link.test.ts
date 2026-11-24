import { describe, expect, test } from "bun:test";
import { encode, Link, payloadToMidi, type SetSlot } from "../src";
import { rawFrame } from "../src/vectors";
import { identity, setup } from "./harness";

const slot = (key: number, label = "s"): SetSlot => ({
  kind: "SET_SLOT",
  key,
  state: "working",
  flags: { selected: false, codex: false, stale: false, pinned: false },
  label,
});

/** Host sends after negotiation always go out; fail loudly if one was dropped. */
const sent = (seq: number | undefined): number => {
  if (seq === undefined) throw new Error("frame was dropped");
  return seq;
};

function connected(opts: Parameters<typeof setup>[0] = {}) {
  const s = setup(opts);
  s.host.start();
  s.device.start();
  return s;
}

describe("version negotiation", () => {
  test("HELLO / HELLO_ACK agree on proto 1", () => {
    const s = connected();
    expect(s.hostEvents.negotiated).toHaveLength(1);
    expect(s.hostEvents.negotiated[0]?.proto).toBe(1);
    expect(s.hostEvents.negotiated[0]?.hello?.bootId).toBe(777);
    expect(s.deviceEvents.negotiated).toEqual([{ proto: 1, hostSession: 42 }]);
    expect(s.host.negotiatedProto).toBe(1);
    expect(s.device.negotiatedProto).toBe(1);
    expect(s.hostEvents["peer-alive"]).toHaveLength(1);
    expect(s.deviceEvents["peer-alive"]).toHaveLength(1);
    // HELLO is answered, so the device stops repeating it
    s.clock.advance(5000);
    expect(s.deviceWire.kinds().filter((k) => k === "HELLO")).toHaveLength(1);
  });

  test("no overlap: HELLO_ACK version 0 with a reason, device keeps saying HELLO", () => {
    const s = connected({ device: { versions: { min: 8, max: 9 } } });
    expect(s.hostEvents.negotiated).toHaveLength(0);
    expect(s.hostEvents.incompatible[0]?.reason).toBe("host too old (1-7)");
    const ack = s.hostWire.frames.find((f) => f.message.kind === "HELLO_ACK")?.message;
    expect(ack).toEqual({ kind: "HELLO_ACK", proto: 0, hostSession: 42, reason: "host too old (1-7)" });
    expect(s.deviceEvents.incompatible).toEqual([{ reason: "host too old (1-7)" }]);
    expect(s.device.negotiatedProto).toBeUndefined();
    s.clock.advance(3000);
    expect(s.deviceWire.kinds().filter((k) => k === "HELLO")).toHaveLength(4);
  });

  test("a version 2 device agrees on proto 2 (UX v2 rendering marker)", () => {
    const s = connected({ device: { versions: { min: 1, max: 2 } } });
    expect(s.host.negotiatedProto).toBe(2);
    expect(s.device.negotiatedProto).toBe(2);
  });

  test("a version 5 device agrees on proto 5 (LIST layout), a version 4 device on 4", () => {
    const s5 = connected({ device: { versions: { min: 1, max: 5 } } });
    expect(s5.host.negotiatedProto).toBe(5);
    expect(s5.device.negotiatedProto).toBe(5);
    const s4 = connected({ device: { versions: { min: 1, max: 4 } } });
    expect(s4.host.negotiatedProto).toBe(4);
  });

  test("a version 6 device agrees on proto 6 (SPLIT keys), a version 5 device still on 5", () => {
    const s6 = connected({ device: { versions: { min: 1, max: 6 } } });
    expect(s6.host.negotiatedProto).toBe(6);
    expect(s6.device.negotiatedProto).toBe(6);
    const s5 = connected({ device: { versions: { min: 1, max: 5 } } });
    expect(s5.host.negotiatedProto).toBe(5);
  });

  test("a version 3 device agrees on proto 3 (DETAILS page)", () => {
    const s = connected({ device: { versions: { min: 1, max: 3 } } });
    expect(s.host.negotiatedProto).toBe(3);
    expect(s.device.negotiatedProto).toBe(3);
  });

  test("device older than host gets 'host too new'", () => {
    const s = connected({ device: { versions: { min: 0, max: 0 } } });
    expect(s.deviceEvents.incompatible[0]?.reason).toBe("host too new (1-7)");
  });
});

describe("acknowledgement and retransmission", () => {
  test("a host frame is delivered once and acknowledged", async () => {
    const s = connected();
    const outcome = await s.host.sendAndWait(slot(3, "api"));
    expect(outcome).toEqual({ outcome: "acked", status: "ok" });
    const slots = s.deviceEvents.message.filter((m) => m.message.kind === "SET_SLOT");
    expect(slots.map((m) => m.message)).toEqual([slot(3, "api")]);
    expect(s.host.pendingCount).toBe(0);
  });

  test("retransmits every 250 ms, 3 times, then faults; receiver dedups", () => {
    const s = connected();
    s.deviceWire.drop = (f) => f?.message.kind === "ACK";
    const seq = sent(s.host.send({ kind: "SET_VIEW", view: "tasks", page: 0, pages: 2, title: "Tasks" }));
    const copies = () => s.hostWire.frames.filter((f) => f.seq === seq && f.message.kind === "SET_VIEW").length;
    expect(copies()).toBe(1);
    s.clock.advance(249);
    expect(copies()).toBe(1);
    s.clock.advance(1);
    expect(copies()).toBe(2);
    s.clock.advance(500);
    expect(copies()).toBe(4);
    expect(s.hostEvents.fault).toHaveLength(0);
    s.clock.advance(250);
    expect(copies()).toBe(4);
    expect(s.hostEvents.fault).toEqual([
      { seq, message: { kind: "SET_VIEW", view: "tasks", page: 0, pages: 2, title: "Tasks" } },
    ]);
    // delivered once, ACKed for every copy
    expect(s.deviceEvents.message.filter((m) => m.message.kind === "SET_VIEW")).toHaveLength(1);
    const acks = s.deviceWire.frames.filter((f) => f.message.kind === "ACK" && f.message.ackedSeq === seq);
    expect(acks).toHaveLength(4);
  });

  test("a lost ACK is recovered by one retransmission", async () => {
    const s = connected();
    let dropped = 0;
    s.deviceWire.drop = (f) => f?.message.kind === "ACK" && dropped++ === 0;
    const wait = s.host.sendAndWait({ kind: "CLEAR_SLOTS" });
    s.clock.advance(250);
    expect(await wait).toEqual({ outcome: "acked", status: "ok" });
    expect(s.deviceEvents.message.filter((m) => m.message.kind === "CLEAR_SLOTS")).toHaveLength(1);
    expect(s.hostEvents.fault).toHaveLength(0);
  });

  test("device input frames are retransmitted to the host too", () => {
    const s = connected();
    let dropped = 0;
    s.deviceWire.drop = (f) => f?.message.kind === "KEY" && dropped++ < 2;
    s.device.send({ kind: "KEY", key: 4, gesture: "single" });
    s.clock.advance(500);
    expect(s.hostEvents.message.filter((m) => m.message.kind === "KEY")).toHaveLength(1);
    expect(s.device.pendingCount).toBe(0);
  });

  test("HEARTBEAT and ACK are never acknowledged", () => {
    const s = connected();
    s.clock.advance(1000);
    const hbSeqs = s.hostWire.frames.filter((f) => f.message.kind === "HEARTBEAT").map((f) => f.seq);
    expect(hbSeqs.length).toBeGreaterThan(0);
    const acked = s.deviceWire.frames.filter((f) => f.message.kind === "ACK" && hbSeqs.includes(f.message.ackedSeq));
    expect(acked).toHaveLength(0);
  });

  test("unknown type with a good checksum gets ACK status unknown_type; bad checksum gets nothing", () => {
    const s = connected();
    const before = s.hostWire.frames.length;
    for (const m of payloadToMidi(rawFrame(0x7e, 50, [1]), "device")) s.pair.host.deliver(m);
    const ack = s.hostWire.frames.slice(before).find((f) => f.message.kind === "ACK");
    expect(ack?.message).toEqual({ kind: "ACK", from: "host", ackedSeq: 50, status: "unknown_type" });

    const bad = encode({ kind: "KEY", key: 1, gesture: "single" }, 51);
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1;
    const mark = s.hostWire.frames.length;
    for (const m of payloadToMidi(bad, "device")) s.pair.host.deliver(m);
    expect(s.hostWire.frames.slice(mark)).toHaveLength(0);
    expect(s.hostEvents["rx-error"].map((e) => e.code)).toEqual(["unknown_type", "bad_checksum"]);
    expect(s.host.rxErrors).toBe(2);
  });
});

describe("sequence numbers", () => {
  test("wrap 127 -> 0 and identical frames after the wrap are still delivered", () => {
    const s = connected();
    const seqs: number[] = [];
    for (let i = 0; i < 300; i++) seqs.push(sent(s.host.send(slot(1, "same"))));
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(((seqs[i - 1] ?? 0) + 1) % 128);
    expect(seqs).toContain(127);
    expect(s.deviceEvents.message.filter((m) => m.message.kind === "SET_SLOT")).toHaveLength(300);
    expect(s.host.pendingCount).toBe(0);
  });

  test("a restarted peer is not mistaken for a duplicate", () => {
    const s = connected();
    const key = encode({ kind: "KEY", key: 2, gesture: "long" }, 9);
    const inject = () => {
      for (const m of payloadToMidi(key, "device")) s.pair.host.deliver(m);
    };
    inject();
    inject();
    const keys = () => s.hostEvents.message.filter((m) => m.message.kind === "KEY").length;
    expect(keys()).toBe(1);

    s.device.close();
    const reborn = Link.device({ transport: s.pair.device, clock: s.clock, identity: identity({ bootId: 4242 }) });
    reborn.start();
    expect(s.hostEvents.negotiated).toHaveLength(2);
    inject();
    expect(keys()).toBe(2);
  });
});

describe("liveness", () => {
  test("heartbeats keep both sides alive", () => {
    const s = connected();
    s.clock.advance(20_000);
    expect(s.hostEvents["peer-lost"]).toHaveLength(0);
    expect(s.deviceEvents["peer-lost"]).toHaveLength(0);
    expect(s.host.peerAlive && s.device.peerAlive).toBe(true);
  });

  test("3500 ms of silence -> peer-lost; recovery -> peer-alive and renegotiation", () => {
    const s = connected();
    s.clock.advance(100);
    s.hostWire.drop = () => true;
    s.deviceWire.drop = () => true;
    s.clock.advance(3399);
    expect(s.hostEvents["peer-lost"]).toHaveLength(0);
    s.clock.advance(1100);
    expect(s.hostEvents["peer-lost"]).toHaveLength(1);
    expect(s.deviceEvents["peer-lost"]).toHaveLength(1);
    expect(s.device.negotiatedProto).toBeUndefined();

    s.hostWire.drop = () => false;
    s.deviceWire.drop = () => false;
    s.clock.advance(1000);
    expect(s.hostEvents["peer-alive"]).toHaveLength(2);
    expect(s.deviceEvents["peer-alive"]).toHaveLength(2);
    expect(s.hostEvents.negotiated).toHaveLength(2);
    expect(s.device.negotiatedProto).toBe(1);
  });

  test("device heartbeat reports uptime and saturating rx errors", () => {
    const s = connected();
    s.clock.advance(3000);
    const hb = s.deviceWire.frames.filter((f) => f.message.kind === "HEARTBEAT").at(-1)?.message;
    expect(hb).toEqual({ kind: "HEARTBEAT", from: "device", uptimeS: 3, rxErrors: 0 });
  });
});

describe("guards and pacing", () => {
  test("rejects wrong-direction messages and sends before start", () => {
    const s = setup();
    expect(() => s.host.send({ kind: "CLEAR_SLOTS" })).toThrow("not started");
    s.host.start();
    // @ts-expect-error a device message cannot be sent by the host
    expect(() => s.host.send({ kind: "KEY", key: 0, gesture: "single" })).toThrow(TypeError);
  });

  test("host is paced to 200 frames per second, evenly", () => {
    const s = setup({ hostRate: 200 });
    s.host.start();
    s.device.start();
    s.clock.advance(50);
    expect(s.host.negotiatedProto).toBe(1);
    const mark = s.hostWire.frames.length;
    const t0 = s.clock.now();
    for (let i = 0; i < 300; i++) s.host.send(slot(i % 27, `s${i}`));
    const sentAt: number[] = [];
    let seen = mark;
    for (let ms = 0; ms <= 2000; ms++) {
      for (; seen < s.hostWire.frames.length; seen++) sentAt.push(s.clock.now() - t0);
      s.clock.advance(1);
    }
    // ACK/HEARTBEAT frames share the budget, so count every host frame
    expect(sentAt.length).toBeGreaterThanOrEqual(300);
    for (let i = 0; i + 200 < sentAt.length; i++) {
      expect((sentAt[i + 200] ?? 0) - (sentAt[i] ?? 0)).toBeGreaterThanOrEqual(1000);
    }
    expect(s.deviceEvents.message.filter((m) => m.message.kind === "SET_SLOT")).toHaveLength(300);
  });

  test("close cancels pending sends and stops timers", async () => {
    const s = connected();
    s.deviceWire.drop = () => true;
    const wait = s.host.sendAndWait({ kind: "CLEAR_SLOTS" });
    s.host.close();
    expect(await wait).toEqual({ outcome: "cancelled" });
    const n = s.hostWire.frames.length;
    s.clock.advance(5000);
    expect(s.hostWire.frames.length).toBe(n);
  });
});

describe("host restart", () => {
  test("a host restarted within 3.5 s stays silent until the device re-sends HELLO", () => {
    const s = connected();
    s.clock.advance(500);
    s.host.close();
    const reborn = Link.host({ transport: s.pair.host, clock: s.clock, hostSession: 99, maxFramesPerSecond: Infinity });
    const negotiated: number[] = [];
    reborn.on("negotiated", (e) => negotiated.push(e.proto));
    const mark = s.hostWire.frames.length;
    reborn.start();
    // the companion pushes state right away; it must not reach the device yet
    expect(reborn.send(slot(1))).toBeUndefined();
    s.device.send({ kind: "KEY", key: 4, gesture: "single" });
    s.clock.advance(3000);
    expect(s.hostWire.frames.slice(mark)).toHaveLength(0);
    expect(negotiated).toHaveLength(0);
    // the unanswered KEY faults on the device instead of executing on an unsynced host
    expect(s.deviceEvents.fault.map((f) => f.message.kind)).toEqual(["KEY"]);
    s.clock.advance(2000);
    expect(s.deviceEvents["peer-lost"]).toHaveLength(1);
    expect(negotiated).toEqual([1]);
    expect(s.deviceEvents.negotiated.at(-1)).toEqual({ proto: 1, hostSession: 99 });
    expect(reborn.send(slot(2))).toBeNumber();
  });

  test("close + start on the same host link renegotiates instead of resuming", () => {
    const s = connected();
    s.host.close();
    expect(s.host.peerAlive).toBe(false);
    expect(s.host.negotiatedProto).toBeUndefined();
    s.host.start();
    expect(s.host.send(slot(1))).toBeUndefined();
    s.clock.advance(5000);
    expect(s.hostEvents.negotiated).toHaveLength(2);
    expect(s.host.negotiatedProto).toBe(1);
  });

  test("before negotiation the host answers nothing but HELLO", async () => {
    const s = setup();
    s.host.start();
    expect(await s.host.sendAndWait({ kind: "CLEAR_SLOTS" })).toEqual({ outcome: "cancelled" });
    for (const m of payloadToMidi(encode({ kind: "KEY", key: 1, gesture: "single" }, 3), "device")) s.pair.host.deliver(m);
    for (const m of payloadToMidi(rawFrame(0x7e, 4, []), "device")) s.pair.host.deliver(m);
    s.clock.advance(5000);
    expect(s.hostWire.frames).toHaveLength(0);
    expect(s.hostEvents.message).toHaveLength(0);
    s.device.start();
    expect(s.hostWire.kinds()).toEqual(["ACK", "HELLO_ACK"]);
  });
});

describe("receive errors", () => {
  test("an over-long frame is counted as an rx error and not delivered", () => {
    const s = connected();
    const midi = payloadToMidi(new Array<number>(105).fill(0), "device");
    for (const m of midi) s.pair.host.deliver(m);
    expect(s.host.rxErrors).toBe(1);
    expect(s.hostEvents["rx-error"].map((e) => e.code)).toEqual(["bad_length"]);
  });
});
