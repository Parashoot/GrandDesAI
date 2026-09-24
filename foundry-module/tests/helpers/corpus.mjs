// Shared test helper: loads the nlp-scale labeled corpus from disk (Node only). Lives under
// tests/helpers/ so `node --test tests/*.test.mjs` does not pick it up as a test file.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "nlp-scale", "corpus");

export function loadCorpusSync(dir = CORPUS_DIR) {
  const items = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
    items.push(...JSON.parse(readFileSync(join(dir, file), "utf8")));
  }
  return items;
}
