import defaults from "./vocabulary.default.json";
import { parseVocabulary, type VocabularyEntry } from "./vocabulary";

export const DEFAULT_VOCABULARY: readonly VocabularyEntry[] = parseVocabulary(defaults);

/** Loads a vocabulary JSON file; `FM1_VOCAB_PATH` overrides the bundled default. */
export async function loadVocabulary(path = process.env.FM1_VOCAB_PATH): Promise<readonly VocabularyEntry[]> {
  if (!path) return DEFAULT_VOCABULARY;
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`vocabulary file not found: ${path}`);
  return parseVocabulary(await file.json());
}
