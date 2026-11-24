import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, SessionRef } from "@fm1/agent-core";
import { TerminalScreen } from "../src/agent/terminal-screen";
import { parseTranscript } from "../src/agent/terminal-transcript";
import {
  deliverTyped,
  locateUserMessage,
  typeableText,
  userMessages,
  type TerminalStreamEvents,
  type TypingArgs,
  type TypingDeps,
} from "../src/agent/terminal-typing";
import { QUEUED_MESSAGE } from "../src/agent/prompt-delivery";
import { classifyTuiScreen } from "../src/agent/tui-screen-state";
import type { FakeStreamSub } from "./fake-host";
import { HOST, makeHarness, standardWorld, until, type Harness, type World } from "./scenario";

const FIX = join(import.meta.dir, "fixtures", "tui");
const screenOf = (ansi: string | Uint8Array, cols = 80, rows = 24): TerminalScreen => {
  const s = new TerminalScreen(cols, rows);
  s.write(ansi);
  return s;
};
const verdictOf = (ansi: string, harness: "claude" | "codex" = "claude") => {
  const s = screenOf(ansi);
  return classifyTuiScreen(s.lines(), harness, s.cells());
};

const GRAY = "\x1b[38;2;136;136;136m";
const RESET = "\x1b[0m";
const RULE = `${GRAY}${"─".repeat(80)}${RESET}`;
/** A Claude Code screen like the live one: conversation lines, optional status line, the input box, footer. */
function claudeScreen(opts: { above?: string[]; status?: string; box?: string; boxFaint?: string; below?: string[] } = {}): string {
  const lines = [...(opts.above ?? ["⏺ FM1 earlier answer", ""]), opts.status ?? "", RULE, `❯ ${opts.box ?? ""}${opts.boxFaint ? `${GRAY}${opts.boxFaint}${RESET}` : ""}`, RULE, "  [CAVEMAN]", ...(opts.below ?? ["  ⏵⏵ auto mode on · 1 monitor"])];
  return `\x1b[?1049h\x1b[H${lines.join("\r\n")}\x1b[?2004h`;
}

describe("terminal screen (headless VT)", () => {
  test("renders the live serialized snapshot (host 1.5.4, Claude Code 2.1.311): input box, cursor, bracketed paste", () => {
    const s = screenOf(readFileSync(join(FIX, "claude-idle.ans")));
    const lines = s.lines();
    expect(lines[20]).toBe("❯");
    expect(lines[19]?.startsWith("─────")).toBe(true);
    expect(lines[2]).toBe("⏺ FM1_SELF_A2A_MWM18D7O");
    expect(lines[14]).toBe("⏺ Stream ping gap was client-side; host answered in 45ms, no recovery needed.");
    expect(s.cursor).toEqual({ x: 2, y: 20 });
    expect(s.bracketedPaste).toBe(true);
  });

  test("cursor moves, erase, wrap, wide characters, scroll, alternate screen and DECSC/DECRC", () => {
    const s = new TerminalScreen(10, 3);
    s.write("abcdefghijKL"); // wraps
    expect(s.lines()).toEqual(["abcdefghij", "KL", ""]);
    s.write("\x1b[1;3H\x1b[K"); // erase to end of line 1 from col 3
    expect(s.lines()[0]).toBe("ab");
    s.write("\x1b[3;1H漢字x"); // wide characters take two cells
    expect(s.lines()[2]).toBe("漢字x");
    s.write("\r\n1\r\n2"); // LF at the bottom scrolls
    expect(s.lines()).toEqual(["漢字x", "1", "2"]);
    s.write("\x1b7\x1b[1;1HZ\x1b8!");
    expect(s.lines()).toEqual(["Z字x", "1", "2!"]);
    s.write("\x1b[?1049h");
    expect(s.lines()).toEqual(["", "", ""]);
    s.write("\x1b[?1049l");
    expect(s.lines()[2]).toBe("2!");
    s.write("\x1b]0;title\x07\x1b[2J");
    expect(s.lines()).toEqual(["", "", ""]);
  });

  test("hostile counts and saved positions cannot hang or crash the screen (review fix)", () => {
    const s = new TerminalScreen(10, 5);
    const t0 = Date.now();
    s.write("x\x1b[999999999S\x1b[99999999999999999999999T\x1b[3;1H\x1b[999999999L\x1b[999999999M\x1b[999999999@\x1b[999999999P");
    expect(Date.now() - t0).toBeLessThan(500);
    expect(s.lines()).toHaveLength(5);
    // A position saved on a bigger grid is clamped on restore (no undefined row on the next erase).
    const big = new TerminalScreen(80, 40);
    big.write("\x1b[38;70H\x1b7");
    big.resize(20, 10);
    expect(() => big.write("\x1b8\x1b[KZ\x1b[s\x1b[u\x1b[K")).not.toThrow();
    expect(big.cursor.y).toBeLessThan(10);
    expect(big.cursor.x).toBeLessThan(20);
  });

  test("gray or faint text is marked faint (placeholder / suggestion), colored text is not", () => {
    const s = screenOf(`${GRAY}gray${RESET} \x1b[2mdim\x1b[22m \x1b[38;2;255;193;7myellow`);
    const row = s.cells()[0]!;
    expect(row.slice(0, 4).every((c) => c.faint)).toBe(true);
    expect(row.slice(5, 8).every((c) => c.faint)).toBe(true);
    expect(row.slice(9, 15).every((c) => !c.faint)).toBe(true);
  });
});

