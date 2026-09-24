import assert from "node:assert/strict";
import test from "node:test";

import { CREATIVITY_LEVELS, GATEWAY_DEFAULTS, normalizeGatewayConfig, PIPELINES, PROPOSAL_MODES } from "../scripts/ai/gateway-config.js";

// normalizeGatewayConfig is fed by a Foundry settings form, a world setting written by an older
// module version, and hand-edited JSON. Its one job is to never let any of those break "Analyze
// Notes": clamp what is out of range, ignore what is the wrong type, and always return every key.

const CONTRACT_KEYS = [
  "provider", "endpoint", "model", "apiKey", "temperature", "numCtx", "numPredict", "timeoutMs", "maxRepairAttempts",
  "pipeline", "chunkChars", "proposalMode", "maxProposals", "creativity", "allowRed", "emergentThemes", "outputLanguage",
  "namingStyle", "houseRules", "customSynonyms", "toneHints", "extractionExamples"
];

test("GATEWAY_DEFAULTS carries every contract key with the contract's defaults", () => {
  for (const key of CONTRACT_KEYS) assert.ok(key in GATEWAY_DEFAULTS, key);
  assert.equal(GATEWAY_DEFAULTS.temperature, 0.2);
  assert.equal(GATEWAY_DEFAULTS.numCtx, 16384);
  assert.equal(GATEWAY_DEFAULTS.numPredict, 3072);
  assert.equal(GATEWAY_DEFAULTS.timeoutMs, 180000);
  assert.equal(GATEWAY_DEFAULTS.maxRepairAttempts, 2);
  assert.equal(GATEWAY_DEFAULTS.pipeline, "two-stage");
  assert.equal(GATEWAY_DEFAULTS.chunkChars, 2400);
  assert.equal(GATEWAY_DEFAULTS.proposalMode, "when-earned");
  assert.equal(GATEWAY_DEFAULTS.maxProposals, 3);
  assert.equal(GATEWAY_DEFAULTS.creativity, "balanced");
  assert.equal(GATEWAY_DEFAULTS.allowRed, true);
  assert.equal(GATEWAY_DEFAULTS.emergentThemes, true);
  assert.equal(GATEWAY_DEFAULTS.outputLanguage, "en");
  assert.equal(GATEWAY_DEFAULTS.houseRules, "");
});

test("an empty / missing partial returns the full default config", () => {
  for (const partial of [undefined, {}, null]) {
    const config = normalizeGatewayConfig(partial);
    for (const key of CONTRACT_KEYS) assert.deepEqual(config[key], GATEWAY_DEFAULTS[key], key);
  }
});

test("garbage input of any type never throws and always yields every key", () => {
  const garbage = [42, "x", [], true, () => {}, Symbol("s"), { temperature: {} }, { numCtx: [] }, { customSynonyms: 7 }, { extractionExamples: "{" }, Object.create(null)];
  for (const partial of garbage) {
    let config;
    assert.doesNotThrow(() => { config = normalizeGatewayConfig(partial); }, String(partial?.toString?.() ?? typeof partial));
    for (const key of CONTRACT_KEYS) assert.ok(key in config, key);
  }
});

test("temperature is clamped to 0..1.5 and accepts numeric strings", () => {
  assert.equal(normalizeGatewayConfig({ temperature: 9 }).temperature, 1.5);
  assert.equal(normalizeGatewayConfig({ temperature: -1 }).temperature, 0);
  assert.equal(normalizeGatewayConfig({ temperature: "0.7" }).temperature, 0.7);
  assert.equal(normalizeGatewayConfig({ temperature: "hot" }).temperature, 0.2);
  assert.equal(normalizeGatewayConfig({ temperature: NaN }).temperature, 0.2);
});

test("integer knobs are rounded and clamped", () => {
  const config = normalizeGatewayConfig({ numCtx: 1, numPredict: 10 ** 9, chunkChars: "1200.6", maxProposals: -3, maxRepairAttempts: 99 });
  assert.ok(config.numCtx >= 2048);
  assert.ok(config.numPredict <= 32768);
  assert.equal(config.chunkChars, 1201);
  assert.equal(config.maxProposals, 0);
  assert.ok(config.maxRepairAttempts <= 5);
});

test("maxProposals 0 is allowed (a GM may want events only)", () => {
  assert.equal(normalizeGatewayConfig({ maxProposals: 0 }).maxProposals, 0);
});

test("enum knobs accept any case and fall back on unknown values", () => {
  assert.equal(normalizeGatewayConfig({ pipeline: "SINGLE" }).pipeline, "single");
  assert.equal(normalizeGatewayConfig({ pipeline: "three-stage" }).pipeline, "two-stage");
  assert.equal(normalizeGatewayConfig({ proposalMode: "Always" }).proposalMode, "always");
  assert.equal(normalizeGatewayConfig({ proposalMode: "sometimes" }).proposalMode, "when-earned");
  assert.equal(normalizeGatewayConfig({ creativity: "WILD" }).creativity, "wild");
  assert.equal(normalizeGatewayConfig({ creativity: 3 }).creativity, "balanced");
  for (const value of PIPELINES) assert.equal(normalizeGatewayConfig({ pipeline: value }).pipeline, value);
  for (const value of PROPOSAL_MODES) assert.equal(normalizeGatewayConfig({ proposalMode: value }).proposalMode, value);
  for (const value of CREATIVITY_LEVELS) assert.equal(normalizeGatewayConfig({ creativity: value }).creativity, value);
});

