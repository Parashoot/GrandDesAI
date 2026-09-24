// Offline simulated LLM for the AI gateway pipeline.
//
// Why this exists: the gateway's whole promise is "almost never fall back to the keyword
// dictionary", and a promise like that can only be kept if the parsing / coercion / repair-turn
// machinery has been exercised against every ugly thing a real local model does -- thousands of
// times, deterministically, inside `npm test`, with no Ollama running. A real model misbehaves
// rarely and irreproducibly; this one misbehaves on purpose, at a configurable rate, and the same
// seed always misbehaves the same way, so a regression in pipeline.js shows up as a red test
// instead of as a GM's "why did it fall back again?" a month later.
//
// The sim is a drop-in `fetch` replacement (`fetchImpl` for scripts/ai/transport.js). It
// recognises both wire shapes the transport speaks -- Ollama's POST /api/chat and the
// OpenAI-compatible POST /v1/chat/completions -- plus the model-listing endpoints, and answers
// with a real `Response` object so the transport cannot tell it from the network.
//
// Answers come from the labeled corpus gold when the request's notes can be matched to a corpus
// item (token-fingerprint match, so it survives the pipeline's chunking and prompt wrapping), and
// from a cheap regex heuristic over GROWTH_TAXONOMY otherwise. Accuracy is NOT the point -- the
// real-model harness (run.mjs) measures accuracy; the sim measures robustness.
//
// Pure ESM, no Node or Foundry globals beyond `Response`/`setTimeout`, so it also runs inside the
// browser bundle.

import { GROWTH_TAXONOMY } from "../../scripts/growth-taxonomy.js";

export const FAULT_KINDS = Object.freeze([
  "truncate", // cut the JSON off mid-way
  "fence", // ```json ... ```
  "prose", // "Sure! Here is the JSON:" before and a sign-off after
  "think", // <think>...</think> preamble (qwen3 ignoring think:false)
  "wrongKeys", // {"result": [...]} / {"data": {"events": ...}} / bare array
  "hallucinatedTags", // "melee", "defensive", "healing", "lockpicking", random words
  "missingFields", // drop summary / outcome / tags on some events or proposal fields
  "badEnums", // "Success!", "crit", "nat 20", "FAILED"
  "stringNumbers", // tier "2", max "1", actions "one"
  "pythonLiterals", // True / None / single quotes
  "http500",
  "http429", // starts a short burst of 429s
  "timeout", // never answers; rejects when the caller aborts
  "network", // TypeError("Failed to fetch")
  "empty" // 200 with empty content
]);

// Weighted so that content faults (which the pipeline must SALVAGE) dominate, and transport faults
// (which the pipeline may only RETRY) are a realistic minority.
export const DEFAULT_FAULT_WEIGHTS = Object.freeze({
  truncate: 10,
  fence: 10,
  prose: 8,
  think: 8,
  wrongKeys: 6,
  hallucinatedTags: 12,
  missingFields: 8,
  badEnums: 10,
  stringNumbers: 8,
  pythonLiterals: 5,
  http500: 4,
  http429: 3,
  timeout: 2,
  network: 3,
  empty: 3
});

const HALLUCINATED_TAGS = ["melee", "defensive", "healing", "lockpicking", "sneaking", "magic", "combat", "swordsmanship", "Persuasion", "Athletics!", "fire magic", "Brewing", "bee-keeping", "banana", "vibes", "teamwork"];
const BAD_OUTCOMES = ["Success!", "crit", "nat 20", "FAILED", "critical fail", "partial", "win", "Crit Success", "botched", "succeeded", "1", "20", "mixed", "éxito"];
const BAD_DANGER = ["HIGH", "extreme", "yes", "true", "none", "Moderate ", "SEVERE!!"];

// mulberry32: tiny, fast, good enough, and identical in Node and every browser.
export function createRng(seed = 1) {
  let a = (Number(seed) >>> 0) || 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p
  };
}

function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const TOKEN_RE = /[\p{L}\p{N}]{3,}/gu;
function tokens(text) {
  return (String(text).toLowerCase().match(TOKEN_RE) ?? []);
}

