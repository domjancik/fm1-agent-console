// Session details for the PRESETS scroll and the DETAILS page (docs/ux-v2.md sections 7.2 and 7.5). Pure, ASCII only.
import { ageText, asciiText, cutWords, DEFAULT_BACKEND, NO_PROMPTS_LINE, titleSplit, wrapWords, type BubbleInput } from "./copy";
import { taskKey, taskOf } from "./identity";
import { clipRow, layoutMarkdown, type MdBlock, type TextSpan } from "./markdown";
import type { SessionEntry } from "./registry";
import { activityAt, effectiveState, isInferred } from "./status";
import type { ApprovalRequest, NormalizedState, Provider, SessionDetails } from "./types";

export type TextStyle = "body" | "heading" | "muted";
export interface TextRow {
  style: TextStyle;
  text: string;
  /** Inline highlights (docs/ui-v3.md section 13); sent to the device only with protocol version 7. */
  spans?: TextSpan[];
}

/** DETAILS page geometry (docs/ux-v2.md section 7.4): 12 rows of 29 FONT_S characters, at most 8 pages. */
export const DETAIL_COLS = 29;
export const DETAIL_ROWS = 12;
export const MAX_DETAIL_PAGES = 8;
export const NO_DETAILS = "No chat details yet";
export const DETAILS_TITLE = "DETAILS";

/** The firmware's state chip words (docs/firmware-ui.md), reused for the DETAILS heading. */
export const CHIP_WORDS: Record<NormalizedState, string> = {
  approval_required: "NEEDS APPROVAL",
  waiting_input: "NEEDS ANSWER",
  failed: "FAILED",
  completed_unread: "DONE, UNREAD",
  completed_read: "DONE",
  working: "WORKING",
  idle: "IDLE",
  unknown: "NO STATUS",
  disconnected: "OFFLINE",
};

const PROVIDER_WORD: Record<Provider, string> = { claude: "Claude", codex: "Codex", other: "Agent" };

export interface DetailInput {
  entry: SessionEntry;
  /** Display state (inbox read state applied). */
  state: NormalizedState;
  taskTitle?: string;
  approval?: ApprovalRequest;
  now: number;
  /** The backend's name (`GONE FROM <NAME>`). */
  backend?: string;
}

/** `GONE FROM <NAME>` for a stale session's DETAILS heading. */
const goneHeading = (backend: string | undefined): string => `GONE FROM ${asciiText(backend ?? "") || DEFAULT_BACKEND}`.toUpperCase();

/**
 * The newest thing the session said: `details.reply` (the answer to a console prompt, docs/ui-v3.md section 9.7) when it
 * is at least as new as `lastMessage`, else `lastMessage`.
 */
export function newestMessage(d: SessionDetails): { text: string; at?: number; blocks?: MdBlock[] } | undefined {
  const reply = d.reply;
  if (reply !== undefined && asciiText(reply.text) && (d.lastMessageAt === undefined || reply.at >= d.lastMessageAt || !d.lastMessage)) {
    return reply.blocks !== undefined && reply.blocks.length > 0 ? { text: reply.text, at: reply.at, blocks: reply.blocks } : { text: reply.text, at: reply.at };
  }
  if (d.lastMessage === undefined || !asciiText(d.lastMessage)) return undefined;
  const out: { text: string; at?: number; blocks?: MdBlock[] } = { text: d.lastMessage };
  if (d.lastMessageAt !== undefined) out.at = d.lastMessageAt;
  if (d.lastBlocks !== undefined && d.lastBlocks.length > 0) out.blocks = d.lastBlocks;
  return out;
}

/**
 * The message's rows at `width`: the Markdown layout when the adapter gave its structure (docs/ui-v3.md section 13),
 * else the plain text wrapped as one paragraph. At most `max` rows.
 */
export function messageRows(message: { text: string; blocks?: MdBlock[] }, max: number, width = DETAIL_COLS): TextRow[] {
  const md = message.blocks ? layoutMarkdown(message.blocks, width, max) : [];
  return md.length > 0 ? md : rows("body", message.text, max, width);
}

