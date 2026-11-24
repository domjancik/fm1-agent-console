// The protocol version 4 screen (docs/ui-v3.md section 3.A, "Buddy and bubble"), drawn pixel by pixel into an RGB565
// framebuffer with the firmware's fonts and sprites. Geometry and colours follow the A mocks
// (reports/evidence/ui-v3/scripts/mocks.py); the firmware draws the same boxes. Pure and browser-safe.
import type { CommandResultCode, Provider, SlotState, TextStyle } from "@fm1/device-protocol";
import { KEY_COUNT, selectedKey, type DeviceState, type Slot } from "../state";
import { ANIM_PHASE_MS, animFrame, FONT_L, FONT_S, Framebuffer, rgb565, SPRITES, spritePalette, textWidth, type Pose, type Rgb, type Species } from "./raster";

export const RESULT_SHOW_MS = 2000;

/** Transitions (docs/ui-v3.md section 9.10) redraw rows and keys without the selection highlight. Set by renderV4. */
let noHighlight = false;

// Colours (RGB, quantised to RGB565 when drawn), as docs/firmware-ui.md and the mocks use them.
const C = {
  white: [255, 255, 255],
  black: [0, 0, 0],
  grey: [128, 128, 128],
  text2: [192, 192, 192],
  hint: [160, 160, 160],
  hintBg: [32, 32, 32],
  outline: [48, 48, 48],
  amber: [255, 176, 0],
  green: [32, 192, 96],
  red: [240, 48, 48],
  blue: [47, 125, 246],
  calm: [150, 150, 150],
  bannerBg: [16, 16, 16],
  knobLit: [70, 70, 70],
  darkRed: [90, 20, 20],
  blackKeyDash: [32, 32, 32],
} as const satisfies Record<string, Rgb>;

const SLOT_RGB: Record<SlotState, Rgb> = {
  empty: [0, 0, 0],
  disconnected: [32, 32, 32],
  idle: [96, 96, 96],
  working: C.blue,
  waiting_input: [160, 80, 240],
  approval_required: C.amber,
  completed_unread: C.green,
  completed_read: [42, 90, 58],
  failed: C.red,
  unknown: [64, 64, 64],
};
const CALM: ReadonlySet<SlotState> = new Set<SlotState>(["idle", "unknown", "disconnected", "completed_read", "empty"]);

const STYLE_RGB: Record<TextStyle, Rgb> = { body: C.white, heading: C.amber, muted: C.hint };

/** The toast bar: fm1c_draw.h FM1C_RESULT_NAME / FM1C_RESULT_RGB (the bar is filled with the colour). */
const RESULT_RGB: Record<CommandResultCode, { text: string; color: Rgb }> = {
  accepted_locally: { text: "OK", color: C.grey },
  sent: { text: "Sent", color: C.blue },
  acknowledged: { text: "Received", color: C.blue },
  completed: { text: "Done", color: C.green },
  failed: { text: "Failed", color: C.red },
  unsupported: { text: "Not supported", color: C.amber },
  target_unavailable: { text: "Target gone", color: C.red },
};
/** fm1c_dark: white text on a dark bar, black on a light one (on the RGB565 value). */
const darkBar = (c: number): boolean => (c >> 11) * 2 + ((c >> 5) & 63) + (c & 31) * 2 < 140;

/** The physical key of each slot (docs/firmware-controls.md, fm1c_sprites.h FM1C_NOTE). */
export const NOTE = ["F3", "F#3", "G3", "G#3", "A3", "A#3", "B3", "C4", "C#4", "D4", "D#4", "E4", "F4", "F#4", "G4", "G#4", "A4", "A#4", "B4", "C5", "C#5", "D5", "D#5", "E5", "F5", "F#5", "G5"];

const WHITE_KEYS = [0, 2, 4, 6, 7, 9, 11, 12, 14, 16, 18, 19, 21, 23, 24, 26];
const BLACK_KEYS = [1, 3, 5, 8, 10, 13, 15, 17, 20, 22, 25];
const BLACK_AFTER = [0, 1, 2, 4, 5, 7, 8, 9, 11, 12, 14];

/** docs/ui-v3.md section 3.A bands. */
export const V4 = {
  topH: 18,
  hero: { x: 4, y: 20, size: 48 },
  labelX: 60,
  bubble: { x: 2, y: 74, w: 236, h: 108, tailX: 22 },
  captionY: 78,
  bodyY: 96,
  keyboardY: 184,
  hintY: 224,
  detailBodyY: 72,
} as const;

export const DETAIL_HINT4 = "PRESETS older  LFO close";
export const CONFIRM_HINT4 = "SAVE yes   FX no";
export const HELP_CLOSE = "let go of SCL to close";
export const NO_HOST_TITLE4 = "NO COMPANION";
export const NO_HOST_HINT4 = "start fm1-console on Mac";

/**
 * The device-local help tables of version 4 (fm1c_help.h; equal to agent-core HELP_TEXT, checked by a test). The base
 * help is followed by two knob lines built from SET_LEGEND (helpKnobLines4), as fm1c_draw4.h fm1c_v4_help_into does.
 */
