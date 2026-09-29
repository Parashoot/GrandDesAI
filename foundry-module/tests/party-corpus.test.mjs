import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { GROWTH_TAXONOMY } from "../scripts/growth-taxonomy.js";
import { createGatewayAdapter } from "../scripts/ai-gateway.js";
import { createTransport } from "../scripts/ai/transport.js";
import { attributionCorrect, distributePartyEvents, renderMarkdown, runScale, scoreItem, scorePartyRep, summarizeJev, trueDoers } from "../tools/nlp-scale/lib.mjs";
import { createSimModel, partyGoldEvents } from "../tools/nlp-scale/sim-model.js";
import { createSimJev } from "../tools/nlp-scale/sim-jev.js";
import { createJevClient } from "../scripts/ai/jev.js";
import { loadPartyCorpus } from "../tools/nlp-scale/run.mjs";
import { CORPUS_DIR, loadCorpusSync } from "./helpers/corpus.mjs";

// The party corpus (docs/jev-layer-contract.md "Party corpus"; cloud packet C1, board c61ef1a8)
// measures per-character credit: who gets which deed when a whole party's notes are read at once.
// Its gold must be internally consistent, or the harness would blame the module for label noise.

const party = loadPartyCorpus(join(CORPUS_DIR, "party"));
const CANONICAL = new Set(GROWTH_TAXONOMY.map(([tag]) => tag));
const OUTCOMES = new Set(["criticalSuccess", "success", "failure", "criticalFailure"]);
const norm = (text) => String(text).toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();

test("party corpus: >= 20 items, unique pa- ids, the contract shape, both systems", () => {
  assert.ok(party.length >= 20, `${party.length}`);
  assert.equal(new Set(party.map((item) => item.id)).size, party.length);
  for (const item of party) {
    assert.match(item.id, /^pa-\d{3}$/);
    assert.equal(item.category, "party", item.id);
    assert.ok(["dnd5e", "pf2e"].includes(item.system), item.id);
    assert.ok(typeof item.lang === "string" && item.lang, item.id);
    assert.ok(typeof item.notes === "string" && item.notes.trim().length >= 20, item.id);
    assert.ok(Array.isArray(item.party) && item.party.length >= 2, item.id);
    assert.equal(new Set(item.party).size, item.party.length, item.id);
    assert.ok(item.gold?.perActor && typeof item.gold.perActor === "object", item.id);
  }
  const systems = new Set(party.map((item) => item.system));
  assert.ok(systems.has("dnd5e") && systems.has("pf2e"));
  assert.ok(party.filter((item) => item.system === "pf2e").length >= 8);
  assert.ok(party.filter((item) => item.system === "dnd5e").length >= 8);
});

test("party corpus: gold names are exactly the party; bounds, tags and outcomes are valid", () => {
  for (const item of party) {
    assert.deepEqual(Object.keys(item.gold.perActor).sort(), [...item.party].sort(), item.id);
    for (const [name, gold] of Object.entries(item.gold.perActor)) {
      const where = `${item.id}/${name}`;
      assert.ok(Number.isInteger(gold.minEvents) && Number.isInteger(gold.maxEvents) && gold.minEvents >= 0 && gold.minEvents <= gold.maxEvents, where);
      assert.ok(Array.isArray(gold.mustTags), where);
      if (gold.maxEvents === 0) assert.equal(gold.mustTags.length, 0, where);
      for (const tag of [...gold.mustTags.flatMap((t) => t.split("|")), ...(gold.okTags ?? []), ...(gold.forbidTags ?? [])]) assert.ok(CANONICAL.has(tag), `${where}: ${tag}`);
      if (gold.outcome) for (const o of gold.outcome.split("|")) assert.ok(OUTCOMES.has(o), `${where}: ${o}`);
      for (const snippet of gold.evidence ?? []) assert.ok(norm(item.notes).includes(norm(snippet)), `${where}: evidence "${snippet}" not in notes`);
      if (gold.redWorthy !== undefined) assert.equal(typeof gold.redWorthy, "boolean", where);
    }
    for (const snippet of item.gold.wholeParty?.evidence ?? []) assert.ok(norm(item.notes).includes(norm(snippet)), `${item.id}: whole-party evidence`);
  }
});

test("party corpus: covers every style the contract asks for", () => {
  const has = (style) => party.filter((item) => item.style === style || item.traits?.includes(style)).length;
  for (const [style, min] of Object.entries({ "speaker-lines": 8, "third-person": 5, witness: 8, "whole-party": 3, "idle-pc": 10, "mixed-language": 4, shorthand: 3, "ember-road": 4 })) {
    assert.ok(has(style) >= min, `${style}: ${has(style)}`);
  }
  assert.ok(party.some((item) => item.gold.wholeParty), "an explicit whole-party deed");
  assert.ok(party.filter((item) => Object.values(item.gold.perActor).some((g) => g.redWorthy)).length >= 3, "dark deeds reported by a witness");
  const langs = new Set(party.map((item) => item.lang));
  for (const lang of ["es-en", "el-en", "fr-en", "tl-en"]) assert.ok(langs.has(lang), lang);
});

