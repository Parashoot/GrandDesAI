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
// Scope split: provider / endpoint / model / API key and the per-machine tuning knobs are CLIENT
// scoped (the key never leaves this browser profile and never touches a world setting). The table
// "flavor" -- house rules, naming style, tone, custom synonyms, extraction examples, creativity,
// red entries, emergent themes, proposal mode/count -- is WORLD scoped so every GM browser at the
// table writes Skills the same way.
import { createChatCompletionsAdapter, createGatewayAdapter } from "./ai-gateway.js";
import { CREATIVITY_LEVELS, GATEWAY_DEFAULTS, normalizeGatewayConfig, PIPELINES, PROPOSAL_MODES } from "./ai/gateway-config.js";
import { MODULE_ID } from "./constants.js";
import { GROWTH_TAXONOMY } from "./growth-taxonomy.js";

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
export const CLIENT_TUNING_SETTING = "aiGatewayClient";
export const WORLD_FLAVOR_SETTING = "aiGatewayWorld";
export const CLIENT_TUNING_KEYS = Object.freeze(["temperature", "numCtx", "numPredict", "timeoutMs", "maxRepairAttempts", "pipeline", "chunkChars", "outputLanguage"]);
export const WORLD_FLAVOR_KEYS = Object.freeze([
  "houseRules", "namingStyle", "toneHints", "customSynonyms", "extractionExamples",
  "creativity", "allowRed", "emergentThemes", "proposalMode", "maxProposals"
]);
const NUMBER_KEYS = new Set(["temperature", "numCtx", "numPredict", "timeoutMs", "maxRepairAttempts", "chunkChars", "maxProposals"]);
const BOOLEAN_KEYS = new Set(["allowRed", "emergentThemes"]);
const CANONICAL_TAGS = GROWTH_TAXONOMY.map(([tag]) => tag);

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

/** null when fine, otherwise a human-readable reason (mirrors transport.js#assertSafeEndpoint). */
export function validateEndpointUrl(endpoint) {
  if (typeof endpoint !== "string" || !endpoint.trim()) return "An endpoint URL is required.";
  let url;
  try {
    url = new URL(endpoint.trim());
  } catch {
    return `"${endpoint}" is not a valid URL.`;
  }
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    return "Remote AI endpoints must use HTTPS (plain HTTP is only allowed for localhost / 127.0.0.1).";
  }
  return null;
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
  const merged = {
    ...pick(client, CLIENT_TUNING_KEYS),
    ...pick(world, WORLD_FLAVOR_KEYS),
    provider: provider === "disabled" ? GATEWAY_DEFAULTS.provider : provider,
    endpoint: endpoint || GATEWAY_DEFAULTS.endpoint,
    model: model || (provider === "ollama" ? DEFAULT_OLLAMA_MODEL : ""),
    apiKey: typeof basics.apiKey === "string" ? basics.apiKey : ""
  };
  const normalized = normalizeGatewayConfig(merged);
  return {
    ...normalized,
    provider,
    endpoint: provider === "disabled" ? "" : endpoint,
    model: provider === "disabled" ? "" : model,
    label: preset.label,
    requiresKey: preset.requiresKey
  };
}

