import test from "node:test";
import assert from "node:assert/strict";

import {
  AI_EXPECTED_SETTING,
  checkGatewayAtReady,
  gatewayStartupMessage,
  gatewayStartupProblem,
  migrateClientProviderSettings,
  providerSettingScope,
  registerAiProviderSettings,
  renderGatewayForm,
  scheduleAdapterRebuild
} from "../scripts/ai-provider-config.js";
import { describeBuild, BUILD } from "../scripts/build-info.js";
import { renderGrowthContent, renderProposal, renderUnderTheHood, reportAnalysis, reportRest } from "../scripts/growth-ui.js";

// Boards 51f276b4 (AI silently off), 5286a3ba (adapter frozen), db092299 (rest warnings hidden),
// 30f2b191 (no build stamp). One fake Foundry per system id so both PF2e and dnd5e are covered.

const MODULE = "grand-design-ai";

function fakeFoundry({ systemId = "pf2e", isGM = true, generation = 14, stored = {}, localStorage = null, adapterAttached = false } = {}) {
  const registered = new Map();
  const values = new Map(Object.entries(stored));
  const notes = [];
  const attached = { adapter: adapterAttached ? () => {} : null, sets: [] };
  const api = {
    hasProposalAdapter: () => attached.adapter !== null,
    setProposalAdapter: (adapter) => { attached.adapter = adapter; attached.sets.push(adapter); }
  };
  const saved = { game: globalThis.game, ui: globalThis.ui, FormApplication: globalThis.FormApplication, localStorage: globalThis.localStorage };
  globalThis.FormApplication = class {};
  const notify = (level) => (message, options) => notes.push({ level, message, options });
  globalThis.game = {
    system: { id: systemId },
    release: { generation },
    user: { isGM },
    modules: { get: () => ({ api }) },
    settings: {
      register: (_ns, key, data) => registered.set(key, data),
      registerMenu: () => {},
      get: (_ns, key) => (values.has(key) ? values.get(key) : registered.get(key)?.default),
      set: async (_ns, key, value) => { values.set(key, value); registered.get(key)?.onChange?.(value); return value; }
    }
  };
  globalThis.ui = { notifications: { info: notify("info"), warn: notify("warn"), error: notify("error") } };
  Object.defineProperty(globalThis, "localStorage", { value: localStorage, configurable: true, writable: true });
  return {
    registered, values, notes, attached,
    restore() {
      Object.assign(globalThis, { game: saved.game, ui: saved.ui, FormApplication: saved.FormApplication });
      Object.defineProperty(globalThis, "localStorage", { value: saved.localStorage, configurable: true, writable: true });
    }
  };
}