/**
 * Build the corpus index used to recognise which labeled item a request is about. Tokens that
 * occur in many items (character names reused across the corpus, "the", "and") are dropped so the
 * fingerprint is made of words that actually distinguish one note from another; the prompt's own
 * instruction text then cannot accidentally match an item.
 */
export function buildCorpusIndex(corpus = []) {
  const docFreq = new Map();
  const itemTokens = corpus.map((item) => new Set(tokens(item.notes)));
  for (const set of itemTokens) for (const token of set) docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
  const cutoff = Math.max(3, Math.ceil(corpus.length * 0.03));
  return corpus.map((item, index) => {
    const distinctive = [...itemTokens[index]].filter((token) => docFreq.get(token) <= cutoff);
    return { item, fingerprint: distinctive.length >= 2 ? distinctive : [...itemTokens[index]] };
  });
}

export function matchCorpusItem(index, text) {
  if (!index.length) return null;
  const present = new Set(tokens(text));
  let best = null;
  for (const entry of index) {
    if (!entry.fingerprint.length) continue;
    let hits = 0;
    for (const token of entry.fingerprint) if (present.has(token)) hits += 1;
    const score = hits / entry.fingerprint.length;
    if (!best || score > best.score) best = { item: entry.item, score };
  }
  return best && best.score >= 0.34 ? best : null;
}

function firstAlt(value) {
  return typeof value === "string" ? value.split("|")[0] : value;
}

function sentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^[\s\-*•~+—>\d.)]+/, "").trim())
    .filter(Boolean);
}

/** The "ideal" events for a corpus item, derived from its gold labels. */
export function goldEvents(item) {
  const gold = item.gold ?? {};
  if (gold.noEvents) return [];
  const must = (gold.mustTags ?? []).map(firstAlt);
  const themes = gold.themesAny?.length ? [gold.themesAny[0]] : [];
  const count = Math.max(gold.minEvents ?? 1, must.length ? 1 : 0, themes.length ? 1 : 0);
  const n = Math.max(1, Math.min(count, gold.maxEvents ?? count));
  const parts = sentences(item.notes);
  const events = [];
  for (let i = 0; i < n; i += 1) {
    const tags = must.filter((_, k) => k % n === i);
    if (!tags.length && must.length && !themes.length) tags.push(must[i % must.length]);
    const quote = parts[i % Math.max(1, parts.length)] ?? item.notes;
    events.push({
      summary: `Sim summary ${i + 1}: ${quote.slice(0, 120)}`,
      tags,
      themes: i === 0 ? themes : [],
      outcome: firstAlt(gold.outcome) ?? "success",
      ...(gold.dangerGap && gold.dangerGap !== "none" && i === 0 ? { dangerGap: firstAlt(gold.dangerGap) } : {}),
      quote: quote.slice(0, 400),
      language: String(item.lang ?? "en").split("-")[0]
    });
    if (!events[i].tags.length && !events[i].themes.length) events[i].themes = ["sim-activity"];
  }
  return events;
}

/** Cheap fallback when the notes are not a corpus item: taxonomy regexes per sentence. */
export function heuristicEvents(text) {
  const out = [];
  for (const sentence of sentences(text).slice(0, 12)) {
    const tags = GROWTH_TAXONOMY.filter(([, pattern]) => pattern.test(sentence)).map(([tag]) => tag).slice(0, 3);
    if (!tags.length) continue;
    out.push({ summary: sentence.slice(0, 160), tags, themes: [], outcome: /fail|miss|couldn/i.test(sentence) ? "failure" : "success", quote: sentence.slice(0, 400), language: "en" });
  }
  return out;
}

