import assert from "node:assert/strict";
import test from "node:test";

import { GROWTH_TAXONOMY } from "../scripts/growth-taxonomy.js";
import {
  consistency,
  diagnosticsStats,
  filterCorpus,
  loadCorpusFromArrays,
  percentile,
  predictedThemes,
  renderMarkdown,
  scoreItem,
  scoreRep,
  scoreRun,
  themeMatches
} from "../tools/nlp-scale/lib.mjs";
import { buildCorpusIndex, createRng, createSimModel, goldEvents, matchCorpusItem } from "../tools/nlp-scale/sim-model.js";
import { bundle } from "../tools/nlp-scale/build-browser.mjs";
import { loadCorpusSync } from "./helpers/corpus.mjs";

// The corpus is test DATA with its own invariants (gold must be defensible and machine-checkable),
// and the harness is code whose numbers will pick the default model -- both get tests.

const corpus = loadCorpusSync();
const CANONICAL = new Set(GROWTH_TAXONOMY.map(([tag]) => tag));

// ---- corpus invariants ---------------------------------------------------------------------------

test("corpus: >= 320 items with unique ids and the required fields", () => {
  assert.ok(corpus.length >= 320);
  assert.equal(new Set(corpus.map((item) => item.id)).size, corpus.length);
  for (const item of corpus) {
    assert.ok(typeof item.id === "string" && item.id, JSON.stringify(item));
    assert.ok(typeof item.category === "string" && item.category, item.id);
    assert.ok(typeof item.lang === "string" && item.lang, item.id);
    assert.ok(typeof item.notes === "string" && item.notes.trim().length >= 10, item.id);
    assert.ok(Array.isArray(item.gold?.mustTags) && Array.isArray(item.gold?.okTags), item.id);
  }
});

test("corpus: every gold tag (including a|b alternatives and forbidTags) is canonical", () => {
  for (const item of corpus) {
    const tags = [...item.gold.mustTags.flatMap((t) => t.split("|")), ...item.gold.okTags, ...(item.gold.forbidTags ?? [])];
    for (const tag of tags) assert.ok(CANONICAL.has(tag), `${item.id}: ${tag}`);
  }
});

test("corpus: gold enums are valid (outcome, dangerGap alternatives)", () => {
  const outcomes = new Set(["criticalSuccess", "success", "failure", "criticalFailure"]);
  for (const item of corpus) {
    if (item.gold.outcome) for (const o of item.gold.outcome.split("|")) assert.ok(outcomes.has(o), `${item.id}: ${o}`);
    if (item.gold.dangerGap) for (const d of item.gold.dangerGap.split("|")) assert.ok(["moderate", "severe", "none"].includes(d), `${item.id}: ${d}`);
  }
});

test("corpus: event bounds are consistent and noEvents traps carry no mustTags", () => {
  for (const item of corpus) {
    const { minEvents, maxEvents, noEvents, mustTags } = item.gold;
    if (minEvents !== undefined && maxEvents !== undefined) assert.ok(minEvents <= maxEvents, item.id);
    if (noEvents) assert.equal(mustTags.length, 0, item.id);
  }
});

const MINIMUMS = {
  "fluent-en": 20, "non-native-en": 20, "typos-phonetic": 20, "texting-shorthand": 20, "bullets-fragments": 20, "dice-jargon": 20,
  "non-english": 40, "code-switching": 20, "long-multiscene": 15, "novel-activities": 40, traps: 30, "red-polarity-worthy": 8, "counter-leveling": 15
};
for (const [category, minimum] of Object.entries(MINIMUMS)) {
  test(`corpus: category ${category} has >= ${minimum} items`, () => {
    const count = corpus.filter((item) => item.category === category).length;
    assert.ok(count >= minimum, `${category}: ${count}`);
  });
}

test("corpus: non-english covers es, pt, el, de, fr, tl, it, ja-romaji, pl, tr", () => {
  const langs = new Set(corpus.filter((item) => item.category === "non-english").map((item) => item.lang));
  for (const lang of ["es", "pt", "el", "de", "fr", "tl", "it", "ja-Latn", "pl", "tr"]) assert.ok(langs.has(lang), lang);
});

test("corpus: non-native English covers seven L1 patterns", () => {
  const l1 = new Set(corpus.filter((item) => item.category === "non-native-en").map((item) => item.l1));
  for (const lang of ["es", "el", "tl", "zh", "ru", "ar", "hi"]) assert.ok(l1.has(lang), lang);
});

test("corpus: long multi-scene recaps are 150-400 words", () => {
  for (const item of corpus.filter((entry) => entry.category === "long-multiscene")) {
    const words = item.notes.split(/\s+/).length;
    assert.ok(words >= 150 && words <= 400, `${item.id}: ${words} words`);
  }
});

test("corpus: novel activities name plausible themes; counter-leveling items carry dangerGap; traps are traps", () => {
  for (const item of corpus.filter((entry) => entry.category === "novel-activities")) assert.ok(item.gold.themesAny?.length >= 1, item.id);
  for (const item of corpus.filter((entry) => entry.category === "counter-leveling")) assert.ok(item.gold.dangerGap, item.id);
  for (const item of corpus.filter((entry) => entry.category === "traps")) assert.ok(item.gold.noEvents || item.gold.maxEvents !== undefined, item.id);
  for (const item of corpus.filter((entry) => entry.category === "red-polarity-worthy")) assert.equal(item.gold.redWorthy, true, item.id);
});

