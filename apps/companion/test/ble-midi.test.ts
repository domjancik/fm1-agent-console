import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode, FakeClock, FrameAssembler, type MidiMessage, type MidiTransport, type VectorFile } from "@fm1/device-protocol";
import { BleMidiDecoder, encodePackets, MIN_BLE_PAYLOAD, type TimedMessage } from "../src/device/ble-midi-codec";
import { BleMidiLink, BleMidiTransport, fromHex, LineSplitter, parseHelperLine, toHex, type HelperProc, type HelperSpawner } from "../src/device/ble-midi";
import { parseStartSelection } from "../src/cli";

const vectors = JSON.parse(readFileSync(join(import.meta.dir, "../../../fixtures/device/vectors.json"), "utf8")) as VectorFile;
const bytesOf = (ms: TimedMessage[]): number[][] => ms.map((m) => m.bytes);
const decodeAll = (packets: number[][], d = new BleMidiDecoder()): number[][] => packets.flatMap((p) => bytesOf(d.decode(p)));
const sysex = (n: number): number[] => [0xf0, ...Array.from({ length: n }, (_, i) => i & 0x7f), 0xf7];

describe("BLE-MIDI decoder", () => {
  test("header and timestamp bytes give a 13-bit time; low-byte wrap in a packet carries into the high bits", () => {
    // header hi=0x05, ts lo=0x7e: CC; then ts lo=0x02 (< 0x7e -> hi 6): note on
    const out = new BleMidiDecoder().decode([0x85, 0xfe, 0xbf, 0x74, 0x01, 0x82, 0x90, 0x3c, 0x40]);
    expect(out).toEqual([
      { ts: (5 << 7) | 0x7e, bytes: [0xbf, 0x74, 0x01] },
      { ts: (6 << 7) | 0x02, bytes: [0x90, 0x3c, 0x40] },
    ]);
  });

  test("running status: data only, and timestamp + data, within and across packets", () => {
    const d = new BleMidiDecoder();
    expect(bytesOf(d.decode([0x80, 0x81, 0xbf, 0x75, 0x01, 0x75, 0x02, 0x82, 0x75, 0x03]))).toEqual([
      [0xbf, 0x75, 0x01],
      [0xbf, 0x75, 0x02],
      [0xbf, 0x75, 0x03],
    ]);
    expect(bytesOf(d.decode([0x80, 0x83, 0x75, 0x04]))).toEqual([[0xbf, 0x75, 0x04]]);
    expect(d.errors).toBe(0);
  });

  test("SysEx across three packets, timestamp before F7, real-time byte inside", () => {
    const d = new BleMidiDecoder();
    expect(d.decode([0x80, 0x81, 0xf0, 0x01, 0x02])).toEqual([]);
    expect(bytesOf(d.decode([0x80, 0x03, 0x04, 0x82, 0xf8, 0x05]))).toEqual([[0xf8]]);
    expect(bytesOf(d.decode([0x80, 0x06, 0x83, 0xf7, 0x84, 0xbf, 0x74, 0x01]))).toEqual([
      [0xf0, 1, 2, 3, 4, 5, 6, 0xf7],
      [0xbf, 0x74, 0x01],
    ]);
  });

  test("bad header, stray data and a status inside SysEx count as errors and are dropped", () => {
    const d = new BleMidiDecoder();
    expect(d.decode([0x40, 0x81, 0xbf, 1, 2])).toEqual([]);
    expect(d.decode([0x80, 0x01])).toEqual([]);
    expect(bytesOf(d.decode([0x80, 0x81, 0xf0, 0x01, 0x82, 0xbf, 0x74, 0x05]))).toEqual([[0xbf, 0x74, 0x05]]);
    expect(d.errors).toBe(3);
  });

  test("a channel message cut at the packet end is lost; running status survives", () => {
    const d = new BleMidiDecoder();
    expect(d.decode([0x80, 0x81, 0xbf, 0x74])).toEqual([]);
    expect(bytesOf(d.decode([0x80, 0x81, 0x75, 0x09]))).toEqual([[0xbf, 0x75, 0x09]]);
  });
});

