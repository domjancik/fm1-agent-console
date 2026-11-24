import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@fm1/agent-core";
import type { PendingApproval } from "../src/agent/chat-channel";
import { approvalSummary } from "../src/agent/approvals";
import { activityText, asciiFold, ChatDetails, plainText, redactSecrets, shortModel, summaryFor } from "../src/agent/chat-details";
import { SessionBook } from "../src/agent/session-book";
import type { NormalizedAgent, NormalizedTask } from "../src/normalize";
import type { ChatFrame } from "../src/streams";

// Shapes follow the live chat.subscribe snapshot of the disposable smoke chat (host 1.5.4), with synthetic content.
const snapshot = (over: Record<string, unknown> = {}): ChatFrame => ({
  kind: "snapshot",
  snapshot: {
    chat: { id: "c1", updatedAt: 5_000, settings: { harnessId: "claude", model: "claude-opus-4-5-20251101" } },
    runStatus: "idle",
    activeTurn: null,
    derived: { latestAssistantUsage: { contextTokens: 107_178, contextWindow: 1_000_000 } },
    tail: {
      messages: [
        { role: "user", timestamp: 1_000 },
        { role: "assistant", timestamp: 1_500, turnId: "t1", blocks: [{ type: "text", status: "completed", blockId: "b1", text: "First **answer** with `code`." }] },
        { role: "user", timestamp: 2_000 },
        {
          role: "assistant",
          timestamp: 4_000,
          turnId: "t2",
          blocks: [
            { type: "reasoning", status: "completed", blockId: "r", content: "hm" },
            { type: "file_change", status: "completed", blockId: "f1", filePath: "/repo/packages/a/view.ts" },
            { type: "file_change", status: "completed", blockId: "f2", filePath: "/repo/packages/a/copy.ts" },
            { type: "text", status: "completed", blockId: "b2", text: "## Done\n\nAll 412 tests pass — see [report](http://x)." },
          ],
        },
      ],
      events: [
        { type: "turn.started", timestamp: 2_100, message: "Turn started.", severity: "info" },
        { type: "turn.completed", timestamp: 4_100, message: "Turn completed.", severity: "info" },
      ],
    },
    ...over,
  },
});

const delta = (event: Record<string, unknown>): ChatFrame => ({ kind: "blockDelta", event: { blockId: "x", timestamp: 9_000, parentBlockId: null, ...event } });

describe("text helpers", () => {
  test("asciiFold folds typography and accents, drops the rest", () => {
    expect(asciiFold("café “quoted” — done… ✓ 🚀 x")).toBe('cafe "quoted" - done... ok x');
  });
  test("plainText strips markdown to words", () => {
    expect(asciiFold(plainText("## Title\n- **bold** and `code` [link](http://a)\n```ts\nconst a = 1;\n```"))).toBe("Title - bold and code link const a = 1;");
  });
  test("shortModel", () => {
    expect(shortModel("claude-opus-4-5-20251101")).toBe("opus-4-5");
    expect(shortModel("haiku")).toBe("haiku");
    expect(shortModel("gpt-5-codex")).toBe("gpt-5-codex");
  });
  test("activityText names the verb and the target", () => {
    expect(activityText("Edit", "/repo/src/view.ts")).toBe("editing view.ts");
    expect(activityText("Read", "/repo/src/copy.ts")).toBe("reading copy.ts");
    expect(activityText("Bash", "bun test")).toBe("running bun test");
    expect(activityText("Grep", "titleSplit")).toBe("searching titleSplit");
    expect(activityText("mcp__linear__get_issue", "LIN-1")).toBe("get issue LIN-1");
    expect(activityText("Bash", "x".repeat(100)).length).toBeLessThanOrEqual(60);
  });
});

