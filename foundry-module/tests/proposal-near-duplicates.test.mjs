import assert from "node:assert/strict";
import test from "node:test";

// Board 3574bd96: near-duplicate proposals piled up. Two "Suggest proposals" clicks left Briik with
// "Unbroken Bastion" AND "Unbroken Bulwark" pending (stage 2 never saw the pending list), and one
// stage-2 call returned five variants of the same archery volley (siblings were only deduped by an
// exact name match). Board 4f3192e0: an event that only happened TO a character ("was read very well
// by a woman who wants a year of his dreams") was extracted as that character's success. Both systems.

import { findDuplicateOwnedFeatureText, findNearDuplicate, nearDuplicateReason, runGatewayPipeline } from "../scripts/ai/pipeline.js";
import { AiProviderUnreachableError } from "../scripts/ai/transport.js";
import { buildExtractionMessages, buildProposalMessages } from "../scripts/ai/prompts.js";
import { EVENT_EXTRACTION_SCHEMA } from "../scripts/ai/schemas.js";
import { normalizeGatewayConfig } from "../scripts/ai/gateway-config.js";
import { buildAiGatewayRequest, compactProposals, createGatewayAdapter } from "../scripts/ai-gateway.js";
import { GROWTH_PROPOSALS_FLAG } from "../scripts/constants.js";
import { makeHarnessActor } from "../tools/nlp-scale/lib.mjs";

function scriptedTransport(replies) {
  const calls = [];
  return {
    calls,
    info: { model: "stub-model", provider: "ollama" },
    async chat(args) {
      calls.push({ ...args, messages: args.messages.map((m) => ({ ...m })) });
      let reply = replies.length > 1 ? replies.shift() : replies[0];
      if (typeof reply === "function") reply = reply(args, calls.length);
      return { content: typeof reply === "string" ? reply : JSON.stringify(reply), ms: 1, truncated: false };
    }
  };
}

function skill(name, effect, { tags = ["ranged"], themes = ["archery"], kind = "passive", evidence = ["Rook shot the raider"], trigger } = {}) {
  return {
    kind: "skill",
    evidence,
    entry: {
      name,
      tier: 1,
      system_equivalent: "Skill feat",
      gameItem: { kind },
      mechanics: { effect, duration: "while active", frequency: { max: 1, per: "unlimited" }, ...(trigger ? { trigger } : {}) },
      metadata: { tags, themes, lineage: { operation: "origin", sources: [], rationale: "Earned it." } }
    }
  };
}

function classProposal(name, effect, { tags = ["defense", "martial"], evidence = ["Briik held the gate"] } = {}) {
  return {
    kind: "class",
    evidence,
    entry: {
      name,
      level: 50,
      power_tier: "standard",
      is_primary: true,
      is_secondary: false,
      system_chassis: "Fighter evolution",
      gameItem: { kind: "passive" },
      mechanics: { effect, duration: "while active", frequency: { max: 1, per: "day" } },
      metadata: { tags, lineage: { operation: "origin", sources: [], rationale: "Held the line." } }
    }
  };
}

// An actor whose Foundry flags hold growth proposals, as api.js stores them.
function actorWith(systemId, proposals = [], registry = {}) {
  const base = makeHarnessActor(systemId, { name: "Rook", registry });
  const inner = base.getFlag.bind(base);
  return { ...base, getFlag: (scope, key) => (key === GROWTH_PROPOSALS_FLAG ? proposals : inner(scope, key)) };
}

const EVENTS = [
  { summary: "Rook shot the raider off the wall from 200 feet.", actorName: "Rook", tags: ["ranged"], themes: ["archery"], outcome: "success" },
  { summary: "Rook put three arrows in the troll in one breath.", actorName: "Rook", tags: ["ranged"], themes: ["archery"], outcome: "criticalSuccess" }
];

const VOLLEY = "Once per round when you make a ranged Strike with a bow, fire two arrows at the same target and roll damage once, adding both arrows' dice.";
const VOLLEY_2 = "Once per round when you make a ranged Strike with a bow, fire two arrows at one target; roll damage once with both arrows' dice.";
const VOLLEY_3 = "When you make a ranged Strike with your bow, you may loose two arrows at a single target, rolling damage once for both.";
const DISTINCT = "When an ally within 30 feet is attacked, use your reaction to shoot the attacker, imposing a penalty to its attack roll.";

