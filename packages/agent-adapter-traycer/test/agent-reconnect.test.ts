import { afterEach, describe, expect, test } from "bun:test";
import { AgentConsole, type SessionRef } from "@fm1/agent-core";
import { Backoff } from "../src/agent/backoff";
import { chatSnapshot, HOST, makeHarness, standardWorld, until, type Harness } from "./scenario";

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

const ref = (taskId: string, sessionId: string): SessionRef => ({ backendId: "traycer", hostId: HOST, projectId: "ws:/Users/me/dev/alpha", taskId, sessionId });
const connections = (harness: Harness) => harness.events.flatMap((e) => (e.type === "connection" ? [e.state] : []));

describe("backoff", () => {
  test("doubles from initial to the cap and resets", () => {
    const b = new Backoff({ initialMs: 100, maxMs: 1000, factor: 2 });
    expect([b.next(), b.next(), b.next(), b.next(), b.next(), b.next()]).toEqual([100, 200, 400, 800, 1000, 1000]);
    b.reset();
    expect(b.next()).toBe(100);
  });
});

describe("host disconnect and reconnect", () => {
  test("host respawn on a new port: drop detected, pid.json re-read, streams and RPC follow the new port", async () => {
    h = makeHarness({ world: standardWorld() });
    await h.adapter.connect();
    await h.adapter.listSessions();
    const oldUrl = h.host.url;
    await h.host.waitForSub("agent.activity.subscribe");

    h.host.restart(); // new port; pid.json rewritten
    expect(h.host.url).not.toBe(oldUrl);
    const harness = h;
    await until(() => connections(harness).includes("disconnected"), 5_000, "disconnected");
    await until(() => connections(harness).at(-1) === "connected", 5_000, "reconnected");
    expect(h.adapter.diagnostics().endpoint?.websocketUrl).toBe(h.host.url);

    // Streams re-subscribed against the new server; RPC works there too.
    await h.host.waitForSub("agent.activity.subscribe", 5_000);
    await h.host.waitForSub("host.chatRecords.subscribe", 5_000);
    const sessions = await h.adapter.listSessions("e1");
    expect(sessions.map((s) => s.ref.sessionId)).toEqual(["c1", "c2", "t1"]);
    // Identities survive: same hostId, same composite refs.
    expect(sessions[0]?.ref).toEqual(ref("e1", "c1"));
  }, 15_000);

  test("host down: connect fails, background retries with backoff, connects when the host is back", async () => {
    h = makeHarness({ world: standardWorld() });
    h.host.stop();
    await expect(h.adapter.connect()).rejects.toThrow();
    expect(h.adapter.diagnostics().link).not.toBe("connected");
    h.host.restart();
    const harness = h;
    await until(() => connections(harness).includes("connected"), 5_000, "connected after host came back");
    // Integration: the event feeds must open too, or the console never sees live state.
    await until(() => Object.values(harness.adapter.diagnostics().feeds).every((f) => f === "open"), 5_000, "feeds open after host came back");
  }, 15_000);

  test("works end-to-end under AgentConsole: snapshot, drop, resync after reconnect", async () => {
    h = makeHarness({ world: standardWorld() });
    const console = new AgentConsole({ adapter: h.adapter });
    await console.start();
    const view = () => console.world().registry;
    expect(view().ready()).toBe(true);
    expect(view().sessions().length).toBe(4);
    h.host.restart();
    const harness = h;
    await until(() => connections(harness).at(-1) === "connected" && connections(harness).includes("disconnected"), 5_000);
    await until(() => view().ready(), 5_000, "registry resynced");
    expect(view().sessions().filter((s) => !s.stale).length).toBe(4);
    await console.stop();
  }, 15_000);

  test("a prompt in flight when the host dies is reported sent/failed, never replayed", async () => {
    h = makeHarness({
      world: standardWorld(),
      config: { ackTimeoutMs: 800 },
      host: {
        onSubscribe: (sub) => {
          if (sub.method === "chat.subscribe") sub.send(chatSnapshot("e1", "c1"));
        },
        onClientFrame: (sub, frame) => {
          if (frame.kind === "send") setTimeout(() => harness.host.stop(), 10);
        },
      },
    });
    const harness = h;
    await h.adapter.connect();
    await h.adapter.listSessions();
    const result = await h.adapter.sendPrompt(ref("e1", "c1"), "x", "req-down");
    expect(["sent", "failed"]).toContain(result.stage);
    harness.host.restart();
    await until(() => connections(harness).at(-1) === "connected" && connections(harness).includes("disconnected"), 5_000);
    await Bun.sleep(200);
    const sends = h.host.subs.flatMap((s) => s.clientFrames).filter((f) => f.kind === "send");
    expect(sends).toHaveLength(1);
  }, 15_000);
});

describe("INCOMPATIBLE", () => {
  test("handshake INCOMPATIBLE: connect rejects, every host capability is lost (focus stays), no crash", async () => {
    h = makeHarness({ world: standardWorld(), host: { onOpen: () => "INCOMPATIBLE" } });
    await expect(h.adapter.connect()).rejects.toThrow(/INCOMPATIBLE/);
    const caps = h.adapter.getCapabilities();
    expect(caps.sendPrompt.supported).toBe(false);
    expect(caps.sendPrompt.reason).toContain("INCOMPATIBLE");
    expect(caps.listSessions.supported).toBe(false);
    expect(caps.focus.supported).toBe(true);
    expect(h.events.some((e) => e.type === "connection" && e.reason?.includes("INCOMPATIBLE"))).toBe(true);
  });

  test("a feed closed with INCOMPATIBLE degrades, starts fallback polling, keeps the rest working", async () => {
    const world = standardWorld();
    h = makeHarness({
      world,
      host: {
        onSubscribe: (sub) => {
          if (sub.method === "host.chatRecords.subscribe") {
            sub.fatal("INCOMPATIBLE", { incompatibleMethods: [{ method: "host.chatRecords.subscribe", clientCanonical: { major: 1, minor: 4 }, hostCanonical: null, blocking: "host-missing-method" }] });
          }
        },
      },
    });
    await h.adapter.connect();
    await h.adapter.listSessions();
    const harness = h;
    await until(() => harness.events.some((e) => e.type === "connection" && e.state === "degraded"), 5_000, "degraded");
    await until(() => harness.adapter.diagnostics().pollingFallback, 3_000, "polling");
    expect(h.adapter.getCapabilities().subscribe.supported).toBe(true); // activity still live
    // Polling picks up a chat added on the host.
    world.chats.push({ epicId: "e1", chatId: "c-polled", title: "polled", harnessId: "codex", model: "gpt-5.6-luna" });
    await until(() => harness.events.some((e) => e.type === "session_upserted" && e.session.ref.sessionId === "c-polled"), 5_000, "polled chat");
  }, 15_000);

  test("RPC INCOMPATIBLE on a method removes only the dependent capability", async () => {
    const world = standardWorld();
    world.overrides["agent.stop"] = () => ({ error: { code: "INCOMPATIBLE", message: "agent.stop major mismatch" } });
    h = makeHarness({ world });
    await h.adapter.connect();
    await h.adapter.listSessions();
    const result = await h.adapter.interrupt(ref("e1", "c1"), "i-x");
    expect(result.stage).toBe("unsupported");
    expect(h.adapter.getCapabilities().interrupt.supported).toBe(false);
    expect(h.adapter.getCapabilities().sendPrompt.supported).toBe(true);
    expect((await h.adapter.interrupt(ref("e1", "c1"), "i-y")).stage).toBe("unsupported");
  });
});