describe("ChatDetails", () => {
  test("snapshot: last message, files of the last turn, context, model, turns, last activity", () => {
    const d = new ChatDetails();
    d.consume(snapshot(), 10_000);
    expect(d.details()).toEqual({
      lastMessage: "Done All 412 tests pass - see report.",
      // The same message's structure (docs/ui-v3.md section 13): the heading, a paragraph gap, the paragraph.
      lastBlocks: [{ kind: "heading", inline: [{ text: "Done" }] }, { kind: "gap" }, { kind: "para", inline: [{ text: "All 412 tests pass - see report." }] }],
      lastMessageAt: 4_000,
      contextPct: 11,
      model: "opus-4-5",
      turns: 2,
      files: { count: 2, names: ["view.ts", "copy.ts"] },
    });
    expect(d.lastActivityAt()).toBe(5_000);
  });

  test("the skeleton counts every user row, beyond the bounded tail", () => {
    const d = new ChatDetails();
    d.consume(snapshot(), 0);
    d.consume({ kind: "skeletonChunk", chunk: { fromOrdinal: 0, entries: [1, 2, 3, 4, 5].map((i) => ({ rowId: `u${i}`, role: "user", createdAt: i })) } }, 0);
    expect(d.details().turns).toBe(5);
  });

  test("a live turn: activity follows the open tool, text commits on completion, files and usage update", () => {
    const d = new ChatDetails();
    d.consume(snapshot(), 0);
    d.consume(delta({ type: "turn.started", turnId: "t3" }), 0);
    expect(d.activity()).toBe("thinking");
    expect(d.details().files).toBeUndefined();
    d.consume(delta({ type: "tool_call.started", blockId: "k1", toolName: "Bash", input: { command: "bun test" } }), 0);
    expect(d.activity()).toBe("running bun test");
    d.consume(delta({ type: "file_change.started", blockId: "k2", filePath: "/r/src/view.ts", operation: "edit" }), 0);
    expect(d.activity()).toBe("editing view.ts");
    d.consume(delta({ type: "file_change.completed", blockId: "k2", filePath: "/r/src/view.ts", operation: "edit", reason: "captured" }), 0);
    expect(d.activity()).toBe("running bun test");
    d.consume(delta({ type: "tool_call.completed", blockId: "k1", toolName: "Bash" }), 0);
    d.consume(delta({ type: "usage.updated", turnId: "t3", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, contextTokens: 420_000, contextWindow: 1_000_000 } }), 0);
    d.consume(delta({ type: "text.delta", blockId: "m1", delta: "Renamed " }), 0);
    d.consume(delta({ type: "text.delta", blockId: "m1", delta: "and tested." }), 0);
    expect(d.activity()).toBe("writing reply");
    // streaming text is not the last message until it completes
    expect(d.details().lastMessage).toBe("Done All 412 tests pass - see report.");
    d.consume(delta({ type: "text.completed", blockId: "m1", timestamp: 9_500 }), 0);
    d.consume(delta({ type: "turn.completed", turnId: "t3" }), 0);
    const out = d.details();
    expect(out.lastMessage).toBe("Renamed and tested.");
    expect(out.lastMessageAt).toBe(9_500);
    expect(out.activity).toBeUndefined();
    expect(out.contextPct).toBe(42);
    expect(out.turns).toBe(3);
    expect(out.files).toEqual({ count: 1, names: ["view.ts"] });
    expect(d.lastActivityAt()).toBe(9_500);
  });

  test("a failed turn sets the failure; the next turn clears it", () => {
    const d = new ChatDetails();
    d.consume(snapshot(), 0);
    d.consume(delta({ type: "turn.started", turnId: "t3" }), 0);
    d.consume(delta({ type: "turn.interrupted", turnId: "t3", reason: "Tests failed: 3 — see log" }), 0);
    expect(d.details().failure).toBe("Tests failed: 3 - see log");
    d.consume(delta({ type: "turn.started", turnId: "t4" }), 0);
    expect(d.details().failure).toBeUndefined();
    d.consume(delta({ type: "error", message: "rate limited", recoverable: false }), 0);
    expect(d.details().failure).toBe("rate limited");
  });

  test("snapshot of an interrupted turn and of a running tool", () => {
    const d = new ChatDetails();
    const base = snapshot().snapshot as Record<string, unknown>;
    const tail = base.tail as { messages: Record<string, unknown>[]; events: Record<string, unknown>[] };
    d.consume(
      snapshot({
        activeTurn: { turnId: "t2", status: "running" },
        tail: {
          messages: [...tail.messages.slice(0, 3), { role: "assistant", timestamp: 4_000, blocks: [{ type: "command", status: "streaming", blockId: "c", command: "bun run build" }] }],
          events: [{ type: "turn.interrupted", timestamp: 3_000, message: "Interrupted", severity: "error", metadata: { reason: "Out of credits" } }],
        },
      }),
      0,
    );
    expect(d.details().activity).toBe("running bun run build");
    expect(d.details().failure).toBe("Out of credits");
    expect(d.details().lastMessage).toBe("First answer with code.");
    d.consume({ kind: "turnStateChanged", runStatus: "running", activeTurn: { turnId: "t2", status: "completed" } }, 0);
    expect(d.details().activity).toBeUndefined();
  });

  test("the last message is cut at 600 characters on a word boundary, ASCII only", () => {
    const d = new ChatDetails();
    const long = Array.from({ length: 200 }, (_, i) => `wörd${i}`).join(" ");
    d.consume(delta({ type: "text.delta", blockId: "m", delta: long }), 0);
    d.consume(delta({ type: "text.completed", blockId: "m" }), 0);
    const msg = d.details().lastMessage ?? "";
    expect(msg.length).toBeLessThanOrEqual(600);
    expect(msg.startsWith("word0 word1")).toBe(true);
    expect(/^[\x20-\x7e]*$/.test(msg)).toBe(true);
    expect(msg.endsWith(" ")).toBe(false);
  });

  test("approval details: the command, or the files and what the edit does", () => {
    const d = new ChatDetails();
    const cmd: PendingApproval = { approvalId: "a", kind: "command", toolName: "Bash", description: "rm -rf build/", paths: [], requestedAt: 1 };
    expect(d.details(cmd).approval).toEqual({ target: "rm -rf build/", summary: "Bash" });
    const file: PendingApproval = { approvalId: "b", kind: "fileEdit", toolName: "Edit", description: "Rename parse to decode", paths: ["/r/a/view.ts"], requestedAt: 1 };
    expect(d.details(file).approval).toEqual({ target: "view.ts", summary: "Rename parse to decode" });
  });

  test("review: secrets in commands, messages, failures and approvals never reach the details", () => {
    const d = new ChatDetails();
    d.consume(snapshot(), 0);
    d.consume(delta({ type: "turn.started", turnId: "t3" }), 0);
    d.consume(delta({ type: "tool_call.started", blockId: "k1", toolName: "Bash", input: { command: "GITHUB_TOKEN=ghp_abcdefghijklmnop1234 gh pr list" } }), 0);
    expect(d.activity()).toBe("running GITHUB_TOKEN=<redacted> gh pr list");
    d.consume(delta({ type: "command.started", blockId: "k2", command: "curl -H 'Authorization: Bearer abc123def456ghi789' https://api" }), 0);
    expect(d.activity()).not.toContain("abc123def456ghi789");
    d.consume(delta({ type: "text.delta", blockId: "m1", delta: "Set OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234 in .env and ran it." }), 0);
    d.consume(delta({ type: "text.completed", blockId: "m1" }), 0);
    d.consume(delta({ type: "error", message: "login failed: password: hunter2 rejected" }), 0);
    const cmd: PendingApproval = { approvalId: "a", kind: "command", toolName: "Bash", description: "mysql --password s3cr3t -u root", paths: [], requestedAt: 1 };
    const out = JSON.stringify(d.details(cmd));
    for (const secret of ["ghp_abcdefghijklmnop1234", "sk-proj-abcdefghijklmnop1234", "hunter2", "s3cr3t", "abc123def456ghi789"]) expect(out).not.toContain(secret);
    expect(d.details(cmd).approval?.target).toBe("mysql --password <redacted> -u root");
    expect(approvalSummary(cmd)).toBe("Bash: mysql --password <redacted> -u root");
  });

  test("review: redaction keeps ordinary text readable", () => {
    for (const t of ["bun test packages/device-protocol", "authentication: failed for user", "the token expired", "edited apps/companion/src/device/render.ts"]) expect(redactSecrets(t)).toBe(t);
    expect(redactSecrets("export AWS_SECRET_ACCESS_KEY=abc/def+ghi")).toBe("export AWS_SECRET_ACCESS_KEY=<redacted>");
    expect(redactSecrets("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U")).toBe("jwt <redacted>");
  });

  test("unknown frames and malformed fields are ignored", () => {
    const d = new ChatDetails();
    d.consume({ kind: "pong" }, 0);
    d.consume({ kind: "snapshot", snapshot: { tail: { messages: [null, 3, { role: "assistant", blocks: "x" }] }, derived: { latestAssistantUsage: { contextTokens: "a" } } } }, 0);
    d.consume(delta({ type: "tool_call.started" }), 0);
    expect(d.details()).toEqual({});
  });
});

