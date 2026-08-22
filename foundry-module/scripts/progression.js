import { GROWTH_EVENTS_FLAG, GROWTH_PROPOSALS_FLAG, MODULE_ID } from "./constants.js";

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
