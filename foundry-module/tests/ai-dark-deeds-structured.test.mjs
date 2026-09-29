// Batch 3 gateway half: every extracted event carries darkDeed + darkSeverity (board 21e944ed, Horror
// Rank from deeds), and proposals carry mechanics.structured in each system's vocabulary (board
// 5a0cea2e, real game items). Shapes: contract3 sections 1 and 2.
import assert from "node:assert/strict";
import test from "node:test";

import { coerceEvent, coerceDarkDeed, coerceVice, darkSeverityRank } from "../scripts/ai/normalize.js";
import { EVENT_ITEM_SCHEMA, PROPOSAL_ENTRY_SCHEMA, proposalSchemaCapped } from "../scripts/ai/schemas.js";
import { coerceStructuredMechanics, fillStructuredFromEffect, structuredMechanicsSchema, splitDice, DND5E_SKILL_KEYS, STRUCTURED_SKILLS } from "../scripts/ai/structured.js";
import { buildExtractionMessages, buildProposalMessages, structuredInstruction, BUILTIN_EXTRACTION_EXAMPLES } from "../scripts/ai/prompts.js";
import { mergeFollowUpEvents, repairProposal, runGatewayPipeline } from "../scripts/ai/pipeline.js";
import { normalizeGatewayConfig } from "../scripts/ai/gateway-config.js";
import { buildAiGatewayRequest } from "../scripts/ai-gateway.js";
import { validateSkillEntry } from "../scripts/validator.js";
import { validateGrowthEvent } from "../scripts/progression.js";
import { makeHarnessActor } from "../tools/nlp-scale/lib.mjs";

function scriptedTransport(replies) {
  const calls = [];
  return {
    calls,
    info: { model: "stub-model", provider: "ollama" },
    async chat(args) {
      calls.push({ ...args, messages: args.messages.map((m) => ({ ...m })) });
      const reply = replies.length > 1 ? replies.shift() : replies[0];
      return { content: typeof reply === "string" ? reply : JSON.stringify(reply), ms: 1, truncated: false };
    }
  };
}

function request(notes, systemId = "pf2e", allowances = 1) {
  const req = buildAiGatewayRequest(makeHarnessActor(systemId), notes, systemId);
  req.actor.grandDesign.availableGrantAllowances = allowances;
  return req;
}

// ---- section 1: dark deeds on events -------------------------------------------------------------

test("event schema requires darkDeed and darkSeverity, right after outcome", () => {
  const keys = Object.keys(EVENT_ITEM_SCHEMA.properties);
  assert.equal(keys.indexOf("darkDeed"), keys.indexOf("outcome") + 1);
  assert.equal(keys.indexOf("darkSeverity"), keys.indexOf("outcome") + 2);
  assert.ok(EVENT_ITEM_SCHEMA.required.includes("darkDeed"));
  assert.ok(EVENT_ITEM_SCHEMA.required.includes("darkSeverity"));
  assert.deepEqual(EVENT_ITEM_SCHEMA.properties.darkSeverity.enum, ["none", "minor", "serious", "monstrous"]);
  assert.equal(EVENT_ITEM_SCHEMA.properties.darkDeed.enum[0], "none");
  assert.ok(EVENT_ITEM_SCHEMA.properties.darkDeed.enum.includes("cruelty"));
});

