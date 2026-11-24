import { markdownBlocks, MARKDOWN_SOURCE_MAX, type MdBlock, type SessionDetails } from "@fm1/agent-core";
import { deriveToolInputSummary } from "@traycer/protocol/host/agent/gui/tool-input-summary";
import type { ChatFrame } from "../streams";
import type { PendingApproval } from "./chat-channel";

/**
 * Per-chat details derived from the `chat.subscribe` stream the adapter already
 * holds open (docs/ux-v2.md section 7.1). Read only: it consumes frames and
 * never sends anything.
 *
 * Shapes (vendored protocol @ host-v1.5.4, confirmed live on a disposable chat):
 *  - `snapshot.snapshot.tail.messages[]`: `{role:"assistant", blocks:[{type:"text", text} | {type:"tool_call",
 *    toolName, inputSummary, status} | {type:"command", command, status} | {type:"file_change", filePath, status} |
 *    {type:"error", message}], timestamp, turnId}` and `{role:"user", timestamp}`;
 *  - `snapshot.snapshot.tail.events[]`: `{type:"turn.started"|"turn.completed"|"turn.stopped"|"turn.interrupted",
 *    timestamp, message, severity, metadata}`;
 *  - `snapshot.snapshot.derived.latestAssistantUsage`: `{contextTokens, contextWindow}`;
 *  - `snapshot.snapshot.chat.settings.model`, `chat.updatedAt`;
 *  - `skeletonChunk.chunk.entries[]`: `{rowId, role, createdAt}` (every row, so the turn count is not bounded by
 *    the tail);
 *  - `blockDelta.event`: runtime events `text.delta`, `text.completed`, `reasoning.delta`, `tool_call.started`
 *    (`toolName`, `input`), `tool_call.completed` / `.errored`, `command.started` (`command`) / `.completed`,
 *    `file_change.started` / `.completed` (`filePath`, `operation`), `usage.updated` (`usage`), `turn.started`,
 *    `turn.completed`, `turn.stopped`, `turn.interrupted` (`reason`), `error` (`message`).
 */

export const DETAIL_LIMITS = { lastMessage: 600, activity: 60, failure: 200, target: 200, model: 24, fileName: 40, suggestion: 600 } as const;

/**
 * The `chat.subscribe` minor that carries `suggestedPrompt` (the "Claude-parity line", vendored registry 1.20). Below it
 * the host strips the key by name, so a chat simply never has a suggestion.
 */
export const SUGGESTED_PROMPT_MINOR = 20;

export interface ChatDetailsOptions {
  /** Whether the negotiated `chat.subscribe` line carries `suggestedPrompt` (>= 1.20). Default: yes. */
  suggestions?: () => boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

const FOLD: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'", "“": '"', "”": '"', "„": '"',
  "–": "-", "—": "-", "―": "-", "−": "-", "…": "...", "•": "-", "·": "-",
  "→": "->", "←": "<-", "×": "x", "✓": "ok", "✔": "ok", "✗": "x", " ": " ",
};

/** ASCII fold: common typography to ASCII, accents dropped, anything else removed; whitespace collapsed. */
export function asciiFold(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFKD")) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e) out += ch;
    else if (ch === "\n" || ch === "\t" || ch === "\r") out += " ";
    else if (FOLD[ch] !== undefined) out += FOLD[ch];
    else if (code >= 0x300 && code <= 0x36f) continue; // combining accents
    else out += " ";
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * ASCII fold that keeps the line structure (for Markdown, docs/ui-v3.md section 13): the same character mapping as
 * asciiFold, but line breaks and tabs stay and nothing is collapsed (indentation is meaningful in Markdown).
 */
export function asciiFoldLines(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFKD")) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x20 && code <= 0x7e) || ch === "\n" || ch === "\t" || ch === "\r") out += ch;
    else if (FOLD[ch] !== undefined) out += FOLD[ch];
    else if (code >= 0x300 && code <= 0x36f) continue; // combining accents
    else out += " ";
  }
  return out;
}

