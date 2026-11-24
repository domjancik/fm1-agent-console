// Builds the DeviceView model the companion serialises into SET_* frames. Field limits follow docs/protocol.md;
// wording follows docs/ux-v2.md sections 1.3-1.5 (every string comes from copy.ts).
import type { VoiceState } from "./composer-state";
import { LEGEND } from "./control-map";
import { bubbleScroll, detailPagesFor4, focusBubble, taskSessions, taskState, URGENCY, voiceLines as voiceBubbleLines, type SlotState } from "./bubble";
import {
  ageWhatLine,
  asciiText,
  bubbleRows,
  BUBBLE_BODY_ROWS,
  REVIEW_HINT,
  HEAD4,
  type BubbleRow,
  cutWords,
  GROUP_TITLE,
  groupCount,
  groupedRowTitle,
  groupTitle,
  HINT,
  PINNED_EMPTY,
  hintLine,
  hintLine as hintLineOf,
  LIST_NONE_SELECTED,
  listHeadRows,
  limitedText,
  listTitle,
  offlineText,
  rowAge,
  rowTitle,
  resultReason,
  SCOPE_LABEL,
  TALK_VERB,
  titleSplit,
  VIEW_TITLE,
  whatText,
  wrapWords,
  type HintPair,
} from "./copy";
import {
  can,
  clampPages,
  currentView,
  destinationFor,
  effectiveTalk,
  focusEntry,
  inboxItemAtCursor,
  inboxPage,
  layoutOf,
  pageCount,
  pendingApproval,
  screenOf,
  sessionsGrouped,
  splitSessions,
  suggestionsOf,
  type ScreenLayout,
  sessionPage,
  talkCapability,
  talkModes,
  taskPage,
  visibleTasks,
  type ControllerState,
  type ViewName,
  type World,
} from "./context";
import { detailInput, detailRows, detailTitle, padPage, paginate, scrollTail, type TextRow } from "./details";
import { isAttention, NEW_GROUP, PINNED_GROUP, rank, SCOPE_MAX_TIER, scopeMembers, taskGroup } from "./focus";
import { isSessionKey, isTaskKey, sessionKey, taskKey, taskOf } from "./identity";
import type { InboxItem, InboxKind } from "./inbox";
import type { SessionEntry } from "./registry";
import { acceptsPrompt, activityAt, effectiveState, isInferred, isInterruptible } from "./status";
import type { ApprovalRequest } from "./types";
import {
  BLACK_KEYS,
  FILTER_NAME,
  FILTER_OF,
  FILTER_TAG,
  SETTINGS_HINT,
  SETTINGS_TITLE,
  settingsItems,
  settingsRow,
  TASK_KEYS,
  taskPageCount,
  taskRowPage,
  taskTags,
  whiteCount,
  whiteList,
  type KeyMode,
  type SplitState,
} from "./split";
import type { NormalizedState, Provider } from "./types";

export type { SlotState };
export type Lines4 = [string, string, string, string];
export type Legend4 = [string, string, string, string];

export interface SlotView {
  state: SlotState;
  label: string;
  selected: boolean;
  provider: Provider | null;
  stale: boolean;
  /** Slot flag bit 3 (protocol v2 draws a bar). */
  pinned: boolean;
  /** Protocol version 5 (docs/ui-v3.md section 8.6): the list row's title (<= 20) and age (<= 3). Absent below 5. */
  title?: string;
  age?: string;
  /** Version 5 GROUPED (docs/ui-v3.md section 9.5): the row byte; present on every slot while Sessions is Grouped. */
  row?: { indent: 0 | 1 | 2; start: boolean; task: boolean };
  /** The group header drawn before this row (exactly when `row.start`). */
  head?: { state: SlotState; pinned: boolean; title: string; count: string };
  /** Protocol version 6 SPLIT (docs/ui-v3.md section 10.6): flag bit 4, the chosen filter or task key. Never with `selected`. */
  chosen?: boolean;
}

export interface DeviceView {
  view: ViewName;
  page: number;
  pages: number;
  title: string;
  slots: SlotView[];
  detail: { provider: Provider | null; state: SlotState; lines: Lines4 };
  voice: { state: VoiceState; level: number; elapsedDs: number; target: string };
  legend: Legend4;
  status: { link: "ok" | "degraded" | "down"; attentionCount: number; text: string };
  /** The DETAILS page rows (12, docs/ux-v2.md section 7.4) while `view` is `detail`; null otherwise. */
  text: TextRow[] | null;
  /**
   * Protocol version 5: the SET_VIEW layout byte (docs/ui-v3.md section 8.6) - the base view's layout in Sessions and
   * TO DO, `buddy` in every other view. null below version 5 (no layout byte on the wire).
   */
  layout: ScreenLayout | null;
  /**
   * Protocol version 6 (docs/ui-v3.md section 10.6): the SET_VIEW keys byte - `split` exactly while the 27 slots hold the
   * SPLIT assignment, with the task page and the task page count. null (or absent) below version 6.
   */
  keys?: KeyMode | null;
  taskPage?: number;
  taskPages?: number;
}

export const LIMITS = { title: 20, label: 12, line: 20, legend: 6, target: 20, status: 20 } as const;

export const clip = (s: string, n: number): string => s.replace(/[^\x20-\x7e]/g, "?").slice(0, n);

