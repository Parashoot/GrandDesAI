import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_JEV_FAULT_WEIGHTS,
  JEV_FAULT_KINDS,
  answerQuestion,
  createSimJev,
  focusOf,
  focusSubject,
  guessDoer,
  questionIntent,
  validateSystemOneBody
} from "../tools/nlp-scale/sim-jev.js";
import { chunkHeldGold, jevRepStats, redactConfig, renderMarkdown, runScale, summarizeJev } from "../tools/nlp-scale/lib.mjs";
import { createHarnessJev, jevConfigBlock, loadCorpus, loadJevModule, loadPartyCorpus, parseArgs, resolveJevOptions } from "../tools/nlp-scale/run.mjs";
import { bundle } from "../tools/nlp-scale/build-browser.mjs";
import { CORPUS_DIR } from "./helpers/corpus.mjs";

// The Jev layer is optional and built elsewhere (scripts/ai/jev.js); these tests pin the harness
// side of docs/jev-layer-contract.md on their own: the simulator speaks the documented wire format,
// is deterministic, injects every fault the client must survive, and the harness measures and
// reports Jev (or says clearly that it did not run) without ever leaking the key.

const ENDPOINT = "https://api.typesafe.ai";
const KEY = "test-key-123";
const post = (sim, body, { key = KEY, signal, raw } = {}) =>
  sim.fetch(`${ENDPOINT}/v1/systemone`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: raw ?? JSON.stringify(body),
    ...(signal ? { signal } : {})
  });

const ROSTER = { Brakka: null, Wick: null, Maren: null, Tovin: null, Luz: "the cleric", "someone-else": null, "whole-party": null };
const LUZ_LINE = "Luz: Tonight Luz heal Brakka full HP after the troll fight (Cure Wounds clutch), and she catch Tovin killing a goblin that was surrender, not happy about that at all.";

function fullRequest() {
  return {
    model: "jev-latest",
    state: {
      chunks: ["GM: next session the Toll King. rules q - can Wick ride Steve without Mounted Combatant? also someone owes me pizza money", "Brakka: Held the bridge, troll ran off."],
      events: [{ summary: "Luz saw Tovin kill a goblin that had surrendered.", quote: "she catch Tovin killing a goblin that was surrender" }, { summary: "Maren got 2nd place in the bake-off.", quote: "got 2nd place in the bake-off with a lavender honey loaf" }],
      proposals: [{ name: "Honeyed Artisan", effect: "bake-off honey loaf bonus" }]
    },
    questions: {
      t0: { type: "noul", instructions: "Does chunks[0] describe something a player character did, attempted, suffered or decided (not scenery, lore, rules talk or out-of-character chat)?" },
      t1: { type: "noul", instructions: "Does chunks[1] describe something a player character did, attempted, suffered or decided (not scenery, lore, rules talk or out-of-character chat)?", criteria: { true: "an action", false: "no action" } },
      who0: { type: "choice", instructions: "Who performed the action described in events[0]? Pick the doer, not the character reporting it.", criteria: ROSTER },
      out0: { type: "choice", instructions: "What was the outcome of events[1]?", criteria: { criticalSuccess: null, success: null, failure: null, criticalFailure: null, unclear: null } },
      dark0: { type: "noul", instructions: "Is events[0] a morally dark act (killing the helpless or surrendered, torture, betrayal, trading lives, desecration, raising the dead, taking trophies from the slain)?" },
      dark1: { type: "noul", instructions: "Is events[1] a morally dark act (killing the helpless or surrendered, torture, betrayal, trading lives, desecration, raising the dead, taking trophies from the slain)?" },
      g0: { type: "score", instructions: "How directly is proposals[0] grounded in the cited deeds in events?", criteria: ["not grounded", "loosely", "clearly", "directly"] }
    }
  };
}

// ---- wire format --------------------------------------------------------------------------------

