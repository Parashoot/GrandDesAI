import assert from "node:assert/strict";
import test from "node:test";

import { explainSessionNotes } from "../scripts/session-notes.js";

// A second held-out pass (2026-09-02), following the same rule as notes-corpus.test.mjs: measure
// against sentence SHAPES the analyzer had not been tested against, not against the prose that
// motivated a fix. Where notes-corpus.test.mjs is about vocabulary coverage (does the pattern know
// the verb at all), this file is about sentence structure -- cases where the right tag can be
// present and the right call is still to produce nothing, or to produce a different outcome than
// the tag's own outcome wording implies.
//
// The first fix attempt in this pass (a blanket "drop any event whose only tags are ambient" rule)
// broke two ALREADY-PINNED tests: "Kesh burned the rest of it down." and "...secured the flooded
// sluice gate..." are real actions whose only lexical hook happens to be an elemental/environment
// tag, and got discarded right alongside actual weather description. The corrected rule
// (growth-taxonomy.js#isAmbientScenery) checks the sentence's grammatical subject, not just which
// tag fired. Keep that distinction in mind before tightening any of the patterns below further.
test("pure scene-setting produces no event even when a tag matches", () => {
  const scenery = [
    "It was cold and the wind cut through their cloaks.",
    "The river was high and brown from the storm.",
    "Rain hammered the tin roof all night.",
    "Thunder rolled somewhere over the hills.",
    "The old walls were crumbling and slick with moss.",
    "The air in the crypt was thick with dust."
  ];
  for (const sentence of scenery) {
    const { events } = explainSessionNotes(sentence);
    assert.equal(events.length, 0, `"${sentence}" describes weather/terrain, not a character acting`);
  }
});

// The counterpart to the scenery cases above: a sentence whose ONLY tag hook is an ambient word
// (fire, water, ...) but whose subject is a named character doing something must still be kept.
// This is the exact regression the corrected rule above exists to prevent.
test("an ambient-tagged sentence with an actual actor and verb is still kept", () => {
  const { events } = explainSessionNotes("Kesh burned the rest of it down.");
  assert.equal(events.length, 1);
  assert.ok(events[0].tags.includes("fire"));
});

test("an attempt that explicitly did not happen produces no event", () => {
  const negated = [
    "She never even tried to persuade the guard.",
    "He refused to even attempt the climb.",
    "Nobody bothered to check the door for traps."
  ];
  for (const sentence of negated) {
    const { events } = explainSessionNotes(sentence);
    assert.equal(events.length, 0, `"${sentence}" says the thing was NOT done`);
  }
});

test("a question is not treated as an assertion that something happened", () => {
  const { events } = explainSessionNotes("Did anyone actually check the door for traps?");
  assert.equal(events.length, 0);
});

test("'almost/nearly ... but' reads as a failed attempt, not the default success", () => {
  const almostFailed = explainSessionNotes("He almost picked the lock but the pick snapped in the mechanism.").events;
  assert.equal(almostFailed.length, 1);
  assert.equal(almostFailed[0].outcome, "failure");
  assert.ok(almostFailed[0].tags.includes("thievery"));

  const nearlyFailed = explainSessionNotes("She nearly talked him down, but he drew his sword anyway.").events;
  assert.equal(nearlyFailed.length, 1);
  assert.equal(nearlyFailed[0].outcome, "failure");
});

test("'succeeded' with a negated object is a failure, not a success", () => {
  const { events } = explainSessionNotes("He succeeded in convincing absolutely no one.");
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "failure");
});

test("disarm, trip, and knock-away are recognized as martial actions", () => {
  const cases = [
    ['"I yield," the bandit said after Sera disarmed him.', "martial"],
    ["Halvard tripped the charging boar with his spear haft.", "martial"],
    ["Mirren knocked the wand from the cultist's hand.", "martial"]
  ];
  for (const [sentence, expectedTag] of cases) {
    const [event] = explainSessionNotes(sentence).events;
    assert.ok(event, `"${sentence}" produced no event at all`);
    assert.ok(event.tags.includes(expectedTag), `"${sentence}" -> [${event?.tags}], expected to include ${expectedTag}`);
  }
});

test("present-tense narration is recognized the same as past-tense", () => {
  const [event] = explainSessionNotes("Sera sneaks past the watchman and signals the others.").events;
  assert.ok(event);
  assert.ok(event.tags.includes("stealth"));
});
