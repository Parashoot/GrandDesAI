import assert from "node:assert/strict";
import test from "node:test";

import { GrandDesignApi, buildSuggestionNotes } from "../scripts/api.js";
import { createGatewayAdapter } from "../scripts/ai-gateway.js";
import { MODULE_ID } from "../scripts/constants.js";
import { buildEmergentSkillEntry } from "../scripts/emergent-themes.js";
import { generateCapstoneProposal, generateSkillProposals } from "../scripts/progression.js";
import {
  attributeEventsToActor,
  classifyActorName,
  proposalCitesOnlyOthers,
  speakerSegments
} from "../scripts/session-notes.js";
import { validateSkillEntry } from "../scripts/validator.js";

// Regression tests for playtest ember-road session 1 (board 137fb08b, 92539102, ea4012f6):
//  - party-wide notes analysed per PC credited every PC with every event,
//  - a dnd5e PC got a PF2e-worded ("Treat Wounds") template proposal with no source,
//  - after a rest there was no way to ask the AI for proposals to spend grant allowances on.
// Every API-level test runs on BOTH supported systems.

const SYSTEMS = ["pf2e", "dnd5e"];

const PARTY_NOTES = `session 1 recap (pasted from the group chat)

Brakka: Held the bridge, troll ran off, kept the goblins in line till the watch took them.

Wick: bro rode an ox into a troll fight, lost my dagger to the river

Maren: healed brakka back up, then patched up the surrendered goblins anyway bc soft heart. got 2nd place in the bake-off with a lavender honey loaf

Tovin: Tovin's night: torched a troll, lost my pit bet

GM: the troll was WAY out of their league and they still drove it off.`;

const ev = (summary, tags, extra = {}) => ({ summary, tags, themes: [], outcome: "success", quote: summary, ...extra });

// What the model returned in the playtest, give or take: some events name their actor, some don't.
function partyEvents() {
  return [
    ev("Brakka held the bridge against a troll.", ["defense", "leadership"], { actorName: "Brakka", quote: "Held the bridge, troll ran off" }),
    ev("Wick rode an ox into a troll fight.", ["mobility"], { actorName: "Wick", quote: "bro rode an ox into a troll fight" }),
    ev("Wick lost his dagger to the river.", ["water"], { quote: "lost my dagger to the river", outcome: "failure" }), // no actorName
    ev("Maren healed Brakka.", ["medicine", "support"], { actorName: "maren", quote: "healed brakka back up" }),
    ev("Maren patched up the surrendered goblins.", ["medicine", "support"], { actorName: "Maren", quote: "patched up the surrendered goblins anyway" }),
    ev("Maren placed second in a bake-off.", ["craft"], { actorName: "Maren", themes: ["baking"], quote: "got 2nd place in the bake-off" }),
    ev("Tovin torched a troll.", ["fire", "spellcasting"], { actorName: "Tovin", quote: "torched a troll" }),
    ev("Tovin lost a pit bet.", ["deception"], { quote: "lost my pit bet", outcome: "failure" }), // no actorName
    ev("The party drove off a troll far above their level.", ["martial"], { actorName: "the party", dangerGap: "severe", quote: "they still drove it off" })
  ];
}

function createMockActor(systemId, name) {
  const flags = { [MODULE_ID]: {} };
  return {
    id: `mock-${systemId}-${name}`,
    name,
    documentName: "Actor",
    type: "character",
    system: systemId === "dnd5e"
      ? { details: { level: 3 }, skills: { acr: { mod: 3, total: 5 } }, attributes: { prof: 2 } }
      : { details: { level: { value: 3 } }, skills: { acrobatics: { mod: 7 } } },
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
    }
  };
}

async function withFoundry(systemId, fn) {
  const originalGame = globalThis.game;
  const originalHooks = globalThis.Hooks;
  const originalWarn = console.warn;
  globalThis.game = { user: { isGM: true }, system: { id: systemId } };
  globalThis.Hooks = { callAll: () => {} };
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    globalThis.game = originalGame;
    globalThis.Hooks = originalHooks;
    console.warn = originalWarn;
  }
}

