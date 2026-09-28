// Prompt builders for the gateway pipeline.
//
// Why two stages: the old gateway sent ONE ~4000-token prompt (system prompt + the whole
// buildAiGatewayRequest payload with eight worked examples) and asked for events AND fully-fielded
// proposals in one reply. On a 4k context that left almost no room to answer, and even on 16k a
// mid-sized local model spent its attention on the proposal schema and got sloppy reading the notes
// -- which is the part the GM actually cares about. Stage 1 is now a small prompt whose only job is
// to *understand the notes* (any language, any spelling); stage 2 only runs when there is something
// to propose, and gets the full proposal requirements.
//
// Pure ESM, zero Foundry globals.

import { CANONICAL_TAGS } from "./normalize.js";
import { VICE_TAXONOMY } from "../vice-taxonomy.js";

// One line per canonical tag. Kept terse on purpose: this block is sent with every chunk.
export const TAG_MEANINGS = {
  acrobatics: "balance, tumbling, dodging, agile body control",
  arcana: "knowledge of arcane magic, runes, identifying magic",
  athletics: "strength: climbing hard surfaces, swimming, grappling, shoving, lifting, forcing doors",
  craft: "making/repairing things: smithing, cooking, building, tinkering, brewing",
  deception: "lying, bluffing, disguise, feints, cons",
  diplomacy: "persuading, negotiating, haggling, calming, making friends",
  intimidation: "threats, coercion, interrogation, scaring",
  medicine: "first aid, treating wounds/disease/poison, stabilizing",
  nature: "animals, plants, herbs, taming, riding, reading the wild",
  occultism: "knowledge of spirits, rituals, curses, the uncanny",
  performance: "music, singing, dancing, acting, storytelling, poetry",
  religion: "prayer, rites, theology, gods, temples",
  society: "laws, nobles, guilds, politics, etiquette, city knowledge",
  stealth: "sneaking, hiding, shadowing, going unseen",
  survival: "tracking, foraging, hunting, fishing, finding the way (stars, landmarks, maps), camping, enduring weather",
  thievery: "lockpicking, pickpocketing, disabling traps, sleight of hand (NOT buying, selling or looting the dead)",
  lore: "research, recalling knowledge, history, deciphering, investigating",
  mobility: "running, jumping, climbing, chasing, escaping, travel",
  water: "swimming, boats, sailing, canals, floods, diving, anything on/in water",
  support: "helping, rescuing, protecting or buffing allies",
  martial: "melee combat: attacking, sword/axe/fists, parrying, dueling",
  precision: "careful aimed actions, weak points, sneak attacks, finesse",
  defense: "blocking, shields, guarding, taking hits, holding a line, tanking or holding an enemy's attention",
  ranged: "bows, crossbows, guns, throwing",
  leadership: "commanding others, rallying, organizing, tactics, inspiring (not fighting alone)",
  alchemy: "potions, elixirs, bombs, poisons, reagents",
  spellcasting: "casting any spell or cantrip",
  arcane: "wizard-style arcane magic",
  divine: "god-granted magic: blessings, smites, holy power",
  occult: "psychic/mind magic, curses, dreams, eldritch pacts",
  primal: "druidic/elemental/nature magic, shapeshifting",
  fire: "fire, flames, burning, heat",
  cold: "ice, frost, freezing",
  electricity: "lightning, thunder, shock",
  earth: "stone, earth, digging, mining",
  air: "wind, flight, levitation",
  summoning: "summoning or commanding companions, familiars, conjured creatures"
};

const LANGUAGE_NAMES = {
  en: "English", es: "Spanish", pt: "Portuguese", fr: "French", de: "German", it: "Italian", el: "Greek",
  tl: "Tagalog", ja: "Japanese", nl: "Dutch", pl: "Polish", ru: "Russian", zh: "Chinese", ko: "Korean", tr: "Turkish"
};

export function languageName(code) {
  const base = String(code ?? "en").toLowerCase().split("-")[0];
  return LANGUAGE_NAMES[base] ?? code;
}

function tagLines() {
  return CANONICAL_TAGS.map((tag) => `${tag}: ${TAG_MEANINGS[tag] ?? tag}`).join("\n");
}

