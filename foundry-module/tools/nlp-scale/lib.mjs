// Scale / consistency harness core for the AI gateway (docs/ai-gateway-v2-contract.md).
//
// Environment-agnostic on purpose: no fs, no process, no window. run.mjs (Node CLI) and
// browser-entry.mjs (a page on the Ollama origin) both drive this same code, so a number measured
// from a Windows terminal and a number measured in the browser tab mean the same thing.
//
// What it measures, per corpus item and aggregated per category / language:
//   - accuracy vs gold: mustTags recall, tag precision (mustTags + okTags count as correct), F1,
//     outcome accuracy, dangerGap accuracy, theme discovery on novel activities, trap pass
//     (noEvents -> zero events), forbidden tags, event-count bounds;
//   - robustness: total-failure ("fallback") rate, first-try-valid rate, repair turns and JSON
//     repairs per model call, latency p50/p95;
//   - consistency across reps: mean pairwise Jaccard of the union tag set, outcome modal agreement,
//     event-count standard deviation.
//
// Gold conventions (see corpus/*.json): a mustTags entry "a|b" is satisfied by either tag; an
// outcome / dangerGap "a|b" accepts either; dangerGap "none" means NO event may carry one.

import { runGatewayPipeline } from "../../scripts/ai/pipeline.js";
import { normalizeGatewayConfig } from "../../scripts/ai/gateway-config.js";
import { buildAiGatewayRequest } from "../../scripts/ai-gateway.js";
import { validateGrowthEvent } from "../../scripts/progression.js";

export const HARNESS_VERSION = "1.0.0";

// ---- corpus --------------------------------------------------------------------------------

/** Flatten one or more arrays of items (e.g. one per corpus file) and check ids are unique. */
export function loadCorpusFromArrays(...arrays) {
  const items = arrays.flat(2).filter((item) => item && typeof item === "object" && item.id);
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`Duplicate corpus id ${item.id}`);
    seen.add(item.id);
  }
  return items;
}

export function filterCorpus(corpus, { filter, lang, ids, limit, offset = 0 } = {}) {
  let items = corpus;
  if (filter) {
    const wanted = String(filter).split(",").map((s) => s.trim()).filter(Boolean);
    items = items.filter((item) => wanted.some((w) => item.category === w || item.category.startsWith(w)));
  }
  if (lang) {
    const wanted = String(lang).split(",").map((s) => s.trim());
    items = items.filter((item) => wanted.includes(item.lang) || wanted.includes(String(item.lang).split("-")[0]));
  }
  if (ids) {
    const wanted = new Set(Array.isArray(ids) ? ids : String(ids).split(","));
    items = items.filter((item) => wanted.has(item.id));
  }
  if (offset) items = items.slice(offset);
  if (Number.isFinite(limit) && limit > 0) items = items.slice(0, limit);
  return items;
}

// ---- actor / request -------------------------------------------------------------------------

/** A minimal Foundry-free actor good enough for buildAiGatewayRequest, for either system. */
export function makeHarnessActor(systemId = "pf2e", { name = "Scale Tester", level = 5, registry = {}, gdLevel = 3 } = {}) {
  const flags = { registry, levelProgression: { level: gdLevel, progress: 0, grantAllowances: 1 } };
  return {
    id: `harness-${systemId}`,
    name,
    type: "character",
    system: systemId === "dnd5e"
      ? { details: { level }, skills: { acr: { total: 6, mod: 3 } }, attributes: { prof: 3 } }
      : { details: { level: { value: level } }, skills: { acrobatics: { mod: 8 } } },
    items: { find: () => undefined, filter: () => [] },
    getFlag(_scope, key) {
      return flags[key];
    }
  };
}

export function buildHarnessRequest(item, systemId = "pf2e", actor = makeHarnessActor(systemId)) {
  return buildAiGatewayRequest(actor, item.notes, systemId);
}

// ---- running ---------------------------------------------------------------------------------

function now() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

/**
 * Run one item `reps` times. Never throws: a pipeline total failure is recorded as a rep with
 * `error` (that is exactly the "would have fallen back to the local analyzer" case we count).
 */
