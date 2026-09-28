// Regression tests for board 0cd50d30, 649aeb9f, 40d30e3d: three ember-road s2 events the gateway
// dropped or merged away (session notes and root cause in
// foundry-module/playtests/ember-road/sessions/02/notes.md and docs/ai-gateway-v2-contract.md,
// 2026-09-28 entry). No network: every model reply is scripted.
import assert from "node:assert/strict";
import test from "node:test";

import { mergeFollowUpEvents, runGatewayPipeline } from "../scripts/ai/pipeline.js";
import { buildExtractionMessages, BUILTIN_EXTRACTION_EXAMPLES } from "../scripts/ai/prompts.js";
import { buildAiGatewayRequest } from "../scripts/ai-gateway.js";
import { makeHarnessActor } from "../tools/nlp-scale/lib.mjs";

function scriptedTransport(replies) {
  const calls = [];
  return {
    calls,
    info: { model: "stub-model", provider: "ollama" },
    async chat(args) {
      calls.push({ ...args, messages: args.messages.map((m) => ({ ...m })) });
      let reply = replies.length > 1 ? replies.shift() : replies[0];
      if (typeof reply === "function") reply = reply(args, calls.length);
      if (reply instanceof Error) throw reply;
      return { content: typeof reply === "string" ? reply : JSON.stringify(reply), ms: 1, truncated: false };
    }
  };
}

function request(notes, { systemId = "dnd5e" } = {}) {
  return buildAiGatewayRequest(makeHarnessActor(systemId), notes, systemId);
}

const ev = (summary, tags, outcome = "success", extra = {}) => ({ quote: summary, summary, actorName: "Maren", tags, themes: [], outcome, dangerGap: "none", ...extra });

// ---- 0cd50d30: a same-actor "then Y" follow-up must never fold into the event before it ---------

test("mergeFollowUpEvents: a 'then' follow-up is kept separate even when the model flags continuesPrevious", () => {
  // This is exactly the shape that lost Maren's Thorn Lash: the model correctly ran Entangle and
  // Thorn Lash as two events, but flagged Thorn Lash continuesPrevious:true anyway, and the old
  // NEW_OCCASION regex did not treat "then" as a new-occasion marker, so it folded into Entangle
  // and vanished as a distinct event (survived only inside Entangle's consequence/quote).
  const entangle = { summary: "Maren cast Entangle on the thralls.", tags: ["primal"], themes: ["entangle"], outcome: "failure", quote: "maren entangle only got 1 of 4", actorName: "Maren" };
  const thornLash = { summary: "Maren used Thorn Lash to pin the thrall going for the wagon.", tags: ["primal"], themes: ["thorn-lash"], outcome: "success", quote: "then Thorn Lash on the one going for the wagon, pinned it", actorName: "Maren", continuesPrevious: true };
  const { events, merged } = mergeFollowUpEvents([entangle, thornLash]);
  assert.equal(merged, 0, "a 'then' follow-up must not be counted as merged");
  assert.equal(events.length, 2, "Thorn Lash must survive as its own event");
  assert.equal(events[1].summary, "Maren used Thorn Lash to pin the thrall going for the wagon.");
  assert.equal(events[1].outcome, "success");

  // Sanity: a genuine payoff with no "then" (or other new-occasion marker) still folds.
  const inn = { summary: "Erin ran the inn alone all week.", tags: ["leadership"], themes: ["innkeeping"], outcome: "success", quote: "Erin ran the inn solo", actorName: "Erin" };
  const payoff = { summary: "Erin did not lose a single guest.", tags: ["diplomacy"], themes: ["customer-service"], outcome: "success", quote: "Didn't lose a single guest.", continuesPrevious: true };
  assert.equal(mergeFollowUpEvents([inn, payoff]).merged, 1);
});

