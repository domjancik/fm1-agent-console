import { afterEach, describe, expect, test } from "bun:test";
import type { AgentEvent, SessionRef } from "@fm1/agent-core";
import type { FakeStreamSub } from "./fake-host";
import { chatSnapshot, HOST, makeHarness, standardWorld, turnFrame, until, USER, type Harness } from "./scenario";

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

const ALPHA = "ws:/Users/me/dev/alpha";
const ref = (taskId: string, sessionId: string, projectId = ALPHA): SessionRef => ({ backendId: "traycer", hostId: HOST, projectId, taskId, sessionId });
const progressOf = (events: AgentEvent[], requestId: string) =>
  events.flatMap((e) => (e.type === "command_progress" && e.requestId === requestId ? [e.stage] : []));

type ChatScript = (sub: FakeStreamSub, frame: Record<string, unknown>) => void;

/** Fake chat host: snapshot on subscribe, then the script answers client frames. */
function chatHost(script: ChatScript, snapshotExtra: Record<string, unknown> = {}) {
  return {
    onSubscribe: (sub: FakeStreamSub) => {
      if (sub.method !== "chat.subscribe") return;
      const p = sub.params as { epicId: string; chatId: string };
      sub.send(chatSnapshot(p.epicId, p.chatId, snapshotExtra));
    },
    onClientFrame: script,
  };
}

const ack = (sub: FakeStreamSub, frame: Record<string, unknown>, status = "accepted", code: string | null = null, reason: string | null = null) =>
  sub.send({ kind: "actionAck", epicId: frame.epicId, chatId: frame.chatId, clientActionId: frame.clientActionId, action: frame.kind, status, reason, code });

const accepted = (sub: FakeStreamSub, frame: Record<string, unknown>) =>
  sub.send({
    kind: "messageAccepted",
    epicId: frame.epicId,
    chatId: frame.chatId,
    message: {
      role: "user",
      messageId: frame.messageId,
      sender: { type: "user", userId: USER },
      message: { kind: "user", content: frame.content, browserAnnotations: [] },
      timestamp: 1,
      sessionAnchor: null,
    },
  });

