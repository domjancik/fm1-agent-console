import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const REPO = resolve(import.meta.dir, "../../..");
export const AGENT_DECK_DIST = resolve(REPO, "../.fm1-upstream/fm-1-agent-deck/dist");
export const ROLLBACK = resolve(REPO, "../.fm1-rollback");
/** The first console package (0.1 USB, first flashed 2026-11-18), archived unchanged. firmware/dist/ is rebuilt
 * with every firmware change, so the pinned sizes and hashes below refer to this copy. */
export const CONSOLE_PKG = join(ROLLBACK, "console/fm1-console-0.1-usb-00b00e64.fwsc");
export const CONSOLE_SHA256 = "00b00e64ae33da81869ce824d8d60bdace8a90c1620390d5b617c14e4c8b3eaf";
/** The archive lives outside the repository (this machine only): suites that read it are skipped without it. */
export const HAS_CONSOLE_PKG = existsSync(CONSOLE_PKG);

export const load = (p: string): Uint8Array => new Uint8Array(readFileSync(p));
export const exists = (p: string): boolean => existsSync(p);
export const agentDeckPackages = (): string[] =>
  existsSync(AGENT_DECK_DIST) ? readdirSync(AGENT_DECK_DIST).filter((f) => f.endsWith(".fwsc")).map((f) => join(AGENT_DECK_DIST, f)) : [];

/** A copy with one byte XOR-ed at a raw .fwsc offset. */
export function flip(raw: Uint8Array, at: number, mask = 0x01): Uint8Array {
  const c = Uint8Array.from(raw);
  c[at] = (c[at] ?? 0) ^ mask;
  return c;
}

/** raw .fwsc offset of logical-image offset `l` (20 interleave blocks of 0x2F data + 1 marker). */
export const rawOffset = (l: number): number => (l < 20 * 0x2f ? Math.floor(l / 0x2f) * 0x30 + (l % 0x2f) : l + 20);
