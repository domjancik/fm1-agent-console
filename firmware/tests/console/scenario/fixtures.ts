// SPDX-License-Identifier: GPL-3.0-only
// Host state the scenarios send, and the LED rules of docs/protocol.md section 6 as the companion reads them,
// to predict what the firmware's LEDs show at a given ms.
import type { HostMessage, SlotFlags, SlotState } from "../../../../packages/device-protocol/src/index.ts";

export interface SlotSpec {
  key: number;
  state: SlotState;
  label: string;
  selected?: boolean;
  codex?: boolean;
  stale?: boolean;
  pinned?: boolean;
  /** Version 6 (docs/ui-v3.md section 10.6): flag bit 4, the chosen filter / task key of the SPLIT black row. */
  chosen?: boolean;
  /** Version 5 (docs/ui-v3.md section 8.6): the list row's title and age; set: the version 5 SET_SLOT body. */
  title?: string;
  age?: string;
  /** Version 5 grouped (docs/ui-v3.md section 9.5): the row byte and, with start, the group's header. */
  row?: { indent: 0 | 1 | 2; start: boolean; task: boolean };
  head?: { state: SlotState; pinned: boolean; title: string; count: string };
}

export const flags = (s: SlotSpec): SlotFlags => ({
  selected: s.selected ?? false,
  codex: s.codex ?? false,
  stale: s.stale ?? false,
  pinned: s.pinned ?? false,
  ...(s.chosen ? { chosen: true } : {}),
});

export const setSlot = (s: SlotSpec): HostMessage =>
  s.title === undefined && s.age === undefined && s.row === undefined
    ? { kind: "SET_SLOT", key: s.key, state: s.state, flags: flags(s), label: s.label }
    : { kind: "SET_SLOT", key: s.key, state: s.state, flags: flags(s), label: s.label, title: s.title ?? "", age: s.age ?? "",
        ...(s.row ? { row: s.row } : {}), ...(s.row?.start && s.head ? { head: s.head } : {}) } as HostMessage;

/** 27 keys of mixed sessions (fixtures/sessions/mixed.json's spirit): every state, a selection, a stale one. */
export const MIXED: SlotSpec[] = [
  { key: 0, state: "working", label: "fw codec" },
  { key: 1, state: "approval_required", label: "fw review", codex: true },
  { key: 2, state: "working", label: "voice tests", selected: true },
  { key: 3, state: "waiting_input", label: "refund hook" },
  { key: 4, state: "completed_unread", label: "docs" },
  { key: 5, state: "failed", label: "ci fix", codex: true },
  { key: 6, state: "idle", label: "research" },
  { key: 7, state: "completed_read", label: "release" },
  { key: 8, state: "unknown", label: "old task", stale: true },
  { key: 9, state: "disconnected", label: "offline" },
  { key: 12, state: "working", label: "api", codex: true },
  { key: 13, state: "idle", label: "notes", pinned: true },
  { key: 18, state: "approval_required", label: "migrate" },
  { key: 20, state: "completed_unread", label: "bench" },
  { key: 26, state: "waiting_input", label: "question" },
];

export function fullSlots(specs: readonly SlotSpec[]): SlotSpec[] {
  return Array.from({ length: 27 }, (_, key) => specs.find((s) => s.key === key) ?? { key, state: "empty", label: "" });
}

export type Level = "off" | "glow" | "full";

const blink = (ms: number, half: number): boolean => ms % (2 * half) < half;

export function keyLevel(s: SlotSpec, ms: number): Level {
  if (s.selected) return s.state === "approval_required" && ms % 1000 < 100 ? "off" : "full";
  switch (s.state) {
    case "approval_required":
      return blink(ms, 500) ? "full" : "off";
    case "failed":
      return blink(ms, 150) ? "full" : "off";
    case "waiting_input":
      return blink(ms, 500) ? "full" : "glow";
    case "completed_unread":
      return ms % 2000 < 120 ? "full" : "glow";
    case "working":
      return "full";
    case "idle":
    case "completed_read":
      return "glow";
    case "unknown":
      return ms % 2000 < 120 ? "off" : "glow";
    default:
      return "off";
  }
}

/** The level of LED id from the harness's two layers (lit wins, as on the panel). */
export function ledLevel(lit: bigint, glow: bigint, id: number): Level {
  const bit = 1n << BigInt(id);
  if (lit & bit) return "full";
  if (glow & bit) return "glow";
  return "off";
}

export const KEY_LED = (k: number): number => 14 + k;
export const BTN = { OCT_DOWN: 0, OCT_UP: 1, FX: 2, SEL: 3, ENV: 4, LFO: 5, EDIT: 6, GLO: 7, HOME: 8, SAVE: 9, ARP: 10, SEQ: 11, PLAY: 12, REC: 13 } as const;

/** LED language v2 (docs/ui-v3.md section 9.9, protocol 5): "back" is the backlight layer (the selected key, breathing). */
export type Level2 = Level | "back";
const burst2 = (state: SlotState, ms: number): boolean => {
  if (state === "approval_required") return ms % 500 < 250;
  if (state === "waiting_input") { const t = ms % 1260; return t < 120 || (t >= 240 && t < 360); }
  return false;
};
export function keyLevel2(s: SlotSpec, ms: number): Level2 {
  if (s.chosen) return "back";   // protocol 6 CHOSEN (section 10.8): first, whatever the state
  if (s.selected && s.state === "failed") return (ms + 150) % 3000 < 300 ? "off" : "back";
  if (s.selected) return burst2(s.state, ms) ? "full" : "back";
  if (s.state === "empty" || s.state === "disconnected") return "off";
  if (s.stale) return ms % 4000 < 150 ? "glow" : "off";
  switch (s.state) {
    case "approval_required":
      return burst2(s.state, ms) ? "full" : "off";
    case "waiting_input":
      return burst2(s.state, ms) ? "full" : "glow";
    case "failed":
      return ms % 3000 < 1500 ? "glow" : "off";
    case "completed_unread":
      return ms % 2500 < 150 ? "full" : "glow";
    case "working":
      return "full";
    case "unknown":
      return ms % 3000 < 150 ? "off" : "glow";
    default:
      return "glow";
  }
}
/** The breathing table and its index at ms (section 9.9). */
export const BREATH_NS = [
  12000, 12010, 12041, 12092, 12163, 12255, 12367, 12500, 12654, 12829, 13025, 13242, 13480, 13740, 14022, 14325,
  14650, 14997, 15367, 15758, 16171, 16607, 17064, 17544, 18045, 18568, 19111, 19676, 20262, 20867, 21492, 22136,
  22797, 23477, 24172, 24883, 25609, 26348, 27099, 27861, 28632, 29412, 30198, 30989, 31783, 32579, 33374, 34168,
  34957, 35741, 36517, 37283, 38038, 38778, 39503, 40210, 40898, 41563, 42206, 42822, 43412, 43972, 44502, 45000,
  45463, 45892, 46284, 46638, 46953, 47228, 47462, 47655, 47806, 47913, 47978, 48000];
export const breathNs = (ms: number): number => { const p = Math.floor(ms / 20) % 150; return BREATH_NS[p <= 75 ? p : 150 - p] ?? 0; };
/** The level of LED id from the three layers (lit wins, then glow, then the backlight). */
export function ledLevel2(lit: bigint, glow: bigint, bg: bigint, id: number): Level2 {
  const bit = 1n << BigInt(id);
  if (lit & bit) return "full";
  if (glow & bit) return "glow";
  if (bg & bit) return "back";
  return "off";
}
