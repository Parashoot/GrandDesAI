import assert from "node:assert/strict";
import test from "node:test";

// Board 6ca3c8e7 / a48d97c0 / c284b5ec (ember-road s1): the doer of a deed is named on every event,
// stage 1 is read once per party instead of once per character, and a follow-up line never moves a
// deed from one character to another.
import { createExtractionCache, mergeFollowUpEvents, runGatewayPipeline } from "../scripts/ai/pipeline.js";
import { coerceActorName, coerceEvent } from "../scripts/ai/normalize.js";
import { buildExtractionMessages } from "../scripts/ai/prompts.js";
import { EVENT_ITEM_SCHEMA } from "../scripts/ai/schemas.js";
import { buildAiGatewayRequest, createGatewayAdapter } from "../scripts/ai-gateway.js";
import { attributeEventsToActor } from "../scripts/session-notes.js";
import { makeHarnessActor } from "../tools/nlp-scale/lib.mjs";

const RECAP = [
  "Luz: healed Brakka after the ambush. I catch Tovin killing a goblin that was surrender. not ok",
  "Tovin: torched the troll, tidied up a loose end ;)"
].join("\n");

const ev = (summary, actorName, extra = {}) => ({ quote: summary, actorName, continuesPrevious: false, summary, tags: [], themes: ["x"], outcome: "success", dangerGap: "none", ...extra });

function countingTransport(reply) {
  const calls = [];
  return {
    calls,
    info: { model: "stub-model", provider: "ollama", endpoint: "http://127.0.0.1:11434" },
    async chat(args) {
      calls.push(args);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { content: JSON.stringify(typeof reply === "function" ? reply(args, calls.length) : reply), ms: 1, truncated: false };
    }
  };
}

function actor(name, systemId = "dnd5e") {
  return { ...makeHarnessActor(systemId), name };
}

test("coerceActorName: pronouns and placeholders are 'not stated'; every group spelling is 'the party'", () => {
  for (const value of ["I", "me", "unknown", "N/A", "the GM", "someone", "?", "", null]) assert.equal(coerceActorName(value), "", String(value));
  for (const value of ["we", "Us", "the whole party", "everyone", "el grupo", "nous"]) assert.equal(coerceActorName(value), "the party", value);
  assert.equal(coerceActorName("\"Tovin.\""), "Tovin");
  assert.equal(coerceEvent(ev("Tovin killed the goblin.", "they")).event.actorName, undefined);
});

test("actorName is required and decided right after the quote", () => {
  assert.ok(EVENT_ITEM_SCHEMA.required.includes("actorName"));
  assert.deepEqual(Object.keys(EVENT_ITEM_SCHEMA.properties).slice(0, 2), ["quote", "actorName"]);
});

test("the extraction prompt no longer names the analysed character, so one party recap reads the same for everyone", () => {
  const a = buildExtractionMessages({ notesChunk: RECAP, request: buildAiGatewayRequest(actor("Luz"), RECAP, "dnd5e"), config: {} });
  const b = buildExtractionMessages({ notesChunk: RECAP, request: buildAiGatewayRequest(actor("Tovin"), RECAP, "dnd5e"), config: {} });
  assert.deepEqual(a, b);
  assert.match(a[0].content, /belongs to the DOER/);
  assert.match(a[0].content, /Never soften a deed/);
});

test("a follow-up flagged on a different character's line is not folded into the previous event", () => {
  const merged = mergeFollowUpEvents([
    ev("Luz healed Brakka.", "Luz"),
    ev("Tovin killed a goblin that had surrendered.", "Tovin", { continuesPrevious: true }),
    ev("The goblin's friends fled.", "", { continuesPrevious: true })
  ]);
  const events = merged.events ?? merged;
  assert.equal(events.length, 2);
  assert.equal(events[1].actorName, "Tovin");
});

test("a follow-up that lands on the party or on someone the previous event names still folds", () => {
  const party = mergeFollowUpEvents([
    ev("Tovin broke the captured scout's will.", "Tovin"),
    ev("The party got the camp location.", "the party", { continuesPrevious: true })
  ]);
  assert.equal((party.events ?? party).length, 1);
  const recipient = mergeFollowUpEvents([
    ev("Brin carried Holt two miles on her back.", "Brin"),
    ev("Holt's fever broke.", "Holt", { continuesPrevious: true })
  ]);
  const folded = recipient.events ?? recipient;
  assert.equal(folded.length, 1);
  assert.equal(folded[0].actorName, "Brin");
});

test("a deed Luz reports about Tovin is credited to Tovin and not to Luz", () => {
  const events = [ev("Luz healed Brakka.", "Luz"), ev("Tovin killed a goblin that had surrendered.", "Tovin"), ev("Tovin torched the troll.", "Tovin")];
  const tovin = attributeEventsToActor(events, ["Tovin"], { notes: RECAP });
  const luz = attributeEventsToActor(events, ["Luz"], { notes: RECAP });
  assert.deepEqual(tovin.kept.map((e) => e.summary), ["Tovin killed a goblin that had surrendered.", "Tovin torched the troll."]);
  assert.deepEqual(luz.kept.map((e) => e.summary), ["Luz healed Brakka."]);
});

