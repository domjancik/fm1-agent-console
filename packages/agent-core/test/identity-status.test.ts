import { describe, expect, test } from "bun:test";
import { fixturePath, loadFixture } from "../src/fixtures";
import { isCompleteRef, parseSessionKey, sameSession, sessionKey, taskKey, taskOf } from "../src/identity";
import { effectiveState, isInferred } from "../src/status";
import { parseEvent, parseSession } from "../src/validate";
import { ref, session } from "./helpers";

describe("session identity", () => {
  test("key round-trips through parse", () => {
    const r = ref("s/1", "t:2", "p 3");
    expect(parseSessionKey(sessionKey(r))).toEqual(r);
  });

  test("a slash inside an id cannot forge another identity", () => {
    const a = { ...ref("x"), taskId: "t/evil" };
    const b = { ...ref("evil/x"), taskId: "t" };
    expect(sessionKey(a)).not.toBe(sessionKey(b));
  });

  test("identity ignores title, provider and slot", () => {
    const a = session("s1");
    const b = { ...session("s1"), title: "renamed", provider: "codex" as const };
    expect(sameSession(a.ref, b.ref)).toBe(true);
  });

  test("every component participates in identity", () => {
    const base = ref("s1");
    for (const f of ["backendId", "hostId", "projectId", "taskId", "sessionId"] as const) {
      expect(sessionKey({ ...base, [f]: "other" })).not.toBe(sessionKey(base));
    }
  });

  test("incomplete refs are rejected", () => {
    expect(isCompleteRef({ ...ref("s"), hostId: "" })).toBe(false);
    expect(parseSessionKey("a/b/c")).toBeNull();
    expect(parseSessionKey("a/b/c/d/")).toBeNull();
  });

  test("taskKey derives from the session ref", () => {
    expect(taskKey(taskOf(ref("s1", "t9")))).toBe("b/h/p1/t9");
  });
});

describe("status normalization", () => {
  test("observed facts win over inference", () => {
    const s = session("s", "idle");
    s.status.inferred = { state: "working", reason: "pty output" };
    expect(effectiveState(s.status)).toBe("idle");
    expect(isInferred(s.status)).toBe(false);
  });

  test("inference fills only a missing observation and is flagged", () => {
    const s = session("s", null);
    s.status.inferred = { state: "working", reason: "pty output" };
    expect(effectiveState(s.status)).toBe("working");
    expect(isInferred(s.status)).toBe(true);
  });

  test("no observation and no inference is unknown", () => {
    expect(effectiveState(session("s", null).status)).toBe("unknown");
  });

  test("fixture keeps raw backend state and separates inferred activity", () => {
    const f = loadFixture(fixturePath("mixed"));
    const tui = f.snapshot.sessions.find((s) => s.ref.sessionId === "s-codex-tui");
    expect(tui?.status.observed.state).toBeNull();
    expect(tui?.status.inferred?.reason).toContain("PTY");
    expect(tui?.status.raw).toEqual({ sessionState: "running", active: true });
    const failed = f.snapshot.sessions.find((s) => s.ref.sessionId === "s-claude-voice");
    expect(failed?.status.raw).toEqual({ activeTurn: { status: "errored" } });
  });

  test("unknown state strings are rejected, not coerced", () => {
    const bad = { ...session("s"), status: { observed: { state: "busy", at: 1 }, raw: null } };
    const r = parseSession(bad);
    expect(r.ok).toBe(false);
  });

  test("malformed events are rejected with a reason", () => {
    for (const ev of [null, 42, {}, { type: "nope" }, { type: "session_upserted" }, { type: "session_removed", ref: { sessionId: "x" } }, { type: "command_progress", requestId: "r", stage: "delivered" }]) {
      const r = parseEvent(ev);
      expect(r.ok).toBe(false);
    }
  });

  test("all three fixtures load and validate", () => {
    expect(loadFixture(fixturePath("mixed")).snapshot.sessions.length).toBe(7);
    expect(loadFixture(fixturePath("forty")).snapshot.sessions.length).toBe(40);
    const d = loadFixture(fixturePath("disconnected"));
    expect(d.connected).toBe(false);
    expect(d.snapshot.sessions.every((s) => s.status.observed.state === "disconnected")).toBe(true);
  });
});

test("parseSession accepts an optional finite lastActivityAt >= 0 and rejects anything else", async () => {
  const { parseSession } = await import("../src/validate");
  const { session } = await import("./helpers");
  const base = session("x");
  expect(parseSession({ ...base, lastActivityAt: 5 })).toMatchObject({ ok: true, value: { lastActivityAt: 5 } });
  expect(parseSession(base)).toMatchObject({ ok: true });
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "5", null]) expect(parseSession({ ...base, lastActivityAt: bad }).ok).toBe(false);
});
