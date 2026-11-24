// Read-only lookups shared by the controller reducer and the view builder, plus the layout (re-sort) helpers.
import type { CannedEntry } from "./canned";
import type { ComposerState, Destination } from "./composer-state";
import { asciiText, cutWords, SCOPES, TALKS, titleSplit, type Scope, type Talk } from "./copy";
import {
  DEFAULT_SPLIT,
  EMPTY_TASK_ROW,
  inChoice,
  pageOfTask,
  SPLIT_GEOMETRY,
  taskPageCount,
  taskRowOrder,
  whiteList,
  type KeyMode,
  type SplitState,
  type TaskRow,
} from "./split";
import {
  EMPTY_LAYOUT,
  flatOrder,
  FocusLayout,
  groupedLayout,
  isAttention,
  pinnedSessions,
  rank,
  rankedSessions,
  scopeMembers,
  sessionPinsOf,
  taskChoices,
  todoItems,
  type LayoutData,
} from "./focus";
import { isSessionKey, isTaskKey, taskKey, taskOf } from "./identity";
import { itemTier, type Inbox, type InboxItem } from "./inbox";
import type { SessionEntry, SessionRegistry } from "./registry";
import { PAGE_SIZE } from "./slots";
import type { AdapterCapabilities, ApprovalRequest, CapabilityName, DeliveryStage, Project, Provider, Task } from "./types";

export type BaseView = "sessions" | "tasks" | "inbox";
/**
 * `detail`: the full-screen DETAILS page over Sessions or TO DO (docs/ux-v2.md section 7, protocol version 3).
 * `settings`: the SETTINGS view over a base view (docs/ui-v3.md section 10.2, protocol version 6).
 */
export type ViewName = BaseView | "voice" | "confirm" | "detail" | "settings";
export type VoiceMode = Destination["mode"];
/**
 * The screens of a base view with protocol version 5: the character (section 3.A), the chat list (section 8), or the
 * list grouped by task (section 9, Sessions only).
 */
export type ScreenLayout = "buddy" | "list" | "grouped";
/** The base views that have a List layout (docs/ui-v3.md section 8.1). Tasks stays Buddy. */
export type ListView = "sessions" | "inbox";
export const LIST_VIEWS: readonly ListView[] = ["sessions", "inbox"];
/** Defaults (operator brief 2026-11-18, GROUPED round): Grouped in Sessions, List in TO DO. */
export const DEFAULT_SCREEN: Readonly<Record<ListView, ScreenLayout>> = { sessions: "grouped", inbox: "list" };
/** SEQ order per view (docs/ui-v3.md section 9.1): Sessions cycles three layouts, TO DO toggles two. */
export const SCREEN_CYCLE: Readonly<Record<ListView, readonly ScreenLayout[]>> = { sessions: ["buddy", "list", "grouped"], inbox: ["buddy", "list"] };
/** A remembered layout that is valid for the view (TO DO has no Grouped). */
export const validScreen = (view: ListView, l: unknown): l is ScreenLayout => typeof l === "string" && SCREEN_CYCLE[view].includes(l as ScreenLayout);
export type { Scope, Talk };

export type ConfirmAction =
  | { type: "interrupt"; key: string; label: string }
  | { type: "approve" | "deny"; key: string; approvalId: string; label: string }
  | { type: "createSession"; taskKey: string; provider: Provider; label: string }
  | { type: "voiceSubmit"; label: string };

/** A toast the controller decided on (COMMAND_RESULT text). */
export interface Notice {
  stage: DeliveryStage;
  text: string;
}

