// Kept voice recordings (voice.keepRecordings) and per-take diagnostics, on synthetic PCM (never the microphone).
import { afterEach, describe, expect, test } from "bun:test";
import { MockAdapter, fixturePath } from "@fm1/agent-core";
import { FakeClock, LoopbackPair } from "@fm1/device-protocol";
import { ScriptedDriver, SimDevice } from "@fm1/device-simulator";
import { decodeWav, toMono } from "@fm1/speech";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Companion } from "../src/companion";
import { ConfigError, DEFAULT_CONFIG, mergeConfig, serializable } from "../src/config";
import { DiagLog } from "../src/diag-log";
import { FixtureCapture, type CapturedAudio } from "../src/voice/capture";
import { DEFAULT_KEEP_RECORDINGS, expandHome, MIN_KEEP_MS, PRUNE_EVERY_MS, RecordingStore, type KeepRecordingsConfig } from "../src/voice/recordings";
import { ScriptedTranscriber, SpeechTranscriber, type Transcriber, type TranscriptOutcome } from "../src/voice/transcriber";
import type { AsrEngine } from "@fm1/speech";
import { clockTimers, ioSleeper } from "./rig";

const T0 = Date.parse("2026-11-19T10:00:00.000Z");
const RATE = 48000;
const TEXT = "Rename parse device frame to decode frame.";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(d, 0o700);
    } catch {
      // already gone
    }
    rmSync(d, { recursive: true, force: true });
  }
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "fm1-recs-"));
  dirs.push(d);
  return d;
}

function tone(amp: number, seconds: number): Int16Array {
  const n = Math.round(seconds * RATE);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / RATE));
  return out;
}

/** Synthetic stereo take: the mono stream is the plain average, as FixtureCapture builds it from a stereo WAV. */
function stereo(l: Int16Array, r: Int16Array): CapturedAudio {
  const samples = new Int16Array(l.length * 2);
  for (let i = 0; i < l.length; i++) {
    samples[i * 2] = l[i] ?? 0;
    samples[i * 2 + 1] = r[i] ?? 0;
  }
  return { pcm: toMono(samples, 2), sampleRate: RATE, raw: { samples, sampleRate: RATE, channels: 2 }, device: "Synthetic Wireless Mic" };
}

const leftOnly = (seconds = 1.5): CapturedAudio => stereo(tone(8000, seconds), new Int16Array(Math.round(seconds * RATE)));
const inverted = (seconds = 1.5): CapturedAudio => {
  const t = tone(8000, seconds);
  return stereo(t, t.map((v) => -v));
};

function store(dir: string, clock: { now: number }, cfg: Partial<KeepRecordingsConfig> = {}, log: string[] = []): RecordingStore {
  return new RecordingStore({ ...DEFAULT_KEEP_RECORDINGS, dir, ...cfg }, { now: () => clock.now, every: () => () => undefined, log: (l, t) => log.push(`${l}: ${t}`) });
}

const takes = (dir: string): string[] => readdirSync(dir).filter((n) => n.endsWith(".json")).sort();