test("pipeline end to end: a scripted 'then'-joined follow-up stays a separate event after coercion", async () => {
  const answer = {
    events: [
      ev("Maren cast Entangle on the thralls.", ["primal"], "failure", { quote: "maren entangle only got 1 of 4" }),
      { ...ev("Maren used Thorn Lash to pin the thrall.", ["primal"], "success", { quote: "then Thorn Lash on the one going for the wagon, pinned it" }), continuesPrevious: true },
      ev("Wick killed the pinned thrall.", ["martial"], "success", { quote: "wick finished it off", actorName: "Wick" })
    ]
  };
  const out = await runGatewayPipeline({ transport: scriptedTransport([answer]), request: request("irrelevant"), config: { proposalMode: "never" } });
  assert.equal(out.events.length, 3, "Entangle, Thorn Lash and the kill must all survive as separate events");
  const summaries = out.events.map((e) => e.summary);
  assert.ok(summaries.some((s) => /Thorn Lash/.test(s)), "Thorn Lash must not be folded into Entangle");
  const thornLash = out.events.find((e) => /Thorn Lash/.test(e.summary));
  assert.equal(thornLash.outcome, "success");
});

// ---- 649aeb9f: two named spells in one comma list, only the last has a stated result -------------

test("prompts: a new few-shot teaches splitting a comma list of named abilities into separate events", () => {
  // Guards the actual fix (a prompt-only lever for this bug, since stage 1 emitted one merged
  // event directly -- nothing for the deterministic pipeline pass to fold). Checks the example is
  // wired into the built extraction prompt, not just present in the source array.
  const multiAbility = BUILTIN_EXTRACTION_EXAMPLES.find((ex) => /Mage Armor/.test(ex.notes));
  assert.ok(multiAbility, "a comma-list-of-abilities few-shot must exist");
  assert.equal(multiAbility.events.length, 2, "Mage Armor and Fireball must be two events, not one");
  assert.equal(multiAbility.events[0].outcome, "success", "the ability with no stated result defaults to success");
  assert.equal(multiAbility.events[1].outcome, "failure");

  const messages = buildExtractionMessages({ notesChunk: "x", request: {}, config: { outputLanguage: "en" } });
  const system = messages[0].content;
  assert.match(system, /Mage Armor/);
  assert.match(system, /Fireball/);
});

// ---- 40d30e3d: an elliptical, implied-verb activity is still that character's event --------------

test("prompts: a new few-shot teaches an implied-verb evaluative clause is still an event", () => {
  const ellipsis = BUILTIN_EXTRACTION_EXAMPLES.find((ex) => /Stew with Bael/.test(ex.notes));
  assert.ok(ellipsis, "an implied-verb downtime activity few-shot must exist");
  const stewEvent = ellipsis.events.find((e) => /stew/i.test(e.summary));
  assert.ok(stewEvent, "the stew activity must be its own event, not dropped");
  assert.equal(stewEvent.outcome, "success");
  assert.equal(stewEvent.actorName, "Nessa", "the actor carries over from the earlier sentence");

  const messages = buildExtractionMessages({ notesChunk: "x", request: {}, config: { outputLanguage: "en" } });
  assert.match(messages[0].content, /Stew with Bael/);
});

// ---- guard against the regex fix being too broad -------------------------------------------------

test("marksNewOccasion via mergeFollowUpEvents: 'then' inside a genuine same-clause elaboration is rare enough that unrelated merges still work", () => {
  // Two unrelated activities (no shared quote/summary connective at all) still merge on a plain
  // model-flagged follow-up that names no new occasion.
  const hives = { summary: "Maren moved the hives.", tags: [], themes: ["beekeeping"], outcome: "success", actorName: "Maren" };
  const honey = { summary: "Maren harvested the honey from them.", tags: [], themes: ["beekeeping"], outcome: "success", continuesPrevious: true, actorName: "Maren" };
  assert.equal(mergeFollowUpEvents([hives, honey]).merged, 1);
});
