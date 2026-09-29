import assert from "node:assert/strict";
import test from "node:test";

import { GrandDesignApi, applyProposalPatch } from "../scripts/api.js";
import { GROWTH_EVENTS_FLAG, GROWTH_PROPOSALS_FLAG, LEVEL_PROGRESSION_FLAG, MODULE_ID, REGISTRY_FLAG } from "../scripts/constants.js";
import { checkEnricher, createMechanicsHtml, pf2eLevelBasedDc, resolveRollCheck } from "../scripts/mechanics.js";
import { flavorProposalName, namingClassFor } from "../scripts/naming.js";
import { generateCapstoneProposal, generateSkillProposals, levelRequirement } from "../scripts/progression.js";
import { validateClassEntry, validateSkillEntry } from "../scripts/validator.js";

// dev-integration batch (2026-09-29), board items b375d56c (milestone retry), 0ed137cb (fallback
// numbers), 17c10e97 (real checks instead of Acrobatics + [[/r]]), 9ebbf3c9 (class-flavored names),
// 78ead05c (per-actor busy lock + deadline), plus api.updateProposal for the proposal editor.

const SYSTEMS = ["pf2e", "dnd5e"];

function createMockActor(systemId, { name = "Maren", withClass = true } = {}) {
  const flags = { [MODULE_ID]: {} };
  const pf2eSystem = {
    details: { level: { value: 12 } },
    skills: { acrobatics: { totalModifier: 8 }, athletics: { totalModifier: 21 }, medicine: { totalModifier: 17 } },
    saves: { fortitude: { totalModifier: 23 }, reflex: { totalModifier: 18 }, will: { totalModifier: 19 } },
    perception: { totalModifier: 20 },
    abilities: { str: { mod: 4 }, dex: { mod: 2 } }
  };
  const dnd5eSystem = {
    details: { level: 12 },
    skills: { acr: { mod: 1, total: 3 }, ath: { mod: 4, total: 8 }, med: { mod: 1, total: 5 } },
    abilities: { str: { mod: 4, save: { value: 8 } }, dex: { mod: 1 }, con: { mod: 3, save: { value: 7 } }, wis: { mod: 1, save: { value: 1 } } },
    attributes: { prof: 4 }
  };
  return {
    id: `mock-${systemId}-${name}`,
    name,
    documentName: "Actor",
    type: "character",
    ...(withClass && systemId === "pf2e" ? { class: { name: "Fighter" } } : {}),
    ...(withClass && systemId === "dnd5e" ? { classes: { fighter: { name: "Fighter", system: { levels: 12 } } } } : {}),
    system: systemId === "dnd5e" ? dnd5eSystem : pf2eSystem,
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
    },
    async createEmbeddedDocuments() {
      return [{ id: "mock-item", getFlag: () => undefined, async createActivity() { return {}; } }];
    }
  };
}

async function withFoundry(systemId, fn) {
  const originalGame = globalThis.game;
  const originalHooks = globalThis.Hooks;
  globalThis.game = { user: { isGM: true }, system: { id: systemId } };
  globalThis.Hooks = { callAll: () => {} };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    globalThis.game = originalGame;
    globalThis.Hooks = originalHooks;
    console.warn = originalWarn;
  }
}

