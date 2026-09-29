import assert from "node:assert/strict";
import test from "node:test";

import { GrandDesignApi } from "../scripts/api.js";
import { createGatewayAdapter } from "../scripts/ai-gateway.js";
import { GROWTH_EVENTS_FLAG, GROWTH_PROPOSALS_FLAG, LEVEL_PROGRESSION_FLAG, MODULE_ID } from "../scripts/constants.js";
import { canApproveGeneratedProposal } from "../scripts/progression.js";

// Boards 3d80edf3 (Author with AI tells the model what to author), d8c96c43 (no templates/placeholders
// beside AI proposals), 0a1c8463 (an AI-authored template survives the next event), f48a1e52 (a Class
// stays approvable past its milestone). Both game systems, real gateway adapter over a fake fetch.

const SYSTEMS = ["pf2e", "dnd5e"];

function createMockActor(systemId, { name = "Maren", level = 12 } = {}) {
  const flags = { [MODULE_ID]: {} };
  return {
    id: `mock-${systemId}`,
    name,
    documentName: "Actor",
    type: "character",
    system: systemId === "dnd5e"
      ? { details: { level }, skills: { acr: { mod: 3, total: 5 } }, attributes: { prof: 2 } }
      : { details: { level: { value: level } }, skills: { acrobatics: { mod: 8 } } },
    items: { find: () => undefined, filter: () => [] },
    getFlag: (module, key) => flags[module]?.[key],
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) flags[MODULE_ID][path.split(".")[2]] = value;
      return this;
    },
    async createEmbeddedDocuments() {
      return [{ id: "mock-item", getFlag: () => undefined, async createActivity() { return {}; } }];
    }
  };
}

async function withFoundry(systemId, fn) {
  const originalGame = globalThis.game;
  const originalHooks = globalThis.Hooks;
  globalThis.game = { user: { isGM: true }, system: { id: systemId } };
  globalThis.Hooks = { callAll: () => {} };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    globalThis.game = originalGame;
    globalThis.Hooks = originalHooks;
    console.warn = originalWarn;
  }
}

const skillItem = (name, { tier = 1, themes = ["archery"], tags = ["precision"] } = {}) => ({
  kind: "skill",
  evidence: ["Maren shot the sentry"],
  entry: {
    name,
    tier,
    system_equivalent: "Skill feat",
    gameItem: { kind: "passive" },
    mechanics: { effect: "Your steady aim adds +1 to ranged attacks against a target you watched last turn.", duration: "while active", frequency: { max: 1, per: "unlimited" } },
    metadata: { tags, themes, lineage: { operation: "origin", sources: [], rationale: "Shot many arrows." } }
  }
});

const classItem = (name) => ({
  kind: "class",
  evidence: ["Maren led the volley"],
  entry: {
    name,
    level: 20,
    power_tier: "standard",
    is_primary: true,
    is_secondary: false,
    system_chassis: "Ranger evolution",
    gameItem: { kind: "passive" },
    mechanics: { effect: "Once per day, loose a volley that marks every foe you can see.", duration: "instant", frequency: { max: 1, per: "day" } },
    metadata: { tags: ["precision"], lineage: { operation: "origin", sources: [], rationale: "Archery mastery." } }
  }
});

// A fake Ollama that records every request body and answers from `respond(body, n)`.
function fakeFetch(respond) {
  const bodies = [];
  const fetchImpl = async (_url, options = {}) => {
    if (options.method === "GET") return { ok: true, status: 200, json: async () => ({ models: [] }), text: async () => "{}" };
    const body = JSON.parse(options.body);
    bodies.push(body);
    const content = await respond(body, bodies.length);
    return { ok: true, status: 200, json: async () => ({ model: "fake", message: { role: "assistant", content: JSON.stringify(content) }, done_reason: "stop" }), text: async () => "" };
  };
  fetchImpl.bodies = bodies;
  return fetchImpl;
}

const gatewayFor = (systemId, fetchImpl, extra = {}) => createGatewayAdapter({
  provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "fake", fetchImpl, sleep: async () => {}, systemId, ...extra
});

const archeryEvents = (n = 4) => Array.from({ length: n }, (_, i) => ({
  id: `event:${i + 1}`, summary: `Maren loosed an arrow at the ridge sentry (${i + 1}).`, quote: `shot the sentry ${i + 1}`,
  tags: ["precision"], themes: ["archery"], outcome: "success", actorName: "Maren", occurredAt: new Date().toISOString()
}));

