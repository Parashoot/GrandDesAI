// Coverage for scripts/revival-penalty.js (C4 cloud packet: no test file existed for this module at
// all before this one). Pure, system-agnostic (docks levels off the actor's own strongest approved
// Class regardless of which PF2e/dnd5e chassis backs it), a one-shot GM action rather than an
// accumulating meter -- see the module's own header comment and horror-rank.js#findStrongestClass,
// which it deliberately reuses WITHOUT excludeRed (a resurrection toll is paid "regardless of what
// your strongest Class actually is", unlike Horror Rank's own docking).
import assert from "node:assert/strict";
import test from "node:test";

import { applyRevivalPenalty } from "../scripts/revival-penalty.js";
import { REVIVAL_PENALTY_LEVELS } from "../scripts/constants.js";

function registryWith(classes) {
  return { version: 1, classes, skills: {}, titles: {} };
}

function classEntry(level, { polarity } = {}) {
  return { name: `Class ${level}`, level, metadata: polarity ? { tags: [], polarity } : { tags: [] } };
}

test("docks REVIVAL_PENALTY_LEVELS from the actor's single strongest Class by default", () => {
  const registry = registryWith({ "class:hero": classEntry(15) });
  const result = applyRevivalPenalty(registry);
  assert.deepEqual(result.dockedFrom, { classId: "class:hero", levelsDocked: REVIVAL_PENALTY_LEVELS });
  assert.equal(result.registry.classes["class:hero"].level, 15 - REVIVAL_PENALTY_LEVELS);
});

test("a custom levels argument is honored instead of the default", () => {
  const registry = registryWith({ "class:hero": classEntry(15) });
  const result = applyRevivalPenalty(registry, 3);
  assert.deepEqual(result.dockedFrom, { classId: "class:hero", levelsDocked: 3 });
  assert.equal(result.registry.classes["class:hero"].level, 12);
});

test("never docks a Class below level 1, even when the requested penalty is larger than the Class's own level minus one", () => {
  const registry = registryWith({ "class:hero": classEntry(5) });
  const result = applyRevivalPenalty(registry, REVIVAL_PENALTY_LEVELS);
  assert.deepEqual(result.dockedFrom, { classId: "class:hero", levelsDocked: 4 });
  assert.equal(result.registry.classes["class:hero"].level, 1);
});

test("a Class already at level 1 has nothing eligible to dock -- dockedFrom is null and the level is unchanged", () => {
  const registry = registryWith({ "class:hero": classEntry(1) });
  const result = applyRevivalPenalty(registry);
  assert.equal(result.dockedFrom, null);
  assert.equal(result.registry.classes["class:hero"].level, 1);
});

test("an empty registry has no eligible Class at all -- dockedFrom is null", () => {
  const result = applyRevivalPenalty(registryWith({}));
  assert.equal(result.dockedFrom, null);
});

test("UNLIKE Horror Rank, revival penalty is willing to dock a red-polarity Class when it's the strongest one", () => {
  const registry = registryWith({
    "class:standard": classEntry(8),
    "class:red": classEntry(20, { polarity: "red" })
  });
  const result = applyRevivalPenalty(registry, 5);
  assert.deepEqual(result.dockedFrom, { classId: "class:red", levelsDocked: 5 }, "death is a toll paid regardless of polarity");
  assert.equal(result.registry.classes["class:red"].level, 15);
  assert.equal(result.registry.classes["class:standard"].level, 8, "the non-strongest Class is untouched");
});

test("docks from exactly one Class -- never split across multiple Classes even when several are approved", () => {
  const registry = registryWith({
    "class:strongest": classEntry(20),
    "class:secondary": classEntry(12),
    "class:tertiary": classEntry(5)
  });
  const result = applyRevivalPenalty(registry, 6);
  assert.deepEqual(result.dockedFrom, { classId: "class:strongest", levelsDocked: 6 });
  assert.equal(result.registry.classes["class:secondary"].level, 12);
  assert.equal(result.registry.classes["class:tertiary"].level, 5);
});

test("applyRevivalPenalty never mutates the input registry (always returns a fresh clone)", () => {
  const registry = registryWith({ "class:hero": classEntry(15) });
  const snapshot = structuredClone(registry);
  applyRevivalPenalty(registry);
  assert.deepEqual(registry, snapshot);
});

test("a non-finite levels argument falls back to REVIVAL_PENALTY_LEVELS", () => {
  const registry = registryWith({ "class:hero": classEntry(30) });
  const result = applyRevivalPenalty(registry, NaN);
  assert.equal(result.dockedFrom.levelsDocked, REVIVAL_PENALTY_LEVELS);
});
