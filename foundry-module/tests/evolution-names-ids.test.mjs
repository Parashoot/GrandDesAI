// Board 574707d8: every martial tier-3 evolution was "Minotaur Punch" (bank[0]), evolved/merged
// entries carried no metadata.id, so lineage.js#normalizeEntry derived `skill:minotaur-punch` for
// both and registerEntry silently replaced the first evolved Skill with the second. These tests pin
// the fix: names are picked by a stable hash of the source(s), every derived entry carries its own
// unique metadata.id, and a caller that passes the ids already in use never lands on one.
import assert from "node:assert/strict";
import test from "node:test";

import { evolveSkillEntry, pickStableName, stableHash, uniqueRegistryId } from "../scripts/skill-evolution.js";
import { mergeClassEntry } from "../scripts/class-merging.js";
import { buildCombinationSkill } from "../scripts/combination-skills.js";
import { createFeatureSource, emptyRegistry, normalizeEntry, registerEntry } from "../scripts/lineage.js";

const MECHANICS = { effect: "Once per round, deal 1 extra damage with a melee Strike.", duration: "instant", frequency: { max: 1, per: "round" } };

function martialSkill(id, name, tier = 2) {
  return { name, tier, approvedAt: "2026-01-01", system_equivalent: "Power Attack", metadata: { id, tags: ["martial"], lineage: { operation: "origin", sources: [], rationale: "" } }, gameItem: { kind: "action", actionCost: 1 }, mechanics: MECHANICS };
}

// Enough weighted evidence plus one defining moment: a real catalyst, so tier 2 -> 3 (full rename).
const CATALYST_EVENTS = [
  { tags: ["martial"], outcome: "success", occurredAt: "2026-01-02" },
  { tags: ["martial"], outcome: "success", occurredAt: "2026-01-03" },
  { tags: ["martial"], outcome: "success", occurredAt: "2026-01-04" },
  { id: "e4", tags: ["martial"], outcome: "criticalSuccess", occurredAt: "2026-01-05", summary: "Held the gate alone." }
];

const SOURCES = [
  ["skill:power-strike", "Power Strike"],
  ["skill:shield-bash", "Shield Bash"],
  ["skill:cleave", "Cleave"],
  ["skill:riposte", "Riposte"],
  ["skill:haymaker", "Haymaker"]
];

test("stableHash / pickStableName are deterministic and skip taken names while the bank has others", () => {
  assert.equal(stableHash("skill:power-strike"), stableHash("skill:power-strike"));
  assert.notEqual(stableHash("skill:power-strike"), stableHash("skill:shield-bash"));
  const bank = ["A", "B", "C"];
  const first = pickStableName(bank, "seed");
  assert.equal(pickStableName(bank, "seed"), first);
  const second = pickStableName(bank, "seed", [first]);
  assert.notEqual(second, first);
  assert.ok(bank.includes(second));
  assert.equal(pickStableName(bank, "seed", bank), first, "all taken -> the hashed pick anyway");
});

test("uniqueRegistryId suffixes past every id in use (array, Set, or the registry bucket itself)", () => {
  assert.equal(uniqueRegistryId("skill:x", []), "skill:x");
  assert.equal(uniqueRegistryId("skill:x", ["skill:x"]), "skill:x-2");
  assert.equal(uniqueRegistryId("skill:x", new Set(["skill:x", "skill:x-2"])), "skill:x-3");
  assert.equal(uniqueRegistryId("skill:x", { "skill:x": {} }), "skill:x-2");
});

test("five different martial Skills evolved to tier 3: not all 'Minotaur Punch', every id unique and derived from its source", () => {
  const entries = SOURCES.map(([id, name]) => evolveSkillEntry({ sourceSkill: martialSkill(id, name), events: CATALYST_EVENTS }));
  const names = entries.map((entry) => entry.name);
  assert.ok(new Set(names).size >= 3, `expected varied names, got ${names.join(", ")}`);
  assert.ok(names.filter((name) => name === "Minotaur Punch").length <= 2, names.join(", "));
  const ids = entries.map((entry) => entry.metadata.id);
  assert.equal(new Set(ids).size, ids.length, ids.join(", "));
  assert.deepEqual(ids, SOURCES.map(([id]) => `${id}--evolved-t3`));
  for (const entry of entries) assert.equal(entry.tier, 3);
  // Deterministic: the same source previews to the same name and id every time.
  const again = evolveSkillEntry({ sourceSkill: martialSkill(...SOURCES[0]), events: CATALYST_EVENTS });
  assert.equal(again.name, entries[0].name);
  assert.equal(again.metadata.id, entries[0].metadata.id);
});

test("the actor's existing names are avoided and existing ids never reused", () => {
  const source = martialSkill("skill:power-strike", "Power Strike");
  const first = evolveSkillEntry({ sourceSkill: source, events: CATALYST_EVENTS });
  const second = evolveSkillEntry({
    sourceSkill: source,
    events: CATALYST_EVENTS,
    existingIds: [first.metadata.id],
    existingNames: [first.name]
  });
  assert.notEqual(second.name, first.name);
  assert.equal(second.metadata.id, `${first.metadata.id}-2`);
});

test("an explicit name / id override wins (the hook for AI-authored names), and the id is still guarded", () => {
  const source = martialSkill("skill:power-strike", "Power Strike");
  const entry = evolveSkillEntry({ sourceSkill: source, events: CATALYST_EVENTS, name: "Bullfighter's Answer", id: "skill:bullfighter", existingIds: ["skill:bullfighter"] });
  assert.equal(entry.name, "Bullfighter's Answer");
  assert.equal(entry.metadata.id, "skill:bullfighter-2");
});

