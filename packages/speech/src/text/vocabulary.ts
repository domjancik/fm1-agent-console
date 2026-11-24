/**
 * Rule-based technical vocabulary correction. Conservative by design: whole-word/phrase matches only,
 * optional context words that must (or must not) appear in the transcript, and case preservation
 * for all-caps input. Hotwords do not work with the cached Parakeet model (see docs/discovery/voice-midi.md),
 * so this dictionary is the vocabulary fix for every engine.
 */

export interface VocabularyEntry {
  /** Spoken or misrecognized forms, matched case-insensitively on word boundaries. */
  from: string[];
  /** Canonical spelling. */
  to: string;
  /** Apply only if at least one of these words appears elsewhere in the transcript. */
  requireAny?: string[];
  /** Skip if any of these words appears in the transcript. */
  avoidAny?: string[];
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9']+/g) ?? []);
}

function contextAllows(entry: VocabularyEntry, present: Set<string>): boolean {
  const has = (w: string): boolean => w.toLowerCase().split(/\s+/).every((part) => present.has(part));
  if (entry.avoidAny?.some(has)) return false;
  if (entry.requireAny && !entry.requireAny.some(has)) return false;
  return true;
}

function matchCase(source: string, target: string): string {
  const letters = source.replace(/[^A-Za-z]/g, "");
  if (letters.length > 1 && letters === letters.toUpperCase()) return target.toUpperCase();
  return target;
}

export function applyVocabulary(text: string, entries: readonly VocabularyEntry[]): string {
  let out = text;
  for (const entry of entries) {
    if (entry.from.length === 0) continue;
    const present = words(out);
    if (!contextAllows(entry, present)) continue;
    const alternatives = [...entry.from]
      .sort((a, b) => b.length - a.length)
      .map((f) => escapeRegex(f.trim()).replace(/\s+/g, "\\s+"));
    const pattern = new RegExp(`(?<![\\w-])(?:${alternatives.join("|")})(?![\\w-])`, "gi");
    out = out.replace(pattern, (match) => matchCase(match, entry.to));
  }
  return out;
}

export function parseVocabulary(json: unknown): VocabularyEntry[] {
  if (!Array.isArray(json)) throw new Error("vocabulary must be a JSON array");
  const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
  return json.map((raw, i): VocabularyEntry => {
    if (typeof raw !== "object" || raw === null) throw new Error(`vocabulary[${i}] must be an object`);
    const r = raw as Record<string, unknown>;
    if (!isStrings(r.from) || typeof r.to !== "string") {
      throw new Error(`vocabulary[${i}] needs "from": string[] and "to": string`);
    }
    if (r.requireAny !== undefined && !isStrings(r.requireAny)) throw new Error(`vocabulary[${i}].requireAny must be string[]`);
    if (r.avoidAny !== undefined && !isStrings(r.avoidAny)) throw new Error(`vocabulary[${i}].avoidAny must be string[]`);
    return { from: r.from, to: r.to, requireAny: r.requireAny, avoidAny: r.avoidAny };
  });
}
