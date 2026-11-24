// Animated transitions and scroll (docs/ui-v3.md section 9.10): what the firmware's fm1c_trans.h draws, step by step,
// modelled on whole framebuffers. Every step names the rectangles it redraws (the pixel budget) and paints them from
// the panel before the transition (old) and the model at the step's time (new). Hardware vertical scroll (VSCRDEF /
// VSCRSADD) is modelled by what the panel shows, which equals a perfect scroll of the area. Pure and browser-safe.
import { selectedKey, type DeviceState } from "../state";
import { Framebuffer, rgb565 } from "./raster";
import {
  captionColor,
  drawHero,
  drawHeroSquash,
  frame80,
  groupedWindow,
  keyBox4,
  LIST,
  listWindow,
  renderV4,
  RESULT_SHOW_MS,
  SPLIT,
  usesGrouped,
  usesList,
  usesSplit,
  usesV4,
  V4,
} from "./screen";
import { KNOB_ROW_MS } from "../state";

/** Frames closer together than this belong to one burst (the CC stream never idles in between). */
export const BURST_GAP_MS = 5;
/** Step start offsets (ms after t0): equal slices, ease-out timing (section 9.10). */
export const T3 = [0, 30, 70] as const;
export const T4 = [0, 20, 50, 90] as const;
export const TRANSITION_MS = 120;
/** Reader open/close: the normal content draw after the outlines. */
export const CONTENT_AT = 110;
/** Pixel budget: per step and per transition (the content draw of reader open/close not counted). */
export const STEP_PX_MAX = 18_000;
export const TRANSITION_PX_MAX = 60_000;
/** The firmware's FM1C_ANIM_PX_PASS: each step goes out in passes of at most this many pixels. */
export const PASS_PX = 2_400;
/** Section 9.10.1 (the firmware's FM1C_TR_FAST_MS): a press (a key down, an encoder step) closer than this to the previous
 * press is a fast scroll; no transition starts until this long after it, the changes are drawn at once. */
export const FAST_MS = 150;

export type TransitionKind =
  | "select-list"
  | "select-strip"
  | "hero"
  | "page-wipe"
  | "layout-wipe"
  | "reader-open"
  | "reader-close"
  | "reader-scroll"
  | "window-scroll"
  | "toast-in"
  | "toast-out"
  | "knob-in"
  | "knob-out"
  | "voice-scroll"
  | "task-wipe";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StepCtx {
  /** The panel before the transition. */
  old: Framebuffer;
  /** The model at this step's time, drawn as usual. */
  fresh: Framebuffer;
  /** The same, with no selection highlight (rows and keys redrawn unselected). */
  plain: () => Framebuffer;
  state: DeviceState;
  t: number;
}

export interface Step {
  /** Offset from t0. */
  at: number;
  rects: Rect[];
  /** Paints this step's rectangles (and only those) into `fb`, which holds the panel as the previous step left it. */
  paint: (fb: Framebuffer, ctx: StepCtx) => void;
  /** True for the normal content draw after reader open/close (outside the transition budget). */
  content?: boolean;
  /** Hardware vertical scroll: the area the panel moves by itself (no SPI pixels, not in the budget). */
  scroll?: Rect;
}

export interface Transition {
  kind: TransitionKind;
  t0: number;
  steps: Step[];
  /** Device time the transition is over (t0 + 120 ms, or earlier when input completed it). */
  end: number;
}

export const rectPx = (r: Rect): number => Math.max(0, r.w) * Math.max(0, r.h);
export const stepPx = (s: Step): number => s.rects.reduce((a, r) => a + rectPx(r), 0);

const copy = (dst: Framebuffer, src: Framebuffer, r: Rect, dx = 0, dy = 0): void => {
  for (let y = Math.max(0, r.y); y < Math.min(240, r.y + r.h); y++) {
    for (let x = Math.max(0, r.x); x < Math.min(240, r.x + r.w); x++) {
      const sx = x + dx;
      const sy = y + dy;
      if (sx >= 0 && sy >= 0 && sx < 240 && sy < 240) dst.px[y * 240 + x] = src.px[sy * 240 + sx] ?? 0;
    }
  }
};

