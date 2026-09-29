// Skill evolution (canon: [Power Strike] becomes [Minotaur Punch]). The raw lineage plumbing for
// this already existed -- `api.upgradeSkill` has always accepted a hand-authored replacement entry
// with `lineage.operation: "upgrade"` -- but "hand-author the whole evolved Skill yourself" is not
// the mechanic canon describes. What canon describes is a Skill that transforms *because of how it
// was used*: a character who leans on the same Skill over and over, and then reaches for it once in
// a genuine crisis, comes out the other side holding something with a different name.
//
// This module is the derivation, and it is deliberately the exact counterpart of class-merging.js:
// pure, Foundry-independent, deterministic (no Math.random/Date.now so it stays callable from plain
// Node tests), and it computes the new entry's name/tier/lineage from the source plus the actor's
// own recorded growth evidence rather than asking a GM to pick them. api.js#buildSkillEvolutionPreview
// wires it to a real actor; the result is handed straight to api.upgradeSkill to actually approve.
import {
  DANGER_GAP_MULTIPLIERS,
  GROWTH_EVENT_OUTCOME_WEIGHTS,
  SKILL_EVOLUTION_EVIDENCE_THRESHOLD,
  SKILL_TIERS
} from "./constants.js";
import { uniqueStrings } from "./lineage.js";
import { weightForTag } from "./tag-weighting.js";

const MAX_SKILL_TIER = Math.max(...SKILL_TIERS);

// Which tag's word bank an evolved name is drawn from when a Skill carries several. Same idea (and
// deliberately the same ordering philosophy) as class-merging.js's LEGENDARY_TITLE_PRIORITY: the
// most thematically loaded tag wins so the result reads as though it were named on purpose, and
// picking by a fixed priority list rather than by iteration order keeps it deterministic.
const EVOLVED_NAME_PRIORITY = [
  "occult", "occultism", "divine", "religion", "arcane", "spellcasting", "primal", "nature",
  "summoning", "alchemy", "fire", "cold", "electricity", "earth", "air", "water",
  "martial", "precision", "defense", "ranged", "stealth", "thievery", "athletics", "acrobatics",
  "mobility", "leadership", "intimidation", "deception", "diplomacy", "performance", "society",
  "medicine", "support", "survival", "craft", "lore"
];