export interface ControllerState {
  view: BaseView;
  confirm: ConfirmAction | null;
  pages: Record<BaseView, number>;
  /** KNOB1 SHOW. */
  scope: Scope;
  /**
   * The REPO filter in effect: a projectId, or null for all. KNOB2 sets it; choosing a task (Tasks view tap, GROUPED
   * folded row) sets it to the task's repo implicitly (operator report 2026-11-19).
   */
  repoFilter: string | null;
  /**
   * The repo KNOB2 chose (null: all). `repoFilter !== repoKnob` means a task choice set the repo implicitly; clearing
   * that task choice (the folded row tapped again, KNOB3 back to all, SPLIT ALL) puts `repoFilter` back to this.
   */
  repoKnob: string | null;
  /** KNOB3 TASK (or a task opened from the Tasks view): a task key, or null for all. */
  taskFilter: string | null;
  taskCursor: string | null;
  inboxCursor: string | null;
  /** KNOB4 TALK. */
  talk: Talk;
  /**
   * Pinned session keys and task keys (docs/ui-v3.md section 9.6), in pin order. Counted per kind: at most
   * MAX_PINS_PER_KIND (200) session pins and 200 task pins (operator decision 2026-11-19).
   */
  pins: string[];
  detailScroll: number;
  /** The DETAILS page is open over `view` (Sessions or TO DO): its page index. null when closed. */
  detail: number | null;
  /** The device can show the DETAILS page (protocol version 3 agreed). LFO does nothing without it. */
  detailsPage: boolean;
  /**
   * The device draws the UI v3 layout (protocol version 4, docs/ui-v3.md section 5): the character, the speech bubble
   * (SET_TEXT rows 0-6 in the base views and voice) and the v4 DETAILS page. PRESETS then scrolls the bubble.
   */
  bubble: boolean;
  /** The device draws the LIST layout (protocol version 5, docs/ui-v3.md section 8). SEQ does nothing without it. */
  listLayout: boolean;
  /** The layout per list view, remembered by the companion (config `layouts`). Used only while `listLayout`. */
  screen: Record<ListView, ScreenLayout>;
  /** Version 4: what `detailScroll` scrolls (bubble.ts bubbleSubject); the scroll counts only while it still matches. */
  bubbleFor: string | null;
  /** Device time of the last input (auto re-sort waits for 60 s of quiet). */
  lastInputAt: number;
  /** Frozen layouts per base view: session keys, task keys, inbox item ids. */
  layouts: Record<BaseView, LayoutData>;
  notice: Notice | null;
  /**
   * The last TO DO dismiss (docs/ux-v2.md section 3.6): the item, when, and the key it held. FX again within
   * DISMISS_UNDO_MS restores it there; any other input ends the window.
   */
  dismissUndo: { itemId: string; at: number; index: number } | null;
  /** SETTINGS Keys (config `settings.keys`, docs/ui-v3.md section 10.2). Applies only while `splitProto`. */
  keyMode: KeyMode;
  /** The device takes protocol version 6 (SPLIT keys, the SETTINGS view, the chosen flag). */
  splitProto: boolean;
  /** The SPLIT choice and task page (config `split`, docs/ui-v3.md section 10.10). */
  split: SplitState;
  /** The frozen SPLIT task row (docs/ui-v3.md section 10.4). */
  taskRow: TaskRow;
  /** SETTINGS is open over this base view; null when closed. */
  settingsFrom: BaseView | null;
  /** The SETTINGS cursor row. */
  settingsCursor: number;
  /** Device time ARP went down in a base view (the 1 s hold opens SETTINGS); null when not held. */
  arpDownAt: number | null;
  /** SPLIT OCT press waiting for its double window (docs/ui-v3.md section 10.5). */
  octPending: { button: "OCT_DOWN" | "OCT_UP"; downAt: number; upAt: number | null } | null;
  /**
   * SPLIT KNOB3 (operator brief 2026-11-19): device time of the last turn whose white-key relayout still waits for the
   * knob to rest (KNOB3_REST_MS); null when none waits. The choice and the black row are already updated.
   */
  knob3At: number | null;
  /**
   * Device time of the REC down edge that started the current recording (docs/ui-v3.md section 11): an up edge before
   * REC_TAP_MS is a short tap (the take is dropped and the first suggestion goes to review); null otherwise.
   */
  recDownAt: number | null;
  /**
   * Suggestions already used up, per session key: the JSON of the list shown when a prompt went to that session. They
   * stay hidden until the adapter reports a different list (the backend drops its own on a send, too).
   */
  spentSuggestions: Readonly<Record<string, string>>;
  /**
   * Canned responses (docs/ui-v3.md section 12), sorted (uses desc, then createdAt desc). Restored from and saved to the
   * companion config `canned`; the reducer changes it (ARP save, a send, FX hold delete and its undo).
   */
  canned: readonly CannedEntry[];
  /** Device time FX went down on a canned review (released after CANNED_DELETE_HOLD_MS it deletes); null otherwise. */
  fxDownAt: number | null;
  /**
   * Device time PLAY went down on a selected session in Sessions or TO DO (docs/ui-v3.md section 14): released before
   * READ_ALOUD_HOLD_MS it opens the chat on the Mac; held that long it reads the latest message aloud. null otherwise.
   */
  playDownAt: number | null;
  /** The last canned delete: FX again within DISMISS_UNDO_MS restores it; any other input ends the window. */
  cannedUndo: { entry: CannedEntry; at: number } | null;
}

