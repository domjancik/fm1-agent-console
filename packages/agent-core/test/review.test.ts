// Regression tests for defects found in adversarial review.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fixturePath } from "../src/fixtures";
import type { CommandResult, SessionRef } from "../src/types";
import { keyOf, REC_HOLD, refOf, rig, slotOf, type Rig } from "./helpers";

async function selectAndRecord(r: Rig, sessionId: string, text: string): Promise<void> {
  await r.console.handleInput({ kind: "key", key: slotOf(r, sessionId), gesture: "single" });
  await r.console.handleInput({ kind: "button", button: "REC", edge: "down" });
  r.timers.advance(REC_HOLD);
  await r.console.handleInput({ kind: "button", button: "REC", edge: "up" });
  r.console.voiceTranscript(text);
}

describe("reconnect window", () => {
  test("identities do not resolve between a connected event and the re-enumeration", async () => {
    const r = await rig();
    const gone = refOf(r, "s-claude-idle");
    r.adapter.dropConnection();
    r.adapter.mutateOffline(({ sessions }) => sessions.delete(keyOf(r, "s-claude-idle")));
    // Event arrives, resync starts but has not completed yet.
    r.adapter.emit({ type: "connection", state: "connected" });
    expect(r.console.registry.resolve(gone)).toEqual({ ok: false, error: "disconnected" });
    expect(r.console.view().status.link).not.toBe("ok");
    await r.console.idle();
  });

  test("a degraded-then-connected sequence after a drop still re-enumerates", async () => {
    const r = await rig();
    r.adapter.dropConnection();
    r.adapter.mutateOffline(({ sessions }) => sessions.delete(keyOf(r, "s-claude-fw")));
    r.adapter.emit({ type: "connection", state: "degraded" });
    await r.console.idle();
    await r.adapter.connect();
    await r.console.idle();
    expect(r.console.registry.get(keyOf(r, "s-claude-fw"))?.stale).toBe(true);
    expect(r.console.registry.resolve(refOf(r, "s-claude-idle")).ok).toBe(true);
  });

  test("confirmed create-session is not sent while disconnected", async () => {
    const r = await rig();
    await r.console.handleInput({ kind: "button", button: "EDIT", edge: "down" });
    await r.console.handleInput({ kind: "encoder", encoder: "SELECT", delta: 1 });
    await r.console.handleInput({ kind: "button", button: "PLAY", edge: "down" });
    expect(r.console.state.confirm?.type).toBe("createSession");
    r.adapter.dropConnection();
    await r.console.handleInput({ kind: "button", button: "SAVE", edge: "down" });
    expect(r.adapter.deliveries).toHaveLength(0);
    expect(r.console.results.at(-1)?.stage).toBe("target_unavailable");
  });
});

describe("adapter output validation", () => {
  test("malformed sessions in a snapshot are rejected, valid ones kept", async () => {
    const r = await rig();
    r.adapter.dropConnection();
    r.adapter.mutateOffline(({ sessions }) => {
      sessions.set("bad", { ref: { backendId: "traycer" }, title: 7 } as never);
    });
    expect((await r.console.reconnect()).ok).toBe(true);
    expect(r.console.registry.sessions().every((e) => typeof e.session.title === "string")).toBe(true);
    expect(r.console.registry.resolve(refOf(r, "s-claude-fw")).ok).toBe(true);
    expect(r.console.rejectedEvents.some((e) => e.startsWith("snapshot session"))).toBe(true);
  });

  test("an adapter result with an unknown stage fails the send instead of crashing", async () => {
    const r = await rig("mixed", { scope: "recent" });
    r.adapter.sendPrompt = async (_t: SessionRef, _x: string, requestId: string): Promise<CommandResult> =>
      ({ requestId, stage: "bogus" }) as unknown as CommandResult;
    await selectAndRecord(r, "s-claude-idle", "hello");
    await r.console.handleInput({ kind: "button", button: "SAVE", edge: "down" });
    await r.console.idle();
    expect(r.console.composer.state).toMatchObject({ state: "failed", stage: "failed" });
  });
});

