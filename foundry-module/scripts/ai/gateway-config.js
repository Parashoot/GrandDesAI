// The gateway's customization surface. Every knob a GM (or the scale harness) can turn lives here,
// with one normalizer that never throws: a settings form with a typo'd number, a world setting saved
// by an older module version, or a hand-edited JSON blob must degrade to sane defaults, not break
// "Analyze Notes" mid-session. Values out of range are clamped; values of the wrong type are
// ignored in favour of the default.
//
// Pure ESM, zero Foundry globals.

export const PIPELINES = ["two-stage", "single"];
export const PROPOSAL_MODES = ["when-earned", "always", "never"];
export const CREATIVITY_LEVELS = ["grounded", "balanced", "wild"];
export const PROVIDERS = ["ollama", "openaiCompatible", "hosted"];

export const GATEWAY_DEFAULTS = Object.freeze({
  provider: "ollama",
  endpoint: "http://127.0.0.1:11434",
  model: "qwen3.8:27b",
  apiKey: "",
  temperature: 0.2,
  numCtx: 16384,
  numPredict: 3072,
  timeoutMs: 180000,
  maxRetries: 2,
  maxRepairAttempts: 2,
  // Retries of a whole chunk after a dropped connection or timeout (see pipeline.js).
  transientRetries: 2,
  transientBackoffMs: 1500,
  pipeline: "two-stage",
  chunkChars: 2400,
  proposalMode: "when-earned",
  maxProposals: 3,
  creativity: "balanced",
  allowRed: true,
  emergentThemes: true,
  // Fold a follow-up event (same actor, shared theme, next in the notes) into the one before it.
  mergeFollowUps: true,
  outputLanguage: "en",
  namingStyle: "",
  houseRules: "",
  customSynonyms: Object.freeze({}),
  toneHints: "",
  extractionExamples: Object.freeze([]),
  // Optional TypeSafe Jev layer (docs/jev-layer-contract.md). Off unless an API key is present: the
  // key is a client-scoped setting, so a world without it behaves exactly as before.
  jev: Object.freeze({
    enabled: false,
    apiKey: "",
    endpoint: "https://api.typesafe.ai",
    model: "jev-latest",
    timeoutMs: 10000,
    triage: true,
    attribution: true,
    verify: true,
    rank: true,
    triageThreshold: 0.12,
    overrideConfidence: 0.85
  }),
  // Reuse one stage-1 reading of identical notes across characters (pipeline.js#createExtractionCache):
  // a party recap pasted into five sheets is read once. 0 entries or 0 ms turns it off.
  extractionCacheEntries: 20,
  extractionCacheTtlMs: 30 * 60 * 1000,
  // Board b81a0357: AI-authored pending proposals grew without limit (Tovin 5, Luz 4 pending for one
  // grant allowance each). The cap an actor is held to is `grantAllowances + pendingProposalCapExtra`,
  // floored at pendingProposalCapMin so a character between allowances still gets a few ideas
  // (api.js#capPendingAiProposals). The floor is 5, not the board's smaller example, so one
  // legitimately eventful session (several genuinely different tagged proposals, still zero grant
  // allowances spent) is never trimmed mid-session; it is the SUSTAINED growth across sessions no one
  // ever approves or rejects that this actually bounds. A GM who wants a tighter table can lower it.
  pendingProposalCapExtra: 2,
  pendingProposalCapMin: 5
});

// Friendly names a GM might type into a free-text language box.
const LANGUAGE_ALIASES = {
  english: "en", spanish: "es", "español": "es", espanol: "es", portuguese: "pt", "português": "pt", portugues: "pt",
  french: "fr", "français": "fr", francais: "fr", german: "de", deutsch: "de", italian: "it", italiano: "it",
  greek: "el", "ελληνικά": "el", tagalog: "tl", filipino: "tl", japanese: "ja", "日本語": "ja", dutch: "nl",
  polish: "pl", russian: "ru", chinese: "zh", korean: "ko", turkish: "tr"
};

const PROVIDER_ALIASES = {
  ollama: "ollama", "ollama-native": "ollama", local: "ollama",
  openai: "openaiCompatible", openaicompatible: "openaiCompatible", "openai-compatible": "openaiCompatible",
  lmstudio: "openaiCompatible", "lm-studio": "openaiCompatible", llamacpp: "openaiCompatible", vllm: "openaiCompatible",
  hosted: "hosted", openrouter: "hosted", groq: "hosted"
};

