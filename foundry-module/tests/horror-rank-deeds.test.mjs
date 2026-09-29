// Board 21e944ed (owner decision 2026-09-29): Horror Rank accrues from the red DEEDS the notes record
// (events' darkDeed/darkSeverity), not from approvals. Rejecting a red Skill refuses the power, not the
// stain. Covers the pure derivation (horror-rank.js), event normalization (progression.js) and the api
// wiring on both systems: record / re-analyze / removal recompute, only NEW docks applied, legacy
// baseline, hook payloads, docked Class Item level, markSuperseded feature detection, and
// mechanics.structured passing through approval untouched.
import assert from "node:assert/strict";
import test from "node:test";

import { GrandDesignApi } from "../scripts/api.js";
import {
  GROWTH_EVENTS_FLAG,
  GROWTH_PROPOSALS_FLAG,
  HORROR_RANK_FLAG,
  HORROR_RANK_LEVEL_PENALTY,
  HORROR_RANK_POINTS_BY_SEVERITY,
  HORROR_RANK_THRESHOLD,
  LEVEL_PROGRESSION_FLAG,
  MODULE_ID,
  REGISTRY_FLAG
} from "../scripts/constants.js";
import {
  computeHorrorRank,
  horrorPointsForDeed,
  horrorStageFor,
  migrateHorrorRankState,
  normalizeDarkDeed
} from "../scripts/horror-rank.js";
import { normalizeGrowthEvent } from "../scripts/progression.js";
import { getSystemAdapter } from "../scripts/systems/index.js";

const SYSTEMS = ["pf2e", "dnd5e"];

// --- pure ------------------------------------------------------------------------------------------

test("horrorPointsForDeed: minor 5, serious 15, monstrous 40; needs both a vice and a severity", () => {
  assert.deepEqual(HORROR_RANK_POINTS_BY_SEVERITY, { none: 0, minor: 5, serious: 15, monstrous: 40 });
  assert.equal(horrorPointsForDeed({ darkDeed: "cruelty", darkSeverity: "minor" }), 5);
  assert.equal(horrorPointsForDeed({ darkDeed: "cruelty", darkSeverity: "serious" }), 15);
  assert.equal(horrorPointsForDeed({ darkDeed: "desecration", darkSeverity: "monstrous" }), 40);
  assert.equal(horrorPointsForDeed({ darkDeed: " Cruelty ", darkSeverity: "SERIOUS" }), 15, "case and spaces tolerated");
  assert.equal(horrorPointsForDeed({ darkDeed: "none", darkSeverity: "serious" }), 0, "a severity with no vice names no taboo");
  assert.equal(horrorPointsForDeed({ darkDeed: "cruelty", darkSeverity: "none" }), 0, "too petty to stain");
  assert.equal(horrorPointsForDeed({ darkDeed: "cheating", darkSeverity: "serious" }), 0, "not a taxonomy vice");
  assert.equal(horrorPointsForDeed({ summary: "fallback analyzer event" }), 0, "events without the fields are 'none'");
  assert.equal(horrorPointsForDeed(null), 0);
});

test("normalizeDarkDeed validates each field on its own", () => {
  assert.deepEqual(normalizeDarkDeed({ darkDeed: "bloodlust", darkSeverity: "bogus" }), { darkDeed: "bloodlust", darkSeverity: "none" });
  assert.deepEqual(normalizeDarkDeed({}), { darkDeed: "none", darkSeverity: "none" });
});