test("sim-jev: GET /v1/models lists models; POST /v1/systemone answers every question in the documented shape", async () => {
  const sim = createSimJev({ seed: 3 });
  const models = await sim.fetch(`${ENDPOINT}/v1/models`, { headers: { Authorization: `Bearer ${KEY}` } });
  assert.equal(models.status, 200);
  const list = (await models.json()).models;
  assert.ok(list.length >= 1);
  for (const m of list) assert.deepEqual(Object.keys(m).sort(), ["description", "name", "release_date"]);

  const response = await post(sim, fullRequest());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  const body = await response.json();
  assert.equal(body.model, "jev-latest");
  assert.deepEqual(Object.keys(body.answers).sort(), ["dark0", "dark1", "g0", "out0", "t0", "t1", "who0"]);
  assert.ok(Number.isInteger(body.usage.input_tokens) && body.usage.input_tokens > 0);
  assert.ok(Number.isInteger(body.usage.output_tokens));
  for (const name of ["t0", "t1", "dark0", "dark1"]) {
    assert.equal(body.answers[name].type, "noul");
    assert.ok(body.answers[name].noul >= 0 && body.answers[name].noul <= 1, name);
  }
  for (const name of ["who0", "out0"]) {
    const a = body.answers[name];
    assert.equal(a.type, "choice");
    assert.ok(Object.keys(fullRequest().questions[name].criteria).includes(a.choice), name);
    assert.ok(a.confidence > 0 && a.confidence <= 1);
    const total = Object.values(a.probabilities).reduce((s, p) => s + p, 0);
    assert.ok(Math.abs(total - 1) < 0.01, `${name} probabilities sum ${total}`);
  }
  const g = body.answers.g0;
  assert.equal(g.type, "score");
  assert.ok(Number.isInteger(g.score) && g.score >= 0 && g.score <= 3);
  assert.equal(g.legend, fullRequest().questions.g0.criteria[g.score]);
  assert.equal(Object.keys(g.probabilities).length, 4);
});

test("sim-jev: answers follow the notes -- OOC chunk skipped, deed kept, witness line credits the doer, dark act flagged", async () => {
  const body = await (await post(createSimJev({}), fullRequest())).json();
  assert.ok(body.answers.t0.noul < 0.12, `OOC/rules/pizza chunk p=${body.answers.t0.noul}`);
  assert.ok(body.answers.t1.noul >= 0.5, `bridge chunk p=${body.answers.t1.noul}`);
  assert.equal(body.answers.who0.choice, "Tovin");
  assert.ok(body.answers.who0.confidence >= 0.6);
  assert.ok(body.answers.dark0.noul >= 0.85);
  assert.ok(body.answers.dark1.noul < 0.2);
  assert.equal(body.answers.out0.choice, "success");
});

test("sim-jev: intent comes from type + criteria + instructions, never from the question name", () => {
  assert.equal(questionIntent({ type: "choice", instructions: "x", criteria: { success: null, failure: null } }), "outcome");
  assert.equal(questionIntent({ type: "choice", instructions: "pick one", criteria: { Kesh: null, "whole-party": null } }), "actor");
  assert.equal(questionIntent({ type: "noul", instructions: "Was the character the notes quote as speaking/reporting only a witness, not the doer?" }), "witness");
  assert.equal(questionIntent({ type: "score", instructions: "how well does it fit this character's play so far" }), "fit");
  assert.equal(focusOf({ events: [{ summary: "A" }, { summary: "B" }] }, "Was events[1].summary bad?"), "B");
  assert.equal(guessDoer(LUZ_LINE, ["Brakka", "Luz", "Tovin"]).label, "Tovin");
  assert.equal(guessDoer("Ana: vi a Tomás robar la bolsa", ["Ana", "Tomás"]).label, "Tomás");
  const whole = answerQuestion({ type: "choice", instructions: "Who performed events[0]?", criteria: { A: null, B: null, "someone-else": null, "whole-party": null } }, { events: [{ summary: "We all rebuilt the mill together" }] });
  assert.equal(whole.answer.choice, "whole-party");
});

