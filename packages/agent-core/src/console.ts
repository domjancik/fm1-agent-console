// Wires adapter + registry + inbox + composer + controller. The only place controller actions become I/O.
import { realTimers, VoiceComposer, type Destination, type Timers } from "./composer";
import { canStartTake } from "./composer-state";
import {
  currentView,
  DEFAULT_SCREEN,
  LIST_VIEWS,
  orderWouldChange,
  pruneSpent,
  reconcile,
  relayout,
  relayoutKeepingSelection,
  resortSplit,
  sessionsGrouped,
  splitOn,
  validScreen,
  type ListView,
  type ScreenLayout,
} from "./context";
import { applyKeyMode, arpHoldElapsed, closeReader, initialController, KNOB3_REST_MS, playHoldElapsed, reduce, resolveKnob3, resolveOct, type ControllerAction, type ControllerState, type World } from "./controller";
import { READ_ALOUD_HOLD_MS } from "./speech";
import { cannedList, type CannedEntry } from "./canned";
import { ARP_HOLD_MS, OCT_DOUBLE_MS, validSplit, type KeyMode, type SplitState } from "./split";
import { NOTICE, READER_AUTO_RETURN_MS, type ToastAction } from "./copy";
import { AUTO_RESORT_MS, MAX_PINS_PER_KIND, READ_DWELL_MS } from "./focus";
import type { DeviceInput } from "./controls";
import { PromptDispatcher } from "./dispatcher";
import { isSessionKey, isTaskKey, parseSessionKey, projectKey, sessionKey, taskKey, taskOf } from "./identity";
import { Inbox } from "./inbox";
import { SessionRegistry } from "./registry";
import { backendName, type AgentAdapter, type AgentEvent, type CommandResult, type Result, type SessionRef, type TaskRef } from "./types";
import { checkedResult, parseSnapshot } from "./validate";
import { buildView, type DeviceView } from "./view";

export interface ConsoleOptions {
  adapter: AgentAdapter;
  now?: () => number;
  timers?: Timers;
  ackTimeoutMs?: number;
  staleRetentionMs?: number;
  newRequestId?: () => string;
  /**
   * Pins restored from the companion config (docs/ui-v3.md section 9.6): session keys and task keys kept apart, or one
   * legacy mixed list (split by key shape). At most MAX_PINS_PER_KIND (200) of each kind are kept.
   */
  pins?: readonly string[] | Partial<PinLists>;
  /** Called with both pin lists whenever a pin is added, removed or dropped. */
  onPinsChanged?: (pins: PinLists) => void;
  /** Layout per list view restored from the companion config (docs/ui-v3.md section 8.7); missing views use the defaults. */
  layouts?: Partial<Record<ListView, ScreenLayout>>;
  /** Called with both layouts whenever SEQ changes one. */
  onLayoutsChanged?: (layouts: Record<ListView, ScreenLayout>) => void;
  /** SETTINGS restored from the companion config (docs/ui-v3.md section 10.2): Keys Ranked (default) or Split. */
  settings?: { keys?: KeyMode };
  /** Called whenever SETTINGS changes a value on the device. */
  onSettingsChanged?: (settings: { keys: KeyMode }) => void;
  /** The SPLIT choice and task page restored from the companion config (docs/ui-v3.md section 10.10). */
  split?: Partial<SplitState>;
  /** Called (at most once a second, trailing) when the SPLIT choice or task page changed. */
  onSplitChanged?: (split: SplitState) => void;
  /** Canned responses restored from the companion config (docs/ui-v3.md section 12); default none. */
  canned?: readonly CannedEntry[];
  /** Called with the whole sorted list whenever the device changes it (ARP save, a send, FX hold delete, undo). */
  onCannedChanged?: (canned: CannedEntry[]) => void;
  /** Read aloud (docs/ui-v3.md section 14): the companion's speech pipeline. Absent: hold PLAY does nothing audible. */
  readAloud?: ReadAloudPort;
}

/** The speech side of read aloud. `speaking` is true from `speak` until playback ends, fails or is stopped. */
export interface ReadAloudPort {
  speak(text: string, sessionKey: string): void;
  stop(): void;
  speaking(): boolean;
}

/** Session pins and task pins, stored and counted apart (operator decision 2026-11-19), each in pin order. */
export interface PinLists {
  sessions: string[];
  tasks: string[];
}

