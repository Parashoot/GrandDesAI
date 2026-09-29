import assert from "node:assert/strict";
import test from "node:test";

// Board 316705b6, b81a0357, 3962a001 -- proposal-quality fixes:
//  - 316705b6: a proposal must not duplicate an OWNED Skill/Class's mechanic under a new name
//    (Luz's "Sanctuary: Voice of Conviction" duplicated her owned "Sanctuary: Public Edict").
//  - b81a0357: pending AI proposals must not grow without limit (Tovin 5, Luz 4 pending for one
//    grant allowance each).
//  - 3962a001: a proposal must not restate the character's own class chassis (a Warlock "gaining"
//    Pact Magic and Eldritch Blast, a Rogue "gaining" proficiency in Sleight of Hand), and must not
//    use the OTHER system's vocabulary or an invented subsystem (dnd5e "free action"/"durability
//    system"; pf2e "bonus action"/"staggered"/"Craft check"/a flat round-count condition duration;
//    salt-lantern s1). Both systems throughout.

import {
  findDuplicateOwnedMechanic,
  findForbiddenSystemTerm,
  findDuplicateClassFeature,
  findDuplicateOwnedFeatureText,
  findBareClassMotif,
  runGatewayPipeline
} from "../scripts/ai/pipeline.js";
import { buildProposalMessages } from "../scripts/ai/prompts.js";
import { normalizeGatewayConfig, pendingProposalCap } from "../scripts/ai/gateway-config.js";
import { buildAiGatewayRequest } from "../scripts/ai-gateway.js";
import { getCharacterKnownFeatures5e } from "../scripts/systems/dnd5e-adapter.js";
import { getCharacterKnownFeaturesPf2e } from "../scripts/systems/pf2e-adapter.js";
import { validateSkillEntry } from "../scripts/validator.js";
import { GrandDesignApi } from "../scripts/api.js";
import { MODULE_ID } from "../scripts/constants.js";
import { makeHarnessActor } from "../tools/nlp-scale/lib.mjs";

// =================================================================================================
// Deterministic helpers, unit-tested directly (both systems where the check is system-specific)
// =================================================================================================

test("findDuplicateOwnedMechanic: same mechanic under a new name is caught (Luz's Sanctuary case)", () => {
  const owned = [{
    name: "Sanctuary: Public Edict",
    mechanics: {
      effect: "As an action, hold up your holy symbol and make a Persuasion or Intimidation check against one hostile creature within 30 feet. On a failure, it must succeed at a Wisdom saving throw or become Frightened of you until the end of its next turn."
    },
    metadata: { tags: ["divine", "intimidation", "diplomacy"] }
  }];
  const duplicate = {
    name: "Sanctuary: Voice of Conviction",
    mechanics: {
      effect: "Hold up your holy symbol and make a Persuasion or Intimidation check against one hostile creature within 30 feet; on a failure it must succeed at a Wisdom saving throw or become Frightened of you."
    },
    metadata: { tags: ["divine", "intimidation"] }
  };
  const hit = findDuplicateOwnedMechanic(duplicate, owned);
  assert.equal(hit?.name, "Sanctuary: Public Edict");
});

test("findDuplicateOwnedMechanic: a genuinely different mechanic is not flagged", () => {
  const owned = [{
    name: "Sanctuary: Public Edict",
    mechanics: { effect: "As an action, hold up your holy symbol and make a Persuasion or Intimidation check against one hostile creature within 30 feet. On a failure it becomes Frightened." },
    metadata: { tags: ["divine", "intimidation"] }
  }];
  const distinct = {
    name: "Sanctuary: Mending Light",
    mechanics: { effect: "When you cast a healing spell on an ally, use your reaction to grant that ally 5 temporary hit points." },
    metadata: { tags: ["divine", "support", "medicine"] }
  };
  assert.equal(findDuplicateOwnedMechanic(distinct, owned), null);
});

test("findDuplicateOwnedMechanic: too little mechanics text to compare is never flagged (no false positive on stubs)", () => {
  const owned = [{ name: "X", mechanics: { effect: "Do a thing." }, metadata: { tags: [] } }];
  assert.equal(findDuplicateOwnedMechanic({ name: "Y", mechanics: { effect: "Do it." }, metadata: { tags: [] } }, owned), null);
});

