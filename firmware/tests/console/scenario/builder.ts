// SPDX-License-Identifier: GPL-3.0-only
// A timed test script for the console firmware: host frames (encoded by the TypeScript reference codec), raw MIDI,
// panel input, screenshots. One script renders to tests/host.c's line format and to fm1-emu's input formats.
import { encode, payloadToMidi, type HostMessage } from "../../../../packages/device-protocol/src/index.ts";

export type Midi = readonly [number, number, number];

type Panel =
  | { kind: "keys"; mask: number }
  | { kind: "btn" | "btndown" | "btnup"; id: number }
  | { kind: "enc"; id: number; steps: number }
  | { kind: "pot"; value: number }
  | { kind: "shot"; name: string }
  | { kind: "leds"; tag: string };

type Item =
  | { kind: "host"; id: number; msg: HostMessage }
  | { kind: "repeat"; id: number; of: number }
  | { kind: "raw"; id: number; midi: Midi[]; label: string };

export interface Delivered {
  id: number;
  /** ms of the frame's END CC (when the device can first act on it). */
  at: number;
  seq?: number;
  msg?: HostMessage;
  label: string;
  payload?: number[];
}

export interface TimedMidi {
  t: number;
  midi: Midi;
}

export interface Ack {
  t: number;
  seq: number;
}

/** CCs per emulated millisecond: one full 64-byte USB-MIDI packet (16 messages) per 1 ms USB frame, which is what
 * fm1-live's emulated host carries. (It was 24: a burst longer than ~40 ms then queued on the emulated bus, and the
 * ACK check, which counts from this schedule, saw the wire's backlog as device latency; the same 21 ms showed with
 * the version 3 package of 2026-11-18 and with version 4.) */
const CC_PER_MS = 16;

export class Scenario {
  private readonly items: { t: number; order: number; item: Item }[] = [];
  private readonly panel: { t: number; order: number; step: Panel }[] = [];
  private order = 0;
  private nextId = 0;
  private mask = 0;
  endMs = 0;

  /** offset: added to every time on output (the emulator enumerates USB ~333 ms after boot; scenarios start later). */
  constructor(
    readonly name: string,
    private readonly acks: readonly Ack[] = [],
    readonly offset = 0,
  ) {}

  /** Schedules a host frame at t; its SEQ is assigned in time order when the script renders. */
  host(t: number, msg: HostMessage): number {
    const id = this.nextId++;
    this.items.push({ t, order: this.order++, item: { kind: "host", id, msg } });
    return id;
  }

  /** Host frames sent back to back so that the last one's END CC lands at t (a transition's trigger at a known ms). */
  burstEndingAt(t: number, msgs: readonly HostMessage[]): void {
    const ccs = msgs.reduce((n, m) => n + payloadToMidi(encode(m, 0), "host").length, 0);
    const start = t - Math.ceil(ccs / CC_PER_MS) + 1;
    for (const m of msgs) this.host(start, m);
  }

  /** The frame `of` again with its SEQ and bytes: a retransmission. */
  repeat(t: number, of: number): number {
    const id = this.nextId++;
    this.items.push({ t, order: this.order++, item: { kind: "repeat", id, of } });
    return id;
  }

  /** A raw frame payload (malformed on purpose), framed as host CCs. */
  rawPayload(t: number, payload: number[], label: string): number {
    return this.rawMidi(t, payloadToMidi(payload, "host").map((m) => [m[0] ?? 0, m[1] ?? 0, m[2] ?? 0] as const), label);
  }

  rawMidi(t: number, midi: Midi[], label: string): number {
    const id = this.nextId++;
    this.items.push({ t, order: this.order++, item: { kind: "raw", id, midi, label } });
    return id;
  }

  /** Host heartbeats every second over [from, to]; uptime counts from `from`. */
  heartbeats(from: number, to: number, uptimeBase = 0): void {
    for (let t = from; t <= to; t += 1000) {
      this.host(t, { kind: "HEARTBEAT", from: "host", hostUptimeS: uptimeBase + Math.floor((t - from) / 1000) });
    }
  }

