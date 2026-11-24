import { randomUUID } from "node:crypto";
import type { CommandResult, DeliveryStage } from "@fm1/agent-core";
import type { A2aReply } from "./a2a-delivery";
import { promptNeedles } from "./a2a-delivery";
import { QUEUED_MESSAGE } from "./prompt-delivery";
import { TerminalScreen } from "./terminal-screen";
import { classifyTuiScreen, type TuiScreenState, type TuiScreenVerdict, type TypingHarness } from "./tui-screen-state";

/**
 * Console prompts TYPED into a terminal (TUI) agent's Traycer terminal (operator decision 2026-11-19): the prompt
 * arrives as a normal user message, for Claude Code and Codex terminals alike. Primary route for terminal sessions;
 * the adapter falls back to Traycer a2a (Claude only) when nothing was written.
 *
 * Steps (each one before the write can refuse; nothing is typed then):
 *   1. `terminal.list` of the task: the agent's terminal session (`sessionId` == agent id, `sessionKind:
 *      "terminal-agent"`, `status: "running"`) and its current size.
 *   2. `terminal.subscribe` as a `cache` viewer (`@1.6+`: holds no size, no reap claim) opened AT that size, so even a
 *      host that ignored `viewer` would not shrink the operator's view. A connection that negotiated < 1.6 is closed
 *      before any write.
 *   3. The snapshot (an xterm-serialized screen) plus live redraws feed a headless screen (terminal-screen.ts); after
 *      the output has been quiet for `quietMs`, the screen must read `idle` (tui-screen-state.ts), or `busy`: an empty
 *      input box under a running turn. Claude Code and Codex take a prompt submitted during a turn as a queued (or
 *      steering) user message, so a busy terminal is typed into too and the prompt resolves "queued".
 *   4. One `write` frame with the text in bracketed paste (`ESC[200~ ... ESC[201~`; the TUI must have turned on mode
 *      2004 for multi-line text), its `actionAck` awaited; then, after `enterDelayMs`, one `write` of `\r`.
 *   5. Confirmation from `agent.getTranscript`: a NEW `<user_message>` holding the prompt's first line (an a2a
 *      `<task-notification>` does not count). Then `backend_acknowledged`, and `completed` when an assistant answer
 *      follows (reply captured). A prompt submitted during a turn resolves `backend_acknowledged` (QUEUED_MESSAGE) as
 *      soon as the input box has taken it, and `completed` when its answer shows up.
 *
 * After the paste frame went out, nothing is ever retried or re-routed: an unconfirmed prompt resolves `sent` with a
 * reason ("typed, not confirmed"), because a fallback could deliver it twice.
 */

export interface TerminalInfo {
  readonly sessionId: string;
  readonly cols: number;
  readonly rows: number;
  readonly status: string;
  readonly sessionKind: string;
}

export interface TerminalStreamEvents {
  onFrame(envelope: Record<string, unknown>, binary: Uint8Array | null): void;
  onClosed(reason: string): void;
}

export interface TerminalStreamHandle {
  send(frame: Record<string, unknown>): void;
  close(): void;
  /** The negotiated `terminal.subscribe` version, or null while unknown. */
  negotiated(): { readonly major: number; readonly minor: number } | null;
}

export interface TypingDeps {
  /** `terminal.list` row for this agent's terminal, or null when the task lists none for it. Throws when unreadable. */
  terminal(epicId: string, agentId: string): Promise<TerminalInfo | null>;
  open(sessionId: string, size: { readonly cols: number; readonly rows: number }, events: TerminalStreamEvents): TerminalStreamHandle;
  transcript(epicId: string, agentId: string): Promise<string | null>;
  progress(requestId: string, stage: DeliveryStage, message?: string): void;
  onReply(reply: A2aReply): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  active(): boolean;
  newId?(): string;
  /** Optional trace of each step (timings, screen states; never screen text). */
  trace?(event: TypingTraceEvent): void;
}

export interface TypingTraceEvent {
  readonly step: string;
  readonly at: number;
  readonly detail?: Record<string, unknown>;
}

