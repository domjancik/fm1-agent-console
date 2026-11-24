// Small subprocess helpers for the CLI (doctor probes and delegated tools).

/** Environment without the agent-context variables, so Traycer CLI calls act as the user, not as an agent. */
export function traycerEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (k === "TRAYCER_AGENT_ID" || k === "TRAYCER_EPIC_ID" || k === "TRAYCER_TERMINAL_SPAWN_TOKEN") continue;
    env[k] = v;
  }
  return env;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Set when the process could not be started or timed out. */
  error?: string;
}

/** Runs a command to completion with captured output; never throws. */
export async function run(cmd: string[], opts: { env?: Record<string, string>; timeoutMs?: number; cwd?: string } = {}): Promise<RunResult> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: opts.env, cwd: opts.cwd });
  } catch (e) {
    return { code: -1, stdout: "", stderr: "", error: `cannot run ${cmd[0]}: ${e instanceof Error ? e.message : String(e)}` };
  }
  let timedOut = false;
  const timer = opts.timeoutMs ? setTimeout(() => ((timedOut = true), proc.kill("SIGKILL")), opts.timeoutMs) : null;
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (timer) clearTimeout(timer);
  return timedOut ? { code: -1, stdout, stderr, error: `${cmd[0]} timed out after ${opts.timeoutMs} ms` } : { code, stdout, stderr };
}

/** Runs a command with inherited stdio and returns its exit code. */
export async function runInherit(cmd: string[], opts: { env?: Record<string, string>; cwd?: string } = {}): Promise<number> {
  const proc = Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: opts.env, cwd: opts.cwd });
  return proc.exited;
}
