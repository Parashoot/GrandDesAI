// Live multi-caster Combination Skills (canon: several characters fire their own Skills together
// in the same moment and the result is bigger than the sum of them). This is the one Grand Design
// mechanic that is genuinely *transient* -- a combination happens, resolves, and is over, and it
// belongs to no single character. Nothing here ever enters an actor's Class/Skill registry, which
// is exactly why it needs its own module rather than another lineage operation: `combine` in
// lineage.js fuses one actor's own two Skills into a permanent third one, while a combination is
// N different actors' existing Skills held together for a round.
//
// What earns it a place in a character-progression tool (rather than staying a pure tactical
// combat gadget) is the feedback loop: participating in a combination is itself recorded as a
// growth event for every participant, tagged with the WHOLE combination's tag set rather than just
// each contributor's own -- so casting alongside a healer is how a duelist accumulates the first
// real medicine-tagged evidence of their life. A strongly resonant combination is recorded as a
// criticalSuccess, which skill-evolution.js#isDefiningMoment recognizes as a defining moment, so a
// great combination can be the very thing that evolves one of the Skills that made it.
//
// Pure and Foundry-independent like class-merging.js/skill-evolution.js: deterministic, no
// Math.random or Date.now, callable straight from the plain-Node test suite. api.js does the actor
// reading, Item creation, and growth recording around it.
import {
  COMBINATION_AMPLIFIED_MULTIPLIER,
  COMBINATION_MAX_POWER,
  COMBINATION_PARTICIPANT_RESONANCE_BONUS,
  COMBINATION_RESONANCE_STRONG_THRESHOLD,
  COMBINATION_RESONANCE_WEAK_THRESHOLD
} from "./constants.js";
import { uniqueStrings } from "./lineage.js";

// A combination that reaches full resonance with three or more casters has become a named thing
// in its own right rather than "several people's Skills at once" -- see buildCombinationName.
const COMBINATION_TITLE_PARTICIPANTS = 3;

const COMBINATION_TITLE_PRIORITY = [
  "occult", "occultism", "divine", "religion", "arcane", "spellcasting", "primal", "nature",
  "summoning", "alchemy", "fire", "cold", "electricity", "earth", "air", "water",
  "martial", "precision", "defense", "ranged", "stealth", "mobility", "leadership",
  "medicine", "support", "performance", "craft", "survival"
];
const COMBINATION_TITLE_BANKS = {
  occult: { epithets: ["Shared", "Waking", "Whispered"], nouns: ["Dream", "Communion", "Chorus"] },
  occultism: { epithets: ["Shared", "Waking", "Whispered"], nouns: ["Dream", "Communion", "Chorus"] },
  divine: { epithets: ["Answered", "Joined", "Hallowed"], nouns: ["Prayer", "Benediction", "Descent"] },
  religion: { epithets: ["Answered", "Joined", "Hallowed"], nouns: ["Prayer", "Benediction", "Descent"] },
  arcane: { epithets: ["Woven", "Converging", "Sevenfold"], nouns: ["Confluence", "Working", "Sigil"] },
  spellcasting: { epithets: ["Woven", "Converging", "Sevenfold"], nouns: ["Confluence", "Working", "Sigil"] },
  primal: { epithets: ["Rising", "Rooted", "Untamed"], nouns: ["Season", "Grove", "Stampede"] },
  nature: { epithets: ["Rising", "Rooted", "Untamed"], nouns: ["Season", "Grove", "Stampede"] },
  summoning: { epithets: ["Massed", "Answering", "Thronged"], nouns: ["Host", "Muster", "Legion"] },
  alchemy: { epithets: ["Catalytic", "Cascading", "Volatile"], nouns: ["Reaction", "Chain", "Bloom"] },
  fire: { epithets: ["Converging", "Rising", "Unquenched"], nouns: ["Conflagration", "Pyre", "Firestorm"] },
  cold: { epithets: ["Deepening", "Joined", "Silent"], nouns: ["Winter", "Stillness", "Freeze"] },
  electricity: { epithets: ["Gathering", "Chained", "Rolling"], nouns: ["Storm", "Arc", "Thunderhead"] },
  earth: { epithets: ["Rising", "Immovable", "Deepening"], nouns: ["Bulwark", "Upheaval", "Foundation"] },
  air: { epithets: ["Gathering", "Lifting", "Boundless"], nouns: ["Gale", "Updraft", "Sky"] },
  water: { epithets: ["Rising", "Converging", "Unbroken"], nouns: ["Tide", "Flood", "Confluence"] },
  martial: { epithets: ["Unbroken", "Converging", "Perfect"], nouns: ["Line", "Onslaught", "Formation"] },
  precision: { epithets: ["Concerted", "Unerring", "Perfect"], nouns: ["Volley", "Opening", "Execution"] },
  defense: { epithets: ["Unbroken", "Interlocked", "Immovable"], nouns: ["Wall", "Aegis", "Shieldwall"] },
  ranged: { epithets: ["Massed", "Converging", "Darkening"], nouns: ["Volley", "Rain", "Barrage"] },
  stealth: { epithets: ["Shared", "Soundless", "Unseen"], nouns: ["Passage", "Silence", "Approach"] },
  mobility: { epithets: ["Concerted", "Unbroken", "Headlong"], nouns: ["Advance", "Charge", "Crossing"] },
  leadership: { epithets: ["Answered", "Massed", "Unbroken"], nouns: ["Rally", "Banner", "Command"] },
  medicine: { epithets: ["Joined", "Unfailing", "Concerted"], nouns: ["Mending", "Reprieve", "Vigil"] },
  support: { epithets: ["Joined", "Unfailing", "Steadfast"], nouns: ["Vigil", "Bulwark", "Accord"] },
  performance: { epithets: ["Massed", "Rising", "Unforgettable"], nouns: ["Chorus", "Crescendo", "Refrain"] },
  craft: { epithets: ["Concerted", "Tireless", "Flawless"], nouns: ["Working", "Assembly", "Forge"] },
  survival: { epithets: ["Shared", "Unbroken", "Weathered"], nouns: ["Endurance", "Passage", "Watch"] }
};
const DEFAULT_COMBINATION_TITLE_BANK = { epithets: ["Joined", "Converging", "Unbroken"], nouns: ["Working", "Accord", "Confluence"] };
const RED_COMBINATION_TITLE_BANK = { epithets: ["Shared", "Compounding", "Unclean"], nouns: ["Atrocity", "Complicity", "Ruin"] };

