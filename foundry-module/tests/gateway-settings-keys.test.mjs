import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGatewayConfig,
  CLIENT_TUNING_KEYS,
  defaultGatewaySettings,
  formDataToSettings,
  migrateOutputLanguage,
  planOutputLanguageMigration,
  renderGatewayForm,
  WORLD_FLAVOR_KEYS
} from "../scripts/ai-provider-config.js";
import { GATEWAY_DEFAULTS, pendingProposalCap } from "../scripts/ai/gateway-config.js";

// Board 5b2ff22d: buildGatewayConfig keeps only listed keys, so these knobs were unreachable (the
// pending cap was always 5, retries/cache always default) and outputLanguage was per-browser.

const NEW_CLIENT = ["maxRetries", "transientRetries", "transientBackoffMs", "extractionCacheEntries", "extractionCacheTtlMs"];
const NEW_WORLD = ["pendingProposalCapExtra", "pendingProposalCapMin", "outputLanguage"];

test("every gateway-config knob a GM can set is in exactly one stored layer", () => {
  for (const key of NEW_CLIENT) assert.ok(CLIENT_TUNING_KEYS.includes(key), `${key} is client tuning`);
  for (const key of NEW_WORLD) assert.ok(WORLD_FLAVOR_KEYS.includes(key), `${key} is world flavor`);
  assert.ok(!CLIENT_TUNING_KEYS.includes("outputLanguage"), "outputLanguage is table-wide now");
  const overlap = CLIENT_TUNING_KEYS.filter((key) => WORLD_FLAVOR_KEYS.includes(key));
  assert.deepEqual(overlap, []);
  // Everything in GATEWAY_DEFAULTS except the connection basics is reachable from the form.
  const basics = new Set(["provider", "endpoint", "model", "apiKey"]);
  // `jev` is a nested sub-config (docs/jev-layer-contract.md) with its own fieldset: its knobs are
  // stored under the client tuning JSON's `jev` key via normalizeJevTuning and the key in jevApiKey.
  const nested = new Set(["jev"]);
  const unreachable = Object.keys(GATEWAY_DEFAULTS).filter((key) => !basics.has(key) && !nested.has(key) && !CLIENT_TUNING_KEYS.includes(key) && !WORLD_FLAVOR_KEYS.includes(key));
  assert.deepEqual(unreachable, []);
});

test("the pending cap from the world setting reaches the config and pendingProposalCap", () => {
  const config = buildGatewayConfig({ basics: { provider: "ollama" }, world: { pendingProposalCapExtra: 0, pendingProposalCapMin: 2 } });
  assert.equal(config.pendingProposalCapExtra, 0);
  assert.equal(config.pendingProposalCapMin, 2);
  assert.equal(pendingProposalCap(config, 0), 2);
  assert.equal(pendingProposalCap(config, 3), 3);
  // Before the fix the same world blob was dropped and the cap stayed 5.
  assert.equal(pendingProposalCap(buildGatewayConfig({ basics: { provider: "ollama" } }), 0), 5);
});

test("retries, backoff and extraction cache come from the client layer, clamped", () => {
  const config = buildGatewayConfig({
    basics: { provider: "ollama" },
    client: { maxRetries: 0, transientRetries: 9, transientBackoffMs: 500, extractionCacheEntries: 0, extractionCacheTtlMs: 60000 }
  });
  assert.equal(config.maxRetries, 0);
  assert.equal(config.transientRetries, 5, "clamped by normalizeGatewayConfig");
  assert.equal(config.transientBackoffMs, 500);
  assert.equal(config.extractionCacheEntries, 0);
  assert.equal(config.extractionCacheTtlMs, 60000);
});

test("outputLanguage: the world wins; an old client value still applies until migrated", () => {
  assert.equal(buildGatewayConfig({ basics: { provider: "ollama" }, client: { outputLanguage: "es" } }).outputLanguage, "es");
  assert.equal(buildGatewayConfig({ basics: { provider: "ollama" }, client: { outputLanguage: "es" }, world: { outputLanguage: "el" } }).outputLanguage, "el");
  assert.equal(buildGatewayConfig({ basics: { provider: "ollama" } }).outputLanguage, "en");
});

test("formDataToSettings routes the new fields and treats an emptied number box as default, not 0", () => {
  const { client, world, errors } = formDataToSettings({
    provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "m",
    maxRetries: "1", transientRetries: "", transientBackoffMs: "2000", extractionCacheEntries: "", extractionCacheTtlMs: "0",
    pendingProposalCapExtra: "1", pendingProposalCapMin: "3", outputLanguage: "German"
  });
  assert.deepEqual(errors, []);
  assert.equal(client.maxRetries, 1);
  assert.equal(client.transientBackoffMs, 2000);
  assert.equal(client.extractionCacheTtlMs, 0, "an explicit 0 is kept (turns the cache off)");
  assert.ok(!("transientRetries" in client), "empty box = default");
  assert.ok(!("extractionCacheEntries" in client));
  assert.ok(!("outputLanguage" in client));
  assert.equal(world.pendingProposalCapExtra, 1);
  assert.equal(world.pendingProposalCapMin, 3);
  assert.equal(world.outputLanguage, "German");
  const config = buildGatewayConfig({ basics: { provider: "ollama" }, client, world });
  assert.equal(config.outputLanguage, "de");
  assert.equal(config.transientRetries, GATEWAY_DEFAULTS.transientRetries);
  assert.equal(config.extractionCacheEntries, GATEWAY_DEFAULTS.extractionCacheEntries);
});

