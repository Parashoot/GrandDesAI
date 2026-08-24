import {
  CLASS_EVOLUTION_LEVELS,
  DANGER_GAP_MULTIPLIERS,
  GRAND_DESIGN_MAX_LEVEL,
  GROWTH_EVENT_OUTCOME_WEIGHTS,
  GROWTH_EVENTS_FLAG,
  GROWTH_PROPOSALS_FLAG,
  LEVEL_PROGRESSION_FLAG,
  MODULE_ID
} from "./constants.js";
import { weightForTag } from "./tag-weighting.js";

// The weighted-evidence total a required tag needs before a proposal template fires. Calibrated
// against "success" outcomes (weight 1 each) so the long-standing rule of thumb -- three tagged
// successes earns a proposal -- is unchanged; the same threshold can now also be reached by more
// numerous failures/criticalFailures, or a mix, since they carry a smaller weight each rather than
// being excluded outright.
const MINIMUM_EVIDENCE = 3;
// Progress points a single "success" outcome contributes toward a Grand Design level; every other
// outcome scales off this via GROWTH_EVENT_OUTCOME_WEIGHTS (e.g. criticalSuccess = 1.6x this).
const BASE_SUCCESS_PROGRESS = 25;

const PROPOSAL_TEMPLATES = [
  {
    id: "canal-step",
    requiredTags: ["mobility", "water"],
    entry: {
      name: "Canal Step",
      tier: 1,
      system_equivalent: "Athletics or Acrobatics movement action",
      gameItem: { kind: "action" },
      mechanics: {
        effect: "Stride up to half your Speed. On a success, ignore difficult terrain from shallow water during that movement.",
        duration: "instant",
        frequency: { max: 1, per: "round" },
        actions: 1,
        roll: { kind: "Athletics check", formula: "", dc: 15 }
      },
      metadata: {
        tags: ["mobility", "water"],
        lineage: { operation: "origin", sources: [], rationale: "" }
      }
    }
  },
  {
    id: "field-ration",
    requiredTags: ["craft", "support"],
    entry: {
      name: "Field Ration",
      tier: 1,
      system_equivalent: "Crafting support feat",
      gameItem: { kind: "passive" },
      mechanics: {
        effect: "During daily preparations, create one temporary ration. The first ally who consumes it that day gains 1 temporary Hit Point for 8 hours.",
        duration: "8 hours",
        frequency: { max: 1, per: "day" }
      },
      metadata: {
        tags: ["craft", "support"],
        lineage: { operation: "origin", sources: [], rationale: "" }
      }
    }
  },
  {
    id: "measured-strike",
    requiredTags: ["martial", "precision"],
    entry: {
      name: "Measured Strike",
      tier: 2,
      system_equivalent: "Class-feat-scale martial action",
      gameItem: { kind: "action" },
      mechanics: {
        effect: "Make a melee Strike. On a success, deal 1d6 additional precision damage.",
        duration: "instant",
        frequency: { max: 1, per: "round" },
        actions: 1,
        roll: { kind: "Melee attack", formula: "", dc: 18 }
      },
      metadata: {
        tags: ["martial", "precision"],
        lineage: { operation: "origin", sources: [], rationale: "" }
      }
    }
  },
  {
    id: "ember-pulse",
    requiredTags: ["fire", "spellcasting"],
    entry: {
      name: "Ember Pulse",
      tier: 2,
      system_equivalent: "Rank 1 elemental spell",
      gameItem: { kind: "spell", rank: 1, tradition: "arcane", school: "evo" },
      mechanics: {
        effect: "Make a spell attack against one creature within 30 feet. On a success, deal 2d6 fire damage.",
        duration: "instant",
        frequency: { max: 2, per: "encounter" },
        actions: 2,
        roll: { kind: "Spell attack", formula: "", dc: 17 }
      },
      metadata: {
        tags: ["fire", "spellcasting"],
        lineage: { operation: "origin", sources: [], rationale: "" }
      }
    }
  },
  {
    id: "field-triage",
    requiredTags: ["medicine", "support"],
    entry: {
      name: "Field Triage",
      tier: 1,
      system_equivalent: "Medicine support action",
      gameItem: { kind: "action" },
      mechanics: {
        effect: "Attempt to Treat Wounds on one adjacent living creature. On a success, it regains 1d8 Hit Points.",
        duration: "10 minutes",
        frequency: { max: 1, per: "hour" },
        actions: 2,
        roll: { kind: "Medicine check", formula: "", dc: 15 }
      },
      metadata: {
        tags: ["medicine", "support"],
        lineage: { operation: "origin", sources: [], rationale: "" }
      }
    }
  },
  {
    id: "shadow-thread",
    requiredTags: ["stealth", "precision"],
    entry: {
      name: "Shadow Thread",
      tier: 2,
      system_equivalent: "Stealth reaction",
      gameItem: { kind: "reaction" },
      mechanics: {
        effect: "Step 5 feet into cover or concealment. On a success, the triggering ranged Strike takes a -1 circumstance penalty.",
        duration: "instant",
        frequency: { max: 1, per: "round" },
        trigger: "A creature targets you with a ranged Strike while you are concealed or in cover.",
        roll: { kind: "Stealth check", formula: "", dc: 18 }
      },
      metadata: {
        tags: ["stealth", "precision"],
        lineage: { operation: "origin", sources: [], rationale: "" }
      }
    }
  },
  {
    id: "rallying-call",
    requiredTags: ["leadership", "support"],
    entry: {
      name: "Rallying Call",
      tier: 2,
      system_equivalent: "Leadership free action",
      gameItem: { kind: "free" },
      mechanics: {
        effect: "One ally within 30 feet gains a +1 circumstance bonus to its next saving throw before the start of your next turn.",
        duration: "until the start of your next turn",
        frequency: { max: 1, per: "round" },
        roll: { kind: "Diplomacy check", formula: "", dc: 18 }
      },
      metadata: {
        tags: ["leadership", "support"],
        lineage: { operation: "origin", sources: [], rationale: "" }
      }
    }
  },
  {
    id: "warden-brace",
    requiredTags: ["defense", "martial"],
    entry: {
      name: "Warden's Brace",
      tier: 2,
      system_equivalent: "Martial defense reaction",
      gameItem: { kind: "reaction" },
      mechanics: {
        effect: "Gain resistance 2 to the triggering physical damage. On a success, an adjacent ally also gains the resistance.",
        duration: "instant",
        frequency: { max: 1, per: "round" },
        trigger: "You or an adjacent ally takes physical damage from a Strike.",
        roll: { kind: "Athletics check", formula: "", dc: 18 }
      },
      metadata: {
        tags: ["defense", "martial"],
        lineage: { operation: "origin", sources: [], rationale: "" }
      }
    }
  },
  {
    id: "trail-sense",
    requiredTags: ["survival", "nature"],
    entry: {
      name: "Trail Sense",
      tier: 1,
      system_equivalent: "Survival exploration feat",
      gameItem: { kind: "passive" },
      mechanics: {
        effect: "When you Follow the Expert in natural terrain, one ally gains a +1 circumstance bonus to Survival checks to Avoid Getting Lost.",
        duration: "while exploring natural terrain",
        frequency: { max: 1, per: "unlimited" }
      },
      metadata: {
        tags: ["survival", "nature"],
        lineage: { operation: "origin", sources: [], rationale: "" }
      }
    }
  },
  {
    id: "winter-veil",
    requiredTags: ["cold", "spellcasting"],
    entry: {
      name: "Winter Veil",
      tier: 2,
      system_equivalent: "Rank 1 cold spell",
      gameItem: { kind: "spell", rank: 1, tradition: "primal", school: "evo" },
      mechanics: {
        effect: "Make a spell attack against one creature within 30 feet. On a success, deal 2d6 cold damage and the target is concealed until the start of your next turn.",
        duration: "until the start of your next turn",
        frequency: { max: 2, per: "encounter" },
        actions: 2,
        roll: { kind: "Spell attack", formula: "", dc: 17 }
      },
      metadata: {
        tags: ["cold", "spellcasting"],
        lineage: { operation: "origin", sources: [], rationale: "" }
      }
    }
  },
  {
    id: "storm-arc",
    requiredTags: ["electricity", "spellcasting"],
    entry: {
      name: "Storm Arc",
      tier: 2,
      system_equivalent: "Rank 1 electricity spell",
      gameItem: { kind: "spell", rank: 1, tradition: "arcane", school: "evo" },
      mechanics: {
        effect: "Make a spell attack against one creature within 30 feet. On a success, deal 2d6 electricity damage.",
        duration: "instant",
        frequency: { max: 2, per: "encounter" },
        actions: 2,
        roll: { kind: "Spell attack", formula: "", dc: 17 }
      },
      metadata: {
        tags: ["electricity", "spellcasting"],
        lineage: { operation: "origin", sources: [], rationale: "" }
      }
    }
  }
];

