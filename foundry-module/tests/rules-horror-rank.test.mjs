// Coverage for scripts/horror-rank.js (C4 cloud packet: no test file existed for this module at
// all before this one). Pure, system-agnostic corruption-meter math (see
// wandering-inn-pf2e-conversion-rules.md Section 6, "a Corruption-style clock, not a class"; the
// module docs its own contagion rule: Horror Rank never docks a red-polarity Class, only standard
// ones, because "the corruption has nowhere left to go but the red Classes themselves, which this
// function deliberately never touches").
import assert from "node:assert/strict";
import test from "node:test";

import {
  applyHorrorRankIncrement,
  emptyHorrorRank,
  findStrongestClass,
  normalizeHorrorRank
} from "../scripts/horror-rank.js";
import { HORROR_RANK_LEVEL_PENALTY, HORROR_RANK_THRESHOLD } from "../scripts/constants.js";

function registryWith(classes) {
  return { version: 1, classes, skills: {}, titles: {} };
}

function classEntry(level, { polarity } = {}) {
  return { name: `Class ${level}`, level, metadata: polarity ? { tags: [], polarity } : { tags: [] } };
}

test("emptyHorrorRank starts at zero points and zero total docked", () => {
  assert.deepEqual(emptyHorrorRank(), { points: 0, totalLevelsDocked: 0 });
});

test("normalizeHorrorRank defaults invalid/negative/missing values to zero, and passes through valid ones", () => {
  assert.deepEqual(normalizeHorrorRank(undefined), { points: 0, totalLevelsDocked: 0 });
  assert.deepEqual(normalizeHorrorRank(null), { points: 0, totalLevelsDocked: 0 });
  assert.deepEqual(normalizeHorrorRank({ points: -5, totalLevelsDocked: -1 }), { points: 0, totalLevelsDocked: 0 });
  assert.deepEqual(normalizeHorrorRank({ points: 40, totalLevelsDocked: 2.5 }), { points: 40, totalLevelsDocked: 0 });
  assert.deepEqual(normalizeHorrorRank({ points: 40, totalLevelsDocked: 2 }), { points: 40, totalLevelsDocked: 2 });
});

test("findStrongestClass picks the highest-level Class, excluding non-integer levels", () => {
  const registry = registryWith({
    "class:a": classEntry(5),
    "class:b": classEntry(9),
    "class:c": { name: "Broken", level: NaN, metadata: { tags: [] } }
  });
  const best = findStrongestClass(registry);
  assert.equal(best.id, "class:b");
});

test("findStrongestClass excludeRed:true skips red-polarity Classes even if they're the strongest", () => {
  const registry = registryWith({
    "class:standard": classEntry(4),
    "class:red": classEntry(9, { polarity: "red" })
  });
  assert.equal(findStrongestClass(registry, { excludeRed: true }).id, "class:standard");
  // Without the option, the red Class (as the strongest) wins -- used by revival-penalty.js on purpose.
  assert.equal(findStrongestClass(registry).id, "class:red");
});

test("findStrongestClass returns null for an empty or malformed registry", () => {
  assert.equal(findStrongestClass(registryWith({})), null);
  assert.equal(findStrongestClass({}), null);
  assert.equal(findStrongestClass(undefined), null);
});

test("accumulating points below the threshold docks nothing and just carries the points forward", () => {
  const registry = registryWith({ "class:hero": classEntry(10) });
  const result = applyHorrorRankIncrement(registry, emptyHorrorRank(), HORROR_RANK_THRESHOLD - 1);
  assert.equal(result.horrorRank.points, HORROR_RANK_THRESHOLD - 1);
  assert.equal(result.horrorRank.totalLevelsDocked, 0);
  assert.deepEqual(result.dockedFrom, []);
  assert.equal(result.registry.classes["class:hero"].level, 10, "no docking below threshold");
});

test("crossing the threshold docks HORROR_RANK_LEVEL_PENALTY levels from the strongest standard Class, and consumes the points", () => {
  const registry = registryWith({ "class:hero": classEntry(10) });
  const result = applyHorrorRankIncrement(registry, emptyHorrorRank(), HORROR_RANK_THRESHOLD);
  assert.equal(result.horrorRank.points, 0);
  assert.equal(result.horrorRank.totalLevelsDocked, HORROR_RANK_LEVEL_PENALTY);
  assert.deepEqual(result.dockedFrom, [{ classId: "class:hero", levelsDocked: HORROR_RANK_LEVEL_PENALTY }]);
  assert.equal(result.registry.classes["class:hero"].level, 10 - HORROR_RANK_LEVEL_PENALTY);
});