describe("TUI screen classification", () => {
  test("Claude live idle snapshot -> idle; live trust dialog -> dialog (no input prompt)", () => {
    expect(verdictOf(readFileSync(join(FIX, "claude-idle.ans"), "utf8")).state).toBe("idle");
    expect(verdictOf(readFileSync(join(FIX, "claude-trust-dialog.ans"), "utf8"))).toMatchObject({ state: "dialog", promptRow: -1 });
  });

  test("Claude busy (live spinner line shapes), draft, faint suggested prompt", () => {
    expect(verdictOf(claudeScreen({ status: "· Accomplishing… (2s · ↓ 142 tokens)" })).state).toBe("busy");
    expect(verdictOf(claudeScreen({ status: "✻ Cogitating… (12s · esc to interrupt)" })).state).toBe("busy");
    expect(verdictOf(claudeScreen({ status: "✻ Cogitated for 1s · done 1:22 PM · 1 monitor still running" })).state).toBe("idle");
    expect(verdictOf(claudeScreen({ box: "half-typed draft" })).state).toBe("draft");
    // Claude Code shows a suggested next prompt in the empty box, drawn gray (seen live): still empty.
    expect(verdictOf(claudeScreen({ boxFaint: "retry the sleep with run_in_background" })).state).toBe("idle");
  });

  test("Claude permission prompt (pattern; not produced live) and a menu drawn below the box -> dialog", () => {
    const permission = [
      "\x1b[?1049h\x1b[H⏺ Bash(rm -rf build)",
      RULE,
      " Bash command",
      "   rm -rf build",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. Yes, and don't ask again for rm commands in this folder",
      "   3. No, and tell Claude what to do differently (esc)",
    ].join("\r\n");
    expect(verdictOf(permission)).toMatchObject({ state: "dialog", promptRow: -1 });
    expect(verdictOf(claudeScreen({ below: ["  ❯ 1. Opus", "    2. Haiku", "  Enter to confirm · Esc to exit"] })).state).toBe("dialog");
  });

  test("Codex composer, busy and approval (patterns; no live Codex TUI was available)", () => {
    const codex = (rows: string[]) => `\x1b[H${rows.join("\r\n")}`;
    expect(verdictOf(codex(["• Ran tests", "", `› ${GRAY}Ask Codex to do anything${RESET}`, "", "  ⏎ send   ⌃J newline   ⌃T transcript   ⌃C quit"]), "codex").state).toBe("idle");
    expect(verdictOf(codex(["• Working (5s • esc to interrupt)", "", "› ", "", "  ⏎ send"]), "codex").state).toBe("busy");
    expect(verdictOf(codex(["› draft text", "", "  ⏎ send"]), "codex").state).toBe("draft");
    expect(
      verdictOf(codex(["Would you like to run the following command?", "  $ rm -rf build", "› 1. Yes, proceed", "  2. No, and tell Codex what to do differently", "Press enter to confirm or esc to cancel"]), "codex").state,
    ).toBe("dialog");
  });

  test("nothing recognizable -> unknown (refused, never guessed)", () => {
    expect(verdictOf("\x1b[Hstarting up...").state).toBe("unknown");
    expect(verdictOf("\x1b[H$ ls\r\nfoo bar\r\n$ ").state).toBe("unknown");
  });
});