/**
 * @param {object} partial any subset of GATEWAY_DEFAULTS keys (plus pass-through function hooks
 *   `fetchImpl`, `getHeaders`, `sleep`, and a legacy `extraBody` object).
 * @returns {object} a complete, clamped config. Never throws.
 */
export function normalizeGatewayConfig(partial = {}) {
  const input = partial && typeof partial === "object" ? partial : {};
  const d = GATEWAY_DEFAULTS;
  const config = {
    provider: normalizeProvider(input.provider),
    endpoint: nonEmptyString(input.endpoint, 2048) ?? d.endpoint,
    model: nonEmptyString(input.model, 256) ?? d.model,
    apiKey: typeof input.apiKey === "string" ? input.apiKey.trim() : d.apiKey,
    temperature: clampNumber(input.temperature, 0, 1.5, d.temperature),
    numCtx: clampInt(input.numCtx, 2048, 262144, d.numCtx),
    numPredict: clampInt(input.numPredict, 256, 32768, d.numPredict),
    timeoutMs: clampInt(input.timeoutMs, 5000, 900000, d.timeoutMs),
    maxRetries: clampInt(input.maxRetries, 0, 5, d.maxRetries),
    maxRepairAttempts: clampInt(input.maxRepairAttempts, 0, 5, d.maxRepairAttempts),
    transientRetries: clampInt(input.transientRetries, 0, 5, d.transientRetries),
    transientBackoffMs: clampInt(input.transientBackoffMs, 0, 60000, d.transientBackoffMs),
    pipeline: oneOf(input.pipeline, PIPELINES, d.pipeline),
    chunkChars: clampInt(input.chunkChars, 400, 20000, d.chunkChars),
    proposalMode: oneOf(input.proposalMode, PROPOSAL_MODES, d.proposalMode),
    maxProposals: clampInt(input.maxProposals, 0, 10, d.maxProposals),
    creativity: oneOf(input.creativity, CREATIVITY_LEVELS, d.creativity),
    allowRed: bool(input.allowRed, d.allowRed),
    emergentThemes: bool(input.emergentThemes, d.emergentThemes),
    mergeFollowUps: bool(input.mergeFollowUps, d.mergeFollowUps),
    outputLanguage: normalizeLanguage(input.outputLanguage),
    namingStyle: text(input.namingStyle, 500),
    houseRules: text(input.houseRules, 4000),
    customSynonyms: normalizeSynonyms(input.customSynonyms),
    toneHints: text(input.toneHints, 1000),
    extractionExamples: normalizeExamples(input.extractionExamples),
    extractionCacheEntries: clampInt(input.extractionCacheEntries, 0, 200, d.extractionCacheEntries),
    extractionCacheTtlMs: clampInt(input.extractionCacheTtlMs, 0, 24 * 60 * 60 * 1000, d.extractionCacheTtlMs),
    pendingProposalCapExtra: clampInt(input.pendingProposalCapExtra, 0, 20, d.pendingProposalCapExtra),
    pendingProposalCapMin: clampInt(input.pendingProposalCapMin, 1, 20, d.pendingProposalCapMin),
    jev: normalizeJevConfig(input.jev)
  };
  // Pass-through hooks: not user settings, but the adapter/tests/harness need to inject them.
  for (const key of ["fetchImpl", "getHeaders", "sleep"]) {
    if (typeof input[key] === "function") config[key] = input[key];
  }
  if (input.extraBody && typeof input.extraBody === "object" && !Array.isArray(input.extraBody)) config.extraBody = input.extraBody;
  if (typeof input.systemId === "string" && input.systemId.trim()) config.systemId = input.systemId.trim();
  return config;
}

/**
 * The `jev` sub-config. Unknown keys are dropped; a non-object is the defaults. `enabled` is forced
 * false without an apiKey, so "enabled but no key" never reaches the network to 401 on every run.
 * `fetchImpl` is a pass-through hook (tests, the harness's simulated Jev), like the top-level one.
 */
