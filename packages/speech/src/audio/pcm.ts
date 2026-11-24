/** Conversions between raw little-endian bytes and Int16Array, independent of host endianness. */

export function bytesToInt16(bytes: Uint8Array): Int16Array {
  const count = Math.floor(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

export function int16ToBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] ?? 0, true);
  return out;
}

export function int16ToFloat32(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = (samples[i] ?? 0) / 32768;
  return out;
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
