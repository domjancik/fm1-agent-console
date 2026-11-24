#!/usr/bin/env bun
// firmware-inspect: read-only FM-1 firmware tooling. It never opens a MIDI port and never writes to a device.
//   verify PACKAGE.fwsc [--json] [--expect-identity ID] [--expect-sha256 HEX]
//   dump FULL.bin [--second FULL2.bin] [--package PKG.fwsc] [--json]
//   device [--json]
// Exit codes: 0 ok, 1 a check failed (mismatch), 2 usage or unreadable input.
import { readFileSync } from "node:fs";
import { readDevices } from "./device";
import { analyseDump } from "./dump";
import { formatDevices, formatDump, formatVerify } from "./format";
import { verifyPackage } from "./verify";

const USAGE = `usage:
  firmware-inspect verify PACKAGE.fwsc [--json] [--expect-identity ID] [--expect-sha256 HEX]
  firmware-inspect dump FULL.bin [--second FULL2.bin] [--package PKG.fwsc] [--json]
  firmware-inspect device [--json]`;

interface Args {
  cmd: string;
  pos: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const [cmd = "", ...rest] = argv;
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? "";
    if (!a.startsWith("--")) pos.push(a);
    else if (a === "--json") flags.set("json", true);
    else flags.set(a.slice(2), rest[++i] ?? "");
  }
  return { cmd, pos, flags };
}

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(path));
const opt = (a: Args, k: string): string | undefined => {
  const v = a.flags.get(k);
  return typeof v === "string" && v ? v : undefined;
};

/** Flags each command takes. An unknown flag or a value flag without a value is a usage error: a mistyped
 *  `--expect-sha256` must never let `verify` pass without the hash check it was asked for. */
const KNOWN: Record<string, readonly string[]> = {
  verify: ["json", "expect-identity", "expect-sha256"],
  dump: ["json", "second", "package"],
  device: ["json"],
};

function badFlag(a: Args): string | null {
  const known = KNOWN[a.cmd];
  if (!known) return null;
  for (const [k, v] of a.flags) {
    if (!known.includes(k)) return `unknown option --${k} for ${a.cmd}`;
    if (k !== "json" && v === "") return `--${k} needs a value`;
  }
  return null;
}

export function main(argv: string[], out: (s: string) => void = console.log, err: (s: string) => void = console.error): number {
  const a = parseArgs(argv);
  const json = a.flags.has("json");
  const bad = badFlag(a);
  if (bad) {
    err(`firmware-inspect: ${bad}\n${USAGE}`);
    return 2;
  }
  try {
    if (a.cmd === "verify" && a.pos.length === 1) {
      const file = a.pos[0] ?? "";
      const r = verifyPackage(read(file), file, { expectIdentity: opt(a, "expect-identity"), expectSha256: opt(a, "expect-sha256") });
      out(json ? JSON.stringify(r, null, 2) : formatVerify(r));
      return r.ok ? 0 : 1;
    }
    if (a.cmd === "dump" && a.pos.length === 1) {
      const file = a.pos[0] ?? "";
      const second = opt(a, "second");
      const pkg = opt(a, "package");
      const r = analyseDump({ file, data: read(file) }, second ? { file: second, data: read(second) } : undefined,
        pkg ? { file: pkg, data: read(pkg) } : undefined);
      out(json ? JSON.stringify(r, null, 2) : formatDump(r));
      return r.ok ? 0 : 1;
    }
    if (a.cmd === "device" && a.pos.length === 0) {
      const list = readDevices();
      out(json ? JSON.stringify(list, null, 2) : formatDevices(list));
      return 0;
    }
  } catch (e) {
    err(`firmware-inspect: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  err(USAGE);
  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
