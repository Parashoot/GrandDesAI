// "Grand Design AI Gateway" settings (AI gateway v2, 2026-09-23).
//
// Two halves, deliberately split so the logic is testable in plain Node:
//  1. PURE, exported helpers (presets, config merging, endpoint migration, textarea parsing,
//     form-data splitting). No Foundry globals are touched at import time.
//  2. Foundry wiring (registerAiProviderSettings / getGatewayConfig / createConfiguredAiAdapter and a
//     FormApplication). The FormApplication subclass is only CREATED inside
//     registerAiProviderSettings(), so importing this file in Node never evaluates
//     `extends FormApplication`.
//
// Scope split: provider / endpoint / model are USER scoped on Foundry v13+ (they follow the GM to any
// browser -- as CLIENT settings every fresh browser silently came up "disabled", board 51f276b4); the
// API key and the per-machine tuning knobs stay CLIENT scoped (the key never leaves this browser
// profile and never touches a world or user document). The table
// "flavor" -- house rules, naming style, tone, custom synonyms, extraction examples, creativity,
// red entries, emergent themes, proposal mode/count, pending cap, summary language -- is WORLD scoped
// so every GM browser at the table writes Skills the same way.
import { createChatCompletionsAdapter, createGatewayAdapter } from "./ai-gateway.js";
import { CREATIVITY_LEVELS, GATEWAY_DEFAULTS, normalizeGatewayConfig, PIPELINES, PROPOSAL_MODES } from "./ai/gateway-config.js";
import { MODULE_ID } from "./constants.js";
import { GROWTH_TAXONOMY } from "./growth-taxonomy.js";
import { BUILD, describeBuild } from "./build-info.js";
import { ALLOW_PRIVATE_HTTP_LABEL, endpointSafetyProblem } from "./ai/transport.js";

// The one place the recommended local model is named. The orchestrator confirms/adjusts it after the
// live scale test (tools/nlp-scale); everything else reads this constant.
export const DEFAULT_OLLAMA_MODEL = "qwen3.8:27b";
export const DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434";

export const PROVIDER_PRESETS = Object.freeze({
  disabled: { label: "Disabled (built-in local note analysis only)", endpoint: "", model: "", requiresKey: false },
  ollama: { label: "Local Ollama (recommended)", endpoint: DEFAULT_OLLAMA_ENDPOINT, model: DEFAULT_OLLAMA_MODEL, requiresKey: false },
  openaiCompatible: { label: "Local OpenAI-compatible server (LM Studio, llama.cpp, vLLM)", endpoint: "http://127.0.0.1:1234/v1", model: "", requiresKey: false },
  hosted: { label: "Hosted OpenAI-compatible API (bring your own key)", endpoint: "", model: "", requiresKey: true }
});

export const CREATIVITY_HELP = Object.freeze({
  grounded: "Grounded — sticks closely to what the notes say; modest, by-the-book Skills.",
  balanced: "Balanced — faithful to the notes, with flavorful names and a little invention.",
  wild: "Wild — bold, surprising Skills and names; best for high-fantasy tables that love weirdness."
});

// Individual client settings kept from v1 so an existing install keeps its provider/endpoint/model/key.
export const CLIENT_BASIC_SETTINGS = Object.freeze({ provider: "aiProvider", endpoint: "aiEndpoint", model: "aiModel", apiKey: "aiApiKey" });
export const AI_EXPECTED_SETTING = "aiExpected";
// Board 2d795cac: opt-in to plain http:// on the GM's own LAN (a home Ollama box, jev-proxy on another
// PC). Same scope as provider/endpoint (it describes where that endpoint lives), Boolean, default off.
export const ALLOW_PRIVATE_HTTP_SETTING = "aiAllowPrivateHttp";
export { ALLOW_PRIVATE_HTTP_LABEL };
export const CLIENT_TUNING_SETTING = "aiGatewayClient";
export const WORLD_FLAVOR_SETTING = "aiGatewayWorld";
// Board 5b2ff22d: buildGatewayConfig keeps ONLY the keys listed here, so a gateway-config.js knob
// missing from both lists could never be changed from the form (the pending cap was always 5).
// Retries, backoff and the extraction cache depend on this machine's model/server, so they are
// per-browser; the pending cap and the summary language shape what the whole table sees, so they are
// world settings. outputLanguage used to be client scoped: migrateOutputLanguage() moves it.
export const CLIENT_TUNING_KEYS = Object.freeze([
  "temperature", "numCtx", "numPredict", "timeoutMs", "maxRetries", "maxRepairAttempts",
  "transientRetries", "transientBackoffMs", "pipeline", "chunkChars",
  "extractionCacheEntries", "extractionCacheTtlMs"
]);
export const WORLD_FLAVOR_KEYS = Object.freeze([
  "houseRules", "namingStyle", "toneHints", "customSynonyms", "extractionExamples",
  "creativity", "allowRed", "emergentThemes", "mergeFollowUps", "proposalMode", "maxProposals",
  "outputLanguage", "pendingProposalCapExtra", "pendingProposalCapMin"
]);
const NUMBER_KEYS = new Set([
  "temperature", "numCtx", "numPredict", "timeoutMs", "maxRetries", "maxRepairAttempts", "transientRetries",
  "transientBackoffMs", "chunkChars", "extractionCacheEntries", "extractionCacheTtlMs", "maxProposals",
  "pendingProposalCapExtra", "pendingProposalCapMin"
]);
const BOOLEAN_KEYS = new Set(["allowRed", "emergentThemes", "mergeFollowUps"]);
const CANONICAL_TAGS = GROWTH_TAXONOMY.map(([tag]) => tag);

// Jev (TypeSafe) optional layer, docs/jev-layer-contract.md. The key is its own CLIENT setting, the
// same mechanism as aiApiKey (never a user setting: those live server-side in the user document, and
// never the world flavor or the tuning JSON). Everything else Jev needs is non-secret per-machine
// tuning and lives in the client tuning JSON under `jev`.
export const CLIENT_JEV_KEY_SETTING = "jevApiKey";
// Mirrors GATEWAY_DEFAULTS.jev from the contract; used until/unless gateway-config.js ships its own.
export const JEV_UI_DEFAULTS = Object.freeze({
  enabled: false,
  endpoint: "https://api.typesafe.ai",
  model: "jev-latest",
  timeoutMs: 10000,
  triage: true,
  attribution: true,
  verify: true,
  rank: true,
  triageThreshold: 0.12,
  overrideConfidence: 0.85
});
export const JEV_TUNING_KEYS = Object.freeze(Object.keys(JEV_UI_DEFAULTS));
const JEV_STEP_KEYS = Object.freeze(["triage", "attribution", "verify", "rank"]);
// Flat form field name -> jev tuning key (Foundry's v1 FormApplication hands over flat formData).
export const JEV_FORM_FIELDS = Object.freeze({
  jevEnabled: "enabled",
  jevEndpoint: "endpoint",
  jevModel: "model",
  jevTimeoutMs: "timeoutMs",
  jevTriage: "triage",
  jevAttribution: "attribution",
  jevVerify: "verify",
  jevRank: "rank",
  jevTriageThreshold: "triageThreshold",
  jevOverrideConfidence: "overrideConfidence"
});

// ------------------------------------------------------------------------------------------------
// Pure helpers
// ------------------------------------------------------------------------------------------------

/**
 * v1 stored full paths ("http://127.0.0.1:11434/api/chat", ".../v1/chat/completions"). The v2
 * transport accepts both a base URL and a full path (scripts/ai/transport.js#resolveEndpoints), so
 * old values keep working as-is; this only tidies the Ollama ones to the base URL the form shows.
 */
