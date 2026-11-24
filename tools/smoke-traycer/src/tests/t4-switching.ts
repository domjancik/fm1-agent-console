// T4: session switching through agent-core (registry selection + PromptDispatcher), alternating targets.
import { AgentConsole, sessionKey, type Session } from "@fm1/agent-core";
import { waitIdle } from "../deliver";
import { RecordBuilder } from "../record";
import { short } from "../redact";
import { marker, markerPrompt, userTurnsWith } from "../transcript";
import type { SmokeTest } from "./types";

export const t4: SmokeTest = {
  id: "T4",
  title: "Session switching",
  live: true,
  async run(ctx) {
    const d = await ctx.disposable();
    const r = new RecordBuilder(
      {
        id: "T4",
        provider: "claude A + codex B",
        sessionType: "GUI chat",
        target: `A ${short(d.claude.ref.sessionId)}, B ${short(d.codex.ref.sessionId)}`,
        operation: "AgentConsole: select A, select B, send to B, select A, send to A, select B, send to B (selected session = target)",
        expected: "Each instruction reaches only its own session; workspaces unchanged; no forced focus",
      },
      ctx.versions,
    );
    const ac = new AgentConsole({ adapter: ctx.shared() });
    await ac.start();
    try {
      const plan: [string, Session][] = [["B1", d.codex], ["A1", d.claude], ["B2", d.codex]];
      const sent: { tag: string; marker: string; target: Session; stage: string }[] = [];
      ac.registry.select(sessionKey(d.claude.ref));
      for (const [tag, target] of plan) {
        const sel = ac.registry.select(sessionKey(target.ref));
        r.check(sel.ok, `select ${tag[0]} ok`);
        const key = ac.registry.selection().key;
        const entry = key ? ac.registry.get(key) : undefined;
        if (!entry) throw new Error("selection vanished");
        await waitIdle(ctx, target);
        const m = marker(`T4${tag}`);
        const id = `smoke-t4-${tag.toLowerCase()}-${crypto.randomUUID()}`;
        const res = await ac.dispatcher.dispatch(id, { mode: "continue-session", target: entry.session.ref, label: entry.session.title }, markerPrompt(m));
        await ctx.waitProgress(id, ["completed", "failed"], 120_000);
        sent.push({ tag, marker: m, target, stage: res.stage });
      }
      r.check(sent.every((s) => s.stage === "backend_acknowledged"), `dispatch stages ${sent.map((s) => `${s.tag}:${s.stage}`).join(", ")}`);
      const ta = await ctx.transcript(d.claude.ref);
      const tb = await ctx.transcript(d.codex.ref);
      for (const s of sent) {
        const own = s.target === d.claude ? ta : tb;
        const foreign = s.target === d.claude ? tb : ta;
        r.check(userTurnsWith(own, s.marker) === 1 && userTurnsWith(foreign, s.marker) === 0, `${s.tag}: 1 turn in its own chat, 0 in the other (${userTurnsWith(own, s.marker)}/${userTurnsWith(foreign, s.marker)})`);
      }
      const after = await ctx.adapter.listSessions(d.epicId);
      const ws = (x: Session) => after.find((s) => s.ref.sessionId === x.ref.sessionId)?.workspace;
      r.check(ws(d.claude) === d.claude.workspace && ws(d.codex) === d.codex.workspace, `workspaces unchanged (${ws(d.claude)}, ${ws(d.codex)})`);
      r.check(ctx.adapter.mutations.every((m) => m.op !== "focus"), "no focus call was needed");
      r.metric("adapter_calls", ac.dispatcher.adapterCalls);
      r.addEvidence(ctx.writeEvidence("t4-switching.json", { sent: sent.map((s) => ({ tag: s.tag, marker: s.marker, chat: s.target.ref.sessionId, stage: s.stage })) }));
    } finally {
      await ac.stop();
    }
    return r.build();
  },
};
