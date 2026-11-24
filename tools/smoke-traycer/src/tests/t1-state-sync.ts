// T1: read-only state synchronization, measured on the disposable claude chat from a passive observer.
import { effectiveState } from "@fm1/agent-core";
import { deliverMarker } from "../deliver";
import { RecordBuilder } from "../record";
import { short } from "../redact";
import { cliAgents } from "./cli-agents";
import { Observer } from "./observer";
import type { SmokeTest } from "./types";

const SLOW = (m: string): string =>
  `${m}\n\nCount from 1 to 40, one number per line, then write the marker on its own line.\nDo not use tools.\nDo not modify files.`;

export const t1: SmokeTest = {
  id: "T1",
  title: "Read-only state synchronization",
  live: true,
  async run(ctx) {
    const d = await ctx.disposable();
    const r = new RecordBuilder(
      {
        id: "T1",
        provider: "claude (haiku)",
        sessionType: "GUI chat",
        target: short(d.claude.ref.sessionId),
        operation: "Passive observer adapter (feeds only, no chat watch) times working/completed while the main adapter sends one marker prompt",
        expected: "Right session, right state, honest unknowns, no restart needed; propagation about 2 s or better",
      },
      ctx.versions,
    );
    const obs = new Observer();
    await obs.start(d.epicId);
    try {
      const before = (await obs.adapter.listSessions(d.epicId)).find((s) => s.ref.sessionId === d.codex.ref.sessionId);
      const codexBefore = before ? effectiveState(before.status) : "missing";
      const t0 = performance.now();
      const del = await deliverMarker(ctx, d.claude, "T1", [d.codex], { text: SLOW });
      const ackAt = ctx.events.find((x) => x.event.type === "command_progress" && x.event.requestId === del.requestId && x.event.stage === "backend_acknowledged")?.t;
      const doneAt = ctx.events.find((x) => x.event.type === "command_progress" && x.event.requestId === del.requestId && x.event.stage === "completed")?.t;
      const working = obs.first(d.claude.ref, ["working"], t0);
      const settled = await obs.waitFor(d.claude.ref, ["completed_unread", "completed_read", "idle"], working?.t ?? t0, 15_000);
      r.check(del.result.stage === "backend_acknowledged" && del.completed && del.targetTurns === 1, `prompt ${del.result.stage}, turn completed ${del.completed}, ${del.targetTurns} user turn(s)`);
      r.check(working !== undefined && working.observed, `observer saw working (observed=${working?.observed ?? "-"})`);
      r.check(settled !== undefined, `observer saw the turn end as ${settled?.state ?? "nothing"}`);
      const workLag = working && ackAt ? Math.round(working.t - ackAt) : null;
      const doneLag = settled && doneAt ? Math.round(settled.t - doneAt) : null;
      r.metric("working_after_backend_ack_ms", workLag);
      r.metric("idle_after_turn_completed_ms", doneLag);
      r.metric("send_to_observer_working_ms", working ? Math.round(working.t - t0) : null);
      r.check(workLag !== null && workLag <= 2_000, `working propagated ${workLag} ms after the backend ack (target <= 2000)`);
      r.check(doneLag !== null && doneLag <= 2_000, `turn end propagated ${doneLag} ms after the chat stream reported completion (target <= 2000)`);
      const wrong = obs.changes.filter((c) => c.t >= t0 && c.sessionId === d.codex.ref.sessionId);
      r.check(wrong.length === 0, `codex chat state unchanged (${codexBefore}); ${wrong.length} change(s) attributed to it`);
      const cli = (await cliAgents(d.epicId, d.claude.ref.sessionId)).find((a) => a.id === d.claude.ref.sessionId);
      const now = (await obs.adapter.listSessions(d.epicId)).find((s) => s.ref.sessionId === d.claude.ref.sessionId);
      r.check(cli !== undefined && !cli.active && now !== undefined && effectiveState(now.status) !== "working", `after the turn: CLI active=${cli?.active}, adapter ${now ? effectiveState(now.status) : "-"}`);
      const tui = (await obs.adapter.listSessions()).filter((s) => s.runtime === "terminal");
      r.check(tui.every((s) => s.status.observed.state === null || s.status.observed.state === "failed" || s.status.observed.state === "idle"), `${tui.length} terminal sessions: activity reported as inferred only (${tui.filter((s) => s.status.inferred).length} inferred)`);
      r.note("Desktop tile switching (spec step 2) was not driven: no UI automation (Accessibility not granted); the observer needs no Desktop action");
      r.addEvidence(ctx.writeEvidence("t1-state-sync.json", { delivery: del, observer: obs.changes.filter((c) => c.t >= t0).map((c) => ({ ...c, t: Math.round(c.t - t0) })), ackAt: ackAt && Math.round(ackAt - t0), doneAt: doneAt && Math.round(doneAt - t0) }));
    } finally {
      await obs.stop();
    }
    return r.build();
  },
};
