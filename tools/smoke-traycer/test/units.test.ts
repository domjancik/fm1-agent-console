import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAdapter, fixturePath, type SessionRef } from "@fm1/agent-core";
import { Allowlist, parseAllowlist, SMOKE_PROJECT_ID } from "../src/allowlist";
import { GuardedAdapter } from "../src/guard";
import { markdownTable, RecordBuilder, summaryLine } from "../src/record";
import { scanForSecrets, short } from "../src/redact";
import { selectTests } from "../src/runner";
import { marker, markerPrompt, replyWith, transcriptText, userMessages, userTurnsWith } from "../src/transcript";

const tmp = (): string => mkdtempSync(join(tmpdir(), "smoke-unit-"));

function allowlistFile(tasks: unknown): string {
  const path = join(tmp(), "allow.json");
  writeFileSync(path, JSON.stringify({ tasks }));
  return path;
}

async function mockWithAllowlist(live: boolean): Promise<{ guard: GuardedAdapter; mock: MockAdapter; ref: SessionRef; other: SessionRef }> {
  const mock = MockAdapter.fromFixture(fixturePath("mixed"));
  await mock.connect();
  const sessions = await mock.listSessions();
  const [a, b] = sessions;
  if (!a || !b) throw new Error("fixture needs two sessions");
  const list = new Allowlist(allowlistFile([{ epicId: a.ref.taskId, chatIds: [a.ref.sessionId] }]));
  return { guard: new GuardedAdapter(mock, list, live), mock, ref: a.ref, other: { ...b.ref, taskId: "not-allowlisted" } };
}

describe("allowlist", () => {
  test("parses, rejects malformed ids, adds tasks and chats atomically", () => {
    const path = allowlistFile([{ epicId: "e1", chatIds: ["c1"] }]);
    const list = Allowlist.load(path);
    expect(list.hasChat("e1", "c1")).toBe(true);
    expect(list.hasChat("e1", "c2")).toBe(false);
    expect(list.hasChat("e2", "c1")).toBe(false);
    list.addTask("e2", "t5");
    list.addChat("e2", "c9", "first agent");
    expect(parseAllowlist(readFileSync(path, "utf8")).map((t) => [t.epicId, t.chatIds])).toEqual([["e1", ["c1"]], ["e2", ["c9"]]]);
    expect(() => list.addChat("e3", "c1", "")).toThrow(/not disposable/);
    expect(() => parseAllowlist(JSON.stringify({ tasks: [{ epicId: "../x" }] }))).toThrow();
    expect(() => list.addTask("bad/id", "")).toThrow();
  });
});

describe("guard", () => {
  test("refuses every state change without --live and sends nothing", async () => {
    const { guard, mock, ref } = await mockWithAllowlist(false);
    const r = await guard.sendPrompt(ref, "x", "r1");
    expect(r.stage).toBe("unsupported");
    expect(mock.deliveries).toHaveLength(0);
    expect(guard.mutations).toHaveLength(0);
    expect(guard.refusals[0]).toContain("needs --live");
  });

  test("refuses targets outside the allowlist, even with --live", async () => {
    const { guard, mock, other } = await mockWithAllowlist(true);
    for (const r of [
      await guard.sendPrompt(other, "x", "r1"),
      await guard.interrupt(other, "r2"),
      await guard.focus(other, "r3"),
      await guard.respondToApproval({ requestId: "r4", approvalId: "a", sessionRef: other, decision: "approve" }),
      await guard.createSession({ requestId: "r5", task: other, provider: "claude" }),
    ]) {
      expect(r.stage).toBe("unsupported");
    }
    expect(mock.deliveries).toHaveLength(0);
    expect(guard.refusals).toHaveLength(5);
  });

  test("createTask only in the disposable smoke workspace project", async () => {
    const { guard, ref } = await mockWithAllowlist(true);
    const r = await guard.createTask({ requestId: "t", project: { backendId: ref.backendId, hostId: ref.hostId, projectId: "ws:/Users/me/real-repo" }, title: "x", provider: "claude" });
    expect(r.stage).toBe("unsupported");
    expect(guard.refusals[0]).toContain(SMOKE_PROJECT_ID);
  });

  test("allowlisted targets pass through once and are logged", async () => {
    const { guard, mock, ref } = await mockWithAllowlist(true);
    const r = await guard.sendPrompt(ref, "hello", "r1");
    expect(["backend_acknowledged", "sent", "completed"]).toContain(r.stage);
    expect(mock.deliveries).toHaveLength(1);
    expect(guard.mutations).toEqual([{ op: "sendPrompt", target: `${ref.taskId}/${ref.sessionId}`, requestId: "r1", at: expect.any(Number), stage: r.stage }]);
  });

  test("inject reaches subscribers like a backend event", async () => {
    const { guard } = await mockWithAllowlist(true);
    const seen: unknown[] = [];
    const off = guard.subscribe((e) => seen.push(e));
    guard.inject({ type: "exec" });
    off();
    guard.inject({ type: "exec2" });
    expect(seen).toEqual([{ type: "exec" }]);
  });
});