  keyDown(t: number, k: number): void {
    this.mask |= 1 << k;
    this.step(t, { kind: "keys", mask: this.mask });
  }
  keyUp(t: number, k: number): void {
    this.mask &= ~(1 << k);
    this.step(t, { kind: "keys", mask: this.mask });
  }
  tap(t: number, button: number): void {
    this.step(t, { kind: "btn", id: button });
  }
  buttonDown(t: number, button: number): void {
    this.step(t, { kind: "btndown", id: button });
  }
  buttonUp(t: number, button: number): void {
    this.step(t, { kind: "btnup", id: button });
  }
  encoder(t: number, id: number, steps: number): void {
    this.step(t, { kind: "enc", id, steps });
  }
  pot(t: number, value: number): void {
    this.step(t, { kind: "pot", value });
  }
  shot(t: number, name: string): void {
    this.step(t, { kind: "shot", name });
  }
  leds(t: number, tag: string): void {
    this.step(t, { kind: "leds", tag });
  }
  end(t: number): void {
    this.endMs = t;
  }

  private step(t: number, step: Panel): void {
    this.panel.push({ t, order: this.order++, step });
  }

  /** The host frames with SEQ and delivery time, and every MIDI message at its ms. */
  render(): { delivered: Delivered[]; midi: TimedMidi[] } {
    const all = [...this.items];
    for (const a of this.acks) {   // (ack times are absolute: device frame times)
      const msg: HostMessage = { kind: "ACK", from: "host", ackedSeq: a.seq, status: "ok" };
      all.push({ t: a.t - this.offset, order: -1, item: { kind: "host", id: this.nextId++, msg } });
    }
    all.sort((a, b) => a.t - b.t || a.order - b.order);
    const byId = new Map<number, { seq: number; payload: number[]; msg: HostMessage }>();
    const delivered: Delivered[] = [];
    const midi: TimedMidi[] = [];
    let seq = 0;
    let cursor = { ms: 0, n: 0 };
    const place = (t: number, ms: Midi[]): number => {
      if (cursor.ms < t) cursor = { ms: t, n: 0 };
      for (const m of ms) {
        midi.push({ t: cursor.ms, midi: m });
        if (++cursor.n === CC_PER_MS) cursor = { ms: cursor.ms + 1, n: 0 };
      }
      return cursor.n === 0 ? cursor.ms - 1 : cursor.ms;
    };
    const toMidi = (payload: number[]): Midi[] =>
      payloadToMidi(payload, "host").map((m) => [m[0] ?? 0, m[1] ?? 0, m[2] ?? 0] as const);
    for (const { t: t0, item } of all) {
      const t = t0 + this.offset;
      if (item.kind === "host") {
        const payload = encode(item.msg, seq);
        byId.set(item.id, { seq, payload, msg: item.msg });
        const at = place(t, toMidi(payload));
        delivered.push({ id: item.id, at, seq, msg: item.msg, label: item.msg.kind, payload });
        seq = (seq + 1) % 128;
      } else if (item.kind === "repeat") {
        const orig = byId.get(item.of);
        if (!orig) throw new Error(`${this.name}: repeat of an unknown or later frame ${item.of}`);
        const at = place(t, toMidi(orig.payload));
        delivered.push({ id: item.id, at, seq: orig.seq, msg: orig.msg, label: `repeat ${orig.msg.kind}`, payload: orig.payload });
      } else {
        const at = place(t, item.midi);
        delivered.push({ id: item.id, at, label: item.label });
      }
    }
    return { delivered, midi };
  }

  /** tests/host.c's script: "T midi ST D1 D2", "T keys MASK", "T shot", ... and the shot names by ms. */
  toHostScript(): { script: string; delivered: Delivered[]; shots: Map<number, string>; leds: Map<number, string> } {
    const { delivered, midi } = this.render();
    const lines: { t: number; order: number; line: string }[] = [];
    midi.forEach((m, i) => lines.push({ t: m.t, order: i, line: `${m.t} midi 0x${m.midi[0].toString(16)} ${m.midi[1]} ${m.midi[2]}` }));
    const shots = new Map<number, string>();
    const leds = new Map<number, string>();
    for (const p of this.panel) {
      const s = p.step;
      let line: string;
      switch (s.kind) {
        case "keys":
          line = `keys 0x${s.mask.toString(16)}`;
          break;
        case "btn":
        case "btndown":
        case "btnup":
          line = `${s.kind} ${s.id}`;
          break;
        case "enc":
          line = `enc ${s.id} ${s.steps}`;
          break;
        case "pot":
          line = `pot ${s.value}`;
          break;
        case "shot":
          if (shots.has(p.t)) throw new Error(`${this.name}: two shots at ${p.t} ms`);
          shots.set(p.t, s.name);
          line = "shot";
          break;
        case "leds":
          leds.set(p.t, s.tag);
          line = "leds";
          break;
      }
      lines.push({ t: p.t, order: 1e9 + p.order, line: `${p.t} ${line}` });   // (host mode: offset 0)
    }
    lines.sort((a, b) => a.t - b.t || a.order - b.order);
    const script = [`# ${this.name}`, ...lines.map((l) => l.line), `${this.endMs} end`, ""].join("\n");
    return { script, delivered, shots, leds };
  }

