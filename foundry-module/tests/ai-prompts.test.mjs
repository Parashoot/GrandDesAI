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

test("both system adapters report the character's own class for proposal naming", async () => {
  const { getSystemAdapter } = await import("../scripts/systems/index.js");
  const pf2e = getSystemAdapter("pf2e");
  const dnd5e = getSystemAdapter("dnd5e");
  assert.equal(pf2e.getCharacterClass({ class: { name: "Fighter" } }), "Fighter");
  assert.equal(pf2e.getCharacterClass({ items: { find: (fn) => [{ type: "feat", name: "x" }, { type: "class", name: "Rogue" }].find(fn) } }), "Rogue");
  assert.equal(pf2e.getCharacterClass({ items: { find: () => undefined } }), null);
  assert.equal(dnd5e.getCharacterClass({ classes: { wizard: { name: "Wizard", system: { levels: 5 } } } }), "Wizard");
  // Multiclass keeps levels so "Fighter 3 / Wizard 2" reads differently from a pure wizard.
  assert.equal(dnd5e.getCharacterClass({ classes: { fighter: { name: "Fighter", system: { levels: 3 } }, wizard: { name: "Wizard", system: { levels: 2 } } } }), "Fighter 3 / Wizard 2");
  assert.equal(dnd5e.getCharacterClass({}), null);
});

test("stage-2 payload carries systemClass and the naming rule forbids the personal name", () => {
  for (const systemId of ["pf2e", "dnd5e"]) {
    const withClass = systemId === "pf2e" ? { ...actor, class: { name: "Champion" } } : { ...actor, classes: { paladin: { name: "Paladin", system: { levels: 3 } } } };
    const messages = buildProposalMessages({ request: buildAiGatewayRequest(withClass, "notes", systemId), config, events });
    const payload = JSON.parse(messages[1].content);
    assert.equal(payload.actor.systemClass, systemId === "pf2e" ? "Champion" : "Paladin");
    assert.match(messages[0].content, /never from the character's personal name/);
  }
});

test("coerceEvent keeps a stated consequence instead of needing a second event", async () => {
  const { coerceEvent } = await import("../scripts/ai/normalize.js");
  const { event } = coerceEvent({ quote: "Erin ran the inn solo", summary: "Erin ran the inn alone.", consequence: "No guest was lost.", tags: ["leadership"], themes: ["innkeeping"], outcome: "success" });
  assert.equal(event.consequence, "No guest was lost.");
  // "result" stays an outcome alias (older models answer {result:"success"}), never a consequence.
  const legacy = coerceEvent({ summary: "Kesh kicked the door open.", tags: ["athletics"], result: "success" }).event;
  assert.equal(legacy.outcome, "success");
  assert.equal(legacy.consequence, undefined);
});

test("normalizeGrowthEvent keeps an event's consequence for the Growth dialog", async () => {
  const { normalizeGrowthEvent } = await import("../scripts/progression.js");
  const stored = normalizeGrowthEvent({ summary: "Erin ran the inn alone.", tags: ["leadership"], outcome: "success", consequence: "  No guest was lost.  " }, 0);
  assert.equal(stored.consequence, "No guest was lost.");
  assert.equal(normalizeGrowthEvent({ summary: "x", tags: ["craft"], outcome: "success" }, 1).consequence, undefined);
});

test("stage-2 payload carries each event's verbatim quote and consequence", () => {
  const withQuote = [{ ...events[0], quote: "Tovin broke the captured scout's will over three days", consequence: "We got the camp location." }];
  const payload = JSON.parse(buildProposalMessages({ request: buildAiGatewayRequest(actor, "notes", "pf2e"), config, events: withQuote })[1].content);
  assert.match(payload.newEvents[0].quote, /broke the captured scout's will/);
  assert.equal(payload.newEvents[0].consequence, "We got the camp location.");
});

test("stage-2 red check lists every vice, and disappears when the table disables red", async () => {
  const { VICE_TAGS } = await import("../scripts/vice-taxonomy.js");
  const request = buildAiGatewayRequest(actor, "notes", "dnd5e");
  const on = systemText(buildProposalMessages({ request, config: { ...config, allowRed: true }, events }));
  assert.match(on, /Red check, BEFORE any proposal: fill "redCheck"/);
  for (const vice of VICE_TAGS) assert.match(on, new RegExp(`${vice}: `));
  const off = systemText(buildProposalMessages({ request, config: { ...config, allowRed: false }, events }));
  assert.doesNotMatch(off, /Red check/);
});

test("the emergent-theme evidence threshold is waived only when the GM asked for suggestions", () => {
  const request = buildAiGatewayRequest(actor, "notes", "pf2e");
  assert.match(systemText(buildProposalMessages({ request, config, events })), /weighted evidence >= 3/);
  const eager = systemText(buildProposalMessages({ request, config, events, mustPropose: true }));
  assert.doesNotMatch(eager, /weighted evidence >= 3/);
  assert.match(eager, /a single event is enough evidence; keep such a first Skill at tier 1/);
});

test("proposalSchemaCapped caps the array and keeps the OpenAI schema name", async () => {
  const { proposalSchemaCapped, schemaName, PROPOSAL_SCHEMA } = await import("../scripts/ai/schemas.js");
  const capped = proposalSchemaCapped(2);
  assert.equal(capped.properties.proposals.maxItems, 2);
  assert.equal(proposalSchemaCapped(undefined).properties.proposals.maxItems, 3);
  assert.equal(schemaName(capped), "grand_design_proposals");
  // The symbol tag must never reach the wire.
  assert.equal(JSON.stringify(capped).includes("cappedOf"), false);
  assert.equal(PROPOSAL_SCHEMA.properties.proposals.maxItems, undefined);
});

test("dnd5e rules vocabulary lists the real 5e skills and treats crafts as tool proficiencies", async () => {
  const { RULES_VOCABULARY } = await import("../scripts/systems/dnd5e-adapter.js");
  assert.match(RULES_VOCABULARY, /Sleight of Hand/);
  assert.match(RULES_VOCABULARY, /Cook's Utensils/);
  assert.match(RULES_VOCABULARY, /never a "Craft" skill/);
});
