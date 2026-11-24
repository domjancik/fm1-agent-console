import { sessionKey } from "./identity";
import type { SessionEntry, SessionRegistry } from "./registry";
import { activityAt, effectiveState } from "./status";
import type { NormalizedState, SessionRef } from "./types";

export type InboxKind = "approval" | "question" | "failure" | "completed";

export interface InboxItem {
  /** Stable while the condition persists; a new occurrence of the same condition gets a new id. */
  id: string;
  kind: InboxKind;
  sessionKey: string;
  sessionRef: SessionRef;
  approvalId?: string;
  summary: string;
  since: number;
  /** Last activity of the session (results age by it). */
  activityAt: number;
  read: boolean;
  dismissed: boolean;
}

const GONE_MAX = 256;

/** FX again within this long after a TO DO dismiss restores the item (docs/ux-v2.md section 3.6). */
export const DISMISS_UNDO_MS = 3_000;

/** Windows of docs/ux-v2.md section 3.2 (also exported from focus.ts). */
export const RESULT_WINDOW_MS = 72 * 3_600_000;
export const RECENT_WINDOW_MS = 8 * 3_600_000;

const STATE_KIND: Partial<Record<NormalizedState, InboxKind>> = {
  approval_required: "approval",
  waiting_input: "question",
  failed: "failure",
  completed_unread: "completed",
};

interface Occurrence {
  kind: InboxKind;
  id: string;
  since: number;
}

/**
 * TO DO tier of an inbox item (T0-T3, T6), or null when it no longer belongs in TO DO
 * (dismissed, or a result that was read).
 */
export function itemTier(item: InboxItem, now: number): 0 | 1 | 2 | 3 | 6 | null {
  if (item.kind === "approval") return 0;
  if (item.dismissed) return null; // FX dismiss hides questions and results alike (section 3.6)
  if (item.kind === "question") return 1;
  if (item.kind === "completed" && item.read) return null;
  if (now - item.activityAt > RESULT_WINDOW_MS) return 6;
  return item.kind === "failure" ? 2 : 3;
}