test("sim-jev: corpus gold decides the doer when the state holds a party evidence snippet", async () => {
  const party = loadPartyCorpus(join(CORPUS_DIR, "party"));
  const sim = createSimJev({ corpus: party });
  // "Tovin: ... tidied up a loose end" names only Tovin, but pa-013's Greek witness line has no
  // Latin-script doer at all; gold still routes "held the door vs 4 zombies" to Nikos.
  const body = await (await post(sim, { model: "jev-latest", state: { events: [{ summary: "Petros: held the door vs 4 zombies" }] }, questions: { who: { type: "choice", instructions: "Who performed events[0]?", criteria: { Nikos: null, Eleni: null, Petros: null, "someone-else": null, "whole-party": null } } } })).json();
  assert.equal(body.answers.who.choice, "Nikos");
  assert.ok(sim.stats.goldMatches >= 1);
});

test("sim-jev (board ab855163): answers are about the EVENT, not the whole notes line it sits in", async () => {
  // The pipeline's attribution state: each event carries its quote, summary and the whole speaker
  // line around it. Luz's line holds her own heal and blessing AND Tovin's kill; the sim used to
  // match the longest gold snippet anywhere in the line, so all three "became" Tovin's.
  const partyCorpus = loadPartyCorpus(join(CORPUS_DIR, "party"));
  const sim = createSimJev({ corpus: partyCorpus });
  const line = { speaker: "Luz", text: "Luz: Tonight Luz heal Brakka full HP after the troll fight (Cure Wounds clutch), and she catch Tovin killing a goblin that was surrender, not happy about that at all. Then Ember Festival was so pretty, Luz lead the dawn blessing at the temple and whole square kneel, I nearly cry lol" };
  const events = [
    { summary: "Tonight Luz heal Brakka full HP after the troll fight (Cure Wounds clutch)", quote: "Tonight Luz heal Brakka full HP after the troll fight (Cure Wounds clutch)", noteLine: line },
    { summary: "and she catch Tovin killing a goblin that was surrender", quote: "and she catch Tovin killing a goblin that was surrender", noteLine: line },
    { summary: "Luz lead the dawn blessing at the temple and whole square kneel", quote: "Luz lead the dawn blessing at the temple and whole square kneel", noteLine: line },
    { summary: "torched a troll", quote: "torched a troll", noteLine: { speaker: "Tovin", text: "Tovin: torched a troll, lost my pit bet. Also I may have quietly tidied up a loose end on the bridge" } },
    { summary: "Held the bridge", quote: "Held the bridge", noteLine: { speaker: "Brakka", text: "Brakka: Held the bridge, troll ran off, kept the goblins in line till the watch took them." } }
  ];
  const questions = {};
  events.forEach((_, i) => {
    questions[`who_${i}`] = { type: "choice", instructions: `events[${i}].quote is the exact text, events[${i}].summary paraphrases it, events[${i}].noteLine is the whole line around it; noteLine.speaker reported it. Who PERFORMED the act in events[${i}]?`, criteria: ROSTER };
    questions[`witness_${i}`] = { type: "noul", instructions: `events[${i}].noteLine.speaker wrote the line events[${i}] comes from. Was events[${i}].noteLine.speaker only a witness or reporter of the act in events[${i}].quote, with another character performing it?` };
    questions[`dark_${i}`] = { type: "noul", instructions: `Is events[${i}] a morally dark act by the character who did it: killing someone helpless or surrendered, torture, betraying an ally?` };
  });
  const body = await (await post(sim, { model: "jev-latest", state: { roster: Object.keys(ROSTER).map((name) => ({ name })), events }, questions })).json();
  const a = body.answers;
  assert.equal(a.who_0.choice, "Luz", "the heal is Luz's own");
  assert.equal(a.who_1.choice, "Tovin", "the kill she reported is Tovin's");
  assert.equal(a.who_2.choice, "Luz", "the blessing is Luz's own");
  assert.equal(a.who_3.choice, "Tovin");
  assert.equal(a.who_4.choice, "Brakka", "'Held the bridge' names nobody: the line's speaker did it");
  for (const i of [0, 1, 2, 3]) assert.ok(a[`who_${i}`].confidence >= 0.9, `who_${i} is a confident gold answer`);
  assert.ok(a.witness_0.noul < 0.2 && a.witness_2.noul < 0.2, "Luz did her own deeds");
  assert.ok(a.witness_1.noul >= 0.85, "Luz only witnessed the kill");
  assert.ok(a.dark_1.noul >= 0.85, "the kill of a surrendered goblin is dark");
  assert.ok(a.dark_3.noul < 0.2, "torching a troll is not dark just because Tovin is the red character");
  // A deed gold shares between two characters has no single right label: hesitant, below 0.6.
  const shared = await (await post(sim, { model: "jev-latest", state: { events: [{ summary: "Dax and Pell held the narrow pass", quote: "Dax and Pell held the narrow pass" }] }, questions: { who: { type: "choice", instructions: "Who performed events[0]?", criteria: { Oona: null, Dax: null, Pell: null, Sorrel: null, "someone-else": null, "whole-party": null } } } })).json();
  assert.ok(["Dax", "Pell"].includes(shared.answers.who.choice));
  assert.ok(shared.answers.who.confidence < 0.6, `${shared.answers.who.confidence}`);
  // focusSubject: the shortest referenced passage is the subject; a bare-name part is the speaker.
  const sub = focusSubject({ events }, questions.witness_1.instructions);
  assert.equal(sub.speaker, "Luz");
  assert.equal(sub.subject, events[1].quote);
  assert.match(sub.context, /catch Tovin killing/);
});

