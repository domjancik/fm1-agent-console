import { describe, expect, test } from "bun:test";
import { capabilitiesFrom } from "../src/capabilities";
import { initialComposer, reduceComposer, type Destination } from "../src/composer-state";
import { keyOf, refOf, rig, type Rig } from "./helpers";

const dest = (r: Rig, sessionId: string): Destination => {
  const e = r.console.registry.get(keyOf(r, sessionId));
  if (!e) throw new Error("missing");
  return { mode: "continue-session", target: e.session.ref, label: e.session.title };
};

function recordAndReview(r: Rig, sessionId: string, text = "fix the codec"): void {
  const c = r.console.composer;
  expect(c.start(dest(r, sessionId)).ok).toBe(true);
  r.timers.advance(1200);
  c.level(55);
  c.stop();
  c.transcribed(`  ${text}  `);
}

describe("composer reducer", () => {
  test("illegal transitions are refused without changing state", () => {
    for (const ev of [{ type: "stop", now: 0 }, { type: "edit", text: "x" }, { type: "submit", requestId: "r" }, { type: "cancel" }] as const) {
      const red = reduceComposer(initialComposer, ev);
      expect(red.ok).toBe(false);
      expect(red.state).toBe(initialComposer);
    }
  });

  test("empty transcripts cannot be submitted", () => {
    const s = { ...initialComposer, state: "reviewing" as const, transcript: "  ", destination: { mode: "new-task", project: { backendId: "b", hostId: "h", projectId: "p" }, provider: "claude", label: "x" } as Destination };
    expect(reduceComposer(s, { type: "submit", requestId: "r" }).ok).toBe(false);
  });

  test("stage regressions are ignored", () => {
    const s = { ...initialComposer, state: "submitting" as const, requestId: "r", stage: "sent" as const };
    expect(reduceComposer(s, { type: "progress", requestId: "r", stage: "accepted_locally" }).ok).toBe(false);
    expect(reduceComposer(s, { type: "progress", requestId: "other", stage: "backend_acknowledged" }).ok).toBe(false);
  });
});