// ---- scoring ---------------------------------------------------------------------------------------

const item = (gold, extra = {}) => ({ id: "x", category: "c", lang: "en", notes: "n", gold: { mustTags: [], okTags: [], ...gold }, ...extra });
const rep = (events, extra = {}) => ({ events, proposals: [], themes: [], ...extra });

test("scoreRep: recall honors a|b alternatives; precision counts must+ok tags", () => {
  const s = scoreRep(item({ mustTags: ["martial|defense", "medicine"], okTags: ["support"] }), rep([{ tags: ["defense", "support", "lore"], outcome: "success" }]));
  assert.equal(s.recall, 0.5);
  assert.ok(Math.abs(s.precision - 2 / 3) < 1e-9);
  assert.ok(s.f1 > 0 && s.f1 < 1);
});

test("scoreRep: outcome and dangerGap alternatives; dangerGap none means absent", () => {
  assert.equal(scoreRep(item({ outcome: "success|criticalSuccess" }), rep([{ tags: [], outcome: "criticalSuccess" }])).outcomeOk, true);
  assert.equal(scoreRep(item({ dangerGap: "severe|moderate" }), rep([{ tags: [], outcome: "success", dangerGap: "moderate" }])).dangerOk, true);
  assert.equal(scoreRep(item({ dangerGap: "none" }), rep([{ tags: [], outcome: "success", dangerGap: "moderate" }])).dangerOk, false);
  assert.equal(scoreRep(item({ dangerGap: "none" }), rep([{ tags: [], outcome: "success" }])).dangerOk, true);
});

test("scoreRep: traps pass only with zero events; forbidTags and counts are checked", () => {
  assert.equal(scoreRep(item({ noEvents: true }), rep([])).trapOk, true);
  assert.equal(scoreRep(item({ noEvents: true }), rep([{ tags: ["stealth"], outcome: "success" }])).trapOk, false);
  assert.equal(scoreRep(item({ forbidTags: ["fire"] }), rep([{ tags: ["fire"], outcome: "success" }])).forbidOk, false);
  assert.equal(scoreRep(item({ minEvents: 2, maxEvents: 3 }), rep([{ tags: [], outcome: "success" }])).countOk, false);
});

test("scoreRep: a failed rep scores 0", () => {
  assert.equal(scoreRep(item({ mustTags: ["martial"] }), { error: { name: "X" }, events: [] }).score, 0);
});

test("themeMatches: slug, substring and stem matches; unrelated words do not match", () => {
  assert.equal(themeMatches(["beekeeping"], ["apiculture", "beekeeping"]), true);
  assert.equal(themeMatches(["bee-keeping"], ["beekeeping"]), true);
  assert.equal(themeMatches(["brewer"], ["brewing"]), true);
  assert.equal(themeMatches(["card-games"], ["gambling", "cards"]), true);
  assert.equal(themeMatches(["cartographer"], ["cartography"]), true);
  assert.equal(themeMatches(["fishing"], ["beekeeping", "honey"]), false);
  assert.equal(themeMatches([], ["beekeeping"]), false);
});

test("predictedThemes collects event themes, result themes (objects) and proposal metadata themes", () => {
  const themes = predictedThemes({ events: [{ themes: ["a-theme"] }], themes: [{ slug: "b-theme" }], proposals: [{ entry: { metadata: { themes: ["c-theme"] } }, theme: "d-theme" }] });
  assert.deepEqual(themes.sort(), ["a-theme", "b-theme", "c-theme", "d-theme"]);
});

test("consistency: Jaccard, modal outcome agreement and count stdev across reps", () => {
  const c = consistency([
    rep([{ tags: ["martial"], outcome: "success" }]),
    rep([{ tags: ["martial", "defense"], outcome: "success" }]),
    rep([{ tags: ["martial"], outcome: "failure" }, { tags: [], outcome: "failure" }])
  ]);
  assert.ok(Math.abs(c.tagJaccard - (0.5 + 1 + 0.5) / 3) < 1e-9);
  assert.ok(Math.abs(c.outcomeAgreement - 2 / 3) < 1e-9);
  assert.ok(c.eventCountStdev > 0);
});

test("percentile and diagnosticsStats", () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 95), 5);
  assert.equal(percentile([], 50), null);
  const d = diagnosticsStats({ diagnostics: { stages: [{ attempts: 1, repairs: ["a"], errors: [], ms: 10 }, { attempts: 3, repairs: [], errors: ["e"], ms: 30 }] } });
  assert.deepEqual({ calls: d.calls, firstTryValid: d.firstTryValid, repairTurns: d.repairTurns, jsonRepairs: d.jsonRepairs }, { calls: 4, firstTryValid: 1, repairTurns: 2, jsonRepairs: 1 });
});