export function migrateEndpoint(provider, endpoint) {
  const value = typeof endpoint === "string" ? endpoint.trim() : "";
  if (!value) return "";
  if (provider === "ollama") return value.replace(/\/+(api\/chat|api\/generate|v1\/chat\/completions|v1)\/*$/, "").replace(/\/+$/, "");
  return value.replace(/\/+$/, "");
}

/**
 * null when fine, otherwise a human-readable reason. Delegates to transport.js#endpointSafetyProblem,
 * the rule assertSafeEndpoint enforces, so the form never accepts what the transport refuses (or the
 * reverse). `allowPrivateHttp` is the GM's "Allow plain HTTP to my local network" box.
 */
export function validateEndpointUrl(endpoint, { allowPrivateHttp = false } = {}) {
  return endpointSafetyProblem(endpoint, { allowPrivateHttp: allowPrivateHttp === true })?.message ?? null;
}

/**
 * Merges the three stored layers into one full gateway config:
 *   preset defaults (per provider) <- client basics <- client tuning <- world flavor
 * then runs G1's normalizeGatewayConfig (clamps, never throws). provider "disabled" is preserved
 * (normalizeGatewayConfig has no such provider and would otherwise turn it into "ollama").
 */
export function buildGatewayConfig({ basics = {}, client = {}, world = {} } = {}) {
  const provider = typeof basics.provider === "string" && Object.hasOwn(PROVIDER_PRESETS, basics.provider) ? basics.provider : "disabled";
  const preset = PROVIDER_PRESETS[provider];
  const endpoint = migrateEndpoint(provider, basics.endpoint) || preset.endpoint;
  const model = (typeof basics.model === "string" && basics.model.trim()) || preset.model;
  const pick = (source, keys) => Object.fromEntries(keys.filter((key) => source?.[key] !== undefined).map((key) => [key, source[key]]));
  // Until the ready-time migration has run (or on a player's browser, which cannot write the world
  // setting), an old client-scoped outputLanguage still applies when the world has none.
  const legacyLanguage = world?.outputLanguage === undefined && client?.outputLanguage !== undefined ? { outputLanguage: client.outputLanguage } : {};
  const merged = {
    ...pick(client, CLIENT_TUNING_KEYS),
    ...legacyLanguage,
    ...pick(world, WORLD_FLAVOR_KEYS),
    provider: provider === "disabled" ? GATEWAY_DEFAULTS.provider : provider,
    endpoint: endpoint || GATEWAY_DEFAULTS.endpoint,
    model: model || (provider === "ollama" ? DEFAULT_OLLAMA_MODEL : ""),
    apiKey: typeof basics.apiKey === "string" ? basics.apiKey : "",
    allowPrivateHttp: basics.allowPrivateHttp === true,
    jev: buildJevConfig(client?.jev, basics.jevApiKey)
  };
  const normalized = normalizeGatewayConfig(merged);
  return {
    ...normalized,
    // gateway-config.js owns the canonical clamp once it knows `jev`; if it does not (yet), the UI's
    // own normalization is passed through so the adapter still receives the block.
    jev: normalized.jev && typeof normalized.jev === "object" ? normalized.jev : merged.jev,
    provider,
    endpoint: provider === "disabled" ? "" : endpoint,
    model: provider === "disabled" ? "" : model,
    label: preset.label,
    requiresKey: preset.requiresKey
  };
}

function jevDefaults() {
  const fromGateway = GATEWAY_DEFAULTS.jev && typeof GATEWAY_DEFAULTS.jev === "object" ? GATEWAY_DEFAULTS.jev : {};
  const merged = { ...JEV_UI_DEFAULTS };
  for (const key of JEV_TUNING_KEYS) if (fromGateway[key] !== undefined) merged[key] = fromGateway[key];
  return merged;
}

/**
 * The non-secret Jev tuning, clamped (thresholds 0-1, timeout 1000-60000 ms; unknown keys and any
 * stray `apiKey` dropped). This is exactly what may be stored in the client tuning JSON.
 */
export function normalizeJevTuning(raw) {
  const d = jevDefaults();
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const bool = (value, fallback) => (typeof value === "boolean" ? value : fallback);
  const num = (value, min, max, fallback) => {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const str = (value, fallback) => (typeof value === "string" && value.trim() ? value.trim().replace(/\/+$/, "") : fallback);
  return {
    enabled: bool(input.enabled, d.enabled),
    endpoint: str(input.endpoint, d.endpoint),
    model: str(input.model, d.model),
    timeoutMs: Math.round(num(input.timeoutMs, 1000, 60000, d.timeoutMs)),
    triage: bool(input.triage, d.triage),
    attribution: bool(input.attribution, d.attribution),
    verify: bool(input.verify, d.verify),
    rank: bool(input.rank, d.rank),
    triageThreshold: num(input.triageThreshold, 0, 1, d.triageThreshold),
    overrideConfidence: num(input.overrideConfidence, 0, 1, d.overrideConfidence)
  };
}

/**
 * The `jev` block the gateway receives: tuning + the key from its own client setting. `enabled` is
 * forced off without a key (contract invariant 1: unconfigured == off).
 */
export function buildJevConfig(tuning, apiKey) {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  const jev = normalizeJevTuning(tuning);
  return { ...jev, enabled: jev.enabled && Boolean(key), apiKey: key };
}

/** The defaults a "Reset to defaults" restores, for a given provider. */
export function defaultGatewaySettings(provider = "ollama") {
  const preset = PROVIDER_PRESETS[provider] ?? PROVIDER_PRESETS.ollama;
  const pick = (keys) => Object.fromEntries(keys.map((key) => [key, structuredClone(GATEWAY_DEFAULTS[key])]));
  return {
    basics: { provider, endpoint: preset.endpoint, model: preset.model, apiKey: "", jevApiKey: "", allowPrivateHttp: false },
    client: { ...pick(CLIENT_TUNING_KEYS), jev: normalizeJevTuning({}) },
    world: pick(WORLD_FLAVOR_KEYS)
  };
}

/**
 * "word = tag" per line (also accepts "word: tag", "word -> tag", comments starting with #).
 * Every target must be a canonical tag; bad lines are reported with their line number and skipped.
 */
export function parseCustomSynonyms(text, canonicalTags = CANONICAL_TAGS) {
  const allowed = new Set(canonicalTags);
  const synonyms = {};
  const errors = [];
  String(text ?? "").split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) return;
    const match = line.match(/^(.+?)\s*(?:=|:|->|=>)\s*(.+)$/);
    if (!match) {
      errors.push({ line: index + 1, text: rawLine, message: 'Expected "word = tag".' });
      return;
    }
    const word = match[1].trim().toLowerCase();
    const tag = match[2].trim();
    if (!allowed.has(tag)) {
      const lower = tag.toLowerCase();
      if (allowed.has(lower)) {
        synonyms[word] = lower;
        return;
      }
      errors.push({ line: index + 1, text: rawLine, message: `"${tag}" is not a gameplay tag. Allowed: ${[...allowed].join(", ")}.` });
      return;
    }
    synonyms[word] = tag;
  });
  return { synonyms, errors };
}

export function formatCustomSynonyms(synonyms) {
  if (!synonyms || typeof synonyms !== "object") return "";
  return Object.entries(synonyms).map(([word, tag]) => `${word} = ${tag}`).join("\n");
}

/**
 * GM few-shot examples: a JSON array of up to 5 { notes, events:[{summary, tags, outcome, ...}] }.
 * Empty text is fine (no examples). Returns { examples, errors: string[] }.
 */
export function parseExtractionExamples(text) {
  const source = String(text ?? "").trim();
  if (!source) return { examples: [], errors: [] };
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    return { examples: [], errors: [`Not valid JSON: ${error.message}`] };
  }
  if (!Array.isArray(value)) value = [value];
  const errors = [];
  const examples = [];
  value.forEach((example, index) => {
    const label = `Example ${index + 1}`;
    if (!example || typeof example !== "object" || Array.isArray(example)) return errors.push(`${label} must be an object like {"notes": "...", "events": [...]}.`);
    if (typeof example.notes !== "string" || !example.notes.trim()) return errors.push(`${label} needs a non-empty "notes" string.`);
    if (!Array.isArray(example.events)) return errors.push(`${label} needs an "events" array (it may be empty).`);
    const bad = example.events.findIndex((event) => !event || typeof event.summary !== "string" || !event.summary.trim());
    if (bad >= 0) return errors.push(`${label}, event ${bad + 1} needs a "summary".`);
    examples.push({ notes: example.notes, events: example.events });
    return undefined;
  });
  if (examples.length > 5) errors.push("At most 5 examples are used; the rest are ignored.");
  return { examples: examples.slice(0, 5), errors };
}

