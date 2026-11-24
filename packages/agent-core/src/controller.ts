// Pure reducer: (controller state, logical input, world) -> (next state, actions). No I/O here.
// Control map: docs/ux-v2.md section 2.3. Knobs only change a setting; buttons act.
import type { Destination } from "./composer-state";
import { bubbleScroll, bubbleSubject, detailPagesFor4, focusBubble, voiceLines } from "./bubble";
import { addCanned, CANNED_DELETE_HOLD_MS, removeCanned, restoreCanned, useCanned, type CannedEntry } from "./canned";
import { bubbleMaxScroll, cannedSaved, knobToast, listMaxScroll, NOTICE, APPROVAL_GONE, SCOPES, type Talk } from "./copy";
import {
  can,
  chatTaskKey,
  clampPages,
  currentView,
  destinationFor,
  effectiveTalk,
  focusEntry,
  inboxItemAtCursor,
  inboxPage,
  initialController,
  layoutOf,
  pageCount,
  pendingApproval,
  REC_TAP_MS,
  relayout,
  relayoutKeepingSelection,
  relayoutTaskRow,
  resortSplit,
  SCREEN_CYCLE,
  screenOf,
  sessionPage,
  sessionsGrouped,
  splitOn,
  splitSessions,
  suggestionsOf,
  talkCapability,
  talkModes,
  talkProvider,
  taskPage,
  type BaseView,
  type ConfirmAction,
  type ControllerState,
  type Notice,
  type World,
} from "./context";
import type { DeviceInput, EncoderName } from "./controls";
import { detailInput, detailRows, paginate } from "./details";
import { isAttention, MAX_PINS_PER_KIND, pageOfIndex, rank, repoChoices, scopeMembers, taskChoices } from "./focus";
import { isSessionKey, isTaskKey, sessionKey, taskKey } from "./identity";
import {
  ARP_HOLD_MS,
  FILTER_OF,
  isBlackKey,
  KEY_MODES,
  OCT_DOUBLE_MS,
  pageOfTask,
  settingsItems,
  SPLIT_SCOPES,
  taskPageCount,
  taskRowPage,
  taskSlotOf,
  whiteCount,
  whiteList,
  type KeyMode,
  type SplitState,
} from "./split";
import { DISMISS_UNDO_MS, itemTier } from "./inbox";
import { newestMessage } from "./details";
import { READ_ALOUD_HOLD_MS, speechText } from "./speech";
import type { SessionEntry } from "./registry";
import { PAGE_SIZE } from "./slots";
import { effectiveState, isInterruptible } from "./status";
import type { CapabilityName, DeliveryStage, Provider, SessionRef, TaskRef } from "./types";

export { initialController };
export type { ControllerState, World };

export type ControllerAction =
  | { type: "select"; key: string }
  | { type: "focus"; ref: SessionRef }
  | { type: "interrupt"; ref: SessionRef }
  | { type: "approve" | "deny"; approvalId: string; ref: SessionRef }
  | { type: "createSession"; task: TaskRef; provider: Provider }
  | { type: "voiceStart"; destination: Destination }
  | { type: "voiceStop" }
  | { type: "voiceCancel" }
  | { type: "voiceSubmit" }
  /**
   * A short REC tap (or PRESETS on a suggested / canned review): this suggestion, or with `cannedId` this canned
   * response (docs/ui-v3.md section 12), goes to review; the take is dropped.
   */
  | { type: "voiceSuggest"; destination: Destination; text: string; index: number; count: number; cannedId?: string }
  /** A short REC tap with nothing to suggest: the take is dropped and nothing else changes. */
  | { type: "voiceDiscard" }
  | { type: "markRead"; itemId: string }
  | { type: "dismiss"; itemId: string }
  | { type: "undismiss"; itemId: string }
  | { type: "pin" | "unpin"; key: string }
  | { type: "resort"; view: BaseView }
  | { type: "rejected"; stage: Extract<DeliveryStage, "unsupported" | "target_unavailable">; reason: string }
  /** Hold PLAY (docs/ui-v3.md section 14): speak this text, the latest message of session `key`; stops any playback first. */
  | { type: "readAloud"; key: string; text: string }
  /** PLAY or FX while read aloud is busy: playback (or its preparation) stops. */
  | { type: "readAloudStop" };

/** Actions that change the backend. A knob turn must never produce one. */
export const BACKEND_ACTIONS: ReadonlySet<ControllerAction["type"]> = new Set(["focus", "interrupt", "approve", "deny", "createSession", "voiceSubmit"]);

export interface Step {
  state: ControllerState;
  actions: ControllerAction[];
}

const step = (state: ControllerState, ...actions: ControllerAction[]): Step => ({ state, actions });
const tell = (s: ControllerState, text: string, stage: DeliveryStage = "accepted_locally"): ControllerState => ({ ...s, notice: { stage, text } as Notice });
const unsupported = (s: ControllerState, cap: CapabilityName): Step =>
  step(s, { type: "rejected", stage: "unsupported", reason: `${cap} unsupported` });
const unavailable = (s: ControllerState, why: string): Step => step(s, { type: "rejected", stage: "target_unavailable", reason: why });

/** Pages of the DETAILS page for one chat (docs/ux-v2.md section 7.5). */
export function detailPageCount(e: SessionEntry, w: World, s: ControllerState): number {
  if (s.bubble) return detailPagesFor4(s, w, e).length;
  const item = s.view === "inbox" ? inboxItemAtCursor(s, w) : undefined;
  const approval = item?.approvalId ? w.registry.approval(item.approvalId) : undefined;
  // The same state as the view draws (view.ts detailPage), so the page count agrees with what is shown.
  const state = w.registry.connection() === "disconnected" ? "disconnected" : w.inbox.displayState(e);
  return paginate(detailRows(detailInput(e, state, w, approval))).length;
}

export function reduce(s0: ControllerState, input: DeviceInput, w: World): Step {
  // Only FX (either edge) keeps the TO DO undo window open (docs/ux-v2.md section 3.6).
  // The canned delete undo window (docs/ui-v3.md section 12) behaves the same way.
  const keepUndo = input.kind === "button" && input.button === "FX";
  const s1 = clampPages({ ...s0, notice: null, lastInputAt: w.now, dismissUndo: keepUndo ? s0.dismissUndo : null, cannedUndo: keepUndo ? s0.cannedUndo : null }, w);
  // SPLIT KNOB3: any input other than another KNOB3 turn lays the white keys out for the chosen task first, so a white
  // key, SELECT or ALGORITHM never acts on the previous task's sessions.
  const s = s1.knob3At !== null && !(input.kind === "encoder" && input.encoder === "K3" && input.delta !== 0) ? settleKnob3(s1, w) : s1;
  // SPLIT OCT (docs/ui-v3.md section 10.5): any input other than the pending OCT button's own edges resolves the waiting
  // single first, then acts.
  const p = s.octPending;
  if (p && !(input.kind === "button" && input.button === p.button)) {
    const single = octSingle({ ...s, octPending: null }, w, p.button);
    const rest = reduceInput({ ...single, notice: null }, input, w);
    return rest.state.notice || !single.notice ? rest : step({ ...rest.state, notice: single.notice }, ...rest.actions);
  }
  return reduceInput(s, input, w);
}

function reduceInput(s: ControllerState, input: DeviceInput, w: World): Step {
  // Read aloud (docs/ui-v3.md section 14): while it is busy, PLAY or FX (down edge, any view) only stops it. The up
  // edge then finds no pending PLAY / FX press and does nothing, so one press is one action.
  if (w.speaking && input.kind === "button" && input.edge === "down" && (input.button === "PLAY" || input.button === "FX")) {
    return step(tell({ ...s, playDownAt: null }, NOTICE.readStopped), { type: "readAloudStop" });
  }
  if (currentView(s, w) === "settings") return onSettingsInput(s, input, w);
  switch (input.kind) {
    case "button":
      return input.edge === "down" ? onButtonDown(s, input.button, w) : onButtonUp(s, input.button, w);
    case "key":
      return onKey(s, input.key, input.gesture, w);
    case "encoder":
      return input.delta === 0 ? step(s) : onEncoder(s, input.encoder, Math.sign(input.delta), w);
  }
}

