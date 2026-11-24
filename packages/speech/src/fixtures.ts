import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RejectReason } from "./gate";

export const FIXTURE_DIR = fileURLToPath(new URL("../../../fixtures/audio/", import.meta.url));

export interface AudioFixture {
  file: string;
  path: string;
  sampleRate: number;
  spoken: string;
  expected: string;
  mustContain: string[];
  rejected?: RejectReason;
}

interface ExpectedFile {
  fixtures: Array<Omit<AudioFixture, "path" | "mustContain"> & { mustContain?: string[] }>;
}

export async function loadFixtures(expectedPath = join(FIXTURE_DIR, "expected.json")): Promise<AudioFixture[]> {
  const data = (await Bun.file(expectedPath).json()) as ExpectedFile;
  const dir = dirname(expectedPath);
  return data.fixtures.map((f) => ({ ...f, mustContain: f.mustContain ?? [], path: join(dir, f.file) }));
}

/** Lower-case words without punctuation, for accuracy scoring. */
export function normalizeWords(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
}

/** Word error rate: word-level edit distance divided by the reference length. */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = normalizeWords(reference);
  const hyp = normalizeWords(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const row = [i];
    for (let j = 1; j <= hyp.length; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      row.push(Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
    }
    prev = row;
  }
  return (prev[hyp.length] ?? 0) / ref.length;
}
