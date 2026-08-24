import assert from "node:assert/strict";
import test from "node:test";

import { validateClassEntry, validateSkillEntry } from "../scripts/validator.js";

function baseClass(overrides = {}) {
  return {
    name: "Bloodbound Reaver",
    level: 5,
    power_tier: "elevated",
    gameItem: { kind: "passive" },
    mechanics: { effect: "Deal 1 extra damage against a bloodied foe.", duration: "instant", frequency: { max: 1, per: "round" } },
    metadata: { tags: ["martial"] },
    ...overrides
  };
}

function baseSkill(overrides = {}) {
  return {
    name: "Wine-Sworn",
    tier: 2,
    system_equivalent: "Narrative vice-driven skill",
    gameItem: { kind: "passive" },
    mechanics: { effect: "Advantage on Persuasion checks made while drinking with a target.", duration: "1 hour", frequency: { max: 1, per: "day" } },
    metadata: { tags: ["support"] },
    ...overrides
  };
}

test("an ordinary standard-polarity Class entry validates with no polarity field at all", () => {
  const result = validateClassEntry(baseClass());
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("an explicit metadata.polarity: 'standard' Class entry validates fine on its own", () => {
  const result = validateClassEntry(baseClass({ metadata: { tags: ["martial"], polarity: "standard" } }));
  assert.deepEqual(result.errors, []);
});

test("metadata.polarity must be 'standard' or 'red' -- anything else is rejected", () => {
  const result = validateClassEntry(baseClass({ metadata: { tags: ["martial"], polarity: "evil" } }));
  assert.match(result.errors.join(" "), /polarity must be/i);
});

test("a red Class entry without metadata.malignance is rejected", () => {
  const result = validateClassEntry(baseClass({ metadata: { tags: ["martial"], polarity: "red" } }));
  assert.match(result.errors.join(" "), /malignance\.vice.*malignance\.drawback/i);
});

test("a red Class entry with an unrecognized vice is rejected", () => {
  const result = validateClassEntry(baseClass({
    metadata: { tags: ["martial"], polarity: "red", malignance: { vice: "greed", drawback: "Something." } }
  }));
  assert.match(result.errors.join(" "), /malignance\.vice must be one of/i);
});

test("a fully-formed red Class entry (vice from the closed taxonomy, non-empty drawback) validates cleanly", () => {
  const result = validateClassEntry(baseClass({
    metadata: {
      tags: ["martial"],
      polarity: "red",
      malignance: { vice: "bloodlust", drawback: "Cannot willingly disengage from a bloodied foe without a Will save." }
    }
  }));
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("red polarity validation applies to Skills too, not just Classes", () => {
  const missing = validateSkillEntry(baseSkill({ metadata: { tags: ["support"], polarity: "red" } }));
  assert.match(missing.errors.join(" "), /malignance/i);

  const valid = validateSkillEntry(baseSkill({
    metadata: { tags: ["support"], polarity: "red", malignance: { vice: "addiction", drawback: "Disadvantage on the first check of the day until the craving is fed." } }
  }));
  assert.deepEqual(valid.errors, []);
});
