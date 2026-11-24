#!/usr/bin/env bun
// fm1-console: companion CLI (spec section 16).
import { parseArgs } from "node:util";
import { parseAdapterKind } from "./adapters";
import { CANNED_USAGE, runCanned } from "./cli/canned";
import { EXIT_UNAVAILABLE, firmwareVerify, testTraycer } from "./cli/delegate";
import { testVoice } from "./cli/test-voice";
import { formatChecks, runDoctor } from "./doctor/checks";
import { startRuntime, type DeviceMode } from "./runtime";

const USAGE = `usage: fm1-console <command>

  doctor [--adapter traycer|mock] [--json]   read-only environment report
  start [--sim|--emu|--loopback] [--adapter traycer|mock] [--fixture-audio <wav>] [--warm] [--ui-port N] [--sim-port N] [--port NAME | --ble NAME]
                                             run the companion (default: real FM-1 port "FM1 CONSOLE")
                                             --port NAME: a CoreMIDI port (USB, or macOS Bluetooth MIDI "<name> Bluetooth")
                                             --ble NAME: BT direct to the advertised name, e.g. "FM1 CONSOLE 19E2"
                                                         (own CoreBluetooth helper, no Audio MIDI Setup, no CoreMIDI port)
  simulate [--adapter traycer|mock] [--fixture-audio <wav>]
                                             simulator on virtual MIDI + companion against it
  test traycer --read-only | --live [-- --only T2,T3 --no-report]
                                             delegate to tools/smoke-traycer (spec 6 T0-T9)
  test voice --fixture <wav> [--dispatch] [--target <id>] [--adapter mock|traycer] [--engine sherpa|apple]
  firmware verify <package.fwsc>             delegate to tools/firmware-inspect
${CANNED_USAGE}
                                             (edits the config file; a running companion picks it up before its next input)
`;

const say = (s: string): void => {
  process.stderr.write(`${s}\n`);
};

export interface StartSelection {
  mode: DeviceMode;
  devicePort?: string;
  bleDevice?: string;
}

/** Device choice of `start` from its flags; throws on a combination that makes no sense. */
export function parseStartSelection(f: Record<string, string | boolean | undefined>): StartSelection {
  if ([f.sim, f.emu, f.loopback].filter(Boolean).length > 1) throw new Error("--sim, --emu and --loopback are exclusive");
  if (f.port !== undefined && (f.sim || f.emu || f.loopback)) throw new Error("--port applies to the real FM-1 only");
  if (f.ble !== undefined && (f.sim || f.emu || f.loopback)) throw new Error("--ble applies to the real FM-1 only");
  if (f.ble !== undefined && f.port !== undefined) throw new Error("--port and --ble are exclusive (--port: CoreMIDI port, --ble: BT direct)");
  if (f.ble !== undefined && (typeof f.ble !== "string" || !f.ble.trim())) throw new Error('--ble needs the advertised device name, e.g. --ble "FM1 CONSOLE 19E2"');
  const mode: DeviceMode = f.loopback ? "loopback" : f.sim ? "sim" : f.emu ? "emu" : "real";
  return {
    mode,
    ...(typeof f.port === "string" ? { devicePort: f.port } : {}),
    ...(typeof f.ble === "string" ? { bleDevice: f.ble.trim() } : {}),
  };
}

async function runServer(sel: StartSelection, flags: Record<string, string | boolean | undefined>): Promise<number> {
  const rt = await startRuntime({
    ...sel,
    adapter: parseAdapterKind(typeof flags.adapter === "string" ? flags.adapter : undefined),
    captureFixture: typeof flags["fixture-audio"] === "string" ? flags["fixture-audio"] : undefined,
    uiPort: typeof flags["ui-port"] === "string" ? Number(flags["ui-port"]) : undefined,
    simUiPort: typeof flags["sim-port"] === "string" ? Number(flags["sim-port"]) : undefined,
    warm: flags.warm === true,
  });
  process.stdout.write(`fm1-console running\n${rt.describe.map((d) => `  ${d}`).join("\n")}\n`);
  await new Promise<void>((resolve) => {
    const stop = (): void => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await rt.stop();
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const { values: f, positionals: pos } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      adapter: { type: "string" },
      json: { type: "boolean" },
      sim: { type: "boolean" },
      emu: { type: "boolean" },
      loopback: { type: "boolean" },
      "fixture-audio": { type: "string" },
      "ui-port": { type: "string" },
      "sim-port": { type: "string" },
      port: { type: "string" },
      ble: { type: "string" },
      warm: { type: "boolean" },
      "read-only": { type: "boolean" },
      live: { type: "boolean" },
      fixture: { type: "string" },
      dispatch: { type: "boolean" },
      target: { type: "string" },
      engine: { type: "string" },
      language: { type: "string" },
      file: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, sub, arg] = pos;
  if (f.help || !cmd) {
    process.stdout.write(USAGE);
    return cmd ? 0 : EXIT_UNAVAILABLE;
  }
  switch (cmd) {
    case "doctor": {
      const checks = await runDoctor({ adapter: parseAdapterKind(f.adapter) });
      process.stdout.write(f.json ? `${JSON.stringify(checks, null, 2)}\n` : `${formatChecks(checks)}\n`);
      return checks.some((c) => c.status === "fail") ? 1 : 0;
    }
    case "start":
      return runServer(parseStartSelection(f), f);
    case "simulate":
      if (f.port !== undefined || f.ble !== undefined) throw new Error("simulate takes no --port or --ble");
      return runServer({ mode: "simulate" }, f);
    case "test":
      if (sub === "traycer") {
        if (f.live === f["read-only"]) throw new Error("test traycer needs exactly one of --read-only, --live");
        return testTraycer(f.live ? "live" : "read-only", pos.slice(2));
      }
      if (sub === "voice") {
        if (!f.fixture) throw new Error("test voice needs --fixture <wav>");
        if (f.engine !== undefined && f.engine !== "sherpa" && f.engine !== "apple") throw new Error("--engine must be sherpa or apple");
        return testVoice({
          fixture: f.fixture,
          adapter: parseAdapterKind(f.adapter ?? "mock"),
          dispatch: f.dispatch === true,
          target: f.target,
          engine: f.engine,
          language: f.language,
        });
      }
      throw new Error(`unknown test "${sub ?? ""}" (traycer | voice)`);
    case "canned":
      return runCanned(sub, pos.slice(2), { file: f.file });
    case "firmware":
      if (sub !== "verify") throw new Error(`unknown firmware command "${sub ?? ""}" (verify)`);
      return firmwareVerify(arg);
    default:
      throw new Error(`unknown command "${cmd}"`);
  }
}

if (import.meta.main) {
  // Vendored Traycer transport code logs through console.*; keep stdout for command output (doctor --json).
  for (const level of ["log", "info", "debug", "warn"] as const) console[level] = (...parts: unknown[]) => console.error(...parts);
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      say(`fm1-console: ${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
      process.exit(EXIT_UNAVAILABLE);
    },
  );
}