/**
 * Splits a flat FormApplication formData object into the three stored layers, coercing types and
 * parsing the two structured textareas. `errors` lists everything that should block saving.
 */
export function formDataToSettings(formData = {}) {
  const errors = [];
  const provider = Object.hasOwn(PROVIDER_PRESETS, formData.provider) ? formData.provider : "disabled";
  const basics = {
    provider,
    endpoint: String(formData.endpoint ?? "").trim(),
    model: String(formData.model ?? "").trim(),
    apiKey: String(formData.apiKey ?? "").trim(),
    // An unchecked checkbox is absent from formData: absent = off.
    allowPrivateHttp: isChecked(formData.allowPrivateHttp)
  };
  if (provider !== "disabled") {
    const endpointError = validateEndpointUrl(basics.endpoint || PROVIDER_PRESETS[provider].endpoint, { allowPrivateHttp: basics.allowPrivateHttp });
    if (endpointError) errors.push(endpointError);
    if (!basics.model && !PROVIDER_PRESETS[provider].model) errors.push("Choose a model (use Refresh models to list what the provider has).");
    if (PROVIDER_PRESETS[provider].requiresKey && !basics.apiKey) errors.push("This hosted provider needs an API key.");
  }
  const coerce = (key, value) => {
    if (BOOLEAN_KEYS.has(key)) return value === true || value === "true" || value === "on" || value === 1;
    if (NUMBER_KEYS.has(key)) {
      // An emptied number box means "use the default", not 0 (Number("") is 0, and 0 turns the
      // extraction cache and every retry off).
      if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return undefined;
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    }
    return typeof value === "string" ? value.trim() : value;
  };
  const client = {};
  for (const key of CLIENT_TUNING_KEYS) {
    const value = coerce(key, formData[key]);
    if (value !== undefined && value !== "") client[key] = value;
  }
  const world = {};
  for (const key of WORLD_FLAVOR_KEYS) {
    if (key === "customSynonyms" || key === "extractionExamples") continue;
    // Unchecked checkboxes are simply absent from formData.
    const value = BOOLEAN_KEYS.has(key) ? coerce(key, formData[key] ?? false) : coerce(key, formData[key]);
    if (value !== undefined) world[key] = value;
  }
  const jev = formDataToJev(formData);
  if (jev) {
    client.jev = jev.tuning;
    basics.jevApiKey = jev.apiKey;
    // The Jev fieldset is hidden with the provider "disabled"; never block Save on a field the GM cannot see.
    if (provider !== "disabled") errors.push(...jev.errors);
  }
  const synonyms = parseCustomSynonyms(formData.customSynonyms);
  world.customSynonyms = synonyms.synonyms;
  for (const error of synonyms.errors) errors.push(`Custom synonyms line ${error.line}: ${error.message}`);
  const examples = parseExtractionExamples(formData.extractionExamples);
  world.extractionExamples = examples.examples;
  for (const error of examples.errors) errors.push(`Extraction examples: ${error}`);
  return { basics, client, world, errors };
}

/**
 * Board 5b2ff22d: outputLanguage moved from the per-browser tuning blob to the world flavor blob.
 * Pure: given the two stored blobs, returns what to write. The world value wins when it exists (a
 * GM already chose the table's language); otherwise a non-default client value is copied over. The
 * client copy is dropped either way so it can never shadow the table setting again.
 * @returns {{ client: object, world: object, changedClient: boolean, changedWorld: boolean }}
 */
export function planOutputLanguageMigration(client = {}, world = {}) {
  const nextClient = { ...(client ?? {}) };
  const nextWorld = { ...(world ?? {}) };
  if (!Object.hasOwn(nextClient, "outputLanguage")) return { client: nextClient, world: nextWorld, changedClient: false, changedWorld: false };
  const legacy = nextClient.outputLanguage;
  delete nextClient.outputLanguage;
  let changedWorld = false;
  if (nextWorld.outputLanguage === undefined && typeof legacy === "string" && legacy.trim() && legacy.trim() !== GATEWAY_DEFAULTS.outputLanguage) {
    nextWorld.outputLanguage = legacy.trim();
    changedWorld = true;
  }
  return { client: nextClient, world: nextWorld, changedClient: true, changedWorld };
}

/**
 * The Jev fieldset's flat fields -> { tuning (no key), apiKey, errors }, or null when the form has no
 * Jev fields at all (an older form, or a caller that never showed them: nothing changes).
 * Unchecked checkboxes are absent from formData, so the toggles read "absent" as false.
 */
export function formDataToJev(formData = {}) {
  const present = Object.keys(JEV_FORM_FIELDS).some((field) => formData[field] !== undefined) || formData.jevApiKey !== undefined;
  if (!present) return null;
  const checked = (value) => value === true || value === "true" || value === "on" || value === 1;
  const raw = {};
  for (const [field, key] of Object.entries(JEV_FORM_FIELDS)) {
    if (key === "enabled" || JEV_STEP_KEYS.includes(key)) raw[key] = checked(formData[field]);
    else if (formData[field] !== undefined && formData[field] !== "") raw[key] = typeof formData[field] === "string" ? formData[field].trim() : formData[field];
  }
  const tuning = normalizeJevTuning(raw);
  const apiKey = String(formData.jevApiKey ?? "").trim();
  const errors = [];
  if (tuning.enabled) {
    if (!apiKey) errors.push("Jev is switched on but has no API key (untick Use Jev, or paste the key from TypeSafe).");
    // The same LAN opt-in covers jev-proxy running on another machine.
    const endpointError = validateEndpointUrl(tuning.endpoint, { allowPrivateHttp: checked(formData.allowPrivateHttp) });
    if (endpointError) errors.push(`Jev endpoint: ${endpointError}`);
  }
  return { tuning, apiKey, errors };
}

/**
 * [settingKey, value] pairs a Save writes, in order. Pure so "the key never reaches a world setting"
 * is testable: the Jev key only goes to its own client setting, the tuning JSON is rebuilt from
 * known keys (no `apiKey` can hide in it), and the world flavor is written by a GM only.
 */
export function settingsWrites({ basics = {}, client = {}, world = {} } = {}, { isGM = false } = {}) {
  const writes = Object.entries(CLIENT_BASIC_SETTINGS).map(([key, setting]) => [setting, String(basics[key] ?? "")]);
  if (basics.jevApiKey !== undefined) writes.push([CLIENT_JEV_KEY_SETTING, String(basics.jevApiKey ?? "")]);
  if (basics.allowPrivateHttp !== undefined) writes.push([ALLOW_PRIVATE_HTTP_SETTING, basics.allowPrivateHttp === true]);
  const tuning = Object.fromEntries(CLIENT_TUNING_KEYS.filter((key) => client[key] !== undefined).map((key) => [key, client[key]]));
  if (client.jev !== undefined) tuning.jev = normalizeJevTuning(client.jev);
  writes.push([CLIENT_TUNING_SETTING, JSON.stringify(tuning)]);
  if (isGM) {
    const flavor = Object.fromEntries(WORLD_FLAVOR_KEYS.filter((key) => world[key] !== undefined).map((key) => [key, world[key]]));
    writes.push([WORLD_FLAVOR_SETTING, JSON.stringify(flavor)]);
  }
  return writes;
}

function isChecked(value) {
  return value === true || value === "true" || value === "on" || value === 1;
}

