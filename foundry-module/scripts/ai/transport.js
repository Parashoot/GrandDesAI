// HTTP transport to the model provider. One small object per configured provider:
//   chat({ messages, schema?, temperature?, maxTokens?, signal? }) -> { content, raw, ms, truncated, model }
//   listModels() -> string[]
//   ping() -> { ok, ms, model, modelAvailable?, models?, error? }
//
// Why this is its own layer: every "fall back to the keyword dictionary" we have traced so far was a
// transport problem wearing a different hat -- Ollama's /v1 shim silently ignoring num_ctx (so every
// reply was truncated), a hosted API rejecting `response_format` with a 400, a model still loading
// returning 503 for the first few seconds, a browser fetch that hangs forever. Each of those now has
// a specific, tested behaviour here instead of surfacing as "malformed JSON".
//
// Pure ESM, zero Foundry globals. `fetch`/`AbortController`/`setTimeout` are platform globals in
// browsers and Node 18+; fetch and sleep are injectable so tests never touch the network or wait.

// A browser `fetch` that cannot reach its target rejects with a bare TypeError whose message is the
// famously unhelpful "Failed to fetch" -- no URL, no cause, nothing a GM can act on. That string was
// the only thing a GM saw when the Growth dialog's "Analyze Notes" button hit a provider that wasn't
// running. Everything actionable is spelled out here instead. (Moved from ai-gateway.js, which
// re-exports it for backward compatibility.)
export class AiProviderUnreachableError extends Error {
  constructor(endpoint, cause) {
    const { hostname, port } = safeUrlParts(endpoint);
    // The origin that must be allowed is the page MAKING the request (this Foundry server), not the
    // endpoint's own -- getting these backwards is exactly the mistake that makes a CORS
    // misconfiguration hard to diagnose.
    const callerOrigin = typeof location !== "undefined" && location?.origin ? location.origin : "this Foundry server's origin";
    super(
      `Could not reach the AI provider at ${endpoint}. Nothing was sent and no notes were lost. `
        + `Check that: (1) the provider is actually running and listening on ${hostname}:${port} `
        + `-- for Ollama, \`ollama serve\`, then \`ollama list\` to confirm the model is pulled; `
        + `(2) it allows browser requests from ${callerOrigin} -- Ollama gates this with the `
        + `OLLAMA_ORIGINS environment variable, which must include that origin; and (3) the endpoint `
        + `in Grand Design's AI Provider Setup matches the port the provider is really on.`
    );
    this.name = "AiProviderUnreachableError";
    this.endpoint = endpoint;
    this.cause = cause;
  }
}

export class AiProviderTimeoutError extends Error {
  constructor(endpoint, timeoutMs) {
    super(
      `The AI provider at ${endpoint} did not answer within ${Math.round(timeoutMs / 1000)}s. No notes were lost. `
        + "A large local model may still be loading into memory (the first call after a restart is the slowest), "
        + "or the notes are long for this model -- try again, raise the timeout, or pick a faster model in AI Provider Setup."
    );
    this.name = "AiProviderTimeoutError";
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
  }
}

export class AiProviderHttpError extends Error {
  constructor(status, detail = "") {
    // "AI provider returned HTTP <status>." is kept verbatim: existing tests and GM-facing docs
    // match on it.
    super(`AI provider returned HTTP ${status}.${detail ? ` ${detail}` : ""}`);
    this.name = "AiProviderHttpError";
    this.status = status;
    this.detail = detail;
  }
}

export class AiProviderResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiProviderResponseError";
  }
}

