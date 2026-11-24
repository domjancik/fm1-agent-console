/**
 * A small headless VT emulator: enough of xterm to rebuild the visible screen of a Traycer terminal (TUI) agent from
 * `terminal.subscribe` frames, so the typing route can tell whether the TUI sits at its idle input prompt.
 *
 * Observed (host 1.5.4, `terminal.subscribe@1.7`): the snapshot is not raw PTY history but an xterm-serialized screen
 * (`ESC[?1049h ESC[H`, rows joined by CR LF, `ESC[nC` for runs of blanks, SGR colors, a final cursor move and the
 * active modes such as `ESC[?2004h`). Live `data` chunks are the TUI's own incremental redraws. Both go through
 * `write()`.
 *
 * Handled: printable text (UTF-8, wide East Asian/emoji cells), CR, LF, BS, TAB, CSI cursor moves (A B C D E F G H f d
 * `), erase (J K X), insert/delete (@ P L M), scroll (S T, DECSTBM r), SGR (only faint/gray foreground is kept, to tell
 * placeholder text from typed text), DECSC/DECRC (ESC 7/8, CSI s/u), alternate screen (?1049/?1047/?47), DECAWM (?7),
 * bracketed paste mode (?2004, recorded), OSC/DCS/APC/PM/SOS strings (skipped). Everything else is ignored.
 */
export interface ScreenCell {
  ch: string;
  /** Written with SGR 2 (faint) or a gray foreground: placeholder or hint text, not user input. */
  faint: boolean;
}

const BLANK = (): ScreenCell => ({ ch: " ", faint: false });

