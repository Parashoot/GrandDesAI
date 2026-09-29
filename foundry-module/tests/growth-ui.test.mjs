import test from "node:test";
import assert from "node:assert/strict";

import { renderGrowthContent, allowanceHint, describeSuggestResult, openGrowthManager } from "../scripts/growth-ui.js";

// Board ea4012f6 (ember-road session 01): after a long rest Brakka had 3 grant allowances and zero
// proposals, and the dialog only said "No proposal has enough evidence yet." -- the GM was stuck.

const aiStatus = { kind: "ai", text: "AI: qwen3.8:27b", title: "Notes are read by qwen3.8:27b via ollama." };
const events = [{ id: "e1", summary: "Brakka held the bridge.", outcome: "success", tags: ["defense"], themes: [] }];
const pendingProposal = {
  id: "p1",
  status: "pending",
  kind: "skill",
  source: "ai-gateway",
  entry: { name: "Bridge Warden", system_equivalent: "feat", mechanics: { effect: "Hold a choke point." } },
  evidence: ["e1"]
};

const render = (overrides = {}) =>
  renderGrowthContent({
    growth: { events },
    progression: { level: 3, progress: 87.5, grantAllowances: 3 },
    pending: [],
    lastAnalysis: null,
    lastResult: null,
    status: aiStatus,
    ...overrides
  });