async function seed(actor, { level, progress = 0, events = [], proposals, capstoneAllowances = 0, grantAllowances = 0 }) {
  await actor.update({
    [`flags.${MODULE_ID}.${LEVEL_PROGRESSION_FLAG}`]: { level, progress, grantAllowances, capstoneAllowances, lastRestAt: null, lastRestType: null },
    [`flags.${MODULE_ID}.${GROWTH_EVENTS_FLAG}`]: events,
    ...(proposals ? { [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: proposals } : {})
  });
}

const gev = (id, summary, tags, outcome = "success") => ({ id, summary, tags, outcome, occurredAt: "2026-09-29T00:00:00.000Z", actorName: "Maren" });
const martialEvents = () => [
  gev("event:1", "Maren shoved the ogre off the bridge.", ["martial"]),
  gev("event:2", "Maren wrestled the bandit chief down.", ["martial"], "criticalSuccess"),
  gev("event:3", "Maren patched a guard.", ["medicine"])
];

function capstoneSkill(name) {
  return {
    kind: "skill",
    evidence: ["event:1"],
    entry: {
      name,
      tier: 3,
      system_equivalent: "Rare capstone ability",
      gameItem: { kind: "passive" },
      mechanics: { effect: "Once per day, throw a foe 30 feet.", duration: "instant", frequency: { max: 1, per: "day" } },
      metadata: { tags: ["martial"], lineage: { operation: "origin", sources: [], rationale: "AI capstone." } }
    }
  };
}

// ---------------------------------------------------------------------------------------------
// 17c10e97: roll.kind -> the system's own statistic and check enricher

test("roll kinds resolve to each system's own statistic", () => {
  assert.deepEqual(resolveRollCheck("Athletics check", "pf2e"), { type: "skill", key: "athletics", label: "Athletics check" });
  assert.deepEqual(resolveRollCheck("Wisdom (Medicine) check", "pf2e"), { type: "skill", key: "medicine", label: "Medicine check" });
  assert.deepEqual(resolveRollCheck("Charisma (Persuasion) check", "pf2e")?.key, "diplomacy");
  assert.deepEqual(resolveRollCheck("Reflex save", "pf2e"), { type: "save", key: "reflex", label: "Reflex save" });
  assert.equal(resolveRollCheck("Constitution saving throw", "pf2e").key, "fortitude");
  assert.deepEqual(resolveRollCheck("Medicine check", "dnd5e"), { type: "skill", key: "med", ability: "wis", label: "Wisdom (Medicine) check" });
  assert.deepEqual(resolveRollCheck("Diplomacy check", "dnd5e")?.key, "per");
  assert.deepEqual(resolveRollCheck("Fortitude save", "dnd5e"), { type: "save", key: "con", ability: "con", label: "Constitution saving throw" });
  assert.deepEqual(resolveRollCheck("Crafting check", "dnd5e"), { type: "ability", key: "int", ability: "int", label: "Intelligence check" });
  assert.equal(resolveRollCheck("Perception check", "pf2e").type, "perception");
  // Attacks and made-up checks have no single statistic: the flat roll stays.
  assert.equal(resolveRollCheck("Melee attack", "pf2e"), null);
  assert.equal(resolveRollCheck("Ranged spell attack", "dnd5e"), null);
  assert.equal(resolveRollCheck("Martial check", "pf2e"), null);
});

test("check enrichers use the pf2e @Check and dnd5e 5.x [[/check]] / [[/save]] syntax", () => {
  assert.equal(checkEnricher({ kind: "Athletics check", dc: 30 }, "pf2e"), "@Check[athletics|dc:30]");
  assert.equal(checkEnricher({ kind: "Fortitude save", dc: 28 }, "pf2e"), "@Check[fortitude|dc:28]");
  assert.equal(checkEnricher({ kind: "Strength (Athletics) check", dc: 16 }, "dnd5e"), "[[/check skill=ath ability=str dc=16]]");
  assert.equal(checkEnricher({ kind: "Dexterity saving throw", dc: 14 }, "dnd5e"), "[[/save ability=dex dc=14]]");
  assert.equal(checkEnricher({ kind: "Intelligence check" }, "dnd5e"), "[[/check ability=int]]");
  assert.equal(checkEnricher({ kind: "Melee attack", dc: 18 }, "pf2e"), null);
});

for (const systemId of SYSTEMS) {
  test(`[${systemId}] the Item description shows the system check first and keeps the flat roll only as a fallback`, () => {
    const entry = {
      gameItem: { kind: "action" },
      mechanics: { effect: "Shove.", frequency: { max: 1, per: "round" }, roll: { kind: "Athletics check", formula: "1d20+21", dc: 30 } }
    };
    const html = createMechanicsHtml(entry, { systemId });
    const enricher = systemId === "pf2e" ? "@Check[athletics|dc:30]" : "[[/check skill=ath ability=str dc=30]]";
    assert.ok(html.includes(`Athletics check — ${enricher} (flat roll: [[/r 1d20+21]])`), html);
    const attack = createMechanicsHtml({ ...entry, mechanics: { ...entry.mechanics, roll: { kind: "Melee attack", formula: "1d20+18", dc: 30 } } }, { systemId });
    assert.ok(attack.includes("Melee attack — [[/r 1d20+18]] vs. DC 30"), attack);
  });
}

test("createMechanicsHtml falls back to game.system.id (lineage.js does not pass the system yet)", () => {
  const original = globalThis.game;
  globalThis.game = { system: { id: "pf2e" } };
  try {
    const html = createMechanicsHtml({ gameItem: { kind: "action" }, mechanics: { effect: "x", frequency: { max: 1, per: "day" }, roll: { kind: "Stealth check", formula: "1d20+5", dc: 20 } } });
    assert.match(html, /@Check\[stealth\|dc:20\]/);
  } finally {
    globalThis.game = original;
  }
});

// ---------------------------------------------------------------------------------------------
// 0ed137cb + 17c10e97 + 9ebbf3c9: the fallback capstone / Class and the templates

for (const systemId of SYSTEMS) {
  test(`[${systemId}] a level-50 fallback capstone rolls the real check vs a character-level DC, with a concrete benefit and a class name`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor(systemId);
    await seed(actor, { level: 49, progress: levelRequirement(49), events: martialEvents() });
    const result = await api.resolveLevelRest(actor, { restType: "long" });
    const capstone = result.capstoneProposals[0];
    const roll = capstone.entry.mechanics.roll;
    if (systemId === "pf2e") {
      assert.equal(roll.kind, "Athletics check");
      assert.equal(roll.dc, pf2eLevelBasedDc(12)); // 30 for a level-12 character, not 10 + 50
      assert.equal(roll.formula, "1d20+21");
    } else {
      assert.equal(roll.kind, "Strength (Athletics) check");
      assert.equal(roll.dc, 8 + 4 + 4); // 8 + proficiency + Strength
      assert.equal(roll.formula, "1d20+8");
    }
    assert.notEqual(roll.dc, 60);
    assert.doesNotMatch(capstone.entry.mechanics.effect, /left to the GM|flesh out/i);
    assert.match(capstone.entry.mechanics.effect, /extra 3d6 damage/);
    assert.equal(capstone.entry.name, "Fighter: Decisive Blow");
    assert.deepEqual(validateSkillEntry(capstone.entry).errors, []);

    const cls = result.classProposals[0];
    assert.equal(cls.entry.name, "Fighter: Martial Ascendant");
    assert.match(cls.entry.system_chassis, /^Fighter evolution/);
    assert.doesNotMatch(cls.entry.system_chassis, /Pending chassis review/);
    assert.match(cls.entry.mechanics.effect, systemId === "pf2e" ? /\+1 status bonus to Athletics checks/ : /\+2 bonus to Strength \(Athletics\) checks/);
    assert.deepEqual(validateClassEntry(cls.entry).errors, []);
  }));

  test(`[${systemId}] a character with no Class keeps the plain concept name and a stated chassis`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor(systemId, { withClass: false });
    await seed(actor, { level: 19, progress: levelRequirement(19), events: martialEvents() });
    const result = await api.resolveLevelRest(actor, { restType: "long" });
    assert.equal(result.capstoneProposals[0].entry.name, "Decisive Blow");
    assert.equal(result.classProposals[0].entry.name, "Martial Ascendant");
    assert.doesNotMatch(result.classProposals[0].entry.system_chassis, /Pending chassis review/);
  }));

  test(`[${systemId}] a Grand Design Class names the fallback (primary Class motif)`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor(systemId);
    await actor.update({
      [`flags.${MODULE_ID}.${REGISTRY_FLAG}`]: {
        classes: { "class:spearmaster": { name: "Spearmaster", level: 5, is_primary: true, metadata: { tags: ["martial", "precision"] } } },
        skills: {}
      }
    });
    await seed(actor, { level: 9, progress: levelRequirement(9), events: martialEvents() });
    const result = await api.resolveLevelRest(actor, { restType: "long" });
    assert.equal(result.capstoneProposals[0].entry.name, "Speartip: Decisive Blow");
  }));

  test(`[${systemId}] a template rolls its own check with the right modifier and is named after the Class`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor(systemId);
    await seed(actor, { level: 2 });
    let last;
    for (let i = 0; i < 3; i += 1) {
      last = await api.recordGrowthEvent(actor, { summary: `Maren bandaged a wounded ally ${i}.`, tags: ["medicine", "support"], outcome: "success", actorName: "Maren" });
    }
    const triage = last.proposals.find((proposal) => proposal.id === "proposal:field-triage");
    assert.ok(triage);
    assert.equal(triage.entry.name, "Fighter: Field Triage");
    assert.equal(triage.entry.metadata.id, "skill:field-triage", "the registry id stays the template's own");
    const roll = triage.entry.mechanics.roll;
    if (systemId === "pf2e") {
      assert.equal(roll.formula, "1d20+17"); // Medicine, not Acrobatics (+8)
      assert.equal(roll.dc, 30); // level-based for a level-12 character
    } else {
      assert.equal(roll.formula, "1d20+5"); // Medicine total, not Acrobatics (+3)
      assert.equal(roll.dc, 12); // dnd5e keeps the template's bounded-accuracy DC
    }
  }));
}

