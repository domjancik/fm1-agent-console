import { describe, expect, test } from "bun:test";
import { PromptTracker } from "../src/prompt-tracker";

const turn = (turnId: string, status: string, userMessageId = "m-1") => ({
  kind: "turnStateChanged",
  runStatus: status === "completed" ? "running" : "running",
  activeTurn: { turnId, status, userMessageId },
});

describe("PromptTracker", () => {
  test("follows a turn whose id is re-minted (frames shaped like host 1.5.4)", () => {
    const tracker = new PromptTracker("a-1", "m-1");
    tracker.consume(turn("turn:placeholder", "starting"));
    tracker.consume({ kind: "actionAck", clientActionId: "a-1", status: "accepted", reason: null, code: null });
    tracker.consume({ kind: "messageAccepted", message: { role: "user", messageId: "m-1" } });
    tracker.consume(turn("harness-turn", "running"));
    tracker.consume({ kind: "blockDelta", event: { type: "text.delta", delta: "FM1_" } });
    tracker.consume({ kind: "blockDelta", event: { type: "text.delta", delta: "MARK" } });
    tracker.consume({ kind: "blockDelta", event: { type: "usage.updated", usage: { contextTokens: 10, contextWindow: 100 } } });
    const done = tracker.consume(turn("harness-turn", "completed"));
    expect(done).toBe(true);
    expect(tracker.result).toEqual({ kind: "finished", status: "completed", turnId: "harness-turn" });
    expect(tracker.messageAccepted).toBe(true);
    expect(tracker.assistantText).toBe("FM1_MARK");
    expect(tracker.usage).toEqual({ contextTokens: 10, contextWindow: 100 });
    expect(tracker.turnStatuses).toEqual(["starting", "running", "completed"]);
  });

  test("a send queued behind a running turn is marked queued, then followed to its own turn", () => {
    const tracker = new PromptTracker("a-1", "m-1", "busy-turn");
    tracker.consume({ kind: "actionAck", clientActionId: "a-1", status: "accepted", reason: null, code: null });
    tracker.consume({ kind: "queueChanged", queue: { status: "running", items: [{ kind: "prompt", queueItemId: "q-0", messageId: "m-other" }] } });
    expect(tracker.queued).toBe(false);
    tracker.consume({ kind: "queueChanged", queue: { status: "running", items: [{ kind: "prompt", queueItemId: "q-1", messageId: "m-1" }] } });
    expect(tracker.queued).toBe(true);
    expect(tracker.messageAccepted).toBe(false);
    tracker.consume({ kind: "messageAccepted", message: { role: "user", messageId: "m-1" } });
    tracker.consume(turn("t-2", "running"));
    expect(tracker.consume(turn("t-2", "completed"))).toBe(true);
    expect(tracker.result).toEqual({ kind: "finished", status: "completed", turnId: "t-2" });
  });

  test("ignores other clients' acks and other messages' turns", () => {
    const tracker = new PromptTracker("a-1", "m-1");
    tracker.consume({ kind: "actionAck", clientActionId: "other", status: "rejected", reason: "x", code: "y" });
    tracker.consume(turn("t-other", "completed", "m-other"));
    expect(tracker.result.kind).toBe("pending");
    expect(tracker.ack).toBeNull();
  });

  test("a rejected ack settles the outcome", () => {
    const tracker = new PromptTracker("a-1", "m-1");
    const done = tracker.consume({ kind: "actionAck", clientActionId: "a-1", status: "rejected", reason: "busy", code: "CHAT_BUSY" });
    expect(done).toBe(true);
    expect(tracker.result).toEqual({ kind: "rejected", ack: { status: "rejected", reason: "busy", code: "CHAT_BUSY" } });
  });

  test("without userMessageId, skips the prior turn and adopts the first turn after the ack", () => {
    const tracker = new PromptTracker("a-1", "m-1", "t-prior");
    const bare = (turnId: string, status: string) => ({ kind: "turnStateChanged", runStatus: "running", activeTurn: { turnId, status } });
    tracker.consume(bare("t-prior", "completed"));
    tracker.consume({ kind: "actionAck", clientActionId: "a-1", status: "accepted", reason: null, code: null });
    tracker.consume(bare("t-new", "running"));
    tracker.consume(bare("t-new", "stopped"));
    expect(tracker.result).toEqual({ kind: "finished", status: "stopped", turnId: "t-new" });
  });
});