// PF2e-only rules vocabulary that must never reach a dnd5e sheet (see dnd5e-adapter.js#RULES_VOCABULARY).
const PF2E_TERMS = /treat wounds|circumstance bonus|\bstrikes?\b|\bstride\b|daily preparations|follow the expert|avoid getting lost|resistance \d|\bconcealed\b|per encounter|\brank \d/i;

function entryText(entry) {
  const m = entry.mechanics ?? {};
  return [entry.system_equivalent, m.effect, m.duration, m.trigger, m.roll?.kind].filter(Boolean).join(" | ");
}

// Enough evidence for EVERY template (each tag x3) so every template fires.
function everyTemplateEvents() {
  const tags = ["mobility", "water", "craft", "support", "martial", "precision", "fire", "spellcasting", "medicine", "stealth", "leadership", "defense", "survival", "nature", "cold", "electricity"];
  return tags.flatMap((tag) => [1, 2, 3].map((n) => ({ id: `e-${tag}-${n}`, summary: `${tag} ${n}`, tags: [tag], outcome: "success" })));
}

// ---------------------------------------------------------------------------------------------
// Name matching

test("classifyActorName: tolerant, case-insensitive, token-based; groups belong to everyone", () => {
  assert.equal(classifyActorName("Kellin", ["GD AI Test - Kellin the Undercutter"]), "self");
  assert.equal(classifyActorName("GD AI Test - Kellin the Undercutter", ["Kellin"]), "self");
  assert.equal(classifyActorName("brakka", ["Brakka"]), "self");
  assert.equal(classifyActorName("Brakka's", ["Brakka"]), "self");
  assert.equal(classifyActorName("Maren and Tovin", ["Tovin"]), "self");
  assert.equal(classifyActorName("Luz y Tovin", ["Luz"]), "self");
  assert.equal(classifyActorName("Maren", ["Tovin"]), "other");
  assert.equal(classifyActorName("the Undercutter", ["Maren"]), "other");
  for (const group of ["the party", "party", "Everyone", "we", "us", "the whole party", "GM"]) {
    assert.equal(classifyActorName(group, ["Tovin"]), "group", group);
  }
  assert.equal(classifyActorName("", ["Tovin"]), "unknown");
  assert.equal(classifyActorName(undefined, ["Tovin"]), "unknown");
  // A short common token must not match by prefix ("Al" is not "Aldric").
  assert.equal(classifyActorName("Al", ["Aldric"]), "other");
});

test("speakerSegments reads chat-style party recaps and ignores topic headings", () => {
  const labels = speakerSegments(PARTY_NOTES).map((segment) => segment.label);
  assert.deepEqual(labels, [null, "Brakka", "Wick", "Maren", "Tovin", "GM"]);
  assert.ok(speakerSegments("Loot: 40 gp\nDay 3: we reached the pass\nNote: Kesh owes 5 gp").every((s) => s.label === null));
});

test("attributeEventsToActor keeps own, unnamed and group events; infers unnamed ones from speaker labels", () => {
  const { kept, attributedToOthers } = attributeEventsToActor(partyEvents(), ["Tovin"], { notes: PARTY_NOTES });
  assert.deepEqual(kept.map((event) => event.summary), [
    "Tovin torched a troll.",
    "Tovin lost a pit bet.",
    "The party drove off a troll far above their level."
  ]);
  // "lost my pit bet" had no actorName -- it was recovered from the "Tovin:" line.
  assert.equal(kept[1].actorName, "Tovin");
  assert.equal(attributedToOthers.length, 6);
  assert.ok(attributedToOthers.some((entry) => entry.actorName === "Maren" && /bake-off/.test(entry.summary)));
  // "lost my dagger" had no actorName either; it is inferred as Wick's, not Tovin's.
  assert.ok(attributedToOthers.some((entry) => entry.actorName === "Wick" && /dagger/.test(entry.summary)));
});