export interface World {
  registry: SessionRegistry;
  inbox: Inbox;
  composer: ComposerState;
  capabilities: AdapterCapabilities;
  now: number;
  /** The backend's name in device copy (`<name> offline`, `Gone from <name>`); copy.ts DEFAULT_BACKEND when absent. */
  backend?: string;
  /** Read aloud is busy (preparing or playing; docs/ui-v3.md section 14): PLAY or FX stops it. Absent = false. */
  speaking?: boolean;
}

export const initialController: ControllerState = {
  view: "sessions",
  confirm: null,
  pages: { sessions: 0, tasks: 0, inbox: 0 },
  scope: "active",
  repoFilter: null,
  repoKnob: null,
  taskFilter: null,
  taskCursor: null,
  inboxCursor: null,
  talk: "reply",
  pins: [],
  detailScroll: 0,
  detail: null,
  detailsPage: false,
  bubble: false,
  listLayout: false,
  screen: { ...DEFAULT_SCREEN },
  bubbleFor: null,
  lastInputAt: 0,
  layouts: { sessions: EMPTY_LAYOUT, tasks: EMPTY_LAYOUT, inbox: EMPTY_LAYOUT },
  notice: null,
  dismissUndo: null,
  keyMode: "ranked",
  splitProto: false,
  split: { ...DEFAULT_SPLIT },
  taskRow: EMPTY_TASK_ROW,
  settingsFrom: null,
  settingsCursor: 0,
  arpDownAt: null,
  octPending: null,
  knob3At: null,
  recDownAt: null,
  spentSuggestions: {},
  canned: [],
  fxDownAt: null,
  cannedUndo: null,
  playDownAt: null,
};

/**
 * A REC press released sooner than this is a short tap (docs/ui-v3.md section 11): it loads the first suggestion instead
 * of sending a recording. Recording still starts on the down edge exactly as before, so a hold loses no audio; a tap's
 * take is dropped untranscribed.
 */
export const REC_TAP_MS = 350;

/** Spent suggestion lists the adapter no longer reports (cleared or replaced) are forgotten, so a later repeat shows. */
export function pruneSpent<S extends Pick<ControllerState, "spentSuggestions">>(s: S, registry: Pick<SessionRegistry, "get">): S {
  const keys = Object.keys(s.spentSuggestions);
  if (keys.length === 0) return s;
  const kept: Record<string, string> = {};
  for (const k of keys) {
    const list = (registry.get(k)?.session.details?.suggestions ?? []).filter((x) => x.trim() !== "");
    if (list.length > 0 && JSON.stringify(list) === s.spentSuggestions[k]) kept[k] = s.spentSuggestions[k] ?? "";
  }
  return Object.keys(kept).length === keys.length ? s : { ...s, spentSuggestions: kept };
}

