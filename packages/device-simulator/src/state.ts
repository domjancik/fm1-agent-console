// Browser-safe: type-only imports from the protocol package.
import type {
  CommandResultCode,
  FourStrings,
  HostMessage,
  KeyMode,
  Layout,
  LinkState,
  Provider,
  SlotFlags,
  SlotHead,
  SlotRow,
  SlotState,
  TextRow,
  View,
  VoiceState,
} from "@fm1/device-protocol";

export const KEY_COUNT = 27;
/** DETAILS page rows (SET_TEXT, protocol version 3). */
export const TEXT_ROW_COUNT = 12;
/** Bars of the version 4 voice level meter (fm1c_model.h FM1C_BARS). */
export const VOICE_BARS = 28;

export interface Slot {
  state: SlotState;
  flags: SlotFlags;
  label: string;
  /** Protocol version 5 (docs/ui-v3.md section 8.6): the list row's title and age ("" when not sent). */
  title?: string;
  age?: string;
  /** Version 5 GROUPED (docs/ui-v3.md section 9.5): the row byte and the group header (absent: indent 0, no header). */
  row?: SlotRow;
  head?: SlotHead;
}

/** Device-local link condition, as the firmware would show it. */
export type HostPhase = "no_host" | "connected" | "incompatible";

export interface LinkView {
  phase: HostPhase;
  /** A frame exhausted its retransmits (NO REPLY); cleared by the next ACK or handshake. */
  linkError: boolean;
  /** "UPDATE APP" / "OLD FIRMWARE" / "INCOMPATIBLE" when phase is incompatible. */
  incompatible: string;
  proto: number;
  hostSession: number;
}

export interface LastResult {
  reqSeq: number;
  result: CommandResultCode;
  text: string;
  atMs: number;
}

/**
 * Device-local UI that the host never sees (docs/ui-v3.md section 5): the help overlay while SCL is held, and the
 * knob row for 2 s after a K1-K4 turn (protocol version 4). `maxProto` is the firmware's own highest version: a
 * version 4 firmware draws its version 4 banner before any host has agreed a version.
 */
export interface LocalUi {
  maxProto: number;
  help: boolean;
  /** 0-3: the knob whose row cell is lit; -1 none. */
  knobLit: number;
  knobUntilMs: number;
  /**
   * Device time the screen was dimmed (no host / incompatible). The firmware stops every sprite while dimmed, so the
   * sprites under the banner keep the frame of that moment (fm1c_draw4.h: fm1c_anim_hero/key with no pose).
   */
  dimSinceMs: number;
}

/** How long the knob row shows after a knob turn (docs/ui-v3.md section 5). */
export const KNOB_ROW_MS = 2000;

export interface DeviceState {
  link: LinkView;
  /**
   * `layout`: the version 5 SET_VIEW layout byte (absent = buddy). `keys`, `taskPage`, `taskPages`: the version 6 keys
   * byte and the SPLIT task page (absent = ranked; docs/ui-v3.md section 10.6).
   */
  view: { view: View; page: number; pages: number; title: string; layout?: Layout; keys?: KeyMode; taskPage?: number; taskPages?: number };
  slots: Slot[];
  detail: { provider: Provider; state: SlotState; lines: FourStrings };
  /**
   * `bars`/`barN`: the version 4 level meter (fm1c_model.h `bar`, `bar_n`): one bar per elapsed step while recording,
   * sweeping left to right over 28 columns; cleared when a recording starts.
   */
  voice: { voice: VoiceState; level: number; elapsedDs: number; target: string; bars: number[]; barN: number };
  legend: FourStrings;
  status: { link: LinkState; attentionCount: number; text: string };
  lastResult: LastResult | null;
  master: number;
  /** The 12-row DETAILS text buffer; stored in every view, drawn in the `detail` view (and as the bubble in v4). */
  text: TextRow[];
  local: LocalUi;
}

const NO_FLAGS: SlotFlags = { selected: false, codex: false, stale: false, pinned: false };

export const emptySlot = (): Slot => ({ state: "empty", flags: { ...NO_FLAGS }, label: "", title: "", age: "" });
export const emptyText = (): TextRow[] => Array.from({ length: TEXT_ROW_COUNT }, () => ({ style: "body" as const, text: "" }));