describe("typing units", () => {
  test("typeableText strips control characters (no paste-end or key injection) and refuses input-mode prefixes", () => {
    expect(typeableText("hello\r\nworld\r")).toEqual({ text: "hello\nworld" });
    expect(typeableText("a\x1b[201~\x03b\tc\x7f\x9b")).toEqual({ text: "a[201~b  c" });
    expect(typeableText("  \n ")).toMatchObject({ error: expect.stringContaining("empty") });
    for (const p of ["/clear", "!rm -rf x", "# remember", "?"]) expect("error" in typeableText(p)).toBe(true);
    expect(typeableText("  fix the /api route")).toEqual({ text: "fix the /api route" });
  });

  test("userMessages counts typed user messages (plain or pasted) and never a2a task notifications", () => {
    const t = [
      "<user_message>\n<task-notification>\n<event>[traycer:agent-message] from X\nFM1_M check\n</event>\n</task-notification>\n</user_message>",
      "<assistant_response>\nold\n</assistant_response>",
      "<user_message>\nFM1_M check\n</user_message>",
      "<assistant_response>\nnew answer\n</assistant_response>",
      '<user_message>\n<pasted_content id="cd54">\nFM1_M check\nline 2\n</pasted_content id="cd54">\n</user_message>',
    ].join("\n\n");
    expect(userMessages(t, ["FM1_M check"])).toHaveLength(2);
    expect(locateUserMessage(t, ["FM1_M check"], 0)).toEqual({ delivered: true, reply: "new answer" });
    expect(locateUserMessage(t, ["FM1_M check"], 1)).toEqual({ delivered: true, reply: null });
    expect(locateUserMessage(t, ["FM1_M check"], 2).delivered).toBe(false);
    // The terminal details keep only what was typed (no pasted_content tags).
    expect(parseTranscript(t).lastPrompt).toBe("FM1_M check line 2");
  });
});

// --- deliverTyped against a fake terminal stream (no host) -------------------------------------------------------

interface FakeTerminal {
  writes: string[];
  opens: Array<{ sessionId: string; cols: number; rows: number }>;
  closed: number;
  transcript: string;
}

function fakeDeps(
  opts: {
    screen?: string;
    afterPaste?: string | null;
    /** Screen redrawn after the Enter (a queued prompt leaves the input box). */
    afterEnter?: string;
    ack?: "accepted" | "rejected" | "none";
    enterAck?: "accepted" | "none";
    deliver?: boolean;
    attach?: "ok" | "refused" | "silent";
    version?: { major: number; minor: number } | null;
    terminal?: "running" | "exited" | "missing" | "error";
    /** Keep redrawing the screen every 10 ms (never quiet). */
    noisy?: boolean;
    throwActive?: boolean;
  } = {},
): { deps: TypingDeps; term: FakeTerminal; progress: string[]; replies: string[] } {
  const term: FakeTerminal = { writes: [], opens: [], closed: 0, transcript: "<user_message>\nearlier\n</user_message>\n" };
  const progress: string[] = [];
  const replies: string[] = [];
  const deps: TypingDeps = {
    terminal: async (_e, agentId) => {
      if (opts.terminal === "error") throw new Error("terminal.list exploded");
      if (opts.terminal === "missing") return null;
      return { sessionId: agentId, cols: 80, rows: 24, status: opts.terminal === "exited" ? "exited" : "running", sessionKind: "terminal-agent" };
    },
    open: (sessionId, size, events: TerminalStreamEvents) => {
      term.opens.push({ sessionId, ...size });
      const session = { sessionId, cols: 80, rows: 24, status: "running" };
      setTimeout(() => {
        if (opts.attach === "refused") events.onClosed("UNAUTHORIZED: not yours");
        else if (opts.attach !== "silent") events.onFrame({ kind: "snapshot", sessionId, session, scrollback: opts.screen ?? claudeScreen() }, null);
      }, 5);
      if (opts.noisy) {
        const timer = setInterval(() => events.onFrame({ kind: "data", sessionId, chunk: `\x1b[H${opts.screen ?? claudeScreen()}` }, null), 10);
        setTimeout(() => clearInterval(timer), 1_000);
      }
      return {
        send: (frame) => {
          const data = String(frame.data);
          term.writes.push(data);
          const isEnter = data === "\r";
          const ack = isEnter ? (opts.enterAck ?? "accepted") : (opts.ack ?? "accepted");
          if (ack !== "none") setTimeout(() => events.onFrame({ kind: "actionAck", sessionId, clientActionId: frame.clientActionId, action: "write", status: ack, reason: null, code: ack === "rejected" ? "FORBIDDEN" : null }, null), 3);
          if (!isEnter && ack === "accepted" && opts.afterPaste !== null) {
            setTimeout(() => events.onFrame({ kind: "data", sessionId, chunk: `\x1b[H${opts.afterPaste ?? claudeScreen({ box: "[Pasted text #1]" })}` }, null), 4);
          }
          if (isEnter && opts.afterEnter !== undefined) {
            const screen = opts.afterEnter;
            setTimeout(() => events.onFrame({ kind: "data", sessionId, chunk: `\x1b[2J\x1b[H${screen}` }, null), 4);
          }
          if (isEnter && opts.deliver !== false) {
            const text = term.writes[term.writes.length - 2]?.replace("\x1b[200~", "").replace("\x1b[201~", "") ?? "";
            setTimeout(() => (term.transcript += `<user_message>\n${text}\n</user_message>\n`), 20);
            setTimeout(() => (term.transcript += "<assistant_response>\nDone: OK\n</assistant_response>\n"), 45);
          }
        },
        close: () => {
          term.closed++;
        },
        negotiated: () => (opts.version === undefined ? { major: 1, minor: 7 } : opts.version),
      };
    },
    transcript: async () => term.transcript,
    progress: (_id, stage) => progress.push(stage),
    onReply: (r) => replies.push(r.text),
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    active: () => {
      if (opts.throwActive) throw new Error("boom");
      return true;
    },
  };
  return { deps, term, progress, replies };
}

