import assert from "node:assert/strict";
import test from "node:test";

import { createFeatureSource } from "../scripts/lineage.js";
import { mechanicsConversionFixture, testConversionFixture } from "../scripts/test-fixtures.js";
import { validateConversion } from "../scripts/validator.js";

test("approved campaign fixtures require complete mechanics", () => {
  assert.equal(validateConversion(testConversionFixture()).valid, true);
  assert.equal(validateConversion(mechanicsConversionFixture()).valid, true);
});

test("actions without dice resolution are rejected", () => {
  const invalid = testConversionFixture();
  delete invalid.skills[0].mechanics.roll;

  const result = validateConversion(invalid);

  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /dice roll/);
});

test("passives without duration are rejected", () => {
  const invalid = testConversionFixture();
  delete invalid.classes[0].mechanics.duration;

  const result = validateConversion(invalid);

  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /passive mechanics require a duration/);
});

test("mechanics map to PF2e spell and weapon sources with dice details", () => {
  const [spell, weapon] = mechanicsConversionFixture().skills;
  spell.metadata.id = "skill:canal-spark";
  weapon.metadata.id = "skill:silt-hook";

  const { source: spellSource } = createFeatureSource("skill", spell, "pf2e");
  const { source: weaponSource } = createFeatureSource("skill", weapon, "pf2e");

  assert.equal(spellSource.type, "spell");
  assert.equal(spellSource.system.level.value, 1);
  assert.equal(weaponSource.type, "weapon");
  assert.deepEqual(weaponSource.system.damage, { dice: 1, die: "d6", damageType: "piercing" });
});

test("mechanics map to dnd5e spell and weapon sources with dice details", () => {
  const [spell, weapon] = mechanicsConversionFixture().skills;
  spell.metadata.id = "skill:canal-spark";
  weapon.metadata.id = "skill:silt-hook";

  const { source: spellSource, postCreate: spellPostCreate } = createFeatureSource("skill", spell, "dnd5e");
  const { source: weaponSource, postCreate: weaponPostCreate } = createFeatureSource("skill", weapon, "dnd5e");

  assert.equal(spellSource.type, "spell");
  assert.equal(spellSource.system.level, 1);
  assert.equal(spellSource.system.school, "evo");
  assert.equal(typeof spellPostCreate, "function");
  assert.equal(weaponSource.type, "weapon");
  assert.deepEqual(weaponSource.system.damage.base, { number: 1, denomination: 6, bonus: "2", types: ["piercing"] });
  assert.equal(weaponPostCreate, null);
});
