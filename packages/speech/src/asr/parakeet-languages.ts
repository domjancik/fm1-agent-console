import { baseLanguage } from "./engine";

/** The 25 European languages Parakeet TDT 0.6B v3 was trained on. It detects the language itself. */
export const PARAKEET_V3_LANGUAGES: ReadonlySet<string> = new Set([
  "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it",
  "lv", "lt", "mt", "pl", "pt", "ro", "sk", "sl", "es", "sv", "ru", "uk",
]);

export function parakeetSupports(language: string): boolean {
  return PARAKEET_V3_LANGUAGES.has(baseLanguage(language));
}
