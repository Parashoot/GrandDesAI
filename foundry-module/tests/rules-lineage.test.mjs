// Additional coverage for scripts/lineage.js (C4 cloud packet). tests/lineage.test.mjs already
// covers the happy "combine inherits tags" path and one validator interaction; this file covers the
// rules that had NO test anywhere in the suite: normalizeEntry's own error/guard paths, registerEntry's
// kind-specific field whitelist for "class" and "title" (only "skill" was previously exercised, via
// tests/lineage.test.mjs), and createTitleSource/createCombinationSource, which no test file
// referenced at all before this one. Both PF2e and dnd5e are exercised for the two system-branching
// functions (createTitleSource, createCombinationSource) via getSystemAdapter.
import assert from "node:assert/strict";
import test from "node:test";

import {
  cloneRegistry,
  createCombinationSource,
  createTitleSource,
  emptyRegistry,
  normalizeEntry,
  registerEntry,
  uniqueStrings
} from "../scripts/lineage.js";

function approvedSkill(registry, id, name, tags) {
  const next = cloneRegistry(registry);
  next.skills[id] = { name, metadata: { id, tags, lineage: { operation: "origin", sources: [], rationale: "" } } };
  return next;
}

test("normalizeEntry rejects an unsupported lineage operation", () => {
  const registry = emptyRegistry();
  assert.throws(
    () => normalizeEntry("skill", { name: "X", metadata: { lineage: { operation: "teleport" } } }, registry),
    /Unsupported lineage operation: teleport/
  );
});

test("normalizeEntry requires at least two sources for a 'combine' operation", () => {
  const registry = approvedSkill(emptyRegistry(), "skill:a", "A", ["fire"]);
  assert.throws(
    () => normalizeEntry("skill", { name: "X", metadata: { lineage: { operation: "combine", sources: ["skill:a"] } } }, registry),
    /at least two approved source entries/
  );
});

test("normalizeEntry requires exactly one source for an 'upgrade' operation", () => {
  let registry = approvedSkill(emptyRegistry(), "skill:a", "A", ["fire"]);
  registry = approvedSkill(registry, "skill:b", "B", ["water"]);
  assert.throws(
    () => normalizeEntry("skill", { name: "X", metadata: { lineage: { operation: "upgrade", sources: ["skill:a", "skill:b"] } } }, registry),
    /exactly one approved source entry/
  );
  assert.throws(
    () => normalizeEntry("skill", { name: "X", metadata: { lineage: { operation: "upgrade", sources: [] } } }, registry),
    /exactly one approved source entry/
  );
});

test("normalizeEntry rejects a lineage source that isn't actually an approved entry of that kind", () => {
  const registry = approvedSkill(emptyRegistry(), "skill:a", "A", ["fire"]);
  assert.throws(
    () => normalizeEntry(
      "skill",
      { name: "X", metadata: { lineage: { operation: "combine", sources: ["skill:a", "skill:nonexistent"] } } },
      registry
    ),
    /skill:nonexistent is not an approved skill/
  );
});

test("normalizeEntry preserves polarity/malignance and themes through re-normalization when present, and omits them when absent", () => {
  const registry = emptyRegistry();
  const withExtras = normalizeEntry(
    "skill",
    {
      name: "Cruel Trick",
      metadata: {
        tags: ["cruelty"],
        polarity: "red",
        malignance: { vice: "cruelty", drawback: "Costs something every time." },
        themes: ["beekeeping", "beekeeping"]
      }
    },
    registry
  );
  assert.equal(withExtras.metadata.polarity, "red");
  assert.deepEqual(withExtras.metadata.malignance, { vice: "cruelty", drawback: "Costs something every time." });
  assert.deepEqual(withExtras.metadata.themes, ["beekeeping"], "deduplicated");

  const plain = normalizeEntry("skill", { name: "Plain Trick", metadata: { tags: [] } }, registry);
  assert.equal("polarity" in plain.metadata, false);
  assert.equal("malignance" in plain.metadata, false);
  assert.equal("themes" in plain.metadata, false);
});

test("normalizeEntry throws for an unknown registry entry kind", () => {
  assert.throws(() => normalizeEntry("weapon", { name: "X", metadata: {} }, emptyRegistry()), /Unknown Grand Design entry kind/);
});

test("registerEntry persists Class-specific fields (level, power_tier, is_primary/secondary, system_chassis, offCycleEvolution)", () => {
  const registry = emptyRegistry();
  const entry = normalizeEntry("class", {
    name: "Runner",
    level: 12,
    power_tier: "elevated",
    is_primary: true,
    system_chassis: "Ranger",
    offCycleEvolution: true,
    metadata: { tags: ["mobility"] }
  }, registry);
  const next = registerEntry("class", entry, "item-1", registry);
  const stored = next.classes[entry.metadata.id];
  assert.equal(stored.level, 12);
  assert.equal(stored.power_tier, "elevated");
  assert.equal(stored.is_primary, true);
  assert.equal(stored.is_secondary, false, "defaults false when not explicitly true");
  assert.equal(stored.system_chassis, "Ranger");
  assert.equal(stored.offCycleEvolution, true);
});