test("party corpus: the ember-road s1 notes and the two known credit failures are in it", () => {
  const s1 = readFileSync(new URL("../playtests/ember-road/sessions/01/notes.md", import.meta.url), "utf8").trim();
  const full = party.find((item) => item.source === "ember-road-s1" && item.notes === s1);
  assert.ok(full, "pa-001 is the verbatim session-1 recap");
  assert.deepEqual(full.party, ["Brakka", "Wick", "Maren", "Tovin", "Luz"]);
  // Luz reports Tovin's kill: the deed is Tovin's (and dark), not Luz's.
  assert.ok(full.gold.perActor.Tovin.evidence.includes("killing a goblin that was surrender"));
  assert.equal(full.gold.perActor.Tovin.redWorthy, true);
  assert.equal(trueDoers(full, { quote: "she catch Tovin killing a goblin that was surrender" }).doers[0], "Tovin");
  // Wick's lost dagger and the rigged dice he lost.
  assert.ok(full.gold.perActor.Wick.evidence.includes("lost my dagger to the river"));
  assert.ok(full.gold.perActor.Wick.evidence.includes("rigging dice"));
  assert.ok(party.filter((item) => item.source === "ember-road-s1").length >= 4);
});

test("party corpus: gold is self-consistent -- the ideal events, credited to the true doers, score 100% on every item", () => {
  for (const item of party) {
    const s = scorePartyRep(item, { events: partyGoldEvents(item, { trueDoers: true }) });
    const bad = Object.entries(s.actors).filter(([, a]) => a.score !== 1);
    assert.equal(s.score, 1, `${item.id}: ${JSON.stringify(bad)}`);
    assert.equal(s.attribution.correct, s.attribution.scored, item.id);
  }
});

test("party corpus stays out of the ordinary corpus and its loaders", () => {
  assert.ok(loadCorpusSync().every((item) => item.category !== "party"));
});

// ---- party scoring on hand-made outputs ------------------------------------------------------------

const ER = party.find((item) => item.id === "pa-002"); // Tovin + Luz lines, Brakka idle
const ev = (actorName, quote, tags, extra = {}) => ({ summary: quote, quote, actorName, tags, outcome: "success", ...extra });

test("scorePartyRep: the right credit scores 1; the s1 'everyone gets everything' bug does not", () => {
  const right = [
    ev("Tovin", "torched a troll", ["fire"]),
    ev("Tovin", "tidied up a loose end", ["stealth"]),
    ev("Tovin", "she catch Tovin killing a goblin that was surrender", ["martial"]),
    ev("Luz", "Luz heal Brakka full HP", ["medicine"]),
    ev("Luz", "Luz lead the dawn blessing", ["religion"])
  ];
  const good = scorePartyRep(ER, { events: right });
  assert.equal(good.score, 1);
  assert.equal(good.creditLeak, 0);
  assert.equal(good.idleOk, 1);
  assert.deepEqual(good.attribution, { scored: 5, correct: 5 });

  // No actorName anywhere: attributeEventsToActor keeps every unattributable event for everyone
  // (the shape of ember-road s1's credit bug) -- idle Brakka is credited, bounds are blown.
  const anonymous = right.map((e) => ({ ...e, actorName: "", quote: "x", summary: "something happened" }));
  const bad = scorePartyRep(ER, { events: anonymous, perActor: { Tovin: anonymous, Luz: anonymous, Brakka: anonymous } });
  assert.ok(bad.score < 0.7, `${bad.score}`);
  assert.ok(bad.creditLeak > 0);
  assert.equal(bad.idleOk, 0);
  assert.equal(bad.actors.Brakka.countOk, false);
});

test("scorePartyRep: a deed reported in a witness's line and credited to the witness is an attribution miss", () => {
  const events = [
    ev("Tovin", "torched a troll", ["fire"]),
    ev("Luz", "she catch Tovin killing a goblin that was surrender", ["martial"]),
    ev("Luz", "Luz heal Brakka full HP", ["medicine"]),
    ev("Luz", "Luz lead the dawn blessing", ["religion"])
  ];
  const s = scorePartyRep(ER, { events });
  assert.equal(attributionCorrect(ER, events[1]), false);
  assert.deepEqual(s.attribution, { scored: 4, correct: 3 });
  assert.equal(s.actors.Tovin.count, 1);
  assert.equal(s.actors.Tovin.countOk, false, "Tovin is short the deed Luz reported");
  assert.equal(s.actors.Luz.count, 3);
  assert.ok(s.score < 1);
});

