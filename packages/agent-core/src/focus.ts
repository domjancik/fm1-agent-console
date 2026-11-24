// Actionable-first ordering, scopes and the frozen key layout (docs/ux-v2.md section 3). Pure apart from FocusLayout.
import type { Scope } from "./copy";
import { isSessionKey, isTaskKey, taskKey, taskOf } from "./identity";
import { compareItems, itemTier, RECENT_WINDOW_MS, RESULT_WINDOW_MS, type Inbox, type InboxItem } from "./inbox";
import type { SessionEntry, SessionRegistry } from "./registry";
import { PAGE_SIZE } from "./slots";
import { activityAt } from "./status";
import type { Project, Task } from "./types";

export { RECENT_WINDOW_MS, RESULT_WINDOW_MS };
/** A completed_unread session selected this long counts as read (its key stops ticking, the badge drops it). */
export const READ_DWELL_MS = 1_500;
export const AUTO_RESORT_MS = 60_000;
/**
 * Safety cap per pin kind (operator decision 2026-11-19, "no limit"; docs/ux-v2.md section 3.5): at most 200 session
 * pins and, separately, 200 task pins. Pins take no fixed keys; they only order the layout.
 */
export const MAX_PINS_PER_KIND = 200;
/** The session pins (5-part keys) of a pin list, in pin order. */
export const sessionPinsOf = (pins: readonly string[] | undefined): string[] => (pins ?? []).filter(isSessionKey);
/** The task pins (4-part keys) of a pin list, in pin order. */
export const taskPinsOf = (pins: readonly string[] | undefined): string[] => (pins ?? []).filter(isTaskKey);
/** Keys 24-26 (F5, F#5, G5) of page 1 stay free for arrivals at layout time. */
export const RESERVED_START = 24;

export type Tier = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const SCOPE_MAX_TIER: Record<Scope, Tier> = { active: 4, recent: 5, all: 7, pinned: 7 };
/** T0-T3: blocks an agent or is a fresh result. */
export const isAttention = (t: number): boolean => t <= 3;

export interface FocusWorld {
  registry: SessionRegistry;
  inbox: Inbox;
  now: number;
}

/** Tier of a session (display state with inbox read state applied, last activity, local dismiss set). */
export function tierOf(e: SessionEntry, inbox: Inbox, now: number, registry?: SessionRegistry): Tier {
  const state = inbox.displayState(e);
  if (state === "approval_required" || (registry !== undefined && registry.approvalsFor(e.key).length > 0)) return 0;
  const occ = inbox.occurrence(e.key);
  const dismissed = occ !== undefined && inbox.isDismissed(occ.id);
  if (state === "waiting_input" && !dismissed) return 1;
  const age = now - activityAt(e.session);
  if (!dismissed && (state === "failed" || state === "completed_unread")) {
    if (age <= RESULT_WINDOW_MS) return state === "failed" ? 2 : 3;
    return 6;
  }
  if (state === "working") return 4;
  return age <= RECENT_WINDOW_MS ? 5 : 7;
}

export interface Ranked {
  key: string;
  tier: Tier;
  /** Within-tier sort value, ascending. */
  order: number;
  activity: number;
  projectId: string;
  taskKey: string;
}

export function rank(e: SessionEntry, w: FocusWorld): Ranked {
  const tier = tierOf(e, w.inbox, w.now, w.registry);
  const activity = activityAt(e.session);
  let order = -activity;
  if (tier === 0) {
    const a = w.registry.approvalsFor(e.key)[0];
    order = a?.createdAt ?? w.inbox.occurrence(e.key)?.since ?? activity;
  } else if (tier === 1) {
    order = w.inbox.occurrence(e.key)?.since ?? activity;
  }
  return { key: e.key, tier, order, activity, projectId: e.session.ref.projectId, taskKey: taskKey(taskOf(e.session.ref)) };
}

