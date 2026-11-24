import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawAudio } from "./audio/channels";
import { bytesToInt16, concatBytes } from "./audio/pcm";
import { BUILD_HINT, nativeHelperExists, nativeHelperPath } from "./native";
import { readLines } from "./util/lines";

export type CaptureErrorCode =
  | "binary_missing"
  | "permission_denied"
  | "no_device"
  | "device_not_found"
  | "device_changed"
  | "engine"
  | "exited"
  | "state";

export class CaptureError extends Error {
  override name = "CaptureError";
  constructor(
    readonly code: CaptureErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface InputDevice {
  id: number;
  uid: string;
  name: string;
  inputChannels: number;
  sampleRate: number;
  transport: string;
  default: boolean;
}

export interface PermissionStatus {
  status: "authorized" | "denied" | "restricted" | "notDetermined" | "unknown";
  authorized: boolean;
}

export interface CaptureOptions {
  /** Helper argv prefix; defaults to the built fm1-mic binary. Tests pass a fake script here. */
  command?: string[];
  deviceUid?: string;
  sampleRate?: number;
  /** Hard stop for a stuck REC key; defaults to DEFAULT_MAX_SECONDS. 0 disables it. */
  maxSeconds?: number;
  /**
   * Also keep the unconverted input (all channels, input rate) for diagnostics: the helper writes it to a private temp
   * file (env FM1_MIC_RAW_OUT), read and deleted on stop(). The mono stream on stdout is unchanged. An older helper
   * ignores the variable; `raw` is then absent.
   */
  keepRaw?: boolean;
}

export const DEFAULT_MAX_SECONDS = 120;

const RAW_DIR_PREFIX = "fm1-mic-raw-";
/** A raw temp directory older than this is left over from a crashed companion (a take lasts at most maxSeconds). */
export const STALE_RAW_DIR_MS = 60 * 60 * 1000;

/**
 * Removes `fm1-mic-raw-*` directories older than `maxAgeMs` from the temp directory: a companion that crashed mid-take
 * cannot delete its own. Best effort; returns how many were removed.
 */
let rawDirsSwept = false;

export function sweepStaleRawDirs(maxAgeMs = STALE_RAW_DIR_MS, now = Date.now(), base = tmpdir()): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(RAW_DIR_PREFIX)) continue;
    try {
      const path = join(base, name);
      const st = statSync(path);
      if (!st.isDirectory() || now - st.mtimeMs < maxAgeMs) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch {
      // not ours, or already gone
    }
  }
  return removed;
}

export interface StartInfo {
  /** From spawn to the helper's `started` event (engine running). */
  latencyMs: number;
  sampleRate: number;
  inputSampleRate: number;
  device: InputDevice | undefined;
}

export interface CaptureResult {
  pcm: Int16Array;
  sampleRate: number;
  durationMs: number;
  stopReason: string;
  /** Highest level event seen, 0..1 full scale. */
  maxRms: number;
  /** The raw multi-channel input (keepRaw and a helper that supports it); never used for ASR. */
  raw?: RawAudio;
}

export type LevelListener = (rms: number, peak: number) => void;
/** Called once when the helper ends on its own (max-seconds, device change, crash) before stop()/cancel(). */
export type EndListener = (reason: string, error: CaptureError | undefined) => void;

type HelperEvent =
  | { type: "started"; sampleRate: number; inputSampleRate: number; inputChannels?: number; rawOut?: boolean; device?: InputDevice; t?: number }
  | { type: "level"; rms: number; peak?: number }
  | { type: "stopped"; reason: string; frames: number }
  | { type: "device_changed" }
  | { type: "error"; code: string; message: string };

type MicProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;
type State = "idle" | "starting" | "recording" | "stopping" | "done";

const EXIT_CODE_ERRORS: Record<number, CaptureErrorCode> = { 3: "permission_denied", 4: "no_device" };
const HELPER_CODES: ReadonlySet<string> = new Set<CaptureErrorCode>([
  "permission_denied",
  "no_device",
  "device_not_found",
  "device_changed",
]);

function defaultCommand(): string[] {
  const bin = nativeHelperPath("fm1-mic");
  if (!nativeHelperExists(bin)) throw new CaptureError("binary_missing", `fm1-mic not found at ${bin}; ${BUILD_HINT}`);
  return [bin];
}