test("a template approved under its bare name is not proposed again under the flavored one", () => {
  const events = Array.from({ length: 3 }, (_, i) => gev(`event:${i}`, "canal run", ["mobility", "water"]));
  const rollContext = { namingClass: (tags) => namingClassFor({}, "Fighter", tags) };
  assert.equal(generateSkillProposals(events, { skills: {} }, 0, [], {}, { rollContext })[0].entry.name, "Fighter: Canal Step");
  assert.deepEqual(generateSkillProposals(events, { skills: { "skill:canal-step": { name: "Canal Step" } } }, 0, [], {}, { rollContext }), []);
});

test("naming helpers: GD Class first, then the system class without levels; nothing -> plain concept", () => {
  assert.equal(namingClassFor({}, "Fighter 3 / Wizard 2").name, "Fighter");
  assert.equal(namingClassFor({}, null), null);
  assert.equal(flavorProposalName(null, "Decisive Blow"), "Decisive Blow");
  assert.equal(flavorProposalName({ name: "Fighter" }, "Fighter: Decisive Blow"), "Fighter: Decisive Blow", "never prefixed twice");
  // A bare role word (Ranger is a generic suffix) falls back to the proposal's tags.
  assert.equal(flavorProposalName(namingClassFor({}, "Ranger", ["survival"]), "Trail Sense"), "Trail: Trail Sense");
});

