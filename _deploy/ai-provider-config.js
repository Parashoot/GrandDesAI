import { createChatCompletionsAdapter } from "./ai-gateway.js";
import { MODULE_ID } from "./constants.js";

const SETTINGS = {
  provider: "aiProvider",
  endpoint: "aiEndpoint",
  model: "aiModel",
  apiKey: "aiApiKey"
};

const PROVIDERS = {
  disabled: {
    label: "Disabled (use built-in local note analysis)",
    endpoint: "",
    model: "",
    requiresKey: false
  },
  ollama: {
    label: "Local Ollama (recommended)",
    endpoint: "http://127.0.0.1:11434/api/chat",
    model: "mistral-small3.1:24b",
    requiresKey: false
  },
  openaiCompatible: {
    label: "Local OpenAI-compatible server",
    endpoint: "http://127.0.0.1:1234/v1/chat/completions",
    model: "",
    requiresKey: false
  },
  hosted: {
    label: "Hosted OpenAI-compatible API",
    endpoint: "",
    model: "",
    requiresKey: true
  }
};

// Ollama defaults every model to a 4096-token context window regardless of what the model itself
// supports (mistral-small3.1:24b can handle 131072). The Grand Design request body -- system
// prompt plus the full schema/allowedTags/exampleByKind payload -- alone runs to roughly 3500-4000
// tokens, so with the 4096-token default there was barely any room left for a response: the model's
// JSON reply was silently truncated mid-object every single time, which surfaced only as "AI
// provider returned malformed JSON" with no indication of why. num_ctx raises the context window so
// the full request fits with room to spare, and num_predict caps the reply at a generous but bounded
// length instead of the provider's own default (which is also too small here).
//
// IMPORTANT: this only takes effect through Ollama's own /api/chat endpoint. Its OpenAI-compatible
// shim at /v1/chat/completions silently ignores an `options` object entirely -- confirmed with
// `ollama ps`, which keeps reporting the old (default) context size after a /v1 call even when
// `options.num_ctx` was sent, but immediately reports the requested size after a /api/chat call.
// That is exactly why the Ollama preset's endpoint above is the native /api/chat route, not the
// OpenAI-compatible one other providers use -- see ai-gateway.js's `transport: "ollama-native"`.
const OLLAMA_INFERENCE_OPTIONS = { num_ctx: 16384, num_predict: 2048 };

export function registerAiProviderSettings() {
  for (const [key, setting] of Object.entries(SETTINGS)) {
    game.settings.register(MODULE_ID, setting, {
      scope: "client",
      config: false,
      type: String,
      default: key === "provider" ? "disabled" : ""
    });
  }
  game.settings.registerMenu(MODULE_ID, "aiProviderSetup", {
    name: "AI Provider Setup",
    label: "Configure AI Provider",
    hint: "Configure a local or bring-your-own hosted AI provider for this browser only.",
    icon: "fas fa-brain",
    type: AiProviderSettings,
    restricted: true
  });
}

export function createConfiguredAiAdapter() {
  const config = getAiProviderConfig();
  if (config.provider === "disabled") return null;
  if (!config.endpoint || !config.model) return null;
  if (config.requiresKey && !config.apiKey) {
    throw new Error("This hosted AI provider requires an API key in Grand Design AI Provider Setup.");
  }
  return createChatCompletionsAdapter({
    endpoint: config.endpoint,
    model: config.model,
    getHeaders: () => (config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    requestOptions: config.provider === "ollama" ? { think: false, options: OLLAMA_INFERENCE_OPTIONS } : {},
    transport: config.provider === "ollama" ? "ollama-native" : "openai"
  });
}

export function getAiProviderConfig() {
  const provider = game.settings.get(MODULE_ID, SETTINGS.provider);
  const preset = PROVIDERS[provider] ?? PROVIDERS.disabled;
  return {
    provider,
    label: preset.label,
    endpoint: game.settings.get(MODULE_ID, SETTINGS.endpoint) || preset.endpoint,
    model: game.settings.get(MODULE_ID, SETTINGS.model) || preset.model,
    apiKey: game.settings.get(MODULE_ID, SETTINGS.apiKey),
    requiresKey: preset.requiresKey
  };
}

class AiProviderSettings extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      title: "Grand Design AI Provider Setup",
      id: "grand-design-ai-provider-setup",
      template: null,
      width: 560
    });
  }

  getData() {
    return { config: getAiProviderConfig(), providers: PROVIDERS };
  }

  async _renderInner() {
    const { config, providers } = this.getData();
    const options = Object.entries(providers)
      .map(([id, provider]) => `<option value="${id}" ${id === config.provider ? "selected" : ""}>${provider.label}</option>`)
      .join("");
    return $(`<form>
      <p>Local providers are preferred. Settings are client-scoped: the key stays in this Foundry browser profile and is never sent to a world setting.</p>
      <div class="form-group"><label>Provider</label><select name="provider">${options}</select></div>
      <div class="form-group"><label>Chat-completions endpoint</label><input name="endpoint" type="url" value="${escapeHtml(config.endpoint)}" required></div>
      <div class="form-group"><label>Model</label><input name="model" type="text" value="${escapeHtml(config.model)}" required></div>
      <div class="form-group"><label>API key</label><input name="apiKey" type="password" value="${escapeHtml(config.apiKey)}" autocomplete="off"></div>
      <p>Use HTTPS for remote providers. Only localhost/127.0.0.1 may use HTTP.</p>
      <footer class="sheet-footer flexrow"><button type="submit"><i class="fas fa-save"></i> Save</button></footer>
    </form>`);
  }

  async _updateObject(_event, formData) {
    for (const [key, setting] of Object.entries(SETTINGS)) {
      await game.settings.set(MODULE_ID, setting, String(formData[key] ?? "").trim());
    }
    const api = game.modules.get(MODULE_ID).api;
    try {
      const adapter = createConfiguredAiAdapter();
      api.setProposalAdapter(adapter);
      ui.notifications.info(adapter ? "Grand Design AI provider configured for this GM browser." : "Grand Design AI provider configuration cleared.");
    } catch (error) {
      console.error(`${MODULE_ID} | provider setup failed`, error);
      ui.notifications.error(error.message);
    }
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