/**
 * How well a set of contributed Skills actually fit together, 0..1, from average pairwise tag
 * overlap.
 *
 * The deliberate inversion of class-merging.js#computeMergeFocus: there, every extra source past
 * two applies a *penalty*, because following more paths at once is a less specialized choice. Here
 * every extra caster past two applies a *bonus*, because a combination is not a life path anyone
 * has to commit to -- it is one moment, and more people managing to land their Skills inside the
 * same moment is straightforwardly harder and straightforwardly more impressive. Same math, opposite
 * sign, opposite meaning.
 */
export function computeCombinationResonance(contributions) {
  assertContributions(contributions);
  const tagSets = contributions.map((contribution) => new Set(contribution.skill?.metadata?.tags ?? []));
  const allTags = uniqueStrings(tagSets.flatMap((set) => [...set]));
  const sharedTags = allTags.filter((tag) => tagSets.every((set) => set.has(tag)));

  let pairCount = 0;
  let pairwiseTotal = 0;
  for (let i = 0; i < tagSets.length; i += 1) {
    for (let j = i + 1; j < tagSets.length; j += 1) {
      pairCount += 1;
      pairwiseTotal += jaccard(tagSets[i], tagSets[j]);
    }
  }
  const averagePairwiseOverlap = pairCount ? pairwiseTotal / pairCount : 0;
  const participantBonus = Math.max(0, contributions.length - 2) * COMBINATION_PARTICIPANT_RESONANCE_BONUS;
  const resonanceScore = clamp01(averagePairwiseOverlap + participantBonus);

  return { resonanceScore, sharedTags, allTags, averagePairwiseOverlap, participantBonus };
}

/** Which of the three behavioral bands a resonance score falls into. */
export function resolveCombinationBand(resonanceScore) {
  if (resonanceScore >= COMBINATION_RESONANCE_STRONG_THRESHOLD) return "amplified";
  if (resonanceScore < COMBINATION_RESONANCE_WEAK_THRESHOLD) return "discordant";
  return "combined";
}

/**
 * The combination's raw magnitude, on its own scale rather than the 1-3 SKILL_TIERS one -- a
 * combination is explicitly allowed to be bigger than any Skill a single character could hold,
 * which is the whole point of the mechanic, and reusing the Skill tier scale would both cap that
 * artificially and invite the result to be mistaken for a registrable Skill entry.
 *
 *   - amplified: every contributor's tier counts, and the whole is multiplied on top.
 *   - combined:  every contributor's tier counts, straight sum. Solid, unremarkable teamwork.
 *   - discordant: only the single strongest contribution lands at all. Skills that share nothing
 *     don't cancel to zero -- the strongest caster still does their thing -- but the others are
 *     wasted, so a badly-matched four-caster combination is genuinely worse than the best of them
 *     acting alone would have been, which is the cost that makes resonance matter.
 */
