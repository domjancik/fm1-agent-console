// MicCapture keepRaw: the helper's FM1_MIC_RAW_OUT side output, with the fake helper (never the real microphone).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CaptureError, MicCapture, STALE_RAW_DIR_MS, sweepStaleRawDirs } from "../src/capture";
import { rms } from "../src/audio/level";

const FAKE = fileURLToPath(new URL("./fake-fm1-mic.ts", import.meta.url));
function withMode<T>(mode: string, fn: (command: string[]) => Promise<T>, extra: Record<string, string> = {}): Promise<T> {
  const vars = Object.entries({ FAKE_MIC_MODE: mode, ...extra }).map(([k, v]) => `${k}=${v}`);
  return fn(["/usr/bin/env", ...vars, process.execPath, FAKE]);
}
const pathOut = (tag: string): string => `${process.env.TMPDIR ?? "/tmp"}/fm1-fake-rawpath-${tag}-${process.pid}.txt`;
const exists = (p: string): Promise<boolean> => Bun.file(p).exists();
const rawDirs = (): number => readdirSync(tmpdir()).filter((n) => n.startsWith("fm1-mic-raw-")).length;

describe("MicCapture keepRaw (FM1_MIC_RAW_OUT side output)", () => {
  test("returns the raw stereo capture next to the unchanged mono stream, then deletes the temp file", async () => {
    const out = pathOut("ok");
    await withMode(
      "ok",
      async (command) => {
        const capture = new MicCapture({ command, keepRaw: true });
        await capture.start();
        await Bun.sleep(300);
        const result = await capture.stop();
        expect(result.sampleRate).toBe(16000);
        expect(rms(result.pcm)).toBeGreaterThan(0.1);
        expect(result.raw?.channels).toBe(2);
        expect(result.raw?.sampleRate).toBe(48000);
        const raw = result.raw?.samples ?? new Int16Array();
        expect(raw.length % 2).toBe(0);
        // Fake helper: left = tone, right = silent; same duration as the mono stream.
        expect(Math.abs((raw.length / 2 / 48000) * 1000 - result.durationMs)).toBeLessThan(60);
        const left = raw.filter((_, i) => i % 2 === 0);
        const right = raw.filter((_, i) => i % 2 === 1);
        expect(rms(left)).toBeGreaterThan(0.1);
        expect(rms(right)).toBe(0);
        const rawPath = await Bun.file(out).text();
        expect(await exists(rawPath)).toBe(false);
      },
      { FAKE_MIC_RAW_PATH_OUT: out },
    );
  });

  test("the temp raw file is private (0600 in a 0700 directory) and cancel deletes it", async () => {
    const out = pathOut("mode");
    await withMode(
      "ok",
      async (command) => {
        const capture = new MicCapture({ command, keepRaw: true });
        await capture.start();
        await Bun.sleep(100);
        const rawPath = await Bun.file(out).text();
        expect(statSync(rawPath).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(rawPath)).mode & 0o777).toBe(0o700);
        await capture.cancel();
        expect(await exists(rawPath)).toBe(false);
        expect(await exists(dirname(rawPath))).toBe(false);
      },
      { FAKE_MIC_RAW_PATH_OUT: out },
    );
  });

  test("an older helper that ignores the variable: no raw, mono capture unaffected", async () => {
    await withMode(
      "ok",
      async (command) => {
        const capture = new MicCapture({ command, keepRaw: true });
        await capture.start();
        await Bun.sleep(200);
        const result = await capture.stop();
        expect(result.raw).toBeUndefined();
        expect(rms(result.pcm)).toBeGreaterThan(0.1);
      },
      { FAKE_MIC_OLD_HELPER: "1" },
    );
  });

  test("without keepRaw the helper gets no raw path and nothing raw comes back", async () => {
    const out = pathOut("off");
    await withMode(
      "ok",
      async (command) => {
        const capture = new MicCapture({ command });
        await capture.start();
        await Bun.sleep(150);
        const result = await capture.stop();
        expect(result.raw).toBeUndefined();
        expect(await exists(out)).toBe(false);
      },
      { FAKE_MIC_RAW_PATH_OUT: out },
    );
  });

  test("a helper that fails to start leaves no raw temp directory behind", async () => {
    const before = rawDirs();
    await withMode("denied", async (command) => {
      const err = await new MicCapture({ command, keepRaw: true }).start().catch((e: unknown) => e);
      expect((err as CaptureError).code).toBe("permission_denied");
    });
    expect(rawDirs()).toBeLessThanOrEqual(before);
  });

  test("a helper crash mid-recording still surfaces as exited and cleans up", async () => {
    const before = rawDirs();
    await withMode("crash", async (command) => {
      const capture = new MicCapture({ command, keepRaw: true });
      await capture.start();
      await Bun.sleep(400);
      const err = await capture.stop().catch((e: unknown) => e);
      expect((err as CaptureError).code).toBe("exited");
    });
    expect(rawDirs()).toBeLessThanOrEqual(before);
  });

  test("leftover raw temp directories of a crashed run are swept once over an hour old; nothing else is touched", () => {
    const base = mkdtempSync(join(tmpdir(), "fm1-sweep-"));
    try {
      const now = Date.now();
      const old = (now - STALE_RAW_DIR_MS - 60_000) / 1000;
      mkdirSync(join(base, "fm1-mic-raw-old"));
      writeFileSync(join(base, "fm1-mic-raw-old", "raw.s16le"), "x");
      utimesSync(join(base, "fm1-mic-raw-old"), old, old);
      mkdirSync(join(base, "fm1-mic-raw-fresh")); // a take in progress
      mkdirSync(join(base, "other-old"));
      utimesSync(join(base, "other-old"), old, old);
      writeFileSync(join(base, "fm1-mic-raw-file"), "not a directory");
      utimesSync(join(base, "fm1-mic-raw-file"), old, old);
      expect(sweepStaleRawDirs(STALE_RAW_DIR_MS, now, base)).toBe(1);
      expect(readdirSync(base).sort()).toEqual(["fm1-mic-raw-file", "fm1-mic-raw-fresh", "other-old"]);
      expect(sweepStaleRawDirs(STALE_RAW_DIR_MS, now, join(base, "missing"))).toBe(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
