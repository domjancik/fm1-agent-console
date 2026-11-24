// BLE-MIDI packets (Apple / MMA "MIDI over Bluetooth Low Energy" 1.0) to and from plain MIDI messages.
//
// A packet is: header (1 0 t12..t7), then per message a timestamp byte (1 t6..t0) before every status byte,
// data bytes after it. Running status: a message may repeat the previous channel status with data bytes only,
// with or without its own timestamp byte. SysEx may span packets: a continuation packet starts with the header
// and goes on with data bytes (no timestamp); the closing F7 has its own timestamp byte. Real-time bytes
// (F8..FF) may appear anywhere, also inside a SysEx, each after a timestamp byte.
// The decoder follows the firmware's (firmware/firmware/ble/ble_midi.c) rules so both ends agree.

export interface TimedMessage {
  /** 13-bit BLE-MIDI timestamp in ms (header high 6 bits, timestamp byte low 7 bits). */
  ts: number;
  bytes: number[];
}

/** The smallest payload a BLE link has (ATT MTU 23 - 3). */
export const MIN_BLE_PAYLOAD = 20;
/** A packet must hold at least header + timestamp + a 3-byte message. */
export const MIN_PACKET = 5;
export const MAX_PACKET = 512;
/** A SysEx longer than this is dropped by the decoder (the console protocol never uses SysEx). */
export const MAX_SYSEX = 4096;

/** Data bytes after a status byte: channel messages and system common; 0 for real time and the rest. */
export function dataLength(status: number): number {
  if (status < 0xf0) return (status & 0xe0) === 0xc0 ? 1 : 2;
  return status === 0xf2 ? 2 : status === 0xf1 || status === 0xf3 ? 1 : 0;
}

export class BleMidiDecoder {
  private rs = 0;
  private cur = 0;
  private need = 0;
  private data: number[] = [];
  private sysex: number[] | null = null;
  /** Packets with a bad header, stray data and cut-short or oversize SysEx. */
  errors = 0;

  reset(): void {
    this.rs = this.cur = this.need = 0;
    this.data = [];
    this.sysex = null;
  }

  decode(packet: ArrayLike<number>): TimedMessage[] {
    const out: TimedMessage[] = [];
    if (packet.length < 1 || (packet[0]! & 0xc0) !== 0x80) {
      this.errors++;
      return out;
    }
    let hi = packet[0]! & 0x3f;
    let lo = -1;
    let ts = hi << 7;
    let afterTs = false;
    for (let i = 1; i < packet.length; i++) {
      const b = packet[i]! & 0xff;
      if (!(b & 0x80)) {
        this.onData(b, ts, out);
        afterTs = false;
      } else if (!afterTs) {
        const l = b & 0x7f;
        if (lo >= 0 && l < lo) hi = (hi + 1) & 0x3f; // the low 7 bits wrapped inside this packet
        lo = l;
        ts = (hi << 7) | lo;
        afterTs = true;
      } else {
        this.onStatus(b, ts, out);
        afterTs = false;
      }
    }
    if (!this.sysex) {
      // Only a SysEx continues in the next packet; a channel message cut at the end is lost (running status kept).
      if (this.cur && this.data.length) this.errors++;
      this.cur = 0;
      this.data = [];
    }
    return out;
  }

  private onStatus(b: number, ts: number, out: TimedMessage[]): void {
    if (b >= 0xf8) {
      out.push({ ts, bytes: [b] }); // real time: anywhere, nothing else changes
      return;
    }
    if (this.sysex) {
      if (b === 0xf7) {
        this.sysex.push(b);
        out.push({ ts, bytes: this.sysex });
        this.sysex = null;
        return;
      }
      this.sysex = null; // any other status cuts the SysEx short: dropped
      this.errors++;
    }
    this.data = [];
    if (b === 0xf0) {
      this.rs = this.cur = 0;
      this.sysex = [b];
      return;
    }
    if (b === 0xf7 || b === 0xf4 || b === 0xf5) {
      this.rs = this.cur = 0;
      return;
    }
    this.cur = b;
    this.need = dataLength(b);
    this.rs = b < 0xf0 ? b : 0;
    if (!this.need) this.emit(ts, out); // F6
  }

