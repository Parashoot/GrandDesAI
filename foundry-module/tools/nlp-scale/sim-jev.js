// Offline simulated TypeSafe "Jev" for the harness (docs/jev-layer-contract.md, "Harness").
//
// Why this exists: the owner has no Jev key yet, and even with one a Jev regression must show up
// inside `npm test` without the network. This is a drop-in `fetch` (`fetchImpl` for
// scripts/ai/jev.js#createJevClient) that speaks the exact wire format the contract documents:
//
//   POST {endpoint}/v1/systemone   Authorization: Bearer <key>
//     { model, state, questions: { name: { type: "noul"|"choice"|"score", instructions, criteria } } }
//     -> { model, answers: { name: Answer }, usage: { input_tokens, output_tokens } }
//   GET  {endpoint}/v1/models      -> { models: [{ name, description, release_date }] }
//
// Answers are deterministic: they come from what the question is about (recognised from its type,
// its criteria labels and keywords in its instructions -- the real question names are for code
// only, so nothing here depends on them) plus cheap keyword heuristics over the state the question
// points at (`events[3].summary`, `chunks[1]`, or the whole state), and from corpus gold when the
// state can be matched to a labeled item (party items name the doer of each deed; red-polarity
// items are dark). Like sim-model.js, accuracy is not the point: robustness and wiring are.
//
// Fault injection (seeded, never Math.random): 5xx, 429 with Retry-After, timeout (a fetch that
// never resolves but rejects with AbortError when the caller's AbortSignal fires), malformed JSON
// (200 with a truncated body), 401, and a network TypeError. `forceFault` pins one kind for tests.
//
// Pure ESM; no Node or Foundry globals beyond `Response`/`setTimeout`, so it can join the browser
// bundle.

import { createRng } from "./sim-model.js";

export const JEV_FAULT_KINDS = Object.freeze(["http500", "http503", "http429", "timeout", "malformed", "unauthorized", "network"]);

// Retryable faults dominate (the client may only retry them); a 401 ends Jev for the whole run, so
// it is rare. "network" is off by default: the contract lists it as a failure mode but the brief
// for the sim does not, and it overlaps with timeout for the pipeline's purposes.
export const DEFAULT_JEV_FAULT_WEIGHTS = Object.freeze({
  http500: 4,
  http503: 2,
  http429: 4,
  timeout: 2,
  malformed: 3,
  unauthorized: 1,
  network: 0
});

export const SIM_JEV_MODELS = Object.freeze([
  { name: "jev-latest", description: "Simulated Jev (nlp-scale sim-jev.js)", release_date: "2026-09-29" },
  { name: "jev-sim-1", description: "Simulated Jev, pinned", release_date: "2026-09-29" }
]);

// ---- small text helpers ------------------------------------------------------------------------

function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const norm = (text) => String(text ?? "").toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function stateText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return value.map(stateText).join("\n");
  // Prefer the fields that carry what happened; fall back to everything.
  const preferred = ["summary", "quote", "text", "notes", "passage", "consequence", "name", "effect"].filter((k) => typeof value[k] === "string").map((k) => value[k]);
  return preferred.length ? preferred.join("\n") : Object.values(value).map(stateText).join("\n");
}

/** Resolve "events[3].summary" / "chunks[1]" / "state.events[0]" against the state; null if absent. */
export function resolveStatePath(state, path) {
  const parts = String(path).replace(/^state\.?/, "").match(/[A-Za-z_$][\w$]*|\[\d+\]/g) ?? [];
  let current = state;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = part.startsWith("[") ? current[Number(part.slice(1, -1))] : current[part];
  }
  return current;
}

/** The part of the state a question is about: every `name[i](.field)` reference that resolves. */
export function focusOf(state, instructions) {
  const refs = String(instructions ?? "").match(/[A-Za-z_$][\w$]*(?:\[\d+\](?:\.[A-Za-z_$][\w$]*)*)+/g) ?? [];
  const hits = [];
  for (const ref of refs) {
    const value = resolveStatePath(state, ref);
    if (value !== undefined) hits.push(value);
  }
  return hits.length ? hits.map(stateText).join("\n") : stateText(state);
}

// ---- intent recognition --------------------------------------------------------------------------

const OUTCOME_LABELS = ["criticalSuccess", "success", "failure", "criticalFailure", "unclear"];

