import assert from "node:assert/strict";
import test from "node:test";

import { canalStepGrowthEvents } from "../scripts/test-fixtures.js";
import {
  canApproveGeneratedProposal,
  generateSkillProposals,
  levelRequirement,
  resolveRest,
  validateGrowthEvent
} from "../scripts/progression.js";

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

test("Grand Design levels resolve only at rest and requirements escalate through level 100", () => {
  assert.ok(levelRequirement(2) > levelRequirement(1));
  assert.ok(levelRequirement(99) > levelRequirement(50));
  assert.throws(() => resolveRest({ progress: 100 }, { restType: "encounter" }));

  const result = resolveRest({ level: 0, progress: 100, grantAllowances: 0 }, { restType: "short" });
  assert.deepEqual(result.gainedLevels, [1]);
  assert.equal(result.progression.level, 1);
  assert.equal(result.progression.grantAllowances, 1);
});

test("Class proposals require both a level-up allowance and an evolution milestone", () => {
  const proposal = { kind: "class" };
  assert.equal(canApproveGeneratedProposal({ level: 19, grantAllowances: 1 }, proposal).valid, false);
  assert.equal(canApproveGeneratedProposal({ level: 20, grantAllowances: 0 }, proposal).valid, false);
  assert.equal(canApproveGeneratedProposal({ level: 20, grantAllowances: 1 }, proposal).valid, true);
  assert.equal(canApproveGeneratedProposal({ level: 21, grantAllowances: 1 }, proposal).valid, false);
});