  private onData(b: number, ts: number, out: TimedMessage[]): void {
    if (this.sysex) {
      if (this.sysex.length >= MAX_SYSEX) {
        this.sysex = null;
        this.errors++;
        return;
      }
      this.sysex.push(b);
      return;
    }
    if (!this.cur) {
      if (!this.rs) {
        this.errors++; // a stray data byte
        return;
      }
      this.cur = this.rs;
      this.need = dataLength(this.rs);
      this.data = [];
    }
    this.data.push(b);
    if (this.data.length === this.need) this.emit(ts, out);
  }

  private emit(ts: number, out: TimedMessage[]): void {
    out.push({ ts, bytes: [this.cur, ...this.data] });
    this.data = [];
    // Running status (`rs`) carries a channel status to data-only messages; system common leaves none.
    this.cur = 0;
  }
}

export interface EncodeOptions {
  /** Repeat a channel status within a packet as [timestamp][data] (the firmware does this too). Default false:
   * every message carries its status, the plainest form for any decoder. */
  runningStatus?: boolean;
}

/** Checks one outgoing message: a channel / system common / real-time message with the right length, or a
 * complete SysEx (F0 ... F7) with data bytes in between. */
export function checkMessage(m: readonly number[]): void {
  const s = m[0];
  if (s === undefined || s < 0x80 || s > 0xff) throw new Error(`MIDI message must start with a status byte: ${JSON.stringify(m)}`);
  if (s === 0xf0) {
    if (m.length < 2 || m[m.length - 1] !== 0xf7) throw new Error("SysEx must end with F7");
    for (let i = 1; i < m.length - 1; i++) if (m[i]! & 0x80 || m[i]! < 0) throw new Error("SysEx data byte out of range");
    return;
  }
  if (s === 0xf7 || s === 0xf4 || s === 0xf5) throw new Error(`status ${s.toString(16)} cannot be sent alone`);
  const n = s >= 0xf8 ? 0 : dataLength(s);
  if (m.length !== n + 1) throw new Error(`status ${s.toString(16)} needs ${n} data bytes, got ${m.length - 1}`);
  for (let i = 1; i < m.length; i++) if (!Number.isInteger(m[i]) || m[i]! < 0 || m[i]! > 0x7f) throw new Error("data byte out of range");
}

/**
 * Packs messages (in order) into BLE-MIDI packets of at most `maxLen` bytes, all stamped with `timeMs`.
 * A SysEx is split across as many packets as it needs; a channel message never straddles two packets.
 */
export function encodePackets(messages: readonly (readonly number[])[], maxLen: number, timeMs: number, opts: EncodeOptions = {}): number[][] {
  const cap = Math.min(MAX_PACKET, Math.floor(maxLen));
  if (!(cap >= MIN_PACKET)) throw new Error(`BLE-MIDI packet size ${maxLen} is below ${MIN_PACKET}`);
  const t = ((timeMs % 8192) + 8192) % 8192;
  const header = 0x80 | (t >> 7);
  const tsByte = 0x80 | (t & 0x7f);
  const packets: number[][] = [];
  let pkt: number[] = [];
  let rs = 0;
  const room = (): number => cap - (pkt.length || 1); // an empty packet still needs its header
  const flush = (): void => {
    if (pkt.length > 1) packets.push(pkt);
    pkt = [];
    rs = 0;
  };
  const put = (...bytes: number[]): void => {
    if (!pkt.length) pkt.push(header);
    pkt.push(...bytes);
  };
  for (const m of messages) {
    checkMessage(m);
    const s = m[0]!;
    if (s === 0xf0) {
      if (room() < 3) flush(); // [ts][F0] and at least one more byte
      put(tsByte, 0xf0);
      const body = m.slice(1, -1);
      for (let i = 0; i < body.length; ) {
        if (room() < 1) flush();
        const n = Math.min(room(), body.length - i);
        put(...body.slice(i, i + n));
        i += n;
      }
      if (room() < 2) flush(); // [ts][F7] stay together
      put(tsByte, 0xf7);
      rs = 0;
      continue;
    }
    const running = opts.runningStatus === true && s < 0xf0 && s === rs;
    const bytes = running ? [tsByte, ...m.slice(1)] : [tsByte, ...m];
    if (room() < bytes.length) {
      flush();
      put(tsByte, ...m);
    } else put(...bytes);
    if (s < 0xf0) rs = s;
    else if (s < 0xf8) rs = 0;
  }
  flush();
  return packets;
}
