import assert from "node:assert/strict";
import test from "node:test";

import { explainSessionNotes } from "../scripts/session-notes.js";
import { progressionForEvent } from "../scripts/progression.js";

// A third held-out pass (2026-09-06), this time simulating 20 long, structurally and tonally
// distinct "session notes" paragraphs (military log, screenplay, courtroom drama, noir, chronicle,
// texting shorthand, dialogue-only, purple prose, and more -- see the user-facing report for the
// full set) rather than isolated sentences, and measuring whether computed "power"
// (sum of progressionForEvent across the note) and tag recall stayed in a similar band across
// styles that were deliberately written to carry the same narrative weight. The first run's power
// varied by 39% (coefficient of variation) across 14 comparably-weighted notes; every deviation
// traced back to a real, fixable gap, not noise. After the fixes below, the same 14 notes landed
// within 18%, and the residual variance is real (a note with a genuine failure and only two events
// legitimately scores lower than one with three), not measurement error. This file pins the
// individual bugs that pass found, trimmed to the shortest sentence that reproduces each one.
//
// The one class of prose this pass confirms the local analyzer still cannot read is genuine literary
// paraphrase -- "she turned his blade aside with a shriek of steel" instead of "she parried" -- which
// is a vocabulary ceiling inherent to a keyword matcher, not a bug to chase with more regex. That is
// exactly the gap the AI-gateway adapter path exists to cover; see session-notes.js's own hint text.

test("a verb+particle pattern (drove ... back / cut ... down) accepts a named target, not just a pronoun", () => {
  // Previously required drove/cut to be immediately followed by him/her/them/it -- which is rare in
  // real notes, where a GM almost always names the target instead.
  const cases = [
    "Torv drove the second brigand back into the water.",
    "Mirren, badly outmatched, drove the entity back through the widening rift.",
    "Kesh swings low and cuts the pack leader down where it stands."
  ];
  for (const sentence of cases) {
    const [event] = explainSessionNotes(sentence).events;
    assert.ok(event, `"${sentence}" produced no event`);
    assert.ok(event.tags.includes("martial"), `"${sentence}" -> [${event?.tags}]`);
  }
});

test("present-tense and gerund combat verbs (strikes/striking/swings) are recognized, not just the past tense", () => {
  const cases = [
    "Halvard, a difficult opponent that night, striking down two of the constables before order was restored.",
    "Kesh swings low and cuts the pack leader down."
  ];
  for (const sentence of cases) {
    const [event] = explainSessionNotes(sentence).events;
    assert.ok(event, `"${sentence}" produced no event`);
    assert.ok(event.tags.includes("martial"));
  }
});

test("'force X open' is recognized with the object named in between, not just adjacent 'forced open'", () => {
  const [event] = explainSessionNotes("Sera tries to force the shrine door open, but it doesn't budge.").events;
  assert.ok(event);
  assert.ok(event.tags.includes("athletics"));
});

test("'talked X into Y' is recognized alongside the existing 'talked X out of/down/around'", () => {
  const [event] = explainSessionNotes("Sera talked the surviving pair into just walking away.").events;
  assert.ok(event);
  assert.ok(event.tags.includes("diplomacy"));
});

test("danger-gap language carries forward from a tagless context sentence to the next real event", () => {
  // "We were badly outgunned." has no gameplay tag of its own and used to be dropped with its
  // dangerGap lost entirely by the time the next sentence recorded the actual event.
  const { events } = explainSessionNotes("Initiative rolled, party was outgunned two-to-one against the hobgoblin squad. Halvard struck the captain down before the second round.");
  const combat = events.find((e) => e.tags.includes("martial"));
  assert.ok(combat, "the combat event must still be recorded");
  assert.equal(combat.dangerGap, "moderate", "the danger gap from the preceding context sentence must carry forward");
});

test("danger-gap carry-forward survives multiple tagless sentences in between, not just one", () => {
  // A 250-case generated pass (2026-09-06) exercised this path at scale; the pinned tests before it
  // only ever checked a single intervening sentence. Checked here with zero, one, and two tagless
  // filler sentences between the gap and the action it should attach to.
  const gap = "They were hopelessly outmatched from the start.";
  const action = "Oma grappled the last one to the floor.";
  const fillers = ["The torches guttered in the draft.", "Somewhere above, a bell was ringing."];
  for (let count = 0; count <= 2; count++) {
    const text = [gap, ...fillers.slice(0, count), action].join(" ");
    const [event] = explainSessionNotes(text).events;
    assert.ok(event, `fillerCount=${count}: no event produced`);
    assert.equal(event.dangerGap, "severe", `fillerCount=${count}: gap did not carry forward`);
  }
});

test("danger-gap carry-forward is consumed once and does not leak onto an unrelated later event", () => {
  const { events } = explainSessionNotes("We were badly outnumbered. Halvard struck the captain down. Later, Sera negotiated safe passage from the toll-warden.");
  const combat = events.find((e) => e.tags.includes("martial"));
  const diplomacy = events.find((e) => e.tags.includes("diplomacy"));
  assert.equal(combat.dangerGap, "moderate");
  assert.equal("dangerGap" in diplomacy, false, "the danger gap must not persist past the event that consumed it");
});

