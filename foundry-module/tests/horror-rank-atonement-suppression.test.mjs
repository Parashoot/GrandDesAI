// Owner decisions 2026-09-29 (conversion rules section 6, all three open questions answered YES):
// - 73fa8066: each Horror Rank stage gained suppresses one class feat / dedication (PF2e) or feat /
//   class feature (dnd5e), GM-confirmed (module default: combat-relevant first, never a Grand Design
//   Item), switched off mechanically and restored exactly; Stage 3 lock-out notice; a stage lost
//   gives one back (GM's order, default most recent).
// - a8728f4e: atonement deeds lower Horror Rank on the deeds' scale, floored at 0, still derived;
//   GM "Restore docked levels", recorded so nothing double-docks or re-restores.
// - 41384131: severity points and the threshold as clamped GM world settings.
// Everything on BOTH systems.
import assert from "node:assert/strict";
import test from "node:test";

import { GrandDesignApi } from "../scripts/api.js";
import {
  GROWTH_EVENTS_FLAG,
  GROWTH_PROPOSALS_FLAG,
  HORROR_RANK_FLAG,
  HORROR_RANK_SETTINGS,
  LEVEL_PROGRESSION_FLAG,
  MODULE_ID
} from "../scripts/constants.js";
import {
  atonementPointsFor,
  computeHorrorRank,
  normalizeAtonement,
  resolveHorrorRankConfig,
  restoreDockedLevels,
  suppressionBalance
} from "../scripts/horror-rank.js";
import { normalizeGrowthEvent } from "../scripts/progression.js";
import {
  combatRelevance,
  isSuppressibleFeature,
  listSuppressibleFeatures,
  restoreSuppressedFeature,
  suppressFeature
} from "../scripts/systems/horror-suppression.js";
import { coerceAtonement, coerceEvent } from "../scripts/ai/normalize.js";
import { EVENT_ITEM_SCHEMA } from "../scripts/ai/schemas.js";
import { buildExtractionMessages } from "../scripts/ai/prompts.js";
import { mergeFollowUpEvents } from "../scripts/ai/pipeline.js";
import { scoreAtonement, goldAtonement } from "../tools/nlp-scale/lib.mjs";
import {
  describeHorrorRankChange,
  normalizeHorrorRankView,
  prepareHorrorAction,
  renderAtonementBadge,
  renderHorrorRankControls,
  renderHorrorRankMeter
} from "../scripts/growth-ui.js";

const SYSTEMS = ["pf2e", "dnd5e"];

// --- helpers ---------------------------------------------------------------------------------------

// Applies a Foundry-style update path: "a.b.c" sets, "a.b.-=c" deletes.
function applyPath(target, path, value) {
  const keys = path.split(".");
  let node = target;
  for (const key of keys.slice(0, -1)) {
    node[key] ??= {};
    node = node[key];
  }
  const last = keys.at(-1);
  if (last.startsWith("-=")) delete node[last.slice(2)];
  else node[last] = value;
}

function makeItem(source, id) {
  return {
    id,
    name: source.name,
    type: source.type,
    system: structuredClone(source.system ?? {}),
    flags: structuredClone(source.flags ?? {}),
    effects: structuredClone(source.effects ?? []),
    updates: [],
    getFlag(module, key) {
      return this.flags?.[module]?.[key];
    },
    async update(changes) {
      this.updates.push(structuredClone(changes));
      for (const [path, value] of Object.entries(changes)) {
        if (path === "name") this.name = value;
        else if (path === "effects") this.effects = structuredClone(value);
        else applyPath(this, path, structuredClone(value));
      }
      return this;
    },
    async createActivity() {
      return {};
    }
  };
}

function createMockActor(systemId, { name = "Tovin" } = {}) {
  const flags = { [MODULE_ID]: {} };
  const items = [];
  let counter = 0;
  const add = (source) => {
    counter += 1;
    const item = makeItem(source, `item-${counter}`);
    items.push(item);
    return item;
  };
  return {
    id: `mock-${systemId}-${name}`,
    name,
    documentName: "Actor",
    type: "character",
    _items: items,
    _add: add,
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
        flags[MODULE_ID][key] = structuredClone(value);
      }
      return this;
    },
    async createEmbeddedDocuments(_type, sources) {
      return sources.map(add);
    }
  };
}