// Canon guarantees a rare Skill at every 10th Grand Design level, distinct from the tag-triggered
// PROPOSAL_TEMPLATES above (which need specific evidence to unlock) and distinct from the 20/30/50
// class-evolution checkpoints (CLASS_EVOLUTION_LEVELS, which are about a Class evolving, not a new
// Skill appearing). A capstone fires purely on hitting the level -- no tag threshold required --
// because canon's capstones are guaranteed, not earned through a specific activity pattern.
const CAPSTONE_LEVEL_INTERVAL = 10;

export function isCapstoneLevel(level) {
  return Number.isInteger(level) && level > 0 && level % CAPSTONE_LEVEL_INTERVAL === 0;
}

/**
 * Builds the one guaranteed capstone Skill proposal for a level milestone. Canon flavors these by
 * "what the individual needs and desires" rather than handing out something generic -- the local
 * fallback here approximates that by reading whichever tag has the most weighted evidence across
 * the character's own growth-event history (not just tags matching a specific template's required
 * pair) and naming/framing the capstone around it; a character with no recorded events yet still
 * gets a usable, GM-editable capstone rather than nothing. Marked `isCapstone: true` so
 * canApproveGeneratedProposal/spendCapstoneAllowance route it through its own allowance track
 * instead of the ordinary per-rest grant allowance an evidence-triggered proposal uses.
 */
