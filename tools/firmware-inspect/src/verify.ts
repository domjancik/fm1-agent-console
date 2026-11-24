// `verify`: parse a .fwsc package, re-compute every embedded checksum and compare, and summarise what
// the installer, the running firmware's updater and the update loader would decide.
import { ascii, hex, indexOf, sha256 } from "./bytes";
import { Checks, type Check } from "./checks";
import { analyseFlash, APP_END, type FlashInfo, jedecConstantsIn } from "./flash";
import { deinterleave, FwscError, parseIdentity } from "./fwsc";
import { analyseLoader, LOADER_MARK, type LoaderInfo } from "./loader";
import { entryData, parseUfw, UFW_TYPE_FLASH, UFW_TYPE_OTA, ufwDamage, type UfwHeader } from "./ufw";

export const EXPECTED_CHIP_KEY = 0x980f;

export interface VerifyOptions {
  expectIdentity?: string;
  expectSha256?: string;
}

export interface VerifyReport {
  tool: string;
  file: string;
  size: number;
  sha256: string;
  identity: string | null;
  interleaveBlocks: number | null;
  logical: { size: number; sha256: string } | null;
  ufw: (Omit<UfwHeader, "entries"> & { entries: (UfwHeader["entries"][number] & { sha256: string | null })[] }) | null;
  loader: Omit<LoaderInfo, "image"> | null;
  flash: (Omit<FlashInfo, "appArea"> & { appArea: Omit<NonNullable<FlashInfo["appArea"]>, "plain"> | null }) | null;
  flashChipClaims: { app: string[]; loader: string[] } | null;
  checks: Check[];
  ok: boolean;
}

function checkUfw(c: Checks, u: UfwHeader, imageLen: number): void {
  c.expect("ufw.header-crc", u.headerCrcOk, "UFW header CRC matches", "UFW header CRC does not match");
  c.expect("ufw.list-crc", u.listCrcOk, `file list CRC matches (${u.count} entries)`, "file list CRC does not match");
  c.expect("ufw.count", u.count >= 1 && u.count <= 8, `${u.count} entries`, `${u.count} entries (the installer accepts 1..8)`);
  c.add("ufw.chip", u.chip === "AC791N" ? "pass" : "warn", `chip field "${u.chip}"`);
  c.add("ufw.total", u.total === imageLen ? "pass" : "info", `header total ${u.total} B, logical image ${imageLen} B`);
  for (const e of u.entries) {
    const id = `ufw.entry.${e.name || e.type}`;
    if (e.actualCrc === null) c.add(id, "fail", `${e.size} B at ${hex(e.offset, 6)} runs past the image`);
    else if (!e.crcChecked) c.add(id, "info", `type ${e.type}, ${e.size} B: CRC not over served bytes (bounds only, as the installer)`);
    else c.expect(id, e.actualCrc === e.storedCrc, `CRC ${hex(e.storedCrc)} matches (${e.size} B)`,
      `stored CRC ${hex(e.storedCrc)}, computed ${hex(e.actualCrc)} (${e.size} B)`);
  }
  c.expect("ufw.flash.bin", u.entries.some((e) => e.type === UFW_TYPE_FLASH), "flash.bin (type 0) present", "no flash.bin (type 0)");
  c.expect("ufw.ota.bin", u.entries.some((e) => e.type === UFW_TYPE_OTA), "ota.bin (type 100) present", "no ota.bin (type 100)");
}

