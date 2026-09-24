import assert from "node:assert/strict";
import test from "node:test";

import {
  AiProviderHttpError,
  AiProviderResponseError,
  AiProviderTimeoutError,
  AiProviderUnreachableError,
  assertSafeEndpoint,
  createTransport,
  resolveEndpoints
} from "../scripts/ai/transport.js";
import { EVENT_EXTRACTION_SCHEMA } from "../scripts/ai/schemas.js";
import { createSimModel } from "../tools/nlp-scale/sim-model.js";

// A scripted fetch: each call shifts the next scripted reply (a function of (url, init) or a spec).
function scriptedFetch(script) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), init, body, headers: init.headers ?? {} });
    const step = script.length > 1 ? script.shift() : script[0];
    if (typeof step === "function") return step(url, init);
    if (step instanceof Error) throw step;
    const { status = 200, json, text, headers = {} } = step;
    return new Response(text ?? JSON.stringify(json ?? {}), { status, headers: { "content-type": "application/json", ...headers } });
  };
  return { fetchImpl, calls };
}

const ollamaOk = (content = '{"events":[]}', extra = {}) => ({ json: { model: "m", message: { role: "assistant", content }, done: true, ...extra } });
const openaiOk = (content = '{"events":[]}', extra = {}) => ({ json: { model: "m", choices: [{ message: { content }, finish_reason: "stop", ...extra }] } });
const noSleep = async () => {};
const MESSAGES = [{ role: "system", content: "s" }, { role: "user", content: "u" }];

test("ollama: POSTs /api/chat with stream:false, think:false, schema format and options", async () => {
  const { fetchImpl, calls } = scriptedFetch([ollamaOk()]);
  const transport = createTransport({ provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "qwen3:30b-a3b", fetchImpl, ollamaOptions: { num_ctx: 16384, num_predict: 3072 } });
  const result = await transport.chat({ messages: MESSAGES, schema: EVENT_EXTRACTION_SCHEMA, temperature: 0.2, maxTokens: 999 });
  assert.equal(result.content, '{"events":[]}');
  const [{ url, body, init }] = calls;
  assert.equal(url, "http://127.0.0.1:11434/api/chat");
  assert.equal(init.method, "POST");
  assert.equal(body.model, "qwen3:30b-a3b");
  assert.equal(body.stream, false);
  assert.equal(body.think, false);
  assert.deepEqual(body.format, EVENT_EXTRACTION_SCHEMA);
  assert.deepEqual(body.messages, MESSAGES);
  assert.equal(body.options.num_ctx, 16384);
  assert.equal(body.options.num_predict, 999, "maxTokens overrides the default num_predict");
  assert.equal(body.options.temperature, 0.2);
  assert.equal(typeof result.ms, "number");
});

test("ollama: without a schema the format is plain \"json\"", async () => {
  const { fetchImpl, calls } = scriptedFetch([ollamaOk()]);
  await createTransport({ provider: "ollama", endpoint: "http://localhost:11434", model: "m", fetchImpl }).chat({ messages: MESSAGES });
  assert.equal(calls[0].body.format, "json");
});

test("ollama: a 400 complaining about format downgrades to format:\"json\" and retries once", async () => {
  const { fetchImpl, calls } = scriptedFetch([{ status: 400, json: { error: "invalid format: schema not supported" } }, ollamaOk()]);
  const transport = createTransport({ provider: "ollama", endpoint: "http://localhost:11434", model: "m", fetchImpl });
  await transport.chat({ messages: MESSAGES, schema: EVENT_EXTRACTION_SCHEMA });
  assert.equal(calls.length, 2);
  assert.equal(typeof calls[0].body.format, "object");
  assert.equal(calls[1].body.format, "json");
});

