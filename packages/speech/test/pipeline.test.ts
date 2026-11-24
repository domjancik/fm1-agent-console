import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppleDictationEngine } from "../src/asr/apple-engine";
import { AsrError } from "../src/asr/engine";
import { locateParakeetModel } from "../src/asr/model";
import { engineForLanguage } from "../src/asr/select";
import { SherpaParakeetEngine } from "../src/asr/sherpa-engine";
import { decodeWav } from "../src/audio/wav";
import { loadWavFor16k } from "../src/audio/load";
import { FIXTURE_DIR, loadFixtures, wordErrorRate, type AudioFixture } from "../src/fixtures";
import { nativeHelperPath } from "../src/native";
import { transcribeFile, transcribePcm } from "../src/pipeline";

function modelAvailable(): boolean {
  try {
    locateParakeetModel();
    return true;
  } catch {
    return false;
  }
}

const HAVE_MODEL = modelAvailable();
if (!HAVE_MODEL) console.warn("pipeline tests skipped: Parakeet model not found (set FM1_ASR_MODEL_DIR or download it)");

const fixtures: AudioFixture[] = await loadFixtures();

describe.skipIf(!HAVE_MODEL)("pipeline with Parakeet (sherpa-onnx worker)", () => {
  const engine = new SherpaParakeetEngine();

  beforeAll(async () => {
    await engine.load();
  }, 30_000);
  afterAll(async () => {
    await engine.dispose();
  });

  for (const fx of fixtures) {
    test(`${fx.file} (${fx.sampleRate} Hz)`, async () => {
      const header = decodeWav(new Uint8Array(await Bun.file(fx.path).arrayBuffer()));
      expect(header.sampleRate).toBe(fx.sampleRate);
      const result = await transcribeFile(fx.path, { engine });
      if (fx.rejected) {
        expect(result.rejected).toBe(fx.rejected);
        expect(result.text).toBe("");
        expect(result.timings.asrMs).toBe(0);
        return;
      }
      expect(result.rejected).toBeUndefined();
      expect(result.text).toBe(fx.expected);
      for (const fragment of fx.mustContain) expect(result.text).toContain(fragment);
      expect(wordErrorRate(fx.expected, result.text)).toBe(0);
      expect(result.raw.length).toBeGreaterThan(0);
      expect(result.timings.asrMs).toBeGreaterThan(0);
      expect(result.timings.asrMs).toBeLessThan(2000); // spec 13: short utterance < 2 s once warm
      expect(result.timings.loadMs).toBe(0); // loaded in beforeAll
    }, 20_000);
  }

  const voiceProcessorSample = "/Users/dominikj/dev/personal/voice-processor/recorded_audio.wav";
  test.skipIf(!existsSync(voiceProcessorSample))("silent voice-processor recording is rejected before ASR", async () => {
    const sample = voiceProcessorSample;
    const result = await transcribeFile(sample, { engine });
    expect(result.rejected).toBe("silent");
    expect(result.timings.totalMs).toBeLessThan(200);
  });

  test("transcribePcm accepts 48 kHz PCM directly", async () => {
    const wav = decodeWav(new Uint8Array(await Bun.file(join(FIXTURE_DIR, "smoke-48k.wav")).arrayBuffer()));
    const result = await transcribePcm(wav.samples, wav.sampleRate, { engine });
    expect(result.text).toContain("decode frame");
  }, 20_000);

  test("no audio is written unless keepAudioPath is set", async () => {
    const dir = join(tmpdir(), `fm1-speech-${process.pid}`);
    const kept = join(dir, "kept.wav");
    const write = spyOn(Bun, "write");
    try {
      await transcribeFile(join(FIXTURE_DIR, "question-16k.wav"), { engine });
      expect(write).not.toHaveBeenCalled();
      await transcribeFile(join(FIXTURE_DIR, "question-16k.wav"), { engine, keepAudioPath: kept });
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      write.mockRestore();
    }
    expect(existsSync(kept)).toBe(true);
    const wav = decodeWav(new Uint8Array(await Bun.file(kept).arrayBuffer()));
    expect(wav.sampleRate).toBe(16000);
    expect(wav.samples.length).toBeGreaterThan(16000);
  }, 20_000);

  test("unsupported language is refused, fallback selection works", async () => {
    const audio = await loadWavFor16k(join(FIXTURE_DIR, "smoke-16k.wav"));
    const err = await engine.transcribe(audio.pcm, { language: "he" }).catch((e: unknown) => e);
    expect((err as AsrError).code).toBe("language_unsupported");
    expect(engine.supportsLanguage("en-US")).toBe(true);
    const apple = new AppleDictationEngine("/nonexistent");
    expect(engineForLanguage("he", engine, apple)).toBe(apple);
    expect(engineForLanguage("en", engine, apple)).toBe(engine);
    expect(() => engineForLanguage("he", engine)).toThrow(AsrError);
  });

  test("invalid sample rate and empty PCM are handled without calling the worker", async () => {
    await expect(transcribePcm(new Int16Array(10), 0, { engine })).rejects.toThrow(RangeError);
    expect(await engine.transcribe(new Int16Array(0), { language: "en" })).toEqual({ text: "", ms: 0 });
  });

  test("cancellation drops the result and keeps the worker usable", async () => {
    const audio = await loadWavFor16k(join(FIXTURE_DIR, "smoke-16k.wav"));
    const controller = new AbortController();
    const pending = engine.transcribe(audio.pcm, { language: "en", signal: controller.signal });
    controller.abort();
    expect(((await pending.catch((e: unknown) => e)) as AsrError).code).toBe("cancelled");
    const again = await engine.transcribe(audio.pcm, { language: "en" });
    expect(again.text).toContain("agent console");
  }, 20_000);
});

