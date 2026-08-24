import { CLASS_EVOLUTION_LEVELS } from "./constants.js";
import { uniqueStrings } from "./lineage.js";

// How much average pairwise tag overlap two-or-more source Classes need before a merge counts
// as "tightly specialized" (can reach one tier above its strongest source, and unlocks the
// comma-joined naming style) versus "generalist" (capped at standard power regardless of how
// strong any single source was). Middling focus (between the two) just holds at the strongest
// source's own tier -- neither rewarded nor punished.
export const MERGE_FOCUS_STRONG_THRESHOLD = 0.5;
export const MERGE_FOCUS_WEAK_THRESHOLD = 0.2;
// Every source class beyond the first two chips away at focus a little more: following three,
// four, or five different paths at once is a meaningfully more generalist choice than combining
// two closely related ones, even if every individual pair happens to share a tag or two.
const GENERALIZATION_PENALTY_PER_EXTRA_SOURCE = 0.12;

const POWER_TIER_RANK = { standard: 0, elevated: 1, prestige: 2 };
const POWER_TIER_BY_RANK = ["standard", "elevated", "prestige"];

// A level-50-or-higher merge that is ALSO prestige tier and tightly focused has earned its own
// grandiose, wordy title instead of a name built from its sources' own names -- the character
// has transcended being "two classes stapled together" into something singular. Anchored to the
// highest Grand Design class-evolution checkpoint rather than a bare literal.
export const LEGENDARY_TITLE_LEVEL = Math.max(...CLASS_EVOLUTION_LEVELS);

