import { afterEach, describe, expect, test } from "bun:test";
import { effectiveState, isInferred, type Session, type SessionRef } from "@fm1/agent-core";
import { chatRecord, chatSnapshot, HOST, listRevision, makeHarness, standardWorld, until, USER, type Harness } from "./scenario";

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

const ref = (taskId: string, sessionId: string, projectId = "ws:/Users/me/dev/alpha"): SessionRef => ({
  backendId: "traycer",
  hostId: HOST,
  projectId,
  taskId,
  sessionId,
});

function lastSession(harness: Harness, sessionId: string): Session | undefined {
  for (let i = harness.events.length - 1; i >= 0; i -= 1) {
    const e = harness.events[i]!;
    if (e.type === "session_upserted" && e.session.ref.sessionId === sessionId) return e.session;
  }
  return undefined;
}

describe("handshake and connection", () => {
  test("connects with the fm1-console identity, announces connected, opens the three feeds", async () => {
    h = makeHarness({ world: standardWorld() });
    await h.adapter.connect();
    expect(h.host.opens[0]?.clientIdentity).toEqual({ kind: "fm1-console", compatibilityEpoch: 2, appVersion: "0.1.0" });
    expect(h.events[0]).toEqual({ type: "connection", state: "connected" });
    const host = h.host;
    await until(() => ["agent.activity.subscribe", "host.chatRecords.subscribe", "host.notifications.subscribe"].every((m) => host.live(m).length === 1));
    expect(host.live("host.notifications.subscribe")[0]?.params).toEqual({ filter: "all", initialLimit: 200 });
    expect(h.adapter.diagnostics().endpoint?.hostId).toBe(HOST);
  });

  test("never logs or exposes the bearer in diagnostics", async () => {
    h = makeHarness({ world: standardWorld() });
    await h.adapter.connect();
    expect(JSON.stringify(h.adapter.diagnostics())).not.toContain("fake-token");
  });
});

describe("listing", () => {
  test("projects come from workspaces, then repos; tasks carry the project", async () => {
    h = makeHarness({ world: standardWorld() });
    await h.adapter.connect();
    const projects = await h.adapter.listProjects();
    expect(projects.map((p) => [p.projectId, p.name])).toEqual([
      ["repo:acme/beta", "acme/beta"],
      ["ws:/Users/me/dev/alpha", "alpha"],
    ]);
    const tasks = await h.adapter.listTasks();
    expect(tasks.map((t) => [t.ref.taskId, t.ref.projectId, t.title])).toEqual([
      ["e1", "ws:/Users/me/dev/alpha", "Task one"],
      ["e2", "repo:acme/beta", "Task two"],
    ]);
    expect(await h.adapter.listTasks("repo:acme/beta")).toHaveLength(1);
    const req = h.host.requests.find((r) => r.method === "epic.listTasks")?.params as Record<string, unknown>;
    expect([req.extensionPhaseVersion, req.extensionEpicVersion]).toEqual(["1.0.0", "2.0.0"]);
  });

  test("sessions: composite identity, provider from harness, chat vs terminal runtime, workspace", async () => {
    h = makeHarness({ world: standardWorld() });
    await h.adapter.connect();
    const sessions = await h.adapter.listSessions();
    const rows = sessions.map((s) => [s.ref.taskId, s.ref.sessionId, s.ref.projectId, s.provider, s.runtime, s.workspace, s.title]);
    expect(rows).toEqual([
      ["e1", "c1", "ws:/Users/me/dev/alpha", "codex", "chat", "/Users/me/dev/alpha", "Codex chat"],
      ["e1", "c2", "ws:/Users/me/dev/alpha", "claude", "chat", "/Users/me/dev/alpha", "Claude chat"],
      ["e1", "t1", "ws:/Users/me/dev/alpha", "claude", "terminal", "/Users/me/dev/alpha", "Terminal"],
      ["e2", "c3", "repo:acme/beta", "claude", "chat", "", "claude chat"],
    ]);
    expect(sessions.every((s) => s.ref.backendId === "traycer" && s.ref.hostId === HOST)).toBe(true);
    // Before any activity frame nothing is observed; the terminal only has an inference.
    const t1 = sessions.find((s) => s.ref.sessionId === "t1")!;
    expect(t1.status.observed.state).toBeNull();
    expect(t1.status.inferred?.state).toBe("idle");
    expect((await h.adapter.listSessions("e2")).map((s) => s.ref.sessionId)).toEqual(["c3"]);
  });

  test("archived chats and chats owned by another host are not listed", async () => {
    const world = standardWorld();
    world.chats.push({ epicId: "e1", chatId: "old", title: "old", harnessId: "codex", model: "x", archived: true });
    world.chats.push({ epicId: "e1", chatId: "far", title: "far", harnessId: "codex", model: "x", hostId: "other-host" });
    h = makeHarness({ world });
    await h.adapter.connect();
    const ids = (await h.adapter.listSessions("e1")).map((s) => s.ref.sessionId);
    expect(ids).not.toContain("old");
    expect(ids).not.toContain("far");
  });
});

