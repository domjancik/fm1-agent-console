// The TS port must agree with the installer itself (firmware/tools/fm1_install.py) on identity and damage.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deinterleave } from "../src/fwsc";
import { ufwDamage } from "../src/ufw";
import { agentDeckPackages, CONSOLE_PKG, flip, HAS_CONSOLE_PKG, load, rawOffset, REPO } from "./helpers";

const py = spawnSync("python3", ["-c", "print(1)"]).status === 0;
const SCRIPT = `import sys
sys.path.insert(0, sys.argv[1])
import fm1_install as f
for p in sys.argv[2:]:
    raw = open(p, "rb").read()
    img, _ = f.deinterleave(raw)
    print(f.product_of(raw) + "\\t" + str(f.package_damage(img)))`;

describe("agreement with fm1_install.py", () => {
  test.skipIf(!py || !HAS_CONSOLE_PKG)("identity and package_damage on good and corrupted packages", () => {
    const dir = mkdtempSync(join(tmpdir(), "fwsc-x-"));
    const raw = load(CONSOLE_PKG);
    const files = [CONSOLE_PKG, ...agentDeckPackages().slice(0, 3)];
    const variants: [string, Uint8Array][] = [
      ["app", flip(raw, rawOffset(0x400 + 0x6000))], ["hdr", flip(raw, 3)], ["list", flip(raw, rawOffset(0x60))],
      ["id", flip(raw, 0x2f + 0x30 * 7)], ["ota", flip(raw, raw.length - 10)],
    ];
    for (const [n, d] of variants) {
      const p = join(dir, `${n}.fwsc`);
      writeFileSync(p, d);
      files.push(p);
    }
    const r = spawnSync("python3", ["-I", "-c", SCRIPT, join(REPO, "firmware/tools"), ...files], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split("\n");
    files.forEach((p, i) => {
      const d = deinterleave(load(p));
      expect(`${d.identity}\t${ufwDamage(d.image) ?? "None"}`).toBe(lines[i] ?? "");
    });
  });
});
