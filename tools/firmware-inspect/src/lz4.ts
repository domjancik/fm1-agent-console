// LZ4 block decoder (no frame), for the Felucca update loader's compressed blocks (firmware/tools/lz4blk.py).

export class Lz4Error extends Error {}

export function lz4Decompress(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let ip = 0;
  let op = 0;
  const byte = (): number => {
    const b = src[ip++];
    if (b === undefined) throw new Lz4Error("input ends inside a sequence");
    return b;
  };
  const extend = (n: number): number => {
    if (n !== 15) return n;
    for (;;) {
      const b = byte();
      n += b;
      if (b !== 255) return n;
    }
  };
  while (ip < src.length) {
    const token = byte();
    const lit = extend(token >> 4);
    if (ip + lit > src.length || op + lit > expected) throw new Lz4Error("literal run out of bounds");
    out.set(src.subarray(ip, ip + lit), op);
    ip += lit;
    op += lit;
    if (ip >= src.length) break; // last sequence: literals only
    const offset = byte() | (byte() << 8);
    if (offset === 0 || offset > op) throw new Lz4Error(`bad match offset ${offset} at output ${op}`);
    const len = extend(token & 15) + 4;
    if (op + len > expected) throw new Lz4Error("match runs past the expected size");
    for (let i = 0; i < len; i++, op++) out[op] = out[op - offset] ?? 0;
  }
  if (op !== expected) throw new Lz4Error(`decoded ${op} bytes, expected ${expected}`);
  return out;
}