/**
 * A message's Markdown structure as it may leave the adapter (`SessionDetails.lastBlocks`): secrets redacted over the
 * whole source first (multi-line PEM blocks too), then ASCII-folded with its lines kept, at most MARKDOWN_SOURCE_MAX
 * characters, parsed by agent-core's shared reader.
 */
export const messageBlocks = (markdown: string): MdBlock[] => markdownBlocks(asciiFoldLines(redactSecrets(markdown)), MARKDOWN_SOURCE_MAX);

/** Markdown to plain text: fences, headings, emphasis, inline code and links reduced to their words. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|\W)[*_]([^*_\n]+)[*_](?=\W|$)/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "- ")
    .replace(/^\s*\|?[-:| ]{3,}\|?\s*$/gm, " ");
}

/** Cut at the last space at or before `n` (a single long word is cut at `n`). */
export function cut(text: string, n: number): string {
  if (text.length <= n) return text;
  const i = text.lastIndexOf(" ", n);
  return (i > n / 2 ? text.slice(0, i) : text.slice(0, n)).trimEnd();
}

/**
 * Secret-looking values masked before any detail leaves the adapter (device, companion UI, logs): `KEY=value` and
 * `--token value` where the name says token/secret/password/key/auth/credential, `Authorization: Bearer x`, and
 * well-known token shapes (sk-..., ghp_..., xox?-..., AKIA..., JWTs, PEM blocks, long hex/base64 runs).
 */
const SECRET_NAME = String.raw`[A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|auth|credential|cookie|session[_-]?id)[A-Za-z0-9_.-]*`;
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "<redacted>"],
  [/\b(Bearer|Basic|Token)\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{8,}/gi, "$1 <redacted>"],
  // `NAME=value` (shell, env files) always; `NAME: value` / `"name": "value"` only when the value has a digit (prose
  // such as "authentication: failed" stays readable).
  [new RegExp(String.raw`\b(${SECRET_NAME})(\s*=\s*)("[^"]*"|'[^']*'|[^\s"',;&|]+)`, "gi"), "$1$2<redacted>"],
  [new RegExp(String.raw`\b(${SECRET_NAME}"?)(\s*:\s*)("[^"]*\d[^"]*"|'[^']*\d[^']*'|[^\s"',;&|]*\d[^\s"',;&|]*)`, "gi"), "$1$2<redacted>"],
  [new RegExp(String.raw`(--?${SECRET_NAME})(\s+|=)("[^"]*"|'[^']*'|[^\s"',;&|-][^\s"',;&|]*)`, "gi"), "$1$2<redacted>"],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "<redacted>"],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abposr]|npm)_?-?[A-Za-z0-9_-]{16,}/g, "<redacted>"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "<redacted>"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "<redacted>"],
  [/\b[0-9a-fA-F]{40,}\b/g, "<redacted>"],
  [/(?<![A-Za-z0-9/+_.-])(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[a-z])(?=[A-Za-z0-9+_-]*[A-Z])[A-Za-z0-9+_-]{32,}={0,2}(?![A-Za-z0-9/+_.-])/g, "<redacted>"],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, by] of SECRET_PATTERNS) out = out.replace(re, by);
  return out;
}

const clean = (text: string, n: number): string => cut(asciiFold(redactSecrets(text)), n);

/**
 * A notification's free text (agent.stopped/stalled `message`/`reason`) as the observed status detail: secrets
 * redacted, ASCII, at most DETAIL_LIMITS.failure. Version 4 shows it whole in the main-screen bubble.
 */
