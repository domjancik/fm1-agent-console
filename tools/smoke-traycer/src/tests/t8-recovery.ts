// T8: recovery. Companion process killed mid-prompt and restarted; transport drop; host "unavailable" simulated
// with a copy of pid.json pointing at a dead pid (the real host is never touched).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConsole, sessionKey } from "@fm1/agent-core";
import { TraycerAgentAdapter } from "@fm1/agent-adapter-traycer";
import { cleanEnv, sleep, type SmokeContext } from "../context";
import { waitIdle } from "../deliver";
import { GuardedAdapter } from "../guard";
import { RecordBuilder } from "../record";
import { short } from "../redact";
import { marker, markerPrompt, userTurnsWith } from "../transcript";
import type { SmokeTest } from "./types";

const CHILD = join(import.meta.dir, "..", "child-console.ts");

async function runChild(args: string[], killOn?: (line: Record<string, unknown>) => boolean): Promise<Record<string, unknown>[]> {
  const p = Bun.spawn(["bun", CHILD, ...args], { env: cleanEnv(), stdout: "pipe", stderr: "ignore" });
  const lines: Record<string, unknown>[] = [];
  const timer = setTimeout(() => p.kill("SIGKILL"), 90_000);
  const reader = p.stdout.getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
      buf = buf.slice(nl + 1);
      lines.push(line);
      if (killOn?.(line)) p.kill("SIGKILL");
    }
  }
  clearTimeout(timer);
  await p.exited;
  return lines;
}

function deadPid(): number {
  for (let pid = 99_999; pid > 50_000; pid -= 7) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("no free pid found");
}

async function companionRestart(ctx: SmokeContext, r: RecordBuilder): Promise<void> {
  const d = await ctx.disposable();
  await waitIdle(ctx, d.claude);
  const m = marker("T8");
  const first = await runChild(["send", d.epicId, d.claude.ref.sessionId, markerPrompt(m), "--live"], (l) => l.stage === "backend_acknowledged");
  const keys1 = (first[0]?.keys as string[] | undefined) ?? [];
  r.check(first.some((l) => l.stage === "backend_acknowledged"), `companion process killed (SIGKILL) right after backend_acknowledged; stages seen ${first.flatMap((l) => (l.stage ? [l.stage] : [])).join(">")}`);
  const second = await runChild(["list", d.epicId]);
  const keys2 = (second[0]?.keys as string[] | undefined) ?? [];
  r.check(keys1.length > 0 && keys1.join() === keys2.join(), `restarted process lists the same ${keys2.length} session keys`);
  await sleep(2000);
  await waitIdle(ctx, d.claude);
  let turns = 0;
  for (let i = 0; i < 20; i++) {
    turns = userTurnsWith(await ctx.transcript(d.claude.ref), m);
    if (turns > 0) break;
    await sleep(500);
  }
  r.check(turns === 1, `in-flight prompt delivered exactly once after the crash (${turns} user turn(s))`);
}

async function transportDrop(ctx: SmokeContext, r: RecordBuilder): Promise<void> {
  const d = await ctx.disposable();
  const before = (await ctx.adapter.listSessions(d.epicId)).map((s) => sessionKey(s.ref)).sort();
  const from = ctx.events.length;
  await ctx.adapter.disconnect();
  await ctx.adapter.connect();
  const after = (await ctx.adapter.listSessions(d.epicId)).map((s) => sessionKey(s.ref)).sort();
  const conn = ctx.events.slice(from).flatMap((x) => (x.event.type === "connection" ? [x.event.state] : []));
  r.check(before.join() === after.join() && conn.join(">") === "disconnected>connected", `transport drop: ${conn.join(">")}, keys stable (${after.length})`);
}

async function hostUnavailable(ctx: SmokeContext, r: RecordBuilder): Promise<void> {
  const d = await ctx.disposable();
  const real = readFileSync(join(homedir(), ".traycer", "host", "pid.json"), "utf8");
  const bogusDir = mkdtempSync(join(tmpdir(), "fm1-smoke-host-"));
  const bogus = join(bogusDir, "pid.json");
  writeFileSync(bogus, JSON.stringify({ ...(JSON.parse(real) as Record<string, unknown>), pid: deadPid() }));
  const adapter = new GuardedAdapter(new TraycerAgentAdapter({ pidFilePath: bogus, sessionScanLimit: 25, backoff: { initialMs: 250, maxMs: 1_000, factor: 2 } }), ctx.allowlist, true);
  const ac = new AgentConsole({ adapter });
  try {
    await ac.start();
    r.check(ac.registry.connection() === "disconnected" && ac.view().status.text === "Traycer offline", `bogus pid.json: console ${ac.registry.connection()}, device status "${ac.view().status.text}"`);
    const m = marker("T8DOWN");
    const viaConsole = await ac.dispatcher.dispatch(`smoke-t8-down-${crypto.randomUUID()}`, { mode: "continue-session", target: d.claude.ref, label: "x" }, markerPrompt(m));
    const direct = await adapter.sendPrompt(d.claude.ref, markerPrompt(m), `smoke-t8-down2-${crypto.randomUUID()}`);
    r.check(viaConsole.stage === "target_unavailable" && direct.stage === "failed", `while down: console dispatch ${viaConsole.stage}, adapter sendPrompt ${direct.stage} (${direct.message ?? ""})`);
    r.check(userTurnsWith(await ctx.transcript(d.claude.ref), m) === 0, "nothing reached the chat while the host was unavailable");
    const t0 = performance.now();
    writeFileSync(bogus, real); // the host "comes back"
    for (let i = 0; i < 100 && !ac.registry.ready(); i++) await sleep(100);
    const back = Math.round(performance.now() - t0);
    const keys = ac.registry.sessions().filter((e) => e.session.ref.taskId === d.epicId).map((e) => e.key).sort();
    const want = (await ctx.adapter.listSessions(d.epicId)).map((s) => sessionKey(s.ref)).sort();
    r.check(ac.registry.ready() && keys.join() === want.join(), `host back: console resynced in ${back} ms with the same ${keys.length} keys`);
    r.metric("host_back_to_resync_ms", back);
    await sleep(1500);
    const feeds = (adapter.inner as TraycerAgentAdapter).diagnostics().feeds;
    r.check(Object.values(feeds).every((f) => f === "open"), `event feeds open after the late connect ${JSON.stringify(feeds)}`);
  } finally {
    await ac.stop();
  }
}

export const t8: SmokeTest = {
  id: "T8",
  title: "Recovery",
  live: true,
  async run(ctx) {
    const d = await ctx.disposable();
    const r = new RecordBuilder(
      {
        id: "T8",
        provider: "claude (haiku)",
        sessionType: "GUI chat",
        target: short(d.claude.ref.sessionId),
        operation: "Kill the console process after backend ack and restart it; adapter disconnect/connect; console on a pid.json copy with a dead pid, then restored",
        expected: "State resyncs; ids stable; in-flight prompt not duplicated; actions refused while the host is unavailable",
      },
      ctx.versions,
    );
    await companionRestart(ctx, r);
    await transportDrop(ctx, r);
    await hostUnavailable(ctx, r);
    r.note("'Restart a disposable agent' not exercised separately (T6 stop + later prompts cover the agent coming back)");
    return r.build();
  },
};
