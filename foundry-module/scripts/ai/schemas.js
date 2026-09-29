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
    // The DOER, decided right after the source fragment and before anything is summarized. It used to
    // be optional and late in the object, and qwen3.8 then omitted it on every event of a party recap
    // (ember-road s1: 0 of 18 events named) -- so per-character credit had nothing to go on. Required
    // + early makes the model commit to "who did this" while it is looking at the quote, which is
    // also what lets "Luz saw Tovin kill..." be recorded for Tovin rather than for the reporter.
    actorName: { type: "string" },
    // Board 4f3192e0: did actorName DO this, or did it only happen TO them? The prompt rule alone
    // ("something that merely happens TO a character is not their event") left "Tovin was read very
    // well by a woman who wants a year of his dreams" as a success/occultism event for Tovin. Deciding
    // it as a field, right after naming the character, works where the rule did not (this model
    // follows schema fields better than prose rules). "target" entries are dropped in pipeline.js.
    actorRole: { type: "string", enum: ["doer", "target"] },
    // Model-declared "this line is only the payoff/elaboration of the previous event". Prompting alone
    // never stopped the split (see pipeline.js#mergeFollowUpEvents); a flag lets the model record the
    // line AND lets us fold it deterministically. Right after quote so it is decided from the source.
    continuesPrevious: { type: "boolean" },
    summary: { type: "string" },
    // Optional slot for "what came of it". Without it the model has nowhere to put a stated payoff
    // ("didn't lose a single guest", "the owner offered her a slot") and emits it as a second event,
    // which inflates evidence and was the main count error in the 2026-09-24 corpus run.
    consequence: { type: "string" },
    tags: { type: "array", items: { type: "string", enum: CANONICAL_TAGS } },
    themes: { type: "array", items: { type: "string" } },
    outcome: { type: "string", enum: OUTCOMES },
    dangerGap: { type: "string", enum: DANGER_GAP_VALUES },
    language: { type: "string" }
  },
  required: ["quote", "actorName", "actorRole", "continuesPrevious", "summary", "tags", "themes", "outcome", "dangerGap"]
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

// Same schema with the array capped. Measured 2026-09-24: once asked to always propose, qwen3.8
// looped out 15+ near-duplicate proposals per call (the pipeline kept 3) -- a grammar-level maxItems
// stops the decoder at the cap instead of burning the output budget. Tagged so schemaName() still
// recognizes it for the OpenAI json_schema name.
// `redCheck: true` puts a per-event vice verdict BEFORE the proposals. The prompt-only red check
// was skipped when the model built its proposal on other events: ember-road s1 "Tovin killed a
// goblin that was surrendering" (theme killing-the-surrendered) was never cited, and the one
// proposal was a clean "Infernal Pact". A required field is decided event by event, first.
export const RED_CHECK_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: { event: { type: "string" }, vice: { type: "string", enum: ["none", ...VICE_TAGS] } },
    required: ["event", "vice"]
  }
};

// Board 7b616fea: a Title ([Trollbane], [Hero of the Bridge]) is a name the world gives a character
// for ONE deed, with no mechanics block -- so it gets its own small list instead of the Skill/Class
// entry shape (whose required gameItem/mechanics would make the model invent a rules effect for it).
// `deed` comes first so the model grounds the title in a quoted line before naming it. The list is
// not required and is capped at one: titles are rare, and a required list is one a model feels it
// must fill.
export const TITLE_ITEM_SCHEMA = {
  type: "object",
  properties: {
    deed: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    polarity: { type: "string", enum: ["standard", "red"] },
    vice: { type: "string", enum: ["none", ...VICE_TAGS] },
    drawback: { type: "string" },
    tags: { type: "array", items: { type: "string", enum: CANONICAL_TAGS } }
  },
  required: ["deed", "name", "description", "polarity"]
};

export function proposalSchemaCapped(maxProposals, { redCheck = false, titles = false } = {}) {
  const max = Number.isInteger(maxProposals) && maxProposals > 0 ? maxProposals : 3;
  const proposals = { ...PROPOSAL_SCHEMA.properties.proposals, maxItems: max };
  return {
    ...PROPOSAL_SCHEMA,
    properties: {
      ...(redCheck ? { redCheck: RED_CHECK_SCHEMA } : {}),
      proposals,
      ...(titles ? { titles: { type: "array", items: TITLE_ITEM_SCHEMA, maxItems: 1 } } : {})
    },
    required: redCheck ? ["redCheck", "proposals"] : PROPOSAL_SCHEMA.required,
    [CAPPED_OF]: PROPOSAL_SCHEMA
  };
}
const CAPPED_OF = Symbol("cappedOf");

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
  if (schema === PROPOSAL_SCHEMA || schema?.[CAPPED_OF] === PROPOSAL_SCHEMA) return "grand_design_proposals";
  if (schema === COMBINED_SCHEMA) return "grand_design_events_and_proposals";
  return "grand_design_output";
}
