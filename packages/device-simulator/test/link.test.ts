import { describe, expect, test } from "bun:test";
import { keyLeds } from "../src/leds";
import { layoutScreen } from "../src/layout";
import { connected, rig } from "./harness";

const kinds = (r: ReturnType<typeof rig>, kind: string) => r.deviceFrames.filter((f) => f.message.kind === kind);

describe("handshake", () => {
  test("HELLO repeats every second until HELLO_ACK, then stops", () => {
    const r = rig();
    r.device.start();
    expect(r.device.state.link.phase).toBe("no_host");
    r.clock.advance(3000);
    expect(kinds(r, "HELLO").length).toBe(4);
    const hello = kinds(r, "HELLO")[0]?.message;
    expect(hello).toMatchObject({ protoMin: 1, protoMax: 5, fwMajor: 0, fwMinor: 1, fwPatch: 0, bootId: 1234 });

    r.startHost();
    r.clock.advance(1000);
    expect(r.device.state.link).toMatchObject({ phase: "connected", proto: 5, hostSession: 99, linkError: false });
    const before = kinds(r, "HELLO").length;
    r.clock.advance(5000);
    expect(kinds(r, "HELLO").length).toBe(before);
  });

  test("heartbeat every 1000 ms carries uptime and rx errors", () => {
    const r = connected();
    const start = kinds(r, "HEARTBEAT").length;
    r.clock.advance(3000);
    const beats = kinds(r, "HEARTBEAT").slice(start);
    expect(beats.length).toBe(3);
    expect(beats.at(-1)?.message).toMatchObject({ kind: "HEARTBEAT", uptimeS: 3, rxErrors: 0 });
  });

  test("a host with no common version shows UPDATE APP", () => {
    const r = rig();
    r.startHost({ versions: { min: 0, max: 0 } });
    r.device.start();
    r.clock.advance(10);
    expect(r.device.state.link.phase).toBe("incompatible");
    expect(r.device.state.link.incompatible).toBe("UPDATE APP");
    const overlay = layoutScreen(r.device.state, 0).regions.find((x) => x.id === "overlay");
    expect(JSON.stringify(overlay?.ops)).toContain("UPDATE APP");
  });

  test("inputs are not sent without a negotiated host", () => {
    const r = rig();
    r.device.start();
    const notes: string[] = [];
    r.device.on("frame", (e) => e.error && notes.push(`${e.kind}:${e.error}`));
    r.device.button("REC", true);
    expect(r.inputs()).toEqual([]);
    expect(notes).toEqual(["BUTTON:not sent"]);
  });
});

describe("liveness", () => {
  test("host lost after 3500 ms silence: NO COMPANION, keys glow, HELLO resumes, then reconnects", () => {
    const r = connected();
    r.host().send({ kind: "SET_SLOT", key: 2, state: "working", flags: { selected: true, codex: false, stale: false, pinned: false }, label: "a" });
    r.clock.advance(10);
    expect(keyLeds(r.device.state, 0)[2]).toBe("breath"); // LED language v2 (protocol 5): the selection breathes

    r.stopHost();
    r.clock.advance(3400);
    expect(r.device.state.link.phase).toBe("connected");
    r.clock.advance(200);
    expect(r.device.state.link.phase).toBe("no_host");
    // Local selection and slots are kept, LEDs go to glow, the NO HOST banner covers the last frame.
    expect(r.device.state.slots[2]?.flags.selected).toBe(true);
    // (LED language v2, docs/ui-v3.md section 9.9: the kept selection breathes, every other key glows)
    expect(keyLeds(r.device.state, 0).every((l, k) => l === (k === 2 ? "breath" : "glow"))).toBe(true);
    const ids = layoutScreen(r.device.state, 0).regions.map((x) => x.id);
    expect(ids).toContain("overlay");

    const hellos = kinds(r, "HELLO").length;
    r.clock.advance(2000);
    expect(kinds(r, "HELLO").length).toBeGreaterThanOrEqual(hellos + 2);

    r.startHost({ hostSession: 7 });
    r.clock.advance(1000);
    expect(r.device.state.link).toMatchObject({ phase: "connected", hostSession: 7 });
  });

  test("host heartbeats alone keep the link alive", () => {
    const r = connected();
    r.clock.advance(20_000);
    expect(r.device.state.link.phase).toBe("connected");
  });

  test("unacknowledged input faults to NO REPLY, cleared by the next ACK", () => {
    const r = connected();
    r.pair.host.tap = () => null; // host's frames (incl. ACKs) vanish
    r.device.button("PLAY", true);
    r.clock.advance(250 * 4 + 10);
    expect(r.device.state.link.linkError).toBe(true);
    const status = layoutScreen(r.device.state, 0).regions.find((x) => x.id === "status");
    expect(JSON.stringify(status?.ops)).toContain('"NO REPLY"');
    r.pair.host.tap = undefined;
    r.device.button("PLAY", false);
    r.clock.advance(10);
    expect(r.device.state.link.linkError).toBe(false);
  });
});

describe("sequence wrap and lifecycle", () => {
  test("300 frames each way wrap SEQ past 127 without loss or false duplicates", () => {
    const r = connected();
    let applied = 0;
    r.device.on("applied", (m) => m.kind === "SET_VIEW" && applied++);
    let buttons = 0;
    r.host().on("message", ({ message }) => message.kind === "BUTTON" && buttons++);
    for (let i = 0; i < 300; i++) {
      // Identical bodies, so a SEQ reused after the wrap has the same checksum as before.
      r.host().send({ kind: "SET_VIEW", view: "tasks", page: 0, pages: 1, title: "SAME" });
      r.device.button("PLAY", true);
      r.clock.advance(1);
    }
    r.clock.advance(50);
    expect(applied).toBe(300);
    expect(buttons).toBe(300);
    expect(r.host().pendingCount).toBe(0);
    expect(r.device.state.link.linkError).toBe(false);
    expect(r.device.rxErrors).toBe(0);
  });

  test("bad input values throw instead of hanging or sending garbage", () => {
    const r = connected();
    expect(() => r.device.turn("K1", Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => r.device.turn("K1", Number.NaN)).toThrow(RangeError);
    expect(() => r.device.turn("K1", 1.5)).toThrow(RangeError);
    expect(() => r.device.turn("K1", 5000)).toThrow(RangeError);
    expect(() => r.device.setMaster(Number.NaN)).toThrow(RangeError);
    expect(() => r.device.keyDown(27)).toThrow(RangeError);
    r.clock.advance(10);
    expect(r.inputs()).toEqual([]);
  });

  test("a stopped device refuses to start again rather than crashing on its closed transport", () => {
    const r = connected();
    r.device.stop();
    expect(() => r.device.start()).toThrow(/stopped/);
    expect(() => r.clock.advance(5000)).not.toThrow();
  });
});
