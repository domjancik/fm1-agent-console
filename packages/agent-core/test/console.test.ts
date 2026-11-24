import { describe, expect, test } from "bun:test";
import { AgentConsole, type PinLists } from "../src/console";
import { isAttention, rank } from "../src/focus";
import { keyOf, mockFrom, refOf, rig, slotOf } from "./helpers";

describe("reconnection", () => {
  test("drop -> offline changes -> reconnect re-enumerates; unresolved selection becomes stale", async () => {
    const r = await rig("mixed", { scope: "recent" });
    await r.console.handleInput({ kind: "key", key: slotOf(r, "s-claude-idle"), gesture: "single" });
    const selected = keyOf(r, "s-claude-idle");
    const k = slotOf(r, "s-claude-idle");
    r.adapter.dropConnection();
    let v = r.console.view();
    expect(v.status).toMatchObject({ link: "down", text: "Traycer offline" });
    expect(v.slots.filter((s) => s.state !== "empty").every((s) => s.state === "disconnected")).toBe(true);
    r.adapter.mutateOffline(({ sessions }) => sessions.delete(selected));
    expect((await r.console.reconnect()).ok).toBe(true);
    expect(r.console.registry.selection()).toEqual({ key: selected, status: "stale" });
    v = r.console.view();
    expect(v.status.link).toBe("ok");
    expect(v.slots[k]).toMatchObject({ stale: true, selected: true });
    expect(v.detail.lines[2]).toBe("gone from Traycer");
    expect(v.detail.lines[3]).toBe("HOME re-sorts");
    await r.console.handleInput({ kind: "button", button: "REC", edge: "down" });
    expect(r.console.composer.state.state).toBe("ready");
  });

  test("a connected event after a drop triggers resync automatically", async () => {
    const r = await rig();
    r.adapter.dropConnection();
    r.adapter.mutateOffline(({ sessions }) => sessions.delete(keyOf(r, "s-claude-fw")));
    await r.adapter.connect();
    await r.console.idle();
    expect(r.console.registry.get(keyOf(r, "s-claude-fw"))?.stale).toBe(true);
    expect(r.console.registry.connection()).toBe("connected");
  });

  test("actions while disconnected are rejected as target_unavailable", async () => {
    const r = await rig();
    await r.console.handleInput({ kind: "key", key: slotOf(r, "s-claude-fw"), gesture: "single" });
    await r.console.handleInput({ kind: "button", button: "ENV", edge: "down" });
    r.adapter.dropConnection();
    await r.console.handleInput({ kind: "button", button: "SAVE", edge: "down" });
    expect(r.adapter.interruptCalls).toEqual([]);
    expect(r.console.results.at(-1)).toMatchObject({ stage: "target_unavailable" });
  });

  test("stale slots are freed only by the prune policy", async () => {
    const r = await rig();
    const k = keyOf(r, "s-codex-tui");
    const at = slotOf(r, "s-codex-tui");
    r.adapter.removeSession(refOf(r, "s-codex-tui"));
    expect(r.console.pruneStale()).toEqual([]);
    expect(r.console.view().slots[at]?.stale).toBe(true);
    r.timers.advance(30_000);
    expect(r.console.pruneStale()).toEqual([k]);
    expect(r.console.view().slots[at]?.state).toBe("empty");
  });
});