export const HELP4 = {
  base: [
    "HELP - let go of SCL",
    "SELECT move  PRESETS scroll",
    "key tap select  2x open",
    "LFO details  ALGORITHM next",
    "SAVE approve  FX deny",
    "REC hold to talk  ENV stop",
  ],
  /** Version 5 (docs/ui-v3.md section 9.11, fm1c_help.h FM1C_HELP_BASE5): the SEQ cycle first, PRESETS read, pins. */
  base5: [
    "HELP - SEQ buddy/list/group",
    "SELECT move  PRESETS read",
    "key tap sel 2x open hold pin",
    "LFO details  ALGORITHM next",
    "SAVE approve  FX deny",
    "REC hold to talk  ENV stop",
  ],
  /** Version 6 (docs/ui-v3.md section 10.11, fm1c_help.h FM1C_HELP_BASE6 / SPLIT6 / SETTINGS6). */
  base6: [
    "HELP - SEQ view  ARP settings",
    "SELECT move  PRESETS read",
    "key tap sel 2x open hold pin",
    "LFO details  ALGORITHM next",
    "SAVE approve  FX deny",
    "REC hold to talk  ENV stop",
  ],
  split6: [
    "HELP - SEQ view  ARP settings",
    "white sel 2x open hold pin",
    "black filter/task hold pin",
    "OCT page/2x task  REC talk",
    "SELECT move  PRESETS read",
    "LFO details  ALGORITHM next",
  ],
  settings6: ["HELP - let go of SCL", "SELECT    move", "SAVE      change", "HOME/LFO/ARP  close"],
  detail: [
    "HELP - let go of SCL",
    "PRESETS   older/newer page",
    "OCT-/OCT+ next/prev page",
    "SELECT    next/prev chat",
    "ALGORITHM next needing you",
    "key tap   show that chat",
    "LFO/HOME  close details",
    "SAVE approve  FX deny",
    "ENV stop  PLAY open on Mac",
    "REC hold to talk",
  ],
  voice: [
    "HELP - let go of SCL",
    "REC hold    record",
    "REC let go  stop, transcribe",
    "SAVE        send",
    "FX          cancel",
    "PLAY        retry after fail",
    "PRESETS     scroll text",
  ],
  confirm: ["HELP - let go of SCL", "SAVE  yes, do it", "FX    no, go back", "Nothing else acts here."],
  words: ["Working", "Needs answer", "Approve?", "Failed", "Done, unread", "Asleep", "No status", "Offline"],
  wordStates: ["working", "waiting_input", "approval_required", "failed", "completed_unread", "idle", "unknown", "disconnected"] as SlotState[],
} as const;

const c565 = (c: Rgb): number => rgb565(c);

/**
 * Protocol version 7 highlights (docs/ui-v3.md section 13.5): bold in the accent (white in a heading row), code in the
 * code colour, table rules grey. Exported for the parity tests.
 */
export const RICH_RGB = { bold: C.amber, boldInHeading: C.white, code: [128, 208, 255] as Rgb, rule: C.grey } as const;

/** One SET_TEXT row in its style colour (or `color`), with any version 7 control bytes drawn, cut at `maxCols`. */
function textRow(fb: Framebuffer, x: number, y: number, row: { style: TextStyle; text: string }, color?: Rgb, maxCols?: number): number {
  const base = color ?? STYLE_RGB[row.style];
  const bold = row.style === "heading" ? RICH_RGB.boldInHeading : RICH_RGB.bold;
  return fb.richText(x, y, row.text, c565(base), { bold: c565(bold), code: c565(RICH_RGB.code), rule: c565(RICH_RGB.rule) }, maxCols);
}
const scaleRgb = (c: Rgb, f: number): Rgb => [Math.floor(c[0] * f), Math.floor(c[1] * f), Math.floor(c[2] * f)];

/** True when the screen draws the version 4 layout (agreed v4, or no host on a v4 firmware). */
export function usesV4(s: DeviceState): boolean {
  return s.link.phase === "connected" ? s.link.proto >= 4 : s.local.maxProto >= 4;
}

/** The 14x14 mini box of key `k` (docs/ui-v3.md section 3.A; fm1c_key_box with version 4). */
export function keyBox4(k: number): { x: number; y: number; w: number; h: number } {
  const w = WHITE_KEYS.indexOf(k);
  if (w >= 0) return { x: 8 + 14 * w, y: V4.keyboardY + 18, w: 14, h: 14 };
  const b = BLACK_KEYS.indexOf(k);
  if (b < 0) throw new RangeError(`key ${k} not in 0..26`);
  return { x: 8 + 14 * ((BLACK_AFTER[b] ?? 0) + 1) - 7, y: V4.keyboardY, w: 14, h: 14 };
}

const species = (p: Provider): Species => (p === "codex" ? "codex" : "claude");
const poseOf = (state: SlotState): Pose | null => (state === "empty" ? null : (SPRITES.poseOfState[state] ?? "huh"));

/** Draws the 24x24 hero of `state` 2x (48x48; the List header: 1x) at (x, y), animated from device time. */
export function drawHero(fb: Framebuffer, x: number, y: number, state: SlotState, provider: Provider, nowMs: number, scale = 2): void {
  const pose = poseOf(state);
  if (!pose) return;
  const frames = SPRITES.hero[pose][species(provider)];
  const f = frames[animFrame(pose, "hero", nowMs) % Math.max(1, frames.length)];
  if (f) fb.sprite(x, y, f, 24, spritePalette(state), scale);
}

/** Draws the 12x12 mini of `state` at (x, y); calm poses stay still. */
export function drawMini(fb: Framebuffer, x: number, y: number, state: SlotState, sp: Species, nowMs: number, still = false): void {
  const pose = poseOf(state);
  if (!pose) return;
  const frames = SPRITES.mini[pose][sp];
  const f = frames[still ? 0 : animFrame(pose, "mini", nowMs) % Math.max(1, frames.length)];
  if (f) fb.sprite(x, y, f, 12, spritePalette(state), 1);
}

/**
 * fm1c_draw_status_in: the title (the backend's trouble text first, in amber; no title: the status text, else the app
 * name), the page, the link dot or words, the attention badge. Drawn before the dim, so it dims with the screen.
 */
function topBar(fb: Framebuffer, s: DeviceState, noPage = false): void {
  const link = linkIndicator(s);
  let title = s.view.title;
  let tc: Rgb = C.white;
  if (s.status.link !== "ok" && s.status.text) {
    title = s.status.text;
    tc = C.amber;
  } else if (!title) title = s.status.text || "FM1 CONSOLE";
  fb.rect(0, 0, 240, V4.topH, c565(C.black));
  fb.text(4, 1, title, c565(tc));
  let x = 236;
  const n = Math.min(99, s.status.attentionCount);
  if (n > 0 && s.link.phase === "connected") {
    const badge = String(n);
    const w = textWidth(badge) + 8;
    x -= w;
    fb.rect(x, 1, w, 16, c565(C.amber));
    fb.text(x + 4, 1, badge, c565(isDark(C.amber) ? C.white : C.black));
    x -= 6;
  }
  if (link === null) {
    x -= 6;
    fb.rect(x, 6, 6, 6, c565(C.green));
  } else {
    x -= textWidth(link.text);
    fb.text(x, 1, link.text, c565(link.color));
  }
  const page = !noPage && s.view.pages > 1 && s.link.phase === "connected" ? `${s.view.page + 1}/${s.view.pages}` : "";
  if (page) {
    x -= 8 + textWidth(page);
    fb.text(x, 1, page, c565(C.grey));
  }
  fb.rect(0, V4.topH - 1, 240, 1, c565(C.outline));
}

