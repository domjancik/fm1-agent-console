import { fileURLToPath } from "node:url";
import { AsrError, type AsrEngine, type AsrErrorCode, type LoadInfo, type TranscribeOptions, type Transcription } from "./engine";
import { readLines } from "../util/lines";
import { parakeetSupports } from "./parakeet-languages";
import { encodePcm, parseResponse, type WorkerRequest, type WorkerResponse, type WorkerResult, type WorkerStats } from "./protocol";

const WORKER_PATH = fileURLToPath(new URL("./worker.ts", import.meta.url));
const KNOWN_CODES: ReadonlySet<string> = new Set<AsrErrorCode>(["model_missing", "load_failed", "transcribe_failed"]);

export interface SherpaEngineOptions {
  modelDir?: string;
  numThreads?: number;
  /** Command that starts the worker; defaults to this Bun binary running worker.ts. */
  workerCommand?: string[];
  /** A worker that does not answer within this time is killed and the call fails with `timeout`. */
  loadTimeoutMs?: number;
  transcribeTimeoutMs?: number;
}

const DEFAULT_LOAD_TIMEOUT_MS = 60_000;
const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 30_000;

interface Pending {
  resolve: (res: WorkerResult) => void;
  reject: (err: AsrError) => void;
}

type WorkerProcess = Bun.Subprocess<"pipe", "pipe", "inherit">;

/**
 * Parakeet TDT v3 (int8) through sherpa-onnx, hosted in a child Bun process speaking NDJSON.
 * If the worker dies, pending calls fail with `worker_crashed` and the next call starts a new worker.
 */
export class SherpaParakeetEngine implements AsrEngine {
  readonly id = "sherpa-parakeet-v3";
  private worker: WorkerProcess | undefined;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private loaded = false;
  private disposed = false;
  /** Worker RSS after the last call, for benchmarks. */
  lastStats: WorkerStats | undefined;

  constructor(private readonly options: SherpaEngineOptions = {}) {}

  supportsLanguage(language: string): boolean {
    return parakeetSupports(language);
  }

  async load(): Promise<LoadInfo> {
    const res = await this.request(
      { op: "load", modelDir: this.options.modelDir, numThreads: this.options.numThreads },
      this.options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS,
    );
    if (res.op !== "load") throw new AsrError("load_failed", "unexpected worker reply");
    this.loaded = true;
    return { ms: res.loadMs };
  }

  async transcribe(pcm16k: Int16Array, opts: TranscribeOptions): Promise<Transcription> {
    if (!this.supportsLanguage(opts.language)) {
      throw new AsrError("language_unsupported", `Parakeet v3 does not support language "${opts.language}"`);
    }
    if (opts.signal?.aborted) throw new AsrError("cancelled", "transcription cancelled");
    if (pcm16k.length === 0) return { text: "", ms: 0 };
    if (!this.loaded) await (opts.signal ? raceAbort(this.load(), opts.signal) : this.load());
    if (opts.signal?.aborted) throw new AsrError("cancelled", "transcription cancelled");
    const call = this.request(
      { op: "transcribe", pcm: encodePcm(pcm16k), sampleRate: 16000 },
      this.options.transcribeTimeoutMs ?? DEFAULT_TRANSCRIBE_TIMEOUT_MS,
    );
    // A native decode cannot be interrupted; cancelling drops the result and keeps the warm worker.
    const res = await (opts.signal ? raceAbort(call, opts.signal) : call);
    if (res.op !== "transcribe") throw new AsrError("transcribe_failed", "unexpected worker reply");
    return { text: res.text, ms: res.ms };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const worker = this.worker;
    if (!worker) return;
    try {
      await this.request({ op: "shutdown" }, 2000, true);
    } catch {
      worker.kill("SIGKILL");
    }
    await worker.exited;
  }

  /** Kills the worker without a shutdown request. Test hook for crash handling. */
  killWorker(): void {
    this.worker?.kill("SIGKILL");
  }

  /**
   * Detaches a worker at once and fails its pending calls, so the next call starts a fresh worker
   * instead of writing to one that is still dying.
   */
  private retire(worker: WorkerProcess, message: string): void {
    worker.kill("SIGKILL");
    if (this.worker !== worker) return;
    this.worker = undefined;
    this.loaded = false;
    const failed = [...this.pending.values()];
    this.pending.clear();
    for (const p of failed) p.reject(new AsrError("worker_crashed", message));
  }

  private request(body: DistributiveOmit<WorkerRequest, "id">, timeoutMs: number, allowDisposed = false): Promise<WorkerResult> {
    if (this.disposed && !allowDisposed) return Promise.reject(new AsrError("disposed", "engine disposed"));
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<WorkerResult>((resolve, reject) => {
      // A hung worker (stuck native decode, deadlock) is killed; the next call starts a fresh one.
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new AsrError("timeout", `ASR worker did not answer ${body.op} within ${timeoutMs} ms`));
        this.retire(worker, "ASR worker killed after a timeout");
      }, timeoutMs);
      const settle = (): void => clearTimeout(timer);
      this.pending.set(id, {
        resolve: (res) => {
          settle();
          resolve(res);
        },
        reject: (err) => {
          settle();
          reject(err);
        },
      });
      try {
        worker.stdin.write(`${JSON.stringify({ ...body, id })}\n`);
        worker.stdin.flush();
      } catch (err) {
        this.pending.delete(id);
        settle();
        reject(new AsrError("worker_crashed", `cannot write to ASR worker: ${String(err)}`));
      }
    });
  }

  private ensureWorker(): WorkerProcess {
    if (this.worker) return this.worker;
    const cmd = this.options.workerCommand ?? [process.execPath, WORKER_PATH];
    const worker = Bun.spawn(cmd, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    this.worker = worker;
    this.loaded = false;
    void this.readResponses(worker);
    void worker.exited.then((code) => this.onExit(worker, code));
    return worker;
  }

  private async readResponses(worker: WorkerProcess): Promise<void> {
    for await (const line of readLines(worker.stdout)) {
      if (line.trim()) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let res: WorkerResponse;
    try {
      res = parseResponse(line);
    } catch {
      return;
    }
    const pending = this.pending.get(res.id);
    if (!pending) return;
    this.pending.delete(res.id);
    if (res.ok) {
      this.lastStats = res.stats;
      pending.resolve(res.result);
    } else {
      const code = KNOWN_CODES.has(res.error.code) ? (res.error.code as AsrErrorCode) : "transcribe_failed";
      pending.reject(new AsrError(code, res.error.message));
    }
  }

  private onExit(worker: WorkerProcess, code: number | null): void {
    this.retire(worker, `ASR worker exited (code ${String(code)})`);
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new AsrError("cancelled", "transcription cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