// Two name shapes per bank, for the two rungs an evolution can land on:
//   `epithets` -- prefixed onto the source Skill's own name when the Skill grew stronger but is
//     still recognizably itself ([Power Strike] -> [Cleaving Power Strike]).
//   `mythic` + `nouns` -- a wholesale rename for a Skill that reached the top tier and stopped
//     being a version of what it was ([Power Strike] -> [Minotaur Punch], the canon example).
const EVOLVED_NAME_BANKS = {
  occult: { epithets: ["Dreaming", "Half-Waking", "Whispering"], mythic: ["Nightmare", "Revenant", "Oracle"], nouns: ["Veil", "Whisper", "Communion"] },
  occultism: { epithets: ["Dreaming", "Half-Waking", "Whispering"], mythic: ["Nightmare", "Revenant", "Oracle"], nouns: ["Veil", "Whisper", "Communion"] },
  divine: { epithets: ["Anointed", "Radiant", "Hallowed"], mythic: ["Seraph", "Empyrean", "Saint"], nouns: ["Benediction", "Judgment", "Aegis"] },
  religion: { epithets: ["Anointed", "Radiant", "Hallowed"], mythic: ["Seraph", "Empyrean", "Saint"], nouns: ["Benediction", "Judgment", "Aegis"] },
  arcane: { epithets: ["Sundering", "Runewrought", "Boundless"], mythic: ["Archmage", "Starfall", "Sigil"], nouns: ["Unmaking", "Cascade", "Rite"] },
  spellcasting: { epithets: ["Sundering", "Runewrought", "Boundless"], mythic: ["Archmage", "Starfall", "Sigil"], nouns: ["Unmaking", "Cascade", "Rite"] },
  primal: { epithets: ["Feral", "Rootdeep", "Untamed"], mythic: ["Worldbeast", "Greenmother", "Wildheart"], nouns: ["Rampage", "Blessing", "Awakening"] },
  nature: { epithets: ["Feral", "Rootdeep", "Untamed"], mythic: ["Worldbeast", "Greenmother", "Wildheart"], nouns: ["Rampage", "Blessing", "Awakening"] },
  summoning: { epithets: ["Answering", "Thronged", "Manifold"], mythic: ["Legion", "Hostcaller", "Covenant"], nouns: ["Summons", "Muster", "Calling"] },
  alchemy: { epithets: ["Volatile", "Distilled", "Catalytic"], mythic: ["Philosopher", "Quicksilver", "Crucible"], nouns: ["Reaction", "Draught", "Detonation"] },
  fire: { epithets: ["Ember-Wreathed", "Scorching", "Cinderclad"], mythic: ["Phoenix", "Wyrmfire", "Pyre"], nouns: ["Blaze", "Breath", "Immolation"] },
  cold: { epithets: ["Frostbound", "Rimeclad", "Hollow-Aired"], mythic: ["Wintermaw", "Glacier", "Hoarfrost"], nouns: ["Grasp", "Silence", "Shroud"] },
  electricity: { epithets: ["Thundering", "Arc-Lit", "Storm-Wreathed"], mythic: ["Thunderbird", "Tempest", "Stormcrown"], nouns: ["Strike", "Discharge", "Peal"] },
  earth: { epithets: ["Stoneclad", "Unmoved", "Deep-Rooted"], mythic: ["Mountainheart", "Bedrock", "Colossus"], nouns: ["Slam", "Bulwark", "Upheaval"] },
  air: { epithets: ["Windborne", "Skyward", "Unweighted"], mythic: ["Skydancer", "Zephyr", "Galecaller"], nouns: ["Step", "Gust", "Ascent"] },
  water: { epithets: ["Tideborne", "Flood-Marked", "Undrowned"], mythic: ["Leviathan", "Riptide", "Deepcurrent"], nouns: ["Surge", "Passage", "Undertow"] },
  martial: { epithets: ["Cleaving", "Sundering", "Unyielding"], mythic: ["Minotaur", "Titan", "Warlord"], nouns: ["Punch", "Blow", "Onslaught"] },
  precision: { epithets: ["Unerring", "Vital-Seeking", "Exacting"], mythic: ["Hawkeye", "Needlepoint", "Deadeye"], nouns: ["Incision", "Thrust", "Finish"] },
  defense: { epithets: ["Ironclad", "Immovable", "Warding"], mythic: ["Bulwark", "Aegis", "Ironwall"], nouns: ["Stance", "Refusal", "Guard"] },
  ranged: { epithets: ["Far-Flying", "Piercing", "Sure-Loosed"], mythic: ["Skyshot", "Longshot", "Falcon"], nouns: ["Volley", "Loose", "Descent"] },
  stealth: { epithets: ["Unseen", "Ash-Footed", "Soundless"], mythic: ["Shadowstep", "Nightwalker", "Ghost"], nouns: ["Passage", "Vanishing", "Approach"] },
  thievery: { epithets: ["Deft", "Ghost-Fingered", "Unnoticed"], mythic: ["Locksbane", "Sleightmaster", "Nimblehand"], nouns: ["Lift", "Opening", "Slip"] },
  athletics: { epithets: ["Titanic", "Unbending", "Overbearing"], mythic: ["Giant", "Ironback", "Behemoth"], nouns: ["Heave", "Grip", "Hurl"] },
  acrobatics: { epithets: ["Weightless", "Impossible", "Coiling"], mythic: ["Featherfall", "Windstep", "Serpent"], nouns: ["Tumble", "Recovery", "Twist"] },
  mobility: { epithets: ["Fleetfooted", "Wind-Stepped", "Unbound"], mythic: ["Roadrunner", "Blinkstep", "Courser"], nouns: ["Stride", "Dash", "Crossing"] },
  leadership: { epithets: ["Bannerborne", "Undaunted", "Rallying"], mythic: ["Warcry", "Standard", "Marshal"], nouns: ["Command", "Rally", "Charge"] },
  intimidation: { epithets: ["Withering", "Bone-Chilling", "Dread"], mythic: ["Dreadgaze", "Basilisk", "Terror"], nouns: ["Stare", "Word", "Presence"] },
  deception: { epithets: ["Silver-Tongued", "Seamless", "Mirror-Faced"], mythic: ["Trickster", "Mirage", "Doppel"], nouns: ["Gambit", "Feint", "Mask"] },
  diplomacy: { epithets: ["Disarming", "Unshakable", "Golden-Voiced"], mythic: ["Peacemaker", "Concord", "Envoy"], nouns: ["Accord", "Appeal", "Word"] },
  performance: { epithets: ["Spellbinding", "Rapturous", "Unforgettable"], mythic: ["Maestro", "Siren", "Virtuoso"], nouns: ["Refrain", "Crescendo", "Encore"] },
  society: { epithets: ["Well-Placed", "Impeccable", "Unquestioned"], mythic: ["Courtmaster", "Highborn", "Magistrate"], nouns: ["Standing", "Precedent", "Introduction"] },
  medicine: { epithets: ["Steady-Handed", "Life-Sparing", "Tireless"], mythic: ["Lifebinder", "Mender", "Vigil"], nouns: ["Suture", "Reprieve", "Restoration"] },
  support: { epithets: ["Steadfast", "Hearth-Bound", "Unfailing"], mythic: ["Shieldbearer", "Keeper", "Anchor"], nouns: ["Intervention", "Vigil", "Assurance"] },
  survival: { epithets: ["Trail-Worn", "Unlost", "Weathered"], mythic: ["Pathfinder", "Wayfarer", "Trailbreaker"], nouns: ["Reckoning", "Bearing", "Endurance"] },
  craft: { epithets: ["Tireless", "Flawless", "Silt-Handed"], mythic: ["Masterwright", "Forgeheart", "Artificer"], nouns: ["Working", "Assembly", "Temper"] },
  lore: { epithets: ["Total", "Unclouded", "Encyclopedic"], mythic: ["Loremaster", "Archivist", "Remembrance"], nouns: ["Recall", "Insight", "Citation"] }
};
const DEFAULT_EVOLVED_NAME_BANK = {
  epithets: ["Greater", "Awakened", "True"],
  mythic: ["Paragon", "Apotheosis", "Zenith"],
  nouns: ["Form", "Expression", "Ascension"]
};

