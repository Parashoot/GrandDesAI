// Coverage for scripts/skill-evolution.js (C4 cloud packet: no test file existed for this module at
// all before this one). Pure, system-agnostic (mirrors class-merging.js's "deterministic, no
// Math.random/Date.now" contract) -- gameItem/mechanics are always the caller's, so there is no
// PF2e/dnd5e branching inside this module itself to exercise per system. See the module's own header
// (canon: [Power Strike] becomes [Minotaur Punch]) and constants.js's SKILL_EVOLUTION_EVIDENCE_THRESHOLD/
// DANGER_GAP_MULTIPLIERS/GROWTH_EVENT_OUTCOME_WEIGHTS comments for the design intent this checks against.
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEvolvedSkillName,
  computeEvolutionPressure,
  describeEvolutionRationale,
  evolveSkillEntry,
  isDefiningMoment,
  resolveEvolvedTier
} from "../scripts/skill-evolution.js";
import { SKILL_EVOLUTION_EVIDENCE_THRESHOLD } from "../scripts/constants.js";

function skill(id, name, tier, tags, extra = {}) {
  return { name, tier, metadata: { id, tags, ...extra }, gameItem: { kind: "passive" }, mechanics: { effect: "x", duration: "unlimited", frequency: { max: 1, per: "unlimited" } } };
}

function evt({ tags, outcome = "success", occurredAt, dangerGap, id, summary }) {
  return { id, summary, tags, outcome, occurredAt, ...(dangerGap !== undefined ? { dangerGap } : {}) };
}

test("isDefiningMoment: a critical outcome (success or failure) always qualifies", () => {
  assert.equal(isDefiningMoment({ outcome: "criticalSuccess" }), true);
  assert.equal(isDefiningMoment({ outcome: "criticalFailure" }), true);
  assert.equal(isDefiningMoment({ outcome: "success" }), false);
  assert.equal(isDefiningMoment({ outcome: "failure" }), false);
});

test("isDefiningMoment: a recorded dangerGap (counter-leveling) qualifies regardless of outcome", () => {
  assert.equal(isDefiningMoment({ outcome: "success", dangerGap: "moderate" }), true);
  assert.equal(isDefiningMoment({ outcome: "failure", dangerGap: "severe" }), true);
  assert.equal(isDefiningMoment({ outcome: "success" }), false);
  assert.equal(isDefiningMoment({ outcome: "success", dangerGap: "not-a-real-gap" }), false);
});

test("isDefiningMoment tolerates a missing/null event", () => {
  assert.equal(isDefiningMoment(null), false);
  assert.equal(isDefiningMoment(undefined), false);
});

test("computeEvolutionPressure: only counts events whose tags overlap the Skill's own tags", () => {
  const source = skill("skill:strike", "Power Strike", 1, ["martial"]);
  const events = [
    evt({ tags: ["martial"], occurredAt: "2026-02-01" }),
    evt({ tags: ["stealth"], occurredAt: "2026-02-01" })
  ];
  const pressure = computeEvolutionPressure(source, events);
  assert.equal(pressure.matchedEventIds.length, 0); // neither event has an id, but evidenceWeight still only counts the matching one
  assert.equal(pressure.evidenceWeight, 1);
});

test("computeEvolutionPressure: only counts events recorded AFTER the Skill's own approvedAt by default", () => {
  const source = skill("skill:strike", "Power Strike", 1, ["martial"], {});
  source.approvedAt = "2026-02-01";
  const events = [
    evt({ tags: ["martial"], occurredAt: "2026-01-15" }), // before approval -- excluded
    evt({ tags: ["martial"], occurredAt: "2026-02-15" })  // after approval -- counted
  ];
  const pressure = computeEvolutionPressure(source, events);
  assert.equal(pressure.evidenceWeight, 1);
});

