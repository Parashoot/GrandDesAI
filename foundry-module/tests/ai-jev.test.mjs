import assert from "node:assert/strict";
import test from "node:test";

import {
  JEV_BATCH_SIZE,
  JEV_DEFAULTS,
  JevError,
  attributeEvents,
  createJevClient,
  findNoteLine,
  noteLines,
  rankProposals,
  triageChunks,
  verifyEvents
} from "../scripts/ai/jev.js";
import { GATEWAY_DEFAULTS, normalizeGatewayConfig, normalizeJevConfig } from "../scripts/ai/gateway-config.js";

// The Jev client speaks TypeSafe's HTTP API directly (docs/jev-layer-contract.md), so these tests pin
// the wire format against a fake fetch: what is sent, what is retried, what is fatal, and that the
// key never escapes the closure.

const KEY = "ts-secret-key-123";

function json(body, status = 200, headers = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

// Answers every question in a request with a plausible default, overridable per question name.
function autoAnswers(questions, overrides = {}) {
  const answers = {};
  for (const [name, q] of Object.entries(questions)) {
    if (overrides[name]) { answers[name] = overrides[name]; continue; }
    if (q.type === "noul") answers[name] = { type: "noul", noul: 0.9 };
    else if (q.type === "choice") {
      const label = Object.keys(q.criteria)[0];
      answers[name] = { type: "choice", choice: label, confidence: 0.9, probabilities: { [label]: 0.9 } };
    } else answers[name] = { type: "score", score: 2, confidence: 0.8, legend: {}, probabilities: {} };
  }
  return answers;
}

// A fake Jev server. `script` is a list of responders (Response | Error | fn(body, call) -> Response);
// the last one repeats. Every call is recorded with its parsed body.
function fakeFetch(script = [(body) => json({ model: "jev-latest", answers: autoAnswers(body.questions), usage: { input_tokens: 10, output_tokens: 2 } })]) {
  const calls = [];
  const queue = [...script];
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, init, body });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    const out = typeof next === "function" ? next(body, calls.length) : next;
    if (out instanceof Error) throw out;
    // A repeating scripted Response must be readable on every call.
    return out instanceof Response ? out.clone() : out;
  };
  return { fetch, calls };
}

function client(fetch, extra = {}) {
  const sleeps = [];
  const c = createJevClient({ apiKey: KEY, fetchImpl: fetch, sleep: async (ms) => { sleeps.push(ms); }, ...extra });
  return { c, sleeps };
}

const NOUL = { q: { type: "noul", instructions: "Is it raining?" } };

// ---- construction -------------------------------------------------------------------------------

test("createJevClient returns null without an API key (Jev is simply off)", () => {
  assert.equal(createJevClient({}), null);
  assert.equal(createJevClient({ apiKey: "" }), null);
  assert.equal(createJevClient({ apiKey: "   " }), null);
  assert.equal(createJevClient({ apiKey: 42 }), null);
});

test("the key is not a property, not in info, not in JSON of the client", () => {
  const { c } = client(fakeFetch().fetch);
  assert.deepEqual(c.info, { endpoint: "https://api.typesafe.ai", model: "jev-latest" });
  assert.ok(!JSON.stringify(c).includes(KEY));
  assert.ok(!JSON.stringify(c.info).includes(KEY));
  for (const key of Object.keys(c)) assert.ok(!String(c[key]).includes(KEY), key);
});

// ---- wire format --------------------------------------------------------------------------------

test("ask POSTs {model, state, questions} to /v1/systemone with Bearer auth and JSON content type", async () => {
  const f = fakeFetch();
  const { c } = client(f.fetch, { endpoint: "https://jev.example.test/", model: "jev-2" });
  const result = await c.ask({ state: { x: 1 }, questions: NOUL });
  assert.equal(f.calls.length, 1);
  const { url, init, body } = f.calls[0];
  assert.equal(url, "https://jev.example.test/v1/systemone");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.ok(init.signal, "a timeout signal is attached");
  assert.deepEqual(body, { model: "jev-2", state: { x: 1 }, questions: NOUL });
  assert.equal(result.answers.q.noul, 0.9);
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 2 });
  assert.ok(Number.isFinite(result.ms));
});

