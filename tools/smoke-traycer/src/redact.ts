// Id shortening for shared reports, and a scan that proves no Traycer credential leaked into output files.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const short = (id: string): string => (id.length > 8 ? `${id.slice(0, 8)}…` : id);

/** Credential values (bearer, refresh token) read in memory only, with 32-char slices to catch partial leaks. */
export function secretNeedles(path = join(homedir(), ".traycer", "cli", "credentials")): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const values: string[] = [];
  const walk = (v: unknown, key: string): void => {
    if (typeof v === "string" && /token|secret|refresh|bearer/i.test(key) && v.length >= 16) values.push(v);
    else if (typeof v === "object" && v !== null) for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(raw, "");
  const needles = new Set<string>();
  for (const v of values) {
    needles.add(v);
    for (let i = 0; i + 32 <= v.length; i += 32) needles.add(v.slice(i, i + 32));
  }
  return [...needles];
}

export interface LeakScan {
  files: number;
  hits: { file: string; count: number }[];
  needles: number;
}

/** Scans text files under `roots` for any needle. Reports file names and counts only, never the value. */
export function scanForSecrets(roots: readonly string[], needles: readonly string[], maxBytes = 5_000_000): LeakScan {
  const scan: LeakScan = { files: 0, hits: [], needles: needles.length };
  const visit = (path: string): void => {
    let st;
    try {
      st = statSync(path);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      if (path.endsWith("node_modules") || path.endsWith(".git")) return;
      for (const name of readdirSync(path)) visit(join(path, name));
      return;
    }
    if (!st.isFile() || st.size > maxBytes || /\.(png|jpg|wav|fwsc|bin)$/i.test(path)) return;
    scan.files++;
    const text = readFileSync(path, "utf8");
    const count = needles.reduce((n, needle) => n + (text.includes(needle) ? 1 : 0), 0);
    if (count > 0) scan.hits.push({ file: path, count });
  };
  for (const r of roots) visit(r);
  return scan;
}