test("scorePartyRep: Jev's actorName fix and dark-act flag make Tovin's red deed count; jev.whole credits everyone", () => {
  const fixed = [
    ev("Tovin", "torched a troll", ["fire"]),
    ev("Tovin", "she catch Tovin killing a goblin that was surrender", ["martial"], { jev: { actorName: "Tovin", actorConfidence: 0.93, whole: false, flags: ["dark-act"] }, themes: ["dark-deed"] }),
    ev("Luz", "Luz heal Brakka full HP", ["medicine"]),
    ev("Luz", "Luz lead the dawn blessing", ["religion"])
  ];
  const s = scorePartyRep(ER, { events: fixed });
  assert.equal(s.actors.Tovin.redOk, true);
  assert.equal(s.redOk, 1);
  assert.equal(s.redFalse, 0);
  const noFlag = scorePartyRep(ER, { events: fixed.map((e) => ({ ...e, jev: undefined, themes: [] })) });
  assert.equal(noFlag.redOk, 0);

  const mill = party.find((item) => item.id === "pa-008");
  const whole = ev("", "rebuilding the burned mill", ["craft"], { jev: { whole: true, actorConfidence: 0.9 } });
  assert.equal(attributionCorrect(mill, whole), true);
  assert.equal(attributionCorrect(mill, { ...whole, jev: undefined, actorName: "the party" }), true);
  assert.equal(attributionCorrect(mill, { ...whole, jev: undefined, actorName: "Valeros" }), false);
});

test("scorePartyRep: a failed rep scores 0; scoreItem aggregates per character", () => {
  assert.equal(scorePartyRep(ER, { error: { name: "X" }, events: [] }).score, 0);
  const scored = scoreItem(ER, { reps: [{ events: partyGoldEvents(ER, { trueDoers: true }), ms: 5 }, { error: { name: "X", message: "boom" }, events: [], ms: 1 }] });
  assert.equal(scored.score, 0.5);
  assert.deepEqual(scored.party.actors.Tovin.counts, [3, 0]);
  assert.equal(scored.failRate, 0.5);
});

test("partyGoldEvents reproduces the local model's speaker bug unless asked for the true doers", () => {
  const bugged = partyGoldEvents(ER).find((e) => /goblin that was surrender/.test(e.quote));
  assert.equal(bugged.actorName, "Luz");
  const fixed = partyGoldEvents(ER, { trueDoers: true }).find((e) => /goblin that was surrender/.test(e.quote));
  assert.equal(fixed.actorName, "Tovin");
  const leaked = distributePartyEvents(ER, partyGoldEvents(ER));
  assert.equal(leaked.Tovin.length, 2);
  assert.equal(leaked.Luz.length, 3);
});

// ---- end to end through the real pipeline + simulated model ----------------------------------------

function simTransport(corpus, sim = createSimModel({ corpus, seed: 1, faultRate: 0 })) {
  return createTransport({ provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "sim", timeoutMs: 50, fetchImpl: sim.fetch, sleep: async () => {} });
}

test("runScale --party per-pc (cache off): one extraction per character, the witness bug is measured, the report has a Party credit table", async () => {
  const transport = simTransport(party);
  const state = await runScale({ corpus: party, transport, party: true, partyMode: "per-pc", config: { proposalMode: "never" } });
  assert.equal(state.done, party.length);
  assert.equal(state.summary.overall.fallbackRate, 0);
  for (const item of state.scored) {
    assert.equal(item.party.mode, "per-pc");
    assert.equal(item.reps[0].extractions, item.party.party.length, `${item.id}: ${item.reps[0].extractions} extractions`);
  }
  const attribution = state.scored.reduce((acc, item) => ({ s: acc.s + item.party.attribution.scored, c: acc.c + item.party.attribution.correct }), { s: 0, c: 0 });
  assert.ok(attribution.c < attribution.s, "the sim model credits witness lines to the speaker");
  assert.ok(attribution.c / attribution.s > 0.7);
  const md = renderMarkdown(state);
  assert.ok(md.includes("## Party credit"));
  assert.ok(md.includes("| pa-001 | Tovin |"));
});