test("single-character notes with no actorName keep every event", () => {
  const events = [ev("Picked the lock.", ["thievery"]), ev("Talked the guard down.", ["diplomacy"])];
  const { kept, attributedToOthers } = attributeEventsToActor(events, ["Kesh"], { notes: "Picked the lock. Talked the guard down." });
  assert.equal(kept.length, 2);
  assert.equal(attributedToOthers.length, 0);
  // A lone topic-ish label that is not this actor does not turn the log into someone else's.
  const lone = attributeEventsToActor([ev("Kesh picked the lock.", ["thievery"], { quote: "picked the lock" })], ["Kesh"], { notes: "Warehouse: picked the lock" });
  assert.equal(lone.kept.length, 1);
});

test("proposalCitesOnlyOthers: only when every evidence line points at another character", () => {
  const { kept, dropped } = attributeEventsToActor(partyEvents(), ["Wick"], { notes: PARTY_NOTES });
  const ctx = { actorNames: ["Wick"], ownEvents: kept, otherEvents: dropped };
  assert.equal(proposalCitesOnlyOthers({ evidence: ["Maren healed Brakka.", "Maren patched up the surrendered goblins."] }, ctx), true);
  assert.equal(proposalCitesOnlyOthers({ evidence: ["Maren healed Brakka.", "Wick rode an ox into a troll fight."] }, ctx), false);
  assert.equal(proposalCitesOnlyOthers({ evidence: ["Session note analysis"] }, ctx), false);
  assert.equal(proposalCitesOnlyOthers({ evidence: [] }, ctx), false);
});

// ---------------------------------------------------------------------------------------------
// analyzeSessionNotes, both systems

