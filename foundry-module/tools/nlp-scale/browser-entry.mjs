// Browser entry for the scale harness. build-browser.mjs bundles this file (plus scripts/ai/* and
// everything they import) into ONE self-contained IIFE, dist/nlp-scale.browser.js, with the labeled
// corpus inlined, and calls installNlpScale(window, CORPUS). The intended host page is a tab whose
// origin IS the Ollama server (http://localhost:11434), so `fetch('/api/chat')` is same-origin and
// needs no OLLAMA_ORIGINS / CORS setup at all.
//
// Usage from the page console (or an automation tool):
//   await NlpScale.runScale({ model: "qwen3:30b-a3b", reps: 3, filter: "traps" }, console.log)
//   NlpScale.startScale({ model: "qwen3:30b-a3b", reps: 3 })   // fire-and-forget, then poll:
//   NlpScale.brief()           -> small JSON progress snapshot
//   NlpScale.lastRun           -> full live state (partial results while running)
//   NlpScale.renderMarkdown(NlpScale.lastRun)
//   NlpScale.abort()
//
// Pure ESM, no Node APIs.

import { createTransport } from "../../scripts/ai/transport.js";
import { normalizeGatewayConfig } from "../../scripts/ai/gateway-config.js";
import { HARNESS_VERSION, filterCorpus, loadCorpusFromArrays, renderMarkdown, renderSummaryTable, runScale as runScaleCore, scoreRun } from "./lib.mjs";
import { createSimModel } from "./sim-model.js";

/**
 * A fetch that keeps requests same-origin: when the configured endpoint is "" the transport is
 * given this page's origin (so its HTTPS/loopback safety check passes) and this wrapper strips the
 * origin back off, so the actual request is a relative '/api/chat'.
 */
export function sameOriginFetch(baseFetch, origin) {
  return (url, init) => {
    const text = String(url);
    const relative = origin && text.startsWith(origin) ? text.slice(origin.length) || "/" : text;
    return baseFetch(relative, init);
  };
}

function pageOrigin(target) {
  const origin = target?.location?.origin ?? globalThis.location?.origin;
  return origin && origin !== "null" ? origin : "http://localhost:11434";
}

export function installNlpScale(target = globalThis, corpusInput = []) {
  const corpus = loadCorpusFromArrays(corpusInput);
  const signal = { aborted: false };
  const api = {
    version: HARNESS_VERSION,
    corpus,
    lastRun: null,
    lastError: null,
    progressLog: [],
    scoreRun,
    renderMarkdown,
    renderSummaryTable,
    filterCorpus,
    createSimModel,

    /**
     * @param {object} options { model, endpoint = "" (same origin), provider = "ollama", apiKey,
     *   reps, concurrency, filter, lang, ids, limit, offset, systemId, timeoutMs, config: {...},
     *   sim: { faultRate, seed } (offline self-test; no network) }
     * @param {Function} [onProgress]
     */
    async runScale(options = {}, onProgress) {
      signal.aborted = false;
      const endpointOption = options.endpoint ?? "";
      const sameOrigin = !endpointOption;
      const origin = pageOrigin(target);
      const config = normalizeGatewayConfig({
        ...(options.config ?? {}),
        provider: options.provider ?? options.config?.provider ?? "ollama",
        endpoint: sameOrigin ? origin : endpointOption,
        ...(options.model ? { model: options.model } : {}),
        ...(options.apiKey ? { apiKey: options.apiKey } : {})
      });
      let fetchImpl;
      let sim = null;
      if (options.sim) {
        sim = createSimModel({ corpus, seed: options.sim.seed ?? 1, faultRate: options.sim.faultRate ?? 0 });
        fetchImpl = sim.fetch;
      } else {
        const base = (...args) => (target.fetch ?? globalThis.fetch)(...args);
        fetchImpl = sameOrigin ? sameOriginFetch(base, origin) : base;
      }
      const transport = createTransport({
        provider: config.provider,
        endpoint: config.endpoint,
        model: config.model,
        apiKey: config.apiKey,
        timeoutMs: options.timeoutMs ?? (sim ? 50 : config.timeoutMs),
        fetchImpl,
        ...(sim ? { sleep: async () => {} } : {}),
        ollamaOptions: { num_ctx: config.numCtx, num_predict: config.numPredict }
      });
      const state = { status: "starting" };
      api.lastRun = state;
      api.lastError = null;
      api.progressLog = [];
      try {
        await runScaleCore({
          corpus,
          transport,
          config,
          reps: options.reps ?? 1,
          concurrency: options.concurrency ?? 1,
          filter: options.filter,
          lang: options.lang,
          ids: options.ids,
          limit: options.limit,
          offset: options.offset,
          systemId: options.systemId ?? "pf2e",
          state,
          signal
        }, (progress) => {
          const line = { done: progress.done, total: progress.total, item: progress.item, score: progress.scored.score, events: progress.scored.reps.map((r) => r.eventCount), failed: progress.scored.reps.filter((r) => r.failed).length, elapsedMs: Math.round(progress.elapsedMs) };
          api.progressLog.push(line);
          if (typeof onProgress === "function") onProgress(line, progress);
        });
        if (sim) state.simStats = sim.stats;
        return state;
      } catch (error) {
        state.status = "error";
        api.lastError = String(error?.stack ?? error);
        throw error;
      }
    },

    /** Fire-and-forget: returns immediately; poll brief() / lastRun. */
    startScale(options = {}) {
      api.runScale(options).catch((error) => {
        api.lastError = String(error?.stack ?? error);
      });
      return { started: true, total: filterCorpus(corpus, options).length };
    },

    abort() {
      signal.aborted = true;
      return true;
    },

    /** Small snapshot for polling a long run. */
    brief() {
      const run = api.lastRun;
      if (!run) return { status: "idle", error: api.lastError };
      const o = run.summary?.overall;
      return {
        status: run.status,
        model: run.model,
        done: run.done,
        total: run.total,
        reps: run.reps,
        error: api.lastError,
        last: api.progressLog.slice(-3),
        overall: o
          ? { score: o.score, recall: o.recall, precision: o.precision, f1: o.f1, outcomeAcc: o.outcomeAcc, dangerAcc: o.dangerAcc, themeAcc: o.themeAcc, trapAcc: o.trapAcc, fallbackRate: o.fallbackRate, firstTryValidRate: o.firstTryValidRate, tagJaccard: o.tagJaccard, latencyP50: o.latencyP50, latencyP95: o.latencyP95 }
          : null
      };
    },

    /** The full JSON report as a string (for copying out of the page). */
    exportJson() {
      return JSON.stringify(api.lastRun, null, 2);
    }
  };
  target.NlpScale = api;
  return api;
}