for (const systemId of ["dnd5e", "pf2e"]) {
  test(`findForbiddenSystemTerm [${systemId}]: this system's own vocabulary is never flagged`, () => {
    const nativeTerm = systemId === "dnd5e" ? "As a bonus action, curse the target." : "As a free action, curse the target.";
    assert.equal(findForbiddenSystemTerm(systemId, { mechanics: { effect: nativeTerm } }), null);
  });
}

test('findForbiddenSystemTerm [dnd5e]: "free action" (PF2e\'s action economy) is rejected', () => {
  assert.equal(findForbiddenSystemTerm("dnd5e", { mechanics: { effect: "As a free action, you may curse the target." } }), "free action");
});

test('findForbiddenSystemTerm [dnd5e]: an invented "durability system" is rejected', () => {
  assert.equal(findForbiddenSystemTerm("dnd5e", { mechanics: { effect: "This only applies if using a durability system for your gear." } }), "durability system");
});

test('findForbiddenSystemTerm [pf2e]: "bonus action" (5e\'s action economy) is rejected', () => {
  assert.equal(findForbiddenSystemTerm("pf2e", { mechanics: { effect: "As a bonus action, curse the target." } }), "bonus action");
});

test('findForbiddenSystemTerm [pf2e]: "staggered" (not a PF2e condition) is rejected (salt-lantern s1)', () => {
  assert.equal(findForbiddenSystemTerm("pf2e", { mechanics: { effect: "The target is staggered and cannot act." } }), "staggered (not a PF2e condition)");
});

test('findForbiddenSystemTerm [pf2e]: "Craft check" (PF2e\'s skill is Crafting) is rejected (salt-lantern s1)', () => {
  assert.equal(findForbiddenSystemTerm("pf2e", { mechanics: { effect: "Attempt a Craft check to repair the item." } }), "Craft check/skill (PF2e skill is Crafting)");
});

test("findForbiddenSystemTerm [pf2e]: a PF2e condition with a flat round-count duration is rejected (salt-lantern s1)", () => {
  const hit = findForbiddenSystemTerm("pf2e", { mechanics: { effect: "The target is blinded for 1 round." } });
  assert.ok(hit && hit.includes("round-count duration"), hit);
});

test("findForbiddenSystemTerm: an unsupported systemId never throws and never flags", () => {
  assert.equal(findForbiddenSystemTerm("starfinder", { mechanics: { effect: "As a bonus action, do the thing." } }), null);
});

test('findDuplicateClassFeature [dnd5e]: a Warlock "gaining" Pact Magic/Eldritch Blast is caught (Hexblade case, 3962a001)', () => {
  const entry = { name: "Hexblade: Infernal Pact", mechanics: { effect: "You gain Pact Magic and can cast Eldritch Blast at will." } };
  const hit = findDuplicateClassFeature(entry, { systemClass: "Warlock 3", systemId: "dnd5e" });
  assert.equal(hit, "pact magic");
});

test('findDuplicateClassFeature [dnd5e]: a Rogue "gaining" Sleight of Hand/Thieves\' Tools is caught (Shadowfingers case, 3962a001)', () => {
  const entry = { name: "Shadowfingers: Sleight of Hand", mechanics: { effect: "You gain proficiency in Sleight of Hand and Thieves' Tools." } };
  const hit = findDuplicateClassFeature(entry, { systemClass: "Rogue 3", systemId: "dnd5e" });
  assert.ok(["sleight of hand", "thieves' tools"].includes(hit), hit);
});

test("findDuplicateClassFeature [pf2e]: a Rogue proposal restating Sneak Attack is caught", () => {
  const entry = { name: "Backalley: Precise Cut", mechanics: { effect: "You gain Sneak Attack against a flat-footed foe." } };
  assert.equal(findDuplicateClassFeature(entry, { systemClass: "Rogue", systemId: "pf2e" }), "sneak attack");
});

test("findDuplicateClassFeature: a genuinely new ability for the class is never flagged", () => {
  const entry = { name: "Hexblade: Grim Ledger", mechanics: { effect: "Once per day, mark a foe; your next weapon Strike against it deals extra necrotic damage." } };
  assert.equal(findDuplicateClassFeature(entry, { systemClass: "Warlock 3", systemId: "dnd5e" }), null);
});

