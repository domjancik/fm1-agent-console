import type { CommandRunner } from "./config";
import { deepLinkUrl } from "./focus";

/**
 * Guard rails for scripts/focus-test.ts: the live focus probe may act only on
 * a chat listed in reports/disposable-allowlist.json, and the command runner
 * it hands the adapter can run nothing but the read-only process listing and
 * `open -a <Traycer app> [<deep link to that one chat>]`.
 */

export interface DisposableAllowlist {
  readonly tasks: ReadonlyArray<{ readonly epicId: string; readonly chatIds: readonly string[] }>;
}

export function parseAllowlist(text: string): DisposableAllowlist {
  const raw = JSON.parse(text) as { tasks?: unknown };
  if (!Array.isArray(raw.tasks)) throw new Error("allowlist has no tasks array");
  const tasks = raw.tasks.map((t: unknown) => {
    const o = t as { epicId?: unknown; chatIds?: unknown };
    if (typeof o.epicId !== "string" || !Array.isArray(o.chatIds) || o.chatIds.some((c) => typeof c !== "string")) {
      throw new Error("allowlist entry needs epicId and chatIds[]");
    }
    return { epicId: o.epicId, chatIds: o.chatIds as string[] };
  });
  return { tasks };
}

export function isAllowlistedChat(list: DisposableAllowlist, epicId: string, chatId: string): boolean {
  return list.tasks.some((t) => t.epicId === epicId && t.chatIds.includes(chatId));
}

const TRAYCER_APP = /^\/.*\/Traycer[^/]*\.app$/;

/** True for `-a Traycer`, `-a /…/Traycer*.app` or `-a <focusApp>`. */
function allowedAppArg(app: string, focusApp: string | null): boolean {
  return app === "Traycer" || app === focusApp || (TRAYCER_APP.test(app) && !app.includes("/Contents/"));
}

/**
 * Wraps a runner so only these commands get through; anything else throws
 * before a process is spawned:
 *   ps -axo command=
 *   open -a <Traycer app>
 *   open -a <Traycer app> traycer://open/epic/<epicId>/chat/<chatId>?focus=composer   (this chat only)
 */
export function restrictedFocusRunner(
  inner: CommandRunner,
  target: { readonly epicId: string; readonly chatId: string },
  focusApp: string | null,
): CommandRunner {
  const url = deepLinkUrl(target.epicId, target.chatId);
  return (program, args, options) => {
    const ok =
      (program === "ps" && args.length === 2 && args[0] === "-axo" && args[1] === "command=") ||
      (program === "open" &&
        args[0] === "-a" &&
        typeof args[1] === "string" &&
        allowedAppArg(args[1], focusApp) &&
        (args.length === 2 || (args.length === 3 && url !== null && args[2] === url)));
    if (!ok) return Promise.reject(new Error(`focus-test: refused command ${program} ${JSON.stringify(args)}`));
    return inner(program, args, options);
  };
}

/**
 * Deep-link entries of the Desktop log (`[YYYY-MM-DD HH:MM:SS.mmm] [info]  [deep-link] …`,
 * local time) written at or after `sinceMs`. Continuation lines of a
 * multi-line entry are joined onto it.
 */
export function deepLinkLogLines(log: string, sinceMs: number): string[] {
  const out: string[] = [];
  const lines = log.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.includes("[deep-link]")) continue;
    const m = /^\[(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]/.exec(line);
    if (m !== null) {
      const at = Date.parse(`${m[1]}T${m[2]}`);
      if (!Number.isNaN(at) && at < sinceMs) continue;
    }
    let entry = line;
    while (i + 1 < lines.length && !(lines[i + 1] ?? "").startsWith("[") && (lines[i + 1] ?? "").length > 0) {
      entry += ` ${(lines[++i] ?? "").trim()}`;
    }
    out.push(entry.length > 300 ? `${entry.slice(0, 300)}…` : entry);
  }
  return out;
}
