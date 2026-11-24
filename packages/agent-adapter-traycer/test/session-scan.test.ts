import { afterEach, describe, expect, test } from "bun:test";
import type { TraycerAgentAdapter } from "../src/agent/traycer-agent-adapter";
import { makeHarness, standardWorld, until, World, type Harness } from "./scenario";

/**
 * listSessions' quick scan ranks tasks by real agent activity, and the background full scan reads every task
 * (docs/traycer-integration.md "Session scan").
 */
let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

const fullScan = (adapter: TraycerAgentAdapter) => (adapter as unknown as { fullScan(): Promise<void> }).fullScan();
const reads = (harness: Harness, method: string, from = 0) => harness.host.requests.slice(from).filter((r) => r.method === method);
const taskIds = (sessions: ReadonlyArray<{ ref: { taskId: string } }>) => [...new Set(sessions.map((s) => s.ref.taskId))].sort();

/** 30 tasks updated recently (n00..n29, one quiet chat each) and one stale task whose chat worked recently. */
function busyOldWorld(): World {
  const w = new World();
  for (let i = 0; i < 30; i++) {
    const epicId = `n${String(i).padStart(2, "0")}`;
    w.tasks.push({ epicId, title: `New ${i}`, workspace: "/Users/me/dev/alpha", updatedAt: 1_000 + i });
    w.chats.push({ epicId, chatId: `${epicId}c`, title: `Quiet ${i}`, harnessId: "claude", model: "haiku", updatedAt: 1_000 });
  }
  w.tasks.push({ epicId: "old", title: "Old task", workspace: "/Users/me/dev/alpha", updatedAt: 1 });
  w.chats.push({ epicId: "old", chatId: "oc", title: "Recently active", harnessId: "claude", model: "haiku", updatedAt: 50_000 });
  return w;
}

describe("quick scan ranking", () => {
  test("a task whose agent worked recently outranks tasks with a newer but stale updatedAt", async () => {
    const w = standardWorld(); // e1 updatedAt 20, e2 updatedAt 10, all agents updatedAt <= 4
    w.tasks.push({ epicId: "e3", title: "Stale task", workspace: null, updatedAt: 1 });
    w.chats.push({ epicId: "e3", chatId: "c9", title: "Busy chat", harnessId: "codex", model: "gpt-5.6-luna", updatedAt: 500 });
    h = makeHarness({ world: w, config: { sessionScanLimit: 1, fullScanIntervalMs: 60_000 } });
    await h.adapter.connect();
    await fullScan(h.adapter);
    expect(taskIds(await h.adapter.listSessions())).toEqual(["e3"]);
  });

  test("a task with an agent working in the live activity feed is always scanned, whatever the limit", async () => {
    h = makeHarness({ world: standardWorld(), config: { sessionScanLimit: 1 } });
    await h.adapter.connect();
    expect(taskIds(await h.adapter.listSessions())).toEqual(["e1"]);
    const activity = await h.host.waitForSub("agent.activity.subscribe");
    activity.send({ kind: "state", servedBy: "local", byEpic: { e2: { working: ["c3"], turn: [] } } });
    await Bun.sleep(100);
    const sessions = await h.adapter.listSessions();
    expect(taskIds(sessions)).toEqual(["e1", "e2"]);
    expect(sessions.find((s) => s.ref.sessionId === "c3")?.status.observed.state).toBe("working");
  });
});

describe("background full scan", () => {
  test("surfaces a recently active task beyond the top 25, and quick scans keep it", async () => {
    h = makeHarness({ world: busyOldWorld(), config: { fullScanIntervalMs: 60_000 } });
    await h.adapter.connect();
    await fullScan(h.adapter);
    // every task with chats on this host was read once by the full scan
    expect(new Set(reads(h, "epic.listChatRecords").map((r) => (r.params as { epicId: string }).epicId)).size).toBe(31);
    // the console hears about it before its next snapshot
    expect(h.events.some((e) => e.type === "task_upserted" && e.task.ref.taskId === "old")).toBe(true);
    expect(h.events.some((e) => e.type === "session_upserted" && e.session.ref.sessionId === "oc")).toBe(true);
    for (let i = 0; i < 3; i++) {
      const sessions = await h.adapter.listSessions();
      expect(sessions.map((s) => s.ref.sessionId)).toContain("oc");
      expect(taskIds(sessions)).toHaveLength(25);
    }
    expect(h.events.some((e) => e.type === "session_removed" && e.ref.sessionId === "oc")).toBe(false);
  });

  test("never overlaps itself: a second trigger joins the run in flight", async () => {
    h = makeHarness({ world: busyOldWorld(), config: { fullScanIntervalMs: 60_000 } });
    await h.adapter.connect();
    await fullScan(h.adapter);
    const from = h.host.requests.length;
    const a = fullScan(h.adapter);
    const b = fullScan(h.adapter);
    expect(b).toBe(a);
    await Promise.all([a, b]);
    expect(reads(h, "epic.listTasks", from)).toHaveLength(1);
    expect(reads(h, "epic.listChatRecords", from)).toHaveLength(31);
  });

  test("runs on its interval, stops on disconnect and does nothing while the link is down", async () => {
    h = makeHarness({ world: busyOldWorld(), config: { fullScanIntervalMs: 40 } });
    await h.adapter.connect();
    const harness = h;
    await until(() => reads(harness, "epic.listTasks").length >= 3, 3_000, "three full scans");
    await h.adapter.disconnect();
    await Bun.sleep(50); // a run in flight skips its remaining tasks
    const after = h.host.requests.length;
    await Bun.sleep(200);
    expect(h.host.requests.length).toBe(after);
    await fullScan(h.adapter); // link down / not wanted: resolves without reading
    expect(h.host.requests.length).toBe(after);
  });

  test("a task that cannot be read does not stop the others", async () => {
    const w = busyOldWorld();
    w.overrides["epic.listChatRecords"] = (p) => (String(p.epicId).startsWith("n0") ? { error: { code: "INTERNAL", message: "busy" } } : undefined);
    h = makeHarness({ world: w, config: { fullScanIntervalMs: 60_000 } });
    await h.adapter.connect();
    await fullScan(h.adapter);
    expect(h.events.some((e) => e.type === "session_upserted" && e.session.ref.sessionId === "oc")).toBe(true);
    expect((await h.adapter.listSessions()).map((s) => s.ref.sessionId)).toContain("oc");
  });

  test("an answer that is not a full listing does not remove known agents", async () => {
    const w = busyOldWorld();
    h = makeHarness({ world: w, config: { fullScanIntervalMs: 60_000 } });
    await h.adapter.connect();
    await fullScan(h.adapter);
    w.overrides["epic.listChatRecords"] = (p) => (p.epicId === "old" ? { result: { kind: "unchanged", listStamp: null } as never } : undefined);
    await fullScan(h.adapter);
    expect(h.events.some((e) => e.type === "session_removed" && e.ref.sessionId === "oc")).toBe(false);
  });
});