test("scoreRun aggregates per category and language; renderMarkdown has every section", () => {
  const a = scoreItem(item({ mustTags: ["martial"] }, { id: "a", category: "fluent-en" }), { reps: [rep([{ tags: ["martial"], outcome: "success" }])] });
  const b = scoreItem(item({ noEvents: true }, { id: "b", category: "traps", lang: "es" }), { reps: [rep([{ tags: ["x"], outcome: "success" }])] });
  const summary = scoreRun([a, b]);
  assert.deepEqual(Object.keys(summary.byCategory), ["fluent-en", "traps"]);
  assert.deepEqual(Object.keys(summary.byLang), ["en", "es"]);
  assert.equal(summary.worst[0], "b");
  const md = renderMarkdown({ model: "m", provider: "p", scored: [a, b], summary, done: 2, total: 2, reps: 1 });
  for (const heading of ["## Overall", "## By category", "## By language", "## Worst 15 items", "## Metric definitions"]) assert.ok(md.includes(heading), heading);
});

test("filterCorpus by category prefix, language, ids, limit and offset", () => {
  assert.ok(filterCorpus(corpus, { filter: "non-" }).every((entry) => entry.category.startsWith("non-")));
  assert.ok(filterCorpus(corpus, { lang: "el" }).length >= 5);
  assert.deepEqual(filterCorpus(corpus, { ids: "fl-001,tr-002" }).map((entry) => entry.id).sort(), ["fl-001", "tr-002"]);
  assert.equal(filterCorpus(corpus, { limit: 7, offset: 3 }).length, 7);
});

test("loadCorpusFromArrays rejects duplicate ids", () => {
  assert.throws(() => loadCorpusFromArrays([{ id: "a" }], [{ id: "a" }]), /Duplicate/);
});

// ---- sim model -------------------------------------------------------------------------------------

test("sim: the seeded PRNG is deterministic", () => {
  const a = createRng(42);
  const b = createRng(42);
  for (let i = 0; i < 50; i += 1) assert.equal(a.next(), b.next());
});

test("sim: every corpus item is recognised from its own notes (fingerprint match)", () => {
  const index = buildCorpusIndex(corpus);
  const misses = corpus.filter((entry) => matchCorpusItem(index, `NOTES:\n<<<\n${entry.notes}\n>>>`)?.item.id !== entry.id).map((entry) => entry.id);
  assert.ok(misses.length <= 3, `unrecognised: ${misses.join(", ")}`);
});

test("sim: goldEvents satisfy their own gold (a self-consistency check of the labels)", () => {
  for (const entry of corpus) {
    const s = scoreRep(entry, rep(goldEvents(entry)));
    assert.equal(s.score, 1, `${entry.id}: ${JSON.stringify(s)}`);
  }
});

test("sim: answers /api/tags and /v1/models, 404s unknown paths", async () => {
  const sim = createSimModel({});
  assert.ok((await (await sim.fetch("http://x/api/tags")).json()).models.length);
  assert.ok((await (await sim.fetch("http://x/v1/models")).json()).data.length);
  assert.equal((await sim.fetch("http://x/nope")).status, 404);
});

// ---- browser bundle ----------------------------------------------------------------------------

test("browser bundle builds, installs window.NlpScale and runs same-origin against the sim", async () => {
  const { code, corpusItems } = bundle();
  assert.equal(corpusItems, corpus.length);
  const sim = createSimModel({ corpus, seed: 2, faultRate: 0 });
  const urls = [];
  const fakeWindow = { location: { origin: "http://localhost:11434" }, fetch: (url, init) => { urls.push(String(url)); return sim.fetch(new URL(String(url), "http://localhost:11434").href, init); } };
  new Function("window", code)(fakeWindow);
  const api = fakeWindow.NlpScale;
  assert.equal(api.corpus.length, corpus.length);
  const progress = [];
  const state = await api.runScale({ model: "sim", ids: "fl-001,nv-001,tr-002", reps: 2 }, (line) => progress.push(line));
  assert.equal(state.status, "done");
  assert.equal(progress.length, 3);
  assert.ok(urls.length && urls.every((url) => url === "/api/chat"));
  assert.equal(api.lastRun, state);
  assert.equal(api.brief().done, 3);
  assert.equal(api.brief().overall.score, 1);
});

test("browser bundle: startScale is fire-and-forget and abort() stops a run early", async () => {
  const { code } = bundle();
  const sim = createSimModel({ corpus, seed: 2, faultRate: 0, latencyMs: 2 });
  const fakeWindow = { location: { origin: "http://localhost:11434" }, fetch: (url, init) => sim.fetch(new URL(String(url), "http://localhost:11434").href, init) };
  new Function("window", code)(fakeWindow);
  const api = fakeWindow.NlpScale;
  const started = api.startScale({ model: "sim", limit: 40 });
  assert.equal(started.started, true);
  assert.equal(started.total, 40);
  await new Promise((resolve) => setTimeout(resolve, 30));
  api.abort();
  for (let i = 0; i < 100 && api.lastRun.status === "running"; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(api.lastRun.status, "aborted");
  assert.ok(api.lastRun.done < 40);
  assert.ok(api.exportJson().length > 100);
});
