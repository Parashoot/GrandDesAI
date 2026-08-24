// Closed, abstracted vocabulary for "Red" (taboo/debuffing) Class and Skill entries -- see
// constants.js#ENTRY_POLARITIES. Deliberately kept as mechanical/narrative THEMES rather than
// literal real-world criminal labels: a GM can hang any specific backstory they want on
// "subjugation" or "servitude", but this module itself never generates graphic or gratuitous
// content -- it only names the category of vice a dark path is built from, and requires every red
// entry to state a concrete drawback (see validator.js), so red power is never written as clean
// or costless. Ordinary morally-gray professions (thief, assassin, spy, mercenary) are NOT vices
// and should stay metadata.polarity: "standard" -- this taxonomy is only for entries whose origin
// is a genuine violation, compulsion, or forced condition.
export const VICE_TAXONOMY = [
  ["bloodlust", "Killing became easy, even craved, rather than a last resort."],
  ["cruelty", "Harm inflicted for its own sake, past whatever a goal actually required."],
  ["subjugation", "Power built by breaking other people's will and freedom."],
  ["servitude", "Identity and agency stripped away by force, not by choice."],
  ["addiction", "A compulsion the body and mind no longer fully control."],
  ["corruption", "A bargain or influence that hollowed something out from within."],
  ["desecration", "Sacred trusts, oaths, or resting places violated without remorse."],
  ["betrayal", "Trust broken deliberately, for gain, against someone who relied on it."],
  ["ruin", "Wreckage left behind on purpose -- people, places, or oaths burned rather than kept."]
];

export const VICE_TAGS = new Set(VICE_TAXONOMY.map(([tag]) => tag));
