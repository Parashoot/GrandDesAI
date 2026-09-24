import assert from "node:assert/strict";
import test from "node:test";

import { runGatewayPipeline } from "../scripts/ai/pipeline.js";
import { createTransport, AiProviderHttpError, AiProviderTimeoutError, AiProviderUnreachableError, AiProviderResponseError } from "../scripts/ai/transport.js";
import { ModelJsonError } from "../scripts/ai/json-repair.js";
import { validateGrowthEvent } from "../scripts/progression.js";
import { validateClassEntry, validateSkillEntry } from "../scripts/validator.js";
import { DEFAULT_FAULT_WEIGHTS, createSimModel } from "../tools/nlp-scale/sim-model.js";
import { buildHarnessRequest, runScale } from "../tools/nlp-scale/lib.mjs";
import { loadCorpusSync } from "./helpers/corpus.mjs";

// CONSISTENCY AT SCALE, offline. The real pipeline (transport -> json-repair -> coercion -> repair
// turns -> proposal repair -> validator) runs against the simulated model over the full labeled
// corpus, several seeds and several per-call fault rates: thousands of pipeline runs per `npm test`.
// The contract promise under test: the GM (almost) never gets sent to the local keyword fallback,
// nothing ever escapes as an unexpected exception, and nothing invalid ever comes out.

const corpus = loadCorpusSync();
const KNOWN_ERRORS = [AiProviderHttpError, AiProviderTimeoutError, AiProviderUnreachableError, AiProviderResponseError, ModelJsonError];

// Content faults the pipeline must SALVAGE, plus 5xx/429 bursts the transport must RETRY through.
const RECOVERABLE_WEIGHTS = { ...DEFAULT_FAULT_WEIGHTS, timeout: 0, network: 0 };

function simTransport({ seed, faultRate, faultWeights = DEFAULT_FAULT_WEIGHTS, provider = "ollama" }) {
  const sim = createSimModel({ corpus, seed, faultRate, faultWeights });
  const transport = createTransport({
    provider,
    endpoint: provider === "ollama" ? "http://127.0.0.1:11434" : "http://127.0.0.1:1234",
    model: "sim-model",
    fetchImpl: sim.fetch,
    timeoutMs: 5,
    sleep: async () => {},
    ollamaOptions: { num_ctx: 16384, num_predict: 3072 }
  });
  return { sim, transport };
}

/** Run the whole corpus once; return per-run outcomes plus every invariant violation found. */
async function sweep({ seed, faultRate, faultWeights, pipeline = "two-stage", proposalMode = "when-earned", provider = "ollama", systemId = "pf2e" }) {
  const { sim, transport } = simTransport({ seed, faultRate, faultWeights, provider });
  const runs = [];
  const violations = [];
  for (const item of corpus) {
    const request = buildHarnessRequest(item, systemId);
    request.actor.grandDesign.availableGrantAllowances = 1; // exercise the proposal stage often
    let result = null;
    let error = null;
    try {
      result = await runGatewayPipeline({ transport, request, config: { pipeline, proposalMode, maxRepairAttempts: 2 }, systemId });
    } catch (caught) {
      error = caught;
      if (!KNOWN_ERRORS.some((cls) => caught instanceof cls)) violations.push(`${item.id}: unexpected ${caught?.name}: ${caught?.message}`);
    }
    if (result) {
      for (const event of result.events) {
        const { valid, errors } = validateGrowthEvent(event);
        if (!valid) violations.push(`${item.id}: invalid event ${JSON.stringify(event)} ${errors.join(" ")}`);
      }
      for (const proposal of result.proposals) {
        const { valid, errors } = proposal.kind === "class" ? validateClassEntry(proposal.entry) : validateSkillEntry(proposal.entry);
        if (!valid) violations.push(`${item.id}: invalid proposal ${proposal.entry?.name}: ${errors.join(" ")}`);
      }
      if (!Array.isArray(result.skippedEvents) || !Array.isArray(result.skippedProposals)) violations.push(`${item.id}: missing skipped arrays`);
    }
    runs.push({ id: item.id, error: error ? `${error.name}: ${error.message.slice(0, 60)}` : null, result });
  }
  return { runs, violations, stats: sim.stats };
}

const fallbackRate = (runs) => runs.filter((run) => run.error).length / runs.length;

function fingerprint(runs) {
  // Everything the GM would see, minus wall-clock timings.
  return JSON.stringify(runs.map((run) => ({
    id: run.id,
    error: run.error,
    events: run.result?.events,
    proposals: run.result?.proposals,
    themes: run.result?.themes,
    skipped: [run.result?.skippedEvents?.length, run.result?.skippedProposals?.length]
  })));
}

test(`the corpus is large enough to mean something (>= 320 items)`, () => {
  assert.ok(corpus.length >= 320, `${corpus.length} items`);
});

test("fault-free sim: every corpus item runs cleanly and the harness scores gold as 100%", async () => {
  const { transport } = simTransport({ seed: 1, faultRate: 0 });
  const state = await runScale({ corpus, transport, config: { proposalMode: "when-earned" }, reps: 1 });
  const o = state.summary.overall;
  assert.equal(o.fallbackRate, 0);
  assert.equal(o.invalidEvents, 0);
  assert.equal(o.score, 1, `imperfect items: ${state.scored.filter((s) => s.score < 1).map((s) => s.id).join(", ")}`);
  assert.equal(o.firstTryValidRate, 1);
});

