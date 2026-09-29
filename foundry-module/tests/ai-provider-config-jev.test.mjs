import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildGatewayConfig,
  buildJevConfig,
  CLIENT_JEV_KEY_SETTING,
  CLIENT_TUNING_SETTING,
  defaultGatewaySettings,
  describeJevError,
  formDataToJev,
  formDataToSettings,
  normalizeJevTuning,
  renderGatewayForm,
  renderJevTestResult,
  settingsWrites,
  testJevConnection,
  WORLD_FLAVOR_SETTING
} from "../scripts/ai-provider-config.js";

// Board 642a0bda: the Jev (TypeSafe) fieldset in the AI Gateway settings (docs/jev-layer-contract.md "UI").

const KEY = "ts-secret-key-123";
const baseForm = { provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "qwen3.8:27b", apiKey: "" };
const jevForm = {
  jevEnabled: "on",
  jevApiKey: ` ${KEY} `,
  jevEndpoint: "https://jev-proxy.example.com/",
  jevModel: "jev-latest",
  jevTimeoutMs: "8000",
  jevTriage: "on",
  jevVerify: "on",
  // jevAttribution / jevRank unchecked -> absent from formData
  jevTriageThreshold: "0.2",
  jevOverrideConfidence: "1.7"
};

test("the key setting has its own name (registration scope is pinned by the Foundry wiring test below)", () => {
  assert.equal(CLIENT_JEV_KEY_SETTING, "jevApiKey");
});

test("form parsing: toggles, trimmed key, clamped thresholds, endpoint trailing slash removed", () => {
  const parsed = formDataToJev(jevForm);
  assert.equal(parsed.apiKey, KEY);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.tuning, {
    enabled: true,
    endpoint: "https://jev-proxy.example.com",
    model: "jev-latest",
    timeoutMs: 8000,
    triage: true,
    attribution: false,
    verify: true,
    rank: false,
    triageThreshold: 0.2,
    overrideConfidence: 1
  });
  assert.equal("apiKey" in parsed.tuning, false, "the tuning never carries the key");
});

test("form without any Jev field changes nothing (older forms / callers)", () => {
  assert.equal(formDataToJev(baseForm), null);
  const parsed = formDataToSettings(baseForm);
  assert.equal(parsed.client.jev, undefined);
  assert.equal(parsed.basics.jevApiKey, undefined);
  assert.deepEqual(parsed.errors, []);
});

test("enabled without a key blocks Save with a clear reason; off without a key is fine", () => {
  const { errors } = formDataToSettings({ ...baseForm, jevEnabled: "on", jevApiKey: "" });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Jev is switched on but has no API key/);
  assert.deepEqual(formDataToSettings({ ...baseForm, jevApiKey: "" }).errors, []);
  // The fieldset is hidden with the provider disabled, so it cannot block Save there.
  assert.deepEqual(formDataToSettings({ provider: "disabled", jevEnabled: "on", jevApiKey: "" }).errors, []);
});

test("a remote plain-HTTP Jev endpoint is rejected; a localhost proxy is allowed", () => {
  const remote = formDataToSettings({ ...baseForm, ...jevForm, jevEndpoint: "http://jev.example.com" });
  assert.ok(remote.errors.some((error) => /^Jev endpoint: Remote AI endpoints must use HTTPS/.test(error)));
  assert.deepEqual(formDataToSettings({ ...baseForm, ...jevForm, jevEndpoint: "http://127.0.0.1:8787" }).errors, []);
});

test("config merge: the gateway receives jev with the key; world flavor never sees it", () => {
  const parsed = formDataToSettings({ ...baseForm, ...jevForm });
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.basics.jevApiKey, KEY);
  assert.equal(JSON.stringify(parsed.world).includes(KEY), false);
  assert.equal(JSON.stringify(parsed.client).includes(KEY), false);
  const config = buildGatewayConfig(parsed);
  assert.equal(config.jev.enabled, true);
  assert.equal(config.jev.apiKey, KEY);
  assert.equal(config.jev.endpoint, "https://jev-proxy.example.com");
  assert.equal(config.jev.triage, true);
  assert.equal(config.jev.attribution, false);
  // Existing fields untouched.
  assert.equal(config.provider, "ollama");
  assert.equal(config.model, "qwen3.8:27b");
});

