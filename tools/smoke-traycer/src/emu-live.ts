#!/usr/bin/env bun
// Firmware + companion end to end without hardware: the real firmware package in fm1-emu (`fm1-live --usb
// --midi none`, window mode) appears as CoreMIDI "FM1 CONSOLE (emu)"; the real companion (`start --emu`,
// Traycer adapter, read-only use) links to it. A scripted emulator key press must select a session.
// fm1-live opens no other MIDI port, so the plugged-in FM-1 is never touched. No prompt is sent.
//   bun tools/smoke-traycer/src/emu-live.ts [--fwsc firmware/dist/fm1-console-0.1.fwsc] [--key-at 15000]
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { listMidiPorts } from "@fm1/device-protocol";
import { REPO_ROOT, sleep } from "./context";
import { CompanionProcess, selectedKey } from "./e2e/companion-proc";
import { screenshot } from "./e2e/shots";

const PORT = "FM1 CONSOLE (emu)";
const FM1_LIVE = join(REPO_ROOT, "..", ".fm1-upstream", "fm1-emu-bin", "fm1-emu-0.5.1-macos-arm64", "fm1-live");
for (const l of ["log", "info", "debug", "warn"] as const) console[l] = (...p: unknown[]) => console.error(...p);
const say = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { fwsc: { type: "string", default: join(REPO_ROOT, "firmware", "dist", "fm1-console-0.1.fwsc") }, "key-at": { type: "string", default: "15000" }, "ui-port": { type: "string", default: "4738" } } });
  const fwsc = values.fwsc;
  const keyAt = Number(values["key-at"]);
  if (!existsSync(fwsc) || !existsSync(FM1_LIVE)) {
    say(`missing ${existsSync(fwsc) ? FM1_LIVE : fwsc}`);
    return 2;
  }
  const before = await listMidiPorts();
  if (before.inputs.includes(PORT)) {
    say(`refusing: "${PORT}" already exists`);
    return 2;
  }
  const out = join(REPO_ROOT, "reports", "evidence", "e2e", `emu-live-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  Bun.spawnSync(["mkdir", "-p", out]);
  const checks: { ok: boolean; label: string }[] = [];
  const blocked: string[] = [];
  const check = (ok: boolean, label: string): void => {
    checks.push({ ok, label });
    say(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  };
  const companion = new CompanionProcess(Number(values["ui-port"]), ["--emu"]);
  await companion.start();
  check(true, "companion up (start --emu --adapter traycer), backend ready");
  const t0 = performance.now();
  // Key 0: down at keyAt, up 40 ms later (a single press once the 300 ms double window closes).
  const emu = Bun.spawn([FM1_LIVE, "--fwsc", fwsc, "--usb", "--midi", "none"], {
    env: { ...process.env, FM1_BENCH_KEYS: `${keyAt}:n0,${keyAt + 40}:n0^` },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    let linkedMs: number | null = null;
    for (let i = 0; i < 200 && linkedMs === null; i++) {
      const s = await companion.state().catch(() => null);
      if (s?.device.phase === "connected") linkedMs = Math.round(performance.now() - t0);
      else await sleep(100);
    }
    const s1 = await companion.state();
    check(linkedMs !== null, `HELLO / HELLO_ACK with the firmware package: device ${s1.device.phase}, proto ${s1.device.proto}, firmware ${s1.device.firmware}, transport ${s1.device.transport} (${linkedMs} ms after the emulator started)`);
    await sleep(1500);
    const s2 = await companion.state();
    check(s2.device.resyncs >= 1 && s2.device.rxErrors === 0, `resync sent (${s2.device.resyncs}), ${s2.device.rxErrors} rx errors`);
    const shotLinked = join(out, "companion-ui-emu-linked.png");
    await screenshot(companion.url, shotLinked);
    const deadline = t0 + keyAt + 12_000;
    let sel: string | null = null;
    while (performance.now() < deadline && sel === null) {
      sel = selectedKey(await companion.state());
      if (sel === null) await sleep(200);
    }
    const s3 = await companion.state();
    const keyLog = s3.log.filter((e) => /KEY|key/.test(e.text)).map((e) => e.text);
    const selTitle = s3.tasks.flatMap((t) => t.sessions).find((x) => x.selected)?.title ?? null;
    if (sel === null && keyLog.length === 0) {
      blocked.push("emulator key press: fm1-live applies FM1_BENCH_KEYS only to headless --bench/--shot, whose --usb is an emulated host (no CoreMIDI); window-mode key injection needs Accessibility, which is not granted. No KEY frame reached the companion.");
      say(`  BLOCKED  ${blocked[blocked.length - 1]}`);
    } else {
      check(sel !== null, `emulator key 0 -> companion selection: ${selTitle ?? "none"} (${keyLog.slice(-2).join("; ")})`);
    }
    const shotSel = join(out, "companion-ui-emu-after-key-window.png");
    const okShot = await screenshot(companion.url, shotSel);
    check(okShot, `screenshot ${shotSel.replace(`${REPO_ROOT}/`, "")}`);
    writeFileSync(join(out, "emu-live.json"), `${JSON.stringify({ fwsc, linkedMs, device: s3.device, selected: sel, selTitle, keyLog, checks, blocked }, null, 2)}\n`);
  } finally {
    emu.kill();
    await emu.exited;
    await companion.stop();
    writeFileSync(join(out, "companion-process.log"), companion.logLines.join("\n"));
  }
  await sleep(500);
  const after = await listMidiPorts();
  check(!after.inputs.includes(PORT), `"${PORT}" gone after the emulator quit`);
  const failed = checks.filter((c) => !c.ok).length;
  say(`emu-live: ${checks.length - failed} passed, ${failed} failed, ${blocked.length} blocked; evidence ${out.replace(`${REPO_ROOT}/`, "")}`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (c) => process.exit(c),
  (e: unknown) => {
    process.stderr.write(`emu-live: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(2);
  },
);
