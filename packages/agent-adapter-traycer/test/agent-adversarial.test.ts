// Adversarial review regressions: duplicate dispatch on retry after a mid-send stream close,
// approvals answered twice concurrently, decisions whose stream closes before the ack.
import { afterEach, describe, expect, test } from "bun:test";
import type { SessionRef } from "@fm1/agent-core";
import type { FakeStreamSub } from "./fake-host";
import { chatRecord, chatSnapshot, HOST, listRevision, makeHarness, standardWorld, until, type Harness } from "./scenario";

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

const ref = (taskId: string, sessionId: string): SessionRef => ({
  backendId: "traycer",
  hostId: HOST,
  projectId: "ws:/Users/me/dev/alpha",
  taskId,
  sessionId,
});

type Script = (sub: FakeStreamSub, frame: Record<string, unknown>) => void;

function chatHost(script: Script, snapshotExtra: Record<string, unknown> = {}) {
  return {
    onSubscribe: (sub: FakeStreamSub) => {
      if (sub.method !== "chat.subscribe") return;
      const p = sub.params as { epicId: string; chatId: string };
      sub.send(chatSnapshot(p.epicId, p.chatId, snapshotExtra));
    },
    onClientFrame: script,
  };
}

const framesOf = (harness: Harness, kind: string) => harness.host.subs.flatMap((s) => s.clientFrames).filter((f) => f.kind === kind);

describe("duplicate dispatch", () => {
  test("chat stream closed right after the send frame: uncertain 'sent', and a retry with the same requestId never resends", async () => {
    h = makeHarness({
      world: standardWorld(),
      config: { ackTimeoutMs: 1_500 },
      host: chatHost((sub, frame) => {
        // The frame reached the host; the stream dies before any ack.
        if (frame.kind === "send") setTimeout(() => sub.fatal("INTERNAL"), 5);
      }),
    });
    await h.adapter.connect();
    await h.adapter.listSessions();
    const first = await h.adapter.sendPrompt(ref("e1", "c1"), "hello", "req-dup");
    expect(first.stage).toBe("sent");
    expect(first.message ?? "").toMatch(/uncertain/);
    const retry = await h.adapter.sendPrompt(ref("e1", "c1"), "hello", "req-dup");
    expect(retry.stage).toBe("sent");
    await Bun.sleep(100);
    expect(framesOf(h, "send")).toHaveLength(1);
  }, 10_000);
});

describe("approvals answered twice", () => {
  const pending = { pendingApprovals: [{ approvalId: "ap-1", toolName: "Bash", description: "ls", input: null, requestedAt: 5 }] };

  test("two concurrent decisions (approve + deny) for one approval: exactly one decision frame, the other is refused", async () => {
    h = makeHarness({
      world: standardWorld(),
      host: chatHost((sub, frame) => {
        if (frame.kind !== "approvalDecision") return;
        setTimeout(() => {
          sub.send({ kind: "actionAck", epicId: "e1", chatId: "c1", clientActionId: frame.clientActionId, action: frame.kind, status: "accepted", reason: null, code: null });
          sub.send({ kind: "approvalResolved", epicId: "e1", chatId: "c1", approvalId: frame.approvalId, decision: frame.decision, resolvedAt: 9 });
        }, 40);
      }, pending),
    });
    await h.adapter.connect();
    await h.adapter.listSessions();
    const [a, b] = await Promise.all([
      h.adapter.respondToApproval({ requestId: "d-1", approvalId: "ap-1", sessionRef: ref("e1", "c1"), decision: "approve" }),
      h.adapter.respondToApproval({ requestId: "d-2", approvalId: "ap-1", sessionRef: ref("e1", "c1"), decision: "deny" }),
    ]);
    expect(framesOf(h, "approvalDecision")).toHaveLength(1);
    expect(framesOf(h, "approvalDecision")[0]).toMatchObject({ decision: { approved: true } });
    expect(a.stage).toBe("completed");
    expect(b.stage).toBe("target_unavailable");
  }, 10_000);

  test("stream closes after the decision frame, before the ack: 'sent' (uncertain), retry with the same requestId never resends", async () => {
    h = makeHarness({
      world: standardWorld(),
      config: { ackTimeoutMs: 1_500 },
      host: chatHost((sub, frame) => {
        if (frame.kind === "approvalDecision") setTimeout(() => sub.fatal("INTERNAL"), 5);
      }, pending),
    });
    await h.adapter.connect();
    await h.adapter.listSessions();
    const decision = { requestId: "d-3", approvalId: "ap-1", sessionRef: ref("e1", "c1"), decision: "deny" as const };
    const first = await h.adapter.respondToApproval(decision);
    expect(first.stage).toBe("sent");
    const retry = await h.adapter.respondToApproval(decision);
    expect(retry.stage).toBe("sent");
    await Bun.sleep(100);
    expect(framesOf(h, "approvalDecision")).toHaveLength(1);
  }, 10_000);
});

describe("stale ids after archive/delete", () => {
  test("archived chat: a send with the old ref is target_unavailable and nothing is written", async () => {
    const world = standardWorld();
    h = makeHarness({ world, host: chatHost(() => undefined) });
    await h.adapter.connect();
    await h.adapter.listSessions();
    const records = await h.host.waitForSub("host.chatRecords.subscribe");
    const chat = world.chats.find((c) => c.chatId === "c1");
    if (!chat) throw new Error("fixture changed");
    chat.archived = true;
    records.send({ kind: "upsert", epicId: "e1", chatId: "c1", revision: 9, listRevision, record: chatRecord(chat) });
    const harness = h;
    await until(() => harness.events.some((e) => e.type === "session_removed" && e.ref.sessionId === "c1"));
    const sent = await h.adapter.sendPrompt(ref("e1", "c1"), "hello", "r-archived");
    expect(sent.stage).toBe("target_unavailable");
    expect(framesOf(h, "send")).toHaveLength(0);
  });

  test("chat deleted on the host before the feed says so: NOT_FOUND -> target_unavailable, nothing written", async () => {
    const world = standardWorld();
    h = makeHarness({ world, host: chatHost(() => undefined) });
    await h.adapter.connect();
    await h.adapter.listSessions();
    world.chats = world.chats.filter((c) => c.chatId !== "c1");
    const sent = await h.adapter.sendPrompt(ref("e1", "c1"), "hello", "r-deleted");
    expect(sent.stage).toBe("target_unavailable");
    expect(framesOf(h, "send")).toHaveLength(0);
  });
});
