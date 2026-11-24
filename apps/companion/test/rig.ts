// End-to-end rig: SimDevice (scripted) <-> LoopbackPair <-> Companion + MockAdapter + FixtureCapture.
import { MockAdapter, fixturePath, type AdapterCapabilities, type AckMode, type Scope, type Timers } from "@fm1/agent-core";
import {
  FakeClock,
  FrameAssembler,
  LoopbackPair,
  NO_REQ_SEQ,
  decode,
  type CommandResult as CommandResultFrame,
  type HostMessage,
} from "@fm1/device-protocol";
import { ScriptedDriver, SimDevice, type Sleeper } from "@fm1/device-simulator";
import { fileURLToPath } from "node:url";
import { Companion } from "../src/companion";
import type { CannedEntry } from "@fm1/agent-core";
import { DEFAULT_CONFIG, type LayoutsConfig, type SettingsConfig } from "../src/config";
import { FixtureCapture, loadFixtureAudio, type CapturedAudio } from "../src/voice/capture";
import { ScriptedTranscriber } from "../src/voice/transcriber";

export const AUDIO_DIR = fileURLToPath(new URL("../../../fixtures/audio/", import.meta.url));
export const SMOKE_TEXT = "Open the FM1 agent console repository and rename parse device frame to decode frame, then run the tests.";

export function clockTimers(clock: FakeClock): Timers {
  return {
    setTimeout: (fn, ms) => clock.schedule(ms, fn),
    clearTimeout: (h) => (h as { cancel(): void }).cancel(),
  };
}

/** Advances fake time in 10 ms steps and lets real I/O and promise chains run between steps. */
export function ioSleeper(clock: FakeClock): Sleeper {
  return {
    async sleep(ms) {
      for (let left = ms; left > 0; left -= 10) {
        clock.advance(Math.min(10, left));
        await new Promise((r) => setImmediate(r));
      }
    },
  };
}

export interface RigOptions {
  fixture?: string;
  wav?: string;
  text?: string;
  capabilities?: AdapterCapabilities;
  ackMode?: AckMode;
  /** KNOB1 scope at start; "recent" (default here) also shows the idle fixture session "refund impl". */
  scope?: Scope;
  /** Highest protocol version the simulated device offers (default: the simulator's, 5). */
  deviceMax?: number;
  /** Remembered layouts (default: the config default, Sessions Grouped since docs/ui-v3.md section 9). */
  layouts?: LayoutsConfig;
  /** SETTINGS values (protocol 6, docs/ui-v3.md section 10.2; default Keys ranked). */
  settings?: SettingsConfig;
  /** Canned responses (docs/ui-v3.md section 12; default: the config default, the three seed entries). */
  canned?: CannedEntry[];
  /** Re-reads canned responses from a config file before each input (runtime.ts wires config.ts cannedReloader). */
  reloadCanned?: () => Promise<CannedEntry[] | null>;
}

export interface Rig {
  clock: FakeClock;
  pair: LoopbackPair;
  adapter: MockAdapter;
  companion: Companion;
  device: SimDevice;
  driver: ScriptedDriver;
  transcriber: ScriptedTranscriber;
  captures: FixtureCapture[];
  /** Every host->device frame that reached the wire, decoded. */
  hostFrames: { seq: number; message: HostMessage }[];
  results(): CommandResultFrame[];
  sleep(ms: number): Promise<void>;
  slotOf(sessionId: string): number;
  keyOf(sessionId: string): string;
  /** Plug a fresh SimDevice (new boot) into a new loopback pair, as after an unplug. */
  replug(): SimDevice;
  stop(): Promise<void>;
}

const audioCache = new Map<string, CapturedAudio>();
async function audio(name: string): Promise<CapturedAudio> {
  let a = audioCache.get(name);
  if (!a) {
    a = await loadFixtureAudio(`${AUDIO_DIR}${name}`);
    audioCache.set(name, a);
  }
  return a;
}

