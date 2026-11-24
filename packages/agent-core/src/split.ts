// SPLIT keys (docs/ui-v3.md section 10, protocol version 6): the black row (filters ALL / PINNED / NEEDS YOU and a frozen,
// paged task row) and the white keys (the sessions of the chosen filter or task). Pure: the lists, the task row order,
// the task tags. The controller and the view builder apply them.
import { asciiText } from "./copy";
import {
  byGroup,
  flatOrder,
  groupBest,
  groupedLayout,
  isAttention,
  nestChildren,
  pinnedSessions,
  rankedSessions,
  scopeMembers,
  sessionPinsOf,
  taskChoices,
  taskGroup,
  PINNED_GROUP,
  type FocusWorld,
  type LayoutData,
  type Ranked,
  type Tier,
} from "./focus";
import { isSessionKey, isTaskKey } from "./identity";
import type { Scope } from "./copy";

/** The SETTINGS Keys item (config `settings.keys`): every key a session, or the SPLIT black row. Default ranked. */
export type KeyMode = "ranked" | "split";
export const KEY_MODES: readonly KeyMode[] = ["ranked", "split"];

/** What the white keys show (docs/ui-v3.md section 10.3): a filter, or one task. */
export type SplitChoice = "all" | "pinned" | "needs" | "task";
export const SPLIT_CHOICES: readonly SplitChoice[] = ["all", "pinned", "needs", "task"];

/** The persisted SPLIT choice (config `split`, docs/ui-v3.md section 10.10). `task` is a task key exactly when chosen is `task`. */
export interface SplitState {
  chosen: SplitChoice;
  task: string | null;
  taskPage: number;
}
export const DEFAULT_SPLIT: Readonly<SplitState> = { chosen: "all", task: null, taskPage: 0 };

/** The frozen task row: task keys in row order (8 per task page), and when it was last re-sorted. */
export interface TaskRow {
  keys: readonly string[];
  builtAt: number | null;
}
export const EMPTY_TASK_ROW: TaskRow = { keys: [], builtAt: null };

/** Physical keys (docs/ui-v3.md section 10.3). */
export const WHITE_KEYS = [0, 2, 4, 6, 7, 9, 11, 12, 14, 16, 18, 19, 21, 23, 24, 26] as const;
export const BLACK_KEYS = [1, 3, 5, 8, 10, 13, 15, 17, 20, 22, 25] as const;
/** F#3, G#3, A#3: ALL, PINNED, NEEDS YOU. */
export const FILTER_KEYS = [1, 3, 5] as const;
export const FILTER_OF: Readonly<Record<number, Exclude<SplitChoice, "task">>> = { 1: "all", 3: "pinned", 5: "needs" };
export const FILTER_TAG: Readonly<Record<Exclude<SplitChoice, "task">, string>> = { all: "ALL", pinned: "PIN", needs: "YOU" };
export const FILTER_NAME: Readonly<Record<Exclude<SplitChoice, "task">, string>> = { all: "All", pinned: "Pinned", needs: "Needs you" };
/** Task slots 1-8 of the shown task page. */
export const TASK_KEYS = [8, 10, 13, 15, 17, 20, 22, 25] as const;
export const TASKS_PER_PAGE = 8;
/** White keys per page; page 1 leaves G5 (white index 15, key 26) free for arrivals. */
export const WHITE_PAGE = 16;
export const WHITE_RESERVE = 15;
export const SPLIT_GEOMETRY: LayoutData = { slots: [], pending: [], seen: [], builtAt: null, pageSize: WHITE_PAGE, reserve: WHITE_RESERVE };
/** KNOB1 in SPLIT: no PINNED step (the PINNED black key replaces it). */
export const SPLIT_SCOPES: readonly Scope[] = ["active", "recent", "all"];

/** Host-resolved gestures (docs/ui-v3.md sections 10.2 and 10.5). */
export const ARP_HOLD_MS = 1000;
export const OCT_DOUBLE_MS = 300;

export const isWhiteKey = (k: number): boolean => (WHITE_KEYS as readonly number[]).includes(k);
export const isBlackKey = (k: number): boolean => (BLACK_KEYS as readonly number[]).includes(k);
/** Task slot index 0-7 of black key k, or -1 (a filter or a white key). */
export const taskSlotOf = (k: number): number => (TASK_KEYS as readonly number[]).indexOf(k);

/** What the SPLIT lists need from the controller state. */
export interface SplitInput {
  scope: Scope;
  repoFilter: string | null;
  pins: readonly string[];
  split: SplitState;
}

export interface WhiteList {
  /** Session keys in white-key order. */
  keys: string[];
  /** The flat pin block (Buddy and List; empty when grouped). */
  pins: string[];
  /** Attention keys at layout time. */
  seen: string[];
  /** Grouped: each key's group id. */
  groups?: Record<string, string>;
}

const scopeOf = (s: SplitInput): Scope => (s.scope === "pinned" ? "active" : s.scope);

