import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL_TAGS,
  TAG_SYNONYMS,
  coerceDangerGap,
  coerceEvent,
  coerceOutcome,
  eventDedupeKey,
  resolveTag,
  slugifyTheme
} from "../scripts/ai/normalize.js";
import { GROWTH_TAXONOMY } from "../scripts/growth-taxonomy.js";
import { validateGrowthEvent } from "../scripts/progression.js";

// The coercion layer is where "the model said something reasonable in the wrong words" becomes
// either a usable event or a silently-lost one. Every table below is a word a real model (or a real
// GM, via custom synonyms) has produced; each row is its own test so a regression names the exact
// word that stopped resolving.

test("CANONICAL_TAGS mirrors GROWTH_TAXONOMY exactly, in order", () => {
  assert.deepEqual(CANONICAL_TAGS, GROWTH_TAXONOMY.map(([tag]) => tag));
});

test("TAG_SYNONYMS is large (>= 250) and every value is a canonical tag", () => {
  const entries = Object.entries(TAG_SYNONYMS);
  assert.ok(entries.length >= 250, `only ${entries.length} synonyms`);
  const canonical = new Set(CANONICAL_TAGS);
  for (const [key, value] of entries) assert.ok(canonical.has(value), `${key} -> ${value} is not canonical`);
});

test("every canonical tag resolves to itself via exact", () => {
  for (const tag of CANONICAL_TAGS) assert.deepEqual(resolveTag(tag), { tag, via: "exact" });
});

const TAG_CASES = [
  // [raw, expected canonical tag, expected via (optional)]
  ["Martial", "martial", "case"],
  [" STEALTH ", "stealth", "case"],
  ["melee", "martial", "synonym"],
  ["defensive", "defense", "synonym"],
  ["healing", "medicine", "synonym"],
  ["lockpicking", "thievery", "synonym"],
  ["sneaking", "stealth", "synonym"],
  ["Persuasion", "diplomacy", "synonym"],
  ["combat", "martial", "synonym"],
  ["magic", "spellcasting", "synonym"],
  ["teamwork", "support", "synonym"],
  ["athletic", "athletics"],
  ["stealthy", "stealth"],
  ["alchemical", "alchemy"],
  ["Athletics (DC 15)", "athletics"],
  ["#stealth", "stealth"],
  ["tag: stealth", "stealth"],
  ["melee combat", "martial"],
  ["sneaky stuff", "stealth"],
  ["stelth", "stealth", "fuzzy"],
  ["ahtletics", "athletics", "fuzzy"],
  ["acrobatcs", "acrobatics", "fuzzy"],
  ["μάχη", "martial"],
  ["sigilo", "stealth"],
  ["kochen", "craft"],
  ["ryouri", "craft"]
];
for (const [raw, tag, via] of TAG_CASES) {
  test(`resolveTag(${JSON.stringify(raw)}) -> ${tag}`, () => {
    const result = resolveTag(raw);
    assert.equal(result?.tag, tag, JSON.stringify(result));
    if (via) assert.equal(result.via, via);
  });
}

const THEME_CASES = [
  ["beekeeping", "beekeeping"],
  ["Bee-keeping!", "beekeeping"],
  ["gambling", "gambling"],
  ["cartography", "cartography"],
  ["banana", "banana"]
];
for (const [raw, theme] of THEME_CASES) {
  test(`resolveTag(${JSON.stringify(raw)}) is an emergent theme "${theme}", never dropped`, () => {
    assert.deepEqual(resolveTag(raw), { theme, via: "emergent" });
  });
}

test("a distinctive activity that maps to a tag keeps its theme as alsoTheme (cooking -> craft + cooking)", () => {
  const result = resolveTag("cooking");
  assert.equal(result.tag, "craft");
  assert.equal(result.alsoTheme, "cooking");
  assert.equal(resolveTag("poetry").alsoTheme, "poetry");
});

test("fuzzy matching does not collide gambling with tumbling or poetry with pottery", () => {
  assert.equal(resolveTag("gambling").tag, undefined);
  assert.notEqual(resolveTag("poetry").alsoTheme, "pottery");
});