  /** fm1-live's inputs: FM1_USB_SEND ("MS:HEX;..."), FM1_BENCH_KEYS ("MS:n4", "MS:n4^", "MS:HOME", "MS:e0:+3",
   * "MS:pot:512") and the named shots, all shifted by the offset. */
  toEmu(): { usbSend: string; keys: string; delivered: Delivered[]; shots: [number, string][]; endMs: number } {
    const { delivered, midi } = this.render();
    const hex = (m: Midi): string => m.map((b) => b.toString(16).padStart(2, "0")).join("");
    const usbSend = midi.map((m) => `${m.t}:${hex(m.midi)}`).join(";");
    const keys: string[] = [];
    const shots: [number, string][] = [];
    let mask = 0;
    for (const p of [...this.panel].sort((a, b) => a.t - b.t || a.order - b.order)) {
      const t = p.t + this.offset;
      const s = p.step;
      switch (s.kind) {
        case "keys":
          for (let k = 0; k < 27; k++) {
            const was = (mask >> k) & 1;
            const now = (s.mask >> k) & 1;
            if (was !== now) keys.push(`${t}:n${k}${now ? "" : "^"}`);
          }
          mask = s.mask;
          break;
        case "btn":
          keys.push(`${t}:${EMU_BUTTON[s.id]}`, `${t + 30}:${EMU_BUTTON[s.id]}^`);
          break;
        case "btndown":
          keys.push(`${t}:${EMU_BUTTON[s.id]}`);
          break;
        case "btnup":
          keys.push(`${t}:${EMU_BUTTON[s.id]}^`);
          break;
        case "enc":
          keys.push(`${t}:e${s.id}:${s.steps >= 0 ? "+" : ""}${s.steps}`);
          break;
        case "pot":
          keys.push(`${t}:pot:${s.value}`);
          break;
        case "shot":
          shots.push([t, s.name]);
          break;
        case "leds":
          break;
      }
    }
    return { usbSend, keys: keys.join(","), delivered, shots, endMs: this.endMs + this.offset };
  }
}

/** fm1-emu's button names by HAL id (fm1-soc periph.rs; SCL is button 3, SEL) */
const EMU_BUTTON = ["OCTDN", "OCTUP", "FX", "SCL", "ENV", "LFO", "EDIT", "GLO", "HOME", "SAVE", "ARP", "SEQ", "PLAY", "REC"];

/** The ACKs a live companion sends: one per input frame (KEY, BUTTON, ENCODER, POT), 3 ms after its first sending. A
 * resend (the same SEQ within the 1 s retransmit span) is not a new frame; the same SEQ later is (SEQ wraps at 128). */
export function companionAcks(frames: readonly { t: number; seq: number; msg: { kind: string } }[]): Ack[] {
  const first = new Map<number, number>();
  const acks: Ack[] = [];
  for (const f of frames) {
    if (!["KEY", "BUTTON", "ENCODER", "POT"].includes(f.msg.kind)) continue;
    const t0 = first.get(f.seq);
    if (t0 !== undefined && f.t - t0 < 1000) continue;
    first.set(f.seq, f.t);
    acks.push({ t: f.t + 3, seq: f.seq });
  }
  return acks;
}
/** Two ACK schedules alike. */
export const sameAcks = (a: readonly Ack[], b: readonly Ack[]): boolean =>
  a.length === b.length && a.every((x, i) => x.t === b[i]?.t && x.seq === b[i]?.seq);