describe("BLE-MIDI encoder", () => {
  test("every message gets timestamp + status; header carries the high time bits", () => {
    const t = (3 << 7) | 0x11;
    expect(encodePackets([[0xbf, 0x74, 1], [0xbf, 0x75, 2]], 20, t)).toEqual([[0x83, 0x91, 0xbf, 0x74, 1, 0x91, 0xbf, 0x75, 2]]);
    expect(encodePackets([[0xbf, 0x74, 1]], 20, 8192 + 5)[0]![0]).toBe(0x80); // time wraps at 13 bits
  });

  test("running status option: [ts][data] for a repeated channel status in one packet", () => {
    const p = encodePackets([[0xbf, 0x74, 1], [0xbf, 0x75, 2], [0xbf, 0x75, 3]], 20, 0, { runningStatus: true });
    expect(p).toEqual([[0x80, 0x80, 0xbf, 0x74, 1, 0x80, 0x75, 2, 0x80, 0x75, 3]]);
    expect(decodeAll(p)).toEqual([[0xbf, 0x74, 1], [0xbf, 0x75, 2], [0xbf, 0x75, 3]]);
  });

  test("MTU 20: four CCs per packet, no message straddles packets, packets never exceed the MTU", () => {
    const msgs = Array.from({ length: 13 }, (_, i) => [0xbf, 0x75, i]);
    const p = encodePackets(msgs, 20, 0);
    expect(p.map((x) => x.length)).toEqual([17, 17, 17, 5]);
    expect(decodeAll(p)).toEqual(msgs);
    for (const mtu of [5, 6, 7, 20, 23, 185, 244]) {
      const q = encodePackets([...msgs, sysex(300), ...msgs], mtu, 1234);
      for (const pk of q) expect(pk.length).toBeLessThanOrEqual(mtu);
      expect(decodeAll(q)).toEqual([...msgs, sysex(300), ...msgs]);
    }
  });

  test("multi-packet SysEx: continuation packets start with data, F7 keeps its timestamp", () => {
    const p = encodePackets([sysex(40)], 20, 0);
    expect(p[0]!.slice(0, 3)).toEqual([0x80, 0x80, 0xf0]);
    expect(p[1]![1]! & 0x80).toBe(0); // continuation: header then data
    const last = p[p.length - 1]!;
    expect(last.slice(-2)).toEqual([0x80, 0xf7]);
    expect(decodeAll(p)).toEqual([sysex(40)]);
    expect(decodeAll(encodePackets([[0xf0, 0xf7]], 5, 0))).toEqual([[0xf0, 0xf7]]);
  });

  test("rejects malformed messages and an MTU below 5", () => {
    expect(() => encodePackets([[0xbf, 0x74]], 20, 0)).toThrow();
    expect(() => encodePackets([[0x74, 1, 2]], 20, 0)).toThrow();
    expect(() => encodePackets([[0xf0, 0x80, 0xf7]], 20, 0)).toThrow();
    expect(() => encodePackets([[0xbf, 0x74, 1]], 4, 0)).toThrow();
  });

  test(`all ${vectors.valid.length} FM1C protocol vectors round-trip encode -> decode at MTU 20 and 244`, () => {
    for (const mtu of [MIN_BLE_PAYLOAD, 244]) {
      for (const opts of [{}, { runningStatus: true }]) {
        const d = new BleMidiDecoder();
        for (const v of vectors.valid) {
          const p = encodePackets(v.midi, mtu, v.seq * 37, opts);
          expect(decodeAll(p, d)).toEqual(v.midi);
        }
        expect(d.errors).toBe(0);
      }
    }
  });
});

test("packets captured live from FM1 CONSOLE 8C2F (2026-11-23) decode to valid FM1C frames", () => {
  const live = ["ab93bf740193750693753993750393750393756093750093750f937402", "b2fbbf7401fb7507fb754bfb7502fb7508fb7500fb7576fb7402"];
  const d = new BleMidiDecoder();
  const fa = new FrameAssembler("device");
  const kinds: string[] = [];
  for (const l of live) {
    for (const m of d.decode(fromHex(l)!)) {
      const frame = fa.push(m.bytes);
      if (frame) {
        const r = decode(frame, "device");
        if (r.ok) kinds.push(r.value.message.kind);
      }
    }
  }
  expect(kinds).toEqual(["HEARTBEAT", "ACK"]);
  expect(d.errors).toBe(0);
});

describe("helper line protocol", () => {
  test("parses every line kind; rejects malformed ones", () => {
    expect(parseHelperLine("rx 80bf7401")).toEqual({ kind: "rx", data: [0x80, 0xbf, 0x74, 0x01] });
    expect(parseHelperLine("ack")).toEqual({ kind: "ack" });
    expect(parseHelperLine("state ready mtu=244 write=without")).toEqual({ kind: "state", state: "ready", mtu: 244, write: "without" });
    expect(parseHelperLine("state connecting found advertising")).toEqual({ kind: "state", state: "connecting", detail: "found advertising" });
    expect(parseHelperLine("error subscribe failed")).toEqual({ kind: "log", level: "warn", text: "subscribe failed" });
    for (const bad of ["rx 8", "rx zz", "rx ", "state ready mtu=x write=without", "state bogus", "ack 1", "hello"]) {
      expect(parseHelperLine(bad).kind).toBe("bad");
    }
    expect(fromHex(toHex([0, 255, 16]))).toEqual([0, 255, 16]);
  });

  test("line splitter joins partial chunks, strips CR, drops an overlong line whole", () => {
    const s = new LineSplitter(32);
    expect(s.push("state scan")).toEqual([]);
    expect(s.push("ning\r\nrx 80")).toEqual(["state scanning"]);
    expect(s.push("81\n\nack\n")).toEqual(["rx 8081", "ack"]);
    expect(s.push("x".repeat(40))).toEqual([]);
    expect(s.push("yyyy\nack\n")).toEqual(["ack"]);
    expect(s.overlong).toBe(1);
  });
});