test("sim-jev: 401 without a bearer key or with the wrong pinned key; 400 on malformed questions; 404/405", async () => {
  const sim = createSimJev({ apiKey: KEY });
  assert.equal((await post(sim, fullRequest(), { key: "" })).status, 401);
  assert.equal((await post(sim, fullRequest(), { key: "wrong" })).status, 401);
  assert.equal((await sim.fetch(`${ENDPOINT}/v1/models`, {})).status, 401);
  const bad = async (questions) => (await post(sim, { model: "jev-latest", state: "s", questions })).status;
  assert.equal(await bad({ a: { type: "choice", instructions: "x", criteria: { only: null } } }), 400);
  assert.equal(await bad({ a: { type: "score", instructions: "x", criteria: { a: 1 } } }), 400);
  assert.equal(await bad({ a: { type: "maybe", instructions: "x" } }), 400);
  assert.equal(await bad({ a: { type: "noul", instructions: "" } }), 400);
  assert.equal(await bad({}), 400);
  assert.equal((await post(sim, null, { raw: "{not json" })).status, 400);
  assert.equal((await sim.fetch(`${ENDPOINT}/v2/whatever`, { method: "POST", headers: { Authorization: `Bearer ${KEY}` } })).status, 404);
  assert.equal((await sim.fetch(`${ENDPOINT}/v1/systemone`, { method: "GET", headers: { Authorization: `Bearer ${KEY}` } })).status, 405);
  assert.deepEqual(validateSystemOneBody(fullRequest()), []);
  assert.ok(sim.stats.unauthorized >= 3 && sim.stats.badRequests >= 6);
});

// ---- determinism --------------------------------------------------------------------------------

async function transcript(seed, faultRate, n = 30) {
  const sim = createSimJev({ seed, faultRate, timeoutFallbackMs: 0 });
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const req = fullRequest();
    req.state.events[1].summary = `variation ${i % 7}`;
    try {
      const response = await post(sim, req);
      out.push(`${response.status}:${await response.text()}`);
    } catch (error) {
      out.push(`throw:${error.name}`);
    }
  }
  return { out, stats: sim.stats };
}

