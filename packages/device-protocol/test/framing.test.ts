import { describe, expect, test } from "bun:test";
import { CC, encode, FrameAssembler, MAX_FRAME, payloadToMidi } from "../src";

const cc = (controller: number, value: number): number[] => [0xbf, controller, value];
const frame = encode({ kind: "SET_STATUS", link: "ok", attentionCount: 2, text: "hi" }, 3);

describe("payloadToMidi", () => {
  test("host frames use CC118/119, device frames CC116/117", () => {
    const host = payloadToMidi([1, 2], "host");
    expect(host).toEqual([cc(118, 1), cc(119, 1), cc(119, 2), cc(118, 2)]);
    const device = payloadToMidi([5], "device");
    expect(device).toEqual([cc(116, 1), cc(117, 5), cc(116, 2)]);
  });

  test("rejects non-7-bit payload bytes", () => {
    expect(() => payloadToMidi([128], "host")).toThrow(RangeError);
  });
});

describe("FrameAssembler", () => {
  test("ignores interleaved junk MIDI", () => {
    const asm = new FrameAssembler("host");
    const junk: number[][] = [
      [0x90, 60, 100], // note on ch1
      [0xb0, CC.hostData, 9], // right CC, wrong channel
      [0xbf, 7, 100], // channel 16, other controller
      [0xbf, CC.deviceData, 4], // the other direction
      [0xf8], // clock
      [0xfe], // active sensing
      [0xbf, CC.hostData], // truncated
    ];
    const stream: number[][] = [];
    for (const m of payloadToMidi(frame, "host")) {
      stream.push(m);
      stream.push(...junk);
    }
    const out = stream.map((m) => asm.push(m)).filter((p) => p !== undefined);
    expect(out).toEqual([frame]);
  });

  test("START while open discards the open frame", () => {
    const asm = new FrameAssembler("host");
    asm.push(cc(118, 1));
    asm.push(cc(119, 99));
    const out = payloadToMidi(frame, "host").map((m) => asm.push(m)).filter(Boolean);
    expect(out).toEqual([frame]);
    expect(asm.stats.restarted).toBe(1);
  });

  test("ABORT discards; END without START yields nothing", () => {
    const asm = new FrameAssembler("device");
    asm.push(cc(116, 1));
    asm.push(cc(117, 1));
    expect(asm.push(cc(116, 3))).toBeUndefined();
    expect(asm.push(cc(116, 2))).toBeUndefined();
    expect(asm.stats.aborted).toBe(1);
  });

  test("data outside a frame is dropped", () => {
    const asm = new FrameAssembler("host");
    asm.push(cc(119, 7));
    asm.push(cc(119, 8));
    const out = payloadToMidi(frame, "host").map((m) => asm.push(m)).filter(Boolean);
    expect(out).toEqual([frame]);
    expect(asm.stats.strayBytes).toBe(2);
  });

  test("accepts exactly 104 bytes and discards 105", () => {
    const asm = new FrameAssembler("host");
    const max = new Array<number>(MAX_FRAME).fill(1);
    expect(payloadToMidi(max, "host").map((m) => asm.push(m)).filter(Boolean)).toEqual([max]);
    const over = new Array<number>(MAX_FRAME + 1).fill(1);
    expect(payloadToMidi(over, "host").map((m) => asm.push(m)).filter(Boolean)).toEqual([]);
    expect(asm.stats.overflowed).toBe(1);
    // the assembler recovers on the next START
    expect(payloadToMidi(frame, "host").map((m) => asm.push(m)).filter(Boolean)).toEqual([frame]);
  });

  test("unknown control values are ignored", () => {
    const asm = new FrameAssembler("host");
    const msgs = payloadToMidi(frame, "host");
    msgs.splice(2, 0, cc(118, 0), cc(118, 77));
    expect(msgs.map((m) => asm.push(m)).filter(Boolean)).toEqual([frame]);
  });
});
