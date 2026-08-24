import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWeaponItemSpec,
  generateItemSpec,
  generateMonsterSpec,
  generateName,
  generateNpcSpec,
  MONSTER_TEMPLATES,
  parseSpawnCriteria,
  populate,
  WEAPON_BASE
} from "../scripts/populate.js";

// A deterministic rng: cycles through a fixed sequence of [0,1) values so tests get an exact,
// reproducible result instead of real randomness -- the same pattern the rest of Grand Design's
// tests use for anything that would otherwise be nondeterministic.
function fixedRng(sequence) {
  let i = 0;
  return () => {
    const value = sequence[i % sequence.length];
    i += 1;
    return value;
  };
}
const zeroRng = () => 0;

test("parseSpawnCriteria rejects an empty prompt", () => {
  assert.throws(() => parseSpawnCriteria(""), /prompt is required/i);
  assert.throws(() => parseSpawnCriteria("   "), /prompt is required/i);
});

test("parseSpawnCriteria infers kind: monster keyword wins, then item keyword (unless a person word is present), else npc", () => {
  assert.equal(parseSpawnCriteria("a pack of 3 goblin scouts").kind, "monster");
  assert.equal(parseSpawnCriteria("a +1 flaming shortsword").kind, "item");
  assert.equal(parseSpawnCriteria("a grizzled dwarven blacksmith who deals in stolen goods").kind, "npc");
  // "sword" is an item keyword, but "blacksmith" is a person-override -- stays an npc.
  assert.equal(parseSpawnCriteria("a blacksmith who sells swords").kind, "npc");
});

test("parseSpawnCriteria parses digit counts, number words, and clamps to the 1-20 range", () => {
  assert.equal(parseSpawnCriteria("5 goblins").count, 5);
  assert.equal(parseSpawnCriteria("a pack of three goblins").count, 3);
  assert.equal(parseSpawnCriteria("a couple of bandits").count, 2);
  assert.equal(parseSpawnCriteria("a lone goblin").count, 1);
  assert.equal(parseSpawnCriteria("999 goblins").count, 20);
});

test("parseSpawnCriteria infers race, level, and power modifier keywords", () => {
  const criteria = parseSpawnCriteria("a veteran dwarven guard, level 6");
  assert.equal(criteria.race, "dwarf");
  assert.equal(criteria.level, 6);
  assert.equal(criteria.powerModifier.label, "Veteran");
  assert.equal(parseSpawnCriteria("an elven scholar").race, "elf");
  assert.equal(parseSpawnCriteria("a human farmer").role.key, "farmer");
  assert.equal(parseSpawnCriteria("a nameless drifter").role.key, null);
});

test("parseSpawnCriteria does not mistake the number in 'level N' or 'CR N' for a spawn count", () => {
  assert.equal(parseSpawnCriteria("a grizzled dwarven blacksmith, level 3").count, 1);
  assert.equal(parseSpawnCriteria("a lone troll, CR 5").count, 1);
  // ... but an actual count alongside a level phrase still works.
  assert.equal(parseSpawnCriteria("3 level 5 goblins").count, 3);
});

test("parseSpawnCriteria understands CR fractions for monsters", () => {
  assert.equal(parseSpawnCriteria("a goblin, CR 1/4").level, 0.25);
  assert.equal(parseSpawnCriteria("an ogre, cr 2").level, 2);
});

test("generateName is deterministic for a fixed rng and falls back to the human bank for an unknown race", () => {
  const name = generateName("dwarf", zeroRng);
  assert.equal(name, "Thorin"); // first dwarf first-syllable + first dwarf last-syllable
  const fallback = generateName("totally-not-a-race", zeroRng);
  assert.equal(fallback, "Alric"); // human bank is the default
});

test("generateNpcSpec produces a fully-formed, system-agnostic NPC actor spec", () => {
  const criteria = parseSpawnCriteria("a grizzled dwarven blacksmith, level 3");
  const spec = generateNpcSpec(criteria, { rng: fixedRng([0.5, 0.5, 0.5, 0.5]) });
  assert.equal(spec.documentType, "actor");
  assert.equal(spec.actorKind, "npc");
  assert.equal(spec.race, "dwarf");
  assert.equal(spec.role, "blacksmith");
  assert.equal(spec.level, 3);
  assert.ok(spec.hp > 0);
  assert.ok(Number.isInteger(spec.ac));
  assert.equal(spec.weaponKey, "warhammer");
  assert.equal(spec.weaponSpec.documentType, "item");
  // The starting-gear weapon spec must carry a real name -- Foundry's createEmbeddedDocuments
  // silently drops (no error, no document) any item data with a null/empty name, so a null name
  // here would mean the NPC never actually gets its weapon.
  assert.equal(spec.weaponSpec.name, "Warhammer");
  assert.match(spec.bio, /Dwarf Blacksmith/);
  assert.match(spec.bio, /grizzled dwarven blacksmith/);
});