// Compact few-shots covering the populations the user named: non-native English, texting shorthand
// with bullets and dice jargon, a non-English note, and a novel activity plus an intention trap.
// Written as JSON so the model sees the exact output shape; minified to keep stage 1 small.
export const BUILTIN_EXTRACTION_EXAMPLES = [
  {
    notes: "kesh try pick lock but pick is broke, then he kick door open very strong",
    events: [
      { quote: "kesh try pick lock but pick is broke", summary: "Kesh tried to pick the lock but his pick broke.", actorName: "Kesh", tags: ["thievery"], themes: ["lockpicking"], outcome: "failure", dangerGap: "none", language: "en" },
      { quote: "then he kick door open very strong", summary: "Kesh kicked the door open by force.", actorName: "Kesh", tags: ["athletics"], themes: ["door-breaking"], outcome: "success", dangerGap: "none", language: "en" }
    ]
  },
  {
    notes: "- mira nat20 persuasion w/ the guard captain, ez\n- torv rolled a 3 on stealth vs DC 15, got spotted\n- ogre almost tpk'd us lol, we ran",
    events: [
      { quote: "mira nat20 persuasion w/ the guard captain", summary: "Mira persuaded the guard captain brilliantly.", actorName: "Mira", tags: ["diplomacy"], themes: ["persuasion"], outcome: "criticalSuccess", dangerGap: "none", language: "en" },
      { quote: "torv rolled a 3 on stealth vs DC 15, got spotted", summary: "Torv tried to sneak past.", consequence: "He was spotted.", actorName: "Torv", tags: ["stealth"], themes: ["sneaking"], outcome: "failure", dangerGap: "none", language: "en" },
      { quote: "ogre almost tpk'd us lol, we ran", summary: "The party fled from an ogre that nearly killed them all.", actorName: "the party", tags: ["mobility"], themes: ["escape"], outcome: "success", dangerGap: "severe", language: "en" }
    ]
  },
  {
    notes: "Lia curó al herrero herido. Luego intentó convencer al alcalde, pero no la escuchó.",
    events: [
      { quote: "Lia curó al herrero herido.", summary: "Lia healed the wounded blacksmith.", actorName: "Lia", tags: ["medicine", "support"], themes: ["first-aid"], outcome: "success", dangerGap: "none", language: "es" },
      { quote: "intentó convencer al alcalde, pero no la escuchó", summary: "Lia tried to convince the mayor.", consequence: "He would not listen.", actorName: "Lia", tags: ["diplomacy"], themes: ["persuasion"], outcome: "failure", dangerGap: "none", language: "es" }
    ]
  },
  {
    notes: [
      "Orla swung at the troll and got knocked flat lol. Dain's been carving a notch in his bow for every kill.",
      "- Tam ran the ferry solo all week",
      "- never lost a passenger",
      "- harbourmaster offered him a permanent post"
    ].join("\n"),
    events: [
      { quote: "Orla swung at the troll and got knocked flat", summary: "Orla attacked the troll.", consequence: "She was knocked flat.", actorName: "Orla", tags: ["martial"], themes: ["melee"], outcome: "failure", dangerGap: "moderate", language: "en" },
      { quote: "Dain's been carving a notch in his bow for every kill", summary: "Dain carves a notch in his bow for every kill.", actorName: "Dain", tags: ["ranged"], themes: ["archery", "trophy-taking"], outcome: "success", dangerGap: "none", language: "en" },
      { quote: "Tam ran the ferry solo all week", summary: "Tam ran the ferry alone all week.", consequence: "He never lost a passenger and the harbourmaster offered him a permanent post.", actorName: "Tam", tags: ["water", "leadership"], themes: ["ferrying"], outcome: "success", dangerGap: "none", language: "en" }
    ]
  },
  {
    notes: "Between fights Bram kept the monastery's beehives and sold the honey at market for a good price. He wants to learn the lute someday.",
    events: [
      { quote: "Bram kept the monastery's beehives", summary: "Bram tended the monastery's beehives.", actorName: "Bram", tags: ["nature"], themes: ["beekeeping"], outcome: "success", dangerGap: "none", language: "en" },
      { quote: "sold the honey at market for a good price", summary: "Bram sold honey at the market for a good price.", actorName: "Bram", tags: [], themes: ["trading", "beekeeping"], outcome: "success", dangerGap: "none", language: "en" }
    ]
  },
  // A pasted group-chat recap (ember-road s1). Three things the model got wrong there, each shown once:
  // "I/my" in a "Name:" line is Name; a deed one player reports about another is the DOER's event,
  // in plain words (it had become nobody's event, or "dealt with a loose end"); and "lost 30g
  // rigging cards" is a cheating attempt that failed, not an item that went missing (the model
  // said so when asked why it skipped "lost the party's 40g rigging dice").
  {
    notes: [
      "Rook: snuck us past the cultists 😎 and I may have 'handled' the old priest, don't ask",
      "Sable: Sable see Rook push the old priest off the tower when he already give up. very bad. I pray for him after",
      "Ivo: lost 30g of the party's money rigging cards lol (i was so close)",
      "GM: next week the catacombs, someone bring snacks"
    ].join("\n"),
    events: [
      { quote: "snuck us past the cultists", summary: "Rook sneaked the party past the cultists.", actorName: "Rook", tags: ["stealth", "support"], themes: ["sneaking"], outcome: "success", dangerGap: "none", language: "en" },
      { quote: "Sable see Rook push the old priest off the tower when he already give up", summary: "Rook pushed the old priest off the tower after the priest had surrendered.", actorName: "Rook", tags: ["athletics"], themes: ["killing-the-surrendered"], outcome: "success", dangerGap: "none", language: "en" },
      { quote: "I pray for him after", summary: "Sable prayed for the old priest.", actorName: "Sable", tags: ["religion"], themes: ["prayer"], outcome: "success", dangerGap: "none", language: "en" },
      { quote: "lost 30g of the party's money rigging cards", summary: "Ivo tried to cheat at cards by rigging them.", consequence: "He lost 30 gold of the party's money.", actorName: "Ivo", tags: ["deception", "thievery"], themes: ["gambling", "cheating"], outcome: "failure", dangerGap: "none", language: "en" }
    ]
  },
  // Three more things ember-road s2 got wrong, each shown once (board 0cd50d30, 649aeb9f, 40d30e3d):
  // (1) a second ability by the SAME actor right after a first one, joined by "then", is a new
  // action, not the first one's payoff, even mid-combat (Thorn Lash was folded into Entangle and
  // lost as its own event); continuesPrevious is false for it, same as the "kesh ... then he kick
  // door" example above.
  {
    notes: "Rin's Web only tangled 1 of 3 raiders. Then her Ensnaring Strike caught the one going for the cart, holding it in place. Dorn finished it off with his axe.",
    events: [
      { quote: "Rin's Web only tangled 1 of 3 raiders", summary: "Rin cast Web on the raiders.", consequence: "It only tangled 1 of 3.", actorName: "Rin", tags: ["arcana"], themes: ["web"], outcome: "failure", dangerGap: "none", language: "en" },
      { quote: "Then her Ensnaring Strike caught the one going for the cart, holding it in place", summary: "Rin used Ensnaring Strike on the raider going for the cart.", consequence: "It held the raider in place.", actorName: "Rin", tags: ["martial"], themes: ["ensnaring-strike"], outcome: "success", dangerGap: "none", language: "en" },
      { quote: "Dorn finished it off with his axe", summary: "Dorn killed the ensnared raider with his axe.", actorName: "Dorn", tags: ["martial"], themes: ["finishing-blow"], outcome: "success", dangerGap: "none", language: "en" }
    ]
  },
  // (2) several named abilities in one comma list, with an outcome word attached to only the last
  // one, are still that many separate events -- one per ability, not one event covering all of
  // them (the model had merged "sacred flame, guiding bolt missed" into a single failed event,
  // losing that Sacred Flame hit). The ability with no stated result defaults to success.
  {
    notes: "Kade cast Mage Armor, Fireball fizzled.",
    events: [
      { quote: "cast Mage Armor", summary: "Kade cast Mage Armor.", actorName: "Kade", tags: ["arcana"], themes: ["mage-armor"], outcome: "success", dangerGap: "none", language: "en" },
      { quote: "Fireball fizzled", summary: "Kade cast Fireball.", consequence: "It fizzled.", actorName: "Kade", tags: ["arcana"], themes: ["fireball"], outcome: "failure", dangerGap: "none", language: "en" }
    ]
  },
  // (3) an activity can be named only by its result, with the verb left out and the actor only
  // named in an earlier sentence ("Stew with Bael was wonderful" = she made stew with him): still
  // her event, not scenery, and not folded into the unrelated failure before it (the model had
  // dropped "bread w/ Oren was amazing" entirely).
  {
    notes: "Nessa's tomatoes in the flooded row rotted. Stew with Bael was wonderful, he finally told her about the sunken bell. She got the miller to grind their grain for free.",
    events: [
      { quote: "Nessa's tomatoes in the flooded row rotted", summary: "Nessa's tomatoes rotted in the flooded row.", actorName: "Nessa", tags: ["nature"], themes: ["gardening"], outcome: "failure", dangerGap: "none", language: "en" },
      { quote: "Stew with Bael was wonderful", summary: "Nessa made stew with Bael.", consequence: "It was wonderful, and he finally told her about the sunken bell.", actorName: "Nessa", tags: ["craft"], themes: ["cooking"], outcome: "success", dangerGap: "none", language: "en" },
      { quote: "got the miller to grind their grain for free", summary: "Nessa persuaded the miller to grind their grain for free.", actorName: "Nessa", tags: ["diplomacy"], themes: ["negotiating"], outcome: "success", dangerGap: "none", language: "en" }
    ]
  }
];

