// Pure LCD layout model (240x240), shared by the canvas renderer and tests.
// Browser-safe: no runtime imports from the protocol package.
import type { CommandResultCode, Provider, SlotState, TextStyle, VoiceState } from "@fm1/device-protocol";
import { EMPTY_OUTLINE, STATE_COLOR, UI } from "./colors";
import { KEY_COUNT, selectedKey, type DeviceState } from "./state";

export const SCREEN = 240;
export const RESULT_SHOW_MS = 2000;

export type FontSize = "small" | "medium" | "large";
/** Bitmap font cells in LCD pixels (6x8, 8x16, 16x24). */
export const FONT: Record<FontSize, { w: number; h: number }> = {
  small: { w: 6, h: 8 },
  medium: { w: 8, h: 16 },
  large: { w: 16, h: 24 },
};

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type DrawOp =
  | ({ t: "fill"; color: string } & Rect)
  | ({ t: "outline"; color: string; width: number } & Rect)
  | { t: "line"; x1: number; y1: number; x2: number; y2: number; color: string }
  | { t: "text"; x: number; y: number; text: string; font: FontSize; color: string; align: "left" | "center" | "right" }
  | { t: "dim"; color: string };

export type RegionId = "status" | "detail" | "keys" | "legend" | "overlay";

export interface Region {
  id: RegionId;
  rect: Rect;
  ops: DrawOp[];
}

export interface ScreenModel {
  regions: Region[];
}

export const REGION_RECT: Record<RegionId, Rect> = {
  status: { x: 0, y: 0, w: 240, h: 24 },
  detail: { x: 0, y: 24, w: 240, h: 112 },
  keys: { x: 0, y: 136, w: 240, h: 64 },
  legend: { x: 0, y: 200, w: 240, h: 40 },
  overlay: { x: 0, y: 0, w: 240, h: 240 },
};

// Firmware-owned wording (docs/ux-v2.md section 1.2), used in every protocol version.
const STATE_LABEL: Record<SlotState, string> = {
  empty: "EMPTY",
  disconnected: "OFFLINE",
  idle: "IDLE",
  working: "WORKING",
  waiting_input: "NEEDS ANSWER",
  approval_required: "NEEDS APPROVAL",
  completed_unread: "DONE, UNREAD",
  completed_read: "DONE",
  failed: "FAILED",
  unknown: "NO STATUS",
};

/** Provider chip text; "none" draws no chip at all. */
const PROVIDER_LABEL: Record<Provider, string> = { none: "", claude: "CLAUDE", codex: "CODEX", other: "OTHER" };

const VOICE_LABEL: Record<VoiceState, { text: string; color: string }> = {
  ready: { text: "READY", color: UI.text },
  recording: { text: "RECORDING", color: UI.bad },
  transcribing: { text: "TRANSCRIBING", color: UI.warn },
  reviewing: { text: "READY TO SEND", color: STATE_COLOR.working },
  submitting: { text: "SENDING", color: STATE_COLOR.working },
  delivered: { text: "DELIVERED", color: UI.ok },
  cancelled: { text: "CANCELLED", color: UI.dimText },
  failed: { text: "SEND FAILED", color: UI.bad },
  target_unavailable: { text: "TARGET GONE", color: UI.bad },
};

/** Toast colour per result, and the fallback text when the host sent none. */
const RESULT_LABEL: Record<CommandResultCode, { text: string; color: string }> = {
  accepted_locally: { text: "OK", color: UI.dimText },
  sent: { text: "Sent", color: UI.dimText },
  acknowledged: { text: "Received", color: UI.ok },
  completed: { text: "Done", color: UI.ok },
  failed: { text: "Failed", color: UI.bad },
  unsupported: { text: "Not supported", color: UI.warn },
  target_unavailable: { text: "Target gone", color: UI.bad },
};

export const HINT_BG = "#202020";
export const TAG_COLOR = "#808080";
/** A hint-line token that names a control is drawn white; other words grey. */
export const CONTROL_TOKEN = /^[A-Z0-9][A-Z0-9+/-]+$/;
const v2 = (s: DeviceState): boolean => s.link.proto >= 2;

/** Clips text to what fits in `width` pixels at `font`. */
export const fit = (text: string, width: number, font: FontSize): string =>
  text.slice(0, Math.max(0, Math.floor(width / FONT[font].w)));