/** Tier order; T0/T1 oldest request first, results newest first; id breaks ties. */
export function compareItems(a: InboxItem, b: InboxItem, now: number): number {
  const ta = itemTier(a, now) ?? 9;
  const tb = itemTier(b, now) ?? 9;
  if (ta !== tb) return ta - tb;
  const d = ta <= 1 ? a.since - b.since : b.activityAt - a.activityAt;
  return d || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Attention items derived from the registry, with read and dismiss tracking that survive re-syncs. */
export class Inbox {
  private current: InboxItem[] = [];
  private active = new Map<string, Occurrence>();
  private occurrences = new Map<string, number>();
  private readIds = new Set<string>();
  private dismissedIds = new Set<string>();
  private syncedAt = 0;
  /**
   * Items that left the inbox (answered approval, session gone). TO DO keeps their keys until its next re-sort
   * (docs/ux-v2.md sections 3.4 and 3.6), so the view can still draw them. Bounded; oldest dropped first.
   */
  private gone = new Map<string, InboxItem>();

  sync(registry: SessionRegistry, now: number): void {
    this.syncedAt = now;
    const next: InboxItem[] = [];
    const approvals = registry.approvals();
    const withRequest = new Set(approvals.map((a) => sessionKey(a.sessionRef)));
    for (const a of approvals) {
      const entry = registry.get(sessionKey(a.sessionRef));
      if (!entry || entry.stale) continue;
      next.push(this.item(`approval:${a.id}`, "approval", entry, a.summary, a.createdAt, a.id));
    }
    const nextActive = new Map<string, Occurrence>();
    for (const entry of registry.sessions()) {
      if (entry.stale) continue;
      const kind = STATE_KIND[effectiveState(entry.session.status)];
      if (!kind || (kind === "approval" && withRequest.has(entry.key))) continue;
      const occ = this.occurrenceFor(entry.key, kind, now);
      nextActive.set(entry.key, occ);
      next.push(this.item(occ.id, kind, entry, entry.session.summary ?? entry.session.title, occ.since));
    }
    this.active = nextActive;
    const ids = new Set(next.map((i) => i.id));
    for (const id of this.readIds) if (!ids.has(id)) this.readIds.delete(id);
    for (const id of this.dismissedIds) if (!ids.has(id)) this.dismissedIds.delete(id);
    for (const old of this.current) if (!ids.has(old.id)) this.gone.set(old.id, old);
    for (const id of ids) this.gone.delete(id);
    while (this.gone.size > GONE_MAX) this.gone.delete(this.gone.keys().next().value as string);
    this.current = next.sort((a, b) => compareItems(a, b, now));
  }

  private occurrenceFor(key: string, kind: InboxKind, now: number): Occurrence {
    const prev = this.active.get(key);
    if (prev && prev.kind === kind) return prev;
    const n = (this.occurrences.get(key) ?? 0) + 1;
    this.occurrences.set(key, n);
    return { kind, id: `${kind}:${key}#${n}`, since: now };
  }

  private item(id: string, kind: InboxKind, e: SessionEntry, summary: string, since: number, approvalId?: string): InboxItem {
    const item: InboxItem = {
      id,
      kind,
      sessionKey: e.key,
      sessionRef: e.session.ref,
      summary,
      since,
      activityAt: activityAt(e.session),
      read: this.readIds.has(id),
      dismissed: this.dismissedIds.has(id),
    };
    if (approvalId !== undefined) item.approvalId = approvalId;
    return item;
  }

  /** Every current item (read and dismissed included), in TO DO order as of the last sync. */
  items(): readonly InboxItem[] {
    return this.current;
  }

  /** What TO DO lists: T0-T3, then T6, in tier order. */
  todo(now: number = this.syncedAt): InboxItem[] {
    return this.current.filter((i) => itemTier(i, now) !== null).sort((a, b) => compareItems(a, b, now));
  }

  get(id: string): InboxItem | undefined {
    return this.current.find((i) => i.id === id);
  }

  /** A current item, or the last copy of one that has left the inbox (see `gone`). */
  known(id: string): InboxItem | undefined {
    return this.get(id) ?? this.gone.get(id);
  }

  /** The current non-approval occurrence of a session's attention condition. */
  occurrence(key: string): { id: string; kind: InboxKind; since: number } | undefined {
    const occ = this.active.get(key);
    return occ ? { ...occ } : undefined;
  }

  markRead(id: string): boolean {
    const item = this.current.find((i) => i.id === id);
    if (!item) return false;
    this.readIds.add(id);
    item.read = true;
    return true;
  }

  /** Marks a session's current completed occurrence read (selecting it acknowledges it). False when there is none. */
  markSessionRead(key: string): boolean {
    const occ = this.active.get(key);
    if (!occ || occ.kind !== "completed" || this.readIds.has(occ.id)) return false;
    this.readIds.add(occ.id);
    const item = this.current.find((i) => i.id === occ.id);
    if (item) item.read = true;
    return true;
  }

  /** Hides one occurrence locally (never touches the backend). Approvals cannot be dismissed. */
  dismiss(id: string): boolean {
    const item = this.current.find((i) => i.id === id);
    if (!item || item.kind === "approval") return false;
    this.dismissedIds.add(id);
    item.dismissed = true;
    return true;
  }

  /** Undoes `dismiss` (FX within DISMISS_UNDO_MS). False when the item is gone or was not dismissed. */
  undismiss(id: string): boolean {
    const item = this.current.find((i) => i.id === id);
    if (!item || !this.dismissedIds.has(id)) return false;
    this.dismissedIds.delete(id);
    item.dismissed = false;
    return true;
  }

  isDismissed(id: string): boolean {
    return this.dismissedIds.has(id);
  }

  unreadCount(): number {
    return this.current.filter((i) => !i.read).length;
  }

  /** The badge: T0-T3 items that are unread and not dismissed. */
  attentionCount(now: number = this.syncedAt): number {
    return this.current.filter((i) => {
      const t = itemTier(i, now);
      return t !== null && t <= 3 && !i.read && !i.dismissed;
    }).length;
  }

  /** completed_unread becomes completed_read locally once its inbox item is read. */
  displayState(entry: SessionEntry): NormalizedState {
    const state = effectiveState(entry.session.status);
    if (state !== "completed_unread") return state;
    const occ = this.active.get(entry.key);
    return occ && occ.kind === "completed" && this.readIds.has(occ.id) ? "completed_read" : state;
  }
}