// Examples show the ideal, already-merged answer, so every example event is continuesPrevious:false.
// Key order mirrors EVENT_ITEM_SCHEMA (quote, actorName, continuesPrevious first).
function exampleBlock(examples) {
  const shaped = (events) => events.map(({ quote, actorName = "", ...rest }) => ({ quote, actorName, continuesPrevious: false, ...rest }));
  return examples
    .map((ex, i) => `Example ${i + 1} notes:\n${ex.notes}\nExample ${i + 1} output:\n${JSON.stringify({ events: shaped(ex.events) })}`)
    .join("\n\n");
}

/** Stage 1: small, focused extraction prompt. */
export function buildExtractionMessages({ notesChunk, request, config, chunkIndex = 0, chunkCount = 1 }) {
  const lang = languageName(config.outputLanguage);
  const system = [
    "You read tabletop RPG session notes and extract GROWTH EVENTS for a character-progression system. Reply with JSON only.",
    "",
    "The notes can be written by anyone: broken or non-native English, typos and phonetic spelling, texting shorthand (ez, w/, b4, bc, nat20, crit, tpk), bullet lists and fragments, dice/table jargon (\"rolled a 3 on stealth\", \"DC 15\", \"used action surge\", \"failed the save\"), any language, or several languages mixed -- including romanized Japanese/Greek/etc. with transliterated jargon (\"kuritikaru\" = crit, \"nag-crit\" = crit). Work out what actually happened. Never skip a line because of its spelling, grammar or language.",
    "",
    "An EVENT is one thing a character actually attempted or did, whether it worked or not. One event per distinct action -- split compound sentences with several actions, and do not repeat the same action twice.",
    "An event INCLUDES its result. Whatever came of the action goes in that event's consequence field and outcome, NEVER in a new event: they got hurt, stung or knocked out; the crowd cheered or cried; the goods sold out or someone bought one; they were thrown out, moved on or offered a job; nobody was lost; the animal finally let them near; a fever broke; visions came; they learned the secret; the crit landed on the final blow; they won 2 of 3. A second line or bullet that only states such a result belongs to the event above it. Also no event that just restates or elaborates the same activity by the same person (\"brewed the ale\" + \"adjusted the malt\" is one brewing event).",
    "Do not add a scene-level event (\"the party fought the warband\") when you also list what each character did in it. Something that merely happens TO a character (attacked, scared off, knocked down, read or sized up by someone, offered a deal, told a secret) is not their event. But money or gear lost BY DOING something is that doing, as a failure: \"lost 40g rigging dice\" = cheated at dice and lost 40g.",
    "",
    "WHO DID IT. Notes are often a group chat pasted together, one \"Name: text\" line per player. In such a line I/me/my means Name. A line can also report what ANOTHER character did (\"Sable saw Rook push the priest\", \"she catch Tovin killing...\"): that event belongs to the DOER (Rook, Tovin), not to the one who saw or tells it, and it is recorded even though the doer never mentioned it. We/us/the party acting together = \"the party\". Leave actorName \"\" only when the notes truly do not say who.",
    "Write what was done in plain words. Never soften a deed: killing a prisoner or someone who surrendered stays exactly that in the summary, not \"dealt with a threat\" or \"tidied up a loose end\". When one line is coy (\"I may have handled a loose end\") and another line says what it was, record the deed ONCE, in the plain words, quoting the line that says it plainly (not the coy one).",
    "Habitual or ongoing actions count (\"has started taking trophies\", \"keeps sneaking out\", \"every night he prays\"), and so does an action mentioned only as a cause or aside (\"people hate us because Rhys threatened the priest\" -> Rhys threatened the priest).",
    "NOT events: intentions or plans (\"wanted to\", \"was going to\", \"plans to\", \"next session\"), questions, attempts that explicitly never happened (\"didn't even try\", \"never got around to it\"), doing nothing, pure scenery or weather, rumours and legends, and anything out of character: reminders, notes-to-self, shopping lists, scheduling, rules questions, talk about the real players.",
    "",
    "For every event give:",
    "- quote: the exact source fragment, copied verbatim in its original language (keep it short).",
    "- actorName: the name of the character who DID it (see WHO DID IT), \"the party\" for a group action, else \"\".",
    "- continuesPrevious: true ONLY when this entry is just the result, payoff or an elaboration of the entry right before it (same person, same occasion: \"didn't lose a single guest\", \"the owner offered her a slot\", \"he adjusted the malt\"). false for any new action, even one of the same kind on another occasion.",
    `- summary: one short third-person sentence in ${lang} saying who did what.`,
    `- consequence: what came of it, if the notes say (one short ${lang} sentence), else "".`,
    "- tags: 0-3 tags from ALLOWED TAGS that genuinely fit. Only these exact words.",
    "- themes: 1-3 short lowercase English slugs naming the SPECIFIC activity (e.g. lockpicking, beekeeping, innkeeping, gambling, cartography, brewing, poetry, haggling). Always give themes. If no tag fits, still record the event with tags [] and themes -- never drop an activity because no tag fits.",
    "- outcome: criticalSuccess | success | failure | criticalFailure. Failures are valuable evidence: always record them. criticalSuccess ONLY for nat 20 / crit / an explicitly spectacular result (a plain win with a nice payoff is just success). nat 1 / fumble / crit fail / badly hurt / backfired = criticalFailure. \"almost\"/\"nearly\" ... but = failure. A low roll or missed DC = failure. Attacked but got beaten, knocked out or flattened = failure. No outcome stated = success.",
    "- dangerGap: severe only if they survived or beat a threat hopelessly beyond them; moderate for a clearly stronger or outnumbering foe; otherwise none. It is about the power gap, not the dice roll.",
    "- language: language code of the quote (en, es, pt, fr, de, it, el, tl, ja, ...).",
    "",
    "ALLOWED TAGS:",
    tagLines(),
    "",
    exampleBlock(BUILTIN_EXTRACTION_EXAMPLES),
    ...(config.extractionExamples?.length ? ["", "Examples from this GM's table:", exampleBlock(config.extractionExamples)] : []),
    ...(config.houseRules ? ["", `House rules from the GM (follow them): ${config.houseRules}`] : []),
    ...(config.toneHints ? ["", `Tone hints from the GM: ${config.toneHints}`] : []),
    "",
    "Output exactly {\"events\":[...]}. If nothing happened, output {\"events\":[]}."
  ].join("\n");

  // Deliberately NOT naming the character being analysed. It used to say "The notes are for the
  // character X", which (a) made the same party recap produce a different extraction per character,
  // so it had to be re-run for every sheet (20-36 s each, ember-road s1), and (b) nudged the model to
  // credit unnamed or first-person lines to X. Reading the notes is the same job whoever's sheet they
  // were pasted into; per-character credit is decided afterwards from actorName. `request` is still
  // accepted (unused) so callers need not change.
  const chunkLine = chunkCount > 1 ? `This is part ${chunkIndex + 1} of ${chunkCount} of the notes.\n` : "";
  const user = `${chunkLine}NOTES:\n<<<\n${notesChunk}\n>>>`;
  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}

