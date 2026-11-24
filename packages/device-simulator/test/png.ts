// Minimal PNG read/write for the version 4 parity tests (8-bit RGB or RGBA, not interlaced). Test-only, node APIs.
import { deflateSync, inflateSync } from "node:zlib";

export interface Rgb8Image {
  w: number;
  h: number;
  /** RGB triplets, row-major. */
  rgb: Uint8Array;
}

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function readPng(buf: Uint8Array): Rgb8Image {
  const b = Buffer.from(buf);
  if (!b.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");
  let off = 8;
  let w = 0;
  let h = 0;
  let type = 0;
  const idat: Buffer[] = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const kind = b.toString("latin1", off + 4, off + 8);
    const data = b.subarray(off + 8, off + 8 + len);
    if (kind === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error("only 8-bit, non-interlaced PNGs");
      type = data[9] ?? 0;
    } else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
    off += 12 + len;
  }
  const bpp = type === 2 ? 3 : type === 6 ? 4 : 0;
  if (!bpp) throw new Error(`PNG colour type ${type} unsupported`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const cur = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)] ?? 0;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? (cur[i - bpp] ?? 0) : 0;
      const up = prev[i] ?? 0;
      const c = i >= bpp ? (prev[i - bpp] ?? 0) : 0;
      const x = line[i] ?? 0;
      let v = x;
      if (f === 1) v = x + a;
      else if (f === 2) v = x + up;
      else if (f === 3) v = x + ((a + up) >> 1);
      else if (f === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c);
      }
      cur[i] = v & 255;
    }
    for (let px = 0; px < w; px++) {
      rgb[(y * w + px) * 3] = cur[px * bpp] ?? 0;
      rgb[(y * w + px) * 3 + 1] = cur[px * bpp + 1] ?? 0;
      rgb[(y * w + px) * 3 + 2] = cur[px * bpp + 2] ?? 0;
    }
    prev.set(cur);
  }
  return { w, h, rgb };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC[(c ^ byte) & 255] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(kind: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(kind, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encodes RGB triplets as a PNG, optionally scaled up by an integer factor (nearest neighbour). */
export function writePng(img: Rgb8Image, scale = 1): Uint8Array {
  const w = img.w * scale;
  const h = img.h * scale;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const s = (Math.floor(y / scale) * img.w + Math.floor(x / scale)) * 3;
      const d = y * (w * 3 + 1) + 1 + x * 3;
      raw[d] = img.rgb[s] ?? 0;
      raw[d + 1] = img.rgb[s + 1] ?? 0;
      raw[d + 2] = img.rgb[s + 2] ?? 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
