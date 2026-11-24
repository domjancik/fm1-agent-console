import { describe, expect, test } from "bun:test";
import { assertSafeMidi, findPort, LoopbackPair, UnsafeMidiError } from "../src";

describe("assertSafeMidi", () => {
  test("refuses SysEx, including the ROM-boot and OTA triggers", () => {
    for (const bytes of [
      [0xf0, 0x22, 0x24, 0x35, 0x7d, 0xf7],
      [0xf0, 0x22, 0x24, 0x35, 0x7f, 0xf7],
      [0xf0, 0xbf, 0x76],
      [0xf0],
    ]) {
      expect(() => assertSafeMidi(bytes)).toThrow("SysEx");
    }
  });

  test("refuses anything but a channel-16 CC", () => {
    for (const bytes of [
      [0xb0, 118, 1], // channel 1
      [0x9f, 60, 100], // note on ch16
      [0xbf, 118], // short
      [0xbf, 118, 1, 0], // long
      [0xbf, 128, 1], // bad controller
      [0xbf, 118, 200], // bad value
      [0xf7],
      [],
    ]) {
      expect(() => assertSafeMidi(bytes)).toThrow(UnsafeMidiError);
    }
    expect(() => assertSafeMidi([0xbf, 119, 127])).not.toThrow();
  });
});

describe("LoopbackPair", () => {
  test("delivers between ends and enforces the guard", () => {
    const pair = new LoopbackPair();
    const got: number[][] = [];
    pair.device.onMessage((m) => got.push([...m]));
    pair.host.send([0xbf, 118, 1]);
    expect(got).toEqual([[0xbf, 118, 1]]);
    expect(() => pair.host.send([0xf0, 0x22, 0x24, 0x35, 0x7d, 0xf7])).toThrow(UnsafeMidiError);
    expect(got).toHaveLength(1);
  });

  test("unsubscribe and close stop delivery", () => {
    const pair = new LoopbackPair();
    let n = 0;
    const off = pair.host.onMessage(() => n++);
    pair.device.send([0xbf, 117, 1]);
    off();
    pair.device.send([0xbf, 117, 1]);
    expect(n).toBe(1);
    pair.device.close();
    expect(() => pair.device.send([0xbf, 117, 1])).toThrow("closed");
  });
});

describe("findPort", () => {
  test("matches case-insensitive substrings", () => {
    const names = ["IAC Driver Bus 1", "AMB-1 FM-1", "FM1 Console Sim"];
    expect(findPort(names, "fm-1")).toBe(1);
    expect(findPort(names, "console sim")).toBe(2);
    expect(findPort(names, "nope")).toBe(-1);
  });
});

// Opt-in: exercises CoreMIDI through a private virtual port pair in a child process.
// It never opens the FM-1 or any other existing port.
const coreMidi = process.env.FM1_MIDI_TESTS === "1" ? test : test.skip;

coreMidi("CoreMIDI virtual port round trip", () => {
  const script = new URL("../scripts/midi-loopback.ts", import.meta.url).pathname;
  const run = Bun.spawnSync(["bun", script], { stderr: "pipe", stdout: "pipe", timeout: 15_000 });
  expect(run.stderr.toString()).toBe("");
  expect(run.stdout.toString()).toContain("coremidi loopback ok");
  expect(run.exitCode).toBe(0);
});