test("registerEntry omits offCycleEvolution entirely for a hand-authored Class entry that never went through mergeClassEntry", () => {
  const registry = emptyRegistry();
  const entry = normalizeEntry("class", { name: "Runner", level: 1, power_tier: "standard", metadata: { tags: [] } }, registry);
  const next = registerEntry("class", entry, "item-1", registry);
  assert.equal("offCycleEvolution" in next.classes[entry.metadata.id], false);
});

test("registerEntry persists Title-specific fields (achievement, grants, grantedSkillId/ItemId)", () => {
  const registry = emptyRegistry();
  const entry = normalizeEntry("title", {
    name: "Hero of the Vale",
    achievement: "Saved the village from the flood.",
    grants: { reputation: "Known across the Vale." },
    grantedSkillId: "skill:flood-warden",
    grantedItemId: null,
    metadata: { tags: [] }
  }, registry);
  const next = registerEntry("title", entry, "item-1", registry);
  const stored = next.titles[entry.metadata.id];
  assert.equal(stored.achievement, "Saved the village from the flood.");
  assert.deepEqual(stored.grants, { reputation: "Known across the Vale." });
  assert.equal(stored.grantedSkillId, "skill:flood-warden");
  assert.equal(stored.grantedItemId, null);
});

test("registerEntry never mutates the input registry (always returns a fresh clone)", () => {
  const registry = emptyRegistry();
  const entry = normalizeEntry("skill", { name: "Dash", tier: 1, system_equivalent: "x", metadata: { tags: [] } }, registry);
  const snapshot = structuredClone(registry);
  registerEntry("skill", entry, "item-1", registry);
  assert.deepEqual(registry, snapshot);
});

test("createTitleSource builds a Title Item on pf2e and dnd5e, describing its achievement and any bundled grants", () => {
  const entry = {
    name: "Hero of the Vale",
    achievement: "Saved the village from the flood.",
    metadata: { id: "title:hero-of-the-vale" },
    grants: { skillEntry: { name: "Flood Ward" }, reputation: "Known across the Vale." }
  };
  for (const systemId of ["pf2e", "dnd5e"]) {
    const { source, postCreate } = createTitleSource(entry, systemId);
    assert.equal(source.name, "[Hero of the Vale] Title");
    assert.equal(source.type, "feat");
    assert.match(source.system.description.value, /Saved the village from the flood\./);
    assert.match(source.system.description.value, /Flood Ward/);
    assert.match(source.system.description.value, /Known across the Vale\./);
    assert.equal(source.flags["grand-design-ai"].kind, "title");
    assert.equal(source.flags["grand-design-ai"].achievement, entry.achievement);
    assert.equal(postCreate, null, "a Title has nothing to activate, on either system");
  }
});

test("createTitleSource with no grants at all omits the Grants section from the description", () => {
  const entry = { name: "Nobody Special", achievement: "Showed up.", metadata: { id: "title:nobody" }, grants: {} };
  const { source } = createTitleSource(entry, "pf2e");
  assert.equal(/Grants:/.test(source.system.description.value), false);
});

test("createCombinationSource builds a transient combination badge on pf2e and dnd5e, flagged by combinationId (not registryId)", () => {
  const combination = {
    id: "combination:the-converging-conflagration",
    name: "The Converging Conflagration",
    band: "amplified",
    power: 8,
    resonance: { score: 1, sharedTags: ["fire"] },
    effect: "A wall of fire erupts around the casters.",
    duration: "1 round",
    rationale: "Three casters landed genuinely resonant Skills.",
    participants: [
      { actorId: "a", actorName: "Ayla", skillId: "skill:a", skillName: "Ember Lash", tier: 2 },
      { actorId: "b", actorName: "Bo", skillId: "skill:b", skillName: "Cinder Step", tier: 2 }
    ]
  };
  const participant = combination.participants[0];
  for (const systemId of ["pf2e", "dnd5e"]) {
    const { source, postCreate } = createCombinationSource(combination, participant, systemId);
    assert.equal(source.name, "[The Converging Conflagration] Combination");
    assert.match(source.system.description.value, /A wall of fire erupts around the casters\./);
    assert.match(source.system.description.value, /your contribution/, "the acting participant's own line is marked");
    assert.equal(source.flags["grand-design-ai"].kind, "combination");
    assert.equal(source.flags["grand-design-ai"].combinationId, combination.id);
    assert.equal("registryId" in source.flags["grand-design-ai"], false, "transient -- never backed by a registry entry");
    assert.equal(source.flags["grand-design-ai"].contributedSkillId, "skill:a");
    assert.equal(postCreate, null);
  }
});

test("cloneRegistry deep-clones (mutating the clone never touches the original) and defaults a missing registry to empty", () => {
  const registry = approvedSkill(emptyRegistry(), "skill:a", "A", ["fire"]);
  const clone = cloneRegistry(registry);
  clone.skills["skill:a"].name = "Mutated";
  assert.equal(registry.skills["skill:a"].name, "A");
  assert.deepEqual(cloneRegistry(undefined), emptyRegistry());
});

test("uniqueStrings trims, dedupes, and drops non-string/blank values", () => {
  assert.deepEqual(uniqueStrings([" fire ", "fire", "", "  ", "water", 42, null, undefined]), ["fire", "water"]);
});