describe("voice composer", () => {
  test("READY -> RECORDING -> TRANSCRIBING -> REVIEWING -> SUBMITTING -> DELIVERED", async () => {
    const r = await rig();
    const c = r.console.composer;
    const seen: string[] = [];
    c.onChange((s) => seen.push(s.state));
    recordAndReview(r, "s-claude-idle");
    expect(c.state.transcript).toBe("fix the codec");
    expect(c.state.elapsedDs).toBe(12);
    await c.submit();
    expect(c.state.state).toBe("delivered");
    expect(c.state.stage).toBe("backend_acknowledged");
    expect(seen).toContain("transcribing");
    expect(seen.filter((s, i) => s !== seen[i - 1])).toEqual(["recording", "transcribing", "reviewing", "submitting", "delivered"]);
    expect(r.adapter.deliveries).toEqual([{ requestId: "req-1", kind: "prompt", key: keyOf(r, "s-claude-idle"), text: "fix the codec" }]);
  });

  test("destination is captured at record start and not changed by later selection", async () => {
    const r = await rig();
    r.console.registry.select(keyOf(r, "s-claude-idle"));
    recordAndReview(r, "s-claude-idle");
    r.console.registry.select(keyOf(r, "s-claude-fw"));
    await r.console.composer.submit();
    expect(r.adapter.deliveries[0]?.key).toBe(keyOf(r, "s-claude-idle"));
  });

  test("transcript is editable only while reviewing and the edit is what gets sent", async () => {
    const r = await rig();
    const c = r.console.composer;
    expect(c.edit("early").ok).toBe(false);
    recordAndReview(r, "s-claude-idle", "fix the codex");
    expect(c.edit("fix the codec please").ok).toBe(true);
    expect(c.state.edited).toBe(true);
    await c.submit();
    expect(c.edit("too late").ok).toBe(false);
    expect(r.adapter.deliveries[0]?.text).toBe("fix the codec please");
  });

  test("'sent' alone is not delivered; backend ack event completes it", async () => {
    const r = await rig("mixed", { ackMode: "sent" });
    const c = r.console.composer;
    recordAndReview(r, "s-claude-idle");
    await c.submit();
    expect(c.state.state).toBe("submitting");
    expect(c.state.stage).toBe("sent");
    r.adapter.ack("req-1");
    expect(c.state.state).toBe("delivered");
  });

  test("timeout fails the dispatch; retry reuses the requestId and never re-sends", async () => {
    const r = await rig("mixed", { ackMode: "sent", ackTimeoutMs: 1000 });
    const c = r.console.composer;
    recordAndReview(r, "s-claude-idle");
    await c.submit();
    r.timers.advance(1000);
    expect(c.state).toMatchObject({ state: "failed", retryable: true, requestId: "req-1" });
    await c.submit();
    expect(c.state.requestId).toBe("req-1");
    expect(c.state.attempts).toBe(2);
    expect(r.adapter.deliveries).toHaveLength(1);
    expect(r.console.dispatcher.adapterCalls).toBe(1);
    r.adapter.ack("req-1");
    expect(c.state.state).toBe("delivered");
  });

  test("a late acknowledgement after a timeout is honoured", async () => {
    const r = await rig("mixed", { ackMode: "sent", ackTimeoutMs: 1000 });
    recordAndReview(r, "s-claude-idle");
    await r.console.composer.submit();
    r.timers.advance(1500);
    expect(r.console.composer.state.state).toBe("failed");
    r.adapter.ack("req-1");
    expect(r.console.composer.state.state).toBe("delivered");
  });

  test("only one dispatch in flight; concurrent submits share it", async () => {
    const r = await rig("mixed", { ackMode: "hang" });
    const c = r.console.composer;
    recordAndReview(r, "s-claude-idle");
    const first = c.submit();
    const second = await c.submit();
    expect(second.ok).toBe(false);
    r.adapter.release("req-1");
    await first;
    expect(c.state.state).toBe("delivered");
    expect(r.adapter.deliveries).toHaveLength(1);
    expect(r.console.dispatcher.adapterCalls).toBe(1);
  });

  test("dispatcher dedupes the same requestId", async () => {
    const r = await rig();
    const d = dest(r, "s-claude-idle");
    const [a, b] = await Promise.all([r.console.dispatcher.dispatch("x", d, "hi"), r.console.dispatcher.dispatch("x", d, "hi")]);
    await r.console.dispatcher.dispatch("x", d, "hi");
    expect(a).toEqual(b);
    expect(r.console.dispatcher.adapterCalls).toBe(1);
    expect(r.adapter.deliveries).toHaveLength(1);
  });

  test("a hard failure is retryable with the same requestId", async () => {
    const r = await rig("mixed", { ackMode: "fail" });
    const c = r.console.composer;
    recordAndReview(r, "s-claude-idle");
    await c.submit();
    expect(c.state).toMatchObject({ state: "failed", stage: "failed", retryable: true });
    r.adapter.ackMode = "immediate";
    await c.submit();
    expect(c.state.state).toBe("delivered");
    expect(r.adapter.deliveries.map((d) => d.requestId)).toEqual(["req-1"]);
  });

  test("target going stale before submit -> TARGET_UNAVAILABLE, nothing sent", async () => {
    const r = await rig();
    const c = r.console.composer;
    recordAndReview(r, "s-claude-idle");
    r.adapter.removeSession(refOf(r, "s-claude-idle"));
    expect(c.state.state).toBe("target_unavailable");
    expect((await c.submit()).ok).toBe(false);
    expect(r.adapter.deliveries).toHaveLength(0);
    expect(c.state.transcript).toBe("fix the codec");
  });

  test("target lost while recording surfaces after transcription, transcript kept", async () => {
    const r = await rig();
    const c = r.console.composer;
    const d = dest(r, "s-claude-idle");
    c.start(d);
    if (d.mode !== "continue-session") throw new Error("mode");
    r.adapter.removeSession(d.target);
    expect(c.state.state).toBe("recording");
    c.stop();
    c.transcribed("hello");
    expect(c.state).toMatchObject({ state: "target_unavailable", transcript: "hello" });
  });

  test("explicit retarget after target loss starts a fresh request", async () => {
    const r = await rig();
    const c = r.console.composer;
    recordAndReview(r, "s-claude-idle");
    const d = dest(r, "s-claude-idle");
    if (d.mode !== "continue-session") throw new Error("mode");
    r.adapter.removeSession(d.target);
    expect(c.retarget(dest(r, "s-claude-fw")).ok).toBe(true);
    await c.submit();
    expect(c.state.state).toBe("delivered");
    expect(r.adapter.deliveries[0]?.key).toBe(keyOf(r, "s-claude-fw"));
  });

  test("cancel in each pre-dispatch state; never during dispatch", async () => {
    const r = await rig("mixed", { ackMode: "hang" });
    const c = r.console.composer;
    for (const stopAt of ["recording", "transcribing", "reviewing"]) {
      c.start(dest(r, "s-claude-idle"));
      if (stopAt !== "recording") c.stop();
      if (stopAt === "reviewing") c.transcribed("x");
      expect(c.state.state).toBe(stopAt as never);
      expect(c.cancel().ok).toBe(true);
      expect(c.state.state).toBe("cancelled");
    }
    recordAndReview(r, "s-claude-idle");
    const p = c.submit();
    expect(c.cancel().ok).toBe(false);
    r.adapter.release(c.state.requestId ?? "");
    await p;
    expect(c.state.state).toBe("delivered");
  });

  test("unsupported capability fails without sending", async () => {
    const r = await rig("mixed", { capabilities: capabilitiesFrom({ supported: true, verified: "code" }, { sendPrompt: { supported: false, reason: "no prompt API", verified: "code" } }) });
    const c = r.console.composer;
    recordAndReview(r, "s-claude-idle");
    await c.submit();
    expect(c.state).toMatchObject({ state: "failed", stage: "unsupported", retryable: false, error: "no prompt API" });
    expect(r.console.dispatcher.adapterCalls).toBe(0);
  });

  test("transcription failure is terminal and a new recording can start", async () => {
    const r = await rig();
    const c = r.console.composer;
    c.start(dest(r, "s-claude-idle"));
    c.stop();
    c.transcriptionFailed("engine crashed");
    expect(c.state).toMatchObject({ state: "failed", retryable: false, error: "engine crashed" });
    expect((await c.submit()).ok).toBe(false);
    expect(c.start(dest(r, "s-claude-idle")).ok).toBe(true);
  });

  test("new-session and new-task destinations create backend entities", async () => {
    const r = await rig();
    const c = r.console.composer;
    const task = r.console.registry.tasks()[0];
    const project = r.console.registry.projects()[0];
    if (!task || !project) throw new Error("fixture");
    c.start({ mode: "new-session", task: task.ref, provider: "codex", label: "s" });
    c.stop();
    c.transcribed("start on the parser");
    await c.submit();
    expect(c.state.state).toBe("delivered");
    c.start({ mode: "new-task", project, provider: "claude", label: "t" });
    c.stop();
    c.transcribed("Investigate flaky test\nmore detail");
    await c.submit();
    expect(r.adapter.deliveries.map((d) => d.kind)).toEqual(["createSession", "createTask"]);
    expect(r.console.registry.tasks().some((t) => t.title === "Investigate flaky test")).toBe(true);
  });
});