test("computeHorrorRank sums deeds, derives stage/nextThreshold, and counts only NEW crossings", () => {
  const events = [
    { id: "e1", summary: "Killed a surrendering goblin.", darkDeed: "cruelty", darkSeverity: "serious" },
    { id: "e2", summary: "Held the bridge.", tags: ["martial"] },
    { id: "e3", summary: "Ate the prisoner.", darkDeed: "desecration", darkSeverity: "monstrous" },
    { id: "e3", summary: "Ate the prisoner (duplicate id).", darkDeed: "desecration", darkSeverity: "monstrous" }
  ];
  const result = computeHorrorRank(events);
  assert.equal(result.points, 55, "15 + 40; a repeated id counts once");
  assert.equal(result.deedPoints, 55);
  assert.equal(result.stage, 0);
  assert.equal(result.nextThreshold, HORROR_RANK_THRESHOLD);
  assert.equal(result.crossings, 0);
  assert.equal(result.newDocks, 0);
  assert.deepEqual(result.deeds, [
    { eventId: "e1", summary: "Killed a surrendering goblin.", vice: "cruelty", severity: "serious", points: 15 },
    { eventId: "e3", summary: "Ate the prisoner.", vice: "desecration", severity: "monstrous", points: 40 }
  ]);

  const many = Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, summary: `Monstrous ${i}`, darkDeed: "ruin", darkSeverity: "monstrous" }));
  const heavy = computeHorrorRank(many, { docked: 1, legacyPoints: 10 });
  assert.equal(heavy.points, 250);
  assert.equal(heavy.stage, 2);
  assert.equal(heavy.crossings, 2);
  assert.equal(heavy.newDocks, 1, "one crossing was already docked");
  assert.equal(heavy.nextThreshold, 300);
  assert.equal(computeHorrorRank(many, { docked: 5 }).newDocks, 0, "fewer crossings than docked never refunds (negative) anything");
  assert.equal(horrorStageFor(10_000), 3, "the stage is capped at 3");
  assert.equal(computeHorrorRank(Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, summary: "x", darkDeed: "ruin", darkSeverity: "monstrous" }))).crossings, 4, "crossings keep counting past stage 3");
});

test("migrateHorrorRankState keeps approval-era points as a legacy baseline (never zeroed)", () => {
  assert.deepEqual(migrateHorrorRankState(undefined), { version: 2, legacyPoints: 0, thresholdsDocked: 0, totalLevelsDocked: 0, points: 0, stage: 0 });
  assert.deepEqual(migrateHorrorRankState({ points: 50, totalLevelsDocked: 0 }), { version: 2, legacyPoints: 50, thresholdsDocked: 0, totalLevelsDocked: 0, points: 50, stage: 0 });
  // Old model: 5 approvals = 125 -> one crossing docked 2 levels, 25 left over.
  const migrated = migrateHorrorRankState({ points: 25, totalLevelsDocked: HORROR_RANK_LEVEL_PENALTY });
  assert.equal(migrated.legacyPoints, 125);
  assert.equal(migrated.thresholdsDocked, 1);
  assert.equal(migrated.stage, 1);
  assert.equal(computeHorrorRank([], { docked: migrated.thresholdsDocked, legacyPoints: migrated.legacyPoints }).newDocks, 0, "migration never re-docks the past");
  const v2 = { version: 2, legacyPoints: 30, thresholdsDocked: 2, totalLevelsDocked: 4, points: 230, stage: 2 };
  assert.deepEqual(migrateHorrorRankState(v2), v2);
});

test("normalizeGrowthEvent keeps darkDeed/darkSeverity (validated) and omits them when never supplied", () => {
  const kept = normalizeGrowthEvent({ summary: "Tovin killed a goblin that was surrendering.", tags: ["martial"], outcome: "success", darkDeed: "cruelty", darkSeverity: "serious" }, 1);
  assert.equal(kept.darkDeed, "cruelty");
  assert.equal(kept.darkSeverity, "serious");
  const cleaned = normalizeGrowthEvent({ summary: "x", tags: ["martial"], outcome: "success", darkDeed: "made-up", darkSeverity: "catastrophic" }, 1);
  assert.deepEqual([cleaned.darkDeed, cleaned.darkSeverity], ["none", "none"]);
  const local = normalizeGrowthEvent({ summary: "x", tags: ["martial"], outcome: "success" }, 1);
  assert.equal("darkDeed" in local, false);
  assert.equal(horrorPointsForDeed(local), 0);
});

// --- api -------------------------------------------------------------------------------------------

function setPath(target, path, value) {
  const keys = path.split(".");
  let node = target;
  for (const key of keys.slice(0, -1)) {
    node[key] ??= {};
    node = node[key];
  }
  node[keys.at(-1)] = value;
}

