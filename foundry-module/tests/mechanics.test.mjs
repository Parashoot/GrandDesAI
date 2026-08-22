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

  const spellSource = createFeatureSource("skill", spell);
  const weaponSource = createFeatureSource("skill", weapon);

  assert.equal(spellSource.type, "spell");
  assert.equal(spellSource.system.level.value, 1);
  assert.equal(weaponSource.type, "weapon");
  assert.deepEqual(weaponSource.system.damage, { dice: 1, die: "d6", damageType: "piercing" });
});
