// Markdown on the console screen (docs/ui-v3.md section 13): both Traycer sources (GUI chats via chat.subscribe and
// terminal agents via the transcript) hand agent-core the message's structure, redacted and ASCII-folded.
import { describe, expect, test } from "bun:test";
import { layoutMarkdown, type AgentEvent } from "@fm1/agent-core";
import { asciiFoldLines, ChatDetails, messageBlocks } from "../src/agent/chat-details";
import { SessionBook } from "../src/agent/session-book";
import { parseNextSteps, parseTranscript } from "../src/agent/terminal-transcript";
import type { NormalizedAgent, NormalizedTask } from "../src/normalize";
import type { ChatFrame } from "../src/streams";

const ANSWER = [
  "## Result",
  "",
  "Fixed **two** bugs in `view.ts`:",
  "",
  "• first — the wrap",
  "• second",
  "",
  "```sh",
  "export API_TOKEN=abcd1234efgh5678",
  "```",
  "",
  "| File | Lines |",
  "|---|---|",
  "| view.ts | 12 |",
  "",
  "Next steps:",
  "- Run the tests",
  "- Update docs",
].join("\r\n");

const rows = (blocks: ReturnType<typeof messageBlocks>, width = 28): string[] => layoutMarkdown(blocks, width).map((r) => `${r.style[0]}|${r.text}`);

describe("messageBlocks (adapter side)", () => {
  test("typography folded with lines kept ('•' becomes a '-' bullet), secrets redacted inside code", () => {
    expect(asciiFoldLines("a—b\n• c\tcafé")).toBe("a-b\n- c\tcafe");
    const blocks = messageBlocks(ANSWER);
    expect(rows(blocks)).toEqual([
      "h|Result",
      "b|",
      "b|Fixed two bugs in view.ts:",
      "b|",
      "b|- first - the wrap",
      "b|- second",
      "b|",
      "m|export API_TOKEN=<redacted>",
      "b|",
      "h|File    Lines",
      "b|view.ts 12",
      "b|",
      "b|Next steps:",
      "b|- Run the tests",
      "b|- Update docs",
    ]);
    expect(JSON.stringify(blocks)).not.toContain("abcd1234");
  });

  test("a multi-line PEM block is redacted before the lines are read", () => {
    const pem = "key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAAAA\n-----END RSA PRIVATE KEY-----\ndone";
    const text = JSON.stringify(messageBlocks(pem));
    expect(text).not.toContain("MIIEow");
    expect(text).toContain("<redacted>");
  });
});

describe("terminal transcripts (TUI)", () => {
  test("parseTranscript gives lastBlocks next to the plain lastMessage; suggestions still parse", () => {
    const t = `<user_message>go</user_message>\n<assistant_response>${ANSWER}</assistant_response>`;
    const p = parseTranscript(t);
    expect(p.lastMessage?.startsWith("Result Fixed two bugs in view.ts:")).toBe(true);
    expect(p.lastBlocks?.[0]).toEqual({ kind: "heading", inline: [{ text: "Result" }] });
    expect(p.suggestions).toEqual(["Run the tests", "Update docs"]);
    expect(parseNextSteps(ANSWER)).toEqual(["Run the tests", "Update docs"]);
  });
});

describe("GUI chats", () => {
  const frame = (text: string): ChatFrame => ({
    kind: "snapshot",
    snapshot: {
      chat: { id: "c1", updatedAt: 5_000, settings: { harnessId: "claude", model: "claude-opus-4-5-20251101" } },
      runStatus: "idle",
      activeTurn: null,
      derived: {},
      tail: { messages: [{ role: "user", timestamp: 1_000 }, { role: "assistant", timestamp: 4_000, turnId: "t", blocks: [{ type: "text", status: "completed", blockId: "b", text }] }], events: [] },
    },
  });

  test("ChatDetails: lastMessage stays the plain line, lastBlocks carry the structure", () => {
    const d = new ChatDetails();
    d.consume(frame(ANSWER), 10_000);
    const out = d.details();
    expect(out.lastMessage?.startsWith("Result Fixed two bugs")).toBe(true);
    expect(out.lastBlocks).toEqual(messageBlocks(ANSWER));
  });

  test("SessionBook: a terminal reply replaces the chat's older structure with its own", () => {
    const task: NormalizedTask = { epicId: "e1", kind: "epic", title: "Task", status: null, createdAt: 1, updatedAt: 1, pinned: false, chatHostIds: [], workspaces: ["/w"], workspaceRefs: [], repos: [] };
    const agent: NormalizedAgent = {
      epicId: "e1", agentId: "c1", surface: "gui", harnessId: "claude", model: null, reasoningEffort: null, permissionMode: null, profileId: null,
      title: "Chat", parentId: null, hostId: null, ownerUserId: "u", archived: false, sessionState: null, createdAt: 100, updatedAt: 3_000,
    };
    const events: AgentEvent[] = [];
    const book = new SessionBook((e) => events.push(e), () => 10_000);
    book.setHost("h");
    book.setTasks([task], true);
    book.putAgent(agent, false);
    const details = new ChatDetails();
    details.consume(frame(ANSWER), 0);
    book.applyChannel({ epicId: "e1", chatId: "c1", ready: true, closed: false, activeTurn: null, runStatus: "idle", pendingInterviews: new Set<string>(), pendingApprovals: new Map(), details } as never, true);
    expect(book.session("e1", "c1")?.details?.lastBlocks?.[0]).toEqual({ kind: "heading", inline: [{ text: "Result" }] });
    book.setReply("e1", "c1", { requestId: "r1", text: "# Reply\n- **ok**", at: 9_000 });
    const d = book.session("e1", "c1")?.details;
    expect(d?.lastMessage).toBe("Reply - ok");
    expect(d?.lastBlocks).toEqual([{ kind: "heading", inline: [{ text: "Reply" }] }, { kind: "item", depth: 0, marker: "-", inline: [{ text: "ok", mark: "bold" }] }]);
    expect(d?.reply?.blocks).toEqual(d?.lastBlocks);
  });
});