test("a refinement (no catalyst) gets its own id too, distinct from an evolution of the same source", () => {
  const source = martialSkill("skill:power-strike", "Power Strike", 1);
  const refined = evolveSkillEntry({ sourceSkill: source, events: [] });
  assert.equal(refined.name, "Greater Power Strike");
  assert.equal(refined.metadata.id, "skill:power-strike--refined-t1");
});

for (const systemId of ["pf2e", "dnd5e"]) {
  test(`[${systemId}] two evolved Skills that share a name both survive registration (no silent overwrite)`, () => {
    let registry = emptyRegistry();
    for (const [id, name] of SOURCES.slice(0, 2)) {
      const source = normalizeEntry("skill", martialSkill(id, name), registry, "origin");
      registry = registerEntry("skill", source, `item-${id}`, registry);
    }
    // Force the worst case: both evolutions get the SAME name (e.g. a GM typed it, or the bank hashed
    // them together). Before the fix both normalized to "skill:minotaur-punch" and the second replaced the first.
    const evolved = SOURCES.slice(0, 2).map(([id]) => evolveSkillEntry({
      sourceSkill: registry.skills[id],
      events: CATALYST_EVENTS,
      since: null, // registerEntry stamps approvedAt = now; count the fixture's older events anyway
      name: "Minotaur Punch"
    }));
    for (const entry of evolved) {
      const normalized = normalizeEntry("skill", entry, registry, "upgrade");
      const { source } = createFeatureSource("skill", normalized, systemId);
      assert.equal(source.flags["grand-design-ai"].registryId, entry.metadata.id);
      registry = registerEntry("skill", normalized, `item-${entry.metadata.id}`, registry);
    }
    const evolvedIds = Object.keys(registry.skills).filter((key) => key.includes("--evolved-"));
    assert.equal(evolvedIds.length, 2, Object.keys(registry.skills).join(", "));
    assert.equal(Object.keys(registry.skills).length, 4, "both sources and both evolutions are kept");
  });
}

function occultClass(id, name, flags = {}) {
  return { name, power_tier: "prestige", level: 50, ...flags, metadata: { id, tags: ["occult", "mystery"] } };
}

test("merged Classes carry a unique metadata.id from their sources; different source pairs usually get different legendary titles", () => {
  const pairs = [
    [occultClass("class:veiled-seer", "Veiled Seer", { is_primary: true }), occultClass("class:dream-warden", "Dream Warden")],
    [occultClass("class:hollow-oracle", "Hollow Oracle", { is_primary: true }), occultClass("class:night-scribe", "Night Scribe")],
    [occultClass("class:grave-listener", "Grave Listener", { is_primary: true }), occultClass("class:moth-priest", "Moth Priest")],
    [occultClass("class:mirror-witch", "Mirror Witch", { is_primary: true }), occultClass("class:ash-dreamer", "Ash Dreamer")]
  ];
  const merged = pairs.map((sourceClasses) => mergeClassEntry({ sourceClasses, level: 50, gameItem: { kind: "passive" }, mechanics: MECHANICS }));
  const titles = merged.map((entry) => entry.name);
  assert.ok(titles.every((title) => title.startsWith("The ")), titles.join(" | "));
  assert.ok(new Set(titles).size >= 2, `expected varied legendary titles, got ${titles.join(" | ")}`);
  const ids = merged.map((entry) => entry.metadata.id);
  assert.equal(new Set(ids).size, ids.length, ids.join(", "));
  for (const id of ids) assert.match(id, /^class:merge-[0-9a-z]+-prestige-l50$/);
  // Same sources in a different order -> same id and title.
  const reordered = mergeClassEntry({ sourceClasses: [...pairs[0]].reverse(), level: 50, gameItem: { kind: "passive" }, mechanics: MECHANICS });
  assert.equal(reordered.metadata.id, merged[0].metadata.id);
  // Guarded against an id already on the actor; a name override is honored.
  const guarded = mergeClassEntry({ sourceClasses: pairs[0], level: 50, gameItem: { kind: "passive" }, mechanics: MECHANICS, existingIds: [merged[0].metadata.id], name: "The Keeper of Shut Eyes" });
  assert.equal(guarded.metadata.id, `${merged[0].metadata.id}-2`);
  assert.equal(guarded.name, "The Keeper of Shut Eyes");
});

test("combination ids differ for different parties even when the titles match; existingIds adds a suffix", () => {
  const contribution = (actorId, skillId) => ({ actorId, actorName: actorId, skill: { name: `${actorId}'s Flame`, tier: 1, metadata: { id: skillId, tags: ["fire"] } } });
  const a = buildCombinationSkill({ contributions: [contribution("a", "skill:a"), contribution("b", "skill:b"), contribution("c", "skill:c")], effect: "Fire." });
  const b = buildCombinationSkill({ contributions: [contribution("d", "skill:d"), contribution("e", "skill:e"), contribution("f", "skill:f")], effect: "Fire." });
  assert.notEqual(a.id, b.id);
  const again = buildCombinationSkill({ contributions: [contribution("a", "skill:a"), contribution("b", "skill:b"), contribution("c", "skill:c")], effect: "Fire.", existingIds: [a.id] });
  assert.equal(again.id, `${a.id}-2`);
  assert.equal(again.name, a.name, "same party, same title");
});