describe("transcript parsing", () => {
  const text = "<user_message>\nFM1_SMOKE_A_1. Respond.\n</user_message>\n\n<assistant_response>\n[assistant row]\nFM1_SMOKE_A_1\n</assistant_response>\n\n<user_message>\nother FM1_SMOKE_A_1x\n</user_message>";
  test("counts user turns and replies per marker", () => {
    expect(userMessages(text)).toHaveLength(2);
    expect(userTurnsWith(text, "FM1_SMOKE_A_1.")).toBe(1);
    expect(userTurnsWith(text, "FM1_SMOKE_A_1")).toBe(2);
    expect(replyWith(text, "FM1_SMOKE_A_1")).toBe(true);
    expect(replyWith(text, "NOPE")).toBe(false);
    expect(transcriptText({ transcript: text })).toBe(text);
    expect(() => transcriptText({})).toThrow();
  });
  test("markers are unique and the prompt matches spec section 6", () => {
    const a = marker("CLAUDE");
    expect(a).toMatch(/^FM1_SMOKE_CLAUDE_[0-9A-Z]+$/);
    expect(marker("CLAUDE")).not.toBe(a);
    expect(markerPrompt(a)).toBe(`${a}\n\nRespond with exactly this marker.\nDo not modify files.`);
  });
});

describe("records", () => {
  test("PASS/FAIL/BLOCKED from checks; table escapes pipes", () => {
    const v = { cli: "1.5.4", host: "1.5.4" };
    const base = { id: "T2", provider: "claude", sessionType: "GUI chat", target: short("51b0ff2e-946b"), operation: "send", expected: "a | b" };
    const pass = new RecordBuilder(base, v);
    pass.check(true, "ok");
    const fail = new RecordBuilder({ ...base, id: "T3" }, v);
    fail.check(false, "bad");
    const blocked = new RecordBuilder({ ...base, id: "T7" }, v);
    blocked.blocked("no approval");
    const recs = [pass.build(), fail.build(), blocked.build()];
    expect(recs.map((r) => r.result)).toEqual(["PASS", "FAIL", "BLOCKED"]);
    expect(recs[1]?.observed).toContain("FAILED: bad");
    expect(markdownTable(recs)).toContain("a \\| b");
    expect(markdownTable(recs)).toContain("51b0ff2e…");
    expect(summaryLine(recs)).toBe("3 tests: 1 PASS, 1 FAIL, 1 BLOCKED, 0 SKIPPED");
  });
});

describe("secret scan", () => {
  test("finds a planted value and reports only file names", () => {
    const dir = tmp();
    writeFileSync(join(dir, "clean.json"), "{}");
    writeFileSync(join(dir, "dirty.log"), "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789");
    const scan = scanForSecrets([dir], ["abcdefghijklmnopqrstuvwxyz0123456789"]);
    expect(scan.files).toBe(2);
    expect(scan.hits.map((h) => h.file.endsWith("dirty.log"))).toEqual([true]);
  });
});

