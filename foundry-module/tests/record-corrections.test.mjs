import assert from "node:assert/strict";
import test from "node:test";

import { GrandDesignApi, titleEntryFromProposal } from "../scripts/api.js";
import {
  COMBINATIONS_FLAG,
  CONSOLIDATIONS_FLAG,
  GROWTH_EVENTS_FLAG,
  GROWTH_PROPOSALS_FLAG,
  LEVEL_PROGRESSION_FLAG,
  MODULE_ID,
  REGISTRY_FLAG
} from "../scripts/constants.js";
import { normalizeGrowthEvent, progressionForEvent } from "../scripts/progression.js";
import {
  describeDeleteResult,
  describeReassignResult,
  describeRevertResult,
  renderApprovedList,
  renderDeleteEventConfirm,
  renderEventControls,
  renderEventLine,
  renderGrowthContent,
  renderMovePicker,
  renderRevertConfirm
} from "../scripts/growth-ui.js";

// dev-integration, board 4344c58a: the GM can delete or move a recorded event and revert an approval.
// Every API scenario runs on both systems. The mock actor applies update paths the way Foundry does
// for these calls (nested dot paths, "-=" deletion keys), because revertApproval edits the registry
// by path: Foundry deep-merges an object flag, so a whole-registry write could never remove an entry.

const SYSTEMS = ["pf2e", "dnd5e"];

function applyPath(root, path, value) {
  const parts = path.split(".");
  let node = root;
  for (const part of parts.slice(0, -1)) {
    if (!node[part] || typeof node[part] !== "object") node[part] = {};
    node = node[part];
  }
  const last = parts.at(-1);
  if (last.startsWith("-=")) delete node[last.slice(2)];
  else node[last] = value === null || typeof value !== "object" ? value : structuredClone(value);
}

let actorCounter = 0;
function createMockActor(systemId, { name = "Maren" } = {}) {
  actorCounter += 1;
  const data = { flags: { [MODULE_ID]: {} } };
  const items = [];
  let counter = 0;
  const makeItem = (source) => {
    counter += 1;
    const item = {
      id: `item-${actorCounter}-${counter}`,
      name: source.name,
      type: source.type,
      system: structuredClone(source.system ?? {}),
      flags: structuredClone(source.flags ?? {}),
      ...(source.effects ? { effects: structuredClone(source.effects) } : {}),
      updates: [],
      getFlag(module, key) {
        return this.flags?.[module]?.[key];
      },
      async update(changes) {
        this.updates.push(changes);
        for (const [path, value] of Object.entries(changes)) applyPath(this, path, value);
        return this;
      },
      async createActivity(type, activityData) {
        this.system.activities ??= {};
        const id = `act${Object.keys(this.system.activities).length + 1}`;
        this.system.activities[id] = { _id: id, type, ...structuredClone(activityData ?? {}) };
        return this.system.activities[id];
      }
    };
    items.push(item);
    return item;
  };
  return {
    id: `actor-${systemId}-${name}-${actorCounter}`,
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
      return data.flags[module]?.[key];
    },
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) applyPath(data, path, value);
      return this;
    },
    async createEmbeddedDocuments(_type, sources) {
      return sources.map(makeItem);
    },
    async deleteEmbeddedDocuments(_type, ids) {
      for (const id of ids) {
        const index = items.findIndex((item) => item.id === id);
        if (index >= 0) items.splice(index, 1);
      }
      return ids;
    }
  };
}

async function withFoundry(systemId, fn, { isGM = true } = {}) {
  const originalGame = globalThis.game;
  const originalHooks = globalThis.Hooks;
  const calls = [];
  globalThis.game = { user: { isGM }, system: { id: systemId } };
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

const ev = (id, summary, tags, extra = {}) => ({ id, summary, tags, outcome: "success", occurredAt: "2026-09-29T00:00:00.000Z", actorName: "Maren", source: "adapter", ...extra });

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
    system_chassis: "Fighter",
    gameItem: { kind: "passive" },
    mechanics: { effect: `${name} benefit.`, duration: "ongoing", frequency: { max: 1, per: "day" } },
    metadata: { tags, lineage: { operation: "origin", sources: [], rationale: "test" } },
    ...extra
  };
}

