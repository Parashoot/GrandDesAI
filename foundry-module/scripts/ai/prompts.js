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
      { quote: "torv rolled a 3 on stealth vs DC 15, got spotted", summary: "Torv tried to sneak but was spotted.", actorName: "Torv", tags: ["stealth"], themes: ["sneaking"], outcome: "failure", dangerGap: "none", language: "en" },
      { quote: "ogre almost tpk'd us lol, we ran", summary: "The party fled from an ogre that nearly killed them all.", actorName: "", tags: ["mobility"], themes: ["escape"], outcome: "success", dangerGap: "severe", language: "en" }
    ]
  },
  {
    notes: "Lia curó al herrero herido. Luego intentó convencer al alcalde, pero no la escuchó.",
    events: [
      { quote: "Lia curó al herrero herido.", summary: "Lia healed the wounded blacksmith.", actorName: "Lia", tags: ["medicine", "support"], themes: ["first-aid"], outcome: "success", dangerGap: "none", language: "es" },
      { quote: "intentó convencer al alcalde, pero no la escuchó", summary: "Lia tried to convince the mayor, but he would not listen.", actorName: "Lia", tags: ["diplomacy"], themes: ["persuasion"], outcome: "failure", dangerGap: "none", language: "es" }
    ]
  },
  {
    notes: "Orla swung at the troll and got knocked flat lol. Dain's been carving a notch in his bow for every kill. Tam ran the ferry solo all week, never lost a passenger.",
    events: [
      { quote: "Orla swung at the troll and got knocked flat", summary: "Orla attacked the troll but was knocked flat.", actorName: "Orla", tags: ["martial"], themes: ["melee"], outcome: "failure", dangerGap: "moderate", language: "en" },
      { quote: "Dain's been carving a notch in his bow for every kill", summary: "Dain carves a notch in his bow for every kill.", actorName: "Dain", tags: ["ranged"], themes: ["archery", "trophy-taking"], outcome: "success", dangerGap: "none", language: "en" },
      { quote: "Tam ran the ferry solo all week, never lost a passenger", summary: "Tam ran the ferry alone all week without losing a passenger.", actorName: "Tam", tags: ["water", "leadership"], themes: ["ferrying"], outcome: "success", dangerGap: "none", language: "en" }
    ]
  },
  {
    notes: "Between fights Bram kept the monastery's beehives and sold the honey at market for a good price. He wants to learn the lute someday.",
    events: [
      { quote: "Bram kept the monastery's beehives", summary: "Bram tended the monastery's beehives.", actorName: "Bram", tags: ["nature"], themes: ["beekeeping"], outcome: "success", dangerGap: "none", language: "en" },
      { quote: "sold the honey at market for a good price", summary: "Bram sold honey at the market for a good price.", actorName: "Bram", tags: [], themes: ["trading", "beekeeping"], outcome: "success", dangerGap: "none", language: "en" }
    ]
  }
];

function exampleBlock(examples) {
  return examples
    .map((ex, i) => `Example ${i + 1} notes:\n${ex.notes}\nExample ${i + 1} output:\n${JSON.stringify({ events: ex.events })}`)
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
    "An event INCLUDES its result. What happened because of the action (they got hurt or flattened, got stung, the crowd cried, the goods sold out, no guest was lost, the animal finally let them near, visions came, the crit landed on the final blow) is NOT a separate event: fold it into that action's outcome and summary. Do not add a scene-level event (\"the party fought the warband\") when you also list what each character did in it. Being attacked, scared off or knocked down is not an event of the victim.",
    "Habitual or ongoing actions count (\"has started taking trophies\", \"keeps sneaking out\", \"every night he prays\"), and so does an action mentioned only as a cause or aside (\"people hate us because Rhys threatened the priest\" -> Rhys threatened the priest).",
    "NOT events: intentions or plans (\"wanted to\", \"was going to\", \"plans to\", \"next session\"), questions, attempts that explicitly never happened (\"didn't even try\", \"never got around to it\"), doing nothing, pure scenery or weather, rumours and legends, and anything out of character: reminders, notes-to-self, shopping lists, scheduling, rules questions, talk about the real players.",
    "",
    "For every event give:",
    "- quote: the exact source fragment, copied verbatim in its original language (keep it short).",
    `- summary: one short third-person sentence in ${lang} saying who did what.`,
    "- actorName: who did it, if the notes say (else \"\").",
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

  const actorName = request?.actor?.name ? `The notes are for the character "${request.actor.name}"${request.actor.systemLabel ? ` (${request.actor.systemLabel})` : ""}. Record actions by other characters too, with their actorName.\n` : "";
  const chunkLine = chunkCount > 1 ? `This is part ${chunkIndex + 1} of ${chunkCount} of the notes.\n` : "";
  const user = `${actorName}${chunkLine}NOTES:\n<<<\n${notesChunk}\n>>>`;
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
    "EMERGENT THEMES: an activity outside the tag list (beekeeping, gambling, innkeeping...) that has repeated evidence (weighted evidence >= 3 in THEME EVIDENCE) can become a brand-new Skill named for that theme -- set the proposal's theme and metadata.themes to it and use the closest tags, or none.",
    `Always include on every entry: name, gameItem.kind, mechanics.effect, mechanics.frequency {max >= 1, per: round|minute|hour|day|encounter|unlimited}, metadata.tags. A skill also needs tier (1, 2 or 3) and system_equivalent. A class also needs level, power_tier, is_primary, is_secondary, system_chassis.`,
    `Extra fields required per gameItem.kind: ${JSON.stringify(req.requiredFieldsByKind ?? {})}`,
    ...(req.rulesVocabulary ? [`Rules vocabulary -- write every effect, trigger and roll in THIS system's terms (the examples below only show the field shape): ${req.rulesVocabulary}`] : []),
    `Naming: ${req.namingConvention ?? ""}`,
    ...(config.namingStyle ? [`GM naming style (takes priority): ${config.namingStyle}`] : []),
    `Polarity: ${polarity}`,
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
  const existingNames = [
    ...Object.values(registry.classes ?? {}).map((entry) => entry?.name).filter(Boolean),
    ...Object.values(registry.skills ?? {}).map((entry) => entry?.name).filter(Boolean)
  ];
  const payload = {
    actor: {
      name: actor.name,
      system: actor.systemLabel ?? actor.system,
      level: actor.level,
      grandDesign: actor.grandDesign,
      existingClassesAndSkills: existingNames.slice(0, 40)
    },
    newEvents: events.map((event) => ({
      summary: event.summary,
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