describe("BleMidiTransport", () => {
  test("only channel-16 CCs go out; a same-tick burst shares packets; back-pressure window keeps order", async () => {
    const lines: string[] = [];
    const t = new BleMidiTransport(20, (l) => lines.push(l), { now: () => 0, window: 2 });
    expect(() => t.send([0xf0, 0x22, 0xf7])).toThrow();
    const msgs = Array.from({ length: 13 }, (_, i) => [0xbf, 0x75, i]);
    for (const m of msgs) t.send(m);
    expect(lines).toEqual([]); // flushed in a microtask
    await Promise.resolve();
    expect(lines.length).toBe(2);
    expect(t.queued).toBe(2);
    t.ack();
    t.ack();
    t.ack(); // a stray ack never goes below zero
    expect(lines.length).toBe(4);
    t.ack();
    t.ack();
    expect(t.inFlightCount).toBe(0);
    const packets = lines.map((l) => fromHex(l.trim().slice(3))!);
    expect(decodeAll(packets)).toEqual(msgs);
  });

  test("incoming packets reach listeners; SysEx, clock and active sensing are filtered like CoreMIDI", () => {
    const t = new BleMidiTransport(20, () => {});
    const got: MidiMessage[] = [];
    t.onMessage((m) => got.push(m));
    t.receive([0x80, 0x80, 0xf8, 0x80, 0xfe, 0x80, 0xbf, 0x74, 1, 0x80, 0xf0, 1, 0x80, 0xf7, 0x80, 0xbf, 0x74, 2]);
    expect(got).toEqual([[0xbf, 0x74, 1], [0xbf, 0x74, 2]]);
    t.close();
    t.receive([0x80, 0x80, 0xbf, 0x74, 3]);
    expect(got.length).toBe(2);
    expect(() => t.send([0xbf, 0x74, 1])).toThrow();
  });
});

class FakeHelper implements HelperProc {
  written: string[] = [];
  killed = false;
  private resolveExit!: (code: number) => void;
  exited = new Promise<number>((r) => (this.resolveExit = r));
  constructor(private readonly out: (chunk: string) => void) {}
  write(text: string): void {
    this.written.push(text);
  }
  kill(): void {
    this.killed = true;
    this.resolveExit(143);
  }
  say(line: string): void {
    this.out(`${line}\n`);
  }
  exit(code: number): void {
    this.resolveExit(code);
  }
}

