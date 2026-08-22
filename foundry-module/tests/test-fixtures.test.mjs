import assert from "node:assert/strict";
import test from "node:test";

import {
  combinedSkillFixture,
  TEST_ACTORS,
  TEST_ACTS,
  testConversionFixture,
  upgradedClassFixture
} from "../scripts/test-fixtures.js";
import { validateConversion } from "../scripts/validator.js";

test("acceptance campaign fixture has a valid conversion payload", () => {
  const result = validateConversion(testConversionFixture());

  assert.equal(result.valid, true, result.errors.join(" "));
});

test("combined skill fixture names both approved source IDs", () => {
  const combined = combinedSkillFixture();

  assert.deepEqual(combined.metadata.lineage.sources, ["skill:ember-step", "skill:mist-step"]);
  assert.equal(combined.metadata.lineage.operation, "combine");
});

test("full campaign fixtures define three acts and five actors", () => {
  assert.equal(TEST_ACTS.length, 3);
  assert.equal(TEST_ACTORS.length, 5);
  assert.equal(upgradedClassFixture().metadata.lineage.operation, "upgrade");
});
