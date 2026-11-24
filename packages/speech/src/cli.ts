#!/usr/bin/env bun
/**
 * fm1 speech CLI.
 *   transcribe <wav> [--engine sherpa|apple] [--language en] [--keep-audio out.wav] [--channel L|R|mix]
 *       --channel: transcribe one channel (L = 1, R = 2) or the plain average of a multi-channel WAV, and add
 *       `input` and per-channel `stats` to the output. Offline experiments only; the companion never uses it.
 *   bench [--runs 2] [--out reports/asr-bench.md] [--apple]
 *   status | devices                         (never opens the microphone)
 *   record --seconds N [--device uid]        (opens the microphone; manual smoke test only)
 */
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { AppleDictationEngine } from "./asr/apple-engine";
import { createEngine, type EngineId } from "./asr/select";
import { benchEngine, loadFixtures, renderBenchMarkdown, type EngineBench } from "./bench";
import { listInputDevices, micPermission, MicCapture } from "./capture";
import { isChannelPick, pickChannel } from "./audio/channels";
import { decodeWav } from "./audio/wav";
import { transcribeFile, transcribePcm } from "./pipeline";
import { takeStats } from "./take-stats";

const DEFAULT_REPORT = fileURLToPath(new URL("../../../reports/asr-bench.md", import.meta.url));

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function transcribe(args: string[]): Promise<number> {
  const wav = args.find((a, i) => !a.startsWith("--") && !(args[i - 1] ?? "").startsWith("--"));
  if (!wav) throw new Error("usage: transcribe <wav> [--engine sherpa|apple] [--language en] [--keep-audio out.wav] [--channel L|R|mix]");
  const channel = flag(args, "channel");
  if (channel !== undefined && !isChannelPick(channel)) throw new Error("--channel must be L, R or mix");
  const engineId = (flag(args, "engine") ?? "sherpa") as EngineId;
  const engine = createEngine(engineId);
  try {
    const options = { engine, language: flag(args, "language"), keepAudioPath: flag(args, "keep-audio") };
    if (channel === undefined) {
      print(await transcribeFile(wav, options));
      return 0;
    }
    // Offline experiments on kept recordings: one channel, or the plain average, of a multi-channel WAV.
    const decoded = decodeWav(new Uint8Array(await Bun.file(wav).arrayBuffer()));
    const pcm = pickChannel(decoded.samples, decoded.channels, channel);
    const result = await transcribePcm(pcm, decoded.sampleRate, options);
    print({ ...result, input: { file: wav, sampleRate: decoded.sampleRate, channels: decoded.channels, channel }, stats: takeStats(pcm, decoded.sampleRate, decoded) });
    return 0;
  } finally {
    await engine.dispose();
  }
}

async function bench(args: string[]): Promise<number> {
  const runs = Number(flag(args, "runs") ?? 2);
  const out = flag(args, "out") ?? DEFAULT_REPORT;
  const fixtures = await loadFixtures();
  const results: EngineBench[] = [];
  const sherpa = createEngine("sherpa");
  try {
    results.push(await benchEngine(sherpa, fixtures, runs));
  } finally {
    await sherpa.dispose();
  }
  if (args.includes("--apple")) results.push(await benchEngine(new AppleDictationEngine(), fixtures, runs));
  const md = renderBenchMarkdown(results, {
    date: new Date().toISOString(),
    host: `${hostname()}, bun ${Bun.version}, ${process.arch}`,
    mainRssMb: Math.round(process.memoryUsage().rss / 1e6),
  });
  await Bun.write(out, md);
  process.stdout.write(`${md}\nwritten to ${out}\n`);
  return 0;
}

async function record(args: string[]): Promise<number> {
  const seconds = Number(flag(args, "seconds") ?? 5);
  const capture = new MicCapture({ deviceUid: flag(args, "device"), maxSeconds: seconds + 1 });
  const start = await capture.start();
  process.stderr.write(`recording ${seconds}s from ${start.device?.name ?? "default"} (start ${start.latencyMs.toFixed(0)} ms)\n`);
  await Bun.sleep(seconds * 1000);
  const captured = await capture.stop();
  const engine = createEngine("sherpa");
  try {
    const result = await transcribePcm(captured.pcm, captured.sampleRate, { engine, keepAudioPath: flag(args, "keep-audio") });
    print({ start, capture: { durationMs: captured.durationMs, sampleRate: captured.sampleRate, maxRms: captured.maxRms, stopReason: captured.stopReason }, result });
    return 0;
  } finally {
    await engine.dispose();
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case "transcribe":
      return transcribe(args);
    case "bench":
      return bench(args);
    case "status":
      print(await micPermission());
      return 0;
    case "devices":
      print(await listInputDevices());
      return 0;
    case "record":
      return record(args);
    default:
      process.stderr.write("usage: cli.ts transcribe <wav> | bench | status | devices | record --seconds N\n");
      return 1;
  }
}

try {
  process.exit(await main(Bun.argv.slice(2)));
} catch (err) {
  const code = (err as { code?: unknown }).code;
  process.stderr.write(`${JSON.stringify({ error: typeof code === "string" ? code : "error", message: err instanceof Error ? err.message : String(err) })}\n`);
  process.exit(2);
}
