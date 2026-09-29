import assert from "node:assert/strict";
import test from "node:test";

import { runGatewayPipeline, runProposalStageFor, extractionCacheKey } from "../scripts/ai/pipeline.js";
import { createJevClient, sameName } from "../scripts/ai/jev.js";
import { buildExtractionMessages } from "../scripts/ai/prompts.js";
import { normalizeGatewayConfig } from "../scripts/ai/gateway-config.js";
import { buildAiGatewayRequest, createGatewayAdapter } from "../scripts/ai-gateway.js";
import { attributeEventsToActor } from "../scripts/session-notes.js";
import { makeHarnessActor } from "../tools/nlp-scale/lib.mjs";

// The Jev layer in the pipeline (docs/jev-layer-contract.md): off means byte-for-byte today's
// output; on, every step is fail-open, and the four steps only narrow (triage) or annotate/correct
// above a confidence bar (attribution, verify, rank) -- second opinions on the LLM's own fields.

const KEY = "ts-pipeline-secret-999";

// ---- fakes --------------------------------------------------------------------------------------

function scriptedTransport(replies) {
  const calls = [];
  return {
    calls,
    info: { model: "stub-model", provider: "ollama", endpoint: "http://127.0.0.1:11434" },
    async chat(args) {
      calls.push({ ...args, messages: args.messages.map((m) => ({ ...m })) });
      let reply = replies.length > 1 ? replies.shift() : replies[0];
      if (typeof reply === "function") reply = reply(args, calls.length);
      if (reply instanceof Error) throw reply;
      return { content: typeof reply === "string" ? reply : JSON.stringify(reply), ms: 1, truncated: false };
    }
  };
}

function request(notes, { systemId = "pf2e", name = "Kesh", allowances = 0, party } = {}) {
  const req = buildAiGatewayRequest({ ...makeHarnessActor(systemId), name }, notes, systemId);
  req.actor.grandDesign.availableGrantAllowances = allowances;
  req.actor.grandDesign.classEvolutionAvailable = false;
  if (party) req.party = party;
  return req;
}

const ev = (summary, tags, outcome = "success", extra = {}) => ({ quote: summary, summary, tags, themes: [], outcome, continuesPrevious: false, ...extra });

function skill(name, tags = ["martial", "defense"]) {
  return {
    kind: "skill",
    evidence: [`${name} evidence`],
    entry: {
      name,
      tier: 1,
      system_equivalent: "Skill feat",
      gameItem: { kind: "feat" },
      mechanics: { effect: "Gain +1 to AC against the first Strike each round.", duration: "while wielding a blade", frequency: { max: 1, per: "round" } },
      metadata: { tags, lineage: { operation: "origin", sources: [], rationale: "Earned." } }
    }
  };
}

// Neutral defaults: nothing crosses a bar unless a test says so.
function neutralAnswer(name, q) {
  if (q.type === "noul") return { type: "noul", noul: 0.5 };
  if (q.type === "choice") {
    const label = "unclear" in q.criteria ? "unclear" : Object.keys(q.criteria)[0];
    return { type: "choice", choice: label, confidence: 0.3, probabilities: { [label]: 0.3 } };
  }
  return { type: "score", score: 2, confidence: 0.8, legend: {}, probabilities: {} };
}

// A fake Jev HTTP server behind the REAL client, so the pipeline exercises the wire format too.
// handler(body) -> { questionName: answer } overrides, or a Response/Error to return/throw.
function jevServer(handler = () => ({})) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body, auth: init.headers?.Authorization });
    const out = handler(body, calls.length);
    if (out instanceof Error) throw out;
    if (out instanceof Response) return out;
    const answers = {};
    for (const [name, q] of Object.entries(body.questions)) answers[name] = out?.[name] ?? neutralAnswer(name, q);
    return new Response(JSON.stringify({ model: "jev-latest", answers, usage: {} }), { status: 200 });
  };
  const client = createJevClient({ apiKey: KEY, fetchImpl: fetch, sleep: async () => {} });
  return { client, calls };
}

const JEV_ON = { jev: { enabled: true, apiKey: KEY } };

function strip(result) {
  return JSON.parse(JSON.stringify(result, (key, value) => (key === "totalMs" ? undefined : value)));
}

function stage2Payload(transport) {
  const call = transport.calls.find((c) => /newEvents/.test(c.messages.at(-1).content));
  return call ? { system: call.messages[0].content, payload: JSON.parse(call.messages.at(-1).content) } : null;
}

// ---- fixtures ------------------------------------------------------------------------------------

const KILL = "she catch Tovin killing a goblin that was surrender";
const PARTY_NOTES = [
  `Luz: Tonight Luz heal Brakka full HP after the troll fight, and ${KILL}, not happy about that at all. `.repeat(2),
  "Tovin: torched a troll, lost my pit bet, and apparently read very well by a woman who wants a year of my dreams. ".repeat(2),
  "The bridge is old stone, mossy, with a toll house nobody has manned in a century. ".repeat(3)
].join("\n\n");