export function initialState(maxProto = 4): DeviceState {
  return {
    link: { phase: "no_host", linkError: false, incompatible: "", proto: 0, hostSession: 0 },
    view: { view: "sessions", page: 0, pages: 1, title: "", layout: "buddy" },
    slots: Array.from({ length: KEY_COUNT }, emptySlot),
    detail: { provider: "none", state: "empty", lines: ["", "", "", ""] },
    voice: { voice: "ready", level: 0, elapsedDs: 0, target: "", bars: Array.from({ length: VOICE_BARS }, () => 0), barN: 0 },
    legend: ["", "", "", ""],
    status: { link: "ok", attentionCount: 0, text: "" },
    lastResult: null,
    master: 0,
    text: emptyText(),
    local: { maxProto, help: false, knobLit: -1, knobUntilMs: 0, dimSinceMs: 0 },
  };
}

/**
 * Applies one host frame. SET_* frames fully replace their element (protocol section 3),
 * so the result never depends on what was there before. Returns the same object when the
 * message carries no displayable state (ACK, HEARTBEAT, HELLO_ACK).
 */
export function applyHostMessage(state: DeviceState, msg: HostMessage, nowMs: number): DeviceState {
  switch (msg.kind) {
    case "SET_VIEW":
      // (version 5: the layout byte; absent = buddy, kept out of the state so version 1-4 states stay as they were)
      return {
        ...state,
        view: {
          view: msg.view,
          page: msg.page,
          pages: msg.pages,
          title: msg.title,
          ...(msg.layout === undefined ? {} : { layout: msg.layout }),
          // (version 6: kept out of the state when absent, so version 1-5 states stay as they were)
          ...(msg.keys === undefined ? {} : { keys: msg.keys }),
          ...(msg.keys === "split" ? { taskPage: msg.taskPage ?? 0, taskPages: msg.taskPages ?? 1 } : {}),
        },
      };
    case "SET_SLOT": {
      if (msg.key < 0 || msg.key >= KEY_COUNT) return state;
      const slots = state.slots.slice();
      slots[msg.key] = {
        state: msg.state,
        flags: { ...msg.flags },
        label: msg.label,
        ...(msg.title === undefined && msg.age === undefined ? {} : { title: msg.title ?? "", age: msg.age ?? "" }),
        ...(msg.row === undefined ? {} : { row: { ...msg.row } }),
        ...(msg.head === undefined ? {} : { head: { ...msg.head } }),
      };
      return { ...state, slots };
    }
    case "CLEAR_SLOTS":
      return { ...state, slots: Array.from({ length: KEY_COUNT }, emptySlot) };
    case "SET_DETAIL":
      return { ...state, detail: { provider: msg.provider, state: msg.state, lines: [...msg.lines] } };
    case "SET_VOICE": {
      // The meter as fm1c_model.h keeps it: a new recording clears it; each elapsed step while recording writes a bar.
      const prev = state.voice;
      let bars = prev.bars;
      let barN = prev.barN;
      if (prev.voice !== msg.voice && msg.voice === "recording") {
        bars = Array.from({ length: VOICE_BARS }, () => 0);
        barN = 0;
      }
      if (prev.elapsedDs !== msg.elapsedDs && msg.voice === "recording") {
        bars = bars.slice();
        bars[barN] = Math.min(100, msg.level);
        barN = (barN + 1) % VOICE_BARS;
      }
      return {
        ...state,
        voice: { voice: msg.voice, level: msg.level, elapsedDs: msg.elapsedDs, target: msg.target, bars, barN },
      };
    }
    case "SET_LEGEND":
      return { ...state, legend: [...msg.labels] };
    case "SET_STATUS":
      return { ...state, status: { link: msg.link, attentionCount: msg.attentionCount, text: msg.text } };
    case "SET_TEXT": {
      if (msg.row < 0 || msg.row + msg.lines.length > TEXT_ROW_COUNT) return state;
      const text = state.text.slice();
      msg.lines.forEach((l, i) => {
        text[msg.row + i] = { style: l.style, text: l.text };
      });
      return { ...state, text };
    }
    case "COMMAND_RESULT":
      return { ...state, lastResult: { reqSeq: msg.reqSeq, result: msg.result, text: msg.text, atMs: nowMs } };
    case "HELLO_ACK":
    case "HEARTBEAT":
    case "ACK":
      return state;
  }
}

/** The selected key, or -1. The host owns selection; the device only reflects the flag. */
export const selectedKey = (state: DeviceState): number => state.slots.findIndex((s) => s.flags.selected);
