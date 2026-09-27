// Coverage for scripts/class-erosion.js (C4 cloud packet: no test file existed for this module at
// all before this one). Pure, system-agnostic (no PF2e/dnd5e branching -- it only reads registry
// tags and growth-event tags), so there is nothing to duplicate per system here; see GAME_DESIGN.md
// / wandering-inn-pf2e-conversion-rules.md for the design intent this checks against ("a GM ADVISORY
// check ONLY -- it never removes, docks, or modifies anything itself").
import assert from "node:assert/strict";
import test from "node:test";

import { checkClassErosion } from "../scripts/class-erosion.js";
import { CLASS_EROSION_DEFAULT_SESSION_THRESHOLD } from "../scripts/constants.js";

function registryWith(classes) {
  return { version: 1, classes, skills: {}, titles: {} };
}

function classEntry(name, tags) {
  return { name, metadata: { tags } };
}

function event({ tags, occurredAt }) {
  return { tags, occurredAt, outcome: "success" };
}

test("a Class with no tags is never flagged -- there is nothing to check its behavior against", () => {
  const registry = registryWith({ "class:mystery": classEntry("Mystery", []) });
  const events = [event({ tags: [], occurredAt: "2026-01-01" })];
  const atRisk = checkClassErosion(events, registry, { sessionThreshold: 1 });
  assert.deepEqual(atRisk, []);
});

test("a Class whose tags keep showing up in recent sessions is never flagged", () => {
  const registry = registryWith({ "class:innkeeper": classEntry("Innkeeper", ["innkeeping", "hospitality"]) });
  const events = [
    event({ tags: ["innkeeping"], occurredAt: "2026-01-01" }),
    event({ tags: ["combat"], occurredAt: "2026-01-02" }),
    event({ tags: ["hospitality"], occurredAt: "2026-01-03" })
  ];
  const atRisk = checkClassErosion(events, registry, { sessionThreshold: 3 });
  assert.deepEqual(atRisk, []);
});

test("a Class whose tags haven't appeared in >= sessionThreshold sessions is flagged, with the correct gap", () => {
  const registry = registryWith({ "class:runner": classEntry("Runner", ["running", "delivery"]) });
  const events = [
    event({ tags: ["running"], occurredAt: "2026-01-01" }), // session 0
    event({ tags: ["combat"], occurredAt: "2026-01-02" }),  // session 1
    event({ tags: ["combat"], occurredAt: "2026-01-03" }),  // session 2
    event({ tags: ["combat"], occurredAt: "2026-01-04" })   // session 3 (current)
  ];
  const atRisk = checkClassErosion(events, registry, { sessionThreshold: 3 });
  assert.equal(atRisk.length, 1);
  assert.equal(atRisk[0].classId, "class:runner");
  // last seen at session index 0, total sessions 4 -> sessionsSinceLastSeen = 4 - 1 - 0 = 3
  assert.equal(atRisk[0].sessionsSinceLastSeen, 3);
  assert.equal(atRisk[0].neverSeen, false);
});

test("a Class whose tags have NEVER matched any growth event is flagged as neverSeen once enough sessions have passed", () => {
  const registry = registryWith({ "class:king": classEntry("King", ["rulership"]) });
  const events = [
    event({ tags: ["combat"], occurredAt: "2026-01-01" }),
    event({ tags: ["combat"], occurredAt: "2026-01-02" }),
    event({ tags: ["combat"], occurredAt: "2026-01-03" })
  ];
  const atRisk = checkClassErosion(events, registry, { sessionThreshold: 3 });
  assert.equal(atRisk.length, 1);
  assert.equal(atRisk[0].classId, "class:king");
  assert.equal(atRisk[0].neverSeen, true);
  assert.equal(atRisk[0].sessionsSinceLastSeen, 3);
});

test("with zero recorded sessions, nothing is ever flagged (there is no history to judge against)", () => {
  const registry = registryWith({ "class:king": classEntry("King", ["rulership"]) });
  const atRisk = checkClassErosion([], registry, { sessionThreshold: 1 });
  assert.deepEqual(atRisk, []);
});