test("ping GETs /v1/models without a body and returns the model names", async () => {
  const f = fakeFetch([json({ models: [{ name: "jev-latest", description: "", release_date: "2026-01-01" }, { name: "jev-1" }] })]);
  const { c } = client(f.fetch);
  const res = await c.ping();
  assert.equal(res.ok, true);
  assert.deepEqual(res.models, ["jev-latest", "jev-1"]);
  assert.equal(f.calls[0].url, "https://api.typesafe.ai/v1/models");
  assert.equal(f.calls[0].init.method, "GET");
  assert.equal(f.calls[0].init.body, undefined);
  assert.equal(f.calls[0].init.headers["Content-Type"], undefined);
});

test("ping never throws: a failure comes back as { ok:false, error, kind } without the key", async () => {
  const { c } = client(fakeFetch([json({ error: { message: `bad key ${KEY}` } }, 401)]).fetch);
  const res = await c.ping();
  assert.equal(res.ok, false);
  assert.equal(res.kind, "http");
  assert.equal(res.status, 401);
  assert.ok(!JSON.stringify(res).includes(KEY));
});

test("ask rejects empty questions and malformed score/choice criteria before any network call", async () => {
  const f = fakeFetch();
  const { c } = client(f.fetch);
  await assert.rejects(c.ask({ state: "s", questions: {} }), (e) => e instanceof JevError && e.kind === "shape");
  await assert.rejects(c.ask({ state: "s", questions: { s: { type: "score", criteria: ["only one"] } } }), JevError);
  await assert.rejects(c.ask({ state: "s", questions: { s: { type: "choice", criteria: ["a", "b"] } } }), JevError);
  assert.equal(f.calls.length, 0);
});

// ---- retries ------------------------------------------------------------------------------------

test("5xx is retried twice with 500 ms doubling backoff, then succeeds", async () => {
  const f = fakeFetch([json({}, 503), json({}, 502), (body) => json({ answers: autoAnswers(body.questions) })]);
  const { c, sleeps } = client(f.fetch);
  const res = await c.ask({ state: "s", questions: NOUL });
  assert.equal(res.answers.q.noul, 0.9);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(sleeps, [500, 1000]);
});

test("429/408 honour Retry-After, capped at 10 s", async () => {
  const f = fakeFetch([json({}, 429, { "retry-after": "2" }), json({}, 408, { "retry-after": "120" }), (body) => json({ answers: autoAnswers(body.questions) })]);
  const { c, sleeps } = client(f.fetch);
  await c.ask({ state: "s", questions: NOUL });
  assert.deepEqual(sleeps, [2000, 10000]);
});

test("a 5xx that persists throws JevError kind http after max retries", async () => {
  const f = fakeFetch([json({ error: { message: "overloaded" } }, 500)]);
  const { c } = client(f.fetch);
  await assert.rejects(c.ask({ state: "s", questions: NOUL }), (e) => e instanceof JevError && e.kind === "http" && e.status === 500 && !e.fatal && /overloaded/.test(e.message));
  assert.equal(f.calls.length, 3);
});

test("400 is not retried", async () => {
  const f = fakeFetch([json({ detail: "bad questions" }, 400)]);
  const { c } = client(f.fetch);
  await assert.rejects(c.ask({ state: "s", questions: NOUL }), (e) => e.status === 400 && e.fatal === false);
  assert.equal(f.calls.length, 1);
});

