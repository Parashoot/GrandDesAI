// Coverage for scripts/combination-skills.js (C4 cloud packet: no test file existed for this module
// at all before this one). Pure, system-agnostic math -- live multi-caster Combination Skills never
// enter the PF2e/dnd5e-specific registry or Item layer here (that's lineage.js#createCombinationSource,
// covered elsewhere); this module only computes resonance/band/power/name/rationale from the
// participants' own already-approved Skills. See GAME_DESIGN.md's core loop and this module's own
// header comment for the design intent (several characters' Skills fired together, resolved,
// recorded as a growth event for every participant).
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCombinationGrowthEvent,
  buildCombinationName,
  buildCombinationSkill,
  computeCombinationResonance,
  describeCombinationRationale,
  resolveCombinationBand,
  resolveCombinationPower
} from "../scripts/combination-skills.js";
import {
  COMBINATION_MAX_POWER,
  COMBINATION_RESONANCE_STRONG_THRESHOLD,
  COMBINATION_RESONANCE_WEAK_THRESHOLD
} from "../scripts/constants.js";

function contribution(actorId, actorName, tags, tier = 1, extra = {}) {
  return {
    actorId,
    actorName,
    skill: { name: `${actorName}'s Skill`, tier, metadata: { id: `skill:${actorId}`, tags, ...extra } }
  };
}

test("computeCombinationResonance: fully overlapping tags between two casters scores 1 and shares every tag", () => {
  const { resonanceScore, sharedTags, allTags } = computeCombinationResonance([
    contribution("a", "Ayla", ["fire", "arcane"]),
    contribution("b", "Bo", ["fire", "arcane"])
  ]);
  assert.equal(resonanceScore, 1);
  assert.deepEqual(sharedTags.sort(), ["arcane", "fire"]);
  assert.deepEqual(allTags.sort(), ["arcane", "fire"]);
});

test("computeCombinationResonance: completely disjoint tags between two casters scores 0", () => {
  const { resonanceScore, sharedTags } = computeCombinationResonance([
    contribution("a", "Ayla", ["fire"]),
    contribution("b", "Bo", ["stealth"])
  ]);
  assert.equal(resonanceScore, 0);
  assert.deepEqual(sharedTags, []);
});

test("computeCombinationResonance: a third caster past two ADDS a participant bonus on top of pairwise overlap", () => {
  const two = computeCombinationResonance([
    contribution("a", "Ayla", ["fire"]),
    contribution("b", "Bo", ["fire"])
  ]);
  const three = computeCombinationResonance([
    contribution("a", "Ayla", ["fire"]),
    contribution("b", "Bo", ["fire"]),
    contribution("c", "Cass", ["fire"])
  ]);
  assert.equal(two.resonanceScore, 1); // already at the clamp ceiling
  assert.ok(three.participantBonus > 0);
  assert.equal(three.participantBonus, 0.12);
});

test("resolveCombinationBand: boundaries -- >= strong threshold is amplified, < weak threshold is discordant, between is combined", () => {
  assert.equal(resolveCombinationBand(COMBINATION_RESONANCE_STRONG_THRESHOLD), "amplified");
  assert.equal(resolveCombinationBand(COMBINATION_RESONANCE_STRONG_THRESHOLD - 0.01), "combined");
  assert.equal(resolveCombinationBand(COMBINATION_RESONANCE_WEAK_THRESHOLD), "combined", "exactly at the weak threshold is NOT discordant");
  assert.equal(resolveCombinationBand(COMBINATION_RESONANCE_WEAK_THRESHOLD - 0.01), "discordant");
});

test("resolveCombinationPower: discordant only counts the single strongest contributor's tier", () => {
  const contributions = [
    contribution("a", "Ayla", ["fire"], 3),
    contribution("b", "Bo", ["stealth"], 1)
  ];
  assert.equal(resolveCombinationPower(contributions, 0), 3);
});

test("resolveCombinationPower: combined sums every contributor's tier", () => {
  const contributions = [
    contribution("a", "Ayla", ["fire"], 2),
    contribution("b", "Bo", ["fire"], 3)
  ];
  assert.equal(resolveCombinationPower(contributions, 0.3), 5);
});

test("resolveCombinationPower: amplified multiplies the summed tiers by COMBINATION_AMPLIFIED_MULTIPLIER (1.5), rounded", () => {
  const contributions = [
    contribution("a", "Ayla", ["fire"], 2),
    contribution("b", "Bo", ["fire"], 3)
  ];
  // summed = 5, 5 * 1.5 = 7.5 -> rounds to 8
  assert.equal(resolveCombinationPower(contributions, 1), 8);
});

test("resolveCombinationPower: clamps at COMBINATION_MAX_POWER even for a huge amplified combination", () => {
  const contributions = [
    contribution("a", "A", ["fire"], 3),
    contribution("b", "B", ["fire"], 3),
    contribution("c", "C", ["fire"], 3),
    contribution("d", "D", ["fire"], 3)
  ];
  assert.equal(resolveCombinationPower(contributions, 1), COMBINATION_MAX_POWER);
});

