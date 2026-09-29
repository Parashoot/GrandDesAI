#!/usr/bin/env node
// Node CLI for the AI gateway scale / consistency harness. See README.md in this folder.
//
//   node tools/nlp-scale/run.mjs --provider ollama --endpoint http://127.0.0.1:11434 \
//        --model qwen3:30b-a3b --reps 3 --concurrency 1 --filter novel-activities --limit 20 --out reports/
//
//   --sim [--fault-rate 0.3] [--seed 1]   run against the offline simulated model instead (no network)
//   --jev                                 add the real TypeSafe Jev layer (TYPESAFE_API_KEY, TYPESAFE_BASE_URL)
//   --sim-jev [--jev-fault-rate 0.2]      add the offline simulated Jev (sim-jev.js)
//   --party [--party-mode auto|per-pc]    run the party corpus (corpus/party/) and score per-character credit
//
// Writes <out>/<timestamp>-<model>.json (every item, every rep, full outputs) and .md (tables +
// the worst 15 items), prints a summary table, and saves a partial report every 10 items so a
// multi-hour run that gets interrupted still leaves numbers behind.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createTransport } from "../../scripts/ai/transport.js";
import { normalizeGatewayConfig } from "../../scripts/ai/gateway-config.js";
import { darkLine, loadCorpusFromArrays, renderMarkdown, renderSummaryTable, runScale } from "./lib.mjs";
import { createSimModel } from "./sim-model.js";
import { createSimJev } from "./sim-jev.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const JEV_MODULE = resolve(HERE, "..", "..", "scripts", "ai", "jev.js");
export const JEV_DEFAULT_ENDPOINT = "https://api.typesafe.ai";

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const [key, inline] = token.slice(2).split("=", 2);
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (inline !== undefined) args[camel] = inline;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) args[camel] = argv[++i];
    else args[camel] = true;
  }
  return args;
}

export function usage() {
  return `Usage: node tools/nlp-scale/run.mjs [options]
  --provider ollama|openaiCompatible|hosted   (default ollama)
  --endpoint URL                              (default http://127.0.0.1:11434)
  --model NAME                                (default: gateway default)
  --api-key KEY                               (hosted providers)
  --reps N            repetitions per item for consistency (default 1)
  --concurrency N     items in flight at once (default 1; keep 1 for a single local GPU)
  --filter CATS       comma-separated category prefixes (e.g. traps,non-english)
  --lang CODES        comma-separated languages (e.g. es,el)
  --ids IDS           comma-separated item ids
  --limit N / --offset N
  --system pf2e|dnd5e (default pf2e; party items carry their own system)
  --pipeline two-stage|single  --proposal-mode never|when-earned|always
  --temperature X  --num-ctx N  --num-predict N  --timeout-ms N  --chunk-chars N
  --config FILE       JSON file of extra gateway config (houseRules, customSynonyms, ...)
  --out DIR           report directory (default tools/nlp-scale/reports)
  --sim               use the offline simulated model (with --fault-rate, --seed)
  --jev               add the real Jev layer: needs TYPESAFE_API_KEY (optional TYPESAFE_BASE_URL,
                      --jev-endpoint URL, --jev-model NAME, --jev-timeout-ms N)
  --sim-jev           add the offline simulated Jev (--jev-fault-rate X, --jev-seed N)
  --compare-jev / --no-compare-jev
                      also run every item with Jev off for the with/without columns
                      (default: on with --sim-jev, off with --jev because it doubles model time)
  --party             run the party corpus (corpus/party/*.json) and score per-character credit
  --party-mode auto|per-pc
  --no-party-roster   do not pass the party roster to the adapter (the pre-e54491dd path, for A/B)
                      auto = one adapter per item with its extraction cache (one extraction), like api.analyzePartyNotes;
                      per-pc = today's path (one pipeline run per character) for before-numbers
  --quiet             no per-item progress lines`;
}

/** Every *.json directly in `dir` (subfolders such as corpus/party/ are NOT included). */
export function loadCorpus(dir) {
  const files = readdirSync(dir).filter((name) => name.endsWith(".json") && statSync(join(dir, name)).isFile()).sort();
  return loadCorpusFromArrays(...files.map((name) => JSON.parse(readFileSync(join(dir, name), "utf8"))));
}

/**
 * The party corpus lives in corpus/party/ rather than next to the other files: every loader and
 * test of the scale corpus reads corpus/*.json and expects the ordinary item shape (mustTags,
 * okTags...), and the sim model's fingerprint index is built from those files -- keeping party
 * items out of that folder keeps every existing number (and `--sim` score) exactly as it was.
 */