test("coerceDarkDeed maps synonyms to the taxonomy and keeps the pair consistent", () => {
  assert.deepEqual(pickDark(coerceDarkDeed("Cruelty", "Serious")), { darkDeed: "cruelty", darkSeverity: "serious" });
  assert.deepEqual(pickDark(coerceDarkDeed("torture", "extreme")), { darkDeed: "cruelty", darkSeverity: "monstrous" });
  // A named vice with no severity is the smallest step, never a guess upward.
  assert.deepEqual(pickDark(coerceDarkDeed("treachery", undefined)), { darkDeed: "betrayal", darkSeverity: "minor" });
  // Unknown words never invent a vice; no vice means no severity.
  assert.deepEqual(pickDark(coerceDarkDeed("rudeness", "serious")), { darkDeed: "none", darkSeverity: "none" });
  assert.deepEqual(pickDark(coerceDarkDeed("none", "monstrous")), { darkDeed: "none", darkSeverity: "none" });
  assert.deepEqual(pickDark(coerceDarkDeed(undefined, undefined)), { darkDeed: "none", darkSeverity: "none" });
  // The taxonomy has no cannibalism vice: dev-harness gold reads it as desecration, monstrous.
  assert.deepEqual(pickDark(coerceDarkDeed("cannibalism", "serious")), { darkDeed: "desecration", darkSeverity: "monstrous" });
  assert.equal(coerceVice("blood lust"), "bloodlust");
  assert.equal(coerceVice("betrayed"), "betrayal");
  assert.ok(darkSeverityRank("monstrous") > darkSeverityRank("serious"));
});

function pickDark({ darkDeed, darkSeverity }) {
  return { darkDeed, darkSeverity };
}

test("coerceEvent always carries darkDeed/darkSeverity, and they pass the event validator", () => {
  const dark = coerceEvent({ quote: "Tovin killed the goblin after it surrendered", actorName: "Tovin", summary: "Tovin killed a surrendered goblin.", tags: ["martial"], themes: [], outcome: "success", darkDeed: "cruelty", darkSeverity: "serious" }).event;
  assert.equal(dark.darkDeed, "cruelty");
  assert.equal(dark.darkSeverity, "serious");
  assert.deepEqual(validateGrowthEvent(dark).errors, []);
  const plain = coerceEvent({ summary: "Mira cheated at dice.", tags: ["deception"], outcome: "failure" }).event;
  assert.equal(plain.darkDeed, "none");
  assert.equal(plain.darkSeverity, "none");
});

test("a folded follow-up keeps the worse dark deed of the two lines", () => {
  const base = { tags: ["martial"], themes: [], outcome: "success" };
  const { events } = mergeFollowUpEvents([
    { ...base, summary: "Brakka beat the bandit.", quote: "Brakka beat the bandit", actorName: "Brakka", darkDeed: "none", darkSeverity: "none" },
    { ...base, summary: "Brakka strung him up while he begged.", quote: "strung him up while he begged", actorName: "Brakka", continuesPrevious: true, darkDeed: "cruelty", darkSeverity: "serious" }
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].darkDeed, "cruelty");
  assert.equal(events[0].darkSeverity, "serious");
});

