// Read aloud (docs/ui-v3.md section 14): speaks a session's latest message through Kokoro-FastAPI and afplay.
// Long text is summarized first by the on-device model (native/fm1-summarize). Kokoro is started in Docker when it is
// down. One playback at a time: a new request or stop() ends the current one. Text never leaves the Mac (Kokoro runs
// locally) and is never logged; logs carry lengths and outcomes only.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clipSpeech, NOTICE, type DeliveryStage, type ReadAloudPort } from "@fm1/agent-core";
import type { ReadAloudConfig } from "../config";
import type { RunResult } from "../proc";

/** GET /health answer time limit. */
export const HEALTH_TIMEOUT_MS = 2_000;
/** After starting the container: /health is polled every POLL_MS for at most BOOT_WAIT_MS. */
export const BOOT_WAIT_MS = 90_000;
export const POLL_MS = 1_000;
/** fm1-summarize gets this long; then the text is read clipped (`Summary unavailable`). */
export const SUMMARY_TIMEOUT_MS = 20_000;
/** POST /v1/audio/speech time limit (CPU synthesis of ~600 characters takes a few seconds). */
export const SYNTH_TIMEOUT_MS = 60_000;
/** `docker start` limit; `docker run` may download the image on first use, so it gets much longer. */
export const DOCKER_START_TIMEOUT_MS = 30_000;
export const DOCKER_RUN_TIMEOUT_MS = 600_000;
/** Name of the container this companion creates when none of the image exists. */
export const CONTAINER_NAME = "fm1-kokoro";
/** Port Kokoro-FastAPI listens on inside its container. */
const CONTAINER_PORT = 8880;

export interface ProcHandle {
  exited: Promise<number>;
  kill(): void;
}

export interface SpeechDeps {
  /** Runs to completion (stdin text optional); never throws. */
  run(cmd: string[], opts?: { stdin?: string; timeoutMs?: number }): Promise<RunResult>;
  /** Starts a process that can be killed (afplay). */
  spawn(cmd: string[]): ProcHandle;
  fetch(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Writes audio to a fresh private temp file (0600) and returns its path. */
  writeTemp(bytes: Uint8Array, ext: string): Promise<string>;
  removeTemp(path: string): Promise<void>;
  /** Path of fm1-summarize, or null when it was not built (the summary is then unavailable). */
  summarizer: string | null;
}

export interface ReadAloudOptions {
  config: () => ReadAloudConfig;
  /** Shows a device toast (<= 20 characters). */
  toast: (text: string, stage: DeliveryStage) => void;
  log: (level: "info" | "warn", text: string) => void;
  deps: SpeechDeps;
}

/** `repo` of `repo:tag` (a registry port `host:5000/x` is not a tag). */
export function imageRepo(image: string): string {
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  return colon > slash ? image.slice(0, colon) : image;
}

/** Host port of the Kokoro URL (the container's 8880 is published there). */
function hostPort(url: string): number {
  try {
    const u = new URL(url);
    return u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  } catch {
    return CONTAINER_PORT;
  }
}

const firstLine = (s: string): string => s.trim().split("\n")[0]?.slice(0, 160) ?? "";

export class ReadAloud implements ReadAloudPort {
  private gen = 0;
  private busy = false;
  private player: ProcHandle | null = null;
  private task: Promise<void> = Promise.resolve();

  constructor(private readonly opts: ReadAloudOptions) {}

  speaking(): boolean {
    return this.busy;
  }

  /** Stops whatever is playing or being prepared, then reads `text` (already speech text, see agent-core speech.ts). */
  speak(text: string, _sessionKey: string): void {
    this.stop();
    const gen = this.gen;
    this.busy = true;
    this.task = this.pipeline(gen, text)
      .catch((e: unknown) => {
        this.opts.log("warn", `read aloud failed: ${e instanceof Error ? e.message : String(e)}`);
        if (gen === this.gen) this.opts.toast(NOTICE.voiceOffline, "failed");
      })
      .finally(() => {
        if (gen === this.gen) {
          this.busy = false;
          this.player = null;
        }
      });
  }

  stop(): void {
    this.gen++;
    this.busy = false;
    const p = this.player;
    this.player = null;
    p?.kill();
  }

