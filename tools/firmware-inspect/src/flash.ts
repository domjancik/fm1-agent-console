// A flash image (the package's flash.bin, or a 1 MiB dump of the chip): boot head [0, 0x4000) and
// the SFC-encrypted app area from 0x4000. References: fm1pkg_make.py flash_image(), chipkey_decode(),
// firmware/firmware/loader/ldr_core.c ldr_chip_key(), MvaveFM1Unbricker fm1_unbrick.py (known hashes).
import { crc16, jlEnc, sfc, sha256, trimmedLength, u16 } from "./bytes";
import { type JlfsEntry, parseEntry } from "./jlfs";

export const HEAD_END = 0x4000;
/** End of what the Felucca/Dinghy update loader writes (and of the unbricker's `restore` region). */
export const APP_END = 0x93000;
export const JEDEC_IDS: Record<string, number> = { "Puya P25Q80": 0x856014, "UCUN UC25HQ80": 0xb36014 };

export const KNOWN_HEADS: Record<string, string> = {
  d9f43191777656de01c7bed4f9e9ba2e34e94832c5d2ed02c3fc7ab7a6d9bd67: "stock M-VAVE V15 boot head",
  "8f5228c2d6ea2068838ef4916f946bea877d14b07e6cfca49e41957f4c7b234f": "stock M-VAVE V16 boot head",
};
export const KNOWN_REGIONS: Record<string, string> = {
  "6edf3c37fb5bbbc33607c89375ee024d5477c17914d72221c8c68e58a8255686": "official M-VAVE V15 firmware region",
  "980ff51ae2d90004cf3887602ebd11cd31796977410eb77cc7faabad4023003c": "official M-VAVE V16 (first 0x8F000 B of its longer firmware)",
};

export interface FileCheck {
  name: string;
  offset: number;
  size: number;
  stored: number;
  actual: number | null;
}

export interface FlashInfo {
  length: number;
  headerOk: boolean;
  headEntries: JlfsEntry[];
  headFiles: FileCheck[];
  chipKey: number | null;
  headSha256: string;
  headKnownAs: string | null;
  regionSha256: string | null;
  regionKnownAs: string | null;
  appArea: AppArea | null;
}

export interface AppArea {
  head: JlfsEntry;
  areaCrc: FileCheck;
  files: FileCheck[];
  regions: { name: string; offset: number; size: number }[];
  app: { size: number; used: number; sha256: string; usedSha256: string } | null;
  /** ChoralRoot/CoralFlower boot-stub commit marker ("CRBM" at flash 0x91FE0, decrypted) */
  stubMarker: boolean;
  jedecConstants: string[];
  plain: Uint8Array;
}

export function chipKeyDecode(d: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < 16; i++) sum += d[i] ?? 0;
  sum &= 0xff;
  sum = sum >= 0xe0 ? 0xaa : sum <= 0x10 ? 0x55 : sum;
  let k = 0;
  for (let i = 0; i < 16; i++) if (((d[16 + i] ?? 0) ^ (d[15 - i] ?? 0)) < sum) k |= 1 << i;
  return k;
}

function fileCheck(name: string, data: Uint8Array, offset: number, size: number, stored: number): FileCheck {
  const inBounds = offset + size <= data.length;
  return { name, offset, size, stored, actual: inBounds ? crc16(data.subarray(offset, offset + size)) : null };
}

function parseHead(flash: Uint8Array): Pick<FlashInfo, "headerOk" | "headEntries" | "headFiles" | "chipKey"> {
  const hdr = jlEnc(flash.subarray(0, 32));
  const headerOk = crc16(hdr.subarray(2, 32)) === u16(hdr, 0);
  const headEntries: JlfsEntry[] = [];
  const headFiles: FileCheck[] = [];
  let chipKey: number | null = null;
  for (let at = 32; at < 0x400; at += 32) {
    const e = parseEntry(jlEnc(flash.subarray(at, at + 32)), at);
    if (!e.headerOk) break;
    headEntries.push(e);
    if (e.dcrc !== 0xffff && e.offset + e.size <= HEAD_END) {
      headFiles.push(fileCheck(e.name, flash, e.offset, e.size, e.dcrc));
      if (e.name === "isd_config.ini" && e.offset + 34 <= flash.length) {
        const blob = flash.subarray(e.offset, e.offset + 34);
        if (crc16(blob.subarray(0, 32)) === u16(blob, 32)) chipKey = chipKeyDecode(blob);
      }
    }
    if (e.index !== 0) break; // ldr_chip_key: a nonzero index marks the last top entry
  }
  return { headerOk, headEntries, headFiles, chipKey };
}