describe("sendPrompt", () => {
  test("stages accepted_locally -> sent -> backend_acknowledged -> completed, correlated by userMessageId", async () => {
    h = makeHarness({
      world: standardWorld(),
      host: chatHost((sub, frame) => {
        if (frame.kind !== "send") return;
        const mid = String(frame.messageId);
        // A turn for someone else's message must not complete our request.
        sub.send(turnFrame(sub, "running", "someone-else", "turn-x"));
        ack(sub, frame);
        accepted(sub, frame);
        sub.send(turnFrame(sub, "starting", mid, "turn:placeholder"));
        sub.send(turnFrame(sub, "running", mid, "harness-turn"));
        sub.send(turnFrame(sub, "completed", "someone-else", "turn-x"));
        setTimeout(() => sub.send(turnFrame(sub, "completed", mid, "harness-turn")), 30);
      }),
    });
    await h.adapter.connect();
    await h.adapter.listSessions();
    const result = await h.adapter.sendPrompt(ref("e1", "c1"), "Respond with OK", "req-1");
    expect(result).toEqual({ requestId: "req-1", stage: "backend_acknowledged" });
    const harness = h;
    await until(() => progressOf(harness.events, "req-1").includes("completed"));
    expect(progressOf(h.events, "req-1")).toEqual(["accepted_locally", "sent", "backend_acknowledged", "completed"]);

    const chat = h.host.subs.find((s) => s.method === "chat.subscribe")!;
    const sends = chat.clientFrames.filter((f) => f.kind === "send");
    expect(sends).toHaveLength(1);
    const send = sends[0]!;
    expect(send).toMatchObject({
      epicId: "e1",
      chatId: "c1",
      sender: { type: "user", userId: USER },
      sentFromHostId: HOST,
      accountContext: { type: "PERSONAL" },
      deliveryPolicy: "auto",
      settings: { harnessId: "codex", model: "gpt-5.6-luna" },
    });
    expect(JSON.stringify(send.content)).toContain("Respond with OK");

    // Same requestId again: no second send.
    expect((await h.adapter.sendPrompt(ref("e1", "c1"), "Respond with OK", "req-1")).stage).toBe("backend_acknowledged");
    expect(chat.clientFrames.filter((f) => f.kind === "send")).toHaveLength(1);
  });

  test("errored turn reports failed progress after acknowledgement", async () => {
    h = makeHarness({
      world: standardWorld(),
      host: chatHost((sub, frame) => {
        if (frame.kind !== "send") return;
        ack(sub, frame);
        accepted(sub, frame);
        sub.send(turnFrame(sub, "running", String(frame.messageId)));
        sub.send(turnFrame(sub, "errored", String(frame.messageId)));
      }),
    });
    await h.adapter.connect();
    await h.adapter.listSessions();
    expect((await h.adapter.sendPrompt(ref("e1", "c1"), "x", "req-e")).stage).toBe("backend_acknowledged");
    const harness = h;
    await until(() => progressOf(harness.events, "req-e").includes("failed"));
  });

  test("host rejection -> failed; no ack -> sent (uncertain, not resent)", async () => {
    let mode: "reject" | "silent" = "reject";
    h = makeHarness({
      world: standardWorld(),
      config: { ackTimeoutMs: 300 },
      host: chatHost((sub, frame) => {
        if (frame.kind !== "send") return;
        if (mode === "reject") ack(sub, frame, "rejected", "CHAT_BUSY", "queue full");
      }),
    });
    await h.adapter.connect();
    await h.adapter.listSessions();
    expect(await h.adapter.sendPrompt(ref("e1", "c1"), "x", "req-r")).toEqual({ requestId: "req-r", stage: "failed", message: "CHAT_BUSY: queue full" });
    mode = "silent";
    const silent = await h.adapter.sendPrompt(ref("e1", "c1"), "x", "req-s");
    expect(silent.stage).toBe("sent");
    expect(silent.message).toContain("not resent");
  });

  test("terminal session (a2a route, no sender) -> unsupported with reason; unknown session -> target_unavailable; other backend -> target_unavailable", async () => {
    h = makeHarness({ world: standardWorld(), host: chatHost(() => undefined), config: { tuiRoute: "a2a" } });
    await h.adapter.connect();
    await h.adapter.listSessions();
    const tui = await h.adapter.sendPrompt(ref("e1", "t1"), "x", "req-t");
    expect(tui.stage).toBe("unsupported");
    expect(tui.message).toContain("terminal");
    expect((await h.adapter.sendPrompt(ref("e1", "nope"), "x", "req-n")).stage).toBe("target_unavailable");
    expect((await h.adapter.sendPrompt({ ...ref("e1", "c1"), backendId: "mock" }, "x", "req-m")).stage).toBe("target_unavailable");
    expect((await h.adapter.sendPrompt({ ...ref("e1", "c1"), hostId: "another" }, "x", "req-h")).stage).toBe("target_unavailable");
    expect(h.host.subs.filter((s) => s.method === "chat.subscribe").flatMap((s) => s.clientFrames)).toEqual([]);
  });

  test("disconnected adapter refuses with failed, never sends", async () => {
    h = makeHarness({ world: standardWorld() });
    const result = await h.adapter.sendPrompt(ref("e1", "c1"), "x", "req-d");
    expect(result.stage).toBe("failed");
  });
});

