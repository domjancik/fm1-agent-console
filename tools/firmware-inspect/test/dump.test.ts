import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { analyseDump, FLASH_SIZE } from "../src/dump";
import { deinterleave } from "../src/fwsc";
import { entryData, parseUfw } from "../src/ufw";
import { CONSOLE_PKG, exists, HAS_CONSOLE_PKG, load, ROLLBACK } from "./helpers";

if (HAS_CONSOLE_PKG) {
  // A synthetic 1 MiB "dump": the candidate's flash.bin, then erased flash.
  const pkg = load(CONSOLE_PKG);
  const di = deinterleave(pkg);
  const flashBin = entryData(di.image, parseUfw(di.image).entries.find((e) => e.type === 0)!);
  const dump = new Uint8Array(FLASH_SIZE).fill(0xff);
  dump.set(flashBin, 0);

  describe("dump", () => {
    test("a consistent double read of an image equal to the package", () => {
      const r = analyseDump({ file: "a", data: dump }, { file: "b", data: Uint8Array.from(dump) }, { file: "p", data: pkg });
      expect(r.ok).toBe(true);
      expect(r.chipKey).toBe(0x980f);
      expect(r.second?.identical).toBe(true);
      expect(r.package).toMatchObject({ identity: "FM-1_951", headEqual: true, appSectorsDiffer: 0, appSectors: 143 });
      expect(r.stagedLoader).toBe(false);
      expect(r.updateRecord).toBe(false);
    });
    test("two reads that differ fail", () => {
      const b = Uint8Array.from(dump);
      b[0x7a123] = (b[0x7a123] ?? 0) ^ 4;
      const r = analyseDump({ file: "a", data: dump }, { file: "b", data: b });
      expect(r.ok).toBe(false);
      expect(r.second?.firstDiff).toBe(0x7a123);
    });
    test("a short file and a damaged head fail", () => {
      expect(analyseDump({ file: "s", data: dump.subarray(0, 4096) }).ok).toBe(false);
      const h = Uint8Array.from(dump);
      h[4] = (h[4] ?? 0) ^ 1;
      expect(analyseDump({ file: "h", data: h }).checks.find((c) => c.id === "dump.head")?.status).toBe("fail");
    });
    const cf = join(ROLLBACK, "coralflower-0.7.1/coralflower-0.7.1.fwsc");
    test.skipIf(!exists(cf))("compared with CoralFlower 0.7.1, 92 of 143 app sectors differ", () => {
      const r = analyseDump({ file: "a", data: dump }, undefined, { file: cf, data: load(cf) });
      expect(r.package?.identity).toBe("FM-1_930");
      expect(r.package?.headEqual).toBe(true);
      expect(r.package?.appSectorsDiffer).toBe(92);
    });
  });
} else {
  describe.skip("dump (needs ../.fm1-rollback)", () => test("skipped", () => {}));
}