const FIXTURES = [
  {
    name: "two-stage with proposals",
    notes: "Kesh parried the guard's blade three times. Mira bound the wound.",
    config: { proposalMode: "always" },
    replies: () => [{ events: [ev("Kesh parried the guard's blade", ["martial", "defense"], "success", { actorName: "Kesh" }), ev("Mira bound the wound", ["medicine"], "success", { actorName: "Mira" })] }, { proposals: [skill("Blade Wall"), skill("Second Wall")] }]
  },
  {
    name: "single pipeline",
    notes: "Tovin torched a troll and lost his pit bet.",
    config: { pipeline: "single" },
    replies: () => [{ events: [ev("Tovin torched a troll", ["fire"], "criticalSuccess", { actorName: "Tovin" })], proposals: [skill("Troll Torch", ["fire"])] }]
  },
  {
    name: "multi-chunk party notes",
    notes: PARTY_NOTES,
    config: { chunkChars: 400, proposalMode: "never" },
    name2: "Luz",
    replies: () => [
      (args) => ({ events: /catch Tovin/.test(args.messages.at(-1).content)
        ? [ev("Luz caught Tovin killing a surrendered goblin", ["perception"], "success", { quote: KILL, actorName: "Luz" })]
        : /torched/.test(args.messages.at(-1).content) ? [ev("Tovin torched a troll", ["fire"], "success", { actorName: "" })] : [] })
    ]
  }
];

async function runFixture(fixture, { config = {}, jev, party } = {}) {
  const transport = scriptedTransport(fixture.replies());
  const req = request(fixture.notes, { name: fixture.name2 ?? "Kesh", party });
  const result = await runGatewayPipeline({ transport, request: req, config: { ...fixture.config, ...config }, jev, sleep: async () => {} });
  return { result, transport };
}

test("Jev disabled or absent => identical pipeline output (deep-equal on fixtures)", async () => {
  const explode = { ask: async () => { throw new Error("Jev must not be called"); }, info: {} };
  for (const fixture of FIXTURES) {
    const { result: baseline, transport: baseT } = await runFixture(fixture);
    assert.equal("jev" in baseline.diagnostics, false, fixture.name);
    for (const variant of [
      { jev: explode },                                            // client, but config.jev off
      { config: { jev: { enabled: true } }, jev: explode },         // enabled without a key -> forced off
      { config: { jev: { enabled: false, apiKey: KEY } }, jev: explode },
      { config: JEV_ON, jev: null }                                  // enabled, but no client
    ]) {
      const { result, transport } = await runFixture(fixture, variant);
      assert.deepEqual(strip(result), strip(baseline), fixture.name);
      assert.deepEqual(transport.calls, baseT.calls, `${fixture.name}: same LLM requests`);
    }
  }
});

test("the extraction prompt is byte-identical without request.party; with one it adds a roster line without example names", () => {
  const base = buildExtractionMessages({ notesChunk: PARTY_NOTES, request: request(PARTY_NOTES), config: {} });
  const none = buildExtractionMessages({ notesChunk: PARTY_NOTES, request: request(PARTY_NOTES, { party: [] }), config: {} });
  const one = buildExtractionMessages({ notesChunk: PARTY_NOTES, request: request(PARTY_NOTES, { party: ["Luz"] }), config: {} });
  assert.deepEqual(none, base);
  assert.deepEqual(one, base, "a party of one adds nothing");
  const party = buildExtractionMessages({ notesChunk: PARTY_NOTES, request: request(PARTY_NOTES, { party: ["Luz", { name: "Tovin" }, " ", "Luz"] }), config: {} });
  assert.equal(party[0].content, base[0].content, "the system prompt never changes");
  assert.match(party[1].content, /^The player characters are "Luz", "Tovin"\. .*performed the act.*\n(NOTES:)/s);
  assert.ok(party[1].content.endsWith(base[1].content));
});

// ---- triage -------------------------------------------------------------------------------------

test("triage skips a chunk Jev is confident holds no action; it never reaches the LLM", async () => {
  const fixture = FIXTURES[2];
  const jev = jevServer((body) => (body.state.passages ? { chunk_2: { type: "noul", noul: 0.03 } } : {}));
  const { result, transport } = await runFixture(fixture, { config: JEV_ON, jev: jev.client });
  assert.equal(result.diagnostics.chunks, 3);
  assert.equal(transport.calls.length, 2, "only the two kept chunks were extracted");
  assert.ok(transport.calls.every((call) => !/toll house/.test(call.messages.at(-1).content)));
  const skipped = result.diagnostics.jev.skippedChunks;
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].chunk, 2);
  assert.equal(skipped[0].p, 0.03);
  assert.ok(skipped[0].text.startsWith("The bridge is old stone") && skipped[0].text.length <= 160);
  assert.ok(result.diagnostics.jev.ran.includes("triage"));
});

