// UFW container inside a .fwsc logical image: a 0x40-byte header and 0x50-byte file entries, both
// ENC-ciphered (key 0xFFFF). References: fm1pkg_make.py ufw(), fm1_install.py package_damage(), ota.c ota_ufw().
import { crc16, cstr, jlEnc, u16, u32 } from "./bytes";

export const UFW_TYPE_FLASH = 0;
export const UFW_TYPE_OTA = 100;

export interface UfwEntry {
  index: number;
  type: number;
  name: string;
  offset: number;
  size: number;
  storedCrc: number;
  /** CRC-16 of the bytes as served, or null when the entry runs past the image. */
  actualCrc: number | null;
  /** flash.bin and ota.bin carry the CRC of their served bytes; other stock entries store something else. */
  crcChecked: boolean;
}

export interface UfwHeader {
  headerCrcOk: boolean;
  listCrcOk: boolean;
  total: number;
  count: number;
  chip: string;
  entries: UfwEntry[];
}

export class UfwError extends Error {}

export function parseUfw(image: Uint8Array): UfwHeader {
  if (image.length < 0x40) throw new UfwError("image shorter than the 0x40-byte UFW header");
  const hdr = jlEnc(image.subarray(0, 0x40));
  const headerCrcOk = crc16(hdr.subarray(2, 0x40)) === u16(hdr, 0);
  const count = u16(hdr, 8);
  const total = u32(hdr, 4);
  const chip = cstr(hdr.subarray(16, 32));
  if (count < 1 || count > 11 || image.length < 0x40 + 0x50 * count) {
    return { headerCrcOk, listCrcOk: false, total, count, chip, entries: [] };
  }
  const list = image.subarray(0x40, 0x40 + 0x50 * count);
  const listCrcOk = crc16(list) === u16(hdr, 2);
  const entries: UfwEntry[] = [];
  for (let i = 0; i < count; i++) {
    const e = jlEnc(list.subarray(i * 0x50, (i + 1) * 0x50));
    const type = u16(e, 0);
    const offset = u32(e, 8);
    const size = u32(e, 12);
    const inBounds = offset + size <= image.length;
    entries.push({
      index: u16(e, 2),
      type,
      name: cstr(e.subarray(0x40, 0x50)),
      offset,
      size,
      storedCrc: u16(e, 4),
      actualCrc: inBounds ? crc16(image.subarray(offset, offset + size)) : null,
      crcChecked: type === UFW_TYPE_FLASH || type === UFW_TYPE_OTA,
    });
  }
  return { headerCrcOk, listCrcOk, total, count, chip, entries };
}

/** The installer's damage test (fm1_install.py package_damage): what is wrong, or null. */
export function ufwDamage(image: Uint8Array): string | null {
  let u: UfwHeader;
  try {
    u = parseUfw(image);
  } catch {
    return "too short";
  }
  if (!u.headerCrcOk) return "header CRC";
  if (u.count < 1 || u.count > 8 || u.entries.length === 0) return "file list";
  if (!u.listCrcOk) return "file list CRC";
  for (const e of u.entries) {
    if (e.actualCrc === null) return `${e.name}: cut short`;
    if (e.crcChecked && e.actualCrc !== e.storedCrc) return `${e.name}: CRC`;
  }
  return null;
}

export const entryData = (image: Uint8Array, e: UfwEntry): Uint8Array => image.subarray(e.offset, e.offset + e.size);