describe("RecordingStore", () => {
  test("saves raw WAV, mono WAV and sidecar, 0600 files in a 0700 directory", async () => {
    const dir = join(tmp(), "recordings");
    const clock = { now: T0 };
    const s = store(dir, clock);
    const audio = leftOnly();
    const saved = await s.save(audio, { outcome: "transcript", transcript: TEXT }, 1500);
    expect(saved?.file).toBe("take-20261119T100000000Z-1.wav");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const files = readdirSync(dir).sort();
    expect(files).toEqual(["take-20261119T100000000Z-1.json", "take-20261119T100000000Z-1.mono.wav", "take-20261119T100000000Z-1.wav"]);
    for (const f of files) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
    const raw = decodeWav(new Uint8Array(await Bun.file(join(dir, files[2] ?? "")).arrayBuffer()));
    expect(raw).toMatchObject({ channels: 2, sampleRate: RATE });
    expect(raw.samples).toEqual(audio.raw?.samples ?? new Int16Array());
    const mono = decodeWav(new Uint8Array(await Bun.file(join(dir, files[1] ?? "")).arrayBuffer()));
    expect(mono.channels).toBe(1);
    expect(mono.samples).toEqual(audio.pcm);
    const meta = await Bun.file(join(dir, files[0] ?? "")).json();
    expect(meta).toMatchObject({ outcome: "transcript", transcript: TEXT, savedAt: "2026-11-19T10:00:00.000Z", files: { raw: files[2], mono: files[1] } });
  });

  test("an existing directory keeps its modes (it may be the operator's own); wider modes give one warning", async () => {
    const dir = tmp();
    chmodSync(dir, 0o755);
    const log: string[] = [];
    const s = store(dir, { now: T0 }, {}, log);
    await s.save(leftOnly(), {}, 1500);
    await s.save(leftOnly(), {}, 1500);
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(log.filter((l) => l.includes("readable by other users"))).toHaveLength(1);
    for (const f of readdirSync(dir)) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
    const priv = tmp(); // 0700 from mkdtemp: no warning
    const quiet: string[] = [];
    await store(priv, { now: T0 }, {}, quiet).save(leftOnly(), {}, 1500);
    expect(quiet).toEqual([]);
  });

  test("prunes by count: the newest `count` takes stay", async () => {
    const dir = tmp();
    const clock = { now: T0 };
    const s = store(dir, clock, { count: 3 });
    for (let i = 0; i < 6; i++) {
      await s.save(leftOnly(0.5), { i }, 500);
      clock.now += 60_000;
    }
    const left = takes(dir);
    expect(left).toHaveLength(3);
    expect(await Promise.all(left.map(async (f) => (await Bun.file(join(dir, f)).json()).i))).toEqual([3, 4, 5]);
    expect(readdirSync(dir)).toHaveLength(9);
  });

  test("prunes by TTL on prune(), on start() and from the hourly timer; other files are left alone", async () => {
    const dir = tmp();
    const clock = { now: T0 };
    let hourly: (() => void) | null = null;
    let period = 0;
    const s = new RecordingStore({ count: 5, ttlHours: 2, dir }, { now: () => clock.now, every: (ms, fn) => ((period = ms), (hourly = fn), () => (hourly = null)) });
    writeFileSync(join(dir, "notes.txt"), "keep me");
    await s.save(leftOnly(0.5), {}, 500);
    clock.now += 90 * 60_000;
    await s.save(leftOnly(0.5), {}, 500);
    expect(takes(dir)).toHaveLength(2);

    clock.now += 31 * 60_000; // first take is now 2 h 1 min old
    await s.start();
    expect(period).toBe(PRUNE_EVERY_MS);
    expect(takes(dir)).toHaveLength(1);

    clock.now += 2 * 3600_000;
    (hourly as (() => void) | null)?.();
    await s.prune(); // queued behind the timer's prune
    expect(takes(dir)).toHaveLength(0);
    expect(readdirSync(dir)).toEqual(["notes.txt"]);
    s.stop();
    expect(hourly).toBeNull();
  });

  test("a fresh store prunes old takes left by an earlier run, including orphans", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "take-20261117T080000000Z-1.wav"), "x");
    writeFileSync(join(dir, "take-20261117T080000000Z-2.json"), "{}");
    writeFileSync(join(dir, "take-20261119T095900000Z-9.json"), "{}");
    expect(await store(dir, { now: T0 }).prune()).toBe(2);
    expect(readdirSync(dir)).toEqual(["take-20261119T095900000Z-9.json"]);
  });

  test("REC taps (< 350 ms) and count 0 keep nothing", async () => {
    const dir = tmp();
    const s = store(dir, { now: T0 });
    expect(await s.save(leftOnly(0.2), {}, MIN_KEEP_MS - 1)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
    const off = store(dir, { now: T0 }, { count: 0 });
    expect(off.enabled).toBe(false);
    expect(await off.save(leftOnly(), {}, 1500)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a directory that cannot be created: save resolves null and logs, never throws", async () => {
    const base = tmp();
    writeFileSync(join(base, "file"), "not a directory");
    const log: string[] = [];
    const s = store(join(base, "file", "recordings"), { now: T0 }, {}, log);
    expect(await s.save(leftOnly(), {}, 1500)).toBeNull();
    expect(log.some((l) => l.startsWith("warn: keeping the recording failed"))).toBe(true);
    expect(await s.prune()).toBe(0);
  });

  test("a directory under a read-only parent: save resolves null; once writable, saving works again", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "ro"));
    chmodSync(join(dir, "ro"), 0o500);
    const s = store(join(dir, "ro", "sub"), { now: T0 });
    expect(await s.save(leftOnly(), {}, 1500)).toBeNull();
    chmodSync(join(dir, "ro"), 0o700);
    expect(await s.save(leftOnly(), {}, 1500)).not.toBeNull();
  });

  test("expandHome", () => {
    expect(expandHome("~/.fm1-console/recordings", "/Users/x")).toBe("/Users/x/.fm1-console/recordings");
    expect(expandHome("/var/recs", "/Users/x")).toBe("/var/recs");
  });
});