const placeholder = () => ({
  id: "proposal:emergent-archery", kind: "skill", status: "pending", source: "emergent", needsAuthoring: true, theme: "archery",
  evidence: ["event:1", "event:2", "event:3"],
  entry: { ...skillItem("Archery Knack").entry, mechanics: { effect: "A knack for archery.", duration: "while active", frequency: { max: 1, per: "unlimited" } } }
});

async function seed(actor, { proposals = [], events = archeryEvents(), progression } = {}) {
  await actor.update({
    [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: proposals,
    [`flags.${MODULE_ID}.${GROWTH_EVENTS_FLAG}`]: events,
    ...(progression ? { [`flags.${MODULE_ID}.${LEVEL_PROGRESSION_FLAG}`]: progression } : {})
  });
}

const userPayload = (body) => JSON.parse(body.messages.find((m) => m.role === "user").content);
const systemText = (body) => body.messages.find((m) => m.role === "system").content;

for (const systemId of SYSTEMS) {
  test(`[${systemId}] authorProposal is stage 2 only and tells the model what to author`, () => withFoundry(systemId, async () => {
    const fetchImpl = fakeFetch(() => ({ proposals: [skillItem("Ridge-Watcher's Aim")] }));
    const adapter = gatewayFor(systemId, fetchImpl);
    assert.equal(typeof adapter.authorProposal, "function");
    const actor = createMockActor(systemId);
    const out = await adapter.authorProposal({ actor, proposal: placeholder(), events: archeryEvents(), theme: "archery", label: "Archery", systemId });
    assert.equal(fetchImpl.bodies.length, 1, "one provider call: no extraction stage");
    const sys = systemText(fetchImpl.bodies[0]);
    assert.match(sys, /AUTHORING TARGET/);
    assert.match(sys, /"Archery"/);
    assert.match(sys, /Archery Knack/, "the placeholder being replaced is named");
    assert.equal(userPayload(fetchImpl.bodies[0]).newEvents.length, 4, "the cited evidence is the stage-2 input");
    assert.equal(out.events.length > 0, true, "preset events are echoed, not re-extracted");
    assert.equal(out.proposals.length, 1);
    assert.equal(out.proposals[0].kind, "skill");
  }));

  test(`[${systemId}] requestProposalAuthoring replaces the Knack placeholder in place`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    api.setProposalAdapter(gatewayFor(systemId, fakeFetch(() => ({ proposals: [skillItem("Ridge-Watcher's Aim")] }))));
    const actor = createMockActor(systemId);
    await seed(actor, { proposals: [placeholder()] });
    const { proposal } = await api.requestProposalAuthoring(actor, "proposal:emergent-archery");
    assert.equal(proposal.id, "proposal:emergent-archery");
    assert.equal(proposal.entry.name, "Ridge-Watcher's Aim");
    assert.equal(proposal.needsAuthoring, false);
    assert.equal(proposal.authoredBy, "ai-gateway");
    assert.deepEqual(proposal.evidence, ["event:1", "event:2", "event:3"]);
    assert.ok(proposal.entry.metadata.themes.includes("archery"));
    assert.equal(api.getGrowth(actor).proposals.length, 1);
  }));

  test(`[${systemId}] authoring a capstone keeps isCapstone, milestoneLevel and tier 3`, () => withFoundry(systemId, async () => {
    const fetchImpl = fakeFetch(() => ({ proposals: [skillItem("Sentry's Last Sight", { tier: 2 })] }));
    const api = new GrandDesignApi();
    api.setProposalAdapter(gatewayFor(systemId, fetchImpl));
    const actor = createMockActor(systemId);
    const capstone = { ...placeholder(), id: "proposal:capstone-10", source: "capstone", isCapstone: true, milestoneLevel: 10, needsAuthoring: true, theme: undefined,
      entry: { ...placeholder().entry, name: "Capstone: Precision", tier: 3 } };
    await seed(actor, { proposals: [capstone] });
    const { proposal } = await api.requestProposalAuthoring(actor, "proposal:capstone-10");
    assert.match(systemText(fetchImpl.bodies[0]), /tier MUST be 3/);
    assert.equal(proposal.isCapstone, true);
    assert.equal(proposal.milestoneLevel, 10);
    assert.equal(proposal.source, "capstone");
    assert.equal(proposal.entry.tier, 3);
  }));

  test(`[${systemId}] authoring a Class proposal keeps kind class even past its milestone level`, () => withFoundry(systemId, async () => {
    const fetchImpl = fakeFetch(() => ({ proposals: [skillItem("Just A Skill"), classItem("Warden of the Long Draw")] }));
    const api = new GrandDesignApi();
    api.setProposalAdapter(gatewayFor(systemId, fetchImpl));
    const actor = createMockActor(systemId);
    const cls = { id: "proposal:class-evolution-20", kind: "class", status: "pending", source: "class-evolution", milestoneLevel: 20, needsAuthoring: true,
      evidence: ["event:1"], entry: classItem("Placeholder Class").entry };
    await seed(actor, { proposals: [cls], progression: { level: 21, progress: 0, grantAllowances: 1, capstoneAllowances: 0 } });
    const { proposal } = await api.requestProposalAuthoring(actor, "proposal:class-evolution-20");
    assert.match(systemText(fetchImpl.bodies[0]), /kind MUST be "class"/);
    assert.equal(proposal.kind, "class");
    assert.equal(proposal.entry.name, "Warden of the Long Draw");
    assert.equal(proposal.milestoneLevel, 20);
  }));

  test(`[${systemId}] a failed authoring call leaves the placeholder with a stated reason`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    api.setProposalAdapter(gatewayFor(systemId, async () => { throw new TypeError("Failed to fetch"); }, { maxRetries: 0 }));
    const actor = createMockActor(systemId);
    await seed(actor, { proposals: [placeholder()] });
    await assert.rejects(() => api.requestProposalAuthoring(actor, "proposal:emergent-archery"), /placeholder is unchanged/);
    const kept = api.getGrowth(actor).proposals[0];
    assert.equal(kept.needsAuthoring, true);
    assert.equal(kept.entry.name, "Archery Knack");
  }));

  test(`[${systemId}] approveProposal refuses a needsAuthoring placeholder when an adapter is configured`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor(systemId);
    const progression = { level: 3, progress: 0, grantAllowances: 2, capstoneAllowances: 0 };
    await seed(actor, { proposals: [placeholder()], progression });
    api.setProposalAdapter(async () => ({ events: [], proposals: [] }));
    await assert.rejects(() => api.approveProposal(actor, "proposal:emergent-archery"), /Author with AI/);
    await api.approveProposal(actor, "proposal:emergent-archery", { confirm: true });
    assert.equal(api.getGrowth(actor).proposals[0].status, "approved");
    // No adapter: nothing could author it, so it approves as before.
    const bare = new GrandDesignApi();
    const actor2 = createMockActor(systemId);
    await seed(actor2, { proposals: [placeholder()], progression });
    await bare.approveProposal(actor2, "proposal:emergent-archery");
    assert.equal(bare.getGrowth(actor2).proposals[0].status, "approved");
  }));

  test(`[${systemId}] adapter-read notes mint no template or Knack placeholder; the local path still does`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const notes = "Maren shot the sentry.";
    api.setProposalAdapter(async () => ({ events: archeryEvents().map(({ id, ...event }) => event), proposals: [skillItem("Ridge-Watcher's Aim")] }));
    const actor = createMockActor(systemId);
    const result = await api.analyzeSessionNotes(actor, notes);
    const sources = result.proposals.map((p) => p.source);
    assert.ok(!sources.includes("template") && !sources.includes("emergent"), JSON.stringify(result.proposals.map((p) => p.id)));
    assert.ok(sources.includes("ai-gateway"));

    // Adapter configured but failing -> local fallback -> the full path returns.
    const failing = new GrandDesignApi();
    failing.setProposalAdapter(async () => { throw new Error("down"); });
    const local = createMockActor(systemId);
    let last;
    for (const event of archeryEvents()) last = await failing.recordGrowthEvent(local, { ...event, themes: ["archery"] });
    assert.ok(last.proposals.some((p) => p.source === "emergent"), "emergent placeholder minted locally");
  }));

  test(`[${systemId}] an emergent theme already on a pending AI proposal is not minted again`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor(systemId);
    const aiProposal = { ...skillItem("Ridge-Watcher's Aim"), id: "proposal:ai-archery", status: "pending", source: "ai-gateway" };
    await seed(actor, { proposals: [aiProposal], events: [] });
    let last;
    for (const event of archeryEvents()) last = await api.recordGrowthEvent(actor, { ...event, themes: ["archery"] });
    assert.ok(!last.proposals.some((p) => p.source === "emergent"), JSON.stringify(last.proposals.map((p) => p.id)));
  }));

  test(`[${systemId}] every pending source counts toward the cap and placeholders go first`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor(systemId);
    const knacks = ["a", "b", "c", "d", "e", "f"].map((t) => ({ ...placeholder(), id: `proposal:emergent-${t}`, theme: t }));
    await seed(actor, { proposals: knacks, events: [], progression: { level: 1, progress: 0, grantAllowances: 0, capstoneAllowances: 0 } });
    api.setProposalAdapter(async () => ({ events: [], proposals: [skillItem("Ridge-Watcher's Aim")] }));
    const result = await api.analyzeSessionNotes(actor, "Maren shot the sentry.");
    const pending = result.proposals.filter((p) => p.status === "pending");
    assert.equal(pending.length, 5, "cap is 5 for 0 allowances, counting placeholders");
    assert.ok(pending.some((p) => p.source === "ai-gateway"), "the AI proposal survives");
    assert.ok(result.adapterSkippedProposals.some((s) => s.reason === "pending-cap"));
  }));

  test(`[${systemId}] an AI-authored template proposal survives the next recorded event`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor(systemId);
    const events = [1, 2, 3].map((n) => ({ summary: `Maren treated a wound ${n}.`, tags: ["medicine", "support"], outcome: "success", actorName: "Maren" }));
    let last;
    for (const event of events) last = await api.recordGrowthEvent(actor, event);
    const template = last.proposals.find((p) => p.id === "proposal:field-triage");
    assert.ok(template, "the template is minted locally");
    api.setProposalAdapter(gatewayFor(systemId, fakeFetch(() => ({ proposals: [skillItem("Steady Hands, Steady Breath", { tags: ["medicine"], themes: [] })] }))));
    const { proposal } = await api.requestProposalAuthoring(actor, "proposal:field-triage");
    assert.equal(proposal.source, "ai-gateway");
    assert.equal(proposal.origin, "template");
    const after = await api.recordGrowthEvent(actor, { summary: "Maren treated a wound 4.", tags: ["medicine", "support"], outcome: "success", actorName: "Maren" });
    const kept = after.proposals.find((p) => p.id === "proposal:field-triage");
    assert.equal(kept.entry.name, "Steady Hands, Steady Breath");
    assert.equal(kept.authoredBy, "ai-gateway");
    assert.ok(kept.evidence.length >= 4, "evidence refreshed");
  }));

  test(`[${systemId}] a milestone Class stays approvable after the character levels past it`, () => withFoundry(systemId, async () => {
    const cls = { id: "proposal:class-evolution-20", kind: "class", status: "pending", source: "class-evolution", milestoneLevel: 20, entry: {} };
    assert.equal(canApproveGeneratedProposal({ level: 21, grantAllowances: 1 }, cls).valid, true);
    assert.equal(canApproveGeneratedProposal({ level: 21, grantAllowances: 1 }, { ...cls, milestoneLevel: undefined, classEvolutionLevel: 20 }).valid, true);
    assert.equal(canApproveGeneratedProposal({ level: 21, grantAllowances: 1 }, { ...cls, milestoneLevel: undefined }).valid, false);
    assert.equal(canApproveGeneratedProposal({ level: 21, grantAllowances: 1 }, { ...cls, milestoneLevel: 21 }).valid, false);
  }));

  test(`[${systemId}] a template milestone reward is flagged usedFallback on the proposal itself`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor(systemId);
    await seed(actor, {});
    const args = { kind: "capstone", level: 10, ownEvents: archeryEvents(), registry: api.getActorRegistry(actor), modifier: 0, systemId, config: api.getGatewayConfig() };
    const offline = await api._resolveMilestoneReward(actor, args);
    assert.equal(offline.proposal.usedFallback, true);
    assert.match(offline.proposal.fallbackReason, /no AI provider/);
    api.setProposalAdapter(gatewayFor(systemId, fakeFetch(() => ({ proposals: [skillItem("Sentry's Last Sight", { tier: 3 })] }))));
    const authored = await api._resolveMilestoneReward(actor, args);
    assert.equal(authored.proposal.usedFallback, undefined, "an AI-authored reward carries no fallback flag");
  }));

  test(`[${systemId}] a milestone Class is still authored by the AI when the rest crossed several levels`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    api.setProposalAdapter(gatewayFor(systemId, fakeFetch(() => ({ proposals: [classItem("Warden of the Long Draw")] }))));
    const actor = createMockActor(systemId);
    await seed(actor, { progression: { level: 21, progress: 0, grantAllowances: 2, capstoneAllowances: 0 } });
    const { proposal, usedFallback } = await api._resolveMilestoneReward(actor, {
      kind: "class-evolution", level: 20, ownEvents: archeryEvents(), registry: api.getActorRegistry(actor), modifier: 0, systemId, config: api.getGatewayConfig()
    });
    assert.equal(usedFallback, false);
    assert.equal(proposal.kind, "class");
    assert.equal(proposal.milestoneLevel, 20);
    assert.equal(proposal.entry.name, "Warden of the Long Draw");
  }));
}
