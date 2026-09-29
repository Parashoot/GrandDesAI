// Registry panel + advanced-mechanics UI (boards 752369f6, 0860fd78, UI half of 43ff2ae9, Title
// proposals; batch contract 2026-09-29). The API methods the panel calls (getOwnedEntries,
// requestSkillEvolution, requestClassMerge, evolutionReady, skipped/capReached, title proposals) were
// written in parallel, so both the contract shape and today's fallback (registry flag) are tested.
import test from "node:test";
import assert from "node:assert/strict";

import {
  activeErosion,
  collectOwnedEntries,
  describeAdvancedResult,
  describeErosion,
  describeLineage,
  evolutionReadiness,
  openRegistryPanel,
  ownedEntriesFromRegistry,
  readSelectedClassIds,
  renderRegistryContent
} from "../scripts/registry-ui.js";
import {
  buildProposalPatch,
  describeCapReached,
  describeSkippedProposal,
  describeSuggestResult,
  lineageSourceNames,
  prettifyEntryId,
  renderAfterAnalysis,
  renderGrowthContent,
  renderProposal,
  renderSuggestOutcome
} from "../scripts/growth-ui.js";
import { emptyRegistry, normalizeEntry, registerEntry } from "../scripts/lineage.js";

// A registry built with the real lineage.js writers: two Classes, a Skill evolved from another (the
// source now superseded), a red Skill and a Title.
function buildRegistry() {
  let registry = emptyRegistry();
  const add = (kind, entry, operation) => {
    const normalized = normalizeEntry(kind, entry, registry, operation);
    registry = registerEntry(kind, normalized, `item-${normalized.metadata.id}`, registry);
    return normalized.metadata.id;
  };
  const warden = add("class", { name: "Bridge Warden", level: 4, power_tier: "standard", mechanics: { effect: "Hold a choke point." }, metadata: { tags: ["defense"] } });
  const keeper = add("class", { name: "Innkeeper", level: 2, power_tier: "standard", mechanics: { effect: "Guests heal more." }, metadata: { tags: ["hospitality"] } });
  const grip = add("skill", { name: "Iron Grip", tier: 1, mechanics: { effect: "Advantage to hold on." }, metadata: { tags: ["martial"] } });
  const vise = add("skill", { name: "Vise of the Bridge", tier: 2, mechanics: { effect: "Grapple and pin." }, metadata: { tags: ["martial"], lineage: { operation: "upgrade", sources: [grip] } } });
  const cruel = add("skill", { name: "Twist the Knife", tier: 1, mechanics: { effect: "Extra damage to the helpless." }, metadata: { tags: ["martial"], polarity: "red", malignance: { vice: "cruelty", drawback: "Mercy costs you." } } });
  const title = add("title", { name: "Goblinbane", description: "Known on the Ember Road for the bridge.", achievement: "Held the bridge against six goblins." });
  // dev-integration marks an evolved source superseded; the panel reads either place it may land.
  registry.skills[grip].status = "superseded";
  registry.skills[grip].supersededBy = vise;
  return { registry, ids: { warden, keeper, grip, vise, cruel, title } };
}

test("ownedEntriesFromRegistry: every bucket, lineage kept, superseded read from the entry", () => {
  const { registry, ids } = buildRegistry();
  const owned = ownedEntriesFromRegistry(registry);
  assert.deepEqual(owned.classes.map((entry) => entry.name), ["Bridge Warden", "Innkeeper"]);
  assert.equal(owned.skills.length, 3);
  const grip = owned.skills.find((entry) => entry.id === ids.grip);
  assert.equal(grip.status, "superseded");
  assert.equal(grip.supersededBy, ids.vise);
  const vise = owned.skills.find((entry) => entry.id === ids.vise);
  assert.deepEqual(vise.lineage.sources, [ids.grip]);
  assert.equal(vise.status, "active");
  assert.equal(owned.skills.find((entry) => entry.id === ids.cruel).polarity, "red");
  assert.equal(owned.titles[0].achievement, "Held the bridge against six goblins.");
  assert.equal(owned.classes[0].level, 4);
  // Malformed input never throws.
  assert.deepEqual(ownedEntriesFromRegistry(null), { classes: [], skills: [], titles: [] });
  assert.deepEqual(ownedEntriesFromRegistry({ skills: { x: null } }).skills.length, 1);
});