describe("voice.keepRecordings config", () => {
  test("enabled by default: 5 takes, 24 h, ~/.fm1-console/recordings; not written while default", () => {
    expect(DEFAULT_CONFIG.voice.keepRecordings).toEqual({ count: 5, ttlHours: 24, dir: "~/.fm1-console/recordings" });
    expect(serializable(DEFAULT_CONFIG).voice).toBeUndefined();
  });

  test("partial patches merge; false turns it off; changes are written", () => {
    const c = mergeConfig(DEFAULT_CONFIG, { voice: { keepRecordings: { count: 2 } } });
    expect(c.voice.keepRecordings).toEqual({ count: 2, ttlHours: 24, dir: "~/.fm1-console/recordings" });
    expect(serializable(c).voice).toEqual({ keepRecordings: { count: 2, ttlHours: 24, dir: "~/.fm1-console/recordings" } });
    expect(mergeConfig(DEFAULT_CONFIG, { voice: { keepRecordings: false } }).voice.keepRecordings.count).toBe(0);
    expect(DEFAULT_CONFIG.voice.keepRecordings.count).toBe(5); // the default object is not mutated
    expect(mergeConfig(c, JSON.parse(JSON.stringify(serializable(c)))).voice).toEqual(c.voice);
  });

  test("bad values are refused", () => {
    for (const bad of [
      { voice: 1 },
      { voice: { other: true } },
      { voice: { keepRecordings: { count: -1 } } },
      { voice: { keepRecordings: { count: 1.5 } } },
      { voice: { keepRecordings: { count: 101 } } },
      { voice: { keepRecordings: { ttlHours: 0 } } },
      { voice: { keepRecordings: { dir: "relative/path" } } },
      { voice: { keepRecordings: { extra: 1 } } },
      { voice: { keepRecordings: "yes" } },
    ]) {
      expect(() => mergeConfig(DEFAULT_CONFIG, bad)).toThrow(ConfigError);
    }
  });
});

// --- through the device link: REC hold -> capture -> transcriber -> diag log + kept recording ---

interface Flow {
  companion: Companion;
  device: SimDevice;
  driver: ScriptedDriver;
  log: DiagLog;
  stop(): Promise<void>;
}

async function flow(audio: CapturedAudio, transcriber: Transcriber, recordings: RecordingStore | null): Promise<Flow> {
  const clock = new FakeClock(T0);
  const pair = new LoopbackPair();
  const log = new DiagLog(500, () => clock.now());
  const companion = new Companion({ adapter: MockAdapter.fromFixture(fixturePath("mixed")), capture: () => new FixtureCapture(audio, clock), transcriber, clock, timers: clockTimers(clock), now: () => clock.now(), log, tickMs: 0 });
  companion.voice.setRecordings(recordings);
  await companion.start();
  companion.device.attach(pair.host, "loopback");
  const device = new SimDevice({ transport: pair.device, clock });
  device.start();
  const driver = new ScriptedDriver(device, ioSleeper(clock));
  await driver.waitFor((s) => s.link.phase === "connected" && s.slots[0]?.label !== "");
  return {
    companion,
    device,
    driver,
    log,
    async stop() {
      device.stop();
      await companion.stop();
    },
  };
}