/** The session's suggested next prompts as the console offers them: none when stale, spent, or it takes no prompts. */
export function suggestionsOf(s: Pick<ControllerState, "spentSuggestions">, e: SessionEntry | undefined): string[] {
  if (!e || e.stale || e.session.prompt?.acceptsPrompt === false) return [];
  const list = (e.session.details?.suggestions ?? []).filter((x) => x.trim() !== "");
  if (list.length === 0) return [];
  return s.spentSuggestions[e.key] === JSON.stringify(list) ? [] : list;
}

/** SPLIT keys apply (docs/ui-v3.md section 10.3): Keys is Split and protocol 6 was agreed. Sessions only. */
export const splitOn = (s: Pick<ControllerState, "keyMode" | "splitProto">): boolean => s.splitProto && s.keyMode === "split";
/** The 27 keys on the device hold the SPLIT assignment: Sessions (and views 3-6 opened over it) with SPLIT keys. */
export const splitSessions = (s: Pick<ControllerState, "keyMode" | "splitProto" | "view">): boolean => splitOn(s) && s.view === "sessions";

const VOICE_VISIBLE = new Set(["recording", "transcribing", "reviewing", "submitting", "failed", "target_unavailable"]);

export function currentView(s: ControllerState, w: Pick<World, "composer">): ViewName {
  if (s.confirm) return "confirm";
  if (VOICE_VISIBLE.has(w.composer.state)) return "voice";
  if (s.settingsFrom !== null) return "settings";
  if (s.detail !== null && s.detailsPage && s.view !== "tasks") return "detail";
  return s.view;
}

/** The layout `view` is drawn in: List only for Sessions and TO DO with version 5 and the list chosen. */
export function screenOf(s: Pick<ControllerState, "listLayout" | "screen">, view: ViewName): ScreenLayout {
  if (!s.listLayout) return "buddy";
  if (view === "sessions") return s.screen.sessions;
  if (view === "inbox") return s.screen.inbox === "grouped" ? "list" : s.screen.inbox;
  return "buddy";
}

/** Sessions is laid out (and drawn) grouped by task: protocol 5 and the Grouped layout chosen. */
export const sessionsGrouped = (s: Pick<ControllerState, "listLayout" | "screen">): boolean => screenOf(s, "sessions") === "grouped";

export const can = (w: World, name: CapabilityName): boolean => w.capabilities[name].supported;

export const layoutOf = (s: ControllerState, view: BaseView): FocusLayout => new FocusLayout(s.layouts[view]);

const withLayout = (s: ControllerState, view: BaseView, l: FocusLayout): ControllerState => ({
  ...s,
  layouts: { ...s.layouts, [view]: l.data() },
});

/** A key of the Sessions layout exists: a session the registry knows, or (GROUPED) a folded task row's task. */
export const sessionsKeyExists = (w: World, k: string): boolean => (isTaskKey(k) ? w.registry.task(k) !== undefined : w.registry.get(k) !== undefined);

/** The keys a re-sort of `view` lays out now (GROUPED: with each key's group). */
function sortedKeys(s: ControllerState, w: World, view: BaseView): { keys: string[]; pins: string[]; seen: string[]; groups?: Record<string, string> } {
  if (view === "sessions" && splitOn(s)) return whiteList(s, w, sessionsGrouped(s));
  if (view === "sessions") {
    if (sessionsGrouped(s)) return { ...groupedLayout(s, w), pins: [] };
    // Buddy and List (operator decision 2026-11-22, pins first): pinned sessions, then the other sessions that need you, then the rest.
    // PINNED: every live session pin, those that need you first.
    const members = scopeMembers(s, w);
    return { ...flatOrder(members, s.scope === "pinned" ? members : pinnedSessions(s, w)), pins: [] };
  }
  if (view === "tasks") {
    let tasks = taskChoices(s, w);
    if (s.scope === "pinned") {
      // PINNED in the Tasks view: the pinned tasks and the tasks of pinned sessions, across repos.
      const pinnedTask = pinnedTasksFilter(s, w);
      tasks = taskChoices({ scope: "all", repoFilter: null }, w).filter((t) => pinnedTask(t.key));
    }
    return { keys: tasks.map((t) => t.key), pins: [], seen: tasks.filter((t) => isAttention(t.tier)).map((t) => t.key) };
  }
  const items = todoItems(w);
  return { keys: items.map((i) => i.id), pins: [], seen: items.map((i) => i.id) };
}