function onButtonUp(s: ControllerState, button: string, w: World): Step {
  if (button === "REC") {
    const downAt = s.recDownAt;
    const next = downAt === null ? s : { ...s, recDownAt: null };
    if (w.composer.state !== "recording") return step(next);
    // docs/ui-v3.md section 11: released before REC_TAP_MS it was a tap, not speech: offer the first suggestion.
    if (downAt !== null && w.now - downAt < REC_TAP_MS) return suggestTap(next, w);
    return step(next, { type: "voiceStop" });
  }
  if (button === "FX" && s.fxDownAt !== null) return fxUp({ ...s, fxDownAt: null }, w.now - s.fxDownAt, w);
  if (button === "PLAY" && s.playDownAt !== null) {
    // docs/ui-v3.md section 14: a tap opens the chat on the Mac now (on release); a hold the timer missed (late edge)
    // reads aloud now. Never both.
    const next = { ...s, playDownAt: null };
    // Another input moved to a view where PLAY means something else (voice, confirm, Tasks): the press is dropped.
    const view = currentView(s, w);
    if (view !== "sessions" && view !== "inbox" && view !== "detail") return step(next);
    return w.now - s.playDownAt >= READ_ALOUD_HOLD_MS ? readAloud(next, w) : playTap(next, w);
  }
  if (button === "ARP" && s.arpDownAt !== null && reviewing(w)) {
    // docs/ui-v3.md section 12: on a review an ARP tap saves the text as a canned response; a hold does nothing (and
    // SETTINGS never opens over voice: openSettings refuses any view but the base views).
    const next = { ...s, arpDownAt: null };
    return w.now - s.arpDownAt < ARP_HOLD_MS ? step(saveCanned(next, w)) : step(next);
  }
  if (button === "ARP" && s.arpDownAt !== null) {
    // A tap toasts how to open SETTINGS; a hold the timer missed (late edge) opens it now (docs/ui-v3.md section 10.2).
    const held = w.now - s.arpDownAt >= ARP_HOLD_MS;
    const next = { ...s, arpDownAt: null };
    return held ? step(openSettings(next, w)) : step(tell(next, ARP_TAP_TOAST));
  }
  if ((button === "OCT_DOWN" || button === "OCT_UP") && s.octPending?.button === button && s.octPending.upAt === null) {
    return step({ ...s, octPending: { ...s.octPending, upAt: w.now } });
  }
  return step(s);
}

// ---------------------------------------------------------------------------------------------------------------
// SETTINGS (docs/ui-v3.md section 10.2) and the host-resolved gestures of protocol 6.

export const ARP_TAP_TOAST = "Hold ARP: settings";
const BASE_VIEWS: readonly string[] = ["sessions", "tasks", "inbox"];

/** Opens SETTINGS over the current base view, the cursor on row 1. */
function openSettings(s: ControllerState, w: World): ControllerState {
  if (!s.splitProto || !BASE_VIEWS.includes(currentView(s, w))) return s;
  return { ...s, settingsFrom: s.view, settingsCursor: 0, arpDownAt: null, detailScroll: 0, bubbleFor: null };
}

/** The ARP hold timer fired (the console arms it at ARP down): SETTINGS opens when ARP is still down after 1 s. */
export function arpHoldElapsed(s: ControllerState, w: World): ControllerState {
  if (s.arpDownAt === null || w.now - s.arpDownAt < ARP_HOLD_MS) return s;
  return openSettings({ ...s, arpDownAt: null }, w);
}

/** Closes SETTINGS back to the view it was opened over. */
const closeSettings = (s: ControllerState): ControllerState => ({ ...s, settingsFrom: null, arpDownAt: null, detailScroll: 0, bubbleFor: null });

/**
 * Keys Ranked/Split (SETTINGS or the desktop config form): Sessions is laid out again in the new mode, both rows
 * re-sorted, the task page the saved one (clamped). Switching to SPLIT under PINNED: scope ACTIVE, choice PINNED.
 */
export function applyKeyMode(s0: ControllerState, w: World, mode: KeyMode): ControllerState {
  if (s0.keyMode === mode) return s0;
  let s: ControllerState = { ...s0, keyMode: mode, octPending: null };
  if (splitOn(s) && s.scope === "pinned") s = { ...s, scope: "active", split: { ...s.split, chosen: "pinned", task: null } };
  if (!w.registry.ready()) return s;
  return splitOn(s) ? resortSplit(s, w, "keep") : relayout(s, w, "sessions");
}

function onSettingsInput(s: ControllerState, input: DeviceInput, w: World): Step {
  const items = settingsItems(s.keyMode);
  if (input.kind === "encoder") {
    if (input.encoder !== "SELECT" || input.delta === 0) return step(s);
    const cursor = Math.max(0, Math.min(items.length - 1, s.settingsCursor + Math.sign(input.delta)));
    return step({ ...s, settingsCursor: cursor });
  }
  if (input.kind !== "button" || input.edge !== "down") return step(s);
  switch (input.button) {
    case "SAVE": {
      const item = items[s.settingsCursor];
      if (item?.id !== "keys") return step(s);
      const mode = KEY_MODES[(KEY_MODES.indexOf(s.keyMode) + 1) % KEY_MODES.length] ?? "ranked";
      return step(tell(applyKeyMode(s, w, mode), mode === "split" ? "Keys: split" : "Keys: ranked"), { type: "resort", view: "sessions" });
    }
    case "HOME":
      return goView(closeSettings(s), w, "sessions");
    case "LFO":
    case "ARP":
      return step(closeSettings(s));
    default:
      return step(s); // keys, OCT, FX, ENV, PLAY, REC, SEQ, EDIT, GLO: nothing here
  }
}

/** OCT single in SPLIT Sessions: the white page -1 / +1, clamped. */
function octSingle(s: ControllerState, w: World, button: "OCT_DOWN" | "OCT_UP"): ControllerState {
  if (!splitSessions(s) || currentView(s, w) !== "sessions") return s;
  return turnPage(s, w, button === "OCT_UP" ? 1 : -1);
}

/** OCT double in SPLIT Sessions: the task page -1 / +1, wrapping; filters and the choice stay. */
function octDouble(s: ControllerState, button: "OCT_DOWN" | "OCT_UP"): ControllerState {
  const n = taskPageCount(s.taskRow);
  if (n <= 1) return tell(s, "No more tasks");
  const page = (s.split.taskPage + (button === "OCT_UP" ? 1 : -1) + n) % n;
  return tell({ ...s, split: { ...s.split, taskPage: page } }, `Tasks ${page + 1}/${n}`);
}

/** The OCT double window closed with no second press (the console's one-shot timer): the single acts now. */
export function resolveOct(s: ControllerState, w: World): ControllerState {
  const p = s.octPending;
  if (!p || p.upAt === null || w.now - p.upAt < OCT_DOUBLE_MS) return s;
  return octSingle({ ...s, octPending: null }, w, p.button);
}

/** OCT down in SPLIT Sessions: a second down within 300 ms of the first up is the double; else this press waits. */
function onOctSplit(s: ControllerState, w: World, button: "OCT_DOWN" | "OCT_UP"): Step {
  const p = s.octPending;
  if (p && p.button === button && p.upAt !== null && w.now - p.upAt <= OCT_DOUBLE_MS) return step(octDouble({ ...s, octPending: null }, button));
  const base = p ? octSingle({ ...s, octPending: null }, w, p.button) : s;
  return step({ ...base, octPending: { button, downAt: w.now, upAt: null } });
}