const CREATIVITY_WORDING = {
  grounded: "Stay close to existing published feats and spells for this system; modest, conservative numbers; plain names.",
  balanced: "Be flavorful but balanced: interesting mechanics a GM would happily approve.",
  wild: "Be inventive and surprising -- memorable names and unusual mechanics -- while staying balanced for the character's level."
};

export function creativityTemperature(config) {
  const base = config.temperature;
  if (config.creativity === "grounded") return Math.max(0, Math.min(base, 0.15));
  if (config.creativity === "wild") return Math.min(1.2, base + 0.4);
  return Math.min(1.5, base + 0.15);
}

/** Stage 2: proposal prompt. Reuses buildAiGatewayRequest's requirements verbatim where it can. */
// `mustPropose`: the GM explicitly asked for suggestions (proposalMode "always") or a level-up grant
// allowance is waiting to be spent. Without it a careful model answers {"proposals":[]} for any
// single-session evidence -- which is right for "when-earned" and useless for "always".
export function buildProposalMessages({ request, config, events, themeEvidence = {}, tagEvidence = {}, allowClass, mustPropose = false }) {
  const req = request.requirements ?? {};
  const polarity = config.allowRed
    ? req.polarityGuidance
    : "This table has disabled red (taboo) entries: every proposal must be metadata.polarity \"standard\" (omit the field). Never propose a red entry.";
  const kinds = allowClass ? req.exampleByKind : Object.fromEntries(Object.entries(req.exampleByKind ?? {}).filter(([kind]) => kind !== "class"));
  const system = [
    "You design Grand Design growth proposals (new Skills, or a Class evolution) for a tabletop RPG character from evidence of what they actually did. Reply with JSON only: {\"proposals\":[...]}.",
    "Do not grant, approve, or claim to create any item -- the GM approves every proposal.",
    mustPropose
      ? `The GM has asked for suggestions now: propose at least 1 and at most ${config.maxProposals} proposals, built on the strongest evidence available even if it is a single event. Return {"proposals":[]} only when there are no events at all.`
      : `Propose at most ${config.maxProposals} proposals, and only where the evidence genuinely supports one (repeated effort, including repeated failures). Return {"proposals":[]} when it does not.`,
    "Every proposal is { kind: \"skill\" | \"class\", theme?: string, evidence: [short strings citing events], entry: {...} }. The entry is never nested under skillEntry/classEntry.",
    "metadata.tags may ONLY contain values from ALLOWED TAGS; put any other concept in metadata.themes instead.",
    // Board 316705b6: "Sanctuary: Voice of Conviction" duplicated the owned "Sanctuary: Public Edict"
    // (same Persuasion/Intimidation-vs-one-foe-then-Wisdom-save mechanic) under a new second half of
    // the name -- the old dedupe was by name only, so it sailed through. actor.existingClassesAndSkills
    // below carries each owned entry's effect, not just its name, specifically so this can be checked.
    "Never propose a Skill or Class whose mechanics (what it actually lets the character do) duplicate or closely resemble one the character already owns (actor.existingClassesAndSkills, including its effect) -- not even under a new name. Build on what they have, or cover genuinely new ground.",
    // Board 3962a001: "Hexblade: Infernal Pact" (Warlock 3) granted Pact Magic + Eldritch Blast, which
    // every Warlock already has from level 1; "Shadowfingers: Sleight of Hand" granted a Rogue
    // proficiency in Sleight of Hand and Thieves' Tools, which Rogues already start with.
    "Never propose a Skill or Class that just restates a feature, spell, or proficiency the character's own base class already grants by this system's core rules (actor.systemClass) -- for example a Warlock already has Pact Magic and Eldritch Blast, a Rogue is already proficient with Thieves' Tools and its signature skills. A Grand Design proposal is something ADDITIONAL beyond that baseline chassis, never a reskin of it.",
    // The ">= 3" threshold made the model answer {"proposals":[]} for every single-event novel
    // activity even when the GM had asked for suggestions (20 of 22 empty "always" runs, 2026-09-24).
    mustPropose
      ? "EMERGENT THEMES: an activity outside the tag list (beekeeping, gambling, innkeeping...) can become a brand-new Skill named for that theme -- set the proposal's theme and metadata.themes to it and use the closest tags, or none. Because the GM asked for suggestions now, a single event is enough evidence; keep such a first Skill at tier 1."
      : "EMERGENT THEMES: an activity outside the tag list (beekeeping, gambling, innkeeping...) that has repeated evidence (weighted evidence >= 3 in THEME EVIDENCE) can become a brand-new Skill named for that theme -- set the proposal's theme and metadata.themes to it and use the closest tags, or none.",
    `Always include on every entry: name, gameItem.kind, mechanics.effect, mechanics.frequency {max >= 1, per: round|minute|hour|day|encounter|unlimited}, metadata.tags. A skill also needs tier (1, 2 or 3) and system_equivalent. A class also needs level, power_tier, is_primary, is_secondary, system_chassis.`,
    `Extra fields required per gameItem.kind: ${JSON.stringify(req.requiredFieldsByKind ?? {})}`,
    ...(req.rulesVocabulary ? [`Rules vocabulary -- write every effect, trigger and roll in THIS system's terms (the examples below only show the field shape): ${req.rulesVocabulary}`] : []),
    // Board 3962a001. Each list names the OTHER system's vocabulary plus terms that are neither
    // system's real rules (an invented "durability system"; salt-lantern s1's "staggered", a flat
    // round-count duration on a PF2e condition, "Craft check" for PF2e's Crafting skill).
    request.actor?.system === "dnd5e"
      ? "Never write: \"free action\" (that is PF2e's action economy), \"circumstance bonus\", \"off-guard\"/\"flat-footed\", \"per encounter\" (5e uses short/long rest or per turn), or an invented subsystem like a \"durability system\" this table never established."
      : "Never write: \"bonus action\" (that is 5e's action economy), \"short rest\"/\"long rest\" (PF2e frequency is per round/minute/hour/day), \"staggered\" (not a PF2e condition), \"Craft check\" (PF2e's skill is Crafting), a PF2e condition given a flat \"for N rounds\" duration instead of its own rules (PF2e conditions run \"until the end of your next turn\" or count down a value), or an invented subsystem like a \"durability system\" this table never established.",
    `Naming: ${req.namingConvention ?? ""} Take the class motif from the character's Grand Design classes if it has any, else from actor.systemClass; never from the character's personal name. The motif is ONE evocative word you coin from that class plus this entry's own activity (for example a Ranger's trapping skill might be "Snarewright:", a Cleric's brewing skill "Altarbrew:"; never copy these example words), never the bare class name itself or its possessive ("Fighter: ..." and "Champion's Bulwark" are both wrong), and each proposal gets its own motif.`,
    ...(config.namingStyle ? [`GM naming style (takes priority): ${config.namingStyle}`] : []),
    `Polarity: ${polarity}`,
    // The guidance alone ("almost every proposal is standard") made the model pick standard even
    // for "broke the captured scout's will over three days" (3 of 8 red-worthy items were red).
    // A per-proposal check with the vice list as the match key makes the decision explicit.
    ...(config.allowRed ? [`Red check, BEFORE any proposal: fill "redCheck" with one entry per newEvent, in order: { event: its summary, vice: the key from this list that it clearly matches (read the quote), else "none" }. ${VICE_TAXONOMY.map(([vice, meaning]) => `${vice}: ${meaning}`).join(" ")} Killing someone who surrendered or was helpless, torture, and breaking a captive's will always match. Ordinary fighting, stealing, lying and bargaining are "none". Then, if any event has a vice and you propose anything, one proposal MUST cite that event in its evidence and be metadata.polarity "red" with metadata.malignance { vice: <that key>, drawback: <a concrete cost> } -- that deed written up as a clean standard ability, or left out, is wrong. Every other proposal stays standard.`] : []),
    `Failures: ${req.eventOutcomePhilosophy ?? ""}`,
    `Class rule: ${req.classProposalRule ?? ""}${allowClass ? "" : " (Class evolution is NOT available right now: skills only.)"}`,
    `Creativity: ${CREATIVITY_WORDING[config.creativity] ?? CREATIVITY_WORDING.balanced}`,
    ...(config.houseRules ? [`House rules from the GM (follow them): ${config.houseRules}`] : []),
    ...(config.toneHints ? [`Tone hints from the GM: ${config.toneHints}`] : []),
    `Write names, effects and rationale in ${languageName(config.outputLanguage)}.`,
    `ALLOWED TAGS: ${CANONICAL_TAGS.join(", ")}`,
    `One complete valid example per gameItem.kind (match the field set of the kind you choose): ${JSON.stringify(kinds)}`
  ].join("\n");

  const actor = request.actor ?? {};
  const registry = actor.existingGrandDesign ?? {};
  // Board 316705b6: only the NAME used to travel here, so the model had no way to notice that
  // "Sanctuary: Voice of Conviction" was the same Persuasion/Intimidation-vs-one-foe-then-Wisdom-save
  // mechanic as the owned "Sanctuary: Public Edict" under a different second half of the name. Each
  // owned entry's effect now travels with its name (short: this is context, not the whole entry).
  const existingEntries = [
    ...Object.values(registry.classes ?? {}),
    ...Object.values(registry.skills ?? {})
  ]
    .filter((entry) => entry?.name)
    .map((entry) => ({
      name: entry.name,
      ...(typeof entry.mechanics?.effect === "string" && entry.mechanics.effect.trim()
        ? { effect: entry.mechanics.effect.trim().slice(0, 200) }
        : {})
    }));
  const payload = {
    actor: {
      name: actor.name,
      system: actor.systemLabel ?? actor.system,
      level: actor.level,
      ...(actor.systemClass ? { systemClass: actor.systemClass } : {}),
      grandDesign: actor.grandDesign,
      existingClassesAndSkills: existingEntries.slice(0, 40),
      // Board 3962a001: the character's own native class features/proficiencies (from the actual
      // character sheet, outside Grand Design) -- a Warlock 3 already has Pact Magic and Eldritch
      // Blast, a Rogue is already proficient in Sleight of Hand and Thieves' Tools. Only present when
      // the system adapter can read them (ai-gateway.js#buildAiGatewayRequest); the "Never propose..."
      // rule above still applies from general class knowledge when this list is empty.
      ...(Array.isArray(actor.ownedFeatures) && actor.ownedFeatures.length ? { ownedFeatures: actor.ownedFeatures.slice(0, 40) } : {})
    },
    // The verbatim quote travels with the summary: summaries sanitize ("broke the scout's will over
    // three days" became "interrogated the scout"), which hid exactly the cues red polarity needs.
    newEvents: events.map((event) => ({
      summary: event.summary,
      ...(event.quote ? { quote: String(event.quote).slice(0, 240) } : {}),
      ...(event.consequence ? { consequence: event.consequence } : {}),
      tags: event.tags,
      themes: event.themes,
      outcome: event.outcome,
      ...(event.dangerGap ? { dangerGap: event.dangerGap } : {}),
      ...(event.actorName ? { actorName: event.actorName } : {})
    })),
    tagEvidence: roundValues(tagEvidence),
    themeEvidence: roundValues(themeEvidence),
    maxProposals: config.maxProposals
  };
  return [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify(payload) }
  ];
}