async function seed(api, actor, { events = [], proposals = [], progression = {}, classes = [classEntry("Warrior", ["martial"], { is_primary: true })], skills = [skillEntry("Power Strike", ["martial"])] } = {}) {
  await api.applyToActor(actor, { character: actor.name, classes, skills });
  await actor.update({
    [`flags.${MODULE_ID}.${GROWTH_EVENTS_FLAG}`]: events.map((event, index) => normalizeGrowthEvent(event, index + 1)),
    [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: proposals,
    [`flags.${MODULE_ID}.${LEVEL_PROGRESSION_FLAG}`]: { level: 5, progress: 0, grantAllowances: 0, capstoneAllowances: 0, lastRestAt: null, lastRestType: null, ...progression }
  });
}

const pending = (id, entry, extra = {}) => ({ id, kind: "skill", status: "pending", source: "ai-gateway", authoredBy: "ai-gateway", evidence: [], entry, ...extra });
const itemOf = (actor, registryId) => actor.items.find((item) => item.getFlag(MODULE_ID, "registryId") === registryId);

// ---------------------------------------------------------------------------------------------
// deleteRecordedEvent

for (const systemId of SYSTEMS) {
  test(`[${systemId}] deleteRecordedEvent takes back progress, withdraws only-cited proposals, strips evidence, lowers Horror Rank`, async () => {
    await withFoundry(systemId, async (calls) => {
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId);
      const events = [
        ev("event:1", "Maren power-struck the ogre.", ["martial"]),
        ev("event:2", "Maren kicked the surrendering goblin.", ["martial"], { darkDeed: "cruelty", darkSeverity: "serious" }),
        ev("event:3", "Maren climbed the wall.", ["athletics"])
      ];
      await seed(api, actor, {
        events,
        progression: { progress: 90 },
        proposals: [
          pending("proposal:only-2", skillEntry("Goblin Kicker", ["martial"]), { evidence: ["event:2"] }),
          pending("proposal:2-and-3", skillEntry("Wall Runner", ["athletics"]), { evidence: ["event:2", "event:3"] }),
          pending("proposal:edited", skillEntry("Kept Edit", ["martial"]), { evidence: ["event:2"], editedAt: "2026-09-29" })
        ]
      });
      await api.recomputeHorrorRank(actor);
      assert.equal(api.getHorrorRank(actor).points, 15);

      const worth = progressionForEvent(normalizeGrowthEvent(events[1], 2));
      const result = await api.deleteRecordedEvent(actor, "event:2");
      assert.equal(result.event.id, "event:2");
      assert.equal(result.lostProgress, worth);
      assert.deepEqual(result.progress, { before: 90, after: 90 - worth });
      assert.deepEqual(result.withdrawnProposals, ["proposal:only-2"]);
      assert.equal(result.horrorRank.points, 0);

      const growth = api.getGrowth(actor);
      assert.deepEqual(growth.events.map((event) => event.id), ["event:1", "event:3"]);
      assert.equal(api.getLevelProgression(actor).progress, 90 - worth);
      assert.deepEqual(growth.proposals.map((proposal) => proposal.id), ["proposal:2-and-3", "proposal:edited"]);
      assert.deepEqual(growth.proposals[0].evidence, ["event:3"], "the evidence count no longer includes the deleted event");
      assert.equal(api.getHorrorRank(actor).points, 0);
      assert.ok(calls.some((call) => call.name === "grand-design-ai.growthEventDeleted"));

      await assert.rejects(api.deleteRecordedEvent(actor, "event:2"), /No recorded event event:2/);
    });
  });

  test(`[${systemId}] deleteRecordedEvent never takes progress below zero`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId);
      await seed(api, actor, { events: [ev("event:1", "x", ["martial"])], progression: { progress: 3, level: 2 } });
      const result = await api.deleteRecordedEvent(actor, "event:1");
      assert.equal(result.progress.after, 0);
      assert.equal(api.getLevelProgression(actor).level, 2, "levels already resolved at a rest stay");
    });
  });

  // -------------------------------------------------------------------------------------------
  // reassignRecordedEvent

  test(`[${systemId}] reassignRecordedEvent moves credit, progress and Horror Rank; the Jev block survives`, async () => {
    await withFoundry(systemId, async (calls) => {
      const api = new GrandDesignApi();
      const maren = createMockActor(systemId, { name: "Maren" });
      const tovin = createMockActor(systemId, { name: "Tovin" });
      const jev = { actorName: "Tovin", actorConfidence: 0.91, flags: ["actor-disputed"], outcome: "success" };
      const deed = ev("event:7", "Killed a goblin that was surrendering.", ["martial"], {
        darkDeed: "cruelty", darkSeverity: "serious", quote: "T. offs the goblin", jev, dangerGap: "moderate"
      });
      await seed(api, maren, {
        events: [ev("event:1", "Maren parried.", ["martial"]), deed],
        progression: { progress: 100 },
        proposals: [pending("proposal:cruel", skillEntry("Cruel Edge", ["martial"]), { evidence: ["event:7"] })]
      });
      await seed(api, tovin, { events: [ev("event:7", "Tovin's own, same id by chance.", ["stealth"], { actorName: "Tovin" })], progression: { progress: 10 } });
      await api.recomputeHorrorRank(maren);
      assert.equal(api.getHorrorRank(maren).points, 15);
      const worth = progressionForEvent(normalizeGrowthEvent(deed, 2));

      const result = await api.reassignRecordedEvent(maren, "event:7", tovin);
      assert.equal(result.from.name, "Maren");
      assert.equal(result.to.name, "Tovin");
      assert.equal(result.lostProgress, worth);
      assert.equal(result.gainedProgress, worth);
      assert.deepEqual(result.withdrawnProposals, ["proposal:cruel"]);
      assert.equal(result.horrorRank.from.points, 0);
      assert.equal(result.horrorRank.to.points, 15);

      // Source: gone, progress and meter down.
      assert.deepEqual(api.getGrowth(maren).events.map((event) => event.id), ["event:1"]);
      assert.equal(api.getLevelProgression(maren).progress, 100 - worth);
      assert.equal(api.getHorrorRank(maren).points, 0);
      assert.deepEqual(api.getGrowth(maren).proposals, []);

      // Target: the event with its data, a fresh id (the target already had event:7), credited by name.
      const moved = api.getGrowth(tovin).events.find((event) => event.reassigned);
      assert.notEqual(moved.id, "event:7");
      assert.equal(moved.actorName, "Tovin");
      assert.equal(moved.summary, deed.summary);
      assert.equal(moved.quote, deed.quote);
      assert.equal(moved.darkDeed, "cruelty");
      assert.equal(moved.darkSeverity, "serious");
      assert.equal(moved.dangerGap, "moderate");
      assert.deepEqual(moved.jev, jev, "the optional Jev block is carried over intact");
      assert.equal(moved.reassigned.fromActorName, "Maren");
      assert.equal(moved.reassigned.fromActorId, maren.id);
      assert.equal(moved.reassigned.originalActorName, "Maren");
      assert.equal(moved.reassigned.by, "gm");
      assert.equal(api.getLevelProgression(tovin).progress, 10 + worth);
      assert.equal(api.getHorrorRank(tovin).points, 15);
      assert.deepEqual(api._ownEvents(tovin).map((event) => event.id).sort(), ["event:7", moved.id].sort(), "the target now counts it as its own");
      assert.ok(calls.some((call) => call.name === "grand-design-ai.growthEventReassigned"));
    });
  });

  test(`[${systemId}] reassign works without any Jev data and refuses the same actor`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      const maren = createMockActor(systemId, { name: "Maren" });
      const luz = createMockActor(systemId, { name: "Luz" });
      await seed(api, maren, { events: [ev("event:1", "Picked the lock.", ["stealth"], { source: "local" })], progression: { progress: 40 } });
      await seed(api, luz, {});
      await assert.rejects(api.reassignRecordedEvent(maren, "event:1", maren), /already Maren's/);
      const result = await api.reassignRecordedEvent(maren, "event:1", luz);
      assert.equal(result.event.id, "event:1");
      assert.equal(result.event.jev, undefined);
      assert.equal(api.getGrowth(luz).events.length, 1);
      assert.equal(api.getGrowth(maren).events.length, 0);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Locks and GM-only

  test(`[${systemId}] the new calls take the per-actor lock (both actors for a move) and are GM-only`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      const maren = createMockActor(systemId, { name: "Maren" });
      const luz = createMockActor(systemId, { name: "Luz" });
      await seed(api, maren, { events: [ev("event:1", "x", ["martial"])] });
      await seed(api, luz, {});
      let release;
      const hold = api._withActorLock(luz, "analyze", () => new Promise((resolve) => { release = resolve; }));
      await assert.rejects(api.reassignRecordedEvent(maren, "event:1", luz), /^Error: busy: Luz/);
      assert.equal(api.getGrowth(maren).events.length, 1, "nothing moved while the target was busy");
      assert.equal(api.isBusy(maren), false, "the source's lock is released after the refusal");
      release();
      await hold;

      const holdMaren = api._withActorLock(maren, "rest", () => new Promise((resolve) => { release = resolve; }));
      await assert.rejects(api.deleteRecordedEvent(maren, "event:1"), /busy:/);
      await assert.rejects(api.revertApproval(maren, "skill:power-strike"), /busy:/);
      release();
      await holdMaren;
    });
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      const maren = createMockActor(systemId, { name: "Maren" });
      const luz = createMockActor(systemId, { name: "Luz" });
      await assert.rejects(api.deleteRecordedEvent(maren, "event:1"), /Only a GM/);
      await assert.rejects(api.reassignRecordedEvent(maren, "event:1", luz), /Only a GM/);
      await assert.rejects(api.revertApproval(maren, "skill:power-strike"), /Only a GM/);
    }, { isGM: false });
  });

  // -------------------------------------------------------------------------------------------
  // revertApproval

  test(`[${systemId}] revertApproval of a plain Skill removes it and its Item, refunds the grant, proposal back to pending`, async () => {
    await withFoundry(systemId, async (calls) => {
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId);
      await seed(api, actor, { progression: { grantAllowances: 1 }, proposals: [pending("proposal:grip", skillEntry("Iron Grip", ["athletics"]))] });
      await api.approveProposal(actor, "proposal:grip");
      assert.equal(api.getLevelProgression(actor).grantAllowances, 0);
      assert.ok(itemOf(actor, "skill:iron-grip"));
      assert.equal(api.getGrowth(actor).proposals[0].allowanceSpent, "grant");

      const result = await api.revertApproval(actor, "skill:iron-grip");
      assert.equal(result.kind, "skill");
      assert.equal(result.name, "Iron Grip");
      assert.equal(result.refunded, "grant");
      assert.equal(result.proposal.status, "pending");
      assert.equal(result.removedItemIds.length, 1);
      assert.equal(api.getActorRegistry(actor).skills["skill:iron-grip"], undefined);
      assert.ok(api.getActorRegistry(actor).skills["skill:power-strike"], "other entries untouched");
      assert.equal(itemOf(actor, "skill:iron-grip"), undefined);
      assert.equal(api.getLevelProgression(actor).grantAllowances, 1);
      const proposal = api.getGrowth(actor).proposals[0];
      assert.equal(proposal.status, "pending");
      assert.equal(proposal.approvedAt, undefined);
      assert.ok(proposal.revertedAt);
      assert.ok(calls.some((call) => call.name === "grand-design-ai.approvalReverted"));

      // It can be approved again (same allowance), and reverted with reject: true.
      await api.approveProposal(actor, "proposal:grip");
      const rejected = await api.revertApproval(actor, "skill:iron-grip", { reject: true });
      assert.equal(rejected.proposal.status, "rejected");
      assert.equal(api.getLevelProgression(actor).grantAllowances, 1);
      await assert.rejects(api.revertApproval(actor, "skill:iron-grip"), /No approved Class, Skill or Title/);
    });
  });

  test(`[${systemId}] revertApproval of an evolution restores the superseded Skill, its Item and its mechanics`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId);
      await seed(api, actor);
      // Give the source Item live mechanics the supersede switches off.
      const source = itemOf(actor, "skill:power-strike");
      const originalName = source.name;
      if (systemId === "pf2e") {
        source.system.rules = [{ key: "FlatModifier", selector: "athletics", value: 1 }];
        source.system.frequency = { max: 2, per: "day", value: 1 };
      } else {
        source.effects = [{ _id: "eff1", name: "Grip", disabled: false, changes: [] }, { _id: "eff2", name: "Off already", disabled: true, changes: [] }];
        source.system.uses = { max: 2, spent: 1 };
      }
      const originalDescription = source.system.description?.value;
      const evolved = skillEntry("Power Strike Ascendant", ["martial"], {
        tier: 2,
        metadata: { id: "skill:power-strike-ascendant", tags: ["martial"], lineage: { operation: "upgrade", sources: ["skill:power-strike"], rationale: "grew" } }
      });
      await actor.update({ [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: [pending("proposal:evolve", evolved, { source: "skill-evolution", requestedBy: "gm" })] });
      await api.approveProposal(actor, "proposal:evolve");
      assert.equal(api.getActorRegistry(actor).skills["skill:power-strike"].status, "superseded");
      assert.match(source.name, /\(superseded\)$/);
      if (systemId === "pf2e") assert.deepEqual(source.system.rules, []);
      else {
        assert.deepEqual(Object.keys(source.system.activities ?? {}), []);
        assert.equal(source.effects[0].disabled, true);
      }
      // A pending merge/evolution built on the evolved Skill is dropped by the revert.
      const growth = api.getGrowth(actor);
      await actor.update({
        [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: [...growth.proposals, pending("proposal:next", skillEntry("Beyond", ["martial"], { metadata: { tags: ["martial"], lineage: { operation: "upgrade", sources: ["skill:power-strike-ascendant"] } } }), { source: "skill-evolution" })]
      });

      const result = await api.revertApproval(actor, "skill:power-strike-ascendant");
      assert.deepEqual(result.restored, ["skill:power-strike"]);
      assert.equal(result.refunded, null, "a GM-requested evolution spent no allowance");
      assert.deepEqual(result.withdrawnProposals, ["proposal:next"]);
      const registry = api.getActorRegistry(actor);
      assert.equal(registry.skills["skill:power-strike-ascendant"], undefined);
      const restored = registry.skills["skill:power-strike"];
      assert.equal(restored.status, undefined);
      assert.equal(restored.supersededBy, undefined);
      assert.equal(api.getOwnedEntries(actor).skills.find((row) => row.id === "skill:power-strike").status, "active");
      assert.equal(itemOf(actor, "skill:power-strike-ascendant"), undefined, "the evolved Item is deleted");
      assert.equal(source.name, originalName, "the source Item's name is back");
      assert.equal(source.flags[MODULE_ID].superseded, undefined);
      assert.equal(source.system.description?.value, originalDescription, "the 'Superseded by' line is gone");
      if (systemId === "pf2e") {
        assert.deepEqual(source.system.rules, [{ key: "FlatModifier", selector: "athletics", value: 1 }]);
        assert.equal(source.system.frequency.value, 1, "the frequency is back to what it was, not just max");
        assert.equal(source.flags[MODULE_ID].supersededRules, undefined);
      } else {
        assert.ok(Object.keys(source.system.activities).length >= 1, "the activities are back");
        assert.equal(source.flags[MODULE_ID].supersededActivities, undefined);
        assert.deepEqual(source.effects.map((effect) => effect.disabled), [false, true], "effects are as they were");
        assert.equal(source.system.uses.spent, 1);
      }
      assert.equal(api.getGrowth(actor).proposals.find((proposal) => proposal.id === "proposal:evolve").status, "pending");
      // The source can be evolved again (it is active).
      await api.approveProposal(actor, "proposal:evolve");
      assert.equal(api.getActorRegistry(actor).skills["skill:power-strike"].status, "superseded");
    });
  });

  test(`[${systemId}] revertApproval of a Class merge restores both Classes and drops its consolidations`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId);
      await seed(api, actor, { classes: [classEntry("Warrior", ["martial"], { is_primary: true }), classEntry("Guard", ["defense"])], progression: { grantAllowances: 1 } });
      const merged = classEntry("Warden", ["martial", "defense"], {
        metadata: { id: "class:warden", tags: ["martial", "defense"], lineage: { operation: "combine", sources: ["class:warrior", "class:guard"], rationale: "merged" } }
      });
      await actor.update({ [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: [pending("proposal:merge", merged, { kind: "class", source: "class-merge", milestoneLevel: 20 })] });
      await actor.update({ [`flags.${MODULE_ID}.${LEVEL_PROGRESSION_FLAG}`]: { ...api.getLevelProgression(actor), level: 20 } });
      await api.approveProposal(actor, "proposal:merge");
      assert.equal(api.getLevelProgression(actor).grantAllowances, 0, "a milestone merge spends the grant");
      await actor.update({ [`flags.${MODULE_ID}.${CONSOLIDATIONS_FLAG}`]: [{ classIds: ["class:warden", "class:other"], note: "" }] });

      const result = await api.revertApproval(actor, "class:warden");
      assert.deepEqual(result.restored.sort(), ["class:guard", "class:warrior"]);
      assert.equal(result.refunded, "grant");
      assert.equal(result.removedConsolidations, 1);
      const registry = api.getActorRegistry(actor);
      assert.equal(registry.classes["class:warden"], undefined);
      assert.equal(registry.classes["class:warrior"].status, undefined);
      assert.equal(registry.classes["class:guard"].status, undefined);
      assert.doesNotMatch(itemOf(actor, "class:warrior").name, /superseded/);
      assert.equal(api.getLevelProgression(actor).grantAllowances, 1);
      assert.deepEqual(api.getConsolidations(actor), []);
    });
  });

  test(`[${systemId}] revertApproval of a Title removes the Title, the Skill it granted, and its Item`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId);
      await seed(api, actor);
      const { entry } = titleEntryFromProposal({ kind: "title", entry: { name: "Ogre-Breaker", description: "Broke the ogre's jaw at the bridge.", tags: ["martial"] } });
      entry.grants = { skillEntry: skillEntry("Jawbreaker", ["martial"]) };
      await actor.update({ [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: [pending("proposal:title", entry, { kind: "title", source: "ai-gateway" })] });
      await api.approveProposal(actor, "proposal:title");
      const titleId = Object.keys(api.getActorRegistry(actor).titles)[0];
      assert.ok(api.getActorRegistry(actor).skills["skill:jawbreaker"]);
      const before = actor.items.all.length;

      const result = await api.revertApproval(actor, titleId);
      assert.equal(result.kind, "title");
      assert.equal(result.refunded, null, "a Title spends no allowance");
      assert.equal(result.removedItemIds.length, 2);
      assert.equal(actor.items.all.length, before - 2);
      const registry = api.getActorRegistry(actor);
      assert.deepEqual(registry.titles, {});
      assert.equal(registry.skills["skill:jawbreaker"], undefined);
      assert.equal(api.getGrowth(actor).proposals[0].status, "pending");
    });
  });

  test(`[${systemId}] revertApproval refuses what it cannot undo cleanly, writing nothing`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId);
      await seed(api, actor);
      const evolved = skillEntry("Power Strike Ascendant", ["martial"], {
        tier: 2,
        metadata: { id: "skill:power-strike-ascendant", tags: ["martial"], lineage: { operation: "upgrade", sources: ["skill:power-strike"], rationale: "grew" } }
      });
      await actor.update({ [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: [pending("proposal:evolve", evolved, { source: "skill-evolution" })] });
      await api.approveProposal(actor, "proposal:evolve");
      const snapshot = JSON.stringify(api.getActorRegistry(actor));
      const itemCount = actor.items.all.length;

      // A superseded entry: revert what replaced it first.
      await assert.rejects(api.revertApproval(actor, "skill:power-strike"), /replaced by \[Power Strike Ascendant\]; revert \[Power Strike Ascendant\] first/);
      // A live combination uses it.
      await actor.update({ [`flags.${MODULE_ID}.${COMBINATIONS_FLAG}`]: [{ id: "combo:1", name: "Twin Strike", active: true, contributedSkillId: "skill:power-strike-ascendant" }] });
      await assert.rejects(api.revertApproval(actor, "skill:power-strike-ascendant"), /live Combination \[Twin Strike\]/);
      await actor.update({ [`flags.${MODULE_ID}.${COMBINATIONS_FLAG}`]: [] });
      // A source that was replaced by something else cannot be restored.
      const path = `flags.${MODULE_ID}.${REGISTRY_FLAG}.skills.skill:power-strike.supersededBy`;
      await actor.update({ [path]: "skill:someone-else" });
      await assert.rejects(api.revertApproval(actor, "skill:power-strike-ascendant"), /was replaced by .*not by it/);
      await actor.update({ [path]: "skill:power-strike-ascendant" });
      assert.equal(JSON.stringify(api.getActorRegistry(actor)), snapshot, "nothing was written by a refusal");
      assert.equal(actor.items.all.length, itemCount, "no Item was deleted by a refusal");
      await assert.rejects(api.revertApproval(actor, "skill:nope"), /No approved/);
    });
  });
}