function tapHost(pair: LoopbackPair, sink: Rig["hostFrames"]): void {
  const asm = new FrameAssembler("host");
  pair.host.tap = (m) => {
    const payload = asm.push(m);
    if (payload) {
      const r = decode(payload, "host");
      if (r.ok) sink.push({ seq: r.value.seq, message: r.value.message as HostMessage });
    }
    return m;
  };
}

export async function rig(opts: RigOptions = {}): Promise<Rig> {
  const clock = new FakeClock(1_000_000);
  let pair = new LoopbackPair();
  const adapter = MockAdapter.fromFixture(fixturePath(opts.fixture ?? "mixed"), { capabilities: opts.capabilities, ackMode: opts.ackMode });
  const sound = await audio(opts.wav ?? "smoke-16k.wav");
  const captures: FixtureCapture[] = [];
  const transcriber = new ScriptedTranscriber(opts.text ?? SMOKE_TEXT);
  let n = 0;
  const companion = new Companion({
    adapter,
    capture: () => {
      const c = new FixtureCapture(sound, clock, opts.wav ?? "smoke-16k.wav");
      captures.push(c);
      return c;
    },
    transcriber,
    clock,
    timers: clockTimers(clock),
    now: () => clock.now(),
    hostSession: 4242,
    ...(opts.layouts || opts.settings || opts.canned
      ? {
          config: {
            ...DEFAULT_CONFIG,
            layouts: { ...(opts.layouts ?? DEFAULT_CONFIG.layouts) },
            settings: { ...(opts.settings ?? DEFAULT_CONFIG.settings) },
            canned: opts.canned ?? DEFAULT_CONFIG.canned,
          },
        }
      : {}),
    newRequestId: () => `req-${++n}`,
    ...(opts.reloadCanned ? { reloadCanned: opts.reloadCanned } : {}),
    ackTimeoutMs: 5000,
    tickMs: 0,
  });
  await companion.start();
  // KNOB1 turns through the normal input path, so the device gets the rendered scope.
  const turns = { active: 0, recent: 1, all: 2, pinned: 3 }[opts.scope ?? "recent"];
  for (let i = 0; i < turns; i++) await companion.handleInput({ kind: "encoder", encoder: "K1", delta: 1 }, NO_REQ_SEQ);
  const hostFrames: Rig["hostFrames"] = [];
  tapHost(pair, hostFrames);
  companion.device.attach(pair.host, "loopback");
  const mkDevice = (bootId: number): SimDevice => {
    const d = new SimDevice({ transport: pair.device, clock, identity: { bootId, ...(opts.deviceMax === undefined ? {} : { versions: { min: 1, max: opts.deviceMax } }) } });
    d.start();
    return d;
  };
  const sleeper = ioSleeper(clock);
  const r: Rig = {
    clock,
    pair,
    adapter,
    companion,
    device: mkDevice(77),
    driver: undefined as unknown as ScriptedDriver,
    transcriber,
    captures,
    hostFrames,
    results: () => hostFrames.map((f) => f.message).filter((m): m is CommandResultFrame => m.kind === "COMMAND_RESULT"),
    sleep: (ms) => sleeper.sleep(ms),
    keyOf(sessionId) {
      const e = companion.console.registry.sessions().find((x) => x.session.ref.sessionId === sessionId);
      if (!e) throw new Error(`no session ${sessionId}`);
      return e.key;
    },
    slotOf(sessionId) {
      const i = companion.console.state.layouts.sessions.slots.indexOf(r.keyOf(sessionId));
      if (i < 0) throw new Error(`${sessionId} is not in the sessions layout`);
      return i % 27;
    },
    replug() {
      r.device.stop();
      companion.device.detach();
      pair = new LoopbackPair();
      r.pair = pair;
      tapHost(pair, hostFrames);
      companion.device.attach(pair.host, "loopback");
      r.device = mkDevice(78);
      r.driver = new ScriptedDriver(r.device, sleeper);
      return r.device;
    },
    async stop() {
      r.device.stop();
      await companion.stop();
    },
  };
  r.driver = new ScriptedDriver(r.device, sleeper);
  await r.driver.waitFor((s) => s.link.phase === "connected" && s.slots.some((x) => x.label !== ""), 3000);
  return r;
}