test("computeEvolutionPressure: an explicit `since` overrides approvedAt, and `since: null` counts the entire history", () => {
  const source = skill("skill:strike", "Power Strike", 1, ["martial"]);
  source.approvedAt = "2026-02-01";
  const events = [
    evt({ tags: ["martial"], occurredAt: "2026-01-01" }),
    evt({ tags: ["martial"], occurredAt: "2026-01-20" })
  ];
  // since later than both events -> nothing counts
  assert.equal(computeEvolutionPressure(source, events, { since: "2026-01-25" }).evidenceWeight, 0);
  // since: null ignores approvedAt entirely -- both pre-approval events count
  assert.equal(computeEvolutionPressure(source, events, { since: null }).evidenceWeight, 2);
});

test("computeEvolutionPressure: evidenceWeight applies the strongest matched tag's reweighted multiplier", () => {
  const source = skill("skill:strike", "Power Strike", 1, ["martial", "precision"]);
  const events = [evt({ tags: ["martial", "precision"], occurredAt: "2026-01-01" })];
  const pressure = computeEvolutionPressure(source, events, { tagWeights: { martial: 1, precision: 3 } });
  assert.equal(pressure.evidenceWeight, 3); // success (1) * strongest multiplier (3)
});

test("computeEvolutionPressure: hasCatalyst requires BOTH a defining moment AND enough weighted evidence -- neither alone is enough", () => {
  const source = skill("skill:strike", "Power Strike", 1, ["martial"]);

  // A defining moment (critical), but evidence far below threshold.
  const thinButDramatic = computeEvolutionPressure(source, [
    evt({ tags: ["martial"], outcome: "criticalSuccess", occurredAt: "2026-01-01" })
  ]);
  assert.equal(thinButDramatic.definingMoments.length, 1);
  assert.ok(thinButDramatic.evidenceWeight < SKILL_EVOLUTION_EVIDENCE_THRESHOLD);
  assert.equal(thinButDramatic.hasCatalyst, false);

  // Plenty of weighted evidence, but nothing dramatic ever happened.
  const heavyButRoutine = computeEvolutionPressure(source, [
    evt({ tags: ["martial"], outcome: "success", occurredAt: "2026-01-01" }),
    evt({ tags: ["martial"], outcome: "success", occurredAt: "2026-01-02" }),
    evt({ tags: ["martial"], outcome: "success", occurredAt: "2026-01-03" }),
    evt({ tags: ["martial"], outcome: "success", occurredAt: "2026-01-04" })
  ]);
  assert.equal(heavyButRoutine.definingMoments.length, 0);
  assert.ok(heavyButRoutine.evidenceWeight >= SKILL_EVOLUTION_EVIDENCE_THRESHOLD);
  assert.equal(heavyButRoutine.hasCatalyst, false, "grinding forever without a crisis is mastery, not transformation");

  // Both together -- grind, then a genuine crisis.
  const both = computeEvolutionPressure(source, [
    evt({ tags: ["martial"], outcome: "success", occurredAt: "2026-01-01" }),
    evt({ tags: ["martial"], outcome: "success", occurredAt: "2026-01-02" }),
    evt({ tags: ["martial"], outcome: "success", occurredAt: "2026-01-03" }),
    evt({ tags: ["martial"], outcome: "criticalSuccess", occurredAt: "2026-01-04", id: "evt-4", summary: "Survived the ambush." })
  ]);
  assert.equal(both.hasCatalyst, true);
  assert.deepEqual(both.definingMoments.map((m) => m.id), ["evt-4"]);
});

test("resolveEvolvedTier: no catalyst holds at the same tier (defaulting an invalid source tier to 1)", () => {
  assert.equal(resolveEvolvedTier(1, { hasCatalyst: false }), 1);
  assert.equal(resolveEvolvedTier(2, { hasCatalyst: false }), 2);
  assert.equal(resolveEvolvedTier(99, { hasCatalyst: false }), 1, "an invalid tier defaults to 1");
});

test("resolveEvolvedTier: a catalyst climbs exactly one tier, capped at the tier-3 ceiling", () => {
  assert.equal(resolveEvolvedTier(1, { hasCatalyst: true }), 2);
  assert.equal(resolveEvolvedTier(2, { hasCatalyst: true }), 3);
  assert.equal(resolveEvolvedTier(3, { hasCatalyst: true }), 3, "already at the ceiling -- holds, but still earns the full rename");
});