  /** Resolves when the current request finished (tests, shutdown). */
  idle(): Promise<void> {
    return this.task;
  }

  private live(gen: number): boolean {
    return gen === this.gen;
  }

  private async pipeline(gen: number, text: string): Promise<void> {
    const cfg = this.opts.config();
    const long = text.length > cfg.summarizeOverChars;
    // Kokoro start-up and the summary run side by side: either may take seconds.
    const [ready, summary] = await Promise.all([this.ensureKokoro(gen, cfg), long ? this.summarize(text) : Promise.resolve(null)]);
    if (!this.live(gen)) return;
    if (!ready) {
      this.opts.toast(NOTICE.voiceOffline, "failed");
      return;
    }
    let say = text;
    let toast: string = NOTICE.reading;
    if (long && summary) {
      say = summary;
      toast = NOTICE.readingSummary;
    } else if (long) {
      say = clipSpeech(text, cfg.summarizeOverChars);
      toast = NOTICE.summaryUnavailable;
    }
    const audio = await this.synthesize(cfg, say);
    if (!this.live(gen)) return;
    if (!audio) {
      this.opts.toast(NOTICE.voiceOffline, "failed");
      return;
    }
    const path = await this.opts.deps.writeTemp(audio, "mp3");
    try {
      if (!this.live(gen)) return;
      this.opts.toast(toast, "accepted_locally");
      this.opts.log("info", `read aloud: ${say.length} characters${long ? (summary ? " (summary)" : " (clipped)") : ""}`);
      const player = this.opts.deps.spawn(["afplay", path]);
      this.player = player;
      await player.exited;
    } finally {
      await this.opts.deps.removeTemp(path).catch(() => undefined);
    }
  }

  private async health(cfg: ReadAloudConfig): Promise<boolean> {
    try {
      const r = await this.opts.deps.fetch(`${cfg.kokoroUrl}/health`, { timeoutMs: HEALTH_TIMEOUT_MS });
      return r.ok && /healthy/i.test(await r.text());
    } catch {
      return false;
    }
  }

  /**
   * Kokoro answers /health, or is brought up: a running container of the image is waited for, an existing stopped one
   * is `docker start`ed, else one is created with `docker run` (the first run downloads the image). Then /health is
   * polled for up to BOOT_WAIT_MS. False when Docker is missing / not running or Kokoro never became healthy.
   */
  private async ensureKokoro(gen: number, cfg: ReadAloudConfig): Promise<boolean> {
    if (await this.health(cfg)) return true;
    const { deps } = this.opts;
    const ps = await deps.run(["docker", "ps", "-a", "--format", "{{.Names}}\t{{.Image}}\t{{.State}}"], { timeoutMs: 10_000 });
    if (ps.error || ps.code !== 0) {
      this.opts.log("warn", `read aloud: Docker unavailable (${ps.error ?? firstLine(ps.stderr)})`);
      return false;
    }
    if (!this.live(gen)) return false;
    const repo = imageRepo(cfg.dockerImage);
    const mine = ps.stdout
      .split("\n")
      .map((l) => l.split("\t"))
      .filter((f) => f.length >= 3 && f[0] && imageRepo(f[1] ?? "") === repo)
      .map((f) => ({ name: f[0] as string, state: f[2] ?? "" }));
    this.opts.toast(NOTICE.voiceStarting, "accepted_locally");
    const t0 = deps.now();
    if (!mine.some((c) => c.state === "running")) {
      const existing = mine[0];
      const cmd = existing
        ? ["docker", "start", existing.name]
        : ["docker", "run", "-d", "--name", CONTAINER_NAME, "-p", `127.0.0.1:${hostPort(cfg.kokoroUrl)}:${CONTAINER_PORT}`, cfg.dockerImage];
      this.opts.log("info", existing ? `read aloud: docker start ${existing.name}` : `read aloud: docker run ${cfg.dockerImage} (first run downloads the image)`);
      const r = await deps.run(cmd, { timeoutMs: existing ? DOCKER_START_TIMEOUT_MS : DOCKER_RUN_TIMEOUT_MS });
      if (r.error || r.code !== 0) {
        this.opts.log("warn", `read aloud: ${cmd.slice(0, 2).join(" ")} failed (${r.error ?? firstLine(r.stderr)})`);
        return false;
      }
    }
    const deadline = deps.now() + BOOT_WAIT_MS;
    while (this.live(gen)) {
      if (await this.health(cfg)) {
        this.opts.log("info", `read aloud: Kokoro healthy after ${deps.now() - t0} ms`);
        return true;
      }
      if (deps.now() >= deadline) break;
      await deps.sleep(POLL_MS);
    }
    if (this.live(gen)) this.opts.log("warn", `read aloud: Kokoro not healthy after ${BOOT_WAIT_MS} ms`);
    return false;
  }