/** The defaults a "Reset to defaults" restores, for a given provider. */
export function defaultGatewaySettings(provider = "ollama") {
  const preset = PROVIDER_PRESETS[provider] ?? PROVIDER_PRESETS.ollama;
  const pick = (keys) => Object.fromEntries(keys.map((key) => [key, structuredClone(GATEWAY_DEFAULTS[key])]));
  return {
    basics: { provider, endpoint: preset.endpoint, model: preset.model, apiKey: "" },
    client: pick(CLIENT_TUNING_KEYS),
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
    apiKey: String(formData.apiKey ?? "").trim()
  };
  if (provider !== "disabled") {
    const endpointError = validateEndpointUrl(basics.endpoint || PROVIDER_PRESETS[provider].endpoint);
    if (endpointError) errors.push(endpointError);
    if (!basics.model && !PROVIDER_PRESETS[provider].model) errors.push("Choose a model (use Refresh models to list what the provider has).");
    if (PROVIDER_PRESETS[provider].requiresKey && !basics.apiKey) errors.push("This hosted provider needs an API key.");
  }
  const coerce = (key, value) => {
    if (BOOLEAN_KEYS.has(key)) return value === true || value === "true" || value === "on" || value === 1;
    if (NUMBER_KEYS.has(key)) {
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
  const synonyms = parseCustomSynonyms(formData.customSynonyms);
  world.customSynonyms = synonyms.synonyms;
  for (const error of synonyms.errors) errors.push(`Custom synonyms line ${error.line}: ${error.message}`);
  const examples = parseExtractionExamples(formData.extractionExamples);
  world.extractionExamples = examples.examples;
  for (const error of examples.errors) errors.push(`Extraction examples: ${error}`);
  return { basics, client, world, errors };
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

export function registerAiProviderSettings() {
  for (const [key, setting] of Object.entries(CLIENT_BASIC_SETTINGS)) {
    game.settings.register(MODULE_ID, setting, { scope: "client", config: false, type: String, default: key === "provider" ? "disabled" : "" });
  }
  game.settings.register(MODULE_ID, CLIENT_TUNING_SETTING, { scope: "client", config: false, type: String, default: "{}" });
  game.settings.register(MODULE_ID, WORLD_FLAVOR_SETTING, { scope: "world", config: false, type: String, default: "{}" });
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

async function persistSettings({ basics, client, world }) {
  for (const [key, setting] of Object.entries(CLIENT_BASIC_SETTINGS)) {
    await game.settings.set(MODULE_ID, setting, String(basics[key] ?? ""));
  }
  await game.settings.set(MODULE_ID, CLIENT_TUNING_SETTING, JSON.stringify(client));
  if (game.user?.isGM) await game.settings.set(MODULE_ID, WORLD_FLAVOR_SETTING, JSON.stringify(world));
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
  <p class="gd-help">Grand Design reads your session notes with an AI -- written however you like, in any language -- and turns them into growth. Local models (Ollama) keep everything on your machine.</p>
  <fieldset><legend>Connection (this browser only)</legend>
    <div class="form-group"><label>Provider</label><select name="provider">${providerOptions}</select></div>
    <div class="form-group gd-ai-only"${aiOnly}><label>Endpoint</label><input name="endpoint" type="text" value="${escapeHtml(config.endpoint ?? "")}" placeholder="${escapeHtml(PROVIDER_PRESETS[provider]?.endpoint || "https://...")}"></div>
    <p class="gd-help gd-ai-only"${aiOnly}>Ollama: http://127.0.0.1:11434 (an old ".../api/chat" address still works). Remote providers must use HTTPS.</p>
    <div class="form-group gd-ai-only"${aiOnly}><label>Model</label><div class="gd-row"><input name="model" type="text" list="gd-model-list" value="${escapeHtml(config.model ?? "")}" placeholder="${escapeHtml(PROVIDER_PRESETS[provider]?.model || "model name")}"><button type="button" data-action="refresh-models"><i class="fas fa-rotate"></i> Refresh models</button></div><datalist id="gd-model-list"></datalist></div>
    <div class="form-group gd-ai-only"${aiOnly}><label>API key</label><input name="apiKey" type="password" value="${escapeHtml(config.apiKey ?? "")}" autocomplete="off" placeholder="only for hosted providers"></div>
    <div class="gd-ai-only"${aiOnly}><button type="button" data-action="test-connection"><i class="fas fa-plug"></i> Test Connection</button><div class="gd-test-result gd-help">Checks the connection, the model, and reads one sample sentence.</div></div>
  </fieldset>
  <details class="gd-ai-only"${aiOnly}><summary><strong>Model tuning (this browser only)</strong></summary><fieldset>
    <div class="form-group"><label>Temperature</label><div class="gd-row"><input type="range" name="temperature" min="0" max="1.5" step="0.05" value="${Number(client.temperature)}"><output name="temperatureValue">${Number(client.temperature).toFixed(2)}</output></div></div>
    <p class="gd-help">Lower = more consistent readings. 0.1-0.3 is a good range for note extraction.</p>
    <div class="form-group"><label>Context size (tokens)</label><input type="number" name="numCtx" min="2048" max="262144" step="1024" value="${Number(client.numCtx)}"></div>
    <div class="form-group"><label>Max reply tokens</label><input type="number" name="numPredict" min="256" max="32768" step="256" value="${Number(client.numPredict)}"></div>
    <div class="form-group"><label>Timeout (ms)</label><input type="number" name="timeoutMs" min="5000" max="900000" step="1000" value="${Number(client.timeoutMs)}"></div>
    <div class="form-group"><label>Repair attempts</label><input type="number" name="maxRepairAttempts" min="0" max="5" step="1" value="${Number(client.maxRepairAttempts)}"></div>
    <div class="form-group"><label>Pipeline</label><select name="pipeline">${PIPELINES.map((value) => option(value, value === "two-stage" ? "Two-stage (read events, then propose) -- most robust" : "Single call -- faster, less robust", client.pipeline)).join("")}</select></div>
    <div class="form-group"><label>Chunk size (characters)</label><input type="number" name="chunkChars" min="400" max="20000" step="100" value="${Number(client.chunkChars)}"></div>
    <div class="form-group"><label>Summary language</label><input type="text" name="outputLanguage" value="${escapeHtml(client.outputLanguage ?? "en")}" placeholder="en, es, el, de..."></div>
    <p class="gd-help">Event summaries are written in this language; the original quote is always kept as written.</p>
  </fieldset></details>
  <fieldset><legend>Table flavor</legend><p class="gd-help">${escapeHtml(worldNote)}</p>
    <div class="form-group"><label>Proposals</label><select name="proposalMode">${PROPOSAL_MODES.map((value) => option(value, { "when-earned": "When earned (enough evidence)", always: "Always suggest something", never: "Never (events only)" }[value] ?? value, world.proposalMode)).join("")}</select></div>
    <div class="form-group"><label>Max proposals per analysis</label><input type="number" name="maxProposals" min="0" max="10" step="1" value="${Number(world.maxProposals)}"></div>
    <div class="form-group stacked"><label>Creativity</label>${creativity}</div>
    <div class="form-group"><label>Allow red (taboo) entries</label><input type="checkbox" name="allowRed" ${world.allowRed ? "checked" : ""}></div>
    <div class="form-group"><label>Emergent themes</label><input type="checkbox" name="emergentThemes" ${world.emergentThemes ? "checked" : ""}></div>
    <p class="gd-help">Lets activities the tag list never anticipated (beekeeping, gambling, map-making...) grow into brand-new Skills.</p>
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
