// JSON Schemas sent to the provider as structured-output constraints (Ollama `format: <schema>`,
// OpenAI `response_format: {type:"json_schema"}`).
//
// Why constrain at all when json-repair.js can salvage almost anything: a grammar-constrained
// decoder cannot emit "melee" into a tags array whose items are an enum, cannot forget the "events"
// key, and cannot wrap the answer in prose -- so the cheapest failure is the one that never
// happens. The schemas are deliberately *permissive* where our validator is strict (e.g. the
// proposal entry does not require skill-only or class-only fields), because an over-tight schema
// on a small model produces degenerate output (empty strings to satisfy "required") rather than
// better output; repairProposal() and the validator enforce the fine print afterwards.
//
// Property ORDER matters for autoregressive models: `quote` comes first in an event so the model
// grounds itself in the source text before it summarizes and classifies it.
//
// Pure ESM, zero Foundry globals.

import { CANONICAL_TAGS, OUTCOMES } from "./normalize.js";
import { FREQUENCY_PERIODS, GRAND_DESIGN_ITEM_KINDS, SPELL_SCHOOLS } from "../constants.js";
import { VICE_TAGS } from "../vice-taxonomy.js";

const DANGER_GAP_VALUES = ["none", "moderate", "severe"];

export const EVENT_ITEM_SCHEMA = {
  type: "object",
  properties: {
    quote: { type: "string" },
    summary: { type: "string" },
    actorName: { type: "string" },
    tags: { type: "array", items: { type: "string", enum: CANONICAL_TAGS } },
    themes: { type: "array", items: { type: "string" } },
    outcome: { type: "string", enum: OUTCOMES },
    dangerGap: { type: "string", enum: DANGER_GAP_VALUES },
    language: { type: "string" }
  },
  required: ["quote", "summary", "tags", "themes", "outcome", "dangerGap"]
};

export const EVENT_EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    events: { type: "array", items: EVENT_ITEM_SCHEMA }
  },
  required: ["events"]
};

const MECHANICS_SCHEMA = {
  type: "object",
  properties: {
    effect: { type: "string" },
    duration: { type: "string" },
    frequency: {
      type: "object",
      properties: {
        max: { type: "integer" },
        per: { type: "string", enum: [...FREQUENCY_PERIODS] }
      },
      required: ["max", "per"]
    },
    actions: { type: "integer" },
    trigger: { type: "string" },
    roll: {
      type: "object",
      properties: { kind: { type: "string" }, formula: { type: "string" } }
    }
  },
  required: ["effect", "frequency"]
};

export const PROPOSAL_ENTRY_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    tier: { type: "integer" },
    system_equivalent: { type: "string" },
    level: { type: "integer" },
    power_tier: { type: "string", enum: ["standard", "elevated", "prestige"] },
    is_primary: { type: "boolean" },
    is_secondary: { type: "boolean" },
    system_chassis: { type: "string" },
    gameItem: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...GRAND_DESIGN_ITEM_KINDS] },
        rank: { type: "integer" },
        tradition: { type: "string" },
        school: { type: "string", enum: [...SPELL_SCHOOLS] },
        damage: { type: "string" },
        damageType: { type: "string" }
      },
      required: ["kind"]
    },
    mechanics: MECHANICS_SCHEMA,
    metadata: {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string", enum: CANONICAL_TAGS } },
        themes: { type: "array", items: { type: "string" } },
        polarity: { type: "string", enum: ["standard", "red"] },
        malignance: {
          type: "object",
          properties: { vice: { type: "string", enum: [...VICE_TAGS] }, drawback: { type: "string" } }
        },
        lineage: {
          type: "object",
          properties: {
            operation: { type: "string", enum: ["origin", "combine", "upgrade"] },
            sources: { type: "array", items: { type: "string" } },
            rationale: { type: "string" }
          }
        }
      },
      required: ["tags"]
    }
  },
  required: ["name", "gameItem", "mechanics", "metadata"]
};

export const PROPOSAL_ITEM_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["skill", "class"] },
    theme: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    entry: PROPOSAL_ENTRY_SCHEMA
  },
  required: ["kind", "entry", "evidence"]
};

export const PROPOSAL_SCHEMA = {
  type: "object",
  properties: {
    proposals: { type: "array", items: PROPOSAL_ITEM_SCHEMA }
  },
  required: ["proposals"]
};

// pipeline "single": one call returns both.
export const COMBINED_SCHEMA = {
  type: "object",
  properties: {
    events: { type: "array", items: EVENT_ITEM_SCHEMA },
    proposals: { type: "array", items: PROPOSAL_ITEM_SCHEMA }
  },
  required: ["events", "proposals"]
};

/** Names used for OpenAI's json_schema.name (must match ^[a-zA-Z0-9_-]{1,64}$). */
export function schemaName(schema) {
  if (schema === EVENT_EXTRACTION_SCHEMA) return "grand_design_events";
  if (schema === PROPOSAL_SCHEMA) return "grand_design_proposals";
  if (schema === COMBINED_SCHEMA) return "grand_design_events_and_proposals";
  return "grand_design_output";
}
