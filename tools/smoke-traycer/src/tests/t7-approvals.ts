// T7: approval behaviour on a new disposable supervised claude chat, answered through the device controller
// path (FX/SAVE asks, SAVE confirms), with stale-approval checks after each resolution.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AgentConsole, sessionKey, taskOf, type ApprovalRequest, type Session, type SessionRef } from "@fm1/agent-core";
import { SMOKE_WORKSPACE } from "../allowlist";
import { sleep, type SmokeContext } from "../context";
import { waitIdle } from "../deliver";
import { RecordBuilder } from "../record";
import { short } from "../redact";
import { marker } from "../transcript";
import type { SmokeTest } from "./types";

const FILE = join(SMOKE_WORKSPACE, "SMOKE_APPROVAL.txt");
const WRITE = (m: string): string =>
  `${m}\n\nCreate a file named SMOKE_APPROVAL.txt in the workspace root containing the single line FM1.\nUse your file write tool. Do not run shell commands. Do nothing else.\nIf the write is denied, stop and reply DENIED.`;

async function waitApproval(ac: AgentConsole, key: string, timeoutMs: number, exclude: ReadonlySet<string>): Promise<ApprovalRequest | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const a = ac.registry.approvalsFor(key).find((x) => !exclude.has(x.id));
    if (a) return a;
    await sleep(200);
  }
  return null;
}

/** One device decision: the first press asks (confirm view), SAVE confirms. Returns the console result. */
async function decide(ctx: SmokeContext, ac: AgentConsole, decision: "approve" | "deny", r: RecordBuilder): Promise<string> {
  const before = ctx.adapter.mutations.length;
  await ac.handleInput({ kind: "button", button: decision === "approve" ? "SAVE" : "FX", edge: "down" });
  const confirm = ac.state.confirm;
  r.check(confirm?.type === decision && ctx.adapter.mutations.length === before, `${decision}: first press opens the confirm view "${confirm?.label ?? "-"}" and sends nothing`);
  const results = ac.results.length;
  await ac.handleInput({ kind: "button", button: "SAVE", edge: "down" });
  return ac.results.slice(results).map((x) => `${x.stage}${x.message ? ` (${x.message})` : ""}`).join(", ") || "no result";
}

async function staleChecks(ctx: SmokeContext, ac: AgentConsole, a: ApprovalRequest, r: RecordBuilder): Promise<void> {
  const direct = await ctx.adapter.respondToApproval({ requestId: `smoke-t7-stale-${crypto.randomUUID()}`, approvalId: a.id, sessionRef: a.sessionRef, decision: "approve" });
  r.check(direct.stage === "target_unavailable", `stale ${short(a.id)} via adapter: ${direct.stage} (${direct.message ?? ""})`);
  const before = ctx.adapter.mutations.length;
  await ac.handleInput({ kind: "button", button: "SAVE", edge: "down" });
  r.check(ac.state.confirm === null && ctx.adapter.mutations.length === before, "stale via device: SAVE opens no confirm and sends nothing");
}