test("a custom sessionThreshold is honored, and the default constant is used when omitted", () => {
  const registry = registryWith({ "class:runner": classEntry("Runner", ["running"]) });
  const events = [
    event({ tags: ["running"], occurredAt: "2026-01-01" }),
    event({ tags: ["combat"], occurredAt: "2026-01-02" })
  ];
  // Only 1 session since last seen -- below a threshold of 2, so not flagged yet.
  assert.deepEqual(checkClassErosion(events, registry, { sessionThreshold: 2 }), []);
  // But flagged at threshold 1.
  const atRisk = checkClassErosion(events, registry, { sessionThreshold: 1 });
  assert.equal(atRisk.length, 1);

  // Confirm the exported default threshold used when the option is omitted entirely matches
  // CLASS_EROSION_DEFAULT_SESSION_THRESHOLD (3): build a history that is at risk only under the
  // default, not under a much higher explicit threshold.
  assert.equal(CLASS_EROSION_DEFAULT_SESSION_THRESHOLD, 3);
  const manyEvents = [
    event({ tags: ["running"], occurredAt: "2026-01-01" }),
    event({ tags: ["combat"], occurredAt: "2026-01-02" }),
    event({ tags: ["combat"], occurredAt: "2026-01-03" }),
    event({ tags: ["combat"], occurredAt: "2026-01-04" })
  ];
  const defaultResult = checkClassErosion(manyEvents, registry);
  assert.equal(defaultResult.length, 1, "the default threshold (3) should flag this history");
  assert.deepEqual(checkClassErosion(manyEvents, registry, { sessionThreshold: 10 }), []);
});

test("multiple events on the same calendar date count as one session (the documented date-as-session proxy)", () => {
  const registry = registryWith({ "class:runner": classEntry("Runner", ["running"]) });
  const events = [
    event({ tags: ["running"], occurredAt: "2026-01-01T09:00:00Z" }),
    event({ tags: ["combat"], occurredAt: "2026-01-01T20:00:00Z" }), // same date, still session 0
    event({ tags: ["combat"], occurredAt: "2026-01-02T09:00:00Z" }), // session 1
    event({ tags: ["combat"], occurredAt: "2026-01-03T09:00:00Z" })  // session 2 (current)
  ];
  const atRisk = checkClassErosion(events, registry, { sessionThreshold: 2 });
  assert.equal(atRisk.length, 1);
  assert.equal(atRisk[0].sessionsSinceLastSeen, 2);
});

test("events with no occurredAt (or a non-string one) are ignored entirely rather than breaking session counting", () => {
  const registry = registryWith({ "class:runner": classEntry("Runner", ["running"]) });
  const events = [
    event({ tags: ["running"], occurredAt: "2026-01-01" }),
    { tags: ["combat"], outcome: "success" }, // no occurredAt at all
    { tags: ["combat"], occurredAt: null, outcome: "success" },
    event({ tags: ["combat"], occurredAt: "2026-01-02" }),
    event({ tags: ["combat"], occurredAt: "2026-01-03" })
  ];
  const atRisk = checkClassErosion(events, registry, { sessionThreshold: 2 });
  assert.equal(atRisk.length, 1);
  assert.equal(atRisk[0].sessionsSinceLastSeen, 2, "the two undated events must not have been counted as sessions");
});

test("independently evaluates every approved Class against its own tags", () => {
  const registry = registryWith({
    "class:runner": classEntry("Runner", ["running"]),
    "class:innkeeper": classEntry("Innkeeper", ["innkeeping"]),
    "class:untagged": classEntry("Untagged", [])
  });
  const events = [
    event({ tags: ["running"], occurredAt: "2026-01-01" }),
    event({ tags: ["innkeeping"], occurredAt: "2026-01-02" }),
    event({ tags: ["running"], occurredAt: "2026-01-03" })
  ];
  const atRisk = checkClassErosion(events, registry, { sessionThreshold: 1 });
  const ids = atRisk.map((entry) => entry.classId).sort();
  // Runner last seen at the current (most recent) session -> not at risk.
  // Innkeeper last seen one session back -> at risk at threshold 1.
  // Untagged has no tags -> never checked at all.
  assert.deepEqual(ids, ["class:innkeeper"]);
});

test("checkClassErosion never mutates the input registry or events (pure, GM-advisory read only)", () => {
  const registry = registryWith({ "class:runner": classEntry("Runner", ["running"]) });
  const events = [
    event({ tags: ["running"], occurredAt: "2026-01-01" }),
    event({ tags: ["combat"], occurredAt: "2026-01-02" })
  ];
  const registrySnapshot = structuredClone(registry);
  const eventsSnapshot = structuredClone(events);
  checkClassErosion(events, registry, { sessionThreshold: 1 });
  assert.deepEqual(registry, registrySnapshot);
  assert.deepEqual(events, eventsSnapshot);
});

test("tolerates a missing/malformed registry.classes and a non-array events argument", () => {
  assert.deepEqual(checkClassErosion(undefined, {}), []);
  assert.deepEqual(checkClassErosion(null, { classes: {} }), []);
  assert.deepEqual(checkClassErosion("not-an-array", null), []);
});
