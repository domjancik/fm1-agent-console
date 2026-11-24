import { spawn } from "node:child_process";
import type { CommandRunner } from "./config";

/** Agent-context variables that would scope the CLI to a calling agent's Task. Always removed. */
export const STRIPPED_ENV = ["TRAYCER_AGENT_ID", "TRAYCER_EPIC_ID", "TRAYCER_TERMINAL_SPAWN_TOKEN"] as const;

export function strippedEnv(base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const env = { ...base };
  for (const key of STRIPPED_ENV) delete env[key];
  return env;
}

/** Spawns without a shell; stdout is captured, stderr discarded (it can echo prompt text). */
export const spawnRunner: CommandRunner = (program, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(program, [...args], { env: options.env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });

export interface TaskCreateArgs {
  readonly message: string;
  readonly harnessId: string;
  readonly model: string;
  readonly title?: string;
  readonly workspace?: string;
  readonly repo?: string;
  readonly reasoningEffort?: string;
  readonly permissionMode?: string;
  readonly idempotencyKey: string;
}

export function taskCreateArgv(args: TaskCreateArgs): string[] {
  const argv = ["task", "create", "--json", "--no-progress", "--message", args.message, "--harness", args.harnessId, "--model", args.model];
  argv.push("--idempotency-key", args.idempotencyKey);
  if (args.title) argv.push("--title", args.title);
  if (args.workspace) argv.push("--workspace", args.workspace);
  if (args.repo) argv.push("--repo", args.repo);
  if (args.reasoningEffort) argv.push("--reasoning-effort", args.reasoningEffort);
  if (args.permissionMode) argv.push("--permission-mode", args.permissionMode);
  return argv;
}

export type TaskCreateOutcome =
  | { readonly ok: true; readonly taskId: string; readonly agentId: string; readonly alreadyCreated: boolean }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly mayHaveCreated: boolean };

/**
 * Parses `traycer task create --json` NDJSON. The CLI's last line is
 * `{"type":"result","status":"ok","data":{"taskId","agentId","alreadyCreated"}}`
 * (shape read from the 1.5.4 CLI bundle's `created()`), or an error result.
 */
export function parseTaskCreateOutput(stdout: string, exitCode: number | null): TaskCreateOutcome {
  let result: Record<string, unknown> | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.type === "result") result = parsed;
    } catch {
      // progress noise
    }
  }
  if (result === null) {
    return { ok: false, code: "NO_RESULT", message: `traycer task create exited ${exitCode} without a result line`, mayHaveCreated: true };
  }
  const data = (result.data ?? {}) as Record<string, unknown>;
  if (result.status === "ok" && typeof data.taskId === "string" && typeof data.agentId === "string") {
    return { ok: true, taskId: data.taskId, agentId: data.agentId, alreadyCreated: data.alreadyCreated === true };
  }
  const error = (result.error ?? {}) as Record<string, unknown>;
  const code = typeof error.code === "string" ? error.code : "CLI_ERROR";
  const message = typeof error.message === "string" ? error.message : `traycer task create failed (${String(result.status)})`;
  return { ok: false, code, message, mayHaveCreated: /may have been created|OUTCOME_UNKNOWN/i.test(`${code} ${message}`) };
}