// ---- the similarity rule itself --------------------------------------------------------------

test("nearDuplicateReason: Briik's 'Unbroken Bastion' vs 'Unbroken Bulwark' Class proposals are near-duplicates", () => {
  const a = classProposal("Unbroken Bastion", "While you hold a shield, allies adjacent to you gain a bonus to AC and you cannot be moved against your will.");
  const b = classProposal("Unbroken Bulwark", "Once per day, plant your feet: you and adjacent allies resist forced movement and gain temporary hit points.");
  assert.equal(nearDuplicateReason(a, b), "name");
});

test("nearDuplicateReason: variants of one archery volley are caught; a different archery ability and the shared motif are not", () => {
  const first = skill("Longbow: Precision Volley", VOLLEY);
  assert.equal(nearDuplicateReason(first, skill("Longbow: Twin Volley", VOLLEY_2)), "mechanic");
  assert.ok(nearDuplicateReason(first, skill("Longbow: Double Nock", VOLLEY_3)), "same bow trick in other words");
  // Same motif, same discipline, genuinely different use (a reaction that protects an ally).
  assert.equal(nearDuplicateReason(first, skill("Longbow: Covering Shot", DISTINCT, { kind: "reaction", trigger: "An ally within 30 feet is attacked." })), null);
  // A Skill and a Class are only duplicates when they literally do the same thing.
  assert.equal(nearDuplicateReason(skill("Unbroken: Stand Fast", "Resist being pushed."), classProposal("Unbroken Bastion", "Allies adjacent to you gain AC.")), null);
});

test("findNearDuplicate accepts the compact pending records the request carries", () => {
  const pending = [{ id: "p1", kind: "class", name: "Unbroken Bastion", effect: "While you hold a shield, allies adjacent to you gain a bonus to AC.", tags: ["defense", "martial"], themes: [] }];
  const hit = findNearDuplicate(classProposal("Unbroken Bulwark", "Plant your feet and resist forced movement."), pending);
  assert.equal(hit?.other.id, "p1");
});

// ---- request + prompt ------------------------------------------------------------------------

for (const systemId of ["pf2e", "dnd5e"]) {
  test(`[${systemId}] the request and the stage-2 prompt carry pending and rejected proposals (compact)`, () => {
    const stored = [
      { id: "p1", status: "pending", kind: "skill", entry: skill("Longbow: Precision Volley", VOLLEY).entry },
      { id: "r1", status: "rejected", kind: "class", entry: classProposal("Unbroken Bastion", "Allies adjacent to you gain AC.").entry },
      { id: "a1", status: "approved", kind: "skill", entry: skill("Longbow: Old Trick", DISTINCT).entry }
    ];
    const request = buildAiGatewayRequest(actorWith(systemId, stored), "notes", systemId);
    assert.deepEqual(request.actor.pendingProposals.map((p) => p.id), ["p1"]);
    assert.deepEqual(request.actor.rejectedProposals.map((p) => p.id), ["r1"]);
    assert.equal(request.actor.pendingProposals[0].gameItemKind, "passive");
    assert.deepEqual(request.actor.pendingProposals[0].tags, ["ranged"]);

    const messages = buildProposalMessages({ request, config: normalizeGatewayConfig({}), events: EVENTS, allowClass: false });
    const payload = JSON.parse(messages[1].content);
    assert.equal(payload.actor.pendingProposals[0].name, "Longbow: Precision Volley");
    assert.equal(payload.actor.rejectedByGm[0].name, "Unbroken Bastion");
    assert.match(messages[0].content, /actor\.pendingProposals/);
    assert.match(messages[0].content, /DIFFERENT idea/);
  });
}

test("compactProposals: no flag, or a malformed one, is an empty list (never throws)", () => {
  assert.deepEqual(compactProposals({ getFlag: () => undefined }, "pending"), []);
  assert.deepEqual(compactProposals({ getFlag: () => "nope" }, "pending"), []);
  assert.deepEqual(compactProposals(null, "pending"), []);
});

// ---- the pipeline gate -----------------------------------------------------------------------