function roundValues(map) {
  return Object.fromEntries(Object.entries(map).map(([key, value]) => [key, Math.round(value * 100) / 100]));
}

// Legacy single-call system prompt (unchanged wording where the old tests pin it), plus the stage-1
// understanding guidance so "single" mode is no worse at reading messy notes.
export const LEGACY_PROPOSAL_SYSTEM_PROMPT = "Return only valid JSON matching the requested events and proposals schema. "
  + "Log failed attempts as events too, not just successes -- outcome may be criticalSuccess, success, criticalFailure, or failure; "
  + "see requirements.eventOutcomePhilosophy for exactly how to weigh and use failed attempts as evidence. "
  + "Name every generated proposal so it reads as belonging to the character's own class, not a generic label -- "
  + "see requirements.namingConvention for the exact naming pattern and worked examples. "
  + "A small minority of proposals may be metadata.polarity: \"red\" (taboo/vile origins) instead of the "
  + "default \"standard\" -- see requirements.polarityGuidance for exactly when that applies and what it requires. "
  + "Every tags array (on an event and on a proposal entry's metadata.tags) may ONLY contain values that appear verbatim in the allowedTags array in this request -- "
  + "never invent, pluralize, or reword a tag (for example, allowedTags has \"martial\" and \"defense\", not \"melee\" or \"defensive\"). "
  + "If nothing in allowedTags genuinely fits, use an empty tags array and name the activity in the event's themes array instead (short lowercase slugs like \"beekeeping\") -- never drop the event. "
  + "Return {\"events\":[],\"proposals\":[]} when the evidence is insufficient. Do not grant, approve, or claim to create any item. "
  + "Every field is REQUIRED unless requirements.proposalSchema marks it optional -- never omit a required field, even if you think it is implied. "
  + "Always include, on every proposal's entry: name, mechanics.effect, mechanics.frequency {max, per}, gameItem.kind, and metadata.tags (only tags from allowedTags). "
  + "A skill entry also always needs tier (1, 2, or 3) and system_equivalent. A class entry also always needs level, power_tier, is_primary, is_secondary, and system_chassis. "
  + "Beyond that, requirements.requiredFieldsByKind lists the exact extra fields required for whichever gameItem.kind you choose -- check it every time, per kind, before answering. "
  + "requirements.exampleByKind has one complete, valid, fully-fielded example proposal for every kind (feat, action, reaction, free, passive, spell, weapon, and one class example) -- "
  + "find the entry matching your chosen kind and match its exact field set, changing only the content to fit these notes.";