/** a + (b - a) * i / n in C integer arithmetic (the quotient truncated toward zero), as fm1c_trans.h computes it. */
const lerp = (a: number, b: number, i: number, n: number): number => a + Math.trunc(((b - a) * i) / n);
const lerpRect = (a: Rect, b: Rect, i: number, n: number): Rect => ({ x: lerp(a.x, b.x, i, n), y: lerp(a.y, b.y, i, n), w: lerp(a.w, b.w, i, n), h: lerp(a.h, b.h, i, n) });
/** A 1 px outline's own pixels, as rectangles (for the budget). */
const outlineRects = (r: Rect): Rect[] => [
  { x: r.x, y: r.y, w: r.w, h: 1 },
  { x: r.x, y: r.y + r.h - 1, w: r.w, h: 1 },
  { x: r.x, y: r.y + 1, w: 1, h: Math.max(0, r.h - 2) },
  { x: r.x + r.w - 1, y: r.y + 1, w: 1, h: Math.max(0, r.h - 2) },
];

const BLACK = 0;
const HINT_BG = rgb565([32, 32, 32]);
const GREY = rgb565([128, 128, 128]);
const WHITE = rgb565([255, 255, 255]);

/** Bubble rectangle of the base layout (reader open source / close target). */
export const READER_FULL: Rect = { x: 0, y: 18, w: 240, h: 206 };
const BUBBLE_BUDDY: Rect = { x: V4.bubble.x, y: V4.bubble.y, w: V4.bubble.w, h: V4.bubble.h };
const BUBBLE_LIST: Rect = { x: LIST.frame.x, y: LIST.frame.y, w: LIST.frame.w, h: LIST.frame.h };
/** Hardware scroll areas: TFA, VSA (BFA = 320 - TFA - VSA). */
export const VSCROLL = { reader: { tfa: 72, vsa: 152 }, list: { tfa: 62, vsa: 160 }, splitList: { tfa: 94, vsa: 128 } } as const;
/** SPLIT bands (docs/ui-v3.md section 10.7): the black row (task wipe) and the white-key page wipe. */
const SPLIT_BUDDY_BAND: Rect = { x: 0, y: SPLIT.buddyBandY, w: 240, h: 32 };
const SPLIT_LIST_BAND: Rect = { x: 0, y: SPLIT.listBandY, w: 240, h: 32 };
const SPLIT_WHITE_BAND: Rect = { x: 0, y: 200, w: 240, h: 24 };
const SPLIT_ROWS_BAND: Rect = { x: 0, y: 92, w: 236, h: 132 };
const BUBBLE_SPLIT: Rect = { x: V4.bubble.x, y: V4.bubble.y, w: V4.bubble.w, h: SPLIT.bubbleH };
const LIST_BAND: Rect = { x: 0, y: 60, w: 236, h: 164 };
const STRIP_BAND: Rect = { x: 0, y: 182, w: 240, h: 40 };
const BODY_BAND: Rect = { x: 0, y: 18, w: 240, h: 206 };
const HINT_BAR: Rect = { x: 0, y: V4.hintY, w: 240, h: 16 };
const VOICE_BODY: Rect = { x: 8, y: 96, w: 224, h: 80 };

/** The VSCRSADD values of a full-area scroll in 4 steps (step 4 lands on TFA: the identity mapping). */
export function vscrollStarts(area: { tfa: number; vsa: number }, forward: boolean): number[] {
  const step = area.vsa / 4;
  return [1, 2, 3, 4].map((i) => area.tfa + ((forward ? step * i : area.vsa - step * i) % area.vsa));
}

// ---------------------------------------------------------------------------------------------------------------
// Builders, one per transition.

const isList = (s: DeviceState): boolean => usesList(s) || usesGrouped(s);
const sel = (s: DeviceState): number => selectedKey(s);

/** The window row (0-9) of a key's session entry, and the window top, or null when off the window. */
function rowOf(s: DeviceState, k: number): { row: number; top: number } | null {
  if (usesGrouped(s)) {
    const { entries, top } = groupedWindow(s);
    const i = entries.findIndex((e) => e.k === k && e.kind === "S");
    return i < 0 ? null : { row: i - top, top };
  }
  const { entries, top } = listWindow(s);
  const i = entries.indexOf(k);
  return i < 0 ? null : { row: i - top, top };
}

/** The list rows' geometry: 10 rows from y 62, or (SPLIT) 8 rows from y 94. */
const rowsGeo = (s: DeviceState): { y0: number; n: number } => (usesSplit(s) ? { y0: SPLIT.listRowsY, n: SPLIT.listRows } : { y0: LIST.rowsY, n: LIST.rows });

