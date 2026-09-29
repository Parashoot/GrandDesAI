import test from "node:test";
import assert from "node:assert/strict";

import {
  buildProposalPatch,
  describeActionError,
  describeRetryResult,
  isTemplateMilestone,
  openGrowthManager,
  readEditFields,
  renderGrowthContent,
  renderProposal
} from "../scripts/growth-ui.js";
import { generateCapstoneProposal, generateClassEvolutionProposal } from "../scripts/progression.js";

// Boards a0bcfd05 (inspect/edit, per-row Approve), 283ad7ca (Approve as written), b375d56c (Retry
// with AI on template milestones), 78ead05c (long actions in the body with a busy state).

const events = [
  { id: "e1", actorName: "Brakka", summary: "Brakka held the bridge against six goblins.", outcome: "success", tags: ["defense"], themes: [] },
  { id: "e2", actorName: "Brakka", summary: "Brakka shoved the chieftain into the river.", outcome: "criticalSuccess", tags: ["defense", "martial"], themes: [] }
];
const aiProposal = {
  id: "proposal:bridge-warden",
  status: "pending",
  kind: "skill",
  source: "ai-gateway",
  evidence: ["e1", "e2"],
  entry: {
    name: "Bridge Warden",
    tier: 2,
    system_equivalent: "Reaction feat",
    gameItem: { kind: "reaction" },
    mechanics: {
      effect: "When an enemy moves adjacent, make a Shove against it.",
      actions: 1,
      trigger: "An enemy enters a square adjacent to you.",
      frequency: { max: 1, per: "round" },
      duration: "instant",
      roll: { kind: "Athletics check", formula: "1d20+7", dc: 18 }
    },
    metadata: {
      tags: ["defense", "martial"],
      polarity: "red",
      malignance: { vice: "wrath", drawback: "You cannot willingly retreat while it is active." },
      lineage: { operation: "origin", sources: [], rationale: "Held a choke point twice in one fight." }
    }
  }
};
const placeholder = {
  id: "proposal:theme-beekeeping",
  status: "pending",
  kind: "skill",
  source: "emergent",
  theme: "beekeeping",
  needsAuthoring: true,
  evidence: ["e1"],
  entry: { name: "Beekeeping Knack", tier: 1, mechanics: { effect: "Something about bees." }, metadata: { tags: [] } }
};
const byId = new Map(events.map((event) => [event.id, event]));
const actionsOf = (html) => [...html.matchAll(/data-action="([^"]+)"/g)].map((match) => match[1]);

test("a pending AI proposal: per-row Approve + Reject, full Details, no Author", () => {
  const html = renderProposal(aiProposal, { eventsById: byId });
  assert.deepEqual(actionsOf(html), ["gd-approve-proposal", "gd-reject-proposal"]);
  assert.match(html, /data-action="gd-approve-proposal" data-proposal-id="proposal:bridge-warden"/);
  assert.match(html, /type="button" class="gd-action gd-primary" data-action="gd-approve-proposal"/);
  assert.match(html, /<details class="gd-proposal-details">/);
  for (const text of ["Skill", "Written by the AI", "Reaction feat", "An enemy enters a square adjacent to you.", "1 per round", "Athletics check 1d20+7 DC 18", "defense, martial", "red (taboo)", "wrath", "You cannot willingly retreat", "Held a choke point twice in one fight.", "Brakka shoved the chieftain into the river."]) {
    assert.ok(html.includes(text), `details show: ${text}`);
  }
  assert.match(html, /gd-chip gd-red[^>]*>red: wrath/);
  assert.doesNotMatch(html, /gd-proposal-edit/, "no Edit form without api.updateProposal");
});

test("with api.updateProposal the row has an Edit form prefilled from the entry", () => {
  const html = renderProposal(aiProposal, { canEdit: true });
  assert.match(html, /<details class="gd-proposal-edit">/);
  assert.match(html, /<div class="gd-edit-form" data-proposal-id="proposal:bridge-warden">/);
  assert.match(html, /data-field="name" value="Bridge Warden"/);
  assert.match(html, /<option value="2" selected>2<\/option>/);
  assert.match(html, /data-field="tags" value="defense, martial"/);
  assert.match(html, /data-field="effect" rows="3">When an enemy moves adjacent/);
  assert.match(html, /data-action="gd-save-proposal" data-proposal-id="proposal:bridge-warden"/);
  assert.match(html, /class="gd-edit-errors"/);
  // Class proposals edit level / power tier / chassis instead of tier / system equivalent.
  const cls = renderProposal({ ...aiProposal, kind: "class", entry: { name: "Warden", level: 5, power_tier: "elevated", system_chassis: "Fighter", mechanics: { effect: "x" } } }, { canEdit: true });
  assert.match(cls, /data-field="level" value="5"/);
  assert.match(cls, /<option value="elevated" selected>/);
  assert.doesNotMatch(cls, /data-field="tier"/);
});

