import { describe, expect, test } from "bun:test";
import { FakeClock, type Gesture } from "@fm1/device-protocol";
import { GestureTracker } from "../src/gestures";
import { connected } from "./harness";

function tracker() {
  const clock = new FakeClock();
  const out: string[] = [];
  const t = new GestureTracker(clock, (key: number, g: Gesture) => out.push(`${key}:${g}`));
  return { clock, out, t };
}

describe("gesture timing", () => {
  test("single is sent only once the 300 ms double window has passed", () => {
    const { clock, out, t } = tracker();
    t.down(4);
    clock.advance(80);
    t.up(4);
    expect(out).toEqual(["4:down", "4:up"]);
    clock.advance(300);
    expect(out).toEqual(["4:down", "4:up"]);
    clock.advance(1);
    expect(out).toEqual(["4:down", "4:up", "4:single"]);
  });

  test("double: down, up, down, up, double and no single", () => {
    const { clock, out, t } = tracker();
    t.down(1);
    clock.advance(50);
    t.up(1);
    clock.advance(300); // second down exactly at the window edge still counts
    t.down(1);
    clock.advance(50);
    t.up(1);
    clock.advance(1000);
    expect(out).toEqual(["1:down", "1:up", "1:down", "1:up", "1:double"]);
  });

  test("a second press after the window gives two singles", () => {
    const { clock, out, t } = tracker();
    t.down(1);
    t.up(1);
    clock.advance(301);
    t.down(1);
    t.up(1);
    clock.advance(301);
    expect(out).toEqual(["1:down", "1:up", "1:single", "1:down", "1:up", "1:single"]);
  });

  test("long fires at 600 ms while held; no single follows", () => {
    const { clock, out, t } = tracker();
    t.down(26);
    clock.advance(599);
    expect(out).toEqual(["26:down"]);
    clock.advance(1);
    expect(out).toEqual(["26:down", "26:long"]);
    clock.advance(500);
    t.up(26);
    clock.advance(1000);
    expect(out).toEqual(["26:down", "26:long", "26:up"]);
  });

  test("599 ms hold is not long", () => {
    const { clock, out, t } = tracker();
    t.down(0);
    clock.advance(599);
    t.up(0);
    clock.advance(400);
    expect(out).toEqual(["0:down", "0:up", "0:single"]);
  });

  test("keys are independent", () => {
    const { clock, out, t } = tracker();
    t.down(1);
    t.down(2);
    t.up(1);
    t.up(2);
    clock.advance(301);
    expect(out).toEqual(["1:down", "2:down", "1:up", "2:up", "1:single", "2:single"]);
  });
});

describe("device inputs on the wire", () => {
  test("key gestures, button edges, encoder deltas and MASTER reach the host as frames", () => {
    const r = connected();
    const got: string[] = [];
    r.host().on("message", ({ message }) => {
      if (message.kind === "KEY") got.push(`KEY ${message.key} ${message.gesture}`);
      if (message.kind === "BUTTON") got.push(`BUTTON ${message.button} ${message.edge}`);
      if (message.kind === "ENCODER") got.push(`ENCODER ${message.encoder} ${message.delta}`);
      if (message.kind === "POT") got.push(`POT ${message.pot} ${message.value}`);
    });
    r.device.keyDown(3);
    r.clock.advance(40);
    r.device.keyUp(3);
    r.clock.advance(400);
    r.device.button("REC", true);
    r.device.button("REC", false);
    r.device.turn("SELECT", -2);
    r.device.turn("K1", 100); // split into s7-sized frames
    r.device.setMaster(500);
    r.device.setMaster(502); // below hysteresis
    r.device.setMaster(1023);
    r.clock.advance(10);
    expect(got).toEqual([
      "KEY 3 down",
      "KEY 3 up",
      "KEY 3 single",
      "BUTTON REC down",
      "BUTTON REC up",
      "ENCODER SELECT -2",
      "ENCODER K1 63",
      "ENCODER K1 37",
      "POT MASTER 500",
      "POT MASTER 1023",
    ]);
    expect(r.device.state.master).toBe(1023);
    expect(r.host().pendingCount).toBe(0);
  });
});