for (const systemId of ["pf2e", "dnd5e"]) {
  test(`[${systemId}] one call's five volley variants become one proposal: the best-sourced one is kept`, async () => {
    const transport = scriptedTransport([{
      redCheck: [],
      proposals: [
        skill("Longbow: Precision Volley", VOLLEY),
        skill("Longbow: Twin Volley", VOLLEY_2, { evidence: ["Rook shot the raider", "Rook put three arrows in the troll"] }),
        skill("Longbow: Double Nock", VOLLEY_3),
        skill("Longbow: Precision Volley", VOLLEY),
        skill("Longbow: Covering Shot", DISTINCT, { kind: "reaction", trigger: "An ally within 30 feet is attacked." })
      ]
    }]);
    const request = buildAiGatewayRequest(actorWith(systemId), "", systemId);
    const result = await runGatewayPipeline({ transport, request, config: { proposalMode: "always", maxProposals: 5 }, presetEvents: EVENTS, systemId });
    assert.deepEqual(result.proposals.map((p) => p.entry.name), ["Longbow: Twin Volley", "Longbow: Covering Shot"]);
    const siblings = result.skippedProposals.filter((s) => s.reason === "duplicates-sibling");
    assert.equal(siblings.length, 3);
    assert.ok(siblings.every((s) => s.duplicateOf === "Longbow: Twin Volley"));
  });

  test(`[${systemId}] a second Suggest click does not add a near-duplicate of a pending proposal (Briik)`, async () => {
    const stored = [{ id: "p-bastion", status: "pending", kind: "class", entry: classProposal("Unbroken Bastion", "While you hold a shield, allies adjacent to you gain a bonus to AC.").entry }];
    const request = buildAiGatewayRequest(actorWith(systemId, stored), "", systemId);
    request.actor.grandDesign.classEvolutionAvailable = true;
    const transport = scriptedTransport([{
      redCheck: [],
      proposals: [
        classProposal("Unbroken Bulwark", "Once per day, plant your feet: you and adjacent allies resist forced movement."),
        skill("Longbow: Covering Shot", DISTINCT, { kind: "reaction", trigger: "An ally within 30 feet is attacked." })
      ]
    }]);
    const result = await runGatewayPipeline({ transport, request, config: { proposalMode: "always" }, presetEvents: EVENTS, systemId });
    assert.deepEqual(result.proposals.map((p) => p.entry.name), ["Longbow: Covering Shot"]);
    const skipped = result.skippedProposals.find((s) => s.reason === "duplicates-pending");
    assert.equal(skipped.duplicateOf, "Unbroken Bastion");
    assert.equal(skipped.duplicateOfId, "p-bastion");
  });

  test(`[${systemId}] a near-duplicate of a proposal the GM rejected is skipped too`, async () => {
    const stored = [{ id: "r1", status: "rejected", kind: "skill", entry: skill("Longbow: Precision Volley", VOLLEY).entry }];
    const request = buildAiGatewayRequest(actorWith(systemId, stored), "", systemId);
    const transport = scriptedTransport([{ redCheck: [], proposals: [skill("Longbow: Twin Volley", VOLLEY_2)] }]);
    const result = await runGatewayPipeline({ transport, request, config: { proposalMode: "always" }, presetEvents: EVENTS, systemId });
    assert.equal(result.proposals.length, 0);
    assert.equal(result.skippedProposals[0].reason, "duplicates-rejected");
  });

  test(`[${systemId}] a milestone reward is never dropped for resembling a pending proposal`, async () => {
    const stored = [{ id: "p1", status: "pending", kind: "skill", entry: skill("Longbow: Precision Volley", VOLLEY).entry }];
    const request = buildAiGatewayRequest(actorWith(systemId, stored), "", systemId);
    const capstone = skill("Longbow: Storm of Shafts", VOLLEY_2);
    capstone.entry.tier = 3;
    const transport = scriptedTransport([{ redCheck: [], proposals: [capstone] }]);
    const result = await runGatewayPipeline({ transport, request, config: {}, presetEvents: EVENTS, systemId, milestone: { kind: "capstone", level: 20 } });
    assert.deepEqual(result.proposals.map((p) => p.entry.name), ["Longbow: Storm of Shafts"]);
  });

  test(`[${systemId}] Author with AI: the placeholder being replaced is not counted as a pending duplicate`, async () => {
    const placeholder = { id: "knack-1", status: "pending", kind: "skill", entry: skill("Archery Knack", "Gain a small bonus when you use a bow in the way the notes describe.").entry };
    const other = { id: "p2", status: "pending", kind: "skill", entry: skill("Longbow: Precision Volley", VOLLEY).entry };
    const transport = scriptedTransport([{ redCheck: [], proposals: [skill("Longbow: Archery Knack Perfected", "Gain a small bonus when you use a bow in the way the notes describe, and reroll one miss per day.")] }]);
    const adapter = createGatewayAdapter({ provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "stub" }, { transportFactory: () => transport });
    const result = await adapter.authorProposal({ actor: actorWith(systemId, [placeholder, other]), proposal: placeholder, events: EVENTS, systemId });
    assert.equal(result.proposals.length, 1, JSON.stringify(result.skippedProposals));
    const payload = JSON.parse(transport.calls.at(-1).messages[1].content);
    assert.deepEqual(payload.actor.pendingProposals.map((p) => p.name), ["Longbow: Precision Volley"]);
  });
}