test("generateNpcSpec clamps level to the 1-20 range and rolls a level when none is given", () => {
  const overLeveled = generateNpcSpec(parseSpawnCriteria("a level 99 sage"), { rng: zeroRng });
  assert.equal(overLeveled.level, 20);
  const rolled = generateNpcSpec(parseSpawnCriteria("a farmer"), { rng: () => 0 });
  assert.ok(rolled.level >= 1 && rolled.level <= 20);
});

test("generateMonsterSpec uses the matching template when the prompt names a known creature", () => {
  const criteria = parseSpawnCriteria("a goblin");
  const spec = generateMonsterSpec(criteria, { rng: zeroRng });
  assert.equal(spec.documentType, "actor");
  assert.equal(spec.actorKind, "monster");
  assert.equal(spec.approximated, false);
  assert.equal(spec.cr, MONSTER_TEMPLATES.goblin.cr);
  assert.equal(spec.hp, MONSTER_TEMPLATES.goblin.hp);
  assert.equal(spec.size, MONSTER_TEMPLATES.goblin.size);
});

test("generateMonsterSpec falls back to an honest approximation for an unrecognized creature", () => {
  const spec = generateMonsterSpec(parseSpawnCriteria("a monster called a rock-thing"), { rng: zeroRng });
  assert.equal(spec.approximated, true);
  assert.match(spec.bio, /No exact template/i);
});

test("generateMonsterSpec's power keyword (elite/boss/etc) scales HP and to-hit relative to the base template", () => {
  const base = generateMonsterSpec(parseSpawnCriteria("an orc"), { rng: zeroRng });
  const boss = generateMonsterSpec(parseSpawnCriteria("a boss orc"), { rng: zeroRng });
  assert.ok(boss.hp > base.hp);
  assert.ok(boss.attack.toHit > base.attack.toHit);
  assert.match(boss.name, /^Boss /);
});

test("buildWeaponItemSpec infers rarity from bonus and elemental rider", () => {
  assert.equal(buildWeaponItemSpec({ weaponKey: "sword", bonus: 0 }).rarity, "common");
  assert.equal(buildWeaponItemSpec({ weaponKey: "sword", bonus: 1 }).rarity, "uncommon");
  assert.equal(buildWeaponItemSpec({ weaponKey: "sword", bonus: 1, rider: "fire" }).rarity, "rare");
  assert.equal(buildWeaponItemSpec({ weaponKey: "sword", bonus: 0, rarity: "legendary" }).rarity, "legendary");
});

test("generateItemSpec parses a +N enhancement bonus and an elemental rider keyword into the name and spec", () => {
  const spec = generateItemSpec(parseSpawnCriteria("a +1 flaming shortsword"), { rng: zeroRng });
  assert.equal(spec.documentType, "item");
  assert.equal(spec.itemKind, "weapon");
  assert.equal(spec.weaponKey, "shortsword");
  assert.equal(spec.bonus, 1);
  assert.equal(spec.rider, "fire");
  assert.equal(spec.name, "+1 Flaming Shortsword");
  assert.equal(spec.rarity, "rare");
});

test("generateItemSpec produces a mundane weapon with no prefix when nothing magical is mentioned", () => {
  const spec = generateItemSpec(parseSpawnCriteria("a dagger"), { rng: zeroRng });
  assert.equal(spec.bonus, 0);
  assert.equal(spec.rider, null);
  assert.equal(spec.name, "Dagger");
});

test("populate() with no adapter uses the local heuristic and expands count into that many distinct specs", async () => {
  const { kind, specs, criteria } = await populate("a pack of 3 goblin scouts", { rng: fixedRng([0.1, 0.3, 0.6, 0.9]) });
  assert.equal(kind, "monster");
  assert.equal(specs.length, 3);
  assert.equal(criteria.count, 3);
  for (const spec of specs) assert.equal(spec.templateKeyword, "goblin");
});

test("populate() recognizes an ordinary plural monster prompt too, not just the singular form", async () => {
  const { kind, specs } = await populate("3 goblins", { rng: zeroRng });
  assert.equal(kind, "monster");
  assert.equal(specs.length, 3);
});

test("populate() prefers a registered adapter's result when it returns a valid {kind, specs} shape", async () => {
  const adapterResult = { kind: "item", specs: [{ documentType: "item", itemKind: "weapon", name: "Adapter Blade" }] };
  const adapter = async ({ promptText }) => {
    assert.equal(promptText, "anything");
    return adapterResult;
  };
  const result = await populate("anything", { adapter });
  assert.deepEqual(result, adapterResult);
});

test("populate() falls back to the local heuristic when the adapter returns an invalid shape", async () => {
  const badAdapter = async () => ({ notAValidShape: true });
  const result = await populate("a goblin", { adapter: badAdapter, rng: zeroRng });
  assert.equal(result.kind, "monster");
  assert.ok(result.specs.length >= 1);
});

test("WEAPON_BASE and MONSTER_TEMPLATES stay non-empty curated banks (guards against an accidental empty export)", () => {
  assert.ok(Object.keys(WEAPON_BASE).length >= 10);
  assert.ok(Object.keys(MONSTER_TEMPLATES).length >= 10);
});
