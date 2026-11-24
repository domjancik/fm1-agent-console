// Every device-visible string the host produces (docs/ux-v2.md sections 1.3-1.5). Pure, ASCII only.
import { clipRow, layoutMarkdown, MARKDOWN_ROWS_MAX, type MdBlock, type TextSpan } from "./markdown";
import type { DeliveryStage, NormalizedState } from "./types";

/**
 * The backend name device copy uses when no adapter name is known (`<name> offline`, `Gone from <name>`). The console
 * passes the adapter's own name (types.ts `backendName`: `displayName`, else `id`), e.g. "Traycer".
 */
export const DEFAULT_BACKEND = "Backend";

/** `<name> offline` (status line and toasts), at most 20 characters. */
export const offlineText = (backend: string = DEFAULT_BACKEND): string => cutWords(`${asciiText(backend) || DEFAULT_BACKEND} offline`, 20);
/** `<name> limited` (status line while a capability is degraded), at most 20 characters. */
export const limitedText = (backend: string = DEFAULT_BACKEND): string => cutWords(`${asciiText(backend) || DEFAULT_BACKEND} limited`, 20);

/** Protocol field limits (docs/protocol.md section 4). */
export const TEXT = { title: 20, label: 12, line: 20, legend: 6, toast: 20 } as const;

/** Non-ASCII becomes a space; runs of whitespace collapse to one space. */
export function asciiText(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim();
}

/** Cuts at the last space at or before `n`; a single word longer than `n` is cut at `n`. No ellipsis. */
export function cutWords(s: string, n: number): string {
  if (s.length <= n) return s;
  const i = s.lastIndexOf(" ", n);
  return (i > 0 ? s.slice(0, i) : s.slice(0, n)).trimEnd();
}