describe("respondToApproval", () => {
  const pending = { pendingApprovals: [{ approvalId: "ap-1", toolName: "Bash", description: "ls", input: null, requestedAt: 5 }] };

  test("exact approvalId decision -> completed on approvalResolved", async () => {
    h = makeHarness({
      world: standardWorld(),
      host: chatHost((sub, frame) => {
        if (frame.kind !== "approvalDecision") return;
        ack(sub, frame);
        sub.send({ kind: "approvalResolved", epicId: "e1", chatId: "c1", approvalId: frame.approvalId, decision: frame.decision, resolvedAt: 9 });
      }, pending),
    });
    await h.adapter.connect();
    await h.adapter.listSessions();
    const result = await h.adapter.respondToApproval({ requestId: "a-1", approvalId: "ap-1", sessionRef: ref("e1", "c1"), decision: "approve" });
    expect(result).toEqual({ requestId: "a-1", stage: "completed" });
    const frame = h.host.subs.find((s) => s.method === "chat.subscribe")!.clientFrames.find((f) => f.kind === "approvalDecision");
    expect(frame).toMatchObject({ approvalId: "ap-1", decision: { approved: true }, epicId: "e1", chatId: "c1" });
    expect(h.events.some((e) => e.type === "approval_resolved" && e.approvalId === "ap-1")).toBe(true);
    // Already resolved now: a second decision is stale.
    const again = await h.adapter.respondToApproval({ requestId: "a-2", approvalId: "ap-1", sessionRef: ref("e1", "c1"), decision: "deny" });
    expect(again.stage).toBe("target_unavailable");
  });

  test("approval not pending in the chat snapshot -> target_unavailable, nothing sent", async () => {
    h = makeHarness({ world: standardWorld(), host: chatHost(() => undefined) });
    await h.adapter.connect();
    await h.adapter.listSessions();
    const result = await h.adapter.respondToApproval({ requestId: "a-3", approvalId: "ap-stale", sessionRef: ref("e1", "c1"), decision: "approve" });
    expect(result.stage).toBe("target_unavailable");
    expect(h.host.subs.flatMap((s) => s.clientFrames).filter((f) => f.kind === "approvalDecision")).toEqual([]);
  });

  test("host rejects a decision for an approval it already resolved -> target_unavailable", async () => {
    h = makeHarness({
      world: standardWorld(),
      host: chatHost((sub, frame) => {
        if (frame.kind === "approvalDecision") ack(sub, frame, "rejected", "APPROVAL_NOT_FOUND", "approval already resolved");
      }, pending),
    });
    await h.adapter.connect();
    await h.adapter.listSessions();
    const result = await h.adapter.respondToApproval({ requestId: "a-4", approvalId: "ap-1", sessionRef: ref("e1", "c1"), decision: "deny" });
    expect(result.stage).toBe("target_unavailable");
  });

  test("approval belonging to another session -> target_unavailable", async () => {
    h = makeHarness({ world: standardWorld(), host: chatHost(() => undefined, pending) });
    await h.adapter.connect();
    await h.adapter.listSessions();
    h.adapter.watchSession(ref("e1", "c1"));
    const harness = h;
    await until(() => harness.events.some((e) => e.type === "approval_requested"));
    const result = await h.adapter.respondToApproval({ requestId: "a-5", approvalId: "ap-1", sessionRef: ref("e1", "c2"), decision: "approve" });
    expect(result.stage).toBe("target_unavailable");
  });
});

describe("selected-session chat stream", () => {
  test("watching a chat reflects its turn state and pending approvals; completion seen live is completed_unread", async () => {
    let chat: FakeStreamSub | null = null;
    h = makeHarness({
      world: standardWorld(),
      host: { onSubscribe: (sub) => {
        if (sub.method !== "chat.subscribe") return;
        chat = sub;
        sub.send(chatSnapshot("e1", "c1"));
      } },
    });
    await h.adapter.connect();
    await h.adapter.listSessions();
    h.adapter.watchSession(ref("e1", "c1"));
    await until(() => chat !== null);
    const sub = chat as unknown as FakeStreamSub;
    const state = () => {
      for (let i = harness.events.length - 1; i >= 0; i -= 1) {
        const e = harness.events[i]!;
        if (e.type === "session_upserted" && e.session.ref.sessionId === "c1") return e.session.status.observed.state;
      }
      return undefined;
    };
    const harness = h;
    await until(() => state() === "idle");
    sub.send(turnFrame(sub, "running", "m1"));
    await until(() => state() === "working");
    sub.send({ kind: "approvalRequested", epicId: "e1", chatId: "c1", approval: { approvalId: "ap-9", toolName: "Edit", description: "edit file", input: null, requestedAt: 3 } });
    await until(() => state() === "approval_required");
    sub.send({ kind: "approvalResolved", epicId: "e1", chatId: "c1", approvalId: "ap-9", decision: { approved: true }, resolvedAt: 4 });
    await until(() => state() === "working");
    sub.send(turnFrame(sub, "completed", "m1"));
    await until(() => state() === "completed_unread");
    expect((await h.adapter.focus(ref("e1", "c1"), "f-1")).stage).toBe("completed");
    await until(() => state() === "completed_read");
  });
});