function proposalFor(events, rng, index) {
  const tags = [...new Set(events.flatMap((event) => event.tags ?? []))].slice(0, 2);
  const theme = events.flatMap((event) => event.themes ?? [])[0];
  const label = (theme ?? tags[0] ?? "practice").replace(/-/g, " ");
  const kinds = ["feat", "passive", "action"];
  const kind = kinds[(index + rng.int(3)) % 3];
  const mechanics = { effect: `Gain a +1 circumstance bonus to checks involving ${label}.`, duration: kind === "action" ? "instant" : "while active", frequency: { max: 1, per: "day" } };
  if (kind === "action") Object.assign(mechanics, { actions: 1, roll: { kind: "Skill check", formula: "1d20+6" } });
  return {
    kind: "skill",
    entry: {
      name: `Sim: ${label.replace(/\b\w/g, (c) => c.toUpperCase())} Knack`,
      tier: 1,
      system_equivalent: "Skill feat (simulated)",
      gameItem: { kind },
      mechanics,
      metadata: {
        tags: tags.length ? tags : ["support"],
        ...(theme ? { themes: [theme] } : {}),
        lineage: { operation: "origin", sources: [], rationale: "Simulated from repeated evidence." }
      }
    },
    evidence: ["Session note analysis"]
  };
}

// ---- request introspection ---------------------------------------------------------------

function readRequest(url, init) {
  let body = {};
  try {
    body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ?? {};
  } catch {
    body = {};
  }
  const path = String(url);
  const flavor = /\/v1\/chat\/completions/.test(path) ? "openai" : /\/api\/chat/.test(path) ? "ollama" : null;
  const schema = body.format && typeof body.format === "object"
    ? body.format
    : body.response_format?.json_schema?.schema ?? null;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const contentOf = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""));
  // Only USER turns identify the notes: the system prompt carries few-shot examples ("Bram sold
  // honey...") that would otherwise match unrelated corpus items.
  const userTurns = messages.filter((m) => m.role === "user");
  const text = (userTurns.length ? userTurns : messages).map(contentOf).join("\n");
  const fenced = /<<<\n?([\s\S]*?)\n?>>>/.exec(text);
  return { path, flavor, body, schema, messages, text, notesText: fenced ? fenced[1] : text };
}

function detectStage(req) {
  const props = req.schema?.properties ?? {};
  if (props.proposals && props.events) return "single";
  if (props.proposals && !props.events) return "propose";
  if (props.events) return "extract";
  const system = req.messages.find((m) => m.role === "system")?.content ?? "";
  if (/propos/i.test(system) && !/extract/i.test(system)) return "propose";
  return "extract";
}

function fillRequiredKeys(payload, schema) {
  const required = Array.isArray(schema?.required) ? schema.required : [];
  for (const key of required) {
    if (key in payload) continue;
    const type = schema.properties?.[key]?.type;
    payload[key] = type === "array" ? [] : type === "object" ? {} : type === "string" ? "" : type === "boolean" ? false : type === "number" || type === "integer" ? 0 : null;
  }
  return payload;
}

// ---- fault injection -----------------------------------------------------------------------

function pickFault(rng, weights) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng.next() * total;
  for (const [kind, w] of entries) {
    roll -= w;
    if (roll <= 0) return kind;
  }
  return entries[entries.length - 1]?.[0] ?? null;
}

function corruptPayload(kind, payload, rng) {
  const clone = JSON.parse(JSON.stringify(payload));
  const events = Array.isArray(clone.events) ? clone.events : [];
  const proposals = Array.isArray(clone.proposals) ? clone.proposals : [];
  switch (kind) {
    case "hallucinatedTags":
      for (const event of events) {
        if (rng.chance(0.7)) event.tags = [...(event.tags ?? []), rng.pick(HALLUCINATED_TAGS)];
        if (rng.chance(0.3) && event.tags.length) event.tags[0] = rng.pick(HALLUCINATED_TAGS);
      }
      for (const proposal of proposals) {
        const tags = proposal.entry?.metadata?.tags;
        if (Array.isArray(tags)) tags.push(rng.pick(HALLUCINATED_TAGS));
      }
      return clone;
    case "missingFields":
      for (const event of events) {
        const drop = rng.pick(["summary", "outcome", "quote", "language"]);
        delete event[drop];
      }
      for (const proposal of proposals) {
        const mech = proposal.entry?.mechanics;
        if (mech && rng.chance(0.6)) delete mech.duration;
        if (mech && rng.chance(0.4)) delete mech.frequency;
        if (proposal.entry && rng.chance(0.3)) delete proposal.entry.tier;
      }
      return clone;
    case "badEnums":
      for (const event of events) {
        event.outcome = rng.pick(BAD_OUTCOMES);
        if (rng.chance(0.3)) event.dangerGap = rng.pick(BAD_DANGER);
      }
      for (const proposal of proposals) {
        if (proposal.entry?.mechanics?.frequency) proposal.entry.mechanics.frequency.per = rng.pick(["Day", "per day", "daily", "turn"]);
      }
      return clone;
    case "stringNumbers":
      for (const proposal of proposals) {
        const entry = proposal.entry ?? {};
        if (entry.tier !== undefined) entry.tier = String(entry.tier);
        if (entry.mechanics?.frequency) entry.mechanics.frequency.max = String(entry.mechanics.frequency.max);
        if (entry.mechanics?.actions !== undefined) entry.mechanics.actions = String(entry.mechanics.actions);
      }
      for (const event of events) if (rng.chance(0.5)) event.tags = (event.tags ?? []).join(", ");
      return clone;
    case "wrongKeys": {
      const variant = rng.int(4);
      if (variant === 0) return { result: events.length ? events : proposals };
      if (variant === 1) return { data: clone };
      if (variant === 2) return events.length ? events : proposals;
      return { Events: events, Proposals: proposals };
    }
    default:
      return clone;
  }
}

