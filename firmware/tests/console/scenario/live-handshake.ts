// SPDX-License-Identifier: GPL-3.0-only
// The package in fm1-live (window mode, real time) with --usb: it appears on this Mac as the CoreMIDI device
// "FM1 CONSOLE (emu)". The TypeScript host link (packages/device-protocol) opens that port by name, answers the
// device's HELLO, and checks the ACKs and heartbeats that come back. --midi none: fm1-live opens no other port.
//   bun tests/console/scenario/live-handshake.ts PACKAGE.fwsc FM1_LIVE
import { resolve } from "node:path";
import { Link, listMidiPorts, openCoreMidi, type MidiTransport } from "../../../../packages/device-protocol/src/index.ts";

const PORT = "FM1 CONSOLE (emu)";
function args(): [string, string] {
  const [a, b] = process.argv.slice(2).map((x) => resolve(x));
  if (!a || !b) {
    console.error("usage: live-handshake.ts PACKAGE.fwsc FM1_LIVE");
    process.exit(2);
  }
  return [a, b];
}
const [fwsc, live] = args();

const results: { ok: boolean; label: string }[] = [];
const check = (ok: boolean, label: string): void => {
  results.push({ ok, label });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForPort(ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const p = await listMidiPorts();
    if (p.inputs.includes(PORT) && p.outputs.includes(PORT)) return true;
    await sleep(200);
  }
  return false;
}

async function main(): Promise<number> {
  const before = await listMidiPorts();
  check(!before.inputs.includes(PORT), `no "${PORT}" before the emulator runs`);
  const emu = Bun.spawn([live, "--fwsc", fwsc, "--usb", "--midi", "none"], { stdout: "pipe", stderr: "pipe" });
  let transport: MidiTransport | undefined;
  try {
    check(await waitForPort(15000), `fm1-live enumerated the package as CoreMIDI "${PORT}"`);
    transport = await openCoreMidi({ kind: "ports", input: PORT, output: PORT });
    const link = Link.host({ transport, hostSession: 777 });
    const seen = { hello: 0, heartbeat: 0, acked: 0 };
    let negotiated: number | undefined;
    link.on("message", ({ message }) => {
      if (message.kind === "HELLO") seen.hello++;
      if (message.kind === "HEARTBEAT") seen.heartbeat++;
    });
    link.on("negotiated", ({ proto }) => {
      negotiated = proto;
    });
    link.start();
    const until = Date.now() + 5000;
    while (negotiated === undefined && Date.now() < until) await sleep(50);
    check(seen.hello >= 1 && negotiated === 1, `HELLO from the device, HELLO_ACK from the TS link: proto ${negotiated}`);
    const r1 = await link.sendAndWait({ kind: "SET_VIEW", view: "sessions", page: 0, pages: 1, title: "live handshake" });
    const r2 = await link.sendAndWait({ kind: "SET_SLOT", key: 0, state: "working", flags: { selected: true, codex: false, stale: false, pinned: false }, label: "emu" });
    check(r1.outcome === "acked" && r2.outcome === "acked", `SET_VIEW and SET_SLOT acknowledged by the firmware (${r1.outcome}, ${r2.outcome})`);
    await sleep(2500);
    check(seen.heartbeat >= 2 && link.peerAlive, `device heartbeats over CoreMIDI (${seen.heartbeat} in 2.5 s), link alive`);
    check(link.rxErrors === 0, `no invalid frames from the device (${link.rxErrors})`);
    link.close();
  } finally {
    transport?.close();
    emu.kill();
    await emu.exited;
  }
  await sleep(500);
  const after = await listMidiPorts();
  check(!after.inputs.includes(PORT), `"${PORT}" gone after the emulator quit`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`live handshake: ${results.length - failed} checks passed, ${failed} failed`);
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
