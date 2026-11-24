import { describe, expect, test } from "bun:test";
import { rms, toDbfs } from "../src/audio/level";
import { bytesToInt16, int16ToBytes } from "../src/audio/pcm";
import { resample, toMono } from "../src/audio/resample";
import { decodeWav, encodeWav, WavError } from "../src/audio/wav";
import { decodePcm, encodePcm } from "../src/asr/protocol";
import { wordErrorRate } from "../src/fixtures";

const sine = (rate: number, hz: number, seconds: number, amplitude = 10000): Int16Array => {
  const out = new Int16Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / rate));
  return out;
};

describe("wav", () => {
  test("encode/decode round trip", () => {
    const pcm = sine(16000, 440, 0.25);
    const wav = decodeWav(encodeWav(pcm, 16000));
    expect(wav.sampleRate).toBe(16000);
    expect(wav.channels).toBe(1);
    expect([...wav.samples]).toEqual([...pcm]);
  });

  test("decodes stereo and skips unknown chunks", () => {
    const base = encodeWav(new Int16Array([1, 2, 3, 4]), 8000, 2);
    // Insert a LIST chunk between fmt and data.
    const list = new Uint8Array([0x4c, 0x49, 0x53, 0x54, 4, 0, 0, 0, 1, 2, 3, 4]);
    const bytes = new Uint8Array(base.length + list.length);
    bytes.set(base.subarray(0, 36));
    bytes.set(list, 36);
    bytes.set(base.subarray(36), 36 + list.length);
    const wav = decodeWav(bytes);
    expect(wav.channels).toBe(2);
    expect([...toMono(wav.samples, 2)]).toEqual([2, 4]);
  });

  test("rejects non-WAV input", () => {
    expect(() => decodeWav(new Uint8Array(10))).toThrow(WavError);
  });

  test("rejects a truncated fmt chunk with WavError, not RangeError", () => {
    const full = encodeWav(new Int16Array([1, 2]), 16000);
    expect(() => decodeWav(full.subarray(0, 30))).toThrow(WavError);
  });
});

describe("resample", () => {
  test("48 kHz -> 16 kHz keeps length ratio and in-band level", () => {
    const input = sine(48000, 440, 1);
    const out = resample(input, 48000, 16000);
    expect(out.length).toBe(16000);
    expect(toDbfs(rms(out))).toBeCloseTo(toDbfs(rms(input)), 0);
  });

  test("removes content above the new Nyquist", () => {
    const out = resample(sine(48000, 12000, 0.5), 48000, 16000);
    expect(toDbfs(rms(out.subarray(200, out.length - 200)))).toBeLessThan(-40);
  });

  test("same rate is identity", () => {
    const input = sine(16000, 440, 0.1);
    expect(resample(input, 16000, 16000)).toBe(input);
  });
});

describe("pcm codecs", () => {
  test("little-endian bytes round trip", () => {
    const pcm = new Int16Array([0, 1, -1, 32767, -32768]);
    expect([...bytesToInt16(int16ToBytes(pcm))]).toEqual([...pcm]);
    expect([...bytesToInt16(new Uint8Array([1, 0, 0xff]))]).toEqual([1]); // trailing odd byte dropped
  });

  test("worker base64 round trip", () => {
    const pcm = sine(16000, 300, 0.05);
    expect([...decodePcm(encodePcm(pcm))]).toEqual([...pcm]);
  });
});

describe("word error rate", () => {
  test("ignores case and punctuation", () => {
    expect(wordErrorRate("Run the tests.", "run the tests")).toBe(0);
    expect(wordErrorRate("a b c d", "a x c")).toBe(0.5);
    expect(wordErrorRate("", "")).toBe(0);
  });
});