describe("interrupt, focus, create", () => {
  test("interrupt uses agent.stop with no agent context", async () => {
    h = makeHarness({ world: standardWorld() });
    await h.adapter.connect();
    await h.adapter.listSessions();
    expect(await h.adapter.interrupt(ref("e1", "c1"), "i-1")).toEqual({ requestId: "i-1", stage: "completed" });
    expect(h.host.requests.find((r) => r.method === "agent.stop")?.params).toEqual({ epicId: "e1", agentId: "c1", cascade: false });
    expect((await h.adapter.interrupt(ref("e1", "missing"), "i-2")).stage).toBe("target_unavailable");
  });

  test("focus activates the Traycer window by default; deep link only behind focusDeepLink", async () => {
    h = makeHarness({ world: standardWorld() });
    await h.adapter.connect();
    await h.adapter.listSessions();
    const result = await h.adapter.focus(ref("e1", "c1"), "f-2");
    expect(result.stage).toBe("completed");
    expect(result.message).toContain("window activated");
    expect(h.commands.at(-1)).toMatchObject({ program: "open", args: ["-a", "Traycer"] });
    await h.dispose();

    h = makeHarness({ world: standardWorld(), config: { focusDeepLink: true } });
    expect(h.adapter.getCapabilities().focus).toMatchObject({ supported: true, level: "tile", verified: "code" });
    await h.adapter.connect();
    await h.adapter.listSessions();
    await h.adapter.focus(ref("e1", "c1"), "f-3");
    expect(h.commands.at(-1)?.args).toEqual(["traycer://open/epic/e1/chat/c1?focus=composer"]);
    // Terminal agents get the same link (gui-app opens chat and terminal-agent tiles alike).
    await h.adapter.focus(ref("e1", "t1"), "f-4");
    expect(h.commands.at(-1)?.args).toEqual(["traycer://open/epic/e1/chat/t1?focus=composer"]);
  });

  test("createTask runs `traycer task create --json --idempotency-key` with the agent env stripped", async () => {
    const prev = process.env.TRAYCER_AGENT_ID;
    process.env.TRAYCER_AGENT_ID = "agent-ctx";
    const world = standardWorld();
    h = makeHarness({
      world,
      commandOutput: (program) => {
        if (program !== "traycer") return { code: 0, stdout: "" };
        world.tasks.push({ epicId: "e-new", title: "Fix the bug", workspace: "/Users/me/dev/alpha", updatedAt: 99 });
        return { code: 0, stdout: '{"type":"progress"}\n{"type":"result","status":"ok","data":{"taskId":"e-new","agentId":"c-new","alreadyCreated":false}}\n' };
      },
    });
    try {
      await h.adapter.connect();
      const project = { backendId: "traycer", hostId: HOST, projectId: ALPHA };
      const result = await h.adapter.createTask({ requestId: "t-1", project, title: "Fix the bug", provider: "codex", prompt: "Fix the bug in parser" });
      expect(result.stage).toBe("backend_acknowledged");
      expect(result.task?.ref).toEqual({ ...project, taskId: "e-new" });
      const call = h.commands.find((c) => c.program === "traycer")!;
      expect(call.args).toEqual([
        "task", "create", "--json", "--no-progress",
        "--message", "Fix the bug in parser",
        "--harness", "codex", "--model", "gpt-5.6-luna",
        "--idempotency-key", "fm1-t-1",
        "--title", "Fix the bug",
        "--workspace", "/Users/me/dev/alpha",
        "--reasoning-effort", "low",
        "--permission-mode", "supervised",
      ]);
      expect(call.env.TRAYCER_AGENT_ID).toBeUndefined();
      expect(h.events.some((e) => e.type === "task_upserted" && e.task.ref.taskId === "e-new")).toBe(true);
      const noModel = await h.adapter.createTask({ requestId: "t-2", project, title: "x", provider: "other" });
      expect(noModel.stage).toBe("unsupported");
    } finally {
      if (prev === undefined) delete process.env.TRAYCER_AGENT_ID;
      else process.env.TRAYCER_AGENT_ID = prev;
    }
  });

  test("createTask CLI error is failed; an outcome-unknown error is sent (never retried)", async () => {
    let stdout = '{"type":"result","status":"error","error":{"code":"HOST_BUSY","message":"traycer: the host did not create the Task."}}';
    h = makeHarness({ world: standardWorld(), commandOutput: () => ({ code: 1, stdout }) });
    await h.adapter.connect();
    const project = { backendId: "traycer", hostId: HOST, projectId: ALPHA };
    expect((await h.adapter.createTask({ requestId: "t-3", project, title: "x", provider: "claude" })).stage).toBe("failed");
    stdout = '{"type":"result","status":"error","error":{"code":"HOST_REQUEST_OUTCOME_UNKNOWN","message":"Task a (first agent b) may have been created."}}';
    expect((await h.adapter.createTask({ requestId: "t-4", project, title: "x", provider: "claude" })).stage).toBe("sent");
  });

  test("createSession uses epic.createChat with a client-minted chatId as idempotency key", async () => {
    h = makeHarness({ world: standardWorld() });
    await h.adapter.connect();
    await h.adapter.listSessions();
    const task = { backendId: "traycer", hostId: HOST, projectId: ALPHA, taskId: "e1" };
    const result = await h.adapter.createSession({ requestId: "s-1", task, provider: "claude", prompt: "hello" });
    expect(result.stage).toBe("backend_acknowledged");
    expect(result.session?.provider).toBe("claude");
    expect(result.session?.runtime).toBe("chat");
    const req = h.host.requests.find((r) => r.method === "epic.createChat")!;
    const params = req.params as Record<string, unknown>;
    expect(params).toMatchObject({ epicId: "e1", hostId: HOST, parentId: null, workspaceMode: "inherit", settings: { harnessId: "claude", model: "haiku", permissionMode: "supervised" } });
    expect(req.idempotencyKey).toBe(params.chatId);
    expect(result.session?.ref.sessionId).toBe(params.chatId as string);
    expect((await h.adapter.createSession({ requestId: "s-2", task: { ...task, taskId: "nope" }, provider: "claude" })).stage).toBe("target_unavailable");
  });
});