test("approved/rejected proposals render read-only", () => {
  for (const status of ["approved", "rejected"]) {
    const html = renderProposal({ ...aiProposal, status }, { canEdit: true, canRetry: true });
    assert.deepEqual(actionsOf(html), [], status);
    assert.match(html, /gd-proposal-details/);
  }
});

test("a placeholder offers Author with AI and Approve as written, never a bare Approve", () => {
  const html = renderProposal(placeholder);
  assert.deepEqual(actionsOf(html), ["gd-author-proposal", "gd-approve-as-written", "gd-reject-proposal"]);
  assert.match(html, /Approve as written/);
  // No AI: Author is disabled with the reason; Approve as written still works.
  const offline = renderProposal(placeholder, { aiAttached: false });
  assert.match(offline, /data-action="gd-author-proposal"[^>]*disabled title="Needs an AI provider/);
  assert.doesNotMatch(offline, /data-action="gd-approve-as-written"[^>]*disabled/);
});

test("a tag template can be authored by the AI; an AI proposal cannot", () => {
  const template = { ...aiProposal, source: "template", entry: { ...aiProposal.entry, metadata: { tags: ["defense"] } } };
  assert.deepEqual(actionsOf(renderProposal(template)), ["gd-approve-proposal", "gd-author-proposal", "gd-reject-proposal"]);
});

for (const systemId of ["pf2e", "dnd5e"]) {
  test(`[${systemId}] template milestones offer Retry with AI; AI-written ones do not`, () => {
    const capstone = generateCapstoneProposal(20, events, {}, 4, { systemId });
    const classEvolution = generateClassEvolutionProposal(20, events, {}, 4, { systemId, actorLevel: 7 });
    for (const proposal of [capstone, classEvolution, { ...capstone, usedFallback: true, fallbackReason: "no AI provider is configured" }]) {
      assert.equal(isTemplateMilestone(proposal), true, proposal.id);
      const html = renderProposal(proposal, { canRetry: true });
      assert.deepEqual(actionsOf(html), ["gd-approve-proposal", "gd-retry-milestone", "gd-reject-proposal"], proposal.id);
      assert.match(html, new RegExp(`data-action="gd-retry-milestone" data-proposal-id="${proposal.id}"`));
      // Before dev-integration's retryMilestoneReward lands, the older Author path is offered instead.
      assert.deepEqual(actionsOf(renderProposal(proposal, { canRetry: false })), ["gd-approve-proposal", "gd-author-proposal", "gd-reject-proposal"]);
    }
    const aiCapstone = { ...capstone, authoredBy: "ai-gateway" };
    assert.equal(isTemplateMilestone(aiCapstone), false);
    assert.doesNotMatch(renderProposal(aiCapstone, { canRetry: true }), /gd-retry-milestone/);
    assert.equal(isTemplateMilestone(aiProposal), false);
    // The capstone's details read in the right system's terms.
    const details = renderProposal(capstone, { eventsById: byId });
    assert.match(details, systemId === "dnd5e" ? /with advantage and a \+2 bonus/ : /\+4 circumstance bonus/);
    assert.match(details, /Milestone capstone/);
    assert.match(details, /<dt>Tier<\/dt><dd>3<\/dd>/);
    const fallbackDetails = renderProposal({ ...capstone, usedFallback: true, fallbackReason: "timeout" });
    assert.match(fallbackDetails, /Fallback reason<\/dt><dd>timeout/);
  });
}

test("busy: every action renders disabled with a notice", () => {
  const html = renderGrowthContent({
    growth: { events },
    progression: { level: 3, progress: 10, grantAllowances: 1 },
    pending: [aiProposal, placeholder],
    lastAnalysis: { notes: "x", at: "2026-09-29T10:00:00Z" },
    status: { kind: "ai", text: "AI", title: "" },
    canEdit: true,
    busy: true
  });
  assert.match(html, /class="gd-busy-notice"/);
  const buttons = [...html.matchAll(/<button[^>]*>/g)].map((match) => match[0]);
  assert.ok(buttons.length >= 9);
  for (const button of buttons) assert.match(button, / disabled/, button);
});

test("the dialog body has Analyze, Re-analyze (only with last notes) and Resolve Rest; no Approve select", () => {
  const base = { growth: { events }, progression: { level: 3, grantAllowances: 0 }, pending: [aiProposal], status: { kind: "ai", text: "AI", title: "" } };
  const html = renderGrowthContent({ ...base, lastAnalysis: { notes: "x", at: "2026-09-29T10:00:00Z" } });
  for (const action of ["gd-analyze", "gd-reanalyze", "gd-rest", "gd-approve-proposal", "gd-reject-proposal"]) assert.match(html, new RegExp(`data-action="${action}"`), action);
  assert.doesNotMatch(html, /name="growth-proposal"/);
  assert.doesNotMatch(renderGrowthContent(base), /gd-reanalyze/);
  // Every body button is type="button" so none of them submits the dialog form.
  for (const button of html.matchAll(/<button[^>]*>/g)) assert.match(button[0], /type="button"/);
});

test("escaping holds in details and the edit form", () => {
  const evil = '<img src=x onerror="alert(1)">';
  const html = renderProposal({ ...aiProposal, id: `"><b>`, entry: { ...aiProposal.entry, name: evil, mechanics: { effect: evil, trigger: evil }, metadata: { tags: [evil], lineage: { rationale: evil } } } }, { canEdit: true });
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<b>/);
});

