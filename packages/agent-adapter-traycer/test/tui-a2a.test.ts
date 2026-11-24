import { afterEach, describe, expect, test } from "bun:test";
import type { AgentEvent, SessionRef } from "@fm1/agent-core";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { A2aNotSentError, a2aError, deliverA2a, locateTurn, promptCapabilityFor, promptNeedles, type A2aDeps } from "../src/agent/a2a-delivery";
import type { TraycerSession } from "../src/agent/session-book";
import type { NormalizedAgent } from "../src/normalize";
import type { FakeStreamSub } from "./fake-host";
import { chatSnapshot, HOST, makeHarness, standardWorld, until, USER, type Harness, type World } from "./scenario";

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

const ALPHA = "ws:/Users/me/dev/alpha";
const ref = (taskId: string, sessionId: string): SessionRef => ({ backendId: "traycer", hostId: HOST, projectId: ALPHA, taskId, sessionId });
const progressOf = (events: AgentEvent[], requestId: string) =>
  events.flatMap((e) => (e.type === "command_progress" && e.requestId === requestId ? [e.stage] : []));
const sends = (harness: Harness) => harness.host.requests.filter((r) => r.method === "agent.sendMessage");

type Delivery = "deliver" | "stuck";

/**
 * Fake a2a broker on top of the standard world, shaped after the live host 1.5.4 answers
 * (reports/evidence/tui-a2a/): FORBIDDEN for a sender outside the receiver's task, TARGET_TUI_UNSUPPORTED for a
 * non-Claude TUI, and the monitor delivery visible in agent.getTranscript as a task-notification, then the answer.
 */
function a2aWorld(mode: { delivery: Delivery } = { delivery: "deliver" }): { world: World; transcripts: Map<string, string> } {
  const world = standardWorld();
  world.tuis.push({ epicId: "e1", tuiAgentId: "t2", title: "Codex terminal", harnessId: "codex", sessionState: "running" });
  world.tuis.push({ epicId: "e2", tuiAgentId: "t3", title: "Other task terminal", harnessId: "claude", sessionState: "running" });
  const transcripts = new Map<string, string>();
  const inEpic = (epicId: string, id: string) =>
    world.chats.some((c) => c.epicId === epicId && c.chatId === id) || world.tuis.some((t) => t.epicId === epicId && t.tuiAgentId === id);
  world.overrides["agent.sendMessage"] = (p) => {
    const epicId = String(p.epicId);
    const receiver = String(p.receiverAgentId);
    if (!inEpic(epicId, String(p.senderAgentId))) return { error: { code: "FORBIDDEN", message: String(p.senderAgentId) } };
    if (!inEpic(epicId, receiver)) return { error: { code: "NOT_FOUND", message: `agent ${receiver} not found` } };
    const tui = world.tuis.find((t) => t.tuiAgentId === receiver);
    if (tui !== undefined && tui.harnessId !== "claude") {
      return { error: { code: "RPC_ERROR", message: `TARGET_TUI_UNSUPPORTED — harness '${tui.harnessId}' cannot receive agent-to-agent messages.` } };
    }
    if (mode.delivery === "deliver") {
      const prompt = String(p.prompt);
      setTimeout(() => {
        transcripts.set(
          receiver,
          `${transcripts.get(receiver) ?? ""}<user_message>\n<task-notification>\n<event>[traycer:agent-message] from FM1 Console (agent ${String(p.senderAgentId)}) [claude]\n[traycer:agent-message] No reply is required.\n${prompt}\n</event>\n</task-notification>\n</user_message>\n\n`,
        );
      }, 30);
      setTimeout(() => {
        transcripts.set(receiver, `${transcripts.get(receiver) ?? ""}<assistant_response>\nAll green: 3 tests pass.\n</assistant_response>\n\n`);
      }, 90);
    }
    return { result: { responseId: p.expectReply === true ? "thread-1" : null } };
  };
  world.overrides["agent.getTranscript"] = (p) => ({ result: { transcript: transcripts.get(String(p.agentId)) ?? "" } });
  return { world, transcripts };
}