const le32 = (v: number): Uint8Array => Uint8Array.of(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);

export function jedecConstantsIn(image: Uint8Array): string[] {
  const found: string[] = [];
  for (const [chip, id] of Object.entries(JEDEC_IDS)) {
    const pat = le32(id);
    for (let i = 0; i + 4 <= image.length; i += 2) {
      if (image[i] === pat[0] && image[i + 1] === pat[1] && image[i + 2] === pat[2] && image[i + 3] === pat[3]) {
        found.push(`${chip} 0x${id.toString(16).toUpperCase()}`);
        break;
      }
    }
  }
  return found;
}

function parseAppArea(flash: Uint8Array, key: number): AppArea | null {
  if (flash.length <= HEAD_END + 32) return null;
  const plain = sfc(flash.subarray(HEAD_END), 0, key);
  const head = parseEntry(plain.subarray(0, 32), HEAD_END);
  if (!head.headerOk) return null;
  const blk = head.size;
  const areaCrc: FileCheck = {
    name: head.name,
    offset: 32,
    size: blk - 32,
    stored: head.dcrc,
    actual: blk <= plain.length && blk > 32 ? crc16(plain.subarray(32, blk)) : null,
  };
  const files: FileCheck[] = [];
  const regions: AppArea["regions"] = [];
  let app: AppArea["app"] = null;
  let dirAt = -1;
  for (let at = 32; at + 32 <= Math.min(blk, 0x400); at += 32) {
    const e = parseEntry(plain.subarray(at, at + 32), HEAD_END + at);
    if (!e.headerOk) break;
    if (e.flags !== 0x82) { // files are 0x82; the rest are region descriptors (fm1pkg_make.py REGIONS)
      regions.push({ name: e.name || "?", offset: e.offset, size: e.size });
      continue;
    }
    files.push(fileCheck(e.name, plain, e.offset, e.size, e.dcrc));
    if (e.name === "app.bin" && e.offset + e.size <= plain.length) {
      const data = plain.subarray(e.offset, e.offset + e.size);
      const used = trimmedLength(data);
      app = { size: e.size, used, sha256: sha256(data), usedSha256: sha256(data.subarray(0, used)) };
    }
    if (dirAt < 0) dirAt = blk; // a nested cfg directory follows the block (fm1pkg_make.py)
  }
  if (dirAt > 0 && dirAt + 32 <= plain.length) {
    const d = parseEntry(plain.subarray(dirAt, dirAt + 32), HEAD_END + dirAt);
    if (d.headerOk && d.flags === 0x83) {
      files.push(fileCheck(d.name, plain, dirAt + d.offset, d.size - d.offset, d.dcrc));
      for (let at = dirAt + d.offset; at + 32 <= dirAt + d.size; ) {
        const c = parseEntry(plain.subarray(at, at + 32), HEAD_END + at);
        if (!c.headerOk) break;
        files.push(fileCheck(c.name, plain, dirAt + c.offset, c.size, c.dcrc));
        at = dirAt + c.offset + c.size;
        if (c.flags !== 0x83) break;
      }
    }
  }
  const markOff = 0x91fe0 - HEAD_END;
  const stubMarker = markOff + 4 <= plain.length && new TextDecoder("latin1").decode(plain.subarray(markOff, markOff + 4)) === "CRBM";
  const appImage = files.find((f) => f.name === "app.bin");
  const scan = appImage ? plain.subarray(appImage.offset, appImage.offset + appImage.size) : plain;
  return { head, areaCrc, files, regions, app, stubMarker, jedecConstants: jedecConstantsIn(scan), plain };
}

export function analyseFlash(flash: Uint8Array): FlashInfo {
  const head = parseHead(flash);
  const headSha256 = sha256(flash.subarray(0, HEAD_END));
  const regionSha256 = flash.length >= APP_END ? sha256(flash.subarray(HEAD_END, APP_END)) : null;
  return {
    length: flash.length,
    ...head,
    headSha256,
    headKnownAs: KNOWN_HEADS[headSha256] ?? null,
    regionSha256,
    regionKnownAs: regionSha256 ? (KNOWN_REGIONS[regionSha256] ?? null) : null,
    appArea: head.chipKey === null ? null : parseAppArea(flash, head.chipKey),
  };
}

