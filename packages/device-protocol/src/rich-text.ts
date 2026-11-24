// Protocol version 7 (docs/protocol.md section 3, docs/ui-v3.md section 13): inline highlights inside a SET_TEXT row.
// Control bytes that are never printable ASCII sit in the row's text bytes; they take no screen column, except the
// column rule 0x04, which is one cell. Pure.
import { STR_MAX } from "./constants";

/** The control bytes of a version 7 SET_TEXT row. */
export const TEXT_MARK = {
  /** Bold on: the following characters in the accent colour (white in a heading row). */
  bold: 0x01,
  /** Code on: the following characters in the code colour. */
  code: 0x02,
  /** Back to the row style's colour. */
  off: 0x03,
  /** A column rule: one 8 px cell with a 1 px vertical line (table column gap). Counts as one visible character. */
  rule: 0x04,
} as const;

/** Bold/code spans per row: each costs an "on" and an "off" byte. */
export const TEXT_SPANS_MAX = 4;
/** Style bytes (0x01-0x03) per row. */
export const TEXT_MARKS_MAX = 2 * TEXT_SPANS_MAX;
/** Bytes of one row on the wire: 29 visible characters (0x04 included) plus 8 style bytes. */
export const TEXT_ROW_WIRE_MAX = STR_MAX.textRow + TEXT_MARKS_MAX;

export type RichMark = "bold" | "code" | "rule";
export interface RichSpan {
  start: number;
  end: number;
  mark: RichMark;
}

const isStyleByte = (c: number): boolean => c >= TEXT_MARK.bold && c <= TEXT_MARK.off;
/** A byte that takes a screen column: printable ASCII or the column rule. */
export const isVisibleByte = (c: number): boolean => (c >= 0x20 && c <= 0x7e) || c === TEXT_MARK.rule;

/** Screen columns of a wire row (style bytes count 0, the rule 1). */
export function visibleLength(wire: string): number {
  let n = 0;
  for (let i = 0; i < wire.length; i++) if (isVisibleByte(wire.charCodeAt(i))) n++;
  return n;
}

/**
 * The wire form of a row: `text` (printable ASCII, the visible characters) with its spans as control bytes. Overlapping
 * spans after the first are ignored; at most TEXT_SPANS_MAX bold/code spans are kept (later ones are drawn plain); a
 * rule replaces the character under it. Spans are clipped to the text.
 */
export function spansToWire(text: string, spans: readonly RichSpan[] | undefined): string {
  if (!spans || spans.length === 0) return text;
  const sorted = [...spans].filter((s) => s.start < s.end && s.start < text.length).sort((a, b) => a.start - b.start);
  const style: RichSpan[] = [];
  const rules = new Set<number>();
  let reach = 0;
  for (const s of sorted) {
    if (s.mark === "rule") {
      for (let i = s.start; i < Math.min(s.end, text.length); i++) rules.add(i);
      continue;
    }
    if (s.start < reach || style.length >= TEXT_SPANS_MAX) continue;
    style.push({ start: s.start, end: Math.min(s.end, text.length), mark: s.mark });
    reach = s.end;
  }
  let out = "";
  let k = 0;
  for (let i = 0; i < text.length; i++) {
    const open = style[k];
    if (open && open.start === i) out += String.fromCharCode(open.mark === "bold" ? TEXT_MARK.bold : TEXT_MARK.code);
    out += rules.has(i) ? String.fromCharCode(TEXT_MARK.rule) : text[i];
    if (open && open.end === i + 1) {
      // A span that ends with the row needs no off byte (the style resets at every row).
      if (i + 1 < text.length) out += String.fromCharCode(TEXT_MARK.off);
      k++;
    }
  }
  return out;
}

/** A wire row back to its visible text (rules as spaces) and spans. */
export function wireToSpans(wire: string): { text: string; spans: RichSpan[] } {
  let text = "";
  const spans: RichSpan[] = [];
  let open: { start: number; mark: RichMark } | null = null;
  const close = (): void => {
    if (open && text.length > open.start) spans.push({ start: open.start, end: text.length, mark: open.mark });
    open = null;
  };
  for (let i = 0; i < wire.length; i++) {
    const c = wire.charCodeAt(i);
    if (c === TEXT_MARK.bold || c === TEXT_MARK.code) {
      close();
      open = { start: text.length, mark: c === TEXT_MARK.bold ? "bold" : "code" };
    } else if (c === TEXT_MARK.off) close();
    else if (c === TEXT_MARK.rule) {
      spans.push({ start: text.length, end: text.length + 1, mark: "rule" });
      text += " ";
    } else text += wire[i];
  }
  close();
  return { text, spans: spans.sort((a, b) => a.start - b.start) };
}

/** The version 1-6 form of a wire row: style bytes dropped, a rule as a space (same columns, same width). */
export function stripSpans(wire: string): string {
  let out = "";
  for (let i = 0; i < wire.length; i++) {
    const c = wire.charCodeAt(i);
    if (isStyleByte(c)) continue;
    out += c === TEXT_MARK.rule ? " " : wire[i];
  }
  return out;
}

/**
 * What the sender puts on the wire for a SET_TEXT row: bytes outside printable ASCII and 0x01-0x04 become `?`; the row
 * is cut after 29 visible characters; style bytes past the 8th are dropped (the colour change they meant is lost, the
 * characters stay).
 */
export function sanitizeTextRow(text: string): string {
  let out = "";
  let visible = 0;
  let marks = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (isStyleByte(c)) {
      if (visible >= STR_MAX.textRow || marks >= TEXT_MARKS_MAX) continue;
      marks++;
      out += ch;
      continue;
    }
    if (visible >= STR_MAX.textRow) break;
    out += isVisibleByte(c) ? ch : "?";
    visible++;
  }
  return out;
}
