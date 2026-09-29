// Proof tests for docs/reviews/ai-pipeline-review.md (board c829f2a7, cloud packet C5: a cold
// review of the AI pipeline). Each test below is a `test.todo` that still EXECUTES its assertions
// (Node's test runner reports a failing TODO without failing the run/exit code), so `npm test` stays
// green while the assertion failure documents the exact bug described in the review doc. Do not
// "fix" a test here by loosening its assertion -- fix the production code and un-TODO it instead.
//
// No production code was changed for this review; these tests read scripts/ai/* exactly as shipped.

import assert from "node:assert/strict";
import test from "node:test";

import { mergeFollowUpEvents, runGatewayPipeline } from "../scripts/ai/pipeline.js";
import { buildAiGatewayRequest } from "../scripts/ai-gateway.js";
import { makeHarnessActor } from "../tools/nlp-scale/lib.mjs";

// Same scripted-transport helper style as tests/ai-pipeline.test.mjs: each chat() call pops the next
// scripted reply (a string, an Error, or a function).
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

function request(notes, opts = {}) {
  const req = buildAiGatewayRequest(makeHarnessActor("pf2e", { registry: opts.registry ?? {} }), notes, "pf2e");
  req.actor.grandDesign.availableGrantAllowances = opts.allowances ?? 0;
  req.actor.grandDesign.classEvolutionAvailable = opts.classEvolution ?? false;
  return req;
}

// ---------------------------------------------------------------------------------------------
// Finding 1: differentActors() (pipeline.js:927-933) false-negatives on short common words
// (titles like "Sir", or any 3+ letter word an actor's name shares with unrelated prior text),
// letting mergeFollowUpEvents fold a genuinely different actor's event into the wrong one.
// ---------------------------------------------------------------------------------------------

test("differentActors: a title word ('sir') incidentally in the previous event's text must not make two different actors look like one", () => {
  const events = [
    { summary: "Tovin the sir knight bowed to the king.", quote: "", tags: ["leadership"], themes: [], outcome: "success", actorName: "Tovin" },
    { summary: "Sir Aldric stole the crown jewels.", quote: "", tags: ["thievery"], themes: [], outcome: "success", actorName: "Sir Aldric", continuesPrevious: true }
  ];
  const { events: merged, merged: mergeCount } = mergeFollowUpEvents(events);

  // EXPECTED (review finding 1): two different named actors' events are never folded together --
  // this is the same guarantee attributeEventsToActor gives for "Maren" vs "Wick" etc.
  // OBSERVED today: mergeCount is 1 (they DO merge), because differentActors() tokenizes
  // event.actorName with a bare `.split(/\s+/)` (no stopword filter, unlike
  // session-notes.js#significantTokens) and accepts "sir" as proof of "same person" merely because
  // it appears in prev's unrelated text ("...the sir knight...").
  assert.equal(mergeCount, 0, "Tovin's and Sir Aldric's events must stay separate");
  assert.equal(merged.length, 2);
  // Documents the actual (wrong) damage when this fails: Aldric's thievery tag and his whole event
  // vanish into Tovin's, and Tovin is credited with a tag ("thievery") for a deed he never did.
  if (merged.length === 1) {
    assert.equal(merged[0].actorName, "Tovin");
    assert.ok(!merged[0].tags.includes("thievery"), "Tovin must not inherit Aldric's thievery tag");
  }
});

// ---------------------------------------------------------------------------------------------
// Finding 2: dedupeEvents() (pipeline.js:838-855) keys purely on summary text + outcome
// (normalize.js#eventDedupeKey, pipeline.js:838-855) with no actorName in the key at all, so two
// different party members' generically-phrased events collapse into one and the second actor's
// event -- and their only evidence in the batch -- disappears with no trace in skippedEvents.
// ---------------------------------------------------------------------------------------------

