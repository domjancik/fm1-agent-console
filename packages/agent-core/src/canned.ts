// Canned responses (docs/ui-v3.md section 12): operator-kept prompts offered on the voice review screen after the
// selected chat's suggestions. Pure list helpers; the companion persists the list (config `canned`).
import { asciiText } from "./copy";

export interface CannedEntry {
  id: string;
  text: string;
  uses: number;
  createdAt: number;
  lastUsedAt: number | null;
}

/** At most this many entries; adding beyond is refused (`Canned list full`). */
export const CANNED_MAX = 50;
/** Text longer than this is cut (CLI, ARP save) or refused (config validation). */
export const CANNED_TEXT_MAX = 2000;
/** FX held at least this long on a canned review deletes the entry (released earlier it cancels, as before). */
export const CANNED_DELETE_HOLD_MS = 1000;

/** Written into a config that has no `canned` key yet (first load); never again once the key exists, even empty. */
export const CANNED_SEED: readonly string[] = [
  "Status update? What's done, what's left, and any blockers.",
  "Rebase on main, fix CI, push, and tell me when it's green.",
  "Continue where you stopped.",
];

/** The seed entries: uses 0, createdAt 3, 2, 1 so they keep the listed order (uses desc, then createdAt desc). */
export const seedCanned = (): CannedEntry[] =>
  CANNED_SEED.map((text, i) => ({ id: `seed-${i + 1}`, text, uses: 0, createdAt: CANNED_SEED.length - i, lastUsedAt: null }));

/**
 * ASCII-folded like a transcript on the device (copy.ts asciiText): accents dropped (NFKD), other non-ASCII a space,
 * whitespace runs one space, trimmed, at most CANNED_TEXT_MAX characters.
 */
export function cannedText(raw: string): string {
  const folded = raw.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  return asciiText(folded).slice(0, CANNED_TEXT_MAX).trim();
}

/** Duplicate test: trimmed and case-insensitive, on the folded text. */
export const cannedKey = (text: string): string => cannedText(text).toLowerCase();

/** Display and cycling order: uses desc, then createdAt desc (newest first), then id for a stable tie. */
export function sortCanned(list: readonly CannedEntry[]): CannedEntry[] {
  return [...list].sort((a, b) => b.uses - a.uses || b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The entry with this text (duplicate rule), or undefined. */
export const findCanned = (list: readonly CannedEntry[], text: string): CannedEntry | undefined => {
  const k = cannedKey(text);
  return list.find((e) => cannedKey(e.text) === k);
};

/** A fresh id unique in the list, derived from the time (pure: no randomness). */
export function cannedId(list: readonly CannedEntry[], now: number): string {
  const base = `c${Math.max(0, Math.floor(now)).toString(36)}`;
  const ids = new Set(list.map((e) => e.id));
  if (!ids.has(base)) return base;
  let n = 2;
  while (ids.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export type CannedAdd = { ok: true; list: CannedEntry[]; entry: CannedEntry } | { ok: false; reason: "empty" | "duplicate" | "full" };

/** Adds a text (folded); refuses an empty text, an exact duplicate (trimmed, case-insensitive) or a full list. */
export function addCanned(list: readonly CannedEntry[], raw: string, now: number, id: string = cannedId(list, now)): CannedAdd {
  const text = cannedText(raw);
  if (!text) return { ok: false, reason: "empty" };
  if (findCanned(list, text)) return { ok: false, reason: "duplicate" };
  if (list.length >= CANNED_MAX) return { ok: false, reason: "full" };
  const entry: CannedEntry = { id, text, uses: 0, createdAt: now, lastUsedAt: null };
  return { ok: true, list: sortCanned([...list, entry]), entry };
}

/** A canned text was sent: its uses go up by one and lastUsedAt is now; the list re-sorts. Unknown id: unchanged. */
export function useCanned(list: readonly CannedEntry[], id: string, now: number): CannedEntry[] {
  if (!list.some((e) => e.id === id)) return [...list];
  return sortCanned(list.map((e) => (e.id === id ? { ...e, uses: e.uses + 1, lastUsedAt: now } : e)));
}

export const removeCanned = (list: readonly CannedEntry[], id: string): CannedEntry[] => list.filter((e) => e.id !== id);

/** Puts a deleted entry back (undo): unchanged when its id or text is back already or the list is full. */
export function restoreCanned(list: readonly CannedEntry[], entry: CannedEntry): CannedEntry[] | null {
  if (list.some((e) => e.id === entry.id) || findCanned(list, entry.text) || list.length >= CANNED_MAX) return null;
  return sortCanned([...list, entry]);
}

/** Entries from outside (config, desktop UI) as the console keeps them: well-formed ones only, folded, capped, sorted. */
export function cannedList(raw: unknown): CannedEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: CannedEntry[] = [];
  for (const e of raw) {
    if (typeof e !== "object" || e === null) continue;
    const o = e as Record<string, unknown>;
    const text = typeof o.text === "string" ? cannedText(o.text) : "";
    if (typeof o.id !== "string" || !o.id || !text || out.some((x) => x.id === o.id || cannedKey(x.text) === cannedKey(text))) continue;
    const uses = typeof o.uses === "number" && Number.isFinite(o.uses) && o.uses >= 0 ? Math.floor(o.uses) : 0;
    const createdAt = typeof o.createdAt === "number" && Number.isFinite(o.createdAt) ? o.createdAt : 0;
    const lastUsedAt = typeof o.lastUsedAt === "number" && Number.isFinite(o.lastUsedAt) ? o.lastUsedAt : null;
    out.push({ id: o.id, text, uses, createdAt, lastUsedAt });
    if (out.length >= CANNED_MAX) break;
  }
  return sortCanned(out);
}