test("collectOwnedEntries prefers api.getOwnedEntries, falls back to the registry flag", () => {
  const { registry } = buildRegistry();
  const fromFlag = collectOwnedEntries({ getActorRegistry: () => registry }, {});
  assert.equal(fromFlag.skills.length, 3);
  const contract = {
    getOwnedEntries: () => ({ classes: [{ id: "class:a", name: "A", kind: "class", level: 3, polarity: "standard", status: "active", lineage: null, effect: "Does A." }], skills: [], titles: [] }),
    getActorRegistry: () => { throw new Error("should not be read"); }
  };
  const owned = collectOwnedEntries(contract, {});
  assert.equal(owned.classes[0].effect, "Does A.");
  assert.equal(owned.classes[0].level, 3);
  // A throwing getOwnedEntries still renders from the flag.
  const broken = collectOwnedEntries({ getOwnedEntries: () => { throw new Error("boom"); }, getActorRegistry: () => registry }, {});
  assert.equal(broken.classes.length, 2);
});

test("lineage is shown by NAME, never by id; unknown ids are prettified", () => {
  const { registry, ids } = buildRegistry();
  const names = new Map([[ids.grip, "Iron Grip"]]);
  assert.equal(describeLineage({ operation: "upgrade", sources: [ids.grip] }, names), "Evolved from Iron Grip");
  assert.equal(describeLineage({ operation: "combine", sources: ["class:bridge-warden", "class:innkeeper"] }), "Merged from Bridge Warden + Innkeeper");
  assert.equal(describeLineage({ operation: "origin", sources: [] }), "");
  assert.deepEqual(lineageSourceNames({ sources: [{ id: "x", name: "Named" }, "skill:old-trick"] }), ["Named", "Old Trick"]);
  assert.equal(prettifyEntryId("Plain Name"), "Plain Name");
  const html = renderRegistryContent({ owned: ownedEntriesFromRegistry(registry), canEvolve: true, canMerge: true });
  assert.match(html, /Evolved from Iron Grip/);
  assert.doesNotMatch(html, /Evolved from skill:/);
});

