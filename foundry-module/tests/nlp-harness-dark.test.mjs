import assert from "node:assert/strict";
import test from "node:test";

import { VICE_TAGS } from "../scripts/vice-taxonomy.js";
import { createTransport } from "../scripts/ai/transport.js";
import {
  DARK_REVIEWED_CATEGORIES,
  DARK_SCHEMA_ACTIVE,
  darkLine,
  goldDarkDeed,
  isDarkEvent,
  renderMarkdown,
  runScale,
  scoreDarkDeeds,
  scoreItem,
  scoreRep,
  scoreRun
} from "../tools/nlp-scale/lib.mjs";
import { createSimModel, goldEvents, heuristicEvents } from "../tools/nlp-scale/sim-model.js";
import { loadCorpusSync } from "./helpers/corpus.mjs";

// Horror Rank accrues from recorded dark deeds (board 21e944ed), so the harness has to measure the
// darkDeed / darkSeverity event fields. The one rule these tests guard hardest: a run whose model
// output has no darkDeed field must report null, never 0% -- otherwise every run made before the
// field existed would read as "the model never recognises a dark deed".

const corpus = loadCorpusSync();
const SEVERITIES = new Set(["none", "minor", "serious", "monstrous"]);
const alts = (value) => String(value).split("|");

const RED = { id: "x-red", category: "red-polarity-worthy", lang: "en", notes: "Kesh finished off a surrendered goblin.", gold: { mustTags: ["martial"], okTags: [], darkDeed: "cruelty|bloodlust", darkSeverity: "serious" } };
const TRAP = { id: "x-trap", category: "traps", lang: "en", notes: "Kesh wanted to burn it down.", gold: { mustTags: [], okTags: [], noEvents: true, darkDeed: "none", darkSeverity: "none" } };
const REVIEWED = { id: "x-fl", category: "fluent-en", lang: "en", notes: "Brakka held the bridge.", gold: { mustTags: ["defense"], okTags: [] } };
const UNLABELLED = { id: "x-new", category: "some-new-category", lang: "en", notes: "Brakka held the bridge.", gold: { mustTags: ["defense"], okTags: [] } };

const ev = (extra = {}) => ({ summary: "Did a thing.", tags: ["martial"], themes: [], outcome: "success", ...extra });

// ---- corpus gold ---------------------------------------------------------------------------------

test("corpus: every red-polarity and traps item carries darkDeed + darkSeverity gold", () => {
  for (const item of corpus.filter((entry) => entry.category === "red-polarity-worthy" || entry.category === "traps")) {
    assert.equal(typeof item.gold.darkDeed, "string", item.id);
    assert.equal(typeof item.gold.darkSeverity, "string", item.id);
  }
});

test("corpus: dark gold uses taxonomy vices and the four severities; red items are dark, traps are not", () => {
  for (const item of corpus.filter((entry) => entry.gold.darkDeed !== undefined)) {
    const vices = alts(item.gold.darkDeed);
    const severities = alts(item.gold.darkSeverity);
    for (const vice of vices) assert.ok(vice === "none" || VICE_TAGS.has(vice), `${item.id}: unknown vice ${vice}`);
    for (const severity of severities) assert.ok(SEVERITIES.has(severity), `${item.id}: unknown severity ${severity}`);
    // "none" is all-or-nothing: a vice with severity none (or the reverse) is an unscorable label.
    assert.equal(vices.includes("none"), severities.includes("none"), item.id);
    if (vices.includes("none")) assert.equal(vices.length + severities.length, 2, item.id);
    if (item.category === "red-polarity-worthy") assert.ok(!vices.includes("none"), `${item.id} is red-worthy but gold says no dark deed`);
    if (item.category === "traps") assert.deepEqual([item.gold.darkDeed, item.gold.darkSeverity], ["none", "none"], item.id);
  }
});

test("corpus: every category is in DARK_REVIEWED_CATEGORIES, so a new category forces a dark-deed read", () => {
  for (const category of new Set(corpus.map((item) => item.category))) {
    assert.ok(DARK_REVIEWED_CATEGORIES.includes(category), `${category}: read its items for dark deeds, then add it`);
  }
});

test("goldDarkDeed: explicit label, reviewed category -> none, unlabelled -> null", () => {
  assert.deepEqual(goldDarkDeed(RED), { vices: ["cruelty", "bloodlust"], severities: ["serious"] });
  assert.deepEqual(goldDarkDeed(TRAP), { vices: ["none"], severities: ["none"] });
  assert.deepEqual(goldDarkDeed(REVIEWED), { vices: ["none"], severities: ["none"] });
  assert.equal(goldDarkDeed(UNLABELLED), null);
});