export async function runItem(item, { transport, config, reps = 1, systemId = "pf2e", pipeline = runGatewayPipeline } = {}) {
  const normalized = normalizeGatewayConfig(config ?? {});
  const request = buildHarnessRequest(item, systemId);
  const results = [];
  for (let rep = 0; rep < reps; rep += 1) {
    const started = now();
    try {
      const output = await pipeline({ transport, request, config: normalized });
      results.push({
        rep,
        ms: now() - started,
        events: Array.isArray(output?.events) ? output.events : [],
        proposals: Array.isArray(output?.proposals) ? output.proposals : [],
        themes: output?.themes ?? [],
        skippedEvents: output?.skippedEvents ?? [],
        skippedProposals: output?.skippedProposals ?? [],
        diagnostics: output?.diagnostics ?? null
      });
    } catch (error) {
      results.push({ rep, ms: now() - started, error: { name: error?.name ?? "Error", message: String(error?.message ?? error) }, events: [], proposals: [], themes: [] });
    }
  }
  return { id: item.id, category: item.category, lang: item.lang, reps: results };
}

// ---- scoring helpers -------------------------------------------------------------------------

const alts = (value) => (typeof value === "string" ? value.split("|").map((s) => s.trim()).filter(Boolean) : []);

function unionTags(events) {
  const set = new Set();
  for (const event of events ?? []) for (const tag of event?.tags ?? []) set.add(tag);
  return set;
}

function themeStem(slug) {
  return String(slug)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .replace(/(keeping|keeper|making|maker|ing|ers|er|ery|ry|ist|ism|ists|ion|s)$/g, "")
    .replace(/(ing|er|s)$/g, "");
}

/** Predicted theme slugs from events, the top-level `themes` result and proposal metadata. */
export function predictedThemes(rep) {
  const out = new Set();
  const add = (value) => {
    if (typeof value === "string" && value.trim()) out.add(value.trim().toLowerCase());
    else if (value && typeof value === "object") add(value.slug ?? value.theme ?? value.name);
  };
  for (const event of rep.events ?? []) for (const theme of event?.themes ?? []) add(theme);
  const top = rep.themes;
  if (Array.isArray(top)) top.forEach(add);
  else if (top && typeof top === "object") Object.keys(top).forEach(add);
  for (const proposal of rep.proposals ?? []) {
    for (const theme of proposal?.entry?.metadata?.themes ?? []) add(theme);
    if (proposal?.theme) add(proposal.theme);
  }
  return [...out];
}

/** Lenient theme match: equality, substring either way (>= 4 chars), or shared stem. */
export function themeMatches(predicted, goldList) {
  for (const p of predicted) {
    const pn = p.replace(/[^a-z0-9]+/g, "");
    const ps = themeStem(p);
    for (const g of goldList) {
      const gn = String(g).toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (!gn) continue;
      if (pn === gn) return true;
      if (pn.length >= 4 && gn.length >= 4 && (pn.includes(gn) || gn.includes(pn))) return true;
      const gs = themeStem(g);
      if (ps.length >= 4 && gs.length >= 4 && (ps === gs || ps.startsWith(gs) || gs.startsWith(ps))) return true;
    }
  }
  return false;
}

function dominantOutcome(events) {
  const counts = new Map();
  for (const event of events ?? []) if (event?.outcome) counts.set(event.outcome, (counts.get(event.outcome) ?? 0) + 1);
  let best = null;
  for (const [outcome, count] of counts) if (!best || count > best.count) best = { outcome, count };
  return best?.outcome ?? null;
}