describe.skipIf(!HAVE_MODEL)("worker crash isolation", () => {
  test("a dead worker fails the pending call and the next call restarts it", async () => {
    const engine = new SherpaParakeetEngine();
    try {
      await engine.load();
      const audio = await loadWavFor16k(join(FIXTURE_DIR, "smoke-16k.wav"));
      const pending = engine.transcribe(audio.pcm, { language: "en" });
      engine.killWorker();
      const err = await pending.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AsrError);
      expect((err as AsrError).code).toBe("worker_crashed");
      const recovered = await engine.transcribe(audio.pcm, { language: "en" });
      expect(recovered.text).toContain("agent console");
    } finally {
      await engine.dispose();
    }
  }, 30_000);

  test("a missing model reports model_missing from the worker", async () => {
    const engine = new SherpaParakeetEngine({ modelDir: "/nonexistent/model" });
    try {
      const err = await engine.load().catch((e: unknown) => e);
      expect((err as AsrError).code).toBe("model_missing");
    } finally {
      await engine.dispose();
    }
  });
});

describe("worker timeouts", () => {
  test("a worker that never answers is killed and the call fails with timeout; the next call retries", async () => {
    const engine = new SherpaParakeetEngine({ workerCommand: ["/bin/sleep", "60"], loadTimeoutMs: 300 });
    try {
      const started = performance.now();
      const err = await engine.load().catch((e: unknown) => e);
      expect((err as AsrError).code).toBe("timeout");
      expect(performance.now() - started).toBeLessThan(2000);
      const again = await engine.load().catch((e: unknown) => e);
      expect((again as AsrError).code).toBe("timeout");
    } finally {
      await engine.dispose();
    }
  });
});

describe("model location", () => {
  test("FM1_ASR_MODEL_DIR overrides and validates", () => {
    expect(() => locateParakeetModel({ FM1_ASR_MODEL_DIR: "/nonexistent" })).toThrow(AsrError);
    expect(() => locateParakeetModel({ FM1_ASR_MODEL_DIR: FIXTURE_DIR })).toThrow("incomplete");
  });

  test.skipIf(!HAVE_MODEL)("HF cache lookup resolves the snapshot through refs/main", () => {
    const files = locateParakeetModel({ HOME: process.env.HOME });
    expect(files.encoder).toMatch(/snapshots\/[0-9a-f]{40}\/encoder(\.int8)?\.onnx$/);
  });
});

const appleHelper = nativeHelperPath("fm1-dictate");
const appleAssets = existsSync(appleHelper) && (await new AppleDictationEngine(appleHelper).status("en")).assetsInstalled;
if (existsSync(appleHelper) && !appleAssets) console.warn("Apple dictation test skipped: en_US dictation assets not installed");
describe("Apple dictation engine (optional)", () => {
  test.skipIf(!appleAssets)("transcribes a fixture over stdin when en_US assets are installed", async () => {
    const engine = new AppleDictationEngine(appleHelper);
    const result = await transcribeFile(join(FIXTURE_DIR, "question-16k.wav"), { engine });
    expect(result.text.toLowerCase()).toContain("voice composer");
    expect(result.timings.asrMs).toBeGreaterThan(0);
  }, 20_000);

  test("missing helper reports helper_missing", async () => {
    const err = await new AppleDictationEngine("/nonexistent/fm1-dictate").load().catch((e: unknown) => e);
    expect((err as AsrError).code).toBe("helper_missing");
  });
});