test("findDuplicateClassFeature: an unrecognized class name is never flagged", () => {
  const entry = { name: "Tinker: Overclock", mechanics: { effect: "You gain Pact Magic." } };
  assert.equal(findDuplicateClassFeature(entry, { systemClass: "Artificer 3", systemId: "dnd5e" }), null);
});

test("findDuplicateOwnedFeatureText: granting a proficiency already on the sheet is caught", () => {
  const owned = ["Sleight of Hand", "Thieves' Tools", "Expertise"];
  const entry = { name: "Palmsmith: Quick Hands", mechanics: { effect: "You gain proficiency in Sleight of Hand." } };
  assert.equal(findDuplicateOwnedFeatureText(entry, owned), "Sleight of Hand");
});

test("findDuplicateOwnedFeatureText: a short/generic owned name never matches on its own (avoids false positives)", () => {
  assert.equal(findDuplicateOwnedFeatureText({ name: "Aid the Fallen", mechanics: { effect: "Aid an ally." } }, ["Aid"]), null);
});

test("findDuplicateOwnedFeatureText: no owned features is never flagged", () => {
  assert.equal(findDuplicateOwnedFeatureText({ name: "X", mechanics: { effect: "Y" } }, []), null);
});

test("findBareClassMotif: the bare class name used as the motif is caught (salt-lantern s1)", () => {
  assert.equal(findBareClassMotif("Monk: Aerial Momentum", "Monk"), "Monk");
  assert.equal(findBareClassMotif("Champion's Bulwark", "Champion"), "Champion");
  assert.equal(findBareClassMotif("Ranger: Salt-Wind Shot", "Ranger"), "Ranger");
});

test("findBareClassMotif: a coined motif that merely relates to the class is untouched", () => {
  assert.equal(findBareClassMotif("Snarewright: Trap Sense", "Ranger"), null);
});

test("findBareClassMotif: dnd5e multiclass strings are handled (level numbers stripped)", () => {
  assert.equal(findBareClassMotif("Fighter: Extra Swing", "Fighter 3 / Wizard 2"), "Fighter");
  assert.equal(findBareClassMotif("Battlemage: Extra Swing", "Fighter 3 / Wizard 2"), null);
});

// =================================================================================================
// System adapters: reading the actor's own native features/proficiencies (3962a001)
// =================================================================================================

test("getCharacterKnownFeatures5e reads proficient skills and class/subclass/tool items", () => {
  const actor = {
    items: {
      filter: (fn) => [
        { type: "class", name: "Warlock" },
        { type: "feat", name: "Some Unrelated Feat" },
        { type: "weapon", name: "Ignored Weapon" }
      ].filter(fn)
    },
    system: { skills: { slt: { value: 1 }, ath: { value: 0 } } }
  };
  const features = getCharacterKnownFeatures5e(actor);
  assert.ok(features.includes("Warlock"));
  assert.ok(features.includes("Some Unrelated Feat"));
  assert.ok(features.includes("Sleight of Hand"));
  assert.ok(!features.includes("Athletics"));
});

test("getCharacterKnownFeatures5e never throws on a bare actor", () => {
  assert.deepEqual(getCharacterKnownFeatures5e({}), []);
});

test("getCharacterKnownFeaturesPf2e reads trained skills and class/background/ancestry feats", () => {
  const actor = {
    items: { filter: (fn) => [{ type: "class", name: "Rogue" }, { type: "weapon", name: "Ignored" }].filter(fn) },
    system: { skills: { thievery: { rank: 1, label: "Thievery" }, acrobatics: { rank: 0 } } }
  };
  const features = getCharacterKnownFeaturesPf2e(actor);
  assert.ok(features.includes("Rogue"));
  assert.ok(features.includes("Thievery"));
  assert.ok(!features.includes("Acrobatics"));
});

test("getCharacterKnownFeaturesPf2e never throws on a bare actor", () => {
  assert.deepEqual(getCharacterKnownFeaturesPf2e({}), []);
});

// =================================================================================================
// prompts.js: what stage 2 is actually told (316705b6, 3962a001)
// =================================================================================================

function baseRequest(systemId, overrides = {}) {
  const req = buildAiGatewayRequest(makeHarnessActor(systemId, overrides), "notes", systemId);
  return req;
}

