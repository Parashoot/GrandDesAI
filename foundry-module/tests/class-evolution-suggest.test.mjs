import assert from "node:assert/strict";
import test from "node:test";

import { buildProposalMessages } from "../scripts/ai/prompts.js";
import { buildAiGatewayRequest } from "../scripts/ai-gateway.js";
import { normalizeGatewayConfig } from "../scripts/ai/gateway-config.js";
import { makeHarnessActor } from "../tools/nlp-scale/lib.mjs";

// A GM whose character reached GD level 50 and clicked "Suggest proposals" got only Skills (2 of 2
// real runs): the prompt allowed a Class but never asked for one.
for (const systemId of ["dnd5e", "pf2e"]) {
  test(`[${systemId}] Suggest at a Class-evolution level asks for a Class first; otherwise skills-only or optional`, () => {
    const config = normalizeGatewayConfig({});
    const request = buildAiGatewayRequest(makeHarnessActor(systemId, { gdLevel: 50 }), "x", systemId);
    assert.equal(request.actor.grandDesign.classEvolutionAvailable, true);
    const text = (opts) => buildProposalMessages({ request, config, events: [], ...opts })[0].content;
    assert.match(text({ allowClass: true, mustPropose: true }), /FIRST proposal MUST be kind "class"/);
    assert.doesNotMatch(text({ allowClass: true, mustPropose: false }), /MUST be kind "class"/);
    assert.match(text({ allowClass: false, mustPropose: true }), /NOT available right now/);
  });
}
