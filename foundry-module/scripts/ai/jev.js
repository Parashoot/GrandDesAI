// TypeSafe "Jev" client + the four typed questions the gateway asks it (docs/jev-layer-contract.md).
//
// Jev does not write text; it answers small typed questions about a piece of state -- a yes/no
// probability ("noul"), a one-of-N choice, or a 0..N score -- in well under a second. The gateway
// uses it to skip chunks with no character action (triage), to decide WHO did an event in party
// notes (attribution), to double-check the outcome / dark-act judgments the LLM gets wrong most
// often (verify), and to order proposals by how well the notes back them (rank).
//
// Why hand-rolled HTTP instead of @typesafe-ai/sdk: the module ships as plain browser ESM with no
// bundler, and the SDK refuses to run in a browser without a flag anyway. The wire format below is
// read from the SDK v0.6.0 source (client.ts / retry.ts / types.ts): POST {endpoint}/v1/systemone
// with Bearer auth, GET {endpoint}/v1/models.
//
// The instructions and criteria strings in this file ARE the prompt. Question names are for code
// only (the model never sees them), so every instruction is self-contained and points at the item it
// is about with a state path ("events[3]").
//
// Pure ESM, zero Foundry globals, fetch injected, no Math.random. The API key lives only in the
// createJevClient closure: it is never a property, never in an error message, never in `info`.

import { GATEWAY_DEFAULTS } from "./gateway-config.js";

export const JEV_DEFAULTS = GATEWAY_DEFAULTS.jev;

// Largest number of items (chunks, events, proposals) described in one request. Every question for
// a batch goes in the same request (the server runs them in parallel over the same state), so this
// bounds both the state size and the question count (2 per event -> at most 24 questions).
export const JEV_BATCH_SIZE = 12;

const RETRY_STATUSES = new Set([408, 429]);
const MAX_RETRY_AFTER_MS = 10000;
const BACKOFF_INITIAL_MS = 500;

export class JevError extends Error {
  /**
   * @param {string} message never contains the API key (the client scrubs it)
   * @param {{ kind: "network"|"cors"|"timeout"|"http"|"shape", status?: number, fatal?: boolean }} info
   */
  constructor(message, { kind = "network", status, fatal = false } = {}) {
    super(message);
    this.name = "JevError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
    this.fatal = fatal === true;
  }
}

