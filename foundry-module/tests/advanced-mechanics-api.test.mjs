import assert from "node:assert/strict";
import test from "node:test";

import { GrandDesignApi, describeSkip, titleEntryFromProposal } from "../scripts/api.js";
import { assessIntentionalBreadth, mergeClassMechanics, mergedSystemChassis, pickMergeSources } from "../scripts/class-merging.js";
import {
  GROWTH_EVENTS_FLAG,
  GROWTH_PROPOSALS_FLAG,
  HORROR_RANK_POINTS_PER_RED_APPROVAL,
  LEVEL_PROGRESSION_FLAG,
  MODULE_ID,
  REGISTRY_FLAG
} from "../scripts/constants.js";
import { findStrongestClass } from "../scripts/horror-rank.js";
import { isActiveEntry, markSuperseded, normalizeEntry } from "../scripts/lineage.js";
import { growEvolvedMechanics } from "../scripts/skill-evolution.js";

// dev-integration, advanced-mechanics batch (2026-09-29): board ebcc3f03 (Skill evolution reachable),
// 7b616fea (Class merge offered), d4ae9326 (AI title path), API half of 43ff2ae9 (Suggest explains
// "0 new"), getOwnedEntries. Every scenario runs on both systems.

const SYSTEMS = ["pf2e", "dnd5e"];

function createMockActor(systemId, { name = "Maren" } = {}) {
  const flags = { [MODULE_ID]: {} };
  const items = [];
  let counter = 0;
  const makeItem = (source) => {
    counter += 1;
    const item = {
      id: `item-${counter}`,
      name: source.name,
      type: source.type,
      flags: structuredClone(source.flags ?? {}),
      getFlag(module, key) {
        return this.flags?.[module]?.[key];
      },
      async update(changes) {
        for (const [path, value] of Object.entries(changes)) {
          if (path === "name") this.name = value;
          else if (path.startsWith(`flags.${MODULE_ID}.`)) {
            this.flags[MODULE_ID] ??= {};
            this.flags[MODULE_ID][path.slice(`flags.${MODULE_ID}.`.length)] = value;
          }
        }
        return this;
      },
      async createActivity() {
        return {};
      }
    };
    items.push(item);
    return item;
  };
  return {
    id: `mock-${systemId}-${name}`,
    name,
    documentName: "Actor",
    type: "character",
    system: systemId === "dnd5e"
      ? { details: { level: 10 }, skills: { ath: { mod: 4, total: 8 } }, abilities: { str: { mod: 4 } }, attributes: { prof: 4 } }
      : { details: { level: { value: 10 } }, skills: { athletics: { totalModifier: 18 } }, abilities: { str: { mod: 4 } } },
    items: {
      find: (fn) => items.find(fn),
      filter: (fn) => items.filter(fn),
      get all() {
        return items;
      }
    },
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
    async createEmbeddedDocuments(_type, sources) {
      return sources.map(makeItem);
    }
  };
}

async function withFoundry(systemId, fn) {
  const originalGame = globalThis.game;
  const originalHooks = globalThis.Hooks;
  const calls = [];
  globalThis.game = { user: { isGM: true }, system: { id: systemId } };
  globalThis.Hooks = { callAll: (name, ...args) => calls.push({ name, args }) };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    return await fn(calls);
  } finally {
    globalThis.game = originalGame;
    globalThis.Hooks = originalHooks;
    console.warn = originalWarn;
  }
}

const MECH = (effect, extra = {}) => ({ effect, duration: "ongoing", frequency: { max: 1, per: "day" }, ...extra });

function skillEntry(name, tags, extra = {}) {
  return {
    name,
    tier: 1,
    system_equivalent: "Power Attack",
    gameItem: { kind: "action" },
    mechanics: { effect: `${name}: make a Strike that deals extra damage.`, duration: "instant", frequency: { max: 1, per: "encounter" }, actions: 1, roll: { kind: "Athletics check", formula: "1d20+8" } },
    metadata: { tags, lineage: { operation: "origin", sources: [], rationale: "test" } },
    ...extra
  };
}

