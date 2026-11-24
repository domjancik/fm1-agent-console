import { describe, expect, test } from "bun:test";
import { decode, encode, FrameAssembler, payloadToMidi } from "../src";
import { validVectors } from "../src/vectors";

/** Deterministic PRNG (mulberry32) so failures reproduce. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (r: () => number, n: number): number => Math.floor(r() * n);

describe("fuzz", () => {
  test("random payloads never throw from decode", () => {
    const r = rng(1);
    for (let i = 0; i < 20_000; i++) {
      const len = int(r, 110);
      const bytes = Array.from({ length: len }, () => int(r, i % 10 === 0 ? 256 : 128));
      // force a plausible header half the time so body parsers get exercised
      if (len >= 4 && i % 2 === 0) bytes[2] = len - 4;
      const res = decode(bytes);
      if (res.ok) expect(encode(res.value.message, res.value.seq)).toEqual(bytes);
    }
  });

  test("random MIDI streams through assembler + decoder deliver only exact frames", () => {
    const r = rng(2);
    const known = validVectors().filter((v) => v.direction === "host_to_device");
    for (let round = 0; round < 300; round++) {
      const asm = new FrameAssembler("host");
      const sent: number[][] = [];
      const stream: number[][] = [];
      for (let k = 0; k < 20; k++) {
        if (r() < 0.4) {
          const v = known[int(r, known.length)];
          if (!v) continue;
          sent.push(v.payload);
          stream.push(...payloadToMidi(v.payload, "host"));
        } else {
          // junk: random status, random channel-16 CCs on our controllers, garbage
          const n = 1 + int(r, 6);
          for (let j = 0; j < n; j++) {
            const kind = int(r, 4);
            if (kind === 0) stream.push([int(r, 256), int(r, 256), int(r, 256)]);
            else if (kind === 1) stream.push([0xbf, 119, int(r, 128)]);
            else if (kind === 2) stream.push([0xbf, 118, 3]);
            else stream.push([0xf8]);
          }
        }
      }
      const delivered: number[][] = [];
      for (const m of stream) {
        const payload = asm.push(m);
        if (!payload) continue;
        const res = decode(payload, "host");
        if (res.ok) delivered.push(payload);
      }
      // every delivered frame is byte-identical to something that was sent,
      // and in the same relative order
      let cursor = 0;
      for (const d of delivered) {
        while (cursor < sent.length && JSON.stringify(sent[cursor]) !== JSON.stringify(d)) cursor++;
        expect(cursor).toBeLessThan(sent.length);
        cursor++;
      }
    }
  });

  test("single-byte corruption is always detected or yields another valid frame", () => {
    const r = rng(3);
    const vectors = validVectors();
    let detected = 0;
    for (let i = 0; i < 5000; i++) {
      const v = vectors[int(r, vectors.length)];
      if (!v) continue;
      const bytes = [...v.payload];
      const at = int(r, bytes.length);
      const delta = 1 + int(r, 127);
      bytes[at] = ((bytes[at] ?? 0) + delta) & 0x7f;
      const res = decode(bytes);
      if (!res.ok) detected++;
      else expect(encode(res.value.message, res.value.seq)).toEqual(bytes);
    }
    // a 7-bit additive checksum catches every single-byte change
    expect(detected).toBe(5000);
  });
});