// ---- per-rep scoring -----------------------------------------------------------------------------

test("scoreDarkDeeds: null (not 0) when the model output has no darkDeed field at all", () => {
  for (const darkSchema of [false, true]) {
    for (const item of [RED, TRAP, REVIEWED]) {
      const dark = scoreDarkDeeds(item, [ev(), ev({ tags: ["defense"] })], { darkSchema });
      assert.deepEqual(dark, { darkMeasured: false, darkDeedOk: null, darkViceOk: null, darkDetectOk: null, darkFalse: null }, `${item.id} schema=${darkSchema}`);
    }
  }
});

test("scoreDarkDeeds: zero events count only when the event schema asks for darkDeed", () => {
  assert.equal(scoreDarkDeeds(RED, [], { darkSchema: false }).darkDeedOk, null);
  assert.equal(scoreDarkDeeds(TRAP, [], { darkSchema: false }).darkFalse, null);
  assert.equal(scoreDarkDeeds(RED, [], { darkSchema: true }).darkDeedOk, false, "a dark item with no events is a miss");
  assert.equal(scoreDarkDeeds(TRAP, [], { darkSchema: true }).darkFalse, false);
});

test("scoreDarkDeeds: vice + severity alternatives, vice-only, detection", () => {
  const exact = scoreDarkDeeds(RED, [ev({ darkDeed: "none", darkSeverity: "none" }), ev({ darkDeed: "bloodlust", darkSeverity: "serious" })]);
  assert.deepEqual([exact.darkDeedOk, exact.darkViceOk, exact.darkDetectOk, exact.darkFalse], [true, true, true, null]);

  const wrongSeverity = scoreDarkDeeds(RED, [ev({ darkDeed: "cruelty", darkSeverity: "minor" })]);
  assert.deepEqual([wrongSeverity.darkDeedOk, wrongSeverity.darkViceOk, wrongSeverity.darkDetectOk], [false, true, true]);

  const wrongVice = scoreDarkDeeds(RED, [ev({ darkDeed: "betrayal", darkSeverity: "serious" })]);
  assert.deepEqual([wrongVice.darkDeedOk, wrongVice.darkViceOk, wrongVice.darkDetectOk], [false, false, true]);

  // Severity must sit on the SAME event as the right vice.
  const split = scoreDarkDeeds(RED, [ev({ darkDeed: "cruelty", darkSeverity: "minor" }), ev({ darkDeed: "ruin", darkSeverity: "serious" })]);
  assert.equal(split.darkDeedOk, false);

  const missed = scoreDarkDeeds(RED, [ev({ darkDeed: "none", darkSeverity: "none" })]);
  assert.deepEqual([missed.darkDeedOk, missed.darkViceOk, missed.darkDetectOk], [false, false, false]);

  // Case and whitespace are not the model's fault.
  assert.equal(scoreDarkDeeds(RED, [ev({ darkDeed: " Cruelty ", darkSeverity: "SERIOUS" })]).darkDeedOk, true);
});

test("scoreDarkDeeds: a dark deed on a gold-none item is a false positive; unlabelled items score null", () => {
  assert.equal(scoreDarkDeeds(TRAP, [ev({ darkDeed: "none", darkSeverity: "none" })]).darkFalse, false);
  assert.equal(scoreDarkDeeds(REVIEWED, [ev({ darkDeed: "none" }), ev({ darkDeed: "cruelty", darkSeverity: "minor" })]).darkFalse, true);
  assert.equal(scoreDarkDeeds(TRAP, [ev({ darkDeed: "cruelty" })]).darkDeedOk, null, "accuracy does not apply to none items");
  assert.equal(scoreDarkDeeds(UNLABELLED, [ev({ darkDeed: "cruelty", darkSeverity: "serious" })]).darkFalse, null);
  assert.equal(isDarkEvent({ darkDeed: "none" }), false);
  assert.equal(isDarkEvent({ darkDeed: "" }), false);
  assert.equal(isDarkEvent({}), false);
});

