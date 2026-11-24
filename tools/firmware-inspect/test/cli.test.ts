import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import { CONSOLE_PKG, CONSOLE_SHA256, flip, HAS_CONSOLE_PKG, load, rawOffset } from "./helpers";

const run = (args: string[]): { code: number; out: string; err: string } => {
  let out = "";
  let err = "";
  const code = main(args, (s) => (out += s), (s) => (err += s));
  return { code, out, err };
};

describe("cli", () => {
  test.skipIf(!HAS_CONSOLE_PKG)("verify: exit 0 and RESULT OK on the candidate", () => {
    const r = run(["verify", CONSOLE_PKG, "--expect-identity", "FM-1_951", "--expect-sha256", CONSOLE_SHA256]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("RESULT: OK");
  });
  test.skipIf(!HAS_CONSOLE_PKG)("verify --json is parseable and carries the checks", () => {
    const r = run(["verify", CONSOLE_PKG, "--json"]);
    const j = JSON.parse(r.out) as { ok: boolean; identity: string; checks: unknown[] };
    expect(j.ok).toBe(true);
    expect(j.identity).toBe("FM-1_951");
    expect(j.checks.length).toBeGreaterThan(20);
  });
  test.skipIf(!HAS_CONSOLE_PKG)("verify: exit 1 on a corrupted copy written to disk", () => {
    const p = join(mkdtempSync(join(tmpdir(), "fwsc-bad-")), "corrupted.fwsc");
    writeFileSync(p, flip(load(CONSOLE_PKG), rawOffset(0x400 + 0x9000), 0x80));
    const r = run(["verify", p]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL  ufw.entry.flash.bin");
    expect(r.out).toContain("RESULT: FAILED");
  });
  test("exit 2 on usage errors and unreadable files", () => {
    expect(run([]).code).toBe(2);
    expect(run(["verify"]).code).toBe(2);
    const r = run(["verify", "/nonexistent/x.fwsc"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("ENOENT");
    expect(run(["flash", CONSOLE_PKG]).err).toContain("usage");
  });
  test.skipIf(!HAS_CONSOLE_PKG)("exit 2, never a silent pass, on a mistyped or empty check option", () => {
    const typo = run(["verify", CONSOLE_PKG, "--expect-sha", "00"]);
    expect(typo.code).toBe(2);
    expect(typo.err).toContain("unknown option --expect-sha");
    const empty = run(["verify", CONSOLE_PKG, "--expect-sha256"]);
    expect(empty.code).toBe(2);
    expect(empty.err).toContain("--expect-sha256 needs a value");
    expect(run(["verify", CONSOLE_PKG, "--expect-sha256", "00"]).code).toBe(1);
    expect(run(["dump", CONSOLE_PKG, "--expect-identity", "FM-1_951"]).code).toBe(2);
  });
});
