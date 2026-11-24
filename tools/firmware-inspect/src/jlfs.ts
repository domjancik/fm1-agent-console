// JLFS directory entries (32 bytes): [hcrc u16][dcrc u16][offset u32][size u32][flags u8][resvd u8][index u16][name 16].
// hcrc is the CRC-16 of bytes 2..31. Reference: fm1pkg_make.py entry().
import { crc16, cstr, u16, u32 } from "./bytes";

export interface JlfsEntry {
  at: number;
  headerOk: boolean;
  dcrc: number;
  offset: number;
  size: number;
  flags: number;
  resvd: number;
  index: number;
  name: string;
}

export function parseEntry(e: Uint8Array, at: number): JlfsEntry {
  return {
    at,
    headerOk: e.length >= 32 && crc16(e.subarray(2, 32)) === u16(e, 0),
    dcrc: u16(e, 2),
    offset: u32(e, 4),
    size: u32(e, 8),
    flags: e[12] ?? 0,
    resvd: e[13] ?? 0,
    index: u16(e, 14),
    name: cstr(e.subarray(16, 32)).replace(/[^\x20-\x7e]/g, ""),
  };
}