test("recoverable faults (content garbage + 5xx/429 bursts) at 10/30/50% per call x 3 seeds: < 0.5% fallback, no violations", async () => {
  let total = 0;
  let failed = 0;
  const allViolations = [];
  const byRate = {};
  for (const faultRate of [0.1, 0.3, 0.5]) {
    for (const seed of [11, 22, 33]) {
      const { runs, violations } = await sweep({ seed, faultRate, faultWeights: RECOVERABLE_WEIGHTS });
      total += runs.length;
      const f = runs.filter((run) => run.error).length;
      failed += f;
      byRate[faultRate] = (byRate[faultRate] ?? 0) + f;
      allViolations.push(...violations);
    }
  }
  assert.ok(total >= 2800, `only ${total} pipeline runs`);
  assert.deepEqual(allViolations.slice(0, 10), []);
  // The contract's headline number is at a 30% per-call fault rate.
  const at30 = byRate[0.3] / (corpus.length * 3);
  assert.ok(at30 < 0.005, `fallback rate at 30% recoverable faults = ${(at30 * 100).toFixed(2)}% (${byRate[0.3]} runs)`);
  assert.ok(failed / total < 0.02, `overall fallback ${(100 * failed / total).toFixed(2)}% across ${total} runs`);
});

test("full fault mix (incl. timeouts + network blips) at 30% per call: zero unexpected exceptions, zero invalid output", async () => {
  for (const seed of [5, 6]) {
    const { violations, stats } = await sweep({ seed, faultRate: 0.3 });
    assert.deepEqual(violations.slice(0, 10), [], `seed ${seed}`);
    assert.ok(stats.chatCalls >= corpus.length);
  }
});

test("full fault mix at 30% per call: total-fallback rate < 0.5% (contract target)", async () => {
  let runs = [];
  for (const seed of [101, 202, 303]) runs = runs.concat((await sweep({ seed, faultRate: 0.3 })).runs);
  const rate = fallbackRate(runs);
  const reasons = {};
  for (const run of runs) if (run.error) reasons[run.error.split(":")[0]] = (reasons[run.error.split(":")[0]] ?? 0) + 1;
  assert.ok(rate < 0.005, `fallback ${(rate * 100).toFixed(2)}% over ${runs.length} runs; causes ${JSON.stringify(reasons)}`);
});

test("the single-call pipeline survives the same recoverable fault mix", async () => {
  const { runs, violations } = await sweep({ seed: 44, faultRate: 0.3, faultWeights: RECOVERABLE_WEIGHTS, pipeline: "single" });
  assert.deepEqual(violations.slice(0, 10), []);
  assert.ok(fallbackRate(runs) < 0.01, `single pipeline fallback ${(fallbackRate(runs) * 100).toFixed(2)}%`);
});

test("the OpenAI-compatible wire shape survives the same recoverable fault mix", async () => {
  const { runs, violations } = await sweep({ seed: 55, faultRate: 0.3, faultWeights: RECOVERABLE_WEIGHTS, provider: "openaiCompatible" });
  assert.deepEqual(violations.slice(0, 10), []);
  assert.ok(fallbackRate(runs) < 0.005, `openai-shape fallback ${(fallbackRate(runs) * 100).toFixed(2)}%`);
});

test("dnd5e requests survive the recoverable fault mix with proposalMode always", async () => {
  const { runs, violations } = await sweep({ seed: 66, faultRate: 0.3, faultWeights: RECOVERABLE_WEIGHTS, systemId: "dnd5e", proposalMode: "always" });
  assert.deepEqual(violations.slice(0, 10), []);
  assert.ok(fallbackRate(runs) < 0.005);
  assert.ok(runs.some((run) => run.result?.proposals?.length), "the proposal stage actually produced proposals");
});

test("results are deterministic per seed (same seed -> identical output; different seed -> different faults)", async () => {
  const a = await sweep({ seed: 777, faultRate: 0.3 });
  const b = await sweep({ seed: 777, faultRate: 0.3 });
  assert.equal(fingerprint(a.runs), fingerprint(b.runs));
  assert.deepEqual(a.stats.faults, b.stats.faults);
  const c = await sweep({ seed: 778, faultRate: 0.3 });
  assert.notDeepEqual(a.stats.faults, c.stats.faults);
});

test("the sim really injects every fault kind across a sweep", async () => {
  const { stats } = await sweep({ seed: 9, faultRate: 0.6 });
  for (const kind of Object.keys(DEFAULT_FAULT_WEIGHTS)) assert.ok(stats.faults[kind] > 0, `fault ${kind} never fired`);
  assert.ok(stats.stages.repair > 0, "repair turns were exercised");
  assert.ok(stats.stages.propose > 0, "proposal stage was exercised");
});

test("under faults, noEvents trap items still come back empty whenever the pipeline succeeds", async () => {
  const { runs } = await sweep({ seed: 12, faultRate: 0.3, faultWeights: RECOVERABLE_WEIGHTS });
  const traps = new Set(corpus.filter((item) => item.gold.noEvents).map((item) => item.id));
  const leaked = runs.filter((run) => traps.has(run.id) && run.result && run.result.events.length);
  assert.deepEqual(leaked.map((run) => run.id), []);
});