test("buildProposalMessages sends each owned entry's effect, not just its name (316705b6)", () => {
  const request = baseRequest("dnd5e", {
    registry: { skills: { "skill:sanctuary-public-edict": { name: "Sanctuary: Public Edict", mechanics: { effect: "Holy symbol Persuasion/Intimidation check." }, metadata: { tags: ["divine"] } } } }
  });
  const [, user] = buildProposalMessages({ request, config: normalizeGatewayConfig({}), events: [], allowClass: false });
  const payload = JSON.parse(user.content);
  assert.deepEqual(payload.actor.existingClassesAndSkills, [{ name: "Sanctuary: Public Edict", effect: "Holy symbol Persuasion/Intimidation check." }]);
});

test("buildProposalMessages' system prompt tells the model never to duplicate an owned mechanic or the class's own baseline (3962a001, 316705b6)", () => {
  const request = baseRequest("pf2e");
  const [system] = buildProposalMessages({ request, config: normalizeGatewayConfig({}), events: [], allowClass: false });
  assert.ok(/duplicate.*owns/i.test(system.content) || /duplicate.*owned/i.test(system.content));
  assert.ok(/restates a feature, spell, or proficiency/i.test(system.content));
});

test("buildProposalMessages' forbidden-term guidance is system-specific", () => {
  const dnd5eSystem = buildProposalMessages({ request: baseRequest("dnd5e"), config: normalizeGatewayConfig({}), events: [], allowClass: false })[0];
  const pf2eSystem = buildProposalMessages({ request: baseRequest("pf2e"), config: normalizeGatewayConfig({}), events: [], allowClass: false })[0];
  assert.ok(dnd5eSystem.content.includes('"free action"'));
  assert.ok(!dnd5eSystem.content.includes('"bonus action" (that is 5e'));
  assert.ok(pf2eSystem.content.includes('"bonus action"'));
  assert.ok(pf2eSystem.content.includes("staggered"));
  assert.ok(pf2eSystem.content.includes("Crafting"));
});

test("buildProposalMessages carries actor.ownedFeatures when the adapter provided them (3962a001)", () => {
  const request = baseRequest("dnd5e");
  request.actor.ownedFeatures = ["Pact Magic", "Eldritch Blast"];
  const [, user] = buildProposalMessages({ request, config: normalizeGatewayConfig({}), events: [], allowClass: false });
  assert.deepEqual(JSON.parse(user.content).actor.ownedFeatures, ["Pact Magic", "Eldritch Blast"]);
});

test("buildProposalMessages omits actor.ownedFeatures when the adapter reported none", () => {
  const request = baseRequest("pf2e");
  const [, user] = buildProposalMessages({ request, config: normalizeGatewayConfig({}), events: [], allowClass: false });
  assert.ok(!("ownedFeatures" in JSON.parse(user.content).actor));
});

// =================================================================================================
// Full pipeline wiring (runGatewayPipeline): the deterministic backstops actually skip proposals
// =================================================================================================

function scriptedTransport(replies) {
  const calls = [];
  return {
    calls,
    info: { model: "stub-model", provider: "ollama" },
    async chat(args) {
      calls.push(args);
      const reply = replies.length > 1 ? replies.shift() : replies[0];
      return { content: typeof reply === "string" ? reply : JSON.stringify(reply), ms: 1, truncated: false };
    }
  };
}

function pipelineRequest(notes, systemId, harnessOverrides = {}, requestOverrides = {}) {
  const req = buildAiGatewayRequest(makeHarnessActor(systemId, harnessOverrides), notes, systemId);
  req.actor.grandDesign.availableGrantAllowances = 1;
  Object.assign(req.actor, requestOverrides);
  return req;
}

const ev = (summary, tags) => ({ quote: summary, summary, tags, themes: [], outcome: "success", dangerGap: "none" });

function skillProposal(name, effect, tags = ["martial"], overrides = {}) {
  return {
    kind: "skill",
    evidence: ["Some evidence"],
    entry: {
      name,
      tier: 1,
      system_equivalent: "Skill feat",
      gameItem: { kind: "passive" },
      mechanics: { effect, duration: "while active", frequency: { max: 1, per: "unlimited" } },
      metadata: { tags, themes: [], lineage: { operation: "origin", sources: [], rationale: "Earned it." } },
      ...overrides
    }
  };
}

