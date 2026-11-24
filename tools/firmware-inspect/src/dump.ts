// `dump`: analyse a full 1 MiB flash backup (e.g. MvaveFM1Unbricker's full-flash-before.bin), compare it
// with a second read, and with a package. Read-only: works on files, never on the device.
import { crc16, hex, sha256, u16, u32 } from "./bytes";
import { Checks, type Check } from "./checks";
import { analyseFlash, APP_END, HEAD_END } from "./flash";
import { deinterleave } from "./fwsc";
import { parseEntry } from "./jlfs";
import { entryData, parseUfw, UFW_TYPE_FLASH } from "./ufw";

export const FLASH_SIZE = 0x100000;
const OTA_AREA = 0xe0000;
const OTA_RES = 0xe4f00;
const SECTOR = 0x1000;

export interface DumpReport {
  file: string;
  size: number;
  sha256: string;
  chipKey: number | null;
  head: { sha256: string; knownAs: string | null };
  region: { sha256: string | null; knownAs: string | null };
  stagedLoader: boolean;
  updateRecord: boolean;
  bootStubMarker: boolean;
  second: { file: string; sha256: string; identical: boolean; firstDiff: number | null } | null;
  package: { file: string; identity: string; headEqual: boolean; appSectorsDiffer: number; appSectors: number } | null;
  checks: Check[];
  ok: boolean;
}

export interface DumpInput {
  file: string;
  data: Uint8Array;
}

function firstDiff(a: Uint8Array, b: Uint8Array): number | null {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? null : n;
}

function hasUpdateRecord(d: Uint8Array): boolean {
  const r = d.subarray(OTA_RES, OTA_RES + 80);
  return u16(r, 6) === 0x5441 && u16(r, 0) !== 0 && u16(r, 0) === crc16(r.subarray(2, 80));
}

export function analyseDump(dump: DumpInput, second?: DumpInput, pkg?: DumpInput): DumpReport {
  const c = new Checks();
  const d = dump.data;
  c.expect("dump.size", d.length === FLASH_SIZE, `${d.length} B (1 MiB)`, `${d.length} B, expected ${FLASH_SIZE} B`);
  const f = analyseFlash(d);
  c.expect("dump.head", f.headerOk && f.chipKey !== null, `flash header valid, chip key ${hex(f.chipKey ?? 0)}`,
    "flash header or isd_config.ini invalid: the boot head is damaged");
  const staged = parseEntry(d.subarray(OTA_AREA, OTA_AREA + 32), OTA_AREA);
  const report: DumpReport = {
    file: dump.file, size: d.length, sha256: sha256(d), chipKey: f.chipKey,
    head: { sha256: f.headSha256, knownAs: f.headKnownAs },
    region: { sha256: f.regionSha256, knownAs: f.regionKnownAs },
    stagedLoader: staged.headerOk && staged.name === "LOADER.BIN" && u32(d, OTA_AREA + 4) === OTA_AREA,
    updateRecord: hasUpdateRecord(d),
    bootStubMarker: f.appArea?.stubMarker ?? false,
    second: null, package: null, checks: c.list, ok: false,
  };
  c.add("dump.head-known", "info", f.headKnownAs ?? `head sha256 ${f.headSha256} (not a known stock head)`);
  c.add("dump.staged-loader", "info", report.stagedLoader ? "a loader is staged at 0xE0000" : "no loader staged at 0xE0000");
  c.add("dump.update-record", report.updateRecord ? "warn" : "info",
    report.updateRecord ? "an update record is at 0xE4F00 (an update was cut off)" : "no update record at 0xE4F00");
  if (second) {
    const fd = firstDiff(d, second.data);
    report.second = { file: second.file, sha256: sha256(second.data), identical: fd === null, firstDiff: fd };
    c.expect("dump.double-read", fd === null, "the two reads are byte-identical", `the reads differ from ${hex(fd ?? 0, 6)}`);
  }
  if (pkg) {
    const di = deinterleave(pkg.data);
    const fl = parseUfw(di.image).entries.find((e) => e.type === UFW_TYPE_FLASH);
    if (!fl) c.add("dump.package", "fail", "the package has no flash.bin");
    else {
      const flash = entryData(di.image, fl);
      let differ = 0;
      let total = 0;
      for (let s = HEAD_END; s < APP_END; s += SECTOR, total++) {
        const a = d.subarray(s, s + SECTOR);
        const b = flash.subarray(s, s + SECTOR);
        if (firstDiff(a, b) !== null) differ++;
      }
      const headEqual = firstDiff(d.subarray(0, HEAD_END), flash.subarray(0, HEAD_END)) === null;
      report.package = { file: pkg.file, identity: di.identity, headEqual, appSectorsDiffer: differ, appSectors: total };
      c.add("dump.package", "info", `${di.identity}: ${differ}/${total} app sectors differ; boot head ${headEqual ? "equal" : "differs"}`);
    }
  }
  report.ok = c.failed.length === 0;
  return report;
}