test("runScale --party (default): the adapter's extraction cache reads each item once, with the same credit as per-pc and fewer model calls", async () => {
  const simBefore = createSimModel({ corpus: party, seed: 1, faultRate: 0 });
  const simAfter = createSimModel({ corpus: party, seed: 1, faultRate: 0 });
  const before = await runScale({ corpus: party, transport: simTransport(party, simBefore), party: true, partyMode: "per-pc", config: { proposalMode: "never" } });
  const after = await runScale({ corpus: party, transport: simTransport(party, simAfter), party: true, config: { proposalMode: "never" } });
  assert.equal(after.done, party.length);
  for (const item of after.scored) {
    assert.equal(item.party.mode, "party");
    assert.equal(item.reps[0].extractions, 1, `${item.id}: ${item.reps[0].extractions} extractions`);
  }
  const acc = (state) => state.scored.reduce((a, item) => ({ s: a.s + item.party.attribution.scored, c: a.c + item.party.attribution.correct }), { s: 0, c: 0 });
  assert.deepEqual(acc(after), acc(before), "the same reading, so the same attribution");
  assert.ok(Math.abs(after.summary.overall.score - before.summary.overall.score) < 1e-9);
  // The model was really called once per item, not once per character (the pipeline still reports
  // the cached stage in diagnostics, so the sim's own call count is the honest measure).
  const characters = party.reduce((sum, item) => sum + item.party.length, 0);
  assert.equal(simBefore.stats.stages.extract, characters);
  assert.equal(simAfter.stats.stages.extract, party.length);
  const md = renderMarkdown(after);
  assert.ok(md.includes("mode party"));
  assert.ok(md.includes("extractions per item 1.0"));
});

test("board ab855163: with the simulated Jev on, party credit and attribution are at least the Jev-off numbers, red recall included", async () => {
  // The exact run.mjs `--sim --party --sim-jev` path: the real client over the sim's fetch, the
  // adapter's cache, one extraction per item, and the "without Jev" column from the same transport.
  const simJev = createSimJev({ corpus: party, seed: 1 });
  const jevConfig = { enabled: true, apiKey: "sim-jev-key", endpoint: "https://api.typesafe.ai", model: "jev-latest", timeoutMs: 1000 };
  const client = createJevClient({ ...jevConfig, fetchImpl: simJev.fetch, sleep: async () => {} });
  const state = await runScale({ corpus: party, transport: simTransport(party), party: true, jev: client, compareWithoutJev: true, config: { proposalMode: "never", jev: jevConfig } });
  const jev = summarizeJev(state.scored);
  assert.ok(jev.attribution.scored >= 60, `${jev.attribution.scored} events judged`);
  assert.ok(jev.attribution.accuracy >= jev.without.attribution.accuracy, `attribution ${jev.attribution.accuracy} < ${jev.without.attribution.accuracy} without Jev`);
  assert.ok(jev.without.scoreWith >= jev.without.score, `score ${jev.without.scoreWith} < ${jev.without.score} without Jev`);
  assert.ok(jev.attribution.accuracy > 0.95, `${jev.attribution.accuracy}`);
  assert.equal(jev.red.recall, 1, "Tovin's red deed is still flagged");
  // The ember-road line that started it: Luz keeps her heal and blessing, the kill is Tovin's, and no
  // deed of a single character lands on two sheets.
  const s1 = state.scored.find((item) => item.id === "pa-001");
  assert.equal(s1.party.actors.Luz.counts[0], 2);
  assert.equal(s1.party.actors.Tovin.counts[0], 3);
  assert.deepEqual(s1.party.attribution, { scored: 13, correct: 13 });
  assert.equal(s1.party.creditLeak, 0);
});

test("runScale --party: a confident event.jev.actorName from the pipeline is honoured by the per-character split (session-notes JEV_ATTRIBUTION_CONFIDENCE)", async () => {
  // Stands in for the Jev attribution step the gateway will add (docs/jev-layer-contract.md): the
  // pipeline output carries event.jev on the goblin kill only; nothing else is overridden.
  const luzItem = party.find((item) => item.id === "pa-002");
  const adapterFactory = (config, { transportFactory }) => {
    const base = createGatewayAdapter({ ...config, proposalMode: "never" }, { transportFactory });
    return async (args) => {
      const out = await base(args);
      const events = out.events.map((event) => (/goblin that was surrender/i.test(event.quote ?? "") ? { ...event, jev: { actorName: "Tovin", actorConfidence: 0.93, whole: false, flags: ["dark-act"] } } : event));
      return { ...out, events };
    };
  };
  const plain = await runScale({ corpus: [luzItem], transport: simTransport(party), party: true, config: { proposalMode: "never" } });
  const fixed = await runScale({ corpus: [luzItem], transport: simTransport(party), party: true, adapterFactory, config: { proposalMode: "never" } });
  assert.equal(plain.scored[0].party.actors.Tovin.counts[0], 2, "the sim model credits Luz with Tovin's kill");
  assert.equal(fixed.scored[0].party.actors.Tovin.counts[0], 3, "a confident Jev actorName routes it to Tovin");
  assert.equal(fixed.scored[0].party.actors.Luz.counts[0], 2);
  assert.ok(fixed.scored[0].party.attribution.correct > plain.scored[0].party.attribution.correct);
  assert.equal(fixed.scored[0].redAcc, 1, "the dark-act flag is the red signal for Tovin");
});