const SENDER = { agentId: "c2", epicId: "e1" }; // a dedicated "FM1 Console" agent in task e1 (here: the claude chat)

// These tests pin the a2a route (`tuiRoute: "a2a"`); the default typing route is covered in tui-typing.test.ts.
describe("TUI prompts via Traycer a2a", () => {
  test("Claude TUI: agent.sendMessage as the configured sender; stages; reply surfaced in session details", async () => {
    const { world } = a2aWorld();
    h = makeHarness({ world, config: { tuiRoute: "a2a", a2aSender: SENDER, a2aPollMs: 10, ackTimeoutMs: 1_000, turnTimeoutMs: 3_000 } });
    await h.adapter.connect();
    const sessions = (await h.adapter.listSessions("e1")) as TraycerSession[];
    expect(sessions.find((s) => s.ref.sessionId === "t1")?.prompt).toEqual({ acceptsPrompt: true, via: "agent.sendMessage", senderAgentId: "c2" });
    expect(sessions.find((s) => s.ref.sessionId === "c1")?.prompt).toEqual({ acceptsPrompt: true, via: "chat.subscribe" });

    const result = await h.adapter.sendPrompt(ref("e1", "t1"), "Report status.", "req-1");
    expect(result.stage).toBe("backend_acknowledged");
    const req = sends(h)[0];
    expect(req?.params).toEqual({ senderAgentId: "c2", epicId: "e1", receiverAgentId: "t1", prompt: "Report status.", responseId: null, expectReply: false, workspace: null });
    expect(req?.idempotencyKey).toBe("fm1-a2a-req-1");
    await until(() => progressOf(h!.events, "req-1").includes("completed"), 3_000, "completed");
    expect(progressOf(h.events, "req-1")).toEqual(["accepted_locally", "sent", "backend_acknowledged", "completed"]);
    const upsert = [...h.events].reverse().find((e) => e.type === "session_upserted" && e.session.ref.sessionId === "t1");
    const details = upsert?.type === "session_upserted" ? (upsert.session as TraycerSession).details : undefined;
    expect(details?.reply?.text).toBe("All green: 3 tests pass.");
    expect(details?.reply?.requestId).toBe("req-1");
    expect(details?.lastMessage).toBe("All green: 3 tests pass.");
    expect(h.host.live("terminal.subscribe")).toEqual([]); // never PTY keystrokes
  });

  test("GUI chat keeps chat.subscribe send; no agent.sendMessage", async () => {
    const { world } = a2aWorld();
    h = makeHarness({
      world,
      config: { tuiRoute: "a2a", a2aSender: SENDER },
      host: {
        onSubscribe: (sub: FakeStreamSub) => {
          if (sub.method !== "chat.subscribe") return;
          const p = sub.params as { epicId: string; chatId: string };
          sub.send(chatSnapshot(p.epicId, p.chatId));
        },
        onClientFrame: (sub, frame) => {
          if (frame.kind !== "send") return;
          sub.send({ kind: "actionAck", epicId: frame.epicId, chatId: frame.chatId, clientActionId: frame.clientActionId, action: "send", status: "accepted", reason: null, code: null });
          sub.send({
            kind: "messageAccepted",
            epicId: frame.epicId,
            chatId: frame.chatId,
            message: { role: "user", messageId: frame.messageId, sender: { type: "user", userId: USER }, message: { kind: "user", content: frame.content, browserAnnotations: [] }, timestamp: 1, sessionAnchor: null },
          });
        },
      },
    });
    await h.adapter.connect();
    await h.adapter.listSessions("e1");
    const r = await h.adapter.sendPrompt(ref("e1", "c1"), "hello", "req-g");
    expect(r.stage).toBe("backend_acknowledged");
    expect(sends(h)).toEqual([]);
    expect(h.host.subs.filter((s) => s.method === "chat.subscribe").flatMap((s) => s.clientFrames).filter((f) => f.kind === "send")).toHaveLength(1);
  });

  test("no sender for the receiver's task: acceptsPrompt false with a reason, unsupported, nothing sent; a2aSelfSend sends as the receiver", async () => {
    const { world } = a2aWorld();
    h = makeHarness({ world, config: { tuiRoute: "a2a", a2aSender: [{ agentId: "c3", epicId: "e2" }], a2aPollMs: 10 } });
    await h.adapter.connect();
    await h.adapter.listSessions("e1");
    const cap = h.adapter.promptCapability(ref("e1", "t1"));
    expect(cap?.acceptsPrompt).toBe(false);
    expect(cap?.reason).toContain("no FM-1 sender agent configured for this task");
    const r = await h.adapter.sendPrompt(ref("e1", "t1"), "x", "req-n");
    expect(r.stage).toBe("unsupported");
    expect(r.message).toContain("terminal");
    expect(sends(h)).toEqual([]);
    await h.dispose();

    const self = a2aWorld();
    h = makeHarness({ world: self.world, config: { tuiRoute: "a2a", a2aSelfSend: true, a2aPollMs: 10 } });
    await h.adapter.connect();
    await h.adapter.listSessions("e1");
    expect(h.adapter.promptCapability(ref("e1", "t1"))?.senderAgentId).toBe("t1");
    expect((await h.adapter.sendPrompt(ref("e1", "t1"), "x", "req-self")).stage).toBe("backend_acknowledged");
    expect((sends(h)[0]?.params as { senderAgentId: string }).senderAgentId).toBe("t1");
  });

  test("non-Claude TUI: acceptsPrompt false, unsupported, never sent; host TARGET_TUI_UNSUPPORTED maps to unsupported", async () => {
    const { world } = a2aWorld();
    h = makeHarness({ world, config: { tuiRoute: "a2a", a2aSender: SENDER } });
    await h.adapter.connect();
    await h.adapter.listSessions("e1");
    expect(h.adapter.promptCapability(ref("e1", "t2"))).toMatchObject({ acceptsPrompt: false, via: null });
    const r = await h.adapter.sendPrompt(ref("e1", "t2"), "x", "req-codex");
    expect(r.stage).toBe("unsupported");
    expect(sends(h)).toEqual([]);
    // The host is the authority: a Claude TUI it refuses anyway.
    world.overrides["agent.sendMessage"] = () => ({ error: { code: "RPC_ERROR", message: "TARGET_TUI_UNSUPPORTED — harness 'claude' cannot receive agent-to-agent messages." } });
    const refused = await h.adapter.sendPrompt(ref("e1", "t1"), "x", "req-refused");
    expect(refused.stage).toBe("unsupported");
  });

  test("error mapping: FORBIDDEN sender -> failed (nothing delivered, retryable); NOT_FOUND -> target_unavailable", async () => {
    const { world } = a2aWorld();
    h = makeHarness({ world, config: { tuiRoute: "a2a", a2aSender: { agentId: "ghost", epicId: "e1" }, a2aPollMs: 10 } });
    await h.adapter.connect();
    await h.adapter.listSessions("e1");
    const forbidden = await h.adapter.sendPrompt(ref("e1", "t1"), "x", "req-f");
    expect(forbidden.stage).toBe("failed");
    expect(forbidden.message).toContain("FORBIDDEN");
    expect(forbidden.message).toContain("nothing delivered");
    // A definite refusal had no effect: the same requestId may run again (and here is refused again).
    await h.adapter.sendPrompt(ref("e1", "t1"), "x", "req-f");
    expect(sends(h)).toHaveLength(2);

    world.overrides["agent.sendMessage"] = () => ({ error: { code: "NOT_FOUND", message: "AGENT_NOT_FOUND: agent t1 not found" } });
    expect((await h.adapter.sendPrompt(ref("e1", "t1"), "x", "req-gone")).stage).toBe("target_unavailable");
  });

  test("idempotency: the same requestId never sends twice (concurrent and after success)", async () => {
    const { world } = a2aWorld();
    h = makeHarness({ world, config: { tuiRoute: "a2a", a2aSender: SENDER, a2aPollMs: 10, turnTimeoutMs: 2_000 } });
    await h.adapter.connect();
    await h.adapter.listSessions("e1");
    const [a, b] = await Promise.all([h.adapter.sendPrompt(ref("e1", "t1"), "once", "req-i"), h.adapter.sendPrompt(ref("e1", "t1"), "once", "req-i")]);
    expect(a).toEqual(b);
    const again = await h.adapter.sendPrompt(ref("e1", "t1"), "once", "req-i");
    expect(again).toEqual(a);
    expect(sends(h)).toHaveLength(1);
  });

  test("receiver never shows the prompt (blocked TUI, no monitor): resolves sent with a reason, never resent", async () => {
    const { world } = a2aWorld({ delivery: "stuck" });
    h = makeHarness({ world, config: { tuiRoute: "a2a", a2aSender: SENDER, a2aPollMs: 10, ackTimeoutMs: 150, turnTimeoutMs: 400 } });
    await h.adapter.connect();
    await h.adapter.listSessions("e1");
    const r = await h.adapter.sendPrompt(ref("e1", "t1"), "x", "req-stuck");
    expect(r.stage).toBe("sent");
    expect(r.message).toContain("delivery not observed");
    await Bun.sleep(450);
    expect(progressOf(h.events, "req-stuck")).toEqual(["accepted_locally", "sent"]);
    expect(await h.adapter.sendPrompt(ref("e1", "t1"), "x", "req-stuck")).toEqual(r);
    expect(sends(h)).toHaveLength(1);
  });

  test("an identical earlier prompt in the transcript does not count as delivery", async () => {
    const { world, transcripts } = a2aWorld({ delivery: "stuck" });
    transcripts.set("t1", "<user_message>\nReport status.\n</user_message>\n<assistant_response>\nold answer\n</assistant_response>\n");
    h = makeHarness({ world, config: { tuiRoute: "a2a", a2aSender: SENDER, a2aPollMs: 10, ackTimeoutMs: 150, turnTimeoutMs: 300 } });
    await h.adapter.connect();
    await h.adapter.listSessions("e1");
    expect((await h.adapter.sendPrompt(ref("e1", "t1"), "Report status.", "req-dup")).stage).toBe("sent");
  });
});

