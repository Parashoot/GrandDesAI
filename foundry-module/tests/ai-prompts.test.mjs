import test from "node:test";
import assert from "node:assert/strict";
import { buildProposalMessages, buildExtractionMessages } from "../scripts/ai/prompts.js";
import { normalizeGatewayConfig } from "../scripts/ai/gateway-config.js";
import { buildAiGatewayRequest } from "../scripts/ai-gateway.js";

const actor = {
  name: "Kellin",
  system: { details: { level: { value: 3 } } },
  getFlag: (_module, flag) => (flag === "levelProgression" ? { level: 1, grantAllowances: 0 } : { skills: {} })
};
const events = [{ summary: "Kellin built a pulley rig.", tags: ["craft"], themes: ["rigging"], outcome: "success" }];
const config = normalizeGatewayConfig({});
const systemText = (messages) => messages[0].content;

test("stage-2 prompt only demands a proposal when mustPropose is set", () => {
  const request = buildAiGatewayRequest(actor, "notes", "pf2e");
  const lazy = systemText(buildProposalMessages({ request, config, events }));
  assert.match(lazy, /Return \{"proposals":\[\]\} when it does not/);
  assert.doesNotMatch(lazy, /propose at least 1/);

  // "always" mode / a waiting grant allowance: an empty answer is useless, so the prompt says so.
  const eager = systemText(buildProposalMessages({ request, config, events, mustPropose: true }));
  assert.match(eager, /propose at least 1 and at most 3 proposals/);
  assert.match(eager, /only when there are no events at all/);
});

test("stage-2 prompt quotes the game system's own rules vocabulary", () => {
  const pf2e = systemText(buildProposalMessages({ request: buildAiGatewayRequest(actor, "notes", "pf2e"), config, events }));
  const dnd5e = systemText(buildProposalMessages({ request: buildAiGatewayRequest(actor, "notes", "dnd5e"), config, events }));
  assert.match(pf2e, /Rules vocabulary[^\n]*Pathfinder 2e terms/);
  assert.match(dnd5e, /Rules vocabulary[^\n]*D&D 5e \(2024\) terms/);
  // The 5e line explicitly bans the Pathfinder wording the shared examples use.
  assert.match(dnd5e, /Never use Pathfinder terms/);
  assert.notEqual(pf2e, dnd5e);
});

test("stage-1 prompt folds consequences into their action and rejects out-of-character lines", () => {
  const text = systemText(buildExtractionMessages({ notesChunk: "x", request: {}, config }));
  assert.match(text, /An event INCLUDES its result/);
  assert.match(text, /Habitual or ongoing actions count/);
  assert.match(text, /reminders, notes-to-self, shopping lists/);
  assert.match(text, /criticalSuccess ONLY for nat 20/);
  // The few-shot that demonstrates result-folding: one failure event, not "swung" + "got knocked flat".
  assert.match(text, /"quote":"Orla swung at the troll and got knocked flat"/);
});