function nowMs() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Browsers report a CORS block and an unreachable host with the same bare TypeError ("Failed to
// fetch" in Chromium, "NetworkError when attempting to fetch resource." in Firefox, "Load failed" in
// Safari), so they cannot be told apart; Foundry runs in a browser and api.typesafe.ai may not send
// CORS headers for a Foundry origin, so the message names the likely fix. Node's undici says
// "fetch failed" for a plain network error.
const BROWSER_FETCH_FAILURE = /failed to fetch|networkerror when attempting|load failed/i;

function parseRetryAfter(headers) {
  const get = (name) => (typeof headers?.get === "function" ? headers.get(name) : null);
  const ms = get("retry-after-ms");
  if (ms !== null && ms !== undefined && Number.isFinite(Number(ms)) && Number(ms) >= 0) return Number(ms);
  const raw = get("retry-after");
  if (raw === null || raw === undefined) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * @returns {null | { ask, ping, info }} null when there is no API key (Jev is simply off).
 */
export function createJevClient({ apiKey, endpoint, model, timeoutMs, fetchImpl, sleep, maxRetries = 2 } = {}) {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) return null;
  const base = (typeof endpoint === "string" && endpoint.trim() ? endpoint.trim() : JEV_DEFAULTS.endpoint).replace(/\/+$/, "");
  const modelName = typeof model === "string" && model.trim() ? model.trim() : JEV_DEFAULTS.model;
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : JEV_DEFAULTS.timeoutMs;
  const doFetch = typeof fetchImpl === "function" ? fetchImpl : (url, init) => globalThis.fetch(url, init);
  const wait = typeof sleep === "function" ? sleep : realSleep;
  const retries = Number.isInteger(maxRetries) && maxRetries >= 0 ? maxRetries : 2;

  // Belt and braces: a proxy or server that echoes the Authorization header back in an error body
  // must not leak the key into diagnostics.
  const scrub = (text) => String(text ?? "").split(key).join("***");

  async function attempt(method, path, body) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller?.abort();
    }, timeout);
    const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    try {
      const response = await doFetch(`${base}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(controller ? { signal: controller.signal } : {})
      });
      // Read the body inside the timeout: a server that sends headers and then stalls is a timeout too.
      const text = typeof response?.text === "function" ? await response.text() : "";
      return { response, text };
    } catch (error) {
      if (timedOut) throw new JevError(`Jev did not answer within ${timeout} ms.`, { kind: "timeout" });
      const message = scrub(error?.message ?? error);
      if (error instanceof TypeError && BROWSER_FETCH_FAILURE.test(message)) {
        throw new JevError(
          `Your browser could not reach Jev at ${base} ("${message}"). Usually the browser blocked the call (CORS): set the Jev Endpoint to a proxy that adds CORS headers. It can also mean the network is down.`,
          { kind: "cors" }
        );
      }
      throw new JevError(`Could not reach Jev at ${base}: ${message}`, { kind: "network" });
    } finally {
      clearTimeout(timer);
    }
  }

  // 408/429/5xx are retried (max `retries`, 500 ms doubling, Retry-After honoured up to 10 s);
  // 401/403 are fatal for the run. Thrown transport errors (timeout, CORS, network) are NOT retried:
  // Jev is an optional speed-up, and three 10 s timeouts would make it the slowest part of a run.
  async function request(method, path, body) {
    for (let tries = 0; ; tries += 1) {
      const { response, text } = await attempt(method, path, body);
      const status = Number(response?.status) || 0;
      if (response?.ok || (status >= 200 && status < 300)) {
        try {
          return text ? JSON.parse(text) : undefined;
        } catch {
          throw new JevError(`Jev returned a body that is not JSON (${scrub(text.slice(0, 80))}).`, { kind: "shape", status });
        }
      }
      if (status === 401 || status === 403) {
        throw new JevError(`Jev rejected the API key (HTTP ${status}). Check the Jev key in the gateway settings; Jev is skipped for the rest of this run.`, { kind: "http", status, fatal: true });
      }
      const retryable = RETRY_STATUSES.has(status) || status >= 500;
      if (retryable && tries < retries) {
        const hinted = parseRetryAfter(response?.headers);
        const delay = hinted !== undefined ? Math.min(hinted, MAX_RETRY_AFTER_MS) : BACKOFF_INITIAL_MS * 2 ** tries;
        await wait(delay);
        continue;
      }
      let detail = "";
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error?.message ?? parsed?.message ?? parsed?.detail ?? "";
        if (typeof detail !== "string") detail = JSON.stringify(detail);
      } catch {
        detail = text;
      }
      detail = scrub(String(detail ?? "").slice(0, 200)).trim();
      throw new JevError(`Jev returned HTTP ${status}${detail ? `: ${detail}` : "."}`, { kind: "http", status });
    }
  }

  async function ask({ state, questions } = {}) {
    if (!isPlainObject(questions) || !Object.keys(questions).length) throw new JevError("Jev needs at least one question.", { kind: "shape" });
    for (const [name, q] of Object.entries(questions)) {
      if (q?.type === "score" && (!Array.isArray(q.criteria) || q.criteria.length < 2)) {
        throw new JevError(`Jev score question "${name}" needs a list of at least two criteria.`, { kind: "shape" });
      }
      if (q?.type === "choice" && !isPlainObject(q.criteria)) {
        throw new JevError(`Jev choice question "${name}" needs a map of labels.`, { kind: "shape" });
      }
    }
    const started = nowMs();
    const body = await request("POST", "/v1/systemone", { model: modelName, state, questions });
    const answers = body?.answers;
    if (!isPlainObject(answers)) throw new JevError("Jev's reply had no answers object.", { kind: "shape" });
    for (const [name, q] of Object.entries(questions)) {
      const a = answers[name];
      const ok = isPlainObject(a) && (
        q.type === "noul" ? Number.isFinite(a.noul)
          : q.type === "choice" ? typeof a.choice === "string"
            : Number.isFinite(a.score)
      );
      if (!ok) throw new JevError(`Jev's reply is missing a usable answer for "${name}".`, { kind: "shape" });
    }
    return { answers, usage: isPlainObject(body.usage) ? body.usage : {}, ms: Math.round(nowMs() - started) };
  }

  /** Never throws: the settings app's "Test Jev" button shows whatever comes back. */
  async function ping() {
    const started = nowMs();
    try {
      const body = await request("GET", "/v1/models");
      if (!Array.isArray(body?.models)) throw new JevError("Unexpected reply from GET /v1/models; expected { models: [...] }.", { kind: "shape" });
      const models = body.models.map((m) => (typeof m === "string" ? m : m?.name)).filter((n) => typeof n === "string");
      return { ok: true, ms: Math.round(nowMs() - started), models };
    } catch (error) {
      return { ok: false, ms: Math.round(nowMs() - started), error: scrub(error?.message ?? error), kind: error?.kind ?? "network", ...(error?.status ? { status: error.status } : {}) };
    }
  }

  return { ask, ping, info: Object.freeze({ endpoint: base, model: modelName }) };
}

