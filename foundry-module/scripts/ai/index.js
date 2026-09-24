// Barrel for the v2 AI gateway core. Pure ESM, zero Foundry globals: safe to import from Node tests,
// the Foundry browser, and the scale harness (tools/nlp-scale).
export { ModelJsonError, parseModelJson } from "./json-repair.js";
export {
  CANONICAL_TAGS,
  OUTCOMES,
  TAG_SYNONYMS,
  slugifyTheme,
  resolveTag,
  coerceOutcome,
  coerceDangerGap,
  coerceEvent,
  coerceLanguage,
  eventDedupeKey,
  stemWord,
  levenshtein
} from "./normalize.js";
export {
  EVENT_ITEM_SCHEMA,
  EVENT_EXTRACTION_SCHEMA,
  PROPOSAL_ENTRY_SCHEMA,
  PROPOSAL_ITEM_SCHEMA,
  PROPOSAL_SCHEMA,
  COMBINED_SCHEMA,
  schemaName
} from "./schemas.js";
export {
  TAG_MEANINGS,
  BUILTIN_EXTRACTION_EXAMPLES,
  LEGACY_PROPOSAL_SYSTEM_PROMPT,
  languageName,
  creativityTemperature,
  buildExtractionMessages,
  buildProposalMessages,
  buildSingleMessages,
  buildRepairMessage
} from "./prompts.js";
export {
  AiProviderUnreachableError,
  AiProviderTimeoutError,
  AiProviderHttpError,
  AiProviderResponseError,
  assertSafeEndpoint,
  resolveEndpoints,
  normalizeProviderKind,
  createTransport
} from "./transport.js";
export {
  EARNED_EVIDENCE_THRESHOLD,
  preprocessNotes,
  chunkNotes,
  locateEvents,
  locateProposals,
  weightedEvidence,
  normalizeDiceFormula,
  estimateModifier,
  coerceFrequency,
  normalizeProposalShape,
  repairProposal,
  shouldPropose,
  runGatewayPipeline
} from "./pipeline.js";
export { GATEWAY_DEFAULTS, PIPELINES, PROPOSAL_MODES, CREATIVITY_LEVELS, PROVIDERS, normalizeGatewayConfig } from "./gateway-config.js";