export function generateCapstoneProposal(level, events, existingRegistry, modifier = 0) {
  const weighableEvents = events.filter((event) => Object.prototype.hasOwnProperty.call(GROWTH_EVENT_OUTCOME_WEIGHTS, event.outcome));
  const topTag = topWeightedTag(weighableEvents);
  const entry = buildCapstoneEntry(level, topTag, modifier);
  const registryId = `skill:${slugify(entry.name)}`;
  // Disambiguate if a same-named capstone (e.g. the same top tag recurring at a later level) was
  // already approved, so this proposal doesn't collide with an existing registry entry.
  if (existingRegistry?.skills?.[registryId]) {
    entry.name = `${entry.name} (Level ${level})`;
  }
  return {
    id: `proposal:capstone-${level}`,
    kind: "skill",
    status: "pending",
    isCapstone: true,
    evidence: topTag ? weighableEvents.filter((event) => event.tags.includes(topTag)).map((event) => event.id) : [],
    entry
  };
}

function topWeightedTag(events) {
  const tagWeights = new Map();
  for (const event of events) {
    const weight = GROWTH_EVENT_OUTCOME_WEIGHTS[event.outcome];
    for (const tag of event.tags) {
      tagWeights.set(tag, (tagWeights.get(tag) ?? 0) + weight);
    }
  }
  let topTag = null;
  let topWeight = -Infinity;
  for (const [tag, weight] of tagWeights) {
    if (weight > topWeight) {
      topTag = tag;
      topWeight = weight;
    }
  }
  return topTag;
}

function buildCapstoneEntry(level, topTag, modifier) {
  const themeLabel = topTag ? titleCase(topTag) : "Growth";
  const rollFormula = `1d20${modifier >= 0 ? "+" : ""}${modifier}`;
  return {
    name: `Capstone: ${themeLabel}`,
    tier: 3,
    system_equivalent: `Rare capstone ability (Grand Design level ${level})`,
    gameItem: { kind: "action" },
    mechanics: {
      effect: `A rare, exceptional expression of this character's ${topTag ? `${topTag}-driven` : "hard-won"} growth. `
        + "Make a check relevant to that discipline with a +4 circumstance bonus; on a critical success, the GM should also apply one additional narratively-appropriate benefit scaled to a tier-3 capstone ability. The specific signature effect is left to the GM to flesh out to fit the character.",
      duration: "instant",
      frequency: { max: 1, per: "day" },
      actions: 2,
      roll: { kind: `${themeLabel} check`, formula: rollFormula, dc: 10 + level }
    },
    metadata: {
      tags: topTag ? [topTag, "capstone"] : ["capstone"],
      lineage: {
        operation: "origin",
        sources: [],
        rationale: `Guaranteed capstone Skill unlocked at Grand Design level ${level} -- every 10th level grants one rare Skill regardless of tag evidence.`
      }
    }
  };
}