/** HOME / EDIT / GLO: entering a view re-sorts it; pressing the current view's button again re-sorts too. */
function goView(s: ControllerState, w: World, view: BaseView): Step {
  const already = currentView(s, w) === view;
  const moved: ControllerState = { ...s, view, confirm: null, detailScroll: 0, detail: null };
  // SPLIT Sessions (docs/ui-v3.md section 10.4): both rows re-sort; the task page holds the chosen task.
  const next = view === "sessions" && splitOn(s) ? resortSplit(moved, w, "chosen") : relayout(moved, w, view);
  return already ? step(tell(next, NOTICE.sorted), { type: "resort", view }) : step(next, { type: "resort", view });
}

function onButtonDown(s: ControllerState, button: string, w: World): Step {
  const shown = currentView(s, w);
  // On the DETAILS page the buttons act on the shown chat as in the list below it (docs/ux-v2.md section 7.3).
  const view = shown === "detail" ? s.view : shown;
  switch (button) {
    case "LFO":
      return toggleDetails(s, shown, w);
    case "HOME":
      return shown === "detail" ? step(closeReader(s)) : goView(s, w, "sessions");
    case "EDIT":
      return goView(s, w, "tasks");
    case "GLO":
      return goView(s, w, "inbox");
    case "OCT_DOWN":
    case "OCT_UP":
      if (shown === "detail") return step(turnDetailPage(s, w, button === "OCT_UP" ? 1 : -1));
      if (shown === "sessions" && splitSessions(s)) return onOctSplit(s, w, button);
      return view === "voice" || view === "confirm" ? step(s) : step(turnPage(s, w, button === "OCT_UP" ? 1 : -1));
    case "ARP":
      // Hold 1 s opens SETTINGS (protocol 6, base views only); the console's timer fires it, the up edge tells a tap.
      // On a voice review (any protocol) the up edge saves a canned response instead (docs/ui-v3.md section 12).
      if (shown === "voice" && reviewing(w)) return step({ ...s, arpDownAt: w.now });
      return s.splitProto && BASE_VIEWS.includes(shown) ? step({ ...s, arpDownAt: w.now }) : step(s);
    case "REC": {
      const r = startVoice(s, w);
      // The down edge's time tells a short tap from a hold at the up edge (host-side timing, no firmware change).
      return r.actions.some((a) => a.type === "voiceStart") ? step({ ...r.state, recDownAt: w.now }, ...r.actions) : r;
    }
    case "SAVE":
      return onSave(s, view, w);
    case "FX":
      return onFx(s, view, w);
    case "ENV":
      return view === "confirm" || view === "voice" || view === "tasks" ? step(s) : askInterrupt(s, w);
    case "PLAY":
      return onPlayDown(s, view, w);
    case "SEQ":
      return toggleScreen(s, shown, w);
    default:
      return step(s); // SCL (help is firmware-local)
  }
}

/**
 * SEQ (protocol version 5, docs/ui-v3.md sections 8.5 and 9.1): Sessions cycles Buddy -> List -> Grouped, TO DO toggles
 * Buddy <-> List. Buddy <-> List never re-sorts; into or out of Grouped the key order changes, so Sessions re-sorts
 * keeping the selection (and its page). The bubble starts again at the newest line.
 */
function toggleScreen(s: ControllerState, shown: string, w: World): Step {
  if (!s.listLayout) return step(s);
  if (shown === "tasks") return step(tell(s, NOTICE.noListInTasks));
  if (shown !== "sessions" && shown !== "inbox") return step(s);
  const cycle = SCREEN_CYCLE[shown];
  const cur = screenOf(s, shown);
  const next = cycle[(cycle.indexOf(cur) + 1) % cycle.length] ?? "buddy";
  const moved: ControllerState = { ...s, screen: { ...s.screen, [shown]: next }, detailScroll: 0, bubbleFor: null };
  if (shown === "sessions" && (cur === "grouped" || next === "grouped")) return step(relayoutKeepingSelection(moved, w), { type: "resort", view: "sessions" });
  return step(moved);
}

/** Closing the reader (LFO, HOME, auto-return): back to the layout below, the bubble at the newest line (section 9.8). */
export function closeReader(s: ControllerState): ControllerState {
  return { ...s, detail: null, detailScroll: 0, bubbleFor: null };
}

/** LFO: open the DETAILS page for the shown chat (Sessions, TO DO), or close it. Needs protocol version 3. */
function toggleDetails(s: ControllerState, shown: string, w: World): Step {
  if (!s.detailsPage) return step(s);
  if (shown === "detail") return step(closeReader(s));
  if (shown !== "sessions" && shown !== "inbox") return step(s);
  if (!focusEntry(s, w)) return step(tell(s, NOTICE.selectChat, "target_unavailable"));
  return step({ ...s, detail: 0 });
}

/** PRESETS / OCT on the DETAILS page: next or previous page, clamped. */
function turnDetailPage(s: ControllerState, w: World, dir: number): ControllerState {
  const e = focusEntry(s, w);
  const pages = e ? detailPageCount(e, w, s) : 1;
  // Start from the page as shown: the content may have shrunk since the last turn (view.ts clamps the same way),
  // and a stored index past the end would make the next turns back do nothing.
  const shown = Math.max(0, Math.min(pages - 1, s.detail ?? 0));
  return { ...s, detail: Math.max(0, Math.min(pages - 1, shown + dir)) };
}

/** Paging only shows another slice of the frozen layout; it never re-sorts. */
function turnPage(s: ControllerState, w: World, dir: number): ControllerState {
  const pages = pageCount(s, w, s.view);
  const page = Math.max(0, Math.min(pages - 1, s.pages[s.view] + dir));
  return { ...s, pages: { ...s.pages, [s.view]: page }, detailScroll: 0, detail: s.detail === null ? null : 0 };
}

function startVoice(s: ControllerState, w: World): Step {
  if (s.confirm) return step(s);
  const talk = effectiveTalk(s);
  const cap = talkCapability(talk);
  if (!can(w, cap)) return unsupported(s, cap);
  const destination = destinationFor(s, w);
  if (!destination) {
    const text = talk === "reply" ? NOTICE.selectChat : talk.endsWith("chat") ? NOTICE.selectTask : NOTICE.selectChat;
    return step(tell(s, text, "target_unavailable"));
  }
  // Fail early (docs/ui-v3.md section 9.7): a session that takes no console prompts is refused before recording.
  if (destination.mode === "continue-session") {
    const prompt = focusEntry(s, w)?.session.prompt;
    if (prompt?.acceptsPrompt === false) return step(tell(s, prompt.toast ?? NOTICE.noPrompts, "unsupported"));
  }
  return step(s, { type: "voiceStart", destination });
}

// ---------------------------------------------------------------------------------------------------------------
// Suggested next prompts (docs/ui-v3.md section 11).

/** The session a reply destination names, if it is still known. */
function replyEntry(w: World, dest: Destination | null): SessionEntry | undefined {
  return dest?.mode === "continue-session" ? w.registry.get(sessionKey(dest.target)) : undefined;
}

/** One entry of the review list: a suggestion of the chat, or a canned response (docs/ui-v3.md section 12). */
type ReviewItem = { text: string; index: number; count: number; cannedId?: string };

/**
 * The review list for a destination: the chat's suggestions first (a reply only), then every canned response. `index`
 * and `count` count within the item's own group (the label shows them).
 */
function reviewItems(s: ControllerState, w: World, dest: Destination | null): ReviewItem[] {
  const sugg = suggestionsOf(s, replyEntry(w, dest));
  return [
    ...sugg.map((text, index): ReviewItem => ({ text, index, count: sugg.length })),
    ...s.canned.map((e, index): ReviewItem => ({ text: e.text, index, count: s.canned.length, cannedId: e.id })),
  ];
}