describe("file-edit approvals (host 1.5.4 fileEditApproval* frames, seen live in T7)", () => {
  const card = { approvalId: "fe-1", toolName: "Write", description: "Create file", paths: ["/smoke/SMOKE_APPROVAL.txt"], operation: "create", input: null, requestedAt: 7 };

  test("fileEditApprovalRequested -> approval_required with paths; deny sends fileEditApprovalDecision; stale after", async () => {
    let chatSub: FakeStreamSub | null = null;
    h = makeHarness({
      world: standardWorld(),
      host: {
        onSubscribe: (sub: FakeStreamSub) => {
          if (sub.method !== "chat.subscribe") return;
          const p = sub.params as { epicId: string; chatId: string };
          sub.send(chatSnapshot(p.epicId, p.chatId));
          chatSub = sub;
        },
        onClientFrame: (sub: FakeStreamSub, frame: Record<string, unknown>) => {
          if (frame.kind !== "fileEditApprovalDecision") return;
          ack(sub, frame);
          sub.send({ kind: "fileEditApprovalResolved", epicId: "e1", chatId: "c1", approvalId: frame.approvalId, decision: frame.decision, resolvedAt: 9 });
        },
      },
    });
    await h.adapter.connect();
    await h.adapter.listSessions();
    h.adapter.watchSession(ref("e1", "c1"));
    const harness = h;
    await until(() => chatSub !== null);
    chatSub!.send({ kind: "fileEditApprovalRequested", epicId: "e1", chatId: "c1", approval: card });
    await until(() => harness.events.some((e) => e.type === "approval_requested"));
    const requested = h.events.find((e) => e.type === "approval_requested");
    expect(requested?.type === "approval_requested" && requested.approval).toMatchObject({ id: "fe-1", summary: "Write: Create file /smoke/SMOKE_APPROVAL.txt" });
    await until(() => harness.events.some((e) => e.type === "session_upserted" && e.session.ref.sessionId === "c1" && e.session.status.observed.state === "approval_required"));
    expect((await h.adapter.listApprovals()).map((a) => a.id)).toEqual(["fe-1"]);

    const result = await h.adapter.respondToApproval({ requestId: "fe-a", approvalId: "fe-1", sessionRef: ref("e1", "c1"), decision: "deny" });
    expect(result).toEqual({ requestId: "fe-a", stage: "completed" });
    const frames = chatSub!.clientFrames.filter((f) => String(f.kind).endsWith("ApprovalDecision") || f.kind === "approvalDecision");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: "fileEditApprovalDecision", approvalId: "fe-1", decision: { approved: false } });
    expect(h.events.some((e) => e.type === "approval_resolved" && e.approvalId === "fe-1")).toBe(true);
    const again = await h.adapter.respondToApproval({ requestId: "fe-b", approvalId: "fe-1", sessionRef: ref("e1", "c1"), decision: "approve" });
    expect(again.stage).toBe("target_unavailable");
  });

  test("a pending file-edit card in the chat snapshot is listed and decided with the file-edit frame", async () => {
    h = makeHarness({
      world: standardWorld(),
      host: chatHost((sub, frame) => {
        if (frame.kind !== "fileEditApprovalDecision") return;
        ack(sub, frame);
        sub.send({ kind: "fileEditApprovalResolved", epicId: "e1", chatId: "c1", approvalId: frame.approvalId, decision: frame.decision, resolvedAt: 9 });
      }, { pendingFileEditApprovals: [card] }),
    });
    await h.adapter.connect();
    await h.adapter.listSessions();
    const result = await h.adapter.respondToApproval({ requestId: "fe-c", approvalId: "fe-1", sessionRef: ref("e1", "c1"), decision: "approve" });
    expect(result.stage).toBe("completed");
    const sent = h.host.subs.flatMap((s) => s.clientFrames).filter((f) => f.kind === "fileEditApprovalDecision");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ decision: { approved: true } });
  });
});