function titleCase(value) {
  return String(value).replace(/(^|[\s-])([a-z])/g, (match, sep, letter) => `${sep}${letter.toUpperCase()}`);
}

export function validateGrowthEvent(event) {
  const errors = [];
  if (!isRecord(event)) errors.push("Growth event must be an object.");
  if (!isNonEmptyString(event?.summary)) errors.push("Growth event summary is required.");
  if (!Array.isArray(event?.tags) || event.tags.length === 0 || event.tags.some((tag) => !isNonEmptyString(tag))) {
    errors.push("Growth event tags must contain at least one non-empty tag.");
  }
  if (!Object.prototype.hasOwnProperty.call(GROWTH_EVENT_OUTCOME_WEIGHTS, event?.outcome)) {
    errors.push(`Growth event outcome must be one of: ${Object.keys(GROWTH_EVENT_OUTCOME_WEIGHTS).join(", ")}.`);
  }
  // Counter-leveling (constants.js#DANGER_GAP_MULTIPLIERS): optional, and only meaningful as one
  // of the two recognized severity tiers -- anything else is rejected rather than silently ignored,
  // so a typo'd dangerGap value doesn't just quietly fail to apply its multiplier.
  if (event?.dangerGap !== undefined && !Object.prototype.hasOwnProperty.call(DANGER_GAP_MULTIPLIERS, event.dangerGap)) {
    errors.push(`Growth event dangerGap must be one of: ${Object.keys(DANGER_GAP_MULTIPLIERS).join(", ")}.`);
  }
  return { valid: errors.length === 0, errors };
}

export function normalizeGrowthEvent(event, index) {
  const validation = validateGrowthEvent(event);
  if (!validation.valid) throw new Error(validation.errors.join(" "));
  return {
    id: event.id ?? `event:${Date.now()}-${index}`,
    summary: event.summary.trim(),
    tags: uniqueStrings(event.tags),
    outcome: event.outcome,
    occurredAt: event.occurredAt ?? new Date().toISOString(),
    ...(event.dangerGap !== undefined ? { dangerGap: event.dangerGap } : {})
  };
}

/**
 * `consolidations` (see constants.js#CONSOLIDATIONS_FLAG, api.js#setConsolidation) is an array of
 * `{ classIds: [idA, idB] }` GM-declared links between two of the actor's own approved Classes.
 * When present, a growth event tagged with one consolidated Class's own tags is treated as ALSO
 * carrying its counterpart Class's tags for evidence-weighting purposes only (the event's stored
 * tags on the actor are never rewritten) -- e.g. a maid whose combat Class is consolidated with her
 * domestic one gets combat-tag evidence credit from kitchen-work session notes, per canon's
 * Consolidation mechanic. This is deliberately independent of class-merging.js: consolidation never
 * creates, renames, or changes a Class, it only widens which events count as evidence for a
 * tag-triggered Skill proposal.
 */
/**
 * `tagWeights` (see tag-weighting.js, GM-configured via a world setting -- tag-weighting-settings.js)
 * is Dynamic tag reweighting: canon's Isthekenous actively repatches which tags grant which XP over
 * time, so a tag's contribution to a template's required-evidence threshold isn't hardcoded at 1x
 * forever. Omit it (default {}) and every tag weighs exactly as it always has -- this keeps every
 * existing caller that predates this feature completely unaffected.
 */