test("triage does not run for a single chunk, and a skip-everything answer is ignored", async () => {
  const one = jevServer();
  await runFixture(FIXTURES[0], { config: JEV_ON, jev: one.client });
  assert.ok(one.calls.every((call) => !call.body.state.passages), "no triage request for one chunk");

  const all = jevServer((body) => (body.state.passages ? Object.fromEntries(Object.keys(body.questions).map((n) => [n, { type: "noul", noul: 0 }])) : {}));
  const { result, transport } = await runFixture(FIXTURES[2], { config: JEV_ON, jev: all.client });
  assert.equal(transport.calls.length, 3, "every chunk extracted anyway");
  assert.deepEqual(result.diagnostics.jev.skippedChunks, []);
  assert.ok(result.diagnostics.warnings.some((w) => /skipped every chunk/.test(w)));
});

test("triage threshold comes from config.jev.triageThreshold", async () => {
  const jev = jevServer((body) => (body.state.passages ? { chunk_2: { type: "noul", noul: 0.2 } } : {}));
  const low = await runFixture(FIXTURES[2], { config: JEV_ON, jev: jev.client });
  assert.equal(low.transport.calls.length, 3, "0.2 >= default 0.12 -> kept");
  const high = await runFixture(FIXTURES[2], { config: { jev: { ...JEV_ON.jev, triageThreshold: 0.25 } }, jev: jev.client });
  assert.equal(high.transport.calls.length, 2);
});

// ---- fail-open ----------------------------------------------------------------------------------

const FAULTS = {
  network: () => new TypeError("fetch failed"),
  cors: () => new TypeError("Failed to fetch"),
  http500: () => new Response("{}", { status: 500 }),
  http401: () => new Response(JSON.stringify({ error: { message: `bad key ${KEY}` } }), { status: 401 }),
  shapeNotJson: () => new Response("<html>", { status: 200 }),
  shapeNoAnswers: () => new Response(JSON.stringify({ answers: {} }), { status: 200 })
};

function withoutJev(result) {
  return JSON.parse(JSON.stringify(strip(result), (key, value) => (key === "jev" ? undefined : value)));
}

test("every Jev fault kind fails open: same events/proposals as Jev off, error recorded, nothing thrown", async () => {
  for (const fixture of FIXTURES) {
    const { result: baseline } = await runFixture(fixture);
    for (const [kind, make] of Object.entries(FAULTS)) {
      const jev = jevServer(() => make());
      const { result } = await runFixture(fixture, { config: JEV_ON, jev: jev.client });
      const clean = withoutJev(result);
      assert.deepEqual(clean.events, withoutJev(baseline).events, `${fixture.name} / ${kind}`);
      assert.deepEqual(clean.proposals, withoutJev(baseline).proposals, `${fixture.name} / ${kind}`);
      assert.deepEqual(clean.skippedProposals, withoutJev(baseline).skippedProposals);
      const errors = result.diagnostics.jev.errors;
      assert.ok(errors.length >= 1, `${fixture.name} / ${kind}: error recorded`);
      assert.ok(!JSON.stringify(result).includes(KEY), `${fixture.name} / ${kind}: key never in output`);
    }
  }
});

test("a timeout fails open too", async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const client = createJevClient({ apiKey: KEY, fetchImpl: hang, timeoutMs: 15 });
  const { result: baseline } = await runFixture(FIXTURES[0]);
  const { result } = await runFixture(FIXTURES[0], { config: JEV_ON, jev: client });
  assert.deepEqual(withoutJev(result).events, withoutJev(baseline).events);
  // One timeout ends Jev for the run (2026-09-29): a slow Jev stays slow, so later steps are not asked.
  const kinds = result.diagnostics.jev.errors.map((e) => e.kind);
  assert.deepEqual(kinds, ["timeout"]);
  assert.equal(result.diagnostics.jev.calls, 1);
});

test("a CORS block stops every further Jev call in the run (the block will not clear mid-run)", async () => {
  const jev = jevServer(() => FAULTS.cors());
  const { result: baseline } = await runFixture(FIXTURES[2]);
  const { result } = await runFixture(FIXTURES[2], { config: JEV_ON, jev: jev.client });
  assert.equal(jev.calls.length, 1);
  assert.deepEqual(result.diagnostics.jev.ran, []);
  assert.equal(result.diagnostics.jev.errors[0].kind, "cors");
  assert.deepEqual(withoutJev(result).events, withoutJev(baseline).events);
});

