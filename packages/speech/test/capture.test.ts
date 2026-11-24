import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { CaptureError, DEFAULT_MAX_SECONDS, listInputDevices, micPermission, MicCapture } from "../src/capture";
import { rms } from "../src/audio/level";

const FAKE = fileURLToPath(new URL("./fake-fm1-mic.ts", import.meta.url));
/** Runs fn with a fake helper command configured through `env` (Bun.spawn snapshots process.env). */
function withMode<T>(mode: string, fn: (command: string[]) => Promise<T>, extra: Record<string, string> = {}): Promise<T> {
  const vars = Object.entries({ FAKE_MIC_MODE: mode, ...extra }).map(([k, v]) => `${k}=${v}`);
  return fn(["/usr/bin/env", ...vars, process.execPath, FAKE]);
}

describe("MicCapture with a fake fm1-mic", () => {
  test("records PCM, reports levels and start latency, stops on SIGTERM", async () => {
    await withMode("ok", async (command) => {
      const capture = new MicCapture({ command, sampleRate: 16000, deviceUid: "BuiltInMicrophoneDevice" });
      const levels: number[] = [];
      capture.onLevel((level) => levels.push(level));
      const start = await capture.start();
      expect(start.latencyMs).toBeGreaterThan(0);
      expect(start.sampleRate).toBe(16000);
      expect(start.device?.uid).toBe("BuiltInMicrophoneDevice");
      expect(capture.recording).toBe(true);
      await Bun.sleep(400);
      const result = await capture.stop();
      expect(result.stopReason).toBe("sigterm");
      expect(result.sampleRate).toBe(16000);
      expect(result.pcm.length).toBeGreaterThan(16000 * 0.2);
      expect(result.durationMs).toBeCloseTo((result.pcm.length / 16000) * 1000);
      expect(rms(result.pcm)).toBeGreaterThan(0.1);
      expect(levels.length).toBeGreaterThan(2);
      expect(result.maxRms).toBeGreaterThan(0.1);
    });
  });

  test("passes device, rate and max-seconds to the helper", async () => {
    const out = `${process.env.TMPDIR ?? "/tmp"}/fm1-fake-args-${process.pid}.json`;
    await withMode(
      "ok",
      async (command) => {
        const capture = new MicCapture({ command, deviceUid: "dev-123", sampleRate: 16000, maxSeconds: 30 });
        await capture.start();
        await capture.cancel();
        const args = (await Bun.file(out).json()) as string[];
        expect(args).toEqual(["--rate", "16000", "--device", "dev-123", "--max-seconds", "30"]);
      },
      { FAKE_MIC_ARGS_OUT: out },
    );
  });

  test("silent input yields near-zero PCM", async () => {
    await withMode("silent", async (command) => {
      const capture = new MicCapture({ command });
      await capture.start();
      await Bun.sleep(200);
      const result = await capture.stop();
      expect(result.pcm.length).toBeGreaterThan(0);
      expect(rms(result.pcm)).toBe(0);
      expect(result.maxRms).toBe(0);
    });
  });

  test("permission denied rejects start with permission_denied", async () => {
    await withMode("denied", async (command) => {
      const err = await new MicCapture({ command }).start().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CaptureError);
      expect((err as CaptureError).code).toBe("permission_denied");
    });
  });

  test("missing device rejects start with no_device", async () => {
    await withMode("nodevice", async (command) => {
      const err = await new MicCapture({ command }).start().catch((e: unknown) => e);
      expect((err as CaptureError).code).toBe("no_device");
    });
  });

  test("missing binary fails with binary_missing", async () => {
    const saved = process.env.FM1_MIC_BIN;
    process.env.FM1_MIC_BIN = "/nonexistent/fm1-mic";
    try {
      const err = await new MicCapture().start().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CaptureError);
      expect((err as CaptureError).code).toBe("binary_missing");
    } finally {
      if (saved === undefined) delete process.env.FM1_MIC_BIN;
      else process.env.FM1_MIC_BIN = saved;
    }
  });

  test("cancel discards audio and a later stop is refused", async () => {
    await withMode("ok", async (command) => {
      const capture = new MicCapture({ command });
      await capture.start();
      await Bun.sleep(150);
      await capture.cancel();
      expect(capture.recording).toBe(false);
      await expect(capture.stop()).rejects.toThrow(CaptureError);
    });
  });

  test("cancel before the helper starts rejects the pending start", async () => {
    await withMode(
      "ok",
      async (command) => {
        const capture = new MicCapture({ command });
        const started = capture.start().catch((e: unknown) => e);
        await capture.cancel();
        const err = await started;
        expect(err).toBeInstanceOf(CaptureError);
        expect((err as CaptureError).code).toBe("state");
      },
      { FAKE_MIC_START_DELAY_MS: "500" },
    );
  });

  test("helper crash mid-recording surfaces as exited", async () => {
    await withMode("crash", async (command) => {
      const capture = new MicCapture({ command });
      await capture.start();
      await Bun.sleep(400);
      const err = await capture.stop().catch((e: unknown) => e);
      expect((err as CaptureError).code).toBe("exited");
    });
  });

  test("device change keeps the audio captured so far", async () => {
    await withMode("device_change", async (command) => {
      const capture = new MicCapture({ command });
      await capture.start();
      await Bun.sleep(400);
      const result = await capture.stop();
      expect(result.stopReason).toBe("device_changed");
      expect(result.pcm.length).toBeGreaterThan(0);
    });
  });

  test("a quick tap (stop before the helper starts) stops the helper instead of leaving the mic open", async () => {
    await withMode(
      "ok",
      async (command) => {
        const capture = new MicCapture({ command });
        const started = capture.start();
        await Bun.sleep(30);
        const result = await capture.stop();
        expect((await started).sampleRate).toBe(16000);
        expect(result.stopReason).toBe("sigterm");
        expect(capture.recording).toBe(false);
      },
      { FAKE_MIC_START_DELAY_MS: "300" },
    );
  });

  test("stop during startup rejects with the helper error when start fails", async () => {
    await withMode("denied", async (command) => {
      const capture = new MicCapture({ command });
      const started = capture.start().catch((e: unknown) => e);
      const err = await capture.stop().catch((e: unknown) => e);
      expect((err as CaptureError).code).toBe("permission_denied");
      expect(((await started) as CaptureError).code).toBe("permission_denied");
    });
  });

  test("an unspawnable helper command rejects start with binary_missing", async () => {
    const capture = new MicCapture({ command: ["/nonexistent/fm1-mic"] });
    const err = await capture.start().catch((e: unknown) => e);
    expect((err as CaptureError).code).toBe("binary_missing");
    await expect(capture.start()).rejects.toThrow("cannot start while done");
  });

  test("a default max-seconds hard stop is always passed to the helper", async () => {
    const out = `${process.env.TMPDIR ?? "/tmp"}/fm1-fake-args-default-${process.pid}.json`;
    await withMode(
      "ok",
      async (command) => {
        const capture = new MicCapture({ command });
        await capture.start();
        await capture.cancel();
        const args = (await Bun.file(out).json()) as string[];
        expect(args).toEqual(["--rate", "16000", "--max-seconds", String(DEFAULT_MAX_SECONDS)]);
      },
      { FAKE_MIC_ARGS_OUT: out },
    );
  });

  test("onEnd reports a helper that stops by itself, but not a normal stop", async () => {
    await withMode("device_change", async (command) => {
      const capture = new MicCapture({ command });
      const ended = new Promise<[string, CaptureError | undefined]>((resolve) => capture.onEnd((r, e) => resolve([r, e])));
      await capture.start();
      const [reason, err] = await ended;
      expect(reason).toBe("device_changed");
      expect(err?.code).toBe("device_changed");
      expect((await capture.stop()).pcm.length).toBeGreaterThan(0);
    });
    await withMode("crash", async (command) => {
      const capture = new MicCapture({ command });
      const ended = new Promise<string>((resolve) => capture.onEnd((r) => resolve(r)));
      await capture.start();
      expect(await ended).toBe("exited");
    });
    await withMode("ok", async (command) => {
      const capture = new MicCapture({ command });
      let calls = 0;
      capture.onEnd(() => calls++);
      await capture.start();
      await Bun.sleep(100);
      await capture.stop();
      await Bun.sleep(50);
      expect(calls).toBe(0);
    });
  });

  test("start twice is refused", async () => {
    await withMode("ok", async (command) => {
      const capture = new MicCapture({ command });
      await capture.start();
      await expect(capture.start()).rejects.toThrow(CaptureError);
      await capture.cancel();
    });
  });

  test("status and devices parse helper JSON", async () => {
    await withMode("ok", async (command) => {
      expect(await micPermission(command)).toEqual({ status: "authorized", authorized: true });
      const devices = await listInputDevices(command);
      expect(devices[0]?.default).toBe(true);
    });
  });
});
