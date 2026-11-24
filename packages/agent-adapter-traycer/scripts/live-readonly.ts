/**
 * Read-only live sanity check of TraycerAgentAdapter against the running host.
 *
 * Does: handshake, listProjects/listTasks/listSessions (a few recent tasks),
 * listApprovals, and listens to the three event feeds for a while.
 * Never: sends prompts, decides approvals, stops agents, creates anything,
 * focuses windows, or watches a chat. Prints counts and ids only, no tokens.
 *
 *   env -u TRAYCER_AGENT_ID -u TRAYCER_EPIC_ID -u TRAYCER_TERMINAL_SPAWN_TOKEN \
 *     bun packages/agent-adapter-traycer/scripts/live-readonly.ts [seconds]
 */
import { effectiveState, type AgentEvent } from "@fm1/agent-core";
import { TraycerAgentAdapter } from "../src/agent/traycer-agent-adapter";

for (const key of ["TRAYCER_AGENT_ID", "TRAYCER_EPIC_ID", "TRAYCER_TERMINAL_SPAWN_TOKEN"]) delete process.env[key];
const seconds = Number(process.argv[2] ?? 10);
const refuse = async (): Promise<{ code: number; stdout: string }> => {
  throw new Error("live-readonly: commands are disabled");
};
const adapter = new TraycerAgentAdapter({ sessionScanLimit: 5, runCommand: refuse });
const events: AgentEvent[] = [];
adapter.subscribe((e) => events.push(e));

const t0 = Date.now();
await adapter.connect();
const connectMs = Date.now() - t0;
const projects = await adapter.listProjects();
const tasks = await adapter.listTasks();
const sessions = await adapter.listSessions();
const approvals = await adapter.listApprovals();
const byState = (list: typeof sessions) =>
  list.reduce<Record<string, number>>((acc, s) => {
    const k = `${s.runtime}:${effectiveState(s.status)}${s.status.observed.state === null && s.status.inferred ? "(inferred)" : ""}`;
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
console.log(
  JSON.stringify(
    {
      connectMs,
      diagnostics: adapter.diagnostics(),
      projects: projects.length,
      projectKinds: projects.reduce<Record<string, number>>((a, p) => ({ ...a, [p.projectId.split(":")[0] ?? "?"]: (a[p.projectId.split(":")[0] ?? "?"] ?? 0) + 1 }), {}),
      tasks: tasks.length,
      sessions: sessions.length,
      providers: sessions.reduce<Record<string, number>>((a, s) => ({ ...a, [s.provider]: (a[s.provider] ?? 0) + 1 }), {}),
      statesAtList: byState(sessions),
      approvalsPending: approvals.length,
      sample: sessions.slice(0, 3).map((s) => ({ ref: s.ref, runtime: s.runtime, provider: s.provider, state: effectiveState(s.status) })),
    },
    null,
    2,
  ),
);
await Bun.sleep(seconds * 1000);
const counts = events.reduce<Record<string, number>>((a, e) => ({ ...a, [e.type]: (a[e.type] ?? 0) + 1 }), {});
const latest = new Map<string, string>();
for (const e of events) if (e.type === "session_upserted") latest.set(`${e.session.ref.taskId}/${e.session.ref.sessionId}`, effectiveState(e.session.status));
console.log(JSON.stringify({ afterSeconds: seconds, eventCounts: counts, upsertedStates: Object.fromEntries(latest), diagnostics: adapter.diagnostics() }, null, 2));
await adapter.disconnect();
process.exit(0);
