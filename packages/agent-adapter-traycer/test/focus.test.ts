import { afterEach, describe, expect, test } from "bun:test";
import type { SessionRef } from "@fm1/agent-core";
import type { CommandRunner } from "../src/agent/config";
import { configureFocusApp, configuredFocusApp, findRunningTraycer, focusSession, normalizeFocusApp } from "../src/agent/focus";
import { deepLinkLogLines, isAllowlistedChat, parseAllowlist, restrictedFocusRunner } from "../src/agent/focus-probe";

const PATCHED = "/Users/x/traycer-patched/out/Traycer FM1.app";
const URL_E1_C1 = "traycer://open/epic/e1/chat/c1?focus=composer";
const ref = (taskId: string, sessionId: string): SessionRef => ({ backendId: "traycer", hostId: "h", projectId: "p", taskId, sessionId });

interface Call {
  program: string;
  args: readonly string[];
}

function fakeSpawner(psOutput: string, openCode = 0): { run: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: CommandRunner = async (program, args) => {
    calls.push({ program, args: [...args] });
    if (program === "ps") return { code: 0, stdout: psOutput };
    if (program === "open") return { code: openCode, stdout: "" };
    throw new Error(`unexpected ${program}`);
  };
  return { run, calls };
}

const PS_PATCHED = [
  "/sbin/launchd",
  `${PATCHED}/Contents/MacOS/Traycer FM1`,
  `${PATCHED}/Contents/Frameworks/Traycer FM1 Helper (Renderer).app/Contents/MacOS/Traycer FM1 Helper (Renderer) --type=renderer`,
  "/Applications/Traycer.app/Contents/Library/LaunchAgents/Traycer Host.app/Contents/MacOS/traycer host start --service-label ai.traycer.host.agent",
].join("\n");
const PS_STOCK = [
  "/Applications/Traycer.app/Contents/MacOS/Traycer",
  "/Applications/Traycer.app/Contents/Frameworks/Traycer Helper.app/Contents/MacOS/Traycer Helper --type=gpu-process",
  "/Applications/Traycer.app/Contents/Library/LaunchAgents/Traycer Host.app/Contents/MacOS/traycer host start",
].join("\n");
const PS_NONE = "/Applications/Traycer.app/Contents/Library/LaunchAgents/Traycer Host.app/Contents/MacOS/traycer host start";

afterEach(() => configureFocusApp(null));

describe("review: process list parsing", () => {
  test("a process that only mentions a Traycer bundle in its arguments is not an open -a target", async () => {
    const ps = ["/usr/bin/grep /tmp/Traycer Evil.app/Contents/MacOS/x", "vim /x/Traycer.app/Contents/MacOS/Traycer", PS_STOCK].join("\n");
    const { run } = fakeSpawner(ps);
    expect(await findRunningTraycer(run, PATCHED, {})).toEqual({ patched: false, other: "/Applications/Traycer.app" });
    const fake = fakeSpawner(`/usr/bin/tail ${PATCHED}/Contents/MacOS/Traycer FM1`);
    expect(await findRunningTraycer(fake.run, PATCHED, {})).toEqual({ patched: false, other: null });
  });
});