test("buildCombinationName: discordant joins every Skill's name with slashes, ordered by tier descending", () => {
  const contributions = [
    contribution("a", "Ayla", ["fire"], 1),
    contribution("b", "Bo", ["stealth"], 3)
  ];
  const name = buildCombinationName({ contributions, resonanceScore: 0, allTags: ["fire", "stealth"] });
  assert.equal(name, "Bo's Skill / Ayla's Skill");
});

test("buildCombinationName: combined band (or amplified with only 2 casters) reads as 'Combined <strongest Skill>'", () => {
  const contributions = [
    contribution("a", "Ayla", ["fire"], 1),
    contribution("b", "Bo", ["fire"], 3)
  ];
  assert.equal(buildCombinationName({ contributions, resonanceScore: 0.3, allTags: ["fire"] }), "Combined Bo's Skill");
  // Two casters at full resonance stay on the "Combined ..." rung -- not a named title.
  assert.equal(buildCombinationName({ contributions, resonanceScore: 1, allTags: ["fire"] }), "Combined Bo's Skill");
});

test("buildCombinationName: amplified with 3+ casters earns a real title drawn from the dominant shared tag's bank", () => {
  const contributions = [
    contribution("a", "A", ["fire"], 1),
    contribution("b", "B", ["fire"], 1),
    contribution("c", "C", ["fire"], 1)
  ];
  const name = buildCombinationName({ contributions, resonanceScore: 1, allTags: ["fire"] });
  assert.equal(name, "The Converging Conflagration");
});

test("buildCombinationName: a red-polarity amplified combination at 3+ casters draws from the dark title bank instead", () => {
  const contributions = [
    contribution("a", "A", ["cruelty"], 1),
    contribution("b", "B", ["cruelty"], 1),
    contribution("c", "C", ["cruelty"], 1)
  ];
  const name = buildCombinationName({ contributions, resonanceScore: 1, allTags: ["cruelty"], polarity: "red" });
  assert.equal(name, "The Shared Atrocity");
});

test("describeCombinationRationale: text differs by band and adds a shared-cost line for red combinations", () => {
  const contributions = [contribution("a", "Ayla", ["fire"], 1), contribution("b", "Bo", ["fire"], 1)];
  const amplified = describeCombinationRationale({ contributions, resonanceScore: 1, power: 5, polarity: "standard" });
  assert.match(amplified, /amplified rather than merely stacked/);
  const discordant = describeCombinationRationale({ contributions, resonanceScore: 0, power: 1, polarity: "standard" });
  assert.match(discordant, /share too little to reinforce/);
  const combined = describeCombinationRationale({ contributions, resonanceScore: 0.3, power: 2, polarity: "standard" });
  assert.match(combined, /combined cleanly/);
  const red = describeCombinationRationale({ contributions, resonanceScore: 0.3, power: 2, polarity: "red" });
  assert.match(red, /malignance of a red contribution spreads/);
});

test("buildCombinationSkill: full pipeline produces a ready-to-use transient combination record", () => {
  const contributions = [
    contribution("a", "Ayla", ["fire", "arcane"], 2),
    contribution("b", "Bo", ["fire", "arcane"], 2)
  ];
  const combination = buildCombinationSkill({ contributions, effect: "A wall of fire erupts.", duration: "1 round" });
  assert.equal(combination.band, "amplified");
  assert.equal(combination.polarity, "standard");
  assert.equal(combination.malignance, undefined);
  assert.equal(combination.name, "Combined Ayla's Skill"); // only 2 casters, stays on the "Combined" rung
  assert.equal(combination.participants.length, 2);
  assert.equal(combination.id, "combination:combined-ayla-s-skill");
  assert.ok(combination.rationale.length > 0);
});

test("buildCombinationSkill: red is contagious -- any red contributor makes the whole combination red, with combined malignance", () => {
  const contributions = [
    contribution("a", "Ayla", ["cruelty"], 2, { polarity: "red", malignance: { vice: "cruelty", drawback: "Ayla flinches at kindness now." } }),
    contribution("b", "Bo", ["cruelty"], 2)
  ];
  const combination = buildCombinationSkill({ contributions, effect: "A cruel working." });
  assert.equal(combination.polarity, "red");
  assert.deepEqual(combination.malignance, { vice: "cruelty", drawback: "Ayla flinches at kindness now." });
});