export function buildSingleMessages({ request, config }) {
  const lang = languageName(config.outputLanguage);
  const system = [
    LEGACY_PROPOSAL_SYSTEM_PROMPT,
    "",
    "Reading the notes: they may be in broken English, any language, texting shorthand (nat20, crit, tpk, w/), bullet fragments or dice jargon -- understand the intent and never skip a line for its spelling or language. "
      + "Each event: quote (verbatim source fragment), summary (" + lang + "), actorName, tags, themes (specific activity slugs, always), outcome, dangerGap (none|moderate|severe), language. "
      + "Intentions, questions, negated attempts and pure scenery are not events. \"almost ... but\" is a failure; nat 1 is criticalFailure; nat 20 is criticalSuccess.",
    ...(config.allowRed ? [] : ["This table has disabled red (taboo) entries: never propose metadata.polarity \"red\"."]),
    ...(config.namingStyle ? [`GM naming style: ${config.namingStyle}`] : []),
    ...(config.houseRules ? [`House rules from the GM: ${config.houseRules}`] : []),
    ...(config.toneHints ? [`Tone hints: ${config.toneHints}`] : []),
    `Creativity: ${CREATIVITY_WORDING[config.creativity] ?? CREATIVITY_WORDING.balanced} At most ${config.maxProposals} proposals.`
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify(request) }
  ];
}

/** The follow-up user message for a repair turn. */
export function buildRepairMessage({ stage, errors, expectedShape }) {
  const list = errors.slice(0, 12).map((error) => `- ${error}`).join("\n");
  return {
    role: "user",
    content: `Your previous reply could not be used as-is:\n${list}\n`
      + `Reply again with the COMPLETE corrected JSON only, exactly in the shape ${expectedShape}. `
      + (stage === "extract"
        ? "Keep every real event from the notes (failures too); use only ALLOWED TAGS in tags and put anything else in themes."
        : "Fix every listed field; keep proposals that were already valid unchanged.")
  };
}