const text = (
  x: number,
  y: number,
  value: string,
  font: FontSize,
  color: string,
  width: number,
  align: "left" | "center" | "right" = "left",
): DrawOp => ({ t: "text", x, y, text: fit(value, width, font), font, color, align });

/** Black text on light chips, white on dark ones. */
function textOn(hex: string): string {
  const v = Number.parseInt(hex.slice(1), 16);
  const luma = 0.299 * ((v >> 16) & 0xff) + 0.587 * ((v >> 8) & 0xff) + 0.114 * (v & 0xff);
  return luma > 140 ? "#000000" : "#FFFFFF";
}

/** Link indicator; "ok" is a 6x6 green square with no text. */
function linkIndicator(s: DeviceState): { text: string; color: string } {
  if (s.link.phase === "incompatible") return { text: "VERSION", color: UI.bad };
  if (s.link.phase !== "connected") return { text: "NO LINK", color: UI.bad };
  if (s.link.linkError) return { text: "NO REPLY", color: UI.bad };
  if (s.status.link === "backend_degraded") return { text: "LIMITED", color: UI.warn };
  if (s.status.link === "backend_down") return { text: "OFFLINE", color: UI.bad };
  return { text: "", color: UI.ok };
}

function statusRegion(s: DeviceState): DrawOp[] {
  const ops: DrawOp[] = [];
  const page = s.view.pages > 1 ? ` ${s.view.page + 1}/${s.view.pages}` : "";
  const right = s.status.attentionCount > 0 ? 210 : 236;
  const link = linkIndicator(s);
  const linkW = link.text === "" ? 6 : link.text.length * FONT.medium.w;
  // The title gets whatever the link indicator (up to "NO REPLY") leaves, at most 18 cells.
  ops.push(text(4, 4, `${s.view.title}${page}`, "medium", UI.text, Math.min(148, right - linkW - 8)));
  if (s.status.attentionCount > 0) {
    ops.push({ t: "fill", x: 214, y: 4, w: 22, h: 16, color: UI.badge });
    ops.push(text(225, 8, String(Math.min(s.status.attentionCount, 99)), "small", "#000000", 22, "center"));
  }
  if (link.text === "") ops.push({ t: "fill", x: right - 6, y: 9, w: 6, h: 6, color: "#20C060" });
  else ops.push(text(right, 4, link.text, "medium", link.color, 64, "right"));
  ops.push({ t: "line", x1: 0, y1: 23, x2: 239, y2: 23, color: UI.border });
  return ops;
}

/** Band 5: a toast replaces it for its time; otherwise the proto 2 hint bar (line 4) or, in v1, the status text. */
function footer(s: DeviceState, nowMs: number, hint: string | null): DrawOp[] {
  const r = s.lastResult;
  if (r && nowMs - r.atMs < RESULT_SHOW_MS) {
    const label = RESULT_LABEL[r.result];
    return [text(4, 122, r.text || label.text, "small", label.color, 232)];
  }
  if (hint !== null) return hintBar(hint);
  return [text(4, 122, s.status.text, "small", UI.dimText, 232)];
}

/** Hint bar (proto 2): #202020 band, control names white, other words grey, spaces keep their width. */
export function hintBar(line: string): DrawOp[] {
  const ops: DrawOp[] = [{ t: "fill", x: 0, y: 120, w: 240, h: 16, color: HINT_BG }];
  let col = 0;
  for (const part of line.split(/( +)/)) {
    if (part === "") continue;
    if (!part.startsWith(" ")) {
      ops.push(text(4 + col * FONT.small.w, 122, part, "small", CONTROL_TOKEN.test(part) ? UI.text : UI.dimText, 232 - col * FONT.small.w));
    }
    col += part.length;
  }
  return ops;
}

const SELECTED_NONE = "nothing selected";
const UNTITLED = "(untitled)";