test("buildEvolvedSkillName: no catalyst always reads as a neutral 'Greater <Source>', even for a red Skill", () => {
  const source = skill("skill:strike", "Power Strike", 1, ["martial"]);
  assert.equal(buildEvolvedSkillName({ sourceSkill: source, evolvedTier: 1, hasCatalyst: false }), "Greater Power Strike");
  assert.equal(
    buildEvolvedSkillName({ sourceSkill: source, evolvedTier: 1, hasCatalyst: false, polarity: "red", vice: "cruelty" }),
    "Greater Power Strike"
  );
});

test("buildEvolvedSkillName: catalyst below the ceiling prefixes an on-theme epithet, still recognizably the source Skill", () => {
  const source = skill("skill:strike", "Power Strike", 1, ["martial"]);
  assert.equal(buildEvolvedSkillName({ sourceSkill: source, evolvedTier: 2, hasCatalyst: true }), "Cleaving Power Strike");
});

test("buildEvolvedSkillName: catalyst AT the ceiling is a wholesale rename -- the canon Power Strike -> Minotaur Punch case", () => {
  const source = skill("skill:strike", "Power Strike", 2, ["martial"]);
  assert.equal(buildEvolvedSkillName({ sourceSkill: source, evolvedTier: 3, hasCatalyst: true }), "Minotaur Punch");
});

test("buildEvolvedSkillName: an unrecognized/absent tag falls back to the default word bank", () => {
  const source = skill("skill:mystery", "Odd Trick", 1, ["completely-unknown-tag"]);
  assert.equal(
    buildEvolvedSkillName({ sourceSkill: source, evolvedTier: 2, hasCatalyst: true }),
    "Greater Odd Trick",
    "DEFAULT_EVOLVED_NAME_BANK's epithet is coincidentally also 'Greater', below the ceiling"
  );
  assert.equal(
    buildEvolvedSkillName({ sourceSkill: source, evolvedTier: 3, hasCatalyst: true }),
    "Paragon Form",
    "falls back to DEFAULT_EVOLVED_NAME_BANK's mythic/noun at the ceiling"
  );
});

test("buildEvolvedSkillName: a red Skill draws from the vice-keyed dark bank instead of the heroic tag bank, at both rungs", () => {
  const source = skill("skill:strike", "Cruel Strike", 1, ["martial"]);
  assert.equal(
    buildEvolvedSkillName({ sourceSkill: source, evolvedTier: 2, hasCatalyst: true, polarity: "red", vice: "cruelty" }),
    "Merciless Cruel Strike"
  );
  assert.equal(
    buildEvolvedSkillName({ sourceSkill: source, evolvedTier: 3, hasCatalyst: true, polarity: "red", vice: "cruelty" }),
    "Tormentor Refinement"
  );
});

test("describeEvolutionRationale: message shape depends on whether there was no defining moment at all vs merely thin evidence", () => {
  const source = skill("skill:strike", "Power Strike", 1, ["martial"]);
  const noMoment = describeEvolutionRationale({
    sourceSkill: source,
    evolvedTier: 1,
    pressure: { hasCatalyst: false, definingMoments: [], evidenceWeight: 0, evidenceThreshold: 4 }
  });
  assert.match(noMoment, /never been pushed past its limit/);

  const thinEvidence = describeEvolutionRationale({
    sourceSkill: source,
    evolvedTier: 1,
    pressure: { hasCatalyst: false, definingMoments: [{ id: "e1", summary: "A close call.", outcome: "criticalSuccess" }], evidenceWeight: 1.6, evidenceThreshold: 4 }
  });
  assert.match(thinEvidence, /practice behind it is still thin/);
});

test("describeEvolutionRationale: catalyst rationale differs at the ceiling vs below it, and a red Skill adds a malignance line", () => {
  const source = skill("skill:strike", "Power Strike", 1, ["martial"]);
  const atCeiling = describeEvolutionRationale({
    sourceSkill: source,
    evolvedTier: 3,
    pressure: { hasCatalyst: true, definingMoments: [{ id: "e1", summary: "Survived the impossible fight.", outcome: "criticalSuccess" }], evidenceWeight: 5, evidenceThreshold: 4 }
  });
  assert.match(atCeiling, /stopped being what it was/);

  const belowCeiling = describeEvolutionRationale({
    sourceSkill: source,
    evolvedTier: 2,
    pressure: { hasCatalyst: true, definingMoments: [{ id: "e1", summary: "A hard-won duel.", outcome: "criticalSuccess" }], evidenceWeight: 5, evidenceThreshold: 4 },
    polarity: "red"
  });
  assert.match(belowCeiling, /evolved to tier 2/);
  assert.match(belowCeiling, /malignance evolved right along with it/);
});

