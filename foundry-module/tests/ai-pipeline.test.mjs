import assert from "node:assert/strict";
import test from "node:test";

import {
  chunkNotes,
  coerceFrequency,
  normalizeDiceFormula,
  preprocessNotes,
  repairProposal,
  runGatewayPipeline,
  shouldPropose
} from "../scripts/ai/pipeline.js";
import { EVENT_EXTRACTION_SCHEMA, PROPOSAL_SCHEMA, COMBINED_SCHEMA } from "../scripts/ai/schemas.js";
import { ModelJsonError } from "../scripts/ai/json-repair.js";
import { AiProviderTimeoutError, AiProviderUnreachableError } from "../scripts/ai/transport.js";
import { buildAiGatewayRequest } from "../scripts/ai-gateway.js";
import { validateGrowthEvent } from "../scripts/progression.js";
import { validateClassEntry, validateSkillEntry } from "../scripts/validator.js";
import { makeHarnessActor } from "../tools/nlp-scale/lib.mjs";

// A transport stub: each chat() call pops the next scripted reply. A reply is a string (content),
// an Error (thrown), or a function (call) => string|Error. Every call is recorded for assertions on
// what the pipeline actually SENT (prompts, schema, temperature).
function scriptedTransport(replies) {
  const calls = [];
  return {
    calls,
    info: { model: "stub-model", provider: "ollama" },
    async chat(args) {
      calls.push({ ...args, messages: args.messages.map((m) => ({ ...m })) });
      let reply = replies.length > 1 ? replies.shift() : replies[0];
      if (typeof reply === "function") reply = reply(args, calls.length);
      if (reply instanceof Error) throw reply;
      if (reply && typeof reply === "object" && "content" in reply) return { ms: 1, ...reply };
      return { content: typeof reply === "string" ? reply : JSON.stringify(reply), ms: 1, truncated: false };
    }
  };
}

function request(notes, { systemId = "pf2e", allowances = 0, classEvolution = false, registry = {} } = {}) {
  const req = buildAiGatewayRequest(makeHarnessActor(systemId, { registry }), notes, systemId);
  req.actor.grandDesign.availableGrantAllowances = allowances;
  req.actor.grandDesign.classEvolutionAvailable = classEvolution;
  return req;
}

const ev = (summary, tags, outcome = "success", extra = {}) => ({ quote: summary, summary, tags, themes: [], outcome, dangerGap: "none", ...extra });

function skillProposal(overrides = {}) {
  return {
    kind: "skill",
    evidence: ["Kesh parried three times"],
    entry: {
      name: "Blade Wall",
      tier: 1,
      system_equivalent: "Skill feat",
      gameItem: { kind: "feat" },
      mechanics: { effect: "Gain +1 to AC against the first Strike each round.", duration: "while wielding a blade", frequency: { max: 1, per: "round" } },
      metadata: { tags: ["martial", "defense"], lineage: { operation: "origin", sources: [], rationale: "Parried a lot." } },
      ...overrides
    }
  };
}

const NOTES = "Kesh parried the guard's blade. Mira bound the wound.";

// ---- preprocessing / chunking ------------------------------------------------------------------

test("preprocessNotes normalizes bullets, CRLF and zero-width characters but keeps the words", () => {
  const out = preprocessNotes("• Kesh fought\r\n* Mira sang​\r\n\r\n\r\n\r\n– Tovin hid   ");
  assert.equal(out, "- Kesh fought\n- Mira sang\n\n- Tovin hid");
});

