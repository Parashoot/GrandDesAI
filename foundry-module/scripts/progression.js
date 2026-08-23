import {
  CLASS_EVOLUTION_LEVELS,
  GRAND_DESIGN_MAX_LEVEL,
  GROWTH_EVENTS_FLAG,
  GROWTH_PROPOSALS_FLAG,
  LEVEL_PROGRESSION_FLAG,
  MODULE_ID
} from "./constants.js";

const MINIMUM_EVIDENCE = 3;

const PROPOSAL_TEMPLATES = [
  {
    id: "canal-step",
    requiredTags: ["mobility", "water"],
    entry: {
      name: "Canal Step",
      tier: 1,
      pf2e_equivalent: "Athletics or Acrobatics movement action",
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
      pf2e_equivalent: "Crafting support feat",
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
      pf2e_equivalent: "Class-feat-scale martial action",
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
      pf2e_equivalent: "Rank 1 elemental spell",
      gameItem: { kind: "spell", rank: 1, tradition: "arcane" },
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
      pf2e_equivalent: "Medicine support action",
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
      pf2e_equivalent: "Stealth reaction",
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
      pf2e_equivalent: "Leadership free action",
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
      pf2e_equivalent: "Martial defense reaction",
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
      pf2e_equivalent: "Survival exploration feat",
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
      pf2e_equivalent: "Rank 1 cold spell",
      gameItem: { kind: "spell", rank: 1, tradition: "primal" },
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
      pf2e_equivalent: "Rank 1 electricity spell",
      gameItem: { kind: "spell", rank: 1, tradition: "arcane" },
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

export function validateGrowthEvent(event) {
  const errors = [];
  if (!isRecord(event)) errors.push("Growth event must be an object.");
  if (!isNonEmptyString(event?.summary)) errors.push("Growth event summary is required.");
  if (!Array.isArray(event?.tags) || event.tags.length === 0 || event.tags.some((tag) => !isNonEmptyString(tag))) {
    errors.push("Growth event tags must contain at least one non-empty tag.");
  }
  if (!["success", "criticalSuccess"].includes(event?.outcome)) {
    errors.push("Growth event outcome must be success or criticalSuccess.");
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
    occurredAt: event.occurredAt ?? new Date().toISOString()
  };
}

export function generateSkillProposals(events, existingRegistry, modifier = 0) {
  const successfulEvents = events.filter((event) => ["success", "criticalSuccess"].includes(event.outcome));
  const existingSkills = new Set(Object.keys(existingRegistry?.skills ?? {}));
  return PROPOSAL_TEMPLATES
    .filter((template) => template.requiredTags.every((tag) => countTaggedEvents(successfulEvents, tag) >= MINIMUM_EVIDENCE))
    .map((template) => buildProposal(template, successfulEvents, modifier))
    .filter((proposal) => !existingSkills.has(`skill:${slugify(proposal.entry.name)}`));
}

export function proposalId(proposal) {
  return `proposal:${slugify(proposal.entry.name)}`;
}

function buildProposal(template, events, modifier) {
  const evidence = events
    .filter((event) => template.requiredTags.some((tag) => event.tags.includes(tag)))
    .map((event) => event.id);
  const entry = structuredClone(template.entry);
  if (entry.mechanics.roll) {
    entry.mechanics.roll.formula = `1d20${modifier >= 0 ? "+" : ""}${modifier}`;
  }
  entry.metadata.lineage.rationale =
    `Generated after ${evidence.length} successful tagged events: ${evidence.join(", ")}. GM approval is required.`;
  return {
    id: `proposal:${template.id}`,
    kind: "skill",
    status: "pending",
    evidence,
    entry
  };
}

function countTaggedEvents(events, tag) {
  return events.filter((event) => event.tags.includes(tag)).length;
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
  return event.outcome === "criticalSuccess" ? 40 : 25;
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
    gainedLevels.push(next.level);
  }
  next.lastRestAt = new Date().toISOString();
  next.lastRestType = dire ? "dire" : restType;
  return {
    progression: next,
    gainedLevels,
    classEvolutionUnlocked: gainedLevels.filter((level) => CLASS_EVOLUTION_LEVELS.has(level))
  };
}

export function canApproveGeneratedProposal(progression, proposal) {
  const state = normalizeLevelProgression(progression);
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

function normalizeLevelProgression(value) {
  const level = Number.isInteger(value?.level) && value.level >= 0 && value.level <= GRAND_DESIGN_MAX_LEVEL
    ? value.level
    : 0;
  const progress = Number.isFinite(value?.progress) && value.progress >= 0 ? value.progress : 0;
  const grantAllowances = Number.isInteger(value?.grantAllowances) && value.grantAllowances >= 0
    ? value.grantAllowances
    : 0;
  return {
    level,
    progress,
    grantAllowances,
    lastRestAt: value?.lastRestAt ?? null,
    lastRestType: value?.lastRestType ?? null
  };
}
