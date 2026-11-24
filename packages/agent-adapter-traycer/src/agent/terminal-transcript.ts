import type { SessionDetails } from "@fm1/agent-core";
import type { MdBlock } from "@fm1/agent-core";
import { asciiFold, cut, messageBlocks, plainText, redactSecrets } from "./chat-details";

/**
 * Details of terminal (TUI) sessions from `agent.getTranscript {epicId, agentId}` (operator report 2026-11-18: a
 * terminal session showed no messages, because details came only from GUI chat streams). Verified read-only on a real
 * terminal session: the host returns the whole conversation as `<user_message>...</user_message>` /
 * `<assistant_response>...</assistant_response>` blocks, plus `<summary>`, `<event>`, `<measured>` and (a2a)
 * `<task-notification>` tags. No timestamps.
 *
 * Cost rules: only the session selected on the console is fetched (on selection, every REFRESH_MS while selected, and
 * when its state changes); never in bulk. Only the last TAIL_CHARS of a transcript are parsed.
 */
export const TERMINAL_REFRESH_MS = 15_000;
/** A state change asks for a fetch at most this often (a burst of activity frames is one fetch). */
export const TERMINAL_POKE_MIN_MS = 2_000;
export const TAIL_CHARS = 64_000;
export const LAST_MESSAGE_MAX = 600;
export const LAST_PROMPT_MAX = 200;
/** A terminal agent's suggested next steps (docs/ui-v3.md section 11): at most this many, each at most SUGGESTION_ITEM_MAX. */
export const SUGGESTIONS_MAX = 3;
export const SUGGESTION_ITEM_MAX = 120;

/**
 * A "next steps" heading line (case-insensitive), after markdown markers (`#`, `**`, `__`, `*`) are stripped:
 * `Next steps`, `Suggested next steps`, `Suggested next`, `Recommended next steps:`, `Possible next actions`, `Next steps
 * (optional)`. A bare `Next:` is not one (too common in prose).
 */
const NEXT_HEADING = /^(?:(?:suggested|recommended|possible|proposed|potential|optional)\s+next(?:\s+(?:steps?|actions?|prompts?|moves?|tasks?))?|next\s+(?:steps?|actions?|moves?))(?:\s*\([^)]*\))?\s*:?$/i;
/** A list item: `- x`, `* x`, `+ x`, `1. x`, `1) x` (optionally a `[ ]` checkbox). */
const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d{1,2}[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;
/** A fenced-code delimiter line (``` or ~~~, optionally indented, optionally with an info string). */
const FENCE = /^\s*(`{3,}|~{3,})/;

function headingText(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(\*\*|__)(.*)\1(:?)$/, "$2$3")
    .replace(/^(\*\*|__)(.*?):?(\*\*|__)\s*:?$/, "$2")
    .replace(/^[*_](.*)[*_]$/, "$1")
    .trim();
}

/**
 * The suggested next steps of one assistant answer: the list under its LAST "next steps" heading (up to
 * SUGGESTIONS_MAX items; an item's indented continuation lines join it; blank lines between items are allowed; the list
 * ends at the first other line). Each item: markdown reduced, secrets redacted, ASCII-folded, cut to
 * SUGGESTION_ITEM_MAX. No heading or no items: none.
 */
export function parseNextSteps(answer: string): string[] {
  const lines = answer.replace(/\r\n?/g, "\n").split("\n");
  // Lines inside fenced code (``` or ~~~) are code, never a heading or a list item: a README or script shown in the
  // answer may carry its own "Next steps" list.
  const inFence: boolean[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const f = FENCE.exec(line);
    if (fence === null && f) {
      fence = f[1]?.[0] ?? "`";
      inFence.push(true);
    } else if (fence !== null) {
      inFence.push(true);
      if (f && f[1]?.[0] === fence) fence = null;
    } else inFence.push(false);
  }
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!inFence[i] && NEXT_HEADING.test(headingText(lines[i] ?? ""))) {
      at = i;
      break;
    }
  }
  if (at < 0) return [];
  const items: string[] = [];
  let started = false;
  let indent = 0;
  let nested = false;
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (inFence[i]) {
      // Code under an item (indented) is dropped; a fence at the margin ends the list.
      if (!started || !/^\s{2,}/.test(line)) break;
      while (i + 1 < lines.length && inFence[i + 1]) i++;
      continue;
    }
    if (line.trim() === "") continue;
    const m = LIST_ITEM.exec(line);
    const lead = line.length - line.trimStart().length;
    if (m && (!started || lead <= indent)) {
      if (!started) indent = lead;
      items.push(m[1] ?? "");
      started = true;
      nested = false;
      continue;
    }
    if (started && lead > indent) {
      // A nested sub-item (and its continuation lines) is detail of its parent, not a suggestion of its own.
      if (m) nested = true;
      else if (!nested && items.length > 0) items[items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    break;
  }
  return items
    .map((x) => clean(x, SUGGESTION_ITEM_MAX))
    .filter((x) => x !== "")
    .slice(0, SUGGESTIONS_MAX);
}

