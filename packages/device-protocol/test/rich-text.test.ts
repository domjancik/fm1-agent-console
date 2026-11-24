// Protocol version 7 (docs/ui-v3.md section 13, docs/protocol.md section 4): SET_TEXT rows with inline highlights.
import { describe, expect, test } from "bun:test";
import { decode, encode, sanitizeTextRow, spansToWire, stripSpans, TEXT_ROW_WIRE_MAX, visibleLength, wireToSpans, type RichSpan } from "../src";

const B = "\x01";
const K = "\x02";
const O = "\x03";
const R = "\x04";

describe("spansToWire / wireToSpans", () => {
  test("bold and code spans become on/off bytes; a span ending with the row has no off byte", () => {
    const spans: RichSpan[] = [{ start: 2, end: 6, mark: "bold" }, { start: 7, end: 10, mark: "code" }];
    const wire = spansToWire("a bold cod", spans);
    expect(wire).toBe(`a ${B}bold${O} ${K}cod`);
    expect(spansToWire("ab", [{ start: 1, end: 2, mark: "bold" }])).toBe(`a${B}b`);
    expect(wireToSpans(wire)).toEqual({ text: "a bold cod", spans });
  });

  test("a rule replaces its space and is one visible column", () => {
    const wire = spansToWire("ab cd", [{ start: 2, end: 3, mark: "rule" }]);
    expect(wire).toBe(`ab${R}cd`);
    expect(visibleLength(wire)).toBe(5);
    expect(stripSpans(wire)).toBe("ab cd");
    expect(wireToSpans(wire).spans).toEqual([{ start: 2, end: 3, mark: "rule" }]);
  });

  test("at most 4 bold/code spans, overlaps dropped, rules unlimited", () => {
    const spans: RichSpan[] = [0, 2, 4, 6, 8].map((s) => ({ start: s, end: s + 1, mark: "bold" as const }));
    const wire = spansToWire("a b c d e f", [...spans, { start: 0, end: 3, mark: "code" }, { start: 9, end: 10, mark: "rule" }]);
    expect(wire.split(B).length - 1).toBe(4);
    expect(wire).not.toContain(K);
    expect(wire).toContain(R);
    expect(visibleLength(wire)).toBe(11);
  });

  test("stripSpans gives the version 1-6 row: same columns", () => {
    const wire = `${B}x${O} y ${K}z`;
    expect(stripSpans(wire)).toBe("x y z");
    expect(visibleLength(wire)).toBe(stripSpans(wire).length);
  });
});

describe("sanitizeTextRow and the codec", () => {
  test("29 visible + 8 style bytes is the longest row; more style bytes are dropped, more characters cut", () => {
    const row = `${B}a${O}`.repeat(4) + "x".repeat(25);
    expect(row.length).toBe(TEXT_ROW_WIRE_MAX);
    expect(sanitizeTextRow(row)).toBe(row);
    expect(sanitizeTextRow(`${row}${B}y`)).toBe(row);
    expect(sanitizeTextRow(`a\x07\x1f${R}`)).toBe(`a??${R}`);
  });

  test("a two-row SET_TEXT of 37-byte rows round-trips", () => {
    const row = `${B}a${O}`.repeat(4) + "x".repeat(25);
    const msg = { kind: "SET_TEXT" as const, row: 0, lines: [{ style: "body" as const, text: row }, { style: "muted" as const, text: row }] };
    const res = decode(encode(msg, 3));
    expect(res.ok && res.value.message).toEqual(msg);
  });

  test("three 37-byte rows do not fit one frame (the host splits the group)", () => {
    const row = `${B}a${O}`.repeat(4) + "x".repeat(25);
    const msg = { kind: "SET_TEXT" as const, row: 0, lines: [0, 1, 2].map(() => ({ style: "body" as const, text: row })) };
    expect(() => encode(msg, 0)).toThrow();
  });
});