export const t7: SmokeTest = {
  id: "T7",
  title: "Approval behavior",
  live: true,
  async run(ctx) {
    const d = await ctx.disposable();
    const r = new RecordBuilder(
      {
        id: "T7",
        provider: "claude (haiku, supervised)",
        sessionType: "GUI chat (new, createSession)",
        target: `new chat in epic ${short(d.epicId)}`,
        operation: "createSession; prompt a write of SMOKE_APPROVAL.txt; deny via FX+SAVE; again, approve via SAVE+SAVE; stale decision after each",
        expected: "Approval discovered with exact id and summary; explicit confirmation; deny blocks the write; approve allows it; stale decisions refused",
      },
      ctx.versions,
    );
    if (existsSync(FILE)) rmSync(FILE);
    const ac = new AgentConsole({ adapter: ctx.shared() });
    await ac.start();
    let chat: Session | undefined;
    try {
      const created = await ctx.adapter.createSession({ requestId: `smoke-t7-chat-${crypto.randomUUID()}`, task: taskOf(d.claude.ref), provider: "claude" });
      chat = created.session;
      r.check(created.stage === "backend_acknowledged" && chat !== undefined, `createSession ${created.stage}, chat ${chat ? short(chat.ref.sessionId) : "-"}`);
      if (!chat) return r.build();
      ctx.allowlist.addChat(d.epicId, chat.ref.sessionId, `Chat ${chat.ref.sessionId} added by tools/smoke-traycer T7 (createSession, claude haiku, supervised).`);
      const ref: SessionRef = chat.ref;
      const key = sessionKey(ref);
      for (let i = 0; i < 20 && !ac.registry.get(key); i++) await sleep(250);
      r.check(ac.registry.select(key).ok, "new chat selected in the console");
      const seen = new Set<string>();

      // Deny path.
      const deny = await ctx.adapter.sendPrompt(ref, WRITE(marker("T7DENY")), `smoke-t7-deny-${crypto.randomUUID()}`);
      r.check(deny.stage === "backend_acknowledged", `deny prompt ${deny.stage}`);
      const a1 = await waitApproval(ac, key, 90_000, seen);
      if (!a1) {
        r.blocked(`no approval request within 90 s; SMOKE_APPROVAL.txt exists=${existsSync(FILE)} (the harness did not ask for this write)`);
        await ctx.adapter.interrupt(ref, `smoke-t7-stop-${crypto.randomUUID()}`);
        r.addEvidence(ctx.writeEvidence("t7-approvals.json", { chat: ref, timeline: ctx.timeline(ref), fileExists: existsSync(FILE) }));
        return r.build();
      }
      seen.add(a1.id);
      const listed = (await ctx.adapter.listApprovals()).find((x) => x.id === a1.id);
      r.check(listed !== undefined && listed.sessionRef.sessionId === ref.sessionId, `approval ${short(a1.id)} listed for exactly this chat; summary "${a1.summary}"`);
      const denied = await decide(ctx, ac, "deny", r);
      r.check(/^completed/.test(denied), `deny result ${denied}`);
      await waitIdle(ctx, chat, 60_000);
      const extra = ac.registry.approvalsFor(key).filter((x) => !seen.has(x.id));
      if (extra.length > 0) {
        r.note(`agent asked again after the denial (${extra.length}); interrupted`);
        await ctx.adapter.interrupt(ref, `smoke-t7-stop-${crypto.randomUUID()}`);
      }
      r.check(!existsSync(FILE), "denied write did not happen (SMOKE_APPROVAL.txt absent)");
      await staleChecks(ctx, ac, a1, r);

      // Approve path.
      await waitIdle(ctx, chat, 60_000);
      const ok = await ctx.adapter.sendPrompt(ref, WRITE(marker("T7OK")), `smoke-t7-ok-${crypto.randomUUID()}`);
      r.check(ok.stage === "backend_acknowledged", `approve prompt ${ok.stage}`);
      const a2 = await waitApproval(ac, key, 90_000, seen);
      r.check(a2 !== null && a2.id !== a1.id, `second approval ${a2 ? short(a2.id) : "-"} (new id)`);
      if (a2) {
        seen.add(a2.id);
        const approved = await decide(ctx, ac, "approve", r);
        r.check(/^completed/.test(approved), `approve result ${approved}`);
        for (let i = 0; i < 60 && !existsSync(FILE); i++) await sleep(500);
        r.check(existsSync(FILE) && readFileSync(FILE, "utf8").includes("FM1"), "approved write happened (SMOKE_APPROVAL.txt contains FM1)");
        await waitIdle(ctx, chat, 60_000);
        await staleChecks(ctx, ac, a2, r);
      }
      r.check(ctx.adapter.mutations.every((m) => !m.op.startsWith("respondToApproval") || m.target.endsWith(ref.sessionId)), "every decision targeted this chat only");
      r.addEvidence(ctx.writeEvidence("t7-approvals.json", { chat: ref, approvals: [...seen], results: ac.results, mutations: ctx.adapter.mutations.filter((m) => m.target.endsWith(ref.sessionId)), timeline: ctx.timeline(ref) }));
    } finally {
      await ac.stop();
    }
    return r.build();
  },
};