// Deliberately small, curated word banks keyed by a dominant tag -- picked in priority order so
// the result is deterministic (no Math.random / Date.now, which also keeps this callable from
// plain Node tests). A GM or the AI proposal pipeline is always free to hand-edit the result
// before it's approved; this only needs to produce a strong, on-theme starting point.
const LEGENDARY_TITLE_PRIORITY = [
  "occult", "occultism", "divine", "religion", "arcane", "spellcasting", "primal", "nature",
  "martial", "stealth", "leadership", "craft", "alchemy", "fire", "cold", "electricity",
  "earth", "air", "water", "support", "survival", "mobility"
];
const LEGENDARY_TITLE_BANKS = {
  occult: { epithets: ["Ephemeral", "Veiled", "Half-Remembered"], roles: ["Purveyor", "Custodian", "Wanderer"], domains: ["Lost Dreams", "the Unspoken Hour", "the Dreaming Dark"] },
  occultism: { epithets: ["Ephemeral", "Veiled", "Half-Remembered"], roles: ["Purveyor", "Custodian", "Wanderer"], domains: ["Lost Dreams", "the Unspoken Hour", "the Dreaming Dark"] },
  divine: { epithets: ["Anointed", "Undying", "Radiant"], roles: ["Vessel", "Herald", "Shepherd"], domains: ["the Final Prayer", "an Unbroken Vow", "the Last Light"] },
  religion: { epithets: ["Anointed", "Undying", "Radiant"], roles: ["Vessel", "Herald", "Shepherd"], domains: ["the Final Prayer", "an Unbroken Vow", "the Last Light"] },
  arcane: { epithets: ["Astral", "Sundering", "Boundless"], roles: ["Weaver", "Archon", "Confluence"], domains: ["the Unwritten Word", "Bent Starlight", "the Second Sky"] },
  spellcasting: { epithets: ["Astral", "Sundering", "Boundless"], roles: ["Weaver", "Archon", "Confluence"], domains: ["the Unwritten Word", "Bent Starlight", "the Second Sky"] },
  primal: { epithets: ["Wildbound", "Rootdeep", "Feral"], roles: ["Warden", "Kindred", "Elder"], domains: ["the First Growth", "the Old Wilds", "a Thousand Seasons"] },
  nature: { epithets: ["Wildbound", "Rootdeep", "Feral"], roles: ["Warden", "Kindred", "Elder"], domains: ["the First Growth", "the Old Wilds", "a Thousand Seasons"] },
  martial: { epithets: ["Unbroken", "Ironclad", "Storm-Wreathed"], roles: ["Warlord", "Blademaster", "Sentinel"], domains: ["a Thousand Battles", "the Shattered Line", "the Last Stand"] },
  stealth: { epithets: ["Unseen", "Silent", "Ash-Footed"], roles: ["Shade", "Whisper", "Reaper"], domains: ["the Blind Hour", "a Thousand Doors", "the Empty Room"] },
  leadership: { epithets: ["Undaunted", "Bannerborn", "Steadfast"], roles: ["Warden", "Marshal", "Voice"], domains: ["a Thousand Banners", "the Unbroken Line", "the Long March"] },
  craft: { epithets: ["Unerring", "Tireless", "Silt-Handed"], roles: ["Artisan", "Engineer", "Wright"], domains: ["a Thousand Failures", "the Forgotten Forge", "an Unfinished Work"] },
  alchemy: { epithets: ["Volatile", "Distilled", "Ever-Mixing"], roles: ["Alchemist", "Concoctor", "Reagent"], domains: ["a Thousand Formulae", "the Last Reagent", "the Boiling Hour"] },
  fire: { epithets: ["Ember-Wreathed", "Undying", "Cinder-Born"], roles: ["Ashwalker", "Kindler", "Pyre"], domains: ["the Last Ember", "a Thousand Fires", "the Long Burn"] },
  cold: { epithets: ["Frostbound", "Silent", "Hollow-Aired"], roles: ["Warden", "Wanderer", "Sentinel"], domains: ["the Long Winter", "a Thousand Frosts", "the Frozen Hour"] },
  electricity: { epithets: ["Storm-Wreathed", "Thundering", "Arc-Lit"], roles: ["Herald", "Conduit", "Warden"], domains: ["the Endless Storm", "a Thousand Strikes", "the Charged Hour"] },
  earth: { epithets: ["Stoneheart", "Unmoved", "Root-Deep"], roles: ["Warden", "Bulwark", "Anchor"], domains: ["the Old Bedrock", "a Thousand Seasons", "the Deep Foundation"] },
  air: { epithets: ["Windborne", "Skyward", "Unweighted"], roles: ["Wanderer", "Herald", "Drifter"], domains: ["the Open Sky", "a Thousand Currents", "the High Air"] },
  water: { epithets: ["Tideborn", "Flood-Marked", "Undrowned"], roles: ["Ferryman", "Warden", "Wanderer"], domains: ["the Rising Canal", "a Thousand Tides", "the Deep Current"] },
  support: { epithets: ["Steadfast", "Tireless", "Hearth-Bound"], roles: ["Keeper", "Shepherd", "Anchor"], domains: ["a Thousand Vigils", "the Long Watch", "the Quiet Hour"] },
  survival: { epithets: ["Weathered", "Unlost", "Trail-Worn"], roles: ["Pathfinder", "Wanderer", "Warden"], domains: ["a Thousand Trails", "the Long Road", "the Uncharted Hour"] },
  mobility: { epithets: ["Fleetfooted", "Unbound", "Wind-Stepped"], roles: ["Runner", "Wanderer", "Drifter"], domains: ["a Thousand Roads", "the Open Path", "the Long Stride"] }
};
const DEFAULT_LEGENDARY_TITLE_BANK = { epithets: ["Boundless", "Unnamed", "Ever-Changing"], roles: ["Wanderer", "Vessel", "Keeper"], domains: ["a Thousand Paths", "the Long Road", "an Unwritten Fate"] };

// A DELIBERATE generalist -- someone who pursued breadth itself as a discipline, on purpose,
// rather than dabbling without commitment -- earns its own legendary title bank when that breadth
// reaches level-50 prestige. Not tag-keyed like LEGENDARY_TITLE_BANKS above: a true polymath by
// definition has no single dominant theme, so the bank is fixed rather than picked by tag.
const POLYMATH_LEGENDARY_BANK = { epithets: ["Boundless", "All-Walking", "Ever-Learning"], roles: ["Polymath", "Virtuoso", "Sage"], domains: ["Ten Thousand Paths", "Every Discipline", "No Single Road"] };

