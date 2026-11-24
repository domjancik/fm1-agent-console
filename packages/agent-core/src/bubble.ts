// Protocol version 4 (docs/ui-v3.md sections 5 and 6.3): what the speech bubble and the DETAILS page say for the
// item the screen shows. Shared by the view builder (rows) and the controller (PRESETS clamps).
import { asciiText, bubbleCaption, bubbleLines, CAPTION_MAX, CAPTION_WORDS, cutWords, LIST_HEAD_COLS, resultReason, reviewLabel, wrapWords, BUBBLE_COLS, type BubbleRow } from "./copy";
import { currentView, focusEntry, inboxItemAtCursor, screenOf, suggestionsOf, type ControllerState, type World } from "./context";
import { bubbleInput, detailInput, detailPages4, type TextRow } from "./details";
import { isAttention, rank } from "./focus";
import { taskKey, taskOf } from "./identity";
import type { SessionEntry } from "./registry";
import type { NormalizedState, Task } from "./types";

export type SlotState = "empty" | NormalizedState;

// Higher wins when a task aggregates several sessions.
export const URGENCY: Record<SlotState, number> = {
  approval_required: 8, failed: 7, waiting_input: 6, completed_unread: 5, working: 4,
  idle: 3, completed_read: 2, unknown: 1, disconnected: 0, empty: -1,
};

export function taskSessions(t: Task, w: World): SessionEntry[] {
  const k = taskKey(t.ref);
  return w.registry.sessions().filter((e) => !e.stale && taskKey(taskOf(e.session.ref)) === k);
}

export function taskState(t: Task, w: World): SlotState {
  let best: SlotState = "idle";
  for (const e of taskSessions(t, w)) {
    const st = w.inbox.displayState(e);
    if (URGENCY[st] > URGENCY[best]) best = st;
  }
  return best;
}

export interface Bubble {
  caption: string;
  lines: BubbleRow[];
}

const linkDown = (w: World): boolean => w.registry.connection() === "disconnected";

/** The approval the shown item refers to (TO DO: the item's own; else undefined, and detailInput takes the session's first pending one). */
function approvalOf(s: ControllerState, w: World) {
  const item = s.view === "inbox" ? inboxItemAtCursor(s, w) : undefined;
  return item?.approvalId ? w.registry.approval(item.approvalId) : undefined;
}

/** The chat bubble: caption and every body line, newest content first. */
export function sessionBubble(s: ControllerState, w: World, e: SessionEntry, cols: number = BUBBLE_COLS, oneLine = cols === LIST_HEAD_COLS): Bubble {
  const state = linkDown(w) ? "disconnected" : w.inbox.displayState(e);
  const input = bubbleInput(detailInput(e, state, w, approvalOf(s, w)));
  const next = suggestionsOf(s, e)[0];
  if (next !== undefined) input.suggestion = next;
  // Offline: the caption says so, the body keeps the last thing the chat said. The List / Grouped header shows one line
  // at a time, so a Markdown paragraph gap (an empty row) would only show as an empty message line there: dropped.
  const lines = bubbleLines(input, cols);
  return { caption: bubbleCaption(input), lines: oneLine ? lines.filter((r) => r.text !== "") : lines };
}

/** The task bubble: how many chats need you, the whole title, then one line per chat with its state. */
export function taskBubble(t: Task, w: World): Bubble {
  const sessions = taskSessions(t, w);
  const n = sessions.length;
  const needs = sessions.filter((e) => isAttention(rank(e, w).tier)).length;
  const caption = n === 0 ? "No chats" : needs > 0 ? `${n} ${n === 1 ? "chat" : "chats"}, ${needs} need you` : `${n} ${n === 1 ? "chat" : "chats"}`;
  const lines: BubbleRow[] = wrapWords(t.title, BUBBLE_COLS).map((text) => ({ style: "body" as const, text }));
  const sorted = [...sessions].sort((a, b) => URGENCY[w.inbox.displayState(b)] - URGENCY[w.inbox.displayState(a)]);
  for (const e of sorted) {
    const words = CAPTION_WORDS[w.inbox.displayState(e)];
    const head = asciiText(e.session.title) || "(untitled)";
    const room = BUBBLE_COLS - words.length - 2;
    lines.push({ style: "muted", text: `${head.length <= room ? head : head.slice(0, Math.max(0, room))}: ${words}`.slice(0, BUBBLE_COLS) });
  }
  if (lines.length === 0) lines.push({ style: "muted", text: "No chats yet" });
  return { caption: cutWords(caption, CAPTION_MAX), lines };
}