describe("subscriptions and state normalization", () => {
  test("activity: GUI turn is observed working; terminal output is inferred only", async () => {
    h = makeHarness({ world: standardWorld() });
    await h.adapter.connect();
    await h.adapter.listSessions();
    const activity = await h.host.waitForSub("agent.activity.subscribe");
    activity.send({ kind: "state", servedBy: "local", byEpic: { e1: { working: ["t1"], turn: ["c1"] } } });
    const harness = h;
    await until(() => lastSession(harness, "c1")?.status.observed.state === "working");
    const t1 = lastSession(h, "t1")!;
    expect(t1.status.observed.state).toBeNull();
    expect(t1.status.inferred?.state).toBe("working");
    expect(isInferred(t1.status)).toBe(true);
    expect(lastSession(h, "c2")?.status.observed.state).toBe("idle");
    expect((lastSession(h, "c1")!.status.raw as { activity: unknown }).activity).toEqual({ inTurn: true, working: false, servedBy: "local" });
  });

  test("feed facts that arrive before listSessions are applied to the listed sessions", async () => {
    h = makeHarness({ world: standardWorld() });
    await h.adapter.connect();
    const activity = await h.host.waitForSub("agent.activity.subscribe");
    const notes = await h.host.waitForSub("host.notifications.subscribe");
    activity.send({ kind: "state", servedBy: "local", byEpic: { e1: { working: [], turn: ["c1"] } } });
    notes.send({
      kind: "snapshot",
      entries: [{ id: "n2", kind: "agent.stopped", updatedAt: 11, readAt: null, sourceRef: null, severity: "done", epicId: "e1", chatId: "c2", outcome: "completed", payload: { outcome: "completed" } }],
    });
    await Bun.sleep(100);
    const sessions = await h.adapter.listSessions("e1");
    const state = (id: string) => sessions.find((s) => s.ref.sessionId === id)?.status.observed.state;
    expect([state("c1"), state("c2")]).toEqual(["working", "completed_unread"]);
  });

  test("notifications: approval -> approval_required; interview -> waiting_input; completion -> completed_unread until viewed", async () => {
    h = makeHarness({ world: standardWorld() });
    await h.adapter.connect();
    await h.adapter.listSessions();
    const notes = await h.host.waitForSub("host.notifications.subscribe");
    const base = { readAt: null, sourceRef: null, epicId: "e1" };
    notes.send({
      kind: "snapshot",
      entries: [
        { ...base, id: "n1", kind: "approval.requested", updatedAt: 10, severity: "needs_action", chatId: "c1", outcome: null, resolvedAt: null, payload: { kind: "approval", epicId: "e1", chatId: "c1", chatTitle: "Codex chat", taskTitle: "Task one", approvalId: "ap-1" } },
        { ...base, id: "n2", kind: "agent.stopped", updatedAt: 11, severity: "done", chatId: "c2", outcome: "completed", payload: { outcome: "completed" } },
        { ...base, id: "n3", kind: "interview.requested", updatedAt: 12, severity: "needs_action", chatId: "t1", outcome: null, resolvedAt: null, payload: { kind: "interview", epicId: "e1", chatId: "t1", chatTitle: "T", taskTitle: "Task one", interviewBlockId: "b1" } },
      ],
    });
    const harness = h;
    await until(() => harness.events.some((e) => e.type === "approval_requested"));
    const approval = h.events.find((e) => e.type === "approval_requested");
    expect(approval?.type === "approval_requested" && approval.approval).toEqual({
      id: "ap-1",
      sessionRef: ref("e1", "c1"),
      summary: "Approval: Task one / Codex chat",
      createdAt: 10,
    });
    expect(lastSession(h, "c1")?.status.observed.state).toBe("approval_required");
    expect(lastSession(h, "c2")?.status.observed.state).toBe("completed_unread");
    expect(lastSession(h, "t1")?.status.observed.state).toBe("waiting_input");
    expect(await h.adapter.listApprovals()).toHaveLength(1);

    h.adapter.markViewed(ref("e1", "c2"));
    expect(lastSession(h, "c2")?.status.observed.state).toBe("completed_read");

    // Resolution via readStateChanged clears the approval.
    notes.send({ kind: "readStateChanged", ids: ["n1"], entityRefs: [], readAt: 20, resolvedAt: 20 });
    await until(() => harness.events.some((e) => e.type === "approval_resolved" && e.approvalId === "ap-1"));
    expect(lastSession(h, "c1")?.status.observed.state).not.toBe("approval_required");
  });

  test("errored and stalled agents are failed (observed)", async () => {
    h = makeHarness({ world: standardWorld() });
    await h.adapter.connect();
    await h.adapter.listSessions();
    const notes = await h.host.waitForSub("host.notifications.subscribe");
    notes.send({
      kind: "upserted",
      entry: { id: "n9", kind: "agent.stopped", updatedAt: 30, readAt: null, sourceRef: null, severity: "failure", epicId: "e1", chatId: "c1", outcome: "errored", payload: { outcome: "errored", message: "rate limited" } },
    });
    notes.send({
      kind: "upserted",
      entry: { id: "n10", kind: "agent.stalled", updatedAt: 31, readAt: null, sourceRef: null, severity: "failure", epicId: "e1", chatId: "c2", outcome: "errored", payload: {} },
    });
    const harness = h;
    await until(() => lastSession(harness, "c2")?.status.observed.state === "failed");
    expect(lastSession(h, "c1")?.status.observed.state).toBe("failed");
  });

  test("a terminal's outcome text is redacted and bounded before it becomes the observed detail", async () => {
    h = makeHarness({ world: standardWorld() });
    await h.adapter.connect();
    await h.adapter.listSessions();
    const notes = await h.host.waitForSub("host.notifications.subscribe");
    const message = `push failed: token=ghp_abcdefghijklmnopqrstuvwxyz0123 Authorization: Bearer abcd1234efgh5678ijkl ${"x".repeat(400)}`;
    notes.send({
      kind: "upserted",
      entry: { id: "n11", kind: "agent.stopped", updatedAt: 40, readAt: null, sourceRef: null, severity: "failure", epicId: "e1", chatId: "t1", outcome: "errored", payload: { outcome: "errored", message } },
    });
    const harness = h;
    await until(() => lastSession(harness, "t1")?.status.observed.state === "failed");
    const detail = lastSession(h, "t1")?.status.observed.detail ?? "";
    expect(detail).toContain("push failed");
    expect(detail).toContain("<redacted>");
    expect(detail).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(detail).not.toContain("abcd1234efgh5678ijkl");
    expect(detail.length).toBeLessThanOrEqual(200);
  });

  test("chatRecords: added chat is upserted with its provider, archived/removed chats are removed", async () => {
    const world = standardWorld();
    h = makeHarness({ world });
    await h.adapter.connect();
    await h.adapter.listSessions();
    const records = await h.host.waitForSub("host.chatRecords.subscribe");
    const added = { epicId: "e1", chatId: "c9", title: "Fresh", harnessId: "codex", model: "gpt-5.6-luna" };
    world.chats.push(added);
    records.send({ kind: "upsert", epicId: "e1", chatId: "c9", revision: 1, listRevision, record: chatRecord(added) });
    const harness = h;
    await until(() => lastSession(harness, "c9") !== undefined);
    expect(lastSession(h, "c9")?.provider).toBe("codex");
    records.send({ kind: "upsert", epicId: "e1", chatId: "c9", revision: 2, listRevision, record: { ...chatRecord(added), archived: true } });
    await until(() => harness.events.some((e) => e.type === "session_removed" && e.ref.sessionId === "c9"));
    records.send({ kind: "remove", epicId: "e1", chatId: "c2", listRevision, reason: "deleted" });
    await until(() => harness.events.some((e) => e.type === "session_removed" && e.ref.sessionId === "c2"));
  });

  test("task deletion: last chat deleted -> task list re-read -> task_removed", async () => {
    const world = standardWorld();
    h = makeHarness({ world });
    await h.adapter.connect();
    await h.adapter.listSessions();
    const records = await h.host.waitForSub("host.chatRecords.subscribe");
    world.tasks = world.tasks.filter((t) => t.epicId !== "e2");
    world.chats = world.chats.filter((c) => c.epicId !== "e2");
    records.send({ kind: "remove", epicId: "e2", chatId: "c3", listRevision, reason: "deleted" });
    const harness = h;
    await until(() => harness.events.some((e) => e.type === "task_removed" && e.ref.taskId === "e2"));
    expect(h.events.some((e) => e.type === "session_removed" && e.ref.sessionId === "c3")).toBe(true);
    const sent = await h.adapter.sendPrompt(ref("e2", "c3", "repo:acme/beta"), "hello", "r-gone");
    expect(sent.stage).toBe("target_unavailable");
  });

  test("malformed frames are dropped and counted; state is unaffected and nothing throws", async () => {
    h = makeHarness({ world: standardWorld() });
    await h.adapter.connect();
    await h.adapter.listSessions();
    const records = await h.host.waitForSub("host.chatRecords.subscribe");
    const notes = await h.host.waitForSub("host.notifications.subscribe");
    const activity = await h.host.waitForSub("agent.activity.subscribe");
    records.send({ kind: "upsert", epicId: "e1", chatId: "cx", revision: 1, listRevision, record: { nope: true } });
    records.send({ kind: "remove", epicId: "e1" });
    notes.send({ kind: "upserted", entry: { id: 5 } });
    activity.send({ kind: "state", servedBy: "local", byEpic: { e1: { working: "c1" } } });
    activity.sendRaw("{not json");
    const harness = h;
    await until(() => (harness.adapter.diagnostics().malformed["host.chatRecords.subscribe"] ?? 0) >= 2);
    await until(() => (harness.adapter.diagnostics().malformed["host.notifications.subscribe"] ?? 0) >= 1);
    expect(h.events.some((e) => e.type === "session_removed")).toBe(false);
    expect(lastSession(h, "cx")).toBeUndefined();
    // A non-JSON frame makes the vendored client redial that one stream; the link stays up.
    await until(() => activity.closed);
    const fresh = await h.host.waitForSub("agent.activity.subscribe");
    expect(h.events.some((e) => e.type === "connection" && e.state === "disconnected")).toBe(false);
    fresh.send({ kind: "state", servedBy: "local", byEpic: { e1: { working: [], turn: ["c2"] } } });
    await until(() => lastSession(harness, "c2")?.status.observed.state === "working");
    expect(effectiveState(lastSession(h, "c2")!.status)).toBe("working");
  });
});

