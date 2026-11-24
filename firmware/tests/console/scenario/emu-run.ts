// SPDX-License-Identifier: GPL-3.0-only
// The packaged firmware (.fwsc) in fm1-emu's fm1-live, headless, with its emulated USB: host frames go in as
// USB-MIDI (FM1_USB_SEND), the panel as FM1_BENCH_KEYS, the device's USB replies come out and are decoded with the
// TypeScript codec; screenshots are separate --shot runs of the same input up to their time. --midi none: the
// emulator opens no MIDI port of this Mac (the real FM-1's included). The runs are independent (headless, emulated
// clock), so they go in parallel: EMU_JOBS at once (default: CPUs - 2); scenarios report in their usual order.
//   bun tests/console/scenario/emu-run.ts PACKAGE.fwsc FM1_LIVE WORKDIR EVIDENCE_DIR
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import type { DeviceMessage } from "../../../../packages/device-protocol/src/index.ts";
import { Scenario, companionAcks, sameAcks, type Ack, type Delivered } from "./builder.ts";
import { framesFromMidi, type DeviceFrame } from "./parse.ts";
import { Checker, SCENARIOS, type ScenarioDef } from "./scenarios.ts";

function args(): [string, string, string, string] {
  const [a, b, c, d] = process.argv.slice(2).map((x) => resolve(x));   // (each run has its own cwd)
  if (!a || !b || !c || !d) {
    console.error("usage: emu-run.ts PACKAGE.fwsc FM1_LIVE WORKDIR EVIDENCE_DIR");
    process.exit(2);
  }
  return [a, b, c, d];
}
const [fwsc, live, work, evidence] = args();
mkdirSync(evidence, { recursive: true });

const OFFSET = 1000;                            // USB is configured ~333 ms after boot: scenarios start 1 s in
const TRACKED = new Set(["KEY", "BUTTON", "ENCODER", "POT"]);

interface EmuResult {
  frames: DeviceFrame[];
  bad: { t: number; error: string }[];
  product?: string;
  ledFractions: Map<number, number>;
  delivered: Delivered[];
  hostIn: number;
  log: string;
}

const JOBS = Math.max(1, Number(process.env.EMU_JOBS) || availableParallelism() - 2);
let running = 0;
const waiting: (() => void)[] = [];
/** At most JOBS fm1-live processes at a time. */
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= JOBS) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