test("one adapter reads identical notes once for the whole party; stage 2 still runs per character", async () => {
  const transport = countingTransport((args) => (args.schema?.properties?.events
    ? { events: [ev("Tovin torched the troll.", "Tovin")] }
    : { proposals: [] }));
  const adapter = createGatewayAdapter({ proposalMode: "never" }, { transportFactory: () => transport });
  const [first, second] = await Promise.all([
    adapter({ actor: actor("Luz"), notes: RECAP, systemId: "dnd5e" }),
    adapter({ actor: actor("Tovin"), notes: RECAP, systemId: "dnd5e" })
  ]);
  const third = await adapter({ actor: actor("Brakka"), notes: RECAP, systemId: "dnd5e" });
  assert.equal(transport.calls.length, 1, "concurrent and later callers share one extraction");
  assert.deepEqual([first, second, third].map((r) => r.gatewayDiagnostics.extractionCache).sort(), ["hit", "hit", "miss"]);
  assert.equal(third.events[0].actorName, "Tovin");
  // Cached results are copies: one sheet editing its events must not leak into the next.
  third.events[0].summary = "changed";
  const fourth = await adapter({ actor: actor("Wick"), notes: RECAP, systemId: "dnd5e" });
  assert.equal(fourth.events[0].summary, "Tovin torched the troll.");

  await adapter({ actor: actor("Wick"), notes: RECAP, systemId: "dnd5e", fresh: true });
  assert.equal(transport.calls.length, 2, "fresh: true re-reads the notes");
  await adapter({ actor: actor("Wick"), notes: `${RECAP}\nWick: lost my dagger to the river`, systemId: "dnd5e" });
  assert.equal(transport.calls.length, 3, "different notes are a different reading");
});

test("the cache is off at 0 entries, and a failed extraction is never cached", async () => {
  const transport = countingTransport({ events: [ev("Tovin torched the troll.", "Tovin")] });
  const off = createGatewayAdapter({ proposalMode: "never", extractionCacheEntries: 0 }, { transportFactory: () => transport });
  await off({ actor: actor("Luz"), notes: RECAP, systemId: "dnd5e" });
  const again = await off({ actor: actor("Tovin"), notes: RECAP, systemId: "dnd5e" });
  assert.equal(transport.calls.length, 2);
  assert.equal(again.gatewayDiagnostics.extractionCache, "off");

  const cache = createExtractionCache();
  await assert.rejects(cache.run("k", async () => { throw new Error("boom"); }));
  assert.equal(cache.size, 0);
  await cache.run("k", async () => ({ cacheable: false }));
  assert.equal(cache.size, 0, "a partial reading (a chunk failed) is retried by the next character");
});

test("the extraction cache expires by TTL and evicts the oldest entry past maxEntries", async () => {
  let t = 0;
  const cache = createExtractionCache({ maxEntries: 2, ttlMs: 100, now: () => t });
  await cache.run("a", async () => ({}));
  await cache.run("b", async () => ({}));
  await cache.run("c", async () => ({}));
  assert.equal(cache.size, 2);
  assert.equal((await cache.run("a", async () => ({}))).hit, false);
  t = 500;
  assert.equal(cache.size, 0);
});

test("pipeline single mode never uses the shared cache (its one call also writes per-character proposals)", async () => {
  const transport = countingTransport({ events: [ev("Tovin torched the troll.", "Tovin")], proposals: [] });
  const cache = createExtractionCache();
  const req = buildAiGatewayRequest(actor("Tovin"), RECAP, "dnd5e");
  const result = await runGatewayPipeline({ transport, request: req, config: { pipeline: "single" }, systemId: "dnd5e", extractionCache: cache });
  assert.equal(result.diagnostics.extractionCache, "off");
  assert.equal(cache.size, 0);
});

test("with red allowed, stage 2 must fill a per-event redCheck before its proposals; without, the field is absent", async () => {
  const { proposalSchemaCapped } = await import("../scripts/ai/schemas.js");
  const on = proposalSchemaCapped(3, { redCheck: true });
  assert.deepEqual(Object.keys(on.properties), ["redCheck", "proposals"]);
  assert.deepEqual(on.required, ["redCheck", "proposals"]);
  assert.ok(on.properties.redCheck.items.properties.vice.enum.includes("bloodlust"));
  assert.deepEqual(Object.keys(proposalSchemaCapped(3).properties), ["proposals"]);
});