function textFaults(kind, text, rng) {
  switch (kind) {
    case "truncate": {
      if (text.length < 8) return text;
      const cut = Math.max(2, Math.floor(text.length * (0.35 + rng.next() * 0.6)));
      return text.slice(0, cut);
    }
    case "fence":
      return rng.chance(0.5) ? "```json\n" + text + "\n```" : "Here you go:\n```\n" + text + "\n```\nLet me know if you need anything else!";
    case "prose":
      return rng.pick(["Sure! Here is the JSON you asked for:\n", "Based on the notes, ", "Okay.\n\n"]) + text + rng.pick(["\n\nI hope this helps.", "\nNote: I skipped the out-of-character parts.", ""]);
    case "think":
      return "<think>\nThe user wants events. Let me think about {\"events\": maybe}... The GM wrote about a fight.\n</think>\n" + text;
    case "pythonLiterals":
      return text.replace(/\btrue\b/g, "True").replace(/\bfalse\b/g, "False").replace(/\bnull\b/g, "None").replace(/"(summary|outcome|tags|themes|kind|name)":/g, "'$1':");
    default:
      return text;
  }
}

// ---- the fake fetch ------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {Array}  [options.corpus]       labeled corpus items (gold answers); omit for heuristic-only
 * @param {number} [options.seed=1]
 * @param {number} [options.faultRate=0] probability that any one chat call is faulted
 * @param {object} [options.faultWeights] relative weights per FAULT_KINDS entry (0 disables)
 * @param {number} [options.burst429=2]   how many consecutive 429s a burst lasts
 * @param {number} [options.latencyMs=0] simulated latency per call (kept 0 in tests)
 * @param {number} [options.timeoutFallbackMs=50] when a timeout fault fires and the caller gave no AbortSignal
 * @param {string[]} [options.models]     names reported by /api/tags and /v1/models
 * @returns {{ fetch: Function, stats: object, calls: Array, reset: Function }}
 */