export function normalizeJevConfig(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const d = GATEWAY_DEFAULTS.jev;
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : d.apiKey;
  const jev = {
    enabled: bool(input.enabled, d.enabled) && apiKey.length > 0,
    apiKey,
    endpoint: (nonEmptyString(input.endpoint, 2048) ?? d.endpoint).replace(/\/+$/, "") || d.endpoint,
    model: nonEmptyString(input.model, 128) ?? d.model,
    timeoutMs: clampInt(input.timeoutMs, 1000, 60000, d.timeoutMs),
    triage: bool(input.triage, d.triage),
    attribution: bool(input.attribution, d.attribution),
    verify: bool(input.verify, d.verify),
    rank: bool(input.rank, d.rank),
    triageThreshold: clampNumber(input.triageThreshold, 0, 1, d.triageThreshold),
    overrideConfidence: clampNumber(input.overrideConfidence, 0, 1, d.overrideConfidence)
  };
  if (typeof input.fetchImpl === "function") jev.fetchImpl = input.fetchImpl;
  return jev;
}

function normalizeProvider(value) {
  if (typeof value !== "string") return GATEWAY_DEFAULTS.provider;
  return PROVIDER_ALIASES[value.trim().toLowerCase()] ?? (PROVIDERS.includes(value) ? value : GATEWAY_DEFAULTS.provider);
}

function normalizeLanguage(value) {
  if (typeof value !== "string" || !value.trim()) return GATEWAY_DEFAULTS.outputLanguage;
  const v = value.trim().toLowerCase();
  if (LANGUAGE_ALIASES[v]) return LANGUAGE_ALIASES[v];
  if (/^[a-z]{2,3}(-[a-z0-9]{2,4})?$/.test(v)) return v;
  return GATEWAY_DEFAULTS.outputLanguage;
}

function normalizeSynonyms(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    // Accept a JSON string too -- that is how a textarea setting stores it.
    if (typeof value === "string" && value.trim().startsWith("{")) {
      try { return normalizeSynonyms(JSON.parse(value)); } catch { return {}; }
    }
    return {};
  }
  const out = {};
  let count = 0;
  for (const [raw, target] of Object.entries(value)) {
    if (count >= 500) break;
    if (typeof raw !== "string" || !raw.trim() || typeof target !== "string" || !target.trim()) continue;
    out[raw.trim().slice(0, 64)] = target.trim().slice(0, 64);
    count += 1;
  }
  return out;
}

function normalizeExamples(value) {
  let list = value;
  if (typeof list === "string" && list.trim().startsWith("[")) {
    try { list = JSON.parse(list); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((ex) => ex && typeof ex === "object" && typeof ex.notes === "string" && ex.notes.trim())
    .slice(0, 5)
    .map((ex) => ({
      notes: ex.notes.trim().slice(0, 2000),
      events: Array.isArray(ex.events) ? ex.events.slice(0, 8) : []
    }));
}

function nonEmptyString(value, max) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function text(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function toNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return NaN;
}

function clampNumber(value, min, max, fallback) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampInt(value, min, max, fallback) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function oneOf(value, allowed, fallback) {
  if (typeof value !== "string") return fallback;
  const v = value.trim();
  return allowed.find((option) => option.toLowerCase() === v.toLowerCase()) ?? fallback;
}

function bool(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1 || value === "1") return true;
  if (value === "false" || value === 0 || value === "0") return false;
  return fallback;
}

/**
 * Board b81a0357. `allowances` is the actor's current grant allowances (progression.js); the cap is
 * generous when there is real spending power waiting and still non-zero (pendingProposalCapMin) when
 * there is none, so a character between allowances is not left with nothing to consider.
 */
export function pendingProposalCap(config, allowances = 0) {
  const cfg = config && typeof config === "object" ? config : {};
  const extra = Number.isInteger(cfg.pendingProposalCapExtra) ? cfg.pendingProposalCapExtra : GATEWAY_DEFAULTS.pendingProposalCapExtra;
  const min = Number.isInteger(cfg.pendingProposalCapMin) ? cfg.pendingProposalCapMin : GATEWAY_DEFAULTS.pendingProposalCapMin;
  const a = Number.isInteger(allowances) && allowances > 0 ? allowances : 0;
  return Math.max(min, a + extra);
}