/** The muted line of a session that takes no console prompts (the adapter's `prompt.line`, else NO_PROMPTS_LINE). */
export function promptLineOf(s: { prompt?: { acceptsPrompt: boolean; line?: string } }): string | undefined {
  if (s.prompt === undefined || s.prompt.acceptsPrompt) return undefined;
  return asciiText(s.prompt.line ?? "") || NO_PROMPTS_LINE;
}

const rows = (style: TextStyle, text: string, max: number, width = DETAIL_COLS): TextRow[] => {
  const lines = wrapWords(text, width);
  if (lines.length > max) {
    const kept = lines.slice(0, max);
    kept[max - 1] = cutWords(lines.slice(max - 1).join(" "), width);
    return kept.map((t) => ({ style, text: t }));
  }
  return lines.map((t) => ({ style, text: t }));
};

/** One row per known fact: `Claude opus-4.5`, `Context 42%  turns 12`, `Files 3: view.ts, copy.ts`. */
export function factLines(provider: Provider, d: SessionDetails, width = DETAIL_COLS): string[] {
  const out: string[] = [];
  if (d.model) out.push(cutWords(`${PROVIDER_WORD[provider]} ${asciiText(d.model)}`, width));
  const context = d.contextPct !== undefined ? `Context ${Math.round(d.contextPct)}%` : "";
  if (context && d.turns !== undefined) out.push(`${context}  turns ${d.turns}`);
  else if (context) out.push(context);
  else if (d.turns !== undefined) out.push(`Turns ${d.turns}`);
  if (d.files && d.files.count > 0) out.push(filesLine(d.files, width));
  return out;
}

/** `Files 3: view.ts, copy.ts`: as many whole names as fit. */
function filesLine(files: { count: number; names: string[] }, width: number): string {
  let line = `Files ${files.count}`;
  let sep = ": ";
  for (const name of files.names.map(asciiText).filter(Boolean)) {
    if (line.length + sep.length + name.length > width) break;
    line += sep + name;
    sep = ", ";
  }
  return line.slice(0, width);
}

/** Every row of the DETAILS page for one session, before it is cut into pages. */
export function detailRows(input: DetailInput): TextRow[] {
  const { entry, state, approval, now } = input;
  const s = entry.session;
  const d = s.details ?? {};
  const out: TextRow[] = [];
  const at = approval?.createdAt ?? activityAt(s);
  const inferred = isInferred(s.status);
  out.push({ style: "heading", text: entry.stale ? goneHeading(input.backend) : cutWords(`${CHIP_WORDS[state]}, ${ageText(now - at)}${inferred ? " (guess)" : ""}`, DETAIL_COLS) });
  out.push(...rows("body", asciiText(s.title) || "(untitled)", 2));
  if (input.taskTitle && asciiText(input.taskTitle)) out.push(...rows("muted", `Task: ${asciiText(input.taskTitle)}`, 2));
  const live = entry.stale ? effectiveState(s.status) : state;
  if (live === "approval_required") {
    const target = d.approval?.target ?? approval?.summary;
    if (target) out.push(...rows("body", `Approve: ${asciiText(target)}`, 4));
    const what = approval?.summary && approval.summary !== target ? approval.summary : d.approval?.summary;
    if (what) out.push(...rows("body", asciiText(what), 3));
  } else if (live === "failed") {
    const why = d.failure ?? s.status.observed.detail;
    if (why) out.push(...rows("body", `Error: ${asciiText(why)}`, 4));
  } else if (live === "working" && d.activity) {
    out.push(...rows("body", `Now: ${asciiText(d.activity)}`, 2));
  }
  const promptLine = entry.stale ? undefined : promptLineOf(s);
  if (promptLine) out.push({ style: "muted", text: promptLine });
  for (const f of factLines(s.provider, d)) out.push({ style: "muted", text: f });
  const message = newestMessage(d);
  if (message) {
    out.push({ style: "heading", text: message.at !== undefined ? `Last message ${ageText(now - message.at)}` : "Last message" });
    out.push(...messageRows(message, DETAIL_ROWS * MAX_DETAIL_PAGES));
  }
  if (d.lastPrompt && asciiText(d.lastPrompt)) out.push(...rows("muted", `Prompt: ${asciiText(d.lastPrompt)}`, 3));
  if (s.details === undefined || out.length <= 3) out.push({ style: "muted", text: NO_DETAILS });
  return out;
}

