// SPDX-License-Identifier: GPL-3.0-only
// Runs every scenario on the host build of the firmware (tests/host.c), checks the device's frames with the
// TypeScript codec, and saves the named screenshots as PNG evidence.
//   bun tests/console/scenario/host-run.ts BUILD/console-host WORKDIR EVIDENCE_DIR
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Scenario, type Ack, companionAcks, sameAcks } from "./builder.ts";
import { parseHostOutput } from "./parse.ts";
import { Checker, RANKED6_PREFIX, SCENARIOS, commonChecks, type Run, type ScenarioDef } from "./scenarios.ts";

function args(): [string, string, string] {
  const [a, b, c] = process.argv.slice(2);
  if (!a || !b || !c) {
    console.error("usage: host-run.ts HOST_BINARY WORKDIR EVIDENCE_DIR");
    process.exit(2);
  }
  return [a, b, c];
}
const [bin, work, evidence] = args();
mkdirSync(work, { recursive: true });
mkdirSync(evidence, { recursive: true });

function runOnce(def: ScenarioDef, acks: readonly Ack[]) {
  const s = new Scenario(def.name, acks);
  def.build(s);
  const { script, delivered, shots, leds } = s.toHostScript();
  const scriptPath = join(work, `${def.name}.txt`);
  writeFileSync(scriptPath, script);
  const outPrefix = join(work, def.name);
  const p = Bun.spawnSync([bin, outPrefix, scriptPath]);
  const stdout = p.stdout.toString();
  writeFileSync(join(work, `${def.name}.log`), stdout);
  if (p.exitCode !== 0) throw new Error(`${def.name}: host binary exited ${p.exitCode}: ${p.stderr.toString()}`);
  return { out: parseHostOutput(stdout), delivered, shots, leds, outPrefix, endMs: s.endMs };
}

const summary: { scenario: string; checks: { ok: boolean; label: string }[] }[] = [];
const pngs: [string, string][] = [];
const allShots = new Map<string, string>();     // every shot of the run by name (the RANKED-under-6 comparison below)
let failed = 0;

const only = process.env.FM1C_SCENARIOS?.split(",");   // (run.sh: the software-scroll fallback build runs a subset)
for (const def of SCENARIOS.filter((d) => !only || only.includes(d.name))) {
  let res = runOnce(def, []);
  if (def.autoAck) {
    // a live companion ACKs each input frame a few ms after it arrives: schedule those and run again, until the
    // schedule settles (an unACKed frame changes what follows it: retransmissions, SEQs)
    let acks = companionAcks(res.out.frames);
    for (let i = 0; i < 4; i++) {
      res = runOnce(def, acks);
      const next = companionAcks(res.out.frames);
      if (sameAcks(next, acks)) break;
      acks = next;
    }
  }
  const ledTimes = new Map<string, number>();
  for (const [t, tag] of res.leds) ledTimes.set(tag, t);
  for (const [t, name] of res.shots) ledTimes.set(`shot:${name}`, t);
  const shotByName = new Map<string, string>();
  for (const [t, name] of res.shots) shotByName.set(name, `${res.outPrefix}-${t}.ppm`);
  const run: Run = {
    out: res.out,
    delivered: res.delivered,
    leds: (tag) => {
      const t = ledTimes.get(tag);
      return res.out.leds.find((l) => l.t === t);
    },
    shot: (name) => {
      const f = shotByName.get(name);
      try {
        return f ? new Uint8Array(readFileSync(f)) : undefined;
      } catch {
        return undefined;
      }
    },
  };
  const c = new Checker();
  commonChecks(def, run, c, res.endMs);
  def.check(run, c);
  for (const [name, file] of shotByName) { pngs.push([file, join(evidence, `${name}.png`)]); allShots.set(name, file); }
  console.log(`== ${def.name}`);
  for (const r of c.results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.label}`);
  failed += c.failed;
  summary.push({ scenario: def.name, checks: c.results });
}

// docs/ui-v3.md section 10.12: RANKED under protocol 6 draws exactly the version 5 pixels; the help overlay's line 1
// (rows 18-37) is the one difference allowed (FM1C_HELP_BASE6)
{
  const c = new Checker();
  const rows = (a: Buffer, b: Buffer): number[] => {
    const head = a.length - 240 * 240 * 3, out: number[] = [];
    for (let y = 0; y < 240; y++)
      if (a.compare(b, head + y * 720, head + (y + 1) * 720, head + y * 720, head + (y + 1) * 720) !== 0) out.push(y);
    return out;
  };
  let n = 0, stepDiff = 0;
  for (const [name, file] of allShots) {
    if (!name.startsWith(RANKED6_PREFIX)) continue;
    const base = allShots.get(name.slice(RANKED6_PREFIX.length));
    if (!base) continue;
    n++;
    const a = readFileSync(base), b = readFileSync(file);
    if (a.equals(b)) { c.ok(true, `${name}: byte-identical to the version 5 shot`); continue; }
    if (/-\d+$/.test(name) && allShots.has(name.replace(/-\d+$/, "-done"))) {
      // a shot taken mid-transition shows whichever pass ran last: its time depends on where the trigger frame's END CC
      // lands, and the version 6 SET_VIEW is a byte longer (compare_shots.py skips these for the emulator alike); the
      // scenario's -done twin is compared as every other shot
      c.ok(true, `${name}: a transition step shot, timing-dependent (not compared; its -done shot is)`);
      stepDiff++;
      continue;
    }
    const d = a.length === b.length ? rows(a, b) : [-1];
    const help = d.length > 0 && d.every((y) => y >= 18 && y <= 37);
    c.ok(help && name.includes("help"), `${name}: ${help ? "help line 1 differs (rows " + d[0] + "-" + d.at(-1) + "), the rest identical" : `differs in rows ${d.slice(0, 6).join(",")}...`}`);
  }
  if (!only) c.ok(n >= 40, `RANKED under protocol 6: ${n} shots compared with their version 5 twins, ${stepDiff} step shot(s) differ in timing only`);
  console.log("== v6-ranked: the version 5 screens under protocol 6");
  for (const r of c.results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.label}`);
  failed += c.failed;
  summary.push({ scenario: "v6-ranked-pixels", checks: c.results });
}

// PPM -> PNG at 2x (nearest neighbour), as Dinghy's run_host.sh does
const py = `import sys
from PIL import Image
args = sys.argv[1:]
for src, dst in zip(args[::2], args[1::2]):
    Image.open(src).resize((480, 480), Image.NEAREST).save(dst)
`;
const conv = Bun.spawnSync(["python3", "-c", py, ...pngs.flat()]);
if (conv.exitCode !== 0) {
  console.error(conv.stderr.toString());
  failed++;
}
const total = summary.reduce((n, s) => n + s.checks.length, 0);
writeFileSync(join(evidence, "results.json"), `${JSON.stringify({ total, failed, scenarios: summary }, null, 2)}\n`);
console.log(`host scenarios: ${total - failed} checks passed, ${failed} failed; ${pngs.length} screenshots in ${evidence}`);
process.exit(failed ? 1 : 0);
