import { applySpokenPunctuation } from "./text/punctuation";
import { applyVocabulary, type VocabularyEntry } from "./text/vocabulary";
import { DEFAULT_VOCABULARY } from "./text/vocabulary-config";

export { gate, measure, DEFAULT_GATE, type GateOptions, type GateResult, type RejectReason, type AudioStats } from "./gate";
export { applySpokenPunctuation } from "./text/punctuation";
export { applyVocabulary, parseVocabulary, type VocabularyEntry } from "./text/vocabulary";
export { DEFAULT_VOCABULARY, loadVocabulary } from "./text/vocabulary-config";

export interface PostprocessOptions {
  vocabulary?: readonly VocabularyEntry[];
  spokenPunctuation?: boolean;
}

/** Deterministic transcript clean-up: spoken punctuation, then vocabulary correction. */
export function postprocess(raw: string, options: PostprocessOptions = {}): string {
  const punctuated = options.spokenPunctuation === false ? raw.trim() : applySpokenPunctuation(raw);
  return applyVocabulary(punctuated, options.vocabulary ?? DEFAULT_VOCABULARY);
}