function parseJsonSetting(raw) {
  if (raw && typeof raw === "object") return raw;
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

// ------------------------------------------------------------------------------------------------
// Foundry wiring
// ------------------------------------------------------------------------------------------------

/** "user" where Foundry supports it (v13+), else the old per-browser scope. Pure so tests can pin it. */
export function providerSettingScope(generation = globalThis.game?.release?.generation) {
  return Number(generation) >= 13 ? "user" : "client";
}

// The adapter used to be frozen at ready/Save (board 5286a3ba). Every gateway setting now rebuilds
// and re-attaches it, debounced because one Save writes several settings in a row.
let rebuildTimer = null;
export function scheduleAdapterRebuild(delayMs = 200) {
  if (typeof game === "undefined" || !game?.user?.isGM) return;
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => rebuildGatewayAdapter(), delayMs);
}

/** Rebuilds the adapter from the stored settings and attaches it; returns { adapter, error }. */
export function rebuildGatewayAdapter({ warn = true } = {}) {
  const api = game.modules.get(MODULE_ID)?.api;
  if (!api) return { adapter: null, error: null };
  try {
    const adapter = createConfiguredAiAdapter();
    api.setProposalAdapter(adapter);
    return { adapter, error: null };
  } catch (error) {
    api.setProposalAdapter(null);
    console.warn(`${MODULE_ID} | AI provider is not configured`, error);
    if (warn) ui.notifications.warn(`Grand Design AI Gateway is not ready (${error.message}) -- notes will be read by the local analyzer until it is fixed.`, { permanent: true });
    return { adapter: null, error };
  }
}

export function registerAiProviderSettings() {
  const basicScope = providerSettingScope();
  for (const [key, setting] of Object.entries(CLIENT_BASIC_SETTINGS)) {
    // The API key never becomes a user setting: user settings are stored server-side in the user document.
    const scope = key === "apiKey" ? "client" : basicScope;
    game.settings.register(MODULE_ID, setting, { scope, config: false, type: String, default: key === "provider" ? "disabled" : "", onChange: () => onGatewaySettingChanged(key === "provider") });
  }
  // The Jev key follows aiApiKey exactly: this browser only, and a change rebuilds the adapter.
  game.settings.register(MODULE_ID, CLIENT_JEV_KEY_SETTING, { scope: "client", config: false, type: String, default: "", onChange: () => onGatewaySettingChanged() });
  game.settings.register(MODULE_ID, ALLOW_PRIVATE_HTTP_SETTING, { scope: basicScope, config: false, type: Boolean, default: false, onChange: () => onGatewaySettingChanged() });
  game.settings.register(MODULE_ID, CLIENT_TUNING_SETTING, { scope: "client", config: false, type: String, default: "{}", onChange: () => onGatewaySettingChanged() });
  game.settings.register(MODULE_ID, WORLD_FLAVOR_SETTING, { scope: "world", config: false, type: String, default: "{}", onChange: () => onGatewaySettingChanged() });
  // Set the first time any GM saves a real provider; what makes "no adapter at ready" a warning
  // instead of silence (the keyword analyzer had been reading a GM's notes unnoticed).
  game.settings.register(MODULE_ID, AI_EXPECTED_SETTING, { scope: "world", config: false, type: Boolean, default: false });
  game.settings.registerMenu(MODULE_ID, "aiProviderSetup", {
    name: "AI Gateway",
    label: "Configure AI Gateway",
    hint: "Choose the AI that reads session notes (local Ollama recommended) and tune how it writes Skills and Classes for your table.",
    icon: "fas fa-brain",
    type: buildGatewaySettingsClass(),
    restricted: true
  });
}

export function readStoredSettings() {
  const basics = {};
  for (const [key, setting] of Object.entries(CLIENT_BASIC_SETTINGS)) basics[key] = game.settings.get(MODULE_ID, setting) ?? "";
  // Read defensively: a missing Jev key must mean "Jev off", never a broken gateway config.
  try {
    basics.jevApiKey = game.settings.get(MODULE_ID, CLIENT_JEV_KEY_SETTING) ?? "";
  } catch {
    basics.jevApiKey = "";
  }
  // Unreadable (not registered yet) = off: the safe default.
  try {
    basics.allowPrivateHttp = game.settings.get(MODULE_ID, ALLOW_PRIVATE_HTTP_SETTING) === true;
  } catch {
    basics.allowPrivateHttp = false;
  }
  return {
    basics,
    client: parseJsonSetting(game.settings.get(MODULE_ID, CLIENT_TUNING_SETTING)),
    world: parseJsonSetting(game.settings.get(MODULE_ID, WORLD_FLAVOR_SETTING))
  };
}

/** The full, normalized gateway config for this browser + world. Safe outside Foundry ({} there). */
export function getGatewayConfig() {
  if (typeof game === "undefined" || !game?.settings?.get) return {};
  try {
    return buildGatewayConfig(readStoredSettings());
  } catch (error) {
    console.warn(`${MODULE_ID} | failed to read AI gateway settings`, error);
    return buildGatewayConfig({});
  }
}

/** Kept for v1 callers. */
export function getAiProviderConfig() {
  return getGatewayConfig();
}

/** Builds the v2 adapter from a config (defaults to the stored one); null when AI is disabled. */
export function createConfiguredAiAdapter(config = getGatewayConfig()) {
  if (!config || config.provider === "disabled") return null;
  if (!config.endpoint || !config.model) return null;
  if (config.requiresKey && !config.apiKey) {
    throw new Error("This hosted AI provider requires an API key in Grand Design AI Gateway settings.");
  }
  if (typeof createGatewayAdapter === "function") return createGatewayAdapter(config);
  return createChatCompletionsAdapter({ endpoint: config.endpoint, model: config.model, transport: config.provider === "ollama" ? "ollama-native" : "openai" });
}

function onGatewaySettingChanged(providerChanged = false) {
  if (typeof game === "undefined" || !game?.user?.isGM) return;
  if (providerChanged) noteAiExpected();
  scheduleAdapterRebuild();
}

/** Remember (world-wide) that this table uses an AI, so a later browser without one is warned. */
export async function noteAiExpected() {
  try {
    if (!game.user?.isGM) return;
    const provider = game.settings.get(MODULE_ID, CLIENT_BASIC_SETTINGS.provider);
    if (provider && provider !== "disabled" && !game.settings.get(MODULE_ID, AI_EXPECTED_SETTING)) {
      await game.settings.set(MODULE_ID, AI_EXPECTED_SETTING, true);
    }
  } catch (error) {
    console.warn(`${MODULE_ID} | could not record that AI is expected`, error);
  }
}

/**
 * Before v13 provider/endpoint/model lived in this browser's localStorage under the same key. While
 * the user-scoped value is still the default, copy the old one over once. Returns the migrated keys.
 */
export async function migrateClientProviderSettings() {
  const migrated = [];
  if (providerSettingScope() !== "user") return migrated;
  let storage;
  try { storage = globalThis.localStorage; } catch { return migrated; }
  if (!storage) return migrated;
  for (const [key, setting] of Object.entries(CLIENT_BASIC_SETTINGS)) {
    if (key === "apiKey") continue;
    try {
      const raw = storage.getItem(`${MODULE_ID}.${setting}`);
      if (raw === null || raw === undefined) continue;
      let old;
      try { old = JSON.parse(raw); } catch { old = raw; }
      const current = game.settings.get(MODULE_ID, setting);
      const isDefault = !current || (key === "provider" && current === "disabled");
      if (typeof old === "string" && old && old !== "disabled" && isDefault) {
        await game.settings.set(MODULE_ID, setting, old);
        migrated.push(key);
      }
    } catch (error) {
      console.warn(`${MODULE_ID} | could not migrate the ${setting} setting`, error);
    }
  }
  return migrated;
}

/** What (if anything) is wrong at startup? Pure; `expected` is the world's "AI expected" flag. */
export function gatewayStartupProblem({ expected, provider, adapterAttached }) {
  if (adapterAttached) return null;
  if (provider && provider !== "disabled") return "configured-but-not-attached";
  return expected ? "expected-but-disabled" : null;
}