export function loadPartyCorpus(dir) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((name) => /^party-.*\.json$/.test(name)).sort();
  return loadCorpusFromArrays(...files.map((name) => JSON.parse(readFileSync(join(dir, name), "utf8"))));
}

/**
 * Jev settings from flags + environment. Pure (no I/O) so it is testable.
 * @returns {{ mode: "off"|"sim"|"real", error?: string, apiKey?, endpoint?, model?, timeoutMs?, faultRate?, seed?, compare: boolean }}
 */
export function resolveJevOptions(args = {}, env = {}) {
  const wantsReal = Boolean(args.jev);
  const wantsSim = Boolean(args.simJev);
  const compareFlag = args.noCompareJev ? false : args.compareJev ? true : null;
  if (wantsReal && wantsSim) return { mode: "off", compare: false, error: "--jev and --sim-jev are mutually exclusive: pick the real Jev or the simulated one." };
  const model = typeof args.jevModel === "string" && args.jevModel.trim() ? args.jevModel.trim() : "jev-latest";
  if (wantsReal) {
    const apiKey = String(env.TYPESAFE_API_KEY ?? "").trim();
    if (!apiKey) return { mode: "real", compare: false, error: "--jev needs the Jev API key in TYPESAFE_API_KEY (optionally TYPESAFE_BASE_URL for the endpoint). Set it, or use --sim-jev for the offline simulation." };
    const endpoint = String((typeof args.jevEndpoint === "string" && args.jevEndpoint) || env.TYPESAFE_BASE_URL || JEV_DEFAULT_ENDPOINT).trim().replace(/\/+$/, "");
    return { mode: "real", apiKey, endpoint, model, timeoutMs: Number(args.jevTimeoutMs) > 0 ? Number(args.jevTimeoutMs) : 10000, compare: compareFlag ?? false };
  }
  if (wantsSim) {
    return {
      mode: "sim",
      apiKey: "sim-jev-key",
      endpoint: JEV_DEFAULT_ENDPOINT,
      model,
      timeoutMs: Number(args.jevTimeoutMs) > 0 ? Number(args.jevTimeoutMs) : 100,
      faultRate: Math.max(0, Math.min(1, Number(args.jevFaultRate ?? 0) || 0)),
      seed: Number(args.jevSeed ?? args.seed ?? 1) || 1,
      compare: compareFlag ?? true
    };
  }
  return { mode: "off", compare: false };
}

/**
 * scripts/ai/jev.js is built by another agent and may not exist in this checkout yet: a missing
 * module is a note in the report, never a crash (contract invariant 1: Jev is optional).
 */
export async function loadJevModule(path = JEV_MODULE) {
  if (!existsSync(path)) return { module: null, note: "scripts/ai/jev.js is not present in this checkout, so the run went ahead WITHOUT Jev." };
  try {
    const module = await import(pathToFileURL(path).href);
    if (typeof module.createJevClient !== "function") return { module: null, note: "scripts/ai/jev.js has no createJevClient export, so the run went ahead WITHOUT Jev." };
    return { module, note: null };
  } catch (error) {
    return { module: null, note: `scripts/ai/jev.js failed to load (${error?.message ?? error}), so the run went ahead WITHOUT Jev.` };
  }
}

/** Build the Jev client (real or simulated) for a run; { client: null, info } when it cannot. */
export async function createHarnessJev(jevOptions, { corpus = [], loader = loadJevModule } = {}) {
  if (!jevOptions || jevOptions.mode === "off") return { client: null, sim: null, info: null };
  const info = { mode: jevOptions.mode, endpoint: jevOptions.endpoint, model: jevOptions.model, ...(jevOptions.mode === "sim" ? { faultRate: jevOptions.faultRate, seed: jevOptions.seed } : {}), compare: jevOptions.compare };
  const { module, note } = await loader();
  if (!module) return { client: null, sim: null, info: { ...info, available: false, note } };
  const sim = jevOptions.mode === "sim" ? createSimJev({ corpus, seed: jevOptions.seed, faultRate: jevOptions.faultRate }) : null;
  const client = module.createJevClient({
    apiKey: jevOptions.apiKey,
    endpoint: jevOptions.endpoint,
    model: jevOptions.model,
    timeoutMs: jevOptions.timeoutMs,
    ...(sim ? { fetchImpl: sim.fetch, sleep: async () => {} } : {})
  });
  if (!client) return { client: null, sim, info: { ...info, available: false, note: "createJevClient returned no client (empty key?), so the run went ahead WITHOUT Jev." } };
  return { client, sim, info: { ...info, available: true } };
}