/** Per-rep accuracy against gold. Checks that do not apply to an item are null. */
export function scoreRep(item, rep) {
  const gold = item.gold ?? {};
  const events = rep.events ?? [];
  const failed = Boolean(rep.error);
  const predicted = unionTags(events);
  const mustGroups = (gold.mustTags ?? []).map(alts).filter((group) => group.length);
  const allowed = new Set([...(gold.okTags ?? []), ...mustGroups.flat()]);

  const recall = mustGroups.length ? mustGroups.filter((group) => group.some((tag) => predicted.has(tag))).length / mustGroups.length : null;
  const precision = predicted.size ? [...predicted].filter((tag) => allowed.has(tag)).length / predicted.size : (gold.noEvents || !mustGroups.length ? null : 0);
  const f1 = recall !== null && precision !== null ? (recall + precision ? (2 * recall * precision) / (recall + precision) : 0) : null;

  let outcomeOk = null;
  if (gold.outcome && !gold.noEvents) outcomeOk = alts(gold.outcome).includes(dominantOutcome(events));

  let dangerOk = null;
  if (gold.dangerGap) {
    const gaps = events.map((event) => event?.dangerGap).filter(Boolean);
    dangerOk = gold.dangerGap === "none" ? gaps.length === 0 : gaps.some((gap) => alts(gold.dangerGap).includes(gap));
  }

  const themes = predictedThemes(rep);
  const themeOk = gold.themesAny?.length ? themeMatches(themes, gold.themesAny) : null;
  const trapOk = gold.noEvents ? events.length === 0 : null;
  const forbidOk = gold.forbidTags?.length ? !gold.forbidTags.some((tag) => predicted.has(tag)) : null;
  const min = gold.noEvents ? 0 : gold.minEvents;
  const max = gold.noEvents ? 0 : gold.maxEvents;
  const countOk = min === undefined && max === undefined ? null : events.length >= (min ?? 0) && events.length <= (max ?? Infinity);
  const invalidEvents = events.filter((event) => !validateGrowthEvent(event).valid).length;
  const redOk = gold.redWorthy && (rep.proposals ?? []).length
    ? rep.proposals.some((proposal) => proposal?.entry?.metadata?.polarity === "red")
    : null;

  const checks = [recall, precision, outcomeOk, dangerOk, themeOk, trapOk, forbidOk, countOk].filter((value) => value !== null).map(Number);
  const score = failed ? 0 : checks.length ? checks.reduce((a, b) => a + b, 0) / checks.length : 1;
  return {
    failed,
    recall,
    precision,
    f1,
    outcomeOk,
    dangerOk,
    themeOk,
    trapOk,
    forbidOk,
    countOk,
    redOk,
    invalidEvents,
    eventCount: events.length,
    tags: [...predicted].sort(),
    themes,
    outcome: dominantOutcome(events),
    score
  };
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function mean(values) {
  const nums = values.filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number);
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

function stdev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length);
}

export function percentile(values, p) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

/** Consistency across reps of one item. */
export function consistency(reps) {
  const ok = reps.filter((rep) => !rep.error);
  const sets = ok.map((rep) => unionTags(rep.events));
  const pairs = [];
  for (let i = 0; i < sets.length; i += 1) for (let j = i + 1; j < sets.length; j += 1) pairs.push(jaccard(sets[i], sets[j]));
  const outcomes = ok.map((rep) => dominantOutcome(rep.events) ?? "none");
  const counts = new Map();
  for (const outcome of outcomes) counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  const modal = Math.max(0, ...counts.values());
  return {
    reps: reps.length,
    tagJaccard: pairs.length ? mean(pairs) : null,
    outcomeAgreement: outcomes.length > 1 ? modal / outcomes.length : null,
    eventCountStdev: ok.length > 1 ? stdev(ok.map((rep) => rep.events.length)) : null
  };
}

/** Robustness numbers pulled from pipeline diagnostics (tolerant of shape drift). */
export function diagnosticsStats(rep) {
  const stages = Array.isArray(rep?.diagnostics?.stages) ? rep.diagnostics.stages : [];
  let calls = 0;
  let firstTryValid = 0;
  let repairTurns = 0;
  let jsonRepairs = 0;
  const callMs = [];
  for (const stage of stages) {
    const attempts = Number.isFinite(stage?.attempts) ? stage.attempts : 1;
    calls += Math.max(1, attempts);
    repairTurns += Math.max(0, attempts - 1);
    const errors = Array.isArray(stage?.errors) ? stage.errors.length : 0;
    if (attempts <= 1 && !errors) firstTryValid += 1;
    jsonRepairs += Array.isArray(stage?.repairs) ? stage.repairs.length : Number(stage?.repairs) || 0;
    if (Number.isFinite(stage?.ms)) callMs.push(stage.ms / Math.max(1, attempts));
  }
  return { stages: stages.length, calls, firstTryValid, repairTurns, jsonRepairs, callMs };
}

