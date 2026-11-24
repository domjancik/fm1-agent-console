// Keeps the last few voice takes on disk for debugging (operator decision 2026-11-19: "keep last few recs for debugging
// with ttl"). Each kept take is the raw capture as WAV, the mono stream the ASR engine got as WAV, and a JSON sidecar.
// Files are 0600 in a directory created 0700. Pruned by count and age on start, after every save and hourly.
// Nothing here may break dictation: every error is caught and logged.
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeWav } from "@fm1/speech";
import type { CapturedAudio } from "./capture";

export interface KeepRecordingsConfig {
  /** How many takes to keep; 0 keeps none (and the next prune removes what is there). */
  count: number;
  /** Takes older than this are removed. */
  ttlHours: number;
  /** A directory used only for this: pruning deletes the take files in it. "~/" is the home directory. */
  dir: string;
}

export const DEFAULT_KEEP_RECORDINGS: Readonly<KeepRecordingsConfig> = { count: 5, ttlHours: 24, dir: "~/.fm1-console/recordings" };
export const MAX_KEEP_COUNT = 100;
export const MAX_TTL_HOURS = 24 * 30;
/** Shorter takes (a REC tap) are never kept. */
export const MIN_KEEP_MS = 350;
export const PRUNE_EVERY_MS = 60 * 60 * 1000;

/** Validates `voice.keepRecordings` (`false`/`null` = count 0). `fail` throws the caller's config error. */
export function parseKeepRecordings(v: unknown, base: KeepRecordingsConfig, fail: (msg: string) => never): KeepRecordingsConfig {
  if (v === false || v === null) return { ...base, count: 0 };
  if (typeof v !== "object" || Array.isArray(v)) fail("voice.keepRecordings must be an object or false");
  const out = { ...base };
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k === "count") {
      if (typeof val !== "number" || !Number.isInteger(val) || val < 0 || val > MAX_KEEP_COUNT) fail(`voice.keepRecordings.count must be an integer 0-${MAX_KEEP_COUNT}`);
      out.count = val;
    } else if (k === "ttlHours") {
      if (typeof val !== "number" || !Number.isFinite(val) || val <= 0 || val > MAX_TTL_HOURS) fail(`voice.keepRecordings.ttlHours must be a number above 0, at most ${MAX_TTL_HOURS}`);
      out.ttlHours = val;
    } else if (k === "dir") {
      if (typeof val !== "string" || !(val.startsWith("/") || val.startsWith("~/")) || val.length > 1024) fail(`voice.keepRecordings.dir must be an absolute path or start with "~/"`);
      out.dir = val;
    } else fail(`unknown key voice.keepRecordings.${k}`);
  }
  return out;
}

export function expandHome(path: string, home = homedir()): string {
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/** take-<UTC yyyymmddThhmmssmmmZ>-<seq>.{wav,mono.wav,json} */
const TAKE_FILE = /^take-(\d{8}T\d{9}Z)-(\d+)\.(wav|mono\.wav|json)$/;

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:.]/g, "");
}

