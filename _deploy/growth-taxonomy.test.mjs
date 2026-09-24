import assert from "node:assert/strict";
import test from "node:test";

import { analyzeSessionNotes, explainSessionNotes } from "../scripts/session-notes.js";
import { generateSkillProposals } from "../scripts/progression.js";
import { outcomeFromSentence } from "../scripts/growth-taxonomy.js";

test("outcomeFromSentence recognizes failure and dramatic/critical failure, not just success", () => {
  assert.equal(outcomeFromSentence("Mera fumbled the crossing and fell into the canal."), "failure");
  assert.equal(outcomeFromSentence("Kellin's makeshift bomb misfired in his hands."), "failure");
  assert.equal(outcomeFromSentence("The alchemical mix critically failed and badly burned her hands."), "criticalFailure");
  assert.equal(outcomeFromSentence("The device catastrophically backfired, blowing up in his face."), "criticalFailure");
  // Plain "critically" without a failure word nearby stays a critical success, unchanged behavior.
  assert.equal(outcomeFromSentence("She critically struck the weak point and defeated the beast."), "criticalSuccess");
});

test("taxonomy recognizes diverse PF2e gameplay language", () => {
  const events = analyzeSessionNotes(
    "The wizard critically cast an arcane lightning spell and defeated the storm spirit. " +
    "The scout tracked the beast through the forest and secured the trail. " +
    "The medic healed, protected, and saved the wounded guard."
  );

  assert.deepEqual(events[0].tags.sort(), ["arcane", "electricity", "occultism", "spellcasting"]);
  assert.deepEqual(events[1].tags.sort(), ["nature", "survival"]);
  // "the wounded guard" is a PERSON being treated, not a defensive action by the medic. The
  // original expectation here included "defense", which the taxonomy only produced because its
  // pattern was `guard(?:ed|ing)?` -- the optional suffix let the bare noun match. That is the
  // exact class of false positive that made the analyzer credit characters with evidence for
  // things nobody did, so the pattern now requires a verb form (guarded/guarding) and this
  // expectation is corrected to match reality rather than the old behavior.
  assert.deepEqual(events[2].tags.sort(), ["medicine", "support"]);
});

test("a tagged sentence with no explicit outcome wording is still recorded, inferred as a success", () => {
  // The regression that made the local analyzer useless: real session notes almost never contain
  // the ~20 literal outcome verbs outcomeFromSentence knows ("succeeded", "secured", "won"...),
  // and outcome used to be a hard precondition, so ordinary narrative prose produced zero events.
  const events = analyzeSessionNotes("She parried the guard's blade and drove him into the canal.");
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "success");
  assert.equal(events[0].outcomeInferred, true);
  assert.ok(events[0].tags.includes("martial"));

  // Explicit wording still wins, and is marked as not inferred.
  const explicit = analyzeSessionNotes("She critically struck the weak point.");
  assert.equal(explicit[0].outcome, "criticalSuccess");
  assert.equal(explicit[0].outcomeInferred, false);

  const failed = analyzeSessionNotes("He fumbled the lockpick and the tumbler jammed.");
  assert.equal(failed[0].outcome, "failure");
});

test("intent-only and background sentences are dropped instead of counted as things that happened", () => {
  assert.deepEqual(analyzeSessionNotes("Kesh wanted to burn the rest of it down."), []);
  assert.deepEqual(analyzeSessionNotes("They were going to climb the seawall."), []);
  assert.deepEqual(analyzeSessionNotes("Inside, the ledgers had already been burned."), []);
  // ...but the same subject actually doing it is kept.
  assert.equal(analyzeSessionNotes("Kesh burned the rest of it down.").length, 1);
});

test("explainSessionNotes reports why nothing was kept instead of silently returning zero", () => {
  const { events, diagnostics } = explainSessionNotes("They talked for a while. Nothing much happened. Everyone went to bed.");
  assert.equal(events.length, 0);
  assert.equal(diagnostics.sentences, 3);
  assert.equal(diagnostics.kept, 0);
  assert.equal(diagnostics.droppedNoTag, 3);
  assert.match(diagnostics.hint, /gameplay tag vocabulary/);
  assert.match(diagnostics.hint, /adapter/, "the hint must point at the AI path, which is the real fix for prose the keyword matcher can't read");
  assert.equal(diagnostics.dropped.length, 3);

  const productive = explainSessionNotes("She parried the blade and drove him into the canal.");
  assert.equal(productive.diagnostics.kept, 1);
  assert.equal(productive.diagnostics.hint, null, "no hint when the analyzer actually produced something");
});

test("the inflections real GMs write are recognized, not just the fixture vocabulary", () => {
  // Every one of these returned ZERO tags before the 2026-08-24 recalibration.
  const cases = [
    ["She parried the blow.", "martial"],
    ["He fought them off in the dark.", "martial"],
    ["Torv picked the lock on the door.", "thievery"],
    ["Oma bound the wound with a strip of cloth.", "medicine"],
    ["Kesh carried her the last stretch.", "athletics"],
    ["She finished the binding circle.", "occultism"],
    ["Torv talked her out of it.", "diplomacy"],
    ["Oma stayed low behind the crates.", "stealth"],
    ["Kesh held it off the others for six rounds.", "defense"],
    ["He crept past the sentry.", "stealth"]
  ];
  for (const [sentence, expectedTag] of cases) {
    const [event] = analyzeSessionNotes(sentence);
    assert.ok(event, `"${sentence}" produced no event at all`);
    assert.ok(event.tags.includes(expectedTag), `"${sentence}" -> [${event.tags}], expected to include ${expectedTag}`);
  }
});

test("expanded proposal library produces separate bounded drafts", () => {
  const events = [
    ...Array.from({ length: 3 }, (_, index) => ({
      id: `cold-${index}`,
      summary: "Cast a cold spell successfully.",
      tags: ["cold", "spellcasting"],
      outcome: "success"
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      id: `medic-${index}`,
      summary: "Healed and supported an ally.",
      tags: ["medicine", "support"],
      outcome: "success"
    }))
  ];

  const ids = generateSkillProposals(events, { skills: {} }, 9).map((proposal) => proposal.id).sort();

  assert.deepEqual(ids, ["proposal:field-triage", "proposal:winter-veil"]);
});