test("chunkNotes never exceeds maxChars and keeps short notes as one chunk", () => {
  assert.deepEqual(chunkNotes("short", 2400), ["short"]);
  assert.deepEqual(chunkNotes("", 2400), []);
  const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} about Kesh fighting a goblin.`).join(" ");
  const chunks = chunkNotes(long, 400);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 400, chunk.length);
  assert.equal(chunks.join(" ").replace(/\s+/g, " "), long.replace(/\s+/g, " "), "chunking loses no text");
});

test("chunkNotes prefers paragraph boundaries", () => {
  const para = (n) => `Paragraph ${n}. ` + "word ".repeat(60).trim() + ".";
  const chunks = chunkNotes([para(1), para(2), para(3)].join("\n\n"), 400);
  assert.ok(chunks.every((chunk) => /^Paragraph \d/.test(chunk)));
});

test("chunkNotes hard-splits a single unbroken token run", () => {
  const chunks = chunkNotes("x".repeat(1000), 400);
  assert.ok(chunks.every((chunk) => chunk.length <= 400));
  assert.equal(chunks.join(""), "x".repeat(1000));
});

// ---- two-stage happy path ----------------------------------------------------------------------

test("two-stage: extract then propose, returning validated events and proposals", async () => {
  const transport = scriptedTransport([
    { events: [ev("Kesh parried the guard's blade.", ["martial", "defense"]), ev("Mira bound the wound.", ["medicine"])] },
    { proposals: [skillProposal()] }
  ]);
  const result = await runGatewayPipeline({ transport, request: request(NOTES, { allowances: 1 }), config: {} });
  assert.equal(result.events.length, 2);
  for (const event of result.events) {
    assert.deepEqual(validateGrowthEvent(event).errors, []);
    assert.equal(event.source, "adapter");
  }
  assert.equal(result.proposals.length, 1);
  assert.deepEqual(validateSkillEntry(result.proposals[0].entry).errors, []);
  assert.equal(transport.calls.length, 2);
  assert.deepEqual(transport.calls[0].schema, EVENT_EXTRACTION_SCHEMA);
  assert.deepEqual(transport.calls[1].schema, PROPOSAL_SCHEMA);
});

test("the extraction prompt carries the notes verbatim and the allowed tag list", async () => {
  const transport = scriptedTransport([{ events: [] }]);
  const notes = "Ο Γιώργος πολέμησε με το σπαθί του — and then lol nat 20";
  await runGatewayPipeline({ transport, request: request(notes), config: { proposalMode: "never" } });
  const text = transport.calls[0].messages.map((m) => m.content).join("\n");
  assert.ok(text.includes(notes));
  for (const tag of ["martial", "stealth", "summoning"]) assert.ok(text.includes(tag), tag);
});

test("extraction temperature stays <= 0.3 even with a hot config", async () => {
  const transport = scriptedTransport([{ events: [] }]);
  await runGatewayPipeline({ transport, request: request(NOTES), config: { temperature: 1.2, proposalMode: "never" } });
  assert.ok(transport.calls[0].temperature <= 0.3);
});

test("numPredict is sent as maxTokens", async () => {
  const transport = scriptedTransport([{ events: [] }]);
  await runGatewayPipeline({ transport, request: request(NOTES), config: { numPredict: 1234, proposalMode: "never" } });
  assert.equal(transport.calls[0].maxTokens, 1234);
});

test("diagnostics carry model, provider, pipeline, chunks, per-stage attempts and timing", async () => {
  const transport = scriptedTransport([{ events: [ev("Kesh fought.", ["martial"])] }]);
  const { diagnostics } = await runGatewayPipeline({ transport, request: request(NOTES), config: { proposalMode: "never" } });
  assert.equal(diagnostics.model, "stub-model");
  assert.equal(diagnostics.provider, "ollama");
  assert.equal(diagnostics.pipeline, "two-stage");
  assert.equal(diagnostics.chunks, 1);
  assert.equal(diagnostics.stages[0].stage, "extract");
  assert.equal(diagnostics.stages[0].attempts, 1);
  assert.ok(Array.isArray(diagnostics.stages[0].repairs));
  assert.ok(Array.isArray(diagnostics.coercions));
  assert.equal(typeof diagnostics.totalMs, "number");
});

test("hallucinated tags are coerced, unknown activities become themes, and summarized in result.themes", async () => {
  const transport = scriptedTransport([{ events: [ev("Kesh fought", ["melee"]), ev("Maren moved the hives", ["beekeeping"]), ev("Maren harvested honey", [], "success", { themes: ["Bee-keeping"] })] }]);
  const result = await runGatewayPipeline({ transport, request: request(NOTES), config: { proposalMode: "never" } });
  assert.deepEqual(result.events[0].tags, ["martial"]);
  assert.deepEqual(result.events[1].themes, ["beekeeping"]);
  const theme = result.themes.find((t) => t.slug === "beekeeping");
  assert.equal(theme.count, 2);
  assert.equal(theme.weight, 2);
});

test("an empty-events answer is a valid 'nothing happened', not a failure", async () => {
  const transport = scriptedTransport([{ events: [] }]);
  const result = await runGatewayPipeline({ transport, request: request("We ordered pizza."), config: {} });
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.proposals, []);
});

test("a bare {} is treated as no events, without a repair turn", async () => {
  const transport = scriptedTransport(["{}"]);
  const result = await runGatewayPipeline({ transport, request: request(NOTES), config: {} });
  assert.deepEqual(result.events, []);
  assert.equal(transport.calls.length, 1);
});

test("empty notes make no provider call at all", async () => {
  const transport = scriptedTransport([{ events: [] }]);
  const result = await runGatewayPipeline({ transport, request: request("   \n  "), config: {} });
  assert.equal(transport.calls.length, 0);
  assert.deepEqual(result.events, []);
});

// ---- repair turns ------------------------------------------------------------------------------

test("repair turn (happy): unparseable first reply, valid second reply", async () => {
  const transport = scriptedTransport(["I'm sorry, I cannot help with that.", { events: [ev("Kesh fought.", ["martial"])] }]);
  const result = await runGatewayPipeline({ transport, request: request(NOTES), config: { proposalMode: "never" } });
  assert.equal(result.events.length, 1);
  assert.equal(transport.calls.length, 2);
  const second = transport.calls[1].messages;
  assert.equal(second.at(-2).role, "assistant");
  assert.equal(second.at(-2).content, "I'm sorry, I cannot help with that.");
  assert.equal(second.at(-1).role, "user");
  assert.match(second.at(-1).content, /not valid JSON/);
  assert.equal(result.diagnostics.stages[0].attempts, 2);
});

test("repair turn (wrong shape): the repair message names the keys the model used", async () => {
  const transport = scriptedTransport([{ foo: 1, bar: 2 }, { events: [ev("Kesh fought.", ["martial"])] }]);
  const result = await runGatewayPipeline({ transport, request: request(NOTES), config: { proposalMode: "never" } });
  assert.equal(result.events.length, 1);
  assert.match(transport.calls[1].messages.at(-1).content, /foo, bar/);
});

test("aliased top-level keys ({data:{events}}, bare arrays) are located without a repair turn", async () => {
  for (const reply of [{ data: { events: [ev("Kesh fought.", ["martial"])] } }, [ev("Kesh fought.", ["martial"])], { Events: [ev("Kesh fought.", ["martial"])] }]) {
    const transport = scriptedTransport([reply]);
    const result = await runGatewayPipeline({ transport, request: request(NOTES), config: { proposalMode: "never" } });
    assert.equal(result.events.length, 1, JSON.stringify(reply));
    assert.equal(transport.calls.length, 1);
  }
});

test("repair turn when more than half the events are rejected; the better attempt wins", async () => {
  const bad = { events: [{ summary: "", tags: [] }, { tags: ["martial"] }, ev("Kesh fought.", ["martial"])] };
  const good = { events: [ev("Kesh fought.", ["martial"]), ev("Mira healed.", ["medicine"])] };
  const transport = scriptedTransport([bad, good]);
  const result = await runGatewayPipeline({ transport, request: request(NOTES), config: { proposalMode: "never" } });
  assert.equal(result.events.length, 2);
  assert.match(transport.calls[1].messages.at(-1).content, /rejected/);
});

test("repair turn (sad): garbage on every attempt is a total failure -> ModelJsonError", async () => {
  const transport = scriptedTransport(["nope"]);
  await assert.rejects(() => runGatewayPipeline({ transport, request: request(NOTES), config: { maxRepairAttempts: 2 } }), ModelJsonError);
  assert.equal(transport.calls.length, 3, "1 try + maxRepairAttempts repair turns");
});

test("maxRepairAttempts 0 means exactly one call", async () => {
  const transport = scriptedTransport(["nope"]);
  await assert.rejects(() => runGatewayPipeline({ transport, request: request(NOTES), config: { maxRepairAttempts: 0 } }));
  assert.equal(transport.calls.length, 1);
});

const noSleep = async () => {};

test("an unreachable provider is retried on the SAME chunk, then fatal (no pointless calls for other chunks)", async () => {
  const transport = scriptedTransport([new AiProviderUnreachableError("http://127.0.0.1:11434/api/chat", new TypeError("Failed to fetch"))]);
  const notes = Array.from({ length: 40 }, (_, i) => `Kesh fought goblin number ${i} in the long hall.`).join(" ");
  await assert.rejects(() => runGatewayPipeline({ transport, request: request(notes), config: { chunkChars: 400 }, sleep: noSleep }), AiProviderUnreachableError);
  // 1 call + 2 transient retries (GATEWAY_DEFAULTS.transientRetries), all for chunk 0.
  assert.equal(transport.calls.length, 3);
});

test("transientRetries: 0 restores fail-fast on the first unreachable error", async () => {
  const transport = scriptedTransport([new AiProviderUnreachableError("http://127.0.0.1:11434/api/chat", new TypeError("Failed to fetch"))]);
  await assert.rejects(() => runGatewayPipeline({ transport, request: request(NOTES), config: { transientRetries: 0 }, sleep: noSleep }), AiProviderUnreachableError);
  assert.equal(transport.calls.length, 1);
});

test("one dropped connection is retried and the notes still go through the AI (no fallback)", async () => {
  const transport = scriptedTransport([
    new AiProviderUnreachableError("http://127.0.0.1:11434/api/chat", new TypeError("Failed to fetch")),
    { events: [ev("Kesh fought the goblin.", ["martial"])] }
  ]);
  const slept = [];
  const result = await runGatewayPipeline({ transport, request: request(NOTES), config: { proposalMode: "never" }, sleep: async (ms) => slept.push(ms) });
  assert.equal(result.events.length, 1);
  assert.deepEqual(slept, [1500]);
  assert.ok(result.diagnostics.warnings.some((w) => /transient/.test(w)));
});

test("one timeout is retried; a provider that keeps timing out is still a total failure", async () => {
  const ok = scriptedTransport([new AiProviderTimeoutError("http://x/api/chat", 5000), { events: [ev("Kesh fought the goblin.", ["martial"])] }]);
  const result = await runGatewayPipeline({ transport: ok, request: request(NOTES), config: { proposalMode: "never" }, sleep: noSleep });
  assert.equal(result.events.length, 1);
  const dead = scriptedTransport([new AiProviderTimeoutError("http://x/api/chat", 5000)]);
  await assert.rejects(() => runGatewayPipeline({ transport: dead, request: request(NOTES), config: {}, sleep: noSleep }), AiProviderTimeoutError);
});

test("one failed chunk out of several keeps the others (no total failure)", async () => {
  const notes = Array.from({ length: 40 }, (_, i) => `Kesh fought goblin number ${i} in the long hall.`).join(" ");
  const transport = scriptedTransport([
    (args, n) => (n <= 3 ? "garbage" : { events: [ev(`Kesh fought chunk call ${n}.`, ["martial"])] })
  ]);
  const result = await runGatewayPipeline({ transport, request: request(notes), config: { chunkChars: 400, proposalMode: "never" } });
  assert.ok(result.events.length >= 1);
  assert.ok(result.skippedEvents.some((s) => s.reason === "chunk-failed"));
  assert.ok(result.diagnostics.chunks > 1);
});

// ---- chunking + dedupe ---------------------------------------------------------------------------

test("long notes are chunked; every chunk's text reaches the model; duplicates are merged", async () => {
  const notes = Array.from({ length: 40 }, (_, i) => `Kesh fought goblin number ${i} in the long hall.`).join("\n");
  const transport = scriptedTransport([{ events: [ev("Kesh parried the guard's blade.", ["martial"]), ev("Kesh parried the guard's blade!", ["defense"])] }]);
  const result = await runGatewayPipeline({ transport, request: request(notes), config: { chunkChars: 500, proposalMode: "never" } });
  const extractCalls = transport.calls.filter((c) => c.schema === EVENT_EXTRACTION_SCHEMA);
  assert.ok(extractCalls.length > 1);
  const sent = extractCalls.map((c) => c.messages.at(-1).content).join("\n");
  for (let i = 0; i < 40; i += 1) assert.ok(sent.includes(`goblin number ${i} `), `chunk text ${i} missing`);
  assert.equal(result.events.length, 1, "the same event from every chunk collapses to one");
  assert.deepEqual(result.events[0].tags.sort(), ["defense", "martial"]);
});

test("a truncated reply on a long chunk splits the chunk and re-extracts", async () => {
  const notes = Array.from({ length: 30 }, (_, i) => `Kesh fought goblin number ${i} in the long hall.`).join(" ");
  const transport = scriptedTransport([
    { content: '{"events":[{"summary":"Kesh fought","tags":["martial"],"outcome":"success"},{"summ', truncated: true },
    { events: [ev("Kesh fought goblins in the first half.", ["martial"])] },
    { events: [ev("Kesh fought goblins in the second half.", ["martial"])] }
  ]);
  const result = await runGatewayPipeline({ transport, request: request(notes), config: { proposalMode: "never" } });
  assert.equal(transport.calls.length, 3);
  assert.equal(result.events.length, 2);
  assert.ok(result.diagnostics.warnings.some((w) => /truncated/.test(w)));
});

// ---- single pipeline ---------------------------------------------------------------------------

test("single pipeline: one combined call returns events and proposals", async () => {
  const transport = scriptedTransport([{ events: [ev("Kesh parried.", ["martial"])], proposals: [skillProposal()] }]);
  const result = await runGatewayPipeline({ transport, request: request(NOTES), config: { pipeline: "single" } });
  assert.equal(transport.calls.length, 1);
  assert.deepEqual(transport.calls[0].schema, COMBINED_SCHEMA);
  assert.equal(result.events.length, 1);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.diagnostics.stages[0].stage, "single");
});

test("single pipeline: an invalid proposal gets one repair turn continuing the same conversation", async () => {
  const broken = skillProposal({ mechanics: { frequency: { max: 1, per: "day" } } }); // no effect
  const transport = scriptedTransport([{ events: [ev("Kesh parried.", ["martial"])], proposals: [broken] }, { proposals: [skillProposal()] }]);
  const result = await runGatewayPipeline({ transport, request: request(NOTES), config: { pipeline: "single" } });
  assert.equal(result.proposals.length, 1);
  assert.equal(transport.calls.length, 2);
  assert.equal(transport.calls[1].messages.at(-2).role, "assistant");
});

// ---- proposals -----------------------------------------------------------------------------------

test("proposalMode never: no proposal call even with allowances", async () => {
  const transport = scriptedTransport([{ events: [ev("Kesh fought.", ["martial"])] }]);
  const result = await runGatewayPipeline({ transport, request: request(NOTES, { allowances: 3 }), config: { proposalMode: "never" } });
  assert.equal(transport.calls.length, 1);
  assert.equal(result.diagnostics.proposalStage.ran, false);
});

test("proposalMode when-earned: one success and no allowance does not propose", async () => {
  const transport = scriptedTransport([{ events: [ev("Kesh fought.", ["martial"])] }]);
  const result = await runGatewayPipeline({ transport, request: request(NOTES), config: { proposalMode: "when-earned" } });
  assert.equal(transport.calls.length, 1);
  assert.equal(result.diagnostics.proposalStage.reason, "not-yet-earned");
});

test("proposalMode when-earned: a grant allowance triggers the proposal stage", async () => {
  const transport = scriptedTransport([{ events: [ev("Kesh fought.", ["martial"])] }, { proposals: [] }]);
  await runGatewayPipeline({ transport, request: request(NOTES, { allowances: 1 }), config: {} });
  assert.equal(transport.calls.length, 2);
});

test("proposalMode when-earned: three successes on one theme earn a proposal stage", async () => {
  const hives = (day) => ev(`Maren tended the hives on ${day}.`, [], "success", { themes: ["beekeeping"] });
  const transport = scriptedTransport([{ events: [hives("Monday"), hives("Wednesday"), hives("Friday")] }, { proposals: [] }]);
  const result = await runGatewayPipeline({ transport, request: request(NOTES), config: {} });
  assert.equal(transport.calls.length, 2);
  assert.match(result.diagnostics.proposalStage.reason, /theme:beekeeping/);
  const payload = JSON.parse(transport.calls[1].messages.at(-1).content);
  assert.equal(payload.themeEvidence.beekeeping, 3);
});

test("proposalMode always: proposes after a single event", async () => {
  const transport = scriptedTransport([{ events: [ev("Kesh fought.", ["martial"])] }, { proposals: [skillProposal()] }]);
  const result = await runGatewayPipeline({ transport, request: request(NOTES), config: { proposalMode: "always" } });
  assert.equal(result.proposals.length, 1);
});

test("shouldPropose honors maxProposals 0 and history evidence", () => {
  const events = [ev("Kesh fought.", ["martial"])];
  assert.equal(shouldPropose(events, request(NOTES), { proposalMode: "always", maxProposals: 0 }).run, false);
  const req = request(NOTES);
  req.growthHistory = { tagEvidence: { martial: 2 } };
  assert.equal(shouldPropose(events, req, { proposalMode: "when-earned", maxProposals: 3 }).run, true);
});

test("proposal repair fills obvious gaps without a repair turn (tier string, missing duration, synonym tags)", async () => {
  const sloppy = skillProposal({ tier: "2", mechanics: { effect: "Gain +1 to AC.", frequency: "once per day" }, metadata: { tags: ["melee", "defensive", "beekeeping"] } });
  const transport = scriptedTransport([{ events: [ev("Kesh fought.", ["martial"])] }, { proposals: [sloppy] }]);
  const result = await runGatewayPipeline({ transport, request: request(NOTES), config: { proposalMode: "always" } });
  assert.equal(transport.calls.length, 2);
  const [proposal] = result.proposals;
  assert.equal(proposal.entry.tier, 2);
  assert.deepEqual(proposal.entry.mechanics.frequency, { max: 1, per: "day" });
  assert.equal(typeof proposal.entry.mechanics.duration, "string");
  assert.deepEqual(proposal.entry.metadata.tags, ["martial", "defense"]);
  assert.deepEqual(proposal.entry.metadata.themes, ["beekeeping"]);
  assert.deepEqual(validateSkillEntry(proposal.entry).errors, []);
});

test("an action proposal with no roll gets a roll formula from the actor's level", async () => {
  const action = skillProposal({ gameItem: { kind: "2 actions" }, mechanics: { effect: "Strike twice.", frequency: { max: 1, per: "round" } } });
  const transport = scriptedTransport([{ events: [ev("Kesh fought.", ["martial"])] }, { proposals: [action] }]);
  const result = await runGatewayPipeline({ transport, request: request(NOTES), config: { proposalMode: "always" } });
  const [proposal] = result.proposals;
  assert.equal(proposal.entry.gameItem.kind, "action");
  assert.match(proposal.entry.mechanics.roll.formula, /^1d20\+\d+$/);
  assert.ok(Number.isInteger(proposal.entry.mechanics.actions));
});

test("a proposal the validator still rejects gets one repair turn with the validator's errors", async () => {
  const noEffect = skillProposal({ mechanics: { frequency: { max: 1, per: "day" }, duration: "x" } });
  const transport = scriptedTransport([{ events: [ev("Kesh fought.", ["martial"])] }, { proposals: [noEffect] }, { proposals: [skillProposal()] }]);
  const result = await runGatewayPipeline({ transport, request: request(NOTES), config: { proposalMode: "always" } });
  assert.equal(transport.calls.length, 3);
  assert.match(transport.calls[2].messages.at(-1).content, /Blade Wall/);
  assert.equal(result.proposals.length, 1);
});

test("a proposal that is still invalid after the repair turn is skipped, never thrown", async () => {
  const noEffect = skillProposal({ mechanics: { frequency: { max: 1, per: "day" }, duration: "x" } });
  const transport = scriptedTransport([{ events: [ev("Kesh fought.", ["martial"])] }, { proposals: [noEffect] }, { proposals: [noEffect] }]);
  const result = await runGatewayPipeline({ transport, request: request(NOTES), config: { proposalMode: "always" } });
  assert.equal(result.proposals.length, 0);
  assert.equal(result.events.length, 1);
  assert.ok(result.skippedProposals.some((s) => s.reason === "invalid" && s.errors.length));
});

test("a proposal stage that crashes (timeout) keeps the extracted events", async () => {
  const transport = scriptedTransport([{ events: [ev("Kesh fought.", ["martial"])] }, new AiProviderTimeoutError("http://x", 5000)]);
  const result = await runGatewayPipeline({ transport, request: request(NOTES), config: { proposalMode: "always" } });
  assert.equal(result.events.length, 1);
  assert.ok(result.skippedProposals.some((s) => s.reason === "proposal-stage-failed"));
});

test("an unparseable proposal reply is skipped after repairs, events kept", async () => {
  const transport = scriptedTransport([{ events: [ev("Kesh fought.", ["martial"])] }, "no proposals for you"]);
  const result = await runGatewayPipeline({ transport, request: request(NOTES), config: { proposalMode: "always" } });
  assert.equal(result.events.length, 1);
  assert.ok(result.skippedProposals.some((s) => s.reason === "unparseable-proposal-response"));
});

test("allowRed false: red proposals are skipped with a reason; the prompt says red is disabled", async () => {
  const red = skillProposal({ metadata: { tags: ["martial"], polarity: "red", malignance: { vice: "bloodlust", drawback: "x" }, lineage: { operation: "origin", sources: [], rationale: "x" } } });
  const transport = scriptedTransport([{ events: [ev("Kesh fought.", ["martial"])] }, { proposals: [red] }]);
  const result = await runGatewayPipeline({ transport, request: request(NOTES), config: { proposalMode: "always", allowRed: false } });
  assert.equal(result.proposals.length, 0);
  assert.ok(result.skippedProposals.some((s) => s.reason === "red-entries-disabled"));
  assert.match(transport.calls[1].messages[0].content, /disabled red/);
});

test("a class proposal without class evolution available is skipped", async () => {
  const cls = { kind: "class", entry: { name: "Canal Warden", level: 20, power_tier: "standard", is_primary: true, is_secondary: false, system_chassis: "Fighter", gameItem: { kind: "passive" }, mechanics: { effect: "x", duration: "always", frequency: { max: 1, per: "day" } }, metadata: { tags: ["martial"], lineage: { operation: "origin", sources: [], rationale: "x" } } } };
  const transport = scriptedTransport([{ events: [ev("Kesh fought.", ["martial"])] }, { proposals: [cls] }]);
  const result = await runGatewayPipeline({ transport, request: request(NOTES), config: { proposalMode: "always" } });
  assert.equal(result.proposals.length, 0);
  assert.ok(result.skippedProposals.some((s) => s.reason === "class-evolution-not-available"));
});

test("a class proposal with class evolution available passes the class validator", async () => {
  const cls = { kind: "class", entry: { name: "Canal Warden", level: "20", power_tier: "Elevated", is_primary: "yes", system_chassis: "Fighter", gameItem: { kind: "passive" }, mechanics: { effect: "Gain +1 AC near water.", frequency: { max: 1, per: "day" } }, metadata: { tags: ["martial"] } } };
  const transport = scriptedTransport([{ events: [ev("Kesh fought.", ["martial"])] }, { proposals: [cls] }]);
  const result = await runGatewayPipeline({ transport, request: request(NOTES, { classEvolution: true }), config: { proposalMode: "always" } });
  assert.equal(result.proposals.length, 1);
  assert.deepEqual(validateClassEntry(result.proposals[0].entry).errors, []);
});

test("maxProposals caps the output; extras are skipped with a reason", async () => {
  const many = [1, 2, 3, 4].map((n) => skillProposal({ name: `Blade Wall ${n}` }));
  const transport = scriptedTransport([{ events: [ev("Kesh fought.", ["martial"])] }, { proposals: many }]);
  const result = await runGatewayPipeline({ transport, request: request(NOTES), config: { proposalMode: "always", maxProposals: 2 } });
  assert.equal(result.proposals.length, 2);
  assert.equal(result.skippedProposals.filter((s) => s.reason === "over-max-proposals").length, 2);
});

test("a proposal duplicating an approved registry entry is skipped", async () => {
  const registry = { skills: { "skill:blade-wall": { name: "Blade Wall" } } };
  const transport = scriptedTransport([{ events: [ev("Kesh fought.", ["martial"])] }, { proposals: [skillProposal()] }]);
  const result = await runGatewayPipeline({ transport, request: request(NOTES, { registry }), config: { proposalMode: "always" } });
  assert.equal(result.proposals.length, 0);
  assert.ok(result.skippedProposals.some((s) => s.reason === "already-exists"));
});

test("dnd5e requests work end to end and use the dnd5e label in defaults", async () => {
  const bare = skillProposal({ system_equivalent: undefined });
  delete bare.entry.system_equivalent;
  const transport = scriptedTransport([{ events: [ev("Kesh fought.", ["martial"])] }, { proposals: [bare] }]);
  const result = await runGatewayPipeline({ transport, request: request(NOTES, { systemId: "dnd5e" }), config: { proposalMode: "always" } });
  assert.equal(result.proposals.length, 1);
  assert.match(result.proposals[0].entry.system_equivalent, /Dungeons|5e|D&D/i);
});

// ---- config effects on prompts -------------------------------------------------------------------

test("houseRules, toneHints, extractionExamples and outputLanguage reach the extraction prompt", async () => {
  const transport = scriptedTransport([{ events: [] }]);
  await runGatewayPipeline({
    transport,
    request: request(NOTES),
    config: {
      proposalMode: "never",
      houseRules: "HOUSE-RULE-XYZZY: cooking counts as craft.",
      toneHints: "TONE-HINT-PLUGH",
      outputLanguage: "es",
      extractionExamples: [{ notes: "EXAMPLE-NOTES-FROBOZZ", events: [ev("x", ["craft"])] }]
    }
  });
  const system = transport.calls[0].messages[0].content;
  assert.ok(system.includes("HOUSE-RULE-XYZZY"));
  assert.ok(system.includes("TONE-HINT-PLUGH"));
  assert.ok(system.includes("EXAMPLE-NOTES-FROBOZZ"));
  assert.match(system, /Spanish|español|Español/);
});

test("namingStyle, creativity, houseRules and outputLanguage reach the proposal prompt", async () => {
  const transport = scriptedTransport([{ events: [ev("Kesh fought.", ["martial"])] }, { proposals: [] }]);
  await runGatewayPipeline({
    transport,
    request: request(NOTES),
    config: { proposalMode: "always", namingStyle: "NAMING-STYLE-GRUE", creativity: "wild", houseRules: "HOUSE-RULE-XYZZY", outputLanguage: "el" }
  });
  const system = transport.calls[1].messages[0].content;
  assert.ok(system.includes("NAMING-STYLE-GRUE"));
  assert.ok(system.includes("HOUSE-RULE-XYZZY"));
  assert.match(system, /inventive/);
  assert.match(system, /Greek/);
});

test("creativity changes the proposal temperature: grounded <= 0.15 < balanced < wild", async () => {
  const temps = {};
  for (const creativity of ["grounded", "balanced", "wild"]) {
    const transport = scriptedTransport([{ events: [ev("Kesh fought.", ["martial"])] }, { proposals: [] }]);
    await runGatewayPipeline({ transport, request: request(NOTES), config: { proposalMode: "always", creativity, temperature: 0.3 } });
    temps[creativity] = transport.calls[1].temperature;
  }
  assert.ok(temps.grounded <= 0.15);
  assert.ok(temps.grounded < temps.balanced && temps.balanced < temps.wild, JSON.stringify(temps));
});

test("customSynonyms from the config resolve tags during extraction", async () => {
  const transport = scriptedTransport([{ events: [ev("Erin made pie.", ["hearthcraft"])] }]);
  const result = await runGatewayPipeline({ transport, request: request(NOTES), config: { proposalMode: "never", customSynonyms: { hearthcraft: "craft" } } });
  assert.deepEqual(result.events[0].tags, ["craft"]);
});

test("emergentThemes false drops themes and themes-only events", async () => {
  const transport = scriptedTransport([{ events: [ev("Maren tended bees.", ["beekeeping"]), ev("Kesh fought.", ["martial"])] }]);
  const result = await runGatewayPipeline({ transport, request: request(NOTES), config: { proposalMode: "never", emergentThemes: false } });
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0].themes, []);
});

// ---- repairProposal / helpers --------------------------------------------------------------------

test("repairProposal fills spell defaults (rank, tradition from tags, school from name)", () => {
  const { proposal } = repairProposal({ kind: "skill", entry: { name: "Ember", gameItem: { kind: "spell", school: "Evocation" }, mechanics: { effect: "Burn.", frequency: { max: 1, per: "day" } }, metadata: { tags: ["fire", "primal"] } } });
  assert.equal(proposal.entry.gameItem.school, "evo");
  assert.equal(proposal.entry.gameItem.tradition, "primal");
  assert.ok(Number.isInteger(proposal.entry.gameItem.rank));
  assert.deepEqual(validateSkillEntry(proposal.entry).errors, []);
});

test("repairProposal fills weapon defaults", () => {
  const { proposal } = repairProposal({ kind: "skill", entry: { name: "Hook", gameItem: { kind: "weapon", damage: "d6 + 2" }, mechanics: { effect: "Hit.", frequency: { max: 1, per: "round" } }, metadata: { tags: ["ranged"] } } });
  assert.equal(proposal.entry.gameItem.damage, "1d6+2");
  assert.equal(proposal.entry.gameItem.damageType, "piercing");
  assert.deepEqual(validateSkillEntry(proposal.entry).errors, []);
});

test("repairProposal on a reaction with no trigger leaves it for the repair turn (no invented content)", () => {
  const { proposal } = repairProposal({ kind: "skill", entry: { name: "Parry", gameItem: { kind: "reaction" }, mechanics: { effect: "Parry.", frequency: { max: 1, per: "round" } }, metadata: { tags: ["defense"] } } });
  assert.equal(proposal.entry.mechanics.trigger, undefined);
  assert.equal(validateSkillEntry(proposal.entry).valid, false);
});

test("normalizeDiceFormula folds modifiers and rejects non-dice", () => {
  assert.equal(normalizeDiceFormula("d20 + 5 + 2"), "1d20+7");
  assert.equal(normalizeDiceFormula("+6"), "1d20+6");
  assert.equal(normalizeDiceFormula(7), "1d20+7");
  assert.equal(normalizeDiceFormula("2d6-1"), "2d6-1");
  assert.equal(normalizeDiceFormula("lots"), undefined);
});

test("coerceFrequency understands prose and clamps", () => {
  assert.deepEqual(coerceFrequency("twice per long rest"), { max: 2, per: "day" });
  assert.deepEqual(coerceFrequency({ max: "3", per: "Encounter" }), { max: 3, per: "encounter" });
  assert.deepEqual(coerceFrequency("at will"), { max: 1, per: "unlimited" });
  assert.deepEqual(coerceFrequency(undefined), { max: 1, per: "day" });
  assert.deepEqual(coerceFrequency({ max: 0, per: "turn" }), { max: 1, per: "round" });
});