test("noise words resolve to null rather than to a junk theme", () => {
  for (const raw of ["none", "other", "", "   ", null, undefined]) assert.equal(resolveTag(raw), null, JSON.stringify(raw));
});

test("custom GM synonyms map an unknown word onto a canonical tag", () => {
  assert.deepEqual(resolveTag("hearthcraft", { customSynonyms: { hearthcraft: "craft" } }), { tag: "craft", via: "custom-synonym" });
});

test("custom GM synonyms win over built-in synonyms and may point at a theme", () => {
  assert.deepEqual(resolveTag("cooking", { customSynonyms: { cooking: "Hearth Craft" } }), { theme: "hearthcraft", via: "custom-synonym" });
});

test("custom synonym keys are slug-matched (case, punctuation)", () => {
  assert.equal(resolveTag("Pie Making!", { customSynonyms: { "pie-making": "craft" } })?.tag, "craft");
});

test("garbage customSynonyms never throw", () => {
  for (const customSynonyms of [null, 42, "x", [], { a: 5 }, { "": "craft" }]) {
    assert.doesNotThrow(() => resolveTag("melee", { customSynonyms }));
  }
});

test("resolveTag accepts non-string input without throwing", () => {
  assert.doesNotThrow(() => resolveTag(42));
  assert.doesNotThrow(() => resolveTag({ tag: "x" }));
});

// ---- slugifyTheme --------------------------------------------------------------------------

const SLUG_CASES = [
  ["Bee-keeping!", "beekeeping"],
  ["  The Cartography  ", "cartography"],
  ["Animal Handling", "animal-handling"],
  ["BeeKeeping", "beekeeping"],
  ["glass blowing", "glass-blowing"],
  ["Ψάρεμα", "psarema"],
  ["пчеловодство", "pchelovodstvo"],
  ["!!!", ""],
  ["", ""]
];
for (const [raw, slug] of SLUG_CASES) {
  test(`slugifyTheme(${JSON.stringify(raw)}) -> ${JSON.stringify(slug)}`, () => assert.equal(slugifyTheme(raw), slug));
}

test("slugifyTheme output is always <= 32 chars of [a-z0-9-] with no edge hyphens", () => {
  const inputs = ["a".repeat(50), "the very long and winding art of competitive underwater basket weaving", "Ñandú-ßtraße Øl", "¿¡Qué!?", "x", null, undefined, 12345, "---a---"];
  for (const raw of inputs) {
    const slug = slugifyTheme(raw);
    assert.ok(slug.length <= 32, `${raw} -> ${slug}`);
    assert.match(slug, /^(?:[a-z0-9]+(?:-[a-z0-9]+)*)?$/, `${raw} -> ${slug}`);
  }
});

// ---- coerceOutcome -------------------------------------------------------------------------

const OUTCOME_CASES = [
  ["success", "success"], ["SUCCESS", "success"], ["criticalSuccess", "criticalSuccess"], ["critical success", "criticalSuccess"],
  ["Critical_Success", "criticalSuccess"], ["crit", "criticalSuccess"], ["critical", "criticalSuccess"], ["Crit Success", "criticalSuccess"],
  ["critical hit", "criticalSuccess"], ["nat 20", "criticalSuccess"], ["nat20", "criticalSuccess"], ["natural 20", "criticalSuccess"],
  ["nat 1", "criticalFailure"], ["nat one", "criticalFailure"], ["crit fail", "criticalFailure"], ["fumble", "criticalFailure"],
  ["botched", "criticalFailure"], ["critically failed", "criticalFailure"], ["failed critically", "criticalFailure"],
  ["succeeded", "success"], ["win", "success"], ["partial", "success"], ["mixed", "success"], ["Success!", "success"],
  ["fail", "failure"], ["FAILED", "failure"], ["almost but", "failure"],
  ["0.95", "criticalSuccess"], ["0.6", "success"], ["0.2", "failure"], [0, "failure"], [1, "criticalFailure"], [20, "criticalSuccess"],
  [12, "success"], [5, "failure"], ["15", "success"], [true, "success"], [false, "failure"],
  ["éxito", "success"], ["fallo", "failure"], ["éxito crítico", "criticalSuccess"], ["fallo crítico", "criticalFailure"],
  ["επιτυχία", "success"], ["αποτυχία", "failure"], ["sucesso", "success"], ["falhou", "failure"], ["réussi", "success"],
  ["échec", "failure"], ["geschafft", "success"], ["riuscito", "success"], ["fallito", "failure"], ["tagumpay", "success"],
  ["nabigo", "failure"], ["seikou", "success"], ["shippai", "failure"], ["daishippai", "criticalFailure"],
  // German past participle for "failed" -- the most common way a German GM would write it.
  ["fehlgeschlagen", "failure"],
  [{ result: "success" }, "success"]
];
for (const [raw, expected] of OUTCOME_CASES) {
  test(`coerceOutcome(${JSON.stringify(raw)}) -> ${expected}`, () => assert.equal(coerceOutcome(raw), expected));
}

