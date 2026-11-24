/**
 * ASR worker process: owns the sherpa-onnx native addon so a native crash only kills this process.
 * Reads NDJSON requests on stdin, writes NDJSON responses on stdout. Logs go to stderr.
 */
import { OfflineRecognizer } from "sherpa-onnx-node";
import { int16ToFloat32 } from "../audio/pcm";
import { readLines } from "../util/lines";
import { AsrError } from "./engine";
import { locateParakeetModel } from "./model";
import { decodePcm, parseRequest, type WorkerRequest, type WorkerResponse, type WorkerResult } from "./protocol";

let recognizer: OfflineRecognizer | undefined;

async function load(modelDir: string | undefined, numThreads: number): Promise<WorkerResult> {
  if (recognizer) return { op: "load", loadMs: 0, alreadyLoaded: true };
  const env = modelDir ? { ...process.env, FM1_ASR_MODEL_DIR: modelDir } : process.env;
  const files = locateParakeetModel(env);
  const started = performance.now();
  try {
    recognizer = await OfflineRecognizer.createAsync({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
        tokens: files.tokens,
        numThreads,
        provider: "cpu",
        modelType: "nemo_transducer",
        debug: 0,
      },
      decodingMethod: "greedy_search",
    });
  } catch (err) {
    throw new AsrError("load_failed", `sherpa-onnx failed to load ${files.dir}: ${String(err)}`);
  }
  return { op: "load", loadMs: Math.round(performance.now() - started), alreadyLoaded: false };
}

async function transcribe(pcmB64: string, sampleRate: number): Promise<WorkerResult> {
  if (!recognizer) throw new AsrError("load_failed", "model not loaded");
  const started = performance.now();
  const stream = recognizer.createStream();
  stream.acceptWaveform({ samples: int16ToFloat32(decodePcm(pcmB64)), sampleRate });
  await recognizer.decodeAsync(stream);
  const text = recognizer.getResult(stream).text.trim();
  return { op: "transcribe", text, ms: Math.round(performance.now() - started) };
}

async function handle(req: WorkerRequest): Promise<WorkerResult> {
  switch (req.op) {
    case "load":
      return load(req.modelDir, req.numThreads ?? 4);
    case "transcribe":
      return transcribe(req.pcm, req.sampleRate);
    case "shutdown":
      return { op: "shutdown" };
  }
}

function send(res: WorkerResponse): void {
  process.stdout.write(`${JSON.stringify(res)}\n`);
}

async function main(): Promise<void> {
  // Requests are handled one at a time; sherpa streams are not shared across calls.
  for await (const raw of readLines(Bun.stdin.stream())) {
    const line = raw.trim();
    if (!line) continue;
    let req: WorkerRequest;
    try {
      req = parseRequest(line);
    } catch (err) {
      process.stderr.write(`asr-worker: bad request: ${String(err)}\n`);
      continue;
    }
    try {
      const result = await handle(req);
      send({ id: req.id, ok: true, result, stats: { rssBytes: process.memoryUsage().rss } });
      if (req.op === "shutdown") process.exit(0);
    } catch (err) {
      const code = err instanceof AsrError ? err.code : "transcribe_failed";
      send({ id: req.id, ok: false, error: { code, message: err instanceof Error ? err.message : String(err) } });
    }
  }
}

await main();