export function gatewayStartupMessage(problem, reason = "") {
  const where = 'Open <a data-gd-open-gateway="1">AI Gateway</a> (Game Settings > Configure Settings > Grand Design AI > Configure AI Gateway), choose your provider and press Save.';
  if (problem === "expected-but-disabled") {
    return `Grand Design AI: this world normally reads session notes with an AI, but this browser has no AI provider set, so the keyword analyzer would read them instead. ${where}`;
  }
  return `Grand Design AI: an AI provider is set but could not be attached${reason ? ` (${reason})` : ""}, so notes are read by the keyword analyzer. ${where}`;
}

/** Opens the AI Gateway settings form (used by notification and Growth-dialog links). */
export function openAiGateway() {
  try {
    const menu = game.settings.menus.get(`${MODULE_ID}.aiProviderSetup`);
    if (menu?.type) return new menu.type().render(true);
  } catch (error) {
    console.warn(`${MODULE_ID} | could not open the AI Gateway settings`, error);
  }
  ui.notifications.info("Open Game Settings > Configure Settings > Grand Design AI > Configure AI Gateway.");
  return null;
}

let gatewayLinkInstalled = false;
/** One delegated listener so any `[data-gd-open-gateway]` link (notification text, Growth dialog) works. */
export function installGatewayLinkHandler() {
  if (gatewayLinkInstalled || typeof document === "undefined") return;
  gatewayLinkInstalled = true;
  document.addEventListener("click", (event) => {
    if (event.target?.closest?.("[data-gd-open-gateway]")) {
      event.preventDefault();
      openAiGateway();
    }
  });
}

/**
 * Moves a client-scoped outputLanguage into the world blob (GM only: players cannot write world
 * settings, and buildGatewayConfig keeps honouring their old value meanwhile). Returns the plan.
 */
export async function migrateOutputLanguage() {
  try {
    if (!game.user?.isGM) return null;
    const plan = planOutputLanguageMigration(
      parseJsonSetting(game.settings.get(MODULE_ID, CLIENT_TUNING_SETTING)),
      parseJsonSetting(game.settings.get(MODULE_ID, WORLD_FLAVOR_SETTING))
    );
    // World first: if that write fails the client copy is still there to retry from next launch.
    if (plan.changedWorld) await game.settings.set(MODULE_ID, WORLD_FLAVOR_SETTING, JSON.stringify(plan.world));
    if (plan.changedClient) await game.settings.set(MODULE_ID, CLIENT_TUNING_SETTING, JSON.stringify(plan.client));
    return plan;
  } catch (error) {
    console.warn(`${MODULE_ID} | could not migrate the summary language setting`, error);
    return null;
  }
}

/** Ready-time migration, adapter build and warning for a GM. Returns { adapter, problem }. */
export async function checkGatewayAtReady() {
  installGatewayLinkHandler();
  await migrateClientProviderSettings();
  await migrateOutputLanguage();
  await noteAiExpected();
  const { adapter, error } = rebuildGatewayAdapter({ warn: false });
  const api = game.modules.get(MODULE_ID).api;
  const problem = gatewayStartupProblem({
    expected: game.settings.get(MODULE_ID, AI_EXPECTED_SETTING),
    provider: game.settings.get(MODULE_ID, CLIENT_BASIC_SETTINGS.provider),
    adapterAttached: api.hasProposalAdapter()
  });
  if (problem) ui.notifications.warn(gatewayStartupMessage(problem, error?.message), { permanent: true });
  console.log(`${MODULE_ID} | build ${describeBuild(BUILD)}; AI ${api.hasProposalAdapter() ? "attached" : "not attached"}`);
  return { adapter, problem };
}

/** Writes a parsed form to game.settings (exported so the Foundry wiring is testable with a fake `game`). */
export async function persistSettings(parsed) {
  for (const [setting, value] of settingsWrites(parsed, { isGM: Boolean(game.user?.isGM) })) {
    await game.settings.set(MODULE_ID, setting, value);
  }
}

function buildGatewaySettingsClass() {
  return class GatewaySettings extends FormApplication {
    static get defaultOptions() {
      return foundry.utils.mergeObject(super.defaultOptions, {
        title: "Grand Design AI Gateway",
        id: "grand-design-ai-provider-setup",
        classes: ["grand-design-gateway-settings"],
        template: null,
        width: 640,
        height: "auto",
        resizable: true,
        closeOnSubmit: false,
        submitOnChange: false
      });
    }

    getData() {
      // "Reset to defaults" re-renders from an unsaved defaults snapshot until the GM saves/closes.
      if (this._pendingDefaults) return { config: buildGatewayConfig(this._pendingDefaults), stored: this._pendingDefaults };
      return { config: getGatewayConfig(), stored: readStoredSettings() };
    }

    async _renderInner() {
      const { config, stored } = this.getData();
      return $(renderGatewayForm(config, stored));
    }

    activateListeners(html) {
      super.activateListeners(html);
      const root = html[0] ?? html;
      const q = (selector) => root.querySelector(selector);

      q('select[name="provider"]')?.addEventListener("change", (event) => {
        const preset = PROVIDER_PRESETS[event.target.value] ?? PROVIDER_PRESETS.disabled;
        const endpoint = q('input[name="endpoint"]');
        const model = q('input[name="model"]');
        const presetEndpoints = Object.values(PROVIDER_PRESETS).map((entry) => entry.endpoint);
        if (endpoint && (!endpoint.value || presetEndpoints.includes(endpoint.value))) endpoint.value = preset.endpoint;
        if (model && !model.value) model.value = preset.model;
        if (endpoint) endpoint.placeholder = preset.endpoint || "https://...";
        root.querySelectorAll(".gd-ai-only").forEach((el) => { el.style.display = event.target.value === "disabled" ? "none" : ""; });
      });

      q('input[name="temperature"]')?.addEventListener("input", (event) => {
        const out = q('output[name="temperatureValue"]');
        if (out) out.textContent = Number(event.target.value).toFixed(2);
      });

      q('textarea[name="customSynonyms"]')?.addEventListener("input", (event) => {
        const { errors } = parseCustomSynonyms(event.target.value);
        const box = q(".gd-synonym-errors");
        if (box) box.textContent = errors.map((error) => `Line ${error.line}: ${error.message}`).join("\n");
      });
      q('textarea[name="extractionExamples"]')?.addEventListener("input", (event) => {
        const { errors } = parseExtractionExamples(event.target.value);
        const box = q(".gd-example-errors");
        if (box) box.textContent = errors.join("\n");
      });

      q('button[data-action="refresh-models"]')?.addEventListener("click", async (event) => {
        event.preventDefault();
        const { config } = this._configFromForm(root);
        if (config.provider === "disabled") return ui.notifications.warn("Pick a provider first.");
        try {
          const adapter = createConfiguredAiAdapter(config);
          const models = (await adapter.listModels()) ?? [];
          const list = q("datalist#gd-model-list");
          if (list) list.innerHTML = models.map((name) => `<option value="${escapeHtml(name)}"></option>`).join("");
          ui.notifications.info(models.length ? `Found ${models.length} model(s). Click the model box to choose.` : "The provider answered but lists no models.");
        } catch (error) {
          ui.notifications.error(`Could not list models: ${error.message}`);
        }
        return undefined;
      });

      q('button[data-action="test-connection"]')?.addEventListener("click", async (event) => {
        event.preventDefault();
        const box = q(".gd-test-result");
        const { config } = this._configFromForm(root);
        if (box) box.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Testing -- the first call can take a while if the model is still loading...';
        let result;
        try {
          const adapter = createConfiguredAiAdapter(config);
          result = await game.modules.get(MODULE_ID).api.testAiConnection({ config, adapter });
        } catch (error) {
          result = { ok: false, error: error.message };
        }
        if (box) box.innerHTML = renderTestResult(result);
        const list = q("datalist#gd-model-list");
        if (list && result?.models?.length) list.innerHTML = result.models.map((name) => `<option value="${escapeHtml(name)}"></option>`).join("");
      });

      // The Jev options show only while "Use Jev" is ticked, so the section stays a one-line opt-in.
      q('input[name="jevEnabled"]')?.addEventListener("change", (event) => {
        const body = q(".gd-jev-body");
        if (body) body.style.display = event.target.checked ? "" : "none";
      });

      q('button[data-action="test-jev"]')?.addEventListener("click", async (event) => {
        event.preventDefault();
        const box = q(".gd-jev-test-result");
        const { config } = this._configFromForm(root);
        if (box) box.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Asking Jev for its model list...';
        const result = await testJevConnection(config.jev, { allowPrivateHttp: config.allowPrivateHttp });
        if (box) box.innerHTML = renderJevTestResult(result);
      });

      q('button[data-action="reset-defaults"]')?.addEventListener("click", (event) => {
        event.preventDefault();
        const provider = q('select[name="provider"]')?.value || "ollama";
        this._pendingDefaults = defaultGatewaySettings(provider === "disabled" ? "ollama" : provider);
        this.render();
        ui.notifications.info("Defaults filled in -- click Save to keep them.");
      });
    }

    _configFromForm(root) {
      const form = root.querySelector("form") ?? root;
      const data = Object.fromEntries(new FormData(form).entries());
      const parsed = formDataToSettings(data);
      return { ...parsed, config: buildGatewayConfig(parsed) };
    }

    async _updateObject(_event, formData) {
      const parsed = formDataToSettings(formData);
      if (parsed.errors.length) {
        ui.notifications.error(`Not saved: ${parsed.errors.join(" | ")}`);
        return;
      }
      await persistSettings(parsed);
      // Deliberately disabling clears the flag, so a table that turns AI off is not nagged at every launch.
      if (game.user?.isGM) await game.settings.set(MODULE_ID, AI_EXPECTED_SETTING, parsed.basics.provider !== "disabled");
      this._pendingDefaults = null;
      const api = game.modules.get(MODULE_ID).api;
      try {
        const adapter = createConfiguredAiAdapter();
        api.setProposalAdapter(adapter);
        ui.notifications.info(adapter ? "Grand Design AI Gateway saved." : "Grand Design AI Gateway disabled -- the built-in local analyzer will read notes.");
        this.close();
      } catch (error) {
        console.error(`${MODULE_ID} | provider setup failed`, error);
        ui.notifications.error(error.message);
      }
    }
  };
}

