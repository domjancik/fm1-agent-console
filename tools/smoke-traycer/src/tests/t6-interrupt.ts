// T6: interrupt a long, harmless turn through the adapter; check the other chat and no replay on reconnect.
import { effectiveState } from "@fm1/agent-core";
import { waitIdle } from "../deliver";
import { sleep } from "../context";
import { RecordBuilder } from "../record";
import { short } from "../redact";
import { marker, userMessages, userTurnsWith } from "../transcript";
import type { SmokeTest } from "./types";

export const t6: SmokeTest = {
  id: "T6",
  title: "Interruption",
  live: true,
  async run(ctx) {
    const d = await ctx.disposable();
    const r = new RecordBuilder(
      {
        id: "T6",
        provider: "claude (haiku)",
        sessionType: "GUI chat",
        target: short(d.claude.ref.sessionId),
        operation: "sendPrompt (count slowly to 200), then TraycerAgentAdapter.interrupt (agent.stop cascade:false); disconnect + reconnect",
        expected: "Correct session stops; codex chat unaffected; state matches backend; nothing replayed on reconnect",
      },
      ctx.versions,
    );
    await waitIdle(ctx, d.claude);
    const m = marker("T6");
    const id = `smoke-t6-${crypto.randomUUID()}`;
    const from = ctx.events.length;
    const t0 = performance.now();
    const sent = await ctx.adapter.sendPrompt(d.claude.ref, `${m}\n\nCount slowly from 1 to 200, one number per line, writing a short sentence about each number.\nDo not use tools.\nDo not modify files.`, id);
    const working = await ctx.waitState(d.claude.ref, ["working"], 30_000, from);
    r.check(sent.stage === "backend_acknowledged" && working !== null, `prompt ${sent.stage}; working after ${working ? Math.round(working.t - t0) : "-"} ms`);
    await sleep(4000);
    const codexBefore = (await ctx.adapter.listSessions(d.epicId)).find((s) => s.ref.sessionId === d.codex.ref.sessionId);
    const ti = performance.now();
    const stop = await ctx.adapter.interrupt(d.claude.ref, `smoke-t6-stop-${crypto.randomUUID()}`);
    const turnEnd = await ctx.waitProgress(id, ["failed", "completed"], 30_000, from);
    const afterWorking = working ? ctx.events.indexOf(working) + 1 : from;
    const settled = await ctx.waitState(d.claude.ref, ["idle", "completed_read", "completed_unread", "failed"], 15_000, afterWorking);
    r.check(stop.stage === "completed" && !stop.message, `interrupt ${stop.stage}${stop.message ? ` (${stop.message})` : ""}`);
    r.check(turnEnd?.event.type === "command_progress" && turnEnd.event.stage === "failed" && /stopped/.test(turnEnd.event.message ?? ""), `prompt progress ended ${turnEnd?.event.type === "command_progress" ? `${turnEnd.event.stage} ${turnEnd.event.message ?? ""}` : "-"}`);
    r.metric("interrupt_to_turn_end_ms", turnEnd ? Math.round(turnEnd.t - ti) : null);
    r.check(settled !== null, `session left working after the stop (${settled?.event.type === "session_upserted" ? effectiveState(settled.event.session.status) : "-"})`);
    const codexAfter = (await ctx.adapter.listSessions(d.epicId)).find((s) => s.ref.sessionId === d.codex.ref.sessionId);
    r.check(
      codexBefore !== undefined && codexAfter !== undefined && effectiveState(codexBefore.status) === effectiveState(codexAfter.status),
      `codex chat unchanged (${codexBefore ? effectiveState(codexBefore.status) : "-"} -> ${codexAfter ? effectiveState(codexAfter.status) : "-"})`,
    );
    const turnsBefore = userMessages(await ctx.transcript(d.claude.ref)).length;
    await ctx.adapter.disconnect();
    await ctx.adapter.connect();
    await ctx.adapter.listSessions(d.epicId);
    await sleep(5000);
    const text = await ctx.transcript(d.claude.ref);
    const now = (await ctx.adapter.listSessions(d.epicId)).find((s) => s.ref.sessionId === d.claude.ref.sessionId);
    r.check(userMessages(text).length === turnsBefore && userTurnsWith(text, m) === 1, `after reconnect: ${userMessages(text).length - turnsBefore} new user turn(s), marker turns ${userTurnsWith(text, m)}`);
    r.check(now !== undefined && effectiveState(now.status) !== "working", `after reconnect the chat is ${now ? effectiveState(now.status) : "-"} (not restarted)`);
    r.check(ctx.adapter.mutations.filter((x) => x.op === "interrupt" && x.target.endsWith(d.claude.ref.sessionId)).length === 1, "one interrupt call, never repeated");
    r.addEvidence(ctx.writeEvidence("t6-interrupt.json", { stop, timeline: ctx.timeline(d.claude.ref, from, t0) }));
    return r.build();
  },
};
