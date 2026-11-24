import type { CommandResult, SessionRef } from "@fm1/agent-core";
import type { CommandRunner } from "./config";
import { DEEP_LINK_ID } from "./mapping";

/**
 * Desktop focus.
 *
 * Default (stock Traycer 1.5.4): `open -a Traycer` brings the window to the
 * front. Nothing public selects a chat tile (docs/traycer-integration.md,
 * verdict 2), so the result says the window was activated, not the tile.
 *
 * With `focusDeepLink`, opens `traycer://open/epic/<E>/chat/<C>?focus=composer`.
 * Stock 1.5.4 ignores the path (LaunchServices still activates the window);
 * a Desktop build with docs/upstream/traycer-deep-link.diff selects the tile.
 *
 * With `focusDeepLink` AND a configured `focusApp` (path to the side-by-side
 * patched build, e.g. ".../traycer-patched/out/Traycer FM1.app"), the link is
 * sent to that app explicitly: `open -a <focusApp> <url>`. The patched build
 * does not claim `traycer://` as the default handler, so a bare `open <url>`
 * would reach the stock app. Level `tile+composer` is reported only when the
 * patched app is running; otherwise focus falls back to activating whichever
 * Traycer is running (level `window`).
 */

export type FocusLevel = "window" | "tile+composer";
export type FocusResult = CommandResult & { readonly level?: FocusLevel };

export interface FocusOptions {
  readonly deepLink: boolean;
  readonly runtime: "chat" | "terminal" | null;
  /** Patched Desktop .app path. `undefined` = the process-wide default (`configureFocusApp`). */
  readonly focusApp?: string | null;
}

/** Bundle path of the stock app; used only to recognise it in the process list. */
export const STOCK_TRAYCER_APP = "/Applications/Traycer.app";

let defaultFocusApp: string | null = null;

/** Validates a configured focus app path: absolute, ends in `.app`, no trailing slash. */
export function normalizeFocusApp(path: string | null | undefined): string | null {
  if (path === null || path === undefined) return null;
  const trimmed = path.trim().replace(/\/+$/, "");
  if (trimmed === "") return null;
  if (!trimmed.startsWith("/") || !trimmed.endsWith(".app") || trimmed.includes("\n")) {
    throw new Error(`focusApp must be an absolute path to a .app bundle: ${JSON.stringify(path)}`);
  }
  return trimmed;
}

/**
 * Sets the process-wide patched-Desktop path used when `focusSession` gets no
 * explicit `focusApp` (the companion calls this from its config).
 */
export function configureFocusApp(path: string | null | undefined): void {
  defaultFocusApp = normalizeFocusApp(path);
}

export function configuredFocusApp(): string | null {
  return defaultFocusApp;
}

export function deepLinkUrl(epicId: string, chatId: string): string | null {
  if (!DEEP_LINK_ID.test(epicId) || !DEEP_LINK_ID.test(chatId)) return null;
  return `traycer://open/epic/${epicId}/chat/${chatId}?focus=composer`;
}

/** Bundle path of a running app whose main executable lives in `<bundle>/Contents/MacOS/`. */
function bundleOf(command: string): string | null {
  // Only an absolute executable path counts: `vim /x/Traycer.app/Contents/MacOS/y` or any other process that merely
  // mentions a bundle in its arguments must not become an `open -a` target.
  if (!command.startsWith("/")) return null;
  const at = command.indexOf(".app/Contents/MacOS/");
  if (at < 0) return null;
  // Helpers live under Contents/Frameworks, so a MacOS/ hit is a main executable.
  const bundle = command.slice(0, at + ".app".length);
  // ` /` starts a second argument (`/usr/bin/grep /x/Traycer.app/...`): not the executable's own path.
  return bundle.includes(" /") ? null : bundle;
}

export interface RunningTraycer {
  /** The patched app (`focusApp`) is running. */
  readonly patched: boolean;
  /** Bundle path of another running Traycer main process, if any. */
  readonly other: string | null;
}

/** Reads the process list once (`ps -axo command=`) and finds the Traycer main processes. */
export async function findRunningTraycer(
  run: CommandRunner,
  focusApp: string | null,
  env: Record<string, string | undefined>,
): Promise<RunningTraycer> {
  let stdout = "";
  try {
    const result = await run("ps", ["-axo", "command="], { env, timeoutMs: 5_000 });
    if (result.code === 0) stdout = result.stdout;
  } catch {
    stdout = "";
  }
  let patched = false;
  let other: string | null = null;
  for (const line of stdout.split("\n")) {
    const bundle = bundleOf(line.trim());
    if (bundle === null) continue;
    if (focusApp !== null && bundle === focusApp) {
      patched = true;
      continue;
    }
    if (other === null && (bundle === STOCK_TRAYCER_APP || /\/Traycer[^/]*\.app$/.test(bundle))) {
      if (!bundle.includes("/Contents/")) other = bundle;
    }
  }
  return { patched, other };
}

async function runOpen(
  run: CommandRunner,
  args: readonly string[],
  env: Record<string, string | undefined>,
  requestId: string,
): Promise<FocusResult | null> {
  try {
    const { code } = await run("open", args, { env, timeoutMs: 10_000 });
    if (code !== 0) return { requestId, stage: "failed", message: `open exited ${code}` };
  } catch (error) {
    return { requestId, stage: "failed", message: error instanceof Error ? error.message : String(error) };
  }
  return null;
}

export async function focusSession(
  run: CommandRunner,
  ref: SessionRef,
  requestId: string,
  options: FocusOptions,
): Promise<FocusResult> {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  // Terminal agents too: gui-app routes a chat payload to an open `chat` or `terminal-agent` tile alike
  // (notifications/payload.ts isChatArtifactTileType), so the same link carries a terminal agent's id.
  const url = options.deepLink && options.runtime !== null ? deepLinkUrl(ref.taskId, ref.sessionId) : null;
  const focusApp = options.focusApp === undefined ? defaultFocusApp : normalizeFocusApp(options.focusApp);

  if (url !== null && focusApp !== null) {
    const running = await findRunningTraycer(run, focusApp, env);
    if (running.patched) {
      const failed = await runOpen(run, ["-a", focusApp, url], env, requestId);
      if (failed !== null) return failed;
      return { requestId, stage: "completed", level: "tile+composer", message: "deep link sent to the patched Desktop; chat tile selected, composer focused" };
    }
    // Patched build not running: activate whichever Traycer is (never launch the patched one).
    const target = running.other ?? "Traycer";
    const failed = await runOpen(run, ["-a", target], env, requestId);
    if (failed !== null) return failed;
    return {
      requestId,
      stage: "completed",
      level: "window",
      message: "Traycer window activated; the patched Desktop is not running, so the chat tile is not selected",
    };
  }

  // Activate the Traycer that is running (stock or a side-by-side build): `open -a Traycer` would launch the stock app,
  // which quits at once on the shared single-instance lock while another build holds it (operator report 2026-11-23).
  const args = url === null ? ["-a", (await findRunningTraycer(run, null, env)).other ?? "Traycer"] : [url];
  const failed = await runOpen(run, args, env, requestId);
  if (failed !== null) return failed;
  return {
    requestId,
    stage: "completed",
    level: "window",
    message:
      url === null
        ? "Traycer window activated; the chat tile is not selected (needs upstream deep link)"
        : "deep link sent; tile selection requires a Desktop build with the deep-link patch",
  };
}