test("coerceOutcome returns null for unrecognizable input instead of guessing", () => {
  for (const raw of ["banana", null, undefined, "", {}, NaN]) assert.equal(coerceOutcome(raw), null, JSON.stringify(raw));
});

// ---- coerceDangerGap -----------------------------------------------------------------------

const DANGER_CASES = [
  ["moderate", "moderate"], ["severe", "severe"], ["HIGH", "moderate"], ["extreme", "severe"], ["yes", "moderate"],
  ["true", "moderate"], ["Moderate ", "moderate"], ["SEVERE!!", "severe"], [true, "moderate"], [0.5, "moderate"],
  [0.9, "severe"], [3, "moderate"], [7, "severe"], ["outnumbered", "moderate"], ["hopelessly outmatched", "severe"],
  [{ level: "severe" }, "severe"],
  ["none", undefined], [false, undefined], [0, undefined], ["low", undefined], [null, undefined], ["banana", undefined]
];
for (const [raw, expected] of DANGER_CASES) {
  test(`coerceDangerGap(${JSON.stringify(raw)}) -> ${expected}`, () => assert.equal(coerceDangerGap(raw), expected));
}

// ---- coerceEvent ---------------------------------------------------------------------------

test("coerceEvent wraps a bare string and infers tags from its text", () => {
  const { event, coercions } = coerceEvent("Kesh parried the blade");
  assert.deepEqual(event.tags, ["martial"]);
  assert.equal(event.outcome, "success");
  assert.ok(coercions.includes("string-event-wrapped"));
});

test("coerceEvent reads aliased fields and comma-separated tags", () => {
  const { event } = coerceEvent({ description: "Mira healed Kesh", tags: "medicine, support", result: "Success!" });
  assert.deepEqual(event, { summary: "Mira healed Kesh", tags: ["medicine", "support"], themes: [], outcome: "success" });
});

test("coerceEvent keeps an event whose only tag is novel, as a theme", () => {
  const { event } = coerceEvent({ summary: "Maren moved the beehives", tags: ["beekeeping"], outcome: "success" });
  assert.deepEqual(event.tags, []);
  assert.deepEqual(event.themes, ["beekeeping"]);
  assert.equal(validateGrowthEvent(event).valid, true, "a themes-only event must pass the (updated) validator");
});

test("coerceEvent resolves hallucinated tags to canonical ones", () => {
  const { event } = coerceEvent({ summary: "Kesh fought", tags: ["melee", "defensive", "healing"], outcome: "success" });
  assert.deepEqual(event.tags, ["martial", "defense", "medicine"]);
});

test("coerceEvent rejects an event with no summary and no quote", () => {
  assert.equal(coerceEvent({ tags: ["martial"] }).rejected, "missing-summary");
});

test("coerceEvent falls back to the quote for the summary", () => {
  const { event } = coerceEvent({ quote: "Ο Γιώργος πολέμησε", tags: ["μάχη"] });
  assert.equal(event.summary, "Ο Γιώργος πολέμησε");
  assert.deepEqual(event.tags, ["martial"]);
});

