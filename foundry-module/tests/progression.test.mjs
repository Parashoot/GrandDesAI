import assert from "node:assert/strict";
import test from "node:test";

import { canalStepGrowthEvents } from "../scripts/test-fixtures.js";
import { generateSkillProposals, validateGrowthEvent } from "../scripts/progression.js";

test("three successful water and mobility events generate a bounded proposal", () => {
  const proposals = generateSkillProposals(canalStepGrowthEvents(), { skills: {} }, 8);

  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].id, "proposal:canal-step");
  assert.equal(proposals[0].entry.mechanics.roll.formula, "1d20+8");
  assert.equal(proposals[0].evidence.length, 3);
});

test("failed or untagged events cannot create progression proposals", () => {
  const invalid = validateGrowthEvent({ summary: "Did a thing", tags: [], outcome: "failure" });

  assert.equal(invalid.valid, false);
  assert.deepEqual(generateSkillProposals([], { skills: {} }, 0), []);
});
