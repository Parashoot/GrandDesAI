import assert from "node:assert/strict";
import test from "node:test";

import { buildAiGatewayRequest, createAiGatewayAdapter, createChatCompletionsAdapter } from "../scripts/ai-gateway.js";

const actor = {
  name: "Ari",
  system: { details: { level: { value: 5 } } },
  getFlag: (_module, flag) => flag === "levelProgression"
    ? { level: 20, grantAllowances: 1 }
    : ({ skills: {} })
};

test("AI gateway request supplies bounded context and schema", () => {
  const request = buildAiGatewayRequest(actor, "Ari saved the ferry.");

  assert.equal(request.task, "grand-design-pf2e-proposals");
  assert.equal(request.actor.level, 5);
  assert.ok(request.allowedTags.includes("medicine"));
  assert.equal(request.requirements.approvalRequired, true);
  assert.equal(request.actor.grandDesign.classEvolutionAvailable, true);
  assert.deepEqual(request.requirements.outputShape, { events: ["eventSchema"], proposals: ["proposalSchema"] });
});

test("AI gateway only accepts HTTPS endpoints", () => {
  assert.throws(() => createAiGatewayAdapter({ endpoint: "http://insecure.example" }));
  assert.doesNotThrow(() => createAiGatewayAdapter({ endpoint: "http://127.0.0.1:11434/v1/chat/completions" }));
});

// Regression guard: api.js's GrandDesignApi#_validateModelProposals reads proposal.entry
// (see progression.js and growth-ui.js, which agree). The prompt sent to the model must
// ask for that same field name, or every real proposal an LLM returns fails validation.
test("proposal schema in the prompt names the field 'entry', matching what api.js consumes", () => {
  const request = buildAiGatewayRequest(actor, "Ari saved the ferry.");
  const proposalSchema = request.requirements.proposalSchema;

  assert.ok(
    Object.prototype.hasOwnProperty.call(proposalSchema, "entry"),
    "proposalSchema must document a top-level 'entry' field."
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(proposalSchema, "skillEntry")
      && !Object.prototype.hasOwnProperty.call(proposalSchema, "classEntry"),
    "proposalSchema must not tell the model to nest the entry under skillEntry/classEntry."
  );
});

function withMockFetch(handler, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (endpoint, init) => {
    calls.push({ endpoint, init });
    return handler(endpoint, init);
  };
  return run(calls).finally(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("createChatCompletionsAdapter parses a choices[0].message.content chat-completion reply", () =>
  withMockFetch(
    () => jsonResponse(200, { choices: [{ message: { content: JSON.stringify({ events: [], proposals: [] } ) } }] }),
    async () => {
      const adapter = createChatCompletionsAdapter({ endpoint: "http://127.0.0.1:11434/v1/chat/completions", model: "mistral-small3.1:24b" });
      const result = await adapter({ actor, notes: "Ari saved the ferry." });
      assert.deepEqual(result, { events: [], proposals: [] });
    }
  ));

test("createChatCompletionsAdapter falls back to a bare message.content reply shape", () =>
  withMockFetch(
    () => jsonResponse(200, { message: { content: JSON.stringify({ events: [], proposals: [] }) } }),
    async () => {
      const adapter = createChatCompletionsAdapter({ endpoint: "http://127.0.0.1:11434/v1/chat/completions", model: "mistral-small3.1:24b" });
      const result = await adapter({ actor, notes: "Ari saved the ferry." });
      assert.deepEqual(result, { events: [], proposals: [] });
    }
  ));

test("createChatCompletionsAdapter throws on a non-OK HTTP response", () =>
  withMockFetch(
    () => jsonResponse(500, {}),
    async () => {
      const adapter = createChatCompletionsAdapter({ endpoint: "http://127.0.0.1:11434/v1/chat/completions", model: "mistral-small3.1:24b" });
      await assert.rejects(() => adapter({ actor, notes: "Ari saved the ferry." }), /HTTP 500/);
    }
  ));

test("createChatCompletionsAdapter throws when the model's content is not valid JSON", () =>
  withMockFetch(
    () => jsonResponse(200, { choices: [{ message: { content: "not json" } }] }),
    async () => {
      const adapter = createChatCompletionsAdapter({ endpoint: "http://127.0.0.1:11434/v1/chat/completions", model: "mistral-small3.1:24b" });
      await assert.rejects(() => adapter({ actor, notes: "Ari saved the ferry." }), /malformed JSON/);
    }
  ));

test("createChatCompletionsAdapter throws when the response has no chat-completion message content", () =>
  withMockFetch(
    () => jsonResponse(200, {}),
    async () => {
      const adapter = createChatCompletionsAdapter({ endpoint: "http://127.0.0.1:11434/v1/chat/completions", model: "mistral-small3.1:24b" });
      await assert.rejects(() => adapter({ actor, notes: "Ari saved the ferry." }), /did not return a JSON chat-completion message/);
    }
  ));

test("createChatCompletionsAdapter sends the model, schema-locked system prompt, headers, and Ollama's think:false option", () =>
  withMockFetch(
    () => jsonResponse(200, { choices: [{ message: { content: "{}" } }] }),
    async (calls) => {
      const adapter = createChatCompletionsAdapter({
        endpoint: "http://127.0.0.1:11434/v1/chat/completions",
        model: "mistral-small3.1:24b",
        getHeaders: () => ({ Authorization: "Bearer test-key" }),
        requestOptions: { think: false }
      });
      await adapter({ actor, notes: "Ari saved the ferry." });

      assert.equal(calls.length, 1);
      const { endpoint, init } = calls[0];
      assert.equal(endpoint, "http://127.0.0.1:11434/v1/chat/completions");
      assert.equal(init.method, "POST");
      assert.equal(init.headers["Content-Type"], "application/json");
      assert.equal(init.headers.Authorization, "Bearer test-key");

      const body = JSON.parse(init.body);
      assert.equal(body.model, "mistral-small3.1:24b");
      assert.equal(body.think, false);
      assert.equal(body.response_format.type, "json_object");
      assert.equal(body.messages[0].role, "system");
      assert.ok(body.messages[0].content.includes("Do not grant, approve, or claim to create any item."));
      assert.equal(body.messages[1].role, "user");
      assert.equal(JSON.parse(body.messages[1].content).notes, "Ari saved the ferry.");
    }
  ));