describe("focusSession with a patched Desktop (focusApp)", () => {
  test("patched app running: open -a <focusApp> <deep link>, level tile+composer", async () => {
    const { run, calls } = fakeSpawner(PS_PATCHED);
    const r = await focusSession(run, ref("e1", "c1"), "f1", { deepLink: true, runtime: "chat", focusApp: PATCHED });
    expect(r).toMatchObject({ requestId: "f1", stage: "completed", level: "tile+composer" });
    expect(calls).toEqual([
      { program: "ps", args: ["-axo", "command="] },
      { program: "open", args: ["-a", PATCHED, URL_E1_C1] },
    ]);
  });

  test("patched app not running, stock running: activates the stock bundle, level window, no deep link", async () => {
    const { run, calls } = fakeSpawner(PS_STOCK);
    const r = await focusSession(run, ref("e1", "c1"), "f2", { deepLink: true, runtime: "chat", focusApp: PATCHED });
    expect(r).toMatchObject({ stage: "completed", level: "window" });
    expect(r.message).toContain("window activated");
    expect(calls.at(-1)).toEqual({ program: "open", args: ["-a", "/Applications/Traycer.app"] });
    expect(calls.some((c) => c.args.includes(URL_E1_C1))).toBe(false);
  });

  test("no Traycer running: falls back to open -a Traycer, never launches the patched app", async () => {
    const { run, calls } = fakeSpawner(PS_NONE);
    const r = await focusSession(run, ref("e1", "c1"), "f3", { deepLink: true, runtime: "chat", focusApp: PATCHED });
    expect(r.level).toBe("window");
    expect(calls.at(-1)).toEqual({ program: "open", args: ["-a", "Traycer"] });
    expect(calls.some((c) => c.args.includes(PATCHED))).toBe(false);
  });

  test("ps failure counts as not running", async () => {
    const calls: Call[] = [];
    const run: CommandRunner = async (program, args) => {
      calls.push({ program, args });
      if (program === "ps") throw new Error("spawn failed");
      return { code: 0, stdout: "" };
    };
    const r = await focusSession(run, ref("e1", "c1"), "f4", { deepLink: true, runtime: "chat", focusApp: PATCHED });
    expect(r.level).toBe("window");
    expect(calls.at(-1)?.args).toEqual(["-a", "Traycer"]);
  });

  test("open failure on the patched path reports failed", async () => {
    const { run } = fakeSpawner(PS_PATCHED, 1);
    const r = await focusSession(run, ref("e1", "c1"), "f5", { deepLink: true, runtime: "chat", focusApp: PATCHED });
    expect(r).toEqual({ requestId: "f5", stage: "failed", message: "open exited 1" });
  });

  test("a terminal agent gets the same deep link (gui-app treats chat and terminal-agent tiles alike)", async () => {
    const { run, calls } = fakeSpawner(PS_PATCHED);
    const r = await focusSession(run, ref("e1", "t1"), "f8", { deepLink: true, runtime: "terminal", focusApp: PATCHED });
    expect(r.level).toBe("tile+composer");
    expect(calls.at(-1)).toEqual({ program: "open", args: ["-a", PATCHED, "traycer://open/epic/e1/chat/t1?focus=composer"] });
  });

  test("no deep link (focusDeepLink off, unknown runtime, invalid ids): the running Traycer is activated, no link sent", async () => {
    for (const [opts, sid] of [
      [{ deepLink: false, runtime: "chat" as const }, "c1"],
      [{ deepLink: true, runtime: null }, "t1"],
      [{ deepLink: true, runtime: "chat" as const }, "../x"],
    ] as const) {
      // The side-by-side build is running: activate it (`open -a Traycer` would launch the stock app, which quits on
      // the shared single-instance lock).
      const { run, calls } = fakeSpawner(PS_PATCHED);
      const r = await focusSession(run, ref("e1", sid), "f6", { ...opts, focusApp: PATCHED });
      expect(r.level).toBe("window");
      expect(calls.at(-1)).toEqual({ program: "open", args: ["-a", PATCHED] });
      expect(calls.some((c) => c.args.some((a) => a.startsWith("traycer://")))).toBe(false);
      // Nothing running: the stock app, as before.
      const none = fakeSpawner(PS_NONE);
      await focusSession(none.run, ref("e1", sid), "f6", { ...opts, focusApp: PATCHED });
      expect(none.calls.at(-1)).toEqual({ program: "open", args: ["-a", "Traycer"] });
    }
  });

  test("without focusApp the stock behaviour is unchanged (bare open <url>)", async () => {
    const { run, calls } = fakeSpawner(PS_PATCHED);
    await focusSession(run, ref("e1", "c1"), "f7", { deepLink: true, runtime: "chat" });
    expect(calls).toEqual([{ program: "open", args: [URL_E1_C1] }]);
  });

  test("configureFocusApp sets the default used when the option is omitted", async () => {
    configureFocusApp(`${PATCHED}/`);
    expect(configuredFocusApp()).toBe(PATCHED);
    const { run, calls } = fakeSpawner(PS_PATCHED);
    const r = await focusSession(run, ref("e1", "c1"), "f8", { deepLink: true, runtime: "chat" });
    expect(r.level).toBe("tile+composer");
    expect(calls.at(-1)?.args).toEqual(["-a", PATCHED, URL_E1_C1]);
    // An explicit null overrides the default.
    const second = fakeSpawner(PS_PATCHED);
    await focusSession(second.run, ref("e1", "c1"), "f9", { deepLink: true, runtime: "chat", focusApp: null });
    expect(second.calls).toEqual([{ program: "open", args: [URL_E1_C1] }]);
  });

  test("normalizeFocusApp rejects relative or non-.app paths", () => {
    expect(normalizeFocusApp(null)).toBeNull();
    expect(normalizeFocusApp("  ")).toBeNull();
    expect(normalizeFocusApp(`${PATCHED}//`)).toBe(PATCHED);
    expect(() => normalizeFocusApp("Traycer FM1.app")).toThrow();
    expect(() => normalizeFocusApp("/usr/bin/open")).toThrow();
  });

  test("findRunningTraycer separates the patched app, the stock app and helper bundles", async () => {
    const both = `${PS_PATCHED}\n${PS_STOCK}`;
    expect(await findRunningTraycer(fakeSpawner(both).run, PATCHED, {})).toEqual({ patched: true, other: "/Applications/Traycer.app" });
    expect(await findRunningTraycer(fakeSpawner(PS_NONE).run, PATCHED, {})).toEqual({ patched: false, other: null });
    expect(await findRunningTraycer(fakeSpawner(PS_PATCHED).run, null, {})).toEqual({ patched: false, other: PATCHED });
  });
});