test("legacy callers (numeric modifier, no actor) still get a valid capstone", () => {
  const proposal = generateCapstoneProposal(10, martialEvents(), { skills: {} }, 3, { systemId: "dnd5e" });
  assert.equal(proposal.entry.mechanics.roll.formula, "1d20+3");
  assert.deepEqual(validateSkillEntry(proposal.entry).errors, []);
});

// ---------------------------------------------------------------------------------------------
// b375d56c: retryMilestoneReward

function scriptedAdapter(answers) {
  const calls = [];
  const adapter = async (args) => {
    calls.push(args.milestone);
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next ?? { proposals: [] };
  };
  adapter.calls = calls;
  return adapter;
}

for (const systemId of SYSTEMS) {
  test(`[${systemId}] a template capstone can be re-asked of the AI and stays spendable`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor(systemId);
    await seed(actor, { level: 9, progress: levelRequirement(9), events: martialEvents() });
    // The rest: AI down -> template with a stated reason.
    api.setProposalAdapter(scriptedAdapter([new Error("connect ECONNREFUSED")]));
    const rest = await api.resolveLevelRest(actor, { restType: "long" });
    assert.equal(rest.capstoneProposals[0].usedFallback, true);
    // The retry: AI back.
    api.setProposalAdapter(scriptedAdapter([{ proposals: [capstoneSkill("Fighter: Mountain Toss")] }]));
    const retried = await api.retryMilestoneReward(actor, "proposal:capstone-10");
    assert.equal(retried.usedFallback, false);
    assert.equal(retried.proposal.id, "proposal:capstone-10");
    assert.equal(retried.proposal.status, "pending");
    assert.equal(retried.proposal.isCapstone, true);
    assert.equal(retried.proposal.entry.name, "Fighter: Mountain Toss");
    assert.equal(retried.proposal.previousAttempts[0].usedFallback, true);
    const rows = api.getGrowth(actor).proposals.filter((p) => p.id === "proposal:capstone-10");
    assert.equal(rows.length, 1, "replaced in place, not duplicated");
    await api.approveProposal(actor, "proposal:capstone-10");
    assert.equal(api.getLevelProgression(actor).capstoneAllowances, 0);
    await assert.rejects(api.retryMilestoneReward(actor, "proposal:capstone-10"), /already approved/);
  }));

  test(`[${systemId}] a rejected capstone is re-offered; the rejected name is not accepted again`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor(systemId);
    await seed(actor, { level: 9, progress: levelRequirement(9), events: martialEvents() });
    api.setProposalAdapter(scriptedAdapter([{ proposals: [capstoneSkill("Fighter: Ogre Slam")] }]));
    await api.resolveLevelRest(actor, { restType: "long" });
    await api.rejectProposal(actor, "proposal:capstone-10", { reason: "too samey" });
    assert.equal(api.getLevelProgression(actor).capstoneAllowances, 1, "a rejection does not consume the allowance");
    assert.deepEqual(api.getMilestoneRewards(actor).map((r) => [r.proposalId, r.status, r.retryable]), [["proposal:capstone-10", "rejected", true]]);

    // The AI proposes the rejected name again -> the template, with the reason stated.
    api.setProposalAdapter(scriptedAdapter([{ proposals: [capstoneSkill("Fighter: Ogre Slam")] }]));
    const again = await api.retryMilestoneReward(actor, "proposal:capstone-10");
    assert.equal(again.usedFallback, true);
    assert.match(again.reason, /already rejected/);
    assert.equal(again.proposal.status, "pending");
    assert.equal(again.proposal.previousAttempts.at(-1).status, "rejected");
    assert.equal(again.proposal.previousAttempts.at(-1).rejectedReason, "too samey");

    // A later retry with something new is accepted and can be approved with the allowance the rest earned.
    api.setProposalAdapter(scriptedAdapter([{ proposals: [capstoneSkill("Fighter: Titan's Grip")] }]));
    const fresh = await api.retryMilestoneReward(actor, "proposal:capstone-10");
    assert.equal(fresh.proposal.entry.name, "Fighter: Titan's Grip");
    await api.approveProposal(actor, "proposal:capstone-10");
    assert.equal(api.getLevelProgression(actor).capstoneAllowances, 0);
  }));

  test(`[${systemId}] an AI capstone's flat roll uses the sheet modifier; a gateway skip is named in the fallback reason`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor(systemId);
    await seed(actor, { level: 10, events: martialEvents(), capstoneAllowances: 1 });
    const withRoll = capstoneSkill("Fighter: Ogre Toss");
    withRoll.entry.gameItem = { kind: "action" };
    withRoll.entry.mechanics = { ...withRoll.entry.mechanics, actions: 2, roll: { kind: "Athletics check", formula: "1d20+9" } };
    api.setProposalAdapter(scriptedAdapter([{ proposals: [withRoll] }]));
    const ok = await api.retryMilestoneReward(actor, "proposal:capstone-10");
    assert.equal(ok.proposal.entry.mechanics.roll.formula, systemId === "pf2e" ? "1d20+21" : "1d20+8");

    api.setProposalAdapter(scriptedAdapter([{ proposals: [], skippedProposals: [{ proposal: capstoneSkill("Fighter: Grip"), reason: "duplicates-owned-proficiency" }] }]));
    const skipped = await api.retryMilestoneReward(actor, "proposal:capstone-10");
    assert.equal(skipped.usedFallback, true);
    assert.match(skipped.reason, /gateway skipped Fighter: Grip: duplicates-owned-proficiency/);
  }));

  test(`[${systemId}] a Class evolution can be retried, and a missing milestone row can be asked for by id`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor(systemId);
    await seed(actor, { level: 20, events: martialEvents(), capstoneAllowances: 1, grantAllowances: 1 });
    // No row at all for capstone-20 / class-evolution-20 (e.g. dropped by an older re-analysis).
    const missing = await api.retryMilestoneReward(actor, "proposal:class-evolution-20");
    assert.equal(missing.usedFallback, true);
    assert.match(missing.reason, /no AI provider/);
    assert.equal(missing.proposal.kind, "class");
    assert.equal(missing.proposal.milestoneLevel, 20);
    assert.deepEqual(validateClassEntry(missing.proposal.entry).errors, []);
    await assert.rejects(api.retryMilestoneReward(actor, "proposal:capstone-30"), /current level 20/);
    await assert.rejects(api.retryMilestoneReward(actor, "proposal:field-triage"), /not a milestone reward/);
  }));

  test(`[${systemId}] re-analyzing notes keeps a pending capstone whose evidence was replaced`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor(systemId);
    await seed(actor, { level: 9, progress: levelRequirement(9) });
    await api.analyzeSessionNotes(actor, "Maren shoved the ogre off the bridge. Maren wrestled the bandit chief down. Maren shoved a raider.");
    await api.resolveLevelRest(actor, { restType: "long" });
    const before = api.getGrowth(actor).proposals.find((p) => p.id === "proposal:capstone-10");
    assert.ok(before.evidence.length > 0, "the capstone cites the analysed events, so the re-analysis removes all of them");
    await api.reanalyzeLastNotes(actor);
    assert.ok(api.getGrowth(actor).proposals.some((p) => p.id === "proposal:capstone-10" && p.status === "pending"));
  }));
}