// ---------------------------------------------------------------------------------------------
// normalizeGrowthEvent keeps the GM's stamp

test("normalizeGrowthEvent keeps a compact reassigned stamp and drops unknown keys", () => {
  const event = normalizeGrowthEvent({ summary: "x", tags: ["martial"], outcome: "success", reassigned: { fromActorId: "a1", fromActorName: "Maren", originalActorName: "Maren", by: "someone", at: "2026-09-29", junk: 1 } }, 1);
  assert.deepEqual(event.reassigned, { fromActorId: "a1", fromActorName: "Maren", originalActorName: "Maren", by: "gm", at: "2026-09-29" });
  assert.equal(normalizeGrowthEvent({ summary: "x", tags: ["martial"], outcome: "success" }, 1).reassigned, undefined);
});

// ---------------------------------------------------------------------------------------------
// UI (pure renderers)

const baseRender = (extra = {}) => renderGrowthContent({
  growth: { events: [{ id: "event:1", summary: "Maren parried.", tags: ["martial"], outcome: "success" }], proposals: [] },
  progression: { level: 1, progress: 0, grantAllowances: 0 },
  pending: [],
  lastAnalysis: null,
  lastResult: null,
  status: { kind: "ai", text: "AI", title: "" },
  ...extra
});

test("Growth dialog: Delete / Move to... / Revert approval only render for the GM", () => {
  const owned = { classes: [{ id: "class:warrior", name: "Warrior", kind: "class", status: "active" }], skills: [{ id: "skill:old", name: "Old", kind: "skill", status: "superseded" }], titles: [] };
  const player = baseRender({ owned });
  assert.doesNotMatch(player, /gd-delete-event|gd-move-event|gd-revert-approval/);
  const gm = baseRender({ owned, canManageEvents: true, canRevert: true });
  assert.match(gm, /data-action="gd-delete-event" data-event-id="event:1"/);
  assert.match(gm, /data-action="gd-move-event" data-event-id="event:1"/);
  assert.match(gm, /data-action="gd-revert-approval" data-entry-id="class:warrior"/);
  assert.doesNotMatch(gm, /data-entry-id="skill:old"/, "a superseded entry is not revertable (revert what replaced it)");
  assert.match(gm, /Approved \(1\)/);
  const busy = baseRender({ owned, canManageEvents: true, canRevert: true, busy: true });
  assert.match(busy, /data-action="gd-delete-event"[^>]* disabled/);
});