describe("focus probe guard rails", () => {
  const list = parseAllowlist(JSON.stringify({ tasks: [{ epicId: "e1", chatIds: ["c1", "c2"] }] }));

  test("allowlist matches epic+chat pairs only", () => {
    expect(isAllowlistedChat(list, "e1", "c1")).toBe(true);
    expect(isAllowlistedChat(list, "e1", "c9")).toBe(false);
    expect(isAllowlistedChat(list, "e2", "c1")).toBe(false);
    expect(() => parseAllowlist("{}")).toThrow();
  });

  test("the real allowlist file parses", async () => {
    const text = await Bun.file(new URL("../../../reports/disposable-allowlist.json", import.meta.url).pathname).text();
    expect(parseAllowlist(text).tasks.length).toBeGreaterThan(0);
  });

  test("restricted runner lets through only ps, open -a <Traycer> and this chat's deep link", async () => {
    const { run, calls } = fakeSpawner(PS_PATCHED);
    const r = restrictedFocusRunner(run, { epicId: "e1", chatId: "c1" }, PATCHED);
    const opts = { env: {}, timeoutMs: 1 };
    await r("ps", ["-axo", "command="], opts);
    await r("open", ["-a", "Traycer"], opts);
    await r("open", ["-a", "/Applications/Traycer.app"], opts);
    await r("open", ["-a", PATCHED, URL_E1_C1], opts);
    expect(calls).toHaveLength(4);
    for (const [program, args] of [
      ["open", ["-a", PATCHED, "traycer://open/epic/e1/chat/c2?focus=composer"]],
      ["open", [URL_E1_C1]],
      ["open", ["-a", "Terminal"]],
      ["open", ["-a", "/Applications/Traycer.app/Contents/Library/LaunchAgents/Traycer Host.app"]],
      ["traycer", ["task", "create"]],
      ["osascript", ["-e", "tell application \"System Events\" to keystroke \"x\""]],
      ["ps", ["aux"]],
    ] as const) {
      await expect(r(program, args, opts)).rejects.toThrow("refused");
    }
    expect(calls).toHaveLength(4);
  });

  test("deepLinkLogLines keeps recent deep-link entries and joins continuation lines", () => {
    const log = [
      "[2026-11-17 21:02:07.926] [info]  [deep-link] open-url {",
      "  url: 'traycer://open/epic/e/chat/c'",
      "}",
      "[2026-11-18 10:00:00.000] [info]  [other] noise",
      "[2026-11-18 10:00:01.000] [info]  [deep-link] open chat",
    ].join("\n");
    const since = Date.parse("2026-11-18T09:59:59");
    expect(deepLinkLogLines(log, since)).toEqual(["[2026-11-18 10:00:01.000] [info]  [deep-link] open chat"]);
    expect(deepLinkLogLines(log, 0)[0]).toContain("url: 'traycer://open/epic/e/chat/c' }");
  });
});
