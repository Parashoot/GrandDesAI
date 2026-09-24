import assert from "node:assert/strict";
import test from "node:test";

import { explainSessionNotes, analyzeSessionNotes } from "../scripts/session-notes.js";
import { correctTypo, isCheapTypoOf, normalizeNoteText, splitNoteLines } from "../scripts/growth-taxonomy.js";
import { validateGrowthEvent } from "../scripts/progression.js";

// The local keyword analyzer is the "never lose the GM's notes" safety net: it runs when no AI
// provider is configured or every provider attempt failed. These tests pin how it copes with the
// way real tables write -- bullets and one-thing-per-line notes, cheap typos, texting shorthand,
// and non-native English -- WITHOUT turning into a false-positive machine (real words that are one
// letter away from an action verb must stay untouched).

const tagsOf = (notes) => analyzeSessionNotes(notes).map((event) => event.tags);
const flat = (notes) => [...new Set(tagsOf(notes).flat())];

// ---- line / bullet splitting ---------------------------------------------------------------

test("dash bullets without final punctuation become separate events", () => {
  assert.deepEqual(tagsOf("- Kesh attacked the goblin\n- Mira sneaked past the guards\n- Tovin picked the lock"), [["martial"], ["stealth"], ["thievery"]]);
});

test("asterisk and bullet-dot lists split per line", () => {
  const events = analyzeSessionNotes("* ambush on road\n* Kesh parried, killed 2\n• Mira healed Kesh after");
  assert.deepEqual(events.map((e) => e.tags), [["martial"], ["medicine"]]);
});

test("numbered lists (1. and 2) styles) split per line", () => {
  const events = analyzeSessionNotes("1. Kesh fought the ogre\n2. Mira prayed over the fallen\n3) Tovin picked the lock");
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.tags[0]), ["martial", "religion", "thievery"]);
});

test("splitNoteLines strips bullet markers and keeps paragraph breaks as boundaries", () => {
  assert.deepEqual(splitNoteLines("- a\n- b\n\n1. c\n2) d"), ["a", "b", "c", "d"]);
});

test("splitNoteLines joins a long hard-wrapped prose line with its lowercase continuation", () => {
  const segments = splitNoteLines("e long line without punctuation that goes on and on and on for a while\ncontinued here");
  assert.deepEqual(segments, ["e long line without punctuation that goes on and on and on for a while continued here"]);
});

test("splitNoteLines keeps short unpunctuated lines separate (shorthand notes)", () => {
  assert.deepEqual(splitNoteLines("nat 1 on the swim lol\nthe bard sang all night"), ["nat 1 on the swim lol", "the bard sang all night"]);
});

test("splitNoteLines handles CRLF and never returns empty segments", () => {
  const segments = splitNoteLines("Kesh fought.\r\n\r\n\r\n- Mira sang\r\n   \r\n");
  assert.deepEqual(segments, ["Kesh fought.", "Mira sang"]);
});

test("a prose paragraph still splits on sentence punctuation", () => {
  assert.equal(analyzeSessionNotes("Kesh parried the blade. Mira bound the wound. Tovin picked the lock.").length, 3);
});

// ---- typos -------------------------------------------------------------------------------------

const TYPO_CASES = [
  ["Kesh atacked the goblin", "martial"],
  ["Mira sneeked past the guards", "stealth"],
  ["Tovin pickd the lock", "thievery"],
  ["Garrik intimadated the shopkeepr", "intimidation"],
  ["Brakka blokced the troll's club", "defense"],
  ["The cleric heald the wounded", "medicine"],
  ["Ilse pursuaded the harbourmaster", "diplomacy"],
  ["Wick decieved the inquisitor", "deception"],
  ["Hal fougth the ogre", "martial"],
  ["Kip climed the wall", "mobility"]
];
for (const [notes, tag] of TYPO_CASES) {
  test(`typo tolerance: ${JSON.stringify(notes)} -> ${tag}`, () => assert.ok(flat(notes).includes(tag), JSON.stringify(tagsOf(notes))));
}

test("the event summary keeps the GM's original (misspelled) words", () => {
  const [event] = analyzeSessionNotes("Kesh atacked the goblin");
  assert.equal(event.summary, "Kesh atacked the goblin");
});

test("correctTypo never rewrites real everyday words that are one letter from an action verb", () => {
  for (const word of ["heated", "options", "stuck", "bought", "crypt", "treats", "dragon", "leader", "headed", "started"]) {
    assert.equal(correctTypo(word).toLowerCase(), word, word);
  }
});