const memoryStorage = (entries) => ({ getItem: (key) => (key in entries ? entries[key] : null) });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const systemId of ["pf2e", "dnd5e"]) {
  test(`[${systemId}] provider/endpoint/model are user scope on v13+, the API key stays client scope`, () => {
    const fake = fakeFoundry({ systemId });
    try {
      registerAiProviderSettings();
      for (const key of ["aiProvider", "aiEndpoint", "aiModel"]) assert.equal(fake.registered.get(key).scope, "user", key);
      assert.equal(fake.registered.get("aiApiKey").scope, "client");
      assert.equal(fake.registered.get("aiGatewayClient").scope, "client");
      assert.equal(fake.registered.get("aiGatewayWorld").scope, "world");
      assert.equal(fake.registered.get(AI_EXPECTED_SETTING).scope, "world");
      for (const key of ["aiProvider", "aiEndpoint", "aiModel", "aiApiKey", "aiGatewayClient", "aiGatewayWorld"]) {
        assert.equal(typeof fake.registered.get(key).onChange, "function", `${key} has onChange`);
      }
    } finally { fake.restore(); }
  });

  test(`[${systemId}] Foundry v12 keeps the client scope`, () => {
    assert.equal(providerSettingScope(12), "client");
    assert.equal(providerSettingScope(13), "user");
    assert.equal(providerSettingScope(14), "user");
  });

  test(`[${systemId}] ready with AI expected but no provider: permanent warning with the fix and an open link`, async () => {
    const fake = fakeFoundry({ systemId, stored: { [AI_EXPECTED_SETTING]: true } });
    try {
      registerAiProviderSettings();
      const { problem } = await checkGatewayAtReady();
      assert.equal(problem, "expected-but-disabled");
      const warn = fake.notes.find((note) => note.level === "warn");
      assert.ok(warn, "a warning is shown");
      assert.equal(warn.options.permanent, true);
      assert.match(warn.message, /Configure AI Gateway/);
      assert.match(warn.message, /data-gd-open-gateway/);
    } finally { fake.restore(); }
  });

  test(`[${systemId}] ready with a working provider attaches the adapter and stays quiet`, async () => {
    const fake = fakeFoundry({ systemId, stored: { aiProvider: "ollama", aiEndpoint: "http://127.0.0.1:11434", aiModel: "qwen3.8:27b" } });
    try {
      registerAiProviderSettings();
      const { problem, adapter } = await checkGatewayAtReady();
      assert.equal(problem, null);
      assert.equal(typeof adapter, "function");
      assert.equal(fake.notes.filter((note) => note.level === "warn").length, 0);
      assert.equal(fake.values.get(AI_EXPECTED_SETTING), true, "a GM with a real provider marks AI as expected for the world");
    } finally { fake.restore(); }
  });

  test(`[${systemId}] a table that never used AI is not nagged`, async () => {
    const fake = fakeFoundry({ systemId });
    try {
      registerAiProviderSettings();
      const { problem } = await checkGatewayAtReady();
      assert.equal(problem, null);
      assert.equal(fake.notes.length, 0);
    } finally { fake.restore(); }
  });

  test(`[${systemId}] a hosted provider missing its key warns permanently with the reason`, async () => {
    const fake = fakeFoundry({ systemId, stored: { aiProvider: "hosted", aiEndpoint: "https://api.example.com/v1", aiModel: "m" } });
    try {
      registerAiProviderSettings();
      const { problem } = await checkGatewayAtReady();
      assert.equal(problem, "configured-but-not-attached");
      const warns = fake.notes.filter((note) => note.level === "warn");
      assert.equal(warns.length, 1, "one warning, not two");
      assert.match(warns[0].message, /API key/);
      assert.equal(warns[0].options.permanent, true);
    } finally { fake.restore(); }
  });

  test(`[${systemId}] changing a gateway setting rebuilds the adapter (debounced, GM only)`, async () => {
    const fake = fakeFoundry({ systemId, stored: { aiProvider: "ollama", aiEndpoint: "http://127.0.0.1:11434", aiModel: "qwen3.8:27b" } });
    try {
      registerAiProviderSettings();
      const before = fake.attached.sets.length;
      await game.settings.set(MODULE, "aiModel", "other-model");
      await game.settings.set(MODULE, "aiEndpoint", "http://127.0.0.1:11435");
      await game.settings.set(MODULE, "aiGatewayWorld", "{}");
      assert.equal(fake.attached.sets.length, before, "nothing rebuilt yet: debounced");
      await wait(300);
      assert.equal(fake.attached.sets.length, before + 1, "three writes, one rebuild");
      assert.equal(typeof fake.attached.adapter, "function");
      await game.settings.set(MODULE, "aiProvider", "disabled");
      await wait(300);
      assert.equal(fake.attached.adapter, null, "turning the provider off detaches the adapter");
    } finally { fake.restore(); }
  });

  test(`[${systemId}] a player's browser never rebuilds an adapter`, async () => {
    const fake = fakeFoundry({ systemId, isGM: false });
    try {
      registerAiProviderSettings();
      scheduleAdapterRebuild(1);
      await game.settings.set(MODULE, "aiModel", "x");
      await wait(50);
      assert.equal(fake.attached.sets.length, 0);
    } finally { fake.restore(); }
  });
}

test("an old client-scope provider is migrated once into the user setting", async () => {
  const fake = fakeFoundry({
    localStorage: memoryStorage({ "grand-design-ai.aiProvider": JSON.stringify("ollama"), "grand-design-ai.aiModel": JSON.stringify("qwen3.8:27b") })
  });
  try {
    registerAiProviderSettings();
    const migrated = await migrateClientProviderSettings();
    assert.deepEqual(migrated.sort(), ["model", "provider"]);
    assert.equal(fake.values.get("aiProvider"), "ollama");
    // A user value that is already set is never overwritten by a stale browser value.
    fake.values.set("aiModel", "already-chosen");
    assert.deepEqual(await migrateClientProviderSettings(), []);
    assert.equal(fake.values.get("aiModel"), "already-chosen");
    await wait(300); // let the debounced rebuild the migration triggered finish before the fake is torn down
  } finally { fake.restore(); }
});

test("startup problem decisions", () => {
  assert.equal(gatewayStartupProblem({ expected: true, provider: "disabled", adapterAttached: false }), "expected-but-disabled");
  assert.equal(gatewayStartupProblem({ expected: false, provider: "disabled", adapterAttached: false }), null);
  assert.equal(gatewayStartupProblem({ expected: true, provider: "ollama", adapterAttached: true }), null);
  assert.equal(gatewayStartupProblem({ expected: false, provider: "ollama", adapterAttached: false }), "configured-but-not-attached");
  assert.match(gatewayStartupMessage("configured-but-not-attached", "no key"), /\(no key\)/);
});