// Dark counterpart to LEGENDARY_TITLE_BANKS, keyed by vice (see vice-taxonomy.js) instead of
// gameplay tag, for a merge whose polarity is "red" (see resolveMergedPolarity below). Used at
// every naming tier a red merge reaches a legendary title, whether that's via tight focus
// (specialization in vice) or deliberate breadth (a polymath of vices).
const RED_LEGENDARY_TITLE_BANKS = {
  bloodlust: { epithets: ["Blood-Soaked", "Unrepentant", "Ravenous"], roles: ["Reaver", "Butcher", "Executioner"], domains: ["a Thousand Kills", "the Endless Slaughter", "the Red Ledger"] },
  cruelty: { epithets: ["Merciless", "Gleeful", "Unfeeling"], roles: ["Tormentor", "Inquisitor", "Breaker"], domains: ["a Thousand Screams", "the Long Cruelty", "the Broken Hour"] },
  subjugation: { epithets: ["Iron-Fisted", "Unyielding", "Absolute"], roles: ["Overlord", "Master", "Breaker of Wills"], domains: ["a Thousand Chains", "the Conquered Realm", "the Silent Yoke"] },
  servitude: { epithets: ["Chained", "Unfreed", "Branded"], roles: ["Bondsman", "Thrall", "the Yoked"], domains: ["a Thousand Masters", "the Unbroken Chain", "the Long Bondage"] },
  addiction: { epithets: ["Craving", "Hollow", "Unquenched"], roles: ["Wretch", "the Sworn", "the Thirsting"], domains: ["a Thousand Cups", "the Endless Thirst", "the Empty Well"] },
  corruption: { epithets: ["Rotten", "Hollowed", "Unclean"], roles: ["Husk", "the Bargained", "Wretch"], domains: ["a Thousand Bargains", "the Long Rot", "the Hollow Pact"] },
  desecration: { epithets: ["Profane", "Blighted", "Unholy"], roles: ["Defiler", "Blasphemer", "the Fallen"], domains: ["a Thousand Graves", "the Broken Altar", "the Last Sacrilege"] },
  betrayal: { epithets: ["Faithless", "Twice-Sworn", "Unforgiven"], roles: ["Turncoat", "the Unfaithful", "Backstabber"], domains: ["a Thousand Broken Oaths", "the Long Betrayal", "the Knife's Edge"] },
  ruin: { epithets: ["Ashen", "Wasted", "Undone"], roles: ["the Ruined", "Wastrel", "the Fallen"], domains: ["a Thousand Ashes", "the Long Ruin", "the Salted Earth"] }
};
const DEFAULT_RED_LEGENDARY_TITLE_BANK = { epithets: ["Damned", "Unmade", "Forsaken"], roles: ["the Cursed", "the Marked", "the Broken"], domains: ["a Thousand Sins", "the Long Fall", "the Unmarked Grave"] };

/**
 * How thematically coherent a set of source Classes is. Returns 0..1: 0 means the sources share
 * nothing in common (a pure generalist grab-bag), 1 means every source overlaps completely. Uses
 * *average pairwise* Jaccard overlap (not "any tag shared by all") so it correctly tells apart a
 * tight two-class combo from a three-or-more-class blend where only a single tag happens to be
 * universal. Every extra source beyond two applies an additional generalization penalty on top,
 * since spreading across more disciplines is itself a less specialized choice.
 */
export function computeMergeFocus(sourceClasses) {
  assertSources(sourceClasses);
  const tagSets = sourceClasses.map((source) => new Set(source.metadata?.tags ?? []));
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
  const breadthPenalty = Math.max(0, sourceClasses.length - 2) * GENERALIZATION_PENALTY_PER_EXTRA_SOURCE;
  const focusScore = clamp01(averagePairwiseOverlap - breadthPenalty);

  return { focusScore, sharedTags, allTags, averagePairwiseOverlap, breadthPenalty };
}

/**
 * A tightly focused merge (following one's own path closely) can reach one power tier above its
 * strongest source, up to prestige. A generalist blend (too much spread across unrelated
 * disciplines) is normally capped at standard no matter how powerful any individual source was on
 * its own -- UNLESS that breadth was *intentional*: pass `{ intentional: true }` when the
 * character deliberately pursued generalization as its own discipline (evidence-backed, not just
 * "they happened to dabble"). An intentional generalist isn't measured by its single best source
 * the way a focused specialist is -- there IS no "best" discipline to lean on, the point is the
 * breadth itself -- so it climbs one tier above the AVERAGE of its sources' tiers instead, up to
 * prestige. Anything in the middle band (neither tightly focused nor weakly scattered) just holds
 * at the strongest source's tier, same as before, regardless of intentional.
 *
 * "Off-classing": canon distinguishes an on-cadence Class evolution (at one of Grand Design's own
 * checkpoint levels, CLASS_EVOLUTION_LEVELS -- 20/30/50) from one forced through off that cadence,
 * and the off-cycle one is weaker. Pass `{ offCycle: true }` (see mergeClassEntry's actorLevel
 * param) to suppress BOTH upward-tier bonuses above -- a tightly focused or intentionally broad
 * merge still happens off-cycle, but it never climbs beyond what its sources already collectively
 * justify (the strongest source's own tier). It is not an additional penalty below that floor --
 * an off-cycle merge is exactly as good as a same-cycle "middle band" one, just never better.
 */