/** PINNED in the Tasks view: a pinned task, or the task of a live pinned session. */
function pinnedTasksFilter(s: ControllerState, w: World): (taskKey: string) => boolean {
  if (s.scope !== "pinned") return () => true;
  const pins = new Set(s.pins);
  const sessionPins = new Set(sessionPinsOf(s.pins));
  const withPins = new Set(rankedSessions(w).filter((r) => sessionPins.has(r.key)).map((r) => r.taskKey));
  return (k) => pins.has(k) || withPins.has(k);
}

/** An empty layout of `view` with its geometry: SPLIT white keys (16 a page, G5 free) or the flat 27 keys. */
const freshLayout = (s: ControllerState, view: BaseView): FocusLayout => new FocusLayout(view === "sessions" && splitOn(s) ? SPLIT_GEOMETRY : EMPTY_LAYOUT);

/** Re-sorts one view. `keepPage` (auto re-sort) keeps the page index, clamped; otherwise page 1. */
export function relayout(s: ControllerState, w: World, view: BaseView, keepPage = false): ControllerState {
  const { keys, pins, seen, groups } = sortedKeys(s, w, view);
  const l = freshLayout(s, view).relayout(keys, pins, w.now, seen, groups);
  const page = keepPage ? Math.min(s.pages[view], l.pageCount() - 1) : 0;
  return { ...withLayout(s, view, l), pages: { ...s.pages, [view]: page } };
}

/** True when a re-sort would change the order of `view`. */
export function orderWouldChange(s: ControllerState, w: World, view: BaseView): boolean {
  const { keys, pins, seen, groups } = sortedKeys(s, w, view);
  const next = freshLayout(s, view).relayout(keys, pins, w.now, seen, groups).keys();
  const cur = layoutOf(s, view);
  if (view === "sessions" && splitOn(s) && JSON.stringify(taskRowOrder(s, w)) !== JSON.stringify(s.taskRow.keys)) return true;
  return cur.pendingNew > 0 || JSON.stringify(next) !== JSON.stringify(cur.keys());
}

/**
 * Where the task page goes at a task row re-sort (docs/ui-v3.md section 10.4): the page holding the chosen task (a filter
 * chosen: page 1), the old index clamped, or the page holding a given task (a task just pinned or unpinned).
 */
export type TaskPagePolicy = "chosen" | "keep" | { task: string | null };

/**
 * Re-sorts the SPLIT task row. A chosen task that is not on the new row falls back to ALL (toast `Show: all`). The white
 * keys are not touched (resortSplit does both).
 */
export function relayoutTaskRow(s: ControllerState, w: World, policy: TaskPagePolicy): ControllerState {
  // Before the first full snapshot (or while the backend link is down) the registry is incomplete: the row and the
  // choice stay as they are (a restored task must not fall back to ALL and be saved, section 10.10); a row never built
  // keeps builtAt null, so reconcile builds it from the first ready snapshot.
  if (!w.registry.ready()) return s;
  const row: TaskRow = { keys: taskRowOrder(s, w), builtAt: w.now };
  let split = s.split;
  let notice = s.notice;
  if (split.chosen === "task" && (split.task === null || !row.keys.includes(split.task))) {
    split = { ...split, chosen: "all", task: null };
    notice = { stage: "accepted_locally", text: "Show: all" };
  }
  const pages = taskPageCount(row);
  let page: number;
  if (policy === "keep") page = split.taskPage;
  else if (policy === "chosen") page = split.chosen === "task" ? Math.max(0, pageOfTask(row, split.task)) : 0;
  else page = Math.max(0, pageOfTask(row, policy.task));
  page = Math.max(0, Math.min(pages - 1, page));
  return { ...s, taskRow: row, split: { ...split, taskPage: page }, notice };
}