// The dark counterpart, keyed by vice (vice-taxonomy.js) rather than gameplay tag -- exactly the
// same split class-merging.js uses for its own legendary titles, and for the same reason: a red
// Skill that evolves should not come out the other side sounding heroic.
const RED_EVOLVED_NAME_BANKS = {
  bloodlust: { epithets: ["Blood-Soaked", "Ravenous", "Unsated"], mythic: ["Reaver", "Slaughter", "Redmaw"], nouns: ["Rapture", "Feast", "Harvest"] },
  cruelty: { epithets: ["Merciless", "Gleeful", "Unfeeling"], mythic: ["Tormentor", "Flenser", "Anguish"], nouns: ["Refinement", "Lesson", "Art"] },
  subjugation: { epithets: ["Iron-Fisted", "Absolute", "Unyielding"], mythic: ["Overlord", "Yoke", "Willbreaker"], nouns: ["Decree", "Collar", "Dominion"] },
  servitude: { epithets: ["Chained", "Branded", "Unfreed"], mythic: ["Thrall", "Bondsman", "Leash"], nouns: ["Obeisance", "Duty", "Devotion"] },
  addiction: { epithets: ["Craving", "Hollow", "Unquenched"], mythic: ["Thirst", "Withdrawal", "Hunger"], nouns: ["Indulgence", "Fix", "Draught"] },
  corruption: { epithets: ["Rotten", "Hollowed", "Unclean"], mythic: ["Blight", "Hollowing", "Bargain"], nouns: ["Spread", "Price", "Pact"] },
  desecration: { epithets: ["Profane", "Blighted", "Unholy"], mythic: ["Defiler", "Sacrilege", "Gravesong"], nouns: ["Rite", "Offering", "Unmaking"] },
  betrayal: { epithets: ["Faithless", "Twice-Sworn", "Unforgiven"], mythic: ["Turncoat", "Knifepoint", "Judas"], nouns: ["Kiss", "Turn", "Reversal"] },
  ruin: { epithets: ["Ashen", "Undone", "Wasted"], mythic: ["Ruination", "Saltfall", "Ending"], nouns: ["Wake", "Toll", "Silence"] }
};
const DEFAULT_RED_EVOLVED_NAME_BANK = {
  epithets: ["Damned", "Forsaken", "Unmade"],
  mythic: ["Malediction", "Anathema", "Ruin"],
  nouns: ["Mark", "Sentence", "Inheritance"]
};