function linkIndicator(s: DeviceState): { text: string; color: Rgb } | null {
  if (s.link.phase === "incompatible") return { text: "VERSION", color: C.red };
  if (s.link.phase !== "connected") return { text: "NO LINK", color: C.red };
  if (s.link.linkError) return { text: "NO REPLY", color: C.red };
  if (s.status.link === "backend_degraded") return { text: "LIMITED", color: C.amber };
  if (s.status.link === "backend_down") return { text: "OFFLINE", color: C.red };
  return null;
}

/** fm1c_draw.h fm1c_dark: a chip colour dark enough for white text (amber is, by this rule). */
function isDark(c: Rgb): boolean {
  const v = c565(c);
  return (v >> 11) * 2 + ((v >> 5) & 63) + (v & 31) * 2 < 140;
}

/** A control-name token (white in the hint bar): 2+ capitals, digits, `+`, `/`, `-`. */
const isControl = (tok: string): boolean => tok.length >= 2 && /^[A-Z0-9+/-]+$/.test(tok);

export { frame80, captionColor };

export function hintBar(fb: Framebuffer, y: number, line: string): void {
  fb.rect(0, y, 240, 16, c565(C.hintBg));
  let x = 4;
  line.split(" ").forEach((tok, i) => {
    if (i) x += 8;
    if (tok) x = fb.text(x, y, tok, c565(isControl(tok) ? C.white : C.hint));
  });
}

/** The knob row for 2 s after a knob turn: 4 cells (ring glyph, number, label), the turned one lit. */
function knobRow(fb: Framebuffer, s: DeviceState): void {
  const y = V4.hintY;
  fb.rect(0, y, 240, 16, c565(C.hintBg));
  s.legend.forEach((label, i) => {
    const x = i * 60;
    const on = i === s.local.knobLit;
    if (on) fb.rect(x, y, 60, 16, c565(C.knobLit));
    if (i) fb.rect(x, y, 1, 16, c565(C.outline));
    if (!label) return;
    const g = c565(C.grey);
    fb.rect(x + 5, y + 4, 6, 1, g);
    fb.rect(x + 5, y + 11, 6, 1, g);
    fb.rect(x + 4, y + 5, 1, 6, g);
    fb.rect(x + 11, y + 5, 1, 6, g);
    fb.rect(x + 7, y + 5, 2, 3, c565(C.white));
    fb.text(x + 14, y, String(i + 1), c565(on ? C.white : C.grey));
    fb.text(x + 23, y, label, c565(on ? C.white : C.hint));
  });
}

/** Rows 224-239: the toast for 2 s, else the knob row for 2 s after a turn, else the hint line. */
function footer(fb: Framebuffer, s: DeviceState, nowMs: number, hint: string, knobs: boolean): void {
  const r = s.lastResult;
  if (r && nowMs - r.atMs < RESULT_SHOW_MS) {
    // fm1c_toast_in(m, 16, 0): the bar filled with the result colour, the text in black or white on it.
    const label = RESULT_RGB[r.result];
    const bg = c565(label.color);
    fb.rect(0, V4.hintY, 240, 16, bg);
    fb.text(4, V4.hintY, r.text || label.text, c565(darkBar(bg) ? C.white : C.black));
    return;
  }
  if (knobs && s.local.knobLit >= 0 && nowMs < s.local.knobUntilMs) return knobRow(fb, s);
  hintBar(fb, V4.hintY, hint);
}

/** The bubble frame with its tail pointing up at the hero (docs/ui-v3.md section 3.A). */
function bubble(fb: Framebuffer, border: number, tailX: number | null = V4.bubble.tailX, h: number = V4.bubble.h): void {
  const { x, y, w } = V4.bubble;
  const black = c565(C.black);
  fb.rframe(x, y, w, h, border, black);
  if (tailX === null) return;
  // the tail as fm1c_v4_bubble_into draws it: a left edge and one diagonal, up at the speaker, open into the bubble
  for (let i = 0; i < 5; i++) {
    fb.rect(tailX, y - 5 + i, 1, 1, border);
    fb.rect(tailX + 1 + i, y - 5 + i, 1, 1, border);
  }
  fb.rect(tailX + 1, y, 5, 1, black);
}

/** The "more below" wedge on the bubble's bottom edge. */
function wedge(fb: Framebuffer, dy = 0): void {
  for (let i = 0; i < 4; i++) fb.rect(224 + i, 178 + dy + i, 7 - 2 * i, 1, c565(C.white));
}

/** The label beside the hero: FONT_L when it fits 176 px, else FONT_S; line 1 below it. */
function heroLabel(fb: Framebuffer, label: string, line1: string, labelColor: Rgb = C.white): void {
  if (label) {
    if (textWidth(label, FONT_L) <= 176) fb.text(V4.labelX, 18, label, c565(labelColor), FONT_L);
    else fb.text(V4.labelX, 26, label, c565(labelColor));
  }
  if (line1) fb.text(V4.labelX, 50, line1, c565(C.text2));
}

function keyboard(fb: Framebuffer, s: DeviceState, nowMs: number): void {
  fb.rect(0, V4.keyboardY - 2, 240, 40, c565(C.black));
  // Voice and confirm over SPLIT Sessions (docs/ui-v3.md section 10.7): the black keys as compact colour boxes.
  const split = usesSplit(s);
  for (let k = 0; k < KEY_COUNT; k++) {
    if (split && BLACK_KEYS.includes(k)) drawCompactBlack(fb, k, s.slots[k]);
    else drawKey(fb, k, s.slots[k], nowMs);
  }
}

/** One 14x14 key box: the mini (ghost when stale), the selection frame and tick, the pin dot; an empty key a dash. */
export function drawKey(fb: Framebuffer, k: number, slot: Slot | undefined, nowMs: number): void {
  const { x, y } = keyBox4(k);
  const white = WHITE_KEYS.includes(k);
  fb.rect(x, y, 14, 16, c565(C.black));
  if (!slot || slot.state === "empty") {
    fb.rect(x + 5, y + 6, 4, 2, c565(white ? C.outline : C.blackKeyDash));
    if (slot?.flags.selected) fb.frame(x, y, 14, 14, 1, c565(C.white));
    return;
  }
  const sp: Species = slot.flags.codex ? "codex" : "claude";
  drawMini(fb, x + 1, y + 1, slot.flags.stale ? "disconnected" : slot.state, sp, nowMs);
  if (slot.flags.pinned) fb.rect(x + 12, y, 2, 2, c565(C.white));
  if (slot.flags.selected && !noHighlight) fb.frame(x, y, 14, 14, 1, c565(C.white));
}

