// Additional coverage for scripts/class-merging.js (C4 cloud packet). tests/class-merging.test.mjs
// and tests/class-merging-api.test.mjs already cover focus scoring, naming, and the happy end-to-end
// merge path; this file covers the one rule that had NO direct unit test anywhere: "off-classing"
// (wandering-inn-pf2e-conversion-rules.md doesn't name it directly, but GAME_DESIGN.md's "Record a
// new ruling before reusing it" spirit is exactly why this module's own header documents it) -- an
// evolution forced through off the Grand Design's own cadence (CLASS_EVOLUTION_LEVELS: 20/30/50)
// must never climb a power tier it wouldn't otherwise have earned, even when the merge is otherwise
// tightly focused or an intentional generalist. tests/class-merging-api.test.mjs exercises actorLevel
// only incidentally (to KEEP a preexisting on-cadence test passing after off-classing was added); it
// never actually asserts the off-cycle-capping behavior itself, which is the gap this file closes.
// System-agnostic: system_chassis is a free-text label here, never branched on by system id.
import assert from "node:assert/strict";
import test from "node:test";

import {
  describeMergeRationale,
  mergeClassEntry,
  resolveMergedPowerTier
} from "../scripts/class-merging.js";

// Shared, overlapping tags -- deliberately give computeMergeFocus a STRONG focus score (identical
// tag sets -> jaccard 1) so tests/rules-class-merging.test.mjs's mergeClassEntry-based tests (which
// run the real focus computation, unlike the resolveMergedPowerTier-direct tests below that pass
// focusScore explicitly) actually exercise the "tightly focused" branch rather than accidentally
// landing on the unrelated "unrewarded generalist" one.
function elevatedSource(id, name) {
  return { name, power_tier: "elevated", is_primary: true, metadata: { id, tags: ["martial", "precision"] } };
}

function otherElevatedSource(id, name) {
  return { name, power_tier: "elevated", is_secondary: true, metadata: { id, tags: ["martial", "precision"] } };
}

test("resolveMergedPowerTier: a tightly focused merge climbs a tier ON-cadence, but is capped at its sources' own tier OFF-cadence", () => {
  const sources = [elevatedSource("class:a", "A"), otherElevatedSource("class:b", "B")];
  assert.equal(resolveMergedPowerTier(sources, 0.9, { offCycle: false }), "prestige");
  assert.equal(resolveMergedPowerTier(sources, 0.9, { offCycle: true }), "elevated", "off-cycle never climbs beyond the strongest source's own tier");
});

test("resolveMergedPowerTier: an intentional generalist blend climbs above its sources' AVERAGE tier ON-cadence, but not OFF-cadence", () => {
  const sources = [elevatedSource("class:a", "A"), otherElevatedSource("class:b", "B")];
  assert.equal(resolveMergedPowerTier(sources, 0.05, { intentional: true, offCycle: false }), "prestige");
  assert.equal(resolveMergedPowerTier(sources, 0.05, { intentional: true, offCycle: true }), "elevated", "off-cycle floors at the highest source's tier instead of averaging up");
});

test("resolveMergedPowerTier: an unrewarded (non-intentional) generalist scatter stays 'standard' regardless of cadence", () => {
  const sources = [elevatedSource("class:a", "A"), otherElevatedSource("class:b", "B")];
  assert.equal(resolveMergedPowerTier(sources, 0.05, { intentional: false, offCycle: false }), "standard");
  assert.equal(resolveMergedPowerTier(sources, 0.05, { intentional: false, offCycle: true }), "standard");
});

test("resolveMergedPowerTier: the middle focus band always just holds at the strongest source's tier, on- or off-cadence alike", () => {
  const sources = [elevatedSource("class:a", "A"), otherElevatedSource("class:b", "B")];
  assert.equal(resolveMergedPowerTier(sources, 0.3, { offCycle: false }), "elevated");
  assert.equal(resolveMergedPowerTier(sources, 0.3, { offCycle: true }), "elevated");
});

test("resolveMergedPowerTier: off-cycle is a cap, never an additional penalty below the sources' own floor", () => {
  const sources = [elevatedSource("class:a", "A"), otherElevatedSource("class:b", "B")];
  // Middle band on-cycle already holds at "elevated" with no bonus to strip -- off-cycle must match it exactly.
  assert.equal(
    resolveMergedPowerTier(sources, 0.3, { offCycle: true }),
    resolveMergedPowerTier(sources, 0.3, { offCycle: false }),
    "off-cycle never punishes a merge that wasn't going to climb anyway"
  );
});

test("mergeClassEntry: actorLevel on a CLASS_EVOLUTION_LEVELS checkpoint (20/30/50) resolves on-cadence, off it resolves off-cadence", () => {
  const sources = [elevatedSource("class:a", "A"), otherElevatedSource("class:b", "B")];
  const shared = { sourceClasses: sources, level: 25, gameItem: { kind: "passive" }, mechanics: { effect: "x", duration: "unlimited", frequency: { max: 1, per: "unlimited" } } };

  const onCadence = mergeClassEntry({ ...shared, actorLevel: 30 });
  assert.equal(onCadence.offCycleEvolution, false);
  assert.equal(onCadence.power_tier, "prestige");

  const offCadence = mergeClassEntry({ ...shared, actorLevel: 25 });
  assert.equal(offCadence.offCycleEvolution, true);
  assert.equal(offCadence.power_tier, "elevated");
});

test("mergeClassEntry: omitting actorLevel entirely skips the off-classing check (backward compatible with actor-less callers)", () => {
  const sources = [elevatedSource("class:a", "A"), otherElevatedSource("class:b", "B")];
  const entry = mergeClassEntry({
    sourceClasses: sources,
    level: 25,
    gameItem: { kind: "passive" },
    mechanics: { effect: "x", duration: "unlimited", frequency: { max: 1, per: "unlimited" } }
  });
  assert.equal(entry.offCycleEvolution, false, "actorLevel omitted -> never flagged off-cycle");
  assert.equal(entry.power_tier, "prestige", "resolves exactly as before off-classing existed");
});

test("describeMergeRationale appends an explicit off-cadence explanation only when offCycle is true", () => {
  const sources = [elevatedSource("class:a", "A"), otherElevatedSource("class:b", "B")];
  const onCadence = describeMergeRationale({ sourceClasses: sources, focusScore: 0.9, powerTier: "prestige", offCycle: false });
  assert.equal(/Grand Design's own evolution cadence/.test(onCadence), false);
  const offCadence = describeMergeRationale({ sourceClasses: sources, focusScore: 0.9, powerTier: "elevated", offCycle: true });
  assert.match(offCadence, /Forced through off the Grand Design's own evolution cadence \(levels 20\/30\/50\)/);
});