for (const systemId of SYSTEMS) {
  test(`[${systemId}] party notes analysed per PC credit each PC only with their own (and group) events`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      api.setProposalAdapter(async () => ({ events: partyEvents(), proposals: [] }));
      const counts = {};
      for (const name of ["Brakka", "Wick", "Maren", "Tovin"]) {
        const actor = createMockActor(systemId, name);
        const result = await api.analyzeSessionNotes(actor, PARTY_NOTES);
        assert.equal(result.source, "adapter");
        counts[name] = result.events.length;
        for (const event of result.events) {
          assert.ok(!event.actorName || ["the party", name.toLowerCase()].includes(event.actorName.toLowerCase()), `${name} got ${event.summary}`);
        }
        assert.equal(result.events.length + result.attributedToOthers.length, partyEvents().length);
        const last = api.getLastAnalysis(actor);
        assert.equal(last.diagnostics.attributedToOthers, result.attributedToOthers.length);
        assert.equal(last.attributedToOthers.length, result.attributedToOthers.length);
        assert.equal(api.getGrowth(actor).events.length, result.events.length);
      }
      // own events + the one party-wide event
      assert.deepEqual(counts, { Brakka: 2, Wick: 3, Maren: 4, Tovin: 3 });
    });
  });

  test(`[${systemId}] Wick gets no Field Triage from Maren's healing, and a model proposal built on others' deeds is skipped`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      const healerProposal = {
        kind: "skill",
        evidence: ["Maren healed Brakka.", "Maren patched up the surrendered goblins."],
        entry: {
          name: "Soft-Hearted Mender",
          tier: 1,
          system_equivalent: "Skill feat",
          gameItem: { kind: "passive" },
          mechanics: { effect: "Healing you provide restores 1 extra hit point.", duration: "while active", frequency: { max: 1, per: "unlimited" } },
          metadata: { tags: ["medicine"], lineage: { operation: "origin", sources: [], rationale: "Healed people." } }
        }
      };
      // Plenty of medicine/support evidence -- all of it Maren's.
      const events = [...partyEvents(), ...[1, 2, 3].map((n) => ev(`Maren bandaged villager ${n}.`, ["medicine", "support"], { actorName: "Maren", quote: `bandaged villager ${n}` }))];
      api.setProposalAdapter(async () => ({ events, proposals: [healerProposal] }));
      const wick = createMockActor(systemId, "Wick");
      const result = await api.analyzeSessionNotes(wick, PARTY_NOTES);
      assert.ok(!result.proposals.some((proposal) => proposal.id === "proposal:field-triage"));
      assert.ok(!result.proposals.some((proposal) => proposal.entry.name === "Soft-Hearted Mender"));
      assert.ok(result.adapterSkippedProposals.some((entry) => entry.reason === "attributed-to-others"));

      // Maren herself does get both.
      const maren = createMockActor(systemId, "Maren");
      const hers = await api.analyzeSessionNotes(maren, PARTY_NOTES);
      const triage = hers.proposals.find((proposal) => proposal.id === "proposal:field-triage");
      assert.ok(triage, "Maren earned Field Triage");
      assert.equal(triage.source, "template");
      assert.equal(triage.systemId, systemId);
      assert.ok(hers.proposals.some((proposal) => proposal.entry.name === "Soft-Hearted Mender"));
      if (systemId === "dnd5e") {
        assert.doesNotMatch(entryText(triage.entry), PF2E_TERMS);
        assert.equal(triage.entry.mechanics.roll.formula, "1d20+3"); // dnd5e "acr" modifier, not a flat +0
      } else {
        assert.match(triage.entry.mechanics.effect, /Treat Wounds/);
        assert.equal(triage.entry.mechanics.roll.formula, "1d20+7");
      }
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Template / capstone / emergent wording per system

test("dnd5e template proposals contain no PF2e terms, validate, and carry source 'template'", () => {
  const proposals = generateSkillProposals(everyTemplateEvents(), { skills: {} }, 4, [], {}, { systemId: "dnd5e" });
  assert.equal(proposals.length, 11, "every template fired");
  for (const proposal of proposals) {
    assert.equal(proposal.source, "template");
    assert.equal(proposal.systemId, "dnd5e");
    assert.doesNotMatch(entryText(proposal.entry), PF2E_TERMS, proposal.id);
    assert.deepEqual(validateSkillEntry(proposal.entry).errors, [], proposal.id);
  }
});

test("pf2e template proposals keep their PF2e wording and also carry source 'template'", () => {
  const proposals = generateSkillProposals(everyTemplateEvents(), { skills: {} }, 4);
  assert.equal(proposals.length, 11);
  for (const proposal of proposals) {
    assert.equal(proposal.source, "template");
    assert.equal(proposal.systemId, "pf2e");
    assert.deepEqual(validateSkillEntry(proposal.entry).errors, [], proposal.id);
  }
  assert.match(entryText(proposals.find((p) => p.id === "proposal:field-triage").entry), /Treat Wounds/);
});

test("capstone and emergent placeholder wording is system-correct", () => {
  const events = everyTemplateEvents();
  const dnd = generateCapstoneProposal(10, events, { skills: {} }, 3, { systemId: "dnd5e" });
  const pf = generateCapstoneProposal(10, events, { skills: {} }, 3);
  assert.doesNotMatch(entryText(dnd.entry), PF2E_TERMS);
  assert.match(pf.entry.mechanics.effect, /circumstance bonus/);
  assert.equal(dnd.source, "capstone");
  assert.deepEqual(validateSkillEntry(dnd.entry).errors, []);
  assert.doesNotMatch(entryText(buildEmergentSkillEntry("beekeeping", { systemId: "dnd5e" })), PF2E_TERMS);
  assert.match(buildEmergentSkillEntry("beekeeping").mechanics.effect, /circumstance bonus/);
});

// ---------------------------------------------------------------------------------------------
// requestGrowthProposals, both systems

const suggestedSkill = (name, evidence) => ({
  kind: "skill",
  evidence,
  entry: {
    name,
    tier: 1,
    system_equivalent: "Skill feat",
    gameItem: { kind: "passive" },
    mechanics: { effect: "You gain a +1 bonus to checks to keep a line.", duration: "while active", frequency: { max: 1, per: "unlimited" } },
    metadata: { tags: ["defense"], lineage: { operation: "origin", sources: [], rationale: "Held the bridge." } }
  }
});

for (const systemId of SYSTEMS) {
  test(`[${systemId}] requestGrowthProposals without an AI adapter fails with a clear message`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      await assert.rejects(() => api.requestGrowthProposals(createMockActor(systemId, "Brakka")), /configured AI provider/);
    });
  });

  test(`[${systemId}] requestGrowthProposals runs the adapter on the actor's own growth and merges new proposals`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId, "Brakka");
      api.setProposalAdapter(async () => ({ events: partyEvents(), proposals: [] }));
      await api.analyzeSessionNotes(actor, PARTY_NOTES);
      const before = api.getGrowth(actor);

      await assert.rejects(() => api.requestGrowthProposals(createMockActor(systemId, "Nobody")), /no recorded growth/);

      const calls = [];
      api.setProposalAdapter(async (args) => {
        calls.push(args);
        return {
          events: [ev("Brakka held the bridge.", ["defense"], { actorName: "Brakka" })],
          proposals: [suggestedSkill("Bridgewarden's Stand", ["Brakka held the bridge against a troll."]), suggestedSkill("Bridgewarden's Stand", ["dup"])]
        };
      });
      const result = await api.requestGrowthProposals(actor);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].proposalMode, "always");
      assert.equal(calls[0].systemId, systemId);
      assert.match(calls[0].notes, /Brakka held the bridge against a troll\./);
      assert.doesNotMatch(calls[0].notes, /Maren/); // only Brakka's own growth is replayed
      assert.equal(result.added.length, 1);
      assert.equal(result.added[0].source, "ai-gateway");
      assert.equal(result.added[0].status, "pending");
      assert.ok(result.skipped.some((entry) => entry.reason === "duplicate"));
      const after = api.getGrowth(actor);
      assert.equal(after.proposals.length, before.proposals.length + 1);
      // The re-extracted events from the synthetic note were NOT recorded.
      assert.equal(after.events.length, before.events.length);

      // Asking again does not duplicate the pending proposal.
      const again = await api.requestGrowthProposals(actor);
      assert.equal(again.added.length, 0);
      assert.equal(api.getGrowth(actor).proposals.length, after.proposals.length);
    });
  });

  test(`[${systemId}] requestGrowthProposals forces stage 2 on a v2 gateway adapter configured "never"`, async () => {
    await withFoundry(systemId, async () => {
      const seen = [];
      const transport = {
        async chat({ schema }) {
          const stage = schema?.properties?.proposals ? "propose" : "extract";
          seen.push(stage);
          const body = stage === "propose"
            ? { proposals: [suggestedSkill("Bridgewarden's Stand", ["Brakka held the bridge against a troll."])] }
            : { events: [{ quote: "Brakka held the bridge", continuesPrevious: false, summary: "Brakka held the bridge.", actorName: "Brakka", tags: ["defense"], themes: [], outcome: "success", dangerGap: "none" }] };
          return { content: JSON.stringify(body), ms: 1 };
        },
        async ping() { return { ok: true }; },
        async listModels() { return []; }
      };
      const adapter = createGatewayAdapter(
        { provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "test-model", proposalMode: "never" },
        { transportFactory: () => transport }
      );
      const api = new GrandDesignApi();
      const actor = createMockActor(systemId, "Brakka");
      api.setProposalAdapter(adapter);
      await api.analyzeSessionNotes(actor, PARTY_NOTES);
      assert.ok(!seen.includes("propose"), "configured 'never' -- analysis does not propose");
      const result = await api.requestGrowthProposals(actor);
      assert.ok(seen.includes("propose"), "the suggestion call ran the proposal stage");
      assert.equal(result.added.length, 1);
      assert.equal(result.added[0].entry.name, "Bridgewarden's Stand");
    });
  });
}

test("buildSuggestionNotes lists the actor's own deeds as citable lines", () => {
  const text = buildSuggestionNotes({ name: "Luz" }, [
    { summary: "Luz led the dawn blessing.", outcome: "criticalSuccess", tags: ["leadership"], themes: ["ritual"] }
  ]);
  assert.match(text, /suggest new Grand Design proposals for Luz/);
  assert.match(text, /- Luz led the dawn blessing\. \(criticalSuccess; tags: leadership; themes: ritual\)/);
});