test("provider aliases normalize to the three transport providers", () => {
  const cases = { ollama: "ollama", "ollama-native": "ollama", OpenAI: "openaiCompatible", "lm-studio": "openaiCompatible", openaiCompatible: "openaiCompatible", hosted: "hosted", openrouter: "hosted", bogus: "ollama", 5: "ollama" };
  for (const [raw, expected] of Object.entries(cases)) assert.equal(normalizeGatewayConfig({ provider: raw }).provider, expected, raw);
});

test("booleans accept real booleans and their string/number forms, otherwise default", () => {
  assert.equal(normalizeGatewayConfig({ allowRed: false }).allowRed, false);
  assert.equal(normalizeGatewayConfig({ allowRed: "false" }).allowRed, false);
  assert.equal(normalizeGatewayConfig({ allowRed: 0 }).allowRed, false);
  assert.equal(normalizeGatewayConfig({ emergentThemes: "true" }).emergentThemes, true);
  assert.equal(normalizeGatewayConfig({ emergentThemes: "maybe" }).emergentThemes, true);
});

test("outputLanguage accepts codes and friendly names, else falls back to en", () => {
  assert.equal(normalizeGatewayConfig({ outputLanguage: "Spanish" }).outputLanguage, "es");
  assert.equal(normalizeGatewayConfig({ outputLanguage: "ελληνικά" }).outputLanguage, "el");
  assert.equal(normalizeGatewayConfig({ outputLanguage: "pt-BR" }).outputLanguage, "pt-br");
  assert.equal(normalizeGatewayConfig({ outputLanguage: "Klingon!!" }).outputLanguage, "en");
});

test("houseRules is capped at 4000 chars and trimmed; free-text knobs ignore non-strings", () => {
  const config = normalizeGatewayConfig({ houseRules: "  " + "r".repeat(5000), namingStyle: 42, toneHints: ["x"] });
  assert.equal(config.houseRules.length, 4000);
  assert.equal(config.namingStyle, "");
  assert.equal(config.toneHints, "");
});

test("customSynonyms accepts an object or a JSON string and drops non-string pairs", () => {
  assert.deepEqual(normalizeGatewayConfig({ customSynonyms: { hearthcraft: "craft", bad: 5, "": "x" } }).customSynonyms, { hearthcraft: "craft" });
  assert.deepEqual(normalizeGatewayConfig({ customSynonyms: '{"brewing":"craft"}' }).customSynonyms, { brewing: "craft" });
  assert.deepEqual(normalizeGatewayConfig({ customSynonyms: "{not json" }).customSynonyms, {});
  assert.deepEqual(normalizeGatewayConfig({ customSynonyms: ["craft"] }).customSynonyms, {});
});

test("extractionExamples keeps at most 5 well-formed examples", () => {
  const good = (i) => ({ notes: `Kesh fought ${i}`, events: [{ summary: "x", tags: ["martial"], outcome: "success" }] });
  const config = normalizeGatewayConfig({ extractionExamples: [good(1), { notes: "" }, null, 5, good(2), good(3), good(4), good(5), good(6)] });
  assert.equal(config.extractionExamples.length, 5);
  assert.equal(config.extractionExamples[0].notes, "Kesh fought 1");
  assert.deepEqual(normalizeGatewayConfig({ extractionExamples: JSON.stringify([good(9)]) }).extractionExamples.length, 1);
});

test("injectable hooks (fetchImpl, sleep, getHeaders) pass through; non-functions do not", () => {
  const fetchImpl = async () => {};
  const config = normalizeGatewayConfig({ fetchImpl, sleep: "no", getHeaders: () => ({}) });
  assert.equal(config.fetchImpl, fetchImpl);
  assert.equal("sleep" in config, false);
  assert.equal(typeof config.getHeaders, "function");
});

test("normalizing is idempotent", () => {
  const once = normalizeGatewayConfig({ temperature: 3, pipeline: "SINGLE", outputLanguage: "German", customSynonyms: '{"a":"craft"}' });
  const twice = normalizeGatewayConfig(once);
  assert.deepEqual(twice, once);
});

test("the returned config is a fresh object (mutating it never changes the defaults)", () => {
  const config = normalizeGatewayConfig({});
  config.customSynonyms.x = "craft";
  config.extractionExamples?.push?.({ notes: "x" });
  assert.deepEqual(GATEWAY_DEFAULTS.customSynonyms, {});
  assert.equal(normalizeGatewayConfig({}).extractionExamples.length, 0);
});