test("pipeline: a proposal duplicating an owned Skill's mechanic under a new name is skipped (316705b6)", async () => {
  const registry = {
    skills: {
      "skill:sanctuary-public-edict": {
        name: "Sanctuary: Public Edict",
        mechanics: { effect: "As an action, hold up your holy symbol and make a Persuasion or Intimidation check against one hostile creature within 30 feet. On a failure it becomes Frightened of you." },
        metadata: { tags: ["divine", "intimidation"] }
      }
    }
  };
  const transport = scriptedTransport([
    { events: [ev("Luz held up her holy symbol.", ["divine"])] },
    { proposals: [skillProposal(
      "Sanctuary: Voice of Conviction",
      "Hold up your holy symbol and make a Persuasion or Intimidation check against one hostile creature within 30 feet; on a failure it becomes Frightened of you.",
      ["divine", "intimidation"]
    )] }
  ]);
  const result = await runGatewayPipeline({ transport, request: pipelineRequest("notes", "dnd5e", { registry }), config: {} });
  assert.equal(result.proposals.length, 0);
  assert.ok(result.skippedProposals.some((s) => s.reason === "duplicates-owned"), JSON.stringify(result.skippedProposals));
});

test("pipeline: a proposal that is genuinely new is accepted even with an unrelated owned Skill on file", async () => {
  const registry = {
    skills: {
      "skill:sanctuary-public-edict": {
        name: "Sanctuary: Public Edict",
        mechanics: { effect: "As an action, hold up your holy symbol and make a Persuasion or Intimidation check against one hostile creature within 30 feet. On a failure it becomes Frightened of you." },
        metadata: { tags: ["divine", "intimidation"] }
      }
    }
  };
  const transport = scriptedTransport([
    { events: [ev("Luz healed an ally.", ["medicine"])] },
    { proposals: [skillProposal("Sanctuary: Mending Light", "When you cast a healing spell on an ally, use your reaction to grant that ally 5 temporary hit points.", ["divine", "support", "medicine"])] }
  ]);
  const result = await runGatewayPipeline({ transport, request: pipelineRequest("notes", "dnd5e", { registry }), config: {} });
  assert.equal(result.proposals.length, 1);
  assert.deepEqual(validateSkillEntry(result.proposals[0].entry).errors, []);
});

test("pipeline [dnd5e]: a proposal written with PF2e's \"free action\" is rejected, not silently kept (3962a001)", async () => {
  const transport = scriptedTransport([
    { events: [ev("Kellin acted fast.", ["martial"])] },
    { proposals: [skillProposal("Quickdraw: Snap Strike", "As a free action, you may draw a weapon and make a Strike.")] }
  ]);
  const result = await runGatewayPipeline({ transport, request: pipelineRequest("notes", "dnd5e"), config: {} });
  assert.equal(result.proposals.length, 0);
  assert.ok(result.skippedProposals.some((s) => String(s.reason).startsWith("wrong-system-terms")), JSON.stringify(result.skippedProposals));
});

test('pipeline [pf2e]: a proposal written with 5e\'s "bonus action" is rejected (3962a001)', async () => {
  const transport = scriptedTransport([
    { events: [ev("Kellin acted fast.", ["martial"])] },
    { proposals: [skillProposal("Quickdraw: Snap Strike", "As a bonus action, you may draw a weapon and make a Strike.")] }
  ]);
  const result = await runGatewayPipeline({ transport, request: pipelineRequest("notes", "pf2e"), config: {} });
  assert.equal(result.proposals.length, 0);
  assert.ok(result.skippedProposals.some((s) => String(s.reason).startsWith("wrong-system-terms")), JSON.stringify(result.skippedProposals));
});

test('pipeline [dnd5e]: a Warlock proposal that just restates Pact Magic/Eldritch Blast is rejected (Hexblade case, 3962a001)', async () => {
  const transport = scriptedTransport([
    { events: [ev("Tovin struck a dark bargain.", ["occultism"])] },
    { proposals: [skillProposal("Hexblade: Infernal Pact", "You gain Pact Magic and can cast Eldritch Blast at will.")] }
  ]);
  const result = await runGatewayPipeline({ transport, request: pipelineRequest("notes", "dnd5e", { className: "Warlock" }), config: {} });
  assert.equal(result.proposals.length, 0);
  assert.ok(result.skippedProposals.some((s) => s.reason === "duplicates-class-feature"), JSON.stringify(result.skippedProposals));
});

