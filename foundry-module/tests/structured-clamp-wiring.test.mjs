// The model's structured numbers are clamped to tier + character level when proposals are accepted
// (api._validateModelProposals); a GM edit through updateProposal is reported, never enforced.
import assert from "node:assert/strict";
import test from "node:test";

import { GrandDesignApi } from "../scripts/api.js";

const flags = {};
const actorFor = (systemId) => ({
  id: `clamp-${systemId}`,
  name: "Kestra",
  type: "character",
  system: systemId === "dnd5e" ? { details: { level: 3 }, attributes: { prof: 2 } } : { details: { level: { value: 3 } } },
  items: { find: () => undefined, filter: () => [] },
  getFlag: (_m, key) => flags[key]
});

const proposal = {
  kind: "skill",
  evidence: [],
  entry: {
    name: "Fletch: Braced Stance",
    tier: 1,
    description: "Brace behind your bow.",
    metadata: { tags: ["defense"] },
    system_equivalent: "General feat",
    gameItem: { kind: "passive" },
    mechanics: { effect: "You brace.", frequency: { max: 1, per: "unlimited" }, duration: "ongoing", structured: { modifiers: [{ value: 3, type: "circumstance", selector: "ac" }] } }
  }
};

for (const systemId of ["pf2e", "dnd5e"]) {
  test(`[${systemId}] AI structured modifiers are clamped and the clamp is recorded`, () => {
    globalThis.game = { system: { id: systemId }, user: { isGM: true }, settings: { get: () => undefined } };
    const api = new GrandDesignApi();
    const { accepted, skipped } = api._validateModelProposals([structuredClone(proposal)], actorFor(systemId), {});
    assert.equal(skipped.length, 0, JSON.stringify(skipped));
    const mechanics = accepted[0].entry.mechanics;
    assert.equal(mechanics.structured.modifiers[0].value, 1, "tier 1 caps the bonus at +1");
    assert.equal(mechanics.clamps[0].from, 3);
    assert.equal(mechanics.clamps[0].to, 1);
  });
}