test("evolveSkillEntry: full pipeline with a catalyst produces a ready-to-approve evolved Skill entry", () => {
  const source = skill("skill:strike", "Power Strike", 2, ["martial"]);
  source.approvedAt = "2026-01-01";
  const events = [
    evt({ tags: ["martial"], outcome: "success", occurredAt: "2026-01-02" }),
    evt({ tags: ["martial"], outcome: "success", occurredAt: "2026-01-03" }),
    evt({ tags: ["martial"], outcome: "success", occurredAt: "2026-01-04" }),
    evt({ tags: ["martial"], outcome: "criticalSuccess", occurredAt: "2026-01-05", id: "e5", summary: "No business surviving that." })
  ];
  const entry = evolveSkillEntry({ sourceSkill: source, events });
  assert.equal(entry.name, "Minotaur Punch");
  assert.equal(entry.tier, 3);
  assert.equal(entry.evolution.from, "skill:strike");
  assert.equal(entry.evolution.catalyst, true);
  assert.deepEqual(entry.evolution.definingMomentIds, ["e5"]);
  assert.equal(entry.metadata.lineage.operation, "upgrade");
  assert.deepEqual(entry.metadata.lineage.sources, ["skill:strike"]);
  assert.deepEqual(entry.metadata.tags, ["martial"]);
  assert.equal(entry.system_equivalent, "Pending system equivalent review");
  // gameItem/mechanics default to the source's own, cloned rather than shared by reference.
  assert.deepEqual(entry.gameItem, source.gameItem);
  assert.notEqual(entry.gameItem, source.gameItem);
});

test("evolveSkillEntry: without a catalyst, the Skill merely refines -- 'Greater' name, unchanged tier", () => {
  const source = skill("skill:strike", "Power Strike", 1, ["martial"]);
  const entry = evolveSkillEntry({ sourceSkill: source, events: [] });
  assert.equal(entry.name, "Greater Power Strike");
  assert.equal(entry.tier, 1);
  assert.equal(entry.evolution.catalyst, false);
});

test("evolveSkillEntry: a red source's evolution inherits red polarity/malignance automatically", () => {
  const source = skill("skill:cruel", "Cruel Strike", 1, ["martial"], { polarity: "red", malignance: { vice: "cruelty", drawback: "It never stopped costing her." } });
  const entry = evolveSkillEntry({ sourceSkill: source, events: [] });
  assert.equal(entry.metadata.polarity, "red");
  assert.deepEqual(entry.metadata.malignance, { vice: "cruelty", drawback: "It never stopped costing her." });
});

test("evolveSkillEntry: explicit name/polarity/malignance/gameItem/mechanics override every derived default", () => {
  const source = skill("skill:strike", "Power Strike", 1, ["martial"]);
  const entry = evolveSkillEntry({
    sourceSkill: source,
    events: [],
    name: "Custom Name",
    polarity: "red",
    malignance: { vice: "corruption", drawback: "Hand-authored." },
    gameItem: { kind: "action" },
    mechanics: { effect: "custom", duration: "instant", frequency: { max: 1, per: "encounter" } }
  });
  assert.equal(entry.name, "Custom Name");
  assert.equal(entry.metadata.polarity, "red");
  assert.deepEqual(entry.metadata.malignance, { vice: "corruption", drawback: "Hand-authored." });
  assert.deepEqual(entry.gameItem, { kind: "action" });
});

test("evolveSkillEntry: throws when the source Skill has no registry ID to evolve from", () => {
  assert.throws(() => evolveSkillEntry({ sourceSkill: { name: "No ID", tier: 1, metadata: { tags: [] } }, events: [] }), /no registry ID/);
});