function createMockActor(systemId, { name = "Tovin" } = {}) {
  const flags = { [MODULE_ID]: {} };
  const items = [];
  let counter = 0;
  const makeItem = (source) => {
    counter += 1;
    const item = {
      id: `item-${counter}`,
      name: source.name,
      type: source.type,
      system: structuredClone(source.system ?? {}),
      flags: structuredClone(source.flags ?? {}),
      updates: [],
      getFlag(module, key) {
        return this.flags?.[module]?.[key];
      },
      async update(changes) {
        this.updates.push(changes);
        for (const [path, value] of Object.entries(changes)) {
          if (path === "name") this.name = value;
          else if (path.startsWith(`flags.${MODULE_ID}.`)) {
            this.flags[MODULE_ID] ??= {};
            this.flags[MODULE_ID][path.slice(`flags.${MODULE_ID}.`.length)] = value;
          } else setPath(this, path, value);
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

const MECH = (effect) => ({ effect, duration: "ongoing", frequency: { max: 1, per: "day" } });

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

function classEntry(name, level, extra = {}) {
  return {
    name,
    level,
    power_tier: "standard",
    system_chassis: "Fighter",
    gameItem: { kind: "passive" },
    mechanics: MECH(`${name} benefit.`),
    metadata: { tags: ["martial"], lineage: { operation: "origin", sources: [], rationale: "test" } },
    ...extra
  };
}

async function seed(api, actor, { horrorFlag } = {}) {
  await api.applyToActor(actor, { character: actor.name, classes: [classEntry("Warrior", 12, { is_primary: true })], skills: [] });
  await actor.update({
    [`flags.${MODULE_ID}.${GROWTH_EVENTS_FLAG}`]: [],
    [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: [],
    [`flags.${MODULE_ID}.${LEVEL_PROGRESSION_FLAG}`]: { level: 5, progress: 0, grantAllowances: 0, capstoneAllowances: 0, lastRestAt: null, lastRestType: null },
    ...(horrorFlag ? { [`flags.${MODULE_ID}.${HORROR_RANK_FLAG}`]: horrorFlag } : {})
  });
}

const deed = (id, summary, darkDeed, darkSeverity) => ({ id, summary, tags: ["martial"], outcome: "success", actorName: "Tovin", darkDeed, darkSeverity });
const hooksNamed = (calls, name) => calls.filter((call) => call.name === name);

for (const systemId of SYSTEMS) {
  test(`[${systemId}] analysis records deeds -> points; re-analysis is idempotent; a crossing docks once with both hooks`, async () => {
    await withFoundry(systemId, async (calls) => {
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId);
      await seed(api, actor);
      // 3 monstrous deeds = 120 -> one crossing.
      api.setProposalAdapter(async () => ({
        events: [
          deed("event:a", "Tovin ate the captured scout.", "desecration", "monstrous"),
          deed("event:b", "Tovin flayed the bandit for fun.", "cruelty", "monstrous"),
          deed("event:c", "Tovin burned the shrine with the priests inside.", "ruin", "monstrous"),
          { id: "event:d", summary: "Tovin held the ford.", tags: ["martial"], outcome: "success", actorName: "Tovin", darkDeed: "none", darkSeverity: "none" }
        ]
      }));
      const analysis = await api.analyzeSessionNotes(actor, "Tovin did terrible things.");
      assert.equal(analysis.horrorRank.points, 120);
      assert.equal(analysis.horrorRank.stage, 1);
      assert.equal(analysis.horrorRank.nextThreshold, 200);
      assert.equal(analysis.horrorRank.deeds.length, 3);
      assert.deepEqual(Object.keys(analysis.horrorRank.deeds[0]).sort(), ["eventId", "points", "severity", "summary", "vice"]);
      assert.deepEqual(analysis.horrorRankDocked, [{ classId: "class:warrior", levelsDocked: HORROR_RANK_LEVEL_PENALTY, fromLevel: 12, toLevel: 12 - HORROR_RANK_LEVEL_PENALTY }]);
      assert.equal(api.getActorRegistry(actor).classes["class:warrior"].level, 10);

      const changed = hooksNamed(calls, "grand-design-ai.horrorRankChanged");
      assert.equal(changed.length, 1, "one horrorRankChanged per analysis, not per event");
      const [hookActor, state, dockedFrom] = changed[0].args;
      assert.equal(hookActor, actor);
      for (const key of ["points", "stage", "nextThreshold", "totalLevelsDocked", "deeds"]) assert.ok(key in state, `state.${key}`);
      assert.equal(state.totalLevelsDocked, HORROR_RANK_LEVEL_PENALTY);
      assert.equal(dockedFrom[0].classId, "class:warrior");
      const docked = hooksNamed(calls, "grand-design-ai.horrorRankLevelsDocked");
      assert.equal(docked.length, 1);
      assert.deepEqual(docked[0].args[1], dockedFrom);

      // Docking updates the Class Item: PF2e shows the level in system.level.value; both get the flag.
      const item = actor.items.find((candidate) => candidate.getFlag(MODULE_ID, "registryId") === "class:warrior");
      assert.equal(item.getFlag(MODULE_ID, "level"), 10);
      if (systemId === "pf2e") assert.equal(item.system.level.value, 10);
      else assert.equal(item.system.level, undefined, "a dnd5e feat carries no level field to rewrite");

      // Re-analysis of the same notes: same deeds, same points, no second dock, no news.
      calls.length = 0;
      const again = await api.reanalyzeLastNotes(actor);
      assert.equal(again.horrorRank.points, 120);
      assert.equal(again.horrorRankDocked, undefined);
      assert.equal(api.getGrowth(actor).events.length, 4, "the old reading was replaced, not added to");
      assert.equal(api.getActorRegistry(actor).classes["class:warrior"].level, 10, "never docked twice");
      assert.equal(api.getHorrorRank(actor).totalLevelsDocked, HORROR_RANK_LEVEL_PENALTY);
      assert.equal(hooksNamed(calls, "grand-design-ai.horrorRankLevelsDocked").length, 0);
      assert.equal(hooksNamed(calls, "grand-design-ai.horrorRankChanged").length, 0, "nothing changed");
    });
  });

  test(`[${systemId}] removing a deed lowers the points but never refunds docked levels; re-adding never re-docks`, async () => {
    await withFoundry(systemId, async (calls) => {
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId);
      await seed(api, actor);
      for (const [i, vice] of ["desecration", "cruelty", "ruin"].entries()) {
        await api.recordGrowthEvent(actor, deed(`event:${i}`, `Deed ${i}`, vice, "monstrous"));
      }
      assert.equal(api.getHorrorRank(actor).points, 120);
      assert.equal(api.getActorRegistry(actor).classes["class:warrior"].level, 10);
      assert.equal(hooksNamed(calls, "grand-design-ai.horrorRankChanged").length, 3, "one per recorded deed");

      calls.length = 0;
      await api._removeRecordedEvents(actor, ["event:2"]);
      const lowered = api.getHorrorRank(actor);
      assert.equal(lowered.points, 80);
      assert.equal(lowered.stage, 0);
      assert.equal(lowered.totalLevelsDocked, HORROR_RANK_LEVEL_PENALTY, "no refund");
      assert.equal(api.getActorRegistry(actor).classes["class:warrior"].level, 10, "the Class keeps its docked level");
      const [, state, dockedFrom] = hooksNamed(calls, "grand-design-ai.horrorRankChanged")[0].args;
      assert.equal(state.points, 80);
      assert.deepEqual(dockedFrom, []);

      await api.recordGrowthEvent(actor, deed("event:2b", "Deed again", "ruin", "monstrous"));
      assert.equal(api.getHorrorRank(actor).points, 120);
      assert.equal(api.getActorRegistry(actor).classes["class:warrior"].level, 10, "crossing 1 was already docked");
      await api.recordGrowthEvent(actor, deed("event:3", "One more", "cruelty", "monstrous"));
      await api.recordGrowthEvent(actor, deed("event:4", "And another", "cruelty", "serious"));
      assert.equal(api.getHorrorRank(actor).points, 175);
      await api.recordGrowthEvent(actor, deed("event:5", "The second crossing", "bloodlust", "monstrous"));
      assert.equal(api.getHorrorRank(actor).points, 215);
      assert.equal(api.getActorRegistry(actor).classes["class:warrior"].level, 8, "crossing 2 docks");
      assert.equal(api.getHorrorRank(actor).totalLevelsDocked, 2 * HORROR_RANK_LEVEL_PENALTY);
    });
  });

  test(`[${systemId}] approving a red Skill adds no Horror Rank; the local fallback analyzer's events are 'none'`, async () => {
    await withFoundry(systemId, async (calls) => {
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId);
      await seed(api, actor);
      await api._approveEvolution(actor, "skill", skillEntry("Cruel Edge", ["martial"], {
        metadata: { tags: ["martial"], polarity: "red", malignance: { vice: "cruelty", drawback: "You cannot spare a foe who begs." }, lineage: { operation: "origin", sources: [], rationale: "test" } }
      }), "origin");
      assert.equal(api.getHorrorRank(actor).points, 0);
      assert.equal(hooksNamed(calls, "grand-design-ai.horrorRankChanged").length, 0);

      const local = await api.analyzeSessionNotes(actor, "Tovin killed a goblin that was surrendering, then searched the body.");
      assert.equal(local.source, "local");
      assert.equal(local.horrorRank.points, 0);
      assert.deepEqual(local.horrorRank.deeds, []);
    });
  });

  test(`[${systemId}] a pre-2026-09-29 world keeps its approval points as a legacy baseline`, async () => {
    await withFoundry(systemId, async (calls) => {
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId);
      await seed(api, actor, { horrorFlag: { points: 90, totalLevelsDocked: 0 } });
      assert.equal(api.getHorrorRank(actor).points, 90, "read before any migration write");
      assert.equal(api.getHorrorRank(actor).legacyPoints, 90);

      // Explicit recompute migrates silently: same numbers, new shape, no hook.
      const migrated = await api.recomputeHorrorRank(actor);
      assert.equal(migrated.changed, true);
      assert.equal(actor.getFlag(MODULE_ID, HORROR_RANK_FLAG).version, 2);
      assert.equal(hooksNamed(calls, "grand-design-ai.horrorRankChanged").length, 0);

      await api.recordGrowthEvent(actor, deed("event:x", "Tovin killed a goblin that was surrendering.", "cruelty", "serious"));
      const state = api.getHorrorRank(actor);
      assert.equal(state.points, 105);
      assert.equal(state.deedPoints, 15);
      assert.equal(state.legacyPoints, 90);
      assert.equal(api.getActorRegistry(actor).classes["class:warrior"].level, 10, "the legacy remainder plus the deed crosses exactly where the old meter would");
    });
  });

  test(`[${systemId}] superseding calls the system adapter's markSuperseded(item) when present, and still works without it`, async () => {
    await withFoundry(systemId, async () => {
      const adapter = getSystemAdapter(systemId);
      const original = adapter.markSuperseded;
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId);
      await seed(api, actor);
      await api._approveEvolution(actor, "skill", skillEntry("Power Strike", ["martial"]), "origin");
      await api._approveEvolution(actor, "skill", skillEntry("Iron Strike", ["martial"]), "origin");
      await api._approveEvolution(actor, "skill", skillEntry("Old Strike", ["martial"]), "origin");
      try {
        const seen = [];
        adapter.markSuperseded = (item, info) => {
          seen.push({ item, info });
          return { "system.superseded": true, [`flags.${MODULE_ID}.mechanicsOff`]: true };
        };
        await api._supersedeSources(actor, "skill", ["skill:power-strike"], "skill:iron-strike");
        assert.equal(seen.length, 1);
        assert.equal(seen[0].item.getFlag(MODULE_ID, "registryId"), "skill:power-strike");
        assert.equal(seen[0].info.byName, "Iron Strike");
        assert.equal(seen[0].item.getFlag(MODULE_ID, "superseded").byName, "Iron Strike", "the Item already knows what replaced it");
        assert.equal(seen[0].item.system.superseded, true, "the adapter's update is applied");
        assert.equal(seen[0].item.getFlag(MODULE_ID, "mechanicsOff"), true);

        delete adapter.markSuperseded;
        await api._supersedeSources(actor, "skill", ["skill:old-strike"], "skill:iron-strike");
        const old = actor.items.find((candidate) => candidate.getFlag(MODULE_ID, "registryId") === "skill:old-strike");
        assert.match(old.name, /\(superseded\)$/);
      } finally {
        if (original) adapter.markSuperseded = original;
        else delete adapter.markSuperseded;
      }
    });
  });

  test(`[${systemId}] approval passes entry.mechanics.structured to the system item builder untouched`, async () => {
    await withFoundry(systemId, async () => {
      const adapter = getSystemAdapter(systemId);
      const original = adapter.buildItemSource;
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId);
      await seed(api, actor);
      const structured = {
        damage: [{ dice: "2d6", type: "fire", bonus: 1 }],
        save: { save: systemId === "pf2e" ? "reflex" : "dex", dc: "class", basic: true },
        modifiers: [{ value: 1, type: "circumstance", selector: "ac", predicate: "self:shield-raised" }],
        uses: { max: 1, per: "day" }
      };
      const snapshot = structuredClone(structured);
      const seen = [];
      try {
        adapter.buildItemSource = (kind, entry) => {
          seen.push(entry.mechanics.structured);
          return original(kind, entry);
        };
        const entry = skillEntry("Flame Lash", ["martial"]);
        entry.mechanics.structured = structured;
        await api._approveEvolution(actor, "skill", entry, "origin");
      } finally {
        adapter.buildItemSource = original;
      }
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0], snapshot);
      assert.deepEqual(api.getActorRegistry(actor).skills["skill:flame-lash"].mechanics.structured, snapshot);
    });
  });
}
