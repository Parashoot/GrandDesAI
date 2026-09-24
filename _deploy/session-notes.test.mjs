import assert from "node:assert/strict";
import test from "node:test";

import { analyzeSessionNotes, validateAdapterEvents } from "../scripts/session-notes.js";

test("local notes analyzer produces tagged successful events", () => {
  const events = analyzeSessionNotes(
    "Mera crossed the flooded canal and rescued a resident. She critically secured the flooded sluice gate with a rope."
  );

  assert.equal(events.length, 2);
  assert.deepEqual(events[0].tags.sort(), ["mobility", "support", "water"]);
  assert.equal(events[0].outcome, "success");
  assert.equal(events[1].outcome, "criticalSuccess");
});

// validateAdapterEvents() used to throw on the first structurally-invalid event, which meant one
// bad field anywhere in an AI adapter's response discarded every other event alongside it -- a
// held-out adversarial pass on the AI path (2026-09-02) identified this as the same failure mode
// already fixed for the local analyzer (one bad sentence used to zero out the whole note) wearing a
// different hat. It now separates valid events from invalid ones instead of aborting the batch; only
// a response with no recognizable shape at all (not an array, not `{ events: [...] }`) is still a
// hard failure, since api.js#analyzeSessionNotes falls back to the local analyzer for that case
// exactly as it does for a network failure.
test("a structurally invalid adapter event is skipped, not a reason to discard the whole batch", () => {
  const { events, skipped } = validateAdapterEvents({
    events: [
      { summary: "", tags: [], outcome: "failure" },
      { summary: "Ari saved the ferry.", tags: ["water", "support"], outcome: "success" }
    ]
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].summary, "Ari saved the ferry.");
  assert.equal(skipped.length, 1);
  assert.ok(skipped[0].errors.length, "the reason the event was skipped must be reported, not silently dropped");
});

test("a response with no recognizable event shape is still a hard failure", () => {
  assert.throws(() => validateAdapterEvents({ notEvents: "garbage" }));
  assert.throws(() => validateAdapterEvents("not even an object"));
});

test("adapter output must satisfy the same growth event contract", () => {
  const { events } = validateAdapterEvents([{ summary: "Ari saved the ferry.", tags: ["water", "support"], outcome: "success" }]);
  assert.equal(events.length, 1);
});

// --- Counter-leveling: a badly mismatched fight is detected from the notes text and carried onto
// the generated event as dangerGap, without requiring the GM/AI to set it explicitly. ------------

test("local notes analyzer detects a severely mismatched fight and tags the event with dangerGap: severe", () => {
  const events = analyzeSessionNotes("Mera was hopelessly outmatched but struck the beast anyway and won.");
  assert.equal(events.length, 1);
  assert.equal(events[0].dangerGap, "severe");
});

test("local notes analyzer detects a moderately mismatched fight and tags the event with dangerGap: moderate", () => {
  const events = analyzeSessionNotes("It was a tough fight but Mera struck the beast and won.");
  assert.equal(events.length, 1);
  assert.equal(events[0].dangerGap, "moderate");
});

test("local notes analyzer leaves dangerGap unset for an ordinary event with no power-gap language", () => {
  const events = analyzeSessionNotes("Mera crossed the flooded canal and rescued a resident.");
  assert.equal(events.length, 1);
  assert.equal("dangerGap" in events[0], false);
});

// --- AI provider failure must never cost the GM their notes ------------------------------------

import { GrandDesignApi } from "../scripts/api.js";
import { AiProviderUnreachableError, createChatCompletionsAdapter } from "../scripts/ai-gateway.js";
import { MODULE_ID, GROWTH_EVENTS_FLAG } from "../scripts/constants.js";

function createMockActor() {
  const flags = { [MODULE_ID]: {} };
  let itemCounter = 0;
  return {
    id: "mock-actor", name: "Mock Actor", documentName: "Actor",
    system: { skills: { acrobatics: { mod: 0 } } },
    items: { find: () => undefined, filter: () => [] },
    getFlag: (module, key) => flags[module]?.[key],
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) flags[MODULE_ID][path.split(".")[2]] = value;
      return this;
    },
    async createEmbeddedDocuments() { itemCounter += 1; return [{ id: `item-${itemCounter}`, getFlag: () => undefined }]; }
  };
}