test("pipeline [dnd5e]: a proposal granting a proficiency already on the actor's sheet is rejected (Shadowfingers case, 3962a001)", async () => {
  const transport = scriptedTransport([
    { events: [ev("Wick picked a pocket.", ["thievery"])] },
    { proposals: [skillProposal("Shadowfingers: Sleight of Hand", "You gain proficiency in Sleight of Hand and Thieves' Tools.")] }
  ]);
  // className is deliberately NOT one of BASELINE_CLASS_FEATURES' entries, so this exercises the
  // sheet-derived ownedFeatures check (findDuplicateOwnedFeatureText) specifically, not the
  // hand-picked baseline table (findDuplicateClassFeature, covered by the Hexblade test above).
  const result = await runGatewayPipeline({
    transport,
    request: pipelineRequest("notes", "dnd5e", { className: "Gunslinger" }, { ownedFeatures: ["Sleight of Hand", "Thieves' Tools"] }),
    config: {}
  });
  assert.equal(result.proposals.length, 0);
  assert.ok(result.skippedProposals.some((s) => s.reason === "duplicates-owned-proficiency"), JSON.stringify(result.skippedProposals));
});

test("pipeline [pf2e]: a bare class-name motif is re-coined from the theme, not rejected (salt-lantern s1/s2, 3962a001)", async () => {
  const transport = scriptedTransport([
    { events: [ev("Ren leapt across the gap.", ["acrobatics"])] },
    { proposals: [skillProposal("Monk: Aerial Momentum", "Once per round, treat difficult terrain from a fall as normal terrain.")] }
  ]);
  const result = await runGatewayPipeline({ transport, request: pipelineRequest("notes", "pf2e", { className: "Monk" }), config: {} });
  // Skipping emptied a whole Suggest for Buck (3 of 3 "Monk:"); the Skill is kept under a new motif.
  assert.equal(result.proposals.length, 1, JSON.stringify(result.skippedProposals));
  assert.match(result.proposals[0].entry.name, /^(?!Monk\b)\p{L}+: Aerial Momentum$/u);
});

test("pipeline [pf2e]: Craft check, staggered and 'blinded for 1 round' are rewritten to PF2e terms, not rejected", async () => {
  const transport = scriptedTransport([
    { events: [ev("Ren threw salt in the hag's eyes.", ["deception"])] },
    { proposals: [skillProposal("Saltspray: Grit Toss", "Make a Craft check to mix grit; on a success the target is blinded for 1 round, on a critical success it is also staggered.")] }
  ]);
  const result = await runGatewayPipeline({ transport, request: pipelineRequest("notes", "pf2e", { className: "Rogue" }), config: {} });
  assert.equal(result.proposals.length, 1, JSON.stringify(result.skippedProposals));
  const effect = result.proposals[0].entry.mechanics.effect;
  assert.match(effect, /Crafting check/);
  assert.match(effect, /blinded until the end of your next turn/);
  assert.match(effect, /slowed 1/);
  assert.doesNotMatch(effect, /staggered|for 1 round|Craft check/);
});

// =================================================================================================
// b81a0357: pending AI proposals are capped
// =================================================================================================

test("pendingProposalCap: floors at pendingProposalCapMin and grows with allowances + pendingProposalCapExtra", () => {
  assert.equal(pendingProposalCap({}, 0), 5);
  assert.equal(pendingProposalCap({}, 1), 5);
  assert.equal(pendingProposalCap({}, 4), 6);
  assert.equal(pendingProposalCap({ pendingProposalCapMin: 1, pendingProposalCapExtra: 2 }, 0), 2);
  assert.equal(pendingProposalCap({ pendingProposalCapMin: 6, pendingProposalCapExtra: 0 }, 0), 6);
  assert.equal(pendingProposalCap({ pendingProposalCapMin: 1, pendingProposalCapExtra: 2 }, 3), 5);
});

test("normalizeGatewayConfig clamps pendingProposalCapMin/Extra and falls back on garbage input", () => {
  const cfg = normalizeGatewayConfig({ pendingProposalCapMin: "not a number", pendingProposalCapExtra: 999 });
  assert.equal(cfg.pendingProposalCapMin, 5);
  assert.equal(cfg.pendingProposalCapExtra, 20);
});

