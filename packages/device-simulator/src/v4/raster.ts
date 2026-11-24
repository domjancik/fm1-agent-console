// A 240x240 RGB565 framebuffer that draws the way the firmware does (docs/ui-v3.md section 6.4): text with the
// firmware's own FONT_S / FONT_L bitmaps and gfx.c cv_text semantics (each glyph pixel = colour x alpha / 15 on
// black), and 4 bpp sprites with index 0 transparent. Browser-safe and pure; the assets come from fm1-v4.json.
import ASSETS from "../assets/fm1-v4.json";

export type Rgb = readonly [number, number, number];

export const rgb565 = ([r, g, b]: Rgb): number => ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);

/** RGB565 -> 8-bit RGB as the host screenshots expand it ((c << 3) | (c >> 2), (c << 2) | (c >> 4)). */
export function expand565(v: number): Rgb {
  const r = v >> 11;
  const g = (v >> 5) & 63;
  const b = v & 31;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

const hex = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export interface Font {
  h: number;
  pad: number;
  first: number;
  last: number;
  off: number[];
  adv: number[];
  bw: number[];
  data: Uint8Array;
}

function font(f: { h: number; pad: number; first: number; last: number; off: number[]; adv: number[]; bw: number[]; data: string }): Font {
  return { ...f, data: hex(f.data) };
}

export const FONT_S: Font = font(ASSETS.fonts.S);
export const FONT_L: Font = font(ASSETS.fonts.L);

function glyph(f: Font, ch: string): number {
  let c = ch.charCodeAt(0);
  // FONT_L has capitals only: lower case draws as upper case, as gfx.c does
  if (c >= 97 && c <= 122 && f.last < 97) c -= 32;
  if (c < f.first || c > f.last) c = 63;
  return c - f.first;
}

export const textWidth = (s: string, f: Font = FONT_S): number => {
  let w = 0;
  for (const ch of s) w += f.adv[glyph(f, ch)] ?? 0;
  return w;
};

export type Pose = "work" | "wave" | "hand" | "dizzy" | "happy" | "sleep" | "huh" | "ghost";
export type Species = "claude" | "codex";
type SpriteTable = Record<Pose, Record<Species, Uint8Array[]>>;

const table = (t: Record<string, Record<string, string[]>>): SpriteTable => {
  const out = {} as SpriteTable;
  for (const [pose, byProvider] of Object.entries(t)) {
    out[pose as Pose] = { claude: (byProvider.claude ?? []).map(hex), codex: (byProvider.codex ?? []).map(hex) };
  }
  return out;
};

export const SPRITES = {
  source: ASSETS.sprites.source,
  hero: table(ASSETS.sprites.hero),
  mini: table(ASSETS.sprites.mini),
  basePal: ASSETS.sprites.basePal as number[],
  statePal: ASSETS.sprites.statePal as Record<string, number[]>,
  poseOfState: ASSETS.sprites.poseOfState as Record<string, Pose>,
  anim: ASSETS.sprites.anim as Record<Pose, { heroFrames: number; heroFps: number; miniFrames: number; miniFps: number }>,
};

/** The 16-entry sprite palette of a state: the fixed colours, with 13-15 the state's body, light and shade. */
export function spritePalette(state: string): number[] {
  const pal = SPRITES.basePal.slice(0, 16);
  while (pal.length < 16) pal.push(0);
  const body = SPRITES.statePal[state] ?? SPRITES.statePal.unknown ?? [0, 0, 0];
  pal[13] = body[0] ?? 0;
  pal[14] = body[1] ?? 0;
  pal[15] = body[2] ?? 0;
  return pal;
}

/** fm1c_anim.h FM1C_ANIM_PHASE_MS: frame edges fall 60 ms before whole seconds (0 and 500 ms are mid-frame). */
export const ANIM_PHASE_MS = 60;

/** `((now + 60) * fps / 1000) % frames`: every box in the same pose shows the same frame (fm1c_anim.h). */
export function animFrame(pose: Pose, which: "hero" | "mini", nowMs: number): number {
  const a = SPRITES.anim[pose];
  const n = which === "hero" ? a.heroFrames : a.miniFrames;
  const fps = which === "hero" ? a.heroFps : a.miniFps;
  if (n <= 1 || fps === 0) return 0;
  return Math.floor(((Math.max(0, nowMs) + ANIM_PHASE_MS) * fps) / 1000) % n;
}

export class Framebuffer {
  readonly w: number;
  readonly h: number;
  readonly px: Uint16Array;

  constructor(w = 240, h = 240) {
    this.w = w;
    this.h = h;
    this.px = new Uint16Array(w * h);
  }

  pset(x: number, y: number, c: number): void {
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.px[y * this.w + x] = c;
  }

  get(x: number, y: number): number {
    return this.px[y * this.w + x] ?? 0;
  }

  rect(x: number, y: number, w: number, h: number, c: number): void {
    const x0 = Math.max(0, x);
    const x1 = Math.min(this.w, x + w);
    for (let yy = Math.max(0, y); yy < Math.min(this.h, y + h); yy++) this.px.fill(c, yy * this.w + x0, yy * this.w + Math.max(x0, x1));
  }

  frame(x: number, y: number, w: number, h: number, t: number, c: number): void {
    this.rect(x, y, w, t, c);
    this.rect(x, y + h - t, w, t, c);
    this.rect(x, y, t, h, c);
    this.rect(x + w - t, y, t, h, c);
  }

  /** 1 px frame with cut corners (a cheap rounded box), optionally filled. */
  rframe(x: number, y: number, w: number, h: number, c: number, fill?: number): void {
    if (fill !== undefined) this.rect(x + 1, y + 1, w - 2, h - 2, fill);
    this.rect(x + 2, y, w - 4, 1, c);
    this.rect(x + 2, y + h - 1, w - 4, 1, c);
    this.rect(x, y + 2, 1, h - 4, c);
    this.rect(x + w - 1, y + 2, 1, h - 4, c);
    this.rect(x + 1, y + 1, 1, 1, c);
    this.rect(x + w - 2, y + 1, 1, 1, c);
    this.rect(x + 1, y + h - 2, 1, 1, c);
    this.rect(x + w - 2, y + h - 2, 1, 1, c);
  }

  /** gfx.c cv_text: the alpha ramp on black; returns the x after the text. */
  text(x: number, y: number, s: string, c: number, f: Font = FONT_S): number {
    const r = c >> 11;
    const g = (c >> 5) & 63;
    const b = c & 31;
    const ramp: number[] = [];
    for (let a = 0; a < 16; a++) ramp.push((Math.floor((r * a) / 15) << 11) | (Math.floor((g * a) / 15) << 5) | Math.floor((b * a) / 15));
    let cx = x;
    for (const ch of s) {
      const gi = glyph(f, ch);
      const w = f.bw[gi] ?? 0;
      const bpr = (w + 1) >> 1;
      const base = f.off[gi] ?? 0;
      for (let gy = 0; gy < f.h; gy++) {
        for (let gx = 0; gx < w; gx++) {
          const byte = f.data[base + gy * bpr + (gx >> 1)] ?? 0;
          const v = gx & 1 ? byte & 15 : byte >> 4;
          if (v) this.pset(cx - f.pad + gx, y + gy, ramp[v] ?? c);
        }
      }
      cx += f.adv[gi] ?? 0;
    }
    return cx;
  }

  /**
   * Protocol version 7 (docs/ui-v3.md section 13.5): a SET_TEXT row with inline control bytes, FONT_S. 0x01 switches to
   * `colors.bold`, 0x02 to `colors.code`, 0x03 back to `c`; none takes a column. 0x04 is one 8 px cell with a 1 px
   * vertical rule at x + 3, y 0-15 in `colors.rule`. Any other byte is a glyph. At most `maxCols` visible cells are
   * drawn (the firmware's per-region cut). Returns the x after the text.
   */
  richText(x: number, y: number, s: string, c: number, colors: { bold: number; code: number; rule: number }, maxCols = Number.MAX_SAFE_INTEGER): number {
    let cx = x;
    let color = c;
    let cols = 0;
    for (const ch of s) {
      const b = ch.charCodeAt(0);
      if (b === 0x01) color = colors.bold;
      else if (b === 0x02) color = colors.code;
      else if (b === 0x03) color = c;
      else {
        if (cols >= maxCols) break;
        cols++;
        if (b === 0x04) {
          this.rect(cx + 3, y, 1, 16, colors.rule);
          cx += FONT_S.adv[0] ?? 8;
        } else cx = this.text(cx, y, ch, color);
      }
    }
    return cx;
  }

  /** A 4 bpp sprite (2 pixels per byte, high nibble first), index 0 transparent, drawn `scale` times. */
  sprite(x: number, y: number, px4: Uint8Array, n: number, pal: readonly number[], scale = 1): void {
    for (let sy = 0; sy < n; sy++) {
      for (let sx = 0; sx < n; sx++) {
        const byte = px4[(sy * n + sx) >> 1] ?? 0;
        const v = sx & 1 ? byte & 15 : byte >> 4;
        if (!v) continue;
        const c = pal[v] ?? 0;
        if (scale === 1) this.pset(x + sx, y + sy, c);
        else this.rect(x + sx * scale, y + sy * scale, scale, scale, c);
      }
    }
  }

  /** The firmware's dim: every channel to a quarter (r >> 2, g >> 2, b >> 2). */
  dim(): void {
    for (let i = 0; i < this.px.length; i++) {
      const c = this.px[i] ?? 0;
      this.px[i] = ((c >> 13) << 11) | (((c >> 7) & 15) << 5) | ((c & 31) >> 2);
    }
  }

  /** RGBA bytes for a canvas ImageData. */
  rgba(): Uint8ClampedArray {
    const out = new Uint8ClampedArray(this.w * this.h * 4);
    for (let i = 0; i < this.px.length; i++) {
      const [r, g, b] = expand565(this.px[i] ?? 0);
      out[i * 4] = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = b;
      out[i * 4 + 3] = 255;
    }
    return out;
  }
}
