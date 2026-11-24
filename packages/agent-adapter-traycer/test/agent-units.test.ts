import { describe, expect, test } from "bun:test";
import { parseTaskCreateOutput, strippedEnv, taskCreateArgv } from "../src/agent/cli";
import { parseChatRecordFrame, parseNotificationFrame } from "../src/agent/feeds";
import { deepLinkUrl } from "../src/agent/focus";
import { projectIdOf, providerOf } from "../src/agent/mapping";
import { deriveStatus, emptyFacts } from "../src/agent/state-model";
import type { NormalizedTask } from "../src/normalize";

const task = (over: Partial<NormalizedTask>): NormalizedTask => ({
  epicId: "e",
  kind: "epic",
  title: "t",
  status: null,
  createdAt: null,
  updatedAt: null,
  pinned: false,
  chatHostIds: [],
  workspaces: [],
  workspaceRefs: [],
  repos: [],
  ...over,
});

describe("project mapping", () => {
  test("local workspace first, then any workspace, then repo, then none", () => {
    expect(
      projectIdOf(task({ workspaces: ["/b", "/a"], workspaceRefs: [{ hostId: "other", path: "/a" }, { hostId: "me", path: "/b" }] }), "me"),
    ).toBe("ws:/b");
    expect(projectIdOf(task({ workspaces: ["/z", "/a"], workspaceRefs: [] }), "me")).toBe("ws:/a");
    expect(projectIdOf(task({ repos: ["acme/z", "acme/a"] }), "me")).toBe("repo:acme/a");
    expect(projectIdOf(task({}), "me")).toBe("none");
  });

  test("provider from harness id", () => {
    expect([providerOf("claude"), providerOf("codex"), providerOf("opencode"), providerOf(null)]).toEqual(["claude", "codex", "other", "other"]);
  });
});

describe("state model", () => {
  test("approval beats running; interview is waiting_input", () => {
    const f = emptyFacts("chat");
    f.activity = { inTurn: true, working: true, servedBy: "local", at: 1 };
    f.approvalIds = new Set(["a"]);
    expect(deriveStatus(f, 5).observed.state).toBe("approval_required");
    f.approvalIds = new Set();
    f.interviewIds = new Set(["i"]);
    expect(deriveStatus(f, 5).observed.state).toBe("waiting_input");
  });

  test("a completed active turn is not running even when runStatus says running (host 1.5.4)", () => {
    const f = emptyFacts("chat");
    f.chat = { runStatus: "running", turnStatus: "completed", at: 1 };
    expect(deriveStatus(f, 2).observed.state).toBe("idle");
  });

  test("completed outcome: unread until viewed, read if read in Traycer", () => {
    const f = emptyFacts("chat");
    f.outcome = { status: "completed", at: 10, source: "chat", readInTraycer: false };
    expect(deriveStatus(f, 11).observed.state).toBe("completed_unread");
    f.viewedAt = 12;
    expect(deriveStatus(f, 13).observed.state).toBe("completed_read");
    f.viewedAt = 0;
    f.outcome = { ...f.outcome, readInTraycer: true, source: "notification" };
    expect(deriveStatus(f, 13).observed.state).toBe("completed_read");
  });

  test("errored/interrupted are failed; stopped is idle", () => {
    const f = emptyFacts("chat");
    for (const [status, expected] of [["errored", "failed"], ["interrupted", "failed"], ["stalled", "failed"], ["stopped", "idle"]] as const) {
      f.outcome = { status, at: 1, source: "notification", readInTraycer: false };
      expect(deriveStatus(f, 2).observed.state).toBe(expected);
    }
  });

  test("terminal activity is inferred only, never observed", () => {
    const f = emptyFacts("terminal");
    f.activity = { inTurn: false, working: true, servedBy: "local", at: 1 };
    const s = deriveStatus(f, 2);
    expect(s.observed.state).toBeNull();
    expect(s.inferred?.state).toBe("working");
  });

  test("turn ended per activity with no outcome: observed idle plus an inferred completed_unread", () => {
    const f = emptyFacts("chat");
    f.activity = { inTurn: false, working: false, servedBy: "local", at: 3 };
    f.turnEndedUnreported = 3;
    const s = deriveStatus(f, 4);
    expect(s.observed.state).toBe("idle");
    expect(s.inferred?.state).toBe("completed_unread");
  });
});

describe("feed parsers", () => {
  test("chatRecords: tui upsert keeps harness and session state; garbage is malformed", () => {
    const e = parseChatRecordFrame({
      kind: "tuiUpsert",
      epicId: "e",
      tuiAgentId: "t",
      record: { title: "x", archived: false, createdAt: 1, updatedAt: 2, hostId: "h", harnessId: "claude", sessionState: "running", ownerUserId: "u", parentId: null },
    });
    expect(e.kind === "upsert" && [e.agent.surface, e.agent.harnessId, e.agent.sessionState]).toEqual(["tui", "claude", "running"]);
    expect(parseChatRecordFrame({ kind: "upsert", epicId: "e" }).kind).toBe("malformed");
    expect(parseChatRecordFrame({ kind: "somethingNew" }).kind).toBe("ignored");
  });

  test("notifications: unknown kinds and bad rows are rejected by the vendored schema", () => {
    expect(parseNotificationFrame({ kind: "upserted", hasBinaryPayload: false, entry: { kind: "made.up" } }).kind).toBe("malformed");
    expect(parseNotificationFrame({ kind: "pong", hasBinaryPayload: false }).kind).toBe("ignored");
  });
});

describe("cli and focus helpers", () => {
  test("env strip removes the agent-context variables only", () => {
    const env = strippedEnv({ TRAYCER_AGENT_ID: "a", TRAYCER_EPIC_ID: "e", TRAYCER_TERMINAL_SPAWN_TOKEN: "t", PATH: "/bin" });
    expect(env).toEqual({ PATH: "/bin" });
  });

  test("task create argv always carries --json and --idempotency-key", () => {
    const argv = taskCreateArgv({ message: "m", harnessId: "claude", model: "haiku", idempotencyKey: "k" });
    expect(argv.slice(0, 3)).toEqual(["task", "create", "--json"]);
    expect(argv).toContain("--idempotency-key");
  });

  test("task create output parsing", () => {
    expect(parseTaskCreateOutput('{"type":"result","status":"ok","data":{"taskId":"t","agentId":"a","alreadyCreated":true}}', 0)).toEqual({
      ok: true,
      taskId: "t",
      agentId: "a",
      alreadyCreated: true,
    });
    expect(parseTaskCreateOutput("garbage", 1)).toMatchObject({ ok: false, mayHaveCreated: true });
  });

  test("deep link url validates ids", () => {
    expect(deepLinkUrl("e1", "c1")).toBe("traycer://open/epic/e1/chat/c1?focus=composer");
    expect(deepLinkUrl("e1", "../x")).toBeNull();
  });
});