describe("robustness", () => {
  test("unreachable backend: companion stays usable and reports Traycer offline", async () => {
    const adapter = mockFrom("disconnected");
    const c = new AgentConsole({ adapter });
    await c.start();
    const v = c.view();
    expect(v.status).toMatchObject({ link: "down", text: "Traycer offline", attentionCount: 0 });
    expect(v.slots.every((s) => s.state === "empty")).toBe(true);
    await c.handleInput({ kind: "button", button: "GLO", edge: "down" });
    expect(c.view().view).toBe("inbox");
  });

  test("all-disconnected sessions render as disconnected and accept no prompts", async () => {
    const adapter = mockFrom("disconnected");
    adapter.reachable = true;
    let t = Date.now();
    const c = new AgentConsole({ adapter, now: () => t });
    await c.start();
    expect(c.view().title).toBe("ACTIVE 0");
    await c.handleInput({ kind: "encoder", encoder: "K1", delta: 1 });
    expect(c.view().slots.slice(0, 4).map((s) => s.state)).toEqual(["disconnected", "disconnected", "disconnected", "disconnected"]);
    await c.handleInput({ kind: "key", key: 0, gesture: "single" });
    await c.handleInput({ kind: "button", button: "REC", edge: "down" });
    c.voiceTranscript("x");
    t += 400; // a hold, not a short tap (docs/ui-v3.md section 11)
    await c.handleInput({ kind: "button", button: "REC", edge: "up" });
    c.voiceTranscript("hello");
    await c.handleInput({ kind: "button", button: "SAVE", edge: "down" });
    await c.idle();
    expect(c.composer.state.state).toBe("target_unavailable");
    expect(adapter.deliveries).toHaveLength(0);
  });

  test("malformed adapter events are counted and do not corrupt state", async () => {
    const r = await rig();
    const before = JSON.stringify(r.console.view());
    r.adapter.emit({ type: "session_upserted", session: { title: 3 } });
    r.adapter.emit({ type: "bogus" });
    expect(r.console.rejectedEvents).toHaveLength(2);
    expect(JSON.stringify(r.console.view())).toBe(before);
  });

  test("view listeners receive updates on backend changes", async () => {
    const r = await rig();
    const views: string[] = [];
    const at = slotOf(r, "s-claude-fw");
    r.console.onView((v) => views.push(v.slots[at]?.state ?? ""));
    r.adapter.setState(refOf(r, "s-claude-fw"), "completed_unread");
    expect(views.at(-1)).toBe("completed_unread");
  });
});

describe("completed sessions are acknowledged by selection", () => {
  test("selected READ_DWELL_MS turns completed_unread read; passing over a key does not", async () => {
    const r = await rig();
    r.adapter.setState(refOf(r, "s-claude-fw"), "completed_unread");
    r.adapter.setState(refOf(r, "s-claude-idle"), "completed_unread");
    const fw = slotOf(r, "s-claude-fw");
    const idle = slotOf(r, "s-claude-idle");
    const badge = r.console.view().status.attentionCount;
    await r.console.handleInput({ kind: "key", key: fw, gesture: "single" });
    r.timers.advance(500);
    await r.console.handleInput({ kind: "key", key: idle, gesture: "single" });
    r.timers.advance(1_499);
    expect(r.console.view().slots[fw]?.state).toBe("completed_unread");
    expect(r.console.view().slots[idle]?.state).toBe("completed_unread");
    r.timers.advance(1);
    expect(r.console.view().slots[idle]?.state).toBe("completed_read");
    expect(r.console.view().slots[fw]?.state).toBe("completed_unread");
    expect(r.console.view().status.attentionCount).toBe(badge - 1);
  });
});

describe("pins (section 3.5)", () => {
  test("restored from the config, reported on change, dropped when the session leaves", async () => {
    const changes: PinLists[] = [];
    const adapter = mockFrom("mixed");
    const keyFw = "traycer/host-mbp/proj-console/task-fw/s-claude-fw";
    const c = new AgentConsole({ adapter, pins: [keyFw, keyFw, "x/y/z/w/v"], onPinsChanged: (p) => changes.push(p) });
    await c.start();
    expect(c.state.pins).toEqual([keyFw]);
    expect(changes).toEqual([{ sessions: [keyFw], tasks: [] }]);
    // Sessions that need you first, then the pin (operator decision 2026-11-19).
    const slots = c.state.layouts.sessions.slots;
    const at = slots.indexOf(keyFw);
    expect(at).toBeGreaterThanOrEqual(0);
    for (const k of slots.slice(0, at)) expect(isAttention(rank(c.registry.get(k!)!, c.world()).tier)).toBe(true);
    expect(c.view().slots[at]?.pinned).toBe(true);
    const fw = c.registry.get(keyFw)!.session.ref;
    adapter.dropConnection();
    adapter.mutateOffline(({ sessions }) => sessions.delete(keyFw));
    await c.reconnect();
    expect(c.state.pins).toEqual([]);
    expect(changes.at(-1)).toEqual({ sessions: [], tasks: [] });
    expect(fw.sessionId).toBe("s-claude-fw");
  });
});