test("scoreRep: dark checks never move score", () => {
  const plain = scoreRep(RED, { events: [ev()] });
  const dark = scoreRep(RED, { events: [ev({ darkDeed: "cruelty", darkSeverity: "serious" })] });
  const wrong = scoreRep(RED, { events: [ev({ darkDeed: "none", darkSeverity: "none" })] });
  assert.equal(plain.score, dark.score);
  assert.equal(plain.score, wrong.score);
  assert.equal(dark.darkDeedOk, true);
  assert.equal(wrong.darkDeedOk, false);
});

// ---- aggregation + report ------------------------------------------------------------------------

const run = (item, repsEvents) => ({ id: item.id, category: item.category, lang: item.lang, reps: repsEvents.map((events, rep) => ({ rep, ms: 1, events, proposals: [], themes: [] })) });

test("scoreItem / scoreRun: rates over reps and items; null everywhere when nothing carried the field", () => {
  const scored = [
    scoreItem(RED, run(RED, [[ev({ darkDeed: "cruelty", darkSeverity: "serious" })], [ev({ darkDeed: "cruelty", darkSeverity: "minor" })]])),
    scoreItem(TRAP, run(TRAP, [[ev({ darkDeed: "none", darkSeverity: "none" })], [ev({ darkDeed: "ruin", darkSeverity: "minor" })]])),
    scoreItem(REVIEWED, run(REVIEWED, [[ev({ tags: ["defense"], darkDeed: "none", darkSeverity: "none" })], [ev({ tags: ["defense"], darkDeed: "none", darkSeverity: "none" })]]))
  ];
  assert.equal(scored[0].darkDeedAcc, 0.5);
  assert.equal(scored[0].darkViceAcc, 1);
  assert.equal(scored[0].darkFalseRate, null);
  assert.equal(scored[1].darkFalseRate, 0.5);
  assert.equal(scored[2].darkFalseRate, 0);
  assert.equal(scored[0].sampleOutput[0].events[0].darkDeed, "cruelty");

  const summary = scoreRun(scored);
  assert.equal(summary.overall.darkDeedAcc, 0.5);
  assert.equal(summary.overall.darkViceAcc, 1);
  assert.equal(summary.overall.darkDetectAcc, 1);
  assert.equal(summary.overall.darkFalseRate, 0.25, "mean of the two none items (0.5 and 0)");
  assert.equal(summary.overall.darkGoldItems, 1);
  assert.equal(summary.overall.darkNoneItems, 2);
  assert.deepEqual(summary.darkMisses, ["x-red", "x-trap"]);
  assert.equal(summary.byCategory.traps.darkDeedAcc, null);

  const legacy = scoreRun([scoreItem(RED, run(RED, [[ev()], []])), scoreItem(TRAP, run(TRAP, [[]]))].map((item) => item));
  // With the schema field active a zero-event rep on RED counts as a miss; without it, all null.
  if (!DARK_SCHEMA_ACTIVE) {
    for (const key of ["darkDeedAcc", "darkViceAcc", "darkDetectAcc", "darkFalseRate"]) assert.equal(legacy.overall[key], null, key);
    assert.deepEqual(legacy.darkMisses, []);
  }
  const forcedLegacy = scoreRun([
    scoreItem(RED, run(RED, [[ev()], []]), { darkSchema: false }),
    scoreItem(TRAP, run(TRAP, [[]]), { darkSchema: false })
  ]);
  for (const key of ["darkDeedAcc", "darkViceAcc", "darkDetectAcc", "darkFalseRate"]) assert.equal(forcedLegacy.overall[key], null, key);
  assert.match(darkLine(forcedLegacy.overall), /not measured/);
});