/** The a2a monitor's framing lines inside a task notification (`[traycer:agent-message] ...`). */
const A2A_LINE = /^\s*\[traycer:agent-message\]/;

function lastBlock(text: string, tag: string): { body: string; at: number } | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const end = text.lastIndexOf(close);
  if (end < 0) return null;
  const start = text.lastIndexOf(open, end);
  if (start < 0) return null; // the tail cut the block's start off
  return { body: text.slice(start + open.length, end), at: start };
}

/** A user message as the operator would read it: an a2a notification reduced to the prompt it carries. */
function promptText(body: string): string {
  const event = /<event>([\s\S]*?)<\/event>/.exec(body);
  if (event !== null && /<task-notification>/.test(body)) {
    return (event[1] ?? "")
      .split("\n")
      .filter((line) => !A2A_LINE.test(line))
      .join("\n");
  }
  // Other tags inside a user message (summaries, measured blocks) are not what the user typed.
  // A multi-line prompt typed with bracketed paste arrives wrapped in `<pasted_content id="...">` (observed live).
  return body
    .replace(/<\/?pasted_content\b[^>]*>/g, " ")
    .replace(/<(summary|measured|event|task-id)>[\s\S]*?<\/\1>/g, " ")
    .replace(/<\/?[a-z-]+>/g, " ");
}

const clean = (text: string, n: number): string => cut(asciiFold(redactSecrets(plainText(text))), n);

/**
 * Transcript text as it may leave the adapter (device, companion UI, logs): markdown reduced, secrets redacted, ASCII,
 * at most `n` characters. Used for parsed details and for the a2a reply (`details.reply`).
 */
export const cleanTranscriptText = clean;

export interface ParsedTranscript {
  /** The last assistant answer, redacted, ASCII, <= LAST_MESSAGE_MAX. */
  readonly lastMessage?: string;
  /** The same answer's Markdown structure (docs/ui-v3.md section 13), from at most 2000 redacted, ASCII characters. */
  readonly lastBlocks?: MdBlock[];
  /** The last user message (or a2a prompt) for context, redacted, ASCII, <= LAST_PROMPT_MAX. */
  readonly lastPrompt?: string;
  /** The last answer's "next steps" list (parseNextSteps); absent when none, or when a newer user message followed it. */
  readonly suggestions?: string[];
}

/** Parses the tail of a transcript: the last `<assistant_response>` and the last `<user_message>`. */
export function parseTranscript(transcript: string, tailChars: number = TAIL_CHARS): ParsedTranscript {
  const tail = transcript.length > tailChars ? transcript.slice(-tailChars) : transcript;
  const out: { lastMessage?: string; lastBlocks?: MdBlock[]; lastPrompt?: string; suggestions?: string[] } = {};
  const answer = lastBlock(tail, "assistant_response");
  const user = lastBlock(tail, "user_message");
  if (answer !== null) {
    const body = answer.body.replace(/^\s*\[assistant row[^\]]*\]\s*/, "");
    const text = clean(body, LAST_MESSAGE_MAX);
    if (text) {
      out.lastMessage = text;
      const blocks = messageBlocks(body);
      if (blocks.length > 0) out.lastBlocks = blocks;
    }
    // Suggestions belong to the newest answer only: a user message after it means the conversation moved on.
    const steps = user !== null && user.at > answer.at ? [] : parseNextSteps(body);
    if (steps.length > 0) out.suggestions = steps;
  }
  if (user !== null) {
    const text = clean(promptText(user.body), LAST_PROMPT_MAX);
    if (text) out.lastPrompt = text;
  }
  return out;
}

