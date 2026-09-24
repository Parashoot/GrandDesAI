#!/usr/bin/env node
// Node CLI for the AI gateway scale / consistency harness. See README.md in this folder.
//
//   node tools/nlp-scale/run.mjs --provider ollama --endpoint http://127.0.0.1:11434 \
//        --model qwen3:30b-a3b --reps 3 --concurrency 1 --filter novel-activities --limit 20 --out reports/
//
//   --sim [--fault-rate 0.3] [--seed 1]   run against the offline simulated model instead (no network)
//
// Writes <out>/<timestamp>-<model>.json (every item, every rep, full outputs) and .md (tables +
// the worst 15 items), prints a summary table, and saves a partial report every 10 items so a
// multi-hour run that gets interrupted still leaves numbers behind.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createTransport } from "../../scripts/ai/transport.js";
import { normalizeGatewayConfig } from "../../scripts/ai/gateway-config.js";
import { loadCorpusFromArrays, renderMarkdown, renderSummaryTable, runScale } from "./lib.mjs";
import { createSimModel } from "./sim-model.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
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

function usage() {
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
  --system pf2e|dnd5e (default pf2e)
  --pipeline two-stage|single  --proposal-mode never|when-earned|always
  --temperature X  --num-ctx N  --num-predict N  --timeout-ms N  --chunk-chars N
  --config FILE       JSON file of extra gateway config (houseRules, customSynonyms, ...)
  --out DIR           report directory (default tools/nlp-scale/reports)
  --sim               use the offline simulated model (with --fault-rate, --seed)
  --quiet             no per-item progress lines`;
}

function loadCorpus(dir) {
  const files = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  return loadCorpusFromArrays(...files.map((name) => JSON.parse(readFileSync(join(dir, name), "utf8"))));
}

const safeName = (value) => String(value).replace(/[^A-Za-z0-9._-]+/g, "_");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(usage());
    return;
  }
  const corpus = loadCorpus(resolve(args.corpus ?? join(HERE, "corpus")));
  const extra = args.config ? JSON.parse(readFileSync(resolve(args.config), "utf8")) : {};
  const config = normalizeGatewayConfig({
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
    ...(args.chunkChars ? { chunkChars: Number(args.chunkChars) } : {})
  });

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

  const outDir = resolve(args.out ?? join(HERE, "reports"));
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = join(outDir, `${stamp}-${safeName(sim ? `sim-f${args.faultRate ?? 0}` : config.model)}`);
  const state = {};
  const save = () => {
    writeFileSync(`${base}.json`, JSON.stringify(state, null, 2));
    writeFileSync(`${base}.md`, renderMarkdown(state));
  };

  const reps = Math.max(1, Number(args.reps ?? 1));
  console.log(`Running ${config.model} via ${config.provider} at ${config.endpoint} — reps ${reps}, concurrency ${args.concurrency ?? 1}${sim ? " [SIMULATED]" : ""}`);
  await runScale({
    corpus,
    transport,
    config,
    reps,
    concurrency: Math.max(1, Number(args.concurrency ?? 1)),
    filter: args.filter,
    lang: args.lang,
    ids: args.ids,
    limit: args.limit ? Number(args.limit) : undefined,
    offset: args.offset ? Number(args.offset) : 0,
    systemId: args.system ?? "pf2e",
    state
  }, ({ done, total, item, scored, elapsedMs }) => {
    if (!args.quiet) {
      const fails = scored.reps.filter((rep) => rep.failed).length;
      console.log(`[${done}/${total}] ${item.padEnd(10)} score ${(scored.score * 100).toFixed(0).padStart(3)}%  events ${scored.reps.map((r) => r.eventCount).join("/")}${fails ? `  FAILED ${fails}/${scored.reps.length}` : ""}  (${(elapsedMs / 1000).toFixed(0)}s)`);
    }
    if (done % 10 === 0) save();
  });
  save();
  console.log("");
  console.log(renderSummaryTable(state.summary));
  console.log("");
  for (const [category, g] of Object.entries(state.summary.byCategory)) {
    console.log(`${category.padEnd(22)} score ${(g.score * 100).toFixed(1).padStart(5)}%  F1 ${g.f1 === null ? "  –  " : (g.f1 * 100).toFixed(1).padStart(5) + "%"}  fallback ${(g.fallbackRate * 100).toFixed(1)}%`);
  }
  console.log("");
  console.log(`Reports: ${base}.json\n         ${base}.md`);
  if (sim) console.log(`Sim stats: ${JSON.stringify(sim.stats)}`);
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
