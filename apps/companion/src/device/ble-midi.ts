// BT direct: the companion's MIDI transport over our own CoreBluetooth helper (native/fm1-ble-midi), with no
// CoreMIDI Bluetooth port. The helper is a plain GATT pipe; packet coding (ble-midi-codec.ts) and flow control
// live here. Line protocol: see the header of native/fm1-ble-midi/main.swift.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertSafeMidi, systemClock, type Clock, type MidiMessage, type MidiTransport, type Timer } from "@fm1/device-protocol";
import { BleMidiDecoder, encodePackets, MIN_BLE_PAYLOAD, type EncodeOptions } from "./ble-midi-codec";
import type { PortWatcherTarget } from "./port-watcher";

export const BLE_MIDI_BUILD_HINT = "build it with: bash apps/companion/scripts/build-native.sh";
export const RESTART_MS = 2000;
/** `tx` lines in flight before the helper's `ack`s; more wait here, in order. */
export const TX_WINDOW = 4;
/** Longest stdout line accepted (a 512-byte value is 1,027 characters). */
export const MAX_LINE = 16384;
/** Exit codes after which a restart cannot help: usage, Bluetooth permission denied. */
const FATAL_EXITS = new Set([2, 3]);

export function bleMidiPath(): string {
  return process.env.FM1_BLE_MIDI_BIN ?? fileURLToPath(new URL("../../bin/fm1-ble-midi", import.meta.url));
}

// ------------------------------------------------------------------------------------------- line protocol

export type HelperLine =
  | { kind: "rx"; data: number[] }
  | { kind: "ack" }
  | { kind: "state"; state: "ready"; mtu: number; write: "without" | "with" }
  | { kind: "state"; state: "scanning" | "connecting" | "connected" | "disconnected" | "waiting"; detail: string }
  | { kind: "log"; level: "info" | "warn"; text: string }
  | { kind: "bad"; line: string };

export function toHex(bytes: readonly number[]): string {
  return bytes.map((b) => (b & 0xff).toString(16).padStart(2, "0")).join("");
}

export function fromHex(s: string): number[] | null {
  if (s.length === 0 || s.length % 2 || !/^[0-9a-fA-F]+$/.test(s)) return null;
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
  return out;
}

export function parseHelperLine(line: string): HelperLine {
  const sp = line.indexOf(" ");
  const word = sp < 0 ? line : line.slice(0, sp);
  const rest = sp < 0 ? "" : line.slice(sp + 1);
  switch (word) {
    case "ack":
      return rest ? { kind: "bad", line } : { kind: "ack" };
    case "rx": {
      const data = fromHex(rest);
      return data ? { kind: "rx", data } : { kind: "bad", line };
    }
    case "log":
      return { kind: "log", level: "info", text: rest };
    case "error":
      return { kind: "log", level: "warn", text: rest };
    case "state": {
      const s2 = rest.indexOf(" ");
      const state = s2 < 0 ? rest : rest.slice(0, s2);
      const detail = s2 < 0 ? "" : rest.slice(s2 + 1);
      if (state === "ready") {
        const m = /^mtu=(\d+) write=(without|with)$/.exec(detail);
        if (!m) return { kind: "bad", line };
        return { kind: "state", state: "ready", mtu: Number(m[1]), write: m[2] as "without" | "with" };
      }
      if (state === "scanning" || state === "connecting" || state === "connected" || state === "disconnected" || state === "waiting") {
        return { kind: "state", state, detail };
      }
      return { kind: "bad", line };
    }
    default:
      return { kind: "bad", line };
  }
}

/** Splits a stream of text chunks into lines; a line longer than `max` is dropped whole (and reported). */
export class LineSplitter {
  private buf = "";
  private skipping = false;
  overlong = 0;

  constructor(private readonly max = MAX_LINE) {}

  push(chunk: string): string[] {
    const out: string[] = [];
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "").trim();
      this.buf = this.buf.slice(i + 1);
      if (this.skipping) this.skipping = false;
      else if (line) out.push(line);
    }
    if (this.buf.length > this.max) {
      this.buf = "";
      if (!this.skipping) this.overlong++;
      this.skipping = true;
    }
    return out;
  }
}

// ------------------------------------------------------------------------------------------- transport

/** One BLE-MIDI connection as the device host sees it. Created on `ready`, closed on disconnect. */
export class BleMidiTransport implements MidiTransport {
  private listeners = new Set<(msg: MidiMessage) => void>();
  private closed = false;
  private outbox: number[][] = [];
  private queue: number[][] = [];
  private inFlight = 0;
  private flushScheduled = false;
  readonly decoder = new BleMidiDecoder();
  packetsSent = 0;