test("a thrown non-Jev error from a custom client also fails open", async () => {
  const weird = { ask: async () => { throw new RangeError("boom"); }, info: { model: "x" } };
  const { result } = await runFixture(FIXTURES[0], { config: JEV_ON, jev: weird });
  assert.equal(result.events.length, 2);
  assert.equal(result.diagnostics.jev.errors[0].message, "boom");
});

test("a fatal 401 stops every further Jev call in the run and is recorded once", async () => {
  const jev = jevServer(() => FAULTS.http401());
  const { result } = await runFixture(FIXTURES[2], { config: JEV_ON, jev: jev.client });
  assert.equal(jev.calls.length, 1, "triage 401'd; attribution/verify/rank never asked");
  assert.equal(result.diagnostics.jev.calls, 1);
  assert.equal(result.diagnostics.jev.errors.length, 1);
  assert.equal(result.diagnostics.jev.errors[0].fatal, true);
  assert.equal(result.diagnostics.jev.errors[0].status, 401);
  assert.deepEqual(result.diagnostics.jev.ran, []);
  assert.ok(!JSON.stringify(result).includes(KEY));
});

// ---- attribution --------------------------------------------------------------------------------

function tovinServer(confidence = 0.92, witness = 0.95, extra = () => ({})) {
  return jevServer((body) => {
    if (!body.state.roster) return extra(body);
    const out = {};
    body.state.events.forEach((event, i) => {
      if (/catch Tovin killing/.test(event.quote)) {
        out[`who_${i}`] = { type: "choice", choice: "Tovin", confidence, probabilities: { Tovin: confidence } };
        out[`witness_${i}`] = { type: "noul", noul: witness };
      } else if (/torched/.test(event.quote)) {
        out[`who_${i}`] = { type: "choice", choice: "Tovin", confidence: 0.9, probabilities: { Tovin: 0.9 } };
      }
    });
    return out;
  });
}

test("board 6ca3c8e7: a deed reported in another player's line is credited to its doer when Jev is confident", async () => {
  const jev = tovinServer();
  const { result } = await runFixture(FIXTURES[2], { config: JEV_ON, jev: jev.client });
  const kill = result.events.find((event) => /goblin/.test(event.summary));
  assert.equal(kill.actorName, "Tovin");
  assert.equal(kill.jev.actorName, "Tovin");
  assert.equal(kill.jev.actorFrom, "Luz");
  assert.equal(kill.jev.actorConfidence, 0.92);
  assert.equal(kill.jev.witnessOnly, 0.95);
  assert.equal(kill.jev.whole, false);
  assert.equal("actor" in kill.jev, false, "field name pinned to actorName");
  assert.deepEqual(result.diagnostics.jev.overrides.filter((o) => o.field === "actorName"), [
    { event: 0, field: "actorName", from: "Luz", to: "Tovin", confidence: 0.92 },
    { event: 1, field: "actorName", from: null, to: "Tovin", confidence: 0.9 }
  ], "the witness correction, and the empty actorName on 'torched a troll' filled");
  assert.equal(result.diagnostics.jev.routed, 2);
  // The roster was derived from the notes' speaker labels (no request.party needed), and Jev was
  // shown the quote plus the whole speaker-labelled line.
  const attribution = jev.calls.find((call) => call.body.state.roster);
  assert.deepEqual(attribution.body.state.roster.map((p) => p.name).sort(), ["Luz", "Tovin"]);
  assert.equal(attribution.body.state.events[0].noteLine.speaker, "Luz");
  assert.match(attribution.body.state.events[0].noteLine.text, /catch Tovin killing/);
  assert.ok(result.diagnostics.jev.ran.includes("attribution"));
});

test("an explicit request.party is the roster; with no second name in sight attribution is not asked", async () => {
  const explicit = tovinServer();
  await runFixture(FIXTURES[2], { config: JEV_ON, jev: explicit.client, party: ["Luz", { name: "Tovin", aliases: ["Tov"] }, "Brakka"] });
  const call = explicit.calls.find((c) => c.body.state.roster);
  assert.deepEqual(call.body.state.roster, [{ name: "Luz" }, { name: "Tovin", aliases: ["Tov"] }, { name: "Brakka" }]);

  const solo = jevServer();
  const fixture = { ...FIXTURES[0], replies: () => [{ events: [ev("Kesh parried the guard's blade", ["martial"], "success", { actorName: "Kesh" })] }, { proposals: [] }] };
  await runFixture(fixture, { config: JEV_ON, jev: solo.client });
  assert.ok(solo.calls.every((c) => !c.body.state.roster), "roster = [Kesh] only");
});

test("attribution below 0.6 confidence leaves the LLM's actorName alone", async () => {
  const { result } = await runFixture(FIXTURES[2], { config: JEV_ON, jev: tovinServer(0.55).client });
  const kill = result.events.find((event) => /goblin/.test(event.summary));
  assert.equal(kill.actorName, "Luz");
  assert.equal(kill.jev.actorName, "Tovin");
  assert.equal(kill.jev.actorConfidence, 0.55);
  assert.equal(kill.jev.actorFrom, undefined);
});