function selectList(prev: DeviceState, next: DeviceState, a: number, b: number): Step[] | null {
  const ra = rowOf(prev, a);
  const rb = rowOf(next, b);
  if (!ra || !rb || ra.top !== rb.top || ra.row === rb.row) return null;
  const { y0, n } = rowsGeo(next);
  const rowRect = (row: number): Rect => ({ x: 0, y: y0 + LIST.rowH * row, w: LIST.rowW, h: LIST.rowH });
  const rowsUnder = (y: number): number[] => [Math.floor((y - y0) / LIST.rowH), Math.floor((y + LIST.rowH - 1 - y0) / LIST.rowH)].filter((r, i, a) => r >= 0 && r < n && a.indexOf(r) === i);
  const ya = y0 + LIST.rowH * ra.row;
  const yb = y0 + LIST.rowH * rb.row;
  const ys = [1, 2].map((i) => ya + Math.trunc(((yb - ya) * i) / 3));
  const steps: Step[] = [];
  let prevY = ya;
  ys.forEach((y, i) => {
    const restore = [...new Set([ra.row, ...rowsUnder(prevY)])].map(rowRect);
    const frame: Rect = { x: 0, y, w: LIST.rowW, h: LIST.rowH };
    steps.push({
      at: T3[i] ?? 0,
      rects: [...restore, ...outlineRects(frame)],
      paint: (fb, c) => {
        const plain = c.plain();
        for (const r of restore) copy(fb, plain, r);
        fb.frame(frame.x, frame.y, frame.w, frame.h, 1, GREY);
      },
    });
    prevY = y;
  });
  const last = [...new Set([ra.row, rb.row, ...rowsUnder(prevY)])].map(rowRect);
  steps.push({ at: T3[2], rects: last, paint: (fb, c) => last.forEach((r) => copy(fb, c.fresh, r)) });
  return steps;
}

function selectStrip(prev: DeviceState, next: DeviceState, a: number, b: number): Step[] {
  const A = keyBox4(a);
  const Bx = keyBox4(b);
  const boxes = [1, 2].map((i) => lerpRect(A, Bx, i, 3));
  const steps: Step[] = [];
  let prevBox: Rect = A;
  boxes.forEach((bx, i) => {
    const restore: Rect[] = [{ x: prevBox.x, y: prevBox.y, w: 14, h: 16 }];
    steps.push({
      at: T3[i] ?? 0,
      rects: [...restore, ...outlineRects({ ...bx, w: 14, h: 14 })],
      paint: (fb, c) => {
        const plain = c.plain();
        for (const r of restore) copy(fb, plain, r);
        fb.frame(bx.x, bx.y, 14, 14, 1, WHITE);
      },
    });
    prevBox = bx;
  });
  const last: Rect[] = [A, prevBox, Bx].map((r) => ({ x: r.x, y: r.y, w: 14, h: 16 }));
  steps.push({ at: T3[2], rects: last, paint: (fb, c) => last.forEach((r) => copy(fb, c.fresh, r)) });
  void prev;
  void next;
  return steps;
}

function heroPop(next: DeviceState): Step[] {
  const list = isList(next);
  const scale = list ? 1 : 2;
  const x = list ? LIST.hero.x : V4.hero.x;
  const y = list ? LIST.hero.y : V4.hero.y;
  const box: Rect = { x, y: y - scale, w: 24 * scale, h: 24 * scale + scale };
  return [
    {
      at: T3[0],
      rects: [box],
      paint: (fb, c) => {
        fb.rect(box.x, box.y, box.w, box.h, BLACK);
        drawHeroSquash(fb, x, y, c.state.detail.state, c.state.detail.provider, c.t, scale);
      },
    },
    {
      at: T3[1],
      rects: [box],
      paint: (fb, c) => {
        fb.rect(box.x, box.y, box.w, box.h, BLACK);
        drawHero(fb, x, y - scale, c.state.detail.state, c.state.detail.provider, c.t, scale);
      },
    },
    { at: T3[2], rects: [box], paint: (fb, c) => copy(fb, c.fresh, box) },
  ];
}