test("redCheck verdicts reach the diagnostics, with a warning when a flagged deed got no red proposal", async () => {
  const { readRedCheck } = await import("../scripts/ai/pipeline.js");
  assert.deepEqual(readRedCheck({ redCheck: [{ event: "a", vice: "none" }, { event: "b", vice: "Cruelty" }, { event: "c", vice: "made-up" }] }), [{ event: "b", vice: "cruelty" }]);
  assert.deepEqual(readRedCheck({ proposals: [] }), []);

  const standard = { kind: "skill", evidence: ["Tovin torched a troll"], entry: { name: "Pyre: Troll Torch", tier: 1, system_equivalent: "feat", gameItem: { kind: "feat" }, mechanics: { effect: "Once per short rest, add 1d6 fire damage to a spell that deals fire damage.", duration: "instant", frequency: { max: 1, per: "encounter" } }, metadata: { tags: ["fire"] } } };
  const schemas = [];
  const transport = countingTransport((args) => {
    schemas.push(args.schema);
    return args.schema?.properties?.events
      ? { events: [ev("Tovin killed a goblin that had surrendered.", "Tovin", { themes: ["killing-the-surrendered"] })] }
      : { redCheck: [{ event: "Tovin killed a goblin that had surrendered.", vice: "bloodlust" }], proposals: [standard] };
  });
  const result = await runGatewayPipeline({ transport, request: buildAiGatewayRequest(actor("Tovin"), RECAP, "dnd5e"), config: { proposalMode: "always" }, systemId: "dnd5e" });
  assert.ok(schemas[1].properties.redCheck, "stage 2 schema carries redCheck");
  assert.match(transport.calls[1].messages[0].content, /fill "redCheck"/);
  assert.deepEqual(result.diagnostics.redCheck, [{ event: "Tovin killed a goblin that had surrendered.", vice: "bloodlust" }]);
  assert.ok(result.diagnostics.warnings.some((w) => /no red proposal/.test(w)));

  const noRed = countingTransport((args) => (args.schema?.properties?.events ? { events: [ev("Tovin torched a troll.", "Tovin")] } : { proposals: [] }));
  await runGatewayPipeline({ transport: noRed, request: buildAiGatewayRequest(actor("Tovin"), RECAP, "dnd5e"), config: { proposalMode: "always", allowRed: false }, systemId: "dnd5e" });
  assert.equal(noRed.calls[1].schema.properties.redCheck, undefined);
});

test("stage 2 only sees the analysed character's events: Tovin's kill never reaches Luz's proposals", async () => {
  const sent = [];
  const transport = countingTransport((args) => {
    if (args.schema?.properties?.events) return { events: [ev("Luz healed Brakka.", "Luz"), ev("Tovin killed a goblin that had surrendered.", "Tovin"), ev("The party drove off the troll.", "the party")] };
    sent.push(JSON.parse(args.messages[1].content).newEvents.map((e) => e.summary));
    return { redCheck: [], proposals: [] };
  });
  const result = await runGatewayPipeline({ transport, request: buildAiGatewayRequest(actor("Luz"), RECAP, "dnd5e"), config: { proposalMode: "always" }, systemId: "dnd5e" });
  assert.deepEqual(sent[0], ["Luz healed Brakka.", "The party drove off the troll."]);
  assert.equal(result.events.length, 3, "the returned events stay whole; api.js attributes them");
  assert.deepEqual(result.diagnostics.proposalEvents, { own: 2, total: 3 });
});

test("presetEvents (Suggest proposals) skip stage 1 and propose from the recorded events", async () => {
  const transport = countingTransport((args) => {
    assert.ok(!args.schema?.properties?.events, "no extraction call");
    return { redCheck: [], proposals: [] };
  });
  const recorded = [ev("Maren healed Brakka.", "Maren"), ev("Maren sold out of honey.", "Maren")];
  const adapter = createGatewayAdapter({ proposalMode: "always" }, { transportFactory: () => transport });
  const out = await adapter({ actor: actor("Maren"), notes: "GM REQUEST: suggest proposals for Maren now.", events: recorded, systemId: "dnd5e" });
  // 2 calls: the stage-2 call, then one "propose something else" turn because the GM asked and the
  // model answered with nothing (live regression 2026-09-29). Still no extraction call.
  assert.equal(transport.calls.length, 2);
  assert.deepEqual(JSON.parse(transport.calls[0].messages[1].content).newEvents.map((e) => e.summary), ["Maren healed Brakka.", "Maren sold out of honey."]);
  assert.equal(out.gatewayDiagnostics.extractionCache, "preset");
});

test("a party roster reaches the extraction prompt and shares one reading across the party (board e54491dd)", async () => {
  const transport = countingTransport((args) => (args.schema?.properties?.events
    ? { events: [ev("Tovin torched the troll.", "Tovin")] }
    : { proposals: [] }));
  const adapter = createGatewayAdapter({ proposalMode: "never" }, { transportFactory: () => transport });
  const party = ["Brakka", "Tovin", "Luz"];
  await adapter({ actor: actor("Luz"), notes: RECAP, systemId: "dnd5e", party });
  await adapter({ actor: actor("Tovin"), notes: RECAP, systemId: "dnd5e", party });
  assert.equal(transport.calls.length, 1, "one reading for the party");
  const user = transport.calls[0].messages.find((m) => m.role === "user").content;
  assert.match(user, /The player characters are "Brakka", "Tovin", "Luz"/);
  // Without a roster the prompt is the old one (and a different cache entry).
  await adapter({ actor: actor("Wick"), notes: RECAP, systemId: "dnd5e" });
  assert.equal(transport.calls.length, 2);
  assert.doesNotMatch(transport.calls[1].messages.find((m) => m.role === "user").content, /player characters are/);
});