export function resolveCombinationPower(contributions, resonanceScore) {
  assertContributions(contributions);
  const tiers = contributions.map((contribution) => tierOf(contribution.skill));
  const band = resolveCombinationBand(resonanceScore);
  if (band === "discordant") return Math.max(...tiers);
  const summed = tiers.reduce((total, tier) => total + tier, 0);
  const raw = band === "amplified" ? summed * COMBINATION_AMPLIFIED_MULTIPLIER : summed;
  return Math.min(COMBINATION_MAX_POWER, Math.round(raw));
}

/**
 * The naming grammar, third member of the family class-merging.js and skill-evolution.js already
 * established: the shape of the name says why it was earned.
 *   - discordant: every Skill's name slash-joined -- "Ice Wall / Firebolt / Rally". Visibly
 *     unresolved, because that is what happened: several people did several things at once.
 *   - combined: "Combined <strongest contributor's Skill>" -- one Skill led and the rest genuinely
 *     reinforced it, but the result is still described in terms of the Skill it was built around.
 *   - amplified with three or more casters: a real title of its own, drawn from the shared theme,
 *     with none of the contributors' names in it -- the combination has become its own thing.
 *     Two casters at full resonance stay on the "Combined ..." rung: exceptional, but still
 *     legibly two people's Skills rather than a named working.
 *   - any red contributor: the title rung uses the dark bank instead (red is contagious here for
 *     the same reason it is in a Class merge -- a corrupting influence doesn't cleanly separate out
 *     of something several people did together).
 */
export function buildCombinationName({ contributions, resonanceScore, allTags = [], polarity = "standard" }) {
  assertContributions(contributions);
  const band = resolveCombinationBand(resonanceScore);
  const ordered = orderContributions(contributions);
  if (band === "discordant") {
    return ordered.map((contribution) => contribution.skill.name).join(" / ");
  }
  if (band === "amplified" && contributions.length >= COMBINATION_TITLE_PARTICIPANTS) {
    const bank = polarity === "red" ? RED_COMBINATION_TITLE_BANK : bankFor(allTags);
    return `The ${bank.epithets[0]} ${bank.nouns[0]}`;
  }
  return `Combined ${ordered[0].skill.name}`;
}

/** A short, human-readable line describing what the combination did and why it landed where it did. */
export function describeCombinationRationale({ contributions, resonanceScore, power, polarity = "standard" }) {
  const band = resolveCombinationBand(resonanceScore);
  const roster = contributions
    .map((contribution) => `${contribution.actorName} ([${contribution.skill.name}])`)
    .join(", ");
  let rationale;
  if (band === "amplified") {
    rationale = `${contributions.length} casters landed genuinely resonant Skills inside the same moment -- ${roster} -- and the working amplified rather than merely stacked, reaching power ${power}.`;
  } else if (band === "discordant") {
    rationale = `${roster} fired at once, but the Skills share too little to reinforce each other -- only the strongest lands, at power ${power}, and the rest are spent for nothing.`;
  } else {
    rationale = `${roster} combined cleanly: every contribution counts toward a power ${power} working, without the resonance to amplify beyond the sum of them.`;
  }
  if (polarity === "red") {
    rationale += " Everyone who joined this shares in what it cost -- the malignance of a red contribution spreads across the whole working.";
  }
  return rationale;
}

/**
 * The full pipeline in one call. `contributions` is `[{ actorId, actorName, skill }]` where `skill`
 * is that actor's own approved registry Skill entry; `effect` is what the combination actually does
 * at the table, which only a GM can supply (this module never invents mechanics, same as
 * skill-evolution.js). Returns a transient combination record -- api.js#castCombinationSkill puts a
 * temporary Item on every participant from it and records it in each one's combination history, but
 * it never enters anyone's Class/Skill registry.
 */
