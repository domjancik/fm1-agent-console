// TUI-A2A: a console prompt to a Claude terminal (TUI) agent through Traycer a2a (agent.sendMessage), end to end
// through the guarded TraycerAgentAdapter. Receiver and sender must both be in reports/disposable-allowlist.json
// (the sender is the task's `a2aSenderId`, or with `--a2a-self` the receiver itself, the companion's default since the
// operator's option B); the guard refuses otherwise. Never writes to a PTY.
import type { Session } from "@fm1/agent-core";
import type { TraycerSession } from "@fm1/agent-adapter-traycer";
import { deliverMarker } from "../deliver";
import type { SmokeContext } from "../context";
import { RecordBuilder, type SmokeRecord } from "../record";
import { short } from "../redact";
import type { SmokeTest } from "./types";

interface Pick {
  epicId: string;
  receiver: TraycerSession;
  sender: Session | undefined;
  senderId: string;
}

/** An allowlisted Claude TUI whose Claude session has started (non-empty transcript), in a task with an a2a sender. */
async function pickReceiver(ctx: SmokeContext): Promise<Pick | string> {
  for (const task of ctx.allowlist.all()) {
    if (task.a2aSenderId === undefined && !ctx.a2aSelf) continue;
    const sessions = (await ctx.adapter.listSessions(task.epicId)) as TraycerSession[];
    const tuis = sessions.filter((s) => s.runtime === "terminal" && s.provider === "claude" && task.chatIds.includes(s.ref.sessionId));
    for (const tui of tuis) {
      const transcript = await ctx.transcript(tui.ref).catch(() => "");
      if (transcript.length > 0) {
        if (ctx.a2aSelf) return { epicId: task.epicId, receiver: tui, sender: undefined, senderId: tui.ref.sessionId };
        const senderId = task.a2aSenderId as string;
        return { epicId: task.epicId, receiver: tui, sender: sessions.find((s) => s.ref.sessionId === senderId), senderId };
      }
    }
  }
  return ctx.a2aSelf ? "no allowlisted Claude TUI with a started session" : "no allowlisted Claude TUI with a started session in a task that names an a2aSenderId";
}

async function run(ctx: SmokeContext): Promise<SmokeRecord> {
  const picked = await pickReceiver(ctx);
  const r = new RecordBuilder(
    {
      id: "TUI-A2A",
      provider: "claude (haiku) terminal agent",
      sessionType: "TUI (terminal)",
      target: typeof picked === "string" ? "-" : short(picked.receiver.ref.sessionId),
      operation: `TraycerAgentAdapter.sendPrompt to a TUI agent -> agent.sendMessage as ${ctx.a2aSelf ? "the receiver itself (a2aSelfSend)" : "the allowlisted a2aSender"}, marker FM1_SMOKE_A2A_<id>`,
      expected:
        "Guard refuses a non-allowlisted target and sender; route is agent.sendMessage; stages accepted_locally>sent>backend_acknowledged>completed; marker in exactly one receiver turn; reply captured in session details; not in the sender's transcript; one send",
    },
    ctx.versions,
  );
  if (typeof picked === "string") {
    r.blocked(picked);
    return r.build();
  }
  const { receiver } = picked;

  // Guard: a target outside the allowlist is refused before the adapter sees it.
  const outside = await ctx.adapter.sendPrompt({ ...receiver.ref, sessionId: "00000000-0000-4000-8000-00000000a2a0" }, "never sent", `smoke-a2a-guard-${crypto.randomUUID()}`);
  r.check(outside.stage === "unsupported" && /allowlist/.test(outside.message ?? ""), `guard refused a non-allowlisted TUI target: ${outside.message ?? outside.stage}`);

  const route = ctx.raw.promptCapability(receiver.ref);
  r.check(route?.via === "agent.sendMessage" && route.senderAgentId === picked.senderId, `route ${route?.via ?? "none"} as ${route?.senderAgentId ?? "-"}`);
  r.check(ctx.adapter.refuseA2aSender(receiver.ref) === null, "a2a sender is allowlisted");

  const del = await deliverMarker(ctx, receiver, "A2A", picked.sender ? [picked.sender] : [], { turnTimeoutMs: 120_000 });
  const stages = del.stages.map((s) => s.stage).join(">");
  r.check(stages === "accepted_locally>sent>backend_acknowledged>completed", `stages ${del.stages.map((s) => `${s.stage}@${s.ms}`).join(" > ")}`);
  r.check(del.targetTurns === 1, `${del.targetTurns} receiver turn(s) with marker ${del.marker}`);
  r.check(del.reply, "receiver reply contains the marker");
  r.check(del.leaked.every((l) => l.turns === 0), `sender transcript: ${del.leaked.map((l) => l.turns).join(",") || "n/a"} turn(s) with the marker`);
  const latest = (await ctx.adapter.listSessions(picked.epicId)).find((s) => s.ref.sessionId === receiver.ref.sessionId) as TraycerSession | undefined;
  const reply = latest?.details?.reply;
  r.check(reply?.requestId === del.requestId && (reply?.text ?? "").includes(del.marker), `session details.reply: ${JSON.stringify(reply?.text ?? null)}`);
  const sendCalls = ctx.adapter.mutations.filter((m) => m.requestId === del.requestId);
  r.check(sendCalls.length === 1, `${sendCalls.length} adapter send call(s) for the request`);
  r.metric("send_to_ack_ms", del.stages.find((s) => s.stage === "backend_acknowledged")?.ms ?? null);
  r.metric("send_to_completed_ms", del.stages.find((s) => s.stage === "completed")?.ms ?? null);
  r.addEvidence(ctx.writeEvidence("tui-a2a-delivery.json", { route, guardRefusal: outside, delivery: del, reply, timeline: ctx.timeline(receiver.ref, del.eventFrom) }));
  return r.build();
}

export const tuiA2a: SmokeTest = { id: "TUI-A2A", title: "TUI prompt via Traycer a2a", live: true, run };