describe("test selection", () => {
  test("read-only runs only T0; live runs T0-T9 and TUI-A2A in order", () => {
    expect(selectTests(false, null).map((t) => t.id)).toEqual(["T0"]);
    expect(selectTests(true, null).map((t) => t.id)).toEqual(["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "TUI-A2A"]);
    expect(selectTests(true, ["tui-a2a"]).map((t) => t.id)).toEqual(["TUI-A2A"]);
    expect(selectTests(false, ["TUI-A2A"])).toEqual([]);
    expect(selectTests(true, ["t2", "T7"]).map((t) => t.id)).toEqual(["T2", "T7"]);
    expect(selectTests(false, ["T2"])).toEqual([]);
  });
});

describe("TUI a2a guard", () => {
  /** MockAdapter plus the TraycerAgentAdapter's promptCapability, routing the target over agent.sendMessage as `sender`. */
  async function a2aGuard(sender: string, live = true, senderListed = true) {
    const mock = MockAdapter.fromFixture(fixturePath("mixed"));
    await mock.connect();
    const [a] = await mock.listSessions();
    if (!a) throw new Error("fixture needs a session");
    const chatIds = senderListed ? [a.ref.sessionId, sender] : [a.ref.sessionId];
    const list = new Allowlist(allowlistFile([{ epicId: a.ref.taskId, chatIds, ...(senderListed ? { a2aSenderId: sender } : {}) }]));
    const inner = Object.assign(Object.create(mock) as MockAdapter, {
      promptCapability: (ref: SessionRef) => (ref.sessionId === a.ref.sessionId ? { acceptsPrompt: true, via: "agent.sendMessage", senderAgentId: sender } : null),
    });
    return { guard: new GuardedAdapter(inner, list, live), mock, ref: a.ref, list };
  }

  test("refuses an a2a prompt whose sender agent is not allowlisted; nothing sent", async () => {
    const { guard, mock, ref } = await a2aGuard("real-sender-1", true, false);
    const r = await guard.sendPrompt(ref, "x", "r1");
    expect(r.stage).toBe("unsupported");
    expect(guard.refusals[0]).toContain("a2a sender real-sender-1 is not in the disposable allowlist");
    expect(mock.deliveries).toHaveLength(0);
    expect(guard.mutations).toHaveLength(0);
  });

  test("allowlisted receiver and sender pass once; the allowlist feeds a2aSenders()", async () => {
    const { guard, mock, ref, list } = await a2aGuard("console-1");
    expect(list.a2aSenders()).toEqual([{ agentId: "console-1", epicId: ref.taskId }]);
    const r = await guard.sendPrompt(ref, "hello", "r2");
    expect(["backend_acknowledged", "sent", "completed"]).toContain(r.stage);
    expect(mock.deliveries).toHaveLength(1);
  });

  test("route unknown until the task's agents load: the guard loads them, then refuses a non-allowlisted sender", async () => {
    const mock = MockAdapter.fromFixture(fixturePath("mixed"));
    await mock.connect();
    const [a] = await mock.listSessions();
    if (!a) throw new Error("fixture needs a session");
    let loaded = false;
    const inner = Object.assign(Object.create(mock) as MockAdapter, {
      listSessions: async (taskId?: string) => {
        loaded = true;
        return mock.listSessions(taskId);
      },
      promptCapability: (ref: SessionRef) => (loaded && ref.sessionId === a.ref.sessionId ? { acceptsPrompt: true, via: "agent.sendMessage", senderAgentId: "operator-agent" } : null),
    });
    const guard = new GuardedAdapter(inner, new Allowlist(allowlistFile([{ epicId: a.ref.taskId, chatIds: [a.ref.sessionId] }])), true);
    const r = await guard.sendPrompt(a.ref, "x", "r-cold");
    expect(r.stage).toBe("unsupported");
    expect(guard.refusals[0]).toContain("a2a sender operator-agent is not in the disposable allowlist");
    expect(mock.deliveries).toHaveLength(0);
  });

  test("without --live the a2a prompt is refused before any route lookup", async () => {
    const { guard, mock, ref } = await a2aGuard("console-1", false);
    expect((await guard.sendPrompt(ref, "x", "r3")).stage).toBe("unsupported");
    expect(guard.refusals[0]).toContain("needs --live");
    expect(mock.deliveries).toHaveLength(0);
  });

  test("allowlist: a2aSenderId must be one of the task's chatIds and survives a save", () => {
    expect(() => parseAllowlist(JSON.stringify({ tasks: [{ epicId: "e1", chatIds: ["c1"], a2aSenderId: "c2" }] }))).toThrow(/a2aSenderId/);
    const path = allowlistFile([{ epicId: "e1", chatIds: ["c1"], a2aSenderId: "c1" }]);
    const list = Allowlist.load(path);
    list.addChat("e1", "c3", "tui receiver");
    expect(parseAllowlist(readFileSync(path, "utf8"))[0]?.a2aSenderId).toBe("c1");
  });
});

describe("TUI typing guard and tool", () => {
  async function typingGuard(route: { via: string; senderAgentId?: string }, receiverListed = true) {
    const mock = MockAdapter.fromFixture(fixturePath("mixed"));
    await mock.connect();
    const [a] = await mock.listSessions();
    if (!a) throw new Error("fixture needs a session");
    const list = new Allowlist(allowlistFile([{ epicId: a.ref.taskId, chatIds: receiverListed ? [a.ref.sessionId] : ["someone-else"] }]));
    const inner = Object.assign(Object.create(mock) as MockAdapter, {
      promptCapability: (ref: SessionRef) => (ref.sessionId === a.ref.sessionId ? { acceptsPrompt: true, ...route } : null),
    });
    return { guard: new GuardedAdapter(inner, list, true), mock, ref: a.ref, list };
  }

  test("terminal.write to an allowlisted terminal: passes; with self-send fallback the sender is the receiver (allowlisted)", async () => {
    const plain = await typingGuard({ via: "terminal.write" });
    expect(["backend_acknowledged", "sent", "completed"]).toContain((await plain.guard.sendPrompt(plain.ref, "x", "w1")).stage);
    const self = await typingGuard({ via: "terminal.write", senderAgentId: "" });
    const selfRef = self.ref;
    const selfGuard = new GuardedAdapter(
      Object.assign(Object.create(self.mock) as MockAdapter, { promptCapability: () => ({ acceptsPrompt: true, via: "terminal.write", senderAgentId: selfRef.sessionId }) }),
      self.list,
      true,
    );
    expect(selfGuard.refuseA2aSender(selfRef)).toBeNull();
  });

  test("terminal.write whose a2a fallback sender is not allowlisted, or a terminal outside the allowlist: refused, nothing sent", async () => {
    const fb = await typingGuard({ via: "terminal.write", senderAgentId: "real-agent" });
    expect((await fb.guard.sendPrompt(fb.ref, "x", "w2")).stage).toBe("unsupported");
    expect(fb.guard.refusals[0]).toContain("a2a sender real-agent is not in the disposable allowlist");
    const outside = await typingGuard({ via: "terminal.write" }, false);
    expect((await outside.guard.sendPrompt(outside.ref, "x", "w3")).stage).toBe("unsupported");
    expect(outside.guard.refusals[0]).toContain("not in the disposable allowlist");
    expect(fb.mock.deliveries).toHaveLength(0);
    expect(outside.mock.deliveries).toHaveLength(0);
  });

  test("tui-typing tool: agents outside the allowlist are refused; a2a task notifications are counted apart", async () => {
    const { allowedTask, notificationHits } = await import("../src/tui-typing");
    const list = new Allowlist(allowlistFile([{ epicId: "e1", chatIds: ["t1"] }]));
    expect(allowedTask(list, "t1")).toEqual({ epicId: "e1" });
    expect(allowedTask(list, "billing-agent")).toMatchObject({ refused: expect.stringContaining("not in the disposable allowlist") });
    const t = "<user_message>\n<task-notification>\n<event>[traycer:agent-message] M1</event>\n</task-notification>\n</user_message>\n<user_message>\nM1\n</user_message>";
    expect(notificationHits(t, "M1")).toBe(1);
  });
});

describe("adapter step tools", () => {
  test("transcript-size reports sizes only, never text", async () => {
    const { sizeReport } = await import("../src/transcript-size");
    const mock = MockAdapter.fromFixture(fixturePath("mixed"));
    await mock.connect();
    const s = (await mock.listSessions())[0]!;
    const secret = "the operator's private words";
    const r = sizeReport({ ...s, summary: secret, details: { lastMessage: secret, lastPrompt: "hi" } }, 80_134, 42);
    expect(r).toEqual({ epic: s.ref.taskId.slice(0, 8), agent: s.ref.sessionId.slice(0, 8), runtime: s.runtime, transcriptChars: 80_134, fetchMs: 42, lastMessageChars: secret.length, lastPromptChars: 2, summaryChars: secret.length });
    expect(JSON.stringify(r)).not.toContain("private");
  });

  test("--a2a-self context: no allowlist sender, self-send on", async () => {
    const { SmokeContext } = await import("../src/context");
    const dir = tmp();
    const path = allowlistFile([{ epicId: "e1", chatIds: ["c1", "t1"], a2aSenderId: "c1" }]);
    const self = new SmokeContext(false, dir, { a2aSender: [], a2aSelfSend: true }, path);
    expect(self.a2aSelf).toBe(true);
    const normal = new SmokeContext(false, dir, {}, path);
    expect(normal.a2aSelf).toBe(false);
  });
});