test("attribution does not override when Jev itself says the speaker was not a witness; it flags instead", async () => {
  const { result } = await runFixture(FIXTURES[2], { config: JEV_ON, jev: tovinServer(0.9, 0.2).client });
  const kill = result.events.find((event) => /goblin/.test(event.summary));
  assert.equal(kill.actorName, "Luz");
  assert.deepEqual(kill.jev.flags, ["actor-disputed"]);
  // Board ab855163: the per-character split used to honour the confident-but-disputed Jev name
  // anyway, silently moving the deed the pipeline had decided to leave on Luz's sheet.
  assert.ok(attributeEventsToActor(result.events, ["Luz"], { notes: PARTY_NOTES }).kept.some((event) => /goblin/.test(event.summary)), "Luz keeps it");
  assert.ok(!attributeEventsToActor(result.events, ["Tovin"], { notes: PARTY_NOTES }).kept.some((event) => /goblin/.test(event.summary)), "Tovin's sheet does not take a disputed deed");
  // The undisputed override still travels: the same fixture with Jev agreeing the speaker witnessed it.
  const { result: fixed } = await runFixture(FIXTURES[2], { config: JEV_ON, jev: tovinServer(0.9, 0.95).client });
  assert.ok(attributeEventsToActor(fixed.events, ["Tovin"], { notes: PARTY_NOTES }).kept.some((event) => /goblin/.test(event.summary)));
  assert.ok(!attributeEventsToActor(fixed.events, ["Luz"], { notes: PARTY_NOTES }).kept.some((event) => /goblin/.test(event.summary)));
});

test("board ab855163: a roster derived from the notes lists single characters -- an LLM 'Dax and Pell' is split, never a label", async () => {
  const jev = jevServer();
  const fixture = {
    ...FIXTURES[0],
    notes: "Dax and Pell held the narrow pass while Oona scouted ahead.",
    replies: () => [{ events: [ev("Dax and Pell held the narrow pass", ["defense"], "success", { actorName: "Dax and Pell" }), ev("Oona scouted ahead", ["stealth"], "success", { actorName: "Oona" })] }, { proposals: [] }]
  };
  await runFixture(fixture, { config: JEV_ON, jev: jev.client });
  const call = jev.calls.find((c) => c.body.state.roster);
  assert.ok(call, "attribution was asked");
  assert.deepEqual(call.body.state.roster.map((p) => p.name), ["Kesh", "Dax", "Pell", "Oona"]);
  assert.ok(!Object.keys(call.body.questions.who_0.criteria).some((label) => /\band\b/.test(label)), "no compound label");
});

test("attribution can be switched off by config.jev.attribution", async () => {
  const jev = tovinServer();
  const { result } = await runFixture(FIXTURES[2], { config: { jev: { ...JEV_ON.jev, attribution: false } }, jev: jev.client });
  assert.equal(result.events.find((e) => /goblin/.test(e.summary)).actorName, "Luz");
  assert.ok(jev.calls.every((call) => !call.body.state.roster));
});

test("things done TO a character (actorRole target) get neither attribution nor verification", async () => {
  const jev = jevServer();
  const fixture = {
    ...FIXTURES[0],
    replies: () => [{ events: [
      ev("A smuggler tried to recruit Kesh", ["deception"], "success", { actorName: "Kesh", actorRole: "target" }),
      ev("Mira bound the wound", ["medicine"], "success", { actorName: "Mira" })
    ] }, { proposals: [] }]
  };
  const { result } = await runFixture(fixture, { config: JEV_ON, jev: jev.client });
  // Main already routes a "target" entry to skippedEvents at coercion; the pipeline's own guard
  // (jevAnnotateEvents skips actorRole "target") is the backstop for any path that keeps one.
  assert.equal(result.events.length, 1);
  assert.ok(result.skippedEvents.some((s) => /recruit/.test(s.event?.summary ?? s.summary ?? "")));
  let asked = 0;
  for (const call of jev.calls) {
    if (!call.body.state.events) continue;
    asked += 1;
    assert.equal(call.body.state.events.length, 1);
    assert.match(call.body.state.events[0].summary, /Mira/);
    if (call.body.state.roster) assert.deepEqual(call.body.state.roster.map((p) => p.name).sort(), ["Kesh", "Mira"]);
  }
  assert.ok(asked >= 2, "attribution and verify both ran, over Mira's event only");
  assert.ok(result.events[0].jev);
});

