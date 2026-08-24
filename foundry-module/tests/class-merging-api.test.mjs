import assert from "node:assert/strict";
import test from "node:test";

import { GrandDesignApi } from "../scripts/api.js";
import { MODULE_ID } from "../scripts/constants.js";

// Mirrors createMockActor() in api.test.mjs -- a minimal stand-in for a Foundry Actor with
// in-memory flags, no real document layer required.
function createMockActor() {
  const flags = { [MODULE_ID]: {} };
  let itemCounter = 0;
  return {
    id: "mock-actor",
    name: "Mock Actor",
    documentName: "Actor",
    system: { skills: { acrobatics: { mod: 8 } } },
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
      itemCounter += 1;
      return [{ id: `mock-item-${itemCounter}`, getFlag: () => undefined }];
    }
  };
}

function twoClassConversion() {
  return {
    character: "Test Character",
    classes: [
      {
        name: "Spearmaster",
        level: 20,
        power_tier: "elevated",
        is_primary: true,
        system_chassis: "Fighter",
        metadata: { tags: ["martial", "precision", "ranged"] },
        gameItem: { kind: "passive" },
        mechanics: { effect: "Melee Strikes with a reach weapon gain a +1 circumstance bonus.", duration: "unlimited", frequency: { max: 1, per: "unlimited" } }
      },
      {
        name: "Horizon's Edge",
        level: 20,
        power_tier: "elevated",
        is_secondary: true,
        system_chassis: "Ranger",
        metadata: { tags: ["martial", "precision", "mobility"] },
        gameItem: { kind: "passive" },
        mechanics: { effect: "Once per round, moving at least 10 feet before a Strike grants a +1 circumstance bonus to that Strike.", duration: "unlimited", frequency: { max: 1, per: "round" } }
      }
    ]
  };
}

test("buildClassMergePreview + combineClasses fuse two of the actor's own approved Classes end to end", async () => {
  const originalGame = globalThis.game;
  const originalHooks = globalThis.Hooks;
  globalThis.game = { user: { isGM: true }, system: { id: "pf2e" } };
  globalThis.Hooks = { callAll: () => {} };

  try {
    const api = new GrandDesignApi();
    const actor = createMockActor();

    await api.applyToActor(actor, twoClassConversion());
    const registryBefore = api.getActorRegistry(actor);
    assert.equal(Object.keys(registryBefore.classes).length, 2, "both source Classes are approved first");
    // The registerEntry patch this feature relies on: registry entries now carry power_tier so
    // class-merging.js's math has something to read.
    assert.equal(registryBefore.classes["class:spearmaster"].power_tier, "elevated");

    const preview = api.buildClassMergePreview(actor, {
      sourceIds: ["class:spearmaster", "class:horizon-s-edge"],
      level: 25,
      gameItem: { kind: "passive" },
      mechanics: {
        effect: "Once per round, a melee Strike that hits within 10 feet of a fallen ally deals 1d6 additional precision damage.",
        duration: "instant",
        frequency: { max: 1, per: "round" }
      }
    });
    assert.equal(preview.name, "Spearmaster, Horizon's Edge");
    assert.equal(preview.power_tier, "prestige");

    const approved = await api.combineClasses(actor, preview);
    const merged = Object.values(approved.registry.classes).find((entry) => entry.name === preview.name);
    assert.ok(merged, "the merged Class is now in the actor's registry");
    assert.equal(merged.power_tier, "prestige");
    assert.equal(merged.level, 25);
    assert.deepEqual(merged.metadata.lineage.sources, ["class:spearmaster", "class:horizon-s-edge"]);
    assert.equal(merged.metadata.lineage.operation, "combine");
    assert.equal(Object.keys(api.getActorRegistry(actor).classes).length, 3, "both sources remain registered alongside the new merge");
  } finally {
    globalThis.game = originalGame;
    globalThis.Hooks = originalHooks;
  }
});

test("buildClassMergePreview rejects a sourceId the actor hasn't actually had approved", async () => {
  const originalGame = globalThis.game;
  const originalHooks = globalThis.Hooks;
  globalThis.game = { user: { isGM: true }, system: { id: "pf2e" } };
  globalThis.Hooks = { callAll: () => {} };

  try {
    const api = new GrandDesignApi();
    const actor = createMockActor();
    await api.applyToActor(actor, twoClassConversion());

    assert.throws(
      () => api.buildClassMergePreview(actor, { sourceIds: ["class:spearmaster", "class:nonexistent"], level: 25 }),
      /No approved Class/
    );
  } finally {
    globalThis.game = originalGame;
    globalThis.Hooks = originalHooks;
  }
});