async function withFoundry(systemId, fn, { settings = {} } = {}) {
  const originalGame = globalThis.game;
  const originalHooks = globalThis.Hooks;
  const calls = [];
  globalThis.game = {
    user: { isGM: true },
    system: { id: systemId },
    settings: {
      get(module, key) {
        if (!(key in settings)) throw new Error(`setting ${key} not registered`);
        return settings[key];
      }
    }
  };
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

const MECH = (effect) => ({ effect, duration: "ongoing", frequency: { max: 1, per: "day" } });
function classEntry(name, level) {
  return {
    name,
    level,
    power_tier: "standard",
    system_chassis: "Fighter",
    is_primary: true,
    gameItem: { kind: "passive" },
    mechanics: MECH(`${name} benefit.`),
    metadata: { tags: ["martial"], lineage: { operation: "origin", sources: [], rationale: "test" } }
  };
}

// The system's own feats on the sheet: the combat one should be the default pick.
const FEATS = {
  pf2e: [
    { name: "Power Attack", type: "feat", system: { category: "class", level: { value: 1 }, actionType: { value: "action" }, traits: { value: ["fighter", "flourish"] }, rules: [{ key: "FlatModifier", selector: "damage", value: 2 }], frequency: { max: 1, per: "day", value: 1 }, description: { value: "<p>Make a Strike that deals an extra die of damage.</p>" } } },
    { name: "Medic Dedication", type: "feat", system: { category: "class", level: { value: 2 }, actionType: { value: "passive" }, traits: { value: ["archetype", "dedication"] }, rules: [], description: { value: "<p>You become an expert in Medicine.</p>" } } },
    { name: "Courtly Graces", type: "feat", system: { category: "skill", level: { value: 1 }, traits: { value: ["general", "skill"] }, rules: [], description: { value: "<p>Society for nobility.</p>" } } },
    { name: "Attack of Opportunity", type: "feat", system: { category: "classfeature", level: { value: 1 }, actionType: { value: "reaction" }, traits: { value: ["fighter"] }, rules: [], description: { value: "<p>Make a Strike.</p>" } } }
  ],
  dnd5e: [
    {
      name: "Great Weapon Master",
      type: "feat",
      system: { type: { value: "feat" }, activities: { atk001: { _id: "atk001", type: "attack", name: "Heavy Swing" } }, uses: { max: 1, spent: 0, recovery: [] }, description: { value: "<p>A heavy attack.</p>" } },
      effects: [
        { _id: "eff001", name: "GWM", changes: [{ key: "system.bonuses.mwak.damage", mode: 2, value: "10" }], disabled: false },
        { _id: "eff002", name: "Already off", changes: [], disabled: true }
      ]
    },
    { name: "Actor", type: "feat", system: { type: { value: "feat" }, activities: {}, description: { value: "<p>Performances.</p>" } } },
    { name: "Second Wind", type: "feat", system: { type: { value: "class" }, activities: { heal01: { _id: "heal01", type: "heal" } }, uses: { max: 1, spent: 1 }, description: { value: "<p>Regain hit points.</p>" } } },
    { name: "Darkvision", type: "feat", system: { type: { value: "race" }, activities: {}, description: { value: "<p>See in the dark.</p>" } } }
  ]
};

async function seed(api, actor, systemId) {
  await api.applyToActor(actor, { character: actor.name, classes: [classEntry("Warrior", 12)], skills: [] });
  await actor.update({
    [`flags.${MODULE_ID}.${GROWTH_EVENTS_FLAG}`]: [],
    [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: [],
    [`flags.${MODULE_ID}.${LEVEL_PROGRESSION_FLAG}`]: { level: 5, progress: 0, grantAllowances: 0, capstoneAllowances: 0, lastRestAt: null, lastRestType: null }
  });
  return FEATS[systemId].map((source) => actor._add(source));
}

const deed = (id, darkDeed, darkSeverity) => ({ id, summary: `Deed ${id}`, tags: ["martial"], outcome: "success", actorName: "Tovin", darkDeed, darkSeverity });
const amends = (id, atonement) => ({ id, summary: `Amends ${id}`, tags: ["diplomacy"], outcome: "success", actorName: "Tovin", atonement, darkDeed: "none", darkSeverity: "none" });
const mechanics = (item) => structuredClone({ name: item.name, system: item.system, effects: item.effects, suppressed: item.flags?.[MODULE_ID]?.horrorSuppressed ?? null });

// --- pure: atonement + config ------------------------------------------------------------------------

test("atonement subtracts on the deeds' scale (profound = monstrous), floored at 0 in recorded order", () => {
  assert.equal(normalizeAtonement({ atonement: " Serious " }), "serious");
  assert.equal(normalizeAtonement({ atonement: "huge" }), "none", "an unknown value never takes points off");
  assert.equal(normalizeAtonement({}), "none", "the local fallback analyzer never sets it");
  assert.deepEqual(["minor", "serious", "profound"].map((level) => atonementPointsFor({ atonement: level })), [5, 15, 40]);

  const events = [deed("d1", "cruelty", "serious"), deed("d2", "desecration", "monstrous"), amends("a1", "serious")];
  const result = computeHorrorRank(events);
  assert.equal(result.points, 40, "15 + 40 - 15");
  assert.equal(result.deedPoints, 55);
  assert.equal(result.atonementPoints, 15);
  assert.deepEqual(result.atonements, [{ eventId: "a1", summary: "Amends a1", level: "serious", points: 15 }]);

  // Floor: amends past clean do not go negative, and amends made BEFORE a deed cannot be banked.
  assert.equal(computeHorrorRank([deed("d1", "cruelty", "minor"), amends("a1", "profound")]).points, 0);
  assert.equal(computeHorrorRank([amends("a0", "profound"), deed("d1", "cruelty", "serious")]).points, 15);
  // Derived: the same events always give the same meter; a repeated id counts once.
  assert.equal(computeHorrorRank([...events, amends("a1", "serious")]).points, 40);
  // Legacy baseline is part of the running sum.
  assert.equal(computeHorrorRank([amends("a1", "serious")], { legacyPoints: 50 }).points, 35);
});

test("resolveHorrorRankConfig clamps the GM's settings and keeps defaults for junk", () => {
  assert.deepEqual(resolveHorrorRankConfig(), { pointsBySeverity: { none: 0, minor: 5, serious: 15, monstrous: 40 }, threshold: 100 });
  const cfg = resolveHorrorRankConfig({ minor: 1000, serious: -3, monstrous: "abc", threshold: 5 });
  assert.equal(cfg.pointsBySeverity.minor, HORROR_RANK_SETTINGS.minor.max);
  assert.equal(cfg.pointsBySeverity.serious, 0);
  assert.equal(cfg.pointsBySeverity.monstrous, 40, "non-numeric keeps the default");
  assert.equal(cfg.threshold, HORROR_RANK_SETTINGS.threshold.min);
  assert.equal(resolveHorrorRankConfig({ threshold: 99999 }).threshold, HORROR_RANK_SETTINGS.threshold.max);
  assert.equal(resolveHorrorRankConfig({ serious: "20" }).pointsBySeverity.serious, 20, "numeric strings are read");
  const custom = computeHorrorRank([deed("d1", "cruelty", "serious"), amends("a1", "minor")], { config: { serious: 60, minor: 10, threshold: 50 } });
  assert.equal(custom.points, 50);
  assert.equal(custom.stage, 1);
  assert.equal(custom.nextThreshold, 100);
});

test("suppressionBalance: one feature per stage (capped at 3); negative = owed back", () => {
  assert.deepEqual(suppressionBalance(2, [{}]), { target: 2, held: 1, due: 1 });
  assert.deepEqual(suppressionBalance(0, [{}, {}]), { target: 0, held: 2, due: -2 });
  assert.equal(suppressionBalance(7, []).due, 3);
});

test("restoreDockedLevels (pure): each dock once; the high-water mark drops only for crossings no longer reached", () => {
  const registry = { classes: { "class:warrior": { name: "Warrior", level: 8 } }, skills: {} };
  const state = {
    thresholdsDocked: 2,
    docks: [
      { id: "d1", crossing: 1, classId: "class:warrior", levelsDocked: 2, fromLevel: 12, toLevel: 10 },
      { id: "d2", crossing: 2, classId: "class:warrior", levelsDocked: 2, fromLevel: 10, toLevel: 8 }
    ]
  };
  const partial = restoreDockedLevels(registry, state, { ids: ["d2"], crossings: 1 });
  assert.equal(partial.registry.classes["class:warrior"].level, 10);
  assert.equal(partial.thresholdsDocked, 1, "crossing 2 is restored and no longer reached");
  assert.equal(registry.classes["class:warrior"].level, 8, "the input registry is never mutated");
  const all = restoreDockedLevels(partial.registry, { ...state, docks: partial.docks, thresholdsDocked: partial.thresholdsDocked }, { crossings: 1 });
  assert.deepEqual(all.restored.map((entry) => entry.id), ["d1"], "d2 is never restored twice");
  assert.equal(all.registry.classes["class:warrior"].level, 12);
  assert.equal(all.thresholdsDocked, 1, "crossing 1 is still reached: restored as mercy, it does not dock again at once");
  const missing = restoreDockedLevels({ classes: {} }, state, { crossings: 0 });
  assert.deepEqual(missing.skipped.map((entry) => entry.reason), ["class-missing", "class-missing"]);
  assert.equal(missing.thresholdsDocked, 2, "unrestored crossings stay docked");
});

// --- pure: suppression per system ---------------------------------------------------------------------

for (const systemId of SYSTEMS) {
  test(`[${systemId}] eligible features: class feats/dedications or feats/class features, never Grand Design Items; combat first`, () => {
    const items = FEATS[systemId].map((source, i) => makeItem(source, `f${i}`));
    const gd = makeItem({ name: "Warrior", type: "feat", system: systemId === "pf2e" ? { category: "class", rules: [{ key: "FlatModifier" }] } : { type: { value: "feat" } }, flags: { [MODULE_ID]: { registryId: "class:warrior" } } }, "gd");
    const eligible = listSuppressibleFeatures([...items, gd], systemId);
    if (systemId === "pf2e") {
      assert.deepEqual(eligible.map((entry) => entry.name), ["Power Attack", "Medic Dedication"], "class feat + dedication; not skill feats or class features");
    } else {
      assert.deepEqual(eligible.map((entry) => entry.name), ["Great Weapon Master", "Second Wind", "Actor"], "feats + class features by combat relevance; not racial traits");
    }
    assert.equal(isSuppressibleFeature(gd, systemId), false, "a Grand Design Item is never a candidate");
    assert.ok(combatRelevance(items[0], systemId).score > combatRelevance(items[1], systemId).score);
  });

  test(`[${systemId}] suppressFeature switches the mechanics off and restoreSuppressedFeature puts back exactly what was there`, async () => {
    const item = makeItem(FEATS[systemId][0], "f0");
    const before = mechanics(item);
    await item.update(suppressFeature(item, systemId, { stage: 1, at: "2026-09-29T00:00:00.000Z" }));
    assert.match(item.name, /\(suppressed\)$/);
    assert.match(item.system.description.value, /Suppressed by Horror Rank \(Stage 1\)/);
    if (systemId === "pf2e") {
      assert.deepEqual(item.system.rules, []);
      assert.equal(item.system.frequency.value, 0);
    } else {
      assert.deepEqual(item.system.activities, {});
      assert.ok(item.effects.every((effect) => effect.disabled === true));
      assert.equal(item.system.uses.spent, 1);
    }
    // Suppressing twice never overwrites the stash with the emptied state.
    assert.equal(isSuppressibleFeature(item, systemId), false);
    await item.update(restoreSuppressedFeature(item, systemId));
    assert.deepEqual(mechanics(item), before, "name, description, rules/activities, frequency/uses and effect states are back exactly");
    assert.equal(restoreSuppressedFeature(item, systemId), null, "nothing to restore twice");
  });
}

// --- api, both systems -------------------------------------------------------------------------------

for (const systemId of SYSTEMS) {
  test(`[${systemId}] a stage gained asks the GM (default = combat feat), suppresses on confirm, and a stage lost restores the most recent exactly`, async () => {
    await withFoundry(systemId, async (calls) => {
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId);
      const [combatFeat, otherFeat] = await seed(api, actor, systemId);
      const pristine = mechanics(combatFeat);
      for (const id of ["a", "b", "c"]) await api.recordGrowthEvent(actor, deed(`event:${id}`, "cruelty", "monstrous"));
      let state = api.getHorrorRank(actor);
      assert.equal(state.stage, 1);
      assert.equal(state.suppression.due, 1, "never silent: one suppression is due");
      assert.equal(state.suppression.defaultCandidateId, combatFeat.id);
      assert.equal(state.suppression.candidates.some((candidate) => /Warrior/.test(candidate.name)), false, "the Grand Design Class is never offered");
      assert.equal(state.lockedOut, false);
      assert.equal(mechanics(combatFeat).suppressed, null, "nothing is switched off before the GM confirms");
      const changed = calls.filter((call) => call.name === "grand-design-ai.horrorRankChanged").at(-1);
      assert.equal(changed.args[1].suppression.due, 1, "the hook's state carries the due suppression");

      // The GM picks another feature first, then undoes it (force) and takes the default.
      const picked = await api.confirmHorrorSuppression(actor, { itemId: otherFeat.id });
      assert.equal(picked.record.itemId, otherFeat.id);
      await assert.rejects(api.confirmHorrorSuppression(actor), /owes no Horror Rank suppression/);
      await assert.rejects(api.restoreHorrorSuppression(actor), /has not dropped a stage/);
      await api.restoreHorrorSuppression(actor, { itemId: otherFeat.id, force: true });
      assert.equal(api.getHorrorRank(actor).suppression.due, 1, "an undone pick asks again");
      const confirmed = await api.confirmHorrorSuppression(actor);
      assert.equal(confirmed.record.itemId, combatFeat.id);
      assert.equal(confirmed.record.stage, 1);
      assert.match(combatFeat.name, /\(suppressed\)/);
      assert.ok(calls.some((call) => call.name === "grand-design-ai.horrorFeatureSuppressed"));
      await assert.rejects(api.confirmHorrorSuppression(actor, { itemId: "item-1" }), /owes no/);

      // Atonement drops the meter below the stage: one feature is owed back, default the most recent.
      await api.recordGrowthEvent(actor, amends("event:amends", "profound"));
      state = api.getHorrorRank(actor);
      assert.equal(state.points, 80);
      assert.equal(state.stage, 0);
      assert.equal(state.suppression.due, -1);
      assert.equal(state.suppression.restoreDefaultId, combatFeat.id);
      const back = await api.restoreHorrorSuppression(actor);
      assert.equal(back.restored, true);
      assert.deepEqual(mechanics(combatFeat), pristine, "restored exactly");
      assert.equal(api.getHorrorRank(actor).suppression.due, 0);
    });
  });

  test(`[${systemId}] Stage 3 is locked out; waiving settles a stage with nothing to suppress`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId);
      await api.applyToActor(actor, { character: actor.name, classes: [classEntry("Warrior", 12)], skills: [] });
      await actor.update({ [`flags.${MODULE_ID}.${GROWTH_EVENTS_FLAG}`]: [] });
      for (let i = 0; i < 8; i += 1) await api.recordGrowthEvent(actor, deed(`event:${i}`, "ruin", "monstrous"));
      const state = api.getHorrorRank(actor);
      assert.equal(state.stage, 3);
      assert.equal(state.lockedOut, true);
      assert.equal(state.suppression.due, 3);
      assert.deepEqual(state.suppression.candidates, [], "only the Grand Design Class is on the sheet");
      await assert.rejects(api.confirmHorrorSuppression(actor), /waive the stage instead/);
      await api.confirmHorrorSuppression(actor, { waive: true });
      assert.equal(api.getHorrorRank(actor).suppression.due, 2);
      assert.match(renderHorrorRankMeter(api.getHorrorRank(actor), { canManage: true }), /Locked out of their calling/);
    });
  });

  test(`[${systemId}] atonement lowers the recorded meter; Restore docked levels gives levels back once and a re-crossing docks once`, async () => {
    await withFoundry(systemId, async (calls) => {
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId);
      await seed(api, actor, systemId);
      for (const id of ["a", "b", "c"]) await api.recordGrowthEvent(actor, deed(`event:${id}`, "desecration", "monstrous"));
      assert.equal(api.getActorRegistry(actor).classes["class:warrior"].level, 10);
      let state = api.getHorrorRank(actor);
      assert.equal(state.docks.length, 1);
      assert.equal(state.docks[0].className, "Warrior");
      assert.equal(state.restorableDocks, 1);

      await api.recordGrowthEvent(actor, amends("event:amends", "profound"));
      assert.equal(api.getHorrorRank(actor).points, 80);
      assert.equal(api.getActorRegistry(actor).classes["class:warrior"].level, 10, "points falling never refunds by itself");
      const restored = await api.restoreDockedLevels(actor);
      assert.equal(restored.levelsRestored, 2);
      assert.equal(api.getActorRegistry(actor).classes["class:warrior"].level, 12);
      const warriorItem = actor._items.find((item) => item.getFlag(MODULE_ID, "registryId") === "class:warrior");
      assert.equal(warriorItem.getFlag(MODULE_ID, "level"), 12, "the Class Item follows");
      if (systemId === "pf2e") assert.equal(warriorItem.system.level.value, 12);
      state = api.getHorrorRank(actor);
      assert.equal(state.totalLevelsDocked, 0);
      assert.equal(state.restorableDocks, 0);
      assert.ok(calls.some((call) => call.name === "grand-design-ai.horrorRankLevelsRestored"));
      assert.equal((await api.restoreDockedLevels(actor)).levelsRestored, 0, "never restored twice");

      // New deeds cross the same line again: it docks again, once.
      await api.recordGrowthEvent(actor, deed("event:d", "cruelty", "monstrous"));
      assert.equal(api.getHorrorRank(actor).points, 120);
      assert.equal(api.getActorRegistry(actor).classes["class:warrior"].level, 10);
      await api.recordGrowthEvent(actor, deed("event:e", "cruelty", "minor"));
      assert.equal(api.getActorRegistry(actor).classes["class:warrior"].level, 10, "not docked twice for one crossing");

      // Mercy above the line: restoring while still at 125 never re-docks on the next change.
      await api.restoreDockedLevels(actor);
      assert.equal(api.getActorRegistry(actor).classes["class:warrior"].level, 12);
      await api.recordGrowthEvent(actor, deed("event:f", "cruelty", "minor"));
      assert.equal(api.getActorRegistry(actor).classes["class:warrior"].level, 12);
    });
  });

  test(`[${systemId}] the GM's world settings move the scale and the threshold (clamped)`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId);
      await seed(api, actor, systemId);
      await api.recordGrowthEvent(actor, deed("event:a", "cruelty", "serious"));
      await api.recordGrowthEvent(actor, amends("event:b", "minor"));
      const state = api.getHorrorRank(actor);
      // serious 30, minor 1000 -> clamped 100 (floor 0 after the amends), threshold 5 -> clamped 20.
      assert.equal(state.points, 0);
      assert.equal(state.threshold, HORROR_RANK_SETTINGS.threshold.min);
      assert.equal(state.pointsBySeverity.serious, 30);
      assert.equal(state.pointsBySeverity.minor, 100);
      await api.recordGrowthEvent(actor, deed("event:c", "cruelty", "serious"));
      assert.equal(api.getHorrorRank(actor).stage, 1, "30 points over a 20-point stage");
    }, { settings: { horrorPointsMinor: 1000, horrorPointsSerious: 30, horrorRankThreshold: 5 } });
  });

  test(`[${systemId}] suppression and restores are GM-only`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId);
      await seed(api, actor, systemId);
      globalThis.game.user.isGM = false;
      await assert.rejects(api.confirmHorrorSuppression(actor));
      await assert.rejects(api.restoreHorrorSuppression(actor, { force: true }));
      await assert.rejects(api.restoreDockedLevels(actor));
    });
  });
}