/**
 * The hero squashed to 18 of its 24 rows (docs/ui-v3.md section 9.10, hero pop step 1): destination row d shows source
 * row floor(d * 4 / 3), bottom-aligned in the 24-row box, `scale` times.
 */
export function drawHeroSquash(fb: Framebuffer, x: number, y: number, state: SlotState, provider: Provider, nowMs: number, scale = 2): void {
  const pose = poseOf(state);
  if (!pose) return;
  const frames = SPRITES.hero[pose][species(provider)];
  const f = frames[animFrame(pose, "hero", nowMs) % Math.max(1, frames.length)];
  if (!f) return;
  const pal = spritePalette(state);
  for (let d = 0; d < 18; d++) {
    const sy = Math.floor((d * 4) / 3);
    for (let sx = 0; sx < 24; sx++) {
      const byte = f[(sy * 24 + sx) >> 1] ?? 0;
      const v = sx & 1 ? byte & 15 : byte >> 4;
      if (v) fb.rect(x + sx * scale, y + (6 + d) * scale, scale, scale, pal[v] ?? 0);
    }
  }
}

const captionColor = (st: SlotState): Rgb => (CALM.has(st) ? C.calm : SLOT_RGB[st]);

/** fm1c_v4_80: 80 % of a colour, per RGB565 channel (the bubble's frame). */
function frame80(c: Rgb): number {
  const v = c565(c);
  return ((Math.floor(((v >> 11) * 4) / 5)) << 11) | (Math.floor((((v >> 5) & 63) * 4) / 5) << 5) | Math.floor(((v & 31) * 4) / 5);
}

/** Sessions, tasks and TO DO: hero, label, the bubble (SET_TEXT rows 0-6), the critter keyboard, the hint bar. */
function baseScreen(fb: Framebuffer, s: DeviceState, nowMs: number): void {
  if (usesSplit(s)) return splitBuddy(fb, s, nowMs);
  const sel = selectedKey(s);
  const slot = sel >= 0 ? s.slots[sel] : undefined;
  const st = s.detail.state;
  topBar(fb, s);
  // fm1c_draw4_hero / fm1c_draw4_label: the hero is SET_DETAIL's state (never the ghost); no label: a grey placeholder
  drawHero(fb, V4.hero.x, V4.hero.y, st, s.detail.provider, nowMs);
  if (slot?.label) heroLabel(fb, slot.label, s.detail.lines[0]);
  else {
    fb.text(V4.labelX, 26, sel >= 0 ? "(untitled)" : "nothing selected", c565(C.grey));
    heroLabel(fb, "", s.detail.lines[0]);
  }
  const col = captionColor(st);
  bubble(fb, frame80(col));
  const cap = s.text[0];
  if (cap?.text) textRow(fb, 8, V4.captionY, cap, col);
  keyName(fb, sel);
  bodyRows(fb, s);
  if (s.text[6]?.text) wedge(fb);
  keyboard(fb, s, nowMs);
  footer(fb, s, nowMs, s.detail.lines[3], true);
}

/** fm1c_draw.h FM1C_VOICE_NAME / FM1C_VOICE_RGB. */
const VOICE_WORD: Record<string, { text: string; color: Rgb }> = {
  ready: { text: "READY", color: C.text2 },
  recording: { text: "RECORDING", color: C.red },
  transcribing: { text: "TRANSCRIBING", color: C.blue },
  reviewing: { text: "READY TO SEND", color: C.amber },
  submitting: { text: "SENDING", color: C.blue },
  delivered: { text: "DELIVERED", color: C.green },
  cancelled: { text: "CANCELLED", color: C.grey },
  failed: { text: "SEND FAILED", color: C.red },
  target_unavailable: { text: "TARGET GONE", color: C.red },
};

/** The bubble's rows 1-5 (x 8, y 96 + 16 n), in the row styles. */
function bodyRows(fb: Framebuffer, s: DeviceState): void {
  for (let i = 0; i < 5; i++) {
    const row = s.text[1 + i];
    if (row?.text) textRow(fb, 8, V4.bodyY + 16 * i, row);
  }
}

/** The physical key of the selected chat, right-aligned on the caption row. */
function keyName(fb: Framebuffer, sel: number): void {
  if (sel < 0) return;
  const note = NOTE[sel] ?? "";
  fb.text(232 - textWidth(note), V4.captionY, note, c565(C.grey));
}

/**
 * Voice (fm1c_draw4.h): the operator's own bubble (tail at x 206) in the voice state's colour; the REC dot and the
 * state's words on the caption row, the elapsed time right-aligned; recording or transcribing: the 28-bar meter over
 * the body rows; else rows 1-5 (the transcript or the error). No "more" wedge in voice.
 */
function voiceScreen(fb: Framebuffer, s: DeviceState, nowMs: number): void {
  const sel = selectedKey(s);
  const slot = sel >= 0 ? s.slots[sel] : undefined;
  topBar(fb, s);
  drawHero(fb, V4.hero.x, V4.hero.y, s.detail.state, s.detail.provider, nowMs);
  if (slot?.label) heroLabel(fb, slot.label, "");
  else fb.text(V4.labelX, 26, sel >= 0 ? "(untitled)" : "nothing selected", c565(C.grey));
  const tx = fb.text(V4.labelX, 50, "to ", c565(C.grey));
  fb.text(tx, 50, s.voice.target || "(no target)", c565(s.voice.target ? C.white : C.grey));
  const v = s.voice.voice;
  const word = VOICE_WORD[v] ?? { text: "SEND FAILED", color: C.red };
  bubble(fb, frame80(word.color), 206);
  const rec = v === "recording";
  if (rec) fb.rect(10, 84, 8, 8, c565(Math.floor((nowMs + ANIM_PHASE_MS) / 500) % 2 === 0 ? C.red : C.darkRed));
  fb.text(rec ? 24 : 8, V4.captionY, word.text, c565(word.color));
  const secs = `${Math.floor(s.voice.elapsedDs / 10)}.${s.voice.elapsedDs % 10} s`;
  fb.text(232 - textWidth(secs), V4.captionY, secs, c565(C.white));
  if (rec || v === "transcribing") {
    for (let i = 0; i < 28; i++) {
      const lv = s.voice.bars[i] ?? 0;
      const x = 8 + 8 * i;
      if (rec && i === s.voice.barN) continue; // the gap ahead of the newest bar
      if (!lv) {
        fb.rect(x + 2, V4.bodyY + 39, 5, 2, c565(C.outline));
        continue;
      }
      const h = 4 + Math.floor((lv * 72) / 100);
      const col = !rec ? C.grey : lv < 70 ? C.green : lv < 90 ? C.amber : C.red;
      fb.rect(x + 2, V4.bodyY + 40 - Math.trunc(h / 2), 5, h, c565(col));
    }
  } else bodyRows(fb, s);
  keyboard(fb, s, nowMs);
  footer(fb, s, nowMs, s.detail.lines[3], true);
}