describe("delivery truth", () => {
  test("a backend failure reported after 'sent' allows a retry that re-sends with the same id", async () => {
    const r = await rig("mixed", { ackMode: "sent", scope: "recent" });
    await selectAndRecord(r, "s-claude-idle", "hello");
    await r.console.handleInput({ kind: "button", button: "SAVE", edge: "down" });
    await r.console.idle();
    const id = r.console.composer.state.requestId;
    expect(r.console.composer.state.stage).toBe("sent");
    r.adapter.emit({ type: "command_progress", requestId: id ?? "", stage: "failed", message: "rejected" });
    expect(r.console.composer.state).toMatchObject({ state: "failed", retryable: true });
    r.adapter.ackMode = "immediate";
    await r.console.handleInput({ kind: "button", button: "PLAY", edge: "down" });
    await r.console.idle();
    expect(r.console.dispatcher.adapterCalls).toBe(2);
    expect(r.console.composer.state.requestId).toBe(id);
  });

  test("a sent-but-unacked request is never re-sent by retry", async () => {
    const r = await rig("mixed", { ackMode: "sent", scope: "recent" });
    await selectAndRecord(r, "s-claude-idle", "hello");
    await r.console.handleInput({ kind: "button", button: "SAVE", edge: "down" });
    await r.console.idle();
    r.timers.advance(5000);
    expect(r.console.composer.state.state).toBe("failed");
    await r.console.handleInput({ kind: "button", button: "PLAY", edge: "down" });
    await r.console.idle();
    expect(r.console.dispatcher.adapterCalls).toBe(1);
  });

  test("a late acknowledgement after the user cancelled a timed-out send still shows delivered", async () => {
    const r = await rig("mixed", { ackMode: "sent", scope: "recent" });
    await selectAndRecord(r, "s-claude-idle", "hello");
    await r.console.handleInput({ kind: "button", button: "SAVE", edge: "down" });
    await r.console.idle();
    const id = r.console.composer.state.requestId ?? "";
    r.timers.advance(5000);
    await r.console.handleInput({ kind: "button", button: "FX", edge: "down" });
    expect(r.console.composer.state.state).toBe("cancelled");
    r.adapter.ack(id);
    expect(r.console.composer.state).toMatchObject({ state: "delivered", stage: "backend_acknowledged" });
  });
});

describe("paging", () => {
  test("page index is clamped when the list shrinks", async () => {
    const r = await rig("forty", { scope: "all" });
    await r.console.handleInput({ kind: "button", button: "OCT_UP", edge: "down" });
    expect(r.console.view().page).toBe(1);
    const page2 = r.console.state.layouts.sessions.slots.slice(27);
    for (const k of page2) if (k) r.adapter.removeSession(r.console.registry.get(k)!.session.ref);
    r.console.pruneStale(true);
    const v = r.console.view();
    expect(v.pages).toBe(1);
    expect(v.page).toBe(0);
    expect(v.slots.filter((s) => s.state !== "empty")).toHaveLength(24);
    await r.console.handleInput({ kind: "key", key: 0, gesture: "single" });
    expect(r.console.registry.selection().status).toBe("ok");
  });
});

test("fixturePath resolves to a real file", () => {
  expect(existsSync(fixturePath("mixed"))).toBe(true);
});

describe("approval duplicates", () => {
  test("a second decision for an approval still in flight is not sent", async () => {
    const r = await rig();
    let calls = 0;
    const waiting: (() => void)[] = [];
    r.adapter.respondToApproval = (d) => {
      calls++;
      return new Promise((res) => waiting.push(() => res({ requestId: d.requestId, stage: "completed" })));
    };
    await r.console.handleInput({ kind: "key", key: slotOf(r, "s-codex-fw"), gesture: "single" });
    await r.console.handleInput({ kind: "button", button: "SAVE", edge: "down" });
    expect(r.console.state.confirm?.type).toBe("approve");
    const first = r.console.handleInput({ kind: "button", button: "SAVE", edge: "down" });
    // Approval still pending in the registry: the user can raise a second confirm and execute it.
    await r.console.handleInput({ kind: "button", button: "FX", edge: "down" });
    expect(r.console.state.confirm?.type).toBe("deny");
    const second = r.console.handleInput({ kind: "button", button: "SAVE", edge: "down" });
    for (const done of waiting) done();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(r.console.results.map((x) => x.stage)).toContain("target_unavailable");
  });
});
