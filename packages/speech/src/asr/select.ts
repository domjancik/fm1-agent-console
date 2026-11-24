import { AppleDictationEngine } from "./apple-engine";
import { AsrError, type AsrEngine } from "./engine";
import { SherpaParakeetEngine, type SherpaEngineOptions } from "./sherpa-engine";

export type EngineId = "sherpa" | "apple";

export function createEngine(id: EngineId, options: SherpaEngineOptions = {}): AsrEngine {
  switch (id) {
    case "sherpa":
      return new SherpaParakeetEngine(options);
    case "apple":
      return new AppleDictationEngine();
  }
}

/** Primary engine for the language, or the fallback when the primary cannot handle it. */
export function engineForLanguage(language: string, primary: AsrEngine, fallback?: AsrEngine): AsrEngine {
  if (primary.supportsLanguage(language)) return primary;
  if (fallback?.supportsLanguage(language)) return fallback;
  throw new AsrError("language_unsupported", `no configured engine supports "${language}"`);
}