/**
 * Confirm (fm1c_draw4.h): the verb (line 1) as the label beside the target's hero and the selected chat's label under
 * it; an amber bubble with "Please confirm" and the key name, lines 2-4 as body rows 1-3; the fixed hint.
 */
function confirmScreen(fb: Framebuffer, s: DeviceState, nowMs: number): void {
  const sel = selectedKey(s);
  topBar(fb, s);
  drawHero(fb, V4.hero.x, V4.hero.y, s.detail.state, s.detail.provider, nowMs);
  heroLabel(fb, s.detail.lines[0], "");
  const label = sel >= 0 ? (s.slots[sel]?.label ?? "") : "";
  if (label) fb.text(V4.labelX, 50, label, c565(C.text2));
  bubble(fb, frame80(C.amber));
  fb.text(8, V4.captionY, "Please confirm", c565(C.amber));
  keyName(fb, sel);
  s.detail.lines.slice(1).forEach((line, i) => {
    if (line) fb.text(8, V4.bodyY + 16 * i, line, c565(C.white));
  });
  keyboard(fb, s, nowMs);
  footer(fb, s, nowMs, CONFIRM_HINT4, true);
}

/** DETAILS: the 48 px hero header (rows 0-2 at x 60), 9 body rows from y 72, the fixed hint at the bottom. */
function detailScreen(fb: Framebuffer, s: DeviceState, nowMs: number): void {
  topBar(fb, s);
  drawHero(fb, V4.hero.x, V4.hero.y, s.detail.state, s.detail.provider, nowMs);
  for (let n = 0; n < 3; n++) {
    const row = s.text[n];
    if (!row?.text) continue;
    const col = n === 0 ? captionColor(s.detail.state) : STYLE_RGB[row.style];
    textRow(fb, V4.labelX, 20 + 16 * n, row, col);
  }
  for (let n = 3; n < 12; n++) {
    const row = s.text[n];
    if (row?.text) textRow(fb, 4, V4.detailBodyY + 16 * (n - 3), row);
  }
  footer(fb, s, nowMs, DETAIL_HINT4, true);
}

/** `KNOB1 SHOW  KNOB2 REPO`, `KNOB3 TASK  KNOB4 TALK` from the held legend; `-` for a knob with no label. */
export function helpKnobLines4(legend: readonly string[]): [string, string] {
  const cell = (k: number): string => `KNOB${k + 1} ${legend[k] ? legend[k] : "-"}`;
  return [`${cell(0)}  ${cell(1)}`, `${cell(2)}  ${cell(3)}`];
}

/** SCL held: the help lines of the view, a rule, and the "who is who" grid of the 8 characters. */
function helpScreen(fb: Framebuffer, s: DeviceState, nowMs: number): void {
  const view = s.view.view;
  const base = view !== "detail" && view !== "voice" && view !== "confirm" && view !== "settings";
  // Version 6 (docs/ui-v3.md section 10.11): SETTINGS6 in view 6, SPLIT6 in view 0 with keys 1, else BASE6.
  const baseLines = s.link.proto >= 6 ? (view === "sessions" && s.view.keys === "split" ? HELP4.split6 : HELP4.base6) : s.link.proto >= 5 ? HELP4.base5 : HELP4.base;
  const lines: readonly string[] =
    view === "detail" ? HELP4.detail
    : view === "voice" ? HELP4.voice
    : view === "confirm" ? HELP4.confirm
    : view === "settings" ? HELP4.settings6
    : [...baseLines, ...helpKnobLines4(s.legend)];
  topBar(fb, s);
  fb.rect(0, V4.topH, 240, 206, c565(C.black));
  let y = 20;
  lines.forEach((line, i) => {
    const knob = line.startsWith("KNOB");
    fb.text(4, y, line, c565(i === 0 ? C.amber : knob ? C.hint : C.white));
    y += 16;
  });
  if (base) {
    y += 2;
    fb.rect(4, y, 232, 1, c565(C.outline));
    y += 4;
    HELP4.wordStates.forEach((st, i) => {
      const x = 4 + (i % 2) * 118;
      const yy = y + Math.floor(i / 2) * 16;
      // (who is who stands still: fm1c_v4_help_into draws frame 0)
      drawMini(fb, x, yy + 2, st, i % 2 === 0 ? "claude" : "codex", nowMs, true);
      fb.text(x + 16, yy, HELP4.words[i] ?? "", c565(C.white));
    });
  }
  hintBar(fb, V4.hintY, HELP_CLOSE);
}

/** No host (or no common version): the screen dimmed, a 208x128 banner with the floating ghost. */
function banner(fb: Framebuffer, s: DeviceState, nowMs: number): void {
  fb.dim();
  const bg = c565(C.bannerBg);
  fb.rect(17, 57, 206, 126, bg);
  fb.frame(16, 56, 208, 128, 2, c565(C.white));
  drawHero(fb, 96, 62, "disconnected", "claude", nowMs);
  const incompatible = s.link.phase === "incompatible";
  const title = incompatible ? s.link.incompatible || "INCOMPATIBLE" : NO_HOST_TITLE4;
  const hint = incompatible ? "no common version" : NO_HOST_HINT4;
  fb.text((240 - textWidth(title, FONT_L)) >> 1, 112, title, c565(C.white), FONT_L);
  fb.text((240 - textWidth(hint)) >> 1, 152, hint, c565(C.text2));
}

// ---------------------------------------------------------------------------------------------------------------
// Protocol version 5: the LIST layout of Sessions and TO DO (docs/ui-v3.md section 8.2-8.3).

