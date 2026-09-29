import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  defaultPartySelection,
  describeAnalysis,
  describePartyResult,
  jevEventChips,
  jevProposalChips,
  jevSummaryLine,
  openGrowthManager,
  openPartyAnalysis,
  partyCandidates,
  partyEntryAsLastResult,
  renderEventLine,
  renderGrowthContent,
  renderPartyContent,
  renderUnderTheHood,
  runPartyAnalysis
} from "../scripts/growth-ui.js";

// Board 642a0bda: Jev chips + summary line in the Growth dialog, and the Analyze party action
// (docs/jev-layer-contract.md "UI" + "Party mode").

const plain = { id: "e0", summary: "Brakka held the bridge.", outcome: "success", tags: ["defense"], themes: [] };
const disputed = { id: "e1", actorName: "Tovin", summary: "Tovin picked the lock.", outcome: "success", tags: ["thievery"], jev: { actorName: "Tovin", actorConfidence: 0.95, whole: false, outcome: "failure", flags: ["outcome-disputed"] } };
const corrected = { id: "e2", actorName: "Luz", summary: "Luz fumbled the climb.", outcome: "criticalFailure", tags: ["athletics"], jev: { actorName: "Luz", actorConfidence: 0.9, outcomeFrom: "success", flags: [] } };
const dark = { id: "e3", actorName: "Tovin", summary: "Tovin killed the surrendered goblin.", outcome: "success", tags: ["martial"], jev: { actorName: "Tovin", actorConfidence: 0.62, flags: ["dark-act"] } };
const whole = { id: "e4", summary: "The party held the inn.", outcome: "success", tags: ["defense"], jev: { actorName: null, actorConfidence: 0.4, whole: true, flags: [] } };

test("no jev block -> no chips, and the event line renders exactly as before", () => {
  assert.deepEqual(jevEventChips(plain), []);
  assert.deepEqual(jevEventChips({ ...plain, jev: null }), []);
  assert.doesNotMatch(renderEventLine(plain), /gd-jev/);
  assert.deepEqual(jevProposalChips({ id: "p" }), []);
});

test("outcome-disputed chip names Jev's reading; falls back to a generic label", () => {
  const [chip] = jevEventChips(disputed);
  assert.equal(chip.kind, "disputed");
  assert.equal(chip.text, "Jev reads this as a failure");
  assert.match(chip.title, /AI recorded a success/);
  const [generic] = jevEventChips({ ...disputed, jev: { ...disputed.jev, outcome: undefined } });
  assert.equal(generic.text, "Jev disputes this outcome");
  assert.match(renderEventLine(disputed), /class="gd-chip gd-jev-chip gd-jev-disputed"[^>]*>Jev reads this as a failure</);
});

test("an override is shown as corrected, naming what the AI said", () => {
  const chips = jevEventChips(corrected);
  assert.deepEqual(chips.map((chip) => chip.kind), ["corrected"]);
  assert.equal(chips[0].text, "Jev corrected (AI said a success)");
});

test("dark-act chip and low attribution confidence (< 0.8) -> who did this?", () => {
  const chips = jevEventChips(dark);
  assert.deepEqual(chips.map((chip) => chip.kind), ["dark", "who"]);
  assert.equal(chips[1].text, "who did this?");
  assert.match(chips[1].title, /only 62% sure Tovin did this/);
  // 0.8 exactly is confident enough; a whole-party event never asks who.
  assert.deepEqual(jevEventChips({ ...dark, jev: { ...dark.jev, actorConfidence: 0.8, flags: [] } }), []);
  assert.deepEqual(jevEventChips(whole).map((chip) => chip.kind), ["party"]);
  // Missing / non-numeric confidence does not invent doubt.
  assert.deepEqual(jevEventChips({ ...plain, jev: { flags: [] } }), []);
  assert.deepEqual(jevEventChips({ ...plain, jev: { actorConfidence: "high" } }), []);
});

test("weak-evidence chip on proposals (flag, or grounded < 1)", () => {
  const [chip] = jevProposalChips({ jev: { grounded: 0, fit: 2, flags: ["weak-evidence"] } });
  assert.equal(chip.text, "weak evidence");
  assert.match(chip.title, /0\/3 \(fit with the character 2\/3\)/);
  assert.equal(jevProposalChips({ jev: { grounded: 0.5, fit: 3 } }).length, 1);
  assert.deepEqual(jevProposalChips({ jev: { grounded: 2, fit: 3, flags: [] } }), []);
  const html = renderGrowthContent({
    growth: { events: [] },
    progression: { level: 1, grantAllowances: 1 },
    pending: [{ id: "p1", status: "pending", source: "ai-gateway", entry: { name: "Bridge Warden", mechanics: { effect: "x" } }, evidence: ["e0"], jev: { grounded: 0, fit: 1, flags: ["weak-evidence"] } }],
    status: { kind: "ai", text: "AI", title: "" }
  });
  // Main's row: name, kind chip, source badge, then the Jev chip.
  assert.match(html, /Bridge Warden<\/strong> <span class="gd-chip gd-kind">Skill<\/span> <span class="gd-chip gd-ai">AI<\/span><span class="gd-chip gd-jev-chip gd-jev-weak"/);
});

