import { describe, expect, test } from "bun:test";
import { fixturePath, loadFixture } from "../src/fixtures";
import { sessionKey } from "../src/identity";
import { Inbox } from "../src/inbox";
import { SessionRegistry } from "../src/registry";
import { ref, session, snapshot } from "./helpers";

function mixed(): { r: SessionRegistry; inbox: Inbox } {
  const r = new SessionRegistry();
  r.applySnapshot(loadFixture(fixturePath("mixed")).snapshot, 0);
  const inbox = new Inbox();
  inbox.sync(r, 0);
  return { r, inbox };
}

describe("inbox", () => {
  test("collects approval, question, failure and unread completion, approvals first", () => {
    const { inbox } = mixed();
    expect(inbox.items().map((i) => i.kind)).toEqual(["approval", "question", "failure", "completed"]);
    const approval = inbox.items()[0];
    expect(approval?.approvalId).toBe("appr-1");
    expect(approval?.id).toBe("approval:appr-1");
    expect(inbox.unreadCount()).toBe(4);
  });

  test("an approval-required session with a pending request yields one item, not two", () => {
    const { inbox } = mixed();
    expect(inbox.items().filter((i) => i.sessionRef.sessionId === "s-codex-fw")).toHaveLength(1);
  });

  test("item identity is stable across unrelated updates and resyncs", () => {
    const { r, inbox } = mixed();
    const ids = inbox.items().map((i) => i.id);
    const idle = r.sessions().find((e) => e.session.ref.sessionId === "s-claude-idle");
    if (!idle) throw new Error("fixture");
    r.applyEvent({ type: "session_upserted", session: { ...idle.session, status: { ...idle.session.status, observed: { state: "working", at: 9 } } } }, 9);
    inbox.sync(r, 9);
    r.applySnapshot(loadFixture(fixturePath("mixed")).snapshot, 10);
    inbox.sync(r, 10);
    expect(inbox.items().map((i) => i.id)).toEqual(ids);
  });

  test("read state persists; a new occurrence is a new unread item", () => {
    const r = new SessionRegistry();
    r.applySnapshot(snapshot([session("a", "failed")]), 0);
    const inbox = new Inbox();
    inbox.sync(r, 0);
    const first = inbox.items()[0];
    if (!first) throw new Error("expected item");
    expect(inbox.markRead(first.id)).toBe(true);
    inbox.sync(r, 1);
    expect(inbox.items()[0]?.read).toBe(true);
    expect(inbox.unreadCount()).toBe(0);
    r.applyEvent({ type: "session_upserted", session: session("a", "working") }, 2);
    inbox.sync(r, 2);
    expect(inbox.items()).toHaveLength(0);
    r.applyEvent({ type: "session_upserted", session: session("a", "failed") }, 3);
    inbox.sync(r, 3);
    expect(inbox.items()[0]?.id).not.toBe(first.id);
    expect(inbox.items()[0]?.read).toBe(false);
  });

  test("reading a completion turns the slot state into completed_read", () => {
    const r = new SessionRegistry();
    r.applySnapshot(snapshot([session("a", "completed_unread")]), 0);
    const inbox = new Inbox();
    inbox.sync(r, 0);
    const entry = r.get(sessionKey(ref("a")));
    if (!entry) throw new Error("missing");
    expect(inbox.displayState(entry)).toBe("completed_unread");
    inbox.markRead(inbox.items()[0]?.id ?? "");
    expect(inbox.displayState(entry)).toBe("completed_read");
  });

  test("stale sessions drop out of the inbox", () => {
    const { r, inbox } = mixed();
    r.applyEvent({ type: "session_removed", ref: inbox.items()[2]?.sessionRef }, 1);
    inbox.sync(r, 1);
    expect(inbox.items().map((i) => i.kind)).toEqual(["approval", "question", "completed"]);
  });

  test("markRead of an unknown id is refused", () => {
    expect(mixed().inbox.markRead("nope")).toBe(false);
  });

  test("dismiss hides one occurrence locally, approvals cannot be dismissed, and a new occurrence returns", () => {
    const r = new SessionRegistry();
    r.applySnapshot(snapshot([session("a", "failed")]), 0);
    const inbox = new Inbox();
    inbox.sync(r, 0);
    const first = inbox.items()[0];
    expect(inbox.attentionCount(0)).toBe(1);
    expect(inbox.dismiss(first?.id ?? "")).toBe(true);
    inbox.sync(r, 1);
    expect(inbox.attentionCount(1)).toBe(0);
    expect(inbox.todo(1)).toHaveLength(0);
    r.applyEvent({ type: "session_upserted", session: session("a", "working") }, 2);
    inbox.sync(r, 2);
    r.applyEvent({ type: "session_upserted", session: session("a", "failed") }, 3);
    inbox.sync(r, 3);
    expect(inbox.attentionCount(3)).toBe(1);
    expect(inbox.isDismissed(first?.id ?? "")).toBe(false);
    const { inbox: m } = mixed();
    expect(m.dismiss("approval:appr-1")).toBe(false);
  });
});