test("renderMarkdown: dark columns, summary line, per-item dark line and the Dark-deed misses section", () => {
  const scored = [
    scoreItem(RED, run(RED, [[ev({ darkDeed: "cruelty", darkSeverity: "minor" })]])),
    scoreItem(TRAP, run(TRAP, [[ev({ darkDeed: "ruin", darkSeverity: "minor" })]]))
  ];
  const md = renderMarkdown({ model: "fixture", provider: "test", scored, summary: scoreRun(scored), done: 2, total: 2 });
  assert.match(md, /\| dark deed \| dark FP \|/);
  assert.match(md, /- dark deeds: vice\+severity 0\.0%, vice only 100\.0%/);
  assert.match(md, /## Dark-deed misses/);
  assert.match(md, /dark gold `cruelty\|bloodlust \/ serious`: vice\+severity 0\.0%, vice 100\.0%/);
  assert.match(md, /\{dark: ruin\/minor\}/);
  assert.match(md, /dark gold `none`: a dark deed invented in 100\.0% of reps/);

  const legacyScored = [scoreItem(RED, run(RED, [[ev()]]), { darkSchema: false })];
  const legacy = renderMarkdown({ model: "old", scored: legacyScored, summary: scoreRun(legacyScored) });
  assert.match(legacy, /- dark deeds: not measured/);
  assert.doesNotMatch(legacy, /## Dark-deed misses/);
  assert.doesNotMatch(legacy, /\| 0\.0% \| 0\.0% \|/);
});

// ---- the simulated model --------------------------------------------------------------------------

test("sim: gold events carry the gold dark deed on the first event and none elsewhere", () => {
  for (const item of corpus.filter((entry) => entry.category === "red-polarity-worthy")) {
    const events = goldEvents(item);
    assert.equal(events[0].darkDeed, alts(item.gold.darkDeed)[0], item.id);
    assert.equal(events[0].darkSeverity, alts(item.gold.darkSeverity)[0], item.id);
    for (const event of events.slice(1)) assert.equal(event.darkDeed, "none", item.id);
    assert.equal(scoreDarkDeeds(item, events).darkDeedOk, true, item.id);
  }
  // Any other item whose gold names no vice (at-010, an atonement item, carries a deed of its own).
  for (const item of corpus.filter((entry) => entry.category !== "red-polarity-worthy" && alts(String(entry.gold?.darkDeed ?? "none"))[0] === "none")) {
    for (const event of goldEvents(item)) assert.deepEqual([event.darkDeed, event.darkSeverity], ["none", "none"], item.id);
  }
  // Unmatched notes: only unmistakable phrasings are dark; an ordinary fight is not.
  assert.deepEqual(heuristicEvents("Tovin tortured the captured scout and intimidated him into talking.").map((e) => [e.darkDeed, e.darkSeverity]), [["cruelty", "serious"]]);
  assert.deepEqual(heuristicEvents("Brakka attacked the goblin with her axe and won.").map((e) => e.darkDeed), ["none"]);
});

test("sim end to end: gold-perfect dark output scores 100% / 0% over red + traps", async () => {
  const items = corpus.filter((entry) => entry.category === "red-polarity-worthy" || entry.category === "traps");
  const byNotes = new Map(items.map((item) => [item.notes, item]));
  // A pipeline stand-in returning the sim's gold events directly: it measures the scoring, not
  // pipeline coercion (which keeps darkDeed only once the gateway schema has it).
  const pipeline = async ({ request }) => ({ events: goldEvents(byNotes.get(request.notes)), proposals: [] });
  const transport = { chat: async () => ({ content: "{}" }) };
  const state = await runScale({ corpus: items, transport, pipeline, reps: 1, darkSchema: true });
  const o = state.summary.overall;
  assert.equal(o.darkDeedAcc, 1);
  assert.equal(o.darkViceAcc, 1);
  assert.equal(o.darkFalseRate, 0);
  assert.equal(o.darkGoldItems, 10);
  assert.equal(o.darkNoneItems, 40);
  // Without the schema field, the 31 traps that correctly return no events say nothing about dark
  // deeds and drop out; only the 9 traps with an event are measured.
  const legacy = await runScale({ corpus: items, transport, pipeline, reps: 1, darkSchema: false });
  assert.equal(legacy.summary.overall.darkNoneItems, 9);
});

test("sim through the real pipeline: dark metrics are numbers once coercion keeps darkDeed, else null", async () => {
  const items = corpus.filter((entry) => entry.category === "red-polarity-worthy" || entry.category === "traps");
  const sim = createSimModel({ corpus, seed: 1, faultRate: 0 });
  const transport = createTransport({ provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "sim-model", fetchImpl: sim.fetch, timeoutMs: 50, sleep: async () => {} });
  const state = await runScale({ corpus: items, transport, config: { proposalMode: "never" }, reps: 1 });
  const carried = state.scored.some((item) => item.sampleOutput.some((out) => out.events.some((event) => event.darkDeed !== undefined)));
  const o = state.summary.overall;
  if (carried) {
    assert.equal(typeof o.darkDeedAcc, "number");
    assert.equal(typeof o.darkFalseRate, "number");
  } else if (!DARK_SCHEMA_ACTIVE) {
    assert.equal(o.darkDeedAcc, null);
    assert.equal(o.darkFalseRate, null);
  }
});
