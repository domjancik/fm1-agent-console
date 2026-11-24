// T2 / T3: prompt delivery through the full AgentAdapter (claude, codex).
import type { Session } from "@fm1/agent-core";
import { deliverMarker, waitIdle } from "../deliver";
import type { SmokeContext } from "../context";
import { RecordBuilder, type SmokeRecord } from "../record";
import { short } from "../redact";
import type { SmokeTest } from "./types";

async function delivery(ctx: SmokeContext, id: "T2" | "T3"): Promise<SmokeRecord> {
  const d = await ctx.disposable();
  const [target, other]: [Session, Session] = id === "T2" ? [d.claude, d.codex] : [d.codex, d.claude];
  const tag = id === "T2" ? "CLAUDE" : "CODEX";
  const r = new RecordBuilder(
    {
      id,
      provider: id === "T2" ? "claude (haiku, low, supervised)" : "codex (gpt-5.6-luna, low, supervised)",
      sessionType: "GUI chat",
      target: short(target.ref.sessionId),
      operation: `TraycerAgentAdapter.sendPrompt with FM1_SMOKE_${tag}_<id>`,
      expected: "Exactly one user turn in the target; reply has the marker; no other session gets it; authoritative ack; no duplicate",
    },
    ctx.versions,
  );
  await waitIdle(ctx, target);
  const del = await deliverMarker(ctx, target, tag, [other]);
  r.check(del.result.stage === "backend_acknowledged", `sendPrompt resolved ${del.result.stage} in ${del.sendMs} ms`);
  r.check(del.stages.map((s) => s.stage).join(">") === "accepted_locally>sent>backend_acknowledged>completed", `stages ${del.stages.map((s) => `${s.stage}@${s.ms}`).join(" > ")}`);
  r.check(del.targetTurns === 1, `${del.targetTurns} user turn(s) with marker ${del.marker} in the target`);
  r.check(del.reply, "assistant reply contains the marker");
  r.check(del.leaked.every((l) => l.turns === 0), `other disposable chat: ${del.leaked.map((l) => l.turns).join(",")} turn(s) with the marker`);
  const sends = ctx.adapter.mutations.filter((m) => m.requestId === del.requestId);
  r.check(sends.length === 1, `${sends.length} adapter send call(s) for the request`);
  r.metric("send_to_ack_ms", del.stages.find((s) => s.stage === "backend_acknowledged")?.ms ?? null);
  r.metric("send_to_completed_ms", del.stages.find((s) => s.stage === "completed")?.ms ?? null);
  r.addEvidence(ctx.writeEvidence(`${id.toLowerCase()}-delivery.json`, { delivery: del, timeline: ctx.timeline(target.ref, del.eventFrom) }));
  return r.build();
}

export const t2: SmokeTest = { id: "T2", title: "Claude prompt delivery", live: true, run: (ctx) => delivery(ctx, "T2") };
export const t3: SmokeTest = { id: "T3", title: "Codex prompt delivery", live: true, run: (ctx) => delivery(ctx, "T3") };