// ---- Growth dialog -------------------------------------------------------------------------------

function withUi(run) {
  const saved = globalThis.ui;
  const notes = [];
  const notify = (level) => (message, options) => notes.push({ level, message, options });
  globalThis.ui = { notifications: { info: notify("info"), warn: notify("warn"), error: notify("error") } };
  try { run(notes); } finally { globalThis.ui = saved; }
}

test("local-mode Analyze is a warning; an AI reading stays info", () => {
  withUi((notes) => {
    reportAnalysis({ source: "local", events: [{ summary: "x" }], proposals: [] });
    assert.equal(notes[0].level, "warn");
    assert.match(notes[0].message, /not an AI/);
    assert.match(notes[0].message, /No AI provider is attached/);
  });
  withUi((notes) => {
    reportAnalysis({ source: "adapter", events: [{ summary: "x" }], proposals: [] });
    assert.equal(notes[0].level, "info");
  });
});

test("Rest: each fallback warning is permanent and new milestone proposals are named", () => {
  withUi((notes) => {
    reportRest({
      gainedLevels: [20],
      capstoneProposals: [{ id: "proposal:capstone-20", entry: { name: "Ember Crown" } }],
      classProposals: [{ id: "proposal:class-evolution-20", entry: { name: "Warden Ascendant" } }],
      warnings: ["Capstone Skill at Grand Design level 20: used the built-in template (no AI provider is configured). The GM should review and flesh it out."]
    }, "long");
    const warns = notes.filter((note) => note.level === "warn");
    assert.equal(warns.length, 1);
    assert.equal(warns[0].options.permanent, true);
    assert.match(warns[0].message, /built-in template/);
    const named = notes.find((note) => note.level === "info" && /milestone proposals/.test(note.message));
    assert.match(named.message, /Ember Crown, Warden Ascendant/);
  });
  withUi((notes) => {
    reportRest({ gainedLevels: [], capstoneProposals: [], classProposals: [] }, "short");
    assert.equal(notes.length, 1);
    assert.match(notes[0].message, /No level was reached/);
  });
});

test("proposal chips: class-evolution is not 'template'; a fallback is flagged", () => {
  const cls = renderProposal({ id: "p", status: "pending", source: "class-evolution", entry: { name: "Warden Ascendant" } });
  assert.match(cls, /class evolution/);
  assert.doesNotMatch(cls, />template</);
  const fb = renderProposal({ id: "p", status: "pending", source: "class-evolution", usedFallback: true, entry: { name: "Warden" } });
  assert.match(fb, /class evolution/);
  assert.match(fb, />template</);
  assert.match(renderProposal({ id: "c", status: "pending", source: "capstone", entry: { name: "Cap" } }), /capstone/);
  assert.match(renderProposal({ id: "t", status: "pending", source: "template", entry: { name: "T" } }), />template</);
});

test("with no provider the Suggest button renders disabled with a reason", () => {
  const html = renderGrowthContent({
    growth: { events: [] },
    progression: { level: 3, grantAllowances: 2 },
    pending: [],
    status: { kind: "local", text: "Local", title: "none" }
  });
  assert.match(html, /data-action="gd-suggest-proposals"[^>]*disabled title="Needs an AI provider/);
  assert.match(html, /data-gd-open-gateway/);
  const ok = renderGrowthContent({ growth: { events: [] }, progression: { level: 3, grantAllowances: 2 }, pending: [], status: { kind: "ai", text: "AI", title: "t" } });
  assert.doesNotMatch(ok, /gd-suggest-proposals"[^>]*disabled/);
});

test("build stamp shows in Under the hood and the gateway form", () => {
  assert.equal(BUILD.sha, "dev", "the committed default is the dev stamp");
  assert.match(describeBuild(), /^dev/);
  assert.equal(describeBuild({ sha: "abc1234", builtAt: "2026-09-29T12:34:56", dirty: true }), "abc1234 (2026-09-29 12:34, uncommitted changes)");
  const hood = renderUnderTheHood({ diagnostics: {} }, { source: "adapter", gatewayDiagnostics: { model: "m" } });
  assert.match(hood, /Module build:<\/strong> dev/);
  assert.equal(renderUnderTheHood(null, null), "", "build alone does not conjure the section");
  assert.match(renderGatewayForm({ provider: "disabled" }), /Build: dev/);
});