export interface TerminalDetailsDeps {
  /** `agent.getTranscript` text; null when unreadable. Throws on transport errors (kept quiet, retried later). */
  transcript(epicId: string, agentId: string): Promise<string | null>;
  /** The parsed details for one session (`at`: when the newest answer was first seen). */
  apply(epicId: string, agentId: string, details: SessionDetails, at: number): void;
  /** The agent record's update time, the best guess of when a first-seen answer was written. */
  updatedAt(epicId: string, agentId: string): number | undefined;
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** Size of each fetched transcript (diagnostics; never its content). */
  onFetched?(epicId: string, agentId: string, chars: number): void;
}

interface Watch {
  readonly epicId: string;
  readonly agentId: string;
  timer: unknown;
  inFlight: boolean;
  again: boolean;
  lastPokeAt: number;
}

/** The selected terminal session's transcript: fetched on watch, every TERMINAL_REFRESH_MS, and on `poke`. */
export class TerminalDetails {
  private watch: Watch | null = null;
  /** Last answer per session and when it was first seen, so an unchanged answer keeps its time. */
  private readonly seen = new Map<string, { message: string; at: number }>();

  constructor(
    private readonly deps: TerminalDetailsDeps,
    private readonly refreshMs: number = TERMINAL_REFRESH_MS,
  ) {}

  get watching(): string | null {
    return this.watch === null ? null : `${this.watch.epicId}/${this.watch.agentId}`;
  }

  /** Starts watching one session (stops any other). Returns the release. */
  start(epicId: string, agentId: string): () => void {
    this.stop();
    const w: Watch = { epicId, agentId, timer: null, inFlight: false, again: false, lastPokeAt: Number.NEGATIVE_INFINITY };
    this.watch = w;
    w.timer = this.deps.setInterval(() => void this.fetch(w), this.refreshMs);
    void this.fetch(w);
    return () => {
      if (this.watch === w) this.stop();
    };
  }

  stop(): void {
    const w = this.watch;
    this.watch = null;
    if (w !== null && w.timer !== null) this.deps.clearInterval(w.timer);
  }

  /** The watched session's state changed: fetch again (at most once per TERMINAL_POKE_MIN_MS). */
  poke(epicId: string, agentId: string): void {
    const w = this.watch;
    if (w === null || w.epicId !== epicId || w.agentId !== agentId) return;
    const now = this.deps.now();
    if (now - w.lastPokeAt < TERMINAL_POKE_MIN_MS) return;
    w.lastPokeAt = now;
    void this.fetch(w);
  }

  forget(epicId: string, agentId: string): void {
    this.seen.delete(`${epicId}/${agentId}`);
  }

  private async fetch(w: Watch): Promise<void> {
    if (w.inFlight) {
      w.again = true;
      return;
    }
    w.inFlight = true;
    try {
      const text = await this.deps.transcript(w.epicId, w.agentId);
      if (this.watch !== w || text === null) return;
      this.deps.onFetched?.(w.epicId, w.agentId, text.length);
      const parsed = parseTranscript(text);
      const key = `${w.epicId}/${w.agentId}`;
      const details: SessionDetails = {};
      let at = this.seen.get(key)?.at ?? 0;
      if (parsed.lastMessage !== undefined) {
        const prior = this.seen.get(key);
        at = prior !== undefined && prior.message === parsed.lastMessage ? prior.at : prior === undefined ? (this.deps.updatedAt(w.epicId, w.agentId) ?? this.deps.now()) : this.deps.now();
        this.seen.set(key, { message: parsed.lastMessage, at });
        details.lastMessage = parsed.lastMessage;
        if (parsed.lastBlocks !== undefined) details.lastBlocks = parsed.lastBlocks;
        details.lastMessageAt = at;
      }
      if (parsed.lastPrompt !== undefined) details.lastPrompt = parsed.lastPrompt;
      if (parsed.suggestions !== undefined) details.suggestions = parsed.suggestions;
      this.deps.apply(w.epicId, w.agentId, details, at);
    } catch {
      // Unreadable now (host busy, link down): the next refresh tries again; the console keeps what it has.
    } finally {
      w.inFlight = false;
      if (w.again && this.watch === w) {
        w.again = false;
        void this.fetch(w);
      }
    }
  }
}