test("stuck state (allowances, nothing pending): callout with a prominent Suggest button replaces the dead end", () => {
  const html = render();
  assert.match(html, /class="gd-suggest-callout"/);
  assert.match(html, /gd-suggest gd-suggest-primary" data-action="gd-suggest-proposals"/);
  assert.match(html, /type="button"/, "the button must not submit the dialog form");
  assert.doesNotMatch(html, /No proposal has enough evidence yet\.<\/li>/);
  assert.match(html, /3 grant allowances are waiting/);
  assert.match(html, /class="gd-allowance-hint"[^]*3 grant allowances to spend, but no proposals yet -- use <strong>Suggest proposals<\/strong> below\./);
  // The callout sits under the Pending Proposals heading, before the recorded evidence. (The old
  // Approve <select> is gone: every proposal row has its own Approve, board a0bcfd05.)
  assert.ok(html.indexOf("gd-suggest-callout") > html.indexOf("<h3>Pending Proposals</h3>"));
  assert.ok(html.indexOf("gd-suggest-callout") < html.indexOf('class="gd-history"'));
  assert.doesNotMatch(html, /name="growth-proposal"/);
});

test("allowances with pending proposals: hint says approving spends one, Suggest is the quiet variant", () => {
  const html = render({ pending: [pendingProposal] });
  assert.match(html, /3 grant allowances to spend -- approve a proposal to use one\./);
  assert.doesNotMatch(html, /gd-suggest-callout/);
  assert.match(html, /gd-suggest gd-suggest-quiet"/);
  assert.match(html, /Bridge Warden/);
  assert.ok(html.indexOf("gd-suggest-quiet") > html.indexOf('class="gd-proposals"'), "quiet button sits after the list");
});

test("zero allowances: no header hint, old empty-list text, quiet Suggest still available", () => {
  const html = render({ progression: { level: 0, progress: 12, grantAllowances: 0 } });
  assert.doesNotMatch(html, /gd-allowance-hint/);
  assert.doesNotMatch(html, /gd-suggest-callout/);
  assert.match(html, /<li>No proposal has enough evidence yet\.<\/li>/);
  assert.match(html, /gd-suggest-quiet/);
  assert.equal(allowanceHint({ grantAllowances: 0 }, 0), "");
  assert.equal(allowanceHint(null, 0), "");
});

test("singular allowance wording", () => {
  assert.equal(allowanceHint({ grantAllowances: 1 }, 2), "1 grant allowance to spend -- approve a proposal to use one.");
  assert.match(render({ progression: { level: 1, grantAllowances: 1 } }), /1 grant allowance is waiting/);
});

test("without requestGrowthProposals (older API) no button renders and the hint does not point at one", () => {
  const html = render({ canSuggest: false });
  assert.doesNotMatch(html, /gd-suggest-proposals/);
  assert.doesNotMatch(html, /Suggest proposals/);
  assert.match(html, /<li>No proposal has enough evidence yet\.<\/li>/);
  assert.match(html, /3 grant allowances to spend; proposals appear here once/);
});

test("local status mentions that suggesting needs an AI provider", () => {
  const html = render({ status: { kind: "local", text: "Local", title: "No AI provider" } });
  assert.match(html, /needs an AI provider/);
  assert.doesNotMatch(render(), /needs an AI provider/);
});

test("escaping: hostile proposal names, status text and draft notes stay inert next to the new UI", () => {
  const evil = '<img src=x onerror="alert(1)">';
  const html = render({
    pending: [{ ...pendingProposal, id: `"><script>x</script>`, entry: { name: evil, mechanics: { effect: evil } } }],
    status: { kind: '"ai', text: evil, title: evil },
    draftNotes: "</textarea><script>alert(2)</script>"
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /gd-suggest-quiet/);
});

test("malformed inputs degrade instead of throwing", () => {
  assert.doesNotThrow(() => renderGrowthContent({ growth: null, progression: { grantAllowances: "3" }, pending: undefined, status: undefined }));
  const html = renderGrowthContent({ growth: null, progression: { grantAllowances: "3" }, pending: undefined, status: undefined });
  assert.match(html, /gd-suggest-callout/);
  assert.equal(allowanceHint({ grantAllowances: -2 }, 0), "");
  assert.equal(allowanceHint({ grantAllowances: 2.7 }, 1), "2 grant allowances to spend -- approve a proposal to use one.");
});

test("describeSuggestResult: counts, lists, nothing new", () => {
  assert.deepEqual(describeSuggestResult({ proposals: [], added: 3 }), { level: "info", message: "3 new proposals -- pick one and Approve to spend a grant allowance." });
  assert.equal(describeSuggestResult({ added: [{ id: "a" }] }).message, "1 new proposal -- pick one and Approve to spend a grant allowance.");
  assert.equal(describeSuggestResult({ added: 0 }).level, "warn");
  assert.equal(describeSuggestResult(undefined).level, "warn");
  assert.equal(describeSuggestResult({ added: "nope" }).level, "warn");
});

// ---- dialog wiring, with just enough fake Foundry + DOM to click the body button ----------------

function fakeButton() {
  const attrs = {};
  const label = { textContent: "Suggest proposals" };
  const icon = { className: "fas fa-lightbulb" };
  const listeners = {};
  return {
    disabled: false,
    attrs,
    label,
    icon,
    setAttribute: (k, v) => { attrs[k] = v; },
    querySelector: (sel) => (sel === ".gd-suggest-label" ? label : sel === "i" ? icon : null),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    click: () => listeners.click?.({ preventDefault() {} })
  };
}

function withFoundry({ requestGrowthProposals }, run) {
  const saved = { game: globalThis.game, ui: globalThis.ui, Dialog: globalThis.Dialog };
  const notes = [];
  const dialogs = [];
  const api = {
    getGrowth: () => ({ events, proposals: [] }),
    getLevelProgression: () => ({ level: 3, progress: 87.5, grantAllowances: 3 }),
    getLastAnalysis: () => null,
    getGatewayConfig: () => ({ provider: "ollama", model: "qwen3.8:27b" }),
    hasProposalAdapter: () => true
  };
  if (requestGrowthProposals) api.requestGrowthProposals = requestGrowthProposals;
  globalThis.game = { modules: { get: () => ({ api }) } };
  const notify = (level) => (message) => notes.push({ level, message });
  globalThis.ui = { notifications: { info: notify("info"), warn: notify("warn"), error: notify("error") } };
  globalThis.Dialog = class {
    constructor(data) {
      this.data = data;
      this.closed = false;
      dialogs.push(this);
    }
    render() {
      const button = fakeButton();
      const textarea = { value: "half-typed notes" };
      const form = { classList: { toggle: (cls, on) => { form.busy = on; } } };
      this.button = button;
      this.form = form;
      this.root = {
        closest: () => null,
        querySelector: (sel) => (sel.startsWith("textarea") ? textarea : sel === ".grand-design-growth" ? form : null),
        querySelectorAll: () => (this.data.content.includes("gd-suggest-proposals") ? [button] : [])
      };
      this.data.render?.([this.root]);
      return this;
    }
    close() {
      this.closed = true;
    }
  };
  return Promise.resolve(run({ notes, dialogs, api })).finally(() => Object.assign(globalThis, saved));
}

test("clicking Suggest shows a busy state, calls the API once, notifies and reopens with the typed notes", async () => {
  let release;
  const calls = [];
  await withFoundry(
    { requestGrowthProposals: (actor) => { calls.push(actor); return new Promise((resolve) => { release = resolve; }); } },
    async ({ notes, dialogs }) => {
      const actor = { name: "Brakka" };
      openGrowthManager(actor);
      const first = dialogs[0];
      assert.match(first.data.content, /gd-suggest-callout/);
      first.button.click();
      first.button.click(); // a double click must not start a second ~10 s request
      assert.equal(calls.length, 1);
      assert.equal(calls[0], actor);
      assert.equal(first.button.disabled, true);
      assert.equal(first.button.attrs["aria-busy"], "true");
      assert.match(first.button.label.textContent, /Asking the AI/);
      assert.equal(first.form.busy, true);
      release({ proposals: [], added: 3 });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(notes, [{ level: "info", message: "3 new proposals -- pick one and Approve to spend a grant allowance." }]);
      assert.equal(first.closed, true);
      assert.equal(dialogs.length, 2, "dialog reopened to show the new proposals");
      assert.match(dialogs[1].data.content, /half-typed notes/, "the GM's typing survives the reopen");
    }
  );
});

test("a failing Suggest (no AI provider) surfaces the API's message and still reopens", async () => {
  await withFoundry(
    { requestGrowthProposals: async () => { throw new Error("No AI provider is configured -- set one in Grand Design AI Gateway settings."); } },
    async ({ notes, dialogs }) => {
      openGrowthManager({ name: "Tovin" });
      dialogs[0].button.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(notes.length, 1);
      assert.equal(notes[0].level, "error");
      assert.match(notes[0].message, /No AI provider is configured/);
      assert.equal(dialogs.length, 2);
    }
  );
});

test("without requestGrowthProposals the dialog opens with no Suggest button", async () => {
  await withFoundry({}, async ({ dialogs }) => {
    openGrowthManager({ name: "Luz" });
    assert.doesNotMatch(dialogs[0].data.content, /gd-suggest-proposals/);
    assert.match(dialogs[0].data.content, /No proposal has enough evidence yet/);
  });
});