test("401 and 403 are fatal, not retried, and the message never contains the key", async () => {
  for (const status of [401, 403]) {
    const f = fakeFetch([json({ error: { message: `invalid key ${KEY}` } }, status)]);
    const { c } = client(f.fetch);
    await assert.rejects(c.ask({ state: "s", questions: NOUL }), (e) => {
      assert.ok(e instanceof JevError);
      assert.equal(e.fatal, true);
      assert.equal(e.kind, "http");
      assert.equal(e.status, status);
      assert.ok(!e.message.includes(KEY));
      return true;
    });
    assert.equal(f.calls.length, 1);
  }
});

test("an error body that echoes the key is scrubbed", async () => {
  const f = fakeFetch([json({ error: { message: `Authorization: Bearer ${KEY} is not allowed here` } }, 422)]);
  const { c } = client(f.fetch);
  await assert.rejects(c.ask({ state: "s", questions: NOUL }), (e) => !e.message.includes(KEY) && e.message.includes("***"));
});

// ---- transport failures -------------------------------------------------------------------------

test("a browser CORS failure (TypeError: Failed to fetch) is kind cors with a proxy hint, not retried", async () => {
  for (const message of ["Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed"]) {
    const f = fakeFetch([new TypeError(message)]);
    const { c } = client(f.fetch);
    await assert.rejects(c.ask({ state: "s", questions: NOUL }), (e) => e instanceof JevError && e.kind === "cors" && /CORS/.test(e.message) && /proxy/.test(e.message));
    assert.equal(f.calls.length, 1);
  }
});

test("a Node network error is kind network", async () => {
  const { c } = client(fakeFetch([new TypeError("fetch failed")]).fetch);
  await assert.rejects(c.ask({ state: "s", questions: NOUL }), (e) => e.kind === "network" && !e.fatal);
});

test("a stalled server is kind timeout (AbortController)", async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  const { c } = client(hang, { timeoutMs: 20 });
  await assert.rejects(c.ask({ state: "s", questions: NOUL }), (e) => e instanceof JevError && e.kind === "timeout");
});

test("a non-JSON body or a missing answer is kind shape", async () => {
  const { c } = client(fakeFetch([new Response("<html>gateway</html>", { status: 200 })]).fetch);
  await assert.rejects(c.ask({ state: "s", questions: NOUL }), (e) => e.kind === "shape");
  const { c: c2 } = client(fakeFetch([json({ answers: {} })]).fetch);
  await assert.rejects(c2.ask({ state: "s", questions: NOUL }), (e) => e.kind === "shape");
  const { c: c3 } = client(fakeFetch([json({ answers: { q: { type: "noul", noul: "yes" } } })]).fetch);
  await assert.rejects(c3.ask({ state: "s", questions: NOUL }), (e) => e.kind === "shape");
});

// ---- helpers: request shapes ----------------------------------------------------------------------

test("triageChunks: one noul per chunk, batched <= 12, self-contained instructions, threshold applied", async () => {
  const chunks = Array.from({ length: 14 }, (_, i) => `Passage ${i}: Kesh fought a goblin.`);
  const f = fakeFetch([(body) => {
    const overrides = {};
    for (const name of Object.keys(body.questions)) overrides[name] = { type: "noul", noul: name === "chunk_1" ? 0.05 : 0.7 };
    return json({ answers: autoAnswers(body.questions, overrides) });
  }]);
  const { c } = client(f.fetch);
  const res = await triageChunks(c, chunks, { threshold: 0.12 });
  assert.equal(f.calls.length, 2, "12 + 2");
  assert.equal(Object.keys(f.calls[0].body.questions).length, JEV_BATCH_SIZE);
  assert.equal(f.calls[0].body.state.passages.length, 12);
  assert.equal(f.calls[1].body.state.passages[0], chunks[12]);
  const q = f.calls[0].body.questions.chunk_3;
  assert.equal(q.type, "noul");
  assert.match(q.instructions, /passages\[3\]/);
  assert.ok(q.criteria.true && q.criteria.false);
  assert.equal(res.keep.length, 14);
  assert.equal(res.keep[1], false);
  assert.equal(res.keep[13], false, "chunk_1 of the second batch too");
  assert.equal(res.keep[0], true);
  assert.equal(res.p[0], 0.7);
});

