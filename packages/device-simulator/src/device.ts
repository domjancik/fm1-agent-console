import {
  Link,
  systemClock,
  type ButtonId,
  type Clock,
  type DeviceIdentity,
  type DeviceMessage,
  type EncoderId,
  type HostMessage,
  type LinkTiming,
  type MidiTransport,
} from "@fm1/device-protocol";
import { Emitter } from "./emitter";
import { logEntry, TappedTransport } from "./frame-log";
import { GestureTracker } from "./gestures";
import { applyHostMessage, initialState, KEY_COUNT, KNOB_ROW_MS, type DeviceState } from "./state";
import { MAX_TURN, type LogEntry } from "./wire";

export const SIM_FIRMWARE = { major: 0, minor: 1, patch: 0 } as const;
/**
 * The simulator speaks what the firmware speaks: protocol versions 1-5 (4: UI v3, docs/ui-v3.md section 5; 5: the
 * LIST layout, section 8).
 */
export const SIM_VERSIONS = { min: 1, max: 5 } as const;
/**
 * Protocol version 6 (SPLIT keys and SETTINGS, docs/ui-v3.md section 10): the simulator draws it when created with these
 * versions (`identity.versions`). The default stays 5, matching the flashed firmware, until the firmware reaches 6.
 */
export const SIM_VERSIONS_V6 = { min: 1, max: 6 } as const;
/** Protocol version 7 (Markdown highlights in SET_TEXT rows, docs/ui-v3.md section 13), for the parity tests. */
export const SIM_VERSIONS_V7 = { min: 1, max: 7 } as const;
/** POT reports are suppressed for changes smaller than this, like ADC hysteresis on the device. */
export const POT_HYSTERESIS = 4;

export interface SimDeviceOptions {
  transport: MidiTransport;
  clock?: Clock;
  identity?: Partial<DeviceIdentity>;
  timing?: Partial<LinkTiming>;
}

export interface SimDeviceEvents {
  state: DeviceState;
  frame: LogEntry;
  /** A host frame that was applied (duplicates and invalid frames never get here). */
  applied: HostMessage;
  /** An input frame handed to the link. */
  input: DeviceMessage;
}

/**
 * The device side of docs/protocol.md, with no business logic: it reports inputs as facts
 * and renders whatever state the host sends, exactly as the firmware does.
 */
export class SimDevice extends Emitter<SimDeviceEvents> {
  readonly clock: Clock;
  private readonly link: Link<"device">;
  private readonly transport: TappedTransport;
  private readonly gestures: GestureTracker;
  private readonly unsubs: (() => void)[] = [];
  private st: DeviceState = initialState();
  private bootAt = 0;
  private lastPotSent: number | undefined;
  private started = false;
  /** stop() closes the transport, so a stopped device cannot be started again. */
  private stopped = false;

  constructor(options: SimDeviceOptions) {
    super();
    this.clock = options.clock ?? systemClock;
    this.transport = new TappedTransport(options.transport, (dir, payload) =>
      this.emit("frame", logEntry(dir, payload, this.nowMs)),
    );
    const identity: DeviceIdentity = {
      versions: { ...SIM_VERSIONS },
      fw: { ...SIM_FIRMWARE },
      bootId: Math.floor(Math.random() * 0x4000),
      ...options.identity,
    };
    this.link = Link.device({ transport: this.transport, clock: this.clock, identity, timing: options.timing });
    this.st = initialState(identity.versions.max);
    this.gestures = new GestureTracker(this.clock, (key, gesture) => this.sendInput({ kind: "KEY", key, gesture }));
  }

  get state(): DeviceState {
    return this.st;
  }

  /** Device uptime in ms (the time base for LED patterns and the frame log). */
  get nowMs(): number {
    return this.clock.now() - this.bootAt;
  }

  get rxErrors(): number {
    return this.link.rxErrors;
  }

  start(): void {
    if (this.stopped) throw new Error("device was stopped; create a new SimDevice");
    if (this.started) return;
    this.started = true;
    this.bootAt = this.clock.now();
    const l = this.link;
    this.unsubs.push(
      l.on("message", ({ message }) => this.onHostMessage(message)),
      l.on("negotiated", ({ proto, hostSession }) =>
        this.patchLink({ phase: "connected", linkError: false, incompatible: "", proto, hostSession: hostSession ?? 0 }),
      ),
      l.on("incompatible", ({ reason }) => this.patchLink({ phase: "incompatible", incompatible: incompatibleTitle(reason) })),
      l.on("peer-lost", () => this.patchLink({ phase: "no_host", proto: 0 })),
      l.on("fault", () => this.patchLink({ linkError: true })),
      l.on("acked", () => {
        if (this.st.link.linkError) this.patchLink({ linkError: false });
      }),
    );
    l.start();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.stopped = true;
    for (const u of this.unsubs.splice(0)) u();
    this.gestures.reset();
    this.link.close();
    this.transport.close();
  }