  /** The on-device summary (ASCII, one paragraph), or null when the helper is missing, unavailable, fails or times out. */
  private async summarize(text: string): Promise<string | null> {
    const bin = this.opts.deps.summarizer;
    if (!bin) {
      this.opts.log("warn", "read aloud: fm1-summarize not built (bun run build:native); reading the start instead");
      return null;
    }
    const r = await this.opts.deps.run([bin], { stdin: text, timeoutMs: SUMMARY_TIMEOUT_MS });
    const out = r.stdout.replace(/[^\x20-\x7e]+/g, " ").replace(/\s+/g, " ").trim();
    if (r.error || r.code !== 0 || !out) {
      this.opts.log("warn", `read aloud: summary unavailable (${r.error ?? (firstLine(r.stderr) || `exit ${r.code}`)})`);
      return null;
    }
    return out;
  }

  private async synthesize(cfg: ReadAloudConfig, input: string): Promise<Uint8Array | null> {
    try {
      const r = await this.opts.deps.fetch(`${cfg.kokoroUrl}/v1/audio/speech`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "kokoro", input, voice: cfg.voice, response_format: "mp3", speed: 1 }),
        timeoutMs: SYNTH_TIMEOUT_MS,
      });
      if (!r.ok) {
        this.opts.log("warn", `read aloud: Kokoro speech HTTP ${r.status} (voice ${cfg.voice})`);
        return null;
      }
      const bytes = new Uint8Array(await r.arrayBuffer());
      return bytes.length > 0 ? bytes : null;
    } catch (e) {
      this.opts.log("warn", `read aloud: Kokoro speech failed (${e instanceof Error ? e.message : String(e)})`);
      return null;
    }
  }
}

/** The bundled helper (apps/companion/bin/fm1-summarize, built by scripts/build-native.sh), or FM1_SUMMARIZE_BIN. */
export function summarizerPath(): string {
  return process.env.FM1_SUMMARIZE_BIN ?? fileURLToPath(new URL("../../bin/fm1-summarize", import.meta.url));
}

/** Real processes, network, clock and temp files. */
export async function realSpeechDeps(): Promise<SpeechDeps> {
  const bin = summarizerPath();
  const summarizer = (await Bun.file(bin).exists()) ? bin : null;
  return {
    summarizer,
    async run(cmd, opts = {}) {
      let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
      try {
        proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      } catch (e) {
        return { code: -1, stdout: "", stderr: "", error: `cannot run ${cmd[0]}: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (opts.stdin !== undefined) proc.stdin.write(opts.stdin);
      void proc.stdin.end();
      let timedOut = false;
      const timer = opts.timeoutMs ? setTimeout(() => ((timedOut = true), proc.kill("SIGKILL")), opts.timeoutMs) : null;
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (timer) clearTimeout(timer);
      return timedOut ? { code: -1, stdout, stderr, error: `${cmd[0]} timed out after ${opts.timeoutMs} ms` } : { code, stdout, stderr };
    },
    spawn(cmd) {
      const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      return { exited: proc.exited, kill: () => proc.kill() };
    },
    fetch(url, init = {}) {
      const { timeoutMs, ...rest } = init;
      return fetch(url, timeoutMs ? { ...rest, signal: AbortSignal.timeout(timeoutMs) } : rest);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
    async writeTemp(bytes, ext) {
      const dir = await mkdtemp(join(tmpdir(), "fm1-read-"));
      const path = join(dir, `speech.${ext}`);
      await writeFile(path, bytes, { mode: 0o600 });
      return path;
    },
    async removeTemp(path) {
      const dir = path.slice(0, path.lastIndexOf("/"));
      await rm(dir.includes("fm1-read-") ? dir : path, { recursive: true, force: true });
    },
  };
}
