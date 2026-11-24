// T0: host discovery, read-only.
import { effectiveState } from "@fm1/agent-core";
import { RecordBuilder } from "../record";
import { short } from "../redact";
import { cliAgents } from "./cli-agents";
import type { SmokeTest } from "./types";

export const t0: SmokeTest = {
  id: "T0",
  title: "Host discovery",
  live: false,
  async run(ctx) {
    const d = await ctx.disposable();
    const r = new RecordBuilder(
      {
        id: "T0",
        provider: "claude + codex",
        sessionType: "GUI chat",
        target: `epic ${short(d.epicId)} (read only)`,
        operation: "TraycerAgentAdapter connect, listProjects/listTasks/listSessions/listApprovals; `traycer agent list --json --all` cross-check",
        expected: "Connects without disturbing Desktop; stable ids; list agrees with the CLI; nothing modified",
      },
      ctx.versions,
    );
    const diag = ctx.raw.diagnostics();
    r.check(diag.link === "connected", `link ${diag.link}, client kind ${diag.clientKind}, host ${diag.endpoint?.version} pid ${diag.endpoint?.pid}`);
    r.check(Object.values(diag.feeds).every((f) => f === "open"), `feeds ${JSON.stringify(diag.feeds)}`);
    const [projects, tasks, sessions, approvals] = await Promise.all([
      ctx.adapter.listProjects(),
      ctx.adapter.listTasks(),
      ctx.adapter.listSessions(),
      ctx.adapter.listApprovals(),
    ]);
    const providers = sessions.reduce<Record<string, number>>((a, s) => ({ ...a, [`${s.provider}/${s.runtime}`]: (a[`${s.provider}/${s.runtime}`] ?? 0) + 1 }), {});
    const unknown = sessions.filter((s) => s.status.observed.state === null && !s.status.inferred).length;
    r.note(`${projects.length} projects, ${tasks.length} tasks, ${sessions.length} sessions ${JSON.stringify(providers)}, ${approvals.length} pending approvals, ${unknown} with no state at all`);
    r.metric("tasks", tasks.length);
    r.metric("sessions", sessions.length);

    const again = await ctx.adapter.listSessions(d.epicId);
    const ids = (xs: { ref: { sessionId: string } }[]) => xs.map((s) => s.ref.sessionId).sort().join(",");
    r.check(ids(again) === ids(sessions.filter((s) => s.ref.taskId === d.epicId)), "disposable task ids stable across two listings");
    const cli = await cliAgents(d.epicId, d.claude.ref.sessionId);
    const cliIds = cli.map((a) => a.id).sort().join(",");
    r.check(cliIds === ids(again), `adapter ids == CLI ids for the disposable task (${cli.length} agents)`);
    for (const s of [d.claude, d.codex]) {
      const c = cli.find((a) => a.id === s.ref.sessionId);
      r.check(c !== undefined && c.harnessId === s.provider && c.surface === "gui", `${short(s.ref.sessionId)}: ${s.provider}/${s.runtime} matches CLI ${c?.harnessId}/${c?.surface}, state ${effectiveState(s.status)}`);
    }
    r.check(ctx.adapter.mutations.length === 0, "no state-changing call made");
    r.addEvidence(ctx.writeEvidence("t0-discovery.json", { diag, providers, projects: projects.length, tasks: tasks.length, cli, disposable: again.map((s) => ({ ref: s.ref, provider: s.provider, state: effectiveState(s.status), raw: s.status.raw })) }));
    return r.build();
  },
};