/**
 * The bubble of the item the base view shows, or null when nothing is selected. In the List layout (version 5) the
 * body is wrapped at 24 for the header's one message line (docs/ui-v3.md section 8.4).
 */
export function focusBubble(s: ControllerState, w: World): Bubble | null {
  if (s.view === "tasks") {
    const t = s.taskCursor === null ? undefined : w.registry.task(s.taskCursor);
    return t ? taskBubble(t, w) : null;
  }
  const e = focusEntry(s, w);
  // The shown view decides: a confirm over the List is drawn as the version 4 bubble (28 columns).
  const screen = screenOf(s, currentView(s, w));
  return e ? sessionBubble(s, w, e, screen === "list" ? LIST_HEAD_COLS : BUBBLE_COLS, screen !== "buddy") : null;
}

/** Voice: the error (failed, target gone) then the transcript (reviewing, submitting, failed); else nothing. */
export function voiceLines(w: Pick<World, "composer" | "backend">): BubbleRow[] {
  const c = w.composer;
  const words = wrapWords(c.transcript, BUBBLE_COLS).map((text): BubbleRow => ({ style: "body", text }));
  // A suggested or canned text (docs/ui-v3.md sections 11-12) carries its label row above it; dictated text keeps the plain body.
  const label = reviewLabel(c);
  if (label !== null && words.length > 0) words.unshift({ style: "heading", text: label });
  if ((c.state === "failed" || c.state === "target_unavailable") && c.error) return [{ style: "muted", text: resultReason(c.error, w.backend) }, ...words];
  if (c.state === "reviewing" || c.state === "submitting" || c.state === "failed") return words;
  return [];
}

/**
 * What the bubble shows, as an identity. PRESETS scroll belongs to it (ControllerState.bubbleFor): when the shown chat,
 * task, TO DO item or voice text changes for any reason (a key, the Mac, an item leaving TO DO), the bubble starts again
 * at the newest content (docs/ui-v3.md section 6.3: "reset on a selection change").
 */
export function bubbleSubject(s: ControllerState, w: World, voice: boolean): string | null {
  if (voice) return `voice:${w.composer.state}:${w.composer.error ?? ""}:${w.composer.transcript}`;
  if (s.view === "tasks") return s.taskCursor === null ? null : `task:${s.taskCursor}`;
  // Version 5: the List header scrolls by lines, the bubble by 5-row steps, so a step never carries across the two.
  const unit = screenOf(s, currentView(s, w)) === "list" ? ":list" : "";
  if (s.view === "inbox") {
    const item = inboxItemAtCursor(s, w);
    return item ? `item:${item.id}${unit}` : null;
  }
  const e = focusEntry(s, w);
  return e ? `chat:${e.key}${unit}` : null;
}

/** The PRESETS step that applies to what the bubble shows now: 0 when it was set for something else. */
export function bubbleScroll(s: ControllerState, w: World, voice: boolean): number {
  return s.bubbleFor !== null && s.bubbleFor === bubbleSubject(s, w, voice) ? s.detailScroll : 0;
}

/** The version 4 DETAILS pages of the shown chat (header on every page, 9 body rows). */
export function detailPagesFor4(s: ControllerState, w: World, e: SessionEntry): TextRow[][] {
  const state = linkDown(w) ? "disconnected" : w.inbox.displayState(e);
  return detailPages4(detailInput(e, state, w, approvalOf(s, w)));
}