// ---- 4f3192e0: things done TO a character ----------------------------------------------------

test("the event schema requires actorRole (doer|target) right after actorName", () => {
  const item = EVENT_EXTRACTION_SCHEMA.properties.events.items;
  assert.deepEqual(item.properties.actorRole.enum, ["doer", "target"]);
  assert.ok(item.required.includes("actorRole"));
  const keys = Object.keys(item.properties);
  assert.equal(keys.indexOf("actorRole"), keys.indexOf("actorName") + 1);
  const prompt = buildExtractionMessages({ notesChunk: "x", request: buildAiGatewayRequest(actorWith("pf2e"), "x", "pf2e"), config: normalizeGatewayConfig({}), chunkIndex: 0, chunkCount: 1 })[0].content;
  assert.match(prompt, /actorRole/);
  assert.match(prompt, /"actorRole":"target"/, "a few-shot shows a target entry");
});

for (const systemId of ["pf2e", "dnd5e"]) {
  test(`[${systemId}] a 'target' entry is dropped into skippedEvents without a repair turn, and its follow-up does not fold into the event before it`, async () => {
    const transport = scriptedTransport([{
      events: [
        { quote: "torched a troll", actorName: "Tovin", actorRole: "doer", continuesPrevious: false, summary: "Tovin burned a troll.", tags: ["fire"], themes: [], outcome: "success", dangerGap: "none" },
        { quote: "'read very well' by a woman", actorName: "Tovin", actorRole: "target", continuesPrevious: false, summary: "A woman read Tovin very well.", tags: ["occultism"], themes: [], outcome: "success", dangerGap: "none" },
        { quote: "bargained her down to a month", actorName: "Tovin", actorRole: "doer", continuesPrevious: true, summary: "Tovin bargained her down to a month of dreams.", tags: ["diplomacy"], themes: ["haggling"], outcome: "success", dangerGap: "none" }
      ]
    }]);
    const request = buildAiGatewayRequest(actorWith(systemId), "Tovin torched a troll, was 'read very well' by a woman, bargained her down to a month.", systemId);
    const result = await runGatewayPipeline({ transport, request, config: { proposalMode: "never" }, systemId });
    assert.equal(transport.calls.length, 1, "no repair turn");
    assert.deepEqual(result.events.map((e) => e.summary), ["Tovin burned a troll.", "Tovin bargained her down to a month of dreams."]);
    assert.equal(result.skippedEvents.length, 1);
    assert.equal(result.skippedEvents[0].reason, "happened-to-actor");
  });

  test(`[${systemId}] notes with only a 'target' entry are a valid reading: no events, no repair, no failure`, async () => {
    const transport = scriptedTransport([{ events: [{ quote: "ambushed", actorName: "Kesh", actorRole: "target", continuesPrevious: false, summary: "Kesh was ambushed.", tags: ["martial"], themes: [], outcome: "failure", dangerGap: "none" }] }]);
    const request = buildAiGatewayRequest(actorWith(systemId), "Kesh got ambushed by two bandits.", systemId);
    const result = await runGatewayPipeline({ transport, request, config: { proposalMode: "never" }, systemId });
    assert.equal(transport.calls.length, 1);
    assert.equal(result.events.length, 0);
    assert.equal(result.skippedEvents[0].reason, "happened-to-actor");
  });
}

// ---- PM follow-ups from dev-integration's real-model run (2026-09-29) --------------------------

