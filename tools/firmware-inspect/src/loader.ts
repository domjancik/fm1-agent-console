// The package's update loader (UFW entry ota.bin). The checks mirror what the RUNNING firmware does
// before it stages the loader (firmware/firmware/src/ota.c ota_stage step 2, identical in CoralFlower
// 0.7.1's ota.c) and the build's wrapper (firmware/tools/build.py ldr_wrap).
import { ascii, crc16, indexOf, u16, u32 } from "./bytes";
import { lz4Decompress } from "./lz4";

export const LOADER_MARK = "FELUCCA-LOADER-1";
export const LOADER_LOAD = 0x01c0a800;
const OTA_AREA_LEN = 0x5000;
// the official M-VAVE update loader (usb_hid_ota.bin), recognised by ota.c
const OFFICIAL = { hcrc: 0xebaa, dcrc: 0x5881, len: 0x4de1 };
/** fm1_install.py OWN_LOADER_RE: a Felucca-family loader the installer will resume. */
export const OWN_LOADER_RE = /^ota-(FM-1|SMK-37 Pro|SMK-37 Elite|MKE-P37)_9\d\d$/i;

export type LoaderKind = "felucca" | "official" | "unknown";

export interface LoaderInfo {
  kind: LoaderKind;
  /** every structural test of ota_stage step 2 passes: the running Felucca-family firmware would stage it */
  acceptedByUpdater: boolean;
  refusal: string | null;
  outerCrcOk: boolean;
  bodyCrcOk: boolean;
  /** decompressed loader size from the inner head, and whether the LZ4 blocks decode to it with its CRC */
  imageSize: number;
  imageCrcOk: boolean | null;
  usbIdentity: string | null;
  resumable: boolean;
  image: Uint8Array | null;
}

function step2Refusal(b: Uint8Array, otaLen: number): string | null {
  const len = u32(b, 8);
  if (crc16(b.subarray(2, 32)) !== u16(b, 0)) return "outer head CRC";
  if (u32(b, 4) !== 0x20) return "outer head offset is not 0x20";
  if (b[12] !== 0x41) return "outer head attribute is not 0x41";
  if (otaLen !== len + 0x20) return `ota.bin size ${otaLen} != body ${len} + 0x20`;
  if (len > OTA_AREA_LEN - 0x200) return `loader body ${len} B does not fit the 0x5000 staging area`;
  if (crc16(b.subarray(0x22, 0x40)) !== u16(b, 0x20)) return "inner head CRC";
  if (u32(b, 0x28) !== LOADER_LOAD) return "inner head load address is not 0x01C0A800";
  return null;
}

function decodeBlocks(ota: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let p = 0x40;
  let o = 0;
  while (o < size) {
    const clen = u32(ota, p);
    const dlen = u32(ota, p + 4);
    if (!clen || clen > 4096 || !dlen || dlen > 4096 || p + 8 + clen > ota.length) throw new Error(`bad LZ4 block at ${p}`);
    out.set(lz4Decompress(ota.subarray(p + 8, p + 8 + clen), dlen), o);
    o += dlen;
    p += 8 + clen;
  }
  if (p !== ota.length) throw new Error(`${ota.length - p} B after the last LZ4 block`);
  return out;
}

const IDENTITY_RE = /ota-[A-Za-z0-9 +-]{1,20}_\d{3}/;

export function analyseLoader(ota: Uint8Array): LoaderInfo {
  const b = ota.subarray(0, 512);
  const len = u32(b, 8);
  const refusal0 = ota.length < 0x48 + 64 ? "ota.bin too short" : step2Refusal(b, ota.length);
  const official = u16(b, 0) === OFFICIAL.hcrc && u16(b, 2) === OFFICIAL.dcrc && len === OFFICIAL.len;
  const imageSize = u32(b, 0x24);
  const markAt = indexOf(b.subarray(0x48, 0x48 + 64), ascii(LOADER_MARK));
  const own = markAt >= 0 && imageSize <= 0x14000;
  const kind: LoaderKind = official ? "official" : own ? "felucca" : "unknown";
  const refusal = refusal0 ?? (kind === "unknown" ? `no ${LOADER_MARK} mark in the first LZ4 literals and not the official loader` : null);
  const bodyCrcOk = ota.length >= 0x20 + len && crc16(ota.subarray(0x20, 0x20 + len)) === u16(b, 2);
  let image: Uint8Array | null = null;
  let imageCrcOk: boolean | null = null;
  if (kind === "felucca" && refusal0 === null) {
    try {
      image = decodeBlocks(ota.subarray(0, 0x20 + len), imageSize);
      imageCrcOk = crc16(image) === u16(b, 0x22);
    } catch {
      imageCrcOk = false;
    }
  }
  const text = image ? new TextDecoder("latin1").decode(image) : "";
  const usbIdentity = IDENTITY_RE.exec(text)?.[0] ?? null;
  return {
    kind,
    acceptedByUpdater: refusal === null && bodyCrcOk,
    refusal: refusal ?? (bodyCrcOk ? null : "loader body CRC (the updater re-checks it after staging)"),
    outerCrcOk: crc16(b.subarray(2, 32)) === u16(b, 0),
    bodyCrcOk,
    imageSize,
    imageCrcOk,
    usbIdentity,
    resumable: usbIdentity !== null && OWN_LOADER_RE.test(usbIdentity),
    image,
  };
}
