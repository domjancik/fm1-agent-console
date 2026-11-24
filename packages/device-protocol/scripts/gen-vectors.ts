import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildVectorFile } from "../src/vectors";

export const VECTORS_PATH = resolve(import.meta.dir, "../../../fixtures/device/vectors.json");

/** One vector per line keeps diffs readable and the file easy to parse from C tooling. */
export function renderVectorFile(): string {
  const file = buildVectorFile();
  const rows = (items: readonly object[]): string =>
    items.map((item) => `    ${JSON.stringify(item)}`).join(",\n");
  return [
    "{",
    `  "protocol": ${file.protocol},`,
    `  "generatedBy": ${JSON.stringify(file.generatedBy)},`,
    `  "checksum": ${JSON.stringify(file.checksum)},`,
    `  "valid": [\n${rows(file.valid)}\n  ],`,
    `  "invalid": [\n${rows(file.invalid)}\n  ],`,
    `  "negotiation": [\n${rows(file.negotiation)}\n  ]`,
    "}",
    "",
  ].join("\n");
}

if (import.meta.main) {
  mkdirSync(dirname(VECTORS_PATH), { recursive: true });
  writeFileSync(VECTORS_PATH, renderVectorFile());
  const file = buildVectorFile();
  console.log(`wrote ${file.valid.length} valid + ${file.invalid.length} invalid vectors to ${VECTORS_PATH}`);
}
