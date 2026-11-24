#!/usr/bin/env bun
// T8 helper: a stand-in companion process (AgentConsole + guarded TraycerAgentAdapter) that the runner kills.
//   child-console.ts list <epicId>                      prints {"keys":[...]} and exits
//   child-console.ts send <epicId> <chatId> <text> --live  prints keys, then each delivery stage; waits to be killed
import { AgentConsole, sessionKey } from "@fm1/agent-core";
import { TraycerAgentAdapter } from "@fm1/agent-adapter-traycer";
import { Allowlist } from "./allowlist";
import { REPO_ROOT, STRIPPED } from "./context";
import { GuardedAdapter } from "./guard";
import { join } from "node:path";

for (const k of STRIPPED) delete process.env[k];
for (const l of ["log", "info", "debug", "warn"] as const) console[l] = () => undefined;
const out = (v: unknown): void => {
  process.stdout.write(`${JSON.stringify(v)}\n`);
};

const [mode, epicId, chatId, text] = process.argv.slice(2);
const live = process.argv.includes("--live");
const allowlist = Allowlist.load(join(REPO_ROOT, "reports", "disposable-allowlist.json"));
const adapter = new GuardedAdapter(new TraycerAgentAdapter({ sessionScanLimit: 25 }), allowlist, live);
const ac = new AgentConsole({ adapter });
await ac.start();
const keys = ac.registry.sessions().filter((e) => e.session.ref.taskId === epicId).map((e) => e.key).sort();
out({ pid: process.pid, keys });
if (mode === "send" && epicId && chatId && text) {
  const entry = ac.registry.sessions().find((e) => e.session.ref.taskId === epicId && e.session.ref.sessionId === chatId);
  if (!entry) {
    out({ error: "target not listed" });
    process.exit(2);
  }
  adapter.subscribe((e) => {
    if (e.type === "command_progress") out({ stage: e.stage });
  });
  const id = `smoke-t8-${crypto.randomUUID()}`;
  ac.registry.select(sessionKey(entry.session.ref));
  const r = await ac.dispatcher.dispatch(id, { mode: "continue-session", target: entry.session.ref, label: entry.session.title }, text);
  out({ result: r.stage, requestId: id });
  await new Promise(() => undefined); // keep running until killed (the "crash")
}
await ac.stop();
process.exit(0);
