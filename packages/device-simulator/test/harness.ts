import {
  decode,
  encode,
  FakeClock,
  FrameAssembler,
  Link,
  LoopbackPair,
  payloadToMidi,
  type DeviceMessage,
  type HostMessage,
  type VersionRange,
} from "@fm1/device-protocol";
import { SimDevice } from "../src/device";

export interface Rig {
  clock: FakeClock;
  pair: LoopbackPair;
  device: SimDevice;
  /** Every decoded frame the device put on the wire, in order. */
  deviceFrames: { seq: number; message: DeviceMessage }[];
  /** Device frames excluding HELLO/HEARTBEAT/ACK. */
  inputs(): DeviceMessage[];
  /** Starts a host Link on the loopback (call again after `stopHost` to simulate a restart). */
  startHost(opts?: { versions?: VersionRange; hostSession?: number }): Link<"host">;
  stopHost(): void;
  host(): Link<"host">;
  /** Writes a raw host frame straight onto the device's input (bypasses the host Link). */
  inject(msg: HostMessage, seq: number): void;
  injectPayload(payload: number[]): void;
}

export function rig(): Rig {
  const clock = new FakeClock(5_000_000);
  const pair = new LoopbackPair();
  const deviceFrames: Rig["deviceFrames"] = [];
  const asm = new FrameAssembler("device");
  // Observe (not alter) everything the device sends.
  pair.device.tap = (m) => {
    const payload = asm.push(m);
    if (payload) {
      const res = decode(payload, "device");
      if (res.ok) deviceFrames.push({ seq: res.value.seq, message: res.value.message as DeviceMessage });
    }
    return m;
  };
  const device = new SimDevice({ transport: pair.device, clock, identity: { bootId: 1234 } });
  let host: Link<"host"> | undefined;
  return {
    clock,
    pair,
    device,
    deviceFrames,
    inputs: () =>
      deviceFrames
        .map((f) => f.message)
        .filter((m) => m.kind !== "HELLO" && m.kind !== "HEARTBEAT" && m.kind !== "ACK"),
    startHost(opts = {}) {
      host = Link.host({ transport: pair.host, clock, maxFramesPerSecond: Infinity, hostSession: 99, ...opts });
      host.start();
      return host;
    },
    stopHost() {
      host?.close();
      host = undefined;
    },
    host() {
      if (!host) throw new Error("host not started");
      return host;
    },
    inject(msg, seq) {
      this.injectPayload(encode(msg, seq));
    },
    injectPayload(payload) {
      for (const m of payloadToMidi(payload, "host")) pair.device.deliver(m);
    },
  };
}

/** Starts device and host and completes the handshake. */
export function connected(): Rig {
  const r = rig();
  r.startHost();
  r.device.start();
  r.clock.advance(10);
  if (r.device.state.link.phase !== "connected") throw new Error("handshake failed");
  return r;
}