/** Display width of one code point: 0 for combining marks, 2 for wide East Asian and most emoji, else 1. */
export function cellWidth(cp: number): 0 | 1 | 2 {
  if (cp === 0x200d || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x20d0 && cp <= 0x20ff)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

type Mode = "ground" | "esc" | "csi" | "osc" | "string" | "charset";

export class TerminalScreen {
  private cols: number;
  private rows: number;
  private main: ScreenCell[][];
  private alt: ScreenCell[][];
  private useAlt = false;
  private x = 0;
  private y = 0;
  private pendingWrap = false;
  private saved = { x: 0, y: 0 };
  private top = 0;
  private bottom: number;
  private autowrap = true;
  private faint = false;
  private grayFg = false;
  private mode: Mode = "ground";
  private csi = "";
  private stringEsc = false;
  private readonly decoder = new TextDecoder("utf-8");
  /** DEC private modes seen set (`h`) or reset (`l`), e.g. 2004 = bracketed paste. */
  readonly privateModes = new Map<number, boolean>();

  constructor(cols: number, rows: number) {
    this.cols = Math.max(1, Math.floor(cols));
    this.rows = Math.max(1, Math.floor(rows));
    this.bottom = this.rows - 1;
    this.main = this.grid();
    this.alt = this.grid();
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  get cursor(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  /** True when the TUI turned on bracketed paste (`ESC[?2004h`). */
  get bracketedPaste(): boolean {
    return this.privateModes.get(2004) === true;
  }

  /** Resets the grid to a new size (a `resized` frame or a fresh snapshot); content is cleared. */
  resize(cols: number, rows: number): void {
    this.cols = Math.max(1, Math.floor(cols));
    this.rows = Math.max(1, Math.floor(rows));
    this.top = 0;
    this.bottom = this.rows - 1;
    this.main = this.grid();
    this.alt = this.grid();
    this.x = Math.min(this.x, this.cols - 1);
    this.y = Math.min(this.y, this.rows - 1);
    this.pendingWrap = false;
  }

  /** Clears everything (a new snapshot replaces the screen). */
  reset(): void {
    this.resize(this.cols, this.rows);
    this.useAlt = false;
    this.x = 0;
    this.y = 0;
    this.faint = false;
    this.grayFg = false;
    this.mode = "ground";
    this.csi = "";
    this.privateModes.clear();
  }

  write(data: string | Uint8Array): void {
    const text = typeof data === "string" ? data : this.decoder.decode(data, { stream: true });
    for (const ch of text) this.feed(ch);
  }

  /** The visible rows, right-trimmed. A wide character's second cell is omitted. */
  lines(): string[] {
    return this.screen().map((row) => row.map((c) => c.ch).join("").replace(/[\s ]+$/u, ""));
  }

  /** The visible rows as cells (read-only use). */
  cells(): readonly (readonly ScreenCell[])[] {
    return this.screen();
  }

  private grid(): ScreenCell[][] {
    return Array.from({ length: this.rows }, () => this.blankRow());
  }

  private blankRow(): ScreenCell[] {
    return Array.from({ length: this.cols }, BLANK);
  }

  private screen(): ScreenCell[][] {
    return this.useAlt ? this.alt : this.main;
  }

  private feed(ch: string): void {
    switch (this.mode) {
      case "ground":
        return this.ground(ch);
      case "esc":
        return this.escape(ch);
      case "csi": {
        const code = ch.charCodeAt(0);
        if (code >= 0x40 && code <= 0x7e) {
          this.mode = "ground";
          this.dispatchCsi(this.csi, ch);
          this.csi = "";
        } else if (code === 0x1b) {
          this.mode = "esc";
          this.csi = "";
        } else {
          this.csi += ch;
          if (this.csi.length > 64) {
            this.mode = "ground";
            this.csi = "";
          }
        }
        return;
      }
      case "osc":
      case "string":
        // Ends at BEL (OSC only) or ST (ESC \).
        if (ch === "\x07" && this.mode === "osc") {
          this.mode = "ground";
        } else if (this.stringEsc) {
          this.stringEsc = false;
          if (ch === "\\") this.mode = "ground";
        } else if (ch === "\x1b") {
          this.stringEsc = true;
        }
        return;
      case "charset":
        this.mode = "ground";
        return;
    }
  }

  private ground(ch: string): void {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x1b) {
      this.mode = "esc";
      return;
    }
    if (code < 0x20 || code === 0x7f) {
      switch (code) {
        case 0x0d:
          this.x = 0;
          this.pendingWrap = false;
          return;
        case 0x0a:
        case 0x0b:
        case 0x0c:
          this.lineFeed();
          return;
        case 0x08:
          this.pendingWrap = false;
          this.x = Math.max(0, this.x - 1);
          return;
        case 0x09:
          this.pendingWrap = false;
          this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8);
          return;
        default:
          return;
      }
    }
    this.print(ch, code);
  }

  private print(ch: string, code: number): void {
    const width = cellWidth(code);
    const screen = this.screen();
    if (width === 0) {
      // Combining mark / variation selector / ZWJ: attach to the previous cell.
      const px = this.pendingWrap ? this.x : this.x - 1;
      const row = screen[this.y];
      if (row !== undefined && px >= 0 && row[px] !== undefined) (row[px] as ScreenCell).ch += ch;
      return;
    }
    if (this.pendingWrap) {
      this.pendingWrap = false;
      this.x = 0;
      this.lineFeed();
    }
    if (width === 2 && this.x === this.cols - 1) {
      if (this.autowrap) {
        this.x = 0;
        this.lineFeed();
      } else return;
    }
    const row = screen[this.y] as ScreenCell[];
    row[this.x] = { ch, faint: this.faint || this.grayFg };
    if (width === 2 && this.x + 1 < this.cols) row[this.x + 1] = { ch: "", faint: this.faint || this.grayFg };
    const next = this.x + width;
    if (next >= this.cols) {
      this.x = this.cols - 1;
      this.pendingWrap = this.autowrap;
    } else this.x = next;
  }

  private lineFeed(): void {
    this.pendingWrap = false;
    if (this.y === this.bottom) this.scrollUp(1);
    else if (this.y < this.rows - 1) this.y++;
  }

  /** Rows in the scroll region: no count beyond it changes the screen (bounds `ESC[999999999S` and friends). */
  private regionRows(n: number): number {
    return Math.max(0, Math.min(n, this.bottom - this.top + 1));
  }

  /** Puts the cursor back inside the grid (a saved position can lie outside it after a resize). */
  private restore(pos: { x: number; y: number }): void {
    this.x = Math.max(0, Math.min(this.cols - 1, pos.x));
    this.y = Math.max(0, Math.min(this.rows - 1, pos.y));
    this.pendingWrap = false;
  }

  private scrollUp(count: number): void {
    const screen = this.screen();
    const n = this.regionRows(count);
    for (let i = 0; i < n; i++) {
      screen.splice(this.top, 1);
      screen.splice(this.bottom, 0, this.blankRow());
    }
  }

  private scrollDown(count: number): void {
    const screen = this.screen();
    const n = this.regionRows(count);
    for (let i = 0; i < n; i++) {
      screen.splice(this.bottom, 1);
      screen.splice(this.top, 0, this.blankRow());
    }
  }

  private escape(ch: string): void {
    this.mode = "ground";
    switch (ch) {
      case "[":
        this.mode = "csi";
        this.csi = "";
        return;
      case "]":
        this.mode = "osc";
        this.stringEsc = false;
        return;
      case "P":
      case "_":
      case "^":
      case "X":
        this.mode = "string";
        this.stringEsc = false;
        return;
      case "(":
      case ")":
      case "*":
      case "+":
        this.mode = "charset";
        return;
      case "7":
        this.saved = { x: this.x, y: this.y };
        return;
      case "8":
        this.restore(this.saved);
        return;
      case "D":
        this.lineFeed();
        return;
      case "E":
        this.x = 0;
        this.lineFeed();
        return;
      case "M":
        this.pendingWrap = false;
        if (this.y === this.top) this.scrollDown(1);
        else if (this.y > 0) this.y--;
        return;
      case "c":
        this.reset();
        return;
      default:
        return;
    }
  }

  private dispatchCsi(body: string, final: string): void {
    const prefix = /^[?>=<]/.test(body) ? body[0] : "";
    const paramText = (prefix ? body.slice(1) : body).replace(/[ -/]+$/, "");
    const params = paramText.length === 0 ? [] : paramText.split(";").map((p) => (p === "" ? NaN : Number(p.split(":")[0])));
    const p = (i: number, dflt: number): number => {
      const v = params[i];
      return v === undefined || Number.isNaN(v) || v === 0 ? dflt : v;
    };
    if (prefix === "?") {
      if (final === "h" || final === "l") this.privateMode(params, final === "h");
      return;
    }
    if (prefix !== "") return; // kitty keyboard (`=`/`>`/`<` ... u), device attributes: no screen effect
    const clampY = (v: number): number => Math.max(0, Math.min(this.rows - 1, v));
    const clampX = (v: number): number => Math.max(0, Math.min(this.cols - 1, v));
    const screen = this.screen();
    const row = (): ScreenCell[] => screen[this.y] as ScreenCell[];
    if (final !== "m") this.pendingWrap = false;
    switch (final) {
      case "A":
        this.y = Math.max(this.y >= this.top ? this.top : 0, this.y - p(0, 1));
        return;
      case "B":
      case "e":
        this.y = Math.min(this.y <= this.bottom ? this.bottom : this.rows - 1, this.y + p(0, 1));
        return;
      case "C":
      case "a":
        this.x = clampX(this.x + p(0, 1));
        return;
      case "D":
        this.x = clampX(this.x - p(0, 1));
        return;
      case "E":
        this.x = 0;
        this.y = clampY(this.y + p(0, 1));
        return;
      case "F":
        this.x = 0;
        this.y = clampY(this.y - p(0, 1));
        return;
      case "G":
      case "`":
        this.x = clampX(p(0, 1) - 1);
        return;
      case "d":
        this.y = clampY(p(0, 1) - 1);
        return;
      case "H":
      case "f":
        this.y = clampY(p(0, 1) - 1);
        this.x = clampX(p(1, 1) - 1);
        return;
      case "J": {
        const mode = params[0] ?? 0;
        if (mode === 2 || mode === 3) {
          for (let i = 0; i < this.rows; i++) screen[i] = this.blankRow();
        } else if (mode === 1) {
          for (let i = 0; i < this.y; i++) screen[i] = this.blankRow();
          for (let i = 0; i <= this.x; i++) row()[i] = BLANK();
        } else {
          for (let i = this.x; i < this.cols; i++) row()[i] = BLANK();
          for (let i = this.y + 1; i < this.rows; i++) screen[i] = this.blankRow();
        }
        return;
      }
      case "K": {
        const mode = params[0] ?? 0;
        const [from, to] = mode === 1 ? [0, this.x] : mode === 2 ? [0, this.cols - 1] : [this.x, this.cols - 1];
        for (let i = from; i <= to; i++) row()[i] = BLANK();
        return;
      }
      case "X":
        for (let i = this.x; i < Math.min(this.cols, this.x + p(0, 1)); i++) row()[i] = BLANK();
        return;
      case "@": {
        const n = Math.min(p(0, 1), this.cols - this.x);
        const r = row();
        r.splice(this.x, 0, ...Array.from({ length: n }, BLANK));
        r.length = this.cols;
        return;
      }
      case "P": {
        const n = Math.min(p(0, 1), this.cols - this.x);
        const r = row();
        r.splice(this.x, n);
        while (r.length < this.cols) r.push(BLANK());
        return;
      }
      case "L":
        if (this.y >= this.top && this.y <= this.bottom) {
          for (let i = 0, n = Math.min(p(0, 1), this.bottom - this.y + 1); i < n; i++) {
            screen.splice(this.bottom, 1);
            screen.splice(this.y, 0, this.blankRow());
          }
        }
        return;
      case "M":
        if (this.y >= this.top && this.y <= this.bottom) {
          for (let i = 0, n = Math.min(p(0, 1), this.bottom - this.y + 1); i < n; i++) {
            screen.splice(this.y, 1);
            screen.splice(this.bottom, 0, this.blankRow());
          }
        }
        return;
      case "S":
        this.scrollUp(p(0, 1));
        return;
      case "T":
        this.scrollDown(p(0, 1));
        return;
      case "r": {
        const t = p(0, 1) - 1;
        const b = p(1, this.rows) - 1;
        if (t < b && b < this.rows) {
          this.top = t;
          this.bottom = b;
          this.x = 0;
          this.y = 0;
        }
        return;
      }
      case "s":
        this.saved = { x: this.x, y: this.y };
        return;
      case "u":
        this.restore(this.saved);
        return;
      case "m":
        this.sgr(params);
        return;
      default:
        return;
    }
  }

  private privateMode(params: number[], on: boolean): void {
    for (const mode of params) {
      if (Number.isNaN(mode)) continue;
      this.privateModes.set(mode, on);
      if (mode === 7) this.autowrap = on;
      if (mode === 1049 || mode === 1047 || mode === 47) {
        if (on && !this.useAlt) {
          if (mode === 1049) this.saved = { x: this.x, y: this.y };
          this.useAlt = true;
          this.alt = this.grid();
        } else if (!on && this.useAlt) {
          this.useAlt = false;
          if (mode === 1049) this.restore(this.saved);
        }
      }
    }
  }

  private sgr(params: number[]): void {
    if (params.length === 0) params = [0];
    for (let i = 0; i < params.length; i++) {
      const v = Number.isNaN(params[i] as number) ? 0 : (params[i] as number);
      if (v === 0) {
        this.faint = false;
        this.grayFg = false;
      } else if (v === 2) this.faint = true;
      else if (v === 22) this.faint = false;
      else if (v === 90) this.grayFg = true;
      else if (v === 39 || (v >= 30 && v <= 37) || (v >= 91 && v <= 97)) this.grayFg = false;
      else if (v === 38) {
        const kind = params[i + 1];
        if (kind === 5) {
          const n = params[i + 2] ?? 0;
          this.grayFg = n === 8 || n === 59 || n === 102 || (n >= 238 && n <= 250);
          i += 2;
        } else if (kind === 2) {
          const [r, g, b] = [params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0];
          this.grayFg = Math.abs(r - g) < 12 && Math.abs(g - b) < 12 && r >= 80 && r <= 180;
          i += 4;
        }
      } else if (v === 48) {
        const kind = params[i + 1];
        i += kind === 5 ? 2 : kind === 2 ? 4 : 0;
      }
    }
  }
}