export interface TypingArgs {
  readonly requestId: string;
  readonly epicId: string;
  readonly agentId: string;
  readonly harness: TypingHarness;
  readonly text: string;
  /** Wait for the snapshot after attaching. */
  readonly attachTimeoutMs: number;
  /** The screen must be quiet (no output) this long before it is read. */
  readonly quietMs: number;
  /** ... but never wait longer than this for quiet: a screen that keeps redrawing (spinner) is classified as it is. */
  readonly settleMaxMs: number;
  readonly writeAckTimeoutMs: number;
  /** Pause between the paste and the Enter key (TUIs process a paste asynchronously). */
  readonly enterDelayMs: number;
  /** How long the transcript is watched for the typed user message before resolving `sent` (unconfirmed). */
  readonly confirmTimeoutMs: number;
  readonly turnTimeoutMs: number;
  readonly pollMs: number;
}

export const TYPING_DEFAULTS = {
  attachTimeoutMs: 5_000,
  quietMs: 300,
  settleMaxMs: 2_000,
  writeAckTimeoutMs: 3_000,
  enterDelayMs: 150,
  confirmTimeoutMs: 15_000,
} as const;

export type NotWrittenCode =
  | "bad_text"
  | "no_terminal"
  | "terminal_exited"
  | "attach_failed"
  | "attach_timeout"
  | "old_host"
  | "not_idle"
  | "write_rejected"
  | "inactive"
  | "internal_error";

export type TypingOutcome =
  | { readonly written: false; readonly code: NotWrittenCode; readonly reason: string; readonly screen?: TuiScreenState }
  | { readonly written: true; readonly result: CommandResult };

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** First characters that switch a TUI input mode (Claude/Codex slash commands, Claude `!` bash and `#` memory, `?` help). */
const MODE_CHARS = /^[/!#?]/;

/**
 * The text as it will be typed: CR LF and CR become LF, TAB two spaces, every other control character (C0 except LF,
 * DEL, C1, ESC) removed, so the text can never close the bracketed paste or inject keys. Trailing whitespace dropped.
 * Returns null when nothing typeable is left, or when the text would start a TUI command mode.
 */
export function typeableText(text: string): { text: string } | { error: string } {
  const cleaned = text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/\s+$/u, "");
  const body = cleaned.replace(/^\s+/u, "");
  if (body.length === 0) return { error: "empty prompt after removing control characters" };
  if (MODE_CHARS.test(body)) return { error: `prompt starts with "${body[0]}", which switches the terminal agent's input mode; not typed` };
  return { text: body };
}

/** Where the (baseline+1)-th typed user message with our text is, and the first answer after it. */
export function locateUserMessage(transcript: string, needles: readonly string[], baseline: number): { delivered: boolean; reply: string | null } {
  const blocks = userMessages(transcript, needles);
  if (blocks.length <= baseline) return { delivered: false, reply: null };
  const end = blocks[baseline] as number;
  const m = /<assistant_response>\n?([\s\S]*?)<\/assistant_response>/.exec(transcript.slice(end));
  if (m === null) return { delivered: true, reply: null };
  return { delivered: true, reply: (m[1] ?? "").replace(/^\[assistant row[^\]]*\]\n?/, "").trim() };
}

/** End offsets of `<user_message>` blocks that contain a needle and are not an a2a task notification. */
export function userMessages(transcript: string, needles: readonly string[]): number[] {
  const out: number[] = [];
  const re = /<user_message>([\s\S]*?)<\/user_message>/g;
  for (let m = re.exec(transcript); m !== null; m = re.exec(transcript)) {
    const body = m[1] ?? "";
    if (/<task-notification>|\[traycer:agent-message\]/.test(body)) continue;
    if (needles.some((n) => body.includes(n))) out.push(m.index + m[0].length);
  }
  return out;
}

class AttachedTerminal {
  readonly screen: TerminalScreen;
  snapshot = false;
  exited = false;
  closed: string | null = null;
  lastOutputAt: number;
  private readonly acks = new Map<string, { status: string; reason: string | null; code: string | null }>();
  handle: TerminalStreamHandle | null = null;

  constructor(
    size: { cols: number; rows: number },
    private readonly now: () => number,
  ) {
    this.screen = new TerminalScreen(size.cols, size.rows);
    this.lastOutputAt = now();
  }