export function scoreItem(item, runResult) {
  const reps = runResult.reps.map((rep) => ({ ...scoreRep(item, rep), ms: rep.ms, error: rep.error ?? null, diag: diagnosticsStats(rep) }));
  const agg = (key) => mean(reps.map((r) => (r[key] === null || r[key] === undefined ? null : Number(r[key]))));
  return {
    id: item.id,
    category: item.category,
    lang: item.lang,
    notes: item.notes,
    gold: item.gold,
    reps,
    recall: agg("recall"),
    precision: agg("precision"),
    f1: agg("f1"),
    outcomeAcc: agg("outcomeOk"),
    dangerAcc: agg("dangerOk"),
    themeAcc: agg("themeOk"),
    trapAcc: agg("trapOk"),
    forbidAcc: agg("forbidOk"),
    countAcc: agg("countOk"),
    redAcc: agg("redOk"),
    failRate: mean(reps.map((r) => (r.failed ? 1 : 0))),
    invalidEvents: reps.reduce((sum, r) => sum + r.invalidEvents, 0),
    score: agg("score"),
    consistency: consistency(runResult.reps),
    sampleOutput: runResult.reps.map((rep) => ({
      error: rep.error ?? undefined,
      events: (rep.events ?? []).map((e) => ({ summary: e.summary, tags: e.tags, themes: e.themes, outcome: e.outcome, dangerGap: e.dangerGap })),
      proposals: (rep.proposals ?? []).map((p) => ({ name: p?.entry?.name, kind: p?.entry?.gameItem?.kind, tags: p?.entry?.metadata?.tags, polarity: p?.entry?.metadata?.polarity }))
    }))
  };
}

function aggregateGroup(items) {
  const reps = items.flatMap((item) => item.reps);
  const diag = reps.map((rep) => rep.diag);
  const calls = diag.reduce((s, d) => s + d.calls, 0);
  const stages = diag.reduce((s, d) => s + d.stages, 0);
  const pick = (key) => mean(items.map((item) => item[key]));
  return {
    items: items.length,
    reps: reps.length,
    score: pick("score"),
    recall: pick("recall"),
    precision: pick("precision"),
    f1: pick("f1"),
    outcomeAcc: pick("outcomeAcc"),
    dangerAcc: pick("dangerAcc"),
    themeAcc: pick("themeAcc"),
    trapAcc: pick("trapAcc"),
    countAcc: pick("countAcc"),
    redAcc: pick("redAcc"),
    fallbackRate: reps.length ? reps.filter((rep) => rep.failed).length / reps.length : null,
    invalidEvents: items.reduce((s, item) => s + item.invalidEvents, 0),
    firstTryValidRate: stages ? diag.reduce((s, d) => s + d.firstTryValid, 0) / stages : null,
    repairTurnsPerCall: calls ? diag.reduce((s, d) => s + d.repairTurns, 0) / calls : null,
    jsonRepairsPerCall: calls ? diag.reduce((s, d) => s + d.jsonRepairs, 0) / calls : null,
    callsPerRun: reps.length ? calls / reps.length : null,
    latencyP50: percentile(reps.map((rep) => rep.ms), 50),
    latencyP95: percentile(reps.map((rep) => rep.ms), 95),
    callLatencyP50: percentile(diag.flatMap((d) => d.callMs), 50),
    callLatencyP95: percentile(diag.flatMap((d) => d.callMs), 95),
    tagJaccard: mean(items.map((item) => item.consistency.tagJaccard)),
    outcomeAgreement: mean(items.map((item) => item.consistency.outcomeAgreement)),
    eventCountStdev: mean(items.map((item) => item.consistency.eventCountStdev))
  };
}

/** Summary over scored items: overall + per category + per language. */
export function scoreRun(scoredItems) {
  const items = scoredItems.filter(Boolean);
  const group = (key) => {
    const out = {};
    for (const item of items) (out[item[key]] ??= []).push(item);
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)).map(([k, list]) => [k, aggregateGroup(list)]));
  };
  const langKey = (item) => String(item.lang ?? "?");
  const byLang = {};
  for (const item of items) (byLang[langKey(item)] ??= []).push(item);
  return {
    overall: aggregateGroup(items),
    byCategory: group("category"),
    byLang: Object.fromEntries(Object.entries(byLang).sort(([a], [b]) => a.localeCompare(b)).map(([k, list]) => [k, aggregateGroup(list)])),
    worst: [...items].sort((a, b) => (a.score ?? 0) - (b.score ?? 0) || a.id.localeCompare(b.id)).slice(0, 15).map((item) => item.id)
  };
}