export function safeUrlParts(endpoint) {
  try {
    const url = new URL(endpoint);
    return { hostname: url.hostname, port: url.port || (url.protocol === "https:" ? "443" : "80") };
  } catch {
    return { hostname: "the configured host", port: "its port" };
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// Notes can contain players' real names and table drama; they must never cross the network in
// plaintext to anything but this machine. HTTPS everywhere, plain HTTP only to loopback.
export function assertSafeEndpoint(endpoint) {
  if (typeof endpoint !== "string") throw new Error("The AI gateway endpoint must be a URL.");
  const url = new URL(endpoint);
  const local = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("AI endpoints must use HTTPS, except a local localhost or loopback server.");
  }
}

export function normalizeProviderKind(provider) {
  const p = String(provider ?? "").toLowerCase();
  return p === "ollama" || p === "ollama-native" ? "ollama" : "openai";
}

/**
 * Accepts either a base URL ("http://127.0.0.1:11434", "https://api.openai.com/v1") or a full path,
 * and returns { chatUrl, modelsUrl, notes[] } for the provider.
 */
export function resolveEndpoints(provider, endpoint) {
  const kind = normalizeProviderKind(provider);
  const url = new URL(endpoint);
  const notes = [];
  const path = url.pathname.replace(/\/+$/, "");
  const origin = url.origin;
  if (kind === "ollama") {
    // Ollama's OpenAI shim ignores options.num_ctx, which silently truncated every reply at the
    // default 4096-token context (see ai-provider-config.js history). Always use the native route.
    if (/\/v1\/chat\/completions$|\/v1$|\/api\/generate$/.test(path)) notes.push(`rewrote ${path} to Ollama's native /api/chat (the /v1 shim ignores num_ctx)`);
    const prefix = path.replace(/\/(api\/chat|api\/generate|api|v1\/chat\/completions|v1)$/, "");
    return { chatUrl: `${origin}${prefix}/api/chat${url.search}`, modelsUrl: `${origin}${prefix}/api/tags`, notes };
  }
  let chatPath;
  if (/\/chat\/completions$/.test(path)) chatPath = path;
  else if (/\/v\d+(beta)?$/.test(path) || /\/openai$/.test(path)) chatPath = `${path}/chat/completions`;
  else if (!path) chatPath = "/v1/chat/completions";
  else chatPath = path; // a custom proxy path: trust it
  const modelsPath = chatPath.endsWith("/chat/completions") ? chatPath.replace(/\/chat\/completions$/, "/models") : `${chatPath}/models`;
  return { chatUrl: `${origin}${chatPath}${url.search}`, modelsUrl: `${origin}${modelsPath}`, notes };
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 524, 529]);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} opts
 * @param {"ollama"|"openaiCompatible"|"hosted"|"openai"} opts.provider
 * @param {string} opts.endpoint base URL or full chat path
 * @param {string} opts.model
 * @param {string} [opts.apiKey]
 * @param {number} [opts.timeoutMs=180000]
 * @param {Function} [opts.fetchImpl] defaults to globalThis.fetch, resolved at call time
 * @param {object} [opts.ollamaOptions] merged into Ollama's `options` ({num_ctx, num_predict, ...})
 * @param {Function} [opts.getHeaders] extra headers per request (legacy adapter option)
 * @param {object} [opts.extraBody] merged into every request body (legacy `requestOptions`)
 * @param {number} [opts.maxRetries=2] retries for 429/5xx
 * @param {number} [opts.retryBaseMs=400]
 * @param {Function} [opts.sleep] injectable for tests
 * @param {"json_schema"|"json_object"|"none"} [opts.responseFormat="json_schema"] openai only; starting mode
 */