/**
 * The white list of a choice (docs/ui-v3.md section 10.4; order: operator decision 2026-11-22). ALL, PINNED and a task:
 * pinned sessions first, then the other sessions that need you (T0-T3), then the rest (Grouped: by group, focus.ts
 * groupedLayout).
 * `grouped`: the Grouped layout (groups never fold; a chosen task is one group). Task pins take no white key (they only
 * order the task row). NEEDS YOU: tier order, pins not lifted.
 */
export function whiteList(s: SplitInput, w: FocusWorld, grouped: boolean, choice: SplitState = s.split): WhiteList {
  const pins = s.pins;
  if (choice.chosen === "pinned") {
    const f = { scope: "pinned" as const, repoFilter: null, taskFilter: null, pins };
    if (!grouped) {
      const members = scopeMembers(f, w);
      return { ...flatOrder(members, members), pins: [] };
    }
    const g = groupedLayout(f, w);
    const keys = g.keys.filter(isSessionKey);
    return { keys, pins: [], seen: g.seen, groups: Object.fromEntries(keys.map((k) => [k, g.groups[k] ?? PINNED_GROUP])) };
  }
  if (choice.chosen === "needs") {
    const members = rankedSessions(w).filter((r) => isAttention(r.tier) && (s.repoFilter === null || r.projectId === s.repoFilter));
    const seen = members.map((r) => r.key);
    if (!grouped) return { keys: seen, pins: [], seen };
    return { ...groupByTask(members, w), pins: [], seen };
  }
  if (choice.chosen === "task" && choice.task !== null) {
    const tk = choice.task;
    // A chosen pinned task shows every live session (whatever SHOW says); another task its sessions in SHOW scope.
    // Session pins of the task always show (SHOW does not apply to pins).
    const all = rankedSessions(w).filter((r) => r.taskKey === tk);
    const scoped = pins.includes(tk) ? all : scopeMembers({ scope: scopeOf(s), repoFilter: null, taskFilter: tk }, w);
    const pinned = pinnedSessions({ scope: "all", repoFilter: null, taskFilter: tk, pins }, w);
    const order = flatOrder(scoped, pinned);
    if (!grouped) return { ...order, pins: [] };
    const parentOf = (k: string): string | undefined => w.registry.get(k)?.session.parentKey;
    const byKey = new Map(all.map((r) => [r.key, r]));
    const ranked = order.keys.flatMap((k) => byKey.get(k) ?? []);
    const pinSet = new Set(pinned.map((r) => r.key));
    const pin = ranked.filter((r) => pinSet.has(r.key));
    const need = ranked.filter((r) => isAttention(r.tier) && !pinSet.has(r.key));
    const rest = ranked.filter((r) => !isAttention(r.tier) && !pinSet.has(r.key));
    const keys = [...nestChildren(pin, parentOf), ...nestChildren(need, parentOf), ...nestChildren(rest, parentOf)].map((r) => r.key);
    return { keys, pins: [], seen: order.seen, groups: Object.fromEntries(keys.map((k) => [k, taskGroup(tk)])) };
  }
  // ALL: the RANKED list of SHOW and REPO with no TASK filter.
  const f = { scope: scopeOf(s), repoFilter: s.repoFilter, taskFilter: null, pins };
  if (grouped) {
    const g = groupedLayout({ ...f, noFold: true }, w);
    const keys = g.keys.filter(isSessionKey);
    return { keys, pins: [], seen: g.seen, groups: Object.fromEntries(keys.map((k) => [k, g.groups[k] ?? PINNED_GROUP])) };
  }
  return { ...flatOrder(scopeMembers(f, w), pinnedSessions(f, w)), pins: [] };
}

/** NEEDS YOU grouped: one group per task (no Pinned group), tasks by best tier, newest activity, title. */
function groupByTask(members: readonly Ranked[], w: FocusWorld): { keys: string[]; groups: Record<string, string> } {
  const title = (tk: string): string => w.registry.task(tk)?.title ?? "";
  const order = [...groupBest(members, (r) => r.taskKey).values()].sort(byGroup(title));
  const parentOf = (k: string): string | undefined => w.registry.get(k)?.session.parentKey;
  const keys: string[] = [];
  const groups: Record<string, string> = {};
  for (const g of order) {
    for (const r of nestChildren(members.filter((m) => m.taskKey === g.id), parentOf)) {
      keys.push(r.key);
      groups[r.key] = taskGroup(g.id);
    }
  }
  return { keys, groups };
}

/** The number of sessions a white list shows (the flat pin block plus the rest). */
export const whiteCount = (l: WhiteList): number => new Set([...l.pins, ...l.keys]).size;

/** Whether a live session belongs to the current choice (arrivals onto the white keys, docs/ui-v3.md section 10.4). */
export function inChoice(s: SplitInput, w: FocusWorld, key: string, tier: Tier, taskKeyOf: string, projectId: string): boolean {
  const c = s.split;
  if (c.chosen === "pinned") return sessionPinsOf(s.pins).includes(key);
  if (c.chosen === "task") return c.task !== null && taskKeyOf === c.task;
  if (s.repoFilter !== null && projectId !== s.repoFilter) return false;
  if (c.chosen === "needs") return isAttention(tier);
  return w.registry.get(key) !== undefined;
}