/** The gateway `jev` config block that turns the pipeline's Jev steps on (key redacted in reports). */
export function jevConfigBlock(jevOptions) {
  if (!jevOptions || jevOptions.mode === "off") return null;
  return { enabled: true, apiKey: jevOptions.apiKey, endpoint: jevOptions.endpoint, model: jevOptions.model, timeoutMs: Math.max(1000, jevOptions.timeoutMs ?? 10000) };
}

const safeName = (value) => String(value).replace(/[^A-Za-z0-9._-]+/g, "_");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(usage());
    return;
  }
  const jevOptions = resolveJevOptions(args, process.env);
  if (jevOptions.error) {
    console.error(jevOptions.error);
    process.exitCode = 2;
    return;
  }
  const corpusDir = resolve(args.corpus ?? join(HERE, "corpus"));
  const corpus = args.party ? loadPartyCorpus(resolve(args.partyCorpus ?? join(corpusDir, "party"))) : loadCorpus(corpusDir);
  if (args.party && !corpus.length) {
    console.error(`No party corpus found in ${join(corpusDir, "party")}.`);
    process.exitCode = 2;
    return;
  }
  const extra = args.config ? JSON.parse(readFileSync(resolve(args.config), "utf8")) : {};
  const jevBlock = jevConfigBlock(jevOptions);
  const configInput = {
    ...extra,
    provider: args.provider ?? extra.provider ?? "ollama",
    endpoint: args.endpoint ?? extra.endpoint ?? "http://127.0.0.1:11434",
    ...(args.model ? { model: args.model } : {}),
    ...(args.apiKey ? { apiKey: args.apiKey } : {}),
    ...(args.pipeline ? { pipeline: args.pipeline } : {}),
    ...(args.proposalMode ? { proposalMode: args.proposalMode } : {}),
    ...(args.temperature !== undefined ? { temperature: Number(args.temperature) } : {}),
    ...(args.numCtx ? { numCtx: Number(args.numCtx) } : {}),
    ...(args.numPredict ? { numPredict: Number(args.numPredict) } : {}),
    ...(args.timeoutMs ? { timeoutMs: Number(args.timeoutMs) } : {}),
    ...(args.chunkChars ? { chunkChars: Number(args.chunkChars) } : {}),
    ...(jevBlock ? { jev: { ...(extra.jev ?? {}), ...jevBlock } } : {})
  };
  const config = normalizeGatewayConfig(configInput);

  let sim = null;
  if (args.sim) {
    sim = createSimModel({ corpus, seed: Number(args.seed ?? 1), faultRate: Number(args.faultRate ?? 0) });
  }
  const transport = createTransport({
    provider: config.provider,
    endpoint: config.endpoint,
    model: config.model,
    apiKey: config.apiKey,
    timeoutMs: sim ? 50 : config.timeoutMs,
    ollamaOptions: { num_ctx: config.numCtx, num_predict: config.numPredict },
    ...(sim ? { fetchImpl: sim.fetch, sleep: async () => {} } : {})
  });

  if (!sim) {
    const ping = await transport.ping();
    if (!ping.ok) {
      console.error(`Provider check failed: ${ping.error}`);
      process.exitCode = 2;
      return;
    }
    if (ping.modelAvailable === false) console.warn(`WARNING: ${ping.error}`);
  }

  const jev = await createHarnessJev(jevOptions, { corpus });
  if (jev.info?.note) console.warn(`Jev: ${jev.info.note}`);
  if (jev.client && jevOptions.mode === "real" && typeof jev.client.ping === "function") {
    const ping = await jev.client.ping();
    if (!ping?.ok) {
      console.error(`Jev check failed: ${ping?.error ?? "no answer"} (endpoint ${jevOptions.endpoint})`);
      process.exitCode = 2;
      return;
    }
    console.log(`Jev reachable in ${ping.ms ?? "?"} ms; models: ${(ping.models ?? []).map((m) => m.name ?? m).join(", ") || "?"}`);
  }

  const outDir = resolve(args.out ?? join(HERE, "reports"));
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = `${args.party ? "-party" : ""}${jevOptions.mode === "sim" ? `-simjev-f${jevOptions.faultRate}` : jevOptions.mode === "real" ? "-jev" : ""}`;
  const base = join(outDir, `${stamp}-${safeName(sim ? `sim-f${args.faultRate ?? 0}` : config.model)}${suffix}`);
  const state = {};
  const save = () => {
    writeFileSync(`${base}.json`, JSON.stringify(state, null, 2));
    writeFileSync(`${base}.md`, renderMarkdown(state));
  };

  const reps = Math.max(1, Number(args.reps ?? 1));
  const jevLabel = jevOptions.mode === "off" ? "" : jev.client ? ` + Jev (${jevOptions.mode})` : " (Jev requested but unavailable)";
  console.log(`Running ${config.model} via ${config.provider} at ${config.endpoint} — reps ${reps}, concurrency ${args.concurrency ?? 1}${sim ? " [SIMULATED]" : ""}${jevLabel}${args.party ? ` [PARTY, mode ${args.partyMode ?? "auto"}]` : ""}`);
  await runScale({
    corpus,
    transport,
    config: configInput,
    reps,
    concurrency: Math.max(1, Number(args.concurrency ?? 1)),
    filter: args.filter,
    lang: args.lang,
    ids: args.ids,
    limit: args.limit ? Number(args.limit) : undefined,
    offset: args.offset ? Number(args.offset) : 0,
    systemId: args.system ?? "pf2e",
    state,
    ...(jev.client ? { jev: jev.client, compareWithoutJev: jevOptions.compare } : {}),
    ...(jev.info ? { jevInfo: jev.info } : {}),
    ...(args.party ? { party: true, partyMode: args.partyMode === "per-pc" ? "per-pc" : "auto", partyRoster: !args.noPartyRoster } : {})
  }, ({ done, total, item, scored, elapsedMs }) => {
    if (!args.quiet) {
      const fails = scored.reps.filter((rep) => rep.failed).length;
      console.log(`[${done}/${total}] ${item.padEnd(10)} score ${(scored.score * 100).toFixed(0).padStart(3)}%  events ${scored.reps.map((r) => r.eventCount).join("/")}${fails ? `  FAILED ${fails}/${scored.reps.length}` : ""}  (${(elapsedMs / 1000).toFixed(0)}s)`);
    }
    if (done % 10 === 0) save();
  });
  if (jev.sim) state.jev = { ...(state.jev ?? {}), simStats: jev.sim.stats };
  save();
  console.log("");
  console.log(renderSummaryTable(state.summary));
  console.log("");
  const pctOrDash = (v) => (v === null || v === undefined ? "  –  " : (v * 100).toFixed(1).padStart(5) + "%");
  for (const [category, g] of Object.entries(state.summary.byCategory)) {
    console.log(`${category.padEnd(22)} score ${(g.score * 100).toFixed(1).padStart(5)}%  F1 ${pctOrDash(g.f1)}  fallback ${(g.fallbackRate * 100).toFixed(1)}%  dark deed ${pctOrDash(g.darkDeedAcc)}  dark FP ${pctOrDash(g.darkFalseRate)}`);
  }
  if (state.jevSummary) {
    const j = state.jevSummary;
    const pct = (v) => (v === null || v === undefined ? "–" : `${(v * 100).toFixed(1)}%`);
    console.log("");
    console.log(`Jev: ${j.runsWithJev}/${j.runs} runs, ${j.calls} calls, ${j.skippedChunks} chunks skipped (${j.triageMisses} misses), overrides ${j.overrides.total} (right ${j.overrides.right}, wrong ${j.overrides.wrong}), attribution ${pct(j.attribution.accuracy)}, red recall ${pct(j.red.recall)} / false ${pct(j.red.falseRate)}${j.without ? `; without Jev: score ${pct(j.without.score)} vs ${pct(j.without.scoreWith)}, attribution ${pct(j.without.attribution.accuracy)}, red recall ${pct(j.without.red.recall)}` : ""}`);
  } else if (jevOptions.mode !== "off") {
    console.log("");
    console.log(`Jev: ${jev.info?.note ?? "no run carried diagnostics.jev (the pipeline in this checkout has no Jev integration yet)."}`);
  }
  console.log("");
  console.log(`Dark deeds: ${darkLine(state.summary.overall)}`);
  console.log("");
  console.log(`Reports: ${base}.json\n         ${base}.md`);
  if (sim) console.log(`Sim stats: ${JSON.stringify(sim.stats)}`);
  if (jev.sim) console.log(`Sim Jev stats: ${JSON.stringify(jev.sim.stats)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