test("coerceEvent rejects events that name nothing gameplay-relevant", () => {
  assert.equal(coerceEvent({ summary: "Something vague happened", tags: [] }).rejected, "no-tags-or-themes");
});

test("coerceEvent honors a model's explicit happened:false / kind:intention", () => {
  assert.equal(coerceEvent({ summary: "x", tags: ["martial"], happened: false }).rejected, "marked-not-an-event");
  assert.equal(coerceEvent({ summary: "x", tags: ["martial"], kind: "intention" }).rejected, "marked-not-an-event");
});

test("coerceEvent infers dangerGap only from explicit power-gap wording", () => {
  assert.equal(coerceEvent({ summary: "Hopelessly outmatched, Brakka held", tags: ["defense"] }).event.dangerGap, "severe");
  assert.equal(coerceEvent({ summary: "Brakka held the line", tags: ["defense"] }).event.dangerGap, undefined);
});

test("coerceEvent drops dangerGap 'none' instead of inventing a multiplier", () => {
  assert.equal("dangerGap" in coerceEvent({ summary: "Brakka held", tags: ["defense"], dangerGap: "none" }).event, false);
});

test("coerceEvent coerces danger / language / actor aliases", () => {
  const { event } = coerceEvent({ summary: "Brakka held", tags: ["defense"], danger: "HIGH", lang: "Spanish", character: "Brakka", quote: "Brakka aguantó" });
  assert.equal(event.dangerGap, "moderate");
  assert.equal(event.language, "es");
  assert.equal(event.actorName, "Brakka");
  assert.equal(event.quote, "Brakka aguantó");
});

test("coerceEvent caps tags at maxTags", () => {
  const { event } = coerceEvent({ summary: "x", tags: ["martial", "defense", "stealth", "thievery", "lore"] }, { maxTags: 3 });
  assert.equal(event.tags.length, 3);
});

test("coerceEvent with emergentThemes:false drops themes (and rejects themes-only events)", () => {
  assert.equal(coerceEvent({ summary: "x", tags: ["beekeeping"] }, { emergentThemes: false }).rejected, "no-tags-or-themes");
});

test("coerceEvent truncates an overlong quote to <= 400 chars", () => {
  const { event } = coerceEvent({ summary: "x", tags: ["lore"], quote: "q".repeat(1000) });
  assert.ok(event.quote.length <= 400);
});

test("coerceEvent never throws on garbage", () => {
  for (const raw of [null, undefined, 1, [], [1], {}, { summary: {} }, { summary: 5, tags: 5 }, { summary: "x", tags: { martial: true } }, { summary: "x", outcome: { nested: { deep: 1 } } }]) {
    assert.doesNotThrow(() => coerceEvent(raw), JSON.stringify(raw));
  }
});

test("every event coerceEvent produces passes validateGrowthEvent", () => {
  const raws = [
    "Kesh parried the blade",
    { description: "Mira healed Kesh", tags: "medicine, support", result: "Success!" },
    { summary: "Maren moved the hives", themes: ["Bee-keeping"] },
    { summary: "Brakka held", tags: ["defense"], danger: "HIGH" },
    { summary: "Tovin lied", tags: ["Deception!"], outcome: "nat 1" }
  ];
  for (const raw of raws) {
    const { event } = coerceEvent(raw);
    assert.ok(event, JSON.stringify(raw));
    assert.deepEqual(validateGrowthEvent(event).errors, [], JSON.stringify(event));
  }
});

test("eventDedupeKey treats punctuation-only differences as the same event", () => {
  assert.equal(eventDedupeKey({ summary: "Kesh parried the guard blade", outcome: "success" }), eventDedupeKey({ summary: "Kesh parried the guard blade!", outcome: "success" }));
  assert.notEqual(eventDedupeKey({ summary: "Kesh parried", outcome: "success" }), eventDedupeKey({ summary: "Kesh parried", outcome: "failure" }));
});