test("ollama: an /v1 endpoint is rewritten to the native /api/chat (the shim ignores num_ctx)", () => {
  const { chatUrl, notes } = resolveEndpoints("ollama", "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(chatUrl, "http://127.0.0.1:11434/api/chat");
  assert.ok(notes.length >= 1);
});

test("openaiCompatible: POSTs /v1/chat/completions with a json_schema response_format", async () => {
  const { fetchImpl, calls } = scriptedFetch([openaiOk('{"events":[1]}')]);
  const transport = createTransport({ provider: "openaiCompatible", endpoint: "http://localhost:1234", model: "local-model", fetchImpl });
  const result = await transport.chat({ messages: MESSAGES, schema: EVENT_EXTRACTION_SCHEMA, temperature: 0.3, maxTokens: 500 });
  assert.equal(result.content, '{"events":[1]}');
  const [{ url, body }] = calls;
  assert.equal(url, "http://localhost:1234/v1/chat/completions");
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, false);
  assert.equal(typeof body.response_format.json_schema.name, "string");
  assert.deepEqual(body.response_format.json_schema.schema, EVENT_EXTRACTION_SCHEMA);
  assert.equal(body.temperature, 0.3);
  assert.equal(body.max_tokens, 500);
  assert.equal("think" in body, false);
});

test("openai: a 400 mentioning response_format retries once with json_object and remembers the downgrade", async () => {
  const { fetchImpl, calls } = scriptedFetch([{ status: 400, json: { error: { message: "response_format json_schema is not supported" } } }, openaiOk(), openaiOk()]);
  const transport = createTransport({ provider: "hosted", endpoint: "https://api.example.com/v1", model: "m", fetchImpl, apiKey: "sk-test" });
  await transport.chat({ messages: MESSAGES, schema: EVENT_EXTRACTION_SCHEMA });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.response_format.type, "json_object");
  await transport.chat({ messages: MESSAGES, schema: EVENT_EXTRACTION_SCHEMA });
  assert.equal(calls.length, 3, "the downgrade is paid once per transport, not once per call");
  assert.equal(calls[2].body.response_format.type, "json_object");
  assert.equal(transport.compat.responseFormat, "json_object");
});

test("openai: an unrelated 400 is not retried", async () => {
  const { fetchImpl, calls } = scriptedFetch([{ status: 400, json: { error: "messages too long" } }]);
  const transport = createTransport({ provider: "openaiCompatible", endpoint: "http://localhost:1234", model: "m", fetchImpl, sleep: noSleep });
  await assert.rejects(() => transport.chat({ messages: MESSAGES, schema: EVENT_EXTRACTION_SCHEMA }), (error) => error instanceof AiProviderHttpError && error.status === 400);
  assert.equal(calls.length, 1);
});

test("apiKey becomes a Bearer header and getHeaders are merged in", async () => {
  const { fetchImpl, calls } = scriptedFetch([openaiOk()]);
  await createTransport({ provider: "hosted", endpoint: "https://api.example.com/v1", model: "m", apiKey: "sk-1", getHeaders: () => ({ "X-Extra": "1" }), fetchImpl }).chat({ messages: MESSAGES });
  assert.equal(calls[0].headers.Authorization, "Bearer sk-1");
  assert.equal(calls[0].headers["X-Extra"], "1");
  assert.equal(calls[0].headers["Content-Type"], "application/json");
});

test("no apiKey means no Authorization header (Ollama needs none)", async () => {
  const { fetchImpl, calls } = scriptedFetch([ollamaOk()]);
  await createTransport({ provider: "ollama", endpoint: "http://localhost:11434", model: "m", fetchImpl }).chat({ messages: MESSAGES });
  assert.equal("Authorization" in calls[0].headers, false);
});