function createMockActor(systemId, name = "Brakka") {
  const flags = { [MODULE_ID]: {} };
  return {
    id: `mock-${systemId}-${name}`,
    name,
    documentName: "Actor",
    type: "character",
    system: systemId === "dnd5e"
      ? { details: { level: 4 }, skills: { acr: { mod: 3, total: 5 } }, attributes: { prof: 2 } }
      : { details: { level: { value: 4 } }, skills: { acrobatics: { mod: 8 } } },
    items: { find: () => undefined, filter: () => [] },
    getFlag(module, key) {
      return flags[module]?.[key];
    },
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) {
        const [, , key] = path.split(".");
        flags[MODULE_ID][key] = value;
      }
      return this;
    }
  };
}

async function withFoundry(systemId, fn) {
  const originalGame = globalThis.game;
  const originalHooks = globalThis.Hooks;
  globalThis.game = { user: { isGM: true }, system: { id: systemId } };
  globalThis.Hooks = { callAll: () => {} };
  try {
    return await fn();
  } finally {
    globalThis.game = originalGame;
    globalThis.Hooks = originalHooks;
  }
}

function validSkill(name, extra = {}) {
  return {
    kind: "skill",
    evidence: ["Some evidence"],
    ...extra,
    entry: {
      name,
      tier: 1,
      system_equivalent: "Skill feat",
      gameItem: { kind: "passive" },
      mechanics: { effect: `${name} grants a narrative benefit.`, duration: "while active", frequency: { max: 1, per: "unlimited" } },
      metadata: { tags: ["martial"], themes: [], lineage: { operation: "origin", sources: [], rationale: "Earned it." } }
    }
  };
}

for (const systemId of ["pf2e", "dnd5e"]) {
  test(`[${systemId}] analyzeSessionNotes caps pending AI proposals, keeping the strongest/newest and reporting the rest (b81a0357)`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    api.setGatewayConfigProvider(() => ({ pendingProposalCapMin: 2, pendingProposalCapExtra: 0 }));
    const actor = createMockActor(systemId);

    const names = ["Alpha Skill", "Beta Skill", "Gamma Skill"];
    let lastResult;
    for (const [i, name] of names.entries()) {
      api.setProposalAdapter(async () => ({
        events: [{ summary: `Brakka did notable thing ${i}.`, tags: ["martial"], outcome: "success", quote: `did notable thing ${i}` }],
        proposals: [validSkill(name, { evidence: Array.from({ length: i + 1 }, (_, k) => `evidence ${k}`) })]
      }));
      lastResult = await api.analyzeSessionNotes(actor, `Brakka did notable thing ${i}.`);
    }

    const pendingAi = api.getGrowth(actor).proposals.filter((p) => p.status === "pending" && p.source === "ai-gateway");
    assert.equal(pendingAi.length, 2, "capped to pendingProposalCapMin");
    assert.deepEqual(new Set(pendingAi.map((p) => p.entry.name)), new Set(["Beta Skill", "Gamma Skill"]), "kept the two with the most evidence");
    assert.ok(
      lastResult.adapterSkippedProposals.some((s) => s.reason === "pending-cap" && s.proposal.entry?.name === "Alpha Skill"),
      JSON.stringify(lastResult.adapterSkippedProposals)
    );
  }));

  test(`[${systemId}] requestGrowthProposals also respects the pending cap (b81a0357)`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    api.setGatewayConfigProvider(() => ({ pendingProposalCapMin: 1, pendingProposalCapExtra: 0 }));
    const actor = createMockActor(systemId);

    // Seed one recorded event so requestGrowthProposals has evidence to work from.
    api.setProposalAdapter(async () => ({ events: [{ summary: "Brakka trained.", tags: ["martial"], outcome: "success", quote: "trained" }], proposals: [] }));
    await api.analyzeSessionNotes(actor, "Brakka trained.");

    api.setProposalAdapter(async () => ({ proposals: [validSkill("First Suggestion")] }));
    const first = await api.requestGrowthProposals(actor);
    assert.equal(first.added.length, 1);

    api.setProposalAdapter(async () => ({ proposals: [validSkill("Second Suggestion", { evidence: ["more evidence than the first"] })] }));
    const second = await api.requestGrowthProposals(actor);

    const pendingAi = api.getGrowth(actor).proposals.filter((p) => p.status === "pending" && p.source === "ai-gateway");
    assert.equal(pendingAi.length, 1, "capped to pendingProposalCapMin=1");
    assert.ok(second.skipped?.some((s) => s.reason === "pending-cap"), JSON.stringify(second.skipped));
  }));
}
