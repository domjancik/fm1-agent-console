import { describe, expect, test } from "bun:test";
import { fixturePath, loadFixture } from "../src/fixtures";
import { sessionKey } from "../src/identity";
import { SessionRegistry } from "../src/registry";
import { observedStatus } from "../src/status";
import { ref, session, snapshot } from "./helpers";

const k = (id: string) => sessionKey(ref(id));

function seeded(ids: string[]): SessionRegistry {
  const r = new SessionRegistry({ staleRetentionMs: 1000 });
  r.applySnapshot(snapshot(ids.map((id, i) => session(id, "idle", i + 1))), 0);
  return r;
}

describe("stable slots", () => {
  test("a session keeps its slot across state updates", () => {
    const r = seeded(["a", "b", "c"]);
    const before = r.get(k("b"))?.slot;
    r.applyEvent({ type: "session_upserted", session: { ...session("b", "working", 2), title: "renamed" } }, 5);
    expect(r.get(k("b"))?.slot).toBe(before);
    expect(r.get(k("b"))?.session.title).toBe("renamed");
  });

  test("slot order is deterministic regardless of enumeration order", () => {
    const sessions = ["c", "a", "b"].map((id, i) => session(id, "idle", 10 - i));
    const r1 = new SessionRegistry();
    r1.applySnapshot(snapshot(sessions), 0);
    const r2 = new SessionRegistry();
    r2.applySnapshot(snapshot([...sessions].reverse()), 0);
    expect(r1.slotKeys()).toEqual(r2.slotKeys());
  });

  test("removed sessions leave a stale slot; new sessions do not take it until pruned", () => {
    const r = seeded(["a", "b", "c"]);
    r.applyEvent({ type: "session_removed", ref: ref("b") }, 10);
    expect(r.get(k("b"))?.stale).toBe(true);
    r.applyEvent({ type: "session_upserted", session: session("d", "idle", 9) }, 11);
    expect(r.get(k("d"))?.slot).toBe(3);
    expect(r.pruneStale(500)).toEqual([]);
    expect(r.pruneStale(1010)).toEqual([k("b")]);
    r.applyEvent({ type: "session_upserted", session: session("e", "idle", 12) }, 1020);
    expect(r.get(k("e"))?.slot).toBe(1);
    expect(r.get(k("a"))?.slot).toBe(0);
    expect(r.get(k("c"))?.slot).toBe(2);
  });

  test("a stale session that comes back reclaims its own slot", () => {
    const r = seeded(["a", "b"]);
    r.applyEvent({ type: "session_removed", ref: ref("a") }, 1);
    r.applyEvent({ type: "session_upserted", session: session("a", "working", 1) }, 2);
    expect(r.get(k("a"))).toMatchObject({ slot: 0, stale: false });
  });

  test("40 sessions span two pages of 27", () => {
    const f = loadFixture(fixturePath("forty"));
    const r = new SessionRegistry();
    r.applySnapshot(f.snapshot, 0);
    expect(r.pageCount()).toBe(2);
    expect(r.pageKeys(0).filter(Boolean).length).toBe(27);
    expect(r.pageKeys(1).filter(Boolean).length).toBe(13);
    expect(r.pageKeys(1)).toHaveLength(27);
  });
});

describe("selection", () => {
  test("selection is keyed by identity and survives other sessions changing", () => {
    const r = seeded(["a", "b", "c"]);
    expect(r.select(k("b")).ok).toBe(true);
    r.applyEvent({ type: "session_upserted", session: session("a", "failed", 1) }, 1);
    r.applyEvent({ type: "session_removed", ref: ref("c") }, 2);
    r.applyEvent({ type: "session_upserted", session: session("z", "working", 0) }, 3);
    expect(r.selection()).toEqual({ key: k("b"), status: "ok" });
  });

  test("cannot select unknown or stale sessions", () => {
    const r = seeded(["a"]);
    expect(r.select(k("nope")).ok).toBe(false);
    r.applyEvent({ type: "session_removed", ref: ref("a") }, 1);
    expect(r.select(k("a")).ok).toBe(false);
  });

  test("reconnect re-enumeration marks an unresolved selection stale", () => {
    const r = seeded(["a", "b"]);
    r.select(k("a"));
    r.setConnection("disconnected");
    expect(r.resolve(ref("a"))).toEqual({ ok: false, error: "disconnected" });
    r.applySnapshot(snapshot([session("b", "idle", 2)]), 100);
    expect(r.connection()).toBe("connected");
    expect(r.selection()).toEqual({ key: k("a"), status: "stale" });
    expect(r.resolve(ref("a"))).toEqual({ ok: false, error: "stale" });
    expect(r.resolve(ref("b")).ok).toBe(true);
  });
});

describe("event validation", () => {
  test("malformed events are rejected and state is untouched", () => {
    const r = seeded(["a"]);
    const rev = r.revision;
    const before = JSON.stringify(r.sessions());
    const bad: unknown[] = [
      { type: "session_upserted", session: { ...session("a"), provider: "gpt" } },
      { type: "session_upserted", session: { ...session("a"), ref: { ...ref("a"), hostId: "" } } },
      { type: "session_removed" },
      { type: "approval_requested", approval: { id: "x", sessionRef: ref("a"), summary: 3, createdAt: 1 } },
      "garbage",
    ];
    for (const ev of bad) expect(r.applyEvent(ev, 1).ok).toBe(false);
    expect(r.revision).toBe(rev);
    expect(JSON.stringify(r.sessions())).toBe(before);
  });

  test("approvals for unknown or stale sessions are rejected", () => {
    const r = seeded(["a"]);
    const res = r.applyEvent({ type: "approval_requested", approval: { id: "x", sessionRef: ref("ghost"), summary: "s", createdAt: 1 } }, 1);
    expect(res.ok).toBe(false);
    expect(r.approvals()).toEqual([]);
  });

  test("approvals of a session that goes stale are dropped", () => {
    const r = seeded(["a"]);
    r.applyEvent({ type: "approval_requested", approval: { id: "x", sessionRef: ref("a"), summary: "s", createdAt: 1 } }, 1);
    expect(r.approvalsFor(k("a"))).toHaveLength(1);
    r.applyEvent({ type: "session_removed", ref: ref("a") }, 2);
    expect(r.approvals()).toEqual([]);
  });

  test("inferred-only status is stored with raw intact", () => {
    const r = seeded([]);
    const s = { ...session("q"), status: { ...observedStatus(null, 1, { pty: true }), inferred: { state: "working" as const, reason: "pty" } } };
    expect(r.applyEvent({ type: "session_upserted", session: s }, 1).ok).toBe(true);
    expect(r.get(k("q"))?.session.status.raw).toEqual({ pty: true });
  });
});