export function resolveMergedPowerTier(sourceClasses, focusScore, { intentional = false, offCycle = false } = {}) {
  assertSources(sourceClasses);
  const ranks = sourceClasses.map((source) => POWER_TIER_RANK[source.power_tier] ?? 0);
  const highestSourceRank = Math.max(...ranks);
  if (focusScore < MERGE_FOCUS_WEAK_THRESHOLD) {
    if (!intentional) return "standard";
    if (offCycle) return POWER_TIER_BY_RANK[highestSourceRank];
    const averageRank = ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length;
    return POWER_TIER_BY_RANK[Math.min(Math.round(averageRank) + 1, POWER_TIER_BY_RANK.length - 1)];
  }
  if (focusScore >= MERGE_FOCUS_STRONG_THRESHOLD) {
    if (offCycle) return POWER_TIER_BY_RANK[highestSourceRank];
    return POWER_TIER_BY_RANK[Math.min(highestSourceRank + 1, POWER_TIER_BY_RANK.length - 1)];
  }
  return POWER_TIER_BY_RANK[highestSourceRank];
}

/**
 * The naming rule this module encodes: more powerful merges get longer, more distinctive names,
 * but length by itself isn't power -- WHY a merge earned its length is what the shape encodes.
 *   - An unrewarded generalist blend (low focus, not intentional) is named by stringing every
 *     source's name together -- visibly long, but that length is the cost of spreading thin
 *     without a real breadth-mastery to show for it.
 *   - A workable, moderately focused merge reads as one flowing phrase: "Primary of Secondary".
 *   - A tightly focused, prestige-tier merge keeps both source identities fully intact instead of
 *     melting them into one phrase -- denoted by joining the source names with a comma instead of
 *     "of": "Primary, Secondary".
 *   - An INTENTIONAL generalist blend that actually climbed a tier (see resolveMergedPowerTier)
 *     gets that same comma treatment across every source -- its breadth is real strength, so every
 *     identity stays intact rather than reading as an unsorted pile.
 *   - A tightly focused, prestige-tier merge at or above the level-50 class-evolution checkpoint
 *     has transcended its components entirely and earns a wordy, grandiose title built from its
 *     dominant theme instead of its sources' literal names -- and so does an intentional
 *     generalist that reaches the same checkpoint, via its own polymath-flavored title bank.
 *   - When `polarity` is "red" (see resolveMergedPolarity), any legendary title drawn here comes
 *     from the dark, vice-keyed bank instead of the heroic tag-keyed one.
 */
export function buildMergedClassName({ sourceClasses, powerTier, focusScore, level = 1, intentional = false, polarity = "standard", vice = null }) {
  const ordered = orderSources(sourceClasses);
  const isRed = polarity === "red";
  const reachedLegendaryLevel = level >= LEGENDARY_TITLE_LEVEL && powerTier === "prestige";
  const isFocusedLegendary = reachedLegendaryLevel && focusScore >= MERGE_FOCUS_STRONG_THRESHOLD;
  const isPolymathLegendary = reachedLegendaryLevel && intentional && focusScore < MERGE_FOCUS_WEAK_THRESHOLD;

  if (isFocusedLegendary || isPolymathLegendary) {
    if (isRed) return buildRedLegendaryTitle(vice);
    if (isPolymathLegendary) return buildPolymathLegendaryTitle();
    const { allTags } = computeMergeFocus(ordered);
    return buildLegendaryTitle(allTags);
  }
  if (powerTier === "prestige" && focusScore >= MERGE_FOCUS_STRONG_THRESHOLD) {
    return ordered.map((source) => source.name).join(", ");
  }
  if (focusScore < MERGE_FOCUS_WEAK_THRESHOLD) {
    if (intentional && powerTier !== "standard") {
      // Deliberate breadth that actually paid off -- every discipline's identity is preserved,
      // same convention as the focused-specialist comma-join above, for the same reason: nothing
      // here was diluted away.
      return ordered.map((source) => source.name).join(", ");
    }
    return ordered.map((source) => source.name).join(" ");
  }
  const [primary, ...rest] = ordered;
  return `${primary.name} of ${rest.map((source) => source.name).join(" and ")}`;
}