test("event controls, move picker, confirmations and result messages", () => {
  assert.equal(renderEventControls({}), "");
  assert.match(renderEventControls({ id: "e<1>" }), /data-event-id="e&lt;1&gt;"/);
  const picker = renderMovePicker({ summary: "Killed <b>it</b>" }, [{ id: "a2", name: "Tovin" }, { id: "a3", name: "Luz" }], "Maren");
  assert.match(picker, /<option value="a2">Tovin<\/option><option value="a3">Luz<\/option>/);
  assert.match(picker, /Killed &lt;b&gt;it&lt;\/b&gt;/);
  assert.match(picker, /Credited to Maren/);
  assert.match(renderDeleteEventConfirm({ summary: "kicked", darkDeed: "cruelty", darkSeverity: "serious" }), /Horror Rank/);
  assert.doesNotMatch(renderDeleteEventConfirm({ summary: "parried" }), /Horror Rank/);
  const revert = renderRevertConfirm({ kind: "skill", name: "Ascendant", lineage: { operation: "upgrade", sources: ["skill:a"] } }, new Map([["skill:a", "Power Strike"]]));
  assert.match(revert, /replaced <strong>Power Strike<\/strong>, which comes back/);
  assert.match(describeDeleteResult({ event: { summary: "x" }, lostProgress: 10, withdrawnProposals: ["p"] }).message, /10 progression taken back, 1 proposal that cited only it withdrawn/);
  assert.match(describeReassignResult({ event: { summary: "x" }, from: { name: "Maren" }, to: { name: "Tovin" }, gainedProgress: 10 }).message, /from Maren to Tovin \(10 progression moved\)/);
  assert.match(describeRevertResult({ name: "Warden", restored: ["a", "b"], refunded: "grant", proposal: { status: "pending" } }).message, /Reverted Warden\. 2 replaced entries were restored\. The grant allowance was given back\. Its proposal is pending again\./);
  assert.equal(renderApprovedList({ classes: [], skills: [], titles: [] }), "");
});

test("a moved event shows where it came from", () => {
  const html = renderEventLine({ id: "e", summary: "x", tags: ["martial"], outcome: "success", actorName: "Tovin", reassigned: { fromActorName: "Maren" } });
  assert.match(html, /gd-moved[^>]*title="Moved here by the GM from Maren"/);
  assert.match(html, /from Maren/);
});
