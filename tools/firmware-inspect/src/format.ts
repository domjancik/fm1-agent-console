// Human-readable output for the CLI.
import { hex } from "./bytes";
import type { Check } from "./checks";
import type { UsbDevice } from "./device";
import type { DumpReport } from "./dump";
import type { VerifyReport } from "./verify";

const TAG: Record<Check["status"], string> = { pass: "PASS", fail: "FAIL", warn: "WARN", info: "INFO" };

export function formatChecks(checks: Check[]): string[] {
  const w = Math.max(...checks.map((c) => c.id.length), 10);
  return checks.map((c) => `  ${TAG[c.status]}  ${c.id.padEnd(w)}  ${c.detail}`);
}

export function formatVerify(r: VerifyReport): string {
  const out = [`${r.file}`, `  size ${r.size} B   sha256 ${r.sha256}`];
  if (r.identity !== null) out.push(`  identity ${r.identity}   interleave blocks ${r.interleaveBlocks}   logical image ${r.logical?.size} B`);
  for (const e of r.ufw?.entries ?? []) out.push(`  ufw ${e.name.padEnd(15)} type ${String(e.type).padStart(3)}  ${String(e.size).padStart(7)} B at ${hex(e.offset, 6)}  sha256 ${e.sha256 ?? "-"}`);
  if (r.loader) out.push(`  loader ${r.loader.kind}, ${r.loader.imageSize} B decompressed, update-mode identity ${r.loader.usbIdentity ?? "-"}`);
  const a = r.flash?.appArea;
  if (r.flash) out.push(`  flash.bin ${hex(r.flash.length, 5)} B, chip key ${r.flash.chipKey === null ? "-" : hex(r.flash.chipKey)}, head ${r.flash.headKnownAs ?? r.flash.headSha256.slice(0, 16) + "…"}`);
  if (a?.app) out.push(`  app.bin ${a.app.used} B used / ${a.app.size} B slot, sha256 (used) ${a.app.usedSha256}`);
  if (a) out.push(`  regions ${a.regions.map((x) => `${x.name}@${hex(x.offset, 5)}+${hex(x.size, 5)}`).join("  ")}`);
  out.push("", ...formatChecks(r.checks), "", r.ok ? "RESULT: OK (no mismatch)" : `RESULT: FAILED (${r.checks.filter((c) => c.status === "fail").length} mismatches)`);
  return out.join("\n");
}

export function formatDump(r: DumpReport): string {
  const out = [`${r.file}`, `  size ${r.size} B   sha256 ${r.sha256}`, `  chip key ${r.chipKey === null ? "-" : hex(r.chipKey)}`];
  if (r.second) out.push(`  second read ${r.second.file}: ${r.second.identical ? "identical" : `differs at ${hex(r.second.firstDiff ?? 0, 6)}`}`);
  if (r.package) out.push(`  vs ${r.package.identity}: ${r.package.appSectorsDiffer}/${r.package.appSectors} app sectors differ, head ${r.package.headEqual ? "equal" : "differs"}`);
  out.push("", ...formatChecks(r.checks), "", r.ok ? "RESULT: OK" : "RESULT: FAILED");
  return out.join("\n");
}

export function formatDevices(list: UsbDevice[]): string {
  if (list.length === 0) return "no FM-1 USB device (VID 0x1209 or 0x4C4A) in the IORegistry";
  return list.map((d) => [
    `${d.name}`,
    `  product "${d.product}"  vendor "${d.vendor}"`,
    `  VID ${hex(d.vendorId ?? 0)}  PID ${hex(d.productId ?? 0)}  bcdDevice ${hex(d.bcdDevice ?? 0)}  location ${hex(d.locationId ?? 0, 8)}  speed ${d.speed === 1 ? "full (12 Mb/s)" : d.speed}`,
    `  macOS accessory authorization: ${d.authorization ?? "-"} (policy: ${d.accessoryPolicy ?? "-"})`,
    `  mode: ${d.mode}`,
  ].join("\n")).join("\n\n");
}
