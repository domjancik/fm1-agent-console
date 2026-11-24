// Markdown on the console screen (docs/ui-v3.md section 13). Pure, ASCII only, no dependencies.
//
// Two steps, so every adapter and the mock share one reading of a message:
//  1. `markdownBlocks(source)`: the message's structure, independent of any width (adapters store it in
//     `SessionDetails.lastBlocks`; the source is redacted and ASCII-folded by the adapter first).
//  2. `layoutMarkdown(blocks, width)`: SET_TEXT rows of at most `width` visible characters, each with one style
//     (body / heading / muted) and inline spans (bold, code, table rules). Spans reach the device only with protocol
//     version 7 (docs/protocol.md); below it the rows' plain text is exactly what is drawn.

/** Highlights inside a row. `rule` is one cell of a table's column gap (a space below version 7). */
export type SpanMark = "bold" | "code" | "rule";

/** `text.slice(start, end)` of a row carries `mark`. Spans never overlap; `start < end <= text.length`. */
export interface TextSpan {
  start: number;
  end: number;
  mark: SpanMark;
}

export type InlineMark = "bold" | "code";
export interface Inline {
  text: string;
  mark?: InlineMark;
}

/**
 * One block of a message. `para`, `quote` and `item` are one source line each (line breaks are kept); `gap` is a blank
 * line between blocks (runs collapsed, never first or last).
 */
export type MdBlock =
  | { kind: "gap" }
  | { kind: "heading"; inline: Inline[] }
  | { kind: "para"; inline: Inline[] }
  | { kind: "item"; depth: number; marker: string; inline: Inline[] }
  | { kind: "quote"; inline: Inline[] }
  | { kind: "code"; lines: string[] }
  | { kind: "table"; header: string[]; rows: string[][] };

export interface MarkdownRow {
  style: "body" | "heading" | "muted";
  text: string;
  spans?: TextSpan[];
}

/** Source characters kept (after redaction and folding): enough for the bubble and 8 DETAILS pages. */
export const MARKDOWN_SOURCE_MAX = 2000;
/** Rows one message may fill (8 DETAILS pages of 12 rows). */
export const MARKDOWN_ROWS_MAX = 96;
/** Bold / code spans per row (each costs two control bytes on the wire, docs/protocol.md version 7). */
export const SPANS_PER_ROW_MAX = 4;
/** Deepest list nesting drawn (2 columns per level). */
export const LIST_DEPTH_MAX = 3;
/** The bullet: FONT_S has ASCII 32-126 only (firmware/firmware/gen/felucca_font.h), so no U+2022. */
export const BULLET = "-";
/** The quote bar and the cut marker of a code line wider than the row. */
export const QUOTE_PREFIX = "| ";
export const CODE_CUT = "~";

// ---------------------------------------------------------------------------------------------------------------
// Source clean-up

/** CRLF/CR -> LF, tab -> 4 spaces, anything outside printable ASCII and LF -> space; trailing spaces per line dropped. */
function normalise(source: string): string {
  return source
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[^\x20-\x7e\n]/g, " ")
    .replace(/ +$/gm, "");
}

/** At most `max` characters, cut at the last line break when one is past the middle. */
function capSource(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const nl = head.lastIndexOf("\n");
  return nl > max / 2 ? head.slice(0, nl) : head;
}

// ---------------------------------------------------------------------------------------------------------------
// Inline: code spans, links, images, emphasis

/**
 * Common HTML tags only: anything else in angle brackets stays literal (`<redacted>` from the secret filter,
 * `Array<string>`, `<file>`).
 */
const HTML_TAG =
  /<\/?(?:a|abbr|b|blockquote|br|center|code|dd|del|details|div|dl|dt|em|font|h[1-6]|hr|i|img|ins|kbd|li|mark|ol|p|pre|s|samp|small|span|strike|strong|sub|summary|sup|table|tbody|td|tfoot|th|thead|tr|tt|u|ul|var)(?:\s[^<>]*)?\/?>/gi;

