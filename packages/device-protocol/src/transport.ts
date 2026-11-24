import { CC_STATUS } from "./constants";
import type { MidiMessage } from "./framing";

export interface MidiTransport {
  /** Sends one MIDI message. Implementations reject anything but a channel-16 CC. */
  send(bytes: number[]): void;
  /** Subscribes to incoming MIDI messages; returns an unsubscribe function. */
  onMessage(cb: (msg: MidiMessage) => void): () => void;
  close(): void;
}

export class UnsafeMidiError extends Error {
  constructor(
    message: string,
    readonly bytes: readonly number[],
  ) {
    super(message);
    this.name = "UnsafeMidiError";
  }
}

/**
 * Throws unless `bytes` is exactly one control change on channel 16. SysEx (0xF0)
 * is rejected first and explicitly: it reaches the updater, and
 * `F0 22 24 35 7D F7` reboots the FM-1 into ROM boot.
 */
export function assertSafeMidi(bytes: readonly number[]): void {
  if (bytes[0] === 0xf0) throw new UnsafeMidiError("refusing to send SysEx", bytes);
  if (bytes.length !== 3 || bytes[0] !== CC_STATUS) {
    throw new UnsafeMidiError("only channel-16 control changes may be sent", bytes);
  }
  for (const b of bytes.slice(1)) {
    if (!Number.isInteger(b) || b < 0 || b > 0x7f) {
      throw new UnsafeMidiError("CC data byte out of range", bytes);
    }
  }
}

type Tap = (msg: number[]) => number[] | null;

export class LoopbackEnd implements MidiTransport {
  peer: LoopbackEnd | undefined;
  /** Test hook: return null to drop a message in flight, or a replacement. */
  tap: Tap | undefined;
  sent = 0;
  private listeners = new Set<(msg: MidiMessage) => void>();
  private closed = false;

  send(bytes: number[]): void {
    assertSafeMidi(bytes);
    if (this.closed) throw new Error("transport closed");
    this.sent++;
    const msg = this.tap ? this.tap([...bytes]) : [...bytes];
    if (msg) this.peer?.deliver(msg);
  }

  /** Injects a raw message as if it came from the peer (bypasses the guard). */
  deliver(msg: MidiMessage): void {
    if (this.closed) return;
    for (const cb of [...this.listeners]) cb(msg);
  }

  onMessage(cb: (msg: MidiMessage) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }
}

/** Two in-memory transports wired to each other; delivery is synchronous. */
export class LoopbackPair {
  readonly host = new LoopbackEnd();
  readonly device = new LoopbackEnd();

  constructor() {
    this.host.peer = this.device;
    this.device.peer = this.host;
  }
}

