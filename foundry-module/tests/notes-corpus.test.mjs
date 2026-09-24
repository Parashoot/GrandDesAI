import assert from "node:assert/strict";
import test from "node:test";

import { explainSessionNotes } from "../scripts/session-notes.js";

// A HELD-OUT calibration corpus for the local session-notes analyzer.
//
// Why this file exists. The taxonomy patterns in growth-taxonomy.js were recalibrated on
// 2026-08-24 after the analyzer was found to extract ZERO events from thirty sentences of ordinary
// session notes. The recalibration was measured against the very prose it was tuned on, which
// proves nothing -- a keyword matcher can always be made to score perfectly on its own training
// text. This corpus is the honest check: a different campaign, a different GM's voice, and mostly
// disciplines the patterns were NOT tuned for (court intrigue, wilderness, ritual magic, animal
// husbandry, mounted and ranged combat, performance, faith) instead of the original's urban
// canal-heist vocabulary.
//
// It caught four real misses on its first run, two of them expensive: "held the gatehouse until
// dawn" (which also carried a danger gap, so the single highest-value event type was being
// discarded) and "critically failed the binding" (a defining moment, likewise discarded). Both
// were the same bug class -- a verb and its object separated by words the pattern did not allow.
//
// Treat this corpus as fixed. When a pattern changes, this file says whether the change
// generalizes or merely fits the example that motivated it. Add cases when a real GM's notes miss;
// do not edit an existing case to make a failing pattern pass.
const CORPUS = [
  // --- should produce evidence, with the discipline a GM would expect ---
  ["Sera curtsied to the Margrave and steered the conversation away from her brother.", "diplomacy"],
  ["She lied about where she had been the night before, and he believed her.", "deception"],
  ["Halvard tracked the boar three miles through wet bracken.", "survival"],
  ["He made camp under an overhang before the storm broke.", "survival"],
  ["The old priest prayed over the body until dawn.", "religion"],
  ["Sera sang the lament at the vigil and half the hall wept.", "performance"],
  ["Halvard loosed an arrow through the stag's throat at ninety paces.", "ranged"],
  ["He shot twice more before the herd scattered.", "ranged"],
  ["Mirren ground the reagents and distilled a fresh tincture.", "alchemy"],
  ["She brewed a potion that actually held its potency this time.", "alchemy"],
  ["Halvard splinted the mare's foreleg and kept her calm.", "medicine"],
  ["Mirren traced the sigil in chalk and spoke the incantation.", "occultism"],
  ["The ward held through the whole night.", "occultism"],
  ["Sera recalled the precedent from a treaty two centuries old.", "lore"],
  ["She deciphered the marginalia on the third reading.", "lore"],
  ["Halvard forged a new bit for the bridle out of scrap.", "craft"],
  ["He repaired the wagon axle by lamplight.", "craft"],
  ["Mirren cast a cantrip to light the cellar stairs.", "spellcasting"],
  ["Sera stared the steward down until he looked away.", "intimidation"],
  ["Halvard hauled the fallen beam off the stablehand.", "athletics"],
  ["He carried the boy back to the house himself.", "athletics"],
  ["Mirren crept along the gallery, keeping to the shadows.", "stealth"],
  ["Sera negotiated the grain price down by a third.", "diplomacy"],
  ["Halvard vaulted the paddock fence without breaking stride.", "acrobatics"],
  ["They were badly outnumbered but held the gatehouse until dawn.", "defense"],
  ["Mirren critically failed the binding and the circle guttered out.", "occultism"],

  // --- should produce nothing: intentions and background, not things that happened ---
  ["Sera wanted to challenge him openly.", null],
  ["Halvard was going to ride out at first light.", null],
  ["The hall had already been swept and dressed for the feast.", null],
  ["It was a long evening and everyone was tired.", null],
  ["They talked for some time about nothing in particular.", null]
];

const NOTES = CORPUS.map(([sentence]) => sentence).join(" ");

function analyze() {
  const { events } = explainSessionNotes(NOTES);
  return new Map(events.map((event) => [event.summary, event]));
}

test("held-out corpus: every sentence describing a real action is recognized", () => {
  const found = analyze();
  const misses = [];
  for (const [sentence, expected] of CORPUS) {
    if (expected === null) continue;
    const event = found.get(sentence);
    if (!event) misses.push(`DROPPED ENTIRELY (wanted ${expected}): "${sentence}"`);
    else if (!event.tags.includes(expected)) misses.push(`wanted ${expected}, got [${event.tags}]: "${sentence}"`);
  }
  assert.deepEqual(misses, [], `${misses.length} sentence(s) a GM would expect to count produced nothing useful`);
});

test("held-out corpus: intentions and background produce no evidence at all", () => {
  const found = analyze();
  const falsePositives = CORPUS
    .filter(([, expected]) => expected === null)
    .filter(([sentence]) => found.has(sentence))
    .map(([sentence]) => `"${sentence}" was tagged [${found.get(sentence).tags}]`);
  assert.deepEqual(falsePositives, [], "crediting a character for something nobody did inflates their history with fiction");
});

test("held-out corpus: the high-value event types survive, not just the easy ones", () => {
  const found = analyze();

  // A danger gap is the most valuable signal the system has -- counter-leveling multiplies
  // progression by up to 2.5x -- and it is worthless if the sentence carrying it is discarded
  // before the gap is ever read. This exact sentence was being dropped before this corpus existed.
  const outnumbered = found.get("They were badly outnumbered but held the gatehouse until dawn.");
  assert.ok(outnumbered, "the danger-gap sentence must survive tagging to have its gap read at all");
  assert.equal(outnumbered.dangerGap, "moderate");
  assert.ok(outnumbered.tags.includes("defense"));

  // A critical failure is a defining moment, which is half of what a Skill needs to evolve.
  const failedBinding = found.get("Mirren critically failed the binding and the circle guttered out.");
  assert.ok(failedBinding, "the critical-failure sentence must survive tagging");
  assert.equal(failedBinding.outcome, "criticalFailure");
  assert.equal(failedBinding.outcomeInferred, false, "explicit wording must win over the inferred default");
});

test("held-out corpus: overall recall stays at or above the level this file was pinned at", () => {
  const found = analyze();
  const shouldCount = CORPUS.filter(([, expected]) => expected !== null);
  const hits = shouldCount.filter(([sentence, expected]) => found.get(sentence)?.tags.includes(expected)).length;
  const recall = hits / shouldCount.length;
  assert.ok(recall >= 1, `recall regressed to ${(recall * 100).toFixed(0)}% (${hits}/${shouldCount.length}); it was 100% when pinned`);
});