// Private-use placeholders (the source is ASCII by now): escaped punctuation, then code spans.
const ESC = 0xf000;
const CODE = 0xe000;

/** Inline Markdown to text runs: code spans and bold kept as marks; links -> label, images and HTML tags dropped. */
export function parseInline(src: string): Inline[] {
  // 1. Backslash escapes become placeholders, so `\*` is never emphasis.
  let s = src.replace(/\\([!-/:-@[-`{-~])/g, (_m, c: string) => String.fromCharCode(ESC + c.charCodeAt(0)));
  // 2. Code spans (a run of n backticks to the next run of exactly n) become one placeholder each.
  const codes: string[] = [];
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_m, _ticks: string, body: string) => {
    codes.push(body.length > 2 && body.startsWith(" ") && body.endsWith(" ") ? body.slice(1, -1) : body);
    return String.fromCharCode(CODE + codes.length - 1);
  });
  // 3. Images go, links keep their label, autolinks their address, HTML tags go (<br> is a space), ~~x~~ -> x.
  s = s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<((?:https?|mailto|ftp):[^>\s]+)>/g, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(HTML_TAG, "")
    .replace(/~~(?=\S)(.+?)~~/g, "$1");
  // 4. Bold pairs over the whole line (so `**`code`**` stays bold around the code).
  const pieces: Inline[] = [];
  const BOLD = /(\*\*\*|\*\*)(?=\S)(.+?)(?<=\S)\1|(?<![A-Za-z0-9])(___|__)(?=\S)(.+?)(?<=\S)\3(?![A-Za-z0-9])/g;
  let at = 0;
  for (let m = BOLD.exec(s); m !== null; m = BOLD.exec(s)) {
    if (m.index > at) pieces.push({ text: s.slice(at, m.index) });
    pieces.push({ text: m[2] ?? m[4] ?? "", mark: "bold" });
    at = m.index + m[0].length;
  }
  if (at < s.length) pieces.push({ text: s.slice(at) });
  // 5. Italic markers go (the words stay); 6. code placeholders split out as code runs; 7. escapes restored.
  const out: Inline[] = [];
  const restore = (t: string): string => t.replace(/[-]/g, (c) => String.fromCharCode(c.charCodeAt(0) - ESC));
  const push = (text: string, mark?: InlineMark): void => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.mark === mark) last.text += text;
    else out.push(mark ? { text, mark } : { text });
  };
  for (const p of pieces) {
    const t = p.text
      .replace(/(^|[^A-Za-z0-9*])\*(?=[^\s*])([^*]*?[^\s*])\*(?![A-Za-z0-9*])/g, "$1$2")
      .replace(/(^|[^A-Za-z0-9_])_(?=[^\s_])([^_]*?[^\s_])_(?![A-Za-z0-9_])/g, "$1$2")
      .replace(/\*{3}/g, "");
    let from = 0;
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i);
      if (c < CODE || c >= CODE + codes.length) continue;
      push(restore(t.slice(from, i)), p.mark);
      push(restore(codes[c - CODE] ?? ""), "code");
      from = i + 1;
    }
    push(restore(t.slice(from)), p.mark);
  }
  return out;
}

/** The inline runs as plain text. */
export const inlineText = (inline: readonly Inline[]): string => inline.map((r) => r.text).join("");

/** True when every non-space character is bold (a line that is entirely bold reads as a heading). */
const allBold = (inline: readonly Inline[]): boolean =>
  inline.some((r) => r.mark === "bold" && r.text.trim() !== "") && inline.every((r) => r.mark === "bold" || r.text.trim() === "");

const unmark = (inline: readonly Inline[]): Inline[] => [{ text: inlineText(inline) }];

// ---------------------------------------------------------------------------------------------------------------
// Blocks

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const RULE_LINE = /^ {0,3}([-*_])(?: *\1){2,} *$/;
const SETEXT = /^ {0,3}(=+|-+) *$/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?: +(.*))?$/;
const QUOTE = /^ {0,3}>/;
const TABLE_SEP = /^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/;

/** Cells of a table row: outer pipes dropped, `\|` kept as a pipe, inline Markdown reduced to text. */
function cells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  return t
    .split(/(?<!\\)\|/)
    .map((c) => inlineText(parseInline(c.replace(/\\\|/g, "|").trim())).replace(/ +/g, " ").trim());
}

const isTableStart = (line: string, next: string | undefined): boolean =>
  line.includes("|") && next !== undefined && next.includes("-") && TABLE_SEP.test(next) && (next.includes("|") || line.trim().startsWith("|"));

/** The message's blocks (docs/ui-v3.md section 13.2). `source` is capped at MARKDOWN_SOURCE_MAX characters first. */
export function markdownBlocks(source: string, max: number = MARKDOWN_SOURCE_MAX): MdBlock[] {
  const lines = capSource(normalise(source), max).split("\n");
  const out: MdBlock[] = [];
  let gap = false;
  const emit = (b: MdBlock): void => {
    if (gap && out.length > 0) out.push({ kind: "gap" });
    gap = false;
    out.push(b);
  };
  /** The previous block may take a lazy continuation line (a paragraph line or a list item). */
  let open: "para" | "item" | "quote" | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      gap = true;
      open = null;
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence && !(fence[2]?.startsWith("`") && (fence[3] ?? "").includes("`"))) {
      const mark = fence[2] ?? "```";
      const indent = (fence[1] ?? "").length;
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const l = lines[i] ?? "";
        const close = /^ {0,3}(`{3,}|~{3,}) *$/.exec(l);
        if (close && close[1]?.[0] === mark[0] && (close[1]?.length ?? 0) >= mark.length) {
          i++;
          break;
        }
        body.push(l.replace(new RegExp(`^ {0,${indent}}`), ""));
        i++;
      }
      emit({ kind: "code", lines: collapseBlank(body) });
      open = null;
      continue;
    }
    // Indented code: 4 spaces, not continuing a paragraph or list item (and not a nested item of the list above).
    const last = out[out.length - 1];
    if (open === null && /^ {4}/.test(line) && !(last?.kind === "item" && ITEM.test(line))) {
      const body: string[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? "";
        if (/^ {4}/.test(l)) body.push(l.slice(4));
        else if (l.trim() === "" && /^ {4}/.test(lines.slice(i).find((x) => x.trim() !== "") ?? "")) body.push("");
        else break;
        i++;
      }
      emit({ kind: "code", lines: collapseBlank(body) });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      emit({ kind: "heading", inline: unmark(parseInline(heading[2] ?? "")) });
      open = null;
      i++;
      continue;
    }
    // Setext underline under a paragraph line: that line becomes a heading.
    const prev = out[out.length - 1];
    if (open === "para" && prev?.kind === "para" && SETEXT.test(line)) {
      out[out.length - 1] = { kind: "heading", inline: unmark(prev.inline) };
      open = null;
      i++;
      continue;
    }
    if (RULE_LINE.test(line)) {
      gap = true;
      open = null;
      i++;
      continue;
    }
    if (isTableStart(line, lines[i + 1])) {
      const header = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim() !== "") {
        const r = cells(lines[i] ?? "");
        rows.push(header.map((_h, n) => r[n] ?? ""));
        i++;
      }
      emit({ kind: "table", header, rows });
      open = null;
      continue;
    }
    if (QUOTE.test(line)) {
      const text = line.replace(/^(?: {0,3}> ?)+/, "");
      if (text.trim() === "") gap = true;
      else emit({ kind: "quote", inline: parseInline(text.trim()) });
      open = "quote";
      i++;
      continue;
    }
    const item = ITEM.exec(line);
    if (item && (item[3] !== undefined || open !== "para")) {
      const indent = (item[1] ?? "").length;
      const raw = item[2] ?? "-";
      const marker = /^\d/.test(raw) ? raw : BULLET;
      const depth = Math.min(LIST_DEPTH_MAX, Math.floor(indent / 2));
      // Consecutive items belong together: no gap row between them even after a blank line inside the list.
      if (gap && prev?.kind === "item") gap = false;
      emit({ kind: "item", depth, marker, inline: parseInline((item[3] ?? "").trim()) });
      open = "item";
      i++;
      continue;
    }
    if (open === "item" && prev?.kind === "item") {
      // A wrapped list item: the line joins it.
      out[out.length - 1] = { ...prev, inline: joinInline(prev.inline, parseInline(line.trim())) };
      i++;
      continue;
    }
    const inline = parseInline(line.trim());
    // A line of only an image or a tag says nothing on the screen.
    if (inlineText(inline).trim() === "") {
      i++;
      continue;
    }
    emit(allBold(inline) ? { kind: "heading", inline: unmark(inline) } : { kind: "para", inline });
    open = "para";
    i++;
  }
  return out;
}

const collapseBlank = (lines: string[]): string[] => {
  const out: string[] = [];
  for (const l of lines) if (l.trim() !== "" || (out.length > 0 && out[out.length - 1] !== "")) out.push(l.trim() === "" ? "" : l);
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
};

const joinInline = (a: readonly Inline[], b: readonly Inline[]): Inline[] => {
  const out = a.map((r) => ({ ...r }));
  const glue = (r: Inline): void => {
    const last = out[out.length - 1];
    if (last && last.mark === r.mark) last.text += r.text;
    else out.push({ ...r });
  };
  glue({ text: " " });
  for (const r of b) glue(r);
  return out;
};

/** The blocks as one line of plain text (the `lastMessage` form): words only, single spaces. */
export function blocksPlain(blocks: readonly MdBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.kind === "gap") continue;
    if (b.kind === "code") parts.push(...b.lines);
    else if (b.kind === "table") parts.push(b.header.join(" "), ...b.rows.map((r) => r.join(" ")));
    else if (b.kind === "item") parts.push(`${b.marker} ${inlineText(b.inline)}`);
    else parts.push(inlineText(b.inline));
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------------------------------------------
// Layout

type Cell = { ch: string; mark: InlineMark | undefined };

/** Runs of marked characters as spans: at most SPANS_PER_ROW_MAX bold/code spans (later ones drawn plain). */
function spansOf(cellsRow: readonly Cell[], offset: number): TextSpan[] {
  const out: TextSpan[] = [];
  let i = 0;
  while (i < cellsRow.length) {
    const mark = cellsRow[i]?.mark;
    if (mark === undefined) {
      i++;
      continue;
    }
    let j = i;
    while (j < cellsRow.length && cellsRow[j]?.mark === mark) j++;
    // A span never starts or ends on a space (cheaper on the wire, same picture).
    let a = i;
    let b = j;
    while (a < b && cellsRow[a]?.ch === " ") a++;
    while (b > a && cellsRow[b - 1]?.ch === " ") b--;
    if (b > a && out.length < SPANS_PER_ROW_MAX) out.push({ start: offset + a, end: offset + b, mark });
    i = j;
  }
  return out;
}

/**
 * Greedy word wrap of marked text: `first` columns on the first row, `rest` on the others. A word longer than the row is
 * split at the row width. Spaces collapse to one.
 */
function wrapCells(inline: readonly Inline[], first: number, rest: number): Cell[][] {
  const words: Cell[][] = [];
  let word: Cell[] = [];
  for (const r of inline) {
    for (const ch of r.text) {
      if (ch === " ") {
        if (word.length > 0) words.push(word);
        word = [];
      } else word.push({ ch, mark: r.mark });
    }
  }
  if (word.length > 0) words.push(word);
  const rows: Cell[][] = [];
  let line: Cell[] = [];
  const width = (): number => Math.max(1, rows.length === 0 ? first : rest);
  for (let w of words) {
    for (;;) {
      const room = width() - (line.length > 0 ? line.length + 1 : 0);
      if (w.length <= room) {
        if (line.length > 0) {
          // The space between two words keeps the mark when both sides have it (one span over `a b`).
          const prev = line[line.length - 1]?.mark;
          line.push({ ch: " ", mark: prev !== undefined && prev === w[0]?.mark ? prev : undefined });
        }
        line.push(...w);
        break;
      }
      if (line.length > 0) {
        rows.push(line);
        line = [];
        continue;
      }
      // A word longer than the whole row: cut at the row width.
      rows.push(w.slice(0, width()));
      w = w.slice(width());
      if (w.length === 0) break;
    }
  }
  if (line.length > 0) rows.push(line);
  return rows;
}

/** Rows of one inline block with a prefix on the first row and a hanging indent on the others. */
function wrapBlock(inline: readonly Inline[], width: number, style: MarkdownRow["style"], prefix: string, hang: string): MarkdownRow[] {
  const rows = wrapCells(inline, width - prefix.length, width - hang.length);
  return rows.map((cellsRow, n) => {
    const lead = n === 0 ? prefix : hang;
    const row: MarkdownRow = { style, text: lead + cellsRow.map((c) => c.ch).join("") };
    const spans = spansOf(cellsRow, lead.length);
    if (spans.length > 0) row.spans = spans;
    return row;
  });
}

/** A code line: kept as is (no joining), cut with CODE_CUT when wider than the row; one code span over its text. */
function codeRow(line: string, width: number): MarkdownRow {
  const text = line.length > width ? `${line.slice(0, Math.max(0, width - CODE_CUT.length))}${CODE_CUT}` : line;
  const row: MarkdownRow = { style: "muted", text };
  const a = text.length - text.trimStart().length;
  const b = text.trimEnd().length;
  if (b > a) row.spans = [{ start: a, end: b, mark: "code" }];
  return row;
}

/**
 * A table (docs/ui-v3.md section 13.3): aligned columns with 1-column gaps when every column fits (the header row in
 * the heading style; each gap carries a `rule` span), else one record per row: the first cell as a heading row, then
 * `<header>: <cell>` body rows with a 2-column hanging indent.
 */
function tableRows(header: readonly string[], rows: readonly string[][], width: number): MarkdownRow[] {
  const n = header.length;
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map((r) => (r[c] ?? "").length)));
  const total = widths.reduce((a, b) => a + b, 0) + Math.max(0, n - 1);
  const out: MarkdownRow[] = [];
  if (n > 0 && total <= width) {
    const line = (cellsRow: readonly string[], style: MarkdownRow["style"]): MarkdownRow => {
      let text = "";
      const spans: TextSpan[] = [];
      cellsRow.forEach((c, k) => {
        if (k > 0) {
          spans.push({ start: text.length, end: text.length + 1, mark: "rule" });
          text += " ";
        }
        text += k < n - 1 ? c.padEnd(widths[k] ?? 0) : c;
      });
      // No trailing trim: the last column is not padded, and a rule on an empty last cell stays a space.
      const row: MarkdownRow = { style, text };
      if (spans.length > 0) row.spans = spans;
      return row;
    };
    out.push(line(header, "heading"));
    for (const r of rows) out.push(line(r, "body"));
    return out;
  }
  if (rows.length === 0) return wrapBlock([{ text: header.join(" | ") }], width, "heading", "", "");
  for (const r of rows) {
    out.push(...wrapBlock([{ text: r[0] || "-" }], width, "heading", "", ""));
    for (let c = 1; c < n; c++) {
      const v = r[c] ?? "";
      if (!v) continue;
      out.push(...wrapBlock([{ text: `${header[c] || `Col ${c + 1}`}: ${v}` }], width, "body", "", "  "));
    }
  }
  return out;
}

/**
 * SET_TEXT rows for `blocks` at `width` visible characters (docs/ui-v3.md section 13.2), at most `maxRows` rows. Every
 * row's `text` is exactly what a version 1-6 device draws; `spans` add the version 7 highlights.
 */
export function layoutMarkdown(blocks: readonly MdBlock[], width: number, maxRows: number = MARKDOWN_ROWS_MAX): MarkdownRow[] {
  const out: MarkdownRow[] = [];
  for (const b of blocks) {
    if (out.length >= maxRows) break;
    switch (b.kind) {
      case "gap":
        if (out.length > 0 && out[out.length - 1]?.text !== "") out.push({ style: "body", text: "" });
        break;
      case "heading":
        out.push(...wrapBlock(b.inline, width, "heading", "", ""));
        break;
      case "para":
        out.push(...wrapBlock(b.inline, width, "body", "", ""));
        break;
      case "quote":
        out.push(...wrapBlock(b.inline, width, "muted", QUOTE_PREFIX, QUOTE_PREFIX));
        break;
      case "item": {
        // Nesting indents 2 per level, but always leaves at least half the row for the words.
        const depth = Math.max(0, Math.min(b.depth, Math.floor((width / 2 - b.marker.length - 1) / 2)));
        const prefix = `${"  ".repeat(depth)}${b.marker} `;
        out.push(...wrapBlock(b.inline, width, "body", prefix, " ".repeat(prefix.length)));
        break;
      }
      case "code":
        for (const l of b.lines) out.push(codeRow(l, width));
        break;
      case "table":
        out.push(...tableRows(b.header, b.rows, width));
        break;
    }
  }
  while (out.length > 0 && out[out.length - 1]?.text === "") out.pop();
  return out.slice(0, maxRows);
}

/** A row cut to `n` visible characters, its spans clipped with it. */
export function clipRow<R extends { text: string; spans?: readonly TextSpan[] }>(row: R, n: number): R {
  if (row.text.length <= n && row.spans === undefined) return row;
  const text = row.text.slice(0, n);
  const { spans, ...rest } = row;
  const kept = (spans ?? []).filter((s) => s.start < text.length).map((s) => ({ ...s, end: Math.min(s.end, text.length) }));
  return (kept.length > 0 ? { ...rest, text, spans: kept } : { ...rest, text }) as unknown as R;
}

// ---------------------------------------------------------------------------------------------------------------
// Validation (adapter input, validate.ts)

const isInline = (v: unknown): v is Inline =>
  typeof v === "object" && v !== null && typeof (v as Inline).text === "string" && ((v as Inline).mark === undefined || (v as Inline).mark === "bold" || (v as Inline).mark === "code");
const inlineOk = (v: unknown): boolean => Array.isArray(v) && v.every(isInline);
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** `SessionDetails.lastBlocks` from an adapter: every block well-formed, at most 2000 blocks; else null. */
export function parseBlocks(v: unknown): MdBlock[] | null {
  if (!Array.isArray(v) || v.length > MARKDOWN_SOURCE_MAX) return null;
  const ascii = (s: string): string => s.replace(/[^\x20-\x7e]/g, " ");
  const fix = (inline: Inline[]): Inline[] => inline.map((r) => (r.mark ? { text: ascii(r.text), mark: r.mark } : { text: ascii(r.text) }));
  const out: MdBlock[] = [];
  for (const b of v as unknown[]) {
    if (typeof b !== "object" || b === null) return null;
    const o = b as Record<string, unknown>;
    switch (o.kind) {
      case "gap":
        out.push({ kind: "gap" });
        break;
      case "heading":
      case "para":
      case "quote":
        if (!inlineOk(o.inline)) return null;
        out.push({ kind: o.kind, inline: fix(o.inline as Inline[]) });
        break;
      case "item":
        if (!inlineOk(o.inline) || typeof o.marker !== "string" || !/^(-|\d{1,9}[.)])$/.test(o.marker) || typeof o.depth !== "number" || !Number.isInteger(o.depth) || o.depth < 0) return null;
        out.push({ kind: "item", depth: Math.min(LIST_DEPTH_MAX, o.depth), marker: o.marker, inline: fix(o.inline as Inline[]) });
        break;
      case "code":
        if (!strs(o.lines)) return null;
        out.push({ kind: "code", lines: o.lines.map(ascii) });
        break;
      case "table":
        if (!strs(o.header) || !Array.isArray(o.rows) || !o.rows.every(strs)) return null;
        out.push({ kind: "table", header: o.header.map(ascii), rows: (o.rows as string[][]).map((r) => r.map(ascii)) });
        break;
      default:
        return null;
    }
  }
  return out;
}