test("unconfigured Jev: off, empty key, contract defaults -- and the rest of the config is unchanged", () => {
  const before = buildGatewayConfig({ basics: { provider: "ollama" } });
  assert.deepEqual(before.jev, { ...normalizeJevTuning({}), enabled: false, apiKey: "" });
  assert.equal(before.jev.endpoint, "https://api.typesafe.ai");
  assert.equal(before.jev.model, "jev-latest");
  assert.equal(before.jev.triageThreshold, 0.12);
  assert.equal(before.jev.overrideConfidence, 0.85);
  // Enabled in tuning but no key -> forced off (contract invariant 1).
  assert.equal(buildGatewayConfig({ basics: { provider: "ollama" }, client: { jev: { enabled: true } } }).jev.enabled, false);
  assert.equal(buildJevConfig({ enabled: true }, "  ").enabled, false);
  assert.equal(buildJevConfig({ enabled: true }, "k").enabled, true);
  // Everything except `jev` matches a config built without any Jev input at all.
  const { jev: _a, ...rest } = before;
  const { jev: _b, ...restWithTuning } = buildGatewayConfig({ basics: { provider: "ollama", jevApiKey: KEY }, client: { jev: { enabled: true } } });
  assert.deepEqual(restWithTuning, rest);
});

test("stored tuning is normalized: junk, stray apiKey and out-of-range values", () => {
  const tuning = normalizeJevTuning({ apiKey: "leak", enabled: "yes", timeoutMs: 5, triageThreshold: -1, bogus: 1, model: "  " });
  assert.equal("apiKey" in tuning, false);
  assert.equal("bogus" in tuning, false);
  assert.equal(tuning.enabled, false);
  assert.equal(tuning.timeoutMs, 1000);
  assert.equal(tuning.triageThreshold, 0);
  assert.equal(tuning.model, "jev-latest");
  assert.deepEqual(normalizeJevTuning("not an object"), normalizeJevTuning({}));
});

test("Save writes: key only to its client setting, tuning JSON under jev without the key, world only for a GM", () => {
  const parsed = formDataToSettings({ ...baseForm, ...jevForm });
  // Even if something smuggled a key into the tuning object, it is not written.
  parsed.client.jev = { ...parsed.client.jev, apiKey: KEY };
  const gm = new Map(settingsWrites(parsed, { isGM: true }));
  assert.equal(gm.get(CLIENT_JEV_KEY_SETTING), KEY);
  const tuning = JSON.parse(gm.get(CLIENT_TUNING_SETTING));
  assert.equal(tuning.jev.enabled, true);
  assert.equal(tuning.jev.triageThreshold, 0.2);
  assert.equal(gm.get(CLIENT_TUNING_SETTING).includes(KEY), false);
  assert.equal(gm.get(WORLD_FLAVOR_SETTING).includes(KEY), false);
  for (const [setting, value] of gm) {
    if (setting !== CLIENT_JEV_KEY_SETTING) assert.equal(String(value).includes(KEY), false, `${setting} must not hold the key`);
  }
  const player = new Map(settingsWrites(parsed, { isGM: false }));
  assert.equal(player.has(WORLD_FLAVOR_SETTING), false);
});

test("Save writes without Jev fields: no jevApiKey write and no jev block (behaves as before)", () => {
  const parsed = formDataToSettings(baseForm);
  const writes = new Map(settingsWrites(parsed, { isGM: true }));
  assert.equal(writes.has(CLIENT_JEV_KEY_SETTING), false);
  assert.equal("jev" in JSON.parse(writes.get(CLIENT_TUNING_SETTING)), false);
});