/** Where the shown suggested / canned text sits in the review list (a canned one by id: the list re-sorts on use). */
function reviewPos(items: readonly ReviewItem[], w: World): number {
  const c = w.composer;
  if (c.source === "canned") {
    const at = items.findIndex((it) => it.cannedId === c.cannedId);
    if (at >= 0) return at;
    return Math.min(items.length - 1, items.filter((it) => it.cannedId === undefined).length + (c.suggestion?.index ?? 0));
  }
  return Math.min(items.length - 1, c.suggestion?.index ?? 0);
}

const suggestAction = (dest: Destination, it: ReviewItem): ControllerAction => ({
  type: "voiceSuggest",
  destination: dest,
  text: it.text,
  index: it.index,
  count: it.count,
  ...(it.cannedId === undefined ? {} : { cannedId: it.cannedId }),
});

/**
 * A short REC tap: the take is dropped; the first entry of the review list (suggestions, then canned responses) goes
 * to review, or `No suggestion/canned` and nothing else.
 */
function suggestTap(s: ControllerState, w: World): Step {
  const dest = w.composer.destination;
  const first = reviewItems(s, w, dest)[0];
  if (!dest || first === undefined) return step(tell(s, NOTICE.noSuggestion), { type: "voiceDiscard" });
  return step({ ...s, detailScroll: 0, bubbleFor: null }, suggestAction(dest, first));
}

/** PRESETS on a suggested or canned review with more than one entry: the next (or previous) one, wrapping; else null. */
function cycleSuggestion(s: ControllerState, w: World, dir: number): Step | null {
  const c = w.composer;
  if (c.state !== "reviewing" || (c.source !== "suggested" && c.source !== "canned") || !c.destination) return null;
  const items = reviewItems(s, w, c.destination);
  if (items.length < 2) return null;
  const index = ((reviewPos(items, w) + dir) % items.length + items.length) % items.length;
  const it = items[index];
  return it ? step({ ...s, detailScroll: 0, bubbleFor: null }, suggestAction(c.destination, it)) : null;
}

const reviewing = (w: World): boolean => w.composer.state === "reviewing";

/** The canned entry the review shows, if it is still in the list. */
const shownCanned = (s: ControllerState, w: World): CannedEntry | undefined =>
  w.composer.state === "reviewing" && w.composer.source === "canned" ? s.canned.find((e) => e.id === w.composer.cannedId) : undefined;

/** ARP tap on a review: the text becomes a canned response. Nothing is sent; SAVE / FX still decide the message. */
function saveCanned(s: ControllerState, w: World): ControllerState {
  const r = addCanned(s.canned, w.composer.transcript, w.now);
  if (r.ok) return tell({ ...s, canned: r.list }, cannedSaved(r.list.length));
  if (r.reason === "duplicate") return tell(s, NOTICE.alreadyCanned);
  if (r.reason === "full") return tell(s, NOTICE.cannedFull, "failed");
  return tell(s, NOTICE.nothingToSave, "failed");
}

/** A canned text is being sent: its uses count goes up (the list re-sorts). */
function countCannedUse(s: ControllerState, w: World): ControllerState {
  const c = w.composer;
  if (c.source !== "canned" || c.cannedId === null || !s.canned.some((e) => e.id === c.cannedId)) return s;
  return { ...s, canned: useCanned(s.canned, c.cannedId, w.now) };
}

/**
 * FX released after going down on a canned review: held CANNED_DELETE_HOLD_MS or more deletes the entry (the review
 * moves to the entry now in its place, or closes when the list is empty); a shorter press cancels, as FX always does.
 */
function fxUp(s: ControllerState, heldMs: number, w: World): Step {
  const entry = shownCanned(s, w);
  const dest = w.composer.destination;
  if (!entry || !dest) return step(s);
  if (heldMs < CANNED_DELETE_HOLD_MS) return step(tell(s, NOTICE.cancelled), { type: "voiceCancel" });
  const before = reviewItems(s, w, dest);
  const pos = Math.max(0, before.findIndex((it) => it.cannedId === entry.id));
  const next: ControllerState = { ...s, canned: removeCanned(s.canned, entry.id), cannedUndo: { entry, at: w.now }, detailScroll: 0, bubbleFor: null };
  const after = reviewItems(next, w, dest);
  const it = after[Math.min(pos, after.length - 1)];
  return step(tell(next, NOTICE.cannedDeleted), it ? suggestAction(dest, it) : { type: "voiceCancel" });
}

/** FX within DISMISS_UNDO_MS of a canned delete: the entry comes back (shown again when a review is still open). */
function restoreCannedEntry(s: ControllerState, w: World, entry: CannedEntry): Step {
  const list = restoreCanned(s.canned, entry);
  const base: ControllerState = { ...s, cannedUndo: null };
  if (list === null) return step(tell(base, NOTICE.nothingToUndo));
  const next: ControllerState = { ...base, canned: list, detailScroll: 0, bubbleFor: null };
  const c = w.composer;
  const dest = c.destination;
  if (!dest || c.state !== "reviewing" || (c.source !== "suggested" && c.source !== "canned")) return step(tell(next, NOTICE.cannedRestored));
  const it = reviewItems(next, w, dest).find((x) => x.cannedId === entry.id);
  return step(tell(next, NOTICE.cannedRestored), ...(it ? [suggestAction(dest, it)] : []));
}

/** A prompt goes to a chat: the suggestions it showed are used up (hidden until the adapter reports others). */
function spendSuggestions(s: ControllerState, w: World): ControllerState {
  const e = replyEntry(w, w.composer.destination);
  const list = e?.session.details?.suggestions ?? [];
  if (!e || list.length === 0) return s;
  return { ...s, spentSuggestions: { ...s.spentSuggestions, [e.key]: JSON.stringify(list.filter((x) => x.trim() !== "")) } };
}

function onSave(s: ControllerState, view: string, w: World): Step {
  if (s.confirm) return executeConfirm(s, s.confirm, w);
  if (view === "voice") {
    const c = w.composer;
    if (c.state === "reviewing") {
      if (c.destination?.mode === "new-task") return step({ ...s, confirm: { type: "voiceSubmit", label: c.destination.label } });
      return step(countCannedUse(spendSuggestions(s, w), w), { type: "voiceSubmit" });
    }
    if (c.state === "failed" && c.retryable) return step(s, { type: "voiceSubmit" });
    return step(s);
  }
  return askApproval(s, w, "approve");
}

function onFx(s: ControllerState, view: string, w: World): Step {
  if (s.confirm) return step(tell({ ...s, confirm: null }, NOTICE.cancelled));
  const cu = s.cannedUndo;
  if (cu && w.now - cu.at <= DISMISS_UNDO_MS) return restoreCannedEntry(s, w, cu.entry);
  if (view === "voice") {
    // A canned review (docs/ui-v3.md section 12): the up edge decides (a tap cancels, a 1 s hold deletes the entry).
    if (shownCanned(s, w)) return step({ ...s, fxDownAt: w.now });
    const st = w.composer.state;
    if (st === "submitting") return step(tell(s, NOTICE.stillSending));
    return step(st === "recording" || st === "transcribing" || st === "reviewing" ? tell(s, NOTICE.cancelled) : s, { type: "voiceCancel" });
  }
  if (view === "inbox") {
    const undo = s.dismissUndo;
    if (undo && w.now - undo.at <= DISMISS_UNDO_MS) {
      if (w.inbox.get(undo.itemId)?.dismissed) return restoreDismissed(s, w, undo);
      // The dismissed item changed (a new occurrence has a new id) or left meanwhile: FX inside the window still means
      // undo, so it never dismisses a second item (the cursor has moved on to it).
      return step(tell({ ...s, dismissUndo: null }, NOTICE.nothingToUndo));
    }
    const item = inboxItemAtCursor(s, w);
    if (item && item.kind !== "approval") {
      // An item that already left the inbox has nothing to dismiss.
      return w.inbox.get(item.id) ? dismissItem(s, w, item.id) : step(s);
    }
  }
  return askApproval(s, w, "deny");
}

