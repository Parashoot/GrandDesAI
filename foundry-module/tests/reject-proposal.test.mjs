import assert from "node:assert/strict";
import test from "node:test";

import { GrandDesignApi } from "../scripts/api.js";
import { MODULE_ID, LEVEL_PROGRESSION_FLAG } from "../scripts/constants.js";
import { renderProposal, renderGrowthContent } from "../scripts/growth-ui.js";

// Board 7c026881 (ember-road s2): the GM rejected five proposals ("Warden's Duty: Gatekeeper" -- not
// a Skill; "Honeycomb: Artisan's Trade" -- garbled) and had no way to say so. They sat in `pending`
// forever, cluttering the Growth dialog, and blocked the AI from ever proposing that exact name again
// only by accident (the old "already pending" name check). This file covers both supported systems,
// same pattern as tests/api-gateway-v2.test.mjs.

const SYSTEMS = ["pf2e", "dnd5e"];

function createMockActor(systemId) {
  const flags = { [MODULE_ID]: {} };
  return {
    id: `mock-${systemId}`,
    name: "Brakka",
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
      // dnd5e's postCreate (systems/dnd5e-adapter.js#buildFeat) calls item.createActivity; a real
      // Item5e has one, this mock item needs a stand-in for approveProposal to complete on dnd5e.
      return [{ id: "mock-item", getFlag: () => undefined, async createActivity() { return {}; } }];
    }
  };
}

async function withFoundry(systemId, fn) {
  const originalGame = globalThis.game;
  const originalHooks = globalThis.Hooks;
  const hookCalls = [];
  globalThis.game = { user: { isGM: true }, system: { id: systemId } };
  globalThis.Hooks = { callAll: (...args) => hookCalls.push(args) };
  const originalWarn = console.warn;
  console.warn = () => {}; // the fallback path logs on purpose; keep test output readable
  try {
    return await fn(hookCalls);
  } finally {
    globalThis.game = originalGame;
    globalThis.Hooks = originalHooks;
    console.warn = originalWarn;
  }
}

const ev = (summary, tags = [], themes = [], outcome = "success", extra = {}) => ({ summary, tags, themes, outcome, quote: summary, ...extra });

function validSkill(name = "Warden's Duty: Gatekeeper", extra = {}) {
  return {
    kind: "skill",
    evidence: ["Brakka held the gate"],
    ...extra,
    entry: {
      name,
      tier: 1,
      system_equivalent: "Skill feat",
      gameItem: { kind: "passive" },
      mechanics: { effect: "Hold a choke point against a rout.", duration: "while standing fast", frequency: { max: 1, per: "unlimited" } },
      metadata: { tags: ["defense"], themes: [], lineage: { operation: "origin", sources: [], rationale: "Held the gate under pressure." } }
    }
  };
}

// Gets exactly one pending proposal onto the actor in a single adapter round trip, the same way
// api-gateway-v2.test.mjs's RICH_OUTPUT tests do.
async function seedPendingProposal(api, actor, name = "Warden's Duty: Gatekeeper") {
  api.setProposalAdapter(async () => ({
    events: [ev("Brakka held the gate against the rout.", ["defense"])],
    proposals: [validSkill(name)]
  }));
  const result = await api.analyzeSessionNotes(actor, "Brakka held the gate against the rout.");
  const proposal = result.proposals.find((p) => p.status === "pending" && p.entry?.name === name);
  assert.ok(proposal, "setup: the rich adapter output must have produced a pending proposal to reject");
  return proposal;
}