  constructor(
    readonly mtu: number,
    private readonly writeLine: (line: string) => void,
    private readonly opts: { now?: () => number; window?: number; encode?: EncodeOptions } = {},
  ) {}

  /** Packets encoded but not yet written to the helper (waiting for credit). */
  get queued(): number {
    return this.queue.length;
  }

  get inFlightCount(): number {
    return this.inFlight;
  }

  send(bytes: number[]): void {
    assertSafeMidi(bytes);
    if (this.closed) throw new Error("transport closed");
    this.outbox.push([...bytes]);
    // Messages sent in the same tick share packets (one FM1C frame is a burst of CCs).
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  /** Encodes everything sent so far into packets and writes as many as the window allows. */
  flush(): void {
    this.flushScheduled = false;
    if (this.closed || !this.outbox.length) return;
    const msgs = this.outbox;
    this.outbox = [];
    this.queue.push(...encodePackets(msgs, Math.max(MIN_BLE_PAYLOAD, this.mtu), (this.opts.now ?? Date.now)(), this.opts.encode));
    this.pump();
  }

  /** The helper took one `tx` line. */
  ack(): void {
    if (this.inFlight > 0) this.inFlight--;
    this.pump();
  }

  /** One notification value from the device. */
  receive(packet: readonly number[]): void {
    if (this.closed) return;
    for (const m of this.decoder.decode(packet)) {
      // As openCoreMidi's input.ignoreTypes(sysex, timing, active sensing): the protocol uses CCs only.
      const s = m.bytes[0]!;
      if (s === 0xf0 || s === 0xf1 || s === 0xf8 || s === 0xfe) continue;
      for (const cb of [...this.listeners]) cb(m.bytes);
    }
  }

  private pump(): void {
    const window = this.opts.window ?? TX_WINDOW;
    while (!this.closed && this.queue.length && this.inFlight < window) {
      const p = this.queue.shift()!;
      this.inFlight++;
      this.packetsSent++;
      this.writeLine(`tx ${toHex(p)}\n`);
    }
  }

  onMessage(cb: (msg: MidiMessage) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
    this.outbox = [];
    this.queue = [];
    this.inFlight = 0;
  }
}

// ------------------------------------------------------------------------------------------- helper process

export interface HelperProc {
  write(text: string): void;
  kill(): void;
  exited: Promise<number>;
}

/** Starts the helper; stdout text goes to `onStdout` in chunks, stderr text to `onStderr`. */
export type HelperSpawner = (bin: string, device: string, onStdout: (chunk: string) => void, onStderr: (chunk: string) => void) => HelperProc;

async function pumpText(stream: ReadableStream<Uint8Array>, sink: (chunk: string) => void): Promise<void> {
  const reader = stream.getReader();
  const text = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    sink(text.decode(value, { stream: true }));
  }
}