/**
 * Whether a single growth event is a "defining moment" for a Skill -- the crisis half of canon's
 * evolution trigger, as opposed to the grind half.
 *
 * Two independent things qualify, because canon's evolutions come from both:
 *   - a critical outcome (criticalSuccess or criticalFailure): the Skill was pushed past its
 *     ordinary envelope and something broke open. criticalFailure counts on purpose -- the same
 *     reasoning constants.js#GROWTH_EVENT_OUTCOME_WEIGHTS already applies to plain evidence, that a
 *     dramatic, costly failure teaches something a routine success never would.
 *   - a dangerGap (counter-leveling, constants.js#DANGER_GAP_MULTIPLIERS): the Skill was used in a
 *     fight the character had no business surviving. This is the single most on-canon evolution
 *     trigger there is, and it reuses the exact field counter-leveling already populates -- both
 *     the GM-set one and the one session-notes.js/an AI gateway detects automatically.
 */
export function isDefiningMoment(event) {
  if (!event) return false;
  if (event.outcome === "criticalSuccess" || event.outcome === "criticalFailure") return true;
  return Object.prototype.hasOwnProperty.call(DANGER_GAP_MULTIPLIERS, event.dangerGap);
}

/**
 * How much pressure the actor's own recorded growth history is putting on one approved Skill to
 * evolve. Both halves of canon's trigger are measured here and reported separately, so a GM can
 * see *why* a Skill is or isn't ready rather than just getting a yes/no.
 *
 * `events` are matched to the Skill by tag overlap with its own metadata.tags, and weighted exactly
 * the way progression.js weights evidence for a Skill proposal -- outcome weight times the strongest
 * matched tag's Dynamic-tag-reweighting multiplier (tag-weighting.js) -- so a GM who has repatched
 * what a tag is worth sees that reflected here too, rather than evolution quietly running on a
 * separate, stale scale.
 *
 * Only events recorded *after the Skill was approved* count, when the registry entry carries an
 * `approvedAt` (every entry registered by lineage.js#registerEntry does). Evolution is a claim
 * about what you did *with* the Skill; the practice that earned it in the first place was already
 * spent doing exactly that. Pass an explicit `since` to override, or `since: null` to count the
 * actor's entire history.
 */
export function computeEvolutionPressure(sourceSkill, events, { tagWeights = {}, since } = {}) {
  const skillTags = new Set(sourceSkill?.metadata?.tags ?? []);
  const cutoff = since === undefined ? sourceSkill?.approvedAt ?? null : since;
  const matched = (Array.isArray(events) ? events : []).filter((event) => {
    if (cutoff && typeof event?.occurredAt === "string" && event.occurredAt < cutoff) return false;
    return (event?.tags ?? []).some((tag) => skillTags.has(tag));
  });

  let evidenceWeight = 0;
  for (const event of matched) {
    const outcomeWeight = GROWTH_EVENT_OUTCOME_WEIGHTS[event.outcome] ?? 0;
    const multipliers = (event.tags ?? []).filter((tag) => skillTags.has(tag)).map((tag) => weightForTag(tagWeights, tag));
    evidenceWeight += outcomeWeight * (multipliers.length ? Math.max(...multipliers) : 1);
  }

  const definingMoments = matched.filter(isDefiningMoment);
  // Both halves are required, and neither substitutes for the other: grinding a Skill forever
  // without ever being pushed by it produces mastery, not transformation, and one lucky critical
  // on a Skill you have barely used is a fluke rather than an evolution.
  const hasCatalyst = definingMoments.length > 0 && evidenceWeight >= SKILL_EVOLUTION_EVIDENCE_THRESHOLD;

  return {
    evidenceWeight: round2(evidenceWeight),
    evidenceThreshold: SKILL_EVOLUTION_EVIDENCE_THRESHOLD,
    matchedEventIds: matched.map((event) => event.id).filter(Boolean),
    definingMoments: definingMoments.map((event) => ({
      id: event.id ?? null,
      summary: event.summary ?? "",
      outcome: event.outcome,
      ...(event.dangerGap !== undefined ? { dangerGap: event.dangerGap } : {})
    })),
    hasCatalyst
  };
}