// ---- the whole run -----------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {Array}  options.corpus
 * @param {object} [options.transport]         a scripts/ai/transport.js transport (or compatible)
 * @param {Function} [options.transportFactory] (config) => transport; used when transport omitted
 * @param {object} [options.config]            gateway config (normalizeGatewayConfig input)
 * @param {number} [options.reps=1]
 * @param {number} [options.concurrency=1]
 * @param {string} [options.filter] / [options.lang] / [options.ids] / [options.limit] / [options.offset]
 * @param {string} [options.systemId="pf2e"]
 * @param {object} [options.state]             pass an object to observe partial results live
 * @param {Function} [onProgress]              ({done,total,item,scored,elapsedMs}) after each item
 * @param {{aborted:boolean}} [options.signal] set .aborted = true to stop after in-flight items
 */
export async function runScale(options = {}, onProgress = () => {}) {
  const { corpus = [], reps = 1, concurrency = 1, systemId = "pf2e", pipeline = runGatewayPipeline } = options;
  const config = normalizeGatewayConfig(options.config ?? {});
  const transport = options.transport ?? options.transportFactory?.(config);
  if (!transport || typeof transport.chat !== "function") throw new Error("runScale needs a transport (or transportFactory) with a chat() method.");
  const items = filterCorpus(corpus, options);
  const state = options.state ?? {};
  Object.assign(state, {
    harnessVersion: HARNESS_VERSION,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "running",
    model: config.model,
    provider: config.provider,
    config: { ...config, apiKey: config.apiKey ? "***" : "", fetchImpl: undefined, sleep: undefined, getHeaders: undefined },
    reps,
    systemId,
    total: items.length,
    done: 0,
    scored: [],
    summary: null,
    errors: 0
  });
  const started = now();
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length && !options.signal?.aborted) {
      const item = items[cursor];
      cursor += 1;
      const result = await runItem(item, { transport, config, reps, systemId, pipeline });
      const scored = scoreItem(item, result);
      state.scored.push(scored);
      state.errors += scored.reps.filter((rep) => rep.failed).length;
      state.done += 1;
      state.summary = scoreRun(state.scored);
      try {
        onProgress({ done: state.done, total: state.total, item: item.id, scored, elapsedMs: now() - started, summary: state.summary });
      } catch {
        // a broken progress callback must never kill a multi-hour run
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, worker));
  state.scored.sort((a, b) => a.id.localeCompare(b.id));
  state.summary = scoreRun(state.scored);
  state.finishedAt = new Date().toISOString();
  state.elapsedMs = now() - started;
  state.status = options.signal?.aborted ? "aborted" : "done";
  return state;
}

// ---- reporting ---------------------------------------------------------------------------------

const pct = (v) => (v === null || v === undefined ? "–" : `${(v * 100).toFixed(1)}%`);
const num = (v, d = 2) => (v === null || v === undefined ? "–" : Number(v).toFixed(d));
const ms = (v) => (v === null || v === undefined ? "–" : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);

function row(name, g) {
  return `| ${name} | ${g.items} | ${pct(g.score)} | ${pct(g.recall)} | ${pct(g.precision)} | ${pct(g.f1)} | ${pct(g.outcomeAcc)} | ${pct(g.dangerAcc)} | ${pct(g.themeAcc)} | ${pct(g.trapAcc)} | ${pct(g.countAcc)} | ${pct(g.fallbackRate)} | ${pct(g.firstTryValidRate)} | ${num(g.tagJaccard)} | ${num(g.outcomeAgreement)} | ${ms(g.latencyP50)} | ${ms(g.latencyP95)} |`;
}

const HEADER = "| group | items | score | recall | precision | F1 | outcome | dangerGap | themes | traps | count | fallback | 1st-try valid | tag Jaccard | outcome agree | p50 | p95 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";

export function renderSummaryTable(summary) {
  return [HEADER, row("**overall**", summary.overall)].join("\n");
}