const ARGS: TypingArgs = {
  requestId: "req-t",
  epicId: "e1",
  agentId: "t1",
  harness: "claude",
  text: "Report status.\nThen stop.",
  attachTimeoutMs: 150,
  quietMs: 20,
  settleMaxMs: 150,
  writeAckTimeoutMs: 80,
  enterDelayMs: 10,
  confirmTimeoutMs: 250,
  turnTimeoutMs: 600,
  pollMs: 10,
};

describe("deliverTyped (fake terminal stream)", () => {
  test("idle: one bracketed paste, one Enter, then sent -> backend_acknowledged -> completed; stream closed", async () => {
    const f = fakeDeps();
    const out = await deliverTyped(f.deps, ARGS);
    expect(out).toEqual({ written: true, result: { requestId: "req-t", stage: "backend_acknowledged" } });
    expect(f.term.writes).toEqual(["\x1b[200~Report status.\nThen stop.\x1b[201~", "\r"]);
    expect(f.term.opens).toEqual([{ sessionId: "t1", cols: 80, rows: 24 }]);
    expect(f.term.closed).toBe(1);
    await until(() => f.progress.includes("completed"), 1_000, "completed");
    expect(f.progress).toEqual(["sent", "backend_acknowledged", "completed"]);
    expect(f.replies).toEqual(["Done: OK"]);
  });

  test("draft / dialog / unknown screens: refused before any write", async () => {
    const screens: Record<string, string> = {
      draft: claudeScreen({ box: "operator draft" }),
      dialog: readFileSync(join(FIX, "claude-trust-dialog.ans"), "utf8"),
      unknown: "\x1b[Hloading",
    };
    for (const [state, screen] of Object.entries(screens)) {
      const f = fakeDeps({ screen });
      const out = await deliverTyped(f.deps, ARGS);
      expect(out).toMatchObject({ written: false, code: "not_idle", screen: state });
      expect(f.term.writes).toEqual([]);
      expect(f.progress).toEqual([]);
    }
  });

  test("attach refused, attach timeout, no terminal, exited, old host, write rejected: nothing written", async () => {
    const cases: Array<[Parameters<typeof fakeDeps>[0], string]> = [
      [{ attach: "refused" }, "attach_failed"],
      [{ attach: "silent" }, "attach_timeout"],
      [{ terminal: "missing" }, "no_terminal"],
      [{ terminal: "error" }, "no_terminal"],
      [{ terminal: "exited" }, "terminal_exited"],
      [{ version: { major: 1, minor: 5 } }, "old_host"],
    ];
    for (const [opts, code] of cases) {
      const f = fakeDeps(opts);
      const out = await deliverTyped(f.deps, ARGS);
      expect(out).toMatchObject({ written: false, code });
      expect(f.term.writes).toEqual([]);
    }
    const rejected = fakeDeps({ ack: "rejected" });
    expect(await deliverTyped(rejected.deps, ARGS)).toMatchObject({ written: false, code: "write_rejected" });
    expect(rejected.term.writes).toHaveLength(1); // the paste the host refused; no Enter
  });

  test("review fixes: never-quiet screen, unknown version, pre-write error: refused, nothing written", async () => {
    const noisy = fakeDeps({ noisy: true });
    expect(await deliverTyped(noisy.deps, ARGS)).toMatchObject({ written: false, code: "not_idle", screen: "busy" });
    expect(noisy.term.writes).toEqual([]);
    const unknown = fakeDeps({ version: null });
    expect(await deliverTyped(unknown.deps, ARGS)).toMatchObject({ written: false, code: "attach_failed" });
    expect(unknown.term.writes).toEqual([]);
    const thrown = fakeDeps({ throwActive: true });
    expect(await deliverTyped(thrown.deps, ARGS)).toMatchObject({ written: false, code: "internal_error" });
    expect(thrown.term.writes).toEqual([]);
    expect(thrown.term.closed).toBe(1);
  });

  test("busy (turn running, empty box): pasted and submitted, resolves queued at once, completed when answered", async () => {
    const status = "✻ Cogitating… (4s · esc to interrupt)";
    const f = fakeDeps({ screen: claudeScreen({ status }), afterPaste: claudeScreen({ status, box: "[Pasted text #1]" }), afterEnter: claudeScreen({ status }) });
    const out = await deliverTyped(f.deps, ARGS);
    expect(out).toEqual({ written: true, result: { requestId: "req-t", stage: "backend_acknowledged", message: QUEUED_MESSAGE } });
    expect(f.term.writes).toEqual(["\x1b[200~Report status.\nThen stop.\x1b[201~", "\r"]);
    await until(() => f.progress.includes("completed"), 1_000, "completed");
    expect(f.progress).toEqual(["sent", "backend_acknowledged", "completed"]);
    expect(f.replies).toEqual(["Done: OK"]);
  });

  test("a turn starts between the screen read and the paste: Enter queues the prompt behind it", async () => {
    const status = "✻ Cogitating… (1s · esc to interrupt)";
    const f = fakeDeps({ afterPaste: claudeScreen({ status, box: "[Pasted text #1]" }), afterEnter: claudeScreen({ status }) });
    expect(await deliverTyped(f.deps, ARGS)).toMatchObject({ written: true, result: { stage: "backend_acknowledged", message: QUEUED_MESSAGE } });
    expect(f.term.writes).toHaveLength(2);
  });

  test("busy, but the text stays in the input box after Enter: sent with a reason, not resent", async () => {
    const status = "✻ Cogitating… (4s · esc to interrupt)";
    const f = fakeDeps({ screen: claudeScreen({ status }), afterPaste: claudeScreen({ status, box: "[Pasted text #1]" }), deliver: false });
    expect(await deliverTyped(f.deps, ARGS)).toMatchObject({ written: true, result: { stage: "sent", message: expect.stringContaining("stayed in the input box") } });
    expect(f.term.writes).toHaveLength(2);
    expect(f.progress).toEqual([]);
  });

  test("bad text (input-mode prefix, empty) is refused before attaching", async () => {
    const f = fakeDeps();
    expect(await deliverTyped(f.deps, { ...ARGS, text: "/clear" })).toMatchObject({ written: false, code: "bad_text" });
    expect(f.term.opens).toEqual([]);
  });

  test("written but not confirmed: resolves sent with a reason; exactly one paste and one Enter, never more", async () => {
    const f = fakeDeps({ deliver: false });
    const out = await deliverTyped(f.deps, ARGS);
    expect(out).toMatchObject({ written: true, result: { stage: "sent", message: expect.stringContaining("not confirmed") } });
    await new Promise((r) => setTimeout(r, 450));
    expect(f.term.writes).toHaveLength(2);
    expect(f.progress).toEqual(["sent"]);
  });

  test("paste not shown in the input box: Enter is not pressed; paste ack missing: Enter not pressed either", async () => {
    const hidden = fakeDeps({ afterPaste: null });
    expect(await deliverTyped(hidden.deps, ARGS)).toMatchObject({ written: true, result: { stage: "sent", message: expect.stringContaining("Enter not pressed") } });
    expect(hidden.term.writes).toHaveLength(1);
    const noAck = fakeDeps({ ack: "none" });
    expect(await deliverTyped(noAck.deps, ARGS)).toMatchObject({ written: true, result: { stage: "sent", message: expect.stringContaining("Enter not pressed") } });
    expect(noAck.term.writes).toHaveLength(1);
  });

  test("an identical earlier typed prompt does not confirm this one (baseline)", async () => {
    const f = fakeDeps({ deliver: false });
    f.term.transcript += "<user_message>\nReport status.\nThen stop.\n</user_message>\n<assistant_response>\nold\n</assistant_response>\n";
    const out = await deliverTyped(f.deps, ARGS);
    expect(out).toMatchObject({ written: true, result: { stage: "sent" } });
    expect(f.replies).toEqual([]);
  });
});