/** docs/ui-v3.md section 8.2 bands. */
export const LIST = {
  hero: { x: 4, y: 26 },
  frame: { x: 34, y: 19, w: 204, h: 40 },
  tailY: 31,
  textX: 40,
  captionY: 22,
  messageY: 38,
  rowsY: 62,
  rowH: 16,
  rows: 10,
  rowW: 236,
  titleX: 48,
  keyX: 20,
  ageRight: 233,
} as const;

/**
 * True when the screen draws the List layout: version 5 agreed (or, under the no-host banner, a version 5 firmware
 * keeping the last view), Sessions or TO DO, layout byte 1.
 */
export function usesList(s: DeviceState): boolean {
  const v = s.view.view;
  const v5 = s.link.phase === "connected" ? s.link.proto >= 5 : s.local.maxProto >= 5;
  // (layout 2 in view 2 draws the List, docs/ui-v3.md section 9.3)
  return v5 && ((s.view.layout === "list" && (v === "sessions" || v === "inbox")) || (s.view.layout === "grouped" && v === "inbox"));
}

/** Version 5 GROUPED (docs/ui-v3.md section 9.3): view 0 with layout 2. */
export function usesGrouped(s: DeviceState): boolean {
  const v5 = s.link.phase === "connected" ? s.link.proto >= 5 : s.local.maxProto >= 5;
  return v5 && s.view.layout === "grouped" && s.view.view === "sessions";
}

/** One row of the Grouped list: a header (H) or a session row (S) of key k. */
export interface GroupedEntry {
  k: number;
  kind: "H" | "S";
}

/** The entries of the Grouped list (section 9.3): a header before each `start` key, a session row unless `task`. */
export function groupedWindow(s: DeviceState): { entries: GroupedEntry[]; top: number } {
  const entries: GroupedEntry[] = [];
  const split = usesSplit(s);
  const rows = split ? SPLIT.listRows : LIST.rows;
  s.slots.forEach((slot, k) => {
    if (slot.state === "empty" || (split && !WHITE_KEYS.includes(k))) return;
    if (slot.row?.start) entries.push({ k, kind: "H" });
    if (!slot.row?.task) entries.push({ k, kind: "S" });
  });
  const sel = entries.findIndex((e) => e.kind === "S" && s.slots[e.k]?.flags.selected);
  return { entries, top: sel >= 0 ? rows * Math.floor(sel / rows) : 0 };
}

/** The rows the list shows (section 8.3): the non-empty keys in key order, a window of 10 around the selection. */
export function listWindow(s: DeviceState): { entries: number[]; top: number } {
  const entries: number[] = [];
  const split = usesSplit(s);
  const rows = split ? SPLIT.listRows : LIST.rows;
  s.slots.forEach((slot, k) => {
    // (SPLIT: black keys are never rows, docs/ui-v3.md section 10.7)
    if (slot.state !== "empty" && (!split || WHITE_KEYS.includes(k))) entries.push(k);
  });
  const sel = entries.findIndex((k) => s.slots[k]?.flags.selected);
  return { entries, top: sel >= 0 ? rows * Math.floor(sel / rows) : 0 };
}

/** One list row at y: row colour, mini, pin, key name, title, age (section 8.3); `d` the Grouped indent shift (9.3). */
function listRow(fb: Framebuffer, k: number, slot: Slot, y: number, nowMs: number, d = 0): void {
  const sel = slot.flags.selected && !noHighlight;
  if (sel) fb.rect(0, y, LIST.rowW, LIST.rowH, c565(C.outline));
  drawMini(fb, 4 + d, y + 2, slot.flags.stale ? "disconnected" : slot.state, slot.flags.codex ? "codex" : "claude", nowMs);
  if (slot.flags.pinned) fb.rect(15 + d, y + 1, 2, 2, c565(C.white));
  fb.text(LIST.keyX + d, y, NOTE[k] ?? "", c565(sel ? C.white : C.grey));
  if (slot.title) fb.text(LIST.titleX + d, y, slot.title, c565(slot.flags.stale ? C.grey : sel ? C.white : C.text2));
  if (slot.age) fb.text(LIST.ageRight - textWidth(slot.age), y, slot.age, c565(sel ? C.white : C.grey));
}

/** The longest prefix of `s` that fits `px` FONT_S pixels (the firmware clips by character count). */
const clipChars = (s: string, px: number): string => s.slice(0, Math.max(0, Math.floor(px / 8)));

/** A Grouped header row (section 9.3): rule, still mini of the group state, pin dot, title (folded: key name), count. */
function headerRow(fb: Framebuffer, k: number, slot: Slot, y: number): void {
  const head = slot.head;
  if (!head) return;
  fb.rect(0, y, LIST.rowW, 1, c565(C.outline));
  drawMini(fb, 4, y + 2, head.state, "claude", 0, true);
  if (head.pinned) fb.rect(15, y + 1, 2, 2, c565(C.white));
  const xc = LIST.ageRight - textWidth(head.count);
  const folded = slot.row?.task === true;
  const x0 = folded ? LIST.titleX : LIST.keyX;
  if (folded) fb.text(LIST.keyX, y, NOTE[k] ?? "", c565(C.grey));
  if (head.title) fb.text(x0, y, clipChars(head.title, xc - 8 - x0), c565(folded ? C.text2 : C.white));
  if (head.count) fb.text(xc, y, head.count, c565(captionColor(head.state)));
}