const EMBER = [
  "Tovin: Tovin's night: torched a troll, lost my pit bet. Also I may have quietly tidied up a loose end on the bridge — don't ask Luz about it.",
  "",
  "Luz: Tonight Luz heal Brakka full HP after the troll fight, and she catch Tovin killing a goblin that was surrender, not happy about that at all."
].join("\n");

test("noteLines / findNoteLine recover the speaker label of the line an event quote came from", () => {
  const lines = noteLines(EMBER);
  assert.deepEqual(lines.map((l) => l.speaker), ["Tovin", "Luz"]);
  assert.equal(findNoteLine({ quote: "she catch Tovin killing a goblin that was surrender" }, lines).speaker, "Luz");
  assert.equal(findNoteLine({ quote: "torched a troll" }, lines).speaker, "Tovin");
  assert.equal(findNoteLine({ quote: "" , summary: "" }, lines), null);
  assert.equal(noteLines("Loot: 40 gp\nDay 3: we rode")[0].speaker, null, "topic labels are not speakers");
});

test("attributeEvents asks who PERFORMED the act, with the quote and the speaker-labelled line in state", async () => {
  const f = fakeFetch([(body) => json({ answers: autoAnswers(body.questions, {
    who_0: { type: "choice", choice: "Tovin", confidence: 0.93, probabilities: { Tovin: 0.93, Luz: 0.05 } },
    witness_0: { type: "noul", noul: 0.96 }
  }) })]);
  const { c } = client(f.fetch);
  const events = [{ summary: "Luz caught Tovin killing a surrendered goblin", quote: "she catch Tovin killing a goblin that was surrender", actorName: "Luz" }];
  const res = await attributeEvents(c, events, { roster: ["Luz", { name: "Tovin", aliases: ["Tov"] }, "Brakka"], notes: EMBER });
  const { state, questions } = f.calls[0].body;
  assert.equal(state.events[0].noteLine.speaker, "Luz");
  assert.match(state.events[0].noteLine.text, /catch Tovin killing/);
  assert.equal(state.events[0].quote, events[0].quote);
  assert.equal("actorName" in state.events[0], false, "the LLM's guess is not shown to Jev");
  assert.deepEqual(state.roster, [{ name: "Luz" }, { name: "Tovin", aliases: ["Tov"] }, { name: "Brakka" }]);
  const who = questions.who_0;
  assert.equal(who.type, "choice");
  assert.deepEqual(Object.keys(who.criteria), ["Luz", "Tovin", "Brakka", "someone-else", "whole-party"]);
  for (const description of Object.values(who.criteria)) assert.ok(typeof description === "string" && description.length > 20);
  assert.match(who.criteria.Tovin, /also called Tov/);
  assert.match(who.instructions, /PERFORMED/);
  assert.match(who.instructions, /events\[0\]/);
  assert.match(who.instructions, /NOT necessarily/);
  // Example names could be in a real roster and bias the choice, so the instructions use none.
  assert.doesNotMatch(who.instructions, /Luz|Tovin/);
  assert.equal(questions.witness_0.type, "noul");
  assert.deepEqual(res[0], { actorName: "Tovin", whole: false, choice: "Tovin", confidence: 0.93, probabilities: { Tovin: 0.93, Luz: 0.05 }, speaker: "Luz", witnessOnly: 0.96 });
});

test("attributeEvents: no speaker -> no witness question; whole-party / someone-else map to actorName null", async () => {
  const f = fakeFetch([(body) => json({ answers: autoAnswers(body.questions, {
    who_0: { type: "choice", choice: "whole-party", confidence: 0.8, probabilities: {} },
    who_1: { type: "choice", choice: "someone-else", confidence: 0.7, probabilities: {} }
  }) })]);
  const { c } = client(f.fetch);
  const res = await attributeEvents(c, [{ summary: "we crossed the river", quote: "we crossed the river" }, { summary: "the mayor paid us", quote: "the mayor paid us" }], { roster: ["Luz", "Tovin"], notes: "we crossed the river\nthe mayor paid us" });
  assert.equal(f.calls[0].body.questions.witness_0, undefined);
  assert.equal(res[0].whole, true);
  assert.equal(res[0].actorName, null);
  assert.equal(res[0].witnessOnly, null);
  assert.equal(res[1].choice, "someone-else");
  assert.equal(res[1].actorName, null);
});