export function generateSkillProposals(events, existingRegistry, modifier = 0, consolidations = [], tagWeights = {}) {
  // Every recognized outcome is usable evidence now, not just success/criticalSuccess -- genuine
  // repeated effort (including failure) counts, just at a lower weight (GROWTH_EVENT_OUTCOME_WEIGHTS).
  const weighableEvents = events.filter((event) => Object.prototype.hasOwnProperty.call(GROWTH_EVENT_OUTCOME_WEIGHTS, event.outcome));
  const consolidatedEvents = applyConsolidations(weighableEvents, existingRegistry, consolidations);
  const existingSkills = new Set(Object.keys(existingRegistry?.skills ?? {}));
  return PROPOSAL_TEMPLATES
    .filter((template) => template.requiredTags.every((tag) => taggedEvidenceWeight(consolidatedEvents, tag, tagWeights) >= MINIMUM_EVIDENCE))
    .map((template) => buildProposal(template, consolidatedEvents, modifier, tagWeights))
    .filter((proposal) => !existingSkills.has(`skill:${slugify(proposal.entry.name)}`));
}

function applyConsolidations(events, registry, consolidations) {
  if (!Array.isArray(consolidations) || !consolidations.length || !registry) return events;
  // A symmetric tag-alias graph: consolidating Class A (tags X) with Class B (tags Y) means an
  // event carrying any tag in X should also be credited with every tag in Y, and vice versa.
  const aliasMap = new Map();
  for (const consolidation of consolidations) {
    const [idA, idB] = consolidation?.classIds ?? [];
    const classA = registry.classes?.[idA];
    const classB = registry.classes?.[idB];
    if (!classA || !classB) continue;
    const tagsA = classA.metadata?.tags ?? [];
    const tagsB = classB.metadata?.tags ?? [];
    for (const tag of tagsA) addAliases(aliasMap, tag, tagsB);
    for (const tag of tagsB) addAliases(aliasMap, tag, tagsA);
  }
  if (!aliasMap.size) return events;
  return events.map((event) => {
    const extra = event.tags.flatMap((tag) => [...(aliasMap.get(tag) ?? [])]);
    if (!extra.length) return event;
    return { ...event, tags: uniqueStrings([...event.tags, ...extra]) };
  });
}

function addAliases(map, tag, aliasTags) {
  if (!aliasTags.length) return;
  const set = map.get(tag) ?? new Set();
  for (const aliasTag of aliasTags) set.add(aliasTag);
  map.set(tag, set);
}

export function proposalId(proposal) {
  return `proposal:${slugify(proposal.entry.name)}`;
}

function buildProposal(template, events, modifier, tagWeights = {}) {
  const evidenceEvents = events.filter((event) => template.requiredTags.some((tag) => event.tags.includes(tag)));
  const evidence = evidenceEvents.map((event) => event.id);
  // An event can match more than one of a template's required tags; when a GM has reweighted them
  // differently, credit that event at whichever matched tag currently carries the highest multiplier.
  const totalWeight = evidenceEvents.reduce((sum, event) => {
    const matchedTags = template.requiredTags.filter((tag) => event.tags.includes(tag));
    const multiplier = Math.max(...matchedTags.map((tag) => weightForTag(tagWeights, tag)));
    return sum + GROWTH_EVENT_OUTCOME_WEIGHTS[event.outcome] * multiplier;
  }, 0);
  const entry = structuredClone(template.entry);
  if (entry.mechanics.roll) {
    entry.mechanics.roll.formula = `1d20${modifier >= 0 ? "+" : ""}${modifier}`;
  }
  entry.metadata.lineage.rationale =
    `Generated after ${evidence.length} tagged event(s), weighted evidence ${totalWeight.toFixed(2)} `
      + `(successes count for more than failures, but persistence through failure counts too): ${evidence.join(", ")}. GM approval is required.`;
  return {
    id: `proposal:${template.id}`,
    kind: "skill",
    status: "pending",
    evidence,
    entry
  };
}

function taggedEvidenceWeight(events, tag, tagWeights = {}) {
  const multiplier = weightForTag(tagWeights, tag);
  return events
    .filter((event) => event.tags.includes(tag))
    .reduce((sum, event) => sum + GROWTH_EVENT_OUTCOME_WEIGHTS[event.outcome] * multiplier, 0);
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => value.trim()))];
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function growthFlags(actor) {
  return {
    events: actor.getFlag(MODULE_ID, GROWTH_EVENTS_FLAG) ?? [],
    proposals: actor.getFlag(MODULE_ID, GROWTH_PROPOSALS_FLAG) ?? []
  };
}