/** Equal slices of `band`, columns (horizontal) or rows (vertical), revealed in order, from the model at each step. */
function wipe(band: Rect, n: 3 | 4, vertical: boolean, reverse: boolean): Step[] {
  const T = n === 3 ? T3 : T4;
  const len = vertical ? band.h : band.w;
  return Array.from({ length: n }, (_, j) => {
    const i = j + 1;
    let a = Math.floor((len * (i - 1)) / n);
    let b = Math.floor((len * i) / n);
    if (reverse) [a, b] = [len - b, len - a];
    const r: Rect = vertical ? { x: band.x, y: band.y + a, w: band.w, h: b - a } : { x: band.x + a, y: band.y, w: b - a, h: band.h };
    return { at: T[j] ?? 0, rects: [r], paint: (fb: Framebuffer, c: StepCtx) => copy(fb, c.fresh, r) };
  });
}

/**
 * Reader open: outlines at lerp(B, F, i/3); close: the same rectangles in reverse, lerp(B, F, (3 - i)/3), so open and
 * close draw the same pixels (fm1c_trans.h; with integer truncation lerp(F, B, i/3) would differ by 1 px).
 */
function outlines(bubble: Rect, full: Rect, color: number, close: boolean): Step[] {
  const steps: Step[] = [1, 2, 3].map((i) => {
    const r = lerpRect(bubble, full, close ? 3 - i : i, 3);
    return { at: T3[i - 1] ?? 0, rects: outlineRects(r), paint: (fb: Framebuffer) => fb.frame(r.x, r.y, r.w, r.h, 1, color) };
  });
  const all: Rect = { x: 0, y: 0, w: 240, h: 240 };
  steps.push({ at: CONTENT_AT, rects: [all], content: true, paint: (fb, c) => copy(fb, c.fresh, all) });
  return steps;
}

/**
 * Hardware scroll of a full area in 4 steps: step i shows the old area moved by i quarters and the new area entering
 * (forward: from below), the new rows drawn at their own step's time. Step 4 is the new area, mapping back at TFA.
 */
function vscroll(area: { tfa: number; vsa: number }, forward: boolean, extraLast: Rect[] = []): Step[] {
  const q = area.vsa / 4;
  const steps: Step[] = [];
  const drawn: { rows: [number, number]; src: Framebuffer | null }[] = [];
  for (let i = 1; i <= 4; i++) {
    const exposed: Rect = forward ? { x: 0, y: area.tfa + area.vsa - q * i, w: 240, h: q } : { x: 0, y: area.tfa + q * (i - 1), w: 240, h: q };
    const newRows: [number, number] = forward ? [q * (i - 1), q * i] : [area.vsa - q * i, area.vsa - q * (i - 1)];
    const rects = i === 4 ? [exposed, ...extraLast] : [exposed];
    steps.push({
      at: T4[i - 1] ?? 0,
      rects,
      scroll: { x: 0, y: area.tfa, w: 240, h: area.vsa },
      paint: (fb, c) => {
        if (i === 1) drawn.length = 0;
        drawn.push({ rows: newRows, src: c.fresh });
        // The panel shows the virtual strip [old area | new area] (forward) moved by i quarters.
        const shift = q * i;
        for (let y = 0; y < area.vsa; y++) {
          const v = forward ? y + shift : y - shift + area.vsa; // index into [old 0..vsa) [new vsa..2vsa) (back: [new][old])
          const fromNew = forward ? v >= area.vsa : v < area.vsa;
          const row = forward ? (fromNew ? v - area.vsa : v) : fromNew ? v : v - area.vsa;
          let src: Framebuffer = c.old;
          if (fromNew) src = drawn.find((d) => row >= d.rows[0] && row < d.rows[1])?.src ?? c.fresh;
          for (let x = 0; x < 240; x++) fb.px[(area.tfa + y) * 240 + x] = src.px[(area.tfa + row) * 240 + x] ?? 0;
        }
        if (i === 4) for (const r of extraLast) copy(fb, c.fresh, r);
      },
    });
  }
  return steps;
}

/** The hint bar redrawn with `src`'s bar content moved down by `off` rows (the rows above it the bar colour). */
function barAt(off: number, which: "old" | "fresh"): (fb: Framebuffer, c: StepCtx) => void {
  return (fb, c) => {
    const src = which === "old" ? c.old : c.fresh;
    fb.rect(HINT_BAR.x, HINT_BAR.y, HINT_BAR.w, Math.min(16, off), HINT_BG);
    copy(fb, src, { x: 0, y: HINT_BAR.y + off, w: 240, h: 16 - off }, 0, -off);
  };
}