test("malformed proposals do not throw", () => {
  for (const bad of [null, {}, { id: "x", status: "pending" }, { id: "y", status: "pending", entry: "nope", evidence: "e1" }]) {
    assert.doesNotThrow(() => renderProposal(bad, { canEdit: true, canRetry: true }));
  }
});

test("buildProposalPatch applies edits and keeps everything the form does not show", () => {
  const { patch, errors } = buildProposalPatch(aiProposal, {
    name: "  Bridge Keeper ", tier: "3", system_equivalent: "Reaction feat", actions: "", trigger: "", duration: "1 round",
    effect: "Shove an enemy that steps adjacent.", tags: "defense, martial, defense,  ", rationale: "Twice at the bridge."
  });
  assert.deepEqual(errors, []);
  const entry = patch.entry;
  assert.equal(entry.name, "Bridge Keeper");
  assert.equal(entry.tier, 3);
  assert.equal(entry.mechanics.effect, "Shove an enemy that steps adjacent.");
  assert.equal(entry.mechanics.duration, "1 round");
  assert.ok(!("actions" in entry.mechanics), "an emptied optional field is removed");
  assert.ok(!("trigger" in entry.mechanics));
  assert.deepEqual(entry.metadata.tags, ["defense", "martial"]);
  assert.equal(entry.metadata.lineage.rationale, "Twice at the bridge.");
  assert.deepEqual(entry.mechanics.roll, aiProposal.entry.mechanics.roll, "roll kept");
  assert.deepEqual(entry.gameItem, { kind: "reaction" }, "gameItem kept");
  assert.equal(entry.metadata.malignance.vice, "wrath", "red cost kept");
  assert.equal(aiProposal.entry.name, "Bridge Warden", "the original is not mutated");
});

test("buildProposalPatch catches the obvious mistakes before the API is called", () => {
  assert.deepEqual(buildProposalPatch(aiProposal, { name: " ", effect: "" }).errors.length, 2);
  assert.match(buildProposalPatch(aiProposal, { tier: "4" }).errors[0], /Tier must be 1, 2 or 3/);
  assert.match(buildProposalPatch(aiProposal, { actions: "5" }).errors[0], /Actions/);
  const capstone = generateCapstoneProposal(10, events, {}, 2, { systemId: "dnd5e" });
  assert.match(buildProposalPatch(capstone, { tier: "2" }).errors[0], /capstone is always tier 3/);
  const cls = generateClassEvolutionProposal(20, events, {}, 2, { systemId: "pf2e", actorLevel: 7 });
  assert.match(buildProposalPatch(cls, { level: "0" }).errors[0], /Class level/);
  assert.match(buildProposalPatch(cls, { power_tier: "godlike" }).errors[0], /Power tier/);
  const ok = buildProposalPatch(cls, { level: "8", power_tier: "elevated" });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.patch.entry.level, 8);
  assert.equal(ok.patch.entry.power_tier, "elevated");
});