test("sim-jev: the same seed gives byte-identical answers and faults; the source never uses Math.random", async () => {
  const a = await transcript(7, 0.5);
  const b = await transcript(7, 0.5);
  assert.deepEqual(a.out, b.out);
  assert.deepEqual(a.stats.faults, b.stats.faults);
  const c = await transcript(8, 0.5);
  assert.notDeepEqual(a.out, c.out);
  const clean = await transcript(1, 0);
  assert.ok(clean.out.every((line) => line.startsWith("200:")));
  const source = readFileSync(new URL("../tools/nlp-scale/sim-jev.js", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
  assert.ok(!/Math\.random/.test(source));
});

test("sim-jev: faultRate injects the default mix; reset() replays the same run", async () => {
  const sim = createSimJev({ seed: 11, faultRate: 1, timeoutFallbackMs: 0 });
  const kinds = [];
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await post(sim, fullRequest());
      kinds.push(response.status);
    } catch (error) {
      kinds.push(error.name);
    }
  }
  const seen = Object.keys(sim.stats.faults);
  for (const kind of seen) assert.ok(JEV_FAULT_KINDS.includes(kind));
  for (const kind of Object.keys(DEFAULT_JEV_FAULT_WEIGHTS).filter((k) => DEFAULT_JEV_FAULT_WEIGHTS[k] > 1)) assert.ok(seen.includes(kind), `${kind} never injected`);
  assert.ok(!seen.includes("network"), "network is off by default");
  const first = JSON.stringify(sim.stats.faults);
  sim.reset();
  assert.equal(sim.calls.length, 0);
  for (let i = 0; i < 60; i += 1) {
    try {
      await post(sim, fullRequest());
    } catch {
      // timeouts/network reject
    }
  }
  assert.equal(JSON.stringify(sim.stats.faults), first);
});

// ---- each fault ---------------------------------------------------------------------------------

test("sim-jev faults: 500, 503, 429 with Retry-After, malformed JSON, 401, network TypeError", async () => {
  const one = (forceFault, extra = {}) => post(createSimJev({ forceFault, ...extra }), fullRequest());
  assert.equal((await one("http500")).status, 500);
  assert.equal((await one("http503")).status, 503);
  const limited = await one("http429", { retryAfterSeconds: 3 });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "3");
  const malformed = await one("malformed");
  assert.equal(malformed.status, 200);
  const text = await malformed.text();
  assert.ok(text.startsWith("{"));
  assert.throws(() => JSON.parse(text));
  assert.equal((await one("unauthorized")).status, 401);
  await assert.rejects(one("network"), (error) => error instanceof TypeError);
});

test("sim-jev fault: timeout never resolves on its own and rejects with AbortError when the signal fires", async () => {
  const sim = createSimJev({ forceFault: "timeout" });
  const controller = new AbortController();
  const pending = post(sim, fullRequest(), { signal: controller.signal });
  const winner = await Promise.race([pending.then(() => "settled", () => "settled"), new Promise((resolve) => setTimeout(() => resolve("still pending"), 30))]);
  assert.equal(winner, "still pending");
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  const already = new AbortController();
  already.abort();
  await assert.rejects(post(sim, fullRequest(), { signal: already.signal }), (error) => error.name === "AbortError");
  // Without a signal it hangs forever unless the test opts into a fallback.
  const hung = post(createSimJev({ forceFault: "timeout" }), fullRequest());
  const hungWinner = await Promise.race([hung.then(() => "settled", () => "settled"), new Promise((resolve) => setTimeout(() => resolve("still pending"), 20))]);
  assert.equal(hungWinner, "still pending");
  await assert.rejects(post(createSimJev({ forceFault: "timeout", timeoutFallbackMs: 1 }), fullRequest()), (error) => error.name === "AbortError");
});

test("sim-jev: forceFault as a function targets single calls (e.g. fail the first, then recover)", async () => {
  const sim = createSimJev({ forceFault: (i) => (i === 0 ? "http503" : null) });
  assert.equal((await post(sim, fullRequest())).status, 503);
  assert.equal((await post(sim, fullRequest())).status, 200);
  assert.deepEqual(sim.calls.map((c) => c.fault), ["http503", null]);
  assert.deepEqual(sim.calls[1].questions.sort(), Object.keys(fullRequest().questions).sort());
});

// ---- run.mjs arguments ----------------------------------------------------------------------------

