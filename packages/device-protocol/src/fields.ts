import type { EnumTable } from "./enums";
import { isVisibleByte, sanitizeTextRow, TEXT_ROW_WIRE_MAX } from "./rich-text";
import { STR_MAX } from "./constants";

const isInt = (v: number, min: number, max: number): boolean =>
  Number.isInteger(v) && v >= min && v <= max;

/** Replaces characters outside printable ASCII with `?` and truncates to `max` characters. */
export function sanitizeAscii(text: string, max: number): string {
  let out = "";
  for (const ch of text) {
    if (out.length >= max) break;
    const code = ch.codePointAt(0) ?? 0;
    out += code >= 0x20 && code <= 0x7e ? ch : "?";
  }
  return out;
}

/** Builds a message body. Throws RangeError on out-of-range numbers (a caller bug). */
export class BodyWriter {
  readonly bytes: number[] = [];

  u7(value: number, field: string, min = 0, max = 127): this {
    if (!isInt(value, min, max)) throw new RangeError(`${field}: ${value} not in ${min}..${max}`);
    this.bytes.push(value);
    return this;
  }

  u14(value: number, field: string, max = 0x3fff): this {
    if (!isInt(value, 0, max)) throw new RangeError(`${field}: ${value} not in 0..${max}`);
    this.bytes.push(value >> 7, value & 0x7f);
    return this;
  }

  s7(value: number, field: string): this {
    if (!isInt(value, -64, 63)) throw new RangeError(`${field}: ${value} not in -64..63`);
    this.bytes.push(value + 64);
    return this;
  }

  str(text: string, max: number): this {
    const clean = sanitizeAscii(text, max);
    this.bytes.push(clean.length);
    for (let i = 0; i < clean.length; i++) this.bytes.push(clean.charCodeAt(i));
    return this;
  }

  /** A SET_TEXT row (version 7 control bytes allowed, rich-text.ts sanitizeTextRow). */
  textRow(text: string): this {
    const clean = sanitizeTextRow(text);
    this.bytes.push(clean.length);
    for (let i = 0; i < clean.length; i++) this.bytes.push(clean.charCodeAt(i));
    return this;
  }

  enum<N extends string>(table: EnumTable<N>, name: N): this {
    this.bytes.push(table.toWire(name));
    return this;
  }
}

/** Thrown by BodyReader; the codec turns it into a `bad_body` decode error. */
export class BodyError extends Error {}

export class BodyReader {
  private pos = 0;

  constructor(private readonly bytes: readonly number[]) {}

  private next(field: string): number {
    const b = this.bytes[this.pos];
    if (b === undefined) throw new BodyError(`${field}: body too short`);
    this.pos++;
    return b;
  }

  u7(field: string, min = 0, max = 127): number {
    const v = this.next(field);
    if (v < min || v > max) throw new BodyError(`${field}: ${v} not in ${min}..${max}`);
    return v;
  }

  u14(field: string, max = 0x3fff): number {
    const v = (this.next(field) << 7) | this.next(field);
    if (v > max) throw new BodyError(`${field}: ${v} > ${max}`);
    return v;
  }

  s7(field: string): number {
    return this.next(field) - 64;
  }

  str(field: string, max: number): string {
    const len = this.next(field);
    if (len > max) throw new BodyError(`${field}: length ${len} > ${max}`);
    let out = "";
    for (let i = 0; i < len; i++) {
      const c = this.next(field);
      if (c < 0x20 || c > 0x7e) throw new BodyError(`${field}: byte ${c} not printable ASCII`);
      out += String.fromCharCode(c);
    }
    return out;
  }

  /**
   * A SET_TEXT row: at most 37 bytes, each printable ASCII or 0x01-0x04, at most 29 of them visible (printable or the
   * 0x04 rule). Version 7 (docs/protocol.md section 4); decoding does not depend on the negotiated version.
   */
  textRow(field: string): string {
    const len = this.next(field);
    if (len > TEXT_ROW_WIRE_MAX) throw new BodyError(`${field}: length ${len} > ${TEXT_ROW_WIRE_MAX}`);
    let out = "";
    let visible = 0;
    for (let i = 0; i < len; i++) {
      const c = this.next(field);
      if (!(isVisibleByte(c) || (c >= 0x01 && c <= 0x03))) throw new BodyError(`${field}: byte ${c} not printable ASCII or 0x01-0x04`);
      if (isVisibleByte(c)) visible++;
      out += String.fromCharCode(c);
    }
    if (visible > STR_MAX.textRow) throw new BodyError(`${field}: ${visible} visible characters > ${STR_MAX.textRow}`);
    return out;
  }

  enum<N extends string>(field: string, table: EnumTable<N>): N {
    const v = this.next(field);
    const name = table.fromWire(v);
    if (name === undefined) throw new BodyError(`${field}: unknown value ${v}`);
    return name;
  }

  /** Bytes not read yet (optional trailing fields, protocol version 5). */
  remaining(): number {
    return this.bytes.length - this.pos;
  }

  end(): void {
    if (this.pos !== this.bytes.length) {
      throw new BodyError(`${this.bytes.length - this.pos} trailing body bytes`);
    }
  }
}