/** Rows cut into pages of 12 (at most 8 pages). Always at least one page. */
export function paginate(all: readonly TextRow[]): TextRow[][] {
  const pages: TextRow[][] = [];
  for (let i = 0; i < all.length && pages.length < MAX_DETAIL_PAGES; i += DETAIL_ROWS) pages.push(all.slice(i, i + DETAIL_ROWS));
  return pages.length > 0 ? pages : [[]];
}

/** 12 rows exactly: the page padded with empty body rows. */
export function padPage(page: readonly TextRow[] | undefined): TextRow[] {
  const out: TextRow[] = (page ?? []).slice(0, DETAIL_ROWS).map((r) => clipRow({ ...r }, DETAIL_COLS));
  while (out.length < DETAIL_ROWS) out.push({ style: "body", text: "" });
  return out;
}

export function detailInput(
  entry: SessionEntry,
  state: NormalizedState,
  world: { registry: { task(k: string): { title: string } | undefined; approvalsFor(k: string): ApprovalRequest[] }; now: number; backend?: string },
  approval?: ApprovalRequest,
): DetailInput {
  const taskTitle = world.registry.task(taskKey(taskOf(entry.session.ref)))?.title;
  const out: DetailInput = { entry, state, now: world.now };
  if (world.backend !== undefined) out.backend = world.backend;
  if (taskTitle !== undefined) out.taskTitle = taskTitle;
  const a = approval ?? world.registry.approvalsFor(entry.key)[0];
  if (a !== undefined) out.approval = a;
  return out;
}

/** The PRESETS scroll tail in the base views (20 wide): last message, then activity and facts. */
export function scrollTail(provider: Provider, d: SessionDetails | undefined, width: number): string[] {
  if (!d) return [];
  const out: string[] = [];
  const message = newestMessage(d);
  if (message) out.push(...messageRows(message, Number.MAX_SAFE_INTEGER, width).map((r) => r.text).filter((t) => t !== ""));
  if (d.activity) out.push(...wrapWords(`Now: ${d.activity}`, width));
  if (d.failure) out.push(...wrapWords(`Error: ${d.failure}`, width));
  if (d.contextPct !== undefined) out.push(`Context ${Math.round(d.contextPct)}%`);
  if (d.model) out.push(cutWords(`Model ${asciiText(d.model)}`, width));
  if (d.turns !== undefined) out.push(`Turns ${d.turns}`);
  if (d.files && d.files.count > 0) out.push(...wrapWords(`Files ${d.files.count}: ${d.files.names.join(" ")}`, width));
  void provider;
  return out;
}

/** `DETAILS <title head>`, clipped to 20. */
export const detailTitle = (title: string): string => `${DETAILS_TITLE} ${titleSplit(title).head}`.trim().slice(0, 20);

// ---------------------------------------------------------------------------------------------------------------
// Protocol version 4 (docs/ui-v3.md sections 5 and 6.3).

/** DETAILS v4: rows 0-2 are the header beside the 48 px hero (<= 22), rows 3-11 the body (9 rows of <= 29). */
export const HEADER4_COLS = 22;
export const HEADER4_ROWS = 3;
export const BODY4_ROWS = DETAIL_ROWS - HEADER4_ROWS;

/** The three header rows: the state heading with the age, then the title wrapped at 22 (2 rows). */
export function detailHeader4(input: DetailInput): TextRow[] {
  const { entry, state, approval, now } = input;
  const s = entry.session;
  const at = approval?.createdAt ?? activityAt(s);
  const heading = entry.stale ? goneHeading(input.backend) : cutWords(`${CHIP_WORDS[state]} ${ageText(now - at)}${isInferred(s.status) ? " (guess)" : ""}`, HEADER4_COLS);
  const title = rows("body", asciiText(s.title) || "(untitled)", 2, HEADER4_COLS);
  while (title.length < 2) title.push({ style: "body", text: "" });
  return [{ style: "heading", text: heading }, ...title];
}