function checkLoader(c: Checks, l: LoaderInfo, raw: Uint8Array): void {
  const marked = indexOf(raw, ascii(LOADER_MARK)) >= 0;
  c.add("installer.loader-mark", marked ? "pass" : "warn",
    marked ? `${LOADER_MARK} present: fm1_install.py accepts it` : `no ${LOADER_MARK}: fm1_install.py refuses it without --force`);
  if (l.kind === "unknown") c.add("loader.kind", "warn", `not a Felucca-family or official loader: ${l.refusal}`);
  else c.expect("loader.updater-accepts", l.acceptedByUpdater, `${l.kind} loader passes the updater's step-2 checks (ota.c ota_stage)`,
    `${l.kind} loader refused by the updater: ${l.refusal}`);
  c.expect("loader.body-crc", l.bodyCrcOk, "loader body CRC matches the outer head", "loader body CRC does not match the outer head");
  if (l.imageCrcOk !== null) c.expect("loader.image-crc", l.imageCrcOk, `LZ4 blocks decode to ${l.imageSize} B with the inner head's CRC`,
    "LZ4 blocks do not decode to the inner head's size and CRC");
  if (l.kind === "felucca") c.add("loader.identity", l.resumable ? "pass" : "warn",
    `update-mode USB identity ${l.usbIdentity ?? "(not found)"}${l.resumable ? " (fm1_install.py resumes it)" : " (fm1_install.py will not resume it)"}`);
}

function checkFlash(c: Checks, f: FlashInfo, felucca: boolean): void {
  c.expect("flash.size", f.length >= APP_END, `flash.bin ${hex(f.length, 5)} B`, `flash.bin ${hex(f.length, 5)} B, shorter than ${hex(APP_END, 5)} (the loader refuses it)`);
  if (f.length > APP_END) c.add("flash.size-extra", "warn", `flash.bin runs to ${hex(f.length, 5)}: the Felucca loader and the unbricker's restore write only up to ${hex(APP_END, 5)}`);
  c.expect("flash.header-crc", f.headerOk, "flash header CRC matches", "flash header CRC does not match");
  for (const h of f.headFiles) {
    const id = `flash.head.${h.name}`;
    if (h.actual === h.stored) c.add(id, "pass", `CRC ${hex(h.stored)} matches (${h.size} B)`);
    else if (f.headKnownAs && h.name === "uboot.boot") // the stock SPL's dcrc is not over its stored bytes (unbricker: unverifiable)
      c.add(id, "info", `stock SPL: stored ${hex(h.stored)} is not a CRC of the stored bytes; the head is identified by sha256 instead`);
    else c.add(id, "fail", `stored ${hex(h.stored)}, computed ${h.actual === null ? "out of bounds" : hex(h.actual)}`);
  }
  if (f.chipKey === null) {
    c.add("flash.chip-key", "fail", "no isd_config.ini chip key in the head");
    return;
  }
  c.add("flash.chip-key", f.chipKey === EXPECTED_CHIP_KEY ? "pass" : "warn", `chip key ${hex(f.chipKey)} (FM-1 units: ${hex(EXPECTED_CHIP_KEY)})`);
  c.add("flash.head-known", "info", f.headKnownAs ?? `head sha256 ${f.headSha256.slice(0, 16)}… (not a known stock head)`);
  if (f.regionSha256) c.add("flash.region-known", "info", f.regionKnownAs ?? `0x4000..0x92FFF sha256 ${f.regionSha256.slice(0, 16)}…`);
  const a = f.appArea;
  if (!a) {
    c.add("flash.app-area", felucca ? "fail" : "warn", "the app area does not decrypt to a valid app_area_head with this chip key");
    return;
  }
  c.expect("flash.app-area", a.areaCrc.actual === a.areaCrc.stored, `${a.head.name} decrypts with ${hex(f.chipKey)}, CRC matches`,
    `${a.head.name} CRC: stored ${hex(a.areaCrc.stored)}, computed ${a.areaCrc.actual === null ? "out of bounds" : hex(a.areaCrc.actual)}`);
  for (const x of a.files) c.expect(`flash.app.${x.name}`, x.actual === x.stored, `CRC ${hex(x.stored)} matches (${x.size} B)`,
    `stored ${hex(x.stored)}, computed ${x.actual === null ? "out of bounds" : hex(x.actual)}`);
  if (a.app) {
    const fits = a.app.size <= APP_END - 0x4120;
    c.add("flash.app-size", fits ? "pass" : felucca ? "fail" : "info",
      `app.bin ${a.app.used} B used of a ${a.app.size} B slot${fits ? "" : ` (past ${hex(APP_END, 5)})`}`);
  }
  if (a.stubMarker) c.add("flash.boot-stub", "info", "ChoralRoot/CoralFlower boot-stub commit marker CRBM at 0x91FE0");
}