// ---------------------------------------------------------------------------------------------
// Answer readers
// ---------------------------------------------------------------------------------------------

function clamp01(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function choiceOf(answer) {
  const probabilities = isPlainObject(answer?.probabilities) ? answer.probabilities : {};
  const confidence = Number.isFinite(answer?.confidence) ? clamp01(answer.confidence) : clamp01(probabilities[answer?.choice]);
  return { choice: answer?.choice, confidence, probabilities };
}

function batches(items, size = JEV_BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push({ offset: i, items: items.slice(i, i + size) });
  return out;
}

function text(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// ---------------------------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------------------------

/**
 * One noul per chunk: does it describe anything a player character did? Low thresholds keep it
 * conservative -- a skipped chunk never reaches the LLM, so a miss would lose a real event.
 * @returns {Promise<{ keep: boolean[], p: number[] }>} throws JevError (the pipeline keeps all).
 */
export async function triageChunks(client, chunks, { threshold = JEV_DEFAULTS.triageThreshold } = {}) {
  const list = Array.isArray(chunks) ? chunks.map((c) => String(c ?? "")) : [];
  const p = [];
  for (const batch of batches(list)) {
    const state = { passages: batch.items.map((chunk) => chunk.slice(0, 4000)) };
    const questions = {};
    batch.items.forEach((_, i) => {
      questions[`chunk_${i}`] = {
        type: "noul",
        instructions:
          `passages[${i}] is an excerpt from the notes of a tabletop role-playing game session (D&D or Pathfinder), written by a game master or a player, possibly in broken English, texting shorthand, bullet points or another language. `
          + `Does passages[${i}] describe at least one thing a player character did, attempted, suffered or decided during play -- a fight, a spell, a skill check, a conversation, crafting, trading, travelling, healing, stealing, a failure, an injury, even if mentioned only briefly? `
          + "Answer no only when the whole passage is scenery or setting description, lore or history, rumours, rules discussion, scheduling, a loot list, or out-of-character chat about the real players.",
        criteria: {
          true: "At least one character action, attempt, choice or hardship appears anywhere in the passage, even in passing.",
          false: "Nothing in the passage is something a character did, tried, suffered or decided: it is only scenery, lore, rules, scheduling or out-of-character talk."
        }
      };
    });
    const { answers } = await client.ask({ state, questions });
    batch.items.forEach((_, i) => p.push(clamp01(answers[`chunk_${i}`]?.noul)));
  }
  return { keep: p.map((value) => value >= threshold), p };
}

// ---------------------------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------------------------

// Same shape of speaker label as session-notes.js ("Luz: ..."), duplicated here because scripts/ai/*
// may not import Foundry-side modules. A label owns the following lines up to a blank line.
const SPEAKER_LABEL = /^\s*(?:[-*•]\s*)?(?:\*\*|__)?([\p{L}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}][\p{L}\p{M}'’.-]*){0,2})(?:\*\*|__)?\s*[:：]\s*(.*)$/u;
const NEUTRAL_LABELS = new Set([
  "note", "notes", "loot", "combat", "fight", "battle", "day", "night", "morning", "evening", "session", "recap",
  "summary", "later", "meanwhile", "downtime", "travel", "quest", "xp", "reward", "rewards", "npc", "npcs", "location",
  "scene", "todo", "next", "reminder", "also", "edit", "update", "ps", "tldr", "result", "results", "outcome", "status",
  "rules", "question", "treasure", "gold", "chapter", "part", "act", "tonight", "today", "yesterday", "highlights", "misc", "gm", "dm"
]);

function squash(value) {
  return String(value ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Same character? Full name first ("Tovin Ashgrave" = "tovin ashgrave"); a first-token match only
 * when one side is a single token ("Tovin" = "Tovin Ashgrave"), never "Tovin Ash" = "Tovin Reed".
 */
export function sameName(a, b) {
  const x = squash(a);
  const y = squash(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const xs = x.split(" ");
  const ys = y.split(" ");
  if (xs.length > 1 && ys.length > 1) return false;
  return xs[0] === ys[0];
}

/** [{ speaker|null, text }] -- one entry per labelled paragraph or unlabelled line. */
export function noteLines(notes) {
  const lines = [];
  let current = null;
  for (const line of String(notes ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    if (!line.trim()) { current = null; continue; }
    const match = SPEAKER_LABEL.exec(line);
    const label = match && !squash(match[1]).split(" ").some((w) => NEUTRAL_LABELS.has(w)) ? match[1].trim() : null;
    if (match && label) {
      current = { speaker: label, text: line.trim() };
      lines.push(current);
    } else if (current) {
      current.text += `\n${line.trim()}`;
    } else {
      lines.push({ speaker: null, text: line.trim() });
    }
  }
  return lines;
}

/** The notes line an event came from: the one containing its quote, else the best token overlap. */
export function findNoteLine(event, lines) {
  const quote = squash(String(event?.quote ?? "").split(" ... ")[0]);
  if (!lines.length) return null;
  if (quote.length >= 8) {
    const probe = quote.slice(0, 60);
    const hits = lines.filter((line) => squash(line.text).includes(probe));
    if (hits.length === 1) return hits[0];
  }
  const tokens = new Set((quote || squash(event?.summary)).split(" ").filter((t) => t.length >= 3));
  if (!tokens.size) return null;
  let best = null;
  let bestScore = 0;
  for (const line of lines) {
    const words = new Set(squash(line.text).split(" "));
    let hit = 0;
    for (const t of tokens) if (words.has(t)) hit += 1;
    const score = hit / tokens.size;
    if (score > bestScore) { best = line; bestScore = score; }
  }
  return bestScore >= 0.5 ? best : null;
}

function normalizeRoster(roster) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(roster) ? roster : []) {
    const name = text(typeof raw === "string" ? raw : raw?.name, 80);
    if (!name || seen.has(name.toLowerCase())) continue;
    if (["someone-else", "whole-party"].includes(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const aliases = Array.isArray(raw?.aliases) ? raw.aliases.map((a) => text(a, 80)).filter((a) => a && a.toLowerCase() !== name.toLowerCase()) : [];
    out.push({ name, aliases });
  }
  return out;
}

/**
 * Per event: WHO PERFORMED it (a roster name, someone-else, whole-party) and, when the event's notes
 * line has a speaker label, whether that speaker was only a witness. The failure this exists for
 * (board 6ca3c8e7): "Luz: ... she catch Tovin killing a goblin that was surrender" was credited to
 * Luz, the reporter. So the state carries the event's quote AND the whole notes line with its
 * speaker, and the question asks about the doer, never the speaker.
 * @returns {Promise<Array<{ actorName: string|null, whole: boolean, choice: string, confidence: number, probabilities: object, speaker: string|null, witnessOnly: number|null }>>}
 */
export async function attributeEvents(client, events, { roster, notes } = {}) {
  const people = normalizeRoster(roster);
  if (!people.length) throw new JevError("attributeEvents needs a roster of at least one name.", { kind: "shape" });
  const list = Array.isArray(events) ? events : [];
  const lines = noteLines(notes);
  const criteria = {};
  for (const person of people) {
    const aka = person.aliases.length ? ` (also called ${person.aliases.join(", ")})` : "";
    criteria[person.name] = `${person.name}${aka} personally performed the act -- it was their own deed, words or spell -- even when a different character is the one who wrote or reported the line.`;
  }
  criteria["someone-else"] = "The act was performed by someone who is not in the roster: a non-player character, a monster, an animal, or an unnamed stranger.";
  criteria["whole-party"] = "The whole group acted together (\"we\", \"the party\", \"everyone\"), not one character in particular.";
  const out = [];
  for (const batch of batches(list)) {
    const state = {
      roster: people.map((p) => (p.aliases.length ? { name: p.name, aliases: p.aliases } : { name: p.name })),
      events: batch.items.map((event) => {
        const line = findNoteLine(event, lines);
        return {
          summary: text(event?.summary, 300),
          quote: text(event?.quote, 400),
          noteLine: line ? { speaker: line.speaker, text: line.text.slice(0, 800) } : null
        };
      })
    };
    const questions = {};
    state.events.forEach((item, i) => {
      questions[`who_${i}`] = {
        type: "choice",
        instructions:
          `events[${i}] is one event taken from the notes of a tabletop role-playing game session. events[${i}].quote is the exact text it came from and events[${i}].summary paraphrases it. `
          + `events[${i}].noteLine is the whole line of the notes around it; noteLine.speaker is the player character who wrote or reported that line. `
          + "The speaker is NOT necessarily the one who acted: players often report what they saw another character do (a line written by one character saying they caught a second character killing a prisoner means the second character did the killing and the writer only watched). "
          + `Who PERFORMED the act in events[${i}] -- whose hands, words or spell did it? Choose a name from roster, "someone-else", or "whole-party". If the line names nobody else, the speaker is the doer.`,
        criteria
      };
      if (item.noteLine?.speaker) {
        questions[`witness_${i}`] = {
          type: "noul",
          instructions:
            `events[${i}].noteLine.speaker wrote or reported the notes line that events[${i}] comes from. `
            + `Was events[${i}].noteLine.speaker only a witness or reporter of the act in events[${i}].quote, with another character performing it?`,
          criteria: {
            true: "The speaker saw, heard, caught or tells about someone else doing it; the speaker did not do it.",
            false: "The speaker did it themselves, alone or together with others."
          }
        };
      }
    });
    const { answers } = await client.ask({ state, questions });
    state.events.forEach((item, i) => {
      const { choice, confidence, probabilities } = choiceOf(answers[`who_${i}`]);
      const isPerson = people.some((p) => p.name === choice);
      out.push({
        actorName: isPerson ? choice : null,
        whole: choice === "whole-party",
        choice: isPerson || choice === "whole-party" ? choice : "someone-else",
        confidence,
        probabilities,
        speaker: item.noteLine?.speaker ?? null,
        witnessOnly: questions[`witness_${i}`] ? clamp01(answers[`witness_${i}`]?.noul) : null
      });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------------------------

export const JEV_OUTCOMES = ["criticalSuccess", "success", "failure", "criticalFailure", "unclear"];

/**
 * Per event: the outcome over the four growth outcomes (+ "unclear"), and when allowRed a noul for a
 * morally dark act -- the two judgments the LLM misses most (a "crit" read as a plain success; a
 * mercy killing summarised into "dealt with the prisoner").
 * @returns {Promise<Array<{ outcome, outcomeConfidence, outcomeProbabilities, darkP: number|null }>>}
 */
export async function verifyEvents(client, events, { allowRed = true } = {}) {
  const list = Array.isArray(events) ? events : [];
  const out = [];
  for (const batch of batches(list)) {
    const state = {
      events: batch.items.map((event) => ({
        summary: text(event?.summary, 300),
        quote: text(event?.quote, 400),
        ...(event?.consequence ? { consequence: text(event.consequence, 240) } : {}),
        ...(event?.actorName ? { actor: text(event.actorName, 80) } : {})
      }))
    };
    const questions = {};
    state.events.forEach((_, i) => {
      questions[`outcome_${i}`] = {
        type: "choice",
        instructions:
          `events[${i}] is one thing a character did in a tabletop role-playing game session: events[${i}].quote is the original note text (any language, maybe shorthand or dice jargon) and events[${i}].summary paraphrases it. `
          + `Judging by the quote first, how did the attempt in events[${i}] turn out for the character who made it?`,
        criteria: {
          criticalSuccess: "An exceptional success: a natural 20, a crit or critical hit is stated, or the text stresses it went far better than anyone hoped.",
          success: "It worked or mostly worked, including partial or mixed results and plain statements that it was done.",
          failure: "It did not work, was lost or was abandoned, without disaster.",
          criticalFailure: "A disastrous failure: a natural 1, a fumble or botch is stated, or it backfired badly (serious injury, humiliation, lasting harm).",
          unclear: "The notes do not say or imply how it turned out."
        }
      };
      if (allowRed) {
        questions[`dark_${i}`] = {
          type: "noul",
          instructions:
            `Is events[${i}] a morally dark act by the character who did it: killing someone helpless or surrendered, torture, betraying an ally, trading other people's lives, desecrating the dead or a sacred place, raising the dead, taking trophies from the slain, or similar deliberate cruelty? `
            + "Ordinary combat against enemies who are fighting back, self-defence, and morally grey jobs like stealing, smuggling or spying are not dark acts.",
          criteria: {
            true: "The character deliberately did something cruel, treacherous or taboo.",
            false: "An ordinary action, fair fight, or grey-area job; nothing cruel or taboo."
          }
        };
      }
    });
    const { answers } = await client.ask({ state, questions });
    state.events.forEach((_, i) => {
      const { choice, confidence, probabilities } = choiceOf(answers[`outcome_${i}`]);
      out.push({
        outcome: JEV_OUTCOMES.includes(choice) ? choice : "unclear",
        outcomeConfidence: confidence,
        outcomeProbabilities: probabilities,
        darkP: allowRed ? clamp01(answers[`dark_${i}`]?.noul) : null
      });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Rank
// ---------------------------------------------------------------------------------------------

/**
 * Per proposal, two 0-3 scores: how directly the cited deeds ground it, and how well it fits this
 * character's play. Used to order proposals and flag weak evidence, never to drop one.
 * @returns {Promise<Array<{ grounded: number, fit: number, confidence: number }>>}
 */
export async function rankProposals(client, proposals, { events = [], actor = {} } = {}) {
  const list = Array.isArray(proposals) ? proposals : [];
  const characterName = text(actor?.name, 80);
  // A deed with no actorName was recorded on this character's own sheet: it is theirs, so Jev is
  // told so outright instead of being left to guess from a missing field.
  const deeds = (Array.isArray(events) ? events : []).slice(0, 40).map((event) => ({
    summary: text(event?.summary, 200),
    ...(event?.quote ? { quote: text(event.quote, 200) } : {}),
    actor: text(event?.actorName, 80) || characterName || "the character",
    outcome: event?.outcome
  }));
  const character = {
    name: characterName,
    ...(actor?.systemClass ? { class: typeof actor.systemClass === "string" ? text(actor.systemClass, 80) : actor.systemClass } : {}),
    ...(Number.isFinite(actor?.level) ? { level: actor.level } : {})
  };
  const out = [];
  for (const batch of batches(list)) {
    const state = {
      character,
      deeds,
      proposals: batch.items.map((p) => ({
        name: text(p?.entry?.name, 120),
        kind: p?.kind,
        itemKind: p?.entry?.gameItem?.kind,
        effect: text(p?.entry?.mechanics?.effect, 400),
        tags: p?.entry?.metadata?.tags ?? [],
        ...(p?.entry?.metadata?.themes?.length ? { themes: p.entry.metadata.themes } : {}),
        citedEvidence: (Array.isArray(p?.evidence) ? p.evidence : []).slice(0, 6).map((e) => text(String(e), 200))
      }))
    };
    const questions = {};
    state.proposals.forEach((_, i) => {
      questions[`grounded_${i}`] = {
        type: "score",
        instructions:
          `proposals[${i}] is a new ability suggested for character, earned from what happened in a tabletop role-playing game session; deeds lists what happened, each with its actor (the one who did it; a deed whose actor is character's own name is character's own deed). `
          + `How directly is proposals[${i}] grounded in deeds that character actually performed? Its citedEvidence is the suggester's claim; check it against deeds.`,
        criteria: [
          "Not grounded: no deed by this character shows the behaviour the ability rewards, or it rests on other characters' deeds.",
          "Loosely related: the character's deeds touch the same area, but the ability goes well beyond them.",
          "Grounded: at least one deed by this character clearly shows the behaviour this ability rewards.",
          "Directly grounded: several deeds by this character show exactly this behaviour."
        ]
      };
      questions[`fit_${i}`] = {
        type: "score",
        instructions:
          `How well does proposals[${i}] fit how character has been played so far, judging by their deeds, class and level -- would their player recognise it as theirs?`,
        criteria: [
          "Poor fit: at odds with how the character plays, or about someone else.",
          "Weak fit: plausible but generic; any character could have it.",
          "Good fit: matches the character's play style.",
          "Excellent fit: distinctly this character; it captures what they keep doing."
        ]
      };
    });
    const { answers } = await client.ask({ state, questions });
    state.proposals.forEach((_, i) => {
      const g = answers[`grounded_${i}`];
      const f = answers[`fit_${i}`];
      const round = (v) => Math.round(Math.min(3, Math.max(0, Number(v) || 0)) * 100) / 100;
      out.push({
        grounded: round(g?.score),
        fit: round(f?.score),
        confidence: Math.min(clamp01(g?.confidence ?? 1), clamp01(f?.confidence ?? 1))
      });
    });
  }
  return out;
}
