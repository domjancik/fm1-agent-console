// `cli.ts transcribe --channel L|R|mix` on synthetic stereo WAVs built from a fixture (offline; no microphone).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { locateParakeetModel } from "../src/asr/model";
import { decodeWav, encodeWav } from "../src/audio/wav";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const SMOKE = fileURLToPath(new URL("../../../fixtures/audio/smoke-16k.wav", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "fm1-cli-channel-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const haveModel = (() => {
  try {
    locateParakeetModel();
    return true;
  } catch {
    return false;
  }
})();

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

/** The fixture on the right channel only, the left silent (one transmitter per channel). */
async function rightOnly(): Promise<string> {
  const wav = decodeWav(new Uint8Array(await Bun.file(SMOKE).arrayBuffer()));
  const st = new Int16Array(wav.samples.length * 2);
  for (let i = 0; i < wav.samples.length; i++) st[i * 2 + 1] = wav.samples[i] ?? 0;
  const path = join(dir, "right-only.wav");
  await Bun.write(path, encodeWav(st, wav.sampleRate, 2));
  return path;
}

describe("cli transcribe --channel", () => {
  test("an unknown channel is refused before any work", async () => {
    const r = await run(["transcribe", SMOKE, "--channel", "left"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--channel must be L, R or mix");
  });

  test("R on a mono file is refused", async () => {
    const r = await run(["transcribe", SMOKE, "--channel", "R"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("needs at least 2 channels");
  });

  test.skipIf(!haveModel)(
    "picks the channel: silent L is gated, R and mix are transcribed, stats describe both channels",
    async () => {
      const path = await rightOnly();
      const left = JSON.parse((await run(["transcribe", path, "--channel", "L"])).out);
      expect(left.rejected).toBe("silent");
      expect(left.input).toEqual({ file: path, sampleRate: 16000, channels: 2, channel: "L" });
      expect(left.stats.perChannel.map((c: { label: string }) => c.label)).toEqual(["L", "R"]);
      const right = JSON.parse((await run(["transcribe", path, "--channel", "R"])).out);
      expect(right.rejected).toBeUndefined();
      expect(right.text.length).toBeGreaterThan(20);
      const mix = JSON.parse((await run(["transcribe", path, "--channel", "mix"])).out);
      expect(mix.audio.rmsDbfs).toBeCloseTo(right.audio.rmsDbfs - 6.02, 0);
    },
    60_000,
  );
});