test("correctTypo fixes doubled/undoubled letters and vowel slips, preserving nothing else", () => {
  assert.equal(correctTypo("atacked"), "attacked");
  assert.equal(correctTypo("Healled").toLowerCase(), "healed");
});

test("isCheapTypoOf accepts doubling, vowel insertion and adjacent swaps but not consonant substitutions", () => {
  assert.equal(isCheapTypoOf("atacked", "attacked"), true);
  assert.equal(isCheapTypoOf("attakced", "attacked"), true);
  assert.equal(isCheapTypoOf("heated", "healed"), false);
  assert.equal(isCheapTypoOf("options", "potions"), false);
  assert.equal(isCheapTypoOf("same", "same"), false);
});

test("a stove sentence does not become a medicine event", () => {
  assert.equal(flat("The innkeeper heated the stew.").includes("medicine"), false);
});

// ---- texting shorthand -------------------------------------------------------------------------

test("normalizeNoteText expands w/, &, thru, b/c and ppl", () => {
  assert.equal(normalizeNoteText("kesh fought w/ the ogre & won thru the gate b/c ppl"), "kesh fought with  the ogre and won through the gate because people");
});

test("shorthand notes still produce events", () => {
  assert.ok(flat("kesh fought w/ the ogre & won").includes("martial"));
  assert.ok(flat("rogue pickpocketed the noble lmao got 30gp").includes("thievery"));
});

test("nat 1 on a check reads as a critical failure", () => {
  const [event] = analyzeSessionNotes("Nat 1 on the stealth check.");
  assert.deepEqual(event.tags, ["stealth"]);
  assert.equal(event.outcome, "criticalFailure");
});

// ---- non-native English ------------------------------------------------------------------------

const NON_NATIVE_CASES = [
  ["Marco is very angry and he fight with the orc", "martial"],
  ["Lucia has convinced to the merchant for give us the horses more cheap.", "diplomacy"],
  ["Dmitri was defending the door from zombies all night.", "martial|defense"],
  ["Yusuf he is protecting the caravan from the raiders.", "support|defense"],
  ["Wei use sword attack the bandit leader three time", "martial"],
  ["The alchemist mix two potion together but it explode", "alchemy"]
];
for (const [notes, alternatives] of NON_NATIVE_CASES) {
  test(`non-native English: ${JSON.stringify(notes)}`, () => {
    const tags = flat(notes);
    assert.ok(alternatives.split("|").some((tag) => tags.includes(tag)), JSON.stringify(tags));
  });
}

// ---- traps stay traps --------------------------------------------------------------------------

test("a question is not an event", () => {
  assert.equal(analyzeSessionNotes("Did anyone check the chest for traps?").length, 0);
});

test("pure scenery is not an event", () => {
  assert.equal(analyzeSessionNotes("The rain hammered the roof all night.").length, 0);
});

test("\"planning to\" is an intention, not an event", () => {
  assert.equal(analyzeSessionNotes("Next session we are planning to sneak into the palace.").length, 0);
});

test("\"wanted to\" is an intention, not an event, even in a bullet", () => {
  assert.equal(analyzeSessionNotes("- Kesh wanted to burn the warehouse down").length, 0);
});

test("danger-gap context on its own bullet carries to the next event", () => {
  const [event] = analyzeSessionNotes("- we were badly outnumbered\n- Halvard struck the leader down anyway");
  assert.equal(event.dangerGap, "moderate");
});

// ---- invariants ----------------------------------------------------------------------------

test("every local event is valid, marked source:local, and keeps a non-empty summary", () => {
  const notes = "- Kesh atacked the goblin\n- Mira sneeked past\nkesh fought w/ the ogre & won\nNat 1 on the stealth check.";
  for (const event of analyzeSessionNotes(notes)) {
    assert.deepEqual(validateGrowthEvent(event).errors, []);
    assert.equal(event.source, "local");
    assert.ok(event.summary.trim());
  }
});

test("explainSessionNotes diagnostics count the split segments and give a hint when nothing matched", () => {
  const { events, diagnostics } = explainSessionNotes("- we ordered pizza\n- argued about batman");
  assert.equal(events.length, 0);
  assert.equal(diagnostics.sentences, 2);
  assert.ok(diagnostics.hint);
});
