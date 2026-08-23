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
