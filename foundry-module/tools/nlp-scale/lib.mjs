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
import { buildAiGatewayRequest, createGatewayAdapter } from "../../scripts/ai-gateway.js";
import { validateGrowthEvent } from "../../scripts/progression.js";
import { EVENT_ITEM_SCHEMA } from "../../scripts/ai/schemas.js";
import { attributeEventsToActor, classifyActorName } from "../../scripts/session-notes.js";
import { GROWTH_TAXONOMY } from "../../scripts/growth-taxonomy.js";

export const HARNESS_VERSION = "1.1.0";

// ---- dark deeds (Horror Rank, board 21e944ed) ----------------------------------------------------
//
// Events may carry darkDeed ("none" | a vice id from scripts/vice-taxonomy.js) and darkSeverity
// ("none" | "minor" | "serious" | "monstrous"). Gold lives on the item: gold.darkDeed / darkSeverity,
// "a|b" = either. Items in the categories below were read one by one (2026-09-29) and hold no dark
// deed unless their gold says so, so a missing gold field there means "none". Any other category is
// unlabelled and scores null, so a new category cannot silently inflate darkFalseRate's denominator.
export const DARK_REVIEWED_CATEGORIES = Object.freeze([
  "bullets-fragments",
  "code-switching",
  "counter-leveling",
  "dice-jargon",
  "fluent-en",
  "long-multiscene",
  "non-english",
  "non-native-en",
  "novel-activities",
  "red-polarity-worthy",
  "texting-shorthand",
  "traps",
  "typos-phonetic"
]);

// Does the pipeline's event schema ask for darkDeed? Feature-detected, not assumed: the field is
// being added in parallel (contract section 1). Used only to decide what a rep with ZERO events means:
// with the field in the schema, "no events" on a dark item is a miss; without it, it says nothing.
export const DARK_SCHEMA_ACTIVE = Boolean(EVENT_ITEM_SCHEMA?.properties?.darkDeed);

/** Gold dark-deed label for an item: { vices: [...], severities: [...] }, vices ["none"], or null (unlabelled). */
export function goldDarkDeed(item) {
  const gold = item?.gold ?? {};
  if (typeof gold.darkDeed === "string" && gold.darkDeed.trim()) {
    const vices = alts(gold.darkDeed.toLowerCase());
    if (vices.includes("none")) return { vices: ["none"], severities: ["none"] };
    return { vices, severities: alts(String(gold.darkSeverity ?? "").toLowerCase()) };
  }
  return DARK_REVIEWED_CATEGORIES.includes(item?.category) ? { vices: ["none"], severities: ["none"] } : null;
}

const darkValue = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");
/** A predicted event counts as a dark deed when it names a vice (anything but ""/"none"). */
export function isDarkEvent(event) {
  const vice = darkValue(event?.darkDeed);
  return Boolean(vice) && vice !== "none";
}

/**
 * Per-rep dark-deed checks. All null when the item is unlabelled or the model output carries no
 * darkDeed field at all (today's pipeline), so a run from before the field existed never reads as
 * "0% dark-deed accuracy".
 */
export function scoreDarkDeeds(item, events, { darkSchema = DARK_SCHEMA_ACTIVE } = {}) {
  const none = { darkMeasured: false, darkDeedOk: null, darkViceOk: null, darkDetectOk: null, darkFalse: null };
  const gold = goldDarkDeed(item);
  if (!gold) return none;
  const list = (events ?? []).filter(Boolean);
  const seen = list.some((event) => Object.prototype.hasOwnProperty.call(event, "darkDeed"));
  if (!seen && !(list.length === 0 && darkSchema)) return none;
  const dark = list.filter(isDarkEvent);
  if (gold.vices[0] === "none") return { ...none, darkMeasured: true, darkFalse: dark.length > 0 };
  const viceHits = dark.filter((event) => gold.vices.includes(darkValue(event.darkDeed)));
  return {
    darkMeasured: true,
    darkDetectOk: dark.length > 0,
    darkViceOk: viceHits.length > 0,
    // An empty severity gold accepts any non-"none" severity rather than failing every rep.
    darkDeedOk: viceHits.some((event) => {
      const severity = darkValue(event.darkSeverity);
      return gold.severities.length ? gold.severities.includes(severity) : Boolean(severity) && severity !== "none";
    }),
    darkFalse: null
  };
}

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
// The harness actor has a system class so proposal names can be judged: without one the model
// had no class motif to use and named 40 of 93 proposals "Scale Tester: ...".
export function makeHarnessActor(systemId = "pf2e", { name = "Scale Tester", level = 5, registry = {}, gdLevel = 3, className = "Fighter" } = {}) {
  const flags = { registry, levelProgression: { level: gdLevel, progress: 0, grantAllowances: 1 } };
  return {
    id: `harness-${systemId}`,
    name,
    type: "character",
    system: systemId === "dnd5e"
      ? { details: { level }, skills: { acr: { total: 6, mod: 3 } }, attributes: { prof: 3 } }
      : { details: { level: { value: level } }, skills: { acrobatics: { mod: 8 } } },
    ...(systemId === "dnd5e" ? { classes: { [className.toLowerCase()]: { name: className, type: "class", system: { levels: level } } } } : { class: { name: className } }),
    items: { find: () => undefined, filter: () => [] },
    getFlag(_scope, key) {
      return flags[key];
    }
  };
}

export function buildHarnessRequest(item, systemId = "pf2e", actor = makeHarnessActor(systemId)) {
  // Stage 2 only sees events credited to request.actor.name (2026-09-27). Corpus items name their
  // own characters (Kesh, Tovin...), so "Scale Tester" filtered out every event and redAcc was
  // always null. A blank name means "no analysed PC": stage 2 sees the item's events.
  const request = buildAiGatewayRequest(actor, item.notes, systemId);
  return { ...request, actor: { ...request.actor, name: "" } };
}