function classEntry(name, tags, extra = {}) {
  return {
    name,
    level: 12,
    power_tier: "standard",
    system_chassis: name === "Warrior" ? "Fighter" : "Ranger",
    gameItem: { kind: "passive" },
    mechanics: MECH(`${name} benefit.`),
    metadata: { tags, lineage: { operation: "origin", sources: [], rationale: "test" } },
    ...extra
  };
}

async function seedCharacter(api, actor, { skills = [skillEntry("Power Strike", ["martial"])], classes = [classEntry("Warrior", ["martial", "athletics"], { is_primary: true })], events = [], level = 5, grantAllowances = 0 } = {}) {
  await api.applyToActor(actor, { character: actor.name, classes, skills });
  // Pretend everything was approved long ago, so the seeded events count as practice since then.
  const registry = api.getActorRegistry(actor);
  for (const bucket of ["classes", "skills"]) for (const entry of Object.values(registry[bucket])) entry.approvedAt = "2026-01-01T00:00:00.000Z";
  await actor.update({
    [`flags.${MODULE_ID}.${REGISTRY_FLAG}`]: registry,
    [`flags.${MODULE_ID}.${GROWTH_EVENTS_FLAG}`]: events,
    [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: [],
    [`flags.${MODULE_ID}.${LEVEL_PROGRESSION_FLAG}`]: { level, progress: 0, grantAllowances, capstoneAllowances: 0, lastRestAt: null, lastRestType: null }
  });
}

const ev = (id, summary, tags, outcome = "success", extra = {}) => ({ id, summary, tags, outcome, occurredAt: "2026-09-29T00:00:00.000Z", actorName: "Maren", ...extra });
// Enough practice (4 x success = 4 >= SKILL_EVOLUTION_EVIDENCE_THRESHOLD) plus a defining moment.
const readyEvents = () => [
  ev("event:1", "Maren power-struck the ogre.", ["martial"]),
  ev("event:2", "Maren power-struck a bandit.", ["martial"]),
  ev("event:3", "Maren power-struck the gate.", ["martial"]),
  ev("event:4", "Maren power-struck the troll against all odds.", ["martial"], "criticalSuccess", { dangerGap: "severe" })
];

// ---------------------------------------------------------------------------------------------
// Pure helpers

test("growEvolvedMechanics grows the source's mechanics instead of copying them (ebcc3f03)", () => {
  const source = { effect: "Strike hard.", duration: "instant", frequency: { max: 1, per: "encounter" }, actions: 1, roll: { kind: "Athletics check", formula: "1d20+8" } };
  const pf2e = growEvolvedMechanics(source, { fromTier: 1, toTier: 2, hasCatalyst: true, systemId: "pf2e" });
  assert.equal(pf2e.roll.formula, "1d20+10");
  assert.equal(pf2e.frequency.max, 2);
  assert.match(pf2e.effect, /circumstance bonus/);
  assert.notDeepEqual(pf2e, source);
  assert.equal(source.roll.formula, "1d20+8", "the source is not mutated");
  const dnd = growEvolvedMechanics(source, { fromTier: 2, toTier: 3, hasCatalyst: true, systemId: "dnd5e" });
  assert.doesNotMatch(dnd.effect, /circumstance/);
  assert.match(dnd.effect, /roll a 20/);
  const refined = growEvolvedMechanics(source, { fromTier: 1, toTier: 1, hasCatalyst: false });
  assert.equal(refined.frequency.max, 1, "a refinement gains no extra use");
  assert.equal(refined.roll.formula, "1d20+9");
});

test("markSuperseded / isActiveEntry / normalizeEntry refuse to build on a superseded source", () => {
  const registry = { version: 1, classes: {}, skills: { "skill:a": { name: "A", metadata: { id: "skill:a", tags: ["martial"] } } }, titles: {} };
  const next = markSuperseded(registry, "skill", ["skill:a", "skill:missing"], "skill:b", "2026-09-29");
  assert.equal(isActiveEntry(registry.skills["skill:a"]), true, "input untouched");
  assert.equal(next.skills["skill:a"].status, "superseded");
  assert.equal(next.skills["skill:a"].supersededBy, "skill:b");
  assert.throws(() => normalizeEntry("skill", { name: "C", metadata: { lineage: { operation: "upgrade", sources: ["skill:a"] } } }, next), /already superseded/);
});

test("findStrongestClass skips superseded Classes (Horror Rank and revival never dock history)", () => {
  const registry = { classes: { "class:old": { level: 30, status: "superseded", metadata: {} }, "class:new": { level: 20, metadata: {} } } };
  assert.equal(findStrongestClass(registry).id, "class:new");
});

test("assessIntentionalBreadth: practised sources plus a deed that bridges them", () => {
  const a = { name: "Cook", metadata: { id: "class:cook", tags: ["craft", "support"] } };
  const b = { name: "Duelist", metadata: { id: "class:duelist", tags: ["martial", "precision"] } };
  const events = [
    ev("e1", "cooked", ["craft"]), ev("e2", "fed the camp", ["support"]),
    ev("e3", "duel", ["martial"]), ev("e4", "riposte", ["precision"])
  ];
  assert.equal(assessIntentionalBreadth([a, b], events).intentional, false, "separate boxes are not deliberate breadth");
  const bridged = assessIntentionalBreadth([a, b], [...events, ev("e5", "fought with a cleaver in the kitchen", ["craft", "martial"])]);
  assert.equal(bridged.intentional, true);
  assert.deepEqual(bridged.bridgingEventIds, ["e5"]);
  assert.equal(assessIntentionalBreadth([a, b], [ev("e5", "x", ["craft", "martial"])]).intentional, false, "one deed is not practice");
});

test("pickMergeSources picks the most focused pair; chassis and mechanics follow rule 2.3 per system", () => {
  const warrior = { name: "Warrior", level: 12, is_primary: true, system_chassis: "Fighter", power_tier: "standard", mechanics: { effect: "W." }, metadata: { id: "class:warrior", tags: ["martial", "athletics"] } };
  const guard = { name: "Guard", level: 10, system_chassis: "Champion", power_tier: "standard", mechanics: { effect: "G." }, metadata: { id: "class:guard", tags: ["martial", "athletics", "defense"] } };
  const cook = { name: "Cook", level: 8, system_chassis: "Alchemist", power_tier: "standard", mechanics: { effect: "C." }, metadata: { id: "class:cook", tags: ["craft"] } };
  assert.deepEqual(pickMergeSources([cook, warrior, guard]).map((entry) => entry.name).sort(), ["Guard", "Warrior"]);
  assert.match(mergedSystemChassis([guard, warrior], "pf2e"), /^Fighter chassis, with Champion as a multiclass archetype dedication/);
  assert.match(mergedSystemChassis([guard, warrior], "dnd5e"), /^Fighter chassis, with Champion as multiclass levels or feats/);
  const merged = mergeClassMechanics([warrior, guard], { powerTier: "elevated", systemId: "dnd5e" });
  assert.match(merged.mechanics.effect, /\[Warrior\]: W\. \[Guard\]: G\./);
  assert.match(merged.mechanics.effect, /long rest/);
  assert.equal(mergeClassMechanics([warrior, guard], { powerTier: "standard" }).mechanics.effect.includes("Merged:"), false, "no extra without a tier climb");
});

test("titleEntryFromProposal: deed as achievement, red titles need a vice and get a drawback", () => {
  const plain = titleEntryFromProposal({ kind: "title", entry: { name: "Ogre-Breaker", description: "Broke the ogre's jaw at the bridge.", tags: ["martial"] } });
  assert.equal(plain.entry.achievement, "Broke the ogre's jaw at the bridge.");
  assert.equal(plain.entry.metadata.polarity, undefined);
  const red = titleEntryFromProposal({ kind: "title", entry: { name: "Butcher of Hollow Ford", description: "Killed the surrendering goblins.", tags: [], metadata: { polarity: "red", vice: "bloodlust" } } });
  assert.equal(red.entry.metadata.polarity, "red");
  assert.equal(red.entry.metadata.malignance.vice, "bloodlust");
  assert.match(red.entry.metadata.malignance.drawback, /Infamy/);
  assert.match(titleEntryFromProposal({ kind: "title", entry: { name: "X", description: "y", metadata: { polarity: "red" } } }).error, /no vice/);
  assert.match(titleEntryFromProposal({ kind: "title", entry: { name: "X" } }).error, /deed/);
});

test("describeSkip normalizes every skip shape to { name, reason, duplicateOf, message }", () => {
  const gateway = describeSkip({ proposal: { entry: { name: "Iron Grip" } }, reason: "near-duplicate", duplicateOf: "proposal:ai-skill:iron-hold", errors: ["Too close to Iron Hold."] });
  assert.deepEqual([gateway.name, gateway.reason, gateway.duplicateOf, gateway.message], ["Iron Grip", "near-duplicate", "proposal:ai-skill:iron-hold", "Too close to Iron Hold."]);
  const bare = describeSkip({ proposal: { kind: "skill" }, errors: ["Invalid."] });
  assert.deepEqual([bare.name, bare.reason, bare.duplicateOf], [null, "invalid", null]);
});

// ---------------------------------------------------------------------------------------------
// API, both systems

for (const systemId of SYSTEMS) {
  test(`[${systemId}] readiness runs after analysis and rest: evolutionReady + hook (ebcc3f03)`, async () => {
    await withFoundry(systemId, async (calls) => {
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId);
      await seedCharacter(api, actor, { events: readyEvents().slice(0, 3) });
      // An adapter that reads the notes as the defining moment.
      api.setProposalAdapter(async () => ({ events: [ev("event:9", "Maren power-struck the troll and lived.", ["martial"], "criticalSuccess", { dangerGap: "severe" })], proposals: [] }));
      const analysis = await api.analyzeSessionNotes(actor, "Maren power-struck the troll and lived.");
      assert.equal(analysis.evolutionReady.length, 1);
      assert.equal(analysis.evolutionReady[0].skillId, "skill:power-strike");
      assert.equal(analysis.evolutionReady[0].pressure.hasCatalyst, true);
      assert.ok(calls.some((call) => call.name === "grand-design-ai.evolutionReady"), "hook fired");
      const rest = await api.resolveLevelRest(actor, { restType: "short" });
      assert.deepEqual(rest.evolutionReady.map((row) => row.skillId), ["skill:power-strike"]);
    });
  });

  test(`[${systemId}] requestSkillEvolution without authorAdvanced: fallback with the reason, grown mechanics; approve supersedes (ebcc3f03)`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId);
      await seedCharacter(api, actor, { events: readyEvents() });
      api.setProposalAdapter(async () => ({ events: [], proposals: [] })); // a gateway without authorAdvanced
      const { proposal, usedFallback, reason } = await api.requestSkillEvolution(actor, "skill:power-strike");
      assert.equal(usedFallback, true);
      assert.match(reason, /authorAdvanced/);
      assert.equal(proposal.status, "pending");
      assert.equal(proposal.kind, "skill");
      assert.equal(proposal.source, "skill-evolution");
      assert.deepEqual(proposal.entry.metadata.lineage.sources, ["skill:power-strike"]);
      assert.equal(proposal.entry.metadata.lineage.operation, "upgrade");
      assert.equal(proposal.entry.tier, 2);
      assert.doesNotMatch(proposal.entry.metadata.lineage.rationale, /\.\./, "no doubled full stop after the moment's summary");
      assert.notEqual(proposal.entry.mechanics.effect, "Power Strike: make a Strike that deals extra damage.", "mechanics grow, not copied");
      assert.match(proposal.entry.mechanics.effect, systemId === "pf2e" ? /circumstance bonus/ : /\+2 bonus/);
      await assert.rejects(api.requestSkillEvolution(actor, "skill:power-strike"), /already pending/);
      assert.deepEqual(api._evolutionReady(actor), [], "a pending evolution is not announced again");

      // No grant allowance is needed (the readiness earned it) and none is spent.
      const approved = await api.approveProposal(actor, proposal.id);
      assert.deepEqual(approved.superseded, ["skill:power-strike"]);
      const registry = api.getActorRegistry(actor);
      assert.equal(registry.skills["skill:power-strike"].status, "superseded");
      assert.equal(registry.skills["skill:power-strike"].supersededBy, proposal.entry.metadata.id);
      assert.equal(registry.skills[proposal.entry.metadata.id].evolution.from, "skill:power-strike");
      assert.equal(api.getLevelProgression(actor).grantAllowances, 0);
      const oldItem = actor.items.find((item) => item.getFlag(MODULE_ID, "registryId") === "skill:power-strike");
      assert.match(oldItem.name, /\(superseded\)$/, "the Item is kept but marked");
      assert.equal(oldItem.getFlag(MODULE_ID, "superseded").by, proposal.entry.metadata.id);
      await assert.rejects(api.requestSkillEvolution(actor, "skill:power-strike"), /already evolved/);

      const owned = api.getOwnedEntries(actor);
      const oldRow = owned.skills.find((row) => row.id === "skill:power-strike");
      const newRow = owned.skills.find((row) => row.id === proposal.entry.metadata.id);
      assert.equal(oldRow.status, "superseded");
      assert.equal(oldRow.supersededByName, proposal.entry.name);
      assert.equal(newRow.status, "active");
      assert.deepEqual(newRow.lineage.sourceNames, ["Power Strike"]);
      assert.equal(newRow.tier, 2);
      assert.equal(owned.classes[0].level, 12);
      assert.deepEqual(owned.titles, []);
    });
  });

  test(`[${systemId}] requestSkillEvolution uses adapter.authorAdvanced and fits its answer to the rules`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId);
      await seedCharacter(api, actor, { events: readyEvents() });
      const adapter = async () => ({ events: [], proposals: [] });
      let seen = null;
      adapter.authorAdvanced = async (args) => {
        seen = args;
        return {
          events: [],
          proposals: [{
            kind: "skill",
            rationale: "The troll fight broke it open.",
            entry: {
              name: "Troll-Felling Blow",
              tier: 3, // the model over-reaches; the rules say +1
              system_equivalent: "Power Attack, improved",
              gameItem: { kind: "action" },
              mechanics: { effect: "Make a Strike; on a hit deal 2 extra dice of damage and knock the target prone.", duration: "instant", frequency: { max: 2, per: "encounter" }, actions: 2, roll: { kind: "Athletics check", formula: "1d20+10" } },
              metadata: { id: "skill:hijacked", tags: ["martial"], lineage: { operation: "origin", sources: [] } }
            }
          }]
        };
      };
      api.setProposalAdapter(adapter);
      const { proposal, usedFallback, reason } = await api.requestSkillEvolution(actor, "skill:power-strike");
      assert.equal(seen.operation, "upgrade");
      assert.equal(seen.sources[0].id, "skill:power-strike");
      assert.equal(seen.sources[0].kind, "skill");
      assert.ok(seen.sources[0].definingMoments.some((summary) => /troll/.test(summary)));
      assert.equal(seen.systemId, systemId);
      assert.equal(usedFallback, false);
      assert.match(reason, /tier set to 2/);
      assert.equal(proposal.entry.name, "Troll-Felling Blow");
      assert.equal(proposal.entry.tier, 2);
      assert.equal(proposal.entry.metadata.id, "skill:power-strike--evolved-t2");
      assert.deepEqual(proposal.entry.metadata.lineage, { operation: "upgrade", sources: ["skill:power-strike"], rationale: "The troll fight broke it open." });
      assert.equal(proposal.authoredBy, "ai-gateway");
    });
  });

  test(`[${systemId}] requestSkillEvolution: a throwing authorAdvanced falls back with the provider's error`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId);
      await seedCharacter(api, actor, { events: readyEvents().slice(0, 2) });
      const adapter = async () => ({ events: [] });
      adapter.authorAdvanced = async () => {
        throw new Error("connect ECONNREFUSED");
      };
      api.setProposalAdapter(adapter);
      const { proposal, usedFallback, reason } = await api.requestSkillEvolution(actor, "skill:power-strike");
      assert.equal(usedFallback, true);
      assert.match(reason, /ECONNREFUSED/);
      assert.match(reason, /not ready yet/, "an unready Skill is said to refine, not evolve");
      assert.equal(proposal.entry.tier, 1);
      assert.equal(proposal.entry.name, "Greater Power Strike");
    });
  });

  test(`[${systemId}] requestClassMerge: fallback merge per rules 2.3/2.4, approve supersedes both sources (7b616fea)`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId);
      await seedCharacter(api, actor, {
        classes: [
          classEntry("Warrior", ["martial", "athletics"], { is_primary: true }),
          classEntry("Guard", ["martial", "athletics", "defense"], { level: 10, is_secondary: true, power_tier: "elevated" })
        ]
      });
      const { proposal, usedFallback, reason, intentional } = await api.requestClassMerge(actor, ["class:warrior", "class:guard"]);
      assert.equal(usedFallback, true);
      assert.match(reason, /no AI provider/);
      assert.equal(intentional, false);
      assert.equal(proposal.kind, "class");
      assert.equal(proposal.source, "class-merge");
      assert.equal(proposal.entry.metadata.lineage.operation, "combine");
      assert.deepEqual(proposal.entry.metadata.lineage.sources, ["class:warrior", "class:guard"]);
      assert.equal(proposal.entry.level, 12, "the highest source level");
      assert.equal(proposal.entry.power_tier, "elevated", "off-cycle: held at the strongest source's tier");
      assert.equal(proposal.entry.offCycleEvolution, true);
      assert.equal(proposal.entry.is_primary, true);
      assert.match(proposal.entry.system_chassis, /^Fighter chassis/);
      assert.match(proposal.entry.mechanics.effect, /\[Warrior\]: Warrior benefit\./);
      await assert.rejects(api.requestClassMerge(actor, ["class:guard", "class:warrior"]), /already pending/);
      await assert.rejects(api.requestClassMerge(actor, ["class:warrior"]), /at least two/);

      const approved = await api.approveProposal(actor, proposal.id);
      assert.deepEqual(approved.superseded.sort(), ["class:guard", "class:warrior"]);
      const owned = api.getOwnedEntries(actor);
      assert.deepEqual(owned.classes.filter((row) => row.status === "active").map((row) => row.name), [proposal.entry.name]);
      assert.deepEqual(owned.classes.find((row) => row.status === "active").lineage.sourceNames, ["Warrior", "Guard"]);
      assert.deepEqual(api.checkClassErosion(actor).map((row) => row.classId ?? row.id).filter((id) => id === "class:warrior"), [], "a merged-away Class is not eroding");
    });
  });

  test(`[${systemId}] requestClassMerge via authorAdvanced: the focus score owns the power tier, red is contagious`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId);
      await seedCharacter(api, actor, {
        classes: [
          classEntry("Warrior", ["martial", "athletics"], { is_primary: true }),
          classEntry("Reaver", ["martial", "athletics"], { metadata: { tags: ["martial", "athletics"], polarity: "red", malignance: { vice: "bloodlust", drawback: "Must kill once a day." }, lineage: { operation: "origin", sources: [], rationale: "" } } })
        ],
        level: 20
      });
      const adapter = async () => ({ events: [] });
      adapter.authorAdvanced = async ({ operation, sources }) => ({
        events: [],
        proposals: [{
          kind: "class",
          entry: {
            name: "Red Warlord",
            level: 99,
            power_tier: "standard",
            system_chassis: "Fighter with a Barbarian dedication",
            gameItem: { kind: "passive" },
            mechanics: MECH("Your Strikes against a frightened foe gain a +1 bonus."),
            metadata: { tags: ["martial"], lineage: { operation, sources: sources.map((source) => source.name) } }
          }
        }]
      });
      api.setProposalAdapter(adapter);
      const { proposal, usedFallback, reason } = await api.requestClassMerge(actor, ["class:warrior", "class:reaver"]);
      assert.equal(usedFallback, false);
      assert.equal(proposal.entry.name, "Red Warlord");
      assert.equal(proposal.entry.power_tier, "elevated", "identical tags: focus 1.0, on cadence at 20 -> one tier up");
      assert.match(reason, /power tier set to elevated/);
      assert.equal(proposal.entry.level, 12);
      assert.deepEqual(proposal.entry.metadata.lineage.sources, ["class:warrior", "class:reaver"], "ids, not the names the model echoed");
      assert.equal(proposal.entry.metadata.polarity, "red");
      assert.equal(proposal.entry.metadata.malignance.vice, "bloodlust");
      const before = api.getHorrorRank(actor).points;
      await api.approveProposal(actor, proposal.id);
      assert.equal(api.getHorrorRank(actor).points, before + HORROR_RANK_POINTS_PER_RED_APPROVAL);
    });
  });

  test(`[${systemId}] a Class milestone with two active Classes offers a merge next to the new Class`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId);
      await seedCharacter(api, actor, {
        classes: [classEntry("Warrior", ["martial", "athletics"], { is_primary: true }), classEntry("Guard", ["martial", "defense"])],
        level: 19,
        events: readyEvents()
      });
      // Enough progress for 19 -> 20.
      await actor.update({ [`flags.${MODULE_ID}.${LEVEL_PROGRESSION_FLAG}`]: { ...api.getLevelProgression(actor), progress: 100000 } });
      const rest = await api.resolveLevelRest(actor, { restType: "long" });
      assert.ok(rest.classEvolutionUnlocked.includes(20));
      const merge = rest.classProposals.find((proposal) => proposal.source === "class-merge");
      assert.ok(merge, "a merge proposal is offered");
      assert.equal(merge.id, "proposal:class-merge-20");
      assert.equal(merge.milestoneLevel, 20);
      assert.equal(merge.entry.offCycleEvolution, false, "on the cadence at a milestone");
      assert.ok(rest.classProposals.some((proposal) => proposal.source === "class-evolution"), "the new-Class option stays");
      assert.ok(rest.warnings.some((warning) => /Class merge at Grand Design level 20/.test(warning)));
      const allowances = api.getLevelProgression(actor).grantAllowances;
      assert.ok(allowances >= 1);
      await api.approveProposal(actor, merge.id);
      assert.equal(api.getLevelProgression(actor).grantAllowances, allowances - 1, "the milestone merge spends the grant");
    });
  });

  test(`[${systemId}] stage-2 title proposals: pending, approve -> grantTitle, red title accrues Horror Rank (d4ae9326)`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId);
      await seedCharacter(api, actor);
      api.setProposalAdapter(async () => ({
        events: [ev("event:t1", "Maren killed the goblins that surrendered.", ["martial"])],
        proposals: [
          { kind: "title", evidence: ["event:t1"], rationale: "\"killed the goblins that surrendered\"", entry: { name: "Butcher of Hollow Ford", description: "Killed the goblins that surrendered at Hollow Ford.", tags: ["martial"], metadata: { polarity: "red", vice: "bloodlust" } } },
          { kind: "title", evidence: ["event:t1"], entry: { name: "Ogre-Breaker", description: "Broke the ogre's jaw.", tags: [] } },
          { kind: "title", evidence: ["event:t1"], entry: { name: "Nameless Horror", description: "Something dark.", metadata: { polarity: "red" } } }
        ]
      }));
      const analysis = await api.analyzeSessionNotes(actor, "Maren killed the goblins that surrendered.");
      const titles = analysis.proposals.filter((proposal) => proposal.kind === "title");
      assert.deepEqual(titles.map((proposal) => proposal.entry.name).sort(), ["Butcher of Hollow Ford", "Ogre-Breaker"]);
      assert.ok(analysis.adapterSkippedProposals.some((skip) => /no vice/.test(skip.errors.join(" "))), "a red title with no vice is skipped with the reason");

      const red = titles.find((proposal) => proposal.entry.name === "Butcher of Hollow Ford");
      const edited = await api.updateProposal(actor, red.id, { description: "Cut down the surrendering goblins at Hollow Ford." });
      assert.equal(edited.ok, true, edited.errors.join(" "));
      assert.equal(edited.proposal.entry.achievement, "Cut down the surrendering goblins at Hollow Ford.");
      assert.equal(edited.proposal.entry.mechanics, undefined);

      const points = api.getHorrorRank(actor).points;
      const granted = await api.approveProposal(actor, red.id); // no grant allowance needed for a Title
      assert.ok(granted.item);
      const registry = api.getActorRegistry(actor);
      assert.equal(registry.titles["title:butcher-of-hollow-ford"].metadata.polarity, "red");
      assert.equal(api.getHorrorRank(actor).points, points + HORROR_RANK_POINTS_PER_RED_APPROVAL);
      const ogre = titles.find((proposal) => proposal.entry.name === "Ogre-Breaker");
      await api.rejectProposal(actor, ogre.id, { reason: "not earned yet" });
      assert.equal(api.getGrowth(actor).proposals.find((proposal) => proposal.id === ogre.id).status, "rejected");
      assert.deepEqual(api.getOwnedEntries(actor).titles.map((row) => [row.name, row.polarity, row.effect]), [["Butcher of Hollow Ford", "red", "Cut down the surrendering goblins at Hollow Ford."]]);
    });
  });

  test(`[${systemId}] Suggest returns skipped reasons and capReached (43ff2ae9: Buck at 5 pending got "0 new" with no reason)`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId, { name: "Buck" });
      await seedCharacter(api, actor, { events: readyEvents().map((event) => ({ ...event, actorName: "Buck" })) });
      const pending = Array.from({ length: 5 }, (_, index) => ({
        id: `proposal:ai-skill:held-${index}`,
        kind: "skill",
        status: "pending",
        source: "ai-gateway",
        evidence: ["event:1", "event:2", "event:3"],
        entry: skillEntry(`Held Idea ${index}`, ["martial"])
      }));
      await actor.update({ [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: pending });
      api.setProposalAdapter(async () => ({
        events: [],
        proposals: [
          { kind: "skill", evidence: ["event:1"], entry: skillEntry("Fresh Idea", ["martial"]) },
          { kind: "skill", evidence: ["event:1"], entry: skillEntry("Held Idea 0", ["martial"]) },
          { kind: "skill", evidence: ["event:1"], entry: skillEntry("Power Strike", ["martial"]) }
        ],
        skippedProposals: [{ proposal: { kind: "skill", entry: { name: "Grappler's Grip" } }, reason: "near-duplicate", duplicateOf: "proposal:ai-skill:held-1", errors: ["Too close to Held Idea 1."] }]
      }));
      const result = await api.requestGrowthProposals(actor);
      assert.equal(result.added.length, 0);
      assert.deepEqual(result.capReached, { pending: 5, cap: 5 });
      const byName = Object.fromEntries(result.skipped.map((skip) => [skip.name, skip]));
      assert.equal(byName["Fresh Idea"].reason, "pending-cap");
      assert.equal(byName["Held Idea 0"].reason, "duplicate");
      assert.equal(byName["Held Idea 0"].duplicateOf, "proposal:ai-skill:held-0");
      assert.equal(byName["Power Strike"].reason, "owned");
      assert.equal(byName["Power Strike"].duplicateOf, "skill:power-strike");
      assert.equal(byName["Grappler's Grip"].reason, "near-duplicate");
      assert.equal(byName["Grappler's Grip"].duplicateOf, "proposal:ai-skill:held-1");
      for (const skip of result.skipped) assert.equal(typeof skip.message, "string");

      // With room left, nothing is capped and capReached is null.
      await actor.update({ [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: [] });
      const roomy = await api.requestGrowthProposals(actor);
      assert.equal(roomy.capReached, null);
      assert.ok(roomy.added.some((proposal) => proposal.entry.name === "Fresh Idea"));
    });
  });
}