export function renderMarkdown(state) {
  const summary = state.summary ?? scoreRun(state.scored ?? []);
  const o = summary.overall;
  const lines = [];
  lines.push(`# NLP scale report — ${state.model ?? "?"} (${state.provider ?? "?"})`);
  lines.push("");
  lines.push(`- started ${state.startedAt ?? "?"}, finished ${state.finishedAt ?? "(partial)"}; ${state.done ?? 0}/${state.total ?? 0} items × ${state.reps ?? 1} reps; system ${state.systemId ?? "pf2e"}; harness ${state.harnessVersion ?? HARNESS_VERSION}`);
  if (state.config) lines.push(`- pipeline ${state.config.pipeline}, proposalMode ${state.config.proposalMode}, temperature ${state.config.temperature}, numCtx ${state.config.numCtx}, chunkChars ${state.config.chunkChars}`);
  lines.push(`- **fallback (total failure) rate ${pct(o.fallbackRate)}**, first-try-valid ${pct(o.firstTryValidRate)}, repair turns/call ${num(o.repairTurnsPerCall)}, JSON repairs/call ${num(o.jsonRepairsPerCall)}, calls/run ${num(o.callsPerRun)}, invalid events returned ${o.invalidEvents}`);
  lines.push(`- latency per run p50 ${ms(o.latencyP50)} / p95 ${ms(o.latencyP95)}; per call p50 ${ms(o.callLatencyP50)} / p95 ${ms(o.callLatencyP95)}`);
  lines.push(`- consistency: tag Jaccard ${num(o.tagJaccard)}, outcome agreement ${num(o.outcomeAgreement)}, event-count stdev ${num(o.eventCountStdev)}`);
  lines.push("");
  lines.push("## Overall");
  lines.push(HEADER);
  lines.push(row("**overall**", o));
  lines.push("");
  lines.push("## By category");
  lines.push(HEADER);
  for (const [name, g] of Object.entries(summary.byCategory)) lines.push(row(name, g));
  lines.push("");
  lines.push("## By language");
  lines.push(HEADER);
  for (const [name, g] of Object.entries(summary.byLang)) lines.push(row(name, g));
  lines.push("");
  lines.push("## Worst 15 items");
  const byId = new Map((state.scored ?? []).map((item) => [item.id, item]));
  for (const id of summary.worst) {
    const item = byId.get(id);
    if (!item) continue;
    lines.push("");
    lines.push(`### ${id} (${item.category}, ${item.lang}) — score ${pct(item.score)}`);
    lines.push("");
    lines.push("> " + String(item.notes).replace(/\n/g, "\n> "));
    lines.push("");
    lines.push("gold: `" + JSON.stringify(item.gold) + "`");
    item.sampleOutput.forEach((out, index) => {
      if (out.error) {
        lines.push(`- rep ${index}: **ERROR** ${out.error.name}: ${out.error.message}`);
        return;
      }
      const events = out.events.map((e) => `[${(e.tags ?? []).join(",")}${e.themes?.length ? ` / ${e.themes.join(",")}` : ""}] ${e.outcome}${e.dangerGap ? ` (${e.dangerGap})` : ""} — ${String(e.summary ?? "").slice(0, 100)}`);
      lines.push(`- rep ${index}: ${events.length} event(s)${events.length ? "\n  - " + events.join("\n  - ") : ""}`);
      if (out.proposals.length) lines.push(`  - proposals: ${out.proposals.map((p) => `${p.name} (${p.kind}${p.polarity === "red" ? ", red" : ""})`).join("; ")}`);
    });
  }
  lines.push("");
  lines.push("## Metric definitions");
  lines.push("- **score**: mean of the applicable per-item checks below (0 on a total failure).");
  lines.push("- **recall**: share of gold mustTags groups (\"a|b\" = either) present on some event. **precision**: share of predicted tags that are in mustTags ∪ okTags. **F1** of the two.");
  lines.push("- **outcome**: dominant event outcome ∈ gold outcome alternatives. **dangerGap**: some event carries an allowed gap (gold \"none\" = no event may carry one).");
  lines.push("- **themes**: any predicted theme (event themes, result themes, proposal metadata.themes) matches gold themesAny by slug, substring or stem. **traps**: noEvents items returned zero events. **count**: event count within [minEvents, maxEvents].");
  lines.push("- **fallback**: the pipeline threw (the GM would have got the local keyword analyzer). **1st-try valid**: pipeline stages that needed no repair turn and reported no errors.");
  lines.push("- **tag Jaccard**: mean pairwise Jaccard of the union tag set across reps. **outcome agree**: share of reps agreeing with the modal dominant outcome.");
  return lines.join("\n") + "\n";
}