/**
 * FX on a non-approval TO DO item (docs/ux-v2.md section 3.6): its key empties at once (the other keys stay), the
 * cursor moves to the next item still in TO DO (key order, wrapping), and FX within DISMISS_UNDO_MS undoes it.
 */
function dismissItem(s: ControllerState, w: World, id: string): Step {
  const l = layoutOf(s, "inbox");
  const index = l.indexOf(id);
  const order = l.keys();
  const live = order.filter((k): k is string => {
    if (k === null || k === id) return false;
    const it = w.inbox.get(k);
    return it !== undefined && itemTier(it, w.now) !== null;
  });
  const next = live.find((k) => order.indexOf(k) > index) ?? live[0];
  l.release((k) => k !== id);
  const base: ControllerState = {
    ...s,
    layouts: { ...s.layouts, inbox: l.data() },
    dismissUndo: { itemId: id, at: w.now, index },
    detailScroll: 0,
    detail: s.detail === null ? null : 0,
  };
  const dismiss: ControllerAction = { type: "dismiss", itemId: id };
  if (next === undefined) return step(tell({ ...base, inboxCursor: null }, NOTICE.dismissedUndo), dismiss);
  const moved = pickInboxAt(base, w, next);
  return step(tell({ ...moved.state, dismissUndo: base.dismissUndo }, NOTICE.dismissedUndo), dismiss, ...moved.actions);
}

/** FX within the undo window: the item comes back to the key it held (else the first free key) and is selected. */
function restoreDismissed(s: ControllerState, w: World, undo: NonNullable<ControllerState["dismissUndo"]>): Step {
  const l = layoutOf(s, "inbox");
  if (l.indexOf(undo.itemId) < 0 && !l.putAt(undo.itemId, undo.index)) l.place([undo.itemId]);
  const at = l.indexOf(undo.itemId);
  const item = w.inbox.get(undo.itemId);
  const actions: ControllerAction[] = [{ type: "undismiss", itemId: undo.itemId }];
  const e = item ? w.registry.get(item.sessionKey) : undefined;
  if (item && e && !e.stale) actions.push({ type: "select", key: item.sessionKey });
  const next: ControllerState = {
    ...s,
    layouts: { ...s.layouts, inbox: l.data() },
    dismissUndo: null,
    inboxCursor: undo.itemId,
    pages: at < 0 ? s.pages : { ...s.pages, inbox: pageOfIndex(at) },
    detailScroll: 0,
    detail: s.detail === null ? null : 0,
  };
  return step(tell(next, NOTICE.restored), ...actions);
}

/**
 * PLAY down. Voice (retry), confirm and Tasks (new chat) act at once, as before. On a selected session in Sessions or
 * TO DO (and their DETAILS page) the press waits (docs/ui-v3.md section 14): released before READ_ALOUD_HOLD_MS it
 * opens the chat on the Mac (playTap), held that long it reads the latest message aloud (the console's timer, or the
 * up edge when the timer missed). The short action moves to the release because a press cannot be told from a hold
 * at its down edge; firing on down and reading on hold would do two things for one press.
 */
function onPlayDown(s: ControllerState, view: string, w: World): Step {
  if (view === "voice") return w.composer.state === "failed" && w.composer.retryable ? step(s, { type: "voiceSubmit" }) : step(s);
  if (view === "confirm") return step(s);
  if (view === "tasks") return askCreateSession(s, w);
  if (!focusEntry(s, w)) return step(tell(s, NOTICE.selectChat, "target_unavailable"));
  return step({ ...s, playDownAt: w.now });
}

/** A short PLAY on a selected session: open it on the Mac (unchanged behaviour, now on the release). */
function playTap(s: ControllerState, w: World): Step {
  const e = focusEntry(s, w);
  if (!e) return step(tell(s, NOTICE.selectChat, "target_unavailable"));
  if (e.stale) return unavailable(s, "session is stale");
  return focus(step(s), e.session.ref, w);
}

/** Hold PLAY: the shown session's latest message as speech text, or `Nothing to read`. */
function readAloud(s: ControllerState, w: World): Step {
  const e = focusEntry(s, w);
  if (!e) return step(tell(s, NOTICE.selectChat, "target_unavailable"));
  const m = e.session.details ? newestMessage(e.session.details) : undefined;
  const text = m ? speechText(m) : "";
  if (!text) return step(tell(s, NOTICE.nothingToRead));
  return step(s, { type: "readAloud", key: e.key, text });
}

/** The PLAY hold timer fired (the console arms it at PLAY down): still down after READ_ALOUD_HOLD_MS reads aloud. */
export function playHoldElapsed(s: ControllerState, w: World): Step {
  if (s.playDownAt === null || w.now - s.playDownAt < READ_ALOUD_HOLD_MS) return step(s);
  return readAloud({ ...s, playDownAt: null, notice: null }, w);
}

function askApproval(s: ControllerState, w: World, decision: "approve" | "deny"): Step {
  const approval = pendingApproval(s, w);
  if (!approval) return step(s);
  if (!can(w, "respondToApproval")) return unsupported(s, "respondToApproval");
  const key = s.view === "inbox" ? inboxItemAtCursor(s, w)?.sessionKey : w.registry.selection().key;
  if (!key) return step(s);
  const title = w.registry.get(key)?.session.title ?? approval.summary;
  return step({ ...s, confirm: { type: decision, key, approvalId: approval.id, label: title } });
}

function askInterrupt(s: ControllerState, w: World): Step {
  const e = focusEntry(s, w);
  if (!e) return step(tell(s, NOTICE.selectChat, "target_unavailable"));
  if (!can(w, "interrupt")) return unsupported(s, "interrupt");
  if (e.stale) return unavailable(s, "session is stale");
  if (!isInterruptible(effectiveState(e.session.status))) return step(tell(s, NOTICE.nothingToStop, "failed"));
  return step({ ...s, confirm: { type: "interrupt", key: e.key, label: e.session.title } });
}

function askCreateSession(s: ControllerState, w: World): Step {
  const key = s.taskCursor ?? chatTaskKey(s, w);
  const task = key === null ? undefined : w.registry.task(key);
  if (!task || key === null) return step(tell(s, NOTICE.selectTask, "target_unavailable"));
  if (!can(w, "createSession")) return unsupported(s, "createSession");
  const provider = talkProvider(effectiveTalk(s));
  return step({ ...s, confirm: { type: "createSession", taskKey: key, provider, label: task.title } });
}

/** Second step of every dangerous action. Re-validates the target at execution time. */
function executeConfirm(s0: ControllerState, c: ConfirmAction, w: World): Step {
  const s = { ...s0, confirm: null };
  if (c.type === "voiceSubmit") return step(w.composer.state === "reviewing" ? countCannedUse(s, w) : s, { type: "voiceSubmit" });
  if (c.type === "createSession") {
    const task = w.registry.task(c.taskKey);
    return task ? step(s, { type: "createSession", task: task.ref, provider: c.provider }) : unavailable(s, "task gone");
  }
  const e = w.registry.get(c.key);
  if (!e || e.stale) return unavailable(s, "session is stale");
  if (c.type === "interrupt") return step(s, { type: "interrupt", ref: e.session.ref });
  if (!w.registry.approval(c.approvalId)) return unavailable(s, APPROVAL_GONE);
  return step(s, { type: c.type, approvalId: c.approvalId, ref: e.session.ref });
}