async function take(f: Flow, until: "reviewing" | "failed"): Promise<string> {
  await f.driver.press(0);
  await f.driver.hold("REC", 600);
  await f.driver.waitFor((s) => s.voice.voice === until, 3000);
  await f.companion.voice.idle();
  const line = f.log.recent(50).find((e) => e.source === "voice" && e.text.startsWith("take "));
  if (!line) throw new Error("no take line");
  return line.text;
}

let open: Flow | null = null;
afterEach(async () => {
  await open?.stop();
  open = null;
});

describe("per-take diagnostics through the device link", () => {
  test("one silent channel: per-channel and mono stats in the log, recording kept, transcript only in the sidecar", async () => {
    const dir = tmp();
    open = await flow(leftOnly(), new ScriptedTranscriber(TEXT), store(dir, { now: T0 }));
    const line = await take(open, "reviewing");
    expect(line).toMatch(/^take 1\.50 s, 48000 Hz x2 \(Synthetic Wireless Mic\); L rms -15\.3 peak -12\.2 dBFS voiced 1500 ms; R rms -120\.0 peak -120\.0 dBFS voiced 0 ms; mono 48000 Hz rms -21\.3 peak -18\.3 dBFS voiced 1500 ms; gate accepted; engine scripted; asr 0 ms; transcript 42 chars; outcome transcript; kept take-\d{8}T\d{9}Z-1\.wav$/);
    expect(open.companion.console.composer.state.transcript).toBe(TEXT);
    for (const e of open.log.recent(500)) expect(e.text).not.toContain(TEXT);
    const [json] = takes(dir);
    const meta = await Bun.file(join(dir, json ?? "")).json();
    expect(meta).toMatchObject({ outcome: "transcript", gate: "accepted", engine: "scripted", chars: 42, transcript: TEXT, device: "Synthetic Wireless Mic" });
    expect(meta.stats.perChannel.map((c: { label: string; voicedMs: number }) => [c.label, c.voicedMs])).toEqual([["L", 1500], ["R", 0]]);
  });

  test("phase-inverted channels: the mono mix is silent and gated; kept as failed with no transcript", async () => {
    const dir = tmp();
    open = await flow(inverted(), new ScriptedTranscriber(TEXT), store(dir, { now: T0 }));
    const line = await take(open, "failed");
    expect(line).toContain("L rms -15.3 peak -12.2 dBFS voiced 1500 ms; R rms -15.3 peak -12.2 dBFS voiced 1500 ms; mono 48000 Hz rms -120.0");
    expect(line).toContain("gate silent; engine scripted; asr 0 ms; transcript 0 chars; outcome failed (silent recording); kept take-");
    const meta = await Bun.file(join(dir, takes(dir)[0] ?? "")).json();
    expect(meta).toMatchObject({ outcome: "failed", reason: "silent recording", gate: "silent", chars: 0 });
    expect(meta.transcript).toBeUndefined();
  });

  test("a REC tap (< 350 ms) is logged but not kept", async () => {
    const dir = tmp();
    open = await flow(leftOnly(0.25), new ScriptedTranscriber(TEXT), store(dir, { now: T0 }));
    const line = await take(open, "failed");
    expect(line).toContain("gate too_short");
    expect(line).not.toContain("kept");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a recording store that fails does not break dictation", async () => {
    const base = tmp();
    writeFileSync(join(base, "file"), "x");
    open = await flow(leftOnly(), new ScriptedTranscriber(TEXT), store(join(base, "file", "recs"), { now: T0 }));
    const line = await take(open, "reviewing");
    expect(open.companion.console.composer.state.transcript).toBe(TEXT);
    expect(line).toContain("outcome transcript");
    expect(line).not.toContain("kept");
  });

  test("the take line is computed a macrotask after the transcript reached the composer (never ahead of it)", async () => {
    open = await flow(leftOnly(), new ScriptedTranscriber(TEXT), null);
    const f = open;
    const original = f.companion.console.voiceTranscript.bind(f.companion.console);
    let lineBeforeNextTask: boolean | null = null;
    f.companion.console.voiceTranscript = (text: string) => {
      const res = original(text);
      // A timer queued with the transcript runs before the controller's deferred report.
      setTimeout(() => (lineBeforeNextTask = f.log.recent(50).some((e) => e.source === "voice" && e.text.startsWith("take "))), 0);
      return res;
    };
    await take(f, "reviewing");
    expect(lineBeforeNextTask === false).toBe(true);
  });

  test("a store whose save rejects: still reviewing, a warning instead of a take line", async () => {
    const broken = { wouldKeep: () => true, save: () => Promise.reject(new Error("disk on fire")) } as unknown as RecordingStore;
    open = await flow(leftOnly(), new ScriptedTranscriber(TEXT), broken);
    await open.driver.press(0);
    await open.driver.hold("REC", 600);
    await open.driver.waitFor((s) => s.voice.voice === "reviewing", 3000);
    await open.companion.voice.idle();
    expect(open.companion.console.composer.state.transcript).toBe(TEXT);
    expect(open.log.recent(50).some((e) => e.level === "warn" && e.text === "take stats failed: disk on fire")).toBe(true);
  });

  test("no store attached: stats are still logged (mono-only capture has no per-channel part)", async () => {
    const mono: CapturedAudio = { pcm: tone(8000, 1), sampleRate: RATE };
    open = await flow(mono, new ScriptedTranscriber(TEXT), null);
    const line = await take(open, "reviewing");
    expect(line).toMatch(/^take 1\.00 s, 48000 Hz x1; mono 48000 Hz rms -15\.3 peak -12\.2 dBFS voiced 990 ms; gate accepted/);
  });

  test("a transcriber failure ('no speech recognised') is kept with its ASR time", async () => {
    const dir = tmp();
    const asr: Transcriber = {
      id: "fake-asr",
      async transcribe(): Promise<TranscriptOutcome> {
        return { ok: false, reason: "no speech recognised", detail: { gate: "accepted", engine: "sherpa-parakeet-v3", asrMs: 312, chars: 0 } };
      },
      async dispose() {},
    };
    open = await flow(leftOnly(), asr, store(dir, { now: T0 }));
    const line = await take(open, "failed");
    expect(line).toContain("gate accepted; engine sherpa-parakeet-v3; asr 312 ms; transcript 0 chars; outcome failed (no speech recognised); kept take-");
  });
});