/** Re-sorts both SPLIT rows: the task row first (its fallback may change the choice), then the white keys. */
export function resortSplit(s: ControllerState, w: World, policy: TaskPagePolicy, keepWhitePage = false): ControllerState {
  return relayout(relayoutTaskRow(s, w, policy), w, "sessions", keepWhitePage);
}

export const relayoutAll = (s: ControllerState, w: World): ControllerState =>
  (["sessions", "tasks", "inbox"] as const).reduce((acc, v) => relayout(acc, w, v), s);

/**
 * Between re-sorts: new attention items take free keys of page 1 (or wait as `+N new`); nothing else moves.
 * The first ready snapshot builds every layout.
 */
export function reconcile(s0: ControllerState, w: World): ControllerState {
  if (!w.registry.ready()) return s0;
  let s = s0;
  // SPLIT: the first ready snapshot builds the task row too (the saved choice and page restored, docs/ui-v3.md 10.10).
  if (splitOn(s) && s.taskRow.builtAt === null) s = resortSplit(s, w, "keep", true);
  for (const view of ["sessions", "tasks", "inbox"] as const) {
    if (s.layouts[view].builtAt === null) {
      s = relayout(s, w, view, true);
      continue;
    }
    const l = layoutOf(s, view);
    const before = JSON.stringify(l.data());
    l.release(view === "sessions" ? (k) => sessionsKeyExists(w, k) : view === "tasks" ? (k) => w.registry.task(k) !== undefined : (k) => w.inbox.known(k) !== undefined);
    const { arrivals, qualifies } = arrivalsFor(s, w, view, l);
    for (const k of arrivals) {
      if (l.indexOf(k) >= l.pageSize) l.promote(k);
      else l.place([k]);
    }
    l.keepPending(qualifies);
    if (JSON.stringify(l.data()) !== before) s = clampPages(withLayout(s, view, l), w);
  }
  return s;
}

function arrivalsFor(s: ControllerState, w: World, view: BaseView, l: FocusLayout): { arrivals: string[]; qualifies: (k: string) => boolean } {
  const builtAt = l.builtAt ?? w.now;
  if (view === "inbox") {
    const items = todoItems(w).filter((i) => isAttention(itemTier(i, w.now) ?? 9));
    const ids = new Set(items.map((i) => i.id));
    return { arrivals: items.filter((i) => !l.wasSeen(i.id) && l.indexOf(i.id) < 0).map((i) => i.id), qualifies: (k) => ids.has(k) };
  }
  const pinned = s.scope === "pinned";
  if (view === "tasks") {
    // PINNED: only pinned tasks and the tasks of pinned sessions arrive, across repos (section 9.4).
    const pinnedTask = pinnedTasksFilter(s, w);
    const tasks = taskChoices({ scope: "all", repoFilter: pinned ? null : s.repoFilter }, w).filter((t) => isAttention(t.tier) && pinnedTask(t.key));
    const ids = new Set(tasks.map((t) => t.key));
    return { arrivals: tasks.filter((t) => !l.wasSeen(t.key) && (l.indexOf(t.key) < 0 || l.indexOf(t.key) >= PAGE_SIZE)).map((t) => t.key), qualifies: (k) => ids.has(k) };
  }
  const split = splitOn(s);
  const ok = new Set<string>();
  const out: string[] = [];
  const pins = new Set(sessionPinsOf(s.pins));
  for (const e of w.registry.sessions()) {
    if (e.stale) continue;
    if (split) {
      // SPLIT (docs/ui-v3.md section 10.4): only sessions of the current choice arrive on the white keys.
      const r = rank(e, w);
      if (!inChoice(s, w, e.key, r.tier, r.taskKey, r.projectId)) continue;
    } else if (pinned) {
      // PINNED ignores REPO and TASK and shows only session pins (docs/ui-v3.md section 9.4): nothing else arrives there.
      if (!pins.has(e.key)) continue;
    } else {
      if (s.repoFilter !== null && e.session.ref.projectId !== s.repoFilter) continue;
      if (s.taskFilter !== null && taskKey(taskOf(e.session.ref)) !== s.taskFilter) continue;
    }
    const created = e.session.createdAt > builtAt;
    const attention = isAttention(rank(e, w).tier);
    if (!attention && !created) continue;
    ok.add(e.key);
    const at = l.indexOf(e.key);
    if (l.wasSeen(e.key) && at >= 0) continue;
    if (at < 0 || (attention && at >= l.pageSize)) out.push(e.key);
  }
  return { arrivals: out, qualifies: (k) => ok.has(k) };
}