/**
 * The DETAILS body for version 4, newest first: `Last message <age>` and the message; then the approval, the error
 * or what it is doing now; then the facts; then the task.
 */
export function detailBody4(input: DetailInput): TextRow[] {
  const { entry, state, approval, now } = input;
  const s = entry.session;
  const d = s.details ?? {};
  const out: TextRow[] = [];
  const promptLine = entry.stale ? undefined : promptLineOf(s);
  if (promptLine) out.push({ style: "muted", text: promptLine });
  const message = newestMessage(d);
  if (message) {
    out.push({ style: "heading", text: message.at !== undefined ? `Last message ${ageText(now - message.at)}` : "Last message" });
    out.push(...messageRows(message, BODY4_ROWS * MAX_DETAIL_PAGES));
  }
  if (d.lastPrompt && asciiText(d.lastPrompt)) out.push(...rows("muted", `Prompt: ${asciiText(d.lastPrompt)}`, 3));
  const live = entry.stale ? effectiveState(s.status) : state;
  if (live === "approval_required") {
    const target = d.approval?.target ?? approval?.summary;
    if (target) out.push(...rows("body", `Approve: ${asciiText(target)}`, 4));
    const what = approval?.summary && approval.summary !== target ? approval.summary : d.approval?.summary;
    if (what) out.push(...rows("body", asciiText(what), 3));
  } else if (live === "failed") {
    const why = d.failure ?? s.status.observed.detail;
    if (why) out.push(...rows("body", `Error: ${asciiText(why)}`, 4));
  } else if (live === "working" && d.activity) {
    out.push(...rows("body", `Now: ${asciiText(d.activity)}`, 2));
  }
  for (const f of factLines(s.provider, d)) out.push({ style: "muted", text: f });
  if (input.taskTitle && asciiText(input.taskTitle)) out.push(...rows("muted", `Task: ${asciiText(input.taskTitle)}`, 2));
  if (s.details === undefined || out.length === 0) out.push({ style: "muted", text: NO_DETAILS });
  return out;
}

/** Version 4 pages: the header on every page, then 9 body rows (at most 8 pages, always at least one). */
export function detailPages4(input: DetailInput): TextRow[][] {
  const header = detailHeader4(input);
  const body = detailBody4(input);
  const pages: TextRow[][] = [];
  for (let i = 0; i < body.length && pages.length < MAX_DETAIL_PAGES; i += BODY4_ROWS) pages.push([...header, ...body.slice(i, i + BODY4_ROWS)]);
  return pages.length > 0 ? pages : [header];
}

/** The bubble input for one chat (docs/ui-v3.md section 6.3); the caller formats it with copy.ts bubbleRows. */
export function bubbleInput(input: DetailInput): BubbleInput {
  const { entry, state, approval, now } = input;
  const s = entry.session;
  const d = s.details ?? {};
  const out: BubbleInput = {
    state: entry.stale ? effectiveState(s.status) : state,
    stale: entry.stale,
    inferred: isInferred(s.status),
    ageMs: now - (approval?.createdAt ?? activityAt(s)),
  };
  const message = newestMessage(d);
  if (message !== undefined) out.lastMessage = message.text;
  if (message?.blocks !== undefined) out.lastBlocks = message.blocks;
  if (d.activity !== undefined) out.activity = d.activity;
  if (input.backend !== undefined) out.backend = input.backend;
  const promptLine = entry.stale ? undefined : promptLineOf(s);
  if (promptLine !== undefined) out.promptLine = promptLine;
  const failure = d.failure ?? s.status.observed.detail;
  if (failure !== undefined) out.failure = failure;
  const target = d.approval?.target ?? approval?.summary;
  if (target !== undefined) out.approvalTarget = target;
  const what = approval?.summary ?? d.approval?.summary;
  if (what !== undefined) out.approvalSummary = what;
  if (s.summary !== undefined) out.summary = s.summary;
  return out;
}