/** A short, human-readable line for the merged entry's lineage.rationale, if the caller doesn't supply their own. */
export function describeMergeRationale({ sourceClasses, focusScore, powerTier, intentional = false, polarity = "standard", offCycle = false }) {
  const names = sourceClasses.map((source) => source.name).join(" and ");
  let rationale;
  if (focusScore >= MERGE_FOCUS_STRONG_THRESHOLD) {
    rationale = `A tightly specialized fusion of ${names} -- the character has followed both paths closely enough that neither discipline dilutes the other, reaching ${powerTier} power.`;
  } else if (focusScore < MERGE_FOCUS_WEAK_THRESHOLD && intentional) {
    rationale = `A deliberate, wide-ranging mastery across ${names} -- the character pursued breadth as its own discipline on purpose, reaching ${powerTier} power precisely because that generalization was intentional, not accidental.`;
  } else if (focusScore < MERGE_FOCUS_WEAK_THRESHOLD) {
    rationale = `A broad, uncommitted blend of ${names} -- spreading practice across too many unrelated disciplines without real intent behind it keeps this at ${powerTier} power despite the number of paths involved.`;
  } else {
    rationale = `A workable fusion of ${names}, holding steady at ${powerTier} power without fully specializing or diluting.`;
  }
  if (polarity === "red") {
    rationale += " The fusion carries its sources' malignance forward as well -- power bought here is never clean.";
  }
  if (offCycle) {
    rationale += " Forced through off the Grand Design's own evolution cadence (levels 20/30/50) -- a genuine evolution, but one that never climbs beyond what its sources already collectively justify.";
  }
  return rationale;
}

/**
 * The full pipeline in one call: given approved registry Class entries (as returned by
 * `GrandDesignApi#getActorRegistry(actor).classes`) and the mechanical shell of the new Class
 * (gameItem/mechanics), produces a ready-to-approve Class entry -- name, power_tier, and
 * metadata.lineage all computed from the sources themselves rather than hand-picked. Pass the
 * result straight to `api.combineClasses(actor, entry)`, or inspect/edit `entry.name` first.
 *
 * `intentional: true` marks the breadth as deliberate (see resolveMergedPowerTier) for a
 * generalist blend that should be rewarded rather than capped -- pass this when the evidence
 * shows the character genuinely pursued many disciplines on purpose, not just dabbled.
 *
 * Red polarity (see vice-taxonomy.js) is normally auto-detected by contagion: if ANY source
 * Class is itself metadata.polarity === "red", the merge inherits "red" too (a corrupting
 * influence doesn't cleanly separate out of a fusion) and its malignance is drawn from whichever
 * red source(s) contributed it. Pass explicit `polarity`/`malignance` to override this -- e.g. to
 * mark an otherwise-standard merge red on purpose, or to hand-author a combined drawback.
 *
 * "Off-classing" (canon: an evolution forced off the Grand Design's own cadence is weaker): pass
 * `actorLevel` as the actor's own current overall Grand Design level (GrandDesignApi#getLevelProgression(actor).level)
 * so this can tell whether the evolution lands on one of CLASS_EVOLUTION_LEVELS (20/30/50) or not.
 * Omit it (the default) to skip the check entirely and resolve exactly as before -- this keeps
 * every existing caller that doesn't have an actor in scope (tests, previews with no actor
 * context) behaving unchanged. When provided and off-cadence, the merge still happens -- it's
 * never blocked here, only capped (see resolveMergedPowerTier) -- and the returned entry carries
 * `offCycleEvolution: true` so a GM/UI can flag it as such.
 */