test("sameName: full name first, first-token only when one side is a single token", () => {
  assert.ok(sameName("Tovin", "tovin"));
  assert.ok(sameName("Tovin Ashgrave", "tovin ashgrave"));
  assert.ok(sameName("Tovin", "Tovin Ashgrave"));
  assert.ok(sameName("Tovin Ashgrave", "Tovin"));
  assert.ok(!sameName("Tovin Ash", "Tovin Reed"));
  assert.ok(!sameName("Tovin", "Tovina"));
  assert.ok(!sameName("", "Tovin"));
  assert.ok(sameName("Zoë", "Zoe"));
});

// ---- extraction cache ---------------------------------------------------------------------------

test("with the extraction cache, a second run re-annotates a fresh copy: nothing is applied twice, triage skips replay", async () => {
  const fixture = FIXTURES[2];
  const transport = scriptedTransport(fixture.replies());
  const jev = tovinServer(0.92, 0.95, (body) => (body.state.passages ? { chunk_2: { type: "noul", noul: 0.03 } } : {}));
  const adapter = createGatewayAdapter({ chunkChars: 400, proposalMode: "never", ...JEV_ON }, { transportFactory: () => transport, jevFactory: () => jev.client });
  const luz = { ...makeHarnessActor("dnd5e"), name: "Luz" };
  const tovin = { ...makeHarnessActor("dnd5e"), name: "Tovin" };
  const first = await adapter({ actor: luz, notes: PARTY_NOTES, systemId: "dnd5e" });
  const second = await adapter({ actor: tovin, notes: PARTY_NOTES, systemId: "dnd5e" });
  assert.equal(transport.calls.length, 2, "two kept chunks, read once");
  assert.equal(first.gatewayDiagnostics.extractionCache, "miss");
  assert.equal(second.gatewayDiagnostics.extractionCache, "hit");
  for (const result of [first, second]) {
    const kill = result.events.find((event) => /goblin/.test(event.summary));
    assert.equal(kill.actorName, "Tovin");
    assert.equal(kill.jev.actorFrom, "Luz", "applied once: the cached copy still says Luz");
    assert.equal(result.gatewayDiagnostics.jev.routed, 2);
    assert.deepEqual(result.gatewayDiagnostics.jev.skippedChunks.map((s) => s.chunk), [2]);
  }
  assert.ok(first.gatewayDiagnostics.jev.ran.includes("triage"));
  assert.ok(second.gatewayDiagnostics.jev.ran.includes("triage:cached") && !second.gatewayDiagnostics.jev.ran.includes("triage"));
  const overrides = (r) => r.gatewayDiagnostics.jev.overrides.filter((o) => o.field === "actorName").length;
  assert.equal(overrides(first), 2);
  assert.equal(overrides(second), 2);

  // A Jev-off adapter over the same transport must not be served the triaged reading.
  const cfg = normalizeGatewayConfig({ chunkChars: 400 });
  const keyOff = extractionCacheKey({ notes: PARTY_NOTES, systemId: "dnd5e", cfg });
  const keyOn = extractionCacheKey({ notes: PARTY_NOTES, systemId: "dnd5e", cfg: normalizeGatewayConfig({ chunkChars: 400, ...JEV_ON }) });
  const keyNoTriage = extractionCacheKey({ notes: PARTY_NOTES, systemId: "dnd5e", cfg: normalizeGatewayConfig({ chunkChars: 400, jev: { ...JEV_ON.jev, triage: false } }) });
  assert.notEqual(keyOff, keyOn);
  assert.equal(keyOff, keyNoTriage, "without triage the reading is the same for everyone");
});

// ---- verify -------------------------------------------------------------------------------------

function verifyServer({ outcome = "criticalSuccess", confidence = 0.9, darkP = 0.2 } = {}) {
  return jevServer((body) => {
    if (!body.state.events || body.state.roster) return {};
    const out = {};
    body.state.events.forEach((_, i) => {
      if (i !== 0) return;
      out[`outcome_${i}`] = { type: "choice", choice: outcome, confidence, probabilities: { [outcome]: confidence } };
      out[`dark_${i}`] = { type: "noul", noul: darkP };
    });
    return out;
  });
}

test("verify overrides the LLM outcome at or above overrideConfidence and records outcomeFrom", async () => {
  const { result } = await runFixture(FIXTURES[0], { config: JEV_ON, jev: verifyServer({ confidence: 0.9 }).client });
  const event = result.events[0];
  assert.equal(event.outcome, "criticalSuccess");
  assert.equal(event.jev.outcomeFrom, "success");
  assert.equal(event.jev.outcome, "criticalSuccess");
  assert.deepEqual(event.jev.flags, []);
  assert.ok(result.diagnostics.jev.overrides.some((o) => o.field === "outcome" && o.from === "success" && o.to === "criticalSuccess"));
  assert.equal(result.events[1].jev.outcome, "unclear", "Jev's reading is recorded even when it changes nothing");
});