test("the extraction prompt teaches darkDeed, with a dark few-shot and 'none' everywhere else", () => {
  const cfg = normalizeGatewayConfig({});
  const [system] = buildExtractionMessages({ notesChunk: "x", request: request("x"), config: cfg });
  assert.match(system.content, /- darkDeed: "none" for almost every event/);
  assert.match(system.content, /anything done TO the character/);
  assert.match(system.content, /"darkDeed":"cruelty","darkSeverity":"serious"/);
  // Cheating at cards (Ivo) is shown as "none".
  assert.match(system.content, /rigging cards"[^}]*"darkDeed":"none"/);
  assert.ok(BUILTIN_EXTRACTION_EXAMPLES.some((ex) => ex.events.some((e) => e.darkDeed === "cruelty")));
});

test("stage 2 sees darkDeed only on the dark events, and the red check is told to reuse it", async () => {
  const transport = scriptedTransport([
    { events: [
      { quote: "Tovin killed the goblin that surrendered", actorName: "", actorRole: "doer", continuesPrevious: false, summary: "A goblin that surrendered was killed.", tags: ["martial"], themes: ["killing-the-surrendered"], outcome: "success", darkDeed: "cruelty", darkSeverity: "serious", dangerGap: "none" },
      { quote: "picked the lock", actorName: "", actorRole: "doer", continuesPrevious: false, summary: "Picked the lock.", tags: ["thievery"], themes: ["lockpicking"], outcome: "success", darkDeed: "none", darkSeverity: "none", dangerGap: "none" }
    ] },
    { redCheck: [], proposals: [] }
  ]);
  const result = await runGatewayPipeline({ transport, request: request("notes"), config: { maxRepairAttempts: 0 } });
  assert.equal(result.events[0].darkDeed, "cruelty");
  assert.equal(result.events[1].darkDeed, "none");
  const payload = JSON.parse(transport.calls[1].messages[1].content);
  assert.equal(payload.newEvents[0].darkDeed, "cruelty");
  assert.equal(payload.newEvents[0].darkSeverity, "serious");
  assert.equal("darkDeed" in payload.newEvents[1], false);
  assert.match(transport.calls[1].messages[0].content, /carries darkDeed was already read as that vice/);
});

// ---- section 2: structured mechanics --------------------------------------------------------------

test("the structured schema uses each system's own vocabulary as enums", () => {
  const pf = structuredMechanicsSchema("pf2e").properties;
  const dnd = structuredMechanicsSchema("dnd5e").properties;
  assert.deepEqual(pf.save.properties.save.enum, ["fortitude", "reflex", "will"]);
  assert.deepEqual(dnd.save.properties.save.enum, ["str", "dex", "con", "int", "wis", "cha"]);
  assert.ok(pf.save.properties.basic, "PF2e has basic saves");
  assert.equal(dnd.save.properties.basic, undefined, "5e has no basic saves");
  assert.equal(pf.advantage, undefined, "PF2e has no advantage");
  assert.ok(dnd.advantage.properties.on.enum.includes("skill:stealth"));
  assert.ok(pf.condition.properties.id.enum.includes("off-guard"));
  assert.ok(!dnd.condition.properties.id.enum.includes("off-guard"));
  assert.ok(dnd.condition.properties.id.enum.includes("poisoned"));
  assert.ok(pf.modifiers.items.properties.selector.enum.includes("save:reflex"));
  assert.ok(dnd.modifiers.items.properties.selector.enum.includes("save:dex"));
  assert.ok(!dnd.modifiers.items.properties.type.enum.includes("circumstance"));
  assert.ok(dnd.damage.items.properties.type.enum.includes("lightning"));
  assert.ok(pf.damage.items.properties.type.enum.includes("electricity"));
  // Superset without a system (contract shape).
  const any = structuredMechanicsSchema(null).properties;
  assert.ok(any.save.properties.save.enum.includes("will") && any.save.properties.save.enum.includes("wis"));
});

test("mechanics.structured is required in the proposal schema, right after effect", () => {
  const mech = PROPOSAL_ENTRY_SCHEMA.properties.mechanics;
  assert.ok(mech.required.includes("structured"));
  const keys = Object.keys(mech.properties);
  assert.equal(keys.indexOf("structured"), keys.indexOf("effect") + 1);
  const pfItems = proposalSchemaCapped(2, { systemId: "pf2e", redCheck: true }).properties.proposals.items;
  assert.deepEqual(pfItems.properties.entry.properties.mechanics.properties.structured, structuredMechanicsSchema("pf2e"));
  const dndItems = proposalSchemaCapped(2, { systemId: "dnd5e" }).properties.proposals.items;
  assert.deepEqual(dndItems.properties.entry.properties.mechanics.properties.structured, structuredMechanicsSchema("dnd5e"));
});

test("splitDice separates the flat bonus and refuses non-dice", () => {
  assert.deepEqual(splitDice("2d6+3"), { dice: "2d6", bonus: 3 });
  assert.deepEqual(splitDice("d8"), { dice: "1d8", bonus: 0 });
  assert.equal(splitDice("2d7"), null);
  assert.equal(splitDice("lots"), null);
  assert.equal(splitDice(5), null);
});

test("PF2e coercion: maps 5e words to PF2e, drops advantage and bad fields", () => {
  const { structured, dropped } = coerceStructuredMechanics({
    attack: { kind: "spell attack" },
    damage: [{ dice: "2d6+3", type: "lightning" }, { dice: "many", type: "fire" }, { dice: "1d4", type: "psychic damage" }],
    save: { save: "Dexterity", dc: "spell DC", basic: true },
    modifiers: [{ value: "+1", type: "circumstance", selector: "Armor Class" }, { value: 2, type: "status", selector: "Stealth checks" }, { value: 1, type: "status", selector: "juggling" }],
    advantage: { on: "attack" },
    range: "30 feet",
    area: { type: "sphere", value: 10 },
    condition: { id: "flat-footed" },
    uses: { max: 1, per: "short rest" }
  }, { systemId: "pf2e" });
  assert.deepEqual(structured, {
    attack: { kind: "spell" },
    damage: [{ dice: "2d6", type: "electricity", bonus: 3 }, { dice: "1d4", type: "mental" }],
    save: { save: "reflex", dc: "spell", basic: true },
    modifiers: [{ value: 1, type: "circumstance", selector: "ac" }, { value: 2, type: "status", selector: "skill:stealth" }],
    range: { value: 30, units: "ft" },
    area: { type: "burst", value: 10 },
    condition: { id: "off-guard" },
    uses: { max: 1, per: "hour" }
  });
  assert.ok(dropped.some((d) => d.startsWith("damage:bad-dice")));
  assert.ok(dropped.some((d) => d.startsWith("modifiers:bad-selector")));
  assert.ok(dropped.includes("advantage:not-a-pf2e-mechanic"));
});

test("PF2e valued conditions keep a value; 'frightened 2' is read from the id", () => {
  const { structured } = coerceStructuredMechanics({ condition: { id: "Frightened 2", duration: "until the end of your next turn" } }, { systemId: "pf2e" });
  assert.deepEqual(structured.condition, { id: "frightened", value: 2, duration: "until the end of your next turn" });
  const prone = coerceStructuredMechanics({ condition: { id: "prone", value: 3 } }, { systemId: "pf2e" }).structured;
  assert.deepEqual(prone.condition, { id: "prone" });
});

test("dnd5e coercion: maps PF2e words to 5e, drops basic, untypes bonuses, reads advantage", () => {
  const { structured, dropped, coercions } = coerceStructuredMechanics({
    damage: { dice: "3d8", type: "void" },
    save: { save: "Reflex", dc: 14, basic: true },
    modifiers: [{ value: 1, type: "circumstance", selector: "save:wis" }, { value: 2, type: "status", selector: "skill:diplomacy" }],
    advantage: { on: "Stealth checks", condition: "in dim light" },
    range: { value: 9, units: "m" },
    area: { type: "burst", value: 20 },
    condition: { id: "off-guard" },
    uses: { max: 2, per: "encounter" }
  }, { systemId: "dnd5e" });
  assert.deepEqual(structured, {
    damage: [{ dice: "3d8", type: "necrotic" }],
    save: { save: "dex", dc: 14 },
    modifiers: [{ value: 1, type: "untyped", selector: "save:wis" }, { value: 2, type: "untyped", selector: "skill:persuasion" }],
    advantage: { on: "skill:stealth", condition: "in dim light" },
    range: { value: 30, units: "ft" },
    area: { type: "sphere", value: 20 },
    uses: { max: 2, per: "short-rest" }
  });
  assert.ok(dropped.some((d) => d.startsWith("condition:unknown-condition")), "off-guard is not a 5e condition");
  assert.ok(coercions.includes("save.basic-dropped:dnd5e"));
  assert.equal(coerceStructuredMechanics({ advantage: { on: "check:str" } }, { systemId: "dnd5e" }).structured.advantage.on, "check:str");
  assert.equal(coerceStructuredMechanics({ condition: { id: "exhaustion", value: 2 } }, { systemId: "dnd5e" }).structured.condition.value, 2);
});

test("structured coercion returns null for nothing usable and never throws on junk", () => {
  assert.equal(coerceStructuredMechanics({}, { systemId: "pf2e" }).structured, null);
  assert.equal(coerceStructuredMechanics("fireball", { systemId: "pf2e" }).structured, null);
  assert.equal(coerceStructuredMechanics({ damage: [null, 3], save: {}, uses: "often", range: "self" }, { systemId: "dnd5e" }).structured, null);
  assert.equal(coerceStructuredMechanics(undefined).structured, null);
});

test("skill slugs are full names on both systems; the dnd5e sheet keys are exported for adapters", () => {
  assert.equal(DND5E_SKILL_KEYS["sleight-of-hand"], "slt");
  for (const skill of STRUCTURED_SKILLS.dnd5e) assert.ok(DND5E_SKILL_KEYS[skill], skill);
  assert.equal(coerceStructuredMechanics({ modifiers: [{ value: 1, type: "untyped", selector: "slt" }] }, { systemId: "dnd5e" }).structured.modifiers[0].selector, "skill:sleight-of-hand");
});

test("repairProposal cleans mechanics.structured, reports drops, and the entry stays valid", () => {
  const proposal = {
    kind: "skill",
    evidence: ["Luz threw fire"],
    entry: {
      name: "Emberwright: Cinder Fan", tier: 1, system_equivalent: "Spell",
      gameItem: { kind: "feat" },
      mechanics: {
        effect: "Each creature in a 15-foot cone takes 2d6 fire damage (basic Reflex save against your class DC).",
        structured: { damage: [{ dice: "2d6", type: "fire" }], save: { save: "reflex", dc: "class", basic: true }, area: { type: "cone", value: 15 }, advantage: { on: "attack" } },
        duration: "instant", frequency: { max: 1, per: "encounter" }
      },
      metadata: { tags: ["fire"] }
    }
  };
  const { proposal: out, repairs } = repairProposal(proposal, { systemId: "pf2e", actorLevel: 3 });
  assert.deepEqual(out.entry.mechanics.structured, { damage: [{ dice: "2d6", type: "fire" }], save: { save: "reflex", dc: "class", basic: true }, area: { type: "cone", value: 15 } });
  assert.ok(repairs.includes("structured-dropped:advantage:not-a-pf2e-mechanic"));
  assert.deepEqual(validateSkillEntry(out.entry).errors, []);
  // An empty block is refilled from the effect's own damage/save, or removed rather than left as {}.
  const empty = repairProposal({ ...proposal, entry: { ...proposal.entry, mechanics: { ...proposal.entry.mechanics, structured: {} } } }, { systemId: "pf2e" });
  assert.deepEqual(empty.proposal.entry.mechanics.structured, { damage: [{ dice: "2d6", type: "fire" }], save: { save: "reflex", dc: "class", basic: true } });
  assert.ok(empty.repairs.includes("structured-from-effect:damage,save"));
  const narrative = repairProposal({ ...proposal, entry: { ...proposal.entry, mechanics: { ...proposal.entry.mechanics, effect: "You always know which way is north.", structured: {} } } }, { systemId: "pf2e" });
  assert.equal("structured" in narrative.proposal.entry.mechanics, false);
});

for (const systemId of ["pf2e", "dnd5e"]) {
  test(`${systemId}: stage 2 sends the system's structured schema + instruction, and structured reaches the result`, async () => {
    const structured = systemId === "pf2e"
      ? { modifiers: [{ value: 1, type: "circumstance", selector: "ac" }], uses: { max: 1, per: "round" } }
      : { advantage: { on: "save:dex" }, uses: { max: 1, per: "turn" } };
    const transport = scriptedTransport([
      { events: [{ quote: "parried", actorName: "", actorRole: "doer", continuesPrevious: false, summary: "Parried the guard's blade.", tags: ["martial", "defense"], themes: [], outcome: "success", darkDeed: "none", darkSeverity: "none", dangerGap: "none" }] },
      { redCheck: [{ event: "Parried", vice: "none" }], proposals: [{ kind: "skill", evidence: ["parried"], entry: {
        name: "Bladewall: Turning Edge", tier: 1, system_equivalent: "Skill feat", gameItem: { kind: "feat" },
        mechanics: { effect: systemId === "pf2e" ? "Gain a +1 circumstance bonus to AC against the first Strike each round." : "You have advantage on Dexterity saving throws once per turn.", structured, duration: "while wielding a blade", frequency: { max: 1, per: "round" } },
        metadata: { tags: ["martial", "defense"] }
      } }] }
    ]);
    const result = await runGatewayPipeline({ transport, request: request("Parried the guard's blade.", systemId), config: {}, systemId });
    const sent = transport.calls[1];
    assert.deepEqual(sent.schema.properties.proposals.items.properties.entry.properties.mechanics.properties.structured, structuredMechanicsSchema(systemId));
    assert.ok(sent.messages[0].content.includes(structuredInstruction(systemId)));
    assert.equal(result.proposals.length, 1);
    assert.deepEqual(result.proposals[0].entry.mechanics.structured, structured);
  });
}

test("damage and save the effect text states are copied into structured when the model left them out", () => {
  // Real probe output (pf2e): the burst came back as {area, uses} only.
  const pf = fillStructuredFromEffect("Each creature in a 15-foot burst takes 1d6 fire damage (basic Reflex save against your spell DC).", { area: { type: "burst", value: 15 } }, { systemId: "pf2e" });
  assert.deepEqual(pf.structured, { area: { type: "burst", value: 15 }, damage: [{ dice: "1d6", type: "fire" }], save: { save: "reflex", dc: "spell", basic: true } });
  assert.deepEqual(pf.filled, ["damage", "save"]);
  const dnd = fillStructuredFromEffect("Each creature within 30 feet must succeed on a DC 14 Wisdom saving throw or take 2d8 thunder damage.", null, { systemId: "dnd5e" });
  assert.deepEqual(dnd.structured, { damage: [{ dice: "2d8", type: "thunder" }], save: { save: "wis", dc: 14 } });
  // A buffed save is not a forced save; fields the model already wrote are never overwritten.
  assert.equal(fillStructuredFromEffect("You have advantage on Dexterity saving throws.", null, { systemId: "dnd5e" }).structured, null);
  const kept = fillStructuredFromEffect("Deal 2d6 fire damage.", { damage: [{ dice: "3d6", type: "fire" }] }, { systemId: "pf2e" });
  assert.deepEqual(kept.filled, []);
  assert.deepEqual(kept.structured.damage, [{ dice: "3d6", type: "fire" }]);
});

test("the per-system examples show structured mechanics in that system's words", () => {
  const pf = buildAiGatewayRequest(makeHarnessActor("pf2e"), "", "pf2e").requirements.exampleByKind;
  const dnd = buildAiGatewayRequest(makeHarnessActor("dnd5e"), "", "dnd5e").requirements.exampleByKind;
  assert.deepEqual(pf.spell.entry.mechanics.structured.save, { save: "reflex", dc: "spell", basic: true });
  assert.deepEqual(dnd.spell.entry.mechanics.structured.save, { save: "dex", dc: "spell" });
  assert.ok(dnd.passive.entry.mechanics.structured.advantage);
  assert.ok(pf.passive.entry.mechanics.structured.modifiers);
  // Every example's structured block survives its own system's coercion unchanged.
  for (const [systemId, examples] of [["pf2e", pf], ["dnd5e", dnd]]) {
    for (const [kind, example] of Object.entries(examples)) {
      const s = example.entry.mechanics.structured;
      assert.deepEqual(coerceStructuredMechanics(s, { systemId }).structured, s, `${systemId} ${kind}`);
    }
  }
  // And the prompt quotes the right vocabulary per system.
  assert.match(structuredInstruction("pf2e"), /basic: true for a basic save/);
  assert.match(structuredInstruction("dnd5e"), /advantage \{on: attack/);
  const msgs = buildProposalMessages({ request: request("x", "dnd5e"), config: normalizeGatewayConfig({}), events: [], allowClass: false });
  assert.match(msgs[0].content, /D&D 5e fields/);
});
