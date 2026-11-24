/**
 * Live focus probe for the patched Traycer Desktop ("Traycer FM1.app").
 *
 * Calls TraycerAgentAdapter.focus() (focusDeepLink on, focusApp = the patched
 * build) for ONE chat that must be listed in reports/disposable-allowlist.json,
 * then reports the frontmost app, its front window title, the AX focused
 * element and the Desktop log's [deep-link] lines, so tile/composer focus can
 * be judged.
 *
 * Host access is read-only (handshake, list, chat.subscribe). The only
 * processes it may start are `ps -axo command=`, `open -a <Traycer app>
 * [traycer://open/epic/<E>/chat/<C>?focus=composer]`, `lsappinfo` and
 * read-only `osascript` queries. It never types, clicks, sends or launches
 * the patched app (if it is not running, focus falls back to the window).
 *
 *   env -u TRAYCER_AGENT_ID -u TRAYCER_EPIC_ID -u TRAYCER_TERMINAL_SPAWN_TOKEN \
 *     bun packages/agent-adapter-traycer/scripts/focus-test.ts --epic <E> --chat <C> \
 *       [--focus-app "/…/Traycer FM1.app"] [--settle-ms 2500]
 *
 * Exit codes: 0 ran (read the JSON verdict), 2 refused (not allowlisted / bad
 * args), 3 chat not found on the host, 1 error.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnRunner } from "../src/agent/cli";
import { configureFocusApp, normalizeFocusApp, findRunningTraycer, type FocusResult } from "../src/agent/focus";
import { deepLinkLogLines, isAllowlistedChat, parseAllowlist, restrictedFocusRunner } from "../src/agent/focus-probe";
import { TraycerAgentAdapter } from "../src/agent/traycer-agent-adapter";

for (const key of ["TRAYCER_AGENT_ID", "TRAYCER_EPIC_ID", "TRAYCER_TERMINAL_SPAWN_TOKEN"]) delete process.env[key];

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const ALLOWLIST = join(REPO_ROOT, "reports", "disposable-allowlist.json");
const DEFAULT_FOCUS_APP = "/Users/dominikj/dev/personal/.fm1-upstream/traycer-patched/out/Traycer FM1.app";
const DESKTOP_LOG = join(homedir(), "Library", "Application Support", "Traycer", "traycer-desktop.log");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function refuse(message: string): never {
  console.error(`focus-test: ${message}`);
  process.exit(2);
}

const epicId = arg("--epic");
const chatId = arg("--chat");
if (epicId === undefined || chatId === undefined) refuse("usage: --epic <epicId> --chat <chatId> [--focus-app <path>] [--settle-ms N]");
const allowlist = parseAllowlist(readFileSync(ALLOWLIST, "utf8"));
if (!isAllowlistedChat(allowlist, epicId, chatId)) refuse(`chat ${chatId} in epic ${epicId} is not in reports/disposable-allowlist.json`);
const focusApp = normalizeFocusApp(arg("--focus-app") ?? DEFAULT_FOCUS_APP);
if (focusApp === null || !existsSync(focusApp)) refuse(`focus app not found: ${focusApp}`);
const settleMs = Number(arg("--settle-ms") ?? 2500);

const env = { PATH: process.env.PATH, HOME: process.env.HOME };
const sh = async (program: string, args: readonly string[]): Promise<string> => {
  try {
    const { code, stdout } = await spawnRunner(program, args, { env, timeoutMs: 5_000 });
    return code === 0 ? stdout.trim() : `<exit ${code}>`;
  } catch (error) {
    return `<error ${error instanceof Error ? error.message : String(error)}>`;
  }
};
const osa = (script: string): Promise<string> => sh("osascript", ["-e", script]);

async function snapshot(): Promise<Record<string, string>> {
  const front = await sh("lsappinfo", ["front"]);
  return {
    lsappinfoFront: front,
    frontApp: await sh("lsappinfo", ["info", "-only", "name", front]),
    frontProcess: await osa('tell application "System Events" to get name of first process whose frontmost is true'),
    frontWindowTitle: await osa(
      'tell application "System Events" to tell (first process whose frontmost is true) to get name of front window',
    ),
    axFocusedElement: await osa(
      'tell application "System Events" to tell (first process whose frontmost is true) to get {role, description} of (value of attribute "AXFocusedUIElement")',
    ),
  };
}

const startedAt = Date.now();
const running = await findRunningTraycer(spawnRunner, focusApp, env);
const before = await snapshot();

configureFocusApp(focusApp);
const adapter = new TraycerAgentAdapter({
  focusDeepLink: true,
  sessionScanLimit: 5,
  runCommand: restrictedFocusRunner(spawnRunner, { epicId, chatId }, focusApp),
});
let result: FocusResult | null = null;
let exitCode = 0;
try {
  await adapter.connect();
  const sessions = await adapter.listSessions(epicId);
  const session = sessions.find((s) => s.ref.taskId === epicId && s.ref.sessionId === chatId);
  if (session === undefined) {
    console.error(`focus-test: chat ${chatId} not found on the host under epic ${epicId}`);
    exitCode = 3;
  } else {
    result = (await adapter.focus(session.ref, `focus-test-${startedAt}`)) as FocusResult;
    await Bun.sleep(settleMs);
  }
} catch (error) {
  console.error(`focus-test: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  await adapter.disconnect().catch(() => undefined);
}

const after = await snapshot();
let deepLinkLog: string[] = [];
try {
  deepLinkLog = deepLinkLogLines(readFileSync(DESKTOP_LOG, "utf8"), startedAt - 1_000);
} catch {
  deepLinkLog = ["<desktop log unreadable>"];
}

console.log(
  JSON.stringify(
    {
      target: { epicId, chatId },
      focusApp,
      runningBefore: running,
      result,
      before,
      after,
      deepLinkLog,
      judge:
        "tile: the after-screenshot / window shows the disposable chat tile; composer: axFocusedElement is a text area in that tile (needs Accessibility for osascript) or a keystroke probe done by a person",
    },
    null,
    2,
  ),
);
process.exit(exitCode);
