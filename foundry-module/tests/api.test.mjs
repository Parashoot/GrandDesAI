import assert from "node:assert/strict";
import test from "node:test";

import { GrandDesignApi } from "../scripts/api.js";
import { MODULE_ID, GROWTH_EVENTS_FLAG, GROWTH_PROPOSALS_FLAG, LEVEL_PROGRESSION_FLAG, REGISTRY_FLAG } from "../scripts/constants.js";

function createMockActor() {
  const flags = { [MODULE_ID]: {} };
  return {
    id: "mock-actor",
    name: "Mock Actor",
    documentName: "Actor",
    system: { skills: { acrobatics: { mod: 8 } } },
    items: { find: () => undefined, filter: () => [] },
    getFlag(module, key) {
      return flags[module]?.[key];
    },
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) {
        const [, , key] = path.split(".");
        flags[MODULE_ID][key] = value;
      }
      return this;
    },
    async createEmbeddedDocuments() {
      return [{ id: "mock-item", getFlag: () => undefined }];
    }
  };
}

test("a still-pending proposal keeps up-to-date evidence as more matching events are recorded", async () => {
  const originalGame = globalThis.game;
  const originalHooks = globalThis.Hooks;
  globalThis.game = { user: { isGM: true }, system: { id: "pf2e" } };
  globalThis.Hooks = { callAll: () => {} };

  try {
    const api = new GrandDesignApi();
    const actor = createMockActor();

    const events = [
      { summary: "Mera crossed a flooded rope line to rescue a trapped resident.", tags: ["mobility", "water"], outcome: "success" },
      { summary: "Mera carried a pressure valve through the rising canal.", tags: ["mobility", "water"], outcome: "criticalSuccess" },
      { summary: "Mera navigated a submerged lock gate to secure an escape route.", tags: ["mobility", "water"], outcome: "success" }
    ];
    let result;
    for (const event of events) result = await api.recordGrowthEvent(actor, event);
    const firstProposal = result.proposals.find((proposal) => proposal.id === "proposal:canal-step");
    assert.equal(firstProposal.evidence.length, 3);

    result = await api.recordGrowthEvent(actor, {
      summary: "Mera guided a family through the flooded canal to safety.",
      tags: ["mobility", "water", "support"],
      outcome: "success"
    });
    const updatedProposal = result.proposals.find((proposal) => proposal.id === "proposal:canal-step");
    assert.equal(updatedProposal.status, "pending");
    assert.equal(updatedProposal.evidence.length, 4);
  } finally {
    globalThis.game = originalGame;
    globalThis.Hooks = originalHooks;
  }
});

function emberStepSkillEntry() {
  return {
    name: "Ember Step",
    tier: 2,
    system_equivalent: "Reskinned movement Class Feat",
    metadata: {
      tags: ["fire", "mobility"],
      lineage: { operation: "origin", sources: [], rationale: "Ari learned to cross hot canal grates without slowing down." }
    },
    gameItem: { kind: "action" },
    mechanics: {
      effect: "Stride up to half your Speed. On a success, ignore difficult terrain from hot metal or shallow water during that movement.",
      duration: "instant",
      frequency: { max: 1, per: "round" },
      actions: 1,
      roll: { kind: "Acrobatics check", formula: "1d20+8", dc: 18 }
    }
  };
}

// End-to-end regression guard for the analyzeSessionNotes -> configured AI adapter -> proposal
// pipeline. It exercises the exact shape a real Ollama/OpenAI-compatible reply must have per
// the prompt in ai-gateway.js's buildAiGatewayRequest (kind + entry), with no live network call
// or Foundry server involved -- the adapter here is a plain stub standing in for
// createChatCompletionsAdapter's parsed return value.
test("analyzeSessionNotes accepts a schema-shaped AI-gateway proposal ({kind, entry}) and records it pending", async () => {
  const originalGame = globalThis.game;
  const originalHooks = globalThis.Hooks;
  globalThis.game = { user: { isGM: true }, system: { id: "pf2e" } };
  globalThis.Hooks = { callAll: () => {} };

  try {
    const api = new GrandDesignApi();
    api.setProposalAdapter(async () => ({
      events: [],
      proposals: [{ kind: "skill", entry: emberStepSkillEntry(), evidence: ["Session note analysis"] }]
    }));
    const actor = createMockActor();

    const result = await api.analyzeSessionNotes(actor, "Ari dashed across the hot canal grates to reach the sluice gate.");

    assert.equal(result.source, "adapter");
    assert.equal(result.proposals.length, 1);
    const [proposal] = result.proposals;
    assert.equal(proposal.status, "pending");
    assert.equal(proposal.kind, "skill");
    assert.equal(proposal.entry.name, "Ember Step");
    assert.equal(proposal.source, "ai-gateway");
  } finally {
    globalThis.game = originalGame;
    globalThis.Hooks = originalHooks;
  }
});

// The mirror-image case: if the adapter returns the OLD, incorrect shape ({kind, skillEntry})
// that the prompt used to document, GrandDesignApi must reject it clearly rather than silently
// dropping the proposal -- this is what would have happened against a real, schema-compliant
// Ollama reply before the prompt in ai-gateway.js was fixed to say "entry".
test("analyzeSessionNotes rejects a {kind, skillEntry} proposal shape with a clear error", async () => {
  const originalGame = globalThis.game;
  const originalHooks = globalThis.Hooks;
  globalThis.game = { user: { isGM: true }, system: { id: "pf2e" } };
  globalThis.Hooks = { callAll: () => {} };

  try {
    const api = new GrandDesignApi();
    api.setProposalAdapter(async () => ({
      events: [],
      proposals: [{ kind: "skill", skillEntry: emberStepSkillEntry(), evidence: ["Session note analysis"] }]
    }));
    const actor = createMockActor();

    await assert.rejects(
      () => api.analyzeSessionNotes(actor, "Ari dashed across the hot canal grates to reach the sluice gate."),
      /Invalid AI skill proposal/
    );
  } finally {
    globalThis.game = originalGame;
    globalThis.Hooks = originalHooks;
  }
});