export function buildCombinationSkill({ contributions, id, effect, duration = "1 round", rationale, polarity, malignance }) {
  assertContributions(contributions);
  assertDistinctActors(contributions);
  if (typeof effect !== "string" || !effect.trim()) {
    throw new Error("A combination requires an effect describing what it actually does.");
  }
  const { resonanceScore, sharedTags, allTags, averagePairwiseOverlap, participantBonus } = computeCombinationResonance(contributions);
  const band = resolveCombinationBand(resonanceScore);
  const power = resolveCombinationPower(contributions, resonanceScore);
  const resolvedPolarity = polarity ?? (contributions.some((c) => c.skill?.metadata?.polarity === "red") ? "red" : "standard");
  const resolvedMalignance = resolvedPolarity === "red" ? (malignance ?? resolveCombinedMalignance(contributions)) : null;
  const name = buildCombinationName({ contributions, resonanceScore, allTags, polarity: resolvedPolarity });

  return {
    id: id ?? `combination:${slugify(name)}`,
    name,
    band,
    power,
    resonance: {
      score: round2(resonanceScore),
      averagePairwiseOverlap: round2(averagePairwiseOverlap),
      participantBonus: round2(participantBonus),
      sharedTags
    },
    tags: allTags,
    effect: effect.trim(),
    duration,
    polarity: resolvedPolarity,
    ...(resolvedMalignance ? { malignance: resolvedMalignance } : {}),
    participants: contributions.map((contribution) => ({
      actorId: contribution.actorId ?? null,
      actorName: contribution.actorName ?? "Unknown",
      skillId: contribution.skill.metadata?.id ?? null,
      skillName: contribution.skill.name,
      tier: tierOf(contribution.skill)
    })),
    rationale: rationale ?? describeCombinationRationale({ contributions, resonanceScore, power, polarity: resolvedPolarity })
  };
}

/**
 * The growth event each participant earns for having been part of the combination -- the reason
 * this mechanic belongs in a progression tool at all.
 *
 * Tagged with the WHOLE combination's tag set rather than only the participant's own contribution,
 * on purpose: standing inside a working somebody else was holding up is exactly how a character
 * first accumulates evidence in a discipline they have never trained. It is self-limiting (you
 * have to actually be in the combination, contributing a real approved Skill of your own), and it
 * is the cross-training story canon keeps telling.
 *
 * An `amplified` combination defaults to a criticalSuccess outcome, which is not just a bigger
 * number: skill-evolution.js#isDefiningMoment treats a critical outcome as a defining moment, so a
 * genuinely great combination can be the crisis that evolves one of the Skills that made it.
 */
export function buildCombinationGrowthEvent(combination, participant, { outcome, dangerGap, occurredAt } = {}) {
  const resolvedOutcome = outcome ?? (combination.band === "amplified" ? "criticalSuccess" : "success");
  return {
    summary: `${participant.actorName} contributed [${participant.skillName}] to ${combination.name} (${combination.band} combination, power ${combination.power}) alongside ${combination.participants.length - 1} other caster${combination.participants.length === 2 ? "" : "s"}.`,
    tags: combination.tags,
    outcome: resolvedOutcome,
    ...(dangerGap !== undefined ? { dangerGap } : {}),
    ...(occurredAt !== undefined ? { occurredAt } : {})
  };
}

function resolveCombinedMalignance(contributions) {
  const red = contributions.filter((c) => c.skill?.metadata?.polarity === "red" && c.skill?.metadata?.malignance);
  if (!red.length) return null;
  const drawbacks = uniqueStrings(red.map((c) => c.skill.metadata.malignance.drawback));
  return {
    vice: red[0].skill.metadata.malignance.vice,
    drawback: drawbacks.length > 1
      ? `Every participant shares in each red contribution's cost: ${drawbacks.join(" ")}`
      : drawbacks[0]
  };
}

function bankFor(tags) {
  const tagSet = new Set(tags);
  const category = COMBINATION_TITLE_PRIORITY.find((tag) => tagSet.has(tag));
  return (category && COMBINATION_TITLE_BANKS[category]) ?? DEFAULT_COMBINATION_TITLE_BANK;
}

function orderContributions(contributions) {
  return [...contributions].sort((a, b) => tierOf(b.skill) - tierOf(a.skill));
}

function tierOf(skill) {
  return Number.isInteger(skill?.tier) ? skill.tier : 1;
}

function jaccard(a, b) {
  const intersectionSize = [...a].filter((tag) => b.has(tag)).length;
  const unionSize = new Set([...a, ...b]).size;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function slugify(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "unnamed";
}

function assertContributions(contributions) {
  if (!Array.isArray(contributions) || contributions.length < 2) {
    throw new Error("A Combination Skill requires at least two contributed Skills.");
  }
  for (const contribution of contributions) {
    if (!contribution?.skill?.name) {
      throw new Error("Every combination contribution requires an approved Skill entry.");
    }
  }
}

function assertDistinctActors(contributions) {
  const ids = contributions.map((contribution) => contribution.actorId).filter(Boolean);
  if (new Set(ids).size !== ids.length) {
    throw new Error("A Combination Skill is a multi-caster working -- each contribution must come from a different actor.");
  }
}