function onKey(s: ControllerState, key: number, gesture: string, w: World): Step {
  if (key < 0 || key >= PAGE_SIZE || gesture === "down" || gesture === "up") return step(s);
  if (currentView(s, w) === "confirm") return step(s);
  if (s.view === "tasks") {
    if (gesture === "long") {
      const t = taskPage(s, w)[key];
      return t ? togglePin(s, w, taskKey(t.ref)) : step(s);
    }
    return gesture === "single" ? pickTask(s, key, w) : step(s);
  }
  if (s.view === "inbox") return pickInboxItem(s, key, gesture, w);
  if (splitSessions(s) && isBlackKey(key)) return onBlackKey(s, key, gesture, w);
  const sessionKey = sessionPage(s)[key] ?? null;
  if (sessionKey === null) return step(s);
  if (isTaskKey(sessionKey)) return onFoldedRow(s, w, sessionKey, gesture);
  const e = w.registry.get(sessionKey);
  if (gesture === "long") return togglePin(s, w, sessionKey);
  if (!e || e.stale) return unavailable(s, "session is stale");
  if (gesture === "double") return focus(step(s, { type: "select", key: sessionKey }), e.session.ref, w);
  return step({ ...s, detailScroll: 0, detail: s.detail === null ? null : 0 }, { type: "select", key: sessionKey });
}

/**
 * GROUPED folded task row (docs/ui-v3.md section 9.2): a tap sets the TASK filter to the task (it then expands), or
 * clears it when it already is the filter; a long press pins or unpins the task; a double tap does nothing.
 */
function onFoldedRow(s: ControllerState, w: World, tk: string, gesture: string): Step {
  if (gesture === "long") return togglePin(s, w, tk);
  // PINNED ignores TASK (section 9.4): a tap there would only set a hidden filter that leaks into the other scopes.
  if (gesture !== "single" || s.scope === "pinned") return step(s);
  const task = w.registry.task(tk);
  if (!task) return unavailable(s, "task gone");
  const clear = s.taskFilter === tk;
  // The task's repo is set implicitly; clearing the task puts back the repo KNOB2 chose (operator report 2026-11-19).
  const next: ControllerState = { ...s, taskFilter: clear ? null : tk, repoFilter: clear ? s.repoKnob : task.ref.projectId, taskCursor: clear ? s.taskCursor : tk, detailScroll: 0 };
  const tasksToo = (st: ControllerState): ControllerState => (st.repoFilter === s.repoFilter ? st : relayout(st, w, "tasks", true));
  return step(tell(tasksToo(relayout(next, w, "sessions")), knobToast.task(clear ? null : task.title)), { type: "resort", view: "sessions" });
}

// SPLIT black row (docs/ui-v3.md section 10.3).

/** Toast for a choice: `Show: all`, `Show: pinned (<n>)`, `Needs you (<n>)`, `Task: <title>`. */
function choiceToast(s: ControllerState, w: World): string {
  const n = whiteCount(whiteList(s, w, false));
  switch (s.split.chosen) {
    case "all":
      return "Show: all";
    case "pinned":
      return `Show: pinned (${n})`.length <= 20 ? `Show: pinned (${n})` : "Show: pinned";
    case "needs":
      return `Needs you (${n})`;
    case "task":
      return knobToast.task(s.split.task === null ? null : (w.registry.task(s.split.task)?.title ?? ""));
  }
}

/**
 * Choosing re-sorts the white keys (page 1); the task page stays. Choosing ALL also drops a repo a task choice set
 * implicitly (back to the KNOB2 repo, operator report 2026-11-19); the task row then re-sorts for that repo (page kept).
 */
function choose(s: ControllerState, w: World, split: SplitState): Step {
  const base: ControllerState = { ...s, split, knob3At: null, detailScroll: s.detail === null ? 0 : s.detailScroll };
  const implicit = split.chosen === "all" && (s.repoFilter !== s.repoKnob || s.taskFilter !== null);
  const cleared = implicit ? relayout(relayoutTaskRow({ ...base, repoFilter: s.repoKnob, taskFilter: null }, w, "keep"), w, "tasks", true) : base;
  const next = relayout(cleared, w, "sessions");
  return step(tell(next, choiceToast(next, w)), { type: "resort", view: "sessions" });
}

function onBlackKey(s: ControllerState, key: number, gesture: string, w: World): Step {
  const filter = FILTER_OF[key];
  const cur = s.split;
  if (filter !== undefined) {
    if (gesture !== "single") return step(s);
    // ALL when chosen: nothing, unless a task choice left its repo set implicitly (then ALL clears it).
    const implicit = s.repoFilter !== s.repoKnob || s.taskFilter !== null;
    if (cur.chosen === filter) return filter === "all" && !implicit ? step(s) : choose(s, w, { ...cur, chosen: "all", task: null });
    return choose(s, w, { ...cur, chosen: filter, task: null });
  }
  const slot = taskSlotOf(key);
  const tk = slot < 0 ? null : (taskRowPage(s.taskRow, s.split.taskPage)[slot] ?? null);
  if (tk === null || !w.registry.task(tk)) return step(s);
  if (gesture === "long") return togglePin(s, w, tk);
  if (gesture === "double") {
    // Opens the task's first session (white-key order) on the Mac; no live session or no focus: nothing.
    const first = whiteList(s, w, sessionsGrouped(s), { ...cur, chosen: "task", task: tk }).keys.find((k) => isSessionKey(k) && w.registry.get(k)?.stale === false);
    const e = first === undefined ? undefined : w.registry.get(first);
    return e && can(w, "focus") ? step(s, { type: "focus", ref: e.session.ref }) : step(s);
  }
  if (gesture !== "single") return step(s);
  if (cur.chosen === "task" && cur.task === tk) return choose(s, w, { ...cur, chosen: "all", task: null });
  return choose(s, w, { ...cur, chosen: "task", task: tk });
}

/** Key long press: pin or unpin a session or (Tasks view, folded row) a task, then re-sort (an explicit act on the layout). */
function togglePin(s: ControllerState, w: World, key: string): Step {
  const isTask = isTaskKey(key);
  // SPLIT: both rows re-sort; the task page holds the task just (un)pinned (a session pin: the first row).
  const sessions = (st: ControllerState): ControllerState => (splitOn(st) ? resortSplit(st, w, { task: isTask ? key : null }) : relayout(st, w, "sessions"));
  const resort = (st: ControllerState): ControllerState => relayout(sessions(st), w, "tasks", true);
  if (s.pins.includes(key)) {
    const next = resort({ ...s, pins: s.pins.filter((k) => k !== key) });
    return step(tell(next, isTask ? NOTICE.taskUnpinned : NOTICE.unpinned), { type: "unpin", key });
  }
  if (isTask) {
    if (!w.registry.task(key)) return unavailable(s, "task gone");
  } else {
    const e = w.registry.get(key);
    if (!e || e.stale) return unavailable(s, "session is stale");
  }
  // No limit (operator decision 2026-11-19): only a safety cap per kind, session pins and task pins counted apart.
  if (s.pins.filter(isTask ? isTaskKey : isSessionKey).length >= MAX_PINS_PER_KIND) return step(tell(s, isTask ? NOTICE.taskPinsFull : NOTICE.pinsFull, "failed"));
  const next = resort({ ...s, pins: [...s.pins, key] });
  return step(tell(next, isTask ? NOTICE.taskPinned : NOTICE.pinned), { type: "pin", key });
}

function focus(prev: Step, ref: SessionRef, w: World): Step {
  if (!can(w, "focus")) {
    const u = unsupported(prev.state, "focus");
    return step(u.state, ...prev.actions, ...u.actions);
  }
  return step(prev.state, ...prev.actions, { type: "focus", ref });
}

/** A task tap opens Sessions filtered to that task (and its repo). */
function pickTask(s: ControllerState, key: number, w: World): Step {
  const task = taskPage(s, w)[key];
  if (!task) return step(s);
  const k = taskKey(task.ref);
  if (splitOn(s)) {
    // SPLIT (docs/ui-v3.md section 10.3): Sessions with that task chosen, on the task page that holds it.
    const next: ControllerState = { ...s, taskCursor: k, view: "sessions", split: { ...s.split, chosen: "task", task: k }, detailScroll: 0, detail: s.detail === null ? null : 0 };
    return step(resortSplit(next, w, { task: k }), { type: "resort", view: "sessions" });
  }
  // Under PINNED (which ignores TASK) the tap leaves for ALL, so the chosen task is what Sessions shows (section 9.4).
  // The task's repo becomes the REPO filter implicitly (repoKnob unchanged), so clearing the task clears it again.
  const scope = s.scope === "pinned" ? "all" : s.scope;
  const next = { ...s, scope, taskCursor: k, taskFilter: k, repoFilter: task.ref.projectId, view: "sessions" as const, detailScroll: 0, detail: s.detail === null ? null : 0 };
  return step(relayout(next, w, "sessions"), { type: "resort", view: "sessions" });
}