/** The List (and Grouped) screen: top bar, the 24 px hero, the one-line bubble, 10 rows, the scroll thumb, the hint bar. */
function listScreen(fb: Framebuffer, s: DeviceState, nowMs: number, grouped = false): void {
  const sel = selectedKey(s);
  const st = s.detail.state;
  topBar(fb, s);
  drawHero(fb, LIST.hero.x, LIST.hero.y, st, s.detail.provider, nowMs, 1);
  const col = captionColor(st);
  const border = frame80(col);
  const { x, y, w, h } = LIST.frame;
  fb.rframe(x, y, w, h, border);
  for (let i = 0; i < 5; i++) {
    fb.rect(29 + i, LIST.tailY, 1, 1, border);
    fb.rect(29 + i, LIST.tailY + 1 + i, 1, 1, border);
  }
  fb.rect(x, LIST.tailY + 1, 1, 5, c565(C.black));
  const cap = s.text[0];
  if (cap?.text) textRow(fb, LIST.textX, LIST.captionY, cap, col, 20);
  if (sel >= 0) {
    const note = NOTE[sel] ?? "";
    fb.text(232 - textWidth(note), LIST.captionY, note, c565(C.grey));
  }
  const msg = s.text[1];
  if (msg?.text) textRow(fb, LIST.textX, LIST.messageY, msg, undefined, 24);
  if (s.text[2]?.text) for (let i = 0; i < 4; i++) fb.rect(224 + i, 55 + i, 7 - 2 * i, 1, c565(C.white));
  const split = usesSplit(s);
  if (split) blackRow(fb, s, SPLIT.listBandY);
  const rowsY = split ? SPLIT.listRowsY : LIST.rowsY;
  const nRows = split ? SPLIT.listRows : LIST.rows;
  const L = grouped ? groupedRows(fb, s, nowMs, rowsY, nRows) : plainRows(fb, s, nowMs, rowsY, nRows);
  const top = grouped ? groupedWindow(s).top : listWindow(s).top;
  const span = LIST.rowH * nRows;
  if (L > nRows) {
    const shown = Math.min(nRows, L - top);
    fb.rect(237, rowsY + Math.floor((span * top) / L), 2, Math.floor((span * shown) / L), c565(C.grey));
  }
  footer(fb, s, nowMs, s.detail.lines[3], true);
}

/** The List rows (section 8.3); returns L. */
function plainRows(fb: Framebuffer, s: DeviceState, nowMs: number, rowsY: number = LIST.rowsY, nRows: number = LIST.rows): number {
  const { entries, top } = listWindow(s);
  for (let n = 0; n < nRows && top + n < entries.length; n++) {
    const k = entries[top + n] ?? 0;
    const slot = s.slots[k];
    if (slot) listRow(fb, k, slot, rowsY + LIST.rowH * n, nowMs);
  }
  return entries.length;
}

/** The Grouped rows (section 9.3): headers and indented session rows; returns L. */
function groupedRows(fb: Framebuffer, s: DeviceState, nowMs: number, rowsY: number = LIST.rowsY, nRows: number = LIST.rows): number {
  const { entries, top } = groupedWindow(s);
  for (let n = 0; n < nRows && top + n < entries.length; n++) {
    const e = entries[top + n];
    const slot = e ? s.slots[e.k] : undefined;
    if (!e || !slot) continue;
    const y = rowsY + LIST.rowH * n;
    if (e.kind === "H") headerRow(fb, e.k, slot, y);
    else listRow(fb, e.k, slot, y, nowMs, 8 * (slot.row?.indent ?? 0));
  }
  return entries.length;
}

/** Renders the whole version 4 screen for `s` at device time `nowMs`. `opts.noHighlight`: rows and keys unselected. */
export function renderV4(s: DeviceState, nowMs: number, fb: Framebuffer = new Framebuffer(), opts: { noHighlight?: boolean } = {}): Framebuffer {
  noHighlight = opts.noHighlight === true;
  try {
    return renderInto(s, nowMs, fb);
  } finally {
    noHighlight = false;
  }
}

function renderInto(s: DeviceState, nowMs: number, fb: Framebuffer): Framebuffer {
  fb.px.fill(0);
  const view = s.view.view;
  // Dimmed (no host): the screen under the banner is still, at the frame it showed when the link went.
  const t = s.link.phase === "connected" ? nowMs : Math.min(nowMs, s.local.dimSinceMs);
  if (s.local.help && s.link.phase === "connected") helpScreen(fb, s, t);
  else if (view === "settings") settingsScreen(fb, s, t);
  else if (view === "detail") detailScreen(fb, s, t);
  else if (view === "voice") voiceScreen(fb, s, t);
  else if (view === "confirm") confirmScreen(fb, s, t);
  else if (usesGrouped(s)) listScreen(fb, s, t, true);
  else if (usesList(s)) listScreen(fb, s, t);
  else baseScreen(fb, s, t);
  if (s.link.phase !== "connected") banner(fb, s, nowMs);
  return fb;
}

/** The boxes that animate at `nowMs` (hero, attention minis): what the firmware's fm1c_anim_due may redraw. */
export function animatedBoxes(s: DeviceState): { hero: boolean; keys: number[] } {
  const heroPose = poseOf(s.detail.state);
  const keys: number[] = [];
  const split = usesSplit(s) && s.view.view === "sessions";
  s.slots.forEach((slot, k) => {
    if (split && BLACK_KEYS.includes(k)) return; // SPLIT chips never animate (docs/ui-v3.md section 10.7)
    const pose = poseOf(slot.flags.stale ? "disconnected" : slot.state);
    if (pose && SPRITES.anim[pose].miniFps > 0 && SPRITES.anim[pose].miniFrames > 1) keys.push(k);
  });
  return { hero: heroPose !== null && SPRITES.anim[heroPose].heroFrames > 1, keys };
}

// ---------------------------------------------------------------------------------------------------------------
// Protocol version 6 (docs/ui-v3.md section 10.7): the SPLIT black row and the SETTINGS view.

/** SPLIT bands. */
export const SPLIT = {
  bubbleH: 92,
  buddyBandY: 168,
  listBandY: 60,
  listRowsY: 94,
  listRows: 8,
  chipW: 26,
  chipH: 16,
} as const;

/** True when the 27 keys hold the SPLIT assignment: version 6 agreed (or the firmware's own, under the banner) and keys 1. */
export function usesSplit(s: DeviceState): boolean {
  const v6 = s.link.phase === "connected" ? s.link.proto >= 6 : s.local.maxProto >= 6;
  return v6 && s.view.keys === "split";
}

/** The centre x of black key index i (k = 1, 3, 5, 8, ...): 8 + 14 (a_i + 1). */
export const chipCentre = (i: number): number => 8 + 14 * ((BLACK_AFTER[i] ?? 0) + 1);

/** One chip's box (26 x 16) and stem; line A (even i) at `bandY`, line B (odd i) 16 px lower. */
export function chipBox(i: number, bandY: number): { x: number; y: number; w: number; h: number; stem: { x: number; y: number; h: number } | null } {
  const c = chipCentre(i);
  const y = bandY + (i % 2 === 0 ? 0 : 16);
  return { x: c - 13, y, w: SPLIT.chipW, h: SPLIT.chipH, stem: i % 2 === 0 ? { x: c, y: y + 16, h: 16 } : null };
}

