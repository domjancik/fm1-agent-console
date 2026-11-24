import { describe, expect, test } from "bun:test";
import { ascii, crc16, jlEnc, sfc, trimmedLength } from "../src/bytes";
import { lz4Decompress, Lz4Error } from "../src/lz4";
import { chipKeyDecode } from "../src/flash";

describe("primitives", () => {
  test("CRC-16/XMODEM check value", () => {
    expect(crc16(ascii("123456789"))).toBe(0x31c3);
    expect(crc16(new Uint8Array(0))).toBe(0);
  });
  test("ENC and SFC are their own inverse", () => {
    const data = Uint8Array.from({ length: 100 }, (_, i) => (i * 37) & 0xff);
    expect(jlEnc(jlEnc(data))).toEqual(data);
    expect(sfc(sfc(data, 64, 0x980f), 64, 0x980f)).toEqual(data);
    expect(sfc(data, 0, 0x980f)).not.toEqual(data);
  });
  test("chip key decode of fm1pkg_make.py key_blob(0x980F)", () => {
    const d = new Uint8Array(32).fill(0x10, 0, 16);
    for (let i = 0; i < 16; i++) d[16 + i] = (d[15 - i] ?? 0) ^ ((0x980f >> i) & 1 ? 0x00 : 0xff);
    expect(chipKeyDecode(d)).toBe(0x980f);
  });
  test("trimmed length drops 0xFF padding only", () => {
    expect(trimmedLength(Uint8Array.of(1, 0xff, 2, 0xff, 0xff))).toBe(3);
  });
});

describe("LZ4 block decoder", () => {
  test("literals then an overlapping match", () => {
    // token 0x34: 3 literals "abc", match len 4+4=8 at offset 3 -> "abcabcabcab", then 5 literals
    const block = Uint8Array.of(0x34, 0x61, 0x62, 0x63, 3, 0, 0x50, 0x76, 0x77, 0x78, 0x79, 0x7a);
    expect(new TextDecoder().decode(lz4Decompress(block, 16))).toBe("abcabcabcabvwxyz");
  });
  test("rejects a bad offset and a wrong size", () => {
    expect(() => lz4Decompress(Uint8Array.of(0x10, 0x61, 9, 0, 0x00), 6)).toThrow(Lz4Error);
    expect(() => lz4Decompress(Uint8Array.of(0x30, 0x61, 0x62, 0x63), 4)).toThrow(Lz4Error);
  });
});
