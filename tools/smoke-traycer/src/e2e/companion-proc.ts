// The real companion as a separate process: `fm1-console start --sim --adapter traycer --fixture-audio <wav>`.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UiState } from "@fm1/companion-ui";
import { cleanEnv, REPO_ROOT, sleep } from "../context";

export class CompanionProcess {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  readonly logLines: string[] = [];

  /** `mode`: device-mode arguments for `fm1-console start`, e.g. ["--sim", "--fixture-audio", wav] or ["--emu"]. */
  constructor(
    readonly uiPort: number,
    private readonly mode: readonly string[],
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.uiPort}`;
  }

  async start(timeoutMs = 60_000): Promise<void> {
    // Fresh config path: defaults only (cheapest models, sherpa ASR, no deep link), user config untouched.
    const env = { ...cleanEnv(), FM1_CONSOLE_CONFIG: join(mkdtempSync(join(tmpdir(), "fm1-e2e-cfg-")), "config.json") };
    const cmd = ["bun", join(REPO_ROOT, "apps/companion/src/cli.ts"), "start", ...this.mode, "--adapter", "traycer", "--ui-port", String(this.uiPort)];
    this.proc = Bun.spawn(cmd, { env, cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
    void this.pump(this.proc.stdout as ReadableStream<Uint8Array>);
    void this.pump(this.proc.stderr as ReadableStream<Uint8Array>);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = await this.state().catch(() => null);
      if (s?.backend.ready) return;
      await sleep(250);
    }
    throw new Error(`companion UI not ready on ${this.url}; last log: ${this.logLines.slice(-5).join(" | ")}`);
  }

  async state(): Promise<UiState> {
    const r = await fetch(`${this.url}/api/state`, { headers: { host: `127.0.0.1:${this.uiPort}` } });
    if (!r.ok) throw new Error(`api/state ${r.status}`);
    const push = (await r.json()) as { t?: string; state?: UiState };
    if (push.t !== "state" || push.state === undefined) throw new Error("api/state: unexpected payload");
    return push.state;
  }

  async stop(): Promise<number | null> {
    if (!this.proc) return null;
    this.proc.kill("SIGINT");
    const code = await Promise.race([this.proc.exited, sleep(5000).then(() => null)]);
    if (code === null) this.proc.kill("SIGKILL");
    return code;
  }

  private async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const dec = new TextDecoder();
    let buf = "";
    const reader = stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        this.logLines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
  }
}

export function selectedKey(s: UiState): string | null {
  for (const t of s.tasks) for (const x of t.sessions) if (x.selected) return x.key;
  return null;
}