// Board 2d795cac: GMs assumed 127.0.0.1 meant the Foundry host. AI calls run in the GM's browser, so
// it is the GM's own PC; a model elsewhere on the LAN needs Ollama to listen there and accept the
// Foundry origin, plus the plain-HTTP opt-in.
export const ENDPOINT_HELP = "AI calls come from this browser, not from the Foundry server: 127.0.0.1 means the PC you are using right now. Ollama on this PC: http://127.0.0.1:11434 (an old \".../api/chat\" address still works). Ollama on another machine: on that machine set OLLAMA_HOST=0.0.0.0 and OLLAMA_ORIGINS to your Foundry URL (for example http://192.168.1.10:30000), restart Ollama, enter http://<its address>:11434 here and tick the box below. Anything outside your local network must use HTTPS.";
export const ALLOW_PRIVATE_HTTP_HELP = "Lets plain http:// reach private addresses only (192.168.x.x, 10.x.x.x, 172.16-31.x.x, 169.254.x.x, IPv6 fc00::/7 and fe80::/10, *.local, *.lan). Your notes then cross your own network unencrypted; public addresses always need HTTPS. Also applies to the Jev endpoint.";
export const JEV_PROXY_HELP = "TypeSafe refuses calls from browser pages, so in Foundry Jev goes through a small proxy: run \"node tools/jev-proxy.mjs\" from the module folder and set the Jev endpoint to http://127.0.0.1:8788. To run the proxy on another machine, start it with --host 0.0.0.0, set the endpoint to http://<that machine's address>:8788 and tick \"Allow plain HTTP to my local network\" above.";