/** Splits a pin list by key shape, drops duplicates and malformed keys, and keeps at most 200 of each kind. */
export function pinLists(pins: readonly string[] | Partial<PinLists> | undefined): PinLists {
  const all = Array.isArray(pins) ? (pins as readonly unknown[]) : [...((pins as Partial<PinLists> | undefined)?.sessions ?? []), ...((pins as Partial<PinLists> | undefined)?.tasks ?? [])];
  const uniq = [...new Set(all.filter((p): p is string => typeof p === "string"))];
  return { sessions: uniq.filter(isSessionKey).slice(0, MAX_PINS_PER_KIND), tasks: uniq.filter(isTaskKey).slice(0, MAX_PINS_PER_KIND) };
}

const splitPins = (pins: readonly string[]): PinLists => ({ sessions: pins.filter(isSessionKey), tasks: pins.filter(isTaskKey) });

/**
 * Pins outside the adapter's scan (docs/traycer-integration.md, "Pins outside the scan"): one `fetchPinned` call carries
 * the pins of at most this many tasks (the adapter reads each task once, whatever the number of pins in it).
 */
export const PIN_FETCH_TASKS = 25;
/** While some out-of-scan pin has not been asked for since the last snapshot: one batch per this interval (catch-up). */
export const PIN_CATCHUP_MS = 5_000;
/** Afterwards: one batch per this interval, rotating over the out-of-scan pins' tasks. */
export const PIN_REFRESH_MS = 120_000;

/** A task key's TaskRef (4 percent-encoded parts), or null for a malformed one (a bad escape in a restored pin). */
function parseTaskKey(k: string): TaskRef | null {
  try {
    const p = k.split("/").map(decodeURIComponent);
    return p.length === 4 && p.every((x) => x.length > 0) ? { backendId: p[0] ?? "", hostId: p[1] ?? "", projectId: p[2] ?? "", taskId: p[3] ?? "" } : null;
  } catch {
    return null;
  }
}

/** SPLIT choice saves are coalesced: at most one a second, the last value wins (docs/ui-v3.md section 10.10). */
export const SPLIT_SAVE_MS = 1000;

/** A recorded command outcome plus what it was about (picks the toast wording). */
export type RecordedResult = CommandResult & { action?: ToastAction };

export class AgentConsole {
  readonly registry: SessionRegistry;
  readonly inbox = new Inbox();
  readonly composer: VoiceComposer;
  readonly dispatcher: PromptDispatcher;
  readonly results: RecordedResult[] = [];
  readonly rejectedEvents: string[] = [];
  state: ControllerState = initialController;
  private readonly adapter: AgentAdapter;
  private readonly now: () => number;
  private readonly newRequestId: () => string;
  private unsubscribe: (() => void) | null = null;
  private pending = new Set<Promise<unknown>>();
  /** Approvals with a decision in flight or accepted; a second decision is never sent. */
  private answered = new Set<string>();
  private listeners = new Set<(v: DeviceView) => void>();
  private readonly onPinsChanged?: (pins: PinLists) => void;
  /** Session keys and task keys the last snapshot listed (the adapter's scan); pins outside it are fetched in batches. */
  private scanSessions = new Set<string>();
  private scanTasks = new Set<string>();
  /** Task keys whose out-of-scan pins were asked for since the last snapshot. */
  private pinAsked = new Set<string>();
  private pinCursor = 0;
  private pinFetchAt: number | null = null;
  private pinFetch: Promise<void> | null = null;
  private readonly onLayoutsChanged?: (layouts: Record<ListView, ScreenLayout>) => void;
  /** SCL (button SEL) is down: the firmware may be showing its help overlay, so nothing re-sorts underneath. */
  private sclHeld = false;
  private readonly timers: Timers;
  private readTimer: unknown = null;
  private readonly onSettingsChanged?: (settings: { keys: KeyMode }) => void;
  private readonly onSplitChanged?: (split: SplitState) => void;
  private readonly onCannedChanged?: (canned: CannedEntry[]) => void;
  /** One-shot timers of the protocol 6 host gestures (ARP hold, OCT double window) and the SPLIT save. */
  private arpTimer: unknown = null;
  private octTimer: unknown = null;
  private knob3Timer: unknown = null;
  private splitTimer: unknown = null;
  private playTimer: unknown = null;
  private readonly readAloud?: ReadAloudPort;
  private savedSplit: string;