export function sessionLayout(s: ControllerState): readonly (string | null)[] {
  return s.layouts.sessions.slots;
}

/**
 * The 27 keys of the shown Sessions page. SPLIT: the white page on the white keys (F3 first), null on every black key
 * (the black row is built by the view, docs/ui-v3.md section 10.3).
 */
export function sessionPage(s: ControllerState): (string | null)[] {
  const l = layoutOf(s, "sessions");
  const page = l.page(s.pages.sessions);
  if (l.pageSize === PAGE_SIZE) return page;
  const out = Array<string | null>(PAGE_SIZE).fill(null);
  WHITE_KEY_LIST.forEach((k, i) => (out[k] = page[i] ?? null));
  return out;
}
const WHITE_KEY_LIST = [0, 2, 4, 6, 7, 9, 11, 12, 14, 16, 18, 19, 21, 23, 24, 26];

export function taskPage(s: ControllerState, w: World): (Task | null)[] {
  return layoutOf(s, "tasks")
    .page(s.pages.tasks)
    .map((k) => (k === null ? null : w.registry.task(k) ?? null));
}

export function inboxPage(s: ControllerState, w: World): (InboxItem | null)[] {
  return layoutOf(s, "inbox")
    .page(s.pages.inbox)
    .map((id) => (id === null ? null : w.inbox.known(id) ?? null));
}

export const visibleTasks = (s: ControllerState, w: World): Task[] =>
  layoutOf(s, "tasks")
    .keys()
    .flatMap((k) => {
      const t = k === null ? undefined : w.registry.task(k);
      return t ? [t] : [];
    });

export function pageCount(s: ControllerState, _w: World, view: BaseView): number {
  return layoutOf(s, view).pageCount();
}

/** Keep every page index in range (layouts shrink only at re-sorts, but stay defensive). */
export function clampPages(s: ControllerState, w: World): ControllerState {
  const views: BaseView[] = ["sessions", "tasks", "inbox"];
  const pages = { ...s.pages };
  let changed = false;
  for (const v of views) {
    const max = pageCount(s, w, v) - 1;
    if (pages[v] > max) {
      pages[v] = max;
      changed = true;
    }
  }
  return changed ? { ...s, pages } : s;
}

export function selectedEntry(w: World): SessionEntry | undefined {
  const sel = w.registry.selection();
  return sel.key === null ? undefined : w.registry.get(sel.key);
}

/** The item under the TO DO cursor; it may have left the inbox since (it keeps its key until the next re-sort). */
export function inboxItemAtCursor(s: ControllerState, w: World): InboxItem | undefined {
  if (s.inboxCursor === null) return undefined;
  return w.inbox.get(s.inboxCursor) ?? (s.layouts.inbox.slots.includes(s.inboxCursor) ? w.inbox.known(s.inboxCursor) : undefined);
}

/** The session an action applies to in the current base view. */
export function focusEntry(s: ControllerState, w: World): SessionEntry | undefined {
  if (s.view === "inbox") {
    const item = inboxItemAtCursor(s, w);
    return item ? w.registry.get(item.sessionKey) : undefined;
  }
  if (s.view === "tasks") return undefined;
  return selectedEntry(w);
}

export function pendingApproval(s: ControllerState, w: World): ApprovalRequest | undefined {
  if (s.view === "inbox") {
    const item = inboxItemAtCursor(s, w);
    return item?.approvalId ? w.registry.approval(item.approvalId) : undefined;
  }
  if (s.view === "tasks") return undefined;
  const e = selectedEntry(w);
  return e && !e.stale ? w.registry.approvalsFor(e.key)[0] : undefined;
}