export function mergeClassEntry({
  sourceClasses,
  level,
  gameItem,
  mechanics,
  tags = [],
  rationale,
  systemChassis,
  intentional = false,
  polarity,
  malignance,
  actorLevel = null
}) {
  assertSources(sourceClasses);
  if (!Number.isInteger(level) || level < 1) {
    throw new Error("A merged Class requires an integer level of at least 1.");
  }
  const offCycle = actorLevel !== null && !CLASS_EVOLUTION_LEVELS.has(actorLevel);
  const { focusScore, allTags } = computeMergeFocus(sourceClasses);
  const powerTier = resolveMergedPowerTier(sourceClasses, focusScore, { intentional, offCycle });
  const resolvedPolarity = polarity ?? resolveMergedPolarity(sourceClasses);
  const resolvedMalignance = resolvedPolarity === "red"
    ? (malignance ?? resolveMergedMalignance(sourceClasses))
    : null;
  const name = buildMergedClassName({
    sourceClasses,
    powerTier,
    focusScore,
    level,
    intentional,
    polarity: resolvedPolarity,
    vice: resolvedMalignance?.vice ?? null
  });
  const primary = orderSources(sourceClasses)[0];

  return {
    name,
    level,
    power_tier: powerTier,
    offCycleEvolution: offCycle,
    system_chassis: systemChassis ?? primary.system_chassis ?? "Pending chassis review",
    metadata: {
      tags: uniqueStrings([...tags, ...allTags]),
      ...(resolvedPolarity === "red" ? { polarity: "red", malignance: resolvedMalignance } : {}),
      lineage: {
        operation: "combine",
        sources: sourceClasses.map((source) => requireSourceId(source)),
        rationale: rationale ?? describeMergeRationale({ sourceClasses, focusScore, powerTier, intentional, polarity: resolvedPolarity, offCycle })
      }
    },
    gameItem,
    mechanics
  };
}

/** Red is contagious: a merge with any red source is red too, since a corrupting influence doesn't cleanly separate out. */
function resolveMergedPolarity(sourceClasses) {
  return sourceClasses.some((source) => source.metadata?.polarity === "red") ? "red" : "standard";
}

/** Combines the malignance of every red source into one { vice, drawback } for the merged entry. */
function resolveMergedMalignance(sourceClasses) {
  const redSources = sourceClasses.filter((source) => source.metadata?.polarity === "red" && source.metadata?.malignance);
  if (!redSources.length) return null;
  const vice = redSources[0].metadata.malignance.vice;
  const drawbacks = uniqueStrings(redSources.map((source) => source.metadata.malignance.drawback));
  return {
    vice,
    drawback: drawbacks.length > 1
      ? `Carries forward every source's malignance: ${drawbacks.join(" ")}`
      : drawbacks[0]
  };
}

function buildLegendaryTitle(tags) {
  const tagSet = new Set(tags);
  const category = LEGENDARY_TITLE_PRIORITY.find((tag) => tagSet.has(tag));
  const bank = (category && LEGENDARY_TITLE_BANKS[category]) ?? DEFAULT_LEGENDARY_TITLE_BANK;
  return `The ${bank.epithets[0]} ${bank.roles[0]} of ${bank.domains[0]}`;
}

function buildPolymathLegendaryTitle() {
  const bank = POLYMATH_LEGENDARY_BANK;
  return `The ${bank.epithets[0]} ${bank.roles[0]} of ${bank.domains[0]}`;
}

function buildRedLegendaryTitle(vice) {
  const bank = (vice && RED_LEGENDARY_TITLE_BANKS[vice]) ?? DEFAULT_RED_LEGENDARY_TITLE_BANK;
  return `The ${bank.epithets[0]} ${bank.roles[0]} of ${bank.domains[0]}`;
}

function orderSources(sourceClasses) {
  const rank = (source) => (source.is_primary ? 2 : source.is_secondary ? 1 : 0);
  return [...sourceClasses].sort((a, b) => rank(b) - rank(a));
}

function jaccard(a, b) {
  const intersectionSize = [...a].filter((tag) => b.has(tag)).length;
  const unionSize = new Set([...a, ...b]).size;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function assertSources(sourceClasses) {
  if (!Array.isArray(sourceClasses) || sourceClasses.length < 2) {
    throw new Error("Merging a Class requires at least two source Classes.");
  }
}

function requireSourceId(source) {
  const id = source?.metadata?.id;
  if (typeof id !== "string" || !id.trim()) {
    throw new Error(`Source Class "${source?.name ?? "unknown"}" has no registry ID to record as lineage.`);
  }
  return id;
}