/**
 * A Skill backed by a real catalyst climbs one tier, up to the Skill ceiling (SKILL_TIERS, 3).
 * Without one it holds exactly where it is -- the evolution is not blocked, it just doesn't gain
 * power, which is the same soft-penalty shape off-classing already uses in class-merging.js rather
 * than an outright refusal. A tier-3 Skill with a catalyst also holds at 3 (there is nowhere left
 * to climb), but as buildEvolvedSkillName shows, it still earns the full rename: at the ceiling an
 * evolution stops being about numbers and becomes about identity.
 */
export function resolveEvolvedTier(sourceTier, { hasCatalyst = false } = {}) {
  const tier = SKILL_TIERS.has(sourceTier) ? sourceTier : 1;
  if (!hasCatalyst) return tier;
  return Math.min(tier + 1, MAX_SKILL_TIER);
}

/**
 * The naming grammar, and the same principle class-merging.js encodes for Classes: a name's shape
 * should say why it was earned, not just how strong it is.
 *   - No catalyst: "Greater <Source>". Honest about what happened -- the Skill was refined, not
 *     transformed, and the name openly reads as an iteration of the old one.
 *   - Catalyst, below the ceiling: "<Epithet> <Source>". The Skill grew into something stronger
 *     but is still recognizably the thing the character has been doing all along.
 *   - Catalyst, at the ceiling: a wholesale rename -- "<Mythic> <Noun>" -- with no trace of the
 *     old name left. This is the canon case: [Power Strike], used hard enough for long enough and
 *     then pushed past its limit in a fight that should have killed you, becomes [Minotaur Punch].
 *   - Red source: every rung above draws from the vice-keyed bank instead, so a corrupt Skill
 *     never evolves into something that sounds heroic.
 */
export function buildEvolvedSkillName({ sourceSkill, evolvedTier, hasCatalyst = false, polarity = "standard", vice = null, seed, takenNames = [] }) {
  const bank = polarity === "red" ? redBankFor(vice) : bankFor(sourceSkill?.metadata?.tags ?? []);
  const sourceName = sourceSkill?.name ?? "Skill";
  if (!hasCatalyst) {
    // "Greater" is the neutral, un-mythologized prefix on purpose -- even a red Skill that merely
    // sharpened rather than transformed gets the plain form, since nothing dramatic happened to it.
    return `Greater ${sourceName}`;
  }
  // The words are picked by a stable hash of the SOURCE (its registry id), not by bank position:
  // always taking bank[0] made every martial tier-3 evolution "Minotaur Punch" (board 574707d8).
  // Same source -> same name on every preview; different sources -> usually different names; and a
  // name the actor already holds (`takenNames`) is skipped while the bank still has another.
  const nameSeed = seed ?? sourceSkill?.metadata?.id ?? sourceName;
  if (evolvedTier >= MAX_SKILL_TIER) {
    const combos = bank.mythic.flatMap((mythic) => bank.nouns.map((noun) => `${mythic} ${noun}`));
    return pickStableName(combos, `${nameSeed}|mythic`, takenNames);
  }
  return pickStableName(bank.epithets.map((epithet) => `${epithet} ${sourceName}`), `${nameSeed}|epithet`, takenNames);
}

// --- Deterministic picks and registry ids (also used by class-merging.js and combination-skills.js) --

/**
 * FNV-1a, 32-bit. Deterministic across runs and platforms (no Math.random/Date.now), which is what
 * lets a preview and the later approval of the same evolution agree on its name and id.
 */