const strip = <T extends { image?: unknown; plain?: unknown }>(o: T): Omit<T, "image" | "plain"> => {
  const { image: _i, plain: _p, ...rest } = o;
  return rest;
};

export function verifyPackage(raw: Uint8Array, file: string, opts: VerifyOptions = {}): VerifyReport {
  const c = new Checks();
  const report: VerifyReport = {
    tool: "@fm1/firmware-inspect verify 0.1.0", file, size: raw.length, sha256: sha256(raw), identity: null,
    interleaveBlocks: null, logical: null, ufw: null, loader: null, flash: null, flashChipClaims: null, checks: c.list, ok: false,
  };
  if (opts.expectSha256) c.expect("file.sha256", report.sha256 === opts.expectSha256.toLowerCase(), `sha256 ${report.sha256}`,
    `sha256 ${report.sha256}, expected ${opts.expectSha256}`);
  let d;
  try {
    d = deinterleave(raw);
  } catch (e) {
    c.add("fwsc.size", "fail", e instanceof FwscError ? e.message : String(e));
    return report;
  }
  report.identity = d.identity;
  report.interleaveBlocks = d.blocks;
  report.logical = { size: d.image.length, sha256: sha256(d.image) };
  const id = parseIdentity(d.identity);
  c.expect("fwsc.identity", id !== null, `identity ${d.identity} (${d.blocks} interleave blocks)`, `identity "${d.identity}" is not MODEL_NNN`);
  if (id) c.add("fwsc.model", id.model === "FM-1" ? "pass" : "warn", `model ${id.model}`);
  if (opts.expectIdentity) c.expect("fwsc.expected-identity", d.identity === opts.expectIdentity, `identity is ${opts.expectIdentity}`,
    `identity ${d.identity}, expected ${opts.expectIdentity}`);
  const u = parseUfw(d.image);
  report.ufw = { ...u, entries: u.entries.map((e) => ({ ...e, sha256: e.actualCrc === null ? null : sha256(entryData(d.image, e)) })) };
  checkUfw(c, u, d.image.length);
  const damage = ufwDamage(d.image);
  c.expect("installer.damage", damage === null, "fm1_install.py package_damage(): none", `fm1_install.py package_damage(): ${damage}`);
  const ota = u.entries.find((e) => e.type === UFW_TYPE_OTA && e.actualCrc !== null);
  const loader = ota ? analyseLoader(entryData(d.image, ota)) : null;
  if (loader) {
    report.loader = strip(loader);
    checkLoader(c, loader, raw);
  }
  const fl = u.entries.find((e) => e.type === UFW_TYPE_FLASH && e.actualCrc !== null);
  if (fl) {
    const f = analyseFlash(entryData(d.image, fl));
    report.flash = { ...f, appArea: f.appArea ? strip(f.appArea) : null };
    checkFlash(c, f, loader?.kind === "felucca");
    const appClaims = f.appArea?.jedecConstants ?? [];
    const ldrClaims = loader?.image ? jedecConstantsIn(loader.image) : [];
    report.flashChipClaims = { app: appClaims, loader: ldrClaims };
    if (loader?.kind === "felucca") c.add("flash-chip.claims", appClaims.length === 2 ? "pass" : "warn",
      `JEDEC ID constants (byte-pattern heuristic) in app: ${appClaims.join(", ") || "none"}; in loader: ${ldrClaims.join(", ") || "none (no chip check in this loader)"}`);
  }
  report.ok = c.failed.length === 0;
  return report;
}