test("verify below overrideConfidence only flags outcome-disputed; the threshold is configurable both ways", async () => {
  const low = await runFixture(FIXTURES[0], { config: JEV_ON, jev: verifyServer({ confidence: 0.8 }).client });
  assert.equal(low.result.events[0].outcome, "success");
  assert.deepEqual(low.result.events[0].jev.flags, ["outcome-disputed"]);
  assert.equal(low.result.events[0].jev.outcome, "criticalSuccess");
  assert.equal(low.result.events[0].jev.outcomeFrom, undefined);

  const strict = await runFixture(FIXTURES[0], { config: { jev: { ...JEV_ON.jev, overrideConfidence: 0.95 } }, jev: verifyServer({ confidence: 0.9 }).client });
  assert.equal(strict.result.events[0].outcome, "success");
  assert.deepEqual(strict.result.events[0].jev.flags, ["outcome-disputed"]);

  const lax = await runFixture(FIXTURES[0], { config: { jev: { ...JEV_ON.jev, overrideConfidence: 0.7 } }, jev: verifyServer({ confidence: 0.8 }).client });
  assert.equal(lax.result.events[0].outcome, "criticalSuccess");
});

test("a confident dark-act on a darkDeed:none event is a flag + theme the red check is handed, never a vice of Jev's own", async () => {
  const { result, transport } = await runFixture(FIXTURES[0], { config: JEV_ON, jev: verifyServer({ outcome: "success", darkP: 0.9 }).client });
  const event = result.events[0];
  assert.deepEqual(event.jev.flags, ["dark-act"]);
  assert.ok(event.themes.includes("dark-deed"));
  assert.equal(event.jev.darkP, 0.9);
  assert.equal(event.darkDeed, "none", "no invented vice");
  assert.equal(event.darkSeverity, "none");
  assert.ok(result.diagnostics.jev.flags.some((f) => f.flag === "dark-act"));
  // The red check's input (stage 2's newEvents) carries the flag, and the instruction tells the model what it means.
  const stage2 = stage2Payload(transport);
  assert.deepEqual(stage2.payload.newEvents[0].jevFlags, ["dark-act"]);
  assert.match(stage2.system, /jevFlags include "dark-act"/);
  assert.match(stage2.system, /Red check, BEFORE any proposal/);

  const mild = await runFixture(FIXTURES[0], { config: JEV_ON, jev: verifyServer({ outcome: "success", darkP: 0.6 }).client });
  assert.equal(mild.result.events[0].themes.includes("dark-deed"), false);
  assert.equal(stage2Payload(mild.transport).payload.newEvents[0].jevFlags, undefined);
  assert.doesNotMatch(stage2Payload(mild.transport).system, /jevFlags/, "no flag, no extra instruction");

  const noRed = await runFixture(FIXTURES[0], { config: { ...JEV_ON, allowRed: false }, jev: verifyServer({ outcome: "success", darkP: 0.99 }).client });
  assert.equal(noRed.result.events[0].themes.includes("dark-deed"), false);
});

test("an event the LLM already marked dark keeps its vice and severity whatever Jev says", async () => {
  const fixture = { ...FIXTURES[0], replies: () => [{ events: [ev("Kesh killed the surrendered guard", ["martial"], "success", { actorName: "Kesh", darkDeed: "cruelty", darkSeverity: "serious" })] }, { proposals: [] }] };
  for (const darkP of [0.05, 0.99]) {
    const { result } = await runFixture(fixture, { config: JEV_ON, jev: verifyServer({ outcome: "success", darkP }).client });
    const event = result.events[0];
    assert.equal(event.darkDeed, "cruelty");
    assert.equal(event.darkSeverity, "serious");
    assert.deepEqual(event.jev.flags, [], `darkP ${darkP}: no dark-act flag on an already signalled event`);
    assert.equal(event.themes.includes("dark-deed"), false);
    assert.equal(event.jev.darkP, darkP);
  }
});

// ---- rank ---------------------------------------------------------------------------------------

test("rank orders proposals by grounded + fit, annotates each, flags weak evidence, never drops", async () => {
  const jev = jevServer((body) => (body.state.proposals ? {
    grounded_0: { type: "score", score: 0.5, confidence: 0.8, legend: {}, probabilities: {} },
    fit_0: { type: "score", score: 1, confidence: 0.8, legend: {}, probabilities: {} },
    grounded_1: { type: "score", score: 3, confidence: 0.9, legend: {}, probabilities: {} },
    fit_1: { type: "score", score: 2, confidence: 0.9, legend: {}, probabilities: {} }
  } : {}));
  const { result } = await runFixture(FIXTURES[0], { config: JEV_ON, jev: jev.client });
  assert.deepEqual(result.proposals.map((p) => p.entry.name), ["Second Wall", "Blade Wall"]);
  assert.deepEqual(result.proposals[0].jev, { grounded: 3, fit: 2 });
  assert.deepEqual(result.proposals[1].jev, { grounded: 0.5, fit: 1, flags: ["weak-evidence"] });
  assert.ok(result.diagnostics.jev.ran.includes("rank"));
  assert.equal(typeof result.diagnostics.jev.ms, "number");
  assert.ok(result.diagnostics.jev.calls >= 2);
  // Rank sees the deeds stage 2 saw: this character's own (Mira's is not among them).
  const rank = jev.calls.find((c) => c.body.state.proposals);
  assert.deepEqual(rank.body.state.deeds.map((d) => d.actor), ["Kesh"]);
});