export function stableHash(value) {
  let hash = 0x811c9dc5;
  const text = String(value ?? "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * One candidate from `candidates`, chosen by `seed`'s hash. When that one is in `takenNames`
 * (case-insensitive) the next candidates in seed-rotated order are tried, so a second Skill never
 * wears the first one's name while the bank still has an unused one; if every candidate is taken
 * the hashed pick is returned anyway (the registry id, not the name, is what must be unique).
 */
export function pickStableName(candidates, seed, takenNames = []) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (!list.length) return "";
  const taken = new Set([...(takenNames ?? [])].map((name) => String(name).trim().toLowerCase()));
  const start = stableHash(seed) % list.length;
  for (let offset = 0; offset < list.length; offset += 1) {
    const candidate = list[(start + offset) % list.length];
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return list[start];
}

/** Registry-safe slug, the same shape lineage.js's slugify produces for ids. */
export function idSlug(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "unnamed";
}

/**
 * The id-collision guard for derived entries. lineage.js#normalizeEntry falls back to
 * `<kind>:<slug(name)>` when an entry has no metadata.id, and registerEntry then overwrites whatever
 * already sits under that key -- so two evolutions that happened to share a name silently replaced
 * the first Skill (board 574707d8). Every builder therefore sets its own metadata.id, and when the
 * caller passes the ids already in use (`existingIds`: an array, a Set, or the registry bucket object
 * itself) a "-2", "-3"... suffix keeps the new entry from landing on top of an old one.
 */
export function uniqueRegistryId(baseId, existingIds) {
  const taken = existingIds instanceof Set
    ? existingIds
    : new Set(Array.isArray(existingIds) ? existingIds : existingIds && typeof existingIds === "object" ? Object.keys(existingIds) : []);
  if (!taken.has(baseId)) return baseId;
  let counter = 2;
  while (taken.has(`${baseId}-${counter}`)) counter += 1;
  return `${baseId}-${counter}`;
}

/**
 * The evolved Skill's registry id: the source's id plus what happened to it (a real evolution or a
 * plain refinement) and the tier it landed on -- "skill:power-strike--evolved-t3". Readable in the
 * registry, stable for the same source and outcome, and never equal to the source's own id (the
 * source stays approved; an upgrade adds a Skill, it does not replace one).
 */
export function evolvedSkillId({ sourceId, evolvedTier, hasCatalyst, existingIds }) {
  const bare = String(sourceId).replace(/^skill:/, "");
  return uniqueRegistryId(`skill:${idSlug(bare)}--${hasCatalyst ? "evolved" : "refined"}-t${evolvedTier}`, existingIds);
}

/** A short, human-readable line for the evolved entry's lineage.rationale, if the caller doesn't supply one. */
export function describeEvolutionRationale({ sourceSkill, evolvedTier, pressure, polarity = "standard" }) {
  const name = sourceSkill?.name ?? "the source Skill";
  let rationale;
  if (!pressure.hasCatalyst) {
    const missing = pressure.definingMoments.length === 0
      ? "it has never been pushed past its limit -- no critical outcome, no fight it had no business surviving"
      : `the practice behind it is still thin (${pressure.evidenceWeight} of ${pressure.evidenceThreshold} weighted evidence)`;
    rationale = `A refinement of [${name}] rather than a true evolution: ${missing}. It sharpens, but holds at tier ${evolvedTier}.`;
  } else if (evolvedTier >= MAX_SKILL_TIER) {
    const moment = pressure.definingMoments[0];
    rationale = `[${name}] has stopped being what it was. ${pressure.evidenceWeight} weighted evidence of relentless use, then a defining moment -- ${momentText(moment)} -- pushed it past its own ceiling into something that no longer shares its old name.`;
  } else {
    const moment = pressure.definingMoments[0];
    rationale = `[${name}] evolved to tier ${evolvedTier}: ${pressure.evidenceWeight} weighted evidence of sustained use, brought to a head by ${momentText(moment)}.`;
  }
  if (polarity === "red") {
    rationale += " Its malignance evolved right along with it -- what corrupted the original was never left behind.";
  }
  return rationale;
}

/**
 * The full pipeline in one call: an approved registry Skill entry (as returned by
 * `GrandDesignApi#getActorRegistry(actor).skills[id]`) plus the actor's own growth events produce a
 * ready-to-approve evolved Skill -- name, tier, and metadata.lineage all derived, exactly the way
 * class-merging.js#mergeClassEntry derives a merged Class. Hand the result to
 * `api.upgradeSkill(actor, entry)`, or edit `entry.name` first; the derivation is a strong starting
 * point, never a mandate.
 *
 * `gameItem`/`mechanics` are the caller's, since only a GM (or the AI proposal pipeline) can say
 * what the evolved Skill actually *does* -- this module deliberately does not invent mechanics.
 * Omit them and the source Skill's own are carried forward unchanged, which is the right default
 * for a refinement and a reasonable starting draft for a full evolution.
 *
 * Red polarity is inherited from the source rather than re-derived: an evolution has exactly one
 * source, so there is no contagion question to resolve the way a multi-source Class merge has --
 * a corrupt Skill's evolution is corrupt. Pass explicit `polarity`/`malignance` to override (e.g.
 * pairing an evolution with a cleansing, or hand-authoring an evolved drawback).
 */
export function evolveSkillEntry({
  sourceSkill,
  events = [],
  tagWeights = {},
  since,
  name,
  gameItem,
  mechanics,
  tags = [],
  rationale,
  systemEquivalent,
  polarity,
  malignance,
  // `name` (above) already overrides the derived name -- the hook for an AI-authored one. `id`
  // overrides the derived registry id. `existingIds` / `existingNames` are what the actor already
  // holds (e.g. `registry.skills` and its names) so the result never lands on an existing registry
  // key and, while the bank allows, never repeats a name the actor already has.
  id,
  existingIds,
  existingNames = []
}) {
  const sourceId = requireSourceId(sourceSkill);
  const pressure = computeEvolutionPressure(sourceSkill, events, { tagWeights, since });
  const evolvedTier = resolveEvolvedTier(sourceSkill.tier, { hasCatalyst: pressure.hasCatalyst });
  const resolvedPolarity = polarity ?? sourceSkill.metadata?.polarity ?? "standard";
  const resolvedMalignance = resolvedPolarity === "red"
    ? (malignance ?? sourceSkill.metadata?.malignance ?? null)
    : null;
  const resolvedName = name ?? buildEvolvedSkillName({
    sourceSkill,
    evolvedTier,
    hasCatalyst: pressure.hasCatalyst,
    polarity: resolvedPolarity,
    vice: resolvedMalignance?.vice ?? null,
    takenNames: existingNames
  });
  const resolvedId = typeof id === "string" && id.trim()
    ? uniqueRegistryId(id.trim(), existingIds)
    : evolvedSkillId({ sourceId, evolvedTier, hasCatalyst: pressure.hasCatalyst, existingIds });

  return {
    name: resolvedName,
    tier: evolvedTier,
    system_equivalent: systemEquivalent ?? sourceSkill.system_equivalent ?? "Pending system equivalent review",
    // Recorded at the top level rather than inside metadata on purpose: lineage.js#normalizeEntry
    // rebuilds metadata from scratch on every approval and would silently drop anything extra
    // stored there, while the outer `{...entry}` spread carries top-level fields through intact.
    // registerEntry's own per-kind whitelist then persists it onto the durable registry entry.
    evolution: {
      from: sourceId,
      catalyst: pressure.hasCatalyst,
      evidenceWeight: pressure.evidenceWeight,
      definingMomentIds: pressure.definingMoments.map((moment) => moment.id).filter(Boolean)
    },
    metadata: {
      // Always set: without it normalizeEntry derived the id from the name, and a second evolution
      // with the same name overwrote the first in the registry (board 574707d8).
      id: resolvedId,
      tags: uniqueStrings([...tags, ...(sourceSkill.metadata?.tags ?? [])]),
      ...(resolvedPolarity === "red" ? { polarity: "red", malignance: resolvedMalignance } : {}),
      lineage: {
        operation: "upgrade",
        sources: [sourceId],
        rationale: rationale ?? describeEvolutionRationale({ sourceSkill, evolvedTier, pressure, polarity: resolvedPolarity })
      }
    },
    gameItem: gameItem ?? structuredClone(sourceSkill.gameItem),
    mechanics: mechanics ?? structuredClone(sourceSkill.mechanics)
  };
}

/**
 * The deterministic fallback's answer to "what does the evolved Skill DO" (board ebcc3f03: the
 * evolved entry used to carry the source's mechanics over unchanged, so an "evolution" was a rename
 * with the same numbers). The AI upgrade (adapter.authorAdvanced) writes real new mechanics; this is
 * what stands in when it cannot, and it grows the source's own mechanics rather than inventing new
 * ones, so the GM still recognizes the Skill:
 *   - a refinement (no catalyst) sharpens: a flat bonus on its roll and one line saying so;
 *   - a true evolution (catalyst) also gains one more use per period (not for "unlimited"), and its
 *     roll bonus is bigger per tier climbed;
 *   - at the ceiling (tier 3 with a catalyst) the effect gains a critical rider on top.
 * System wording: PF2e bonuses are typed ("circumstance"), dnd5e ones plain; the frequency and the
 * roll formula are the same fields on both systems (the adapters read them identically).
 * Pure: returns a new object; `mechanics` is never mutated.
 */
export function growEvolvedMechanics(mechanics, { fromTier = 1, toTier = fromTier, hasCatalyst = false, systemId = "pf2e" } = {}) {
  const grown = structuredClone(mechanics ?? {});
  const is5e = systemId === "dnd5e";
  const climbed = Math.max(0, toTier - fromTier);
  const bonus = hasCatalyst ? 1 + climbed : 1;
  const bonusText = is5e ? `+${bonus} bonus` : `+${bonus} circumstance bonus`;
  const lines = [];
  if (grown.roll && typeof grown.roll.formula === "string") {
    const match = /^(\d+d\d+)\s*(?:([+-])\s*(\d+))?$/i.exec(grown.roll.formula.trim());
    if (match) {
      const current = match[2] ? Number(`${match[2]}${match[3]}`) : 0;
      const next = current + bonus;
      grown.roll = { ...grown.roll, formula: `${match[1]}${next >= 0 ? "+" : "-"}${Math.abs(next)}` };
    }
    lines.push(`Evolved: its roll gains a ${bonusText}.`);
  } else {
    lines.push(`Evolved: checks made with it gain a ${bonusText}.`);
  }
  if (hasCatalyst && grown.frequency && Number.isInteger(grown.frequency.max) && grown.frequency.per !== "unlimited") {
    grown.frequency = { ...grown.frequency, max: grown.frequency.max + 1 };
    lines.push(`It can be used ${grown.frequency.max} times per ${grown.frequency.per}.`);
  }
  if (hasCatalyst && toTier >= MAX_SKILL_TIER) {
    lines.push(is5e
      ? "When you roll a 20 with it, the effect is doubled (twice the dice, twice the duration)."
      : "On a critical success with it, the effect is doubled (twice the dice, twice the duration).");
  }
  const base = typeof grown.effect === "string" && grown.effect.trim() ? grown.effect.trim() : "Pending GM effect description.";
  grown.effect = `${base} ${lines.join(" ")}`;
  return grown;
}

function bankFor(tags) {
  const tagSet = new Set(tags);
  const category = EVOLVED_NAME_PRIORITY.find((tag) => tagSet.has(tag));
  return (category && EVOLVED_NAME_BANKS[category]) ?? DEFAULT_EVOLVED_NAME_BANK;
}

function redBankFor(vice) {
  return (vice && RED_EVOLVED_NAME_BANKS[vice]) ?? DEFAULT_RED_EVOLVED_NAME_BANK;
}

// A moment's summary is a full sentence ("... split the troll's skull."); inside the rationale's own
// sentence its closing punctuation doubled up ("skull..", seen in the 2026-09-29 real-model check).
function momentText(moment) {
  return String(moment?.summary || moment?.outcome || "").trim().replace(/[.!?]+$/, "");
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function requireSourceId(sourceSkill) {
  const id = sourceSkill?.metadata?.id;
  if (typeof id !== "string" || !id.trim()) {
    throw new Error(`Source Skill "${sourceSkill?.name ?? "unknown"}" has no registry ID to evolve from.`);
  }
  return id;
}
