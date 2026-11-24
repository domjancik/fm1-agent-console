// LED rules from docs/protocol.md section 6. Pure functions of state and device time.
import type { ButtonId } from "@fm1/device-protocol";
import type { DeviceState, Slot } from "./state";

/** `breath`: the backlight layer, brightness from `breathNs` (LED language v2, docs/ui-v3.md section 9.9). */
export type LedLevel = "off" | "glow" | "full" | "breath";

export const BUTTON_IDS: readonly ButtonId[] = [
  "OCT_DOWN",
  "OCT_UP",
  "FX",
  "SEL",
  "ENV",
  "LFO",
  "EDIT",
  "GLO",
  "HOME",
  "SAVE",
  "ARP",
  "SEQ",
  "PLAY",
  "REC",
];

const phase = (t: number, period: number): number => ((t % period) + period) % period;
/** `a` for the first `onMs` of each period, else `b`. */
const blink = (t: number, period: number, onMs: number, a: LedLevel, b: LedLevel): LedLevel =>
  phase(t, period) < onMs ? a : b;

/** Key LED level for one slot at device time `t` (ms). `proto` >= 5: LED language v2 (docs/ui-v3.md section 9.9). */
export function keyLed(slot: Slot, t: number, hostConnected: boolean, proto = 0): LedLevel {
  if (proto >= 5) return keyLedV2(slot, t, hostConnected);
  if (!hostConnected) return "glow";
  const { state, flags } = slot;
  if (flags.selected) {
    return state === "approval_required" ? blink(t, 1000, 100, "off", "full") : "full";
  }
  switch (state) {
    case "approval_required":
      return blink(t, 1000, 500, "full", "off");
    case "failed":
      return blink(t, 300, 150, "full", "off");
    case "waiting_input":
      return blink(t, 1000, 500, "full", "glow");
    case "completed_unread":
      return blink(t, 2000, 120, "full", "glow");
    case "working":
      return "full";
    case "idle":
    case "completed_read":
      return "glow";
    case "empty":
    case "disconnected":
      return "off";
    case "unknown":
      return blink(t, 2000, 120, "off", "glow");
  }
}

/** The LED language in force: v2 with protocol 5 agreed (no host: the firmware's own maximum). */
export const ledProto = (s: DeviceState): number => (s.link.phase === "connected" ? s.link.proto : s.local.maxProto);

export const keyLeds = (s: DeviceState, t: number): LedLevel[] =>
  s.slots.map((slot) => keyLed(slot, t, s.link.phase === "connected", ledProto(s)));