export function levelProgressionFlags(actor) {
  return normalizeLevelProgression(actor.getFlag(MODULE_ID, LEVEL_PROGRESSION_FLAG));
}

export function progressionForEvent(event) {
  const dangerGapMultiplier = DANGER_GAP_MULTIPLIERS[event.dangerGap] ?? 1;
  return (GROWTH_EVENT_OUTCOME_WEIGHTS[event.outcome] ?? 0) * BASE_SUCCESS_PROGRESS * dangerGapMultiplier;
}

export function levelRequirement(level) {
  if (!Number.isInteger(level) || level < 0 || level >= GRAND_DESIGN_MAX_LEVEL) {
    throw new Error(`Level must be an integer from 0 to ${GRAND_DESIGN_MAX_LEVEL - 1}.`);
  }
  return 100 + level * 35 + level * level * 4;
}

export function resolveRest(progression, { restType, dire = false } = {}) {
  if (!["short", "long"].includes(restType) && !dire) {
    throw new Error("Levels can only be resolved during a short or long rest unless the scenario is marked dire.");
  }
  const next = normalizeLevelProgression(progression);
  const gainedLevels = [];
  while (next.level < GRAND_DESIGN_MAX_LEVEL && next.progress >= levelRequirement(next.level)) {
    next.progress -= levelRequirement(next.level);
    next.level += 1;
    next.grantAllowances += 1;
    if (isCapstoneLevel(next.level)) next.capstoneAllowances += 1;
    gainedLevels.push(next.level);
  }
  next.lastRestAt = new Date().toISOString();
  next.lastRestType = dire ? "dire" : restType;
  return {
    progression: next,
    gainedLevels,
    classEvolutionUnlocked: gainedLevels.filter((level) => CLASS_EVOLUTION_LEVELS.has(level)),
    capstoneLevelsUnlocked: gainedLevels.filter(isCapstoneLevel)
  };
}

export function canApproveGeneratedProposal(progression, proposal) {
  const state = normalizeLevelProgression(progression);
  if (proposal.isCapstone) {
    if (state.capstoneAllowances < 1) {
      return { valid: false, error: "No capstone Skill is currently available -- one unlocks automatically at each Grand Design level divisible by 10." };
    }
    return { valid: true, error: null };
  }
  if (state.grantAllowances < 1) {
    return { valid: false, error: "Resolve a Grand Design level-up at rest before granting a generated entry." };
  }
  if (proposal.kind === "class" && !CLASS_EVOLUTION_LEVELS.has(state.level)) {
    return {
      valid: false,
      error: `Generated Class evolution is only available at Grand Design levels 20, 30, or 50 (current level: ${state.level}).`
    };
  }
  return { valid: true, error: null };
}

export function spendGrantAllowance(progression) {
  const state = normalizeLevelProgression(progression);
  if (state.grantAllowances < 1) throw new Error("No Grand Design grant allowances are available.");
  return { ...state, grantAllowances: state.grantAllowances - 1 };
}

export function spendCapstoneAllowance(progression) {
  const state = normalizeLevelProgression(progression);
  if (state.capstoneAllowances < 1) throw new Error("No Grand Design capstone allowances are available.");
  return { ...state, capstoneAllowances: state.capstoneAllowances - 1 };
}

function normalizeLevelProgression(value) {
  const level = Number.isInteger(value?.level) && value.level >= 0 && value.level <= GRAND_DESIGN_MAX_LEVEL
    ? value.level
    : 0;
  const progress = Number.isFinite(value?.progress) && value.progress >= 0 ? value.progress : 0;
  const grantAllowances = Number.isInteger(value?.grantAllowances) && value.grantAllowances >= 0
    ? value.grantAllowances
    : 0;
  const capstoneAllowances = Number.isInteger(value?.capstoneAllowances) && value.capstoneAllowances >= 0
    ? value.capstoneAllowances
    : 0;
  return {
    level,
    progress,
    grantAllowances,
    capstoneAllowances,
    lastRestAt: value?.lastRestAt ?? null,
    lastRestType: value?.lastRestType ?? null
  };
}
