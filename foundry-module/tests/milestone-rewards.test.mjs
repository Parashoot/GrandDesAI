import assert from "node:assert/strict";
import test from "node:test";

import { GrandDesignApi } from "../scripts/api.js";
import { CLASS_EVOLUTION_LEVELS, GROWTH_EVENTS_FLAG, LEVEL_PROGRESSION_FLAG, MODULE_ID } from "../scripts/constants.js";
import { isCapstoneLevel, levelRequirement } from "../scripts/progression.js";
import { validateClassEntry, validateSkillEntry } from "../scripts/validator.js";

// Owner request (live test, 2026-09-28): when a rest crosses a capstone level (every 10th) or a
// Class-evolution level (CLASS_EVOLUTION_LEVELS: 20, 30, 50), resolveLevelRest must itself offer the
// milestone reward -- a real capstone Skill and, at 20/30/50, a real Class -- through the configured
// AI gateway, falling back to a deterministic template when the AI can't deliver. Both systems.

const SYSTEMS = ["pf2e", "dnd5e"];

function createMockActor(systemId, { name = "Maren" } = {}) {
  const flags = { [MODULE_ID]: {} };
  return {
    id: `mock-${systemId}`,
    name,
    documentName: "Actor",
    type: "character",
    system: systemId === "dnd5e"
      ? { details: { level: 12 }, skills: { acr: { mod: 3, total: 5 } }, attributes: { prof: 2 } }
      : { details: { level: { value: 12 } }, skills: { acrobatics: { mod: 8 } } },
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
      // dnd5e's postCreate (systems/dnd5e-adapter.js#buildFeat) calls item.createActivity; a real
      // Foundry Item document has it, a bare mock needs the stub.
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
  console.warn = () => {}; // the fallback path logs on purpose; keep test output readable
  try {
    return await fn();
  } finally {
    globalThis.game = originalGame;
    globalThis.Hooks = originalHooks;
    console.warn = originalWarn;
  }
}

async function seed(actor, { level, progress, events = [] }) {
  await actor.update({
    [`flags.${MODULE_ID}.${LEVEL_PROGRESSION_FLAG}`]: {
      level, progress, grantAllowances: 0, capstoneAllowances: 0, lastRestAt: null, lastRestType: null
    }
  });
  await actor.update({ [`flags.${MODULE_ID}.${GROWTH_EVENTS_FLAG}`]: events });
}

const gev = (id, summary, tags, outcome = "success", actorName = "Maren") => ({
  id, summary, tags, outcome, occurredAt: new Date().toISOString(), actorName
});

function sampleEvents() {
  return [
    gev("event:1", "Maren grappled the bandit to the ground.", ["athletics"]),
    gev("event:2", "Maren grappled another raider.", ["athletics"]),
    gev("event:3", "Maren held the line against the ogre.", ["defense"], "criticalSuccess"),
    gev("event:4", "Maren treated a fevered villager.", ["medicine"]),
    gev("event:5", "Maren carved a totem from driftwood.", ["craft"])
  ];
}

function stubClassEntry(name) {
  return {
    kind: "class",
    evidence: ["ai evidence: repeated grappling"],
    entry: {
      name,
      level: 12,
      power_tier: "standard",
      is_primary: true,
      is_secondary: false,
      system_chassis: "Fighter evolution",
      gameItem: { kind: "passive" },
      mechanics: { effect: "Once per day, gain a surge of martial focus.", duration: "instant", frequency: { max: 1, per: "day" } },
      metadata: { tags: ["athletics"], lineage: { operation: "origin", sources: [], rationale: "AI-authored milestone Class." } }
    }
  };
}

function stubCapstoneSkill(name) {
  return {
    kind: "skill",
    evidence: ["ai evidence: repeated grappling"],
    entry: {
      name,
      tier: 3,
      system_equivalent: "Rare capstone ability",
      gameItem: { kind: "passive" },
      mechanics: { effect: "Once per day, unleash a signature capstone throw.", duration: "instant", frequency: { max: 1, per: "day" } },
      metadata: { tags: ["athletics"], lineage: { operation: "origin", sources: [], rationale: "AI-authored capstone." } }
    }
  };
}

// Answers a milestone request with exactly the kind asked for; used to prove resolveLevelRest routes
// through the AI gateway (same _alwaysProposeAdapter path requestGrowthProposals uses) before ever
// falling back to a template.
function milestoneAdapter() {
  const calls = [];
  const adapter = async (args) => {
    calls.push(args.milestone);
    if (!args.milestone) return { proposals: [] };
    if (args.milestone.kind === "capstone") return { proposals: [stubCapstoneSkill(`AI Capstone L${args.milestone.level}`)] };
    return { proposals: [stubClassEntry(`AI Class L${args.milestone.level}`)] };
  };
  adapter.calls = calls;
  return adapter;
}

for (const systemId of SYSTEMS) {
  test(`[${systemId}] 49->50 with an adapter yields one pending Class and one AI capstone`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    api.setProposalAdapter(milestoneAdapter());
    const actor = createMockActor(systemId);
    await seed(actor, { level: 49, progress: levelRequirement(49), events: sampleEvents() });

    const result = await api.resolveLevelRest(actor, { restType: "long" });

    assert.deepEqual(result.gainedLevels, [50]);
    assert.deepEqual(result.classEvolutionUnlocked, [50]);
    assert.deepEqual(result.capstoneLevelsUnlocked, [50]);
    assert.equal(result.warnings, undefined, "the AI adapter answered validly; no fallback should be needed");

    assert.equal(result.classProposals.length, 1);
    assert.equal(result.classProposals[0].kind, "class");
    assert.equal(result.classProposals[0].source, "class-evolution");
    assert.equal(result.classProposals[0].id, "proposal:class-evolution-50");
    assert.equal(result.classProposals[0].milestoneLevel, 50);
    assert.equal(result.classProposals[0].entry.name, "AI Class L50");
    assert.deepEqual(validateClassEntry(result.classProposals[0].entry).errors, []);

    assert.equal(result.capstoneProposals.length, 1);
    assert.equal(result.capstoneProposals[0].isCapstone, true);
    assert.equal(result.capstoneProposals[0].source, "capstone");
    assert.equal(result.capstoneProposals[0].id, "proposal:capstone-50");
    assert.equal(result.capstoneProposals[0].entry.name, "AI Capstone L50");
    assert.deepEqual(validateSkillEntry(result.capstoneProposals[0].entry).errors, []);

    // Both proposals landed pending on the actor, not just in the return value.
    const pending = api.getGrowth(actor).proposals.filter((p) => p.status === "pending");
    assert.equal(pending.length, 2);
  }));

  test(`[${systemId}] 19->20 yields a Class and a capstone`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    api.setProposalAdapter(milestoneAdapter());
    const actor = createMockActor(systemId);
    await seed(actor, { level: 19, progress: levelRequirement(19), events: sampleEvents() });

    const result = await api.resolveLevelRest(actor, { restType: "long" });

    assert.deepEqual(result.gainedLevels, [20]);
    assert.ok(CLASS_EVOLUTION_LEVELS.has(20));
    assert.ok(isCapstoneLevel(20));
    assert.equal(result.classProposals.length, 1);
    assert.equal(result.capstoneProposals.length, 1);
    assert.equal(result.classProposals[0].id, "proposal:class-evolution-20");
    assert.equal(result.capstoneProposals[0].id, "proposal:capstone-20");
  }));

  test(`[${systemId}] 38->40 yields a capstone for 40 only (not a class-evolution level)`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    api.setProposalAdapter(milestoneAdapter());
    const actor = createMockActor(systemId);
    const progress = levelRequirement(38) + levelRequirement(39);
    await seed(actor, { level: 38, progress, events: sampleEvents() });

    const result = await api.resolveLevelRest(actor, { restType: "long" });

    assert.deepEqual(result.gainedLevels, [39, 40]);
    assert.deepEqual(result.classEvolutionUnlocked, []);
    assert.deepEqual(result.capstoneLevelsUnlocked, [40]);
    assert.equal(result.classProposals.length, 0);
    assert.equal(result.capstoneProposals.length, 1);
    assert.equal(result.capstoneProposals[0].id, "proposal:capstone-40");
  }));

  test(`[${systemId}] no adapter configured: template capstone and template Class still appear and validate`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    // No setProposalAdapter call at all.
    const actor = createMockActor(systemId);
    await seed(actor, { level: 49, progress: levelRequirement(49), events: sampleEvents() });

    const result = await api.resolveLevelRest(actor, { restType: "long" });

    assert.equal(result.classProposals.length, 1);
    assert.equal(result.classProposals[0].source, "class-evolution");
    assert.deepEqual(validateClassEntry(result.classProposals[0].entry).errors, []);

    assert.equal(result.capstoneProposals.length, 1);
    assert.equal(result.capstoneProposals[0].isCapstone, true);
    assert.deepEqual(validateSkillEntry(result.capstoneProposals[0].entry).errors, []);

    assert.equal(result.warnings.length, 2, JSON.stringify(result.warnings));
    assert.ok(result.warnings.every((w) => /template/.test(w)));
  }));

  test(`[${systemId}] a throwing adapter: template capstone and template Class still appear and validate`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    api.setProposalAdapter(async () => { throw new Error("AI provider returned HTTP 500."); });
    const actor = createMockActor(systemId);
    await seed(actor, { level: 19, progress: levelRequirement(19), events: sampleEvents() });

    const result = await api.resolveLevelRest(actor, { restType: "long" });

    assert.equal(result.classProposals.length, 1);
    assert.deepEqual(validateClassEntry(result.classProposals[0].entry).errors, []);
    assert.equal(result.capstoneProposals.length, 1);
    assert.deepEqual(validateSkillEntry(result.capstoneProposals[0].entry).errors, []);
    assert.equal(result.warnings.length, 2);
    assert.ok(result.warnings.some((w) => w.includes("AI provider failed")));
  }));

  test(`[${systemId}] approving the Class spends the grant allowance; approving the capstone spends the capstone allowance`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    api.setProposalAdapter(milestoneAdapter());
    const actor = createMockActor(systemId);
    await seed(actor, { level: 49, progress: levelRequirement(49), events: sampleEvents() });

    const result = await api.resolveLevelRest(actor, { restType: "long" });
    const before = api.getLevelProgression(actor);
    assert.equal(before.grantAllowances, 1);
    assert.equal(before.capstoneAllowances, 1);

    await api.approveProposal(actor, result.classProposals[0].id);
    const afterClass = api.getLevelProgression(actor);
    assert.equal(afterClass.grantAllowances, 0, "approving the Class spends the ordinary grant allowance");
    assert.equal(afterClass.capstoneAllowances, 1, "the capstone allowance is untouched by the Class approval");

    await api.approveProposal(actor, result.capstoneProposals[0].id);
    const afterCapstone = api.getLevelProgression(actor);
    assert.equal(afterCapstone.capstoneAllowances, 0, "approving the capstone spends the capstone allowance");
  }));

  test(`[${systemId}] a rest that crosses no milestone asks the AI gateway for nothing`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const adapter = milestoneAdapter();
    api.setProposalAdapter(adapter);
    const actor = createMockActor(systemId);
    await seed(actor, { level: 21, progress: levelRequirement(21), events: sampleEvents() });

    const result = await api.resolveLevelRest(actor, { restType: "long" });

    assert.deepEqual(result.gainedLevels, [22]);
    assert.equal(result.classProposals.length, 0);
    assert.equal(result.capstoneProposals.length, 0);
    assert.equal(adapter.calls.length, 0);
  }));
}