test("a provider that never answers throws AiProviderTimeoutError after timeoutMs", async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const { fetchImpl } = scriptedFetch([hang]);
  const transport = createTransport({ provider: "ollama", endpoint: "http://localhost:11434", model: "m", fetchImpl, timeoutMs: 25 });
  const started = Date.now();
  await assert.rejects(() => transport.chat({ messages: MESSAGES }), (error) => {
    assert.ok(error instanceof AiProviderTimeoutError);
    assert.equal(error.timeoutMs, 25);
    assert.match(error.message, /No notes were lost/);
    return true;
  });
  assert.ok(Date.now() - started < 2000);
});

test("a network failure throws AiProviderUnreachableError naming the endpoint, with the cause attached", async () => {
  const cause = new TypeError("Failed to fetch");
  const { fetchImpl } = scriptedFetch([cause]);
  const transport = createTransport({ provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "m", fetchImpl });
  await assert.rejects(() => transport.chat({ messages: MESSAGES }), (error) => {
    assert.ok(error instanceof AiProviderUnreachableError);
    assert.match(error.message, /127\.0\.0\.1:11434/);
    assert.match(error.message, /OLLAMA_ORIGINS/);
    assert.equal(error.cause, cause);
    return true;
  });
});

test("5xx is retried with exponential backoff and then succeeds", async () => {
  const sleeps = [];
  const { fetchImpl, calls } = scriptedFetch([{ status: 503, json: { error: "loading model" } }, { status: 500, json: {} }, ollamaOk('{"ok":1}')]);
  const transport = createTransport({ provider: "ollama", endpoint: "http://localhost:11434", model: "m", fetchImpl, sleep: async (ms) => sleeps.push(ms), retryBaseMs: 100 });
  const result = await transport.chat({ messages: MESSAGES });
  assert.equal(result.content, '{"ok":1}');
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [100, 200]);
  assert.equal(result.retries, 2);
});

test("429 honors Retry-After (seconds)", async () => {
  const sleeps = [];
  const { fetchImpl } = scriptedFetch([{ status: 429, json: {}, headers: { "retry-after": "1" } }, openaiOk()]);
  await createTransport({ provider: "openaiCompatible", endpoint: "http://localhost:1234", model: "m", fetchImpl, sleep: async (ms) => sleeps.push(ms) }).chat({ messages: MESSAGES });
  assert.deepEqual(sleeps, [1000]);
});

test("5xx beyond maxRetries (2) surfaces AiProviderHttpError with the status", async () => {
  const { fetchImpl, calls } = scriptedFetch([{ status: 502, json: { error: "bad gateway" } }]);
  const transport = createTransport({ provider: "ollama", endpoint: "http://localhost:11434", model: "m", fetchImpl, sleep: noSleep });
  await assert.rejects(() => transport.chat({ messages: MESSAGES }), (error) => error instanceof AiProviderHttpError && error.status === 502 && /HTTP 502/.test(error.message));
  assert.equal(calls.length, 3);
});

test("404 is not retried", async () => {
  const { fetchImpl, calls } = scriptedFetch([{ status: 404, json: { error: "model 'x' not found" } }]);
  await assert.rejects(() => createTransport({ provider: "ollama", endpoint: "http://localhost:11434", model: "x", fetchImpl, sleep: noSleep }).chat({ messages: MESSAGES }), /HTTP 404/);
  assert.equal(calls.length, 1);
});

test("a non-JSON body throws AiProviderResponseError; a body without content too", async () => {
  const { fetchImpl } = scriptedFetch([{ text: "<html>proxy error</html>" }, { json: { choices: [] } }]);
  const transport = createTransport({ provider: "openaiCompatible", endpoint: "http://localhost:1234", model: "m", fetchImpl });
  await assert.rejects(() => transport.chat({ messages: MESSAGES }), AiProviderResponseError);
  await assert.rejects(() => transport.chat({ messages: MESSAGES }), AiProviderResponseError);
});