function parseEvent(line: string): HelperEvent | undefined {
  try {
    const v: unknown = JSON.parse(line);
    if (typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string") return v as HelperEvent;
  } catch {
    // non-JSON stderr noise from CoreAudio is ignored
  }
  return undefined;
}

async function runHelper(command: string[], args: string[]): Promise<string> {
  const proc = Bun.spawn([...command, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new CaptureError("engine", `fm1-mic ${args.join(" ")} failed (${code}): ${err.trim()}`);
  return out;
}

/** Microphone permission, without prompting. */
export async function micPermission(command = defaultCommand()): Promise<PermissionStatus> {
  return JSON.parse(await runHelper(command, ["status"])) as PermissionStatus;
}

export async function listInputDevices(command = defaultCommand()): Promise<InputDevice[]> {
  return JSON.parse(await runHelper(command, ["devices"])) as InputDevice[];
}

/**
 * One push-to-talk capture through fm1-mic: start() on REC down, stop() on REC up, cancel() to discard.
 * PCM stays in memory; nothing is written to disk, except the optional raw diagnostics file (keepRaw), which lives in a
 * private temp directory only while recording.
 */
export class MicCapture {
  private proc: MicProcess | undefined;
  private state: State = "idle";
  private chunks: Uint8Array[] = [];
  private listeners = new Set<LevelListener>();
  private endListeners = new Set<EndListener>();
  private maxRms = 0;
  private sampleRate: number;
  private stopReason = "unknown";
  private helperError: CaptureError | undefined;
  private stdoutDone: Promise<void> = Promise.resolve();
  private stderrDone: Promise<void> = Promise.resolve();
  private startWaiter: { resolve: (info: StartInfo) => void; reject: (err: CaptureError) => void } | undefined;
  private spawnedAt = 0;
  private rawDir: string | undefined;
  private rawFormat: { sampleRate: number; channels: number } | undefined;

  constructor(private readonly options: CaptureOptions = {}) {
    this.sampleRate = options.sampleRate ?? 16000;
  }

  get recording(): boolean {
    return this.state === "recording";
  }

  onLevel(listener: LevelListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Lets the composer leave RECORDING when the helper stops by itself, instead of waiting for REC up. */
  onEnd(listener: EndListener): () => void {
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  start(): Promise<StartInfo> {
    if (this.state !== "idle") return Promise.reject(new CaptureError("state", `cannot start while ${this.state}`));
    let command: string[];
    try {
      command = this.options.command ?? defaultCommand();
    } catch (err) {
      return Promise.reject(err);
    }
    const args = ["record", "--rate", String(this.sampleRate)];
    if (this.options.deviceUid) args.push("--device", this.options.deviceUid);
    const maxSeconds = this.options.maxSeconds ?? DEFAULT_MAX_SECONDS;
    if (maxSeconds > 0) args.push("--max-seconds", String(maxSeconds));

    this.spawnedAt = performance.now();
    let env: Record<string, string | undefined> | undefined;
    if (this.options.keepRaw) {
      try {
        this.rawDir = mkdtempSync(join(tmpdir(), RAW_DIR_PREFIX)); // mode 0700
        env = { ...process.env, FM1_MIC_RAW_OUT: join(this.rawDir, "raw.s16le") };
      } catch {
        this.rawDir = undefined; // diagnostics only: record without it
      }
    }
    let proc: MicProcess;
    try {
      proc = Bun.spawn([...command, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe", ...(env ? { env } : {}) });
    } catch (err) {
      this.state = "done";
      this.dropRaw();
      const detail = err instanceof Error ? err.message : String(err);
      return Promise.reject(new CaptureError("binary_missing", `cannot start fm1-mic: ${detail}; ${BUILD_HINT}`));
    }
    // Leftovers of a crashed run go once per process, while the helper starts (not before: REC latency).
    if (this.options.keepRaw && !rawDirsSwept) {
      rawDirsSwept = true;
      sweepStaleRawDirs(Math.max(STALE_RAW_DIR_MS, 2 * maxSeconds * 1000));
    }
    this.state = "starting";
    this.proc = proc;
    const started = new Promise<StartInfo>((resolve, reject) => {
      this.startWaiter = { resolve, reject };
    });
    this.stdoutDone = this.collectPcm(proc);
    this.stderrDone = this.readEvents(proc);
    void proc.exited.then((code) => this.onExit(code));
    return started;
  }

  /**
   * Stops recording and returns the captured PCM. Called during startup (a quick REC tap), it waits
   * for the helper to start and then stops it, so the microphone is never left open.
   */
  async stop(): Promise<CaptureResult> {
    if (this.state === "starting" && this.startWaiter) {
      const waiter = this.startWaiter;
      await new Promise<void>((resolve, reject) => {
        this.startWaiter = {
          resolve: (info) => {
            waiter.resolve(info);
            resolve();
          },
          reject: (err) => {
            waiter.reject(err);
            reject(err);
          },
        };
      });
    }
    if (this.state !== "recording") throw new CaptureError("state", `cannot stop while ${this.state}`);
    const proc = this.proc;
    if (!proc) throw new CaptureError("state", "no helper process");
    this.state = "stopping";
    proc.kill("SIGTERM");
    await Promise.all([proc.exited, this.stdoutDone, this.stderrDone]);
    this.state = "done";
    const raw = this.takeRaw();
    if (this.helperError && this.helperError.code !== "device_changed") throw this.helperError;
    const pcm = bytesToInt16(concatBytes(this.chunks));
    this.chunks = [];
    return {
      pcm,
      sampleRate: this.sampleRate,
      durationMs: (pcm.length / this.sampleRate) * 1000,
      stopReason: this.stopReason,
      maxRms: this.maxRms,
      ...(raw ? { raw } : {}),
    };
  }

  /** Reads and deletes the raw side file. Any problem only loses the diagnostics. */
  private takeRaw(): RawAudio | undefined {
    const dir = this.rawDir;
    const format = this.rawFormat;
    if (!dir) return undefined;
    try {
      if (!format || !(format.channels >= 1) || !(format.sampleRate >= 1)) return undefined;
      const samples = bytesToInt16(new Uint8Array(readFileSync(join(dir, "raw.s16le"))));
      const whole = samples.length - (samples.length % format.channels);
      return { samples: whole === samples.length ? samples : samples.slice(0, whole), sampleRate: format.sampleRate, channels: format.channels };
    } catch {
      return undefined;
    } finally {
      this.dropRaw();
    }
  }

  private dropRaw(): void {
    const dir = this.rawDir;
    this.rawDir = undefined;
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort; the directory is private (0700) under the user's temp dir
      }
    }
  }

  /** Discards the recording. Safe to call in any state. */
  async cancel(): Promise<void> {
    const proc = this.proc;
    this.chunks = [];
    if (this.state === "done" || this.state === "idle" || !proc) {
      this.state = "done";
      this.dropRaw();
      return;
    }
    this.state = "stopping";
    // Reject before the kill so the pending start() sees the cancel, not the resulting exit.
    this.startWaiter?.reject(new CaptureError("state", "cancelled before start"));
    this.startWaiter = undefined;
    proc.kill("SIGKILL");
    await proc.exited;
    this.chunks = [];
    this.state = "done";
    this.dropRaw();
  }

  private async collectPcm(proc: MicProcess): Promise<void> {
    const reader = proc.stdout.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (this.state !== "done") this.chunks.push(value);
    }
  }

  private async readEvents(proc: MicProcess): Promise<void> {
    for await (const line of readLines(proc.stderr)) {
      const event = parseEvent(line);
      if (event) this.onEvent(event);
    }
  }

  private onEvent(event: HelperEvent): void {
    switch (event.type) {
      case "started":
        this.sampleRate = event.sampleRate;
        if (event.rawOut === true && typeof event.inputChannels === "number") {
          this.rawFormat = { sampleRate: event.inputSampleRate, channels: event.inputChannels };
        }
        if (this.state === "starting") this.state = "recording";
        this.startWaiter?.resolve({
          latencyMs: performance.now() - this.spawnedAt,
          sampleRate: event.sampleRate,
          inputSampleRate: event.inputSampleRate,
          device: event.device,
        });
        this.startWaiter = undefined;
        return;
      case "level":
        this.maxRms = Math.max(this.maxRms, event.rms);
        for (const l of this.listeners) l(event.rms, event.peak ?? event.rms);
        return;
      case "stopped":
        this.stopReason = event.reason;
        return;
      case "device_changed":
        this.helperError = new CaptureError("device_changed", "input device changed during recording");
        return;
      case "error": {
        const code = HELPER_CODES.has(event.code) ? (event.code as CaptureErrorCode) : "engine";
        this.helperError = new CaptureError(code, event.message);
        return;
      }
    }
  }

  private onExit(code: number): void {
    if (this.startWaiter) {
      const fallback = EXIT_CODE_ERRORS[code] ?? "exited";
      this.startWaiter.reject(this.helperError ?? new CaptureError(fallback, `fm1-mic exited with code ${code} before starting`));
      this.startWaiter = undefined;
      this.state = "done";
      this.dropRaw();
      return;
    }
    // Helper ended on its own (max-seconds, device change, crash): stop() still returns what was captured.
    if (this.state !== "recording") return;
    if (code !== 0 && !this.helperError) {
      this.helperError = new CaptureError("exited", `fm1-mic exited with code ${code} while recording`);
    }
    // Wait for stderr so the helper's `stopped` reason has been read.
    void this.stderrDone.then(() => {
      const reason = this.stopReason === "unknown" ? "exited" : this.stopReason;
      for (const l of this.endListeners) l(reason, this.helperError);
    });
  }
}
