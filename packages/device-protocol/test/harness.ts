import {
  decode,
  FakeClock,
  FrameAssembler,
  Link,
  LoopbackPair,
  type DecodedFrame,
  type DeviceIdentity,
  type LinkEvents,
  type Role,
} from "../src";

export const identity = (overrides: Partial<DeviceIdentity> = {}): DeviceIdentity => ({
  versions: { min: 1, max: 1 },
  fw: { major: 0, minor: 1, patch: 0 },
  bootId: 777,
  ...overrides,
});

/** Records the decoded frames one side puts on the wire, and can drop them. */
export class Wire {
  readonly frames: DecodedFrame[] = [];
  drop: (f: DecodedFrame | undefined) => boolean = () => false;
  private readonly asm: FrameAssembler;
  private held: number[][] = [];

  constructor(sender: Role) {
    this.asm = new FrameAssembler(sender);
  }

  /**
   * Buffers the CC messages of one frame and releases them together when it closes,
   * so the whole frame can be dropped as a unit.
   */
  tap = (m: number[]): number[] | null => {
    this.held.push(m);
    const payload = this.asm.push(m);
    if (m[2] !== 2 || (m[1] !== 116 && m[1] !== 118)) return null;
    const res = payload ? decode(payload) : undefined;
    const frame = res?.ok ? res.value : undefined;
    if (frame) this.frames.push(frame);
    const batch = this.held;
    this.held = [];
    return this.drop(frame) ? null : this.flush(batch);
  };

  /** Set by the harness to forward a released batch to the peer. */
  flush: (batch: number[][]) => null = () => null;

  kinds(): string[] {
    return this.frames.map((f) => f.message.kind);
  }
}

export interface Recorder<R extends Role> {
  events: { [K in keyof LinkEvents<R>]: LinkEvents<R>[K][] };
}

function record<R extends Role>(link: Link<R>): Recorder<R>["events"] {
  const events = {
    message: [],
    acked: [],
    fault: [],
    "peer-alive": [],
    "peer-lost": [],
    negotiated: [],
    incompatible: [],
    "rx-error": [],
  } as Recorder<R>["events"];
  for (const key of Object.keys(events) as (keyof LinkEvents<R>)[]) {
    link.on(key, (arg) => (events[key] as unknown[]).push(arg));
  }
  return events;
}

export interface Setup {
  clock: FakeClock;
  pair: LoopbackPair;
  host: Link<"host">;
  device: Link<"device">;
  hostEvents: Recorder<"host">["events"];
  deviceEvents: Recorder<"device">["events"];
  hostWire: Wire;
  deviceWire: Wire;
}

export function setup(opts: { device?: Partial<DeviceIdentity>; hostRate?: number } = {}): Setup {
  const clock = new FakeClock(1_000_000);
  const pair = new LoopbackPair();
  const hostWire = new Wire("host");
  const deviceWire = new Wire("device");
  wireUp(pair.host, pair.device, hostWire);
  wireUp(pair.device, pair.host, deviceWire);
  const host = Link.host({ transport: pair.host, clock, hostSession: 42, maxFramesPerSecond: opts.hostRate ?? Infinity });
  const device = Link.device({ transport: pair.device, clock, identity: identity(opts.device) });
  return {
    clock,
    pair,
    host,
    device,
    hostEvents: record(host),
    deviceEvents: record(device),
    hostWire,
    deviceWire,
  };
}

type End = LoopbackPair["host"];

function wireUp(from: End, to: End, wire: Wire): void {
  from.tap = wire.tap;
  wire.flush = (batch) => {
    for (const m of batch) to.deliver(m);
    return null;
  };
}