/** Tier, then the within-tier rule, then sessionKey ascending: deterministic. */
export function compareFocus(a: Ranked, b: Ranked): number {
  return a.tier - b.tier || a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

export interface Filters {
  scope: Scope;
  repoFilter: string | null;
  taskFilter: string | null;
  /** Session and task keys (docs/ui-v3.md section 9.6); needed by the PINNED scope. */
  pins?: readonly string[];
  /** SPLIT keys (docs/ui-v3.md section 10.4): the Grouped layout never folds a task. */
  noFold?: boolean;
}

/** Live sessions ranked, unfiltered. */
export function rankedSessions(w: FocusWorld): Ranked[] {
  return w.registry
    .sessions()
    .filter((e) => !e.stale)
    .map((e) => rank(e, w))
    .sort(compareFocus);
}

const inScope = (r: Ranked, scope: Scope): boolean => r.tier <= SCOPE_MAX_TIER[scope];

/**
 * The sorted members of the scope under the repo and task filters. PINNED: every live pinned session, all repos and
 * tiers (task pins take no session key, docs/ux-v2.md section 3.5).
 */
export function scopeMembers(f: Filters, w: FocusWorld): Ranked[] {
  if (f.scope === "pinned") {
    const pins = new Set(sessionPinsOf(f.pins));
    return rankedSessions(w).filter((r) => pins.has(r.key));
  }
  return rankedSessions(w).filter(
    (r) => inScope(r, f.scope) && (f.repoFilter === null || r.projectId === f.repoFilter) && (f.taskFilter === null || r.taskKey === f.taskFilter),
  );
}

export interface Group {
  id: string;
  tier: Tier;
  activity: number;
}

export function groupBest(rs: readonly Ranked[], by: (r: Ranked) => string): Map<string, Group> {
  const out = new Map<string, Group>();
  for (const r of rs) {
    const id = by(r);
    const g = out.get(id);
    if (!g) out.set(id, { id, tier: r.tier, activity: r.activity });
    else {
      g.tier = Math.min(g.tier, r.tier) as Tier;
      g.activity = Math.max(g.activity, r.activity);
    }
  }
  return out;
}

export const byGroup = (name: (id: string) => string) => (a: Group, b: Group): number =>
  a.tier - b.tier || b.activity - a.activity || name(a.id).localeCompare(name(b.id)) || (a.id < b.id ? -1 : 1);

/** KNOB2 choices: repos with at least one session in the scope, best tier first. */
export function repoChoices(f: Filters, w: FocusWorld): Project[] {
  const projects = new Map(w.registry.projects().map((p) => [p.projectId, p]));
  const name = (id: string): string => projects.get(id)?.name ?? id;
  const groups = groupBest(rankedSessions(w).filter((r) => inScope(r, f.scope)), (r) => r.projectId);
  return [...groups.values()].sort(byGroup(name)).map((g) => projects.get(g.id) ?? { backendId: "", hostId: "", projectId: g.id, name: g.id });
}

export interface RankedTask {
  task: Task;
  key: string;
  tier: Tier;
  activity: number;
}

/** KNOB3 choices and the Tasks view: tasks of the repo filter with a session in the scope, best tier first. */
export function taskChoices(f: Pick<Filters, "scope" | "repoFilter">, w: FocusWorld): RankedTask[] {
  const rs = rankedSessions(w).filter((r) => inScope(r, f.scope) && (f.repoFilter === null || r.projectId === f.repoFilter));
  const groups = groupBest(rs, (r) => r.taskKey);
  const title = (k: string): string => w.registry.task(k)?.title ?? "";
  return [...groups.values()]
    .sort(byGroup(title))
    .flatMap((g) => {
      const task = w.registry.task(g.id);
      return task ? [{ task, key: g.id, tier: g.tier, activity: g.activity }] : [];
    });
}

/** TO DO: one item per attention condition across all repos and tasks; T0-T3 then T6. */
export function todoItems(w: FocusWorld): InboxItem[] {
  return w.inbox
    .items()
    .filter((i) => itemTier(i, w.now) !== null)
    .slice()
    .sort((a, b) => compareItems(a, b, w.now));
}

export interface LayoutData {
  readonly slots: readonly (string | null)[];
  /** Arrivals that found no free key; placed at the next re-sort. */
  readonly pending: readonly string[];
  /** Keys that were attention items when placed, so they are not treated as arrivals again. */
  readonly seen: readonly string[];
  /** When the layout was last re-sorted; null before the first one. */
  readonly builtAt: number | null;
  /** GROUPED (docs/ui-v3.md section 9.2): each key's group at layout time; a key placed later has none (`New`). */
  readonly groups?: Readonly<Record<string, string>>;
  /**
   * SPLIT white keys (docs/ui-v3.md section 10.4): keys per page and the first key kept free on page 1 for arrivals.
   * Absent: the flat 27 keys with 24-26 reserved (every RANKED layout).
   */
  readonly pageSize?: number;
  readonly reserve?: number;
}

export const EMPTY_LAYOUT: LayoutData = { slots: [], pending: [], seen: [], builtAt: null };

/**
 * A frozen, paged key layout. `relayout` sorts; between re-sorts keys never move, arrivals take the first
 * free key of page 1 (the reserved keys 24-26 when the list is long), and the rest wait in `pending`.
 */
export class FocusLayout {
  private slots: (string | null)[];
  private pend: string[];
  private seenKeys: Set<string>;
  private built: number | null;
  private groupOf: Record<string, string> | undefined;
  /** Keys per page and the reserved start on page 1 (SPLIT white keys: 16 and 15; otherwise 27 and 24). */
  readonly pageSize: number;
  private readonly reserve: number;

  constructor(data: LayoutData = EMPTY_LAYOUT) {
    this.slots = [...data.slots];
    this.pend = [...data.pending];
    this.seenKeys = new Set(data.seen);
    this.built = data.builtAt;
    this.groupOf = data.groups ? { ...data.groups } : undefined;
    this.pageSize = data.pageSize ?? PAGE_SIZE;
    this.reserve = data.reserve ?? RESERVED_START;
  }

  /**
   * `pins` first (callers today pass the full order in `keys` and no pins), then the sorted keys up to key 23 on page 1,
   * then 27 keys per page. `groups` (GROUPED) records each key's group.
   */
  relayout(keys: readonly string[], pins: readonly string[] = [], now: number | null = this.built ?? 0, seen: readonly string[] = [], groups?: Readonly<Record<string, string>>): this {
    const pinned = [...new Set(pins)];
    const seq = [...pinned, ...keys.filter((k) => !pinned.includes(k))];
    const page1 = seq.slice(0, this.reserve);
    const later = seq.slice(this.reserve);
    this.slots = later.length === 0 ? page1 : [...page1, ...Array<null>(this.pageSize - page1.length).fill(null), ...later];
    this.pend = [];
    this.seenKeys = new Set(seen);
    this.built = now;
    this.groupOf = groups ? { ...groups } : undefined;
    return this;
  }

  /** GROUPED: the group a key was laid out in; undefined for a key placed after the re-sort (an arrival). */
  group(key: string): string | undefined {
    return this.groupOf?.[key];
  }

  get grouped(): boolean {
    return this.groupOf !== undefined;
  }

  /** Places arrivals into free keys of page 1; returns the keys placed. Keys already present stay put. */
  place(arrivals: readonly string[]): string[] {
    const placed: string[] = [];
    for (const k of arrivals) {
      this.seenKeys.add(k);
      if (this.slots.includes(k) || this.pend.includes(k)) continue;
      const free = this.firstFree();
      if (free < 0) {
        this.pend.push(k);
        continue;
      }
      while (this.slots.length <= free) this.slots.push(null);
      this.slots[free] = k;
      placed.push(k);
    }
    return placed;
  }

  /** Moves a key that sits beyond page 1 into a free key of page 1 (an item that just needs attention). */
  promote(key: string): boolean {
    this.seenKeys.add(key);
    const at = this.slots.indexOf(key);
    if (at >= 0 && at < this.pageSize) return false;
    const free = this.firstFree();
    if (free < 0) {
      if (!this.pend.includes(key)) this.pend.push(key);
      return false;
    }
    if (at >= 0) this.slots[at] = null;
    while (this.slots.length <= free) this.slots.push(null);
    this.slots[free] = key;
    this.trim();
    return true;
  }

  /** Puts `key` back at `index` when that key is free (an undone TO DO dismiss); false when taken or out of range. */
  putAt(key: string, index: number): boolean {
    if (index < 0 || this.slots.includes(key) || (this.slots[index] ?? null) !== null) return false;
    while (this.slots.length <= index) this.slots.push(null);
    this.slots[index] = key;
    this.seenKeys.add(key);
    this.pend = this.pend.filter((k) => k !== key);
    return true;
  }

  /** Frees the keys of entries that no longer exist (pruned stale sessions, answered items). */
  release(exists: (key: string) => boolean): void {
    this.slots = this.slots.map((k) => (k !== null && !exists(k) ? null : k));
    this.pend = this.pend.filter(exists);
    this.trim();
  }

  /** Drops pending keys that no longer qualify. */
  keepPending(pred: (key: string) => boolean): void {
    this.pend = this.pend.filter(pred);
  }

  private firstFree(): number {
    for (let i = 0; i < this.pageSize; i++) if ((this.slots[i] ?? null) === null) return i;
    return -1;
  }

  private trim(): void {
    while (this.slots.length > 0 && this.slots[this.slots.length - 1] === null) this.slots.pop();
  }

  page(n: number): (string | null)[] {
    const start = n * this.pageSize;
    return Array.from({ length: this.pageSize }, (_, i) => this.slots[start + i] ?? null);
  }

  pageCount(): number {
    return Math.max(1, Math.ceil(this.slots.length / this.pageSize));
  }

  /** Page index of a layout position (0 for -1). */
  pageOf(i: number): number {
    return Math.max(0, Math.floor(i / this.pageSize));
  }

  get pendingNew(): number {
    return this.pend.length;
  }

  get builtAt(): number | null {
    return this.built;
  }

  wasSeen(key: string): boolean {
    return this.seenKeys.has(key);
  }

  keys(): readonly (string | null)[] {
    return this.slots;
  }

  indexOf(key: string): number {
    return this.slots.indexOf(key);
  }

  data(): LayoutData {
    let d: LayoutData = { slots: [...this.slots], pending: [...this.pend], seen: [...this.seenKeys], builtAt: this.built };
    if (this.groupOf) d = { ...d, groups: { ...this.groupOf } };
    // (the geometry only when it is not the flat 27 keys, so RANKED layout data stays exactly as before)
    if (this.pageSize !== PAGE_SIZE || this.reserve !== RESERVED_START) d = { ...d, pageSize: this.pageSize, reserve: this.reserve };
    return d;
  }
}

/** Page index of a layout position. */
export const pageOfIndex = (i: number): number => Math.max(0, Math.floor(i / PAGE_SIZE));

// ---------------------------------------------------------------------------------------------------------------
// GROUPED layout (docs/ui-v3.md section 9.2): the frozen order grouped by task, with a Pinned group first.

/** Group ids of the Grouped layout: the Pinned group, arrivals placed between re-sorts, and one per task. */
export const PINNED_GROUP = "pinned";
export const NEW_GROUP = "new";
export const taskGroup = (tk: string): string => `task:${tk}`;

export interface GroupedBuild {
  /** Session keys and folded task rows (task keys), in key order. */
  keys: string[];
  /** Each key's group id. */
  groups: Record<string, string>;
  /** Attention keys at layout time (not arrivals afterwards). */
  seen: string[];
}

/** Members in priority order with each sub-agent right after its parent (parent in the same group), siblings by tier. */
export function nestChildren(members: readonly Ranked[], parentOf: (key: string) => string | undefined): Ranked[] {
  const inGroup = new Set(members.map((m) => m.key));
  const children = new Map<string, Ranked[]>();
  const isRoot = (m: Ranked): boolean => {
    const p = parentOf(m.key);
    return p === undefined || p === m.key || !inGroup.has(p);
  };
  for (const m of members) {
    if (isRoot(m)) continue;
    const p = parentOf(m.key) as string;
    const list = children.get(p) ?? [];
    list.push(m);
    children.set(p, list);
  }
  const out: Ranked[] = [];
  const done = new Set<string>();
  const emit = (m: Ranked): void => {
    if (done.has(m.key)) return;
    done.add(m.key);
    out.push(m);
    for (const c of children.get(m.key) ?? []) emit(c);
  };
  for (const m of members) if (isRoot(m)) emit(m);
  for (const m of members) emit(m); // members of a parent cycle, in priority order
  return out;
}

/**
 * The Grouped frozen order (operator decision 2026-11-22, pins first; docs/ui-v3.md section 9.2), group by group: first
 * the Pinned group (every pinned session, whatever its state and whatever SHOW says), then the task groups with a
 * session that needs you (T0-T3), then the other task groups of the scope. Inside each part: best tier, newest activity,
 * title (`byGroup`). A pinned session is always taken out of its task group.
 * A task group outside the first part with no T0-T4 session folds into one key (its task key), except the TASK
 * filter's task and with `noFold`. Task pins take no session key: they only mark the header. PINNED: the live session
 * pins (all repos) in the same two parts, then one folded row per pinned task (so every pin can be seen and unpinned).
 */
export function groupedLayout(f: Filters, w: FocusWorld): GroupedBuild {
  const pinnedScope = f.scope === "pinned";
  const repoOk = (projectId: string): boolean => pinnedScope || f.repoFilter === null || projectId === f.repoFilter;
  const taskOk = (tk: string): boolean => pinnedScope || f.taskFilter === null || tk === f.taskFilter;
  const live = rankedSessions(w);
  const parentOf = (k: string): string | undefined => w.registry.get(k)?.session.parentKey;
  const keys: string[] = [];
  const groups: Record<string, string> = {};
  const seen: string[] = [];
  const put = (r: Ranked, g: string): void => {
    keys.push(r.key);
    groups[r.key] = g;
    if (isAttention(r.tier)) seen.push(r.key);
  };
  const fold = (tk: string): void => {
    keys.push(tk);
    groups[tk] = taskGroup(tk);
  };

  const sessionPins = new Set(sessionPinsOf(f.pins));
  const pinnedLive = live.filter((r) => sessionPins.has(r.key) && repoOk(r.projectId) && taskOk(r.taskKey));
  const scoped = pinnedScope ? [] : scopeMembers(f, w);
  const inList = new Set([...pinnedLive, ...scoped].map((r) => r.key));
  const members = live.filter((r) => inList.has(r.key)); // one ranking pass: priority order, no duplicates
  const pinGroup = members.filter((r) => sessionPins.has(r.key));
  const inPinGroup = new Set(pinGroup.map((r) => r.key));
  const taskMembers = members.filter((r) => !inPinGroup.has(r.key));
  const title = (tk: string): string => w.registry.task(tk)?.title ?? "";
  const order = [...groupBest(taskMembers, (r) => r.taskKey).values()].sort(byGroup(title));
  const putTask = (tk: string): void => {
    for (const r of nestChildren(taskMembers.filter((m) => m.taskKey === tk), parentOf)) put(r, taskGroup(tk));
  };

  for (const r of nestChildren(pinGroup, parentOf)) put(r, PINNED_GROUP);
  for (const g of order) if (isAttention(g.tier)) putTask(g.id);
  for (const g of order) {
    if (isAttention(g.tier)) continue;
    const folded = !pinnedScope && !f.noFold && g.tier > 4 && g.id !== f.taskFilter;
    if (folded) fold(g.id);
    else putTask(g.id);
  }
  if (pinnedScope) {
    const placed = new Set(keys);
    for (const tk of taskPinsOf(f.pins)) if (w.registry.task(tk) !== undefined && !placed.has(tk)) fold(tk);
  }
  return { keys, groups, seen };
}

/**
 * The flat order (Buddy and List, RANKED and SPLIT white keys; operator decision 2026-11-22, pins first): the pinned
 * sessions first (whatever their state), then the other sessions that need you (T0-T3), then the rest; priority order
 * (`compareFocus`) inside each part.
 * `members` are the scope's sessions, `pinned` the live session pins the filters allow (SHOW does not apply to them).
 * Returns the keys and the attention keys (`seen`).
 */
export function flatOrder(members: readonly Ranked[], pinned: readonly Ranked[]): { keys: string[]; seen: string[] } {
  const byKey = new Map<string, Ranked>();
  for (const r of [...members, ...pinned]) if (!byKey.has(r.key)) byKey.set(r.key, r);
  const all = [...byKey.values()].sort(compareFocus);
  const pins = new Set(pinned.map((r) => r.key));
  const pin = all.filter((r) => pins.has(r.key));
  const need = all.filter((r) => isAttention(r.tier) && !pins.has(r.key));
  const rest = all.filter((r) => !isAttention(r.tier) && !pins.has(r.key));
  return { keys: [...pin, ...need, ...rest].map((r) => r.key), seen: all.filter((r) => isAttention(r.tier)).map((r) => r.key) };
}

/** The live session pins inside the repo and task filters (SHOW does not apply to pins), ranked. */
export function pinnedSessions(f: Filters, w: FocusWorld): Ranked[] {
  const pins = new Set(sessionPinsOf(f.pins));
  return rankedSessions(w).filter((r) => pins.has(r.key) && (f.repoFilter === null || r.projectId === f.repoFilter) && (f.taskFilter === null || r.taskKey === f.taskFilter));
}