// --- the adapter route through the fake host (real vendored stream client) ---------------------------------------

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

const ALPHA = "ws:/Users/me/dev/alpha";
const ref = (taskId: string, sessionId: string): SessionRef => ({ backendId: "traycer", hostId: HOST, projectId: ALPHA, taskId, sessionId });
const progressOf = (events: AgentEvent[], requestId: string) => events.flatMap((e) => (e.type === "command_progress" && e.requestId === requestId ? [e.stage] : []));
const writesOf = (harness: Harness) => harness.host.subs.filter((s) => s.method === "terminal.subscribe").flatMap((s) => s.clientFrames).filter((f) => f.kind === "write");

interface HostTerminal {
  screen: string;
  attach?: "ok" | "fatal";
  confirm?: boolean;
}

/** A host with terminal.list, terminal.subscribe (serialized snapshot, write acks) and a transcript that shows typed text. */
function typingWorld(terminals: Record<string, HostTerminal>): { world: World; transcripts: Map<string, string>; host: { onSubscribe(sub: FakeStreamSub): void; onClientFrame(sub: FakeStreamSub, frame: Record<string, unknown>): void } } {
  const world = standardWorld();
  world.tuis.push({ epicId: "e1", tuiAgentId: "t2", title: "Codex terminal", harnessId: "codex", sessionState: "running" });
  const transcripts = new Map<string, string>();
  const info = (id: string) => ({
    sessionId: id,
    scope: { kind: "epic", epicId: "e1" },
    sessionKind: "terminal-agent",
    cwd: "/w",
    currentCwd: "/w",
    shellCommand: "claude",
    shellArgs: [],
    cols: 100,
    rows: 30,
    status: "running",
    exitCode: null,
    exitReason: null,
    createdAt: 1,
    title: null,
    activeProcessName: null,
    lifecycleOwner: "manager",
  });
  world.overrides["terminal.list"] = () => ({ result: { sessions: Object.keys(terminals).map(info), homeCwd: "/home" } });
  world.overrides["agent.getTranscript"] = (p) => ({ result: { transcript: transcripts.get(String(p.agentId)) ?? "" } });
  world.overrides["agent.sendMessage"] = (p) => {
    const receiver = String(p.receiverAgentId);
    setTimeout(() => transcripts.set(receiver, `${transcripts.get(receiver) ?? ""}<user_message>\n<task-notification>\n<event>[traycer:agent-message] from X\n${String(p.prompt)}\n</event>\n</task-notification>\n</user_message>\n<assistant_response>\nvia a2a\n</assistant_response>\n`), 20);
    return { result: { responseId: null } };
  };
  const pasted = new Map<string, string>();
  const host = {
    onSubscribe(sub: FakeStreamSub) {
      if (sub.method !== "terminal.subscribe") return;
      const p = sub.params as { sessionId: string };
      const t = terminals[p.sessionId];
      if (t === undefined || t.attach === "fatal") {
        sub.fatal("NOT_FOUND");
        return;
      }
      const { lifecycleOwner: _drop, ...session } = info(p.sessionId);
      sub.send({ kind: "snapshot", sessionId: p.sessionId, session, scrollback: t.screen, ackCreditSupported: true });
    },
    onClientFrame(sub: FakeStreamSub, frame: Record<string, unknown>) {
      if (sub.method !== "terminal.subscribe" || frame.kind !== "write") return;
      const id = String(frame.sessionId);
      sub.send({ kind: "actionAck", sessionId: id, clientActionId: frame.clientActionId, action: "write", status: "accepted", reason: null, code: null });
      const data = String(frame.data);
      if (data !== "\r") {
        pasted.set(id, data.replace("\x1b[200~", "").replace("\x1b[201~", ""));
        const harness = id === "t2" ? "codex" : "claude";
        const shown = harness === "codex" ? "\x1b[H› [Pasted]\r\n\r\n  ⏎ send" : `\x1b[H${claudeScreen({ box: "[Pasted text #1]" })}`;
        sub.send({ kind: "data", sessionId: id, chunk: shown });
      } else {
        // The submitted text leaves the input box (a queued one is listed above it).
        sub.send({ kind: "data", sessionId: id, chunk: `\x1b[2J\x1b[H${terminals[id]?.screen ?? ""}` });
      }
      if (data === "\r" && terminals[id]?.confirm !== false) {
        transcripts.set(id, `${transcripts.get(id) ?? ""}<user_message>\n${pasted.get(id) ?? ""}\n</user_message>\n<assistant_response>\ntyped answer\n</assistant_response>\n`);
      }
    },
  };
  return { world, transcripts, host };
}