  constructor(opts: ConsoleOptions) {
    this.adapter = opts.adapter;
    this.onPinsChanged = opts.onPinsChanged;
    this.onLayoutsChanged = opts.onLayoutsChanged;
    const screen = { ...DEFAULT_SCREEN };
    for (const v of LIST_VIEWS) {
      const l = opts.layouts?.[v];
      if (validScreen(v, l)) screen[v] = l;
    }
    const restored = pinLists(opts.pins);
    const pins = [...restored.sessions, ...restored.tasks];
    const keyMode: KeyMode = opts.settings?.keys === "split" ? "split" : "ranked";
    const split = validSplit({ ...initialController.split, ...(opts.split ?? {}) });
    this.state = { ...initialController, screen, pins, keyMode, split, canned: cannedList(opts.canned ?? []) };
    this.onCannedChanged = opts.onCannedChanged;
    this.onSettingsChanged = opts.onSettingsChanged;
    this.onSplitChanged = opts.onSplitChanged;
    this.readAloud = opts.readAloud;
    this.savedSplit = JSON.stringify(split);
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? realTimers;
    this.newRequestId = opts.newRequestId ?? (() => crypto.randomUUID());
    this.registry = new SessionRegistry({ staleRetentionMs: opts.staleRetentionMs });
    this.dispatcher = new PromptDispatcher(this.adapter, this.registry);
    this.composer = new VoiceComposer({
      dispatch: (id, dest, text) => this.dispatcher.dispatch(id, dest, text),
      precheck: (dest, id) => this.dispatcher.precheck(dest, id),
      isTargetLive: (dest) => this.isLive(dest),
      newRequestId: this.newRequestId,
      now: this.now,
      timers: opts.timers,
      ackTimeoutMs: opts.ackTimeoutMs,
    });
    this.composer.onChange(() => this.changed());
  }

  world(): World {
    return {
      registry: this.registry,
      inbox: this.inbox,
      composer: this.composer.state,
      capabilities: this.adapter.getCapabilities(),
      now: this.now(),
      backend: backendName(this.adapter),
      speaking: this.readAloud?.speaking() ?? false,
    };
  }

  view(): DeviceView {
    return buildView(this.state, this.world());
  }

