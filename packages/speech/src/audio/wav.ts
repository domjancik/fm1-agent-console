/** Minimal RIFF/WAVE reader and writer: PCM 8/16/24/32-bit, IEEE float 32/64, WAVE_FORMAT_EXTENSIBLE. */

export interface DecodedWav {
  sampleRate: number;
  channels: number;
  /** Interleaved samples, signed 16-bit. */
  samples: Int16Array;
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

export class WavError extends Error {
  override name = "WavError";
}

function fourcc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

interface FmtChunk {
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
}

function readFmt(view: DataView, offset: number, size: number): FmtChunk {
  if (size < 16) throw new WavError("fmt chunk too small");
  let format = view.getUint16(offset, true);
  const bitsPerSample = view.getUint16(offset + 14, true);
  if (format === FORMAT_EXTENSIBLE) {
    if (size < 40) throw new WavError("extensible fmt chunk too small");
    format = view.getUint16(offset + 24, true); // first two bytes of the SubFormat GUID
  }
  return {
    format,
    channels: view.getUint16(offset + 2, true),
    sampleRate: view.getUint32(offset + 4, true),
    bitsPerSample,
  };
}

function sampleReader(fmt: FmtChunk): (view: DataView, offset: number) => number {
  const clamp = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v)));
  if (fmt.format === FORMAT_PCM) {
    switch (fmt.bitsPerSample) {
      case 8:
        return (v, o) => (v.getUint8(o) - 128) << 8;
      case 16:
        return (v, o) => v.getInt16(o, true);
      case 24:
        return (v, o) => ((v.getUint8(o + 2) << 24) | (v.getUint8(o + 1) << 16) | (v.getUint8(o) << 8)) >> 16;
      case 32:
        return (v, o) => v.getInt32(o, true) >> 16;
    }
  }
  if (fmt.format === FORMAT_FLOAT) {
    if (fmt.bitsPerSample === 32) return (v, o) => clamp(v.getFloat32(o, true) * 32768);
    if (fmt.bitsPerSample === 64) return (v, o) => clamp(v.getFloat64(o, true) * 32768);
  }
  throw new WavError(`unsupported WAV encoding: format ${fmt.format}, ${fmt.bitsPerSample} bits`);
}

export function decodeWav(bytes: Uint8Array): DecodedWav {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || fourcc(view, 0) !== "RIFF" || fourcc(view, 8) !== "WAVE") {
    throw new WavError("not a RIFF/WAVE file");
  }
  let fmt: FmtChunk | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = fourcc(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (body + Math.max(size, 16) > bytes.byteLength) throw new WavError("truncated fmt chunk");
      fmt = readFmt(view, body, size);
    }
    if (id === "data") {
      if (!fmt) throw new WavError("data chunk before fmt chunk");
      if (fmt.channels < 1 || fmt.sampleRate < 1) throw new WavError("invalid channel count or sample rate");
      const read = sampleReader(fmt);
      const step = fmt.bitsPerSample / 8;
      const available = Math.min(size, bytes.byteLength - body);
      const count = Math.floor(available / step);
      const samples = new Int16Array(count);
      for (let i = 0; i < count; i++) samples[i] = read(view, body + i * step);
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples };
    }
    offset = body + size + (size % 2);
  }
  throw new WavError("no data chunk");
}

/** Encodes mono or interleaved 16-bit PCM as a WAV file. */
export function encodeWav(samples: Int16Array, sampleRate: number, channels = 1): Uint8Array {
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, FORMAT_PCM, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i] ?? 0, true);
  return out;
}