describe("summaryFor", () => {
  test("activity when working, failure when failed, approval when pending, else the message head", () => {
    expect(summaryFor({ activity: "editing view.ts", lastMessage: "x" }, "working")).toBe("editing view.ts");
    expect(summaryFor({ failure: "Tests failed: 3", lastMessage: "x" }, "failed")).toBe("Tests failed: 3");
    expect(summaryFor({ approval: { target: "rm -rf build/", summary: "Bash" } }, "approval_required")).toBe("rm -rf build/: Bash");
    expect(summaryFor({ lastMessage: "Done. All pass." }, "completed_unread")).toBe("Done. All pass.");
    expect(summaryFor({}, "idle")).toBeUndefined();
  });
});

describe("SessionBook with chat details", () => {
  const task: NormalizedTask = { epicId: "e1", kind: "epic", title: "Task", status: null, createdAt: 1, updatedAt: 1, pinned: false, chatHostIds: [], workspaces: ["/w"], workspaceRefs: [], repos: [] };
  const agent: NormalizedAgent = {
    epicId: "e1", agentId: "c1", surface: "gui", harnessId: "claude", model: null, reasoningEffort: null, permissionMode: null, profileId: null,
    title: "Chat", parentId: null, hostId: null, ownerUserId: "u", archived: false, sessionState: null, createdAt: 100, updatedAt: 3_000,
  };

  test("lastActivityAt uses the record's update; the stream's details set summary, details and a newer activity time", () => {
    const events: AgentEvent[] = [];
    const book = new SessionBook((e) => events.push(e), () => 10_000);
    book.setHost("h");
    book.setTasks([task], true);
    book.putAgent(agent, false);
    expect(book.session("e1", "c1")?.lastActivityAt).toBe(3_000);
    expect(book.session("e1", "c1")?.details).toBeUndefined();
    const details = new ChatDetails();
    details.consume(snapshot(), 0);
    const channel = { epicId: "e1", chatId: "c1", ready: true, closed: false, activeTurn: null, runStatus: "idle", pendingInterviews: new Set<string>(), pendingApprovals: new Map(), details };
    book.applyChannel(channel as never, true);
    const s = book.session("e1", "c1");
    expect(s?.lastActivityAt).toBe(5_000);
    expect(s?.details?.lastMessage).toBe("Done All 412 tests pass - see report.");
    expect(s?.summary).toBe("Done All 412 tests pass - see report.");
    const upserts = events.filter((e) => e.type === "session_upserted");
    expect(upserts.length).toBe(1);
    // the same details again emit nothing
    book.applyChannel(channel as never, true);
    expect(events.filter((e) => e.type === "session_upserted").length).toBe(1);
    // closing the stream keeps the details
    book.applyChannel(channel as never, false);
    expect(book.session("e1", "c1")?.details?.model).toBe("opus-4-5");
  });
});
