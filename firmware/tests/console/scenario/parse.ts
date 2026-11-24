// SPDX-License-Identifier: GPL-3.0-only
// Device output: CC messages (from tests/host.c's "MIDI out" lines, or the emulator's USB replies) back into
// frames with the TypeScript reference decoder, so every frame the firmware sends is checked by the other codec.
import { decode, FrameAssembler, type DeviceMessage } from "../../../../packages/device-protocol/src/index.ts";

export interface DeviceFrame {
  t: number;
  seq: number;
  msg: DeviceMessage;
}

export interface LedSample {
  t: number;
  lit: bigint;
  glow: bigint;
  px: number;
}

/** A transition's end (fm1c_trans.h, host mode): its kind, done or at once, its pixels and its largest step. */
export interface TransLine {
  t: number;
  kind: string;
  how: string;
  px: number;
  maxStep: number;
}

export interface DeviceOutput {
  frames: DeviceFrame[];
  /** Frames the TS decoder rejected (any is a firmware bug). */
  bad: { t: number; error: string }[];
  leds: LedSample[];
  shots: { t: number; file: string }[];
  /** Version 5 LEDs v2: the backlight layer's mask each time it changed. */
  bg: { t: number; mask: bigint }[];
  trans: TransLine[];
}

export function framesFromMidi(midi: readonly { t: number; midi: readonly number[] }[]): Pick<DeviceOutput, "frames" | "bad"> {
  const asm = new FrameAssembler("device");
  const frames: DeviceFrame[] = [];
  const bad: { t: number; error: string }[] = [];
  for (const m of midi) {
    const payload = asm.push(m.midi);
    if (!payload) continue;
    const r = decode(payload, "device");
    if (r.ok) frames.push({ t: m.t, seq: r.value.seq, msg: r.value.message as DeviceMessage });
    else bad.push({ t: m.t, error: `${r.error.code}: ${r.error.detail}` });
  }
  return { frames, bad };
}

const MIDI = /^\s*(\d+) ms {2}MIDI out ([0-9A-F]{2}) (\d+) (\d+)$/;
const LEDS = /^\s*(\d+) ms {2}LEDS lit ([0-9a-f]+) glow ([0-9a-f]+) px (\d+)$/;
const SHOT = /^\s*(\d+) ms {2}screen -> (\S+)$/;
const LEDBG = /^\s*(\d+) ms {2}LEDBG ([0-9a-f]+)$/;
const TRANS = /^\s*(\d+) ms {2}TRANS (\S+) (\S+) px (\d+) maxstep (\d+)$/;

export function parseHostOutput(stdout: string): DeviceOutput {
  const midi: { t: number; midi: number[] }[] = [];
  const leds: LedSample[] = [];
  const shots: { t: number; file: string }[] = [];
  const bg: { t: number; mask: bigint }[] = [];
  const trans: TransLine[] = [];
  for (const line of stdout.split("\n")) {
    const b = LEDBG.exec(line);
    if (b) {
      bg.push({ t: Number(b[1]), mask: BigInt(`0x${b[2]}`) });
      continue;
    }
    const tr = TRANS.exec(line);
    if (tr) {
      trans.push({ t: Number(tr[1]), kind: tr[2] ?? "", how: tr[3] ?? "", px: Number(tr[4]), maxStep: Number(tr[5]) });
      continue;
    }
    let m = MIDI.exec(line);
    if (m) {
      midi.push({ t: Number(m[1]), midi: [Number.parseInt(m[2] ?? "0", 16), Number(m[3]), Number(m[4])] });
      continue;
    }
    m = LEDS.exec(line);
    if (m) {
      leds.push({ t: Number(m[1]), lit: BigInt(`0x${m[2]}`), glow: BigInt(`0x${m[3]}`), px: Number(m[4]) });
      continue;
    }
    m = SHOT.exec(line);
    if (m) shots.push({ t: Number(m[1]), file: m[2] ?? "" });
  }
  return { ...framesFromMidi(midi), leds, shots, bg, trans };
}