test("dedupeEvents: two different actors' generically-phrased events must not collapse into one, losing the second actor's event", async () => {
  const ev = (actorName) => ({
    quote: "picked a lock",
    summary: "Picked a lock.", // no name in the summary text itself -- actorName carries the credit
    tags: ["thievery"],
    themes: [],
    outcome: "success",
    dangerGap: "none",
    actorName
  });
  const transport = scriptedTransport([{ events: [ev("Tovin"), ev("Maren")] }]);
  const result = await runGatewayPipeline({ transport, request: request("Tovin picked a lock. Maren picked a lock."), config: { proposalMode: "never" } });

  // EXPECTED (review finding 2): both PCs' events survive -- this is exactly the "never lose the
  // GM's notes" invariant pipeline.js's own file header states.
  // OBSERVED today: result.events.length is 1 -- Maren's event was silently folded into Tovin's
  // because eventDedupeKey(event) never looks at event.actorName, only summary + outcome.
  assert.equal(result.events.length, 2, "both Tovin's and Maren's 'picked a lock' events must be kept");
  const actorNames = result.events.map((e) => e.actorName).sort();
  assert.deepEqual(actorNames, ["Maren", "Tovin"]);
});

// ---------------------------------------------------------------------------------------------
// Finding 3: the ONE proposal repair turn in validateProposals (pipeline.js:1202-1222) still uses
// proposalSchemaCapped(..., { redCheck: cfg.allowRed }) (schemas.js:167-176), which requires a
// full per-event redCheck array -- the exact same requirement as the ORIGINAL propose call
// (prompts.js:282) -- even though buildRepairMessage's own text (prompts.js:375-385) tells the
// model the reply must be exactly {"proposals":[...]}  and never mentions redCheck.
// ---------------------------------------------------------------------------------------------

test("proposal repair-turn schema must not silently require a 'redCheck' field the repair message never asks for", async () => {
  // A reaction proposal with no trigger: repairProposal() deliberately leaves this for the repair
  // turn (see the "repairProposal on a reaction with no trigger" test in ai-pipeline.test.mjs), so
  // validateSkillEntry rejects it on the first pass and validateProposals sends a real repair turn.
  const brokenReaction = {
    kind: "skill",
    evidence: ["Kesh parried three times"],
    entry: {
      name: "Parry Reflex",
      tier: 1,
      system_equivalent: "Skill feat",
      gameItem: { kind: "reaction" },
      mechanics: { effect: "Reduce incoming damage.", frequency: { max: 1, per: "round" } },
      metadata: { tags: ["defense"], lineage: { operation: "origin", sources: [], rationale: "Parried a lot." } }
    }
  };
  const fixedReaction = {
    ...brokenReaction,
    entry: { ...brokenReaction.entry, mechanics: { ...brokenReaction.entry.mechanics, trigger: "You are hit by a melee Strike.", roll: { kind: "Reflex check", formula: "1d20+8" } } }
  };
  const transport = scriptedTransport([
    { events: [{ quote: "Kesh parried", summary: "Kesh parried the guard's blade.", tags: ["martial", "defense"], themes: [], outcome: "success", dangerGap: "none" }] },
    { redCheck: [], proposals: [brokenReaction] },
    { redCheck: [], proposals: [fixedReaction] }
  ]);
  await runGatewayPipeline({ transport, request: request("Kesh parried the guard's blade."), config: { proposalMode: "always" } });
  assert.equal(transport.calls.length, 3, "extract, first propose, repair-turn propose");
  const repairCall = transport.calls[2];

  // EXPECTED (review finding 3): a repair turn whose message asks for {"proposals":[...]} only
  // should not force the model to also fill a full per-event redCheck it was never asked to redo.
  // Was observed: repairCall.schema.required still included "redCheck" (the repair turn reused
  // { redCheck: cfg.allowRed }), while the repair message promised only {"proposals":[...]}.
  // Fixed (board 96b5beea): the repair turn's schema is { redCheck: false }.
  assert.ok(repairCall.schema.properties.proposals, "the repair turn still asks for proposals");
  assert.ok(!repairCall.schema.required.includes("redCheck"), "repair-turn schema should not require redCheck");
  const repairMessageText = repairCall.messages.at(-1).content;
  assert.ok(!/redCheck/i.test(repairMessageText), "sanity: the repair message text never mentions redCheck");
});