test("attributeEvents batches 30 events into 3 requests of <= 12", async () => {
  const f = fakeFetch();
  const { c } = client(f.fetch);
  const events = Array.from({ length: 30 }, (_, i) => ({ summary: `deed ${i}`, quote: `deed ${i}` }));
  const res = await attributeEvents(c, events, { roster: ["Luz", "Tovin"], notes: "" });
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls.map((call) => call.body.state.events.length), [12, 12, 6]);
  assert.equal(res.length, 30);
});

test("verifyEvents: outcome choice with described labels; dark-act noul only when allowRed", async () => {
  const f = fakeFetch([(body) => json({ answers: autoAnswers(body.questions, {
    outcome_0: { type: "choice", choice: "criticalSuccess", confidence: 0.91, probabilities: { criticalSuccess: 0.91 } },
    dark_0: { type: "noul", noul: 0.88 }
  }) })]);
  const { c } = client(f.fetch);
  const events = [{ summary: "Tovin killed a goblin", quote: "nat 20, killed the surrendered goblin", outcome: "success", consequence: "Luz is upset" }];
  const res = await verifyEvents(c, events, { allowRed: true });
  const { state, questions } = f.calls[0].body;
  assert.deepEqual(Object.keys(questions.outcome_0.criteria), ["criticalSuccess", "success", "failure", "criticalFailure", "unclear"]);
  assert.equal(state.events[0].consequence, "Luz is upset");
  assert.equal("outcome" in state.events[0], false, "the LLM's outcome is not shown to Jev");
  assert.match(questions.dark_0.instructions, /surrendered/);
  assert.deepEqual(res[0], { outcome: "criticalSuccess", outcomeConfidence: 0.91, outcomeProbabilities: { criticalSuccess: 0.91 }, darkP: 0.88 });

  const f2 = fakeFetch();
  const { c: c2 } = client(f2.fetch);
  const res2 = await verifyEvents(c2, events, { allowRed: false });
  assert.equal(f2.calls[0].body.questions.dark_0, undefined);
  assert.equal(res2[0].darkP, null);
});