for (const systemId of SYSTEMS) {
  test(`[${systemId}] rejectProposal marks status "rejected" with a reason and fires a Hook`, () => withFoundry(systemId, async (hookCalls) => {
    const api = new GrandDesignApi();
    const actor = createMockActor(systemId);
    const proposal = await seedPendingProposal(api, actor);
    const eventsBefore = api.getGrowth(actor).events.length;

    const rejected = await api.rejectProposal(actor, proposal.id, { reason: "not a Skill" });

    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.rejectedReason, "not a Skill");
    assert.equal(typeof rejected.rejectedAt, "string");
    assert.ok(!Number.isNaN(Date.parse(rejected.rejectedAt)));
    // Evidence events are never deleted by a rejection.
    assert.equal(api.getGrowth(actor).events.length, eventsBefore);
    assert.ok(hookCalls.some(([name, hookActor, hookProposal]) => name === "grand-design-ai.proposalRejected" && hookActor === actor && hookProposal.id === proposal.id));
  }));

  test(`[${systemId}] a rejected proposal no longer counts as pending`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor(systemId);
    const proposal = await seedPendingProposal(api, actor);
    await api.rejectProposal(actor, proposal.id);

    const growth = api.getGrowth(actor);
    assert.equal(growth.proposals.find((p) => p.id === proposal.id)?.status, "rejected");
    assert.equal(growth.proposals.filter((p) => p.status === "pending").length, 0);
    // The proposal is still on the actor (not deleted), just not pending -- this is exactly what the
    // Growth dialog filters on (growth-ui.js#openGrowthManager).
    assert.ok(growth.proposals.some((p) => p.id === proposal.id));
  }));

  test(`[${systemId}] approving a rejected proposal is refused, the same way a non-pending id already is`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor(systemId);
    const proposal = await seedPendingProposal(api, actor);
    await api.rejectProposal(actor, proposal.id);

    await assert.rejects(() => api.approveProposal(actor, proposal.id), /No pending skill proposal exists/);
  }));

  test(`[${systemId}] rejectProposal is idempotent: rejecting twice does not throw or re-approve`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor(systemId);
    const proposal = await seedPendingProposal(api, actor);

    const first = await api.rejectProposal(actor, proposal.id, { reason: "first" });
    const second = await api.rejectProposal(actor, proposal.id, { reason: "second call should be a no-op" });

    assert.equal(second.status, "rejected");
    // The no-op call must not overwrite the reason recorded the first time.
    assert.equal(second.rejectedReason, first.rejectedReason);
  }));

  test(`[${systemId}] rejecting a proposal that was already approved is refused`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor(systemId);
    const proposal = await seedPendingProposal(api, actor);
    // approveProposal also needs a spendable grant allowance (progression.js#canApproveGeneratedProposal).
    await actor.update({ [`flags.${MODULE_ID}.${LEVEL_PROGRESSION_FLAG}`]: { level: 4, progress: 0, grantAllowances: 1, capstoneAllowances: 0 } });
    await api.approveProposal(actor, proposal.id);

    await assert.rejects(() => api.rejectProposal(actor, proposal.id), /No pending skill proposal exists/);
  }));

  test(`[${systemId}] rejecting an unknown proposal id is refused`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor(systemId);
    await seedPendingProposal(api, actor);

    await assert.rejects(() => api.rejectProposal(actor, "proposal:does-not-exist"), /No pending skill proposal exists/);
  }));

  test(`[${systemId}] Suggest proposals skips a re-suggestion of an identically named REJECTED proposal, even under a new id`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor(systemId);
    const proposal = await seedPendingProposal(api, actor, "Honeycomb: Artisan's Trade");
    await api.rejectProposal(actor, proposal.id, { reason: "garbled" });

    // The gateway re-authors the same idea under a fresh id (e.g. after "Author with AI" ran again) --
    // the name is what must be recognized, not just the id.
    api.setProposalAdapter(async () => ({
      proposals: [validSkill("Honeycomb: Artisan's Trade", { id: "proposal:ai-skill-honeycomb-artisans-trade-2" })]
    }));
    const result = await api.requestGrowthProposals(actor);

    assert.equal(result.added.length, 0);
    assert.ok(result.skipped?.some((entry) => entry.reason === "rejected" && entry.proposal?.entry?.name === "Honeycomb: Artisan's Trade"));
    assert.equal(api.getGrowth(actor).proposals.filter((p) => p.status === "pending").length, 0);
  }));

  test(`[${systemId}] Suggest proposals still offers a genuinely different proposal after a rejection`, () => withFoundry(systemId, async () => {
    const api = new GrandDesignApi();
    const actor = createMockActor(systemId);
    const proposal = await seedPendingProposal(api, actor, "Warden's Duty: Gatekeeper");
    await api.rejectProposal(actor, proposal.id);

    api.setProposalAdapter(async () => ({ proposals: [validSkill("Shieldwall Stance")] }));
    const result = await api.requestGrowthProposals(actor);

    assert.equal(result.added.length, 1);
    assert.equal(result.added[0].entry.name, "Shieldwall Stance");
  }));
}

// growth-ui.js: the reject control is per-proposal (there is no single global "reject" target the
// way "Approve" uses the <select>), so it must only render for a proposal that is actually pending.
test("growth-ui renderProposal shows a Reject button only for a pending proposal", () => {
  const base = {
    id: "p1",
    kind: "skill",
    source: "ai-gateway",
    entry: { name: "Bridge Warden", system_equivalent: "feat", mechanics: { effect: "Hold a choke point." } },
    evidence: ["e1"]
  };
  const pendingHtml = renderProposal({ ...base, status: "pending" });
  assert.match(pendingHtml, /data-action="gd-reject-proposal"/);
  assert.match(pendingHtml, /data-proposal-id="p1"/);

  for (const status of ["approved", "rejected"]) {
    const html = renderProposal({ ...base, status });
    assert.doesNotMatch(html, /data-action="gd-reject-proposal"/, `a ${status} proposal must not offer Reject`);
  }
});

test("growth-ui renderGrowthContent wires a Reject button for each proposal in the pending list", () => {
  const html = renderGrowthContent({
    growth: { events: [] },
    progression: { level: 3, progress: 10, grantAllowances: 0 },
    pending: [{
      id: "p1",
      status: "pending",
      kind: "skill",
      source: "ai-gateway",
      entry: { name: "Bridge Warden", system_equivalent: "feat", mechanics: { effect: "Hold a choke point." } },
      evidence: ["e1"]
    }],
    lastAnalysis: null,
    lastResult: null,
    status: { kind: "ai", text: "AI: qwen3.8:27b", title: "" }
  });
  assert.match(html, /data-action="gd-reject-proposal" data-proposal-id="p1"/);
});