const TALK_CAP: Record<Talk, CapabilityName> = {
  reply: "sendPrompt",
  "claude-chat": "createSession",
  "codex-chat": "createSession",
  "claude-task": "createTask",
  "codex-task": "createTask",
};
export const talkCapability = (t: Talk): CapabilityName => TALK_CAP[t];

/** KNOB4 positions the adapter supports. */
export const talkModes = (w: World): Talk[] => TALKS.filter((t) => can(w, TALK_CAP[t]));
export const scopes = (): readonly Scope[] => SCOPES;

export const talkProvider = (t: Talk): Provider => (t.startsWith("codex") ? "codex" : "claude");

/** In the Tasks view REC starts a new chat in the task; `reply` has no session there. */
export function effectiveTalk(s: ControllerState): Talk {
  return s.view === "tasks" && s.talk === "reply" ? "claude-chat" : s.talk;
}

function projectFor(s: ControllerState, w: World): Project | undefined {
  const projects = w.registry.projects();
  // The repo of what the screen shows: the task under the Tasks cursor, else the shown session.
  const shown =
    s.view === "tasks"
      ? (s.taskCursor === null ? undefined : w.registry.task(s.taskCursor)?.ref.projectId)
      : focusEntry(s, w)?.session.ref.projectId;
  const id = s.repoFilter ?? shown;
  return projects.find((p) => p.projectId === id) ?? (s.repoFilter === null ? projects[0] : undefined);
}

/** The task a new chat goes to: TASK filter, else the Tasks cursor, else the selected session's task. */
export function chatTaskKey(s: ControllerState, w: World): string | null {
  // In the Tasks view the screen shows the task under the cursor; an older TASK filter must not win over it.
  if (s.view === "tasks") return s.taskCursor;
  const sel = selectedEntry(w);
  // SPLIT: the chosen task replaces the TASK filter (docs/ui-v3.md section 10.9).
  const filter = splitOn(s) ? (s.split.chosen === "task" ? s.split.task : null) : s.taskFilter;
  return filter ?? s.taskCursor ?? (sel ? taskKey(taskOf(sel.session.ref)) : null);
}

/** Destination captured at REC down; null when the current context gives no valid target. */
export function destinationFor(s: ControllerState, w: World): Destination | null {
  const talk = effectiveTalk(s);
  const provider = talkProvider(talk);
  if (talk === "reply") {
    // Only the session the screen shows: in TO DO that is the item under the cursor, never the Sessions selection.
    const e = focusEntry(s, w);
    if (!e || e.stale) return null;
    return { mode: "continue-session", target: e.session.ref, label: titleSplit(e.session.title).head || "(untitled)" };
  }
  if (talk === "claude-chat" || talk === "codex-chat") {
    const key = chatTaskKey(s, w);
    const task = key === null ? undefined : w.registry.task(key);
    return task ? { mode: "new-session", task: task.ref, provider, label: `new chat: ${cutWords(asciiText(task.title), 10)}` } : null;
  }
  const p = projectFor(s, w);
  return p
    ? { mode: "new-task", project: { backendId: p.backendId, hostId: p.hostId, projectId: p.projectId }, provider, label: `new task: ${cutWords(asciiText(p.name), 10)}` }
    : null;
}

/**
 * Re-sorts Sessions after its key order changed kind (Grouped on or off): the selection is kept and the page becomes
 * the page holding it (page 1 when it is off the layout). docs/ui-v3.md section 9.1.
 */
export function relayoutKeepingSelection(s: ControllerState, w: World): ControllerState {
  const next = relayout(s, w, "sessions");
  const sel = w.registry.selection().key;
  const l = layoutOf(next, "sessions");
  const at = sel === null ? -1 : l.indexOf(sel);
  return at < 0 ? next : { ...next, pages: { ...next.pages, sessions: l.pageOf(at) } };
}