test("content given as an array of parts is joined", async () => {
  const { fetchImpl } = scriptedFetch([{ json: { choices: [{ message: { content: [{ type: "text", text: '{"a"' }, { type: "text", text: ":1}" }] } }] } }]);
  const result = await createTransport({ provider: "openaiCompatible", endpoint: "http://localhost:1234", model: "m", fetchImpl }).chat({ messages: MESSAGES });
  assert.equal(result.content, '{"a":1}');
});

test("an empty content with JSON in message.thinking falls back to the thinking text", async () => {
  const { fetchImpl } = scriptedFetch([{ json: { message: { content: "", thinking: '{"events":[]}' }, done: true } }]);
  const result = await createTransport({ provider: "ollama", endpoint: "http://localhost:11434", model: "m", fetchImpl }).chat({ messages: MESSAGES });
  assert.equal(result.content, '{"events":[]}');
});

test("finish_reason/done_reason 'length' is reported as truncated", async () => {
  const { fetchImpl } = scriptedFetch([ollamaOk('{"events":[', { done_reason: "length" }), openaiOk('{"ev', { finish_reason: "length" })]);
  const o = await createTransport({ provider: "ollama", endpoint: "http://localhost:11434", model: "m", fetchImpl }).chat({ messages: MESSAGES });
  assert.equal(o.truncated, true);
  const a = await createTransport({ provider: "openaiCompatible", endpoint: "http://localhost:1234", model: "m", fetchImpl }).chat({ messages: MESSAGES });
  assert.equal(a.truncated, true);
});

const ENDPOINT_CASES = [
  ["ollama", "http://127.0.0.1:11434", "http://127.0.0.1:11434/api/chat", "http://127.0.0.1:11434/api/tags"],
  ["ollama", "http://127.0.0.1:11434/", "http://127.0.0.1:11434/api/chat", "http://127.0.0.1:11434/api/tags"],
  ["ollama", "http://127.0.0.1:11434/api/chat", "http://127.0.0.1:11434/api/chat", "http://127.0.0.1:11434/api/tags"],
  ["ollama", "http://localhost:11434/v1", "http://localhost:11434/api/chat", "http://localhost:11434/api/tags"],
  ["ollama", "https://gpu.example.com/ollama/api/chat", "https://gpu.example.com/ollama/api/chat", "https://gpu.example.com/ollama/api/tags"],
  ["openaiCompatible", "http://localhost:1234", "http://localhost:1234/v1/chat/completions", "http://localhost:1234/v1/models"],
  ["openaiCompatible", "http://localhost:1234/v1", "http://localhost:1234/v1/chat/completions", "http://localhost:1234/v1/models"],
  ["openaiCompatible", "http://localhost:1234/v1/chat/completions", "http://localhost:1234/v1/chat/completions", "http://localhost:1234/v1/models"],
  ["hosted", "https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1/chat/completions", "https://openrouter.ai/api/v1/models"]
];
for (const [provider, endpoint, chatUrl, modelsUrl] of ENDPOINT_CASES) {
  test(`resolveEndpoints(${provider}, ${endpoint})`, () => {
    const resolved = resolveEndpoints(provider, endpoint);
    assert.equal(resolved.chatUrl, chatUrl);
    assert.equal(resolved.modelsUrl, modelsUrl);
  });
}

test("assertSafeEndpoint: HTTPS anywhere, plain HTTP only to loopback", () => {
  for (const ok of ["https://api.openai.com/v1", "http://localhost:11434", "http://127.0.0.1:11434", "http://[::1]:11434"]) assert.doesNotThrow(() => assertSafeEndpoint(ok), ok);
  for (const bad of ["http://192.168.1.20:11434", "http://example.com", "ftp://localhost", 42, undefined]) assert.throws(() => assertSafeEndpoint(bad), String(bad));
});

test("createTransport refuses an unsafe endpoint up front", () => {
  assert.throws(() => createTransport({ provider: "ollama", endpoint: "http://10.0.0.5:11434", model: "m" }), /HTTPS/);
});

