#!/usr/bin/env bun
// Full simulated acceptance (priority update): FM-1 simulator on virtual CoreMIDI + the real companion process
// with the Traycer adapter, driven only through simulated device controls, against the disposable chats.
//   bun tools/smoke-traycer/src/e2e.ts --live [--sim-port 4727] [--ui-port 4728] [--only claude]
import { join } from "node:path";
import { parseArgs } from "node:util";
import { listMidiPorts } from "@fm1/device-protocol";
import { ScriptedDriver, SimDevice, VIRTUAL_PORT_NAME, openVirtualMidi, startSimServer } from "@fm1/device-simulator";
import { REPO_ROOT, SmokeContext } from "./context";
import { CompanionProcess } from "./e2e/companion-proc";
import { acceptanceFlow, type FlowResult } from "./e2e/flow";
import { writeE2eReport } from "./e2e/report";

for (const l of ["log", "info", "debug", "warn"] as const) console[l] = (...p: unknown[]) => console.error(...p);
const say = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      live: { type: "boolean", default: false },
      "sim-port": { type: "string", default: "4727" },
      "ui-port": { type: "string", default: "4728" },
      only: { type: "string" },
    },
  });
  if (!values.live) {
    say("usage: fm1-e2e --live   (sends the dictated fixture text to the allowlisted disposable chats)");
    return 2;
  }
  const ports = await listMidiPorts();
  if (ports.inputs.includes(VIRTUAL_PORT_NAME) || ports.outputs.includes(VIRTUAL_PORT_NAME)) {
    say(`refusing: a "${VIRTUAL_PORT_NAME}" port already exists (another simulator is running); the companion would see two`);
    return 2;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(REPO_ROOT, "reports", "evidence", "e2e", `acceptance-${stamp}`);
  const rel = (p: string): string => p.replace(`${REPO_ROOT}/`, "");
  const ctx = new SmokeContext(true, outDir);
  await ctx.start();
  const d = await ctx.disposable();
  const task = (await ctx.adapter.listTasks()).find((t) => t.ref.taskId === d.epicId);
  if (!task) throw new Error("disposable task not listed");
  const targets = [d.claude, d.codex].filter((s) => !values.only || values.only.split(",").includes(s.provider));

  const simPort = Number(values["sim-port"]);
  const device = new SimDevice({ transport: await openVirtualMidi() });
  const sim = await startSimServer({ device, port: simPort });
  device.start();
  const driver = new ScriptedDriver(device);
  const companion = new CompanionProcess(Number(values["ui-port"]), ["--sim", "--fixture-audio", join(REPO_ROOT, "fixtures", "audio", "smoke-16k.wav"), "--warm"]);
  const results: FlowResult[] = [];
  const t0 = performance.now();
  let attachMs: number | null = null;
  let exitCode: number | null = null;
  try {
    say(`simulator ${sim.url} on virtual MIDI "${VIRTUAL_PORT_NAME}"; starting companion (UI port ${companion.uiPort})`);
    await companion.start();
    await driver.waitFor((s) => s.link.phase === "connected" && s.slots.some((x) => x.label !== ""), 20_000);
    attachMs = Math.round(performance.now() - t0);
    say(`device linked and populated ${attachMs} ms after companion start`);
    for (const target of targets) {
      say(`--- ${target.provider} ${target.ref.sessionId.slice(0, 8)} "${target.title}"`);
      const r = await acceptanceFlow(ctx, device, driver, companion, target, task.title, outDir, rel, sim.url);
      for (const st of r.steps) say(`  ${st.ok ? "ok  " : "FAIL"} ${st.step}: ${st.detail}`);
      say(`  timings ${JSON.stringify(r.timings)}`);
      results.push(r);
    }
  } finally {
    exitCode = await companion.stop();
    sim.stop();
    device.stop();
    ctx.writeEvidence("companion-process.log", companion.logLines.join("\n"));
    await ctx.stop();
  }
  const json = ctx.writeEvidence("acceptance.json", { attachMs, companionExit: exitCode, results });
  const md = writeE2eReport({ results, attachMs, evidenceDir: rel(outDir), json, versions: ctx.versions, companionExit: exitCode });
  say(`${results.filter((r) => r.ok).length}/${results.length} passes; report ${md}; evidence ${rel(outDir)}`);
  return results.length > 0 && results.every((r) => r.ok) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`e2e: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(2);
  },
);
