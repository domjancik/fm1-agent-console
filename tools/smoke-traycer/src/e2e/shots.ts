// Evidence capture: headless Chrome screenshots of the two local UIs, the simulator layout dump, frontmost app.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layoutScreen, type DeviceState } from "@fm1/device-simulator";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Headless screenshot with a throwaway profile (the user's Chrome profile is never used). */
export async function screenshot(url: string, out: string, size = "1400,1000"): Promise<boolean> {
  const profile = mkdtempSync(join(tmpdir(), "fm1-shot-"));
  const p = Bun.spawn(
    [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${profile}`, `--window-size=${size}`, "--virtual-time-budget=4000", `--screenshot=${out}`, url],
    { stdout: "ignore", stderr: "ignore" },
  );
  const code = await Promise.race([p.exited, Bun.sleep(30_000).then(() => -1)]);
  if (code === -1) p.kill("SIGKILL");
  return code === 0 && (await Bun.file(out).exists());
}

export function dumpLayout(state: DeviceState, out: string, nowMs: number): void {
  writeFileSync(out, `${JSON.stringify({ state, layout: layoutScreen(state, nowMs) }, null, 2)}\n`);
}

export async function activate(app: string): Promise<void> {
  await Bun.spawn(["open", "-a", app], { stdout: "ignore", stderr: "ignore" }).exited;
}

/** Name of the frontmost application (LaunchServices; needs no Accessibility permission). */
export async function frontmostApp(): Promise<string> {
  const run = async (args: string[]): Promise<string> => {
    const p = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out.trim();
  };
  const asn = await run(["lsappinfo", "front"]);
  const info = await run(["lsappinfo", "info", "-only", "name", asn]);
  return /^"([^"]+)"/.exec(info)?.[1] ?? "?";
}