test("Reset to defaults includes Jev off with an empty key", () => {
  const defaults = defaultGatewaySettings("ollama");
  assert.equal(defaults.basics.jevApiKey, "");
  assert.equal(defaults.client.jev.enabled, false);
  assert.equal(buildGatewayConfig(defaults).jev.enabled, false);
});

test("form HTML: Jev fieldset collapsed while off, password key field, round-trips through the parser", () => {
  const offHtml = renderGatewayForm(buildGatewayConfig({ basics: { provider: "ollama" } }), {});
  assert.match(offHtml, /Jev \(TypeSafe\) — optional speed-up/);
  assert.match(offHtml, /<input type="checkbox" name="jevEnabled" >/);
  assert.match(offHtml, /class="gd-jev-body" style="display:none"/);
  const config = buildGatewayConfig(formDataToSettings({ ...baseForm, ...jevForm }));
  const html = renderGatewayForm(config, {});
  assert.match(html, /name="jevEnabled" checked/);
  assert.match(html, /<div class="gd-jev-body">/);
  assert.match(html, /name="jevApiKey" type="password"/);
  assert.match(html, /name="jevTriage" checked/);
  assert.match(html, /name="jevAttribution" >/);
  assert.match(html, /<details class="gd-jev-advanced">[^]*name="jevTriageThreshold"[^]*name="jevOverrideConfidence"/);
  assert.match(html, /data-action="test-jev"/);
  // Scrape the rendered inputs back into formData, as the browser would submit them.
  const formData = {};
  for (const match of html.matchAll(/<input ([^>]*)>/g)) {
    const attrs = Object.fromEntries([...match[1].matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    if (!attrs.name?.startsWith("jev")) continue;
    if (attrs.type === "checkbox") {
      if (/\bchecked\b/.test(match[1])) formData[attrs.name] = "on";
    } else formData[attrs.name] = attrs.value;
  }
  assert.deepEqual(formDataToJev(formData).tuning, formDataToJev(jevForm).tuning);
  assert.equal(formDataToJev(formData).apiKey, KEY);
});

test("provider disabled hides the Jev fieldset with the other AI-only parts", () => {
  const html = renderGatewayForm(buildGatewayConfig({}), {});
  assert.match(html, /<fieldset class="gd-jev gd-ai-only" style="display:none">/);
});

test("form HTML escapes a hostile Jev endpoint/model", () => {
  const html = renderGatewayForm(buildGatewayConfig({ basics: { provider: "ollama", jevApiKey: '"><script>k</script>' }, client: { jev: { enabled: true, model: '"><img src=x onerror=alert(1)>' } } }), {});
  assert.doesNotMatch(html, /<script>k/);
  assert.doesNotMatch(html, /<img src=x/);
});

// ---- Test Jev ---------------------------------------------------------------------------------

const jevConfig = buildJevConfig({ enabled: true }, KEY);
const loader = (ping, seen = {}) => async () => ({
  createJevClient: (options) => {
    seen.options = options;
    return { ping, info: { endpoint: options.endpoint, model: options.model } };
  }
});

test("Test Jev success: ms and model list; the client gets key/endpoint/model/timeout", async () => {
  const seen = {};
  const result = await testJevConnection(jevConfig, { loadJev: loader(async () => ({ ok: true, ms: 212.4, models: [{ name: "jev-latest" }, "jev-1"] }), seen) });
  assert.deepEqual(result, { ok: true, ms: 212.4, models: ["jev-latest", "jev-1"] });
  assert.deepEqual(seen.options, { apiKey: KEY, endpoint: "https://api.typesafe.ai", model: "jev-latest", timeoutMs: 10000 });
  const html = renderJevTestResult(result);
  assert.match(html, /Jev answered in 212 ms/);
  assert.match(html, /Models: jev-latest, jev-1/);
  assert.equal(html.includes(KEY), false);
});

test("Test Jev: a CORS / network failure says the browser blocked it and suggests a proxy endpoint", async () => {
  for (const ping of [
    async () => ({ ok: false, error: "Failed to fetch" }),
    async () => ({ ok: false, error: { message: "request failed", kind: "cors" } }),
    async () => { throw Object.assign(new TypeError("NetworkError when attempting to fetch resource."), { kind: "network" }); }
  ]) {
    const result = await testJevConnection(jevConfig, { loadJev: loader(ping) });
    assert.equal(result.ok, false);
    const html = renderJevTestResult(result);
    assert.match(html, /browser blocked the call/);
    assert.match(html, /proxy that adds CORS headers/);
  }
});

test("Test Jev: 401, timeout and other errors read plainly", () => {
  assert.match(describeJevError({ ok: false, status: 401, error: "HTTP 401" }), /rejected the API key/);
  assert.match(describeJevError({ ok: false, kind: "timeout", error: "Jev timed out after 10000 ms" }), /did not answer in time/);
  assert.equal(describeJevError({ ok: false, error: "HTTP 500: upstream" }), "HTTP 500: upstream");
  assert.equal(describeJevError({ ok: false }), "The Jev test failed.");
});

test("Test Jev without a key, with a bad endpoint, or without jev.js never throws", async () => {
  assert.match((await testJevConnection(buildJevConfig({}, ""))).error, /Paste a Jev API key/);
  assert.match((await testJevConnection(buildJevConfig({ endpoint: "http://jev.example.com" }, KEY))).error, /^Jev endpoint:/);
  const missing = await testJevConnection(jevConfig, { loadJev: async () => { throw new Error("Cannot find module"); } });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no Jev client yet/);
  const nullClient = await testJevConnection(jevConfig, { loadJev: async () => ({ createJevClient: () => null }) });
  assert.equal(nullClient.ok, false);
});

// ---- Foundry wiring, with a fake `game` --------------------------------------------------------

function withFakeFoundry(run) {
  const saved = { game: globalThis.game, ui: globalThis.ui, FormApplication: globalThis.FormApplication };
  const store = new Map();
  const registered = [];
  const sets = [];
  const menus = [];
  globalThis.FormApplication = class {};
  globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
  globalThis.game = {
    user: { isGM: true },
    settings: {
      register: (mod, key, options) => registered.push({ mod, key, options }),
      registerMenu: (mod, key, options) => menus.push({ mod, key, options }),
      get: (mod, key) => store.get(`${mod}.${key}`),
      set: async (mod, key, value) => { sets.push([key, value]); store.set(`${mod}.${key}`, value); }
    },
    modules: { get: () => ({ api: { setProposalAdapter() {} } }) }
  };
  return Promise.resolve(run({ store, registered, sets, menus })).finally(() => Object.assign(globalThis, saved));
}

test("Foundry wiring: jevApiKey registered client-scoped, read into the config, and never written to the world setting", async () => {
  const { registerAiProviderSettings, getGatewayConfig, persistSettings, readStoredSettings } = await import("../scripts/ai-provider-config.js");
  await withFakeFoundry(async ({ store, registered, sets, menus }) => {
    // (a) registration
    registerAiProviderSettings();
    const keySetting = registered.find((entry) => entry.key === CLIENT_JEV_KEY_SETTING);
    assert.ok(keySetting, "jevApiKey is registered");
    assert.equal(keySetting.options.scope, "client", "same mechanism as aiApiKey: never a user/world setting");
    assert.equal(keySetting.options.config, false);
    assert.equal(typeof keySetting.options.onChange, "function", "a key change rebuilds the adapter like every other gateway setting");
    assert.equal(registered.find((entry) => entry.key === "aiApiKey").options.scope, "client");
    assert.equal(registered.find((entry) => entry.key === WORLD_FLAVOR_SETTING).options.scope, "world");

    // (b) stored key + tuning -> enabled config carrying the key
    store.set("grand-design-ai.aiProvider", "ollama");
    store.set(`grand-design-ai.${CLIENT_JEV_KEY_SETTING}`, KEY);
    store.set(`grand-design-ai.${CLIENT_TUNING_SETTING}`, JSON.stringify({ temperature: 0.3, jev: { enabled: true, triageThreshold: 0.3 } }));
    const config = getGatewayConfig();
    assert.equal(config.jev.enabled, true);
    assert.equal(config.jev.apiKey, KEY);
    assert.equal(config.jev.triageThreshold, 0.3);
    assert.equal(config.temperature, 0.3);
    // An unreadable key setting still yields a config, with Jev off.
    const savedGet = globalThis.game.settings.get;
    globalThis.game.settings.get = (mod, key) => { if (key === CLIENT_JEV_KEY_SETTING) throw new Error("unregistered"); return savedGet(mod, key); };
    assert.equal(getGatewayConfig().jev.enabled, false);
    assert.equal(readStoredSettings().basics.jevApiKey, "");
    globalThis.game.settings.get = savedGet;

    // (c) the real save path as a GM: the key goes to its own setting only
    const parsed = formDataToSettings({ ...baseForm, ...jevForm, houseRules: "no flight" });
    assert.deepEqual(parsed.errors, []);
    sets.length = 0;
    await persistSettings(parsed);
    const byKey = new Map(sets);
    assert.equal(byKey.get(CLIENT_JEV_KEY_SETTING), KEY);
    assert.ok(byKey.has(WORLD_FLAVOR_SETTING), "a GM writes the world flavor");
    assert.match(byKey.get(WORLD_FLAVOR_SETTING), /no flight/);
    for (const [key, value] of sets) if (key !== CLIENT_JEV_KEY_SETTING) assert.equal(String(value).includes(KEY), false, `${key} carries the key`);

    // Same through the settings class's _updateObject (what Foundry calls on Save).
    const Settings = menus.find((menu) => menu.key === "aiProviderSetup").options.type;
    const app = Object.create(Settings.prototype);
    app.close = () => {};
    sets.length = 0;
    await app._updateObject(null, { ...baseForm, ...jevForm, jevApiKey: "second-key" });
    assert.equal(new Map(sets).get(CLIENT_JEV_KEY_SETTING), "second-key");
    assert.ok(sets.every(([key, value]) => key === CLIENT_JEV_KEY_SETTING || !String(value).includes("second-key")));
    assert.equal(getGatewayConfig().jev.apiKey, "second-key");

    // A player never writes the world setting at all.
    globalThis.game.user.isGM = false;
    sets.length = 0;
    await persistSettings(parsed);
    assert.equal(sets.some(([key]) => key === WORLD_FLAVOR_SETTING), false);
    assert.equal(new Map(sets).get(CLIENT_JEV_KEY_SETTING), KEY);
  });
});

test('Jev number inputs accept any hand-typed value (step="any"); the normalizer clamps instead', () => {
  const html = renderGatewayForm(buildGatewayConfig({ basics: { provider: "ollama", jevApiKey: KEY }, client: { jev: { enabled: true } } }), {});
  for (const name of ["jevTriageThreshold", "jevOverrideConfidence", "jevTimeoutMs"]) {
    assert.match(html, new RegExp(`name="${name}"[^>]*step="any"`), name);
  }
});

test("every new visible settings string has an en.json entry", () => {
  const lang = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
  const jev = lang.GRAND_DESIGN_AI.Gateway.Jev;
  const html = renderGatewayForm(buildGatewayConfig({ basics: { provider: "ollama", jevApiKey: KEY }, client: { jev: { enabled: true } } }), {});
  for (const key of ["Legend", "Help", "Enabled", "ApiKey", "Endpoint", "Model", "Triage", "Attribution", "Verify", "Rank", "Advanced", "TriageThreshold", "OverrideConfidence", "TimeoutMs", "Test", "TestHint"]) {
    assert.ok(html.includes(jev[key].replaceAll("'", "&#039;")) || html.includes(jev[key]), `form shows en.json Gateway.Jev.${key}`);
  }
});
