// Per-channel take statistics on synthetic stereo PCM (no microphone).
import { describe, expect, test } from "bun:test";
import { channelLabel, channelOf, isChannelPick, pickChannel } from "../src/audio/channels";
import { toMono } from "../src/audio/resample";
import { SILENCE_DBFS } from "../src/audio/level";
import { takeStats } from "../src/take-stats";

const RATE = 48000;

/** 1 s of a 300 Hz tone at `amp`, `seconds` long. */
function tone(amp: number, seconds = 1, rate = RATE): Int16Array {
  const n = Math.round(seconds * rate);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * 300 * i) / rate));
  return out;
}

function interleave(l: Int16Array, r: Int16Array): Int16Array {
  const out = new Int16Array(l.length * 2);
  for (let i = 0; i < l.length; i++) {
    out[i * 2] = l[i] ?? 0;
    out[i * 2 + 1] = r[i] ?? 0;
  }
  return out;
}

function invert(x: Int16Array): Int16Array {
  return x.map((v) => (v === -32768 ? 32767 : -v));
}

const stats = (l: Int16Array, r: Int16Array) => {
  const samples = interleave(l, r);
  return takeStats(toMono(samples, 2), RATE, { samples, sampleRate: RATE, channels: 2 });
};

describe("takeStats on synthetic stereo", () => {
  test("one silent channel: the average loses about 6 dB against the live channel", () => {
    const s = stats(tone(8000), new Int16Array(RATE));
    expect(s.channels).toBe(2);
    expect(s.sampleRate).toBe(RATE);
    expect(s.durationMs).toBeCloseTo(1000, 0);
    const [l, r] = s.perChannel;
    expect(l?.label).toBe("L");
    expect(r?.label).toBe("R");
    expect(l?.voicedMs).toBeGreaterThan(900);
    expect(r?.rmsDbfs).toBe(SILENCE_DBFS);
    expect(r?.voicedMs).toBe(0);
    expect((l?.rmsDbfs ?? 0) - s.mono.rmsDbfs).toBeCloseTo(6.02, 1);
    expect((l?.peakDbfs ?? 0) - s.mono.peakDbfs).toBeCloseTo(6.02, 1);
  });

  test("phase-inverted channels: both voiced, the average is silent", () => {
    const t = tone(8000);
    const s = stats(t, invert(t));
    expect(s.perChannel.map((c) => c.voicedMs > 900)).toEqual([true, true]);
    expect(s.mono.rmsDbfs).toBe(SILENCE_DBFS);
    expect(s.mono.voicedMs).toBe(0);
  });

  test("the same signal on both channels: the average equals each channel", () => {
    const t = tone(8000);
    const s = stats(t, t);
    expect(s.perChannel[0]?.rmsDbfs).toBeCloseTo(s.mono.rmsDbfs, 5);
    expect(s.perChannel[1]?.rmsDbfs).toBeCloseTo(s.mono.rmsDbfs, 5);
    expect(s.mono.voicedMs).toBe(s.perChannel[0]?.voicedMs ?? -1);
  });

  test("without the raw capture only the mono stream is described", () => {
    const s = takeStats(tone(8000, 0.5, 16000), 16000);
    expect(s.perChannel).toEqual([]);
    expect(s.channels).toBe(1);
    expect(s.sampleRate).toBe(16000);
    expect(s.durationMs).toBeCloseTo(500, 0);
    expect(s.mono.sampleRate).toBe(16000);
  });

  test("mono rate and raw rate are measured separately (48 kHz raw, 16 kHz mono)", () => {
    const raw = interleave(tone(8000), tone(8000));
    const s = takeStats(tone(8000, 1, 16000), 16000, { samples: raw, sampleRate: RATE, channels: 2 });
    expect(s.durationMs).toBeCloseTo(1000, 0);
    expect(s.mono.durationMs).toBeCloseTo(1000, 0);
    expect(s.mono.sampleRate).toBe(16000);
  });
});

describe("channel helpers", () => {
  const l = Int16Array.from([1, 2, 3]);
  const r = Int16Array.from([-1, -2, -3]);
  const lr = interleave(l, r);

  test("channelOf and pickChannel split interleaved PCM", () => {
    expect([...channelOf(lr, 2, 0)]).toEqual([1, 2, 3]);
    expect([...pickChannel(lr, 2, "R")]).toEqual([-1, -2, -3]);
    expect([...pickChannel(lr, 2, "mix")]).toEqual([0, 0, 0]);
    expect(pickChannel(l, 1, "L")).toBe(l);
  });

  test("bad picks are refused", () => {
    expect(() => pickChannel(l, 1, "R")).toThrow(RangeError);
    expect(() => channelOf(lr, 2, 2)).toThrow(RangeError);
    expect(() => channelOf(lr, 0, 0)).toThrow(RangeError);
    expect(isChannelPick("L")).toBe(true);
    expect(isChannelPick("left")).toBe(false);
  });

  test("labels", () => {
    expect([channelLabel(0, 1), channelLabel(0, 2), channelLabel(1, 2), channelLabel(2, 4)]).toEqual(["M", "L", "R", "ch3"]);
  });
});