// ---------------------------------------------------------------------------------------------
// updateProposal (for the proposal editor)

function pendingTemplate() {
  return {
    id: "proposal:field-triage",
    kind: "skill",
    status: "pending",
    source: "template",
    evidence: ["event:3"],
    entry: {
      name: "Field Triage",
      tier: 1,
      system_equivalent: "Medicine support action",
      gameItem: { kind: "action" },
      mechanics: { effect: "Heal 1d8.", duration: "instant", frequency: { max: 1, per: "hour" }, actions: 1, trigger: "never", roll: { kind: "Medicine check", formula: "1d20+5", dc: 15 } },
      metadata: { id: "skill:field-triage", tags: ["medicine", "support"], lineage: { operation: "origin", sources: [], rationale: "r" } }
    }
  };
}

for (const systemId of SYSTEMS) {
  test(`[${systemId}] updateProposal takes the editor's { entry } and shortcut fields, validates, and keeps it pending`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor(systemId);
    await seed(actor, { level: 2, proposals: [pendingTemplate()] });

    const edited = structuredClone(pendingTemplate().entry);
    edited.name = "Battlefield Surgeon";
    delete edited.mechanics.trigger; // the editor cleared it: a whole-entry edit removes it
    edited.metadata = { tags: ["medicine", "beekeeping"] }; // id/lineage omitted by the editor
    const result = await api.updateProposal(actor, "proposal:field-triage", { entry: edited });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.deepEqual(result.errors, []);
    assert.equal(result.proposal.status, "pending");
    assert.equal(result.proposal.editedBy, "gm");
    assert.equal(result.proposal.entry.name, "Battlefield Surgeon");
    assert.equal(result.proposal.entry.mechanics.trigger, undefined);
    assert.equal(result.proposal.entry.metadata.id, "skill:field-triage", "metadata merged: the registry id survives");
    assert.deepEqual(result.proposal.entry.metadata.tags, ["medicine"]);
    assert.deepEqual(result.proposal.entry.metadata.themes, ["beekeeping"], "an unknown tag becomes an emergent theme");

    const shortcut = await api.updateProposal(actor, "proposal:field-triage", { effect: "Heal 2d8.", roll: { dc: 17 }, tier: 2 });
    assert.equal(shortcut.ok, true);
    assert.equal(shortcut.proposal.entry.mechanics.effect, "Heal 2d8.");
    assert.deepEqual(shortcut.proposal.entry.mechanics.roll, { kind: "Medicine check", formula: "1d20+5", dc: 17 });
    assert.equal(shortcut.proposal.entry.tier, 2);

    // The edit survives the next recorded event (templates are otherwise regenerated wholesale).
    for (let i = 0; i < 3; i += 1) {
      await api.recordGrowthEvent(actor, { summary: `Maren bandaged someone ${i}.`, tags: ["medicine", "support"], outcome: "success", actorName: "Maren" });
    }
    assert.equal(api.getGrowth(actor).proposals.find((p) => p.id === "proposal:field-triage").entry.name, "Battlefield Surgeon");
  }));

  test(`[${systemId}] updateProposal refuses an invalid edit, an unknown field, and non-pending proposals without saving`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor(systemId);
    const approved = { ...pendingTemplate(), id: "proposal:done", status: "approved" };
    await seed(actor, { level: 2, proposals: [pendingTemplate(), approved] });

    const invalid = await api.updateProposal(actor, "proposal:field-triage", { roll: { formula: "lots" } });
    assert.equal(invalid.ok, false);
    assert.match(invalid.errors.join(" "), /dice roll/);
    assert.equal(api.getGrowth(actor).proposals[0].entry.mechanics.roll.formula, "1d20+5", "not saved");

    const unknown = await api.updateProposal(actor, "proposal:field-triage", { colour: "red" });
    assert.equal(unknown.ok, false);
    assert.match(unknown.errors[0], /Unknown proposal field/);

    const notPending = await api.updateProposal(actor, "proposal:done", { name: "Changed" });
    assert.equal(notPending.ok, false);
    assert.equal(api.getGrowth(actor).proposals[1].entry.name, "Field Triage");

    const missing = await api.updateProposal(actor, "proposal:nope", { name: "x" });
    assert.deepEqual([missing.ok, missing.proposal], [false, null]);
  }));
}