function slotDetail(s: DeviceState): DrawOp[] {
  const chip = STATE_COLOR[s.detail.state];
  const sel = selectedKey(s);
  const label = sel >= 0 ? s.slots[sel]?.label || UNTITLED : SELECTED_NONE;
  const ops: DrawOp[] = [];
  const provider = PROVIDER_LABEL[s.detail.provider];
  if (provider) {
    ops.push({ t: "fill", x: 4, y: 28, w: 52, h: 14, color: UI.border });
    ops.push(text(30, 31, provider, "small", UI.text, 52, "center"));
  }
  const stateText = STATE_LABEL[s.detail.state];
  const chipW = Math.max(64, stateText.length * FONT.small.w + 8);
  ops.push(
    { t: "fill", x: 236 - chipW, y: 28, w: chipW, h: 14, color: chip },
    { t: "outline", x: 236 - chipW, y: 28, w: chipW, h: 14, color: EMPTY_OUTLINE, width: 1 },
    text(236 - chipW / 2, 31, stateText, "small", textOn(chip), chipW, "center"),
    text(4, 46, label, "large", UI.text, 232),
  );
  // v2: line 4 is the hint bar (band 5); v1: four plain lines.
  const lines = v2(s) ? s.detail.lines.slice(0, 3) : s.detail.lines;
  lines.forEach((line, i) => ops.push(text(4, 74 + i * 11, line, "small", UI.text, 232)));
  return ops;
}

function voiceDetail(s: DeviceState): DrawOp[] {
  const v = VOICE_LABEL[s.voice.voice];
  const level = Math.max(0, Math.min(100, s.voice.level));
  const live = s.voice.voice === "recording" || s.voice.voice === "transcribing";
  const ops: DrawOp[] = [text(4, 30, v.text, "large", v.color, 232)];
  if (!v2(s) || live) {
    ops.push(
      { t: "outline", x: 4, y: 60, w: 232, h: 12, color: UI.border, width: 1 },
      { t: "fill", x: 5, y: 61, w: Math.round((level / 100) * 230), h: 10, color: v.color },
      text(4, 80, `${(s.voice.elapsedDs / 10).toFixed(1)} s`, "medium", UI.text, 232),
    );
  } else {
    // v2 outside recording/transcribing: the transcript (or error) from SET_DETAIL lines 1-2.
    ops.push(text(4, 60, s.detail.lines[0], "medium", UI.text, 232), text(4, 80, s.detail.lines[1], "medium", "#C0C0C0", 232));
  }
  ops.push(text(4, 100, `to ${s.voice.target || "(no target)"}`, "medium", UI.text, 232));
  return ops;
}

export const CONFIRM_HINT = "SAVE yes   FX no";

function confirmDetail(s: DeviceState): DrawOp[] {
  const lines = v2(s) ? s.detail.lines : s.detail.lines.slice(0, 4);
  const ops: DrawOp[] = lines.map((line, i) => text(4, 28 + i * 18, line, "medium", i === 0 ? UI.warn : UI.text, 232));
  if (!v2(s)) ops.push(text(4, 102, CONFIRM_HINT, "medium", UI.warn, 232));
  return ops;
}

function detailRegion(s: DeviceState, nowMs: number): DrawOp[] {
  const view = s.view.view;
  const body = view === "voice" ? voiceDetail(s) : view === "confirm" ? confirmDetail(s) : slotDetail(s);
  const hint = !v2(s) ? null : view === "confirm" ? CONFIRM_HINT : s.detail.lines[3];
  return [...body, ...footer(s, nowMs, hint)];
}

/** Horizontal extent of key cell `k` (0..26) in the v1 chromatic strip, with a 1px gap on each side. */
export function keyCell(k: number): Rect {
  const x0 = Math.round((k * SCREEN) / KEY_COUNT);
  const x1 = Math.round(((k + 1) * SCREEN) / KEY_COUNT);
  return { x: x0 + 1, y: 140, w: x1 - x0 - 2, h: 56 };
}

const WHITE_KEYS = [0, 2, 4, 6, 7, 9, 11, 12, 14, 16, 18, 19, 21, 23, 24, 26];
const BLACK_KEYS = [1, 3, 5, 8, 10, 13, 15, 17, 20, 22, 25];
const BLACK_AFTER = [0, 1, 2, 4, 5, 7, 8, 9, 11, 12, 14];

export interface KeyBox {
  box: Rect;
  fill: Rect;
  black: boolean;
}