// ---- running ---------------------------------------------------------------------------------

function now() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

/**
 * Run one item `reps` times. Never throws: a pipeline total failure is recorded as a rep with
 * `error` (that is exactly the "would have fallen back to the local analyzer" case we count).
 */
export async function runItem(item, { transport, config, reps = 1, systemId = "pf2e", pipeline = runGatewayPipeline, jev = null } = {}) {
  const normalized = normalizeGatewayConfig(config ?? {});
  const request = buildHarnessRequest(item, systemId);
  const results = [];
  for (let rep = 0; rep < reps; rep += 1) {
    const started = now();
    try {
      // `jev` only when there is a client: without one the call is byte-for-byte what it was before
      // the Jev layer existed (contract invariant 1).
      const output = await pipeline(jev ? { transport, request, config: normalized, jev } : { transport, request, config: normalized });
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

function mergeJevDiagnostics(list) {
  const present = list.filter((d) => d && typeof d === "object");
  if (!present.length) return null;
  return {
    enabled: present.some((d) => d.enabled !== false),
    ran: [...new Set(present.flatMap((d) => (Array.isArray(d.ran) ? d.ran : [])))],
    calls: present.reduce((s, d) => s + (Number(d.calls) || 0), 0),
    ms: present.reduce((s, d) => s + (Number(d.ms) || 0), 0),
    skippedChunks: present.flatMap((d) => (Array.isArray(d.skippedChunks) ? d.skippedChunks : [])),
    overrides: present.reduce((s, d) => s + (Number(d.overrides) || (Array.isArray(d.overrides) ? d.overrides.length : 0)), 0),
    flags: present.flatMap((d) => (Array.isArray(d.flags) ? d.flags : [])),
    errors: present.flatMap((d) => (Array.isArray(d.errors) ? d.errors : []))
  };
}

/**
 * Run one party item (category "party") `reps` times the way api.analyzePartyNotes reads a whole
 * party's notes: ONE gateway adapter (whose extraction cache, keyed on notes+system+config, makes
 * stage 1 run once per distinct notes) and one adapter call per character with the same notes; each
 * character then keeps the events session-notes.js#attributeEventsToActor gives it (it trusts a
 * confident `event.jev.actorName`). Modes:
 *   - "party" (default, `partyMode: "auto"`): the adapter's cache on -> one extraction per item;
 *   - "per-pc": the cache off -> one extraction per character, today's pre-cache cost, for the
 *     before-numbers.
 * Extractions are counted from `gatewayDiagnostics.extractionCache` ("miss" / "off" = the model
 * really read the notes). A `jev` client reaches the adapter through `jevFactory` (contract; the
 * adapter ignores it until the Jev integration lands). Never throws: a total failure is a rep with
 * `error`, as in runItem.
 */
export async function runPartyItem(item, { transport, config, reps = 1, systemId, jev = null, partyMode = "auto", adapterFactory = createGatewayAdapter } = {}) {
  const sys = item.system ?? systemId ?? "pf2e";
  const mode = partyMode === "per-pc" ? "per-pc" : "party";
  const actors = (item.party ?? []).map((name) => makeHarnessActor(sys, { name }));
  const results = [];
  for (let rep = 0; rep < reps; rep += 1) {
    const started = now();
    try {
      // A fresh adapter per rep, so a rep never reads another rep's cached extraction.
      const adapter = adapterFactory(
        { ...(config ?? {}), systemId: sys, ...(mode === "per-pc" ? { extractionCacheEntries: 0 } : {}) },
        { transportFactory: () => transport, jevFactory: () => jev }
      );
      const perActor = {};
      let events = null;
      const proposals = [];
      const stages = [];
      const jevDiags = [];
      let extractions = 0;
      for (const actor of actors) {
        const output = await adapter({ actor, notes: item.notes, systemId: sys });
        const runEvents = Array.isArray(output?.events) ? output.events : [];
        // The extraction is shared, so the first character's events are the party's events; the
        // per-character split is what each sheet would record.
        events ??= runEvents;
        perActor[actor.name] = attributeEventsToActor(runEvents, [actor.name], { notes: item.notes }).kept;
        proposals.push(...(Array.isArray(output?.proposals) ? output.proposals : []));
        const diagnostics = output?.gatewayDiagnostics ?? output?.diagnostics ?? null;
        stages.push(...(Array.isArray(diagnostics?.stages) ? diagnostics.stages : []));
        jevDiags.push(diagnostics?.jev);
        if (diagnostics?.extractionCache === "miss" || diagnostics?.extractionCache === "off" || diagnostics?.extractionCache === undefined) extractions += 1;
      }
      const jevDiag = mergeJevDiagnostics(jevDiags);
      results.push({ rep, ms: now() - started, mode, extractions, events: events ?? [], perActor, proposals, themes: [], diagnostics: { stages, ...(jevDiag ? { jev: jevDiag } : {}) } });
    } catch (error) {
      results.push({ rep, ms: now() - started, mode, error: { name: error?.name ?? "Error", message: String(error?.message ?? error) }, events: [], proposals: [], themes: [] });
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
export function scoreRep(item, rep, options = {}) {
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
  // False positive: a red proposal on notes that are not red-worthy (e.g. an ordinary thief or con
  // artist). redOk alone could be gamed by making everything red.
  const redFalse = !gold.redWorthy && (rep.proposals ?? []).length
    ? rep.proposals.some((proposal) => proposal?.entry?.metadata?.polarity === "red")
    : null;

  // Kept out of `score` on purpose: score stays comparable with every run before dark deeds existed.
  const dark = scoreDarkDeeds(item, events, options);

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
    redFalse,
    ...dark,
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

// ---- party corpus: per-character credit (docs/jev-layer-contract.md "Party corpus") -----------

const normText = (text) => String(text ?? "").toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
const WHOLE = "*whole-party*";

/** Evidence snippets of a party item -> the character(s) who did that deed (WHOLE = everyone). */
export function partyEvidence(item) {
  const map = new Map();
  const add = (snippet, doer) => {
    const key = normText(snippet);
    if (!key) return;
    const doers = map.get(key) ?? [];
    if (!doers.includes(doer)) doers.push(doer);
    map.set(key, doers);
  };
  for (const [name, gold] of Object.entries(item?.gold?.perActor ?? {})) for (const snippet of gold.evidence ?? []) add(snippet, name);
  for (const snippet of item?.gold?.wholeParty?.evidence ?? []) add(snippet, WHOLE);
  return [...map.entries()].map(([snippet, doers]) => ({ snippet, doers })).sort((a, b) => b.snippet.length - a.snippet.length);
}

/** Who really did an extracted event, from the gold evidence its quote/summary contains; null if unknown. */
export function trueDoers(item, event) {
  const text = normText(`${event?.quote ?? ""} \n ${event?.summary ?? ""}`);
  const hit = partyEvidence(item).find((entry) => text.includes(entry.snippet));
  if (!hit) return null;
  return hit.doers.includes(WHOLE) ? { whole: true, doers: [...(item.party ?? [])] } : { whole: false, doers: hit.doers };
}

/** The characters an event's (final) actorName credits: roster names classified "self", or group. */
export function creditedActors(item, event) {
  if (event?.jev?.whole === true) return { group: true, names: [...(item.party ?? [])] };
  const name = typeof event?.actorName === "string" ? event.actorName.trim() : "";
  if (!name) return { group: false, names: [], empty: true };
  const names = (item.party ?? []).filter((member) => classifyActorName(name, [member]) === "self");
  const group = !names.length && classifyActorName(name, item.party ?? []) === "group";
  return { group, names };
}

const eventKey = (event) => `${String(event?.summary ?? "").trim()}\u0000${String(event?.quote ?? "").trim()}`;

/**
 * Is this event credited to exactly the right character(s)? null when the doer is not known. With
 * `perActor` (name -> the events that character's sheet recorded) the credit is the FINAL one, after
 * session-notes.js#attributeEventsToActor (which honours a confident event.jev.actorName); without
 * it, the event's own actorName / jev.whole is read.
 */
export function attributionCorrect(item, event, perActor = null) {
  const truth = trueDoers(item, event);
  if (!truth) return null;
  const credited = perActor
    ? (() => {
        const key = eventKey(event);
        const names = (item.party ?? []).filter((name) => (perActor[name] ?? []).some((kept) => kept === event || eventKey(kept) === key));
        return { group: names.length === (item.party ?? []).length && names.length > 1, names };
      })()
    : creditedActors(item, event);
  if (truth.whole) return credited.group || credited.names.length === (item.party ?? []).length;
  if (credited.group || !credited.names.length) return false;
  return credited.names.length === truth.doers.length && truth.doers.every((doer) => credited.names.includes(doer));
}

/** One event list -> { name: events the module would record for that character }. */
export function distributePartyEvents(item, events, { attribute = attributeEventsToActor } = {}) {
  const out = {};
  for (const name of item.party ?? []) out[name] = attribute(Array.isArray(events) ? events : [], [name], { notes: item.notes }).kept;
  return out;
}

/** A dark act the Jev layer (or the model) marked: the event-level red signal. Includes darkDeed. */
export function isJevDarkEvent(event) {
  return Boolean(
    isDarkEvent(event)
      ||     (Array.isArray(event?.jev?.flags) && event.jev.flags.includes("dark-act"))
      || (Array.isArray(event?.themes) && event.themes.includes("dark-deed"))
      || event?.polarity === "red"
  );
}

/**
 * Per-character credit for one rep of a party item. `rep.perActor` (name -> events, as the API
 * recorded them) wins; otherwise the rep's events are distributed with the module's own
 * attributeEventsToActor, so the number is what a GM would see on each sheet.
 */
export function scorePartyRep(item, rep) {
  const failed = Boolean(rep?.error);
  const party = item.party ?? [];
  const perActor = rep?.perActor ?? distributePartyEvents(item, rep?.events ?? []);
  const actors = {};
  let creditLeak = 0;
  for (const name of party) {
    const gold = item.gold?.perActor?.[name] ?? { minEvents: 0, maxEvents: 0, mustTags: [] };
    const events = failed ? [] : perActor[name] ?? [];
    const tags = unionTags(events);
    const groups = (gold.mustTags ?? []).map(alts).filter((group) => group.length);
    const recall = groups.length ? groups.filter((group) => group.some((tag) => tags.has(tag))).length / groups.length : null;
    const min = gold.minEvents ?? 0;
    const max = gold.maxEvents ?? Infinity;
    const countOk = events.length >= min && events.length <= max;
    creditLeak += Math.max(0, events.length - max);
    const outcomeOk = gold.outcome ? alts(gold.outcome).includes(dominantOutcome(events)) : null;
    const forbidOk = gold.forbidTags?.length ? !gold.forbidTags.some((tag) => tags.has(tag)) : null;
    const dark = events.some(isJevDarkEvent);
    const redOk = gold.redWorthy ? dark : null;
    const redFalse = !gold.redWorthy && events.length ? dark : null;
    const checks = [countOk, recall, outcomeOk, forbidOk].filter((v) => v !== null).map(Number);
    actors[name] = {
      count: events.length,
      min,
      max: Number.isFinite(max) ? max : null,
      countOk,
      recall,
      outcomeOk,
      forbidOk,
      redOk,
      redFalse,
      tags: [...tags].sort(),
      outcome: dominantOutcome(events),
      score: failed ? 0 : checks.length ? checks.reduce((a, b) => a + b, 0) / checks.length : 1
    };
  }
  const list = Object.values(actors);
  const events = rep?.events ?? [];
  const judged = events.map((event) => attributionCorrect(item, event, failed ? null : perActor)).filter((v) => v !== null);
  const idle = list.filter((a) => a.max === 0);
  const avg = (key) => mean(list.map((a) => (a[key] === null || a[key] === undefined ? null : Number(a[key]))));
  const redActors = list.filter((a) => a.redOk !== null);
  const falseActors = list.filter((a) => a.redFalse !== null);
  return {
    failed,
    party: true,
    actors,
    attribution: { scored: judged.length, correct: judged.filter(Boolean).length },
    creditLeak,
    idleOk: idle.length ? idle.filter((a) => a.count === 0).length / idle.length : null,
    recall: avg("recall"),
    precision: null,
    f1: null,
    outcomeOk: avg("outcomeOk"),
    dangerOk: null,
    themeOk: null,
    trapOk: null,
    forbidOk: avg("forbidOk"),
    countOk: avg("countOk"),
    redOk: redActors.length ? redActors.filter((a) => a.redOk).length / redActors.length : null,
    redFalse: falseActors.length ? falseActors.filter((a) => a.redFalse).length / falseActors.length : null,
    invalidEvents: events.filter((event) => !validateGrowthEvent(event).valid).length,
    eventCount: events.length,
    tags: [...unionTags(events)].sort(),
    themes: predictedThemes(rep ?? {}),
    outcome: dominantOutcome(events),
    score: failed ? 0 : mean(list.map((a) => a.score)) ?? 1
  };
}

// ---- Jev measurements (docs/jev-layer-contract.md "Harness") ------------------------------------

const TAXONOMY_PATTERNS = new Map(GROWTH_TAXONOMY.map(([tag, pattern]) => [tag, pattern]));

/**
 * Did a chunk Jev's triage skipped hold gold events? The pipeline only reports the first 160
 * characters of a skipped chunk, so this is a lower bound: a party chunk counts when it contains an
 * evidence snippet or names a character who has gold events; an ordinary item's chunk counts when
 * the item has events and the text matches the taxonomy pattern of one of its gold tags.
 */
export function chunkHeldGold(item, text) {
  const t = normText(text);
  if (!t) return false;
  if (item?.category === "party") {
    if (partyEvidence(item).some((entry) => t.includes(entry.snippet) || (entry.snippet.length > 24 && t.includes(entry.snippet.slice(0, 24))))) return true;
    return Object.entries(item.gold?.perActor ?? {}).some(([name, gold]) => (gold.minEvents ?? 0) > 0 && t.includes(normText(name)));
  }
  const gold = item?.gold ?? {};
  if (gold.noEvents) return false;
  const tags = [...(gold.mustTags ?? []).flatMap(alts), ...(gold.okTags ?? [])];
  return tags.some((tag) => TAXONOMY_PATTERNS.get(tag)?.test(String(text)));
}

function goldOutcomeFor(item, event) {
  if (item?.category !== "party") return item?.gold?.noEvents ? null : item?.gold?.outcome ?? null;
  const truth = trueDoers(item, event);
  if (!truth || truth.whole || truth.doers.length !== 1) return null;
  return item.gold?.perActor?.[truth.doers[0]]?.outcome ?? null;
}

/** Red signal for the with/without-Jev comparison: a red proposal or a dark-act event. */
export function redSignal(rep) {
  return (rep?.proposals ?? []).some((p) => p?.entry?.metadata?.polarity === "red") || (rep?.events ?? []).some(isJevDarkEvent);
}

function isRedWorthy(item) {
  if (item?.category === "party") return Object.values(item.gold?.perActor ?? {}).some((gold) => gold.redWorthy);
  return Boolean(item?.gold?.redWorthy);
}

/** What Jev did in one rep, judged against gold. null when the rep carries no diagnostics.jev. */
export function jevRepStats(item, rep) {
  const d = rep?.diagnostics?.jev;
  if (!d || typeof d !== "object") return null;
  const skipped = Array.isArray(d.skippedChunks) ? d.skippedChunks : [];
  const overrides = { total: 0, right: 0, wrong: 0, neutral: 0 };
  const flags = {};
  for (const event of rep.events ?? []) {
    for (const flag of event?.jev?.flags ?? []) flags[flag] = (flags[flag] ?? 0) + 1;
    const from = event?.jev?.outcomeFrom;
    if (!from || from === event.outcome) continue;
    overrides.total += 1;
    const gold = goldOutcomeFor(item, event);
    if (!gold) {
      overrides.neutral += 1;
      continue;
    }
    const nowOk = alts(gold).includes(event.outcome);
    const beforeOk = alts(gold).includes(from);
    if (nowOk && !beforeOk) overrides.right += 1;
    else if (beforeOk && !nowOk) overrides.wrong += 1;
    else overrides.neutral += 1;
  }
  for (const proposal of rep.proposals ?? []) for (const flag of proposal?.jev?.flags ?? []) flags[flag] = (flags[flag] ?? 0) + 1;
  return {
    enabled: d.enabled !== false,
    ran: Array.isArray(d.ran) ? d.ran : [],
    calls: Number(d.calls) || 0,
    ms: Number.isFinite(Number(d.ms)) ? Number(d.ms) : null,
    skipped: skipped.length,
    triageMisses: skipped.filter((chunk) => chunkHeldGold(item, chunk?.text)).length,
    overrides,
    flags,
    errors: Array.isArray(d.errors) ? d.errors.length : Number(d.errors) || 0
  };
}

function redStats(item, rep) {
  const worthy = isRedWorthy(item);
  if (rep?.error) return { worthy, hit: false, counted: worthy };
  // A false positive only counts where something was produced at all (as redFalse does).
  const counted = worthy || (rep?.events ?? []).length > 0 || (rep?.proposals ?? []).length > 0;
  return { worthy, hit: redSignal(rep), counted };
}

export function scoreItem(item, runResult, options = {}) {
  const isParty = item.category === "party";
  const reps = runResult.reps.map((rep) => ({
    ...(isParty ? scorePartyRep(item, rep) : scoreRep(item, rep, options)),
    ms: rep.ms,
    error: rep.error ?? null,
    diag: diagnosticsStats(rep),
    jev: jevRepStats(item, rep),
    red: redStats(item, rep),
    ...(rep.mode ? { mode: rep.mode, extractions: rep.extractions ?? null } : {})
  }));
  const agg = (key) => mean(reps.map((r) => (r[key] === null || r[key] === undefined ? null : Number(r[key]))));
  const scored = {
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
    redFalseRate: agg("redFalse"),
    darkDeedAcc: agg("darkDeedOk"),
    darkViceAcc: agg("darkViceOk"),
    darkDetectAcc: agg("darkDetectOk"),
    darkFalseRate: agg("darkFalse"),
    failRate: mean(reps.map((r) => (r.failed ? 1 : 0))),
    invalidEvents: reps.reduce((sum, r) => sum + r.invalidEvents, 0),
    score: agg("score"),
    consistency: consistency(runResult.reps),
    sampleOutput: runResult.reps.map((rep) => ({
      error: rep.error ?? undefined,
      events: (rep.events ?? []).map((e) => ({ summary: e.summary, consequence: e.consequence, actorName: e.actorName, tags: e.tags, themes: e.themes, outcome: e.outcome, dangerGap: e.dangerGap, darkDeed: e.darkDeed, darkSeverity: e.darkSeverity, ...(e.jev ? { jev: e.jev } : {}) })),
      proposals: (rep.proposals ?? []).map((p) => ({ name: p?.entry?.name, kind: p?.entry?.gameItem?.kind, tags: p?.entry?.metadata?.tags, polarity: p?.entry?.metadata?.polarity })),
      skippedProposals: (rep.skippedProposals ?? []).map((sp) => ({ reason: sp?.reason, name: sp?.proposal?.entry?.name ?? sp?.proposal?.name, errors: (sp?.errors ?? []).slice(0, 3) })),
      proposalStage: rep.diagnostics?.proposalStage,
      ...(rep.diagnostics?.jev ? { jev: { calls: rep.diagnostics.jev.calls, ms: rep.diagnostics.jev.ms, ran: rep.diagnostics.jev.ran, skippedChunks: rep.diagnostics.jev.skippedChunks, errors: rep.diagnostics.jev.errors } } : {})
    }))
  };
  if (isParty) {
    const names = item.party ?? [];
    scored.party = {
      party: names,
      mode: reps.find((r) => r.mode)?.mode ?? null,
      attribution: {
        scored: reps.reduce((s, r) => s + (r.attribution?.scored ?? 0), 0),
        correct: reps.reduce((s, r) => s + (r.attribution?.correct ?? 0), 0)
      },
      creditLeak: mean(reps.map((r) => r.creditLeak ?? 0)),
      idleAcc: mean(reps.map((r) => r.idleOk)),
      actors: Object.fromEntries(names.map((name) => {
        const list = reps.map((r) => r.actors?.[name]).filter(Boolean);
        const gold = item.gold?.perActor?.[name] ?? {};
        return [name, {
          min: gold.minEvents ?? 0,
          max: gold.maxEvents ?? null,
          counts: list.map((a) => a.count),
          countAcc: mean(list.map((a) => Number(a.countOk))),
          recall: mean(list.map((a) => a.recall)),
          score: mean(list.map((a) => a.score)),
          tags: [...new Set(list.flatMap((a) => a.tags))].sort()
        }];
      }))
    };
  }
  return scored;
}

/** The fields of a scored item kept when the same item is re-run without Jev for comparison. */
export function baselineOf(scored) {
  const reps = scored?.reps ?? [];
  return {
    score: scored?.score ?? null,
    redAcc: scored?.redAcc ?? null,
    redFalseRate: scored?.redFalseRate ?? null,
    red: reps.map((r) => r.red),
    attribution: scored?.party?.attribution ?? null,
    msMean: mean(reps.map((r) => r.ms)),
    calls: reps.reduce((s, r) => s + (r.diag?.calls ?? 0), 0)
  };
}

function redRates(redList) {
  const worthy = redList.filter((r) => r && r.worthy);
  const others = redList.filter((r) => r && !r.worthy && r.counted);
  return {
    recall: worthy.length ? worthy.filter((r) => r.hit).length / worthy.length : null,
    falseRate: others.length ? others.filter((r) => r.hit).length / others.length : null,
    worthy: worthy.length,
    others: others.length
  };
}

/** Jev section numbers over scored items (and their no-Jev baselines, when the run compared). */
export function summarizeJev(scoredItems) {
  const items = (scoredItems ?? []).filter(Boolean);
  const reps = items.flatMap((item) => item.reps.map((rep) => ({ item, rep })));
  const withJev = reps.filter(({ rep }) => rep.jev);
  const flags = {};
  const overrides = { total: 0, right: 0, wrong: 0, neutral: 0 };
  let calls = 0;
  let skipped = 0;
  let triageMisses = 0;
  let errors = 0;
  let runsWithErrors = 0;
  const ms = [];
  const ran = {};
  for (const { rep } of withJev) {
    const j = rep.jev;
    calls += j.calls;
    skipped += j.skipped;
    triageMisses += j.triageMisses;
    errors += j.errors;
    if (j.errors) runsWithErrors += 1;
    if (j.ms !== null) ms.push(j.ms);
    for (const step of j.ran) ran[step] = (ran[step] ?? 0) + 1;
    for (const key of Object.keys(overrides)) overrides[key] += j.overrides[key];
    for (const [flag, n] of Object.entries(j.flags)) flags[flag] = (flags[flag] ?? 0) + n;
  }
  const party = items.filter((item) => item.party);
  const attribution = party.reduce((acc, item) => ({ scored: acc.scored + item.party.attribution.scored, correct: acc.correct + item.party.attribution.correct }), { scored: 0, correct: 0 });
  const baselined = items.filter((item) => item.withoutJev);
  const baseAttribution = baselined.filter((item) => item.withoutJev.attribution).reduce((acc, item) => ({ scored: acc.scored + item.withoutJev.attribution.scored, correct: acc.correct + item.withoutJev.attribution.correct }), { scored: 0, correct: 0 });
  return {
    runs: reps.length,
    runsWithJev: withJev.length,
    calls,
    callsPerRun: withJev.length ? calls / withJev.length : null,
    msP50: percentile(ms, 50),
    msP95: percentile(ms, 95),
    ran,
    skippedChunks: skipped,
    triageMisses,
    overrides,
    flags,
    errors,
    runsWithErrors,
    attribution: { ...attribution, accuracy: attribution.scored ? attribution.correct / attribution.scored : null },
    red: redRates(reps.map(({ rep }) => rep.red)),
    compared: baselined.length,
    without: baselined.length
      ? {
          score: mean(baselined.map((item) => item.withoutJev.score)),
          scoreWith: mean(baselined.map((item) => item.score)),
          red: redRates(baselined.flatMap((item) => item.withoutJev.red)),
          attribution: { ...baseAttribution, accuracy: baseAttribution.scored ? baseAttribution.correct / baseAttribution.scored : null },
          msMean: mean(baselined.map((item) => item.withoutJev.msMean)),
          msMeanWith: mean(baselined.map((item) => mean(item.reps.map((r) => r.ms)))),
          calls: baselined.reduce((s, item) => s + item.withoutJev.calls, 0),
          callsWith: baselined.reduce((s, item) => s + item.reps.reduce((t, r) => t + (r.diag?.calls ?? 0), 0), 0)
        }
      : null
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
    redFalseRate: pick("redFalseRate"),
    // Item means, so an item run with 3 reps weighs the same as one with 1. null = not measured.
    darkDeedAcc: pick("darkDeedAcc"),
    darkViceAcc: pick("darkViceAcc"),
    darkDetectAcc: pick("darkDetectAcc"),
    darkFalseRate: pick("darkFalseRate"),
    darkGoldItems: items.filter((item) => item.darkDeedAcc !== null && item.darkDeedAcc !== undefined).length,
    darkNoneItems: items.filter((item) => item.darkFalseRate !== null && item.darkFalseRate !== undefined).length,
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
    worst: [...items].sort((a, b) => (a.score ?? 0) - (b.score ?? 0) || a.id.localeCompare(b.id)).slice(0, 15).map((item) => item.id),
    // Dark-deed errors do not move `score`, so they get their own list: missed or wrong dark deeds on
    // gold-dark items first, then dark deeds invented on gold "none" items.
    darkMisses: items
      .map((item) => ({ id: item.id, miss: item.darkDeedAcc == null ? null : 1 - item.darkDeedAcc, fp: item.darkFalseRate ?? null }))
      .filter((entry) => (entry.miss ?? 0) > 0 || (entry.fp ?? 0) > 0)
      .sort((a, b) => (b.miss ?? -1) - (a.miss ?? -1) || (b.fp ?? 0) - (a.fp ?? 0) || a.id.localeCompare(b.id))
      .slice(0, 15)
      .map((entry) => entry.id)
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
/** The config as recorded in a report: no API key (gateway or Jev) and no function hooks. */
export function redactConfig(config) {
  const out = { ...config, apiKey: config?.apiKey ? "***" : "", fetchImpl: undefined, sleep: undefined, getHeaders: undefined };
  if (config?.jev && typeof config.jev === "object") out.jev = { ...config.jev, apiKey: config.jev.apiKey ? "***" : "", fetchImpl: undefined, sleep: undefined };
  return out;
}

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
    config: redactConfig(config),
    reps,
    systemId,
    ...(options.party ? { party: true, partyMode: options.partyMode ?? "auto" } : {}),
    ...(options.jevInfo ? { jev: { ...options.jevInfo } } : {}),
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
      const runOne = (jev) => (item.category === "party"
        ? runPartyItem(item, { transport, config: options.config ?? {}, reps, systemId, jev, partyMode: options.partyMode, ...(options.adapterFactory ? { adapterFactory: options.adapterFactory } : {}) })
        : runItem(item, { transport, config, reps, systemId, pipeline, jev }));
      const result = await runOne(options.jev ?? null);
      const scoreOptions = options.darkSchema === undefined ? {} : { darkSchema: options.darkSchema };
      const scored = scoreItem(item, result, scoreOptions);
      // Same item, same transport, Jev off: the "without Jev" column of the report.
      if (options.jev && options.compareWithoutJev) scored.withoutJev = baselineOf(scoreItem(item, await runOne(null), scoreOptions));
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
  if (state.jev || state.scored.some((item) => item.reps.some((rep) => rep.jev))) state.jevSummary = summarizeJev(state.scored);
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
  return `| ${name} | ${g.items} | ${pct(g.score)} | ${pct(g.recall)} | ${pct(g.precision)} | ${pct(g.f1)} | ${pct(g.outcomeAcc)} | ${pct(g.dangerAcc)} | ${pct(g.themeAcc)} | ${pct(g.trapAcc)} | ${pct(g.countAcc)} | ${pct(g.darkDeedAcc)} | ${pct(g.darkFalseRate)} | ${pct(g.fallbackRate)} | ${pct(g.firstTryValidRate)} | ${num(g.tagJaccard)} | ${num(g.outcomeAgreement)} | ${ms(g.latencyP50)} | ${ms(g.latencyP95)} |`;
}

const HEADER = "| group | items | score | recall | precision | F1 | outcome | dangerGap | themes | traps | count | dark deed | dark FP | fallback | 1st-try valid | tag Jaccard | outcome agree | p50 | p95 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";

export function renderSummaryTable(summary) {
  return [HEADER, row("**overall**", summary.overall)].join("\n");
}

/** One-line dark-deed summary for a group; says why when nothing was measured instead of printing zeros. */
export function darkLine(g) {
  if (g.darkDeedAcc == null && g.darkFalseRate == null) return "not measured (no darkDeed field in the model output, or no labelled items)";
  return `vice+severity ${pct(g.darkDeedAcc)}, vice only ${pct(g.darkViceAcc)}, recognised as dark ${pct(g.darkDetectAcc)} on ${g.darkGoldItems ?? 0} gold-dark item(s); a dark deed invented on ${pct(g.darkFalseRate)} of ${g.darkNoneItems ?? 0} gold "none" item(s)`;
}

function darkItemLine(item) {
  const gold = goldDarkDeed(item);
  const label = gold ? (gold.vices[0] === "none" ? "none" : `${gold.vices.join("|")} / ${gold.severities.join("|") || "any"}`) : "unlabelled";
  if (item.darkDeedAcc == null && item.darkFalseRate == null) return `dark gold \`${label}\`: not measured`;
  return item.darkDeedAcc != null
    ? `dark gold \`${label}\`: vice+severity ${pct(item.darkDeedAcc)}, vice ${pct(item.darkViceAcc)}, recognised ${pct(item.darkDetectAcc)}`
    : `dark gold \`${label}\`: a dark deed invented in ${pct(item.darkFalseRate)} of reps`;
}

function renderItem(lines, item) {
  lines.push("");
  lines.push(`### ${item.id} (${item.category}, ${item.lang}) — score ${pct(item.score)}`);
  lines.push("");
  lines.push("> " + String(item.notes).replace(/\n/g, "\n> "));
  lines.push("");
  lines.push("gold: `" + JSON.stringify(item.gold) + "`");
  lines.push("");
  lines.push(darkItemLine(item));
  item.sampleOutput.forEach((out, index) => {
    if (out.error) {
      lines.push(`- rep ${index}: **ERROR** ${out.error.name}: ${out.error.message}`);
      return;
    }
    const events = out.events.map((e) => `${e.actorName ? `${e.actorName}: ` : ""}[${(e.tags ?? []).join(",")}${e.themes?.length ? ` / ${e.themes.join(",")}` : ""}] ${e.outcome}${e.dangerGap ? ` (${e.dangerGap})` : ""}${isDarkEvent(e) ? ` {dark: ${e.darkDeed}/${e.darkSeverity ?? "?"}}` : ""} — ${String(e.summary ?? "").slice(0, 100)}`);
    lines.push(`- rep ${index}: ${events.length} event(s)${events.length ? "\n  - " + events.join("\n  - ") : ""}`);
    if (out.proposals.length) lines.push(`  - proposals: ${out.proposals.map((p) => `${p.name} (${p.kind}${p.polarity === "red" ? ", red" : ""})`).join("; ")}`);
  });
}

/** "## Jev" section lines; [] when the run did not ask for Jev and no rep carried Jev diagnostics. */
export function renderJevSection(state) {
  const info = state?.jev ?? null;
  const summary = state?.jevSummary ?? (state?.scored?.some((item) => item.reps?.some((rep) => rep.jev)) ? summarizeJev(state.scored) : null);
  if (!info && !summary) return [];
  const lines = ["## Jev"];
  if (info) lines.push(`- mode **${info.mode ?? "?"}**${info.endpoint ? `, endpoint ${info.endpoint}` : ""}${info.model ? `, model ${info.model}` : ""}${info.faultRate ? `, simulated fault rate ${info.faultRate}` : ""}`);
  if (info?.note) lines.push(`- note: ${info.note}`);
  if (!summary || !summary.runsWithJev) {
    lines.push("- no run carried `diagnostics.jev`: the Jev layer did not run (not configured, or the pipeline/adapter in this checkout has no Jev integration yet), so every number in this report is the plain run.");
    if (!summary || !summary.runsWithJev) return lines;
  }
  const s = summary;
  lines.push(`- ${s.runsWithJev}/${s.runs} runs with Jev; **${s.calls} Jev calls** (${num(s.callsPerRun)}/run), Jev time per run p50 ${ms(s.msP50)} / p95 ${ms(s.msP95)}; steps ran: ${Object.entries(s.ran).map(([k, v]) => `${k} ${v}`).join(", ") || "–"}`);
  lines.push(`- triage: **${s.skippedChunks} chunk(s) skipped**, ${s.triageMisses} triage miss(es) (skipped chunks that held gold events)`);
  lines.push(`- outcome overrides: ${s.overrides.total} (right ${s.overrides.right}, wrong ${s.overrides.wrong}, no gold or no change in correctness ${s.overrides.neutral})`);
  lines.push(`- flags: ${Object.entries(s.flags).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}; Jev errors ${s.errors} in ${s.runsWithErrors} run(s) (fail-open: those runs carried on without Jev)`);
  if (s.attribution.scored) lines.push(`- attribution accuracy (party items, events whose doer is known from gold evidence): **${pct(s.attribution.accuracy)}** (${s.attribution.correct}/${s.attribution.scored})`);
  lines.push(`- red signal (red proposal or dark-act event): recall ${pct(s.red.recall)} on ${s.red.worthy} red-worthy run(s), false rate ${pct(s.red.falseRate)} on ${s.red.others} other run(s)`);
  if (s.without) {
    const w = s.without;
    lines.push("");
    lines.push(`With vs without Jev (${s.compared} item(s) re-run with Jev off, same transport):`);
    lines.push("");
    lines.push("| | with Jev | without Jev |");
    lines.push("|---|---|---|");
    lines.push(`| score | ${pct(w.scoreWith)} | ${pct(w.score)} |`);
    lines.push(`| red recall | ${pct(s.red.recall)} | ${pct(w.red.recall)} |`);
    lines.push(`| red false rate | ${pct(s.red.falseRate)} | ${pct(w.red.falseRate)} |`);
    if (s.attribution.scored || w.attribution.scored) lines.push(`| attribution accuracy | ${pct(s.attribution.accuracy)} | ${pct(w.attribution.accuracy)} |`);
    lines.push(`| model calls | ${w.callsWith} | ${w.calls} |`);
    lines.push(`| mean time per run | ${ms(w.msMeanWith)} | ${ms(w.msMean)} |`);
  }
  return lines;
}

/** "## Party credit" section: per character, gold bounds vs the events each sheet would get. */
export function renderPartySection(state) {
  const party = (state?.scored ?? []).filter((item) => item.party);
  if (!party.length) return [];
  const lines = ["## Party credit"];
  const modes = [...new Set(party.map((item) => item.party.mode).filter(Boolean))];
  const leak = mean(party.map((item) => item.party.creditLeak));
  const idle = mean(party.map((item) => item.party.idleAcc));
  const att = party.reduce((acc, item) => ({ scored: acc.scored + item.party.attribution.scored, correct: acc.correct + item.party.attribution.correct }), { scored: 0, correct: 0 });
  const extractions = party.flatMap((item) => item.reps.map((rep) => rep.extractions)).filter((n) => Number.isFinite(n));
  lines.push(`- mode ${modes.join(", ") || "?"} (party = one adapter with its extraction cache, one extraction per item; per-pc = cache off, one extraction per character, the pre-cache cost); extractions per item ${num(mean(extractions), 1)}`);
  lines.push(`- per-character count within gold bounds ${pct(mean(party.map((item) => item.countAcc)))}; idle characters left at zero ${pct(idle)}; credit leak ${num(leak)} extra event(s)/item; attribution ${pct(att.scored ? att.correct / att.scored : null)} (${att.correct}/${att.scored})`);
  lines.push("");
  lines.push("| item | character | gold events | got | count ok | tag recall | tags |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const item of party) {
    for (const [name, a] of Object.entries(item.party.actors)) {
      lines.push(`| ${item.id} | ${name} | ${a.min}-${a.max ?? "∞"} | ${a.counts.join("/")} | ${pct(a.countAcc)} | ${pct(a.recall)} | ${a.tags.join(", ")} |`);
    }
  }
  return lines;
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
  if (o.redAcc !== null || o.redFalseRate !== null) lines.push(`- red polarity: red on red-worthy items ${o.redAcc === null ? "–" : (o.redAcc * 100).toFixed(1) + "%"}, red on other items (false positives) ${o.redFalseRate === null ? "–" : (o.redFalseRate * 100).toFixed(1) + "%"}`);
  lines.push(`- dark deeds: ${darkLine(o)}`);
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
  const jevLines = renderJevSection(state);
  if (jevLines.length) lines.push(...jevLines, "");
  const partyLines = renderPartySection(state);
  if (partyLines.length) lines.push(...partyLines, "");
  lines.push("## Worst 15 items");
  const byId = new Map((state.scored ?? []).map((item) => [item.id, item]));
  for (const id of summary.worst) {
    const item = byId.get(id);
    if (item) renderItem(lines, item);
  }
  // Dark-deed errors do not move score, so they would rarely reach the worst-15 list on their own.
  const darkMisses = (summary.darkMisses ?? []).map((id) => byId.get(id)).filter(Boolean);
  if (darkMisses.length) {
    lines.push("");
    lines.push("## Dark-deed misses (up to 15)");
    for (const item of darkMisses) renderItem(lines, item);
  }
  lines.push("");
  lines.push("## Metric definitions");
  lines.push("- **score**: mean of the applicable per-item checks below (0 on a total failure).");
  lines.push("- **recall**: share of gold mustTags groups (\"a|b\" = either) present on some event. **precision**: share of predicted tags that are in mustTags ∪ okTags. **F1** of the two.");
  lines.push("- **outcome**: dominant event outcome ∈ gold outcome alternatives. **dangerGap**: some event carries an allowed gap (gold \"none\" = no event may carry one).");
  lines.push("- **themes**: any predicted theme (event themes, result themes, proposal metadata.themes) matches gold themesAny by slug, substring or stem. **traps**: noEvents items returned zero events. **count**: event count within [minEvents, maxEvents].");
  lines.push("- **dark deed** (darkDeedAcc): on items whose gold names a vice, share of reps where some event carries a gold vice AND a gold severity; the summary line adds vice only and \"recognised as dark\" (any vice). **dark FP** (darkFalseRate): on gold \"none\" items (labelled, or in a reviewed category), share of reps with any event whose darkDeed is not \"none\". Both are \"–\" when the model output has no darkDeed field; neither enters score.");
  lines.push("- **fallback**: the pipeline threw (the GM would have got the local keyword analyzer). **1st-try valid**: pipeline stages that needed no repair turn and reported no errors.");
  lines.push("- **tag Jaccard**: mean pairwise Jaccard of the union tag set across reps. **outcome agree**: share of reps agreeing with the modal dominant outcome.");
  return lines.join("\n") + "\n";
}