export function createSimModel(options = {}) {
  const {
    corpus = [],
    seed = 1,
    faultRate = 0,
    faultWeights = DEFAULT_FAULT_WEIGHTS,
    burst429 = 2,
    latencyMs = 0,
    timeoutFallbackMs = 50,
    models = ["sim-model:latest", "qwen3:30b-a3b"],
    keepCalls = false
  } = options;
  const index = buildCorpusIndex(corpus);
  let rng = createRng(seed);
  let burstRemaining = 0;
  const stats = { calls: 0, chatCalls: 0, faults: {}, matched: 0, heuristic: 0, stages: { extract: 0, propose: 0, single: 0, repair: 0 } };
  const calls = [];

  const respond = (status, body, headers = {}) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  const wrap = (flavor, content, model) =>
    flavor === "openai"
      ? { id: "sim", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] }
      : { model, created_at: "2026-09-23T00:00:00Z", message: { role: "assistant", content }, done: true, done_reason: "stop" };

  async function simFetch(url, init = {}) {
    stats.calls += 1;
    const req = readRequest(url, init);
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));

    if (/\/api\/tags/.test(req.path)) return respond(200, { models: models.map((name) => ({ name, model: name })) });
    if (/\/v1\/models/.test(req.path)) return respond(200, { object: "list", data: models.map((id) => ({ id, object: "model" })) });
    if (/\/api\/version/.test(req.path)) return respond(200, { version: "0.34.3-sim" });
    if (!req.flavor) return respond(404, { error: `sim-model: unknown path ${req.path}` });

    stats.chatCalls += 1;
    const isRepair = req.messages.some((m) => m.role === "assistant");
    const stage = detectStage(req);
    stats.stages[isRepair ? "repair" : stage] += 1;

    // Per-call determinism: the fault decision depends on the seed, the call ordinal and the
    // request content, so reordering unrelated items does not reshuffle every later answer.
    const local = createRng((hashString(req.text) ^ Math.imul(stats.chatCalls, 2654435761) ^ rng.int(1 << 30)) >>> 0);

    let fault = null;
    if (burstRemaining > 0) {
      burstRemaining -= 1;
      fault = "http429";
    } else if (faultRate > 0 && local.chance(faultRate)) {
      fault = pickFault(local, faultWeights);
      if (fault === "http429") burstRemaining = Math.max(0, burst429 - 1);
    }
    if (fault) stats.faults[fault] = (stats.faults[fault] ?? 0) + 1;
    if (keepCalls) calls.push({ path: req.path, stage, isRepair, fault, body: req.body });

    if (fault === "http500") return respond(500, { error: "sim: internal server error" });
    if (fault === "http429") return respond(429, { error: "sim: rate limited" }, { "retry-after": "0" });
    if (fault === "network") throw new TypeError("Failed to fetch");
    if (fault === "timeout") {
      return new Promise((_, reject) => {
        const abortError = () => {
          const error = new Error("The operation was aborted.");
          error.name = "AbortError";
          return error;
        };
        const signal = init.signal;
        if (signal) {
          if (signal.aborted) return reject(abortError());
          signal.addEventListener("abort", () => reject(abortError()), { once: true });
        } else {
          setTimeout(() => reject(abortError()), timeoutFallbackMs);
        }
      });
    }

    const match = matchCorpusItem(index, req.text);
    let events;
    if (match) {
      stats.matched += 1;
      events = goldEvents(match.item);
    } else {
      stats.heuristic += 1;
      events = heuristicEvents(req.notesText);
    }

    let payload;
    const earned = events.filter((event) => (event.tags?.length || event.themes?.length));
    if (stage === "propose") {
      payload = { proposals: earned.length ? [proposalFor(earned, local, stats.chatCalls)] : [] };
    } else if (stage === "single") {
      payload = { events, proposals: earned.length ? [proposalFor(earned, local, stats.chatCalls)] : [] };
    } else {
      payload = { events };
    }
    fillRequiredKeys(payload, req.schema);

    // A repair turn is the model's second chance; real models do mostly fix what they were told,
    // so repairs are faulted at half the base rate (still non-zero: repairs can fail too).
    let content;
    if (fault === "empty") content = "";
    else {
      const shaped = ["hallucinatedTags", "missingFields", "badEnums", "stringNumbers", "wrongKeys"].includes(fault) && !(isRepair && local.chance(0.5))
        ? corruptPayload(fault, payload, local)
        : payload;
      content = JSON.stringify(shaped, null, local.chance(0.5) ? 2 : 0);
      if (["truncate", "fence", "prose", "think", "pythonLiterals"].includes(fault)) content = textFaults(fault, content, local);
    }
    const model = req.body.model ?? models[0];
    return respond(200, wrap(req.flavor, content, model));
  }

  return {
    fetch: simFetch,
    stats,
    calls,
    reset() {
      rng = createRng(seed);
      burstRemaining = 0;
      stats.calls = 0;
      stats.chatCalls = 0;
      stats.faults = {};
      stats.matched = 0;
      stats.heuristic = 0;
      stats.stages = { extract: 0, propose: 0, single: 0, repair: 0 };
      calls.length = 0;
    }
  };
}
