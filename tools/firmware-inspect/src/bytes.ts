// Byte helpers, CRC-16/XMODEM and the two JieLi ciphers used by the FM-1 package format.
// References: firmware/tools/fm1pkg_make.py (crc16, enc, sfc), firmware/firmware/src/ota.c (ota_crc16, ota_jl_enc).
import { createHash } from "node:crypto";

export const u16 = (b: Uint8Array, o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
export const u32 = (b: Uint8Array, o: number): number => (u16(b, o) | (u16(b, o + 2) << 16)) >>> 0;

const CRC_TABLE: Uint16Array = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1;
    t[i] = c & 0xffff;
  }
  return t;
})();

/** CRC-16/XMODEM (poly 0x1021, init 0), as the package, the device and the installer use. */
export function crc16(data: Uint8Array, crc = 0): number {
  let c = crc & 0xffff;
  for (const b of data) c = ((c << 8) & 0xffff) ^ (CRC_TABLE[((c >> 8) ^ b) & 0xff] ?? 0);
  return c;
}

/** JieLi ENC stream cipher (its own inverse); returns a new buffer. */
export function jlEnc(data: Uint8Array, key = 0xffff): Uint8Array {
  const out = Uint8Array.from(data);
  let k = key & 0xffff;
  for (let i = 0; i < out.length; i++) {
    out[i] = (out[i] ?? 0) ^ (k & 0xff);
    k = ((k << 1) ^ (k & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return out;
}

/** SFC cipher: ENC per 32-byte block, key mixed with the block offset from `base` (its own inverse). */
export function sfc(data: Uint8Array, offsetFromBase: number, key: number): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 32) {
    const blk = jlEnc(data.subarray(i, i + 32), (key ^ ((offsetFromBase + i) >> 2)) & 0xffff);
    out.set(blk, i);
  }
  return out;
}

export const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

export const hex = (n: number, width = 4): string => `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;

export function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0];
  outer: for (let i = hay.indexOf(first ?? 0, from); i >= 0 && i + needle.length <= hay.length; i = hay.indexOf(first ?? 0, i + 1)) {
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

export function cstr(b: Uint8Array): string {
  const end = b.indexOf(0);
  return new TextDecoder("latin1").decode(end < 0 ? b : b.subarray(0, end));
}

/** Length without trailing 0xFF padding. */
export function trimmedLength(b: Uint8Array): number {
  let n = b.length;
  while (n > 0 && b[n - 1] === 0xff) n--;
  return n;
}
