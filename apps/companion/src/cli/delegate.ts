// Commands that hand off to other tools in the repo: Traycer smoke runner, firmware inspector.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../doctor/checks";
import { runInherit, traycerEnv } from "../proc";

export const EXIT_UNAVAILABLE = 2;

const say = (s: string): void => {
  process.stderr.write(`${s}\n`);
};

/** First existing path, relative to the repo root. */
function firstExisting(paths: readonly string[], root: string): string | null {
  for (const p of paths) if (existsSync(join(root, p))) return join(root, p);
  return null;
}

export const SMOKE_RUNNERS = ["tools/smoke-traycer/src/cli.ts", "packages/agent-adapter-traycer/src/smoke-cli.ts", "packages/agent-adapter-traycer/src/live-smoke.ts"];
export const FIRMWARE_INSPECT = ["tools/firmware-inspect/src/cli.ts"];
const PROBE = "tools/traycer-probe/src/cli.ts";

export interface AllowlistTask {
  epicId: string;
  chatIds?: string[];
}

export function readAllowlist(root = REPO_ROOT): AllowlistTask[] {
  const path = join(root, "reports", "disposable-allowlist.json");
  if (!existsSync(path)) return [];
  const v = JSON.parse(readFileSync(path, "utf8")) as { tasks?: AllowlistTask[] };
  return Array.isArray(v.tasks) ? v.tasks.filter((t) => typeof t.epicId === "string") : [];
}

export function isAllowlisted(epicId: string, chatId: string | null, root = REPO_ROOT): boolean {
  const t = readAllowlist(root).find((x) => x.epicId === epicId);
  return t !== undefined && (chatId === null || (t.chatIds ?? []).includes(chatId));
}

/** `test traycer --read-only | --live`. Read-only falls back to the probe's read-only discovery. */
export async function testTraycer(mode: "read-only" | "live", extra: string[], root = REPO_ROOT): Promise<number> {
  const runner = firstExisting(SMOKE_RUNNERS, root);
  const env = traycerEnv();
  if (mode === "live") {
    if (readAllowlist(root).length === 0) {
      say("test traycer --live: refused, reports/disposable-allowlist.json lists no disposable task");
      return EXIT_UNAVAILABLE;
    }
    if (!runner) {
      say(`test traycer --live: not available (no live smoke runner; looked for ${SMOKE_RUNNERS.join(", ")})`);
      return EXIT_UNAVAILABLE;
    }
    say(`delegating to ${runner} --live (targets limited to reports/disposable-allowlist.json)`);
    return runInherit(["bun", runner, "--live", ...extra], { env, cwd: root });
  }
  if (runner) {
    say(`delegating to ${runner} --read-only`);
    return runInherit(["bun", runner, "--read-only", ...extra], { env, cwd: root });
  }
  const probe = join(root, PROBE);
  if (!existsSync(probe)) {
    say("test traycer --read-only: not available (no smoke runner and no traycer-probe)");
    return EXIT_UNAVAILABLE;
  }
  say("no smoke runner found; running read-only discovery with traycer-probe (discover, list-tasks 5)");
  const a = await runInherit(["bun", probe, "discover"], { env, cwd: join(root, "tools", "traycer-probe") });
  if (a !== 0) return a;
  return runInherit(["bun", probe, "list-tasks", "5"], { env, cwd: join(root, "tools", "traycer-probe") });
}

/** `firmware verify <pkg.fwsc>`: only via tools/firmware-inspect. No fake success. */
export async function firmwareVerify(pkg: string | undefined, root = REPO_ROOT): Promise<number> {
  if (!pkg) {
    say("usage: fm1-console firmware verify <package.fwsc>");
    return EXIT_UNAVAILABLE;
  }
  const tool = firstExisting(FIRMWARE_INSPECT, root);
  if (!tool) {
    say(`firmware verify: not available (tools/firmware-inspect is not present in this checkout); nothing was verified`);
    return EXIT_UNAVAILABLE;
  }
  return runInherit(["bun", tool, "verify", pkg], { cwd: process.cwd() });
}