  keyDown(key: number): void {
    assertKey(key);
    this.gestures.down(key);
  }

  keyUp(key: number): void {
    assertKey(key);
    this.gestures.up(key);
  }

  button(button: ButtonId, down: boolean): void {
    // SCL hold shows the device-local help overlay (protocol version 2 and later); the host still gets the edge.
    if (button === "SEL" && this.st.local.help !== down) this.patchLocal({ help: down });
    this.sendInput({ kind: "BUTTON", button, edge: down ? "down" : "up" });
  }

  /** Sends encoder detents; large turns are split into frames within the s7 range. */
  turn(encoder: EncoderId, delta: number): void {
    if (!Number.isInteger(delta) || Math.abs(delta) > MAX_TURN) {
      throw new RangeError(`encoder delta ${delta} is not an integer within ±${MAX_TURN}`);
    }
    // Version 4: a K1-K4 turn shows the knob row for 2 s, lit on the turned knob (device-local, docs/ui-v3.md section 5).
    const knob = ["K1", "K2", "K3", "K4"].indexOf(encoder);
    if (knob >= 0 && delta !== 0 && this.st.link.phase === "connected" && this.st.link.proto >= 4) {
      this.patchLocal({ knobLit: knob, knobUntilMs: this.nowMs + KNOB_ROW_MS });
    }
    let left = delta;
    while (left !== 0) {
      const step = Math.max(-64, Math.min(63, left));
      this.sendInput({ kind: "ENCODER", encoder, delta: step });
      left -= step;
    }
  }

  /** MASTER pot position 0..1023. Reported when it moves past the hysteresis or hits an end stop. */
  setMaster(value: number): void {
    if (!Number.isFinite(value)) throw new RangeError(`MASTER value ${value} is not finite`);
    const v = Math.max(0, Math.min(1023, Math.round(value)));
    if (v !== this.st.master) this.setState({ ...this.st, master: v });
    const last = this.lastPotSent;
    const moved = last === undefined || Math.abs(v - last) >= POT_HYSTERESIS || ((v === 0 || v === 1023) && v !== last);
    if (!moved) return;
    if (this.sendInput({ kind: "POT", pot: "MASTER", value: v })) this.lastPotSent = v;
  }

  /** Inputs are only sent to a negotiated host; without one they are logged and dropped. */
  private sendInput(msg: DeviceMessage): boolean {
    if (!this.started) throw new Error("device is not started");
    if (this.st.link.phase !== "connected") {
      this.emit("frame", { atMs: this.nowMs, dir: "tx", seq: null, kind: msg.kind, summary: "", error: "not sent" });
      return false;
    }
    this.link.send(msg);
    this.emit("input", msg);
    return true;
  }

  private onHostMessage(msg: HostMessage): void {
    const next = applyHostMessage(this.st, msg, this.nowMs);
    if (msg.kind !== "HEARTBEAT" && msg.kind !== "ACK") this.emit("applied", msg);
    if (next !== this.st) this.setState(next);
  }

  private patchLocal(patch: Partial<DeviceState["local"]>): void {
    this.setState({ ...this.st, local: { ...this.st.local, ...patch } });
  }

  private patchLink(patch: Partial<DeviceState["link"]>): void {
    const dims = this.st.link.phase === "connected" && patch.phase !== undefined && patch.phase !== "connected";
    const local = dims ? { ...this.st.local, dimSinceMs: this.nowMs } : this.st.local;
    this.setState({ ...this.st, link: { ...this.st.link, ...patch }, local });
  }

  private setState(next: DeviceState): void {
    this.st = next;
    this.emit("state", next);
  }
}

function assertKey(key: number): void {
  if (!Number.isInteger(key) || key < 0 || key >= KEY_COUNT) throw new RangeError(`key ${key} not in 0..26`);
}

/** Maps the host's HELLO_ACK reason to the device banner (protocol section 3). */
export function incompatibleTitle(reason: string): string {
  if (/too old/i.test(reason)) return "UPDATE APP";
  if (/too new/i.test(reason)) return "OLD FIRMWARE";
  return "INCOMPATIBLE";
}
