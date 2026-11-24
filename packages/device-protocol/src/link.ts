import { systemClock, type Clock, type Timer } from "./clock";
import { decode, encode, type DecodeError } from "./codec";
import { SEQ_MODULO, TIMING } from "./constants";
import { DedupWindow } from "./dedup";
import type { AckStatus } from "./enums";
import { Emitter } from "./events";
import { FrameAssembler, payloadToMidi, type MidiMessage } from "./framing";
import {
  originOf,
  peerOf,
  requiresAck,
  type Hello,
  type HelloAck,
  type Incoming,
  type Message,
  type Outgoing,
  type Role,
} from "./messages";
import { HOST_VERSIONS, negotiate, type VersionRange } from "./negotiate";
import { PacedQueue } from "./rate";
import type { MidiTransport } from "./transport";

export interface LinkTiming {
  retransmitMs: number;
  maxRetransmits: number;
  heartbeatMs: number;
  helloMs: number;
  peerTimeoutMs: number;
}

export interface DeviceIdentity {
  versions: VersionRange;
  fw: { major: number; minor: number; patch: number };
  /** u14, random per boot. */
  bootId: number;
}

interface CommonOptions {
  transport: MidiTransport;
  clock?: Clock;
  timing?: Partial<LinkTiming>;
  /** Outgoing frame budget; defaults to 200/s for the host and unlimited for the device. */
  maxFramesPerSecond?: number;
}

export interface HostLinkOptions extends CommonOptions {
  versions?: VersionRange;
  /** u14 identifier of this companion run; random by default. */
  hostSession?: number;
}

export interface DeviceLinkOptions extends CommonOptions {
  identity: DeviceIdentity;
}

export type SendOutcome =
  | { outcome: "acked"; status: AckStatus }
  | { outcome: "fault" }
  /** Dropped without a verdict: link closed, peer lost or peer restarted. */
  | { outcome: "cancelled" }
  /** The frame type is never acknowledged (ACK, HEARTBEAT, HELLO). */
  | { outcome: "sent" };

export interface LinkEvents<R extends Role> {
  message: { seq: number; message: Incoming<R> };
  acked: { seq: number; status: AckStatus };
  fault: { seq: number; message: Outgoing<R> };
  "peer-alive": undefined;
  "peer-lost": undefined;
  /** Host: `hello` is the device's HELLO. Device: `hostSession` is from HELLO_ACK. */
  negotiated: { proto: number; hello?: Hello; hostSession?: number };
  incompatible: { reason: string; hello?: Hello };
  "rx-error": DecodeError;
}

interface PendingFrame {
  payload: number[];
  message: Message;
  transmissions: number;
  timer?: Timer;
  resolve?: (o: SendOutcome) => void;
}

/**
 * One end of the FM1C link: sequencing, ACK/retransmit, duplicate guard, heartbeat,
 * liveness and version negotiation (docs/protocol.md section 3).
 */
export class Link<R extends Role> extends Emitter<LinkEvents<R>> {
  private readonly peer: Role;
  private readonly clock: Clock;
  private readonly timing: LinkTiming;
  private readonly assembler: FrameAssembler;
  private readonly window = new DedupWindow();
  private readonly queue: PacedQueue;
  private readonly pending = new Map<number, PendingFrame>();
  private readonly loops: Timer[] = [];
  private nextSeq = 0;
  private alive = false;
  private liveness: Timer | undefined;
  private proto: number | undefined;
  private startedAt = 0;
  private errors = 0;
  private unsubscribe: (() => void) | undefined;

  private constructor(
    readonly role: R,
    private readonly transport: MidiTransport,
    options: CommonOptions,
    private readonly host?: { versions: VersionRange; hostSession: number },
    private readonly identity?: DeviceIdentity,
  ) {
    super();
    this.peer = peerOf(role);
    this.clock = options.clock ?? systemClock;
    this.timing = { ...TIMING, ...options.timing };
    this.assembler = new FrameAssembler(this.peer);
    const rate = options.maxFramesPerSecond ?? (role === "host" ? TIMING.hostMaxFramesPerSecond : Infinity);
    this.queue = new PacedQueue(this.clock, rate);
  }

  static host(options: HostLinkOptions): Link<"host"> {
    const hostSession = options.hostSession ?? Math.floor(Math.random() * 0x4000);
    return new Link("host", options.transport, options, {
      versions: options.versions ?? HOST_VERSIONS,
      hostSession,
    });
  }

  static device(options: DeviceLinkOptions): Link<"device"> {
    return new Link("device", options.transport, options, undefined, options.identity);
  }

  get peerAlive(): boolean {
    return this.alive;
  }

  /** Negotiated protocol version, undefined until HELLO/HELLO_ACK completes. */
  get negotiatedProto(): number | undefined {
    return this.proto;
  }