describe("SpeechTranscriber take detail", () => {
  const engine = (text: string): AsrEngine => ({
    id: "fake-parakeet",
    supportsLanguage: () => true,
    load: async () => ({ ms: 0 }),
    transcribe: async () => ({ text, ms: 123 }),
    dispose: async () => undefined,
  });

  test("an empty result reports gate, engine and ASR time, and no text", async () => {
    const t = new SpeechTranscriber({ engine: "sherpa", language: "en", vocabularyFile: null, engineInstance: engine("") });
    const r = await t.transcribe(leftOnly());
    expect(r).toMatchObject({ ok: false, reason: "no speech recognised", detail: { gate: "accepted", engine: "fake-parakeet", asrMs: 123, chars: 0 } });
    expect(r.detail?.gateStats?.voicedMs).toBeGreaterThan(1000);
  });

  test("a gated take reports the reject reason with 0 ms ASR; a good one its length", async () => {
    const t = new SpeechTranscriber({ engine: "sherpa", language: "en", vocabularyFile: null, engineInstance: engine("hello there") });
    expect((await t.transcribe(inverted())).detail).toMatchObject({ gate: "silent", asrMs: 0, chars: 0 });
    expect(await t.transcribe(leftOnly())).toMatchObject({ ok: true, text: "hello there", detail: { gate: "accepted", chars: 11 } });
  });
});