/**
 * The task row (docs/ui-v3.md section 10.4): every pinned task, then the tasks of REPO with a session in SHOW scope.
 * Pinned first; inside each part best tier, newest activity, title, task key. Task pins order only this row.
 */
export function taskRowOrder(s: Pick<SplitInput, "scope" | "repoFilter" | "pins">, w: FocusWorld): string[] {
  const pinned = s.pins.filter((k) => isTaskKey(k) && w.registry.task(k) !== undefined);
  const live = rankedSessions(w);
  const best = groupBest(live.filter((r) => pinned.includes(r.taskKey)), (r) => r.taskKey);
  const title = (tk: string): string => w.registry.task(tk)?.title ?? "";
  const pinnedOrder = [...pinned].sort((a, b) => {
    const ga = best.get(a) ?? { id: a, tier: 7 as Tier, activity: w.registry.task(a)?.updatedAt ?? 0 };
    const gb = best.get(b) ?? { id: b, tier: 7 as Tier, activity: w.registry.task(b)?.updatedAt ?? 0 };
    return byGroup(title)(ga, gb);
  });
  const others = taskChoices({ scope: s.scope === "pinned" ? "active" : s.scope, repoFilter: s.repoFilter }, w)
    .map((t) => t.key)
    .filter((k) => !pinned.includes(k));
  return [...pinnedOrder, ...others];
}

export const taskPageCount = (row: TaskRow): number => Math.max(1, Math.ceil(row.keys.length / TASKS_PER_PAGE));

/** The task keys of task page p (8 entries, null for empty slots). */
export function taskRowPage(row: TaskRow, page: number): (string | null)[] {
  return Array.from({ length: TASKS_PER_PAGE }, (_, j) => row.keys[page * TASKS_PER_PAGE + j] ?? null);
}

/** The task page holding `tk`, or -1. */
export function pageOfTask(row: TaskRow, tk: string | null): number {
  const i = tk === null ? -1 : row.keys.indexOf(tk);
  return i < 0 ? -1 : Math.floor(i / TASKS_PER_PAGE);
}

/**
 * A task's 3-character tag (docs/ui-v3.md section 10.7): the upper-cased first character of each of the first 3 words
 * (runs of letters and digits of the ASCII-folded title); fewer than 3: the next characters of the last word used.
 * No word: `?`.
 */
export function taskTag(title: string): string {
  const folded = asciiText(title.normalize("NFKD").replace(/[̀-ͯ]/g, ""));
  const words = folded.match(/[A-Za-z0-9]+/g) ?? [];
  if (words.length === 0) return "?";
  const used = words.slice(0, 3);
  let tag = used.map((x) => x[0] ?? "").join("");
  const last = used[used.length - 1] ?? "";
  for (let i = 1; tag.length < 3 && i < last.length; i++) tag += last[i];
  return tag.toUpperCase().slice(0, 3);
}

/** The tags of one task page's titles: a repeat (row order) replaces its third character with its slot number 1-8. */
export function taskTags(titles: readonly (string | null)[]): (string | null)[] {
  const seen = new Set<string>();
  return titles.map((t, j) => {
    if (t === null) return null;
    let tag = taskTag(t);
    if (seen.has(tag)) tag = `${tag.slice(0, 2).padEnd(2, tag[0] ?? "?")}${j + 1}`;
    seen.add(tag);
    return tag;
  });
}

/** SETTINGS (docs/ui-v3.md section 10.2): the item rows. Later items append here (at most 9). */
export interface SettingsItem {
  id: "keys";
  label: string;
  value: string;
  description: string;
}
export const SETTINGS_ROW_COLS = 26;
export const SETTINGS_HINT = "SAVE set  HOME back";
export const SETTINGS_TITLE = "SETTINGS";

export function settingsItems(keys: KeyMode): SettingsItem[] {
  return [
    {
      id: "keys",
      label: "Keys",
      value: keys === "split" ? "Split" : "Ranked",
      description: keys === "split" ? "Black keys: filters, tasks" : "Every key is a session",
    },
  ];
}

/** `label.padEnd(26 - value.length) + value`: exactly 26 characters. */
export const settingsRow = (it: SettingsItem): string => `${it.label.padEnd(SETTINGS_ROW_COLS - it.value.length)}${it.value}`.slice(0, SETTINGS_ROW_COLS);

/** Validates a restored SPLIT choice (config `split`); anything off becomes the default. */
export function validSplit(v: unknown): SplitState {
  if (typeof v !== "object" || v === null) return { ...DEFAULT_SPLIT };
  const o = v as Partial<SplitState>;
  const chosen = SPLIT_CHOICES.includes(o.chosen as SplitChoice) ? (o.chosen as SplitChoice) : "all";
  const task = chosen === "task" && typeof o.task === "string" && isTaskKey(o.task) ? o.task : null;
  const taskPage = typeof o.taskPage === "number" && Number.isInteger(o.taskPage) && o.taskPage >= 0 && o.taskPage <= 126 ? o.taskPage : 0;
  if (chosen === "task" && task === null) return { chosen: "all", task: null, taskPage };
  return { chosen, task, taskPage };
}