const slideIn = (): Step[] => [11, 5, 0].map((off, i) => ({ at: T3[i] ?? 0, rects: [HINT_BAR], paint: barAt(off, "fresh") }));
const slideOut = (): Step[] => [
  { at: T3[0], rects: [HINT_BAR], paint: barAt(5, "old") },
  { at: T3[1], rects: [HINT_BAR], paint: barAt(11, "old") },
  { at: T3[2], rects: [HINT_BAR], paint: (fb, c) => copy(fb, c.fresh, HINT_BAR) },
];

function voiceScroll(forward: boolean): Step[] {
  const q = VOICE_BODY.h / 4;
  return [1, 2, 3, 4].map((i) => ({
    at: T4[i - 1] ?? 0,
    rects: [VOICE_BODY],
    paint: (fb: Framebuffer, c: StepCtx) => {
      const shift = q * i;
      for (let y = 0; y < VOICE_BODY.h; y++) {
        const v = forward ? y + shift : y - shift;
        const fromNew = forward ? v >= VOICE_BODY.h : v < 0;
        const row = fromNew ? (forward ? v - VOICE_BODY.h : v + VOICE_BODY.h) : v;
        const src = fromNew ? c.fresh : c.old;
        for (let x = VOICE_BODY.x; x < VOICE_BODY.x + VOICE_BODY.w; x++) fb.px[(VOICE_BODY.y + y) * 240 + x] = src.px[(VOICE_BODY.y + row) * 240 + x] ?? 0;
      }
    },
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// Triggers (what the firmware detects from the frames it applies).

const isBase = (v: string): boolean => v === "sessions" || v === "tasks" || v === "inbox";

/** The transition a change from `prev` to `next` starts, or null (drawn directly). Version 5 only. */
export function detectTransition(prev: DeviceState, next: DeviceState, t0: number): Transition | null {
  const v5 = next.link.phase === "connected" && next.link.proto >= 5 && prev.link.phase === "connected";
  if (!v5 || !usesV4(next)) return null;
  const mk = (kind: TransitionKind, steps: Step[] | null): Transition | null => (steps ? { kind, t0, steps, end: t0 + TRANSITION_MS } : null);
  const pv = prev.view;
  const nv = next.view;
  const bubbleOf = (s: DeviceState): Rect => (isList(s) ? BUBBLE_LIST : usesSplit(s) && s.view.view === "sessions" ? BUBBLE_SPLIT : BUBBLE_BUDDY);
  if (pv.view !== nv.view) {
    if ((pv.view === "sessions" || pv.view === "inbox") && nv.view === "detail") {
      return mk("reader-open", outlines(bubbleOf(prev), READER_FULL, frame80(captionColor(next.detail.state)), false));
    }
    if (pv.view === "detail" && (nv.view === "sessions" || nv.view === "inbox")) {
      return mk("reader-close", outlines(bubbleOf(next), READER_FULL, frame80(captionColor(prev.detail.state)), true));
    }
    return null;
  }
  if ((pv.layout ?? "buddy") !== (nv.layout ?? "buddy") && isBase(nv.view)) return mk("layout-wipe", wipe(BODY_BAND, 4, true, false));
  // Version 6 (docs/ui-v3.md section 10.7): a keys change in one view is the layout wipe.
  if ((pv.keys ?? "ranked") !== (nv.keys ?? "ranked") && isBase(nv.view)) return mk("layout-wipe", wipe(BODY_BAND, 4, true, false));
  const split = usesSplit(next) && nv.view === "sessions";
  if (pv.page !== nv.page) {
    if (nv.view === "detail") return mk("reader-scroll", vscroll(VSCROLL.reader, nv.page > pv.page));
    if (isBase(nv.view)) {
      const band = split ? (isList(next) ? SPLIT_ROWS_BAND : SPLIT_WHITE_BAND) : isList(next) ? LIST_BAND : STRIP_BAND;
      return mk("page-wipe", wipe(band, 3, false, nv.page < pv.page));
    }
    return null;
  }
  // SPLIT task wipe: only the task page or count changed; left to right when it moved forward (wrapping).
  if (split && ((pv.taskPage ?? 0) !== (nv.taskPage ?? 0) || (pv.taskPages ?? 1) !== (nv.taskPages ?? 1))) {
    const n = nv.taskPages ?? 1;
    const forward = (nv.taskPage ?? 0) === ((pv.taskPage ?? 0) + 1) % Math.max(1, n);
    return mk("task-wipe", wipe(isList(next) ? SPLIT_LIST_BAND : SPLIT_BUDDY_BAND, 3, false, !forward));
  }
  if (nv.view === "voice") {
    const o = prev.text.map((r) => r.text);
    const n = next.text.map((r) => r.text);
    const same = (a: number, b: number): boolean => (o[a] ?? "") === (n[b] ?? "") && (o[a] ?? "") !== "";
    if (same(6, 1)) return mk("voice-scroll", voiceScroll(true));
    if (same(1, 6)) return mk("voice-scroll", voiceScroll(false));
  }
  if (!isBase(nv.view)) return null;
  const a = sel(prev);
  const b = sel(next);
  if (a >= 0 && b >= 0 && a !== b) {
    if (isList(next)) {
      const ra = rowOf(prev, a);
      const rb = rowOf(next, b);
      if (ra && rb && ra.top !== rb.top) {
        if (usesSplit(next)) return mk("window-scroll", vscroll(VSCROLL.splitList, rb.top > ra.top, [{ x: 236, y: 92, w: 4, h: 132 }]));
        return mk("window-scroll", vscroll(VSCROLL.list, rb.top > ra.top, [{ x: 236, y: 60, w: 4, h: 164 }]));
      }
      return mk("select-list", selectList(prev, next, a, b));
    }
    return mk("select-strip", selectStrip(prev, next, a, b));
  }
  if (a === b && (prev.detail.state !== next.detail.state || prev.detail.provider !== next.detail.provider) && next.detail.state !== "empty") {
    return mk("hero", heroPop(next));
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The screen with transitions: states applied at device times, frames rendered at any time.

/**
 * A simulated panel: apply each new device state at its time (`apply`), device input (`input`), and read the frame at
 * any later time (`frame`). One transition at a time; input completes it at once; a change during it is drawn after.
 */
export class TransitionScreen {
  private history: { at: number; state: DeviceState }[] = [];
  private running: Transition | null = null;
  private old: Framebuffer | null = null;
  /** Every transition started, in order (tests, evidence). */
  readonly log: Transition[] = [];
  private toastSeen = -1;
  private knobUntil = 0;
  /**
   * What the panel shows: the firmware draws only while no host frame is waiting, so the frames of one burst (applied
   * back to back, gaps <= BURST_GAP_MS) are never drawn one by one. A transition's old content is this state.
   */
  private shown: DeviceState;
  private lastApply = -Infinity;
  private burstStart = -Infinity;
  /** Section 9.10.1: the last press and the end of the fast scroll it started. */
  private lastPress = -Infinity;
  private fastUntil = -Infinity;
  private readonly fastSkipped = new Set<string>();

  constructor(initial: DeviceState, at = 0) {
    this.history.push({ at, state: initial });
    this.shown = initial;
  }

  private stateAt(t: number): DeviceState {
    let s = this.history[0]?.state as DeviceState;
    for (const h of this.history) if (h.at <= t) s = h.state;
    return s;
  }

  get current(): DeviceState {
    return this.history[this.history.length - 1]?.state as DeviceState;
  }

  /** A new device state at device time `at` (after one host frame or a local change). */
  apply(next: DeviceState, at: number, rxFrom?: number): Transition | null {
    this.settleTimed(at);
    const prev = this.current;
    // `rxFrom`: when the frame's first byte arrived (known to a replay); the link idled before it when it came after
    // the previous frame had been applied. Without it, frames closer than BURST_GAP_MS count as one burst.
    const idle = rxFrom !== undefined ? rxFrom - this.lastApply > 1 : at - this.lastApply > BURST_GAP_MS;
    if (idle) {
      this.shown = prev; // the link was idle: the panel caught up
      this.burstStart = at;
    }
    this.lastApply = at;
    this.history.push({ at, state: next });
    if (this.history.length > 64) this.history.splice(0, this.history.length - 64); // (a live UI keeps no more)
    // A transition triggered earlier in this burst has not drawn yet (no transition starts while host frames are
    // waiting): a later trigger of the same burst replaces it. One from before the burst runs on.
    const superseded = !idle && this.running !== null && this.running.t0 >= this.burstStart ? this.running : null;
    if (this.running && at < this.running.end && !superseded) return null; // drawn after the end, without a transition
    this.running = null;
    // The trigger compares what the panel shows with the model (fm1c_trans_detect: fm1c_sn against the model), so a
    // change spread over the frames of one burst (the voice rows in three SET_TEXT frames) is seen as a whole.
    const fast = at < this.fastUntil; // (section 9.10.1: a fast scroll draws every change at once)
    let t = fast ? null : detectTransition(this.shown, next, at);
    const r = next.lastResult;
    if (!t && !fast && r && r.atMs !== this.toastSeen && r.atMs === at && next.link.phase === "connected" && next.link.proto >= 5) {
      t = { kind: "toast-in", t0: at, steps: slideIn(), end: at + TRANSITION_MS };
    }
    if (r) this.toastSeen = r.atMs;
    if (!t && !fast && next.local.knobLit >= 0 && next.local.knobUntilMs !== this.knobUntil && next.link.proto >= 5) {
      const shown = prev.local.knobLit >= 0 && at < prev.local.knobUntilMs;
      if (!shown) t = { kind: "knob-in", t0: at, steps: slideIn(), end: at + TRANSITION_MS };
    }
    this.knobUntil = next.local.knobUntilMs;
    if (!t && superseded) {
      this.running = superseded;
      return null;
    }
    if (t && superseded) this.log.splice(this.log.lastIndexOf(superseded), 1);
    // The old content is the panel as last drawn: before the burst, sprites at their frame of that time.
    if (t) this.start(t, this.shown, Math.min(t.t0, this.burstStart - 1));
    return t;
  }

  /**
   * Device input at `at`: a running transition completes at once. `press` (a key down or an encoder step; not a
   * release, not a button) within FAST_MS of the previous press starts a fast scroll (section 9.10.1).
   */
  input(at: number, press = false): void {
    if (this.running && at < this.running.end) this.running = { ...this.running, end: at };
    if (!press) return;
    if (at - this.lastPress < FAST_MS) this.fastUntil = at + FAST_MS;
    this.lastPress = at;
  }

  /** `oldAt`: the time the panel content before the transition is rendered at (the slide-outs: just before t0). */
  private start(t: Transition, prev: DeviceState, oldAt = t.t0): void {
    this.old = renderV4(prev, oldAt);
    this.running = t;
    this.log.push(t);
  }

  /** Toast and knob row leaving: time-driven slide-outs. */
  private settleTimed(t: number): void {
    const s = this.current;
    if (s.link.phase !== "connected" || s.link.proto < 5) return;
    const outs: [TransitionKind, number][] = [];
    if (s.lastResult) outs.push(["toast-out", s.lastResult.atMs + RESULT_SHOW_MS]);
    if (s.local.knobLit >= 0 && s.local.knobUntilMs > 0) outs.push(["knob-out", s.local.knobUntilMs]);
    for (const [kind, at] of outs) {
      if (at > t || this.log.some((l) => l.kind === kind && l.t0 === at) || this.fastSkipped.has(`${kind}@${at}`)) continue;
      if (this.running && at < this.running.end) continue;
      if (at < this.fastUntil) { this.fastSkipped.add(`${kind}@${at}`); continue; }   // (section 9.10.1: drawn at once)
      const t0 = at;
      // The panel still shows the toast / knob row: it expires at t0 itself, so the old content is from t0 - 1.
      this.start({ kind, t0, steps: slideOut(), end: t0 + TRANSITION_MS }, s, t0 - 1);
    }
  }

  /** The panel at device time `t`. */
  frame(t: number): Framebuffer {
    this.settleTimed(t);
    const r = this.running;
    if (!r || t >= r.end || t < r.t0 || !this.old) return renderV4(this.stateAt(t), t);
    const fb = new Framebuffer();
    fb.px.set(this.old.px);
    for (const st of r.steps) {
      const at = r.t0 + st.at;
      if (at > t) break;
      const state = this.stateAt(at);
      let plain: Framebuffer | null = null;
      st.paint(fb, { old: this.old, fresh: renderV4(state, at), plain: () => (plain ??= renderV4(state, at, undefined, { noHighlight: true })), state, t: at });
    }
    return fb;
  }
}

export { KNOB_ROW_MS };