test("summary line: counts from diagnostics, else from the events; empty when Jev did not run", () => {
  const diag = { enabled: true, ran: ["triage", "attribution", "verify"], calls: 3, ms: 612.3, skippedChunks: [{ chunk: 1 }, { chunk: 4 }, { chunk: 5 }], overrides: 2, routed: 14, errors: [] };
  assert.equal(jevSummaryLine(diag), "Jev: 3 chunks skipped, 14 events routed, 2 outcomes corrected, 612 ms");
  const counted = jevSummaryLine({ ran: ["attribution"], skippedChunks: [], ms: 90 }, [disputed, corrected, dark, whole, plain]);
  assert.equal(counted, "Jev: 0 chunks skipped, 4 events routed, 1 outcome corrected, 90 ms");
  assert.match(jevSummaryLine({ ran: ["triage"], skippedChunks: [{}], errors: ["verify: HTTP 500"] }), /^Jev: 1 chunk skipped, 0 events routed, 0 outcomes corrected \(1 error, analysis carried on without it\)$/);
  assert.equal(jevSummaryLine({ enabled: true, ran: [] }), "");
  // Jev on but never ran: the GM is told why instead of seeing nothing.
  assert.match(jevSummaryLine({ enabled: true, ran: [], errors: [{ step: "triage", kind: "cors" }] }), /^Jev did not run: the browser blocked the call \(run node tools\/jev-proxy\.mjs.*carried on without it\.$/);
  assert.match(jevSummaryLine({ ran: [], errors: [{ step: "triage", kind: "http", status: 401, fatal: true }] }), /key was rejected/);
  assert.match(jevSummaryLine({ ran: [], errors: [{ step: "triage", kind: "timeout" }] }), /did not answer in time/);
  assert.equal(jevSummaryLine(null), "");
  assert.equal(jevSummaryLine(undefined, [disputed]), "");
});

test("the dialog shows the Jev line above the reading and lists what Jev skipped under the hood", () => {
  const lastResult = {
    source: "adapter",
    events: [disputed, dark],
    gatewayDiagnostics: { model: "qwen3.8:27b", jev: { ran: ["triage"], ms: 80, skippedChunks: [{ chunk: 2, p: 0.03, text: "The rain kept falling <b>on</b> the road." }], errors: ["rank: HTTP 503"] } }
  };
  const html = renderGrowthContent({ growth: { events: [] }, progression: { level: 1 }, pending: [], lastResult, status: { kind: "ai", text: "AI", title: "" }, canSuggest: false });
  assert.match(html, /<p class="gd-jev-summary"><i class="fas fa-bolt"><\/i> Jev: 1 chunk skipped, 2 events routed, 0 outcomes corrected, 80 ms \(1 error/);
  assert.ok(html.indexOf("gd-jev-summary") < html.indexOf('class="gd-interpretation"'));
  const hood = renderUnderTheHood(null, lastResult);
  assert.match(hood, /Passages Jev skipped[^]*#2 \(p=0\.03\): The rain kept falling &lt;b&gt;on&lt;\/b&gt; the road\./);
  assert.match(hood, /Jev errors[^]*rank: HTTP 503/);
  // Without Jev diagnostics nothing Jev-related appears.
  const plainHtml = renderGrowthContent({ growth: { events: [] }, progression: {}, pending: [], lastResult: { source: "adapter", events: [plain] }, status: {} });
  assert.doesNotMatch(plainHtml, /Jev/);
});

test("chips escape hostile names", () => {
  const html = renderEventLine({ ...dark, jev: { ...dark.jev, actorName: '<img src=x onerror="1">', outcome: "<script>" , flags: ["outcome-disputed"] } });
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>/);
});

// ---- party picker + result -> notifications ----------------------------------------------------

const actors = [
  { id: "a1", name: "Luz", type: "character", hasPlayerOwner: true },
  { id: "a2", name: "Tovin", type: "character", hasPlayerOwner: true },
  { id: "a3", name: "Goblin", type: "npc", hasPlayerOwner: false },
  { id: "a4", name: "Test PC", type: "character", hasPlayerOwner: false },
  { id: "a5", name: "Owl", type: "familiar", hasPlayerOwner: true }
];

test("party candidates: characters only (pf2e and dnd5e both use type 'character'); default = player-owned", () => {
  const candidates = partyCandidates(actors);
  assert.deepEqual(candidates.map((c) => c.id), ["a1", "a2", "a4"]);
  assert.deepEqual([...defaultPartySelection(candidates)], ["a1", "a2"]);
  // The dialog's own actor is ticked even without a player owner.
  assert.deepEqual([...defaultPartySelection(candidates, "a4")].sort(), ["a1", "a2", "a4"]);
  // No player-owned PCs (a GM's test world) -> every PC.
  assert.deepEqual([...defaultPartySelection(partyCandidates([actors[3]]))], ["a4"]);
  assert.deepEqual(partyCandidates(null), []);
  const html = renderPartyContent({ candidates, selected: new Set(["a1"]), draftNotes: "</textarea>x" });
  assert.match(html, /value="a1" checked> Luz/);
  assert.match(html, /value="a4" > Test PC <em class="gd-hint">\(no player owner\)<\/em>/);
  assert.doesNotMatch(html, /<\/textarea>x/);
});

const partyResult = {
  perActor: [
    { actorId: "a1", name: "Luz", source: "adapter", events: [corrected], proposals: [{ status: "pending" }], themes: [] },
    { actorId: "a2", name: "Tovin", source: "adapter", events: [disputed, dark], proposals: [], themes: [{ label: "Lockwork", isNew: true }] },
    { actorId: "a4", name: "Test PC", source: "adapter", events: [], proposals: [] }
  ],
  party: { ms: 18234, extractionCalls: 1, jev: { ran: ["attribution", "verify"], ms: 540, skippedChunks: [], overrides: 1, routed: 3 } }
};

test("party result -> notifications: summary, Jev line, then one block per character via the per-actor helper", () => {
  const notes = describePartyResult(partyResult);
  assert.deepEqual(notes.map((n) => n.level), ["info", "info", "info", "info", "warn"]);
  assert.equal(notes[0].message, "Party analysis: 3 characters, 3 growth event(s) recorded, 18234 ms.");
  assert.equal(notes[1].message, "Jev: 0 chunks skipped, 3 events routed, 1 outcome corrected, 540 ms");
  assert.equal(notes[2].message, "Luz: Recorded 1 growth event(s) via AI analysis; 1 pending proposal(s).");
  assert.equal(notes[3].message, "Tovin: Recorded 2 growth event(s) via AI analysis; 0 pending proposal(s). New theme(s): Lockwork.");
  assert.equal(notes[4].message, "Test PC: nothing in these notes was credited to this character.");
  // The single-actor wording is unchanged when no name is given.
  assert.equal(describeAnalysis({ events: [] })[0].message, "The AI read the notes but found nothing a character did. Try naming who did what and how it went.");
});

test("party result: fallback reason is permanent and per character; errors are kept per character", () => {
  const notes = describePartyResult({
    fallback: true,
    perActor: [
      { actorId: "a1", name: "Luz", source: "local-fallback", adapterError: "fetch failed", events: [plain], proposals: [] },
      { actorId: "a2", name: "Tovin", error: "Only a GM can analyze notes." }
    ],
    party: { ms: 50 }
  });
  assert.match(notes[1].message, /no party mode/);
  const luzFallback = notes.find((n) => n.level === "error" && n.message.startsWith("Luz:"));
  assert.deepEqual(luzFallback.options, { permanent: true });
  assert.match(luzFallback.message, /fell back to local keyword analysis\. fetch failed/);
  assert.ok(notes.some((n) => n.level === "error" && n.message === "Tovin: Only a GM can analyze notes."));
  assert.equal(notes.filter((n) => /^Jev:/.test(n.message)).length, 0, "no Jev line when Jev did not run");
});

test("Jev diagnostics that live only on the party are attached to the character's dialog result", () => {
  const entry = partyEntryAsLastResult(partyResult.perActor[1], partyResult.party);
  assert.equal(entry.gatewayDiagnostics.jev, partyResult.party.jev);
  const own = { ...partyResult.perActor[0], gatewayDiagnostics: { jev: { ran: ["triage"] } } };
  assert.equal(partyEntryAsLastResult(own, partyResult.party), own);
  assert.equal(partyEntryAsLastResult(null, partyResult.party), null);
});

test("runPartyAnalysis uses api.analyzePartyNotes when present", async () => {
  const calls = [];
  const api = { analyzePartyNotes: async (list, notes) => { calls.push([list.map((a) => a.id), notes]); return partyResult; }, analyzeSessionNotes: () => assert.fail("per-actor path must not run") };
  const result = await runPartyAnalysis(api, actors.slice(0, 2), "notes");
  assert.deepEqual(calls, [[["a1", "a2"], "notes"]]);
  assert.equal(result.fallback, false);
  assert.equal(result.perActor.length, 3);
  assert.equal(result.party.jev.routed, 3);
});

test("runPartyAnalysis falls back to analyzeSessionNotes per character, keeping each error", async () => {
  const seen = [];
  const api = {
    analyzeSessionNotes: async (actor, notes) => {
      seen.push(actor.id);
      if (actor.id === "a2") throw new Error("boom");
      return { source: "adapter", events: [plain], proposals: [] };
    }
  };
  const result = await runPartyAnalysis(api, actors.slice(0, 2), "notes");
  assert.deepEqual(seen, ["a1", "a2"]);
  assert.equal(result.fallback, true);
  assert.deepEqual(result.perActor.map((entry) => [entry.actorId, entry.name, entry.error ?? null, entry.events.length]), [["a1", "Luz", null, 1], ["a2", "Tovin", "boom", 0]]);
});

// ---- dialog wiring with a fake Foundry ----------------------------------------------------------

function withFoundry(api, run) {
  const saved = { game: globalThis.game, ui: globalThis.ui, Dialog: globalThis.Dialog };
  const notes = [];
  const dialogs = [];
  globalThis.game = { modules: { get: () => ({ api }) }, actors: { contents: actors, get: (id) => actors.find((a) => a.id === id) } };
  const notify = (level) => (message) => notes.push({ level, message });
  globalThis.ui = { notifications: { info: notify("info"), warn: notify("warn"), error: notify("error") } };
  globalThis.Dialog = class {
    constructor(data) {
      this.data = data;
      dialogs.push(this);
    }
    // The Growth dialog wires its body buttons through one delegated click listener on the root;
    // the party picker has none (its work is in footer buttons). `click(action)` fires that listener.
    render() {
      const listeners = [];
      const textarea = { value: this.data.content.includes('name="growth-notes"') ? "Luz saw Tovin kill the goblin" : "" };
      this.root = {
        querySelector: (sel) => (sel.startsWith("textarea") ? textarea : null),
        querySelectorAll: () => [],
        addEventListener: (type, fn) => listeners.push(fn)
      };
      this.click = (action) => listeners.forEach((fn) => fn({ preventDefault() {}, target: { closest: () => ({ dataset: { action } }) } }));
      this.data.render?.([this.root]);
      return this;
    }
    close() {
      this.closed = true;
    }
  };
  return Promise.resolve(run({ notes, dialogs })).finally(() => Object.assign(globalThis, saved));
}

// A fake Dialog v1 `html` for the party dialog: checked boxes + the notes box.
const partyHtml = (ids, text) => [{
  querySelector: (sel) => (sel.startsWith("textarea") ? { value: text } : null),
  querySelectorAll: (sel) => (sel.includes(":checked") ? ids.map((value) => ({ value })) : [])
}];

const growthApi = (extra = {}) => ({
  getGrowth: () => ({ events: [], proposals: [] }),
  getLevelProgression: () => ({ level: 1, progress: 0, grantAllowances: 0 }),
  getLastAnalysis: () => null,
  getGatewayConfig: () => ({ provider: "ollama", model: "qwen3.8:27b" }),
  hasProposalAdapter: () => true,
  ...extra
});

test("Growth dialog has an Analyze party button that opens the picker with the typed notes carried over", async () => {
  await withFoundry(growthApi(), async ({ dialogs }) => {
    const tovin = actors[1];
    openGrowthManager(tovin);
    assert.match(dialogs[0].data.content, /data-action="gd-analyze-party"[^>]*>[^<]*<i class="fas fa-users"><\/i> <span class="gd-btn-label">Analyze party<\/span>/);
    dialogs[0].click("gd-analyze-party");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(dialogs[0].closed, true, "the Growth dialog closes; the picker takes over");
    assert.equal(dialogs.length, 2);
    assert.equal(dialogs[1].data.title, "Grand Design: Analyze party");
    assert.match(dialogs[1].data.content, /Luz saw Tovin kill the goblin/);
    assert.match(dialogs[1].data.content, /value="a1" checked/);
    assert.match(dialogs[1].data.content, /value="a2" checked/);
    assert.doesNotMatch(dialogs[1].data.content, /value="a3"/, "NPCs are not offered");
  });
});

test("Analyze party: calls the API once, notifies per character, reopens the origin's Growth dialog with its result", async () => {
  const calls = [];
  const api = growthApi({ analyzePartyNotes: async (list, text) => { calls.push({ ids: list.map((a) => a.id), text }); return partyResult; } });
  await withFoundry(api, async ({ notes, dialogs }) => {
    openPartyAnalysis({ origin: actors[1], draftNotes: "" });
    await dialogs[0].data.buttons.analyze.callback(partyHtml(["a1", "a2"], "the notes"));
    assert.deepEqual(calls, [{ ids: ["a1", "a2"], text: "the notes" }]);
    assert.match(notes[0].message, /Reading the notes once for 2 characters/);
    assert.ok(notes.some((n) => n.message.startsWith("Tovin: Recorded 2")));
    assert.ok(notes.some((n) => n.message.startsWith("Jev: ")));
    const reopened = dialogs[1];
    assert.equal(reopened.data.title, "Grand Design Growth: Tovin");
    assert.match(reopened.data.content, /gd-jev-summary/);
    assert.match(reopened.data.content, /Jev reads this as a failure/);
    assert.match(reopened.data.content, /dark act\?/);
  });
});

test("Analyze party with nothing ticked or no notes warns and keeps what was typed", async () => {
  await withFoundry(growthApi({ analyzePartyNotes: async () => assert.fail("must not be called") }), async ({ notes, dialogs }) => {
    openPartyAnalysis({ origin: null });
    await dialogs[0].data.buttons.analyze.callback(partyHtml([], "kept notes"));
    assert.equal(notes[0].message, "Tick at least one character.");
    assert.match(dialogs[1].data.content, /kept notes/);
    assert.doesNotMatch(dialogs[1].data.content, /checked/, "the (empty) selection is kept, not reset");
    await dialogs[1].data.buttons.analyze.callback(partyHtml(["a1"], "   "));
    assert.match(notes[1].message, /Write or paste the session notes first/);
    assert.match(dialogs[2].data.content, /value="a1" checked/);
  });
});

test("a failing party call surfaces the error and reopens the picker with the notes intact", async () => {
  const api = growthApi({ analyzePartyNotes: async () => { throw new Error("Only a GM can analyze notes."); } });
  const savedError = console.error;
  console.error = () => {};
  try {
    await withFoundry(api, async ({ notes, dialogs }) => {
      openPartyAnalysis({ origin: actors[0] });
      await dialogs[0].data.buttons.analyze.callback(partyHtml(["a1", "a4"], "precious notes"));
      assert.deepEqual(notes.at(-1), { level: "error", message: "Only a GM can analyze notes." });
      assert.equal(dialogs[1].data.title, "Grand Design: Analyze party");
      assert.match(dialogs[1].data.content, /precious notes/);
      assert.match(dialogs[1].data.content, /value="a4" checked/);
    });
  } finally {
    console.error = savedError;
  }
});

test("without api.analyzePartyNotes the dialog still works (per-character fallback)", async () => {
  const seen = [];
  const api = growthApi({ analyzeSessionNotes: async (actor) => { seen.push(actor.name); return { source: "adapter", events: [plain], proposals: [] }; } });
  await withFoundry(api, async ({ notes, dialogs }) => {
    openPartyAnalysis({ origin: actors[0] });
    await dialogs[0].data.buttons.analyze.callback(partyHtml(["a1", "a2"], "notes"));
    assert.deepEqual(seen, ["Luz", "Tovin"]);
    assert.match(notes[0].message, /one at a time \(this version has no party mode\)/);
    assert.doesNotMatch(notes[0].message, /once/);
    assert.ok(notes.some((n) => /no party mode/.test(n.message)));
    assert.equal(dialogs[1].data.title, "Grand Design Growth: Luz");
  });
});

test("every new Growth-dialog string has an en.json entry", () => {
  const growth = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8")).GRAND_DESIGN_AI.Growth;
  for (const key of ["AnalyzeParty", "PartyTitle", "PartyHint", "JevSummary", "JevDisputed", "JevDarkAct", "JevWhoDidThis", "JevWeakEvidence", "JevWholeParty", "JevCorrected"]) {
    assert.equal(typeof growth[key], "string", `Growth.${key}`);
  }
  assert.equal(growth.JevWhoDidThis, jevEventChips(dark)[1].text);
  assert.equal(growth.JevDarkAct, jevEventChips(dark)[0].text);
  assert.ok(renderPartyContent({}).includes(growth.PartyHint));
});
