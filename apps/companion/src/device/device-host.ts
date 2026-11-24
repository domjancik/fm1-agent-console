// Host end of the FM1C link: renders DeviceView as SET_* frames and turns device frames into controller input.
import type { DeviceInput, DeviceView } from "@fm1/agent-core";
import {
  Link,
  NO_REQ_SEQ,
  SlotCoalescer,
  systemClock,
  type Clock,
  type CommandResultCode,
  type Hello,
  type HostMessage,
  type LinkTiming,
  type MidiTransport,
  type SetSlot,
} from "@fm1/device-protocol";
import { describeInput, toDeviceInput } from "./inputs";
import { diffFrames, framesFor, fullFrames } from "./render";

const FAULT_RESYNC_GAP_MS = 2000;
/** HELLOs from one boot that arrive closer together than this are one handshake. On attach the
 * real FM-1 delivers its queued HELLOs as a burst (about 25 in 12 ms, 2026-11-18). */
const HELLO_BURST_MS = 500;

export type DevicePhase = "detached" | "waiting" | "connected" | "lost" | "incompatible";

export interface DeviceStatus {
  phase: DevicePhase;
  transport: string | null;
  proto: number | null;
  firmware: string | null;
  rxErrors: number;
  resyncs: number;
  reason: string | null;
}

/** Handles one device input; `reqSeq` is the SEQ of the device frame that carried it. */
export type InputHandler = (input: DeviceInput, reqSeq: number) => Promise<void>;

export interface DeviceHostOptions {
  clock?: Clock;
  timing?: Partial<LinkTiming>;
  maxFramesPerSecond?: number;
  hostSession?: number;
  log?: (level: "info" | "warn", text: string) => void;
}

export class DeviceHost {
  private link: Link<"host"> | null = null;
  private offs: (() => void)[] = [];
  private view: DeviceView | null = null;
  private sent: DeviceView | null = null;
  private queue: Promise<void> = Promise.resolve();
  private lastFaultResync = -Infinity;
  private lastHello: { bootId: number; at: number } | null = null;
  private burstResync = false;
  private readonly coalescer: SlotCoalescer;
  private readonly clock: Clock;
  private readonly hostSession: number;
  private listeners = new Set<(s: DeviceStatus) => void>();
  private st: DeviceStatus = { phase: "detached", transport: null, proto: null, firmware: null, rxErrors: 0, resyncs: 0, reason: null };

  constructor(
    private readonly onInput: InputHandler,
    private readonly opts: DeviceHostOptions = {},
  ) {
    this.clock = opts.clock ?? systemClock;
    // One host_session per companion run: a replugged device keeps its screen and then gets a resync.
    this.hostSession = opts.hostSession ?? Math.floor(Math.random() * 0x4000);
    // A newly selected slot goes before the deselect of the old one: the device never draws "nothing selected"
    // between the two frames (the LIST layout derives its window of 10 from the selected slot; docs/ui-v3.md 8.3).
    this.coalescer = new SlotCoalescer(this.clock, (slots) => {
      for (const s of [...slots.filter((x) => x.flags.selected), ...slots.filter((x) => !x.flags.selected)]) this.link?.send(s);
    });
  }

  get status(): DeviceStatus {
    return this.st;
  }

  get connected(): boolean {
    return this.st.phase === "connected";
  }

