import { CC, CC_STATUS, FRAME_CONTROL, MAX_FRAME } from "./constants";
import type { Role } from "./messages";

export type MidiMessage = readonly number[];

interface CcPair {
  control: number;
  data: number;
}

/** Controller numbers used by frames that `sender` transmits. */
export const ccFor = (sender: Role): CcPair =>
  sender === "host"
    ? { control: CC.hostControl, data: CC.hostData }
    : { control: CC.deviceControl, data: CC.deviceData };

/** Turns frame payload bytes into the CC message stream `sender` transmits. */
export function payloadToMidi(payload: readonly number[], sender: Role): number[][] {
  const { control, data } = ccFor(sender);
  const out: number[][] = [[CC_STATUS, control, FRAME_CONTROL.start]];
  for (const b of payload) {
    if (!Number.isInteger(b) || b < 0 || b > 0x7f) throw new RangeError(`payload byte ${b} is not 7-bit`);
    out.push([CC_STATUS, data, b]);
  }
  out.push([CC_STATUS, control, FRAME_CONTROL.end]);
  return out;
}

export interface AssemblerStats {
  frames: number;
  aborted: number;
  overflowed: number;
  /** Frames discarded because a START arrived while they were open. */
  restarted: number;
  strayBytes: number;
}

/**
 * Reassembles frames sent by `sender` from a raw MIDI message stream. Everything that
 * is not a channel-16 CC on that sender's controllers is ignored.
 */
export class FrameAssembler {
  private readonly cc: CcPair;
  private buf: number[] | undefined;
  private overflow = false;
  readonly stats: AssemblerStats = { frames: 0, aborted: 0, overflowed: 0, restarted: 0, strayBytes: 0 };

  constructor(sender: Role) {
    this.cc = ccFor(sender);
  }

  /** Feeds one MIDI message; returns a completed payload when this message closes a frame. */
  push(msg: MidiMessage): number[] | undefined {
    if (msg.length !== 3 || msg[0] !== CC_STATUS) return undefined;
    const controller = msg[1];
    const value = msg[2] ?? 0;
    if (value > 0x7f) return undefined;
    if (controller === this.cc.data) return this.data(value);
    if (controller === this.cc.control) return this.control(value);
    return undefined;
  }

  private data(value: number): undefined {
    if (!this.buf) {
      this.stats.strayBytes++;
      return undefined;
    }
    if (this.overflow) return undefined;
    if (this.buf.length >= MAX_FRAME) {
      this.overflow = true;
      this.stats.overflowed++;
      return undefined;
    }
    this.buf.push(value);
    return undefined;
  }

  private control(value: number): number[] | undefined {
    switch (value) {
      case FRAME_CONTROL.start:
        if (this.buf) this.stats.restarted++;
        this.buf = [];
        this.overflow = false;
        return undefined;
      case FRAME_CONTROL.end: {
        const done = this.buf && !this.overflow ? this.buf : undefined;
        this.buf = undefined;
        this.overflow = false;
        if (done) this.stats.frames++;
        return done;
      }
      case FRAME_CONTROL.abort:
        if (this.buf) this.stats.aborted++;
        this.buf = undefined;
        this.overflow = false;
        return undefined;
      default:
        return undefined;
    }
  }
}
