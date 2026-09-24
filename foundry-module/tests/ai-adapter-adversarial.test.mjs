import assert from "node:assert/strict";
import test from "node:test";

import { GrandDesignApi } from "../scripts/api.js";
import { MODULE_ID, GROWTH_EVENTS_FLAG } from "../scripts/constants.js";

// A third held-out pass (2026-09-02), this time aimed at the boundary between the AI adapter and
// api.js#analyzeSessionNotes rather than at the local keyword matcher. The question: what happens
// when a configured AI provider answers successfully (no network error, no HTTP error) but with
// content that doesn't match what the code expects? This is the more likely failure mode for a real
// model than a dropped connection -- an LLM is far more likely to omit a key, invent an outcome
// value, or hallucinate a tag than to fail to respond at all -- and it turned out to be handled
// inconsistently: a malformed top-level shape crashed the whole call (losing the notes, the exact
// bug this module's history is about fixing, just triggered a different way), while individual bad
// events or tags inside an otherwise fine response silently discarded everything alongside them.
// Both are fixed in api.js#analyzeSessionNotes / session-notes.js#validateAdapterEvents; these tests
// pin the corrected behavior.

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

const NOTES = "She parried the guard's blade and drove him into the canal.";

test("an adapter that answers with the wrong top-level shape falls back to local analysis, not a crash", async () => {
  await withFoundryGlobals(async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor();
    // Exactly what a small local model does when it drifts off the requested schema: valid JSON,
    // wrong keys. No network error, no thrown exception from the adapter itself.
    api.setProposalAdapter(async () => ({ result: "done", notes: "processed" }));

    const result = await api.analyzeSessionNotes(actor, NOTES);

    assert.equal(result.source, "local-fallback", "a shapeless response must not be mistaken for a working AI path");
    assert.ok(result.adapterError, "the GM needs to know the AI path produced something unusable");
    assert.ok(result.events.length >= 1, "the notes must still be analyzed locally rather than lost");
    assert.ok(result.diagnostics, "the local path's diagnostics must come back with the fallback");
  });
});

test("one malformed event inside an otherwise good adapter response does not cost the rest", async () => {
  await withFoundryGlobals(async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor();
    api.setProposalAdapter(async () => ({
      events: [
        { summary: "", tags: [], outcome: "success" }, // missing a summary and tags entirely
        { summary: "Halvard forced the postern open.", tags: ["athletics"], outcome: "success" }
      ],
      proposals: []
    }));

    const result = await api.analyzeSessionNotes(actor, NOTES);

    assert.equal(result.source, "adapter", "the adapter mostly worked and should still be credited as such");
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].summary, "Halvard forced the postern open.");
    assert.equal(result.adapterSkippedEvents.length, 1, "the dropped event must be reported, not silently gone");
    assert.equal(actor.getFlag(MODULE_ID, GROWTH_EVENTS_FLAG).length, 1);
  });
});

test("a hallucinated tag on one event is stripped from that event rather than discarding it or the batch", async () => {
  await withFoundryGlobals(async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor();
    api.setProposalAdapter(async () => ({
      events: [
        // "melee" isn't in the taxonomy (the real tag is "martial") -- a plausible model synonym-swap.
        { summary: "Halvard struck the raider down.", tags: ["martial", "melee"], outcome: "success" }
      ],
      proposals: []
    }));

    const result = await api.analyzeSessionNotes(actor, NOTES);

    assert.equal(result.source, "adapter");
    assert.equal(result.events.length, 1, "the event survives -- it still has a valid tag alongside the bad one");
    assert.deepEqual(result.events[0].tags, ["martial"]);
    assert.equal(result.adapterRejectedTags.length, 1);
    assert.deepEqual(result.adapterRejectedTags[0].rejected, ["melee"]);
  });
});

// AI gateway v2 (2026-09-23, docs/ai-gateway-v2-contract.md): an unknown tag is no longer thrown
// away -- it becomes an emergent THEME, because "the model said something we have no tag for" is
// exactly how unanticipated activities (beekeeping, gambling) show up. The event is kept, carried by
// the theme, and the tag is still reported in adapterRejectedTags. With emergent themes switched
// off, the old behavior (drop the event) is preserved.
test("an event whose ONLY tag is unknown becomes an emergent-theme event (dropped only when themes are off)", async () => {
  await withFoundryGlobals(async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor();
    api.setProposalAdapter(async () => ({
      events: [{ summary: "Halvard did something clever.", tags: ["cleverness"], outcome: "success" }],
      proposals: []
    }));

    const result = await api.analyzeSessionNotes(actor, NOTES);

    assert.equal(result.events.length, 1);
    assert.deepEqual(result.events[0].tags, []);
    assert.deepEqual(result.events[0].themes, ["cleverness"]);
    assert.equal(result.adapterRejectedTags.length, 1);

    const offApi = new GrandDesignApi();
    offApi.setGatewayConfigProvider(() => ({ emergentThemes: false }));
    offApi.setProposalAdapter(async () => ({
      events: [{ summary: "Halvard did something clever.", tags: ["cleverness"], outcome: "success" }],
      proposals: []
    }));
    const offResult = await offApi.analyzeSessionNotes(createMockActor(), NOTES);
    assert.equal(offResult.events.length, 0);
    assert.equal(offResult.adapterRejectedTags.length, 1);
  });
});

test("a proposal with a fundamentally wrong shape is skipped and reported, not a batch failure", async () => {
  // Reversed 2026-09-23 by the AI gateway v2 contract: proposals are tolerant per proposal (the
  // gateway pipeline repairs them first). A malformed one lands in adapterSkippedProposals.
  await withFoundryGlobals(async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor();
    api.setProposalAdapter(async () => ({
      events: [],
      proposals: [{ kind: "skill", notEntry: { name: "x" }, evidence: [] }]
    }));

    const result = await api.analyzeSessionNotes(actor, NOTES);
    assert.equal(result.source, "adapter");
    assert.equal(result.adapterSkippedProposals.length, 1);
    assert.match(result.adapterSkippedProposals[0].errors.join(" "), /Invalid AI skill proposal/);
  });
});