test("buildCombinationSkill: multiple red contributors with different drawbacks get merged into one shared-cost line", () => {
  const contributions = [
    contribution("a", "Ayla", ["cruelty"], 1, { polarity: "red", malignance: { vice: "cruelty", drawback: "Cost A." } }),
    contribution("b", "Bo", ["cruelty"], 1, { polarity: "red", malignance: { vice: "cruelty", drawback: "Cost B." } })
  ];
  const combination = buildCombinationSkill({ contributions, effect: "A cruel working." });
  assert.match(combination.malignance.drawback, /Every participant shares in each red contribution's cost/);
  assert.match(combination.malignance.drawback, /Cost A\./);
  assert.match(combination.malignance.drawback, /Cost B\./);
});

test("buildCombinationSkill: explicit polarity/malignance override auto-detection", () => {
  const contributions = [contribution("a", "Ayla", ["fire"], 1), contribution("b", "Bo", ["fire"], 1)];
  const combination = buildCombinationSkill({
    contributions,
    effect: "Something dark, even though no source is flagged red.",
    polarity: "red",
    malignance: { vice: "corruption", drawback: "A hand-authored cost." }
  });
  assert.equal(combination.polarity, "red");
  assert.deepEqual(combination.malignance, { vice: "corruption", drawback: "A hand-authored cost." });
});

test("buildCombinationSkill: rejects fewer than two contributions, a contribution with no Skill, and duplicate actors", () => {
  assert.throws(() => buildCombinationSkill({ contributions: [contribution("a", "Ayla", ["fire"])], effect: "x" }), /at least two/);
  assert.throws(
    () => buildCombinationSkill({ contributions: [{ actorId: "a", actorName: "Ayla" }, contribution("b", "Bo", ["fire"])], effect: "x" }),
    /approved Skill entry/
  );
  assert.throws(
    () => buildCombinationSkill({
      contributions: [contribution("a", "Ayla", ["fire"]), contribution("a", "Ayla-again", ["fire"])],
      effect: "x"
    }),
    /different actor/
  );
});

test("buildCombinationSkill: requires a non-empty effect string", () => {
  const contributions = [contribution("a", "Ayla", ["fire"]), contribution("b", "Bo", ["fire"])];
  assert.throws(() => buildCombinationSkill({ contributions }), /requires an effect/);
  assert.throws(() => buildCombinationSkill({ contributions, effect: "   " }), /requires an effect/);
});

test("buildCombinationGrowthEvent: amplified defaults to criticalSuccess, everything else defaults to success", () => {
  const contributions = [contribution("a", "Ayla", ["fire"], 1), contribution("b", "Bo", ["fire"], 1)];
  const amplified = buildCombinationSkill({ contributions, effect: "x" }); // resonance 1 -> amplified band
  const amplifiedEvent = buildCombinationGrowthEvent(amplified, amplified.participants[0]);
  assert.equal(amplifiedEvent.outcome, "criticalSuccess");

  const discordantContributions = [contribution("a", "Ayla", ["fire"], 1), contribution("b", "Bo", ["stealth"], 1)];
  const discordant = buildCombinationSkill({ contributions: discordantContributions, effect: "x" });
  const discordantEvent = buildCombinationGrowthEvent(discordant, discordant.participants[0]);
  assert.equal(discordantEvent.outcome, "success");
});

test("buildCombinationGrowthEvent: explicit outcome overrides the band-based default, and dangerGap/occurredAt are passed through only when given", () => {
  const contributions = [contribution("a", "Ayla", ["fire"], 1), contribution("b", "Bo", ["fire"], 1)];
  const combination = buildCombinationSkill({ contributions, effect: "x" });
  const event = buildCombinationGrowthEvent(combination, combination.participants[0], {
    outcome: "failure",
    dangerGap: "severe",
    occurredAt: "2026-01-01"
  });
  assert.equal(event.outcome, "failure");
  assert.equal(event.dangerGap, "severe");
  assert.equal(event.occurredAt, "2026-01-01");

  const bare = buildCombinationGrowthEvent(combination, combination.participants[0]);
  assert.equal("dangerGap" in bare, false);
  assert.equal("occurredAt" in bare, false);
});

test("buildCombinationGrowthEvent: summary tags carry the WHOLE combination's tag set and pluralize 'other caster(s)' correctly", () => {
  const twoContributions = [contribution("a", "Ayla", ["fire"], 1), contribution("b", "Bo", ["stealth"], 1)];
  const twoCombo = buildCombinationSkill({ contributions: twoContributions, effect: "x" });
  const twoEvent = buildCombinationGrowthEvent(twoCombo, twoCombo.participants[0]);
  assert.deepEqual(twoEvent.tags.sort(), ["fire", "stealth"]);
  assert.match(twoEvent.summary, /alongside 1 other caster\./);

  const threeContributions = [
    contribution("a", "A", ["fire"], 1),
    contribution("b", "B", ["fire"], 1),
    contribution("c", "C", ["fire"], 1)
  ];
  const threeCombo = buildCombinationSkill({ contributions: threeContributions, effect: "x" });
  const threeEvent = buildCombinationGrowthEvent(threeCombo, threeCombo.participants[0]);
  assert.match(threeEvent.summary, /alongside 2 other casters\./);
});