test("listModels reads Ollama /api/tags and OpenAI /v1/models shapes", async () => {
  const { fetchImpl, calls } = scriptedFetch([{ json: { models: [{ name: "qwen3:30b-a3b" }, { model: "qwen2.5:14b" }] } }, { json: { data: [{ id: "gpt-x" }, "plain"] } }]);
  assert.deepEqual(await createTransport({ provider: "ollama", endpoint: "http://localhost:11434", model: "m", fetchImpl }).listModels(), ["qwen3:30b-a3b", "qwen2.5:14b"]);
  assert.equal(calls[0].url, "http://localhost:11434/api/tags");
  assert.deepEqual(await createTransport({ provider: "hosted", endpoint: "https://x.example/v1", model: "m", fetchImpl }).listModels(), ["gpt-x", "plain"]);
});

test("ping reports ok + modelAvailable, matching an implicit :latest tag", async () => {
  const { fetchImpl } = scriptedFetch([{ json: { models: [{ name: "mistral:latest" }] } }]);
  const result = await createTransport({ provider: "ollama", endpoint: "http://localhost:11434", model: "mistral", fetchImpl }).ping();
  assert.equal(result.ok, true);
  assert.equal(result.modelAvailable, true);
  assert.equal(typeof result.ms, "number");
});

test("ping on a reachable server without the model says how to pull it", async () => {
  const { fetchImpl } = scriptedFetch([{ json: { models: [{ name: "other:latest" }] } }]);
  const result = await createTransport({ provider: "ollama", endpoint: "http://localhost:11434", model: "qwen3:30b-a3b", fetchImpl }).ping();
  assert.equal(result.ok, true);
  assert.equal(result.modelAvailable, false);
  assert.match(result.error, /ollama pull qwen3:30b-a3b/);
});

test("ping never throws when the provider is down", async () => {
  const { fetchImpl } = scriptedFetch([new TypeError("Failed to fetch")]);
  const result = await createTransport({ provider: "ollama", endpoint: "http://localhost:11434", model: "m", fetchImpl }).ping();
  assert.equal(result.ok, false);
  assert.match(result.error, /Could not reach/);
});

test("ping on an OpenAI-compatible server without /models falls back to a tiny chat", async () => {
  const { fetchImpl, calls } = scriptedFetch([{ status: 404, json: {} }, openaiOk('{"ok":true}')]);
  const result = await createTransport({ provider: "openaiCompatible", endpoint: "http://localhost:8080", model: "m", fetchImpl, sleep: noSleep }).ping();
  assert.equal(result.ok, true);
  assert.equal(calls[1].url, "http://localhost:8080/v1/chat/completions");
});

test("fetch is resolved at call time, so a later globalThis.fetch stub is honored", async () => {
  const original = globalThis.fetch;
  const transport = createTransport({ provider: "ollama", endpoint: "http://localhost:11434", model: "m" });
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ message: { content: '{"late":1}' } }), { status: 200 });
    assert.equal((await transport.chat({ messages: MESSAGES })).content, '{"late":1}');
  } finally {
    globalThis.fetch = original;
  }
});

test("the sim-model fetch is a drop-in fetchImpl for both wire shapes", async () => {
  const sim = createSimModel({ seed: 3 });
  for (const provider of ["ollama", "openaiCompatible"]) {
    const endpoint = provider === "ollama" ? "http://127.0.0.1:11434" : "http://127.0.0.1:1234";
    const transport = createTransport({ provider, endpoint, model: "sim", fetchImpl: sim.fetch });
    const result = await transport.chat({ messages: [{ role: "user", content: "Kesh parried the blade and struck the guard." }], schema: EVENT_EXTRACTION_SCHEMA });
    const parsed = JSON.parse(result.content);
    assert.ok(Array.isArray(parsed.events));
    assert.deepEqual(await transport.listModels(), ["sim-model:latest", "qwen3:30b-a3b"]);
  }
});