const EMPTY_SLOT: SlotView = { state: "empty", label: "", selected: false, provider: null, stale: false, pinned: false };
const KIND_STATE: Record<InboxKind, NormalizedState> = {
  approval: "approval_required",
  question: "waiting_input",
  failure: "failed",
  completed: "completed_unread",
};
/** The slot label: the title head, 12 characters (11 with protocol version 4, drawn in FONT_L beside the hero). */
const head = (title: string, v4 = false): string => titleSplit(title, v4 ? HEAD4 : LIMITS.label).head;

export function buildView(s0: ControllerState, w: World): DeviceView {
  const s = clampPages(s0, w);
  const view = currentView(s, w);
  const linkDown = w.registry.connection() === "disconnected";
  const base = s.view;
  const split = splitSessions(s);
  const slots = base === "sessions" ? sessionSlots(s, w, linkDown) : base === "tasks" ? taskSlots(s, w) : inboxSlots(s, w);
  const c = w.composer;
  const degraded = w.registry.connection() === "degraded" || !w.registry.ready();
  const details = view === "detail" ? detailPage(s, w) : null;
  const settings = view === "settings" ? settingsItems(s.keyMode) : null;
  const text = details ? details.rows : settings ? settingsText(s, settings) : s.bubble ? bubbleText(view, s, w) : null;
  const rows = s.listLayout ? listRowFields(base, s, w) : null;
  const grouped = base === "sessions" && sessionsGrouped(s) ? groupedRows(s, w) : null;
  let merged = rows ? slots.map((sl, k) => ({ ...sl, ...(rows[k] ?? NO_ROW), ...(grouped?.[k] ?? {}) })) : slots;
  // SPLIT: the black row over the white keys (docs/ui-v3.md section 10.6); Grouped gives every view 0 slot its row byte.
  if (split) {
    const black = blackSlots(s, w, linkDown);
    merged = merged.map((sl, k) => {
      const b = black.get(k);
      if (!b) return sl;
      return grouped?.[k]?.row ? { ...b, row: { indent: 0, start: false, task: false } } : b;
    });
  }
  return {
    view,
    page: details ? details.page : settings ? s.settingsCursor : s.pages[base],
    pages: details ? details.pages : settings ? settings.length : pageCount(s, w, base),
    title: clip(details ? details.title : titleFor(view, s, w), LIMITS.title),
    slots: merged,
    detail: detailFor(view, s, w, linkDown),
    voice: { state: c.state, level: c.level, elapsedDs: Math.min(c.elapsedDs, 16383), target: clip(c.destination?.label ?? "", LIMITS.target) },
    legend: legendFor(view, s, w).map((l) => clip(l, LIMITS.legend)) as Legend4,
    status: {
      link: linkDown ? "down" : degraded ? "degraded" : "ok",
      attentionCount: Math.min(127, w.inbox.attentionCount(w.now)),
      text: linkDown ? offlineText(w.backend) : degraded ? limitedText(w.backend) : "",
    },
    text,
    layout: s.listLayout ? screenOf(s, view) : null,
    ...(s.splitProto ? (split ? { keys: "split" as const, taskPage: s.split.taskPage, taskPages: taskPageCount(s.taskRow) } : { keys: "ranked" as const }) : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Protocol version 6 (docs/ui-v3.md section 10): SETTINGS rows and the SPLIT black row.

/** SETTINGS SET_TEXT: rows 0-8 the items (26 wide), row 9 the cursor item's description (muted), rows 10-11 empty. */
function settingsText(s: ControllerState, items: ReturnType<typeof settingsItems>): TextRow[] {
  const rows: TextRow[] = Array.from({ length: 9 }, (_, n) => ({ style: "body" as const, text: items[n] ? settingsRow(items[n]) : "" }));
  rows.push({ style: "muted", text: clip(items[s.settingsCursor]?.description ?? "", 29) });
  return padPage(rows);
}

/** The most urgent display state of a set of sessions; `none` when empty. */
function urgentState(keys: readonly string[], w: World, none: SlotState): SlotState {
  let best: SlotState | null = null;
  for (const k of keys) {
    const e = w.registry.get(k);
    if (!e || e.stale) continue;
    const st = w.inbox.displayState(e);
    if (best === null || URGENCY[st] > URGENCY[best]) best = st;
  }
  return best ?? none;
}

/** The 11 black-key slots (docs/ui-v3.md sections 10.3, 10.6, 10.8): filters, then the shown task page. */
function blackSlots(s: ControllerState, w: World, linkDown: boolean): Map<number, SlotView> {
  const out = new Map<number, SlotView>();
  const grouped = sessionsGrouped(s);
  const chosen = s.split;
  const blank = (k: number): void => void out.set(k, { ...EMPTY_SLOT, title: "", age: "" });
  for (const k of [1, 3, 5]) {
    const f = FILTER_OF[k];
    if (!f) continue;
    let state: SlotState = "idle";
    if (f === "pinned") state = s.pins.some(isSessionKey) ? "idle" : "empty";
    if (f === "needs") state = linkDown ? "disconnected" : urgentState(whiteList(s, w, false, { ...chosen, chosen: "needs", task: null }).keys, w, "empty");
    out.set(k, { state, label: FILTER_TAG[f], selected: false, provider: null, stale: false, pinned: false, chosen: chosen.chosen === f, title: FILTER_NAME[f], age: "" });
  }
  const page = taskRowPage(s.taskRow, s.split.taskPage);
  const tasks = page.map((tk) => (tk === null ? undefined : w.registry.task(tk)));
  const tags = taskTags(tasks.map((t) => (t ? t.title : null)));
  TASK_KEYS.forEach((k, j) => {
    const tk = page[j] ?? null;
    const t = tasks[j];
    if (tk === null || !t) return blank(k);
    const pinned = s.pins.includes(tk);
    const shown = whiteList(s, w, grouped, { ...chosen, chosen: "task", task: tk }).keys;
    // A task whose last session went keeps its key, calm, until the next re-sort; a pinned task with none is idle.
    const state: SlotState = linkDown ? "disconnected" : urgentState(shown, w, pinned ? "idle" : "disconnected");
    out.set(k, {
      state,
      label: tags[j] ?? "?",
      selected: false,
      provider: null,
      stale: false,
      pinned,
      chosen: chosen.chosen === "task" && chosen.task === tk,
      title: rowTitle(t.title),
      age: rowAge(w.now - taskActivity(tk, w)),
    });
  });
  for (const k of BLACK_KEYS) if (!out.has(k)) blank(k);
  return out;
}

/** SPLIT Sessions title (docs/ui-v3.md section 10.9). */
function splitTitle(s: ControllerState, w: World): string {
  const n = whiteCount(whiteList(s, w, sessionsGrouped(s)));
  const pending = layoutOf(s, "sessions").pendingNew;
  const c: SplitState = s.split;
  if (c.chosen === "all") return listTitle(SCOPE_LABEL[s.scope], scopeMembers({ ...s, taskFilter: null }, w).length, pending, s.repoFilter === null ? undefined : repoName(s.repoFilter, w));
  if (c.chosen === "pinned") return listTitle("PINNED", n, pending);
  if (c.chosen === "needs") return listTitle("NEEDS YOU", n, pending);
  const title = asciiText(c.task === null ? "" : (w.registry.task(c.task)?.title ?? ""));
  const tail = ` ${n}${pending > 0 ? ` +${pending} new` : ""}`;
  return `${cutWords(title, Math.max(1, LIMITS.title - tail.length)) || "(untitled)"}${tail}`.slice(0, LIMITS.title);
}

/** SPLIT with an empty white list (docs/ui-v3.md section 10.9): the bubble / List header's two lines. */
function splitEmptyRows(s: ControllerState, w: World): [string, string] | null {
  if (whiteCount(whiteList(s, w, sessionsGrouped(s))) > 0) return null;
  if (s.split.chosen === "pinned") return [PINNED_EMPTY[0], PINNED_EMPTY[1]];
  if (s.split.chosen === "needs") return ["Nothing needs you", "tap ALL or a task"];
  return ["No chats here", "KNOB1 shows more"];
}

/** The DETAILS page for the shown chat (docs/ux-v2.md section 7.5): the page clamped, 12 rows. */
function detailPage(s: ControllerState, w: World): { page: number; pages: number; title: string; rows: TextRow[] } {
  const e = focusEntry(s, w);
  if (!e) return { page: 0, pages: 1, title: "DETAILS", rows: padPage([{ style: "muted", text: "nothing selected" }]) };
  const item = s.view === "inbox" ? inboxItemAtCursor(s, w) : undefined;
  const approval = item?.approvalId ? w.registry.approval(item.approvalId) : undefined;
  const linkDown = w.registry.connection() === "disconnected";
  const state = linkDown ? "disconnected" : w.inbox.displayState(e);
  const pages = s.bubble ? detailPagesFor4(s, w, e) : paginate(detailRows(detailInput(e, state, w, approval)));
  const page = Math.max(0, Math.min(pages.length - 1, s.detail ?? 0));
  return { page, pages: pages.length, title: detailTitle(e.session.title), rows: padPage(pages[page]) };
}

function slotFor(e: SessionEntry, s: ControllerState, w: World, selectedKey: string | null, linkDown: boolean): SlotView {
  return {
    state: linkDown ? "disconnected" : w.inbox.displayState(e),
    label: clip(head(e.session.title, s.bubble), LIMITS.label),
    selected: e.key === selectedKey,
    provider: e.session.provider,
    stale: e.stale,
    // Only a session pin (operator decision 2026-11-19: task pins take no session key and do not mark its sessions).
    pinned: s.pins.includes(e.key),
  };
}

function sessionSlots(s: ControllerState, w: World, linkDown: boolean): SlotView[] {
  const sel = w.registry.selection().key;
  return sessionPage(s).map((k) => {
    if (k !== null && isTaskKey(k)) return foldedSlot(k, s, w, linkDown);
    const e = k === null ? undefined : w.registry.get(k);
    return e ? slotFor(e, s, w, sel, linkDown) : EMPTY_SLOT;
  });
}

/** GROUPED folded task row (docs/ui-v3.md section 9.5): the slot carries the task; never selected. */
function foldedSlot(tk: string, s: ControllerState, w: World, linkDown: boolean): SlotView {
  const t = w.registry.task(tk);
  if (!t) return EMPTY_SLOT;
  const state = linkDown ? "disconnected" : groupInfo(taskGroup(tk), s, w).state;
  return { state, label: clip(head(t.title, s.bubble), LIMITS.label), selected: false, provider: null, stale: false, pinned: s.pins.includes(tk) };
}

function taskSlots(s: ControllerState, w: World): SlotView[] {
  return taskPage(s, w).map((t) =>
    t ? { state: taskState(t, w), label: clip(head(t.title, s.bubble), LIMITS.label), selected: taskKey(t.ref) === s.taskCursor, provider: null, stale: false, pinned: false } : EMPTY_SLOT,
  );
}

function inboxSlots(s: ControllerState, w: World): SlotView[] {
  return inboxPage(s, w).map((i: InboxItem | null) => {
    if (!i) return EMPTY_SLOT;
    const e = w.registry.get(i.sessionKey);
    // An item that left the inbox keeps its key with the session's new state (crossed when the session is gone).
    const gone = w.inbox.get(i.id) === undefined;
    const state: SlotState = gone && e ? w.inbox.displayState(e) : i.kind === "completed" && i.read ? "completed_read" : KIND_STATE[i.kind];
    const label = head(e?.session.title ?? i.summary, s.bubble);
    return { state, label: clip(label, LIMITS.label), selected: i.id === s.inboxCursor, provider: e?.session.provider ?? null, stale: e?.stale ?? true, pinned: s.pins.includes(i.sessionKey) };
  });
}

function filterName(s: ControllerState, w: World): string | undefined {
  if (s.scope === "pinned") return undefined; // PINNED ignores REPO and TASK (section 9.4)
  if (s.taskFilter !== null) return w.registry.task(s.taskFilter)?.title;
  if (s.repoFilter !== null) return repoName(s.repoFilter, w);
  return undefined;
}

const repoName = (id: string, w: World): string => w.registry.projects().find((p) => p.projectId === id)?.name ?? id;

function titleFor(view: ViewName, s: ControllerState, w: World): string {
  switch (view) {
    case "settings":
      return SETTINGS_TITLE;
    case "confirm":
      return VIEW_TITLE.confirm;
    case "voice":
      return VIEW_TITLE.voice;
    case "detail":
      return "DETAILS";
    case "tasks":
      return listTitle(VIEW_TITLE.tasks, visibleTasks(s, w).length, 0, s.repoFilter === null || s.scope === "pinned" ? undefined : repoName(s.repoFilter, w));
    case "inbox":
      return listTitle(VIEW_TITLE.todo, w.inbox.attentionCount(w.now), layoutOf(s, "inbox").pendingNew);
    case "sessions":
      if (splitSessions(s)) return splitTitle(s, w);
      return listTitle(SCOPE_LABEL[s.scope], scopeMembers(s, w).length, layoutOf(s, "sessions").pendingNew, filterName(s, w));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Protocol version 5 (docs/ui-v3.md section 8): the list row fields of every slot, in every view and layout.

interface RowFields {
  title: string;
  age: string;
}
const NO_ROW: RowFields = { title: "", age: "" };

/** The instant the bubble caption's age refers to: the pending approval, else the chat's last activity. */
function rowFor(e: SessionEntry, w: World, approval: ApprovalRequest | undefined): RowFields {
  const at = (approval ?? w.registry.approvalsFor(e.key)[0])?.createdAt ?? activityAt(e.session);
  return { title: rowTitle(e.session.title), age: e.stale ? "" : rowAge(w.now - at) };
}

function listRowFields(base: "sessions" | "tasks" | "inbox", s: ControllerState, w: World): RowFields[] {
  if (base === "tasks") return taskPage(s, w).map((t) => (t ? { title: rowTitle(t.title), age: rowAge(w.now - t.updatedAt) } : NO_ROW));
  if (base === "inbox") {
    return inboxPage(s, w).map((i: InboxItem | null) => {
      if (!i) return NO_ROW;
      const e = w.registry.get(i.sessionKey);
      // The session is gone: the slot is stale, so the row has no age (docs/ui-v3.md section 8.6).
      if (!e) return { title: rowTitle(i.summary), age: "" };
      return rowFor(e, w, i.approvalId ? w.registry.approval(i.approvalId) : undefined);
    });
  }
  return sessionPage(s).map((k) => {
    if (k !== null && isTaskKey(k)) {
      const t = w.registry.task(k);
      return t ? { title: rowTitle(t.title), age: rowAge(w.now - taskActivity(k, w)) } : NO_ROW;
    }
    const e = k === null ? undefined : w.registry.get(k);
    return e ? rowFor(e, w, undefined) : NO_ROW;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Version 5 GROUPED (docs/ui-v3.md sections 9.2-9.5): the row byte and the group headers of the shown page.

type GroupRow = Pick<SlotView, "row" | "head" | "title">;
interface GroupInfo {
  state: SlotState;
  pinned: boolean;
  title: string;
  count: string;
}

/** The newest activity of a task: its newest live session, else the task's own update time. */
function taskActivity(tk: string, w: World): number {
  const t = w.registry.task(tk);
  let at = t?.updatedAt ?? 0;
  if (t) for (const e of taskSessions(t, w)) at = Math.max(at, activityAt(e.session));
  return at;
}

/** A group's header: the most urgent display state, the pinned flag, the title and the count (section 9.2). */
function groupInfo(gid: string, s: ControllerState, w: World): GroupInfo {
  const layout = layoutOf(s, "sessions");
  const folded = gid.startsWith("task:") && layout.keys().includes(gid.slice(5));
  let members: SessionEntry[];
  let title: string;
  let pinned = false;
  if (gid.startsWith("task:")) {
    const tk = gid.slice(5);
    const t = w.registry.task(tk);
    title = t?.title ?? "";
    pinned = s.pins.includes(tk);
    // A folded row counts the task's sessions in the scope; an expanded group the keys laid out in it.
    members = folded
      ? (t ? taskSessions(t, w).filter((e) => rank(e, w).tier <= SCOPE_MAX_TIER[s.scope]) : [])
      : keyedMembers(layout.keys(), (k) => layout.group(k) === gid, w);
  } else {
    title = gid === PINNED_GROUP ? GROUP_TITLE.pinned : GROUP_TITLE.new;
    pinned = gid === PINNED_GROUP;
    members = keyedMembers(layout.keys(), (k) => (layout.group(k) ?? NEW_GROUP) === gid, w);
  }
  let state: SlotState = "idle";
  let found = false;
  for (const e of members) {
    const st = w.inbox.displayState(e);
    if (!found || URGENCY[st] > URGENCY[state]) state = st;
    found = true;
  }
  const count = groupCount({
    attention: members.filter((e) => isAttention(rank(e, w).tier)).length,
    working: members.filter((e) => w.inbox.displayState(e) === "working").length,
    total: members.length,
    folded,
  });
  return { state, pinned, title: groupTitle(title, count), count };
}

function keyedMembers(keys: readonly (string | null)[], pick: (k: string) => boolean, w: World): SessionEntry[] {
  const out: SessionEntry[] = [];
  for (const k of keys) {
    if (k === null || isTaskKey(k) || !pick(k)) continue;
    const e = w.registry.get(k);
    if (e && !e.stale) out.push(e);
  }
  return out;
}

/** Row byte, header and indent-cut title of every key of the shown Sessions page (Grouped). */
function groupedRows(s: ControllerState, w: World): GroupRow[] {
  const layout = layoutOf(s, "sessions");
  const page = sessionPage(s);
  const infos = new Map<string, GroupInfo>();
  const info = (gid: string): GroupInfo => {
    let i = infos.get(gid);
    if (!i) {
      i = groupInfo(gid, s, w);
      infos.set(gid, i);
    }
    return i;
  };
  let prev: string | null = null;
  return page.map((k) => {
    if (k === null) return { row: { indent: 0, start: false, task: false } };
    const gid = layout.group(k) ?? NEW_GROUP;
    const task = isTaskKey(k);
    const start = task || gid !== prev;
    prev = gid;
    if (task) {
      const i = info(gid);
      return { row: { indent: 0, start: true, task: true }, head: { state: i.state, pinned: i.pinned, title: i.title, count: i.count } };
    }
    const e = w.registry.get(k);
    const parent = e?.session.parentKey;
    const indent: 1 | 2 = parent !== undefined && parent !== k && layout.group(parent) === gid && layout.indexOf(parent) >= 0 ? 2 : 1;
    const out: GroupRow = { row: { indent, start, task: false }, title: groupedRowTitle(e?.session.title, indent) };
    if (start) {
      const i = info(gid);
      out.head = { state: i.state, pinned: i.pinned, title: i.title, count: i.count };
    }
    return out;
  });
}

/** The SEQ verb: the layout SEQ goes to next (docs/ui-v3.md section 9.11). */
const SEQ_VERB: Record<ScreenLayout, string> = { buddy: "list", list: "group", grouped: "buddy" };

/** Version 5, Sessions and TO DO: the SEQ pair, appended last so hintLine drops it first (docs/ui-v3.md section 8.8). */
function seqPair(s: ControllerState, view: ViewName): HintPair[] {
  if (!s.listLayout || (view !== "sessions" && view !== "inbox")) return [];
  const cur = screenOf(s, view);
  return [["SEQ", view === "inbox" ? (cur === "list" ? "buddy" : "list") : SEQ_VERB[cur]]];
}

/** Version 5: the bubble (Buddy row 6) or the List/Grouped header (row 2) has more than it shows. */
function bubbleHasMore(s: ControllerState, w: World, view: ViewName): boolean {
  const rows = bubbleText(view, s, w);
  if (screenOf(s, view) !== "buddy") return rows[2]?.text ? true : false;
  return (view === "sessions" && splitSessions(s) ? rows[5]?.text : rows[6]?.text) ? true : false;
}

const pad4 = (lines: readonly string[]): Lines4 => {
  const l = lines.map((x) => clip(x, LIMITS.line));
  return [l[0] ?? "", l[1] ?? "", l[2] ?? "", l[3] ?? ""];
};

const NONE_SELECTED: Lines4 = pad4([HINT.noSelection[0], HINT.noSelection[1], "", HINT.help]);
/** Version 4: the bubble says how to select, so the lines beside the (absent) hero stay empty. */
const NONE_SELECTED4: Lines4 = pad4(["", "", "", HINT.help]);

function detailFor(view: ViewName, s: ControllerState, w: World, linkDown: boolean): DeviceView["detail"] {
  if (view === "settings") return { provider: null, state: "empty", lines: pad4(["", "", "", SETTINGS_HINT]) };
  if (view === "confirm" && s.confirm) return { ...heroOf(s, w, s.confirm.type === "interrupt" || s.confirm.type === "approve" || s.confirm.type === "deny" ? s.confirm.key : null), lines: confirmLines(s, w) };
  if (view === "voice") return { ...heroOf(s, w, voiceTargetKey(s, w)), lines: voiceLines(s, w) };
  if (view === "tasks") return taskDetail(s, w);
  const e = focusEntry(s, w);
  if (!e) {
    // SPLIT, nothing selected (docs/ui-v3.md section 10.11): the settings entry instead of the SEQ pair.
    if (view === "sessions" && splitSessions(s)) return { provider: null, state: "empty", lines: pad4(["", "", "", "SCL help  ARP setup"]) };
    const seq = seqPair(s, view);
    if (seq.length > 0) return { provider: null, state: "empty", lines: pad4(["", "", "", hintLine([...seq, ["SCL", "help"]])]) };
    return { provider: null, state: "empty", lines: s.bubble ? NONE_SELECTED4 : NONE_SELECTED };
  }
  return sessionDetail(s, w, e, s.view === "inbox" ? inboxItemAtCursor(s, w) : undefined, linkDown, view);
}

function sessionDetail(s: ControllerState, w: World, e: SessionEntry, item: InboxItem | undefined, linkDown: boolean, view: ViewName): DeviceView["detail"] {
  const state: SlotState = linkDown ? "disconnected" : w.inbox.displayState(e);
  const split = titleSplit(e.session.title);
  const taskTitle = asciiText(w.registry.task(taskKey(taskOf(e.session.ref)))?.title ?? "");
  let [l1, l2] = split.rest;
  let taskShown = false;
  if (!l1 && taskTitle) [l1, taskShown] = [cutWords(taskTitle, LIMITS.line), true];
  else if (!l2 && taskTitle) [l2, taskShown] = [cutWords(taskTitle, LIMITS.line), true];
  const approval = item?.approvalId ? w.registry.approval(item.approvalId) : w.registry.approvalsFor(e.key)[0];
  const at = approval?.createdAt ?? activityAt(e.session);
  const what = whatText({
    backend: w.backend,
    state: state === "disconnected" ? effectiveState(e.session.status) : state,
    stale: e.stale,
    summary: e.session.summary,
    approvalSummary: approval?.summary,
    detail: e.session.status.observed.detail,
    taskTitle: taskShown ? undefined : taskTitle,
  });
  const inferred = isInferred(e.session.status);
  const l3 = ageWhatLine(w.now - at, what, inferred, e.stale);
  const hint = sessionHint(s, w, e, state, item, linkDown, seqPair(s, view), s.listLayout && s.detailsPage && (view === "sessions" || view === "inbox"), s.listLayout && bubbleHasMore(s, w, view));
  // Version 4: line 1 is the rest of the title beside the hero; the bubble (SET_TEXT) carries everything else.
  if (s.bubble) {
    const rest = cutWords(titleSplit(e.session.title, HEAD4).remainder, LIMITS.line);
    return { provider: e.session.provider, state, lines: pad4([rest || cutWords(taskTitle, LIMITS.line), "", "", hint]) };
  }
  let body = [l1, l2, l3];
  if (s.detailScroll > 0) {
    // PRESETS walks the title, the task, line 3, then the chat details (docs/ux-v2.md section 7.2).
    const full = [
      ...wrapWords(split.remainder, LIMITS.line),
      ...(taskShown ? [cutWords(taskTitle, LIMITS.line)] : []),
      ...wrapWords(l3, LIMITS.line),
      ...wrapWords(what, LIMITS.line).slice(1),
      ...scrollTail(e.session.provider, e.session.details, LIMITS.line).filter((l) => !what.includes(l)),
    ];
    const start = Math.min(s.detailScroll, Math.max(0, full.length - 3));
    body = full.slice(start, start + 3);
  }
  return { provider: e.session.provider, state, lines: pad4([...body.concat(["", "", ""]).slice(0, 3), hint]) };
}

/** Line 4: the buttons that act on the selected item now (docs/ux-v2.md section 2.3). */
function sessionHint(
  s: ControllerState,
  w: World,
  e: SessionEntry,
  state: SlotState,
  item: InboxItem | undefined,
  linkDown: boolean,
  seq: HintPair[] = [],
  reader = false,
  more = false,
): string {
  // Version 5 extras: `PRESETS read` (the reader, section 9.8) and the SEQ pair. They go last, each only where it fits
  // after the action pairs shown intact and double-spaced: they never squeeze or drop the actions. Exception (section
  // 9.11): when the bubble has more than it shows and nothing awaits an answer, `PRESETS read` goes first.
  const extras: HintPair[] = [...(reader ? [["PRESETS", "read"] as HintPair] : []), ...seq];
  const hintLine = (pairs: readonly HintPair[], answer = false): string => {
    if (reader && more && !answer) return hintLineOf([["PRESETS", "read"], ...pairs]);
    let line = hintLineOf(pairs);
    let intact = line === pairs.map(([b, v]) => `${b} ${v}`).join("  ");
    for (const x of extras) {
      if (!intact) break;
      const tail = hintLineOf([x]);
      const joined = line ? `${line}  ${tail}` : tail;
      if (joined.length > LIMITS.line) continue;
      line = joined;
    }
    return line;
  };
  // The button that re-sorts the current view: HOME in Sessions, GLO in TO DO (HOME there leaves TO DO).
  if (linkDown || e.stale || state === "disconnected") return hintLine([[s.view === "inbox" ? "GLO" : "HOME", "re-sorts"]]);
  const approval = pendingApproval(s, w);
  if (approval && can(w, "respondToApproval")) return hintLine([["SAVE", "approve"], ["FX", "deny"]], true);
  const open: HintPair[] = can(w, "focus") ? [["PLAY", "open"]] : [];
  if (item && item.kind !== "approval" && w.inbox.get(item.id)) return hintLine([["FX", "dismiss"], ...open]);
  const talk = effectiveTalk(s);
  const live = state as NormalizedState;
  // A session that takes no console prompts (session.prompt, docs/ui-v3.md section 9.7) shows no REC for a reply.
  const recOk = can(w, talkCapability(talk)) && (talk !== "reply" || (acceptsPrompt(live) && e.session.prompt?.acceptsPrompt !== false)) && destinationFor(s, w) !== null;
  // A reply with a suggested next prompt (docs/ui-v3.md section 11): `REC next` (a tap loads it; a hold still talks).
  const rec: HintPair[] = recOk ? [["REC", talk === "reply" && suggestionsOf(s, e).length > 0 ? "next" : TALK_VERB[talk]]] : [];
  const stop: HintPair[] = can(w, "interrupt") && isInterruptible(live) ? [["ENV", "stop"]] : [];
  if (live === "working" || live === "approval_required") return hintLine([...stop, ...open]) || HINT.help;
  return hintLine([...rec, ...open], live === "waiting_input") || HINT.help;
}

function taskDetail(s: ControllerState, w: World): DeviceView["detail"] {
  const t = s.taskCursor === null ? undefined : w.registry.task(s.taskCursor);
  if (!t) return { provider: null, state: "empty", lines: s.bubble ? NONE_SELECTED4 : NONE_SELECTED };
  const split = titleSplit(t.title);
  const sessions = taskSessions(t, w);
  const n = sessions.length;
  const needs = sessions.filter((e) => isAttention(rank(e, w).tier)).length;
  const working = sessions.filter((e) => w.inbox.displayState(e) === "working").length;
  const chats = `${n} ${n === 1 ? "chat" : "chats"}`;
  const l3 = needs > 0 ? `${chats}, ${needs} needs you` : working > 0 ? `${chats}, ${working} working` : `${chats}, all quiet`;
  const talk = effectiveTalk(s);
  const pairs: HintPair[] = [];
  if (can(w, "createSession")) pairs.push(["PLAY", "new chat"]);
  if (can(w, talkCapability(talk))) pairs.push(["REC", talk === "reply" ? "talk" : TALK_VERB[talk]]);
  if (s.bubble) return { provider: null, state: taskState(t, w), lines: pad4([cutWords(titleSplit(t.title, HEAD4).remainder, LIMITS.line), "", "", hintLine(pairs) || HINT.help]) };
  return { provider: null, state: taskState(t, w), lines: pad4([split.rest[0], split.rest[1], cutWords(l3, LIMITS.line), hintLine(pairs) || HINT.help]) };
}

const CONFIRM_VERB = {
  approve: "Approve?",
  deny: "Deny?",
  interrupt: "Stop this agent?",
  createSession: "Start new chat?",
  voiceSubmit: "Create new task?",
} as const;

function confirmLines(s: ControllerState, w: World): Lines4 {
  const c = s.confirm;
  if (!c) return pad4([]);
  const wrapped = wrapWords(c.label, LIMITS.line);
  const l2 = wrapped[0] ?? "";
  const l3 = cutWords(wrapped.slice(1).join(" "), LIMITS.line);
  let l4 = "";
  if (c.type === "interrupt" || c.type === "approve" || c.type === "deny") {
    const e = w.registry.get(c.key);
    if (e) {
      const approval = c.type === "interrupt" ? undefined : w.registry.approval(c.approvalId);
      const at = approval?.createdAt ?? activityAt(e.session);
      const what = whatText({ backend: w.backend, state: effectiveState(e.session.status), stale: e.stale, summary: e.session.summary, approvalSummary: approval?.summary, detail: e.session.status.observed.detail });
      l4 = ageWhatLine(w.now - at, what, isInferred(e.session.status), e.stale);
    }
  } else if (c.type === "createSession") {
    l4 = c.provider === "codex" ? "Codex chat" : "Claude chat";
  } else {
    l4 = cutWords(asciiText(w.composer.transcript), LIMITS.line);
  }
  return pad4([CONFIRM_VERB[c.type], l2, l3, l4]);
}

function voiceLines(s: ControllerState, w: World): Lines4 {
  const c = w.composer;
  const text = wrapWords(c.transcript, LIMITS.line);
  const words = [...text];
  if (c.source === "suggested" && words.length > 0) words.unshift(c.suggestion && c.suggestion.count > 1 ? `Suggested ${c.suggestion.index + 1}/${c.suggestion.count}` : "Suggested");
  if (c.source === "canned" && words.length > 0) words.unshift(c.suggestion && c.suggestion.count > 1 ? `Canned ${c.suggestion.index + 1}/${c.suggestion.count}` : "Canned");
  const start = Math.min(s.detailScroll, Math.max(0, words.length - 2));
  let body = words.slice(start, start + 2);
  if ((c.state === "failed" || c.state === "target_unavailable") && c.error) body = [resultReason(c.error, w.backend), text[0] ?? ""];
  const hint =
    c.state === "recording" ? HINT.recording
    : c.state === "transcribing" ? HINT.transcribing
    : c.state === "reviewing" ? HINT.reviewing
    : c.state === "submitting" ? HINT.submitting
    : c.state === "failed" && c.retryable ? HINT.failedRetry
    : c.state === "failed" || c.state === "target_unavailable" ? HINT.close
    : "";
  // Version 4: the transcript or the error goes in the bubble (SET_TEXT rows 1-5), lines 1-3 stay empty.
  if (s.bubble) return pad4(["", "", "", hint]);
  return pad4([body[0] ?? "", body[1] ?? "", "", hint]);
}

// ---------------------------------------------------------------------------------------------------------------
// Protocol version 4 (docs/ui-v3.md sections 5 and 6.3).

const EMPTY_ROW: TextRow = { style: "body", text: "" };

/** 12 SET_TEXT rows: the 7 bubble rows, then empty rows 7-11. */
const pad12 = (rows: readonly BubbleRow[]): TextRow[] => padPage(rows.map((r) => ({ ...r })));

/** Who the hero shows: the target chat's character (provider and state), or nobody. */
function heroOf(s: ControllerState, w: World, key: string | null): { provider: Provider | null; state: SlotState } {
  const e = s.bubble && key !== null ? w.registry.get(key) : undefined;
  if (!e) return { provider: null, state: "unknown" };
  return { provider: e.session.provider, state: w.registry.connection() === "disconnected" ? "disconnected" : w.inbox.displayState(e) };
}

/** The chat a voice reply goes to (reply mode only), else null. */
function voiceTargetKey(s: ControllerState, w: World): string | null {
  const d = w.composer.destination;
  if (!d || d.mode !== "continue-session") return null;
  return sessionKey(d.target);
}

/** SET_TEXT in the base views, voice and confirm when version 4 was agreed (the bubble). */
function bubbleText(view: ViewName, s: ControllerState, w: World): TextRow[] {
  if (view === "voice") return voiceBubble(s, w);
  const b = focusBubble(s, w);
  const split = view === "sessions" && splitSessions(s);
  const empty = !b && split ? splitEmptyRows(s, w) : null;
  if (empty) return pad12([{ style: "heading", text: empty[0] }, { style: "muted", text: empty[1] }]);
  if (!b && !split && pinnedEmpty(s, w, view)) return pad12([{ style: "heading", text: PINNED_EMPTY[0] }, { style: "muted", text: PINNED_EMPTY[1] }]);
  if (screenOf(s, view) !== "buddy") {
    // Version 5 List / Grouped header (docs/ui-v3.md section 8.4): caption, one message line (24 wide), the next or "".
    if (!b) return pad12([{ style: "heading", text: "" }, { style: "muted", text: LIST_NONE_SELECTED }]);
    return pad12(listHeadRows(b.caption, b.lines, bubbleScroll(s, w, false)));
  }
  if (!b) return pad12([{ style: "heading", text: "" }, { style: "muted", text: `${HINT.noSelection[0]} ${HINT.noSelection[1]}` }]);
  // SPLIT Buddy (docs/ui-v3.md section 10.7): 4 body rows, row 5 the next line.
  return pad12(bubbleRows(b.caption, b.lines, bubbleScroll(s, w, false), split ? 4 : undefined));
}

/** Voice: rows 1-5 hold the transcript (reviewing) or the error and the transcript (failed); else empty. */
function voiceBubble(s: ControllerState, w: World): TextRow[] {
  const lines = voiceBubbleLines(w);
  if (lines.length === 0) return padPage([]);
  const rows = bubbleRows("", lines, bubbleScroll(s, w, true));
  // docs/ui-v3.md section 12: a review whose text leaves body row 5 free hints the canned gesture there (muted). The
  // 20-column hint line is full (`SAVE send  FX cancel`); a longer text simply shows no hint.
  const c = w.composer;
  if (c.state === "reviewing" && lines.length <= BUBBLE_BODY_ROWS - 2) {
    rows[BUBBLE_BODY_ROWS] = { style: "muted", text: c.source === "canned" ? REVIEW_HINT.del : REVIEW_HINT.save };
  }
  return pad12([EMPTY_ROW, ...rows.slice(1)]);
}

/** Knobs only: KNOB1..KNOB4 labels, "" for a knob that does nothing here (PINNED: REPO and TASK, section 9.4). */
function legendFor(view: ViewName, s: ControllerState, w: World): Legend4 {
  const row = LEGEND[view];
  const talk = talkModes(w).length > 0 ? row[3] : "";
  // SPLIT (docs/ui-v3.md section 10.9): KNOB2 empty with PINNED chosen; KNOB3 TASK steps the task row (every choice).
  // The cells name the knobs; the values are in the title and the turn's toast (docs/ux-v2.md section 2.3).
  if (view === "sessions" && splitSessions(s)) return [row[0], s.split.chosen === "pinned" ? "" : row[1], row[2], talk];
  const pinned = s.scope === "pinned" && (view === "sessions" || view === "tasks");
  return [row[0], pinned ? "" : row[1], pinned ? "" : row[2], talk];
}

/** PINNED with nothing pinned (docs/ui-v3.md section 9.4): the bubble / List header says how to pin. */
const pinnedEmpty = (s: ControllerState, w: World, view: ViewName): boolean =>
  view === "sessions" &&
  s.scope === "pinned" &&
  scopeMembers(s, w).length === 0 &&
  // Grouped PINNED also lists each pinned task as a folded row (focus.ts groupedLayout).
  !(sessionsGrouped(s) && s.pins.some((k) => isTaskKey(k) && w.registry.task(k) !== undefined));