/** Greedy word wrap; a word longer than `width` is split at `width`. */
export function wrapWords(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (let word of asciiText(text).split(" ").filter(Boolean)) {
    while (word.length > width) {
      if (line) out.push(line);
      line = "";
      out.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!word) continue;
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = "";
    }
    line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

export interface TitleSplit {
  /** Up to 12 characters for the slot label, cut at a word boundary. */
  head: string;
  /** The rest of the title, wrapped at 20 into two lines (the second cut at a word boundary). */
  rest: [string, string];
  /** The whole remainder after `head` (for scrolling). */
  remainder: string;
}

/** `headMax`: 12 for the slot label; 11 in protocol version 4, where the head is drawn in FONT_L beside the hero. */
export function titleSplit(title: string, headMax: number = TEXT.label): TitleSplit {
  const words = asciiText(title).split(" ").filter(Boolean);
  let head = "";
  let i = 0;
  const first = words[0] ?? "";
  if (first.length > headMax) {
    head = first.slice(0, headMax);
    words[0] = first.slice(headMax);
  } else {
    for (; i < words.length; i++) {
      const w = words[i] ?? "";
      const next = head ? `${head} ${w}` : w;
      if (next.length > headMax) break;
      head = next;
    }
  }
  const remainder = words.slice(i).join(" ");
  const lines = wrapWords(remainder, TEXT.line);
  const line0 = lines[0] ?? "";
  const line1 = cutWords(lines.slice(1).join(" "), TEXT.line);
  return { head, rest: [line0, line1], remainder };
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** `now` (< 60 s), `<n>m` (< 60 min), `<n>h` (< 48 h), `<n>d` (< 14 d), `<n>w`. */
export function ageText(ms: number): string {
  const t = Math.max(0, ms);
  if (t < MIN) return "now";
  if (t < HOUR) return `${Math.floor(t / MIN)}m`;
  if (t < 48 * HOUR) return `${Math.floor(t / HOUR)}h`;
  if (t < 14 * DAY) return `${Math.floor(t / DAY)}d`;
  return `${Math.floor(t / (7 * DAY))}w`;
}

/** Sentence-case words per state, for detail lines (chips are drawn by the firmware). */
export const STATE_WORDS: Record<NormalizedState, string> = {
  approval_required: "needs approval",
  waiting_input: "needs answer",
  failed: "failed",
  completed_unread: "finished",
  completed_read: "finished",
  working: "working",
  idle: "idle",
  unknown: "no status",
  disconnected: "offline",
};

export interface WhatInput {
  state: NormalizedState;
  stale: boolean;
  summary?: string;
  approvalSummary?: string;
  detail?: string;
  /** Task title, used by idle/unknown when it is not already on screen. */
  taskTitle?: string;
  /** The backend's name for the stale wording (`gone from <name>`). */
  backend?: string;
}

/** The "what" part of detail line 3 (docs/ux-v2.md section 1.4 rule 5). */
export function whatText(w: WhatInput): string {
  if (w.stale) return `gone from ${asciiText(w.backend ?? "") || DEFAULT_BACKEND}`;
  const pick = (...xs: (string | undefined)[]): string => asciiText(xs.find((x) => x !== undefined && asciiText(x) !== "") ?? "");
  switch (w.state) {
    case "approval_required":
      return pick(w.approvalSummary, w.summary, STATE_WORDS.approval_required);
    case "waiting_input":
      return pick(w.summary, STATE_WORDS.waiting_input);
    case "failed":
      return pick(w.summary, w.detail, STATE_WORDS.failed);
    case "completed_unread":
    case "completed_read":
      return pick(w.summary, STATE_WORDS.completed_unread);
    case "working":
      return pick(w.summary, STATE_WORDS.working);
    default:
      if (w.summary && asciiText(w.summary)) return asciiText(w.summary);
      return w.taskTitle && asciiText(w.taskTitle) ? `in ${asciiText(w.taskTitle)}` : STATE_WORDS[w.state];
  }
}

/** `<age> <what>` cut at 20, with ` (guess)` when the state is inferred and it fits. Stale has no age. */
export function ageWhatLine(ageMs: number, what: string, inferred: boolean, stale = false): string {
  const base = cutWords(stale ? what : `${ageText(ageMs)} ${what}`, TEXT.line);
  return inferred && !stale && base.length + 8 <= TEXT.line ? `${base} (guess)` : base;
}

export type HintPair = readonly [button: string, verb: string];

/** `<BUTTON> <verb>` pairs joined by two spaces, else one; while still over 20, the last pair is dropped. */
export function hintLine(pairs: readonly HintPair[]): string {
  let ps = pairs.map(([b, v]) => `${b} ${v}`);
  while (ps.length > 0) {
    const two = ps.join("  ");
    if (two.length <= TEXT.line) return two;
    const one = ps.join(" ");
    if (one.length <= TEXT.line) return one;
    ps = ps.slice(0, -1);
  }
  return "";
}

export const HINT = {
  help: "Hold SCL for help",
  noSelection: ["Turn SELECT or tap a", "key."] as const,
  confirm: "SAVE yes   FX no",
  recording: "release REC to stop",
  transcribing: "FX cancel",
  reviewing: "SAVE send  FX cancel",
  submitting: "sending...",
  failedRetry: "PLAY retry  FX close",
  close: "FX close",
} as const;

/** KNOB1 SHOW; `pinned` (docs/ui-v3.md section 9.4) shows only pins and ignores REPO and TASK. */
export type Scope = "active" | "recent" | "all" | "pinned";
export const SCOPES: readonly Scope[] = ["active", "recent", "all", "pinned"];
export const SCOPE_LABEL: Record<Scope, string> = { active: "ACTIVE", recent: "RECENT", all: "ALL", pinned: "PINNED" };

export type Talk = "reply" | "claude-chat" | "codex-chat" | "claude-task" | "codex-task";
export const TALKS: readonly Talk[] = ["reply", "claude-chat", "codex-chat", "claude-task", "codex-task"];
/** Toast and help wording of each KNOB4 position. */
export const TALK_LABEL: Record<Talk, string> = {
  reply: "reply",
  "claude-chat": "Claude chat",
  "codex-chat": "Codex chat",
  "claude-task": "Claude task",
  "codex-task": "Codex task",
};
/** The REC verb in the hint line. */
export const TALK_VERB: Record<Talk, string> = {
  reply: "reply",
  "claude-chat": "new chat",
  "codex-chat": "new chat",
  "claude-task": "new task",
  "codex-task": "new task",
};

export const VIEW_TITLE = { todo: "TO DO", tasks: "TASKS", voice: "TALK", confirm: "CHECK BEFORE DOING" } as const;

/** `ACTIVE 20 +2 new <filter>` clipped to 20 at a word boundary. */
export function listTitle(name: string, count: number, pendingNew: number, filter?: string): string {
  const parts = [`${name} ${count}`];
  if (pendingNew > 0) parts.push(`+${pendingNew} new`);
  let t = parts.join(" ");
  const f = filter ? asciiText(filter) : "";
  if (f) {
    const room = TEXT.title - t.length - 1;
    if (room >= 3) t = `${t} ${f.length <= room ? f : cutWords(f, room)}`;
  }
  return t.slice(0, TEXT.title);
}

/** `<prefix>: <value>` toast, the value cut to fit 20. */
function labelled(prefix: string, value: string): string {
  return `${prefix}: ${cutWords(asciiText(value), TEXT.toast - prefix.length - 2)}`;
}

export const knobToast = {
  show: (scope: Scope, count: number): string => {
    const t = `Show: ${scope} (${count})`;
    return t.length <= TEXT.toast ? t : `Show: ${scope}`;
  },
  repo: (name: string | null): string => labelled("Repo", name ?? "all"),
  task: (title: string | null): string => labelled("Task", title ?? "all"),
  talk: (t: Talk): string => `Talk: ${TALK_LABEL[t]}`,
};

export const NOTICE = {
  pinned: "Pinned",
  unpinned: "Unpinned",
  /** Only at the safety cap of 200 session pins (operator decision 2026-11-19, "no limit"; focus.ts MAX_PINS_PER_KIND). */
  pinsFull: "Pins full (200)",
  /** The task pins' own safety cap (200, counted apart from session pins). 20 characters. */
  taskPinsFull: "Task pins full (200)",
  /** Task pins (docs/ui-v3.md section 9.6). */
  taskPinned: "Task pinned",
  taskUnpinned: "Task unpinned",
  sorted: "Sorted",
  dismissed: "Dismissed",
  /** TO DO dismiss with its undo window (docs/ux-v2.md section 3.6): FX again within DISMISS_UNDO_MS restores it. */
  dismissedUndo: "Dismissed, FX undo",
  restored: "Restored",
  /** FX inside the undo window after the dismissed item changed or left: nothing is restored or dismissed. */
  nothingToUndo: "Nothing to undo",
  /** REC on a session that cannot take console prompts, when the adapter gave no toast of its own. */
  noPrompts: "Can't take prompts",
  cancelled: "Cancelled",
  nothingToStop: "Nothing to stop",
  selectChat: "Select a chat first",
  selectTask: "Select a task first",
  stillSending: "Still sending",
  notSupported: "Not supported",
  chatGone: "Chat is gone",
  /** SEQ in Tasks (docs/ui-v3.md section 8.5): only Sessions and TO DO have a List layout. */
  noListInTasks: "No list in Tasks",
  /**
   * A short REC tap with neither a suggested next prompt nor a canned response (docs/ui-v3.md sections 11 and 12).
   * Exactly 20 characters.
   */
  noSuggestion: "No suggestion/canned",
  /** Canned responses (docs/ui-v3.md section 12). `Saved as canned N` is cannedSaved(n). */
  alreadyCanned: "Already canned",
  cannedFull: "Canned list full",
  cannedDeleted: "Canned deleted",
  cannedRestored: "Canned restored",
  nothingToSave: "Nothing to save",
  /** Read aloud (docs/ui-v3.md section 14): hold PLAY on a selected session. Host toasts only. */
  voiceStarting: "Starting voice...",
  reading: "Reading",
  readingSummary: "Reading summary",
  readStopped: "Stopped",
  voiceOffline: "Voice offline",
  summaryUnavailable: "Summary unavailable",
  nothingToRead: "Nothing to read",
} as const;

/** ARP tap on a review (docs/ui-v3.md section 12): `Saved as canned N`, N the list size after the add (<= 20). */
export const cannedSaved = (n: number): string => `Saved as canned ${n}`.slice(0, TEXT.toast);

/** The message `controller.ts executeConfirm` reports when the approval was answered elsewhere. */
export const APPROVAL_GONE = "approval no longer pending";

const REASON_WHOLE: Record<string, string> = {
  "session is stale": "Chat is gone",
  stale: "Chat is gone",
  unknown: "Chat is gone",
  "target stale": "Chat is gone",
  "target unknown": "Chat is gone",
  "target no longer available": "Chat is gone",
  "target unavailable": "Chat is gone",
  "destination unavailable": "Chat is gone",
  "session not found on the host": "Chat is gone",
  "session is archived": "Chat is gone",
  [APPROVAL_GONE]: "Already answered",
  "approval already answered": "Already answered",
  "task gone": "Task is gone",
  "task unavailable": "Task is gone",
  "task not found on the host": "Task is gone",
  "project unavailable": "Repo is gone",
  "target not accepting prompts": "Chat can't take it",
  "timed out waiting for backend acknowledgement": "No reply - retry?",
  "transcript is empty": "Nothing heard",
};

/** A link-down message: `disconnected`, `target disconnected`, `<Backend> host disconnected`. */
const DISCONNECTED = /^(?:(?:target|[A-Za-z0-9 ._-]{1,40} host) )?disconnected$/;

/**
 * Failure text for a toast: whole-string match, then `<known>: ...` prefix, then fixed patterns, else a pointer to the
 * Mac. A link-down message becomes `<backend> offline`.
 */
export function resultReason(message?: string | null, backend: string = DEFAULT_BACKEND): string {
  const m = (message ?? "").trim();
  if (DISCONNECTED.test(m)) return offlineText(backend);
  const whole = REASON_WHOLE[m];
  if (whole) return whole;
  for (const [k, v] of Object.entries(REASON_WHOLE)) if (k.length > 7 && m.startsWith(`${k}:`)) return v;
  if (/^approval \S+ (already resolved|is not pending|.*already in flight)/.test(m)) return "Already answered";
  if (m.endsWith(" unsupported") || m === "unsupported") return "Not supported";
  return "Failed - see Mac";
}

/** What a command toast is about; picks the success wording. */
export type ToastAction = "focus" | "interrupt" | "approve" | "deny" | "createSession" | "voice";

const SUCCESS: Record<ToastAction, Partial<Record<DeliveryStage, string>>> = {
  focus: { accepted_locally: "Queued", sent: "Sent", backend_acknowledged: "Opened on Mac", completed: "Opened on Mac" },
  interrupt: { accepted_locally: "Queued", sent: "Stop sent", backend_acknowledged: "Stopping", completed: "Stopped" },
  approve: { accepted_locally: "Queued", sent: "Sent", backend_acknowledged: "Approved", completed: "Approved" },
  deny: { accepted_locally: "Queued", sent: "Sent", backend_acknowledged: "Denied", completed: "Denied" },
  createSession: { accepted_locally: "Queued", sent: "Sent", backend_acknowledged: "Chat created", completed: "Chat created" },
  voice: { accepted_locally: "Queued", sent: "Sent", backend_acknowledged: "Delivered", completed: "Done" },
};

/**
 * A prompt that resolved `sent` with a reason was queued by the backend but its delivery was not seen (Traycer: a2a to
 * a terminal agent whose transcript does not show it yet). Operator wording "Queued, not delivered" is 21 characters.
 */
export const QUEUED_NOT_DELIVERED = "Queued, undelivered";

/** A prompt the backend queued behind the agent's running turn (Traycer chat queue): it runs next (<= 20 chars). */
export const QUEUED_RUNS_NEXT = "Queued, runs next";

/**
 * COMMAND_RESULT text (docs/ux-v2.md section 1.5). Sentence case, at most 20 characters. A voice prompt that ends
 * `sent` with a message (delivery not observed) says QUEUED_NOT_DELIVERED; `backend` names the backend in
 * `<name> offline`.
 */
export function toastFor(stage: DeliveryStage, message?: string | null, action: ToastAction = "voice", backend: string = DEFAULT_BACKEND): string {
  if (stage === "unsupported") return NOTICE.notSupported;
  if (stage === "failed" || stage === "target_unavailable") return resultReason(message, backend);
  if (stage === "sent" && action === "voice" && (message ?? "").trim() !== "") return QUEUED_NOT_DELIVERED;
  if (stage === "backend_acknowledged" && action === "voice" && /^queued\b/i.test(message ?? "")) return QUEUED_RUNS_NEXT;
  return SUCCESS[action][stage] ?? "OK";
}

// ---------------------------------------------------------------------------------------------------------------
// Protocol version 4 (docs/ui-v3.md sections 5 and 6.3): the speech bubble under the character.

/** Bubble body width in FONT_S characters (224 px), visible body rows, and the label head beside the hero. */
export const BUBBLE_COLS = 28;
export const BUBBLE_BODY_ROWS = 5;
/** SET_TEXT rows the bubble uses: caption, 5 body rows, the "more" row. */
export const BUBBLE_ROWS = 7;
export const HEAD4 = 11;
export const CAPTION_MAX = 20;

/** Caption words per state (the firmware's chip words in sentence case, docs/ui-v3.md section 3.A). */
export const CAPTION_WORDS: Record<NormalizedState, string> = {
  approval_required: "Needs approval",
  waiting_input: "Needs answer",
  failed: "Failed",
  completed_unread: "Done, unread",
  completed_read: "Done",
  working: "Working",
  idle: "Idle",
  unknown: "No status",
  disconnected: "Offline",
};

export const NO_MESSAGE = "No message yet";
/** The stale caption, `Gone from <backend>`, at most 20 characters. */
export const goneCaption = (backend: string = DEFAULT_BACKEND): string => cutWords(`Gone from ${asciiText(backend) || DEFAULT_BACKEND}`, CAPTION_MAX);
/** The muted bubble line of a session that takes no console prompts, when the adapter gave none (<= 28). */
export const NO_PROMPTS_LINE = "No prompts from the console";

export type BubbleStyle = "body" | "heading" | "muted";
export interface BubbleRow {
  style: BubbleStyle;
  text: string;
  /** Inline highlights (docs/ui-v3.md section 13); sent to the device only with protocol version 7. */
  spans?: TextSpan[];
}

/** What the bubble says about one chat. Everything is optional except the state; strings may be raw. */
export interface BubbleInput {
  state: NormalizedState;
  stale: boolean;
  /** The status is a guess (inferred): the caption gets ` (guess)` when it fits. */
  inferred: boolean;
  /** Age of the newest event the caption refers to. */
  ageMs: number;
  lastMessage?: string;
  /** The last message's Markdown structure: laid out (headings, lists, code, tables) instead of wrapping `lastMessage`. */
  lastBlocks?: MdBlock[];
  activity?: string;
  failure?: string;
  approvalTarget?: string;
  approvalSummary?: string;
  /** The session summary: used when there is no last message. */
  summary?: string;
  /** The backend's name (`Gone from <name>`). */
  backend?: string;
  /** The session takes no console prompts: this muted line (<= 28) leads the body (docs/ui-v3.md section 9.7). */
  promptLine?: string;
  /** The first suggested next prompt (docs/ui-v3.md section 11): one accent row `Next: <text>` before the message. */
  suggestion?: string;
}

/** The bubble row that offers a session's first suggestion: `Next: <text>`, one row, cut at a word boundary. */
export const nextLine = (suggestion: string, cols: number = BUBBLE_COLS): string => cutWords(`Next: ${asciiText(suggestion)}`, cols);

/**
 * The label row above a suggested text on the voice review screen (docs/ui-v3.md section 11; host text in body row 1,
 * so no firmware change): `Suggested`, or `Suggested 2/3  PRESETS next` when PRESETS cycles (<= 28).
 */
export function suggestedLabel(s: { index: number; count: number } | null): string {
  if (!s || s.count < 2) return "Suggested";
  return `Suggested ${s.index + 1}/${s.count}  PRESETS next`.slice(0, BUBBLE_COLS);
}

/**
 * The label row above a canned response on the review screen (docs/ui-v3.md section 12): `Canned`, or
 * `Canned 2/5  PRESETS next` (i/n counted within the canned list) when there is more than one (<= 28).
 */
export function cannedLabel(s: { index: number; count: number } | null): string {
  if (!s || s.count < 2) return "Canned";
  return `Canned ${s.index + 1}/${s.count}  PRESETS next`.slice(0, BUBBLE_COLS);
}

/** The review label of a suggested or canned text (dictated text has none). */
export function reviewLabel(c: { source: string; suggestion: { index: number; count: number } | null }): string | null {
  if (c.source === "suggested") return suggestedLabel(c.suggestion);
  if (c.source === "canned") return cannedLabel(c.suggestion);
  return null;
}

/** Version 4 review hint rows (muted, inside the bubble when the text leaves a row free; docs/ui-v3.md section 12). */
export const REVIEW_HINT = { save: "ARP save canned", del: "Hold FX: delete canned" } as const;

/** `<State words>, <age>` (<= 20), ` (guess)` when inferred and it fits; stale has no age. */
export function bubbleCaption(b: Pick<BubbleInput, "state" | "stale" | "inferred" | "ageMs" | "backend">): string {
  if (b.stale) return goneCaption(b.backend);
  const base = `${CAPTION_WORDS[b.state]}, ${ageText(b.ageMs)}`.slice(0, CAPTION_MAX);
  return b.inferred && base.length + 8 <= CAPTION_MAX ? `${base} (guess)` : base;
}

/**
 * Every body line of the bubble, newest content first (docs/ui-v3.md section 6.3), after the muted `promptLine` of a
 * session that takes no console prompts (section 9.7): approval -> `Approve: <target>`
 * and the summary; failed -> `Error: <failure>`; working -> `Now: <activity>`; then the last message (or the summary
 * when no message is known). Nothing known -> one muted `No message yet`.
 */
export function bubbleLines(b: BubbleInput, cols: number = BUBBLE_COLS): BubbleRow[] {
  const out: BubbleRow[] = [];
  const add = (text: string | undefined, style: BubbleStyle = "body"): void => {
    const t = asciiText(text ?? "");
    if (t) for (const line of wrapWords(t, cols)) out.push({ style, text: line });
  };
  if (!b.stale && b.promptLine) add(b.promptLine, "muted");
  if (b.stale) {
    add(`This chat is gone from ${asciiText(b.backend ?? "") || DEFAULT_BACKEND}.`, "muted");
  } else if (b.state === "approval_required") {
    const target = asciiText(b.approvalTarget ?? "") || asciiText(b.approvalSummary ?? "");
    if (target) add(`Approve: ${target}`);
    const what = asciiText(b.approvalSummary ?? "");
    if (what && what !== target) add(what);
  } else if (b.state === "failed") {
    if (b.failure && asciiText(b.failure)) add(`Error: ${b.failure}`);
  } else if (b.state === "working") {
    if (b.activity && asciiText(b.activity)) add(`Now: ${b.activity}`);
  }
  // After the state lines, before the message: the first suggestion, one row in the accent (heading) style.
  if (!b.stale && b.suggestion && asciiText(b.suggestion)) out.push({ style: "heading", text: nextLine(b.suggestion, cols) });
  const message = asciiText(b.lastMessage ?? "");
  const md = message && b.lastBlocks && b.lastBlocks.length > 0 ? layoutMarkdown(b.lastBlocks, cols, MARKDOWN_ROWS_MAX) : [];
  if (md.length > 0) out.push(...md);
  else if (message) add(message);
  else {
    const summary = asciiText(b.summary ?? "");
    if (summary && !out.map((r) => r.text).join(" ").includes(summary)) add(summary);
  }
  if (out.length === 0) out.push({ style: "muted", text: NO_MESSAGE });
  return out;
}

/** Highest PRESETS scroll step: each step skips 5 body rows. */
export const bubbleMaxScroll = (lines: number, rows: number = BUBBLE_BODY_ROWS): number => Math.max(0, Math.ceil(lines / rows) - 1);

/**
 * SET_TEXT rows 0-6 of a base view: row 0 the caption, rows 1-5 the body from `scroll` (clamped), row 6 the first
 * line after the visible body or `""` (a non-empty row 6 draws the "more" wedge).
 */
export function bubbleRows(caption: string, lines: readonly BubbleRow[], scroll: number, rows: number = BUBBLE_BODY_ROWS): BubbleRow[] {
  // (`rows` 4: the SPLIT Buddy bubble, docs/ui-v3.md section 10.7; row 5 is then the "more" row)
  const step = Math.max(0, Math.min(bubbleMaxScroll(lines.length, rows), Math.floor(scroll)));
  const start = step * rows;
  const body: BubbleRow[] = lines.slice(start, start + rows).map((r) => clipRow({ ...r }, BUBBLE_COLS));
  while (body.length < rows) body.push({ style: "body", text: "" });
  const next = lines[start + rows];
  return [
    { style: "heading", text: asciiText(caption).slice(0, CAPTION_MAX) },
    ...body,
    // The "more" row only says that there is more (a non-empty row draws the wedge): plain text, no spans.
    next ? { style: next.style, text: next.text.slice(0, BUBBLE_COLS) || " " } : { style: "body", text: "" },
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Protocol version 5 (docs/ui-v3.md section 8): the LIST layout of Sessions and TO DO.

/** The header's message line: FONT_S at x 40-231 (192 px). */
export const LIST_HEAD_COLS = 24;
/** SET_SLOT.title and SET_SLOT.age (docs/protocol.md section 4, version 5). */
export const ROW_TITLE_MAX = 20;
export const ROW_AGE_MAX = 3;
/** Row 1 of the header when nothing is selected (exactly 24 characters, so it never wraps). */
export const LIST_NONE_SELECTED = "Turn SELECT or tap a key";

/** Highest PRESETS step in the List layout: one line per step, the last line stays visible. */
export const listMaxScroll = (lines: number): number => Math.max(0, lines - 1);

/**
 * SET_TEXT rows 0-2 of the List header: row 0 the caption, row 1 the line at `scroll` (clamped), row 2 the next line
 * or `""` (non-empty draws the "more" wedge). Lines are expected wrapped at LIST_HEAD_COLS.
 */
export function listHeadRows(caption: string, lines: readonly BubbleRow[], scroll: number): BubbleRow[] {
  const at = Math.max(0, Math.min(listMaxScroll(lines.length), Math.floor(scroll)));
  const cut = (r: BubbleRow | undefined): BubbleRow => (r ? clipRow({ ...r }, LIST_HEAD_COLS) : { style: "body", text: "" });
  return [{ style: "heading", text: asciiText(caption).slice(0, CAPTION_MAX) }, cut(lines[at]), cut(lines[at + 1])];
}

/** A list row's title: ASCII, cut at a word boundary to 20, `(untitled)` when empty. */
export function rowTitle(title: string | undefined): string {
  const t = asciiText(title ?? "");
  return t ? cutWords(t, ROW_TITLE_MAX) : "(untitled)";
}

/** A list row's age: `ageText`, capped at 3 characters (`99w` for anything older). */
export function rowAge(ms: number): string {
  const t = ageText(ms);
  return t.length <= ROW_AGE_MAX ? t : "99w";
}

// ---------------------------------------------------------------------------------------------------------------
// Protocol version 5 GROUPED, PINNED and the reader (docs/ui-v3.md section 9).

/** The PINNED scope with no pins (docs/ui-v3.md section 9.4): caption and muted line of the bubble / List header. */
export const PINNED_EMPTY = ["No pins yet", "hold a key to pin"] as const;
/** SET_SLOT head_title / head_count (docs/protocol.md section 4). */
export const HEAD_TITLE_MAX = 20;
export const HEAD_COUNT_MAX = 11;
/** The header row: title and count share 25 FONT_S columns (x 20-232). */
export const HEAD_COLS = 25;
export const GROUP_TITLE = { pinned: "Pinned", new: "New" } as const;

/**
 * A group header's count (<= 11): `<n> need you` (T0-T3), else `<n> working`, else `all quiet`; a folded task
 * `<n> quiet`; a pinned task without live chats `no chats`. n is capped at 99.
 */
export function groupCount(c: { attention: number; working: number; total: number; folded: boolean }): string {
  const n = (x: number): number => Math.min(99, x);
  if (c.folded) return c.total === 0 ? "no chats" : `${n(c.total)} quiet`;
  if (c.attention > 0) return `${n(c.attention)} need you`;
  if (c.working > 0) return `${n(c.working)} working`;
  return "all quiet";
}

/** The header title: ASCII, cut at a word boundary so title and count fit 25 columns (and 20 at most). */
export function groupTitle(title: string, count: string): string {
  const t = asciiText(title);
  return t ? cutWords(t, Math.max(1, Math.min(HEAD_TITLE_MAX, HEAD_COLS - count.length - 1))) : "(untitled)";
}

/** A session row's title in the Grouped layout: 20 characters less one per indent level (so it never reaches the age). */
export function groupedRowTitle(title: string | undefined, indent: number): string {
  const t = asciiText(title ?? "");
  return t ? cutWords(t, ROW_TITLE_MAX - indent) : "(untitled)";
}

/** After this long without device input the reader (DETAILS, protocol 5) closes on its own. */
export const READER_AUTO_RETURN_MS = 20_000;