/** Button LED levels keyed by button id. */
export function buttonLeds(s: DeviceState, t: number): Record<ButtonId, LedLevel> {
  if (ledProto(s) >= 5) return buttonLedsV2(s, t);
  const out = Object.fromEntries(BUTTON_IDS.map((b) => [b, "off" as LedLevel])) as Record<ButtonId, LedLevel>;
  if (s.link.phase !== "connected") {
    out.OCT_UP = blink(t, 1000, 500, "full", "off");
    return out;
  }
  if (s.voice.voice === "recording") out.REC = "full";
  if (s.voice.voice === "transcribing") out.REC = blink(t, 300, 150, "full", "off");
  if (s.voice.voice === "reviewing") out.SAVE = "full";
  if (s.view.view === "sessions") out.HOME = "full";
  if (s.view.view === "tasks") out.EDIT = "full";
  if (s.view.view === "detail") out.LFO = "full";
  // Version 5 (docs/ui-v3.md section 8.5): SEQ is lit while a List layout is shown.
  if (s.link.proto >= 5 && s.view.layout === "list" && (s.view.view === "sessions" || s.view.view === "inbox")) out.SEQ = "full";
  if (s.view.view === "inbox") out.GLO = "full";
  else if (s.status.attentionCount > 0) out.GLO = blink(t, 1000, 500, "full", "off");
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// LED language v2 (docs/ui-v3.md section 9.9; fm1c_led.h; fixtures/device/led-v2.json). Timelines are data: a period
// and the level from each segment start (ms) until the next.

export type Timeline = { period: number; segs: readonly (readonly [number, LedLevel])[] } | LedLevel;

/** Unselected keys, first matching condition wins (stale before the state). */
export const KEY_TIMELINES = {
  off: "off",
  stale: { period: 4000, segs: [[0, "glow"], [150, "off"]] },
  approval_required: { period: 500, segs: [[0, "full"], [250, "off"]] },
  waiting_input: { period: 1260, segs: [[0, "full"], [120, "glow"], [240, "full"], [360, "glow"]] },
  failed: { period: 3000, segs: [[0, "glow"], [1500, "off"]] },
  completed_unread: { period: 2500, segs: [[0, "full"], [150, "glow"]] },
  working: "full",
  idle: "glow",
  completed_read: "glow",
  unknown: { period: 3000, segs: [[0, "off"], [150, "glow"]] },
  /**
   * Protocol 6 SPLIT (docs/ui-v3.md section 10.8): the chosen filter/task black key (flag bit 4), whatever its state:
   * in the backlight layer, breathing in step with the selected session. No state timeline above breathes.
   */
  chosen: "breath",
} as const satisfies Record<string, Timeline>;

/** Button timelines (never breathing). */
export const BUTTON_TIMELINES = {
  sharp: { period: 500, segs: [[0, "full"], [250, "off"]] },
  double: { period: 1260, segs: [[0, "full"], [120, "off"], [240, "full"], [360, "off"]] },
  tick: { period: 2500, segs: [[0, "full"], [150, "off"]] },
  nohost: { period: 1000, segs: [[0, "full"], [500, "off"]] },
} as const satisfies Record<string, Timeline>;

/** The level of a timeline at device time `t`. */
export function levelAt(tl: Timeline, t: number): LedLevel {
  if (typeof tl === "string") return tl;
  const p = phase(t, tl.period);
  let level: LedLevel = tl.segs[0]?.[1] ?? "off";
  for (const [from, l] of tl.segs) if (p >= from) level = l;
  return level;
}

const BREATH_A = 12000 ** (1 / 2.2), BREATH_B = 48000 ** (1 / 2.2);
/** FM1C_BREATH_NS: a raised cosine in perceived brightness (gamma 2.2), 12,000 ns (never dark) to 48,000 ns, 76 steps (docs/ui-v3.md section 9.9). */
export const BREATH_NS: readonly number[] = Array.from({ length: 76 }, (_, i) => Math.round((BREATH_A + (BREATH_B - BREATH_A) * (1 - Math.cos((Math.PI * i) / 75)) / 2) ** 2.2));
export const BREATH_STEP_MS = 20;
export const BREATH_PERIOD_MS = 3000;
/** fm1_led_bg_ns at device time `t`: a triangle over the table, one step every 20 ms. */
export function breathNs(t: number): number {
  const p = Math.floor(Math.max(0, t) / BREATH_STEP_MS) % 150;
  return BREATH_NS[p <= 75 ? p : 150 - p] ?? 12000;
}
/** A lit LED is on ~95 us a frame; the glow 8 us (FM1_GLOW_NS, set in console.c). For the desktop panel's brightness only. */
export const LIT_NS = 95_000;

function keyTimeline(slot: Slot): Timeline {
  const { state, flags } = slot;
  if (state === "empty" || state === "disconnected") return KEY_TIMELINES.off;
  if (flags.stale) return KEY_TIMELINES.stale;
  return KEY_TIMELINES[state];
}

/** Selected failed: breathing, dipped to off for 300 ms at the bottom of each breath (2850-149 of 3000 ms). */
export const SELECTED_FAILED_DIP = { period: 3000, from: 2850, to: 150 } as const;

/** v2 key level: unselected by the table; selected breathes, with the L windows of approval/question breaking through and failed dipping it. */
export function keyLedV2(slot: Slot, t: number, hostConnected: boolean): LedLevel {
  if (!hostConnected) return slot.flags.selected ? "breath" : "glow";
  if (slot.flags.chosen) return levelAt(KEY_TIMELINES.chosen, t);
  if (!slot.flags.selected) return levelAt(keyTimeline(slot), t);
  const st = slot.state;
  if (st === "failed") {
    const p = phase(t, SELECTED_FAILED_DIP.period);
    return p >= SELECTED_FAILED_DIP.from || p < SELECTED_FAILED_DIP.to ? "off" : "breath";
  }
  if (st === "approval_required" || st === "waiting_input") {
    if (levelAt(KEY_TIMELINES[st], t) === "full") return "full";
  }
  return "breath";
}

/**
 * v2 "active controls" (operator 2026-11-22, docs/ui-v3.md section 9.9; fm1c_button_glow2): the buttons the companion
 * acts on in the shown view glow dim steady unless their own pattern is in force. The voice overlay decides alone;
 * CONFIRM wins over it (the companion's currentView). The base views read SET_DETAIL.state ("empty": nothing selected).
 * REC never glows in a base view.
 */
export function activeButtons(s: DeviceState): ReadonlySet<ButtonId> {
  const d = s.detail.state;
  const shown = d !== "empty" && d !== "disconnected";
  const busy = d === "working" || d === "waiting_input" || d === "approval_required";
  const ask = d === "approval_required";
  const on = (...xs: (ButtonId | false)[]): ReadonlySet<ButtonId> => new Set(xs.filter((x): x is ButtonId => x !== false));
  switch (s.view.view) {
    case "confirm":
      return on("FX");
    case "voice":
      switch (s.voice.voice) {
        case "recording":
        case "transcribing":
        case "target_unavailable":
          return on("FX");
        case "reviewing":
          return on("FX", "ARP");
        case "failed":
          return on("FX", "PLAY");
        default:
          return on();
      }
    case "detail":
      return on("HOME", ask && "FX", busy && "ENV", shown && "PLAY");
    case "settings":
      return on("SAVE", "HOME", "LFO");
    case "sessions":
      return on(ask && "FX", busy && "ENV", shown && "PLAY");
    case "inbox":
      return on(shown && "FX", busy && "ENV", shown && "PLAY");
    case "tasks":
      return on(d !== "empty" && "PLAY");
  }
}

/** v2 buttons (docs/ui-v3.md section 9.9). */
export function buttonLedsV2(s: DeviceState, t: number): Record<ButtonId, LedLevel> {
  const out = Object.fromEntries(BUTTON_IDS.map((b) => [b, "off" as LedLevel])) as Record<ButtonId, LedLevel>;
  if (s.link.phase !== "connected") {
    out.OCT_UP = levelAt(BUTTON_TIMELINES.nohost, t);
    return out;
  }
  const v = s.view.view;
  const active = activeButtons(s);
  // SETTINGS (protocol 6, docs/ui-v3.md section 10.8): ARP lit, the active buttons glow, every other button off.
  if (v === "settings") {
    for (const b of active) out[b] = "glow";
    out.ARP = "full";
    return out;
  }
  if (s.voice.voice === "recording") out.REC = "full";
  if (s.voice.voice === "transcribing") out.REC = levelAt(BUTTON_TIMELINES.sharp, t);
  const approval = (v === "sessions" || v === "inbox" || v === "detail") && s.detail.state === "approval_required";
  if (s.voice.voice === "reviewing" || v === "confirm" || approval) out.SAVE = levelAt(BUTTON_TIMELINES.double, t);
  if (v === "detail") out.LFO = "full";
  const layout = s.view.layout ?? "buddy";
  if ((v === "sessions" && layout !== "buddy") || (v === "inbox" && layout === "list")) out.SEQ = "glow";
  if (v === "sessions") out.HOME = "full";
  if (v === "tasks") out.EDIT = "full";
  if (v === "inbox") out.GLO = "full";
  else if (s.status.attentionCount > 0) out.GLO = levelAt(BUTTON_TIMELINES.tick, t);
  // Active controls glow where no pattern of their own is in force (none of them blinks, so no off phase turns glow).
  for (const b of active) if (out[b] === "off") out[b] = "glow";
  return out;
}