test("applyProposalPatch never mutates the stored entry", () => {
  const original = pendingTemplate().entry;
  const snapshot = structuredClone(original);
  applyProposalPatch(original, { name: "New", roll: { dc: 20 }, tags: ["stealth"] });
  assert.deepEqual(original, snapshot);
});

// ---------------------------------------------------------------------------------------------
// 78ead05c: one long task per actor, and an overall deadline

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

for (const systemId of SYSTEMS) {
  test(`[${systemId}] a second analyze/approve/rest on a busy actor is refused with "busy:"; other actors are not blocked`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const gate = deferred();
    let calls = 0;
    api.setProposalAdapter(async () => {
      calls += 1;
      await gate.promise;
      return { events: [{ summary: "Maren shoved the ogre.", tags: ["martial"], outcome: "success", actorName: "Maren" }], proposals: [] };
    });
    const actor = createMockActor(systemId);
    const other = createMockActor(systemId, { name: "Wick" });
    await seed(actor, { level: 1, proposals: [pendingTemplate()] });
    await seed(other, { level: 1 });

    assert.equal(api.isBusy(actor), false);
    const first = api.analyzeSessionNotes(actor, "Maren shoved the ogre.");
    await Promise.resolve();
    assert.equal(api.isBusy(actor), true);
    assert.equal(api.getBusyTask(actor), "analyze");
    await assert.rejects(api.analyzeSessionNotes(actor, "Maren shoved the ogre."), (error) => error.message.startsWith("busy:"));
    await assert.rejects(api.reanalyzeLastNotes(actor), /^Error: busy:/);
    await assert.rejects(api.approveProposal(actor, "proposal:field-triage"), /^Error: busy:/);
    await assert.rejects(api.resolveLevelRest(actor, { restType: "long" }), /^Error: busy:/);
    await assert.rejects(api.updateProposal(actor, "proposal:field-triage", { name: "x" }), /^Error: busy:/);
    await assert.rejects(api.retryMilestoneReward(actor, "proposal:capstone-10"), /^Error: busy:/);
    assert.equal(api.isBusy(other), false);
    const second = api.analyzeSessionNotes(other, "Wick picked a lock.");

    gate.resolve();
    const result = await first;
    await second;
    assert.equal(calls, 2, "the refused double click never reached the AI");
    assert.equal(result.events.length, 1, "recorded once");
    assert.equal(api.getGrowth(actor).events.length, 1);
    assert.equal(api.isBusy(actor), false, "released after finishing");
  }));

  test(`[${systemId}] the lock is released after a failure`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor(systemId);
    await seed(actor, { level: 1 });
    await assert.rejects(api.analyzeSessionNotes(actor, "   "), /non-empty/);
    assert.equal(api.isBusy(actor), false);
    await assert.rejects(api.requestGrowthProposals(actor), /configured AI provider/);
    assert.equal(api.isBusy(actor), false);
  }));

  test(`[${systemId}] an AI analysis past its overall deadline falls back to the local analyzer with the reason`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    api.setGatewayConfigProvider(() => ({ analysisDeadlineMs: 30 }));
    api.setProposalAdapter(() => new Promise(() => {})); // never answers
    const actor = createMockActor(systemId);
    await seed(actor, { level: 1 });
    const result = await api.analyzeSessionNotes(actor, "Maren shoved the ogre off the bridge.");
    assert.equal(result.source, "local-fallback");
    assert.match(result.adapterError, /overall deadline/);
    assert.ok(result.events.length >= 1, "the notes were still read");
    assert.equal(api.isBusy(actor), false);
  }));
}

test("approving a different entry onto an existing registry id is refused", () => withFoundry("pf2e", async () => {
  const api = new GrandDesignApi();
  const actor = createMockActor("pf2e");
  await actor.update({ [`flags.${MODULE_ID}.${REGISTRY_FLAG}`]: { classes: {}, skills: { "skill:warden-s-brace": { name: "Warden's Brace", metadata: { id: "skill:warden-s-brace", tags: [] } } } } });
  // "Warden-s Brace" slugs to the same id as the approved "Warden's Brace".
  const entry = { ...pendingTemplate().entry, name: "Warden-s Brace", metadata: { tags: ["defense"], lineage: { operation: "origin", sources: [], rationale: "" } } };
  await assert.rejects(api.combineSkills(actor, entry), /would overwrite the approved Skill \[Warden's Brace\]/);
}));