function pickInboxItem(s: ControllerState, key: number, gesture: string, w: World): Step {
  const item = inboxPage(s, w)[key];
  if (!item) return step(s);
  if (gesture === "long") return togglePin({ ...s, inboxCursor: item.id }, w, item.sessionKey);
  const next = { ...s, inboxCursor: item.id, detailScroll: 0, detail: s.detail === null ? null : 0 };
  const entry = w.registry.get(item.sessionKey);
  const actions: ControllerAction[] = [{ type: "markRead", itemId: item.id }];
  if (entry && !entry.stale) actions.push({ type: "select", key: item.sessionKey });
  const base = step(next, ...actions);
  return gesture === "double" && entry && !entry.stale ? focus(base, entry.session.ref, w) : base;
}

function onEncoder(s: ControllerState, enc: EncoderName, dir: number, w: World): Step {
  const view = currentView(s, w);
  if (view === "confirm") return step(s);
  if (view === "detail") {
    if (enc === "PRESETS") return step(turnDetailPage(s, w, dir));
    if (enc === "SELECT") return moveCursor(s, dir, w);
    if (enc === "ALGORITHM") return jumpAttention(s, dir, w);
    return step(s); // knobs do nothing here (legend empty)
  }
  if (view === "voice") {
    if (enc !== "PRESETS") return step(s);
    // A suggestion longer than the bubble scrolls to its end before PRESETS moves on, so SAVE never sends unseen text.
    const scrolled = scrollBy(s, w, dir, true);
    if (s.bubble && scrolled.detailScroll !== Math.min(bubbleScroll(s, w, true), bubbleMaxScroll(voiceLines(w).length))) return step(scrolled);
    return cycleSuggestion(s, w, dir) ?? step(scrolled);
  }
  switch (enc) {
    case "SELECT":
      return moveCursor(s, dir, w);
    case "ALGORITHM":
      return jumpAttention(s, dir, w);
    case "PRESETS":
      return openReaderOrScroll(s, w, dir);
    case "K1":
      return s.view === "inbox" ? step(s) : step(cycleScope(s, dir, w));
    case "K2":
      // PINNED ignores REPO and TASK (docs/ui-v3.md section 9.4): their knobs do nothing there (SPLIT: PINNED chosen).
      if (splitSessions(s) && s.split.chosen === "pinned") return step(s);
      return s.view === "inbox" || s.scope === "pinned" ? step(s) : step(cycleRepo(s, dir, w));
    case "K3":
      // SPLIT: KNOB3 steps the chosen task through the frozen task row (operator brief 2026-11-19, ui-v3 section 10.9).
      if (splitSessions(s)) return step(stepSplitTask(s, dir, w));
      return s.view === "sessions" && s.scope !== "pinned" ? step(cycleTask(s, dir, w)) : step(s);
    case "K4":
      return step(cycleTalk(s, dir, w));
    default:
      return step(s);
  }
}

/**
 * PRESETS in Sessions or TO DO with protocol 5 and a chat shown opens the fullscreen reader (DETAILS) on page 0, the
 * newest message first (docs/ui-v3.md section 9.8); the opening turn is its first step. Tasks, protocol <= 4, or
 * nothing selected: the bubble scroll as before.
 */
function openReaderOrScroll(s: ControllerState, w: World, dir: number): Step {
  if (s.listLayout && s.detailsPage && (s.view === "sessions" || s.view === "inbox")) {
    return focusEntry(s, w) ? step({ ...s, detail: 0 }) : step(s);
  }
  return step(scrollBy(s, w, dir, false));
}

/**
 * PRESETS in the base views and voice. Version 3: one line per step (view.ts clamps). Version 4: one bubble page
 * (5 rows) per step, clamped to the last page here, so turning back always moves (docs/ui-v3.md section 6.3).
 */
function scrollBy(s: ControllerState, w: World, dir: number, voice: boolean): ControllerState {
  if (!s.bubble) return { ...s, detailScroll: Math.max(0, s.detailScroll + dir) };
  // The same lines the view draws (view.ts bubbleText / voiceBubble), from the step that applies to them now.
  const lines = voice ? voiceLines(w).length : (focusBubble(s, w)?.lines.length ?? 0);
  // Version 5 List layout: one line per step (docs/ui-v3.md section 8.5).
  const shown = currentView(s, w);
  const rows = !voice && shown === "sessions" && splitSessions(s) ? 4 : undefined;
  const max = !voice && screenOf(s, shown) === "list" ? listMaxScroll(lines) : bubbleMaxScroll(lines, rows);
  const from = Math.min(bubbleScroll(s, w, voice), max);
  return { ...s, detailScroll: Math.max(0, Math.min(max, from + dir)), bubbleFor: bubbleSubject(s, w, voice) };
}

function cycle<T>(items: readonly T[], current: T, dir: number): T {
  if (items.length === 0) return current;
  const i = items.indexOf(current);
  const next = i < 0 ? (dir > 0 ? 0 : items.length - 1) : (i + dir + items.length) % items.length;
  // Not `items[next] ?? current`: null is a real entry (KNOB2 / KNOB3 "all"), and `??` would turn it back into current,
  // so the knob could never return to all (operator report 2026-11-19).
  return items[next] as T;
}

/** Sessions after a KNOB1/KNOB2 change: SPLIT re-sorts both rows (task page holding the chosen task), else Sessions. */
const knobResort = (s: ControllerState, w: World): ControllerState => (splitOn(s) ? resortSplit(s, w, "chosen") : relayout(s, w, "sessions"));

/** KNOB1 SHOW: ACTIVE -> RECENT -> ALL -> PINNED (stops at the ends). SPLIT: no PINNED step (section 10.4). */
function cycleScope(s: ControllerState, dir: number, w: World): ControllerState {
  const scopes = splitOn(s) ? SPLIT_SCOPES : SCOPES;
  const i = scopes.indexOf(s.scope);
  const scope = scopes[Math.max(0, Math.min(scopes.length - 1, i + dir))] ?? s.scope;
  if (scope === s.scope) return s;
  const next = relayout(knobResort({ ...s, scope, detailScroll: 0, detail: s.detail === null ? null : 0 }, w), w, "tasks");
  const n = splitOn(next) ? scopeMembers({ ...next, taskFilter: null }, w).length : scopeMembers(next, w).length;
  return tell(next, knobToast.show(scope, n));
}

/** KNOB2 REPO: all -> repos with a session in the scope, best tier first. Resets TASK. */
function cycleRepo(s: ControllerState, dir: number, w: World): ControllerState {
  const repos = repoChoices(s, w);
  const ids: (string | null)[] = [null, ...repos.map((p) => p.projectId)];
  const repoFilter = cycle(ids, s.repoFilter, dir);
  const next = relayout(knobResort({ ...s, repoFilter, repoKnob: repoFilter, taskFilter: null, taskCursor: null, knob3At: null, detailScroll: 0, detail: s.detail === null ? null : 0 }, w), w, "tasks");
  return tell(next, knobToast.repo(repos.find((p) => p.projectId === repoFilter)?.name ?? null));
}