// --- extraction ---------------------------------------------------------------------------------------

test("atonement is a required schema field right after darkSeverity; the prompt explains it with look-alikes", () => {
  const keys = Object.keys(EVENT_ITEM_SCHEMA.properties);
  assert.equal(keys.indexOf("atonement"), keys.indexOf("darkSeverity") + 1);
  assert.deepEqual(EVENT_ITEM_SCHEMA.properties.atonement.enum, ["none", "minor", "serious", "profound"]);
  assert.ok(EVENT_ITEM_SCHEMA.required.includes("atonement"));
  const [system] = buildExtractionMessages({ notesChunk: "x", request: {}, config: { outputLanguage: "en" } });
  assert.match(system.content, /- atonement: "none" for almost every event/);
  assert.match(system.content, /"atonement":"serious"/, "one few-shot shows real amends");
  assert.match(system.content, /loaded dice","actorName":"Ivo"[^}]*"atonement":"none"/, "an apology for something petty is none");
});

test("coerceAtonement / coerceEvent: synonyms, unknown -> none, always present", () => {
  assert.equal(coerceAtonement("Profound").atonement, "profound");
  assert.equal(coerceAtonement("major").atonement, "serious");
  assert.equal(coerceAtonement("small").atonement, "minor");
  assert.equal(coerceAtonement("bananas").atonement, "none");
  assert.equal(coerceAtonement(true).atonement, "minor");
  assert.equal(coerceAtonement(undefined).atonement, "none");
  assert.equal(coerceEvent({ summary: "Wren freed the slaves she sold", tags: ["diplomacy"], atonement: "serious" }).event.atonement, "serious");
  assert.equal(coerceEvent({ summary: "Mira healed Kesh", tags: ["medicine"] }).event.atonement, "none");
  // The amends event names the past deed it repairs; that deed is not counted again (at-001).
  const paid = coerceEvent({ summary: "Tovin paid the blood-price for killing a surrendered scout", tags: ["diplomacy"], atonement: "serious", darkDeed: "cruelty", darkSeverity: "serious" });
  assert.deepEqual([paid.event.darkDeed, paid.event.darkSeverity, paid.event.atonement], ["none", "none", "serious"]);
  assert.ok(paid.coercions.includes("darkDeed:cruelty->none(atonement-event)"));
  const deedOnly = coerceEvent({ summary: "Tovin killed the surrendered guard", tags: ["martial"], darkDeed: "cruelty", darkSeverity: "serious" });
  assert.equal(deedOnly.event.darkDeed, "cruelty", "a deed without amends is untouched");
});

test("a folded follow-up keeps the greater atonement", () => {
  const { events } = mergeFollowUpEvents([
    { summary: "Wren went back to Millbrook.", tags: ["diplomacy"], themes: [], outcome: "success", actorName: "Wren", darkDeed: "none", darkSeverity: "none", atonement: "none" },
    { summary: "She paid the families back in full.", tags: [], themes: [], outcome: "success", actorName: "Wren", darkDeed: "none", darkSeverity: "none", atonement: "serious", continuesPrevious: true }
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].atonement, "serious");
});

test("normalizeGrowthEvent keeps atonement (validated) only when the reader supplied it", () => {
  const base = { summary: "x", tags: ["martial"], outcome: "success" };
  assert.equal(normalizeGrowthEvent({ ...base, atonement: "profound" }, 1).atonement, "profound");
  assert.equal(normalizeGrowthEvent({ ...base, atonement: "lots" }, 1).atonement, "none");
  assert.equal("atonement" in normalizeGrowthEvent(base, 1), false, "the local fallback analyzer's events carry none");
});

test("harness: scoreAtonement accuracy on gold-atonement items, false positives on gold 'none'", () => {
  const gold = { id: "x", category: "atonement", gold: { atonement: "serious|profound" } };
  assert.deepEqual(goldAtonement(gold), ["serious", "profound"]);
  assert.equal(scoreAtonement(gold, [{ atonement: "serious" }]).atonementOk, true);
  assert.equal(scoreAtonement(gold, [{ atonement: "minor" }]).atonementOk, false);
  assert.equal(scoreAtonement(gold, [{ atonement: "minor" }]).atonementDetectOk, true);
  const trap = { id: "t", category: "traps", gold: {} };
  assert.equal(scoreAtonement(trap, [{ atonement: "none" }]).atonementFalse, false);
  assert.equal(scoreAtonement(trap, [{ atonement: "minor" }]).atonementFalse, true);
  assert.equal(scoreAtonement({ id: "u", category: "party", gold: {} }, [{ atonement: "minor" }]).atonementMeasured, false, "unlabelled");
  assert.equal(scoreAtonement(trap, [{ summary: "no field" }]).atonementMeasured, false, "a run from before the field is not measured");
});

// --- UI -----------------------------------------------------------------------------------------------

test("renderHorrorRankControls: default preselected, GM-only buttons, restore owed, docks, lock-out", () => {
  const state = {
    points: 120, stage: 1, totalLevelsDocked: 2, deeds: [],
    atonements: [{ eventId: "a", summary: "Wren freed the slaves", level: "serious", points: 15 }],
    docks: [{ id: "d1", crossing: 1, classId: "class:warrior", className: "Warrior", levelsDocked: 2, fromLevel: 12, toLevel: 10 }],
    suppression: { due: 1, held: 0, suppressed: [], candidates: [{ itemId: "i1", name: "Power Attack", level: 1, combat: 7, reasons: ["rule elements"] }, { itemId: "i2", name: "Medic Dedication", level: 2, combat: 0, reasons: [] }], defaultCandidateId: "i1", restoreDefaultId: null }
  };
  const view = normalizeHorrorRankView(state);
  const gm = renderHorrorRankControls(view, { canManage: true });
  assert.match(gm, /<option value="i1" selected>Power Attack/);
  assert.match(gm, /data-action="gd-horror-suppress"/);
  assert.match(gm, /data-action="gd-horror-waive"/);
  assert.match(gm, /data-action="gd-horror-restore-levels"/);
  assert.match(gm, /Warrior: -2 levels \(Lv 12 &rarr; 10\)/);
  const player = renderHorrorRankControls(view, { canManage: false });
  assert.doesNotMatch(player, /data-action=/, "no buttons for a player");
  assert.match(renderHorrorRankMeter(state, { canManage: true }), /The amends that lowered it \(1\)/);

  const owed = normalizeHorrorRankView({ points: 20, stage: 0, suppression: { due: -1, held: 1, suppressed: [{ stage: 1, itemId: "i1", itemName: "Power Attack", present: true }], candidates: [], restoreDefaultId: "i1" } });
  const html = renderHorrorRankControls(owed, { canManage: true });
  assert.match(html, /Restore \(most recent\)/);
  assert.match(html, /data-item-id="i1"/);
  assert.match(html, /data-force=""/);
  assert.match(renderHorrorRankMeter({ points: 0, stage: 0, suppression: owed.suppression }, { canManage: true }), /gd-horror-suppressed/, "a feature owed back shows even at 0 points");
  assert.equal(renderAtonementBadge({ atonement: "none" }), "");
  assert.match(renderAtonementBadge({ atonement: "profound" }), /atonement, profound/);
});

test("prepareHorrorAction reads the picked feature and confirms the level restore first", async () => {
  const seen = [];
  const api = {
    confirmHorrorSuppression: async (_actor, options) => (seen.push(["suppress", options]), { record: { stage: 1, itemName: "Medic Dedication" } }),
    restoreDockedLevels: async () => (seen.push(["levels"]), { restored: [{ id: "d1" }], levelsRestored: 2 }),
    getHorrorRank: () => ({ docks: [{ id: "d1", classId: "class:warrior", className: "Warrior", levelsDocked: 2 }] })
  };
  const root = { querySelector: (selector) => (selector.includes("gd-horror-feature") ? { value: "i2" } : null) };
  const work = await prepareHorrorAction(api, { name: "Tovin" }, "suppress", root, null);
  assert.match((await work()).message, /Medic Dedication is suppressed/);
  assert.deepEqual(seen[0], ["suppress", { itemId: "i2" }]);
  assert.equal(await prepareHorrorAction(api, { name: "Tovin" }, "restoreLevels", root, null, { confirm: async () => false }), null, "a declined confirmation runs nothing");
  const levels = await prepareHorrorAction(api, { name: "Tovin" }, "restoreLevels", root, null, { confirm: async (_t, html) => /Warrior: \+2/.test(html) });
  assert.match((await levels()).message, /2 docked levels restored/);
});

test("describeHorrorRankChange: a stage gained asks to confirm a suppression; a stage lost offers a restore; Stage 3 locks out", () => {
  const rose = describeHorrorRankChange({ actorName: "Tovin", previousStage: 2, state: { points: 310, stage: 3, suppression: { due: 1, held: 2, candidates: [{ itemId: "i1", name: "Power Attack" }], defaultCandidateId: "i1" } } });
  assert.ok(rose.some((notice) => /confirm Power Attack \(the default\)/.test(notice.message)));
  assert.ok(rose.some((notice) => /locked out of its role/.test(notice.message)));
  const fell = describeHorrorRankChange({ actorName: "Tovin", previousStage: 1, state: { points: 80, stage: 0, suppression: { due: -1, held: 1 } } });
  assert.ok(fell.some((notice) => /restore a suppressed feature/.test(notice.message)));
});