test("findDuplicateOwnedFeatureText: USING a trained skill or owned feature is fine; GRANTING it is a duplicate", () => {
  const owned = ["Athletics", "Second Wind", "Action Surge"];
  const uses = { name: "Ironhide: Unbroken Charge", mechanics: { effect: "Once per day, make an Athletics check against the target's Fortitude DC; on a success it is knocked prone and you gain a +2 bonus to Athletics checks until your next turn." } };
  assert.equal(findDuplicateOwnedFeatureText(uses, owned), null);
  assert.equal(findDuplicateOwnedFeatureText({ name: "Ironhide: Surge Tactics", mechanics: { effect: "When you use Action Surge, one ally can also move." } }, owned), null);
  assert.equal(findDuplicateOwnedFeatureText({ name: "Ironhide: Strong Back", mechanics: { effect: "You become trained in Athletics." } }, owned), "Athletics");
  assert.equal(findDuplicateOwnedFeatureText({ name: "Ironhide: Strong Back", mechanics: { effect: "You gain expertise in Athletics." } }, owned), "Athletics");
  assert.equal(findDuplicateOwnedFeatureText({ name: "Ironhide: Rally", mechanics: { effect: "You gain Second Wind." } }, owned), "Second Wind");
  assert.equal(findDuplicateOwnedFeatureText({ name: "Ironhide: Action Surge", mechanics: { effect: "Take one extra action." } }, owned), "Action Surge");
});

for (const systemId of ["pf2e", "dnd5e"]) {
  test(`[${systemId}] a milestone capstone that rolls a trained skill is kept (was skipped as duplicates-owned-proficiency)`, async () => {
    const request = buildAiGatewayRequest(actorWith(systemId), "", systemId);
    request.actor.ownedFeatures = ["Athletics"];
    const capstone = skill("Ironhide: Unbroken Charge", "Once per day, make an Athletics check against the target's Fortitude DC; on a success it is knocked prone.", { tags: ["athletics"], themes: [] });
    capstone.entry.tier = 3;
    const transport = scriptedTransport([{ redCheck: [], proposals: [capstone] }]);
    const result = await runGatewayPipeline({ transport, request, config: {}, presetEvents: EVENTS, systemId, milestone: { kind: "capstone", level: 20 } });
    assert.deepEqual(result.proposals.map((p) => p.entry.name), ["Ironhide: Unbroken Charge"], JSON.stringify(result.skippedProposals));
  });

  test(`[${systemId}] a dead provider on a stage-2-only call (Suggest, milestone, Author) throws the provider error instead of returning nothing`, async () => {
    const dead = { info: { model: "stub", provider: "ollama" }, async chat() { throw new AiProviderUnreachableError("http://127.0.0.1:11434", new Error("ECONNREFUSED")); } };
    const adapter = createGatewayAdapter({ provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "stub" }, { transportFactory: () => dead });
    const actor = actorWith(systemId);
    await assert.rejects(adapter({ actor, notes: "", systemId, events: EVENTS }), AiProviderUnreachableError);
    await assert.rejects(adapter({ actor, notes: "", systemId, events: EVENTS, milestone: { kind: "capstone", level: 20 } }), AiProviderUnreachableError);
    await assert.rejects(adapter.authorProposal({ actor, proposal: { id: "k", kind: "skill", entry: { name: "Archery Knack" } }, events: EVENTS, systemId }), AiProviderUnreachableError);
  });

  test(`[${systemId}] reading new notes still keeps its events when only the proposal stage dies`, async () => {
    let calls = 0;
    const flaky = {
      info: { model: "stub", provider: "ollama" },
      async chat() {
        calls += 1;
        if (calls === 1) return { content: JSON.stringify({ events: [{ quote: "shot", actorName: "Rook", actorRole: "doer", continuesPrevious: false, summary: "Rook shot the raider.", tags: ["ranged"], themes: ["archery"], outcome: "success", dangerGap: "none" }] }), ms: 1 };
        throw new AiProviderUnreachableError("http://127.0.0.1:11434", new Error("ECONNREFUSED"));
      }
    };
    const request = buildAiGatewayRequest(actorWith(systemId), "Rook shot the raider.", systemId);
    const result = await runGatewayPipeline({ transport: flaky, request, config: { proposalMode: "always" }, systemId });
    assert.equal(result.events.length, 1);
    assert.ok(result.skippedProposals.some((s) => s.reason === "proposal-stage-failed"));
  });
}