function parseStamp(s: string): number {
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}.${s.slice(15, 18)}Z`;
  return Date.parse(iso);
}

export type StoreLog = (level: "info" | "warn", text: string) => void;

export interface RecordingStoreOptions {
  now?: () => number;
  /** Repeating timer (hourly prune); returns a cancel function. Default: an unref'd setInterval. */
  every?: (ms: number, fn: () => void) => () => void;
  log?: StoreLog;
}

const defaultEvery = (ms: number, fn: () => void): (() => void) => {
  const t = setInterval(fn, ms);
  t.unref?.();
  return () => clearInterval(t);
};

export interface SavedTake {
  /** The raw WAV's file name (no directory). */
  file: string;
}

export class RecordingStore {
  readonly dir: string;
  private readonly now: () => number;
  private readonly every: (ms: number, fn: () => void) => () => void;
  private readonly log: StoreLog;
  private cancelTimer: (() => void) | null = null;
  private seq = 0;
  /** Serialises saves and prunes so a prune never races a half-written take. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly config: KeepRecordingsConfig,
    opts: RecordingStoreOptions = {},
  ) {
    this.dir = expandHome(config.dir);
    this.now = opts.now ?? Date.now;
    this.every = opts.every ?? defaultEvery;
    this.log = opts.log ?? (() => undefined);
  }

  get enabled(): boolean {
    return this.config.count > 0;
  }

  /** Prunes once now and then hourly. */
  async start(): Promise<void> {
    if (!this.cancelTimer) this.cancelTimer = this.every(PRUNE_EVERY_MS, () => void this.prune());
    await this.prune();
  }

  stop(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  /** Whether a take of this length is worth keeping (REC taps are not). */
  wouldKeep(durationMs: number): boolean {
    return this.enabled && durationMs >= MIN_KEEP_MS;
  }

  /**
   * Writes the take (raw WAV, mono WAV, sidecar JSON) and prunes. Returns null when not kept or on any error
   * (logged); never throws.
   */
  save(audio: CapturedAudio, sidecar: Record<string, unknown>, durationMs: number): Promise<SavedTake | null> {
    return this.serial(async () => {
      if (!this.wouldKeep(durationMs)) return null;
      let saved: SavedTake | null = null;
      try {
        saved = await this.write(audio, sidecar);
      } catch (e) {
        this.log("warn", `keeping the recording failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      await this.pruneNow();
      return saved;
    });
  }

  /** Removes takes beyond `count` (newest kept) and older than `ttlHours`. Returns the number of takes removed. */
  prune(): Promise<number> {
    return this.serial(() => this.pruneNow());
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private warnedMode = false;

  /**
   * Creates the directory 0700. The modes of a directory that already exists are never changed (`dir` may be one the
   * operator chose, even their home directory); wider modes only give a warning. The take files are 0600 either way.
   */
  private async ensureDir(): Promise<void> {
    const created = await mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (created !== undefined || this.warnedMode) return;
    if (((await stat(this.dir)).mode & 0o077) !== 0) {
      this.warnedMode = true;
      this.log("warn", `recordings directory ${this.dir} is readable by other users; the take files are still 0600`);
    }
  }

  private async write(audio: CapturedAudio, sidecar: Record<string, unknown>): Promise<SavedTake> {
    await this.ensureDir();
    const at = this.now();
    for (let attempt = 0; ; attempt++) {
      const stem = `take-${stamp(at)}-${++this.seq}`;
      const raw = audio.raw ?? { samples: audio.pcm, sampleRate: audio.sampleRate, channels: 1 };
      try {
        // "wx": never overwrite; 0600 on create.
        await writeFile(join(this.dir, `${stem}.wav`), encodeWav(raw.samples, raw.sampleRate, raw.channels), { mode: 0o600, flag: "wx" });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST" && attempt < 5) continue;
        throw e;
      }
      await writeFile(join(this.dir, `${stem}.mono.wav`), encodeWav(audio.pcm, audio.sampleRate, 1), { mode: 0o600, flag: "wx" });
      const meta = { ...sidecar, savedAt: new Date(at).toISOString(), files: { raw: `${stem}.wav`, mono: `${stem}.mono.wav` } };
      await writeFile(join(this.dir, `${stem}.json`), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      return { file: `${stem}.wav` };
    }
  }

  private async pruneNow(): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.log("warn", `pruning recordings failed: ${e instanceof Error ? e.message : String(e)}`);
      return 0;
    }
    const takes = new Map<string, { at: number; seq: number; files: string[] }>();
    for (const name of names) {
      const m = TAKE_FILE.exec(name);
      if (!m) continue;
      const stem = `take-${m[1]}-${m[2]}`;
      const t = takes.get(stem) ?? { at: parseStamp(m[1] ?? ""), seq: Number(m[2]), files: [] };
      t.files.push(name);
      takes.set(stem, t);
    }
    const newestFirst = [...takes.values()].sort((a, b) => b.at - a.at || b.seq - a.seq);
    const cutoff = this.now() - this.config.ttlHours * 3600_000;
    let removed = 0;
    for (const [i, t] of newestFirst.entries()) {
      if (i < this.config.count && t.at >= cutoff) continue;
      removed++;
      for (const f of t.files) {
        try {
          await unlink(join(this.dir, f));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.log("warn", `removing ${f} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    return removed;
  }
}