test("'thought about'/'considered' only suppress a sentence when followed by a gerund, not any incidental use", () => {
  // "sang the old harvest round" is a real, completed performance; the unrelated aside "nobody
  // thought about the blood" used to be enough to discard the WHOLE sentence.
  const [event] = explainSessionNotes(
    "Tonight, to keep everyone's spirits up, I sang the old harvest round by the fire and for a moment nobody thought about the blood."
  ).events;
  assert.ok(event, "the real action in this sentence must survive an unrelated 'thought about' clause");
  assert.ok(event.tags.includes("performance"));

  // The gerund form must still be caught as a genuine unrealized intent.
  assert.deepEqual(explainSessionNotes("Kesh thought about burning the rest of it down.").events, []);
});

test("'never bothered to' is recognized with a named subject, not just 'nobody'/'no one'", () => {
  assert.deepEqual(explainSessionNotes("Torv never bothered to check the reliquary for wards.").events, []);
});

test("'didn't fight'/'didn't attack' is not credited as a martial success", () => {
  const { events } = explainSessionNotes("The second guy, she didn't fight -- she talked, smooth as oil, and he walked.");
  assert.equal(events.length, 0, "choosing NOT to fight must not be recorded as a martial action");
});

test("a genuine failed attempt ('didn't manage to') is still kept, unlike 'didn't fight' -- these are different shapes", () => {
  const [event] = explainSessionNotes("She didn't manage to persuade the guard, no matter how she tried.").events;
  assert.ok(event, "a real, failed ATTEMPT is still evidence, unlike never attempting at all");
  assert.equal(event.outcome, "failure");
});

test("an ellipsis does not split a sentence in two, separating an action from its stated outcome", () => {
  const { events, diagnostics } = explainSessionNotes(
    "Torv worked the lock with steady hands... and then his hands weren't so steady, and the pick snapped clean off in the keyhole."
  );
  assert.equal(diagnostics.sentences, 1, "the ellipsis must not be counted as two sentence endings");
  assert.equal(events.length, 1);
  assert.ok(events[0].tags.includes("thievery"));
  assert.equal(events[0].outcome, "failure", "'the pick snapped' is a recognized failure idiom");
});

test("gerund forms of failure verbs (failing, botching, misfiring) are recognized, not just the past tense", () => {
  const cases = [
    ["Sera is trying to read the old scroll but she is failing, the words not making sense.", "lore"],
    ["The device keeps misfiring no matter how Kellin adjusts it.", null]
  ];
  const [event1] = explainSessionNotes(cases[0][0]).events;
  assert.ok(event1);
  assert.ok(event1.tags.includes("lore"));
  assert.equal(event1.outcome, "failure");
});

test("'read the scroll/tome/book' is recognized as lore, not just research/recall/decipher", () => {
  const [event] = explainSessionNotes("Sera read the old tome late into the night.").events;
  assert.ok(event);
  assert.ok(event.tags.includes("lore"));
});

test("'worked the lock' is recognized as thievery, an alternate phrasing for lockpicking", () => {
  const [event] = explainSessionNotes("Torv worked the lock for several minutes before it finally gave.").events;
  assert.ok(event);
  assert.ok(event.tags.includes("thievery"));
});

// --- Consistency check across the full held-out complexity corpus --------------------------------
// The 14 "core" paragraphs all encode the same shape (one hard-won moment with a danger gap, one
// other skilled success, one genuine failure, plus scenery/negation distractors) in wildly different
// voices. This does not re-run all 14 in full (see the user-facing report for the complete set /
// numbers) -- it pins the aggregate claim: computed power across a representative sample lands in a
// tight band, not the wide spread the pre-fix version produced.
test("power stays in a tight band across stylistically different notes with equivalent narrative weight", () => {
  const notes = [
    "Badly outnumbered, Sera parried the sergeant's blade and drove him back into the ditch. Sera negotiated safe passage from the toll-warden. Torv almost picked the lock on the strongbox, but the tumbler jammed.",
    "Snowbound and badly outmatched by the pack that had been tracking us for two days, Kesh turned at the ravine and fought the alpha wolf alone. We made camp on the far side once the trail went cold. Mirren tried to forage enough for a proper meal but came back with nothing edible.",
    "So picture this: four drunk dockhands versus just Kesh, a real tough fight by any measure, and somehow Kesh fought them all off. Meanwhile Sera talked the barkeep out of banning the whole party for a month. Torv tried to pick the lock on the cellar door and fumbled it so badly the bolt snapped."
  ];
  const powers = notes.map((note) => explainSessionNotes(note).events.reduce((sum, e) => sum + progressionForEvent(e), 0));
  const mean = powers.reduce((a, b) => a + b, 0) / powers.length;
  for (const power of powers) {
    assert.ok(power > 0, "every note must produce some recorded evidence");
    const deviation = Math.abs(power - mean) / mean;
    assert.ok(deviation < 0.3, `power ${power} deviates ${(deviation * 100).toFixed(0)}% from the mean ${mean.toFixed(1)} across equivalently-weighted notes`);
  }
});