test("readEditFields reads [data-field] inputs", () => {
  const node = (field, value) => ({ dataset: { field }, value });
  assert.deepEqual(readEditFields({ querySelectorAll: () => [node("name", "A"), node("tier", "2"), { dataset: {}, value: "x" }] }), { name: "A", tier: "2" });
  assert.deepEqual(readEditFields(null), {});
});

test("describeActionError: a busy lock is a friendly warning, anything else an error", () => {
  assert.deepEqual(describeActionError(new Error("busy: analyzing notes for Brakka.")), {
    level: "warn",
    message: "Grand Design is still working on this character: analyzing notes for Brakka. Try again when it finishes."
  });
  assert.equal(describeActionError(new Error("busy:")).level, "warn");
  assert.deepEqual(describeActionError(new Error("No pending skill proposal exists for x.")), { level: "error", message: "No pending skill proposal exists for x." });
  assert.equal(describeActionError(undefined).level, "error");
});

test("describeRetryResult", () => {
  assert.equal(describeRetryResult({ proposal: { entry: { name: "Ember Crown" } }, usedFallback: false }).level, "info");
  const fell = describeRetryResult({ proposal: { entry: { name: "Capstone: Defense" } }, usedFallback: true, reason: "timeout" });
  assert.equal(fell.level, "warn");
  assert.match(fell.message, /Capstone: Defense \(timeout\); the template stays/);
  assert.equal(describeRetryResult({ entry: { name: "Bare" }, usedFallback: true }).level, "warn");
  assert.doesNotThrow(() => describeRetryResult(null));
});

// ---- dialog wiring: a fake Dialog v1 and a fake DOM with a delegated root listener --------------

function fakeButton(action, proposalId) {
  const attrs = {};
  const label = { textContent: "Label", dataset: {} };
  const icon = { className: "fas fa-check", dataset: {} };
  return {
    disabled: false,
    dataset: { action, ...(proposalId ? { proposalId } : {}) },
    attrs,
    label,
    icon,
    form: null,
    setAttribute: (k, v) => { attrs[k] = v; },
    querySelector: (sel) => (sel === ".gd-btn-label" ? label : sel === "i" ? icon : null),
    closest(sel) { return sel === "[data-action]" ? this : sel === ".gd-edit-form" ? this.form : null; }
  };
}