test("renderRegistryContent: superseded dimmed without actions; Evolve highlighted when ready; merge checkboxes", () => {
  const { registry, ids } = buildRegistry();
  const owned = ownedEntriesFromRegistry(registry);
  const readiness = new Map([[ids.vise, { ready: true, pressure: "6/5" }], [ids.cruel, { ready: false, pressure: "1/5" }]]);
  const html = renderRegistryContent({ actorName: "Brakka", owned, readiness, canEvolve: true, canMerge: true, horrorRank: { points: 2, totalLevelsDocked: 0 } });
  const row = (id) => html.slice(html.indexOf(`data-entry-id="${id}"`), html.indexOf("</li>", html.indexOf(`data-entry-id="${id}"`)));
  assert.match(row(ids.grip), /superseded by Vise of the Bridge/);
  assert.match(html, new RegExp(`gd-owned gd-owned-skill gd-superseded" data-entry-id="${ids.grip}"`));
  assert.doesNotMatch(row(ids.grip), /gd-registry-evolve/, "a superseded Skill cannot evolve again");
  assert.match(row(ids.vise), /ready to evolve/);
  assert.match(row(ids.vise), /class="gd-action gd-primary gd-ready-action" data-action="gd-registry-evolve" data-entry-id="skill:vise-of-the-bridge"/);
  assert.match(row(ids.cruel), /data-action="gd-registry-evolve"/);
  assert.doesNotMatch(row(ids.cruel), /gd-ready-action/);
  assert.match(row(ids.cruel), /red: cruelty/);
  assert.match(html, /name="gd-merge-class" value="class:bridge-warden"/);
  assert.match(html, /data-action="gd-registry-merge" aria-busy="false" title=/, "merge enabled with 2 active Classes");
  assert.match(html, /Goblinbane/);
  assert.match(html, /Horror Rank 2/);
  assert.match(html, /Coming soon/);
  assert.match(html, /disabled title="Coming soon/);
  // Superseded rows sort after active ones.
  assert.ok(html.indexOf(`data-entry-id="${ids.vise}"`) < html.indexOf(`data-entry-id="${ids.grip}"`));
});

test("renderRegistryContent without the new API: Evolve/Merge render disabled with a reason", () => {
  const { registry } = buildRegistry();
  const html = renderRegistryContent({ owned: ownedEntriesFromRegistry(registry), canEvolve: false, canMerge: false });
  assert.match(html, /data-action="gd-registry-evolve" data-entry-id="skill:vise-of-the-bridge" aria-busy="false" disabled title="This Grand Design version cannot evolve/);
  assert.match(html, /data-action="gd-registry-merge" aria-busy="false" disabled title="This Grand Design version cannot merge/);
  assert.doesNotMatch(html, /gd-merge-class/);
  const busy = renderRegistryContent({ owned: ownedEntriesFromRegistry(registry), canEvolve: true, canMerge: true, busy: true });
  assert.match(busy, /gd-busy-notice/);
  assert.match(busy, /data-action="gd-registry-evolve" data-entry-id="skill:vise-of-the-bridge" aria-busy="false" disabled/);
  const empty = renderRegistryContent({ canMerge: true });
  assert.match(empty, /No Classes yet/);
  assert.match(empty, /Merging needs two or more active Classes/);
});

test("erosion: only active Classes, described in plain words, shown in the panel", () => {
  const { registry, ids } = buildRegistry();
  registry.classes[ids.keeper].status = "superseded";
  const api = {
    getActorRegistry: () => registry,
    checkClassErosion: () => [
      { classId: ids.warden, name: "Bridge Warden", tags: ["defense"], sessionsSinceLastSeen: 3, neverSeen: false },
      { classId: ids.keeper, name: "Innkeeper", tags: ["hospitality"], sessionsSinceLastSeen: 4, neverSeen: true }
    ]
  };
  const atRisk = activeErosion(api, {});
  assert.deepEqual(atRisk.map((risk) => risk.name), ["Bridge Warden"]);
  assert.equal(describeErosion(atRisk[0]), "No deed matching its tags (defense) in the last 3 sessions.");
  assert.match(describeErosion({ tags: [], sessionsSinceLastSeen: 1, neverSeen: true }), /No recorded deed has matched its tags yet, across 1 session\./);
  const html = renderRegistryContent({ owned: ownedEntriesFromRegistry(registry), erosion: atRisk });
  assert.match(html, /Classes at risk of erosion/);
  assert.match(html, /gd-at-risk/);
  assert.deepEqual(activeErosion({}, {}), [], "no checkClassErosion: nothing, no throw");
});

test("evolutionReadiness merges checkSkillEvolutionReadiness with the last result's evolutionReady", () => {
  const api = {
    checkSkillEvolutionReadiness: () => [
      { skillId: "skill:a", name: "A", evidenceWeight: 6.5, evidenceThreshold: 5, hasCatalyst: true, definingMoments: [{}] },
      { skillId: "skill:b", name: "B", evidenceWeight: 1, evidenceThreshold: 5, hasCatalyst: false, definingMoments: [] }
    ]
  };
  const map = evolutionReadiness(api, {}, { evolutionReady: [{ skillId: "skill:c", name: "C", pressure: 7.25 }] });
  assert.deepEqual(map.get("skill:a"), { ready: true, pressure: "6.5/5", definingMoments: 1 });
  assert.equal(map.get("skill:b").ready, false);
  assert.equal(map.get("skill:c").ready, true);
  assert.equal(map.get("skill:c").pressure, "7.25");
  assert.equal(evolutionReadiness({ checkSkillEvolutionReadiness: () => { throw new Error("x"); } }, {}).size, 0);
});

test("describeAdvancedResult states a fallback with its reason", () => {
  const proposal = { id: "proposal:vise", entry: { name: "Vise of the Bridge" } };
  assert.deepEqual(describeAdvancedResult({ proposal, usedFallback: false }, "evolve").level, "info");
  assert.match(describeAdvancedResult({ proposal }, "evolve").message, /Vise of the Bridge is pending in the Growth dialog/);
  const fallback = describeAdvancedResult({ proposal, usedFallback: true, reason: "the model timed out" }, "merge");
  assert.equal(fallback.level, "warn");
  assert.match(fallback.message, /could not write the merged Class \(the model timed out\); the built-in rules proposed Vise of the Bridge/);
  assert.equal(describeAdvancedResult(null).level, "warn");
});

test("readSelectedClassIds reads the ticked boxes once each", () => {
  const root = { querySelectorAll: () => [{ value: "class:a" }, { value: "class:b" }, { value: "class:a" }, { value: "" }] };
  assert.deepEqual(readSelectedClassIds(root), ["class:a", "class:b"]);
  assert.deepEqual(readSelectedClassIds(null), []);
});

// --- Suggest: why nothing (or fewer) appeared (43ff2ae9) ------------------------------------------

test("describeSkippedProposal: contract and legacy shapes", () => {
  assert.equal(describeSkippedProposal({ name: "Athletics: Iron Grip", reason: "duplicate" }), "already pending: Athletics: Iron Grip");
  assert.equal(describeSkippedProposal({ name: "Iron Hold", reason: "near-duplicate", duplicateOf: "Iron Grip" }), "too close to a pending one: Iron Hold (same as Iron Grip)");
  assert.equal(describeSkippedProposal({ name: "Rage", reason: "class-feature", duplicateOf: "Rage" }), "duplicates a class feature: Rage");
  assert.equal(describeSkippedProposal({ proposal: { entry: { name: "Old Trick" } }, reason: "rejected", errors: ["The GM already rejected..."] }), "you rejected it before: Old Trick");
  assert.equal(describeSkippedProposal({ proposal: { entry: { name: "X" } }, reason: "validation", errors: ["tier must be 1-3"] }), "X: tier must be 1-3");
  assert.equal(describeSkippedProposal(null), "");
});

test("describeSuggestResult explains 0 new from capReached and skipped", () => {
  const capped = describeSuggestResult({ added: [], capReached: { pending: 5, cap: 5 }, skipped: [] });
  assert.equal(capped.level, "warn");
  assert.equal(capped.message, "5 proposals are already pending -- approve or reject some first.");
  const dup = describeSuggestResult({ added: [], skipped: [{ name: "Athletics: Iron Grip", reason: "duplicate" }], capReached: null });
  assert.match(dup.message, /^Nothing new was added\. Skipped: already pending: Athletics: Iron Grip\.$/);
  const some = describeSuggestResult({ added: [{}], skipped: [{ name: "A", reason: "owned" }] });
  assert.equal(some.level, "info");
  assert.match(some.message, /1 new proposal .* Skipped: already owned: A\./);
  assert.match(describeSuggestResult({ added: 0 }).message, /found nothing new/, "the old message stays when there is no reason");
  assert.equal(describeCapReached(null), "");
  assert.equal(describeCapReached({ pending: 1, cap: 5 }), "1 proposal is already pending -- approve or reject some first.");
});

test("renderSuggestOutcome keeps the reasons under the button after the toast", () => {
  const html = renderSuggestOutcome({ capReached: { pending: 5, cap: 5 }, skipped: [{ name: "Iron <Grip>", reason: "duplicate" }] });
  assert.match(html, /Last suggestion:<\/strong> 5 proposals are already pending/);
  assert.match(html, /already pending: Iron &lt;Grip&gt;/);
  assert.equal(renderSuggestOutcome({ skipped: [], capReached: null }), "");
  assert.equal(renderSuggestOutcome(null), "");
});

// --- Titles and lineage in proposal rows ------------------------------------------------------------

const titleProposal = {
  id: "proposal:goblinbane",
  status: "pending",
  kind: "title",
  source: "ai-gateway",
  evidence: [],
  rationale: "\"Brakka held the bridge against six goblins.\"",
  entry: { name: "Goblinbane", description: "Known on the Ember Road for the bridge.", tags: ["defense"], metadata: { polarity: "standard" } }
};

test("a Title proposal renders a Title chip, its description and the deed; no Author button", () => {
  const html = renderProposal(titleProposal, { canEdit: true });
  assert.match(html, /gd-title-chip[^>]*>Title</);
  assert.match(html, /Known on the Ember Road for the bridge\./);
  assert.match(html, /<dt>Kind<\/dt><dd>Title<\/dd>/);
  assert.match(html, /<dt>Description<\/dt>/);
  assert.match(html, /<dt>Deed<\/dt><dd>&quot;Brakka held the bridge/);
  assert.doesNotMatch(html, /<dt>Tier<\/dt>/);
  assert.doesNotMatch(html, /gd-author-proposal/);
  assert.match(html, /gd-approve-proposal/);
  assert.match(html, /gd-reject-proposal/);
  assert.match(html, /data-field="description"/, "the edit form edits the description");
  assert.doesNotMatch(html, /data-field="tier"/);
});

test("Title edit patch: description required, no mechanics invented", () => {
  const { patch, errors } = buildProposalPatch(titleProposal, { name: "Goblin-Bane", description: "Feared by goblins." });
  assert.deepEqual(errors, []);
  assert.equal(patch.entry.name, "Goblin-Bane");
  assert.equal(patch.entry.description, "Feared by goblins.");
  assert.equal(patch.entry.mechanics, undefined);
  assert.match(buildProposalPatch(titleProposal, { description: " " }).errors[0], /needs a description/);
});

test("an evolve/merge proposal names its sources and opens when focused", () => {
  const evolved = {
    id: "proposal:vise",
    status: "pending",
    kind: "skill",
    source: "ai-gateway",
    evidence: [],
    entry: { name: "Vise of the Bridge", tier: 2, mechanics: { effect: "Pin." }, metadata: { tags: [], lineage: { operation: "upgrade", sources: ["skill:iron-grip"], rationale: "" } } }
  };
  const names = new Map([["skill:iron-grip", "Iron Grip"]]);
  const html = renderProposal(evolved, { namesById: names, focusProposalId: "proposal:vise" });
  assert.match(html, /gd-lineage[^>]*>evolves Iron Grip</);
  assert.match(html, /<dt>Evolves<\/dt><dd>Iron Grip<\/dd>/);
  assert.match(html, /class="gd-proposal gd-focus"/);
  assert.match(html, /<details class="gd-proposal-details" open>/);
  const merged = { ...evolved, kind: "class", entry: { ...evolved.entry, metadata: { lineage: { operation: "combine", sources: ["class:bridge-warden", "class:innkeeper"] } } } };
  assert.match(renderProposal(merged), /merges Bridge Warden \+ Innkeeper/);
  assert.doesNotMatch(renderProposal(evolved), /gd-focus/);
});

test("after an analysis: ready-to-evolve Skills and at-risk Classes", () => {
  const html = renderAfterAnalysis(
    { evolutionReady: [{ skillId: "skill:iron-grip", name: "Iron Grip", pressure: 6.4 }] },
    [{ classId: "class:innkeeper", name: "Innkeeper", tags: ["hospitality"], sessionsSinceLastSeen: 3 }],
    { canEvolve: true }
  );
  assert.match(html, /Iron Grip<\/strong> is ready to evolve/);
  assert.match(html, /data-action="gd-evolve-skill" data-entry-id="skill:iron-grip"/);
  assert.match(html, /Classes at risk of erosion/);
  assert.match(html, /Innkeeper<\/strong>: No deed matching its tags \(hospitality\) in the last 3 sessions/);
  assert.doesNotMatch(renderAfterAnalysis({ evolutionReady: [{ skillId: "s", name: "S" }] }, [], { canEvolve: false }), /gd-evolve-skill/);
  assert.equal(renderAfterAnalysis(null, []), "");
  const content = renderGrowthContent({ growth: { events: [], proposals: [] }, progression: {}, pending: [], lastResult: { events: [], evolutionReady: [] }, erosion: [{ classId: "c", name: "Hero", sessionsSinceLastSeen: 2 }], status: { kind: "ai" } });
  assert.match(content, /Classes at risk of erosion/);
  assert.match(content, /data-action="gd-open-registry"/);
});

// --- The panel in a fake Foundry, both systems ------------------------------------------------------

function fakeButton(action, { entryId } = {}) {
  const attrs = {};
  const label = { textContent: "Label", dataset: {} };
  const icon = { className: "fas fa-dna", dataset: {} };
  return {
    disabled: false,
    dataset: { action, ...(entryId ? { entryId } : {}) },
    attrs,
    label,
    icon,
    setAttribute: (k, v) => { attrs[k] = v; },
    querySelector: (sel) => (sel === ".gd-btn-label" ? label : sel === "i" ? icon : null),
    closest(sel) { return sel === "[data-action]" ? this : null; }
  };
}

function withFoundry(api, run, { checked = [] } = {}) {
  const saved = { game: globalThis.game, ui: globalThis.ui, Dialog: globalThis.Dialog };
  const notes = [];
  const dialogs = [];
  const { registry } = buildRegistry();
  const base = {
    getActorRegistry: () => registry,
    getGrowth: () => ({ events: [], proposals: [] }),
    getLevelProgression: () => ({ level: 4, progress: 0, grantAllowances: 0 }),
    getLastAnalysis: () => null,
    getGatewayConfig: () => ({ provider: "ollama", model: "qwen3.8:27b" }),
    hasProposalAdapter: () => true,
    checkClassErosion: () => [],
    checkSkillEvolutionReadiness: () => [],
    ...api
  };
  globalThis.game = { modules: { get: () => ({ api: base }) } };
  const notify = (level) => (message) => notes.push({ level, message });
  globalThis.ui = { notifications: { info: notify("info"), warn: notify("warn"), error: notify("error") } };
  globalThis.Dialog = class {
    constructor(data, options) { this.data = data; this.options = options; this.closed = false; dialogs.push(this); }
    render() {
      const buttons = [];
      const form = { busy: false, classList: { toggle: (_cls, on) => { form.busy = on; } } };
      let listener = null;
      this.buttons = buttons;
      this.form = form;
      this.root = {
        closest: () => null,
        querySelector: (sel) => (sel === ".grand-design-registry" || sel === ".grand-design-growth" ? form : sel.startsWith("textarea") ? { value: "" } : null),
        querySelectorAll: (sel) => (sel.includes(":checked") ? checked.map((value) => ({ value })) : buttons),
        addEventListener: (type, fn) => { if (type === "click") listener = fn; }
      };
      this.click = (button) => {
        if (!buttons.includes(button)) buttons.push(button);
        return listener?.({ target: { closest: () => button }, preventDefault() {} });
      };
      this.data.render?.([this.root]);
      return this;
    }
    close() { this.closed = true; }
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  return Promise.resolve(run({ notes, dialogs, tick })).finally(() => Object.assign(globalThis, saved));
}

for (const systemId of ["pf2e", "dnd5e"]) {
  const actor = { name: systemId === "pf2e" ? "Buck" : "Brakka", system: { id: systemId } };

  test(`[${systemId}] panel Evolve: busy in the body, then the Growth dialog opens on the pending proposal`, async () => {
    let release;
    const calls = [];
    const proposal = { id: "proposal:vise-2", status: "pending", kind: "skill", source: "ai-gateway", evidence: [], entry: { name: "Vise Eternal", tier: 3, mechanics: { effect: "Pin harder." }, metadata: { lineage: { operation: "upgrade", sources: ["skill:vise-of-the-bridge"] } } } };
    await withFoundry({
      requestSkillEvolution: (...args) => { calls.push(args); return new Promise((resolve) => { release = resolve; }); },
      getGrowth: () => ({ events: [], proposals: [proposal] })
    }, async ({ notes, dialogs, tick }) => {
      const panel = openRegistryPanel(actor);
      assert.match(panel.data.title, new RegExp(`Registry: ${actor.name}`));
      assert.match(panel.data.content, /Evolved from Iron Grip/);
      const evolve = fakeButton("gd-registry-evolve", { entryId: "skill:vise-of-the-bridge" });
      const merge = fakeButton("gd-registry-merge");
      panel.buttons.push(merge);
      panel.click(evolve);
      panel.click(evolve);
      assert.equal(calls.length, 1, "a double click evolves once");
      assert.deepEqual(calls[0], [actor, "skill:vise-of-the-bridge"]);
      assert.equal(evolve.disabled, true);
      assert.equal(merge.disabled, true, "other panel actions lock");
      assert.equal(evolve.label.textContent, "The AI is evolving it...");
      assert.equal(panel.form.busy, true);
      release({ proposal, usedFallback: false });
      await tick();
      await tick();
      assert.equal(panel.closed, true);
      assert.equal(dialogs.length, 2);
      const growth = dialogs[1].data.content;
      assert.match(dialogs[1].data.title, /Grand Design Growth/);
      assert.match(growth, /class="gd-proposal gd-focus" data-proposal-id="proposal:vise-2"/);
      assert.match(growth, /evolves Vise of the Bridge/, "source named, not its id");
      assert.equal(notes[0].level, "info");
    });
  });

  test(`[${systemId}] panel Merge sends the ticked Classes; fewer than two warns; a fallback is stated`, async () => {
    const calls = [];
    const proposal = { id: "proposal:merged", status: "pending", kind: "class", source: "class-evolution", usedFallback: true, evidence: [], entry: { name: "Warden of the Hearth", level: 5, mechanics: { effect: "Both." }, metadata: { lineage: { operation: "combine", sources: ["class:bridge-warden", "class:innkeeper"] } } } };
    await withFoundry({ requestClassMerge: async (...args) => { calls.push(args); return { proposal, usedFallback: true, reason: "no AI provider attached" }; } }, async ({ notes, dialogs, tick }) => {
      const panel = openRegistryPanel(actor);
      panel.click(fakeButton("gd-registry-merge"));
      await tick();
      await tick();
      assert.deepEqual(calls, [[actor, ["class:bridge-warden", "class:innkeeper"]]]);
      assert.equal(notes[0].level, "warn");
      assert.match(notes[0].message, /no AI provider attached/);
      assert.equal(dialogs.length, 2);
    }, { checked: ["class:bridge-warden", "class:innkeeper"] });
    calls.length = 0;
    await withFoundry({ requestClassMerge: async (...args) => { calls.push(args); } }, async ({ notes, dialogs, tick }) => {
      const panel = openRegistryPanel(actor);
      const merge = fakeButton("gd-registry-merge");
      panel.click(merge);
      await tick();
      assert.deepEqual(calls, []);
      assert.match(notes[0].message, /Tick two or more Classes/);
      assert.equal(dialogs.length, 1, "the panel stays open");
      assert.equal(merge.disabled, false);
    }, { checked: ["class:bridge-warden"] });
  });

  test(`[${systemId}] panel: an API error is reported and the panel reopens; busy lock is a warning`, async () => {
    await withFoundry({ requestSkillEvolution: async () => { throw new Error("busy: analyzing notes."); } }, async ({ notes, dialogs, tick }) => {
      const panel = openRegistryPanel(actor);
      panel.click(fakeButton("gd-registry-evolve", { entryId: "skill:vise-of-the-bridge" }));
      await tick();
      assert.equal(notes[0].level, "warn");
      assert.match(notes[0].message, /still working on this character/);
      assert.match(dialogs[1].data.title, /Registry/);
    });
  });

  test(`[${systemId}] Growth dialog: the Registry button opens the panel; Suggest keeps its reasons`, async () => {
    const { openGrowthManager } = await import("../scripts/growth-ui.js");
    await withFoundry({
      requestGrowthProposals: async () => ({ proposals: [], added: [], skipped: [{ name: "Iron Grip", reason: "duplicate" }], capReached: { pending: 5, cap: 5 } })
    }, async ({ notes, dialogs, tick }) => {
      openGrowthManager(actor);
      dialogs[0].click(fakeButton("gd-open-registry"));
      assert.equal(dialogs.length, 2);
      assert.match(dialogs[1].data.title, /Registry/);
      // Suggest from the growth dialog (delegated handler skips it; call its direct listener path).
      openGrowthManager(actor);
      const growth = dialogs[2];
      const handlers = [];
      growth.root.querySelectorAll = () => [{ addEventListener: (_t, fn) => handlers.push(fn), disabled: false, dataset: {}, setAttribute() {}, querySelector: () => null }];
      growth.data.render([growth.root]);
      handlers[0]({ preventDefault() {} });
      await tick();
      await tick();
      assert.match(notes.at(-1).message, /5 proposals are already pending -- approve or reject some first\. Skipped: already pending: Iron Grip\./);
      assert.match(dialogs.at(-1).data.content, /Last suggestion:/);
      assert.match(dialogs.at(-1).data.content, /already pending: Iron Grip/);
    });
  });

  test(`[${systemId}] Growth dialog: Evolve from the after-analysis callout focuses the new proposal`, async () => {
    const { openGrowthManager } = await import("../scripts/growth-ui.js");
    const proposal = { id: "proposal:evolved", status: "pending", kind: "skill", source: "ai-gateway", evidence: [], entry: { name: "Grip of Ages", tier: 2, mechanics: { effect: "x" }, metadata: {} } };
    const calls = [];
    await withFoundry({
      requestSkillEvolution: async (...args) => { calls.push(args); return { proposal }; },
      getGrowth: () => ({ events: [], proposals: [proposal] })
    }, async ({ dialogs, tick }) => {
      openGrowthManager(actor, { lastResult: { events: [], evolutionReady: [{ skillId: "skill:vise-of-the-bridge", name: "Vise of the Bridge" }] } });
      assert.match(dialogs[0].data.content, /data-action="gd-evolve-skill" data-entry-id="skill:vise-of-the-bridge"/);
      dialogs[0].click(fakeButton("gd-evolve-skill", { entryId: "skill:vise-of-the-bridge" }));
      await tick();
      await tick();
      assert.deepEqual(calls, [[actor, "skill:vise-of-the-bridge"]]);
      assert.match(dialogs[1].data.content, /gd-proposal gd-focus" data-proposal-id="proposal:evolved"/);
    });
  });
}