  onStatus(fn: (s: DeviceStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Binds a transport (one physical or virtual connection). Any previous one is detached first. */
  attach(transport: MidiTransport, name: string): void {
    this.detach();
    const link = Link.host({
      transport,
      clock: this.clock,
      timing: this.opts.timing,
      hostSession: this.hostSession,
      maxFramesPerSecond: this.opts.maxFramesPerSecond,
    });
    this.link = link;
    this.offs = [
      link.on("negotiated", ({ proto, hello }) => this.onNegotiated(proto, hello)),
      link.on("incompatible", ({ reason }) => this.patch({ phase: "incompatible", proto: null, reason })),
      link.on("peer-lost", () => {
        this.sent = null;
        this.coalescer.cancel();
        this.patch({ phase: "lost", proto: null, reason: "no device frame for 3.5 s" });
      }),
      link.on("fault", ({ message }) => this.onFault(message.kind)),
      link.on("rx-error", (e) => this.patch({ rxErrors: link.rxErrors, reason: `rx ${e.code}` })),
      link.on("message", ({ seq, message }) => {
        const input = toDeviceInput(message);
        if (input) this.enqueue(input, seq);
      }),
    ];
    this.patch({ phase: "waiting", transport: name, proto: null, reason: null });
    link.start();
  }

  /** Drops the link (unplug). The transport itself belongs to the caller. */
  detach(): void {
    for (const off of this.offs.splice(0)) off();
    this.coalescer.cancel();
    this.link?.close();
    this.link = null;
    this.sent = null;
    if (this.st.phase !== "detached") this.patch({ phase: "detached", proto: null });
  }

  /** Latest view from the console; only the changes go out while a version is agreed. */
  render(view: DeviceView): void {
    this.view = view;
    const link = this.link;
    if (!link || !this.connected) return;
    if (!this.sent) return this.resync();
    const { frames, slots } = diffFrames(this.sent, view);
    this.sent = view;
    for (const f of framesFor(this.st.proto, frames)) link.send(f);
    // (slots too: a version 1-4 device never gets the version 5 row fields). One diff's slots leave together, so a
    // selection move (deselect + select) is never split across two flushes.
    this.coalescer.pushAll(framesFor(this.st.proto, slots).filter((s): s is SetSlot => s.kind === "SET_SLOT"));
  }

  /** Full replay of every element (after HELLO_ACK, or after a link fault). */
  resync(): void {
    const link = this.link;
    const view = this.view;
    if (!link || !this.connected || !view) return;
    this.coalescer.cancel();
    this.sent = view;
    for (const f of framesFor(this.st.proto, fullFrames(view))) link.send(f);
    this.patch({ resyncs: this.st.resyncs + 1 });
  }

  /** COMMAND_RESULT toast for the frame `reqSeq` (or NO_REQ_SEQ for UI-originated actions). */
  sendResult(reqSeq: number, result: CommandResultCode, text: string): void {
    if (!this.connected) return;
    this.send({ kind: "COMMAND_RESULT", reqSeq: reqSeq === NO_REQ_SEQ ? NO_REQ_SEQ : reqSeq & 0x7f, result, text });
  }

  /** Resolves once every queued device input has been handled. */
  idle(): Promise<void> {
    return this.queue;
  }

  private send(msg: HostMessage): void {
    this.link?.send(msg);
  }

  private enqueue(input: DeviceInput, seq: number): void {
    // Inputs are handled strictly in arrival order; a failing handler never blocks the next one.
    this.queue = this.queue
      .then(() => this.onInput(input, seq))
      .catch((e: unknown) => this.opts.log?.("warn", `input ${describeInput(input)} failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  private onNegotiated(proto: number, hello: Hello | undefined): void {
    const now = this.clock.now();
    const burst = hello !== undefined && this.connected && this.lastHello?.bootId === hello.bootId && now - this.lastHello.at < HELLO_BURST_MS;
    if (hello) this.lastHello = { bootId: hello.bootId, at: now };
    if (burst) {
      // Each repeated HELLO cancels the link's pending retransmits, so replay once after the burst.
      if (!this.burstResync) {
        this.burstResync = true;
        this.clock.schedule(HELLO_BURST_MS, () => {
          this.burstResync = false;
          this.resync();
        });
      }
      return;
    }
    const firmware = hello ? `${hello.fwMajor}.${hello.fwMinor}.${hello.fwPatch}` : null;
    this.patch({ phase: "connected", proto, firmware, reason: null });
    this.opts.log?.("info", `device negotiated proto ${proto}${firmware ? ` fw ${firmware}` : ""}`);
    this.resync();
  }

  private onFault(kind: string): void {
    this.opts.log?.("warn", `${kind} unacknowledged after retransmits; resyncing`);
    // The device may have missed a state frame; a full replay is idempotent. One replay per burst of
    // faults, so a silent device does not get flooded before peer-lost.
    const now = this.clock.now();
    if (!this.connected || now - this.lastFaultResync < FAULT_RESYNC_GAP_MS) return;
    this.lastFaultResync = now;
    this.resync();
  }

  private patch(p: Partial<DeviceStatus>): void {
    this.st = { ...this.st, ...p };
    for (const fn of this.listeners) fn(this.st);
  }
}