export const bunSpawner: HelperSpawner = (bin, device, onStdout, onStderr) => {
  const proc = Bun.spawn([bin, device], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  void pumpText(proc.stdout, onStdout).catch(() => {});
  void pumpText(proc.stderr, onStderr).catch(() => {});
  return {
    write(text) {
      try {
        proc.stdin.write(text);
        void proc.stdin.flush();
      } catch {
        // The helper has exited; its exit restarts it.
      }
    },
    kill: () => proc.kill(),
    exited: proc.exited,
  };
};

export type LinkState = "stopped" | "starting" | "scanning" | "connecting" | "connected" | "ready" | "disconnected" | "waiting" | "failed";

export interface BleMidiLinkOptions {
  bin?: string;
  spawn?: HelperSpawner;
  clock?: Clock;
  restartMs?: number;
  log?: (level: "info" | "warn", text: string) => void;
  window?: number;
  encode?: EncodeOptions;
}

/**
 * Keeps one helper running for `device` (restarted 2 s after it exits, unless the exit says it cannot work),
 * attaches a BleMidiTransport to `target` on `state ready` and detaches it on disconnect or helper exit, so the
 * device host's link and heartbeat logic sees an ordinary transport come and go.
 */
export class BleMidiLink {
  private proc: HelperProc | null = null;
  private transport: BleMidiTransport | null = null;
  private timer: Timer | null = null;
  private running = false;
  private st: LinkState = "stopped";
  private splitter = new LineSplitter();
  readonly history: string[] = [];
  starts = 0;
  badLines = 0;

  constructor(
    readonly device: string,
    private readonly target: PortWatcherTarget,
    private readonly opts: BleMidiLinkOptions = {},
  ) {}

  get state(): LinkState {
    return this.st;
  }

  get attached(): boolean {
    return this.transport !== null;
  }

  get bin(): string {
    return this.opts.bin ?? bleMidiPath();
  }

  /** False when the helper binary is missing (nothing is started). */
  start(): boolean {
    if (this.running) return true;
    if (!this.opts.spawn && !existsSync(this.bin)) {
      this.log("warn", `fm1-ble-midi missing (${this.bin}); ${BLE_MIDI_BUILD_HINT}`);
      this.st = "failed";
      return false;
    }
    this.running = true;
    this.run();
    return true;
  }

  stop(): void {
    this.running = false;
    this.timer?.cancel();
    this.timer = null;
    this.release("stopped");
    this.proc?.kill();
    this.proc = null;
    this.st = "stopped";
  }

  private get clock(): Clock {
    return this.opts.clock ?? systemClock;
  }

  private log(level: "info" | "warn", text: string): void {
    this.history.push(text);
    this.opts.log?.(level, `ble direct: ${text}`);
  }

  private run(): void {
    if (!this.running) return;
    this.starts++;
    this.st = "starting";
    this.splitter = new LineSplitter();
    const errSplit = new LineSplitter();
    const spawn = this.opts.spawn ?? bunSpawner;
    let proc: HelperProc;
    try {
      proc = spawn(
        this.bin,
        this.device,
        (chunk) => {
          if (this.proc === proc) for (const line of this.splitter.push(chunk)) this.onLine(line);
        },
        (chunk) => {
          for (const line of errSplit.push(chunk)) this.log("warn", `helper: ${line}`);
        },
      );
    } catch (e) {
      this.log("warn", `fm1-ble-midi failed to start: ${e instanceof Error ? e.message : String(e)}`);
      this.timer = this.clock.schedule(this.opts.restartMs ?? RESTART_MS, () => this.run());
      return;
    }
    this.proc = proc;
    void proc.exited.then((code) => this.onExit(proc, code));
  }

  private onExit(proc: HelperProc, code: number): void {
    if (this.proc !== proc) return;
    this.proc = null;
    this.release(`helper exited ${code}`);
    if (!this.running) return;
    if (FATAL_EXITS.has(code)) {
      this.st = "failed";
      this.log("warn", `fm1-ble-midi exited ${code}${code === 3 ? " (Bluetooth permission denied)" : ""}; not restarting`);
      return;
    }
    this.st = "disconnected";
    this.log("warn", `fm1-ble-midi exited ${code}; restarting in ${(this.opts.restartMs ?? RESTART_MS) / 1000} s`);
    this.timer = this.clock.schedule(this.opts.restartMs ?? RESTART_MS, () => {
      this.timer = null;
      this.run();
    });
  }

  /** Feeds one stdout line (exposed for tests). */
  onLine(line: string): void {
    const msg = parseHelperLine(line);
    switch (msg.kind) {
      case "rx":
        this.transport?.receive(msg.data);
        return;
      case "ack":
        this.transport?.ack();
        return;
      case "log":
        this.log(msg.level, msg.text);
        return;
      case "bad":
        this.badLines++;
        this.log("warn", `unreadable helper line (${line.length} chars)`);
        return;
      case "state":
        if (msg.state === "ready") {
          this.st = "ready";
          this.log("info", `ready (mtu ${msg.mtu}, write ${msg.write} response)`);
          this.attach(msg.mtu);
        } else {
          this.st = msg.state;
          this.log("info", msg.detail ? `${msg.state} (${msg.detail})` : msg.state);
          if (msg.state === "disconnected" || msg.state === "waiting") this.release(msg.state);
        }
    }
  }

  private attach(mtu: number): void {
    this.release("re-ready");
    const proc = this.proc;
    if (!proc) return;
    const t = new BleMidiTransport(mtu, (text) => proc.write(text), { now: () => this.clock.now(), window: this.opts.window, encode: this.opts.encode });
    this.transport = t;
    this.target.attach(t, `bluetooth direct "${this.device}"`);
  }

  private release(why: string): void {
    const t = this.transport;
    if (!t) return;
    this.transport = null;
    this.target.detach();
    t.close();
    this.log("info", `detached (${why})`);
  }
}