test("a single large increment can cross the threshold multiple times, docking once per crossing", () => {
  const registry = registryWith({ "class:hero": classEntry(20) });
  const amount = HORROR_RANK_THRESHOLD * 2 + 50; // crosses twice, 50 points left over
  const result = applyHorrorRankIncrement(registry, emptyHorrorRank(), amount);
  assert.equal(result.horrorRank.points, 50);
  assert.equal(result.horrorRank.totalLevelsDocked, HORROR_RANK_LEVEL_PENALTY * 2);
  assert.equal(result.dockedFrom.length, 2);
  assert.equal(result.registry.classes["class:hero"].level, 20 - HORROR_RANK_LEVEL_PENALTY * 2);
});

test("never docks a red-polarity Class -- it erodes the strongest standard one instead, even if the red one is stronger", () => {
  const registry = registryWith({
    "class:weak-standard": classEntry(3),
    "class:strong-red": classEntry(30, { polarity: "red" })
  });
  const result = applyHorrorRankIncrement(registry, emptyHorrorRank(), HORROR_RANK_THRESHOLD);
  assert.deepEqual(result.dockedFrom, [{ classId: "class:weak-standard", levelsDocked: HORROR_RANK_LEVEL_PENALTY }]);
  assert.equal(result.registry.classes["class:strong-red"].level, 30, "the red Class is never touched by Horror Rank");
});

test("a threshold crossing with no eligible standard-polarity Class still consumes the points, with nothing docked", () => {
  const registry = registryWith({ "class:only-red": classEntry(30, { polarity: "red" }) });
  const result = applyHorrorRankIncrement(registry, emptyHorrorRank(), HORROR_RANK_THRESHOLD);
  assert.equal(result.horrorRank.points, 0, "points are consumed even with nothing to dock");
  assert.equal(result.horrorRank.totalLevelsDocked, 0);
  assert.deepEqual(result.dockedFrom, []);
});

test("an eligible Class already at level 1 cannot be docked below 1 -- points are consumed but nothing changes", () => {
  const registry = registryWith({ "class:bottomed-out": classEntry(1) });
  const result = applyHorrorRankIncrement(registry, emptyHorrorRank(), HORROR_RANK_THRESHOLD);
  assert.equal(result.horrorRank.points, 0);
  assert.deepEqual(result.dockedFrom, []);
  assert.equal(result.registry.classes["class:bottomed-out"].level, 1);
});

test("docking is clamped so a level-2 Class only loses 1 level (never below 1), even though the penalty is 2", () => {
  const registry = registryWith({ "class:almost-bottom": classEntry(2) });
  const result = applyHorrorRankIncrement(registry, emptyHorrorRank(), HORROR_RANK_THRESHOLD);
  assert.deepEqual(result.dockedFrom, [{ classId: "class:almost-bottom", levelsDocked: 1 }]);
  assert.equal(result.registry.classes["class:almost-bottom"].level, 1);
});

test("existing Horror Rank state's points and totalLevelsDocked carry forward and add up correctly", () => {
  const registry = registryWith({ "class:hero": classEntry(10) });
  const startingState = { points: HORROR_RANK_THRESHOLD - 10, totalLevelsDocked: 6 };
  const result = applyHorrorRankIncrement(registry, startingState, 10);
  assert.equal(result.horrorRank.points, 0);
  assert.equal(result.horrorRank.totalLevelsDocked, 6 + HORROR_RANK_LEVEL_PENALTY);
});

test("applyHorrorRankIncrement never mutates the input registry (always returns a fresh clone)", () => {
  const registry = registryWith({ "class:hero": classEntry(10) });
  const snapshot = structuredClone(registry);
  applyHorrorRankIncrement(registry, emptyHorrorRank(), HORROR_RANK_THRESHOLD);
  assert.deepEqual(registry, snapshot);
});

test("a non-finite amount is treated as zero, so nothing crosses the threshold on its own", () => {
  const registry = registryWith({ "class:hero": classEntry(10) });
  const result = applyHorrorRankIncrement(registry, emptyHorrorRank(), NaN);
  assert.equal(result.horrorRank.points, 0);
  assert.deepEqual(result.dockedFrom, []);
});
