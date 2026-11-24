// Protocol version 7 (docs/ui-v3.md section 13.5): the simulator draws SET_TEXT control bytes as the firmware must.
// 0x01 bold (accent; white in a heading row), 0x02 code (128, 208, 255), 0x03 back to the row colour, none takes a
// column; 0x04 is one 8 px cell with a 1 px grey rule at x + 3, y 0-15.
import { describe, expect, test } from "bun:test";
import type { TextRow } from "@fm1/device-protocol";
import { emptyText, type DeviceState } from "../src/state";
import { rgb565 } from "../src/v4/raster";
import { renderV4, V4 } from "../src/v4/screen";
import { sampleSessions } from "./v4-scenes";

const B = "\x01";
const K = "\x02";
const O = "\x03";
const R = "\x04";
const AMBER = rgb565([255, 176, 0]);
const WHITE = rgb565([255, 255, 255]);
const CODE = rgb565([128, 208, 255]);
const GREY = rgb565([128, 128, 128]);
const MUTED = rgb565([160, 160, 160]);

function bubbleWith(rows: TextRow[]): DeviceState {
  const s = sampleSessions();
  s.link = { ...s.link, proto: 7 };
  const text = emptyText();
  text[0] = { style: "heading", text: "Done, 1m" };
  rows.forEach((r, i) => (text[1 + i] = r));
  s.text = text;
  return s;
}

/** Pixel values in the middle columns (x0 + 2 .. x0 + 5) of one 8 px cell of a 16 px row at y0. */
function cell(px: Uint16Array, x0: number, y0: number): Set<number> {
  const out = new Set<number>();
  for (let y = y0; y < y0 + 16; y++) for (let x = x0 + 2; x < x0 + 6; x++) out.add(px[y * 240 + x] ?? 0);
  return out;
}

describe("version 7 highlights in the bubble (simulator, docs/ui-v3.md section 13.5)", () => {
  test("bold in the accent, code in the code colour, the rest in the row colour; markers take no column", () => {
    const fb = renderV4(bubbleWith([{ style: "body", text: `${B}aa${O}bb${K}cc${O}dd` }]), 0);
    const y = V4.bodyY;
    const at = (n: number): Set<number> => cell(fb.px, 8 + 8 * n, y);
    expect(at(0).has(AMBER) && !at(0).has(WHITE)).toBe(true);
    expect(at(1).has(AMBER)).toBe(true);
    expect(at(2).has(WHITE) && !at(2).has(AMBER)).toBe(true);
    expect(at(4).has(CODE) && !at(4).has(WHITE)).toBe(true);
    expect(at(6).has(WHITE)).toBe(true);
    // the eighth character is the last one: nothing drawn in the ninth cell
    expect([...at(8)].every((p) => p === 0)).toBe(true);
  });

  test("bold in a heading row is white; in a muted row the accent; an unterminated span runs to the row end", () => {
    const fb = renderV4(bubbleWith([{ style: "heading", text: `aa${B}bb` }, { style: "muted", text: `aa${B}bb` }]), 0);
    expect(cell(fb.px, 8, V4.bodyY).has(AMBER)).toBe(true);
    expect(cell(fb.px, 8 + 16, V4.bodyY).has(WHITE)).toBe(true);
    expect(cell(fb.px, 8 + 24, V4.bodyY).has(WHITE)).toBe(true);
    expect(cell(fb.px, 8, V4.bodyY + 16).has(MUTED)).toBe(true);
    expect(cell(fb.px, 8 + 16, V4.bodyY + 16).has(AMBER)).toBe(true);
  });

  test("0x04 is one cell with a 1 px grey rule at x + 3 over the 16 rows; the next glyph follows in the next cell", () => {
    const fb = renderV4(bubbleWith([{ style: "body", text: `ab${R}cd` }]), 0);
    const x = 8 + 16 + 3;
    for (let y = V4.bodyY; y < V4.bodyY + 16; y++) {
      expect(fb.px[y * 240 + x]).toBe(GREY);
      expect(fb.px[y * 240 + x - 1]).toBe(0);
      expect(fb.px[y * 240 + x + 1]).toBe(0);
    }
    expect(cell(fb.px, 8 + 24, V4.bodyY).has(WHITE)).toBe(true);
  });

  test("a row with markers draws its visible characters exactly where the plain row draws them", () => {
    const plain = renderV4(bubbleWith([{ style: "body", text: "abcdef" }]), 0);
    const rich = renderV4(bubbleWith([{ style: "body", text: `${B}${O}abc${K}${O}def${B}${O}` }]), 0);
    for (let y = V4.bodyY; y < V4.bodyY + 16; y++) for (let x = 0; x < 240; x++) expect(rich.px[y * 240 + x]).toBe(plain.px[y * 240 + x] ?? 0);
  });

  test("DETAILS body rows draw the highlights too", () => {
    const s = bubbleWith([]);
    s.view = { view: "detail", page: 0, pages: 1, title: "DETAILS x" };
    const text = emptyText();
    text[3] = { style: "body", text: `${K}code${O} x` };
    s.text = text;
    const fb = renderV4(s, 0);
    expect(cell(fb.px, 4, V4.detailBodyY).has(CODE)).toBe(true);
    expect(cell(fb.px, 4 + 40, V4.detailBodyY).has(WHITE)).toBe(true);
  });
});