describe("a2a units", () => {
  const agent = (over: Partial<NormalizedAgent>): NormalizedAgent => ({
    epicId: "e1",
    agentId: "a",
    surface: "tui",
    harnessId: "claude",
    model: null,
    reasoningEffort: null,
    permissionMode: null,
    profileId: null,
    title: "",
    parentId: null,
    hostId: null,
    ownerUserId: USER,
    archived: false,
    sessionState: "running",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  });

  test("promptCapabilityFor picks the sender of the receiver's own task only", () => {
    const policy = { senders: [{ agentId: "s2", epicId: "e2" }, { agentId: "s1", epicId: "e1" }], selfSend: false, tuiRoute: "a2a" as const };
    expect(promptCapabilityFor(agent({}), policy).senderAgentId).toBe("s1");
    expect(promptCapabilityFor(agent({ epicId: "e3" }), policy).acceptsPrompt).toBe(false);
    expect(promptCapabilityFor(agent({ harnessId: "opencode" }), policy).acceptsPrompt).toBe(false);
    expect(promptCapabilityFor(agent({ surface: "gui", harnessId: "codex" }), policy).via).toBe("chat.subscribe");
  });

  test("a2aError: transport failure is uncertain (sent, never retried); host answers are definite", () => {
    expect(a2aError("r", new Error("socket closed"), "s").stage).toBe("sent");
    const rpc = (code: string, message: string) => new HostRpcError({ code: code as never, message, requestId: "x", method: "agent.sendMessage", fatalDetails: null });
    expect(a2aError("r", rpc("FORBIDDEN", "s"), "s").stage).toBe("failed");
    expect(a2aError("r", rpc("INCOMPATIBLE", "no"), "s").stage).toBe("unsupported");
    expect(a2aError("r", rpc("RPC_ERROR", "WORKSPACE_BINDING_REQUIRED"), "s")).toMatchObject({ stage: "failed" });
  });

  test("locateTurn: baseline skips earlier identical prompts; strips the assistant row header", () => {
    const n = promptNeedles("Report status.");
    const t = "<user_message>Report status.</user_message><assistant_response>\nold\n</assistant_response><user_message>Report status.</user_message>";
    expect(locateTurn(t, n, 1)).toEqual({ delivered: true, reply: null });
    const done = `${t}<assistant_response>\n[assistant row | provider=claude]\nnew\n</assistant_response>`;
    expect(locateTurn(done, n, 1).reply).toBe("new");
    expect(locateTurn(done, n, 2).delivered).toBe(false);
    expect(promptNeedles("a < b & c")).toContain("a &lt; b &amp; c");
  });
  /** deliverA2a against scripted deps: `reads` answers successive agent.getTranscript calls (null = unreadable). */
  function scripted(reads: (string | null)[], send: A2aDeps["sendMessage"] = async () => ({ responseId: null })) {
    const stages: string[] = [];
    const replies: string[] = [];
    let sent = 0;
    let i = 0;
    const deps: A2aDeps = {
      sendMessage: async (p, k) => {
        sent++;
        return send(p, k);
      },
      transcript: async () => {
        const r = reads[Math.min(i++, reads.length - 1)];
        if (r === null || r === undefined) throw new Error("transcript unreadable");
        return r;
      },
      progress: (_id, stage) => stages.push(stage),
      onReply: (r) => replies.push(r.text),
      now: Date.now,
      sleep: (ms) => Bun.sleep(ms),
      active: () => true,
    };
    const args = { requestId: "r", epicId: "e1", receiverAgentId: "t1", senderAgentId: "s1", text: "Report status.", expectReply: false, ackTimeoutMs: 60, turnTimeoutMs: 150, pollMs: 5 };
    return { deps, args, stages, replies, sent: () => sent };
  }

  test("unreadable baseline: an earlier identical prompt and its old answer never pass for this delivery", async () => {
    const old = "<user_message>\nReport status.\n</user_message>\n<assistant_response>\nold answer\n</assistant_response>\n";
    const s = scripted([null, null, old]);
    const r = await deliverA2a(s.deps, s.args);
    expect(r.stage).toBe("sent");
    await Bun.sleep(200);
    expect(s.stages).toEqual(["sent"]);
    expect(s.replies).toEqual([]);
    expect(s.sent()).toBe(1);
  });

  test("unreadable baseline, later delivery: acknowledged against the first readable transcript", async () => {
    const old = "<user_message>\nReport status.\n</user_message>\n<assistant_response>\nold answer\n</assistant_response>\n";
    const fresh = `${old}<user_message>\nReport status.\n</user_message>\n<assistant_response>\nnew answer\n</assistant_response>\n`;
    const s = scripted([null, null, old, old, fresh]);
    expect((await deliverA2a(s.deps, s.args)).stage).toBe("backend_acknowledged");
    await Bun.sleep(50);
    expect(s.replies).toEqual(["new answer"]);
  });

  test("link down before the call: failed (not an uncertain sent), retryable", async () => {
    const s = scripted([""], async () => {
      throw new A2aNotSentError("Traycer host disconnected");
    });
    const r = await deliverA2a(s.deps, s.args);
    expect(r.stage).toBe("failed");
    expect(r.message).toContain("not sent");
    expect(r.message).not.toMatch(/may have|uncertain/i);
    expect(s.stages).toEqual([]);
  });
});