export const cleanOutcomeDetail = (text: string): string => clean(text, DETAIL_LIMITS.failure);
const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** `claude-opus-4-5-20251101` -> `opus-4-5`; `gpt-5-codex` stays. */
export function shortModel(model: string): string {
  const m = asciiFold(model).replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/\[.*\]$/, "");
  return cut(m, DETAIL_LIMITS.model);
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "apply_patch", "edit", "write", "str_replace_based_edit_tool"]);
const READ_TOOLS = new Set(["Read", "read", "NotebookRead", "view"]);
const SHELL_TOOLS = new Set(["Bash", "bash", "shell", "exec_command", "local_shell", "traycer_run_shell", "BashOutput"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob", "grep", "glob", "search", "LS", "ls", "ToolSearch"]);
const WEB_TOOLS = new Set(["WebFetch", "WebSearch", "web_search", "fetch"]);
const AGENT_TOOLS = new Set(["Task", "Agent"]);

/** A tool call as a verb and a target: `editing view.ts`, `running bun test`, `searching titleSplit`. */
export function activityText(toolName: string, summary: string | null): string {
  const s = summary === null ? "" : asciiFold(redactSecrets(summary));
  const verb = (v: string, target: string): string => clean(target ? `${v} ${target}` : v, DETAIL_LIMITS.activity);
  if (EDIT_TOOLS.has(toolName)) return verb("editing", s ? baseName(s) : "");
  if (READ_TOOLS.has(toolName)) return verb("reading", s ? baseName(s) : "");
  if (SHELL_TOOLS.has(toolName)) return verb("running", s);
  if (SEARCH_TOOLS.has(toolName)) return verb("searching", s);
  if (WEB_TOOLS.has(toolName)) return verb("browsing", s);
  if (AGENT_TOOLS.has(toolName)) return verb("subagent:", s);
  if (toolName === "TodoWrite" || toolName === "TaskCreate" || toolName === "TaskUpdate") return "planning";
  const name = asciiFold(toolName.replace(/^mcp__[^_]+__/, "")).replace(/_/g, " ");
  return verb(name || "tool", s);
}

function summaryOf(toolName: string, input: unknown): string | null {
  try {
    return deriveToolInputSummary(toolName, input);
  } catch {
    return null;
  }
}

interface MessageSummary {
  text: string;
  at: number;
  blocks: MdBlock[];
}

/** Text of an assistant message: its `text` blocks joined. */
function messageText(m: Obj): string {
  const blocks = Array.isArray(m.blocks) ? m.blocks : [];
  return blocks
    .filter((b): b is Obj => isObj(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n\n");
}

const TERMINAL_TURN_EVENTS = new Set(["turn.completed", "turn.stopped", "turn.interrupted"]);

export class ChatDetails {
  private model: string | undefined;
  private contextPct: number | undefined;
  private lastMessage: MessageSummary | undefined;
  private failure: string | undefined;
  private tailUsers = 0;
  private readonly skeletonUsers = new Set<string>();
  private liveTurns = new Set<string>();
  private files: string[] = [];
  private fileCount = 0;
  /** Open tool/command/file blocks of the running turn, newest last: blockId -> activity. */
  private readonly open = new Map<string, string>();
  private phase: string | undefined;
  private drafts = new Map<string, string>();
  private turnRunning = false;
  private lastAt = 0;
  /** The provider's suggested next prompt (`suggestedPrompt`, live-only): redacted, ASCII, <= DETAIL_LIMITS.suggestion. */
  private suggested: string | undefined;

  constructor(private readonly options: ChatDetailsOptions = {}) {}

  /**
   * `suggestedPrompt` from a snapshot or a `turnStateChanged` frame. An ABSENT key CLEARS it (the host drops it on any
   * send, any run opening and teardown); below chat.subscribe 1.20 it is ignored.
   */
  private suggest(v: unknown): void {
    if (this.options.suggestions !== undefined && !this.options.suggestions()) {
      this.suggested = undefined;
      return;
    }
    const text = typeof v === "string" ? clean(plainText(v), DETAIL_LIMITS.suggestion) : "";
    this.suggested = text || undefined;
  }

  /** Feeds one chat frame. Unknown kinds and malformed fields are ignored. */
  consume(frame: ChatFrame, now: number): void {
    switch (frame.kind) {
      case "snapshot":
        if (isObj(frame.snapshot)) {
          this.snapshot(frame.snapshot);
          this.suggest(frame.snapshot.suggestedPrompt);
        }
        break;
      case "skeletonChunk":
        this.skeleton(frame.chunk);
        break;
      case "blockDelta":
        if (isObj(frame.event)) this.event(frame.event, now);
        break;
      case "eventAppended":
        if (isObj(frame.event)) this.chatEvent(frame.event);
        break;
      case "turnStateChanged": {
        this.suggest(frame.suggestedPrompt);
        const turn = isObj(frame.activeTurn) ? frame.activeTurn : null;
        const status = turn === null ? null : str(turn.status);
        // An active turn's own status wins (host 1.5.4 reports runStatus "running" beside a completed turn).
        const running = status != null ? !["completed", "stopped", "interrupted", "errored"].includes(status) : frame.runStatus === "running";
        if (!running) this.endTurn();
        else if (!this.turnRunning) {
          this.turnRunning = true;
          this.phase ??= "thinking";
        }
        break;
      }
      default:
        break;
    }
  }

  /** The newest turn or activity time seen on the stream (0 when none). */
  lastActivityAt(): number {
    return this.lastAt;
  }

  /** The stream closed: nothing is known to be in progress any more. */
  closed(): void {
    this.suggested = undefined; // live-only state: unknown once the stream is gone
    this.open.clear();
    this.phase = undefined;
    this.turnRunning = false;
  }

  activity(): string | undefined {
    const tools = [...this.open.values()];
    return tools[tools.length - 1] ?? (this.turnRunning ? this.phase : undefined);
  }

  details(approval?: PendingApproval): SessionDetails {
    const out: SessionDetails = {};
    if (this.lastMessage !== undefined && this.lastMessage.text) {
      out.lastMessage = this.lastMessage.text;
      if (this.lastMessage.blocks.length > 0) out.lastBlocks = this.lastMessage.blocks;
      if (this.lastMessage.at > 0) out.lastMessageAt = this.lastMessage.at;
    }
    const activity = this.activity();
    if (activity !== undefined) out.activity = activity;
    if (this.failure !== undefined) out.failure = this.failure;
    if (approval !== undefined) {
      const target = approval.kind === "fileEdit" && approval.paths.length > 0 ? approval.paths.map(baseName).join(", ") : approval.description || approval.toolName;
      const summary = approval.kind === "fileEdit" ? approval.description : approval.toolName;
      out.approval = { target: clean(target, DETAIL_LIMITS.target) };
      const s = clean(summary, DETAIL_LIMITS.target);
      if (s && s !== out.approval.target) out.approval.summary = s;
    }
    if (this.contextPct !== undefined) out.contextPct = this.contextPct;
    if (this.model !== undefined) out.model = this.model;
    const turns = Math.max(this.tailUsers, this.skeletonUsers.size) + this.liveTurns.size;
    if (turns > 0) out.turns = turns;
    if (this.fileCount > 0) out.files = { count: this.fileCount, names: this.files.slice(0, 3) };
    if (this.suggested !== undefined) out.suggestions = [this.suggested];
    return out;
  }

  private touch(at: number | undefined): void {
    if (at !== undefined && at > this.lastAt) this.lastAt = at;
  }

  private usage(u: unknown): void {
    if (!isObj(u)) return;
    const used = num(u.contextTokens);
    const window = num(u.contextWindow);
    if (used !== undefined && window !== undefined && window > 0) this.contextPct = Math.max(0, Math.min(100, Math.round((used / window) * 100)));
  }

  private snapshot(snap: Obj): void {
    const chat = isObj(snap.chat) ? snap.chat : {};
    const settings = isObj(chat.settings) ? chat.settings : {};
    const model = str(settings.model);
    if (model) this.model = shortModel(model);
    this.touch(num(chat.updatedAt));
    if (isObj(snap.derived)) this.usage(snap.derived.latestAssistantUsage);
    const tail = isObj(snap.tail) ? snap.tail : {};
    const messages = (Array.isArray(tail.messages) ? tail.messages : []).filter(isObj);
    const events = (Array.isArray(tail.events) ? tail.events : []).filter(isObj);
    this.tailUsers = messages.filter((m) => m.role === "user").length;
    this.liveTurns = new Set();
    this.open.clear();
    this.drafts.clear();
    this.failure = undefined;
    for (const m of messages) this.touch(num(m.timestamp));
    for (const e of events) this.touch(num(e.timestamp));
    // The last assistant message with text is the last message; the newest assistant message is the last turn.
    const assistants = messages.filter((m) => m.role === "assistant");
    for (let i = assistants.length - 1; i >= 0; i--) {
      const m = assistants[i] as Obj;
      const text = messageText(m);
      if (asciiFold(text)) {
        this.setMessage(text, num(m.timestamp) ?? 0);
        break;
      }
    }
    const lastTurn = assistants[assistants.length - 1];
    this.files = [];
    this.fileCount = 0;
    if (lastTurn !== undefined) {
      for (const b of (Array.isArray(lastTurn.blocks) ? lastTurn.blocks : []).filter(isObj)) {
        if (b.type === "file_change" && typeof b.filePath === "string" && b.status !== "errored") this.addFile(b.filePath);
        if (b.type === "error" && typeof b.message === "string") this.failure = clean(b.message, DETAIL_LIMITS.failure);
        const blockId = str(b.blockId);
        if (blockId !== undefined && b.status === "streaming") {
          if (b.type === "tool_call" && typeof b.toolName === "string") this.open.set(blockId, activityText(b.toolName, str(b.inputSummary) ?? null));
          if (b.type === "command" && typeof b.command === "string") this.open.set(blockId, activityText("Bash", b.command));
          if (b.type === "file_change" && typeof b.filePath === "string") this.open.set(blockId, activityText("Edit", b.filePath));
        }
      }
    }
    const lastTurnEvent = [...events].reverse().find((e) => typeof e.type === "string" && (e.type === "turn.started" || TERMINAL_TURN_EVENTS.has(e.type)));
    if (lastTurnEvent?.type === "turn.interrupted" || lastTurnEvent?.severity === "error") {
      const meta = isObj(lastTurnEvent.metadata) ? lastTurnEvent.metadata : {};
      const reason = str(meta.reason) ?? str(lastTurnEvent.message);
      if (reason) this.failure = clean(reason, DETAIL_LIMITS.failure);
    }
    const active = isObj(snap.activeTurn) ? str(snap.activeTurn.status) : undefined;
    this.turnRunning = active !== undefined && !["completed", "stopped", "interrupted", "errored"].includes(active);
    this.phase = this.turnRunning ? "thinking" : undefined;
  }

  private skeleton(chunk: unknown): void {
    if (!isObj(chunk) || !Array.isArray(chunk.entries)) return;
    if (chunk.fromOrdinal === 0) this.skeletonUsers.clear();
    for (const e of chunk.entries) {
      if (!isObj(e)) continue;
      this.touch(num(e.createdAt));
      if (e.role === "user" && typeof e.rowId === "string") this.skeletonUsers.add(e.rowId);
    }
  }

  private setMessage(text: string, at: number): void {
    const plain = clean(plainText(text), DETAIL_LIMITS.lastMessage);
    if (plain) this.lastMessage = { text: plain, at, blocks: messageBlocks(text) };
  }

  private addFile(path: string): void {
    const name = cut(asciiFold(baseName(path)), DETAIL_LIMITS.fileName);
    if (this.files.includes(name)) return;
    this.files.push(name);
    this.fileCount += 1;
  }

  private commitDrafts(at: number): void {
    const text = [...this.drafts.values()].join("\n\n");
    this.drafts = new Map();
    if (asciiFold(text)) this.setMessage(text, at);
  }

  private endTurn(): void {
    this.open.clear();
    this.phase = undefined;
    this.turnRunning = false;
  }

  private event(e: Obj, now: number): void {
    const at = num(e.timestamp) ?? now;
    this.touch(at);
    const blockId = str(e.blockId) ?? "";
    const top = e.parentBlockId === undefined || e.parentBlockId === null;
    switch (e.type) {
      case "turn.started": {
        const turnId = str(e.turnId);
        if (turnId !== undefined) this.liveTurns.add(turnId);
        this.failure = undefined;
        this.files = [];
        this.fileCount = 0;
        this.drafts = new Map();
        this.open.clear();
        this.turnRunning = true;
        this.phase = "thinking";
        break;
      }
      case "reasoning.delta":
        this.phase = "thinking";
        break;
      case "text.delta":
        if (!top) break;
        this.drafts.set(blockId, (this.drafts.get(blockId) ?? "") + (str(e.delta) ?? ""));
        this.phase = "writing reply";
        break;
      case "text.completed":
        if (top) this.commitDrafts(at);
        break;
      case "tool_call.started":
        if (typeof e.toolName === "string") this.open.set(blockId, activityText(e.toolName, summaryOf(e.toolName, e.input)));
        break;
      case "command.started":
        if (typeof e.command === "string") this.open.set(blockId, activityText("Bash", e.command));
        break;
      case "file_change.started":
        if (typeof e.filePath === "string") this.open.set(blockId, activityText(e.operation === "create" ? "Write" : "Edit", e.filePath));
        break;
      case "tool_call.completed":
      case "tool_call.errored":
      case "command.completed":
        this.open.delete(blockId);
        break;
      case "file_change.completed":
        this.open.delete(blockId);
        if (typeof e.filePath === "string" && e.reason !== "denied") this.addFile(e.filePath);
        break;
      case "usage.updated":
        this.usage(e.usage);
        break;
      case "turn.completed":
        this.usage(e.usage);
        this.commitDrafts(at);
        this.endTurn();
        break;
      case "turn.stopped":
        this.commitDrafts(at);
        this.endTurn();
        break;
      case "turn.interrupted":
        this.commitDrafts(at);
        if (typeof e.reason === "string") this.failure = clean(e.reason, DETAIL_LIMITS.failure);
        this.endTurn();
        break;
      case "error":
        if (typeof e.message === "string") this.failure = clean(e.message, DETAIL_LIMITS.failure);
        break;
      default:
        break;
    }
  }

  /** `eventAppended`: the chat's own event log (turn lifecycle with a human message). */
  private chatEvent(e: Obj): void {
    this.touch(num(e.timestamp));
    if (e.type === "turn.interrupted" || (typeof e.type === "string" && e.type.startsWith("turn.") && e.severity === "error")) {
      const meta = isObj(e.metadata) ? e.metadata : {};
      const reason = str(meta.reason) ?? str(e.message);
      if (reason) this.failure = clean(reason, DETAIL_LIMITS.failure);
    }
  }

  /** What changes the session as the console shows it; streaming text is not part of it until committed. */
  signature(approval?: PendingApproval): string {
    return JSON.stringify(this.details(approval));
  }
}

/** The best one-liner for `Session.summary` (docs/ux-v2.md section 7.1). */
export function summaryFor(d: SessionDetails, state: string): string | undefined {
  if (state === "approval_required" && d.approval) return d.approval.summary ? `${d.approval.target}: ${d.approval.summary}` : d.approval.target;
  if (state === "working" && d.activity) return d.activity;
  if (state === "failed" && d.failure) return d.failure;
  if (d.lastMessage) return cut(d.lastMessage, 120);
  return d.activity ?? d.failure;
}