test("run.mjs: parseArgs handles --flag value, --flag=value and bare switches", () => {
  assert.deepEqual(parseArgs(["--sim", "--sim-jev", "--jev-fault-rate", "0.2", "--party", "--party-mode=per-pc", "--limit", "5"]), { sim: true, simJev: true, jevFaultRate: "0.2", party: true, partyMode: "per-pc", limit: "5" });
});

test("run.mjs: resolveJevOptions -- clear error without a key, env endpoint, sim defaults, compare defaults, exclusivity", () => {
  assert.deepEqual(resolveJevOptions({}, {}), { mode: "off", compare: false });
  const missing = resolveJevOptions({ jev: true }, {});
  assert.match(missing.error, /TYPESAFE_API_KEY/);
  const real = resolveJevOptions({ jev: true }, { TYPESAFE_API_KEY: " k ", TYPESAFE_BASE_URL: "https://proxy.example/" });
  assert.equal(real.error, undefined);
  assert.equal(real.apiKey, "k");
  assert.equal(real.endpoint, "https://proxy.example");
  assert.equal(real.compare, false);
  assert.equal(resolveJevOptions({ jev: true, compareJev: true }, { TYPESAFE_API_KEY: "k" }).compare, true);
  assert.equal(resolveJevOptions({ jev: true }, { TYPESAFE_API_KEY: "k" }).endpoint, "https://api.typesafe.ai");
  const sim = resolveJevOptions({ simJev: true, jevFaultRate: "0.25" }, {});
  assert.equal(sim.mode, "sim");
  assert.equal(sim.faultRate, 0.25);
  assert.equal(sim.compare, true);
  assert.equal(resolveJevOptions({ simJev: true, noCompareJev: true }, {}).compare, false);
  assert.match(resolveJevOptions({ jev: true, simJev: true }, { TYPESAFE_API_KEY: "k" }).error, /mutually exclusive/);
  assert.deepEqual(jevConfigBlock(sim), { enabled: true, apiKey: "sim-jev-key", endpoint: "https://api.typesafe.ai", model: "jev-latest", timeoutMs: 1000 });
  assert.equal(jevConfigBlock({ mode: "off" }), null);
});

