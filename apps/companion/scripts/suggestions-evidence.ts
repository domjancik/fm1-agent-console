// Evidence for docs/ui-v3.md section 11 (suggested next prompts): the frames the real host pipeline (agent-core view ->
// companion render) sends for the bubble's `Next:` row and the review label, drawn by the simulator and, when a
// firmware host-mode binary is given, by the firmware itself (tests/host.c harness; no device, no flashing).
//   bun apps/companion/scripts/suggestions-evidence.ts [CONSOLE_HOST_BINARY [WORKDIR]]
// Writes reports/evidence/ui-v3/suggestions/{sim,host}/*.png and results.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentConsole, fixturePath, loadFixture, MockAdapter, type DeviceView } from "@fm1/agent-core";
import type { HostMessage } from "@fm1/device-protocol";
import { applyHostMessage, initialState, type DeviceState } from "../../../packages/device-simulator/src/state";
import { expand565 } from "../../../packages/device-simulator/src/v4/raster";
import { renderV4 } from "../../../packages/device-simulator/src/v4/screen";
import { writePng } from "../../../packages/device-simulator/test/png";
import { Scenario } from "../../../firmware/tests/console/scenario/builder.ts";
import { framesFor, fullFrames } from "../src/device/render";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const OUT = join(ROOT, "reports/evidence/ui-v3/suggestions");
const PROTO = 6; // the reviewed firmware package speaks 1-6; RANKED keys, so this is also the version 5 drawing
const [hostBin, workArg] = process.argv.slice(2);

let t = 1_800_000_100_000;
const adapter = new MockAdapter(loadFixture(fixturePath("mixed")), { now: () => t });
const c = new AgentConsole({ adapter, now: () => t, newRequestId: () => "req-evidence" });
await c.start();
c.setProtocol(PROTO);
await c.handleInput({ kind: "encoder", encoder: "K1", delta: 1 }); // RECENT: every fixture chat
const idle = c.registry.sessions().find((e) => e.session.ref.sessionId === "s-claude-idle");
if (!idle) throw new Error("fixture changed");
await c.handleInput({ kind: "key", key: c.state.layouts.sessions.slots.indexOf(idle.key) % 27, gesture: "single" });
adapter.upsertSession({ ...idle.session, details: { lastMessage: "Done. The retry path now backs off exponentially and the two new tests pass.", lastMessageAt: t - 60_000 } });
adapter.setSuggestions(idle.session.ref, ["Run the full test suite and fix what fails", "Update the docs for the new flag", "Open a PR with the change"]);

const scenes: Array<{ name: string; view: DeviceView }> = [];
c.setLayouts({ sessions: "buddy" });
scenes.push({ name: "suggest-buddy-next", view: c.view() });
c.setLayouts({ sessions: "list" });
scenes.push({ name: "suggest-list-next", view: c.view() });
c.setLayouts({ sessions: "buddy" });
await c.handleInput({ kind: "button", button: "REC", edge: "down" });
t += 120; // a short tap (REC_TAP_MS 350)
await c.handleInput({ kind: "button", button: "REC", edge: "up" });
scenes.push({ name: "suggest-review-1of3", view: c.view() });
await c.handleInput({ kind: "encoder", encoder: "PRESETS", delta: 1 });
scenes.push({ name: "suggest-review-2of3", view: c.view() });
await c.stop();

const framesOf = (v: DeviceView): HostMessage[] => framesFor(PROTO, fullFrames(v));
const simState = (msgs: HostMessage[]): DeviceState => {
  const s0 = initialState(PROTO);
  const start: DeviceState = { ...s0, link: { ...s0.link, phase: "connected", proto: PROTO } };
  return msgs.reduce<DeviceState>((a, m) => applyHostMessage(a, m, 0), start);
};
const rgbOf = (fb: ReturnType<typeof renderV4>): Uint8Array => {
  const rgb = new Uint8Array(240 * 240 * 3);
  for (let i = 0; i < 240 * 240; i++) rgb.set(expand565(fb.px[i] ?? 0), i * 3);
  return rgb;
};

mkdirSync(join(OUT, "sim"), { recursive: true });
const results: Record<string, unknown>[] = [];
const sim = new Map<string, Uint8Array>();
for (const { name, view } of scenes) {
  const rgb = rgbOf(renderV4(simState(framesOf(view)), 0));
  sim.set(name, rgb);
  writeFileSync(join(OUT, "sim", `${name}.png`), writePng({ w: 240, h: 240, rgb }, 2));
  results.push({ scene: name, view: view.view, text: view.text?.slice(0, 7).map((r) => `${r.style}:${r.text}`), hint: view.detail.lines[3] });
}

if (hostBin) {
  // Firmware host mode: HELLO_ACK 6, the scene's full resync, heartbeats, one screenshot (tests/host.c writes PPM).
  const work = workArg ?? join(OUT, ".work");
  mkdirSync(work, { recursive: true });
  mkdirSync(join(OUT, "host"), { recursive: true });
  for (const { name, view } of scenes) {
    const s = new Scenario(name);
    s.host(200, { kind: "HELLO_ACK", proto: PROTO, hostSession: 4242, reason: "" });
    for (const m of framesOf(view)) s.host(220, m);
    s.heartbeats(1000, 3000, 1);
    s.shot(1500, name);
    s.end(2200);
    const { script, shots } = s.toHostScript();
    const scriptPath = join(work, `${name}.txt`);
    writeFileSync(scriptPath, script);
    const p = Bun.spawnSync([hostBin, join(work, name), scriptPath]);
    if (p.exitCode !== 0) throw new Error(`${name}: host binary exited ${p.exitCode}`);
    const [shotT] = [...shots.keys()];
    const ppm = new Uint8Array(readFileSync(join(work, `${name}-${shotT}.ppm`)));
    const rgb = ppm.subarray(ppm.length - 240 * 240 * 3);
    writeFileSync(join(OUT, "host", `${name}.png`), writePng({ w: 240, h: 240, rgb: new Uint8Array(rgb) }, 2));
    // Pixels that differ between firmware and simulator, compared as RGB565 (the PPM and the simulator expand 565 to
    // 8 bits differently). The hero (x 0-59, y 18-67) animates on its own clock and is left out.
    const a = sim.get(name)!;
    const q = (v: number, bits: number): number => v >> (8 - bits);
    let diff = 0;
    const rows = new Set<number>();
    for (let y = 0; y < 240; y++)
      for (let x = 0; x < 240; x++) {
        if (x < 60 && y >= 18 && y < 68) continue;
        const i = (y * 240 + x) * 3;
        if (q(a[i]!, 5) !== q(rgb[i]!, 5) || q(a[i + 1]!, 6) !== q(rgb[i + 1]!, 6) || q(a[i + 2]!, 5) !== q(rgb[i + 2]!, 5)) {
          diff++;
          rows.add(y);
        }
      }
    const r = results.find((x) => x.scene === name)!;
    r.hostVsSimDiffPixels = diff;
    r.hostVsSimDiffRows = [...rows].sort((m, n) => m - n);
  }
}
writeFileSync(join(OUT, "results.json"), `${JSON.stringify({ proto: PROTO, firmwareHost: Boolean(hostBin), scenes: results }, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));
