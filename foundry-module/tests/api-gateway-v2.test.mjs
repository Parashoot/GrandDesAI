import assert from "node:assert/strict";
import test from "node:test";

import { GrandDesignApi } from "../scripts/api.js";
import { createGatewayAdapter } from "../scripts/ai-gateway.js";
import { MODULE_ID } from "../scripts/constants.js";
import { validateGrowthEvent } from "../scripts/progression.js";
import { validateSkillEntry } from "../scripts/validator.js";
import { createSimModel } from "../tools/nlp-scale/sim-model.js";
import { loadCorpusSync } from "./helpers/corpus.mjs";

// End-to-end api.js#analyzeSessionNotes against the RICH v2 adapter output (events with themes,
// proposals that may be partly invalid, skipped lists, gatewayDiagnostics), for BOTH supported game
// systems per project policy. The mock actor mirrors api.test.mjs's, with the level shape each
// system actually uses (pf2e: details.level.value, dnd5e: details.level).

const SYSTEMS = ["pf2e", "dnd5e"];
const corpus = loadCorpusSync();

function createMockActor(systemId) {
  const flags = { [MODULE_ID]: {} };
  return {
    id: `mock-${systemId}`,
    name: "Maren",
    documentName: "Actor",
    type: "character",
    system: systemId === "dnd5e"
      ? { details: { level: 4 }, skills: { acr: { mod: 3, total: 5 } }, attributes: { prof: 2 } }
      : { details: { level: { value: 4 } }, skills: { acrobatics: { mod: 8 } } },
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

async function withFoundry(systemId, fn) {
  const originalGame = globalThis.game;
  const originalHooks = globalThis.Hooks;
  globalThis.game = { user: { isGM: true }, system: { id: systemId } };
  globalThis.Hooks = { callAll: () => {} };
  const originalWarn = console.warn;
  console.warn = () => {}; // the fallback path logs on purpose; keep test output readable
  try {
    return await fn();
  } finally {
    globalThis.game = originalGame;
    globalThis.Hooks = originalHooks;
    console.warn = originalWarn;
  }
}

const ev = (summary, tags, themes = [], outcome = "success", extra = {}) => ({ summary, tags, themes, outcome, quote: summary, ...extra });

function validSkill(name = "Apiarist's Calm", tags = ["nature"], themes = ["beekeeping"]) {
  return {
    kind: "skill",
    evidence: ["Maren moved the hives"],
    entry: {
      name,
      tier: 1,
      system_equivalent: "Skill feat",
      gameItem: { kind: "passive" },
      mechanics: { effect: "Bees near you are calm; +1 to checks to handle them.", duration: "while tending hives", frequency: { max: 1, per: "unlimited" } },
      metadata: { tags, themes, lineage: { operation: "origin", sources: [], rationale: "Kept bees for weeks." } }
    }
  };
}

const RICH_OUTPUT = () => ({
  events: [
    ev("Maren moved the beehives to the south meadow.", [], ["beekeeping"]),
    ev("Maren parried the bandit's blade.", ["martial"], [], "criticalSuccess", { dangerGap: "moderate", language: "en" })
  ],
  proposals: [validSkill()],
  themes: [{ slug: "beekeeping", weight: 1, count: 1 }],
  skippedEvents: [{ reason: "no-tags-or-themes", event: { summary: "It rained." } }],
  skippedProposals: [],
  gatewayDiagnostics: { model: "stub", provider: "ollama", pipeline: "two-stage", chunks: 1, stages: [{ stage: "extract", chunk: 0, attempts: 1, ms: 5, repairs: ["stripped-code-fence"], errors: [] }], coercions: [], totalMs: 7 }
});

for (const systemId of SYSTEMS) {
  test(`[${systemId}] rich adapter output: events (incl. themes-only) are recorded and themes surfaced`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    api.setProposalAdapter(async () => RICH_OUTPUT());
    const actor = createMockActor(systemId);
    const result = await api.analyzeSessionNotes(actor, "Maren moved the hives, then parried a bandit.");
    assert.equal(result.source, "adapter");
    assert.equal(result.events.length, 2);
    for (const event of result.events) assert.deepEqual(validateGrowthEvent(event).errors, []);
    const hives = result.events.find((event) => event.themes?.includes("beekeeping"));
    assert.ok(hives, "the themes-only event was kept");
    assert.deepEqual(hives.tags, []);
    assert.equal(result.events.find((event) => event.tags.includes("martial")).dangerGap, "moderate");
    const theme = result.themes.find((t) => t.slug === "beekeeping");
    assert.ok(theme);
    assert.equal(theme.isNew, true);
    assert.equal(api.getGrowth(actor).events.length, 2, "events persisted on the actor");
  }));

  test(`[${systemId}] gatewayDiagnostics, adapter skipped events and lastAnalysis are surfaced/stored`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    api.setProposalAdapter(async () => RICH_OUTPUT());
    const actor = createMockActor(systemId);
    const notes = "Maren moved the hives, then parried a bandit.";
    const result = await api.analyzeSessionNotes(actor, notes);
    assert.equal(result.gatewayDiagnostics.model, "stub");
    assert.ok(result.adapterSkippedEvents.some((s) => s.reason === "no-tags-or-themes"));
    const last = api.getLastAnalysis(actor);
    assert.equal(last.notes, notes);
    assert.equal(last.source, "adapter");
    assert.deepEqual(last.eventIds, result.events.map((event) => event.id));
    assert.equal(last.diagnostics.model, "stub");
    assert.equal(last.diagnostics.repairs, 1);
  }));

  test(`[${systemId}] a valid model proposal is recorded pending with source ai-gateway`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    api.setProposalAdapter(async () => RICH_OUTPUT());
    const actor = createMockActor(systemId);
    const result = await api.analyzeSessionNotes(actor, "Maren moved the hives.");
    const proposal = result.proposals.find((p) => p.source === "ai-gateway");
    assert.ok(proposal);
    assert.equal(proposal.status, "pending");
    assert.deepEqual(validateSkillEntry(proposal.entry).errors, []);
    assert.deepEqual(proposal.entry.metadata.themes, ["beekeeping"]);
  }));

  test(`[${systemId}] proposals are tolerant per proposal: invalid ones go to adapterSkippedProposals, valid ones are kept`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const broken = validSkill("Broken Thing");
    delete broken.entry.mechanics.effect;
    api.setProposalAdapter(async () => ({ ...RICH_OUTPUT(), proposals: [broken, validSkill(), { kind: "skill", skillEntry: {} }, { kind: "banana" }] }));
    const actor = createMockActor(systemId);
    const result = await api.analyzeSessionNotes(actor, "Maren moved the hives.");
    assert.equal(result.source, "adapter");
    assert.equal(result.proposals.filter((p) => p.source === "ai-gateway").length, 1);
    assert.equal(result.adapterSkippedProposals.length, 3);
    for (const skipped of result.adapterSkippedProposals) assert.ok(skipped.errors.length);
  }));

  test(`[${systemId}] pipeline-level skippedProposals are passed through too`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    api.setProposalAdapter(async () => ({ ...RICH_OUTPUT(), proposals: [], skippedProposals: [{ reason: "invalid", errors: ["x"] }] }));
    const result = await api.analyzeSessionNotes(createMockActor(systemId), "Maren moved the hives.");
    assert.ok(result.adapterSkippedProposals.some((s) => s.reason === "invalid"));
  }));

  test(`[${systemId}] unknown proposal tags move to metadata.themes; only canonical tags stay in metadata.tags`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    api.setProposalAdapter(async () => ({ ...RICH_OUTPUT(), proposals: [validSkill("Hive Whisper", ["nature", "melee", "apiculture-arts"], [])] }));
    const result = await api.analyzeSessionNotes(createMockActor(systemId), "Maren moved the hives.");
    const proposal = result.proposals.find((p) => p.source === "ai-gateway");
    assert.ok(proposal, JSON.stringify(result.adapterSkippedProposals));
    assert.deepEqual(proposal.entry.metadata.tags, ["nature", "martial"]);
    assert.ok(proposal.entry.metadata.themes.includes("apiculture-arts"));
  }));

  test(`[${systemId}] hallucinated event tags are remapped (melee -> martial) and reported`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    api.setProposalAdapter(async () => ({ events: [ev("Maren fought.", ["melee"])], proposals: [] }));
    const result = await api.analyzeSessionNotes(createMockActor(systemId), "Maren fought.");
    assert.deepEqual(result.events[0].tags, ["martial"]);
    assert.ok(result.adapterRejectedTags.some((entry) => JSON.stringify(entry).includes("melee")));
  }));

  test(`[${systemId}] three beekeeping sessions yield a pending emergent proposal`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    let n = 0;
    api.setProposalAdapter(async () => {
      n += 1;
      return { events: [ev(`Maren tended the hives, session ${["one", "two", "three"][n - 1]}.`, [], ["beekeeping"])], proposals: [] };
    });
    const actor = createMockActor(systemId);
    let result;
    for (let i = 0; i < 3; i += 1) result = await api.analyzeSessionNotes(actor, `Session ${i + 1}: Maren tended the hives.`);
    const emergent = result.proposals.find((p) => p.id === "proposal:emergent-beekeeping");
    assert.ok(emergent, JSON.stringify(result.proposals.map((p) => p.id)));
    assert.equal(emergent.status, "pending");
    assert.equal(emergent.source, "emergent");
    assert.equal(emergent.needsAuthoring, true);
    assert.deepEqual(validateSkillEntry(emergent.entry).errors, []);
    assert.equal(api.getEmergentThemes().themes.beekeeping.count, 3);
  }));

  test(`[${systemId}] an ignored theme never proposes`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    await api.setEmergentThemeMapping("beekeeping", { ignored: true });
    api.setProposalAdapter(async () => ({ events: [ev("Maren tended the hives today.", [], ["beekeeping"])], proposals: [] }));
    const actor = createMockActor(systemId);
    let result;
    for (let i = 0; i < 3; i += 1) result = await api.analyzeSessionNotes(actor, `Session ${i}: hives.`);
    assert.equal(result.proposals.some((p) => p.id === "proposal:emergent-beekeeping"), false);
  }));

  test(`[${systemId}] fallback ONLY on total failure: a throwing adapter -> local-fallback with the reason, notes kept`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    api.setProposalAdapter(async () => { throw new Error("AI provider returned HTTP 500."); });
    const actor = createMockActor(systemId);
    const notes = "Kesh parried the guard's blade. Mira bound the wound.";
    const result = await api.analyzeSessionNotes(actor, notes);
    assert.equal(result.source, "local-fallback");
    assert.match(result.adapterError, /HTTP 500/);
    assert.ok(result.events.length >= 2);
    assert.ok(result.diagnostics);
    assert.equal(api.getLastAnalysis(actor).notes, notes);
    assert.equal(api.getLastAnalysis(actor).source, "local-fallback");
  }));

  test(`[${systemId}] an adapter answer with zero events is NOT a fallback`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    api.setProposalAdapter(async () => ({ events: [], proposals: [] }));
    const result = await api.analyzeSessionNotes(createMockActor(systemId), "We ordered pizza.");
    assert.equal(result.source, "adapter");
    assert.equal(result.events.length, 0);
  }));

  test(`[${systemId}] reanalyzeLastNotes replaces the previous reading instead of double-counting`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    api.setProposalAdapter(async () => ({ events: [ev("Maren fought.", ["martial"]), ev("Maren healed.", ["medicine"])], proposals: [] }));
    const actor = createMockActor(systemId);
    await api.analyzeSessionNotes(actor, "Maren fought, then healed.");
    const progressBefore = api.getLevelProgression(actor).progress;
    await api.reanalyzeLastNotes(actor);
    assert.equal(api.getGrowth(actor).events.length, 2);
    assert.equal(api.getLevelProgression(actor).progress, progressBefore);
  }));

  test(`[${systemId}] emergentThemes disabled in the gateway config: themes dropped, flagged on the result`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    api.setGatewayConfigProvider(() => ({ emergentThemes: false }));
    api.setProposalAdapter(async () => ({ events: [ev("Maren fought.", ["martial"], ["swordplay"]), ev("Maren tended bees.", [], ["beekeeping"])], proposals: [] }));
    const result = await api.analyzeSessionNotes(createMockActor(systemId), "Maren fought and kept bees.");
    assert.equal(result.emergentThemesDisabled, true);
    for (const event of result.events) assert.deepEqual(event.themes ?? [], []);
    assert.equal(result.events.length, 1);
  }));

  test(`[${systemId}] REAL gateway adapter + simulated model, end to end through the API`, () => withFoundry(systemId, async () => {
    const item = corpus.find((entry) => entry.id === "nv-001");
    const sim = createSimModel({ corpus, seed: 3, faultRate: 0 });
    const api = new GrandDesignApi();
    api.setProposalAdapter(createGatewayAdapter({ provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "sim", fetchImpl: sim.fetch, sleep: async () => {}, systemId }));
    const actor = createMockActor(systemId);
    const result = await api.analyzeSessionNotes(actor, item.notes);
    assert.equal(result.source, "adapter");
    assert.ok(result.events.some((event) => event.themes?.includes("beekeeping")));
    assert.equal(result.gatewayDiagnostics.provider, "ollama");
    assert.ok(sim.stats.chatCalls >= 1);
  }));

  test(`[${systemId}] REAL gateway adapter against a dead provider falls back locally with a helpful reason`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    api.setProposalAdapter(createGatewayAdapter({ provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "sim", fetchImpl: async () => { throw new TypeError("Failed to fetch"); }, systemId }));
    const result = await api.analyzeSessionNotes(createMockActor(systemId), "Kesh parried the guard's blade.");
    assert.equal(result.source, "local-fallback");
    assert.match(result.adapterError, /Could not reach the AI provider/);
    assert.ok(result.events.length >= 1);
  }));
}