async function withFoundryGlobals(run) {
  const [g, h] = [globalThis.game, globalThis.Hooks];
  globalThis.game = { user: { isGM: true }, system: { id: "pf2e" } };
  globalThis.Hooks = { callAll: () => {} };
  try { return await run(); } finally { globalThis.game = g; globalThis.Hooks = h; }
}

const NOTES = "She parried the guard's blade and drove him into the canal. Torv picked the lock on the door.";

test("an unreachable AI provider falls back to local analysis instead of losing the notes", async () => {
  await withFoundryGlobals(async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor();
    // Exactly what a dead Ollama does: fetch itself rejects, before any HTTP status exists.
    api.setProposalAdapter(async () => { throw new AiProviderUnreachableError("http://127.0.0.1:11434/v1/chat/completions", new TypeError("Failed to fetch")); });

    const result = await api.analyzeSessionNotes(actor, NOTES);

    assert.equal(result.source, "local-fallback", "the fallback must be distinguishable from a working AI path");
    assert.equal(result.adapterConfigured, true, "the adapter is still configured -- it just failed this call");
    assert.match(result.adapterError, /Could not reach the AI provider/);
    assert.ok(result.events.length >= 2, "the GM's notes were still analyzed and recorded");
    assert.ok(result.diagnostics, "the local path's diagnostics come back with the fallback");
    assert.equal(actor.getFlag(MODULE_ID, GROWTH_EVENTS_FLAG).length, result.events.length);
  });
});

test("a working adapter is still reported as the adapter, with no fallback fields", async () => {
  await withFoundryGlobals(async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor();
    api.setProposalAdapter(async () => ({ events: [{ summary: "Kesh held the gate.", tags: ["martial"], outcome: "success" }], proposals: [] }));

    const result = await api.analyzeSessionNotes(actor, NOTES);
    assert.equal(result.source, "adapter");
    assert.equal(result.adapterError, undefined);
    assert.equal(result.diagnostics, undefined, "diagnostics describe the local matcher, which did not run");
    assert.equal(result.events.length, 1);
  });
});

test("with no adapter configured the source is plain local, not a fallback", async () => {
  await withFoundryGlobals(async () => {
    const result = await new GrandDesignApi().analyzeSessionNotes(createMockActor(), NOTES);
    assert.equal(result.source, "local");
    assert.equal(result.adapterConfigured, false);
  });
});

test("AiProviderUnreachableError names the endpoint and every actionable cause", () => {
  const error = new AiProviderUnreachableError("http://127.0.0.1:11434/v1/chat/completions", new TypeError("Failed to fetch"));
  assert.match(error.message, /127\.0\.0\.1:11434/, "must name the host and port actually being dialed");
  assert.match(error.message, /no notes were lost/, "the GM's first worry is their typing");
  assert.match(error.message, /ollama serve/);
  assert.match(error.message, /OLLAMA_ORIGINS/, "CORS is the non-obvious failure and must be called out");
  assert.match(error.message, /AI Provider Setup/, "must point at where the endpoint is configured");
  assert.equal(error.cause.message, "Failed to fetch", "the original browser error stays attached for the console");
});

test("a transport failure is wrapped, while an HTTP error status keeps its own message", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    const adapter = createChatCompletionsAdapter({ endpoint: "http://localhost:11434/v1/chat/completions", model: "test" });
    await assert.rejects(() => adapter({ actor: createMockActor(), notes: "x" }), /Could not reach the AI provider/);

    globalThis.fetch = async () => ({ ok: false, status: 404 });
    await assert.rejects(() => adapter({ actor: createMockActor(), notes: "x" }), /returned HTTP 404/);
  } finally { globalThis.fetch = originalFetch; }
});
