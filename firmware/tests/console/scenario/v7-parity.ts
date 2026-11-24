// SPDX-License-Identifier: GPL-3.0-only
// Protocol version 7 (docs/ui-v3.md section 13.7): the firmware's host-mode screenshots of the v7 scenarios against
// the simulator's renderV4 of the same frames, as packages/device-simulator/test/v4-firmware-parity.test.ts does for
// version 4: every delivered host frame goes through the TypeScript codec into the simulator's state, drawn at the
// shot's device time; the target is byte equality in RGB565. Run after host-run.ts (it reads that run's PPMs).
//   bun tests/console/scenario/v7-parity.ts WORKDIR
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Scenario } from "./builder.ts";
import { SCENARIOS } from "./scenarios.ts";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const work = process.argv[2];
if (!work) {
  console.error("usage: v7-parity.ts WORKDIR");
  process.exit(2);
}
// (computed paths: the simulator and the codec are run, not type-checked, from the firmware's harness)
const proto = await import(`${ROOT}packages/device-protocol/src/index.ts`);
const sim = await import(`${ROOT}packages/device-simulator/src/state.ts`);
const screen = await import(`${ROOT}packages/device-simulator/src/v4/screen.ts`);

/** the P6 screenshot's pixels as RGB565 (host.c expands 565 by << 3 / << 2, so >> gives the panel's value back) */
function ppm565(file: string): Uint16Array {
  const b = readFileSync(file);
  let i = 0, fields = 0;
  while (fields < 4) {
    while (/\s/.test(String.fromCharCode(b[i] ?? 0))) i++;
    while (!/\s/.test(String.fromCharCode(b[i] ?? 32))) i++;
    fields++;
  }
  i++;
  const out = new Uint16Array(240 * 240);
  for (let p = 0; p < out.length; p++, i += 3) out[p] = (((b[i] ?? 0) >> 3) << 11) | (((b[i + 1] ?? 0) >> 2) << 5) | ((b[i + 2] ?? 0) >> 3);
  return out;
}

let failed = 0, compared = 0;
for (const def of SCENARIOS.filter((d) => d.name.startsWith("v7-"))) {
  const sc = new Scenario(def.name);
  def.build(sc);
  const { delivered, shots } = sc.toHostScript();
  for (const [t, name] of shots) {
    const file = join(work, `${def.name}-${t}.ppm`);
    if (!existsSync(file)) { console.log(`  FAIL  ${name}: no screenshot ${file}`); failed++; continue; }
    let s = sim.initialState(7), agreed = 7;
    for (const d of delivered) {
      if (!d.msg || d.at > t) continue;
      if (d.msg.kind === "HELLO_ACK") agreed = d.msg.proto;
      const r = proto.decode(proto.encode(d.msg, 1));
      if (r.ok) s = sim.applyHostMessage(s, r.value.message, d.at);
    }
    s = { ...s, link: { ...s.link, phase: "connected", proto: agreed } };
    const fb = screen.renderV4(s, t);
    const fw = ppm565(file);
    let n = 0, first = "";
    for (let y = 0; y < 240; y++)
      for (let x = 0; x < 240; x++)
        if (fb.get(x, y) !== fw[y * 240 + x]) { if (!n) first = `${x},${y}`; n++; }
    compared++;
    if (n) failed++;
    console.log(`  ${n ? "FAIL" : "PASS"}  ${name} (protocol ${agreed}, ${t} ms): ${n} px differ from the simulator${n ? `, first at ${first}` : ""}`);
  }
}
console.log(`v7 parity: ${compared - failed} of ${compared} shots pixel-identical to the simulator`);
process.exit(failed || !compared ? 1 : 0);