const FILTER_KEYS = [1, 3, 5];

/** One black key chip (docs/ui-v3.md section 10.7 chip table). */
export function drawChip(fb: Framebuffer, i: number, slot: Slot | undefined, bandY: number): void {
  const k = BLACK_KEYS[i] ?? 1;
  const box = chipBox(i, bandY);
  const black = c565(C.black);
  fb.rect(box.x, box.y, box.w, box.h, black);
  if (box.stem) fb.rect(box.stem.x, box.stem.y, 1, box.stem.h, black);
  const filter = FILTER_KEYS.includes(k);
  const st = slot?.state ?? "empty";
  if (!filter && st === "empty") {
    fb.rect(box.x + 11, box.y + 7, 4, 2, c565(C.outline));
    return;
  }
  const col = c565(captionColor(st));
  const chosen = slot?.flags.chosen === true;
  let tagColor: number;
  let stem: number;
  if (chosen) {
    fb.rect(box.x, box.y, box.w, box.h, c565(C.white));
    tagColor = black;
    stem = c565(C.white);
  } else if (filter) {
    const empty = st === "empty";
    fb.frame(box.x, box.y, box.w, box.h, 1, empty ? c565(C.outline) : col);
    tagColor = empty ? c565(C.grey) : col;
    stem = col;
  } else {
    fb.rect(box.x, box.y, box.w, box.h, col);
    tagColor = isDark(captionColor(st)) ? c565(C.white) : black;
    stem = col;
  }
  const tag = (slot?.label ?? "").slice(0, 3);
  if (tag) fb.text(box.x + Math.floor((26 - 8 * tag.length) / 2), box.y, tag, tagColor);
  if (!filter && slot?.flags.pinned) fb.rect(box.x + 23, box.y + 1, 2, 2, tagColor);
  if (box.stem) fb.rect(box.stem.x, box.stem.y, 1, box.stem.h, stem);
}

/** The black row band (240 x 32 at `bandY`): the 11 chips and the task page dots. */
export function blackRow(fb: Framebuffer, s: DeviceState, bandY: number): void {
  fb.rect(0, bandY, 240, 32, c565(C.black));
  // line A first, then line B: every line A stem passes outside the line B boxes
  for (let i = 0; i < BLACK_KEYS.length; i += 2) drawChip(fb, i, s.slots[BLACK_KEYS[i] ?? 1], bandY);
  for (let i = 1; i < BLACK_KEYS.length; i += 2) drawChip(fb, i, s.slots[BLACK_KEYS[i] ?? 1], bandY);
  const pages = s.view.taskPages ?? 1;
  if (pages > 1) {
    const n = Math.min(pages, 8);
    const page = s.view.taskPage ?? 0;
    const cur = pages > 8 ? Math.floor((page * 8) / pages) : page;
    for (let j = 0; j < n; j++) fb.rect(234, bandY + 1 + 4 * j, 2, 2, c565(j === cur ? C.white : C.grey));
  }
}

/** Voice / confirm over SPLIT: a black key as a compact box (task fill, filter frame, chosen white, empty task dash). */
function drawCompactBlack(fb: Framebuffer, k: number, slot: Slot | undefined): void {
  const { x, y } = keyBox4(k);
  fb.rect(x, y, 14, 16, c565(C.black));
  const st = slot?.state ?? "empty";
  const filter = FILTER_KEYS.includes(k);
  if (slot?.flags.chosen) return fb.rect(x + 1, y + 1, 12, 12, c565(C.white));
  if (!filter && st === "empty") return fb.rect(x + 5, y + 6, 4, 2, c565(C.blackKeyDash));
  const col = c565(captionColor(st));
  if (filter) fb.frame(x + 1, y + 1, 12, 12, 1, st === "empty" ? c565(C.outline) : col);
  else fb.rect(x + 1, y + 1, 12, 12, col);
}

/** SPLIT Buddy (docs/ui-v3.md section 10.7): the 4-row bubble, the black row at y 168, the 16 white minis at y 202. */
function splitBuddy(fb: Framebuffer, s: DeviceState, nowMs: number): void {
  const sel = selectedKey(s);
  const slot = sel >= 0 ? s.slots[sel] : undefined;
  const st = s.detail.state;
  topBar(fb, s);
  drawHero(fb, V4.hero.x, V4.hero.y, st, s.detail.provider, nowMs);
  if (slot?.label) heroLabel(fb, slot.label, s.detail.lines[0]);
  else {
    fb.text(V4.labelX, 26, sel >= 0 ? "(untitled)" : "nothing selected", c565(C.grey));
    heroLabel(fb, "", s.detail.lines[0]);
  }
  const col = captionColor(st);
  bubble(fb, frame80(col), V4.bubble.tailX, SPLIT.bubbleH);
  const cap = s.text[0];
  if (cap?.text) textRow(fb, 8, V4.captionY, cap, col);
  keyName(fb, sel);
  for (let i = 0; i < 4; i++) {
    const row = s.text[1 + i];
    if (row?.text) textRow(fb, 8, V4.bodyY + 16 * i, row);
  }
  if (s.text[5]?.text) wedge(fb, -16);
  blackRow(fb, s, SPLIT.buddyBandY);
  fb.rect(0, 200, 240, 24, c565(C.black));
  for (const k of WHITE_KEYS) drawKey(fb, k, s.slots[k], nowMs);
  footer(fb, s, nowMs, s.detail.lines[3], true);
}

/** SETTINGS (view 6): the top bar without a page, 9 item rows of 20 px from y 22, the description, the hint bar. */
function settingsScreen(fb: Framebuffer, s: DeviceState, nowMs: number): void {
  topBar(fb, s, true);
  const items = s.view.pages;
  for (let n = 0; n < 9; n++) {
    const y = 22 + 20 * n;
    if (n >= items) continue;
    const cur = n === s.view.page;
    if (cur) {
      fb.rect(0, y, 240, 20, c565(C.outline));
      fb.text(4, y + 2, ">", c565(C.white));
    }
    const row = s.text[n];
    if (row?.text) textRow(fb, 16, y + 2, row, cur ? C.white : row.style === "muted" ? C.grey : C.text2, 26);
  }
  const d = s.text[9];
  if (d?.text) textRow(fb, 4, 204, d, STYLE_RGB.muted);
  footer(fb, s, nowMs, s.detail.lines[3], false);
}