const CODEX_IDLE = `\x1b[H• Ran tests\r\n\r\n› ${GRAY}Ask Codex to do anything${RESET}\r\n\r\n  ⏎ send   ⌃C quit\x1b[?2004h`;
const CODEX_BUSY = "\x1b[H• Working (5s • esc to interrupt)\r\n\r\n› \r\n\r\n  ⏎ send\x1b[?2004h";
const FAST = { a2aPollMs: 10, ackTimeoutMs: 1_000, turnTimeoutMs: 2_000, typeQuietMs: 20 };

describe("adapter: terminal prompts typed (tuiRoute type, default)", () => {
  test("Claude idle: typed as a cache viewer at the listed size; user message confirmed; reply in details; no a2a", async () => {
    const tw = typingWorld({ t1: { screen: claudeScreen() } });
    h = makeHarness({ world: tw.world, host: tw.host, config: { ...FAST, a2aSelfSend: true } });
    await h.adapter.connect();
    await h.adapter.listSessions("e1");
    expect(h.adapter.promptCapability(ref("e1", "t1"))).toEqual({ acceptsPrompt: true, via: "terminal.write", fallbackVia: "agent.sendMessage", senderAgentId: "t1" });
    const r = await h.adapter.sendPrompt(ref("e1", "t1"), "Report status.", "req-1");
    expect(r.stage).toBe("backend_acknowledged");
    const sub = h.host.subs.find((s) => s.method === "terminal.subscribe");
    expect(sub?.params).toEqual({ sessionId: "t1", cols: 100, rows: 30, viewer: "cache" });
    expect(writesOf(h).map((f) => f.data)).toEqual(["\x1b[200~Report status.\x1b[201~", "\r"]);
    expect(h.host.requests.filter((q) => q.method === "agent.sendMessage")).toEqual([]);
    await until(() => progressOf(h!.events, "req-1").includes("completed"), 2_000, "completed");
    expect(progressOf(h.events, "req-1")).toEqual(["accepted_locally", "sent", "backend_acknowledged", "completed"]);
    const upsert = [...h.events].reverse().find((e) => e.type === "session_upserted" && e.session.ref.sessionId === "t1");
    expect(upsert?.type === "session_upserted" ? (upsert.session as { details?: { reply?: { text: string } } }).details?.reply?.text : null).toBe("typed answer");
    await until(() => h!.host.live("terminal.subscribe").length === 0, 1_000, "terminal stream closed");
  });

  test("Claude busy: typed and queued behind the running turn; no a2a", async () => {
    const tw = typingWorld({ t1: { screen: claudeScreen({ status: "✻ Cogitating… (3s · esc to interrupt)" }) } });
    h = makeHarness({ world: tw.world, host: tw.host, config: { ...FAST, a2aSelfSend: true } });
    await h.adapter.connect();
    await h.adapter.listSessions("e1");
    const r = await h.adapter.sendPrompt(ref("e1", "t1"), "Report status.", "req-b");
    expect(r).toMatchObject({ stage: "backend_acknowledged", message: QUEUED_MESSAGE });
    expect(writesOf(h).map((f) => f.data)).toEqual(["\x1b[200~Report status.\x1b[201~", "\r"]);
    expect(h.host.requests.filter((q) => q.method === "agent.sendMessage")).toEqual([]);
  });

  test("Claude draft in the input box: nothing typed, falls back to Traycer a2a (self-send) exactly once", async () => {
    const tw = typingWorld({ t1: { screen: claudeScreen({ box: "operator draft" }) } });
    h = makeHarness({ world: tw.world, host: tw.host, config: { ...FAST, a2aSelfSend: true } });
    await h.adapter.connect();
    await h.adapter.listSessions("e1");
    const r = await h.adapter.sendPrompt(ref("e1", "t1"), "Report status.", "req-b");
    expect(r.stage).toBe("backend_acknowledged");
    expect(writesOf(h)).toEqual([]);
    const sends = h.host.requests.filter((q) => q.method === "agent.sendMessage");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.params).toMatchObject({ senderAgentId: "t1", receiverAgentId: "t1", prompt: "Report status." });
    const notes = h.events.flatMap((e) => (e.type === "command_progress" && e.requestId === "req-b" && e.message ? [e.message] : []));
    expect(notes.some((m) => /not typed .*already holds text.*a2a/.test(m))).toBe(true);
  });

  test("Claude attach refused (no terminal stream): falls back to a2a; no sender and no self-send: failed, nothing sent", async () => {
    const tw = typingWorld({ t1: { screen: claudeScreen(), attach: "fatal" } });
    h = makeHarness({ world: tw.world, host: tw.host, config: { ...FAST, a2aSelfSend: true } });
    await h.adapter.connect();
    await h.adapter.listSessions("e1");
    expect((await h.adapter.sendPrompt(ref("e1", "t1"), "Report status.", "req-f")).stage).toBe("backend_acknowledged");
    expect(h.host.requests.filter((q) => q.method === "agent.sendMessage")).toHaveLength(1);
    await h.dispose();

    const tw2 = typingWorld({ t1: { screen: claudeScreen({ box: "operator draft" }) } });
    h = makeHarness({ world: tw2.world, host: tw2.host, config: FAST });
    await h.adapter.connect();
    await h.adapter.listSessions("e1");
    expect(h.adapter.promptCapability(ref("e1", "t1"))).toEqual({ acceptsPrompt: true, via: "terminal.write" });
    const r = await h.adapter.sendPrompt(ref("e1", "t1"), "Report status.", "req-n");
    expect(r).toMatchObject({ stage: "failed", message: expect.stringContaining("nothing typed") });
    expect(h.host.requests.filter((q) => q.method === "agent.sendMessage")).toEqual([]);
    expect(writesOf(h)).toEqual([]);
  });

  test("Codex: promptable by typing; idle -> typed; busy -> typed and queued; draft -> failed with the reason (no a2a for Codex)", async () => {
    const tw = typingWorld({ t2: { screen: CODEX_IDLE } });
    h = makeHarness({ world: tw.world, host: tw.host, config: { ...FAST, a2aSelfSend: true } });
    await h.adapter.connect();
    await h.adapter.listSessions("e1");
    expect(h.adapter.promptCapability(ref("e1", "t2"))).toEqual({ acceptsPrompt: true, via: "terminal.write" });
    expect((await h.adapter.sendPrompt(ref("e1", "t2"), "Run the tests.", "req-c")).stage).toBe("backend_acknowledged");
    expect(writesOf(h).map((f) => f.data)).toEqual(["\x1b[200~Run the tests.\x1b[201~", "\r"]);
    await h.dispose();

    const busy = typingWorld({ t2: { screen: CODEX_BUSY } });
    h = makeHarness({ world: busy.world, host: busy.host, config: { ...FAST, a2aSelfSend: true } });
    await h.adapter.connect();
    await h.adapter.listSessions("e1");
    expect(await h.adapter.sendPrompt(ref("e1", "t2"), "Run the tests.", "req-cb")).toMatchObject({ stage: "backend_acknowledged", message: QUEUED_MESSAGE });
    expect(writesOf(h).map((f) => f.data)).toEqual(["\x1b[200~Run the tests.\x1b[201~", "\r"]);
    await h.dispose();

    const draft = typingWorld({ t2: { screen: "\x1b[H• Ran tests\r\n\r\n› my own draft\r\n\r\n  ⏎ send\x1b[?2004h" } });
    h = makeHarness({ world: draft.world, host: draft.host, config: { ...FAST, a2aSelfSend: true } });
    await h.adapter.connect();
    await h.adapter.listSessions("e1");
    const r = await h.adapter.sendPrompt(ref("e1", "t2"), "Run the tests.", "req-cd");
    expect(r).toMatchObject({ stage: "failed", message: expect.stringMatching(/^Codex terminal: .*already holds text.*nothing typed/) });
    expect(h.host.requests.filter((q) => q.method === "agent.sendMessage")).toEqual([]);
    expect(writesOf(h)).toEqual([]);
  });

  test("typed but never confirmed: sent with a reason, no a2a fallback (no double send); a retry of the requestId is not re-sent", async () => {
    const tw = typingWorld({ t1: { screen: claudeScreen(), confirm: false } });
    h = makeHarness({ world: tw.world, host: tw.host, config: { ...FAST, a2aSelfSend: true, typeConfirmTimeoutMs: 200 } });
    await h.adapter.connect();
    await h.adapter.listSessions("e1");
    const r = await h.adapter.sendPrompt(ref("e1", "t1"), "Report status.", "req-u");
    expect(r).toMatchObject({ stage: "sent", message: expect.stringContaining("not confirmed") });
    const again = await h.adapter.sendPrompt(ref("e1", "t1"), "Report status.", "req-u");
    expect(again).toEqual(r);
    expect(writesOf(h)).toHaveLength(2);
    expect(h.host.requests.filter((q) => q.method === "agent.sendMessage")).toEqual([]);
  });

  test("tuiRoute a2a: Claude via agent.sendMessage, never terminal.subscribe; Codex not promptable", async () => {
    const tw = typingWorld({ t1: { screen: claudeScreen() }, t2: { screen: CODEX_IDLE } });
    h = makeHarness({ world: tw.world, host: tw.host, config: { ...FAST, a2aSelfSend: true, tuiRoute: "a2a" } });
    await h.adapter.connect();
    await h.adapter.listSessions("e1");
    expect(h.adapter.promptCapability(ref("e1", "t2"))?.acceptsPrompt).toBe(false);
    expect((await h.adapter.sendPrompt(ref("e1", "t1"), "Report status.", "req-a")).stage).toBe("backend_acknowledged");
    expect(h.host.subs.filter((s) => s.method === "terminal.subscribe")).toEqual([]);
    expect((await h.adapter.sendPrompt(ref("e1", "t2"), "x", "req-a2")).stage).toBe("unsupported");
  });

  test("host whose terminal.subscribe is older than 1.6 (no cache viewer): not typed; Claude falls back, later prompts go a2a directly", async () => {
    const tw = typingWorld({ t1: { screen: claudeScreen() } });
    h = makeHarness({
      world: tw.world,
      host: { ...tw.host, streamManifest: (m) => ({ ...m, "terminal.subscribe": { major: 1, minor: 5 } }) },
      config: { ...FAST, a2aSelfSend: true },
    });
    await h.adapter.connect();
    await h.adapter.listSessions("e1");
    expect((await h.adapter.sendPrompt(ref("e1", "t1"), "Report status.", "req-o")).stage).toBe("backend_acknowledged");
    expect(writesOf(h)).toEqual([]);
    expect(h.adapter.promptCapability(ref("e1", "t1"))?.via).toBe("agent.sendMessage");
  });
});