/** KNOB3 TASK: all -> tasks of the repo with a session in the scope, best tier first. */
function cycleTask(s: ControllerState, dir: number, w: World): ControllerState {
  const tasks = taskChoices(s, w);
  const keys: (string | null)[] = [null, ...tasks.map((t) => t.key)];
  const taskFilter = cycle(keys, s.taskFilter, dir);
  // Back to all: a repo the task choice set implicitly goes back to the KNOB2 repo.
  const repoFilter = taskFilter === null ? s.repoKnob : s.repoFilter;
  const moved = relayout({ ...s, taskFilter, repoFilter, detailScroll: 0, detail: s.detail === null ? null : 0 }, w, "sessions");
  const next = repoFilter === s.repoFilter ? moved : relayout(moved, w, "tasks", true);
  return tell(next, knobToast.task(tasks.find((t) => t.key === taskFilter)?.task.title ?? null));
}

/** SPLIT KNOB3: the white keys are laid out once the knob rests this long (one relayout per pause). */
export const KNOB3_REST_MS = 300;

/**
 * SPLIT KNOB3 (operator brief 2026-11-19, docs/ui-v3.md section 10.9): one task of the frozen task row per detent,
 * wrapping; from ALL / PINNED / NEEDS YOU the first turn picks the first (clockwise) or last (counter-clockwise) task.
 * The task page follows the chosen task and the black row updates at once; the white keys wait for KNOB3_REST_MS.
 */
function stepSplitTask(s: ControllerState, dir: number, w: World): ControllerState {
  const keys = s.taskRow.keys.filter((k) => w.registry.task(k) !== undefined);
  if (keys.length === 0) return s;
  const cur = s.split.chosen === "task" ? keys.indexOf(s.split.task ?? "") : -1;
  const at = cur < 0 ? (dir > 0 ? 0 : keys.length - 1) : (cur + dir + keys.length) % keys.length;
  const tk = keys[at] as string;
  const page = pageOfTask(s.taskRow, tk);
  const split: SplitState = { ...s.split, chosen: "task", task: tk, taskPage: page < 0 ? s.split.taskPage : page };
  return tell({ ...s, split, knob3At: w.now }, knobToast.task(w.registry.task(tk)?.title ?? ""));
}

/** Lays the white keys out for the chosen task now (page 1), as choosing it with its black key does. */
function settleKnob3(s: ControllerState, w: World): ControllerState {
  const next: ControllerState = { ...s, knob3At: null };
  return splitOn(next) ? relayout({ ...next, detailScroll: s.detail === null ? 0 : s.detailScroll }, w, "sessions") : next;
}

/** The KNOB3 rest timer fired (the console re-arms it on every turn): the white keys follow once the knob rested. */
export function resolveKnob3(s: ControllerState, w: World): ControllerState {
  if (s.knob3At === null || w.now - s.knob3At < KNOB3_REST_MS) return s;
  return settleKnob3(s, w);
}

/** KNOB4 TALK: reply -> Claude chat -> Codex chat -> Claude task -> Codex task (supported ones only). */
function cycleTalk(s: ControllerState, dir: number, w: World): ControllerState {
  const modes = talkModes(w);
  if (modes.length === 0) return s;
  const talk: Talk = cycle(modes, s.talk, dir);
  return tell({ ...s, talk }, knobToast.talk(talk));
}

function moveCursor(s: ControllerState, dir: number, w: World): Step {
  if (s.view === "tasks") {
    const keys = layoutOf(s, "tasks").keys().filter((k): k is string => k !== null && w.registry.task(k) !== undefined);
    const k = cycle(keys, s.taskCursor ?? "", s.taskCursor === null || !keys.includes(s.taskCursor) ? (dir > 0 ? 1 : -1) : dir);
    if (!k) return step(s);
    const page = pageOfIndex(layoutOf(s, "tasks").indexOf(k));
    return step({ ...s, taskCursor: k, pages: { ...s.pages, tasks: page }, detailScroll: 0, detail: s.detail === null ? null : 0 });
  }
  if (s.view === "inbox") {
    const l = layoutOf(s, "inbox");
    const ids = l.keys().filter((k): k is string => k !== null && w.inbox.get(k) !== undefined);
    const id = cycle(ids, s.inboxCursor ?? "", s.inboxCursor === null || !ids.includes(s.inboxCursor) ? (dir > 0 ? 1 : -1) : dir);
    if (!id) return step(s);
    return pickInboxAt(s, w, id);
  }
  const l = layoutOf(s, "sessions");
  const live = l.keys().filter((k): k is string => k !== null && w.registry.get(k)?.stale === false);
  const sel = w.registry.selection().key;
  const next = cycle(live, sel ?? "", sel === null || !live.includes(sel) ? (dir > 0 ? 1 : -1) : dir);
  if (!next) return step(s);
  return step({ ...s, pages: { ...s.pages, sessions: l.pageOf(l.indexOf(next)) }, detailScroll: 0, detail: s.detail === null ? null : 0 }, { type: "select", key: next });
}

function pickInboxAt(s: ControllerState, w: World, id: string): Step {
  const item = w.inbox.get(id);
  if (!item) return step(s);
  const page = pageOfIndex(layoutOf(s, "inbox").indexOf(id));
  const actions: ControllerAction[] = [{ type: "markRead", itemId: id }];
  const e = w.registry.get(item.sessionKey);
  if (e && !e.stale) actions.push({ type: "select", key: item.sessionKey });
  return step({ ...s, inboxCursor: id, pages: { ...s.pages, inbox: page }, detailScroll: 0, detail: s.detail === null ? null : 0 }, ...actions);
}

/** ALGORITHM: next / previous item that needs you (T0-T3), in layout order, across pages. */
function jumpAttention(s: ControllerState, dir: number, w: World): Step {
  if (s.view === "inbox") {
    const l = layoutOf(s, "inbox");
    const ids = l.keys().filter((k): k is string => {
      const item = k === null ? undefined : w.inbox.get(k);
      return item !== undefined && isAttention(itemTier(item, w.now) ?? 9);
    });
    const cur = s.inboxCursor;
    const id = cycle(ids, cur ?? "", cur === null || !ids.includes(cur) ? (dir > 0 ? 1 : -1) : dir);
    return id ? pickInboxAt(s, w, id) : step(s);
  }
  if (s.view === "tasks") {
    const l = layoutOf(s, "tasks");
    // PINNED lists tasks across repos (section 9.4): the REPO filter must not hide their tiers.
    const tiers = new Map(taskChoices({ scope: "all", repoFilter: s.scope === "pinned" ? null : s.repoFilter }, w).map((t) => [t.key, t.tier]));
    const keys = l.keys().filter((k): k is string => k !== null && isAttention(tiers.get(k) ?? 9));
    const k = nextFrom(l.keys(), keys, s.taskCursor, dir);
    if (!k) return step(s);
    return step({ ...s, taskCursor: k, pages: { ...s.pages, tasks: pageOfIndex(l.indexOf(k)) }, detailScroll: 0, detail: s.detail === null ? null : 0 });
  }
  const l = layoutOf(s, "sessions");
  const keys = l.keys().filter((k): k is string => {
    const e = k === null ? undefined : w.registry.get(k);
    return e !== undefined && !e.stale && isAttention(rank(e, w).tier);
  });
  const k = nextFrom(l.keys(), keys, w.registry.selection().key, dir);
  if (!k) return step(s);
  return step({ ...s, pages: { ...s.pages, sessions: l.pageOf(l.indexOf(k)) }, detailScroll: 0, detail: s.detail === null ? null : 0 }, { type: "select", key: k });
}

/** The next candidate after (or before) `from` in layout order, wrapping; `from` need not be a candidate. */
function nextFrom(order: readonly (string | null)[], candidates: readonly string[], from: string | null, dir: number): string | undefined {
  if (candidates.length === 0) return undefined;
  const pos = (k: string): number => order.indexOf(k);
  const at = from === null ? -1 : pos(from);
  if (dir > 0) return candidates.find((k) => pos(k) > at) ?? candidates[0];
  const before = candidates.filter((k) => at < 0 || pos(k) < at);
  return before.at(-1) ?? candidates.at(-1);
}