  readonly events: TerminalStreamEvents = {
    onFrame: (env, binary) => {
      // A frame the headless screen cannot take must not throw into the stream client: treat the attach as broken
      // (refused before a write; after one, the acks stop and the result stays "sent, unconfirmed").
      try {
        this.apply(env, binary);
      } catch (error) {
        this.closed ??= `screen error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    onClosed: (reason) => {
      this.closed ??= reason;
    },
  };

  private apply(env: Record<string, unknown>, binary: Uint8Array | null): void {
      const kind = env.kind;
      if (kind === "snapshot" || kind === "binarySnapshot") {
        const session = env.session as { cols?: unknown; rows?: unknown; status?: unknown } | undefined;
        const cols = typeof session?.cols === "number" ? session.cols : this.screen.size.cols;
        const rows = typeof session?.rows === "number" ? session.rows : this.screen.size.rows;
        this.screen.reset();
        this.screen.resize(cols, rows);
        if (typeof env.scrollback === "string") this.screen.write(env.scrollback);
        if (binary instanceof Uint8Array) this.screen.write(binary);
        if (session?.status === "exited") this.exited = true;
        this.snapshot = true;
        this.lastOutputAt = this.now();
      } else if (kind === "data" || kind === "binaryData") {
        if (typeof env.chunk === "string") this.screen.write(env.chunk);
        if (binary instanceof Uint8Array) this.screen.write(binary);
        this.lastOutputAt = this.now();
      } else if (kind === "resized") {
        // The grid changed size; the TUI redraws after SIGWINCH. Keep the content, the next redraw fixes it.
        if (typeof env.cols === "number" && typeof env.rows === "number") this.screen.resize(env.cols, env.rows);
        this.lastOutputAt = this.now();
      } else if (kind === "exit") {
        this.exited = true;
      } else if (kind === "actionAck" && typeof env.clientActionId === "string") {
        this.acks.set(env.clientActionId, {
          status: String(env.status),
          reason: typeof env.reason === "string" ? env.reason : null,
          code: typeof env.code === "string" ? env.code : null,
        });
      }
  }

  ack(id: string): { status: string; reason: string | null; code: string | null } | undefined {
    return this.acks.get(id);
  }

  verdict(harness: TypingHarness): TuiScreenVerdict {
    return classifyTuiScreen(this.screen.lines(), harness, this.screen.cells());
  }
}

/**
 * Types one prompt into a terminal agent. `written:false` means provably nothing reached the terminal (the caller may
 * fall back to another route); `written:true` carries the final CommandResult (never re-route it).
 */
export async function deliverTyped(deps: TypingDeps, args: TypingArgs): Promise<TypingOutcome> {
  const { requestId } = args;
  const t0 = deps.now();
  const trace = (step: string, detail?: Record<string, unknown>): void => deps.trace?.({ step, at: deps.now() - t0, ...(detail ? { detail } : {}) });
  const newId = deps.newId ?? randomUUID;
  const notWritten = (code: NotWrittenCode, reason: string, screen?: TuiScreenState): TypingOutcome => {
    trace("refused", { code, ...(screen ? { screen } : {}) });
    return { written: false, code, reason, ...(screen ? { screen } : {}) };
  };

  const typed = typeableText(args.text);
  if ("error" in typed) return notWritten("bad_text", typed.error);

  let info: TerminalInfo | null;
  try {
    info = await deps.terminal(args.epicId, args.agentId);
  } catch (error) {
    return notWritten("no_terminal", `terminal.list failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (info === null) return notWritten("no_terminal", "the task lists no terminal for this agent (its PTY is not running)");
  if (info.status !== "running") return notWritten("terminal_exited", `the agent's terminal is ${info.status}`);
  trace("listed", { cols: info.cols, rows: info.rows });

  // Baseline before anything is typed: an identical earlier prompt must not confirm this one.
  const needles = promptNeedles(typed.text);
  const read = (): Promise<string | null> => deps.transcript(args.epicId, args.agentId).catch(() => null);
  const before = (await read()) ?? (await read());
  let baseline: number | null = before === null ? null : userMessages(before, needles).length;
  trace("baseline", { readable: before !== null, chars: before?.length ?? 0, baseline });

  const term = new AttachedTerminal({ cols: info.cols, rows: info.rows }, deps.now);
  try {
    term.handle = deps.open(info.sessionId, { cols: info.cols, rows: info.rows }, term.events);
  } catch (error) {
    return notWritten("attach_failed", `terminal.subscribe failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const handle = term.handle;
  /** Set right before the first write frame: an error after it must never read as "nothing typed". */
  let wrote = false;
  /** Enter went in during a running turn: the TUI queues the prompt behind it. */
  let queued = false;
  let closedByUs = false;
  const close = (): void => {
    if (closedByUs) return;
    closedByUs = true;
    handle.close();
  };

  try {
    const attachStart = deps.now();
    while (!term.snapshot && term.closed === null && deps.now() - attachStart < args.attachTimeoutMs) await deps.sleep(20);
    if (term.closed !== null) return notWritten("attach_failed", `terminal.subscribe closed: ${term.closed}`);
    if (!term.snapshot) return notWritten("attach_timeout", `no terminal snapshot within ${args.attachTimeoutMs}ms`);
    const version = handle.negotiated();
    if (version === null) return notWritten("attach_failed", "terminal.subscribe version unknown after the snapshot; cache viewer not proven, not typed");
    if (version.major !== 1 || version.minor < 6) {
      return notWritten("old_host", `terminal.subscribe ${version.major}.${version.minor} has no cache viewer (needs 1.6+); not typed`);
    }
    trace("attached", { version: `${version.major}.${version.minor}`, bracketedPaste: term.screen.bracketedPaste });
    if (term.exited) return notWritten("terminal_exited", "the agent's terminal has exited");

    // Let in-flight redraws land, then read the screen.
    // A spinner seen at any point while waiting is enough: a running turn redraws continuously and never goes quiet.
    const settleStart = deps.now();
    let verdict = term.verdict(args.harness);
    while (verdict.state !== "busy" && deps.now() - term.lastOutputAt < args.quietMs && deps.now() - settleStart < args.settleMaxMs) {
      await deps.sleep(Math.min(50, args.quietMs));
      verdict = term.verdict(args.harness);
    }
    const quietFor = deps.now() - term.lastOutputAt;
    trace("screen", { state: verdict.state, reason: verdict.reason, quietFor });
    if (verdict.state !== "idle" && verdict.state !== "busy") return notWritten("not_idle", `terminal agent not at its input prompt: ${verdict.reason}`, verdict.state);
    // An idle TUI goes quiet (observed live: ~320 ms after attach); one that kept redrawing for settleMaxMs is most
    // likely running a turn whose spinner we did not recognize. Refuse rather than guess. A recognized running turn
    // never goes quiet, so `busy` skips this check.
    if (verdict.state === "idle" && quietFor < args.quietMs) {
      return notWritten("not_idle", `terminal output never went quiet within ${args.settleMaxMs}ms (likely a running turn); not typed`, "busy");
    }
    if (typed.text.includes("\n") && !term.screen.bracketedPaste) {
      return notWritten("not_idle", "multi-line prompt but the terminal agent has bracketed paste off; not typed", verdict.state);
    }
    if (!deps.active() || term.closed !== null) return notWritten("inactive", "adapter stopped or terminal stream closed before typing");

    // --- the write: from here on, never fall back ---
    const pasteId = newId();
    const data = term.screen.bracketedPaste ? `${PASTE_START}${typed.text}${PASTE_END}` : typed.text;
    wrote = true;
    handle.send({ kind: "write", hasBinaryPayload: false, sessionId: info.sessionId, clientActionId: pasteId, data });
    trace("paste_sent", { chars: typed.text.length, lines: typed.text.split("\n").length, bracketed: term.screen.bracketedPaste });
    const pasteAck = await waitAck(term, pasteId, args.writeAckTimeoutMs, deps);
    trace("paste_ack", { status: pasteAck?.status ?? "timeout", code: pasteAck?.code ?? null });
    if (pasteAck?.status === "rejected") {
      // The host refused the write: nothing reached the PTY.
      return notWritten("write_rejected", `host rejected the terminal write: ${[pasteAck.code, pasteAck.reason].filter(Boolean).join(": ") || "rejected"}`);
    }
    if (pasteAck === undefined) {
      return {
        written: true,
        result: { requestId, stage: "sent", message: `typed into the terminal, but the host did not ack the write within ${args.writeAckTimeoutMs}ms; Enter not pressed, not resent` },
      };
    }
    // Give the TUI time to take the paste (it shows it in the input box), then press Enter once.
    const pasteAt = deps.now();
    while (deps.now() - pasteAt < Math.max(args.enterDelayMs, 0) || (term.verdict(args.harness).state === "idle" && deps.now() - pasteAt < args.enterDelayMs + 1_000)) {
      await deps.sleep(25);
    }
    const shownVerdict = term.verdict(args.harness);
    const shown = shownVerdict.state;
    trace("paste_visible", { state: shown, turnRunning: shownVerdict.turnRunning === true, afterMs: deps.now() - pasteAt });
    if (shown !== "draft") {
      // The input box does not show our text. Enter now could submit something else (Claude Code offers a faint
      // suggested prompt in the empty box) or answer a dialog: do not press it.
      return {
        written: true,
        result: { requestId, stage: "sent", message: `typed into the terminal, but the input box did not show it (screen ${shown}); Enter not pressed, not resent` },
      };
    }
    // A running turn (seen before the paste or started since) takes the Enter as a queued prompt.
    queued = verdict.state === "busy" || shownVerdict.turnRunning === true;
    const enterId = newId();
    handle.send({ kind: "write", hasBinaryPayload: false, sessionId: info.sessionId, clientActionId: enterId, data: "\r" });
    const enterAck = await waitAck(term, enterId, args.writeAckTimeoutMs, deps);
    trace("enter_ack", { status: enterAck?.status ?? "timeout" });
    if (enterAck?.status !== "accepted") {
      const why = enterAck === undefined ? "no ack" : [enterAck.code, enterAck.reason].filter(Boolean).join(": ") || "rejected";
      return { written: true, result: { requestId, stage: "sent", message: `prompt typed but Enter was not confirmed by the host (${why}); not resent` } };
    }
    if (queued) {
      // The TUI took the prompt when the input box empties again (Claude lists it as queued above the box).
      const enterAt = deps.now();
      while (term.verdict(args.harness).state === "draft" && term.closed === null && deps.now() - enterAt < args.enterDelayMs + 1_000) await deps.sleep(25);
      const after = term.verdict(args.harness).state;
      trace("queued", { state: after, afterMs: deps.now() - enterAt });
      if (after === "draft") {
        return { written: true, result: { requestId, stage: "sent", message: "typed during a running turn and Enter pressed, but the text stayed in the input box; not resent" } };
      }
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (!wrote) return notWritten("internal_error", `typing route failed before writing: ${why}`);
    trace("error_after_write", {});
    return { written: true, result: { requestId, stage: "sent", message: `typing route failed after writing (${why}); not resent` } };
  } finally {
    close();
  }

  deps.progress(requestId, "sent");
  if (queued) deps.progress(requestId, "backend_acknowledged", QUEUED_MESSAGE);
  const started = deps.now();
  const result = await new Promise<CommandResult>((resolve) => {
    let settled = false;
    const settle = (r: CommandResult): void => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    void (async () => {
      let acked = queued;
      if (queued) settle({ requestId, stage: "backend_acknowledged", message: QUEUED_MESSAGE });
      let interval = args.pollMs;
      while (deps.now() - started < args.turnTimeoutMs && deps.active()) {
        if (!acked && deps.now() - started >= args.confirmTimeoutMs) {
          settle({ requestId, stage: "sent", message: "typed into the terminal; not confirmed in the transcript yet (not resent)" });
        }
        await deps.sleep(interval);
        if (acked) interval = Math.min(interval * 2, Math.max(args.pollMs, 5_000));
        const transcript = await read();
        if (transcript === null) continue;
        if (baseline === null) {
          // Conservative: the first readable transcript after the write becomes the baseline (stays `sent`).
          baseline = userMessages(transcript, needles).length;
          continue;
        }
        const turn = locateUserMessage(transcript, needles, baseline);
        if (turn.delivered && !acked) {
          acked = true;
          trace("confirmed", { afterMs: deps.now() - started });
          deps.progress(requestId, "backend_acknowledged");
          settle({ requestId, stage: "backend_acknowledged" });
        }
        if (turn.reply !== null) {
          trace("completed", { afterMs: deps.now() - started });
          deps.onReply({ requestId, text: turn.reply, at: deps.now() });
          deps.progress(requestId, "completed");
          return;
        }
      }
      settle({ requestId, stage: "sent", message: "typed into the terminal; not confirmed in the transcript (not resent)" });
    })();
  });
  return { written: true, result };
}

async function waitAck(
  term: AttachedTerminal,
  id: string,
  timeoutMs: number,
  deps: Pick<TypingDeps, "now" | "sleep">,
): Promise<{ status: string; reason: string | null; code: string | null } | undefined> {
  const start = deps.now();
  for (;;) {
    const ack = term.ack(id);
    if (ack !== undefined) return ack;
    if (term.closed !== null || deps.now() - start >= timeoutMs) return undefined;
    await deps.sleep(10);
  }
}