  onView(fn: (v: DeviceView) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async start(): Promise<void> {
    this.unsubscribe ??= this.adapter.subscribe((e) => this.onEvent(e));
    await this.reconnect();
  }

  async stop(): Promise<void> {
    // The protocol 6 gesture timers die with the console; a SPLIT choice still waiting for its trailing save is saved now.
    for (const t of [this.arpTimer, this.octTimer, this.knob3Timer, this.playTimer]) if (t !== null) this.timers.clearTimeout(t);
    this.playTimer = null;
    this.readAloud?.stop();
    this.arpTimer = null;
    this.octTimer = null;
    this.knob3Timer = null;
    this.state = { ...this.state, arpDownAt: null, octPending: null, knob3At: null, fxDownAt: null, playDownAt: null };
    this.flushSplit();
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.adapter.disconnect();
  }

  /** Connects (if needed) and re-enumerates everything. Unresolved identities become stale. */
  async reconnect(): Promise<Result<void>> {
    try {
      await this.adapter.connect();
      await this.resync();
      return { ok: true, value: undefined };
    } catch (e) {
      this.registry.setConnection("disconnected");
      this.changed();
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async resync(): Promise<void> {
    const [projects, tasks, sessions, approvals] = await Promise.all([
      this.adapter.listProjects(),
      this.adapter.listTasks(),
      this.adapter.listSessions(),
      this.adapter.listApprovals(),
    ]);
    const { snapshot, rejected } = parseSnapshot({ projects, tasks, sessions, approvals });
    this.rejectedEvents.push(...rejected);
    this.registry.applySnapshot(snapshot, this.now());
    this.scanSessions = new Set(snapshot.sessions.map((x) => sessionKey(x.ref)));
    this.scanTasks = new Set(snapshot.sessions.map((x) => taskKey(taskOf(x.ref))));
    this.pinAsked.clear();
    if (this.pinFetch) await this.pinFetch;
    if (this.adapter.fetchPinned) await this.fetchPinnedBatch(this.now());
    else this.dropUnlisted();
    this.refresh();
  }

  /** Without `fetchPinned` (the mock): a pin whose session (or task) is missing after a full snapshot is dropped. */
  private dropUnlisted(): void {
    if (this.state.pins.length === 0) return;
    this.dropPins((k) => (isTaskKey(k) ? this.registry.task(k) === undefined : this.registry.get(k)?.stale !== false));
  }

  /**
   * The out-of-scan pins by task key, in pin order: session pins the last snapshot did not list, and task pins of tasks
   * with no session in it (their sessions order the SPLIT task row and fill a chosen pinned task).
   */
  private outOfScanPins(): Map<string, { sessions: SessionRef[]; task: TaskRef | null }> {
    const out = new Map<string, { sessions: SessionRef[]; task: TaskRef | null }>();
    const entry = (tk: string): { sessions: SessionRef[]; task: TaskRef | null } => {
      let e = out.get(tk);
      if (!e) out.set(tk, (e = { sessions: [], task: null }));
      return e;
    };
    for (const k of this.state.pins) {
      if (isSessionKey(k)) {
        if (this.scanSessions.has(k)) continue;
        const ref = parseSessionKey(k);
        if (ref) entry(taskKey(taskOf(ref))).sessions.push(ref);
      } else if (isTaskKey(k) && !this.scanTasks.has(k)) {
        const ref = this.registry.task(k)?.ref ?? parseTaskKey(k);
        if (ref) entry(k).task = ref;
      }
    }
    return out;
  }

  /** A slow pin batch is due (called from tick): catch-up while some out-of-scan pin was not asked for, else steady. */
  private pinFetchDue(now: number): boolean {
    if (!this.adapter.fetchPinned || this.pinFetch !== null || !this.registry.ready() || this.registry.connection() === "disconnected") return false;
    const out = this.outOfScanPins();
    if (out.size === 0) return false;
    const catchUp = [...out.keys()].some((tk) => !this.pinAsked.has(tk));
    return this.pinFetchAt === null || now - this.pinFetchAt >= (catchUp ? PIN_CATCHUP_MS : PIN_REFRESH_MS);
  }

  /**
   * One `fetchPinned` call for the pins of at most PIN_FETCH_TASKS out-of-scan tasks (docs/ui-v3.md sections 9.6-9.7):
   * first the tasks not asked for since the last snapshot (pin order), then round robin over all of them. The returned
   * sessions and tasks are upserted; only the pins the adapter reports gone (deleted or archived in Traycer) are dropped,
   * and a failed call keeps every pin.
   */
  private fetchPinnedBatch(now: number): Promise<void> {
    const run = async (): Promise<void> => {
      const fetchPinned = this.adapter.fetchPinned?.bind(this.adapter);
      if (!fetchPinned) return;
      const groups = [...this.outOfScanPins().entries()];
      if (groups.length === 0) return;
      const fresh = groups.filter(([tk]) => !this.pinAsked.has(tk));
      let pick: typeof groups;
      if (fresh.length > 0) pick = fresh.slice(0, PIN_FETCH_TASKS);
      else {
        const n = Math.min(PIN_FETCH_TASKS, groups.length);
        const start = this.pinCursor % groups.length;
        pick = Array.from({ length: n }, (_, i) => groups[(start + i) % groups.length] as (typeof groups)[number]);
        this.pinCursor = (start + n) % groups.length;
      }
      for (const [tk] of pick) this.pinAsked.add(tk);
      this.pinFetchAt = now;
      const sessions = pick.flatMap(([, g]) => g.sessions);
      const tasks = pick.flatMap(([, g]) => (g.task ? [g.task] : []));
      try {
        const r = await fetchPinned({ sessions, tasks });
        for (const task of r.tasks ?? []) this.applyFetched({ type: "task_upserted", task });
        for (const session of r.sessions ?? []) this.applyFetched({ type: "session_upserted", session });
        const gone = new Set(r.gone ?? []);
        if (gone.size > 0) this.dropPins((k) => gone.has(k));
      } catch (e) {
        this.rejectedEvents.push(`fetchPinned failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    const p = run().finally(() => {
      if (this.pinFetch === p) this.pinFetch = null;
    });
    this.pinFetch = p;
    return p;
  }

  private applyFetched(ev: AgentEvent): void {
    const r = this.registry.applyEvent(ev, this.now());
    if (!r.ok) this.rejectedEvents.push(r.error);
  }

  private dropPins(gone: (key: string) => boolean): void {
    const kept = this.state.pins.filter((k) => !gone(k));
    if (kept.length === this.state.pins.length) return;
    this.state = { ...this.state, pins: kept };
    this.onPinsChanged?.(splitPins(kept));
  }

  private onEvent(raw: unknown): void {
    const needsResync = !this.registry.ready();
    const r = this.registry.applyEvent(raw, this.now());
    if (!r.ok) {
      this.rejectedEvents.push(r.error);
      return;
    }
    const ev: AgentEvent = r.value;
    if (ev.type === "command_progress") {
      this.dispatcher.record(ev.requestId, ev.stage, ev.message);
      this.composer.progress(ev.requestId, ev.stage, ev.message);
    }
    if (ev.type === "connection" && ev.state !== "disconnected" && needsResync && this.unsubscribe) {
      this.track(this.resync().catch(() => this.registry.setConnection("disconnected")));
    }
    this.refresh();
  }

  private refresh(): void {
    this.inbox.sync(this.registry, this.now());
    this.state = pruneSpent(reconcile(this.state, this.world()), this.registry);
    this.composer.checkTarget();
    this.changed();
  }

  /**
   * Periodic housekeeping (the companion calls it every 5 s): after 60 s without device input, in a base view,
   * re-sorts the current view if its order would change, keeping the page index (clamped).
   */
  tick(now: number = this.now()): boolean {
    const w = { ...this.world(), now };
    this.inbox.sync(this.registry, now);
    this.state = reconcile(this.state, w);
    this.autoReturn(w);
    const resorted = this.autoResort(w);
    // Pins outside the scan: one slow batch at a time (PIN_CATCHUP_MS, then PIN_REFRESH_MS), never awaited here.
    if (this.pinFetchDue(now)) this.track(this.fetchPinnedBatch(now).then(() => this.refresh()));
    // Time alone changes the view (results age out of ACTIVE and the badge); the device diff sends only changes.
    this.changed();
    return resorted;
  }

  /** Protocol 5: the reader closes after 20 s without device input (docs/ui-v3.md section 9.8). Never under voice or confirm. */
  private autoReturn(w: World): void {
    if (!this.state.listLayout || this.sclHeld || currentView(this.state, w) !== "detail") return;
    if (w.now - this.state.lastInputAt < READER_AUTO_RETURN_MS) return;
    this.state = closeReader(this.state);
  }

  private autoResort(w: World): boolean {
    const view = currentView(this.state, w);
    if (view === "voice" || view === "confirm" || view === "detail" || view === "settings" || this.sclHeld) return false;
    if (w.now - this.state.lastInputAt < AUTO_RESORT_MS) return false;
    if (!this.registry.ready() || !orderWouldChange(this.state, w, view)) return false;
    // SPLIT Sessions: both rows, both page indices kept (clamped; docs/ui-v3.md section 10.4).
    this.state = view === "sessions" && splitOn(this.state) ? resortSplit(this.state, w, "keep", true) : relayout(this.state, w, view, true);
    return true;
  }

  /** Frees slots of sessions that stayed stale past the retention period. */
  pruneStale(force = false): string[] {
    const freed = this.registry.pruneStale(this.now(), force);
    if (freed.length > 0) this.refresh();
    return freed;
  }

  /**
   * The device can show the DETAILS page (protocol version 3 agreed; docs/ux-v2.md section 7). The companion calls
   * this on every HELLO_ACK. Without it LFO does nothing and an open DETAILS page closes.
   */
  setDetailsPage(enabled: boolean): void {
    if (this.state.detailsPage === enabled && (enabled || this.state.detail === null)) return;
    this.state = { ...this.state, detailsPage: enabled, detail: enabled ? this.state.detail : null };
    this.changed();
  }

  /**
   * The agreed protocol version (the companion calls this on every HELLO_ACK): 3 or more enables the DETAILS page,
   * 4 or more the UI v3 bubble layout (docs/ui-v3.md section 5), 5 or more the LIST layout and SEQ (section 8).
   * Lower versions get exactly the content of the version they agreed.
   */
  setProtocol(proto: number): void {
    const detailsPage = proto >= 3;
    const bubble = proto >= 4;
    const listLayout = proto >= 5;
    // Version 6 (docs/ui-v3.md section 10): SPLIT keys and SETTINGS. Below it a saved Split lays Sessions out RANKED.
    const splitProto = proto >= 6;
    const st = this.state;
    if (st.detailsPage === detailsPage && st.bubble === bubble && st.listLayout === listLayout && st.splitProto === splitProto && (detailsPage || st.detail === null)) return;
    const sameScroll = st.bubble === bubble && st.listLayout === listLayout;
    const next: ControllerState = {
      ...st,
      detailsPage,
      bubble,
      listLayout,
      splitProto,
      detail: detailsPage ? st.detail : null,
      detailScroll: sameScroll ? st.detailScroll : 0,
      ...(splitProto ? {} : { settingsFrom: null, arpDownAt: null, octPending: null, knob3At: null }),
    };
    const ready = this.registry.ready();
    const w = this.world();
    // Switching to SPLIT under PINNED: scope ACTIVE, choice PINNED (section 10.4), whether or not the registry is ready.
    const scoped = !splitOn(st) && splitOn(next) && next.scope === "pinned" ? { ...next, scope: "active" as const, split: { ...next.split, chosen: "pinned" as const, task: null } } : next;
    if (splitOn(st) !== splitOn(next) && ready) {
      // The Sessions keys change assignment: both rows re-sort (the saved task page, clamped).
      this.state = splitOn(scoped) ? resortSplit(scoped, w, "keep") : relayout(scoped, w, "sessions");
    } else if (scoped !== next) {
      this.state = scoped;
    } else {
      // Grouped needs version 5: when that changes, the Sessions key order changes kind (section 9.1).
      const regroup = sessionsGrouped(st) !== sessionsGrouped(next) && ready;
      this.state = regroup ? relayoutKeepingSelection(next, w) : next;
    }
    this.changed();
  }

  /**
   * SETTINGS values from outside the device (the desktop UI's config form; docs/ui-v3.md section 10.2). Keys applies at
   * once (Sessions laid out again when protocol 6 is agreed); it does not call onSettingsChanged (the caller saved it).
   */
  setSettings(settings: { keys?: KeyMode }): void {
    const mode: KeyMode = settings.keys === "split" ? "split" : "ranked";
    if (mode === this.state.keyMode) return;
    this.state = applyKeyMode(this.state, this.world(), mode);
    this.changed();
  }

  /**
   * Buddy / List per view from outside the device (the desktop UI's config form; docs/ui-v3.md section 8.7). Like SEQ,
   * it never re-sorts and keeps the selection; it does not call onLayoutsChanged (the caller saved it already).
   */
  setLayouts(layouts: Partial<Record<ListView, ScreenLayout>>): void {
    const screen = { ...this.state.screen };
    for (const v of LIST_VIEWS) {
      const l = layouts[v];
      if (validScreen(v, l)) screen[v] = l;
    }
    if (screen.sessions === this.state.screen.sessions && screen.inbox === this.state.screen.inbox) return;
    const next: ControllerState = { ...this.state, screen, detailScroll: 0, bubbleFor: null };
    const regroup = sessionsGrouped(this.state) !== sessionsGrouped(next) && this.registry.ready();
    this.state = regroup ? relayoutKeepingSelection(next, this.world()) : next;
    this.changed();
  }

  /**
   * Canned responses from outside the device (the companion re-read the config file, e.g. after `fm1-console canned
   * add`; docs/ui-v3.md section 12). Does not call onCannedChanged (the list came from the file).
   */
  setCanned(list: readonly CannedEntry[]): void {
    const next = cannedList(list);
    if (JSON.stringify(next) === JSON.stringify(this.state.canned)) return;
    this.state = { ...this.state, canned: next };
    this.changed();
  }

  async handleInput(input: DeviceInput): Promise<ControllerAction[]> {
    if (input.kind === "button" && input.button === "SEL") this.sclHeld = input.edge === "down";
    const pinsBefore = this.state.pins;
    const cannedBefore = this.state.canned;
    const screenBefore = this.state.screen;
    const keysBefore = this.state.keyMode;
    const { state, actions } = reduce(this.state, input, this.world());
    this.state = state;
    if (state.pins !== pinsBefore) this.onPinsChanged?.(splitPins(state.pins));
    if (state.screen !== screenBefore) this.onLayoutsChanged?.({ ...state.screen });
    if (state.keyMode !== keysBefore) this.onSettingsChanged?.({ keys: state.keyMode });
    if (state.canned !== cannedBefore) this.onCannedChanged?.([...state.canned]);
    this.armGestureTimers();
    for (const a of actions) await this.execute(a);
    this.changed();
    return actions;
  }

  /**
   * The protocol 6 host gestures resolve on real one-shot timers (docs/ui-v3.md sections 10.2 and 10.5): SETTINGS opens
   * 1 s after ARP down (if still held), and a waiting OCT single acts 300 ms after its release.
   */
  private armGestureTimers(): void {
    const st = this.state;
    if (st.arpDownAt !== null && this.arpTimer === null) {
      const at = st.arpDownAt;
      this.arpTimer = this.timers.setTimeout(() => {
        this.arpTimer = null;
        if (this.state.arpDownAt !== at) return;
        this.state = arpHoldElapsed(this.state, { ...this.world(), now: Math.max(this.now(), at + ARP_HOLD_MS) });
        this.changed();
      }, ARP_HOLD_MS);
    } else if (st.arpDownAt === null && this.arpTimer !== null) {
      this.timers.clearTimeout(this.arpTimer);
      this.arpTimer = null;
    }
    // Read aloud (docs/ui-v3.md section 14): PLAY still down READ_ALOUD_HOLD_MS after its down edge reads aloud.
    if (st.playDownAt !== null && this.playTimer === null) {
      const at = st.playDownAt;
      this.playTimer = this.timers.setTimeout(() => {
        this.playTimer = null;
        if (this.state.playDownAt !== at) return;
        const r = playHoldElapsed(this.state, { ...this.world(), now: Math.max(this.now(), at + READ_ALOUD_HOLD_MS) });
        this.state = r.state;
        for (const a of r.actions) this.track(this.execute(a));
        this.onTimerStep?.(r);
        this.changed();
      }, READ_ALOUD_HOLD_MS);
    } else if (st.playDownAt === null && this.playTimer !== null) {
      this.timers.clearTimeout(this.playTimer);
      this.playTimer = null;
    }
    const p = st.octPending;
    if (this.octTimer !== null) {
      this.timers.clearTimeout(this.octTimer);
      this.octTimer = null;
    }
    if (p && p.upAt !== null) {
      const upAt = p.upAt;
      this.octTimer = this.timers.setTimeout(() => {
        this.octTimer = null;
        if (this.state.octPending?.upAt !== upAt) return;
        this.state = resolveOct(this.state, { ...this.world(), now: Math.max(this.now(), upAt + OCT_DOUBLE_MS) });
        this.changed();
      }, Math.max(0, upAt + OCT_DOUBLE_MS - this.now()));
    }
    // SPLIT KNOB3: re-armed on every input; the white keys follow once the knob rests KNOB3_REST_MS (one relayout a pause).
    if (this.knob3Timer !== null) {
      this.timers.clearTimeout(this.knob3Timer);
      this.knob3Timer = null;
    }
    if (st.knob3At !== null) {
      const at = st.knob3At;
      this.knob3Timer = this.timers.setTimeout(() => {
        this.knob3Timer = null;
        if (this.state.knob3At !== at) return;
        this.state = resolveKnob3(this.state, { ...this.world(), now: Math.max(this.now(), at + KNOB3_REST_MS) });
        this.changed();
      }, Math.max(0, at + KNOB3_REST_MS - this.now()));
    }
  }

  /** SPLIT choice persistence: compared after every change, saved at most once a second (trailing). */
  private noteSplit(): void {
    if (!this.onSplitChanged) return;
    const cur = JSON.stringify(this.state.split);
    if (cur === this.savedSplit || this.splitTimer !== null) return;
    this.splitTimer = this.timers.setTimeout(() => {
      this.splitTimer = null;
      this.saveSplitNow();
    }, SPLIT_SAVE_MS);
  }

  /** Saves the SPLIT choice now when it differs from the last save (the trailing timer, or stop()). */
  private saveSplitNow(): void {
    const now = JSON.stringify(this.state.split);
    if (now === this.savedSplit) return;
    this.savedSplit = now;
    this.onSplitChanged?.({ ...this.state.split });
  }

  private flushSplit(): void {
    if (this.splitTimer !== null) this.timers.clearTimeout(this.splitTimer);
    this.splitTimer = null;
    if (this.onSplitChanged) this.saveSplitNow();
  }

  // Voice pipeline hooks for the speech engine and the desktop UI.
  voiceLevel(level: number): void {
    this.composer.level(level);
  }
  voiceTranscript(text: string): Result<unknown> {
    return this.composer.transcribed(text);
  }
  voiceTranscriptionFailed(error: string): void {
    this.composer.transcriptionFailed(error);
  }
  editTranscript(text: string): Result<unknown> {
    return this.composer.edit(text);
  }

  /**
   * A gesture timer produced a step outside handleInput (today: the PLAY hold reading aloud, or its `Nothing to read`).
   * The companion turns its notice into a toast, as it does for an input's step.
   */
  onTimerStep?: (step: { state: ControllerState; actions: ControllerAction[] }) => void;

  /** Resolves when every fire-and-forget dispatch has settled (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private track(p: Promise<unknown>): void {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  private record(r: CommandResult, action?: ToastAction): void {
    this.results.push(action === undefined ? r : { ...r, action });
  }

  /** A completed session that stays selected READ_DWELL_MS is read: SELECT can pass over keys without clearing them. */
  private armRead(key: string): void {
    if (this.readTimer !== null) this.timers.clearTimeout(this.readTimer);
    this.readTimer = this.timers.setTimeout(() => {
      this.readTimer = null;
      if (this.registry.selection().key === key && this.inbox.markSessionRead(key)) this.changed();
    }, READ_DWELL_MS);
  }

  private async execute(a: ControllerAction): Promise<void> {
    switch (a.type) {
      case "select":
        this.registry.select(a.key);
        this.armRead(a.key);
        return;
      case "markRead":
        this.inbox.markRead(a.itemId);
        return;
      case "dismiss":
        this.inbox.dismiss(a.itemId);
        return;
      case "undismiss":
        this.inbox.undismiss(a.itemId);
        return;
      case "pin":
      case "unpin":
      case "resort":
        return; // applied by the reducer (state.pins / state.layouts)
      case "rejected":
        return this.record({ requestId: this.newRequestId(), stage: a.stage, message: a.reason });
      case "readAloud":
        this.readAloud?.speak(a.text, a.key);
        return;
      case "readAloudStop":
        this.readAloud?.stop();
        return;
      case "voiceStart": {
        // Busy with a take (e.g. REC on the review screen): nothing to start, and the chat is not gone.
        if (!canStartTake(this.composer.state.state)) return;
        // The microphone must not hear the console read aloud (docs/ui-v3.md section 14).
        this.readAloud?.stop();
        const r = this.composer.start(a.destination);
        if (!r.ok) this.state = { ...this.state, notice: { stage: "target_unavailable", text: NOTICE.chatGone } };
        return;
      }
      case "voiceStop":
        this.composer.stop();
        return;
      case "voiceCancel":
        this.composer.cancel();
        return;
      case "voiceSuggest": {
        // docs/ui-v3.md section 11: the suggestion is the transcript under review; nothing is sent before SAVE.
        const r = this.composer.suggest(a.destination, a.text, a.index, a.count, a.cannedId);
        if (!r.ok) {
          if (this.composer.state.state === "recording") this.composer.discard();
          this.state = { ...this.state, notice: { stage: "target_unavailable", text: NOTICE.chatGone } };
        }
        return;
      }
      case "voiceDiscard":
        this.composer.discard();
        return;
      case "voiceSubmit":
        this.track(this.composer.submit().then(() => this.changed()));
        return;
      case "createSession": {
        const id = this.newRequestId();
        if (!this.registry.ready() || !this.registry.task(taskKey(a.task))) {
          return this.record({ requestId: id, stage: "target_unavailable", message: "task unavailable" }, "createSession");
        }
        return this.record(await this.guarded(id, () => this.adapter.createSession({ requestId: id, task: a.task, provider: a.provider })), "createSession");
      }
      case "focus":
        await this.onTarget(a.ref, (id) => this.adapter.focus(a.ref, id), "focus");
        return;
      case "interrupt":
        await this.onTarget(a.ref, (id) => this.adapter.interrupt(a.ref, id), "interrupt");
        return;
      case "approve":
      case "deny":
        return this.answer(a.approvalId, a.ref, a.type);
    }
  }

  private async answer(approvalId: string, ref: SessionRef, decision: "approve" | "deny"): Promise<void> {
    if (this.answered.has(approvalId)) {
      return this.record({ requestId: this.newRequestId(), stage: "target_unavailable", message: "approval already answered" }, decision);
    }
    this.answered.add(approvalId);
    const r = await this.onTarget(ref, (id) => this.adapter.respondToApproval({ requestId: id, approvalId, sessionRef: ref, decision }), decision);
    // Only a decision that cannot have reached the backend may be made again.
    if (r.stage === "unsupported" || r.stage === "target_unavailable" || r.stage === "failed") {
      this.answered.delete(approvalId);
    }
  }

  /** Every state-changing request is bound to an identity that must still resolve. */
  private async onTarget(ref: SessionRef, call: (requestId: string) => Promise<CommandResult>, action: ToastAction): Promise<CommandResult> {
    const id = this.newRequestId();
    const target = this.registry.resolve(ref);
    const r = target.ok ? await this.guarded(id, () => call(id)) : { requestId: id, stage: "target_unavailable" as const, message: target.error };
    this.record(r, action);
    return r;
  }

  private async guarded(requestId: string, call: () => Promise<CommandResult>): Promise<CommandResult> {
    try {
      return checkedResult(await call(), requestId);
    } catch (e) {
      return { requestId, stage: "failed", message: e instanceof Error ? e.message : String(e) };
    }
  }

  private isLive(dest: Destination): boolean {
    if (!this.registry.ready()) return false;
    if (dest.mode === "continue-session") return this.registry.resolve(dest.target).ok;
    if (dest.mode === "new-session") return this.registry.task(taskKey(dest.task)) !== undefined;
    return this.registry.projects().some((p) => projectKey(p) === projectKey(dest.project));
  }

  private changed(): void {
    this.noteSplit();
    if (this.listeners.size === 0) return;
    const v = this.view();
    for (const fn of this.listeners) fn(v);
  }
}