/** Pure HTML for the settings form (exported so it can be smoke-tested in Node). */
export function renderGatewayForm(config, stored = {}) {
  const world = { ...GATEWAY_DEFAULTS, ...(stored.world ?? {}), ...pickDefined(config, WORLD_FLAVOR_KEYS) };
  const client = { ...GATEWAY_DEFAULTS, ...pickDefined(config, CLIENT_TUNING_KEYS) };
  const provider = config.provider ?? "disabled";
  const aiOnly = provider === "disabled" ? ' style="display:none"' : "";
  const option = (value, label, selected) => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
  const providerOptions = Object.entries(PROVIDER_PRESETS).map(([id, preset]) => option(id, preset.label, provider)).join("");
  const creativity = CREATIVITY_LEVELS.map((level) => `<label class="gd-row"><input type="radio" name="creativity" value="${level}" ${world.creativity === level ? "checked" : ""}> ${escapeHtml(CREATIVITY_HELP[level] ?? level)}</label>`).join("");
  const isGm = typeof game === "undefined" || game?.user?.isGM !== false;
  const worldNote = isGm ? "Shared by everyone at this table (world setting)." : "Only a GM can change the table-wide settings.";
  const synonymsText = formatCustomSynonyms(world.customSynonyms);
  const examplesText = Array.isArray(world.extractionExamples) && world.extractionExamples.length ? JSON.stringify(world.extractionExamples, null, 2) : "";
  return `<form autocomplete="off">
  <p class="gd-help gd-build">Build: ${escapeHtml(describeBuild(BUILD))}</p>
  <p class="gd-help">Grand Design reads your session notes with an AI -- written however you like, in any language -- and turns them into growth. Local models (Ollama) keep everything on your machine.</p>
  <fieldset><legend>Connection (follows your Foundry user; the API key stays in this browser)</legend>
    <div class="form-group"><label>Provider</label><select name="provider">${providerOptions}</select></div>
    <div class="form-group gd-ai-only"${aiOnly}><label>Endpoint</label><input name="endpoint" type="text" value="${escapeHtml(config.endpoint ?? "")}" placeholder="${escapeHtml(PROVIDER_PRESETS[provider]?.endpoint || "https://...")}"></div>
    <p class="gd-help gd-ai-only"${aiOnly}>${escapeHtml(ENDPOINT_HELP)}</p>
    <div class="form-group gd-ai-only"${aiOnly}><label>${escapeHtml(ALLOW_PRIVATE_HTTP_LABEL)}</label><input type="checkbox" name="allowPrivateHttp" ${config.allowPrivateHttp === true ? "checked" : ""}></div>
    <p class="gd-help gd-ai-only"${aiOnly}>${escapeHtml(ALLOW_PRIVATE_HTTP_HELP)}</p>
    <div class="form-group gd-ai-only"${aiOnly}><label>Model</label><div class="gd-row"><input name="model" type="text" list="gd-model-list" value="${escapeHtml(config.model ?? "")}" placeholder="${escapeHtml(PROVIDER_PRESETS[provider]?.model || "model name")}"><button type="button" data-action="refresh-models"><i class="fas fa-rotate"></i> Refresh models</button></div><datalist id="gd-model-list"></datalist></div>
    <div class="form-group gd-ai-only"${aiOnly}><label>API key</label><input name="apiKey" type="password" value="${escapeHtml(config.apiKey ?? "")}" autocomplete="off" placeholder="only for hosted providers"></div>
    <div class="gd-ai-only"${aiOnly}><button type="button" data-action="test-connection"><i class="fas fa-plug"></i> Test Connection</button><div class="gd-test-result gd-help">Checks the connection, the model, and reads one sample sentence.</div></div>
  </fieldset>
  ${renderJevFieldset(config.jev, { aiOnly })}
  <details class="gd-ai-only"${aiOnly}><summary><strong>Model tuning (this browser only)</strong></summary><fieldset>
    <div class="form-group"><label>Temperature</label><div class="gd-row"><input type="range" name="temperature" min="0" max="1.5" step="0.05" value="${Number(client.temperature)}"><output name="temperatureValue">${Number(client.temperature).toFixed(2)}</output></div></div>
    <p class="gd-help">Lower = more consistent readings. 0.1-0.3 is a good range for note extraction.</p>
    <div class="form-group"><label>Context size (tokens)</label><input type="number" name="numCtx" min="2048" max="262144" step="1024" value="${Number(client.numCtx)}"></div>
    <div class="form-group"><label>Max reply tokens</label><input type="number" name="numPredict" min="256" max="32768" step="256" value="${Number(client.numPredict)}"></div>
    <div class="form-group"><label>Timeout (ms)</label><input type="number" name="timeoutMs" min="5000" max="900000" step="1000" value="${Number(client.timeoutMs)}"></div>
    <div class="form-group"><label>Repair attempts</label><input type="number" name="maxRepairAttempts" min="0" max="5" step="1" value="${Number(client.maxRepairAttempts)}"></div>
    <div class="form-group"><label>Pipeline</label><select name="pipeline">${PIPELINES.map((value) => option(value, value === "two-stage" ? "Two-stage (read events, then propose) -- most robust" : "Single call -- faster, less robust", client.pipeline)).join("")}</select></div>
    <div class="form-group"><label>Chunk size (characters)</label><input type="number" name="chunkChars" min="400" max="20000" step="100" value="${Number(client.chunkChars)}"></div>
    <div class="form-group"><label>Request retries (429 / 5xx)</label><input type="number" name="maxRetries" min="0" max="5" step="1" value="${Number(client.maxRetries)}"></div>
    <div class="form-group"><label>Retries after a dropped connection or timeout</label><input type="number" name="transientRetries" min="0" max="5" step="1" value="${Number(client.transientRetries)}"></div>
    <div class="form-group"><label>Wait between those retries (ms)</label><input type="number" name="transientBackoffMs" min="0" max="60000" step="100" value="${Number(client.transientBackoffMs)}"></div>
    <p class="gd-help">Worst case per chunk is roughly timeout x (1 + retries): lower these on a slow machine so a stuck model falls back sooner.</p>
    <div class="form-group"><label>Reuse a reading of identical notes (entries)</label><input type="number" name="extractionCacheEntries" min="0" max="200" step="1" value="${Number(client.extractionCacheEntries)}"></div>
    <div class="form-group"><label>Keep a reading for (ms)</label><input type="number" name="extractionCacheTtlMs" min="0" max="86400000" step="60000" value="${Number(client.extractionCacheTtlMs)}"></div>
    <p class="gd-help">A party recap pasted into five sheets is read once. 0 turns it off; "Re-analyze" always reads fresh.</p>
  </fieldset></details>
  <fieldset><legend>Table flavor</legend><p class="gd-help">${escapeHtml(worldNote)}</p>
    <div class="form-group"><label>Proposals</label><select name="proposalMode">${PROPOSAL_MODES.map((value) => option(value, { "when-earned": "When earned (enough evidence)", always: "Always suggest something", never: "Never (events only)" }[value] ?? value, world.proposalMode)).join("")}</select></div>
    <div class="form-group"><label>Max proposals per analysis</label><input type="number" name="maxProposals" min="0" max="10" step="1" value="${Number(world.maxProposals)}"></div>
    <div class="form-group"><label>Pending proposals: extra over grant allowances</label><input type="number" name="pendingProposalCapExtra" min="0" max="20" step="1" value="${Number(world.pendingProposalCapExtra)}"></div>
    <div class="form-group"><label>Pending proposals: always allow at least</label><input type="number" name="pendingProposalCapMin" min="1" max="20" step="1" value="${Number(world.pendingProposalCapMin)}"></div>
    <p class="gd-help">A character keeps at most max(minimum, grant allowances + extra) AI proposals waiting; the weakest unapproved ones are trimmed first. Milestone rewards never count.</p>
    <div class="form-group"><label>Summary language</label><input type="text" name="outputLanguage" value="${escapeHtml(world.outputLanguage ?? "en")}" placeholder="en, es, el, de..."></div>
    <p class="gd-help">Event summaries are written in this language for the whole table; the original quote is always kept as written.</p>
    <div class="form-group stacked"><label>Creativity</label>${creativity}</div>
    <div class="form-group"><label>Allow red (taboo) entries</label><input type="checkbox" name="allowRed" ${world.allowRed ? "checked" : ""}></div>
    <div class="form-group"><label>Emergent themes</label><input type="checkbox" name="emergentThemes" ${world.emergentThemes ? "checked" : ""}></div>
    <p class="gd-help">Lets activities the tag list never anticipated (beekeeping, gambling, map-making...) grow into brand-new Skills.</p>
    <div class="form-group"><label>Fold follow-up lines into one event</label><input type="checkbox" name="mergeFollowUps" ${world.mergeFollowUps !== false ? "checked" : ""}></div>
    <p class="gd-help">"Ran the inn all week" + "didn't lose a single guest" counts once, with the payoff kept as its consequence. Turn off to count every line the AI splits out.</p>
    <div class="form-group"><label>Naming style</label><input type="text" name="namingStyle" value="${escapeHtml(world.namingStyle ?? "")}" placeholder="e.g. short, bracketed, Wandering Inn style: [Sword Art: Crescent Cut]"></div>
    <div class="form-group"><label>Tone hints</label><input type="text" name="toneHints" value="${escapeHtml(world.toneHints ?? "")}" placeholder="e.g. grim and grounded; humor welcome"></div>
    <div class="form-group stacked"><label>House rules</label><textarea name="houseRules" rows="4" placeholder="Anything the AI should respect when writing Skills: no flight before level 10, healing is rare, ...">${escapeHtml(world.houseRules ?? "")}</textarea></div>
    <div class="form-group stacked"><label>Custom synonyms</label><textarea name="customSynonyms" rows="4" placeholder="one per line: word = tag&#10;brawling = martial&#10;haggling = diplomacy">${escapeHtml(synonymsText)}</textarea><div class="gd-error gd-synonym-errors"></div></div>
    <p class="gd-help">Tags: ${escapeHtml(CANONICAL_TAGS.join(", "))}</p>
    <div class="form-group stacked"><label>Extraction examples (JSON, up to 5)</label><textarea name="extractionExamples" rows="4" placeholder='[{"notes": "Kesh nat 20 on the lock", "events": [{"summary": "Kesh picked the lock flawlessly.", "tags": ["thievery"], "outcome": "criticalSuccess"}]}]'>${escapeHtml(examplesText)}</textarea><div class="gd-error gd-example-errors"></div></div>
  </fieldset>
  <footer class="sheet-footer flexrow">
    <button type="button" data-action="reset-defaults"><i class="fas fa-arrow-rotate-left"></i> Reset to defaults</button>
    <button type="submit"><i class="fas fa-save"></i> Save</button>
  </footer>
</form>`;
}

/**
 * The "Jev (TypeSafe) — optional speed-up" fieldset. While Jev is off only the explanation and the
 * "Use Jev" box show, so a GM who never uses it sees the form essentially as before.
 */