/** Keyboard-style strip (proto 2, docs/ux-v2.md section 2.4): 16 white keys below, 11 black keys above the gaps. */
export function keyBox(k: number): KeyBox {
  const w = WHITE_KEYS.indexOf(k);
  if (w >= 0) {
    const x = 8 + 14 * w;
    return { box: { x, y: 166, w: 14, h: 34 }, fill: { x: x + 1, y: 170, w: 12, h: 26 }, black: false };
  }
  const b = BLACK_KEYS.indexOf(k);
  if (b < 0) throw new RangeError(`key ${k} not in 0..26`);
  const c = 8 + 14 * ((BLACK_AFTER[b] ?? 0) + 1);
  return { box: { x: c - 6, y: 136, w: 12, h: 30 }, fill: { x: c - 5, y: 140, w: 10, h: 24 }, black: true };
}

/** Light fills get a black pinned bar, dark ones a white bar. */
const darkOn = (hex: string): boolean => textOn(hex) === "#000000";

function keysRegion(s: DeviceState): DrawOp[] {
  return v2(s) ? keyboardStrip(s) : chromaticStrip(s);
}

function chromaticStrip(s: DeviceState): DrawOp[] {
  const ops: DrawOp[] = [];
  s.slots.forEach((slot, k) => {
    const c = keyCell(k);
    ops.push({ t: "fill", ...c, color: STATE_COLOR[slot.state] });
    if (slot.state === "empty") ops.push({ t: "outline", ...c, color: EMPTY_OUTLINE, width: 1 });
    if (slot.flags.stale) {
      ops.push({ t: "line", x1: c.x, y1: c.y, x2: c.x + c.w - 1, y2: c.y + c.h - 1, color: UI.stale });
      ops.push({ t: "line", x1: c.x + c.w - 1, y1: c.y, x2: c.x, y2: c.y + c.h - 1, color: UI.stale });
    }
    if (slot.flags.selected) ops.push({ t: "outline", ...c, color: UI.selected, width: 2 });
  });
  return ops;
}

function keyboardStrip(s: DeviceState): DrawOp[] {
  const ops: DrawOp[] = [];
  s.slots.forEach((slot, k) => {
    const { box, fill } = keyBox(k);
    const color = STATE_COLOR[slot.state];
    ops.push({ t: "fill", ...box, color: "#000000" });
    const f = slot.flags.selected ? { x: fill.x + 1, y: fill.y, w: fill.w - 2, h: fill.h } : fill;
    ops.push({ t: "fill", ...f, color });
    if (slot.state === "empty") ops.push({ t: "outline", ...fill, color: EMPTY_OUTLINE, width: 1 });
    if (slot.flags.pinned) ops.push({ t: "fill", x: f.x, y: f.y, w: f.w, h: 4, color: darkOn(color) ? "#000000" : "#FFFFFF" });
    if (slot.flags.stale) {
      ops.push({ t: "line", x1: fill.x, y1: fill.y, x2: fill.x + fill.w - 1, y2: fill.y + fill.h - 1, color: UI.stale });
      ops.push({ t: "line", x1: fill.x + fill.w - 1, y1: fill.y, x2: fill.x, y2: fill.y + fill.h - 1, color: UI.stale });
    }
    if (slot.flags.selected) ops.push({ t: "outline", x: box.x, y: box.y + 2, w: box.w, h: box.h - 4, color: UI.selected, width: 2 });
  });
  return ops;
}

function legendRegion(s: DeviceState): DrawOp[] {
  if (!v2(s)) {
    return s.legend.flatMap((label, i): DrawOp[] => [
      { t: "outline", x: i * 60 + 1, y: 201, w: 58, h: 38, color: UI.border, width: 1 },
      text(i * 60 + 30, 212, label, "medium", UI.text, 56, "center"),
    ]);
  }
  // v2: knobs only; a non-empty cell shows its KNOBn tag above the label, an empty cell only the separator.
  return s.legend.flatMap((label, i): DrawOp[] => {
    const ops: DrawOp[] = [{ t: "outline", x: i * 60 + 1, y: 201, w: 58, h: 38, color: UI.border, width: 1 }];
    if (label === "") return ops;
    ops.push(text(i * 60 + 30, 204, `KNOB${i + 1}`, "small", TAG_COLOR, 56, "center"));
    ops.push(text(i * 60 + 30, 220, label, "medium", UI.text, 56, "center"));
    return ops;
  });
}

export const NO_HOST_TITLE = "NO COMPANION";
export const NO_HOST_HINT = "start fm1-console on Mac";