let runNo = 0;
async function emulate(def: ScenarioDef, acks: readonly Ack[], untilMs?: number): Promise<{ res: EmuResult; lcd: string }> {
  const s = new Scenario(def.name, acks, OFFSET);
  def.build(s);
  const emu = s.toEmu();
  const dir = join(work, `${def.name}-${runNo++}`);
  mkdirSync(join(dir, "work"), { recursive: true });
  writeFileSync(join(dir, "usb.txt"), emu.usbSend);
  writeFileSync(join(dir, "keys.txt"), emu.keys);
  const ms = untilMs ?? emu.endMs;
  const { log, code } = await slot(async () => {
    const p = Bun.spawn([live, "--fwsc", fwsc, "--usb", "--midi", "none", "--shot", String(ms), "--lcd-only"], {
      cwd: dir,
      env: { ...process.env, FM1_USB_SEND: `@${join(dir, "usb.txt")}`, FM1_BENCH_KEYS: `@${join(dir, "keys.txt")}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { log: out + err, code };
  });
  writeFileSync(join(dir, "run.log"), log);
  if (code !== 0) throw new Error(`${def.name}: fm1-live exited ${code}\n${log.slice(-2000)}`);
  const midi: { t: number; midi: number[] }[] = [];
  let hostIn = 0;
  for (const line of log.split("\n")) {
    const m = /^\[\s*(\d+) ms\] usb (in|out):\s+([0-9a-f]{2}) ([0-9a-f]{2}) ([0-9a-f]{2})/.exec(line);
    if (!m) continue;
    if (m[2] === "out") { hostIn++; continue; }   // (the host's OUT: what the device received)
    midi.push({ t: Number(m[1]), midi: [m[3], m[4], m[5]].map((h) => Number.parseInt(h ?? "0", 16)) });
  }
  const product = /usb: Configured \{ product: "([^"]*)"/.exec(log)?.[1];
  const ledFractions = new Map<number, number>();
  const leds = /LED on-fractions: (.*)$/m.exec(log)?.[1] ?? "";
  for (const kv of leds.trim().split(/\s+/)) {
    const [id, f] = kv.split(":");
    if (id && f) ledFractions.set(Number(id), Number(f));
  }
  return { res: { ...framesFromMidi(midi), product, ledFractions, delivered: emu.delivered, hostIn, log }, lcd: join(dir, "work", "lcd.ppm") };
}

const kinds = (fs: readonly DeviceFrame[], k: DeviceMessage["kind"]): DeviceFrame[] => fs.filter((f) => f.msg.kind === k);
const firsts = (fs: readonly DeviceFrame[]): DeviceFrame[] => {
  const seen = new Set<number>();
  return fs.filter((f) => TRACKED.has(f.msg.kind) && !seen.has(f.seq) && seen.add(f.seq));
};
const gesture = (f: DeviceFrame): string =>
  f.msg.kind === "KEY" ? `${f.msg.key}:${f.msg.gesture}` : f.msg.kind === "BUTTON" ? `${f.msg.button}:${f.msg.edge}`
    : f.msg.kind === "ENCODER" ? `${f.msg.encoder}:${f.msg.delta}` : f.msg.kind === "POT" ? `POT:${f.msg.value}` : f.msg.kind;
const near = (a: number | undefined, b: number, tol = 3): boolean => a !== undefined && Math.abs(a - b) <= tol;

function common(def: ScenarioDef, r: EmuResult, c: Checker): void {
  c.ok(r.product === "FM1 CONSOLE", `USB enumerates as "${r.product}"`);
  c.ok(r.bad.length === 0, `every device frame decodes with the TS codec (${r.bad.map((b) => b.error).join("; ")})`);
  c.ok(r.hostIn > 0 || def.name === "nohost-boot" || def.name === "nohost-v2-words", `the emulated host sent ${r.hostIn} USB-MIDI messages`);
  const acks = kinds(r.frames, "ACK");
  let missing = 0;
  let worst = 0;
  const late: string[] = [];
  for (const d of r.delivered) {
    if (!d.msg || d.msg.kind === "HEARTBEAT" || d.msg.kind === "ACK" || d.seq === undefined) continue;
    const a = acks.find((f) => f.msg.kind === "ACK" && f.msg.ackedSeq === d.seq && f.msg.status === "ok" && f.t >= d.at);
    if (a) worst = Math.max(worst, a.t - d.at);
    if (!a || a.t > d.at + 15) {
      missing++;
      late.push(`${d.msg.kind}#${d.seq}@${d.at - OFFSET}:${a ? `${a.t - d.at}ms` : "none"}`);
    }
  }
  c.ok(missing === 0, `every host SET_*/HELLO_ACK/COMMAND_RESULT ACKed ok within 15 ms (${missing} missing; worst ${worst} ms)${late.length ? ` ${late.slice(0, 8).join(" ")}` : ""}`);
  const hbs = kinds(r.frames, "HEARTBEAT");
  const gaps = hbs.slice(1).map((f, i) => f.t - (hbs[i]?.t ?? 0));
  c.ok(hbs.length >= 2 && gaps.every((g) => near(g, 1000, 2)), `device HEARTBEAT every 1000 ms over USB (${hbs.length}, gaps ${[...new Set(gaps)].join("/")})`);
  const ups = hbs.map((f) => (f.msg.kind === "HEARTBEAT" ? f.msg.uptimeS : 0));
  c.ok(ups.every((u, i) => i === 0 || u === (ups[i - 1] ?? 0) + 1), "heartbeat uptime counts seconds");
}

type EmuCheck = (r: EmuResult, c: Checker, shots: Map<string, Buffer>) => void;

const CHECKS: Record<string, EmuCheck> = {
  sessions(r, c) {
    const keys = firsts(r.frames).filter((f) => f.msg.kind === "KEY");
    const seq = keys.map(gesture).join(" ");
    c.ok(seq === "5:down 5:up 5:single 6:down 6:up 6:down 6:up 6:double 7:down 7:long 7:up", `gestures on the package (${seq})`);
    const at = (g: string): number | undefined => keys.find((f) => gesture(f) === g)?.t;
    c.ok(near((at("5:single") ?? 0) - (at("5:up") ?? 0), 300, 3), `single ${(at("5:single") ?? 0) - (at("5:up") ?? 0)} ms after the up (300)`);
    c.ok(near((at("7:long") ?? 0) - (at("7:down") ?? 0), 600, 3), `long ${(at("7:long") ?? 0) - (at("7:down") ?? 0)} ms after the down (600)`);
    const btn = firsts(r.frames).filter((f) => f.msg.kind === "BUTTON").map(gesture).join(" ");
    c.ok(btn === "HOME:down HOME:up REC:down REC:up", `buttons, both edges (${btn})`);
    // the emulator turns an encoder detent by detent, so the 20 ms pacing may split a turn: the sums count
    const sum = (e: string): number => firsts(r.frames).reduce((n, f) => n + (f.msg.kind === "ENCODER" && f.msg.encoder === e ? f.msg.delta : 0), 0);
    const encs = firsts(r.frames).filter((f) => f.msg.kind === "ENCODER").map(gesture).join(" ");
    c.ok(sum("SELECT") === 3 && sum("ALGORITHM") === -2, `encoders: SELECT +3, ALGORITHM -2 in total (${encs})`);
    const pots = firsts(r.frames).filter((f) => f.msg.kind === "POT").map((f) => (f.msg.kind === "POT" ? f.msg.value : -1));
    c.ok(pots.length >= 3 && Math.abs((pots.at(-1) ?? 0) - 900) <= 10, `MASTER followed to ~900 (${pots.join(",")})`);
    c.ok(kinds(r.frames, "ACK").length > 30, "the resync was acknowledged frame by frame");
    c.ok(new Set(firsts(r.frames).map((f) => f.seq)).size === kinds(r.frames, "KEY").length + kinds(r.frames, "BUTTON").length +
      kinds(r.frames, "ENCODER").length + kinds(r.frames, "POT").length, "with the host ACKing, nothing is retransmitted");
  },
  voice(r, c) {
    const btn = firsts(r.frames).filter((f) => f.msg.kind === "BUTTON").map(gesture).join(" ");
    c.ok(btn === "REC:down REC:up SAVE:down SAVE:up", `push-to-talk and SAVE on the package (${btn})`);
  },
  nohost(r, c, shots) {
    const hellos = kinds(r.frames, "HELLO").map((f) => f.t);
    c.ok(hellos.filter((t) => t > OFFSET + 7500 && t < OFFSET + 11000).length === 3, `HELLO resumes every second after the loss (${hellos.join(",")})`);
    c.ok(firsts(r.frames).filter((f) => f.t > OFFSET + 7500 && f.t < OFFSET + 11000).length === 0, "no input frames while the host is lost");
    const a = shots.get("connected");
    const b = shots.get("reconnected");
    const d = shots.get("nohost-dimmed");
    c.ok(!!a && !!b && a.equals(b), "after reconnect and resync the LCD is identical to before");
    c.ok(!!a && !!d && !a.equals(d), "NO HOST changes the LCD");
  },
  malformed(r, c, shots) {
    const acks = kinds(r.frames, "ACK").map((f) => (f.msg.kind === "ACK" ? `${f.msg.ackedSeq}:${f.msg.status}` : ""));
    c.ok(acks.includes("120:unknown_type") && acks.includes("121:bad_body") && acks.includes("122:unknown_type"),
      "unknown type -> ACK 1, bad body -> ACK 2, a device type -> ACK 1");
    const hb = kinds(r.frames, "HEARTBEAT").find((f) => f.t >= OFFSET + 2000);
    c.ok(hb?.msg.kind === "HEARTBEAT" && hb.msg.rxErrors === 5, `rx_errors 5 on the package (${hb?.msg.kind === "HEARTBEAT" ? hb.msg.rxErrors : "?"})`);
    const a = shots.get("before-malformed");
    const b = shots.get("after-malformed");
    c.ok(!!a && !!b && a.equals(b), "malformed input leaves the LCD as it was");
    const dup = r.delivered.find((d) => d.label === "repeat SET_SLOT")?.seq;
    c.ok(kinds(r.frames, "ACK").filter((f) => f.msg.kind === "ACK" && f.msg.ackedSeq === dup && f.t >= OFFSET + 2000).length === 3,
      "a frame sent three times is ACKed three times (repeated action, executed once)");
  },
  retransmit(r, c) {
    const fx = kinds(r.frames, "BUTTON").filter((f) => f.msg.kind === "BUTTON" && f.msg.edge === "down");
    const gaps = fx.slice(1).map((f, i) => f.t - (fx[i]?.t ?? 0));
    c.ok(fx.length === 4 && new Set(fx.map((f) => f.seq)).size === 1 && gaps.every((g) => near(g, 250, 3)),
      `unACKed BUTTON sent 4 times, 250 ms apart, same SEQ (gaps ${gaps.join(",")})`);
  },
  "v4-soak"(r, c) {                             // docs/ui-v3.md 6.5.5: the link with every sprite animating
    const ins = r.frames.filter((f) => TRACKED.has(f.msg.kind));
    const resent = ins.filter((f, i) => ins.slice(0, i).some((g) => g.seq === f.seq && f.t - g.t < 1000));   // (SEQ wraps)
    c.ok(ins.length >= 30 && resent.length === 0, `0 retransmissions (${ins.length} input frames sent, ${resent.length} resent)`);
    const hbs = kinds(r.frames, "HEARTBEAT").map((f) => f.t);
    const jit = Math.max(0, ...hbs.slice(1).map((t, i) => Math.abs(t - (hbs[i] ?? 0) - 1000)));
    c.ok(hbs.length >= 58 && jit < 50, `heartbeat jitter ${jit} ms over ${hbs.length} heartbeats (< 50)`);
  },
  incompatible(r, c) {
    const hellos = kinds(r.frames, "HELLO").length;
    c.ok(hellos >= 2, `HELLO goes on after HELLO_ACK 0 (${hellos})`);
  },
};

/** No host at all: boot, HELLO + HEARTBEAT, the LEDs. */
const BOOT: ScenarioDef = {
  name: "nohost-boot",
  autoAck: false,
  build(s) {
    s.shot(1500, "emu-nohost-boot");
    s.end(3600);
  },
  check() {},
};

const summary: { scenario: string; checks: { ok: boolean; label: string }[] }[] = [];
let failed = 0;
const defs: ScenarioDef[] = [BOOT, ...SCENARIOS].filter((d) => !process.env.ONLY || process.env.ONLY.split(",").includes(d.name));   // ONLY=a,b: those scenarios
const pngs: string[] = [];

async function runScenario(def: ScenarioDef): Promise<{ c: Checker; pngs: string[] }> {
  let { res } = await emulate(def, []);
  let acks: Ack[] = [];
  if (def.autoAck) {                            // (as host-run.ts: until the ACK schedule settles)
    acks = companionAcks(res.frames);
    for (let i = 0; i < 3; i++) {
      res = (await emulate(def, acks)).res;
      const next = companionAcks(res.frames);
      if (sameAcks(next, acks)) break;
      acks = next;
    }
  }
  const shots = new Map<string, Buffer>();
  const pngs: string[] = [];
  const probe = new Scenario(def.name, acks, OFFSET);
  def.build(probe);
  const taken = await Promise.all(probe.toEmu().shots.map(async ([t, name]) => ({ name, lcd: (await emulate(def, acks, t)).lcd })));
  for (const { name, lcd } of taken) {
    const dst = join(work, `${name}.ppm`);
    copyFileSync(lcd, dst);
    shots.set(name.replace(/^emu-/, ""), readFileSync(dst));
    pngs.push(dst, join(evidence, `emu-${name.replace(/^emu-/, "")}.png`));
  }
  const c = new Checker();
  common(def, res, c);
  if (def === BOOT) {
    const hellos = kinds(res.frames, "HELLO").map((f) => f.t);
    c.ok(hellos.length >= 3 && hellos.slice(1).every((t, i) => near(t - (hellos[i] ?? 0), 1000, 2)), `HELLO every 1000 ms with no host (${hellos.join(",")})`);
    const h = kinds(res.frames, "HELLO")[0]?.msg;
    c.ok(h?.kind === "HELLO" && h.protoMin === 1 && h.protoMax === 7 && h.fwMinor === 1, "HELLO: proto 1..7, fw 0.1");
    const keyGlow = Array.from({ length: 27 }, (_, k) => res.ledFractions.get(14 + k) ?? 0);
    c.ok(keyGlow.every((f) => f > 0 && f < 0.05), `no host: all 27 key LEDs at glow level (${[...new Set(keyGlow)].join("/")})`);
    const btns = Array.from({ length: 14 }, (_, b) => res.ledFractions.get(b) ?? 0);
    c.ok(btns.every((f, b) => (b === 1 ? true : f === 0)), "no host: no button LED but OCT+");
  }
  CHECKS[def.name]?.(res, c, shots);
  return { c, pngs };
}

const runs = await Promise.all(defs.map((def) => runScenario(def)));
defs.forEach((def, i) => {
  const { c, pngs: p } = runs[i]!;
  console.log(`== emu ${def.name}`);
  for (const r of c.results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.label}`);
  failed += c.failed;
  summary.push({ scenario: def.name, checks: c.results });
  pngs.push(...p);
});

const py = `import sys
from PIL import Image
a = sys.argv[1:]
for s, d in zip(a[::2], a[1::2]):
    Image.open(s).resize((480, 480), Image.NEAREST).save(d)
`;
const conv = Bun.spawnSync(["python3", "-c", py, ...pngs]);
if (conv.exitCode !== 0) {
  console.error(conv.stderr.toString());
  failed++;
}
const total = summary.reduce((n, s) => n + s.checks.length, 0);
writeFileSync(join(evidence, "results.json"), `${JSON.stringify({ package: fwsc, total, failed, scenarios: summary }, null, 2)}\n`);
console.log(`emulator: ${total - failed} checks passed, ${failed} failed; ${pngs.length / 2} screenshots in ${evidence}`);
process.exit(failed ? 1 : 0);