export function createTransport({
  provider = "ollama",
  endpoint,
  model,
  apiKey = "",
  timeoutMs = 180000,
  fetchImpl,
  ollamaOptions = {},
  getHeaders = () => ({}),
  extraBody = {},
  maxRetries = 2,
  retryBaseMs = 400,
  sleep = defaultSleep,
  responseFormat = "json_schema"
} = {}) {
  assertSafeEndpoint(endpoint);
  const kind = normalizeProviderKind(provider);
  const { chatUrl, modelsUrl, notes: endpointNotes } = resolveEndpoints(kind, endpoint);
  // Per-transport memory of what this server turned out not to support, so a 400 downgrade is paid
  // once per session, not once per chunk.
  const compat = { responseFormat, dropParams: new Set(), useMaxCompletionTokens: false, ollamaSchema: true, ollamaThink: true };
  const doFetch = (...args) => {
    const f = fetchImpl ?? globalThis.fetch;
    if (typeof f !== "function") throw new AiProviderUnreachableError(chatUrl, new Error("No fetch implementation is available in this environment."));
    return f(...args);
  };

  function headers() {
    const extra = typeof getHeaders === "function" ? getHeaders() ?? {} : {};
    return {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...extra
    };
  }

  async function timedFetch(url, init, signal) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let timedOut = false;
    const timer = controller ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : null;
    const onAbort = () => controller?.abort();
    if (signal && controller) signal.addEventListener?.("abort", onAbort, { once: true });
    try {
      return await doFetch(url, controller ? { ...init, signal: controller.signal } : init);
    } catch (error) {
      if (timedOut) throw new AiProviderTimeoutError(url, timeoutMs);
      if (error instanceof AiProviderUnreachableError) throw error;
      if (error?.name === "AbortError" && signal?.aborted) throw error; // caller cancelled
      // Only a genuine transport failure lands here; an HTTP error status resolves normally.
      throw new AiProviderUnreachableError(url, error);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && controller) signal.removeEventListener?.("abort", onAbort);
    }
  }

  function buildBody({ messages, schema, temperature, maxTokens }) {
    if (kind === "ollama") {
      const extraOptions = extraBody?.options && typeof extraBody.options === "object" ? extraBody.options : {};
      const options = { ...ollamaOptions, ...extraOptions };
      if (Number.isFinite(maxTokens)) options.num_predict = maxTokens;
      if (Number.isFinite(temperature)) options.temperature = temperature;
      const { options: _ignored, ...restExtra } = extraBody ?? {};
      const body = {
        model,
        messages,
        stream: false,
        // qwen3 and other reasoning models otherwise spend the whole num_predict budget "thinking"
        // and return an empty or truncated answer.
        think: false,
        // Ollama < 0.5 only understands format:"json"; downgraded after a 400 (see downgradeFor400).
        format: schema && compat.ollamaSchema ? schema : "json",
        ...restExtra,
        options
      };
      if (!compat.ollamaThink) delete body.think;
      return body;
    }
    const body = { model, messages };
    if (Number.isFinite(temperature) && !compat.dropParams.has("temperature")) body.temperature = temperature;
    if (Number.isFinite(maxTokens)) {
      if (compat.useMaxCompletionTokens) body.max_completion_tokens = maxTokens;
      else if (!compat.dropParams.has("max_tokens")) body.max_tokens = maxTokens;
    }
    if (compat.responseFormat === "json_schema" && schema) {
      body.response_format = { type: "json_schema", json_schema: { name: schemaNameFor(schema), schema, strict: false } };
    } else if (compat.responseFormat !== "none") {
      body.response_format = { type: "json_object" };
    }
    Object.assign(body, extraBody ?? {});
    for (const param of compat.dropParams) delete body[param];
    return body;
  }

  // Returns true when the 400 was a compatibility complaint we can fix by changing the request.
  function downgradeFor400(detail) {
    const text = String(detail || "").toLowerCase();
    if (kind === "ollama") {
      if (/format|schema/.test(text) && compat.ollamaSchema) { compat.ollamaSchema = false; return true; }
      if (/think/.test(text) && compat.ollamaThink) { compat.ollamaThink = false; return true; }
      return false;
    }
    if (/response_format|json_schema|structured output/.test(text)) {
      if (compat.responseFormat === "json_schema") { compat.responseFormat = "json_object"; return true; }
      if (compat.responseFormat === "json_object") { compat.responseFormat = "none"; return true; }
    }
    if (/max_tokens/.test(text) && /max_completion_tokens/.test(text) && !compat.useMaxCompletionTokens) {
      compat.useMaxCompletionTokens = true;
      return true;
    }
    const unsupported = /unsupported (?:parameter|value)[^'"`]*['"`]([a-z_]+)['"`]/.exec(text) || /['"`]([a-z_]+)['"`] (?:is not supported|is unsupported)/.exec(text);
    if (unsupported && !compat.dropParams.has(unsupported[1]) && !["model", "messages"].includes(unsupported[1])) {
      compat.dropParams.add(unsupported[1]);
      return true;
    }
    return false;
  }

  async function chat({ messages, schema, temperature, maxTokens, signal } = {}) {
    const started = nowMs();
    let attempt = 0;
    let downgrades = 0;
    const events = [];
    for (;;) {
      const body = buildBody({ messages, schema, temperature, maxTokens });
      const response = await timedFetch(chatUrl, { method: "POST", headers: headers(), body: JSON.stringify(body) }, signal);
      if (!response.ok) {
        const detail = await readErrorDetail(response);
        if (response.status === 400 && downgrades < 3 && downgradeFor400(detail)) {
          downgrades += 1;
          events.push(`downgraded-after-400:${kind === "ollama" ? `schema=${compat.ollamaSchema},think=${compat.ollamaThink}` : compat.responseFormat}`);
          continue;
        }
        if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
          attempt += 1;
          const retryAfter = retryAfterMs(response);
          events.push(`retry-after-${response.status}`);
          await sleep(retryAfter ?? retryBaseMs * 2 ** (attempt - 1));
          continue;
        }
        throw new AiProviderHttpError(response.status, detail);
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new AiProviderResponseError("AI provider returned a response body that was not JSON.");
      }
      const content = extractContent(payload);
      if (typeof content !== "string") {
        throw new AiProviderResponseError("AI provider did not return a JSON chat-completion message.");
      }
      const finish = payload?.choices?.[0]?.finish_reason ?? payload?.done_reason;
      return {
        content,
        raw: payload,
        ms: nowMs() - started,
        truncated: finish === "length",
        model: payload?.model ?? model,
        retries: attempt,
        transportEvents: events,
        responseFormat: kind === "ollama" ? (schema && compat.ollamaSchema ? "schema" : "json") : compat.responseFormat
      };
    }
  }

  async function listModels() {
    const response = await timedFetch(modelsUrl, { method: "GET", headers: headers() });
    if (!response.ok) throw new AiProviderHttpError(response.status, await readErrorDetail(response));
    const payload = await response.json();
    if (kind === "ollama") return (payload?.models ?? []).map((m) => m?.name ?? m?.model).filter(Boolean);
    return (payload?.data ?? payload?.models ?? []).map((m) => (typeof m === "string" ? m : m?.id ?? m?.name)).filter(Boolean);
  }

  async function ping() {
    const started = nowMs();
    try {
      const models = await listModels();
      const modelAvailable = models.some((name) => name === model || name === `${model}:latest` || name.replace(/:latest$/, "") === model);
      return {
        ok: true,
        ms: nowMs() - started,
        model,
        modelAvailable,
        models,
        ...(modelAvailable ? {} : { error: `Connected, but model "${model}" is not installed on this provider${kind === "ollama" ? ` (run \`ollama pull ${model}\`)` : ""}.` })
      };
    } catch (error) {
      // Some OpenAI-compatible servers do not implement /models; a one-token chat proves the path.
      if (kind !== "ollama" && error instanceof AiProviderHttpError && [404, 405, 501].includes(error.status)) {
        try {
          await chat({ messages: [{ role: "user", content: "Reply with {\"ok\":true}" }], maxTokens: 16, temperature: 0 });
          return { ok: true, ms: nowMs() - started, model, modelAvailable: true };
        } catch (inner) {
          return { ok: false, ms: nowMs() - started, model, error: inner.message };
        }
      }
      return { ok: false, ms: nowMs() - started, model, error: error.message };
    }
  }

  return {
    chat,
    listModels,
    ping,
    // Exposed so the pipeline's transient-failure retry (a dropped connection, one slow call) uses
    // the same injectable clock as the transport's own 429/5xx backoff -- tests pass a no-op.
    sleep,
    info: { provider: kind, model, chatUrl, modelsUrl, endpointNotes },
    get compat() { return { responseFormat: compat.responseFormat, dropParams: [...compat.dropParams], useMaxCompletionTokens: compat.useMaxCompletionTokens }; }
  };
}

function schemaNameFor(schema) {
  const props = Object.keys(schema?.properties ?? {});
  if (props.includes("events") && props.includes("proposals")) return "grand_design_events_and_proposals";
  if (props.includes("events")) return "grand_design_events";
  if (props.includes("proposals")) return "grand_design_proposals";
  return "grand_design_output";
}

function extractContent(payload) {
  const message = payload?.choices?.[0]?.message ?? payload?.message;
  let content = message?.content;
  // Some servers return content as an array of typed parts.
  if (Array.isArray(content)) content = content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("");
  // A reasoning model that put everything in `thinking` and left content empty.
  if ((content === "" || content === undefined || content === null) && typeof message?.thinking === "string" && /[{[]/.test(message.thinking)) {
    content = message.thinking;
  }
  if (content === undefined && typeof payload?.response === "string") content = payload.response; // /api/generate shape
  return typeof content === "string" ? content : undefined;
}

async function readErrorDetail(response) {
  try {
    if (typeof response.text !== "function") return "";
    const text = await response.text();
    if (!text) return "";
    try {
      const parsed = JSON.parse(text);
      const message = parsed?.error?.message ?? parsed?.error ?? parsed?.message ?? text;
      return String(typeof message === "string" ? message : JSON.stringify(message)).slice(0, 300);
    } catch {
      return text.slice(0, 300);
    }
  } catch {
    return "";
  }
}

function retryAfterMs(response) {
  const value = response.headers?.get?.("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.min(10000, Math.max(0, seconds * 1000)) : null;
}

function nowMs() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}