function overlayRegion(s: DeviceState): DrawOp[] | null {
  if (s.link.phase === "connected") return null;
  const incompatible = s.link.phase === "incompatible";
  return [
    { t: "dim", color: UI.dim },
    { t: "fill", x: 0, y: 96, w: 240, h: 48, color: UI.bannerBg },
    text(120, 102, incompatible ? s.link.incompatible : NO_HOST_TITLE, "large", UI.text, 236, "center"),
    text(120, 130, incompatible ? "no common version" : NO_HOST_HINT, "small", UI.text, 236, "center"),
  ];
}

// DETAILS page (protocol version 3, docs/ux-v2.md section 7.4): 12 FONT_S rows at y = 24 + 16n, then the hint band.
export const DETAIL_HINT = "PRESETS page  LFO close";
export const TEXT_COLOR: Record<TextStyle, string> = { body: "#FFFFFF", heading: "#FFB000", muted: "#A0A0A0" };
const DETAIL_HINT_Y = 216;

function textRows(s: DeviceState, from: number, to: number): DrawOp[] {
  const ops: DrawOp[] = [];
  for (let n = from; n < to; n++) {
    const row = s.text[n];
    // (version 7 control bytes, docs/ui-v3.md section 13: this SVG layout draws the plain row, a rule as a space)
    if (row && row.text) ops.push(text(4, 24 + 16 * n, row.text.replace(/[\x01-\x03]/g, "").replace(/\x04/g, " "), "medium", TEXT_COLOR[row.style], 232));
  }
  return ops;
}

/** Rows 216-239: the fixed hint (control names white), or the toast in its place. */
function detailFooter(s: DeviceState, nowMs: number): DrawOp[] {
  const r = s.lastResult;
  const ops: DrawOp[] = [{ t: "fill", x: 0, y: DETAIL_HINT_Y, w: 240, h: 24, color: HINT_BG }];
  if (r && nowMs - r.atMs < RESULT_SHOW_MS) {
    const label = RESULT_LABEL[r.result];
    return [...ops, text(4, DETAIL_HINT_Y + 4, r.text || label.text, "medium", label.color, 232)];
  }
  let col = 0;
  for (const part of DETAIL_HINT.split(/( +)/)) {
    if (part && !part.startsWith(" ")) ops.push(text(4 + col * FONT.medium.w, DETAIL_HINT_Y + 4, part, "medium", CONTROL_TOKEN.test(part) ? UI.text : UI.dimText, 232 - col * FONT.medium.w));
    col += part.length;
  }
  return ops;
}

/** The DETAILS page split over the fixed regions: rows 0-6 (detail), 7-10 (keys), 11 and the hint band (legend). */
function detailPage(state: DeviceState, nowMs: number): Region[] {
  return [
    { id: "status", rect: REGION_RECT.status, ops: statusRegion(state) },
    { id: "detail", rect: REGION_RECT.detail, ops: textRows(state, 0, 7) },
    { id: "keys", rect: REGION_RECT.keys, ops: textRows(state, 7, 11) },
    { id: "legend", rect: REGION_RECT.legend, ops: [...textRows(state, 11, 12), ...detailFooter(state, nowMs)] },
  ];
}

/** Lays out the whole screen for `state` at device time `nowMs`. */
export function layoutScreen(state: DeviceState, nowMs: number): ScreenModel {
  const regions: Region[] = state.view.view === "detail" && state.link.proto >= 3 ? detailPage(state, nowMs) : [
    { id: "status", rect: REGION_RECT.status, ops: statusRegion(state) },
    { id: "detail", rect: REGION_RECT.detail, ops: detailRegion(state, nowMs) },
    { id: "keys", rect: REGION_RECT.keys, ops: keysRegion(state) },
    { id: "legend", rect: REGION_RECT.legend, ops: legendRegion(state) },
  ];
  const overlay = overlayRegion(state);
  if (overlay) regions.push({ id: "overlay", rect: REGION_RECT.overlay, ops: overlay });
  return { regions };
}

const sig = (r: Region | undefined): string => (r ? JSON.stringify(r.ops) : "");

/** Regions whose drawing differs between two models; only these need a redraw. */
export function changedRegions(prev: ScreenModel | null, next: ScreenModel): RegionId[] {
  const ids: RegionId[] = ["status", "detail", "keys", "legend", "overlay"];
  return ids.filter((id) => {
    const a = prev?.regions.find((r) => r.id === id);
    const b = next.regions.find((r) => r.id === id);
    return prev === null ? b !== undefined : sig(a) !== sig(b);
  });
}