describe("capabilities", () => {
  test("per-operation verification comes from reports/traycer-capabilities.json", () => {
    h = makeHarness();
    const caps = h.adapter.getCapabilities();
    expect(caps.sendPrompt).toMatchObject({ supported: true, verified: "live" });
    expect(caps.listSessions.verified).toBe("live");
    expect(caps.createTask.verified).toBe("live");
    expect(caps.interrupt.verified).toBe("live");
    expect(caps.respondToApproval).toMatchObject({ supported: true, verified: "live" }); // T7 passed live
    expect(caps.focus).toEqual({
      supported: true,
      level: "window",
      verified: "live",
      reason: "tile selection needs upstream deep link (docs/upstream/traycer-deep-link.diff)",
    });
  });

  test("without a report every operation is verified:'none'", () => {
    h = makeHarness({ config: { capabilityReportPath: null } });
    expect(h.adapter.getCapabilities().sendPrompt.verified).toBe("none");
  });
});

export { USER };

describe("first activity frame (integration: companion resync right after connect)", () => {
  test("listSessions waits for the first activity frame, so chats are observed idle rather than unknown", async () => {
    h = makeHarness({ world: standardWorld(), config: { firstActivityWaitMs: 2_000 } });
    await h.adapter.connect();
    const activity = await h.host.waitForSub("agent.activity.subscribe");
    const listing = h.adapter.listSessions("e1");
    setTimeout(() => activity.send({ kind: "state", servedBy: "local", byEpic: {} }), 150);
    const sessions = await listing;
    expect(sessions.find((s) => s.ref.sessionId === "c2")?.status.observed.state).toBe("idle");
  });

  test("the wait is bounded when no activity frame ever arrives", async () => {
    h = makeHarness({ world: standardWorld(), config: { firstActivityWaitMs: 200 } });
    await h.adapter.connect();
    const t0 = Date.now();
    const sessions = await h.adapter.listSessions("e1");
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(sessions.find((s) => s.ref.sessionId === "c2")?.status.observed.state).toBeNull();
  });
});