test("rankProposals: two 0-3 score questions per proposal over the character's deeds", async () => {
  const f = fakeFetch([(body) => json({ answers: autoAnswers(body.questions, {
    grounded_0: { type: "score", score: 0.4, confidence: 0.7, legend: {}, probabilities: {} },
    fit_0: { type: "score", score: 2.5, confidence: 0.9, legend: {}, probabilities: {} }
  }) })]);
  const { c } = client(f.fetch);
  const proposals = [{ kind: "skill", evidence: ["held the bridge"], entry: { name: "Bridgewarden", gameItem: { kind: "reaction" }, mechanics: { effect: "Gain resistance." }, metadata: { tags: ["defense"] } } }];
  const res = await rankProposals(c, proposals, { events: [{ summary: "held the bridge", actorName: "Brakka", outcome: "success" }, { summary: "won in the pit", outcome: "success" }], actor: { name: "Brakka", level: 3, systemClass: "Fighter" } });
  const { state, questions } = f.calls[0].body;
  assert.deepEqual(state.character, { name: "Brakka", class: "Fighter", level: 3 });
  assert.equal(state.deeds[0].actor, "Brakka");
  assert.equal(state.deeds[1].actor, "Brakka", "a deed without actorName is the character's own");
  assert.match(questions.grounded_0.instructions, /character's own deed/);
  assert.equal(state.proposals[0].name, "Bridgewarden");
  assert.equal(questions.grounded_0.type, "score");
  assert.equal(questions.grounded_0.criteria.length, 4);
  assert.equal(questions.fit_0.criteria.length, 4);
  assert.match(questions.grounded_0.instructions, /proposals\[0\]/);
  assert.deepEqual(res[0], { grounded: 0.4, fit: 2.5, confidence: 0.7 });
});

test("helpers throw JevError on failure (the pipeline decides what failure means)", async () => {
  const { c } = client(fakeFetch([json({}, 500)]).fetch);
  await assert.rejects(triageChunks(c, ["a", "b"]), JevError);
  await assert.rejects(verifyEvents(c, [{ summary: "x" }]), JevError);
  await assert.rejects(attributeEvents(c, [{ summary: "x" }], { roster: [] }), (e) => e.kind === "shape");
});

// ---- config -------------------------------------------------------------------------------------

test("GATEWAY_DEFAULTS.jev carries the contract defaults and JEV_DEFAULTS mirrors it", () => {
  assert.deepEqual({ ...GATEWAY_DEFAULTS.jev }, {
    enabled: false, apiKey: "", endpoint: "https://api.typesafe.ai", model: "jev-latest", timeoutMs: 10000,
    triage: true, attribution: true, verify: true, rank: true, triageThreshold: 0.12, overrideConfidence: 0.85
  });
  assert.equal(JEV_DEFAULTS, GATEWAY_DEFAULTS.jev);
});

test("normalizeGatewayConfig always adds jev; without a key it is disabled", () => {
  assert.deepEqual(normalizeGatewayConfig({}).jev, { ...GATEWAY_DEFAULTS.jev });
  assert.equal(normalizeGatewayConfig({ jev: { enabled: true } }).jev.enabled, false, "no key -> forced off");
  assert.equal(normalizeGatewayConfig({ jev: { enabled: true, apiKey: "  " } }).jev.enabled, false);
  assert.equal(normalizeGatewayConfig({ jev: { enabled: true, apiKey: " k " } }).jev.enabled, true);
  assert.equal(normalizeGatewayConfig({ jev: { enabled: true, apiKey: " k " } }).jev.apiKey, "k");
  for (const bad of [null, 5, "on", [], true]) assert.deepEqual(normalizeGatewayConfig({ jev: bad }).jev, { ...GATEWAY_DEFAULTS.jev });
});

test("normalizeJevConfig clamps thresholds and timeout and drops unknown keys", () => {
  const jev = normalizeJevConfig({ apiKey: "k", enabled: "true", timeoutMs: 5, triageThreshold: 3, overrideConfidence: -1, endpoint: "https://p.example/jev///", model: "", bogus: 1, triage: "false" });
  assert.equal(jev.timeoutMs, 1000);
  assert.equal(normalizeJevConfig({ timeoutMs: 1e9 }).timeoutMs, 60000);
  assert.equal(jev.triageThreshold, 1);
  assert.equal(jev.overrideConfidence, 0);
  assert.equal(jev.endpoint, "https://p.example/jev");
  assert.equal(jev.model, "jev-latest");
  assert.equal(jev.enabled, true);
  assert.equal(jev.triage, false);
  assert.equal("bogus" in jev, false);
  const hook = async () => {};
  assert.equal(normalizeJevConfig({ fetchImpl: hook }).fetchImpl, hook);
});

test("a jev sub-config never changes any other normalized key", () => {
  for (const partial of [{}, { temperature: 9, pipeline: "SINGLE" }, { proposalMode: "always", customSynonyms: '{"a":"craft"}' }]) {
    const { jev: _a, ...without } = normalizeGatewayConfig(partial);
    const { jev: _b, ...withJev } = normalizeGatewayConfig({ ...partial, jev: { enabled: true, apiKey: "k", timeoutMs: 2000 } });
    assert.deepEqual(withJev, without);
  }
});
