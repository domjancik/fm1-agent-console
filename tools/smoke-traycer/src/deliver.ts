// Sends one marker prompt through the full AgentAdapter and checks delivery against the backend transcript.
import { effectiveState, type CommandResult, type Session } from "@fm1/agent-core";
import { sleep, type SmokeContext } from "./context";
import { marker as newMarker, markerPrompt, replyWith, userTurnsWith } from "./transcript";

export interface Delivery {
  marker: string;
  requestId: string;
  result: CommandResult;
  /** command_progress stages, in order, with ms since the send call. */
  stages: { stage: string; ms: number }[];
  completed: boolean;
  /** User turns in the target transcript containing the marker (exactly-once means 1). */
  targetTurns: number;
  reply: boolean;
  /** Marker occurrences in other allowlisted chats' transcripts. */
  leaked: { chatId: string; turns: number }[];
  sendMs: number;
  eventFrom: number;
}

export async function deliverMarker(
  ctx: SmokeContext,
  target: Session,
  tag: string,
  others: readonly Session[],
  opts: { text?: (marker: string) => string; turnTimeoutMs?: number } = {},
): Promise<Delivery> {
  const m = newMarker(tag);
  const requestId = `smoke-${tag.toLowerCase()}-${crypto.randomUUID()}`;
  const from = ctx.events.length;
  const t0 = performance.now();
  const result = await ctx.adapter.sendPrompt(target.ref, (opts.text ?? markerPrompt)(m), requestId);
  const sendMs = Math.round(performance.now() - t0);
  const done = await ctx.waitProgress(requestId, ["completed", "failed"], opts.turnTimeoutMs ?? 120_000, from);
  const stages = ctx.events
    .slice(from)
    .flatMap((x) => (x.event.type === "command_progress" && x.event.requestId === requestId ? [{ stage: x.event.stage, ms: Math.round(x.t - t0) }] : []));
  const completed = done?.event.type === "command_progress" && done.event.stage === "completed";
  // The transcript may lag the turn event slightly.
  let text = "";
  for (let i = 0; i < 10; i++) {
    text = await ctx.transcript(target.ref);
    if (userTurnsWith(text, m) > 0 && (!completed || replyWith(text, m))) break;
    await sleep(500);
  }
  const leaked: Delivery["leaked"] = [];
  for (const o of others) leaked.push({ chatId: o.ref.sessionId, turns: userTurnsWith(await ctx.transcript(o.ref), m) });
  return {
    marker: m,
    requestId,
    result,
    stages,
    completed,
    targetTurns: userTurnsWith(text, m),
    reply: replyWith(text, m),
    leaked,
    sendMs,
    eventFrom: from,
  };
}

/** Waits until the session is no longer working (so the next send does not queue behind a turn). */
export async function waitIdle(ctx: SmokeContext, target: Session, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = (await ctx.adapter.listSessions(target.ref.taskId)).find((x) => x.ref.sessionId === target.ref.sessionId);
    if (s && effectiveState(s.status) !== "working") return;
    await sleep(1000);
  }
}
