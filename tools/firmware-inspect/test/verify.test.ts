import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { verifyPackage, type VerifyReport } from "../src/verify";
import { agentDeckPackages, CONSOLE_PKG, CONSOLE_SHA256, exists, flip, HAS_CONSOLE_PKG, load, rawOffset, ROLLBACK } from "./helpers";

const failed = (r: VerifyReport): string[] => r.checks.filter((c) => c.status === "fail").map((c) => c.id);
if (HAS_CONSOLE_PKG) {
  const raw = load(CONSOLE_PKG);
  const good = verifyPackage(raw, CONSOLE_PKG, { expectIdentity: "FM-1_951", expectSha256: CONSOLE_SHA256 });

  describe("the archived console package 0.1 (00b00e64)", () => {
    test("passes every check", () => {
      expect(failed(good)).toEqual([]);
      expect(good.ok).toBe(true);
    });
    test("identity, sizes and hashes match reports/firmware-validation.md", () => {
      expect(good.identity).toBe("FM-1_951");
      expect(good.size).toBe(612227);
      const ota = good.ufw?.entries.find((e) => e.name === "ota.bin");
      expect(ota?.size).toBe(9071);
      expect(ota?.sha256).toBe("68bfe16a96615f91ee09c4e9ab9b00f84053abc8db5958dc454ca5e8e5b1112f");
      expect(good.flash?.appArea?.app?.used).toBe(61056);
      expect(good.flash?.appArea?.app?.usedSha256).toBe("5fc058562ccc1f9682210b4de5aefda42d5ba38b9b7189adc37cebc7739a7c63");
    });
    test("the updater, the installer and the loader would accept it", () => {
      expect(good.loader?.kind).toBe("felucca");
      expect(good.loader?.acceptedByUpdater).toBe(true);
      expect(good.loader?.usbIdentity).toBe("ota-FM-1_900");
      expect(good.loader?.resumable).toBe(true);
      expect(good.flash?.chipKey).toBe(0x980f);
      expect(good.flashChipClaims?.app.length).toBe(2);
      expect(good.flashChipClaims?.loader.length).toBe(2);
    });
  });

  describe("deliberately corrupted copies fail", () => {
    const flashOff = good.ufw?.entries.find((e) => e.name === "flash.bin")?.offset ?? 0;
    const otaOff = good.ufw?.entries.find((e) => e.name === "ota.bin")?.offset ?? 0;
    const cases: [string, Uint8Array, string[]][] = [
      ["a byte in the app area", flip(raw, rawOffset(flashOff + 0x4000 + 0x2000)), ["ufw.entry.flash.bin", "installer.damage", "flash.app-area", "flash.app.app.bin"]],
      ["a byte in the boot head SPL", flip(raw, rawOffset(flashOff + 0x200)), ["ufw.entry.flash.bin", "flash.head.uboot.boot"]],
      ["a byte in the loader", flip(raw, rawOffset(otaOff + 0x300)), ["ufw.entry.ota.bin", "loader.body-crc"]],
      ["a byte in the UFW header", flip(raw, 5), ["ufw.header-crc", "installer.damage"]],
      ["a byte in the file list", flip(raw, rawOffset(0x45)), ["ufw.list-crc", "installer.damage"]],
      ["the last byte", flip(raw, raw.length - 1, 0xff), ["ufw.entry.ota.bin"]],
    ];
    for (const [name, data, ids] of cases) {
      test(name, () => {
        const r = verifyPackage(data, name, { expectSha256: CONSOLE_SHA256 });
        expect(r.ok).toBe(false);
        expect(failed(r)).toEqual(expect.arrayContaining(["file.sha256", ...ids]));
      });
    }
    test("a changed identity marker is caught by --expect-identity (markers carry no CRC)", () => {
      const r = verifyPackage(flip(raw, 0x2f + 0x30 * 5), "id", { expectIdentity: "FM-1_951" });
      expect(r.identity).not.toBe("FM-1_951");
      expect(failed(r)).toEqual(["fwsc.expected-identity"]);
    });
    test("a truncated package", () => {
      const r = verifyPackage(raw.subarray(0, 300_000), "cut");
      expect(failed(r)).toEqual(expect.arrayContaining(["ufw.entry.flash.bin", "ufw.entry.ota.bin", "installer.damage"]));
      expect(verifyPackage(raw.subarray(0, 500), "tiny").checks.map((c) => c.id)).toEqual(["fwsc.size"]);
    });
  });
} else {
  describe.skip("the archived console package 0.1 (needs ../.fm1-rollback)", () => test("skipped", () => {}));
}

describe("Agent Deck dist packages", () => {
  const pkgs = agentDeckPackages();
  test.skipIf(pkgs.length === 0)("all pass, with a Felucca loader and both flash chips", () => {
    for (const p of pkgs) {
      const r = verifyPackage(load(p), p);
      expect({ p, failed: failed(r) }).toEqual({ p, failed: [] });
      expect(r.loader?.kind).toBe("felucca");
      expect(r.flashChipClaims?.app.length).toBe(2);
    }
  });
});

describe("rollback images in ../.fm1-rollback", () => {
  const cf = join(ROLLBACK, "coralflower-0.7.1/coralflower-0.7.1.fwsc");
  const v15 = join(ROLLBACK, "stock-mvave/V15-FM-1.fwsc");
  const v16 = join(ROLLBACK, "stock-mvave/V16-FM-1.fwsc");
  test.skipIf(!exists(cf))("CoralFlower 0.7.1 release package", () => {
    const r = verifyPackage(load(cf), cf, { expectIdentity: "FM-1_930",
      expectSha256: "d87d6327e0f98000cfa740bab70487728de85d3d64fd96c3a65dfd6bbdf71bbd" });
    expect(failed(r)).toEqual([]);
    expect(r.flash?.appArea?.stubMarker).toBe(true);
    expect(r.loader?.usbIdentity).toBe("ota-FM-1_900");
  });
  test.skipIf(!exists(v15))("official V15 (hash pinned by MvaveFM1Unbricker)", () => {
    const r = verifyPackage(load(v15), v15, { expectIdentity: "FM-1_015",
      expectSha256: "db1642b2b6fa5c2cccb11ffd13878068bb28601678d3644049f99dc40e7edb8a" });
    expect(failed(r)).toEqual([]);
    expect(r.loader?.kind).toBe("official");
    expect(r.flash?.headKnownAs).toBe("stock M-VAVE V15 boot head");
    expect(r.flash?.regionKnownAs).toBe("official M-VAVE V15 firmware region");
  });
  test.skipIf(!exists(v16))("official V16 runs past 0x93000", () => {
    const r = verifyPackage(load(v16), v16, { expectSha256: "d017fb65e70aca97ee29d944470c3515a74581df5c0576bf70de917c7b2b61d5" });
    expect(failed(r)).toEqual([]);
    expect(r.checks.find((c) => c.id === "flash.size-extra")?.status).toBe("warn");
  });
});