test("defaults cover the new keys", () => {
  const defaults = defaultGatewaySettings("ollama");
  for (const key of NEW_CLIENT) assert.equal(defaults.client[key], GATEWAY_DEFAULTS[key], key);
  for (const key of NEW_WORLD) assert.equal(defaults.world[key], GATEWAY_DEFAULTS[key], key);
});

test("the form shows every new field, language and cap under Table flavor", () => {
  const html = renderGatewayForm(buildGatewayConfig({ basics: { provider: "ollama" }, world: { pendingProposalCapMin: 7, outputLanguage: "es" } }));
  for (const key of [...NEW_CLIENT, ...NEW_WORLD]) assert.match(html, new RegExp(`name="${key}"`), key);
  const flavor = html.indexOf("<legend>Table flavor</legend>");
  assert.ok(flavor > 0);
  for (const key of NEW_WORLD) assert.ok(html.indexOf(`name="${key}"`) > flavor, `${key} is a table setting`);
  for (const key of NEW_CLIENT) assert.ok(html.indexOf(`name="${key}"`) < flavor, `${key} is per-browser tuning`);
  assert.match(html, /name="pendingProposalCapMin" min="1" max="20" step="1" value="7"/);
  assert.match(html, /name="outputLanguage" value="es"/);
});

test("planOutputLanguageMigration", () => {
  // A non-default client language moves to an empty world and leaves the client blob.
  let plan = planOutputLanguageMigration({ temperature: 0.3, outputLanguage: "es" }, { houseRules: "x" });
  assert.deepEqual(plan.client, { temperature: 0.3 });
  assert.deepEqual(plan.world, { houseRules: "x", outputLanguage: "es" });
  assert.equal(plan.changedClient, true);
  assert.equal(plan.changedWorld, true);
  // A world value already chosen wins; the stale client copy is still dropped.
  plan = planOutputLanguageMigration({ outputLanguage: "es" }, { outputLanguage: "el" });
  assert.equal(plan.world.outputLanguage, "el");
  assert.equal(plan.changedWorld, false);
  assert.equal(plan.changedClient, true);
  // The default "en" is not worth writing to the world.
  plan = planOutputLanguageMigration({ outputLanguage: "en" }, {});
  assert.equal(plan.world.outputLanguage, undefined);
  assert.equal(plan.changedWorld, false);
  // Nothing to do.
  plan = planOutputLanguageMigration({}, {});
  assert.equal(plan.changedClient || plan.changedWorld, false);
  assert.doesNotThrow(() => planOutputLanguageMigration(null, undefined));
});

function fakeSettings({ isGM, client, world, systemId }) {
  const values = new Map([["aiGatewayClient", JSON.stringify(client)], ["aiGatewayWorld", JSON.stringify(world)]]);
  const writes = [];
  const saved = globalThis.game;
  globalThis.game = {
    system: { id: systemId },
    user: { isGM },
    settings: {
      get: (_ns, key) => values.get(key),
      set: async (_ns, key, value) => { writes.push(key); values.set(key, value); return value; }
    }
  };
  return { values, writes, restore: () => { globalThis.game = saved; } };
}

for (const systemId of ["pf2e", "dnd5e"]) {
  test(`[${systemId}] migrateOutputLanguage moves a GM's client language to the world, world first`, async () => {
    const fake = fakeSettings({ isGM: true, client: { outputLanguage: "pt", numCtx: 8192 }, world: {}, systemId });
    try {
      await migrateOutputLanguage();
      assert.deepEqual(fake.writes, ["aiGatewayWorld", "aiGatewayClient"]);
      assert.equal(JSON.parse(fake.values.get("aiGatewayWorld")).outputLanguage, "pt");
      assert.deepEqual(JSON.parse(fake.values.get("aiGatewayClient")), { numCtx: 8192 });
      fake.writes.length = 0;
      await migrateOutputLanguage();
      assert.deepEqual(fake.writes, [], "idempotent");
    } finally { fake.restore(); }
  });

  test(`[${systemId}] a player's browser never writes the world setting`, async () => {
    const fake = fakeSettings({ isGM: false, client: { outputLanguage: "pt" }, world: {}, systemId });
    try {
      assert.equal(await migrateOutputLanguage(), null);
      assert.deepEqual(fake.writes, []);
    } finally { fake.restore(); }
  });
}
