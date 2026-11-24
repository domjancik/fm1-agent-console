// T5: new task + session via createTask (traycer task create, cheapest model, idempotency key), then selectable.
import { AgentConsole, effectiveState, sessionKey } from "@fm1/agent-core";
import { TraycerAgentAdapter } from "@fm1/agent-adapter-traycer";
import { SMOKE_PROJECT_ID } from "../allowlist";
import { sleep } from "../context";
import { GuardedAdapter } from "../guard";
import { RecordBuilder } from "../record";
import { short } from "../redact";
import { marker, markerPrompt, replyWith, userTurnsWith } from "../transcript";
import type { SmokeTest } from "./types";

export const t5: SmokeTest = {
  id: "T5",
  title: "New task and session",
  live: true,
  async run(ctx) {
    const hostId = ctx.raw.diagnostics().endpoint?.hostId ?? "";
    const r = new RecordBuilder(
      {
        id: "T5",
        provider: "claude (haiku, supervised)",
        sessionType: "GUI chat (first agent of a new task)",
        target: `new task in ${SMOKE_PROJECT_ID}`,
        operation: "TraycerAgentAdapter.createTask (traycer task create --idempotency-key fm1-<requestId>), repeat from a fresh adapter, list, select",
        expected: "Task and session appear in Traycer; prompt delivered once; repeat returns the same task; controller can select it",
      },
      ctx.versions,
    );
    const m = marker("T5");
    const requestId = `smoke-t5-${crypto.randomUUID()}`;
    const request = {
      requestId,
      project: { backendId: "traycer", hostId, projectId: SMOKE_PROJECT_ID },
      title: "FM1 smoke T5 (disposable)",
      provider: "claude" as const,
      prompt: markerPrompt(m),
    };
    const created = await ctx.adapter.createTask(request);
    const taskId = created.task?.ref.taskId;
    r.check(created.stage === "backend_acknowledged" && taskId !== undefined, `createTask ${created.stage}${created.message ? ` (${created.message})` : ""}, task ${taskId ? short(taskId) : "-"}`);
    if (!taskId) return r.build();
    ctx.allowlist.addTask(taskId, `FM1 smoke T5 task created by tools/smoke-traycer createTask, idempotency key fm1-${requestId}, workspace ${SMOKE_PROJECT_ID.slice(3)}.`);

    // Idempotency: a fresh adapter (no in-memory request cache) repeats the same requestId.
    // Guarded like every other state-changing call (createTask only into the disposable workspace).
    const fresh = new GuardedAdapter(new TraycerAgentAdapter({ sessionScanLimit: 3 }), ctx.allowlist, ctx.live);
    await fresh.connect();
    const repeat = await fresh.createTask(request);
    await fresh.disconnect();
    r.check(repeat.task?.ref.taskId === taskId, `repeat from a fresh adapter: ${repeat.stage}, same task ${repeat.task?.ref.taskId === taskId}${repeat.message ? ` (${repeat.message})` : ""}`);

    let sessions = await ctx.adapter.listSessions(taskId);
    for (let i = 0; i < 10 && sessions.length === 0; i++) {
      await sleep(1000);
      sessions = await ctx.adapter.listSessions(taskId);
    }
    for (const s of sessions) ctx.allowlist.addChat(taskId, s.ref.sessionId, `Chat ${s.ref.sessionId} is its first agent.`);
    r.check(sessions.length === 1, `${sessions.length} session(s) in the new task: ${sessions.map((s) => `${short(s.ref.sessionId)} ${s.provider}/${s.runtime}`).join(", ")}`);
    const session = sessions[0];
    if (!session) return r.build();
    const tasks = await ctx.adapter.listTasks(SMOKE_PROJECT_ID);
    r.check(tasks.some((t) => t.ref.taskId === taskId), "task listed under the smoke workspace project");

    let text = "";
    for (let i = 0; i < 60 && !replyWith(text, m); i++) {
      text = await ctx.transcript(session.ref);
      if (!replyWith(text, m)) await sleep(1000);
    }
    r.check(userTurnsWith(text, m) === 1 && replyWith(text, m), `first prompt: ${userTurnsWith(text, m)} user turn(s), reply has the marker ${replyWith(text, m)}`);

    const ac = new AgentConsole({ adapter: ctx.shared() });
    await ac.start();
    const sel = ac.registry.select(sessionKey(session.ref));
    const entry = ac.registry.get(sessionKey(session.ref));
    r.check(sel.ok && entry !== undefined, `controller selects it (slot ${entry?.slot ?? "-"}, state ${entry ? effectiveState(entry.session.status) : "-"})`);
    await ac.stop();
    r.addEvidence(ctx.writeEvidence("t5-new-task.json", { created, repeat: { stage: repeat.stage, message: repeat.message, taskId: repeat.task?.ref.taskId }, sessions, marker: m }));
    return r.build();
  },
};