/** What a question asks, from its shape and instructions (names are code-only per the contract). */
export function questionIntent(question) {
  const type = question?.type;
  const text = norm(question?.instructions);
  const labels = type === "choice" && question.criteria && typeof question.criteria === "object" ? Object.keys(question.criteria) : [];
  if (type === "choice") {
    if (labels.some((l) => /^(success|failure|criticalsuccess|criticalfailure)$/i.test(l))) return "outcome";
    if (labels.some((l) => /whole-party|someone-else/i.test(l)) || /who (performed|did|was)|doer|which character/.test(text)) return "actor";
    return "choice";
  }
  if (type === "noul") {
    if (/witness|only report|reporting only|not the doer|speaking\/reporting/.test(text)) return "witness";
    if (/morally dark|dark act|surrender|torture|betray|desecrat/.test(text)) return "dark";
    if (/player character|scenery|out-of-character|out of character|rules talk|did, attempted|something a/.test(text)) return "triage";
    return "noul";
  }
  if (type === "score") {
    if (/ground|evidence|cited deeds/.test(text)) return "grounded";
    if (/fit|play so far|character's play/.test(text)) return "fit";
    return "score";
  }
  return "unknown";
}

// ---- heuristics ----------------------------------------------------------------------------------

const ACTION_RE = /\b(attack|attacked|kill|killed|killing|slew|slain|fought|fight|won|win|lost|lose|healed|heal|cast|casts|stole|steal|sneak|snuck|picked|climbed|swam|jumped|ran|rode|held|blocked|parried|shot|fired|persuaded|convinced|lied|bluffed|intimidat|haggled|sold|bought|brewed|crafted|forged|baked|tracked|hunted|rescued|saved|carried|dragged|torched|burned|froze|rooted|entangled|patched|treated|prayed|blessed|led|lead|sang|played|danced|bet|gambled|rigged|cheated|tricked|picked|disarmed|searched|found|read|studied|translated|deciphered|summoned|raised|tamed|adopted|built|fixed|repaired|cooked|drank|punched|kicked|tackled|grappled|charged|dodged|hid|crit|nat ?20|nat ?1|rolled|failed|missed|botched|surviv|escaped|negotiat|caught|catch|saw|pushed|knocked|smashed|broke|placed|got \d|got (first|second|third|2nd|3rd|1st)|took|finished|reached|competed|entered|delivered|guarded|scouted|spotted|carried)\w*/i;
const NO_ACTION_RE = /\b(next session|next time|rules q|rules question|pizza|snacks|owes me|brb|afk|scheduling|schedule|reschedul|we (will|'ll|might|plan)|planning to|going to|want(s)? to|thinking about|if we|should we|can \w+ (ride|use|cast)|does .* work|how does|the weather|the town (is|was)|the city (is|was)|described|lore dump|history of)\b/i;
const DARK_RE = /\b(surrender\w*|helpless|begg\w*|execut\w*|tortur\w*|betray\w*|sold out|desecrat\w*|grave ?robb\w*|raise[ds]? the dead|animate[ds]? (the )?dead|necromanc\w*|trophy|trophies|ears? as|loose end|finished off|murder\w*|sacrific\w*|poison(ed)? the well|kill\w* (a |the )?(prisoner|child|captive|goblin that)|slit .* throat|in cold blood|no mercy|enslav\w*)\b/i;
const CRIT_SUCCESS_RE = /\b(nat(ural)? ?20|crit(ical)?(ly)? (success|hit)|crit(ted)?\b|flawless|perfect(ly)?|max(ed)? damage|one[- ]shot)/i;
const CRIT_FAIL_RE = /\b(nat(ural)? ?1\b|crit(ical)? fail\w*|fumbl\w*|botch\w*|disaster|catastroph\w*|nearly died|almost died|went horribly)/i;
const FAIL_RE = /\b(fail\w*|lost|lose|losing|miss(ed)?|couldn'?t|could not|didn'?t (manage|work)|banned|kicked out|caught (cheating|stealing)|got caught|ran away|fled|dropped|broke (his|her|their|my)|no luck|whiffed|sat down|lost to)\b/i;
const WITNESS_VERBS = "(?:saw|see|sees|seen|catch|catches|caught|watched|watch|watches|noticed|notice|spotted|found|heard|witnessed)";
const GROUP_RE = /\b(we|the party|the group|everyone|everybody|all of us|whole party|the team|together)\b/i;

/** Roster names (+ aliases) from choice labels, excluding the special labels. */
function rosterLabels(question) {
  return Object.keys(question?.criteria ?? {}).filter((label) => !/^(someone-else|whole-party|unclear|none|nobody)$/i.test(label));
}

function nameRe(name) {
  return new RegExp(`(^|[^\\p{L}])${escapeRe(norm(name))}(?:'s)?(?=$|[^\\p{L}])`, "u");
}

/**
 * Who did it, from the focus text. The ember-road failure is a deed reported in someone else's
 * line ("she catch Tovin killing a goblin"), so a name right after a witness verb wins over the
 * speaker label; otherwise the first roster name that is the subject of the passage.
 */
export function guessDoer(text, roster, { goldDoer } = {}) {
  const t = norm(text);
  if (goldDoer && roster.includes(goldDoer)) return { label: goldDoer, confidence: 0.93, witness: null };
  for (const name of roster) {
    const witnessed = new RegExp(`${WITNESS_VERBS}\\s+${escapeRe(norm(name))}\\b`, "u");
    if (witnessed.test(t)) {
      const witness = roster.find((other) => other !== name && nameRe(other).test(t)) ?? null;
      return { label: name, confidence: 0.9, witness };
    }
  }
  const mentioned = roster
    .map((name) => ({ name, at: t.search(nameRe(name)) }))
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => a.at - b.at);
  if (!mentioned.length) return GROUP_RE.test(t) ? { label: "whole-party", confidence: 0.75, witness: null } : { label: "someone-else", confidence: 0.4, witness: null };
  if (mentioned.length === 1) return { label: mentioned[0].name, confidence: 0.88, witness: null };
  // Several names: the speaker label ("Luz: ...") is a reporter unless the line has no other name;
  // prefer the first name that is not a line-leading label.
  const labelMatch = /^\s*([\p{L}][\p{L}'.-]*)\s*:/u.exec(t);
  const speaker = labelMatch ? mentioned.find((m) => norm(m.name) === labelMatch[1]) : null;
  const pick = mentioned.find((m) => m !== speaker) ?? mentioned[0];
  return { label: pick.name, confidence: 0.66, witness: null };
}

export function guessOutcome(text) {
  const t = String(text ?? "");
  if (CRIT_FAIL_RE.test(t)) return { outcome: "criticalFailure", confidence: 0.86 };
  if (CRIT_SUCCESS_RE.test(t)) return { outcome: "criticalSuccess", confidence: 0.86 };
  if (FAIL_RE.test(t)) return { outcome: "failure", confidence: 0.88 };
  if (ACTION_RE.test(t)) return { outcome: "success", confidence: 0.8 };
  return { outcome: "unclear", confidence: 0.5 };
}

export function triageProbability(text, goldMatch = null) {
  if (goldMatch?.noEvents === true) return 0.04;
  if (goldMatch?.noEvents === false) return 0.93;
  const t = String(text ?? "");
  if (!t.trim()) return 0.02;
  const action = ACTION_RE.test(t);
  const noAction = NO_ACTION_RE.test(t);
  if (action && !noAction) return 0.9;
  if (action && noAction) return 0.55;
  if (noAction) return 0.06;
  return 0.3;
}

export function darkProbability(text, goldMatch = null) {
  if (goldMatch?.redWorthy === true) return 0.93;
  return DARK_RE.test(String(text ?? "")) ? 0.91 : 0.04;
}

function tokenSet(text) {
  return new Set(norm(text).match(/[\p{L}\p{N}]{4,}/gu) ?? []);
}

function overlapLevel(a, b, levels) {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const ratio = inter / Math.min(A.size, B.size);
  return Math.max(0, Math.min(levels - 1, Math.round(ratio * (levels - 1) * 2)));
}

// ---- corpus gold ---------------------------------------------------------------------------------

/**
 * Index of recognisable gold: party items map evidence snippets to their doer; ordinary items
 * contribute noEvents / redWorthy for their whole notes. Matching is by snippet containment (party)
 * or by a long verbatim slice of the notes (ordinary items), so unrelated text never matches.
 */
export function buildJevGoldIndex(corpus = []) {
  const snippets = [];
  const notes = [];
  for (const item of corpus) {
    if (!item || typeof item !== "object") continue;
    if (item.category === "party") {
      for (const [name, gold] of Object.entries(item.gold?.perActor ?? {})) {
        for (const snippet of gold.evidence ?? []) {
          snippets.push({ snippet: norm(snippet), doer: gold.whole ? "whole-party" : name, item, redWorthy: Boolean(gold.redWorthy) });
        }
      }
      for (const snippet of item.gold?.wholeParty?.evidence ?? []) snippets.push({ snippet: norm(snippet), doer: "whole-party", item, redWorthy: false });
    } else if (typeof item.notes === "string" && item.notes.length >= 24) {
      notes.push({ key: norm(item.notes).slice(0, 48), item });
    }
  }
  snippets.sort((a, b) => b.snippet.length - a.snippet.length);
  return { snippets, notes };
}

export function matchJevGold(index, text) {
  const t = norm(text);
  if (!t) return null;
  const snippet = index.snippets.find((entry) => entry.snippet.length >= 6 && t.includes(entry.snippet));
  if (snippet) return { doer: snippet.doer, redWorthy: snippet.redWorthy, noEvents: false, item: snippet.item };
  const whole = index.notes.find((entry) => t.includes(entry.key) || (t.length >= 24 && entry.key.startsWith(t.slice(0, 48))));
  if (whole) return { doer: null, redWorthy: Boolean(whole.item.gold?.redWorthy), noEvents: whole.item.gold?.noEvents === true ? true : false, item: whole.item };
  return null;
}

// ---- answers -------------------------------------------------------------------------------------

function round(p) {
  return Math.round(Math.max(0, Math.min(1, p)) * 1000) / 1000;
}

function choiceAnswer(labels, chosen, confidence) {
  const label = labels.includes(chosen) ? chosen : labels[0];
  const rest = labels.length > 1 ? (1 - confidence) / (labels.length - 1) : 0;
  const probabilities = Object.fromEntries(labels.map((l) => [l, round(l === label ? confidence : rest)]));
  return { type: "choice", choice: label, confidence: round(confidence), probabilities };
}

function scoreAnswer(levels, score, confidence) {
  const n = levels.length;
  const s = Math.max(0, Math.min(n - 1, score));
  const rest = n > 1 ? (1 - confidence) / (n - 1) : 0;
  const probabilities = Object.fromEntries(levels.map((_, i) => [String(i), round(i === s ? confidence : rest)]));
  return { type: "score", score: s, confidence: round(confidence), legend: levels[s], probabilities };
}

/** Answer one question deterministically. Exported for tests and for anyone probing intents. */
export function answerQuestion(question, state, { goldIndex = { snippets: [], notes: [] } } = {}) {
  const intent = questionIntent(question);
  const focus = focusOf(state, question.instructions);
  const gold = matchJevGold(goldIndex, focus);
  switch (intent) {
    case "triage":
      return { intent, answer: { type: "noul", noul: round(triageProbability(focus, gold)) } };
    case "witness": {
      const roster = [];
      // A witness question has no labels; the doer heuristic still needs names, so take every
      // capitalised word that looks like a name out of the focus.
      for (const m of String(focus).matchAll(/\b[A-Z][a-z]{2,}\b/g)) if (!roster.includes(m[0])) roster.push(m[0]);
      const doer = guessDoer(focus, roster, { goldDoer: gold?.doer && gold.doer !== "whole-party" ? gold.doer : undefined });
      const speaker = /^\s*([\p{L}][\p{L}'.-]*)\s*:/u.exec(String(focus))?.[1];
      const witnessOnly = doer.witness || (speaker && doer.label !== "someone-else" && doer.label !== "whole-party" && norm(speaker) !== norm(doer.label));
      return { intent, answer: { type: "noul", noul: witnessOnly ? 0.88 : 0.08 } };
    }
    case "dark":
      return { intent, answer: { type: "noul", noul: round(darkProbability(focus, gold)) } };
    case "actor": {
      const labels = Object.keys(question.criteria ?? {});
      const roster = rosterLabels(question);
      const goldDoer = gold?.doer ?? undefined;
      const doer = goldDoer === "whole-party" && labels.includes("whole-party")
        ? { label: "whole-party", confidence: 0.9 }
        : guessDoer(focus, roster, { goldDoer });
      return { intent, answer: choiceAnswer(labels, doer.label, doer.confidence) };
    }
    case "outcome": {
      const labels = Object.keys(question.criteria ?? {});
      const guess = guessOutcome(focus);
      return { intent, answer: choiceAnswer(labels, guess.outcome, guess.confidence) };
    }
    case "grounded":
    case "fit": {
      const levels = Array.isArray(question.criteria) ? question.criteria : ["0", "1"];
      const all = stateText(state);
      const level = overlapLevel(focus, all === focus ? focus : all, levels.length);
      return { intent, answer: scoreAnswer(levels, intent === "fit" ? Math.max(1, level) : level, 0.7) };
    }
    case "noul":
      return { intent, answer: { type: "noul", noul: 0.5 } };
    case "choice": {
      const labels = Object.keys(question.criteria ?? {});
      return { intent, answer: choiceAnswer(labels, labels[0], 0.5) };
    }
    case "score": {
      const levels = Array.isArray(question.criteria) ? question.criteria : ["0", "1"];
      return { intent, answer: scoreAnswer(levels, Math.floor((levels.length - 1) / 2), 0.5) };
    }
    default:
      return { intent, answer: null };
  }
}

// ---- request validation (a 400 is what the real API would do with a malformed question) ---------

export function validateSystemOneBody(body) {
  const errors = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return ["body must be a JSON object"];
  if (typeof body.model !== "string" || !body.model.trim()) errors.push("model must be a non-empty string");
  if (!("state" in body) || body.state === null || !["string", "object"].includes(typeof body.state)) errors.push("state must be a string, object or array");
  const questions = body.questions;
  if (!questions || typeof questions !== "object" || Array.isArray(questions) || !Object.keys(questions).length) {
    errors.push("questions must be a non-empty object keyed by name");
    return errors;
  }
  for (const [name, q] of Object.entries(questions)) {
    if (!q || typeof q !== "object") {
      errors.push(`${name}: question must be an object`);
      continue;
    }
    if (typeof q.instructions !== "string" || !q.instructions.trim()) errors.push(`${name}: instructions must be a non-empty string`);
    if (q.type === "noul") {
      if (q.criteria !== undefined && (typeof q.criteria !== "object" || Array.isArray(q.criteria) || Object.keys(q.criteria).some((k) => !["true", "false"].includes(k)))) errors.push(`${name}: noul criteria may only have true/false`);
    } else if (q.type === "choice") {
      if (!q.criteria || typeof q.criteria !== "object" || Array.isArray(q.criteria) || Object.keys(q.criteria).length < 2) errors.push(`${name}: choice criteria must map >= 2 labels`);
    } else if (q.type === "score") {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.some((c) => typeof c !== "string")) errors.push(`${name}: score criteria must be a list of >= 2 strings`);
    } else {
      errors.push(`${name}: unknown question type ${JSON.stringify(q.type)}`);
    }
  }
  return errors;
}

// ---- the fake fetch ------------------------------------------------------------------------------

function pickFault(rng, weights) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  if (!total) return null;
  let roll = rng.next() * total;
  for (const [kind, w] of entries) {
    roll -= w;
    if (roll <= 0) return kind;
  }
  return entries[entries.length - 1][0];
}

function headerOf(init, name) {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

/**
 * @param {object} [options]
 * @param {Array}  [options.corpus]        labeled items (party items' evidence names each deed's doer)
 * @param {number} [options.seed=1]
 * @param {number} [options.faultRate=0]  probability any one /v1/systemone call is faulted
 * @param {object} [options.faultWeights] relative weights per JEV_FAULT_KINDS entry (0 disables)
 * @param {string|Function} [options.forceFault]  a kind for every call, or (callIndex) => kind|null
 * @param {number} [options.retryAfterSeconds=0]  Retry-After on a 429 (seconds, as the header says)
 * @param {string} [options.apiKey]       when set, only this Bearer key is accepted (else any non-empty)
 * @param {number} [options.latencyMs=0]  simulated service time (reported, and awaited when > 0)
 * @param {number|null} [options.timeoutFallbackMs=null]  a timeout fault with no AbortSignal rejects
 *   after this long; null = never resolves (the honest behaviour of a hung server)
 * @returns {{ fetch: Function, calls: Array, stats: object, reset: Function }}
 */
export function createSimJev(options = {}) {
  const {
    corpus = [],
    seed = 1,
    faultRate = 0,
    faultWeights = DEFAULT_JEV_FAULT_WEIGHTS,
    forceFault = null,
    retryAfterSeconds = 0,
    apiKey = null,
    latencyMs = 0,
    timeoutFallbackMs = null,
    models = SIM_JEV_MODELS
  } = options;
  const goldIndex = buildJevGoldIndex(corpus);
  let rng = createRng(seed);
  const calls = [];
  const freshStats = () => ({ calls: 0, systemone: 0, models: 0, questions: 0, answered: 0, faults: {}, intents: {}, goldMatches: 0, badRequests: 0, unauthorized: 0 });
  const stats = freshStats();

  const respond = (status, body, headers = {}) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  async function simJevFetch(url, init = {}) {
    stats.calls += 1;
    const path = String(url);
    const method = String(init.method ?? "GET").toUpperCase();
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));

    const auth = String(headerOf(init, "authorization") ?? "");
    const bearer = /^Bearer\s+(\S.*)$/i.exec(auth)?.[1]?.trim() ?? "";
    const authorized = apiKey ? bearer === apiKey : Boolean(bearer);

    if (/\/v1\/models\/?(\?|$)/.test(path) && method === "GET") {
      stats.models += 1;
      calls.push({ path, method, fault: authorized ? null : "unauthorized", questions: [] });
      if (!authorized) {
        stats.unauthorized += 1;
        return respond(401, { error: { type: "authentication_error", message: "invalid api key" } });
      }
      return respond(200, { models: models.map((m) => ({ ...m })) });
    }
    if (!/\/v1\/systemone\/?(\?|$)/.test(path)) return respond(404, { error: { type: "not_found", message: `sim-jev: unknown path ${path}` } });
    if (method !== "POST") return respond(405, { error: { type: "method_not_allowed", message: "POST only" } });

    stats.systemone += 1;
    let body = null;
    let parseError = null;
    try {
      body = typeof init.body === "string" ? JSON.parse(init.body) : init.body ?? null;
    } catch (error) {
      parseError = error;
    }
    const bodyText = typeof init.body === "string" ? init.body : JSON.stringify(init.body ?? null);
    // Per-call determinism: depends on seed, call ordinal and content, so one extra call elsewhere
    // does not reshuffle every later answer's fault.
    const local = createRng((hashString(bodyText) ^ Math.imul(stats.systemone, 2654435761) ^ rng.int(1 << 30)) >>> 0);

    let fault = null;
    if (typeof forceFault === "function") fault = forceFault(stats.systemone - 1) ?? null;
    else if (forceFault) fault = forceFault;
    else if (faultRate > 0 && local.chance(faultRate)) fault = pickFault(local, faultWeights);
    if (fault) stats.faults[fault] = (stats.faults[fault] ?? 0) + 1;
    const questionNames = body?.questions && typeof body.questions === "object" ? Object.keys(body.questions) : [];
    const record = { path, method, fault, questions: questionNames, intents: [], stateChars: bodyText.length };
    calls.push(record);

    if (!authorized || fault === "unauthorized") {
      stats.unauthorized += 1;
      return respond(401, { error: { type: "authentication_error", message: "invalid api key" } });
    }
    if (fault === "http500") return respond(500, { error: { type: "server_error", message: "sim-jev: internal error" } });
    if (fault === "http503") return respond(503, { error: { type: "overloaded", message: "sim-jev: overloaded" } });
    if (fault === "http429") return respond(429, { error: { type: "rate_limited", message: "sim-jev: slow down" } }, { "retry-after": String(retryAfterSeconds) });
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
        } else if (Number.isFinite(timeoutFallbackMs) && timeoutFallbackMs >= 0) {
          setTimeout(() => reject(abortError()), timeoutFallbackMs);
        }
        // else: never settles, like a hung server with a caller that forgot its timeout.
      });
    }

    if (parseError) {
      stats.badRequests += 1;
      return respond(400, { error: { type: "invalid_request_error", message: `body is not JSON: ${parseError.message}` } });
    }
    const errors = validateSystemOneBody(body);
    if (errors.length) {
      stats.badRequests += 1;
      return respond(400, { error: { type: "invalid_request_error", message: errors.join("; ") } });
    }

    const answers = {};
    for (const [name, question] of Object.entries(body.questions)) {
      stats.questions += 1;
      const { intent, answer } = answerQuestion(question, body.state, { goldIndex });
      stats.intents[intent] = (stats.intents[intent] ?? 0) + 1;
      record.intents.push(intent);
      if (matchJevGold(goldIndex, focusOf(body.state, question.instructions))) stats.goldMatches += 1;
      if (answer) {
        answers[name] = answer;
        stats.answered += 1;
      }
    }
    const payload = {
      model: body.model,
      answers,
      usage: { input_tokens: Math.ceil(bodyText.length / 4), output_tokens: 12 * Object.keys(answers).length }
    };
    if (fault === "malformed") {
      const text = JSON.stringify(payload);
      return respond(200, text.slice(0, Math.max(1, Math.floor(text.length * (0.3 + local.next() * 0.5)))));
    }
    return respond(200, payload);
  }

  return {
    fetch: simJevFetch,
    calls,
    stats,
    reset() {
      rng = createRng(seed);
      calls.length = 0;
      Object.assign(stats, freshStats());
    }
  };
}