// ---- runProposalStageFor ------------------------------------------------------------------------

test("runProposalStageFor == main's presetEvents path: same proposals, always two-stage, Jev ranks", async () => {
  const fixture = FIXTURES[0];
  const { result: full } = await runFixture(fixture);
  const transport = scriptedTransport([{ proposals: [skill("Blade Wall"), skill("Second Wall")] }]);
  const half = await runProposalStageFor({ transport, request: request(fixture.notes), events: full.events, config: { ...fixture.config, pipeline: "single" } });
  assert.deepEqual(half.proposals, full.proposals);
  assert.deepEqual(Object.keys(half).sort(), ["diagnostics", "proposals", "skippedProposals"]);
  assert.equal(half.diagnostics.pipeline, "two-stage");
  assert.equal(half.diagnostics.extractionCache, "preset");
  assert.equal(transport.calls.length, 1);
  assert.equal("jev" in half.diagnostics, false);

  const jev = jevServer((body) => (body.state.proposals ? { grounded_0: { type: "score", score: 0, confidence: 1, legend: {}, probabilities: {} } } : {}));
  const ranked = await runProposalStageFor({ transport: scriptedTransport([{ proposals: [skill("Blade Wall")] }]), request: request("x"), events: [ev("a", ["martial"], "success", { actorName: "Kesh" })], config: { proposalMode: "always", ...JEV_ON }, jev: jev.client });
  assert.deepEqual(ranked.proposals[0].jev.flags, ["weak-evidence"]);
  assert.deepEqual(ranked.diagnostics.jev.ran, ["rank"], "recorded events get no second opinion, only ranking");
});

test("runProposalStageFor honours shouldPropose gating and, like Suggest proposals, re-throws a provider failure", async () => {
  const gated = await runProposalStageFor({ transport: scriptedTransport([new Error("no call expected")]), request: request("x"), events: [ev("a", ["martial"])], config: {} });
  assert.deepEqual(gated.proposals, []);
  assert.equal(gated.diagnostics.proposalStage.ran, false);
  await assert.rejects(runProposalStageFor({ transport: scriptedTransport([new Error("model died")]), request: request("x"), events: [ev("a", ["martial"])], config: { proposalMode: "always" } }), /model died/);
});

// ---- adapter ------------------------------------------------------------------------------------

test("createGatewayAdapter builds the Jev client only with a key, exposes .jev, redacts both keys and never sends a redacted one", () => {
  const seen = [];
  const factory = (opts) => { seen.push(opts); return { ask: async () => ({ answers: {} }), ping: async () => ({ ok: true }), info: {} }; };
  const off = createGatewayAdapter({ jev: { enabled: true } }, { transportFactory: () => scriptedTransport([]), jevFactory: factory });
  assert.equal(off.jev, null);
  assert.equal(seen.length, 0);

  const on = createGatewayAdapter({ jev: { enabled: true, apiKey: KEY, timeoutMs: 3000 } }, { transportFactory: () => scriptedTransport([]), jevFactory: factory });
  assert.ok(on.jev);
  assert.equal(seen[0].apiKey, KEY);
  assert.equal(seen[0].timeoutMs, 3000);
  assert.ok(!JSON.stringify(on.config).includes(KEY));
  assert.equal(on.config.jev.apiKey, "********");
  assert.equal(on.config.jev.enabled, true);

  // api.js rebuilds adapters from .config: with the live client handed over Jev survives; with the
  // default factory the redacted key is never sent.
  const kept = createGatewayAdapter({ ...on.config, apiKey: "" }, { transportFactory: () => scriptedTransport([]), jevFactory: () => on.jev });
  assert.equal(kept.jev, on.jev);
  const lost = createGatewayAdapter({ ...on.config, apiKey: "" }, { transportFactory: () => scriptedTransport([]) });
  assert.equal(lost.jev, null);

  const broken = createGatewayAdapter({ jev: { enabled: true, apiKey: KEY } }, { transportFactory: () => scriptedTransport([]), jevFactory: () => { throw new Error("nope"); } });
  assert.equal(broken.jev, null, "a factory that throws just means no Jev");
});