function withFoundry(api, run, { confirm = true, textarea = "typed notes" } = {}) {
  const saved = { game: globalThis.game, ui: globalThis.ui, Dialog: globalThis.Dialog };
  const notes = [];
  const dialogs = [];
  const confirms = [];
  const base = {
    getGrowth: () => ({ events, proposals: [aiProposal, placeholder] }),
    getLevelProgression: () => ({ level: 3, progress: 10, grantAllowances: 2 }),
    getLastAnalysis: () => ({ notes: "old", at: "2026-09-29T10:00:00Z" }),
    getGatewayConfig: () => ({ provider: "ollama", model: "qwen3.8:27b" }),
    hasProposalAdapter: () => true,
    ...api
  };
  globalThis.game = { modules: { get: () => ({ api: base }) } };
  const notify = (level) => (message) => notes.push({ level, message });
  globalThis.ui = { notifications: { info: notify("info"), warn: notify("warn"), error: notify("error") } };
  globalThis.Dialog = class {
    static async confirm(options) { confirms.push(options); return confirm ? options.yes() : options.no(); }
    constructor(data) { this.data = data; this.closed = false; dialogs.push(this); }
    render() {
      const buttons = [];
      const box = { value: textarea };
      const form = { busy: false, classList: { toggle: (_cls, on) => { form.busy = on; } } };
      let listener = null;
      this.buttons = buttons;
      this.form = form;
      this.root = {
        closest: () => null,
        querySelector: (sel) => (sel.startsWith("textarea") ? box : sel === ".grand-design-growth" ? form : sel.startsWith("select") ? { value: "short" } : null),
        querySelectorAll: (sel) => (sel.includes("gd-suggest-proposals") && !sel.includes(",") ? [] : buttons),
        addEventListener: (type, fn) => { if (type === "click") listener = fn; }
      };
      this.click = (button) => {
        if (!buttons.includes(button)) buttons.push(button);
        listener?.({ target: { closest: () => button }, preventDefault() {} });
      };
      this.data.render?.([this.root]);
      return this;
    }
    close() { this.closed = true; }
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  return Promise.resolve(run({ notes, dialogs, confirms, tick })).finally(() => Object.assign(globalThis, saved));
}

for (const systemId of ["pf2e", "dnd5e"]) {
  const actor = { name: systemId === "pf2e" ? "Buck" : "Brakka", system: { id: systemId } };

  test(`[${systemId}] per-row Approve runs in the body with a busy state, then reopens`, async () => {
    let release;
    const calls = [];
    await withFoundry({ approveProposal: (...args) => { calls.push(args); return new Promise((resolve) => { release = resolve; }); } }, async ({ notes, dialogs, tick }) => {
      openGrowthManager(actor);
      const dialog = dialogs[0];
      assert.deepEqual(Object.keys(dialog.data.buttons), ["close"], "long actions are no longer footer buttons");
      const approve = fakeButton("gd-approve-proposal", aiProposal.id);
      const other = fakeButton("gd-reject-proposal", aiProposal.id);
      dialog.buttons.push(other);
      dialog.click(approve);
      dialog.click(approve);
      assert.equal(calls.length, 1, "a double click approves once");
      assert.deepEqual(calls[0], [actor, aiProposal.id]);
      assert.equal(dialog.closed, false, "the dialog stays open while it works");
      assert.equal(approve.disabled, true);
      assert.equal(other.disabled, true, "every other action is locked");
      assert.equal(approve.attrs["aria-busy"], "true");
      assert.equal(approve.label.textContent, "Approving...");
      assert.equal(approve.icon.className, "fas fa-spinner fa-spin");
      assert.equal(dialog.form.busy, true);
      release({});
      await tick();
      assert.equal(notes.length, 1);
      assert.match(notes[0].message, /Approved: Bridge Warden was added to/);
      assert.equal(dialog.closed, true);
      assert.equal(dialogs.length, 2);
      assert.match(dialogs[1].data.content, /typed notes/, "the typed notes survive");
    });
  });

  test(`[${systemId}] Approve as written confirms first, then passes confirm: true`, async () => {
    const calls = [];
    await withFoundry({ approveProposal: async (...args) => { calls.push(args); } }, async ({ dialogs, confirms, tick }) => {
      openGrowthManager(actor);
      dialogs[0].click(fakeButton("gd-approve-as-written", placeholder.id));
      await tick();
      await tick();
      assert.equal(confirms.length, 1);
      assert.match(confirms[0].content, /Beekeeping Knack/);
      assert.deepEqual(calls, [[actor, placeholder.id, { confirm: true }]]);
    });
    calls.length = 0;
    await withFoundry({ approveProposal: async (...args) => { calls.push(args); } }, async ({ dialogs, tick }) => {
      openGrowthManager(actor);
      dialogs[0].click(fakeButton("gd-approve-as-written", placeholder.id));
      await tick();
      assert.deepEqual(calls, [], "cancelled: nothing approved");
      assert.equal(dialogs[0].closed, false);
    }, { confirm: false });
  });

  test(`[${systemId}] Analyze in the body; empty notes warn without closing; a busy: error is a friendly warning`, async () => {
    await withFoundry({ analyzeSessionNotes: async () => { throw new Error("busy: already analyzing notes for this character."); } }, async ({ notes, dialogs, tick }) => {
      openGrowthManager(actor);
      dialogs[0].click(fakeButton("gd-analyze"));
      await tick();
      assert.deepEqual(notes.map((note) => note.level), ["warn"]);
      assert.match(notes[0].message, /still working on this character: already analyzing/);
      assert.match(dialogs[1].data.content, /typed notes/, "notes kept after the failure");
    });
    await withFoundry({ analyzeSessionNotes: async () => { throw new Error("should not be called"); } }, async ({ notes, dialogs, tick }) => {
      openGrowthManager(actor);
      dialogs[0].click(fakeButton("gd-analyze"));
      await tick();
      assert.match(notes[0].message, /Write or paste some session notes first/);
      assert.equal(dialogs.length, 1);
      assert.equal(dialogs[0].closed, false);
    }, { textarea: "   " });
    const recorded = [];
    await withFoundry({ analyzeSessionNotes: async (_a, text) => { recorded.push(text); return { source: "adapter", events: [events[0]], proposals: [] }; } }, async ({ dialogs, tick }) => {
      openGrowthManager(actor);
      dialogs[0].click(fakeButton("gd-analyze"));
      await tick();
      assert.deepEqual(recorded, ["typed notes"]);
      assert.doesNotMatch(dialogs[1].data.content, /typed notes<\/textarea>/, "recorded notes clear the box");
      assert.match(dialogs[1].data.content, /How your last notes were read/);
    });
  });

  test(`[${systemId}] api.isBusy: buttons render disabled and a click is refused politely`, async () => {
    const calls = [];
    await withFoundry({ isBusy: () => true, rejectProposal: async (...args) => { calls.push(args); } }, async ({ notes, dialogs }) => {
      openGrowthManager(actor);
      assert.match(dialogs[0].data.content, /gd-busy-notice/);
      assert.match(dialogs[0].data.content, /data-action="gd-reject-proposal" data-proposal-id="proposal:bridge-warden" aria-busy="false" disabled/);
      dialogs[0].click(fakeButton("gd-reject-proposal", aiProposal.id));
      assert.deepEqual(calls, []);
      assert.equal(notes[0].level, "warn");
      assert.match(notes[0].message, /still working on this character/);
      dialogs[0].data.close?.();
    });
  });

  test(`[${systemId}] Retry with AI calls retryMilestoneReward and reports a repeat fallback`, async () => {
    const capstone = generateCapstoneProposal(20, events, {}, 4, { systemId });
    const calls = [];
    await withFoundry({
      getGrowth: () => ({ events, proposals: [capstone] }),
      retryMilestoneReward: async (...args) => { calls.push(args); return { proposal: capstone, usedFallback: true, reason: "the model timed out" }; }
    }, async ({ notes, dialogs, tick }) => {
      openGrowthManager(actor);
      assert.match(dialogs[0].data.content, /data-action="gd-retry-milestone" data-proposal-id="proposal:capstone-20"/);
      dialogs[0].click(fakeButton("gd-retry-milestone", capstone.id));
      await tick();
      assert.deepEqual(calls, [[actor, "proposal:capstone-20"]]);
      assert.equal(notes[0].level, "warn");
      assert.match(notes[0].message, /the model timed out/);
    });
  });

  test(`[${systemId}] Save edit: validation errors stay in the form; a good save reopens`, async () => {
    const patches = [];
    const errorBox = { innerHTML: "" };
    const fields = { name: "Bridge Keeper", effect: "Shove them.", tier: "2" };
    const form = {
      querySelector: (sel) => (sel === ".gd-edit-errors" ? errorBox : null),
      querySelectorAll: () => Object.entries(fields).map(([field, value]) => ({ dataset: { field }, value }))
    };
    let answer = { ok: false, errors: ["[Bridge Keeper] requires a tier from 1 to 3."] };
    await withFoundry({ updateProposal: async (...args) => { patches.push(args); return answer; } }, async ({ notes, dialogs, tick }) => {
      openGrowthManager(actor);
      assert.match(dialogs[0].data.content, /gd-proposal-edit/);
      const save = fakeButton("gd-save-proposal", aiProposal.id);
      save.form = form;
      dialogs[0].click(save);
      await tick();
      assert.equal(patches.length, 1);
      assert.equal(patches[0][0], actor);
      assert.equal(patches[0][1], aiProposal.id);
      assert.equal(patches[0][2].entry.name, "Bridge Keeper");
      assert.match(errorBox.innerHTML, /requires a tier from 1 to 3/);
      assert.equal(dialogs.length, 1, "kept open with the GM's edits");
      assert.equal(save.disabled, false, "re-enabled to try again");
      // Client-side check: an empty name never reaches the API.
      fields.name = "";
      dialogs[0].click(save);
      await tick();
      assert.equal(patches.length, 1);
      assert.match(errorBox.innerHTML, /A name is required/);
      fields.name = "Bridge Keeper";
      answer = { ok: true, errors: [], proposal: { ...aiProposal, entry: { ...aiProposal.entry, name: "Bridge Keeper" } } };
      dialogs[0].click(save);
      await tick();
      assert.match(notes.at(-1).message, /Saved your edits to Bridge Keeper/);
      assert.equal(dialogs.length, 2);
    });
  });
}

test("without the new API calls (before dev-integration's merge) the dialog still opens without them", async () => {
  await withFoundry({}, async ({ dialogs }) => {
    openGrowthManager({ name: "Luz" });
    const html = dialogs[0].data.content;
    assert.doesNotMatch(html, /gd-proposal-edit/);
    assert.doesNotMatch(html, /gd-retry-milestone/);
    assert.match(html, /gd-approve-proposal/);
    assert.match(html, /gd-author-proposal/);
  });
});