test("run.mjs: a missing jev.js degrades to a note; a present one gets the sim fetch injected", async () => {
  const missing = await loadJevModule(join(tmpdir(), "no-such-dir", "jev.js"));
  assert.equal(missing.module, null);
  assert.match(missing.note, /not present/);
  const none = await createHarnessJev(resolveJevOptions({ simJev: true }, {}), { loader: async () => missing });
  assert.equal(none.client, null);
  assert.equal(none.info.available, false);
  assert.match(none.info.note, /WITHOUT Jev/);

  const seen = [];
  const fakeModule = { createJevClient: (opts) => (seen.push(opts), opts.apiKey ? { ask: async () => ({}), info: {} } : null) };
  const made = await createHarnessJev(resolveJevOptions({ simJev: true, jevFaultRate: "0.1" }, {}), { loader: async () => ({ module: fakeModule, note: null }) });
  assert.ok(made.client && made.sim);
  assert.equal(seen[0].fetchImpl, made.sim.fetch);
  assert.equal(made.info.available, true);
  assert.equal(made.info.faultRate, 0.1);

  const dir = mkdtempSync(join(tmpdir(), "jev-mod-"));
  try {
    writeFileSync(join(dir, "jev.js"), "export const nothing = 1;\n");
    assert.match((await loadJevModule(join(dir, "jev.js"))).note, /no createJevClient/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run.mjs: the ordinary corpus loader skips corpus/party/; the party loader reads it", () => {
  const ordinary = loadCorpus(CORPUS_DIR);
  assert.ok(ordinary.length >= 320);
  assert.ok(ordinary.every((item) => item.category !== "party"));
  assert.ok(loadPartyCorpus(join(CORPUS_DIR, "party")).length >= 20);
});

// ---- lib: Jev measurements and report ----------------------------------------------------------------

const ITEMS = [
  { id: "j-1", category: "fluent-en", lang: "en", notes: "Kesh picked the lock and then failed to climb the wall.", gold: { mustTags: ["thievery"], okTags: ["athletics"], outcome: "failure" } },
  { id: "j-2", category: "red-polarity-worthy", lang: "en", notes: "Kesh finished off the surrendered guard.", gold: { mustTags: ["martial"], okTags: [], redWorthy: true } },
  { id: "j-3", category: "traps", lang: "en", notes: "Next session we plan to raid the vault. Pizza?", gold: { mustTags: [], okTags: [], noEvents: true } }
];

function stubPipeline(calls) {
  return async ({ request, jev }) => {
    calls.push(Boolean(jev));
    const notes = request.notes;
    if (/Pizza/.test(notes)) return { events: [], proposals: [], diagnostics: { stages: [{ attempts: 1, ms: 5 }], ...(jev ? { jev: { enabled: true, ran: ["triage"], calls: 1, ms: 40, skippedChunks: [{ chunk: 0, p: 0.03, text: notes.slice(0, 160) }], overrides: 0, flags: [], errors: [] } } : {}) } };
    if (/lock/.test(notes)) {
      const event = { summary: "Kesh picked the lock and failed the climb", tags: ["thievery"], outcome: jev ? "failure" : "success", ...(jev ? { jev: { outcomeFrom: "success", flags: [] } } : {}) };
      return { events: [event], proposals: [], diagnostics: { stages: [{ attempts: 1, ms: 5 }], ...(jev ? { jev: { enabled: true, ran: ["verify"], calls: 1, ms: 60, skippedChunks: [], overrides: 1, flags: [], errors: [{ step: "rank", kind: "timeout" }] } } : {}) } };
    }
    const event = { summary: "Kesh killed the surrendered guard", tags: ["martial"], outcome: "success", ...(jev ? { themes: ["dark-deed"], jev: { flags: ["dark-act"] } } : {}) };
    return { events: [event], proposals: [], diagnostics: { stages: [{ attempts: 1, ms: 5 }], ...(jev ? { jev: { enabled: true, ran: ["verify"], calls: 1, ms: 20, skippedChunks: [], overrides: 0, flags: ["dark-act"], errors: [] } } : {}) } };
  };
}

test("lib: runScale with a Jev client measures calls, ms, skips, overrides right/wrong, red with vs without, and never records the key", async () => {
  const calls = [];
  const state = await runScale({
    corpus: ITEMS,
    transport: { chat: async () => ({}) },
    pipeline: stubPipeline(calls),
    config: { jev: { enabled: true, apiKey: "SECRET-JEV-KEY" }, apiKey: "SECRET-LLM-KEY" },
    jev: { ask: async () => ({}) },
    compareWithoutJev: true,
    jevInfo: { mode: "sim", faultRate: 0 }
  });
  assert.deepEqual(calls, [true, false, true, false, true, false]);
  const j = state.jevSummary;
  assert.equal(j.runsWithJev, 3);
  assert.equal(j.calls, 3);
  assert.equal(j.msP50, 40);
  assert.equal(j.msP95, 60);
  assert.equal(j.skippedChunks, 1);
  assert.equal(j.triageMisses, 0, "the skipped chunk was a trap, not a miss");
  assert.deepEqual(j.overrides, { total: 1, right: 1, wrong: 0, neutral: 0 });
  assert.equal(j.errors, 1);
  assert.equal(j.red.recall, 1);
  assert.equal(j.without.red.recall, 0);
  assert.equal(j.red.falseRate, 0);
  assert.ok(j.without.scoreWith > j.without.score, `${j.without.scoreWith} vs ${j.without.score}`);
  const json = JSON.stringify(state);
  assert.ok(!json.includes("SECRET-JEV-KEY") && !json.includes("SECRET-LLM-KEY"));
  const md = renderMarkdown(state);
  for (const needle of ["## Jev", "mode **sim**", "3 Jev calls", "1 chunk(s) skipped", "right 1, wrong 0", "With vs without Jev", "| red recall | 100.0% | 0.0% |"]) assert.ok(md.includes(needle), needle);
  assert.ok(!md.includes("SECRET"));
});

test("lib: a run that asked for Jev but got none says so in the report instead of inventing numbers", async () => {
  const state = await runScale({ corpus: ITEMS.slice(0, 1), transport: { chat: async () => ({}) }, pipeline: stubPipeline([]), jevInfo: { mode: "sim", note: "scripts/ai/jev.js is not present in this checkout, so the run went ahead WITHOUT Jev." } });
  const md = renderMarkdown(state);
  assert.ok(md.includes("## Jev"));
  assert.ok(md.includes("WITHOUT Jev"));
  assert.ok(md.includes("no run carried `diagnostics.jev`"));
  const plain = await runScale({ corpus: ITEMS.slice(0, 1), transport: { chat: async () => ({}) }, pipeline: stubPipeline([]) });
  assert.ok(!renderMarkdown(plain).includes("## Jev"), "no Jev section on a plain run");
  assert.equal(plain.jevSummary, undefined);
});

test("lib: jevRepStats judges an override that broke a right outcome as wrong; chunkHeldGold finds triage misses", () => {
  const rep = { events: [{ outcome: "failure", jev: { outcomeFrom: "success", flags: ["outcome-disputed"] } }], proposals: [{ jev: { flags: ["weak-evidence"] } }], diagnostics: { jev: { calls: 2, ms: 10, skippedChunks: [{ chunk: 1, p: 0.05, text: "Kesh picked the lock of the vault" }], errors: [] } } };
  const stats = jevRepStats({ id: "x", category: "c", gold: { mustTags: ["thievery"], okTags: [], outcome: "success" } }, rep);
  assert.deepEqual(stats.overrides, { total: 1, right: 0, wrong: 1, neutral: 0 });
  assert.equal(stats.triageMisses, 1);
  assert.deepEqual(stats.flags, { "outcome-disputed": 1, "weak-evidence": 1 });
  assert.equal(jevRepStats({ gold: {} }, { events: [] }), null);
  assert.equal(chunkHeldGold({ gold: { noEvents: true, mustTags: [] } }, "Kesh picked the lock"), false);
  assert.equal(chunkHeldGold({ category: "party", party: ["Tovin", "Luz"], gold: { perActor: { Tovin: { minEvents: 1, evidence: ["torched a troll"] }, Luz: { minEvents: 0 } } } }, "Tovin: torched a troll"), true);
  assert.equal(chunkHeldGold({ category: "party", party: ["Tovin", "Luz"], gold: { perActor: { Tovin: { minEvents: 1, evidence: ["torched a troll"] }, Luz: { minEvents: 0 } } } }, "GM: pizza money"), false);
  assert.equal(summarizeJev([]).runsWithJev, 0);
});

test("lib: redactConfig hides both keys and drops function hooks", () => {
  const out = redactConfig({ apiKey: "a", jev: { apiKey: "b", enabled: true }, fetchImpl: () => {} });
  assert.equal(out.apiKey, "***");
  assert.equal(out.jev.apiKey, "***");
  assert.equal(out.fetchImpl, undefined);
  assert.equal(redactConfig({ apiKey: "" }).apiKey, "");
});

// ---- browser bundle ------------------------------------------------------------------------------------

test("browser bundle: carries sim-jev, exposes createSimJev, and bundles jev.js only when it exists", () => {
  const { code, modules, extras } = bundle();
  assert.ok(modules.includes("tools/nlp-scale/sim-jev.js"));
  assert.ok(extras.includes("simJev"));
  const fakeWindow = { location: { origin: "http://localhost:11434" }, fetch: () => Promise.reject(new Error("no network")) };
  new Function("window", code)(fakeWindow);
  assert.equal(typeof fakeWindow.NlpScale.createSimJev, "function");
  assert.equal(fakeWindow.NlpScale.createJevClient === null, !extras.includes("jev"));
  const without = bundle({ extraModules: {} });
  assert.deepEqual(without.extras, []);
});