  /** Invalid frames received (saturates at 127, as reported in the device heartbeat). */
  get rxErrors(): number {
    return Math.min(this.errors, 127);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.startedAt = this.clock.now();
    this.unsubscribe = this.transport.onMessage((m) => this.onMidi(m));
    this.every(this.timing.heartbeatMs, () => this.sendHeartbeat());
    if (this.role === "device") {
      this.sendHelloIfNeeded();
      this.every(this.timing.helloMs, () => this.sendHelloIfNeeded());
    }
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const t of this.loops.splice(0)) t.cancel();
    this.liveness?.cancel();
    this.liveness = undefined;
    this.queue.clear();
    this.cancelPending();
    // A restarted link must negotiate again and must not inherit liveness or dedup state.
    this.alive = false;
    this.proto = undefined;
    this.window.clear();
  }

  /**
   * Sends a message and returns its SEQ. Watch `acked`/`fault`, or use `sendAndWait`.
   * Returns undefined when the host drops the frame because no version is negotiated.
   */
  send(msg: Outgoing<R>): number | undefined {
    this.check(msg);
    return this.silenced(msg) ? undefined : this.sendInternal(msg);
  }

  sendAndWait(msg: Outgoing<R>): Promise<SendOutcome> {
    this.check(msg);
    if (this.silenced(msg)) return Promise.resolve({ outcome: "cancelled" });
    return new Promise((resolve) => {
      this.sendInternal(msg, resolve);
      if (!requiresAckTracked(msg)) resolve({ outcome: "sent" });
    });
  }

  private check(msg: Message): void {
    if (originOf(msg) !== this.role) throw new TypeError(`${msg.kind} is not sent by the ${this.role}`);
    if (!this.unsubscribe) throw new Error("link is not started");
  }

  /**
   * Until HELLO/HELLO_ACK completes the host sends nothing but ACK and HELLO_ACK. A
   * device still bound to a previous host run only re-sends HELLO after 3500 ms
   * without host frames, so any other host traffic would keep it from ever doing so.
   */
  private silenced(msg: Message): boolean {
    return this.role === "host" && this.proto === undefined && msg.kind !== "ACK" && msg.kind !== "HELLO_ACK";
  }

  private sendInternal(msg: Message, resolve?: (o: SendOutcome) => void): number {
    this.check(msg);
    const seq = this.nextSeq;
    const payload = encode(msg, seq);
    this.nextSeq = (seq + 1) % SEQ_MODULO;
    if (requiresAckTracked(msg)) {
      const stale = this.pending.get(seq);
      if (stale) this.settle(seq, stale, { outcome: "fault" });
      this.pending.set(seq, { payload, message: msg, transmissions: 0, resolve });
    }
    this.transmit(seq, payload, msg.kind === "ACK");
    return seq;
  }

  private transmit(seq: number, payload: number[], urgent = false): void {
    this.queue.run(() => {
      if (!this.unsubscribe) return;
      for (const m of payloadToMidi(payload, this.role)) this.transport.send(m);
      const p = this.pending.get(seq);
      if (p && p.payload === payload) this.arm(seq, p);
    }, urgent);
  }

  private arm(seq: number, p: PendingFrame): void {
    p.transmissions++;
    p.timer?.cancel();
    p.timer = this.clock.schedule(this.timing.retransmitMs, () => {
      if (this.pending.get(seq) !== p) return;
      if (p.transmissions <= this.timing.maxRetransmits) this.transmit(seq, p.payload);
      else this.settle(seq, p, { outcome: "fault" });
    });
  }

  private settle(seq: number, p: PendingFrame, outcome: SendOutcome): void {
    p.timer?.cancel();
    this.pending.delete(seq);
    if (outcome.outcome === "fault") this.emit("fault", { seq, message: p.message as Outgoing<R> });
    if (outcome.outcome === "acked") this.emit("acked", { seq, status: outcome.status });
    p.resolve?.(outcome);
  }

  private cancelPending(): void {
    for (const [seq, p] of [...this.pending]) this.settle(seq, p, { outcome: "cancelled" });
  }

  private onMidi(m: MidiMessage): void {
    const overflowed = this.assembler.stats.overflowed;
    const payload = this.assembler.push(m);
    if (this.assembler.stats.overflowed !== overflowed) {
      this.errors++;
      this.emit("rx-error", { code: "bad_length", detail: "frame longer than 104 bytes" });
    }
    if (payload) this.onPayload(payload);
  }

  /** Host before negotiation: valid device frames other than HELLO and ACK get no reply. */
  private unbound(kind: string | undefined): boolean {
    return this.role === "host" && this.proto === undefined && kind !== "HELLO" && kind !== "ACK";
  }

  private onPayload(payload: number[]): void {
    const res = decode(payload, this.peer);
    if (!res.ok) {
      this.errors++;
      const { frame } = res.error;
      if (frame) {
        this.markAlive();
        if (this.unbound(undefined)) {
          this.emit("rx-error", res.error);
          return;
        }
        const status: AckStatus = res.error.code === "unknown_type" ? "unknown_type" : "bad_body";
        const prior = this.window.lookup(frame.seq, frame.checksum);
        if (!prior) this.window.record(frame.seq, frame.checksum, status);
        this.sendAck(frame.seq, prior ?? status);
      }
      this.emit("rx-error", res.error);
      return;
    }
    const { seq, checksum, message } = res.value;
    this.markAlive();
    if (this.unbound(message.kind)) return;
    if (message.kind === "ACK") {
      this.window.record(seq, checksum, "ok");
      const p = this.pending.get(message.ackedSeq);
      if (p) this.settle(message.ackedSeq, p, { outcome: "acked", status: message.status });
      return;
    }
    if (message.kind === "HEARTBEAT") {
      this.window.record(seq, checksum, "ok");
      this.emit("message", { seq, message: message as Incoming<R> });
      return;
    }
    const prior = this.window.lookup(seq, checksum);
    if (prior) {
      this.sendAck(seq, prior);
      return;
    }
    // A fresh HELLO/HELLO_ACK means the peer (re)started and its SEQ restarted too.
    if (message.kind === "HELLO" || message.kind === "HELLO_ACK") this.window.clear();
    this.window.record(seq, checksum, "ok");
    this.sendAck(seq, "ok");
    if (message.kind === "HELLO") this.onHello(message);
    if (message.kind === "HELLO_ACK") this.onHelloAck(message);
    this.emit("message", { seq, message: message as Incoming<R> });
  }

  private onHello(hello: Hello): void {
    if (!this.host) return;
    this.cancelPending();
    const { proto, reason } = negotiate({ min: hello.protoMin, max: hello.protoMax }, this.host.versions);
    this.sendInternal({ kind: "HELLO_ACK", proto, hostSession: this.host.hostSession, reason });
    this.proto = proto > 0 ? proto : undefined;
    if (proto > 0) this.emit("negotiated", { proto, hello });
    else this.emit("incompatible", { reason, hello });
  }

  private onHelloAck(ack: HelloAck): void {
    if (!this.identity) return;
    const { min, max } = this.identity.versions;
    if (ack.proto > 0 && ack.proto >= min && ack.proto <= max) {
      this.proto = ack.proto;
      this.emit("negotiated", { proto: ack.proto, hostSession: ack.hostSession });
    } else {
      this.proto = undefined;
      this.emit("incompatible", { reason: ack.reason || `host chose proto ${ack.proto}` });
    }
  }

  private markAlive(): void {
    this.liveness?.cancel();
    this.liveness = this.clock.schedule(this.timing.peerTimeoutMs, () => this.onPeerLost());
    if (this.alive) return;
    this.alive = true;
    this.emit("peer-alive", undefined);
  }

  private onPeerLost(): void {
    this.liveness = undefined;
    this.alive = false;
    this.proto = undefined;
    this.cancelPending();
    this.emit("peer-lost", undefined);
  }

  private sendAck(ackedSeq: number, status: AckStatus): void {
    this.sendInternal({ kind: "ACK", from: this.role, ackedSeq, status } as Message);
  }

  private sendHeartbeat(): void {
    if (this.role === "host" && this.proto === undefined) return;
    const uptime = Math.floor((this.clock.now() - this.startedAt) / 1000) % 0x4000;
    this.sendInternal(
      this.role === "device"
        ? { kind: "HEARTBEAT", from: "device", uptimeS: uptime, rxErrors: this.rxErrors }
        : { kind: "HEARTBEAT", from: "host", hostUptimeS: uptime },
    );
  }

  private sendHelloIfNeeded(): void {
    if (!this.identity || this.proto !== undefined) return;
    const { versions, fw, bootId } = this.identity;
    this.sendInternal({
      kind: "HELLO",
      protoMin: versions.min,
      protoMax: versions.max,
      fwMajor: fw.major,
      fwMinor: fw.minor,
      fwPatch: fw.patch,
      bootId,
    });
  }

  private every(ms: number, fn: () => void): void {
    const index = this.loops.length;
    const tick = (): void => {
      this.loops[index] = this.clock.schedule(ms, tick);
      fn();
    };
    this.loops.push(this.clock.schedule(ms, tick));
  }
}

/** HELLO repeats every second until answered, so it is not retransmitted or faulted. */
const requiresAckTracked = (msg: Message): boolean => requiresAck(msg) && msg.kind !== "HELLO";