function rig() {
  const helpers: FakeHelper[] = [];
  const events: string[] = [];
  let transport: MidiTransport | null = null;
  const spawn: HelperSpawner = (_bin, device, onStdout) => {
    events.push(`spawn ${device}`);
    const h = new FakeHelper(onStdout);
    helpers.push(h);
    return h;
  };
  const target = {
    attach(t: MidiTransport, name: string) {
      transport = t;
      events.push(`attach ${name}`);
    },
    detach() {
      transport = null;
      events.push("detach");
    },
  };
  const clock = new FakeClock();
  const link = new BleMidiLink("FM1 CONSOLE 19E2", target, { spawn, clock, restartMs: 2000 });
  return { helpers, events, link, clock, transport: () => transport };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("BleMidiLink", () => {
  test("attaches on ready, detaches on disconnect, re-attaches on the next ready", async () => {
    const r = rig();
    expect(r.link.start()).toBe(true);
    const h = r.helpers[0]!;
    h.say("state scanning");
    h.say("state connecting found advertising");
    h.say("state connected");
    expect(r.events).toEqual(["spawn FM1 CONSOLE 19E2"]);
    h.say("state ready mtu=20 write=without");
    expect(r.events.at(-1)).toBe('attach bluetooth direct "FM1 CONSOLE 19E2"');
    const got: MidiMessage[] = [];
    r.transport()!.onMessage((m) => got.push(m));
    h.say("rx 8080bf7401");
    expect(got).toEqual([[0xbf, 0x74, 1]]);
    r.transport()!.send([0xbf, 0x74, 2]);
    await Promise.resolve();
    expect(h.written).toEqual(["tx 8080bf7402\n"]);
    h.say("state disconnected");
    expect(r.events.at(-1)).toBe("detach");
    expect(r.link.attached).toBe(false);
    h.say("state ready mtu=244 write=without");
    expect(r.events.filter((e) => e.startsWith("attach")).length).toBe(2);
    r.link.stop();
    expect(h.killed).toBe(true);
    expect(r.events.at(-1)).toBe("detach");
  });

  test("restarts the helper 2 s after a crash and detaches meanwhile; not after exit 3", async () => {
    const r = rig();
    r.link.start();
    r.helpers[0]!.say("state ready mtu=20 write=without");
    r.helpers[0]!.exit(1);
    await tick();
    expect(r.events.at(-1)).toBe("detach");
    expect(r.helpers.length).toBe(1);
    r.clock.advance(1999);
    expect(r.helpers.length).toBe(1);
    r.clock.advance(1);
    expect(r.helpers.length).toBe(2);
    r.helpers[1]!.exit(3);
    await tick();
    r.clock.advance(10000);
    expect(r.helpers.length).toBe(2);
    expect(r.link.state).toBe("failed");
  });

  test("lines from a replaced helper are ignored; garbage lines are counted, not fatal", async () => {
    const r = rig();
    r.link.start();
    const old = r.helpers[0]!;
    old.exit(0);
    await tick();
    r.clock.advance(2000);
    old.say("state ready mtu=20 write=without");
    expect(r.link.attached).toBe(false);
    r.helpers[1]!.say("%%%");
    expect(r.link.badLines).toBe(1);
    r.link.stop();
  });

  test("a missing helper binary is reported and nothing starts", () => {
    const link = new BleMidiLink("X", { attach() {}, detach() {} }, { bin: "/nonexistent/fm1-ble-midi" });
    expect(link.start()).toBe(false);
    expect(link.state).toBe("failed");
  });
});

describe("start option parsing", () => {
  test("--ble selects BT direct; --port stays CoreMIDI; bad combinations throw", () => {
    expect(parseStartSelection({ ble: "FM1 CONSOLE 19E2" })).toEqual({ mode: "real", bleDevice: "FM1 CONSOLE 19E2" });
    expect(parseStartSelection({ port: "FM1 CONSOLE" })).toEqual({ mode: "real", devicePort: "FM1 CONSOLE" });
    expect(parseStartSelection({})).toEqual({ mode: "real" });
    expect(parseStartSelection({ sim: true })).toEqual({ mode: "sim" });
    expect(() => parseStartSelection({ ble: "A", port: "B" })).toThrow(/exclusive/);
    expect(() => parseStartSelection({ ble: "A", sim: true })).toThrow(/real FM-1/);
    expect(() => parseStartSelection({ ble: "  " })).toThrow(/advertised/);
    expect(() => parseStartSelection({ sim: true, emu: true })).toThrow(/exclusive/);
  });
});

describe("real helper processes", () => {
  const helperBin = join(import.meta.dir, "../bin/fm1-ble-midi");

  test.skipIf(!existsSync(helperBin))("fm1-ble-midi without a name exits 2 (usage)", async () => {
    const p = Bun.spawn([helperBin], { stdout: "pipe", stderr: "pipe" });
    expect(await p.exited).toBe(2);
  });

  test("bunSpawner: a stand-in helper echoes a tx back as rx; a crash restarts it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fm1-ble-"));
    const script = join(dir, "fake-helper.sh");
    writeFileSync(
      script,
      '#!/bin/bash\necho "state ready mtu=20 write=without"\nread -r line\necho "ack"\necho "rx ${line#tx }"\nexit 1\n',
      { mode: 0o755 },
    );
    const events: string[] = [];
    const got: MidiMessage[] = [];
    const link = new BleMidiLink("FAKE", {
      attach(t: MidiTransport) {
        events.push("attach");
        t.onMessage((m) => got.push(m));
        t.send([0xbf, 0x74, 0x05]);
      },
      detach() {
        events.push("detach");
      },
    }, { bin: script, restartMs: 50 });
    expect(link.start()).toBe(true);
    for (let i = 0; i < 100 && events.filter((e) => e === "attach").length < 2; i++) await Bun.sleep(20);
    link.stop();
    expect(got[0]).toEqual([0xbf, 0x74, 0x05]);
    expect(events.slice(0, 3)).toEqual(["attach", "detach", "attach"]);
    expect(link.starts).toBeGreaterThanOrEqual(2);
  });
});