export function renderJevFieldset(jevConfig, { aiOnly = "" } = {}) {
  const jev = normalizeJevTuning(jevConfig);
  const apiKey = typeof jevConfig?.apiKey === "string" ? jevConfig.apiKey : "";
  const on = jevConfig?.enabled === true;
  const box = (name, checked, label) => `<div class="form-group"><label>${escapeHtml(label)}</label><input type="checkbox" name="${name}" ${checked ? "checked" : ""}></div>`;
  return `<fieldset class="gd-jev gd-ai-only"${aiOnly}><legend>Jev (TypeSafe) — optional speed-up</legend>
    <p class="gd-help">Jev answers small yes/no and pick-one questions in under a second: it skips passages with no character action, works out who did each deed, double-checks outcomes and dark deeds, and ranks proposals. It never writes text or replaces your model, and if it fails, analysis carries on without it.</p>
    <div class="form-group"><label>Use Jev</label><input type="checkbox" name="jevEnabled" ${on ? "checked" : ""}></div>
    <div class="gd-jev-body"${on ? "" : ' style="display:none"'}>
      <div class="form-group"><label>Jev API key</label><input name="jevApiKey" type="password" value="${escapeHtml(apiKey)}" autocomplete="off" placeholder="from typesafe.ai (kept in this browser only)"></div>
      <div class="form-group"><label>Jev endpoint</label><input name="jevEndpoint" type="text" value="${escapeHtml(jev.endpoint)}" placeholder="${escapeHtml(JEV_UI_DEFAULTS.endpoint)}"></div>
      <p class="gd-help">${escapeHtml(JEV_PROXY_HELP)}</p>
      <div class="form-group"><label>Jev model</label><input name="jevModel" type="text" value="${escapeHtml(jev.model)}" placeholder="${escapeHtml(JEV_UI_DEFAULTS.model)}"></div>
      ${box("jevTriage", jev.triage, "Skip passages with no character action")}
      ${box("jevAttribution", jev.attribution, "Work out who did each deed")}
      ${box("jevVerify", jev.verify, "Double-check outcomes and dark deeds")}
      ${box("jevRank", jev.rank, "Rank proposals by their evidence")}
      <details class="gd-jev-advanced"><summary>Advanced</summary>
        <div class="form-group"><label>Skip threshold (0-1)</label><input type="number" name="jevTriageThreshold" min="0" max="1" step="any" value="${Number(jev.triageThreshold)}"></div>
        <p class="gd-help">A passage is skipped only when Jev's chance that it holds a character action is below this. Lower = skips less.</p>
        <div class="form-group"><label>Override confidence (0-1)</label><input type="number" name="jevOverrideConfidence" min="0" max="1" step="any" value="${Number(jev.overrideConfidence)}"></div>
        <p class="gd-help">Jev replaces the model's outcome only above this confidence; below it, it just flags the event for you.</p>
        <div class="form-group"><label>Jev timeout (ms)</label><input type="number" name="jevTimeoutMs" min="1000" max="60000" step="any" value="${Number(jev.timeoutMs)}"></div>
      </details>
      <div><button type="button" data-action="test-jev"><i class="fas fa-bolt"></i> Test Jev</button><div class="gd-jev-test-result gd-help">Checks the key and endpoint and lists Jev's models.</div></div>
    </div>
  </fieldset>`;
}

/**
 * Pings Jev with the form's (unsaved) settings. Never throws; returns
 * { ok, ms?, models?: string[], error?, kind?, status? }. jev.js is imported lazily and its absence
 * is a readable result, so this file keeps loading on a build without the Jev client.
 */
export async function testJevConnection(jev, { loadJev = () => import("./ai/jev.js"), allowPrivateHttp = false } = {}) {
  const apiKey = typeof jev?.apiKey === "string" ? jev.apiKey.trim() : "";
  if (!apiKey) return { ok: false, kind: "config", error: "Paste a Jev API key first." };
  const tuning = normalizeJevTuning(jev);
  const endpointError = validateEndpointUrl(tuning.endpoint, { allowPrivateHttp });
  if (endpointError) return { ok: false, kind: "config", error: `Jev endpoint: ${endpointError}` };
  let createJevClient = null;
  try {
    ({ createJevClient } = await loadJev());
  } catch {
    createJevClient = null;
  }
  if (typeof createJevClient !== "function") {
    return { ok: false, kind: "missing", error: "This build of Grand Design has no Jev client yet (scripts/ai/jev.js)." };
  }
  try {
    const client = createJevClient({ apiKey, endpoint: tuning.endpoint, model: tuning.model, timeoutMs: tuning.timeoutMs });
    if (!client || typeof client.ping !== "function") return { ok: false, kind: "config", error: "Jev could not be set up with these settings." };
    return normalizePingResult(await client.ping());
  } catch (error) {
    return { ok: false, kind: error?.kind, status: error?.status, error: error?.message || String(error) };
  }
}

function normalizePingResult(result) {
  const models = (Array.isArray(result?.models) ? result.models : [])
    .map((model) => (typeof model === "string" ? model : model?.name))
    .filter((name) => typeof name === "string" && name);
  const error = result?.error;
  const out = { ok: result?.ok === true };
  if (Number.isFinite(result?.ms)) out.ms = result.ms;
  if (models.length) out.models = models;
  if (error) {
    out.error = typeof error === "string" ? error : error.message || String(error);
    const kind = result?.kind ?? error?.kind;
    const status = result?.status ?? error?.status;
    if (kind) out.kind = kind;
    if (status) out.status = status;
  }
  return out;
}

/** What went wrong with Test Jev, in words a GM can act on. Pure. */
export function describeJevError(result) {
  const message = String(result?.error ?? "");
  const kind = result?.kind;
  if (kind === "cors" || kind === "network" || /failed to fetch|networkerror|load failed|cors|blocked/i.test(message)) {
    return "Your browser blocked the call to Jev (CORS or network). TypeSafe does not accept calls from browser pages, so Foundry needs a proxy that adds CORS headers: on this PC run \"node tools/jev-proxy.mjs\" from the module folder, set the Jev endpoint to http://127.0.0.1:8788, then test again.";
  }
  if (result?.status === 401 || result?.status === 403 || /\b40[13]\b|unauthori[sz]ed|forbidden/i.test(message)) {
    return "Jev rejected the API key (401/403). Check the key in your TypeSafe account.";
  }
  if (kind === "timeout" || /timed? ?out|abort/i.test(message)) return "Jev did not answer in time. Check the endpoint, or raise the Jev timeout under Advanced.";
  return message || "The Jev test failed.";
}

/** Pure HTML for a Test Jev result (the result never carries the key). */
export function renderJevTestResult(result) {
  if (!result) return '<span class="gd-error">No result.</span>';
  if (!result.ok) return `<span class="gd-error"><i class="fas fa-circle-xmark"></i> ${escapeHtml(describeJevError(result))}</span>`;
  const models = Array.isArray(result.models) ? result.models : [];
  const ms = Number.isFinite(result.ms) ? ` in ${Math.round(result.ms)} ms` : "";
  return `<span class="gd-ok"><i class="fas fa-circle-check"></i> Jev answered${ms}.</span>${models.length ? `<br><span class="gd-help">Models: ${escapeHtml(models.join(", "))}</span>` : ""}`;
}



/** Pure HTML for a testAiConnection result. */
export function renderTestResult(result) {
  if (!result) return '<span class="gd-error">No result.</span>';
  const lines = [];
  if (result.ok) lines.push(`<span class="gd-ok"><i class="fas fa-circle-check"></i> Connected${result.model ? ` to <strong>${escapeHtml(result.model)}</strong>` : ""}${Number.isFinite(result.ms) ? ` in ${Math.round(result.ms)} ms` : ""}.</span>`);
  else lines.push(`<span class="gd-error"><i class="fas fa-circle-xmark"></i> ${escapeHtml(result.error ?? "The test failed.")}</span>`);
  if (result.ok && result.error) lines.push(`<span class="gd-error">${escapeHtml(result.error)}</span>`);
  if (Array.isArray(result.models) && result.models.length) lines.push(`<span class="gd-help">${result.models.length} model(s) available.</span>`);
  if (result.sample) {
    const events = result.sample.events ?? [];
    const described = events.length
      ? events.map((event) => `${escapeHtml(event.summary)} <em>[${escapeHtml([...(event.tags ?? []), ...(event.themes ?? []).map((theme) => `~${theme}`)].join(", "))}; ${escapeHtml(event.outcome)}]</em>`).join("<br>")
      : "<em>(no events read from the sample)</em>";
    lines.push(`<div><strong>Sample</strong> (${Math.round(result.sample.ms ?? 0)} ms): "${escapeHtml(result.sample.notes)}"<br>${described}</div>`);
  }
  return lines.join("<br>");
}

function pickDefined(source, keys) {
  return Object.fromEntries(keys.filter((key) => source?.[key] !== undefined).map((key) => [key, source[key]]));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
