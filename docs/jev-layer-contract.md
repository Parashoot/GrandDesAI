# Jev layer — shared contract (read before touching any Jev file)

Owner decision (2026-09-29): add TypeSafe's **Jev** model as an **optional** layer that makes play
faster and analysis cheaper. It never replaces the LLM (Jev does not generate text); it answers
small typed questions (yes/no probability, one-of-N choice, 0..N score) in well under a second, so
the gateway can skip work, route events to the right character, and double-check the judgments the
LLM gets wrong most often. Read `docs/ai-gateway-v2-contract.md` first; its invariants still win.

## Invariants

1. **Off unless configured.** No API key or `jev.enabled:false` -> the pipeline, the API and every
   existing test behave byte-for-byte as before. Nothing throws because Jev is missing.
2. **Jev can never cost the GM their notes.** Any Jev failure (network, CORS, 4xx/5xx, timeout,
   malformed body) is caught, recorded in `diagnostics.jev.errors`, and the pipeline carries on
   exactly as if Jev were off. A Jev failure never triggers the local-analyzer fallback.
3. **Jev only narrows or annotates.** It may skip a chunk it is confident holds no character
   action, choose who did an event, and override an LLM outcome / red flag only above
   `overrideConfidence`. Everything else it does is a *flag* the GM sees, not a silent change.
4. `scripts/ai/jev.js` stays pure ESM, zero Foundry globals, `fetch` injected (`fetchImpl`).
   No npm dependency: the module ships as plain browser ESM with no bundler, so we speak the HTTP
   API directly (it is one endpoint).
5. The key is a **client-scoped** setting (same as `aiApiKey`): it never goes into a world setting,
   an actor flag, a diagnostic, or a log line.

## The API we call (from `@typesafe-ai/sdk` v0.6.0 source; docs.typesafe.ai was unreachable)

```
POST {endpoint}/v1/systemone          endpoint default https://api.typesafe.ai
Authorization: Bearer <key>           Content-Type: application/json
{ "model": "jev-latest", "state": <string|object|array>, "questions": { name: Question } }
Question = { type:"noul",   instructions, criteria?: { true?: text, false?: text } }
         | { type:"choice", instructions, criteria: { label: description|null, ... } }   // map
         | { type:"score",  instructions, criteria: [ level0, level1, ... ] }             // >= 2, list
-> { model, answers: { name: Answer }, usage: { input_tokens, output_tokens } }
Answer   = { type:"noul", noul: p_yes }
         | { type:"choice", choice, confidence, probabilities: { label: p } }
         | { type:"score", score, confidence, legend, probabilities }
GET {endpoint}/v1/models -> { models: [{ name, description, release_date }] }     // used by ping
```
Retry 408/429/5xx (max 2, backoff 500 ms doubling, honour Retry-After up to 10 s); 401/403 are
fatal for the run (bad key: stop asking Jev for this run, record once). Questions over the same
state go in ONE request (they run in parallel server-side); question names are for code only, so
every instruction must be self-contained. Nested state may be referenced as `events[3].summary`.

## `scripts/ai/jev.js` (dev-gateway)

```js
export const JEV_DEFAULTS                         // mirrors GATEWAY_DEFAULTS.jev
export class JevError extends Error {}            // .status, .fatal (401/403), .kind: "network"|"cors"|"timeout"|"http"|"shape"
export function createJevClient({ apiKey, endpoint, model, timeoutMs, fetchImpl, sleep })
  // -> null when apiKey is empty
  // -> { ask({ state, questions }) -> Promise<{ answers, usage, ms }>, ping() -> { ok, ms, models?, error? },
  //      info: { endpoint, model } }            // never exposes the key
export async function triageChunks(client, chunks, { threshold })
  // one request, one noul per chunk: "does this passage describe something a player character
  // did, attempted, suffered or decided (not scenery, lore, rules talk or out-of-character chat)?"
  // -> { keep: boolean[], p: number[] }   keep[i] = p[i] >= threshold. Fail-open: on error keep all.
export async function attributeEvents(client, events, { roster, notes })
  // roster: [{ name, aliases? }]. Per event (batched <= 12 events per request):
  //   choice "who performed this action": one label per roster name + "someone-else" + "whole-party"
  //   noul  "was the character the notes quote as speaking/reporting only a witness, not the doer?"
  // -> [{ actorName|null, whole: bool, confidence, probabilities, witnessOnly: p }]
export async function verifyEvents(client, events, { allowRed })
  // Per event (batched <= 12): choice outcome over criticalSuccess|success|failure|criticalFailure|unclear;
  //   when allowRed: noul "is this a morally dark act (killing the helpless or surrendered, torture,
  //   betrayal, trading lives, desecration, raising the dead, taking trophies from the slain...)?"
  // -> [{ outcome, outcomeConfidence, darkP }]
export async function rankProposals(client, proposals, { events, actor })
  // Per proposal, score 0-3 "how directly is this ability grounded in the cited deeds" and
  // score 0-3 "how well does it fit this character's play so far". -> [{ grounded, fit, confidence }]
```
All four helpers throw `JevError`; the pipeline decides what failure means (fail open).

## Config — `gateway-config.js` (dev-gateway)

`GATEWAY_DEFAULTS.jev = { enabled: false, apiKey: "", endpoint: "https://api.typesafe.ai",
model: "jev-latest", timeoutMs: 10000, triage: true, attribution: true, verify: true, rank: true,
triageThreshold: 0.12, overrideConfidence: 0.85 }`. `normalizeGatewayConfig` clamps it (thresholds
0-1, timeout 1000-60000, unknown keys dropped, non-object -> defaults). `enabled` is forced false
when `apiKey` is empty.

## Pipeline integration — `pipeline.js` (dev-gateway)

`runGatewayPipeline({ ..., jev })` — `jev` is a client from `createJevClient` (or null). When
`cfg.jev.enabled && jev`:
1. **Triage** (before extraction, only when chunks >= 2): skipped chunks never reach the LLM.
   `diagnostics.jev.skippedChunks = [{ chunk, p, text: first 160 chars }]` so the GM can see it.
2. **Attribution** (after dedupe/merge, when `request.party` lists >= 2 names): sets
   `event.actorName` from Jev when confidence >= 0.6 and the LLM left it empty or named a witness;
   attaches `event.jev = { actorName, actorConfidence, whole, outcome, outcomeFrom?, flags }`. Fixes board 6ca3c8e7 (a deed reported in
   another player's line) by asking about the doer, not the speaker.
3. **Verify**: if Jev's outcome differs from the LLM's with confidence >= `overrideConfidence`,
   replace it and record `event.jev.outcomeFrom = <llm outcome>`; below that, add flag
   `"outcome-disputed"`. When `darkP >= overrideConfidence` and the event has no red signal, add
   `dangerGap`-independent flag `"dark-act"` and `themes += ["dark-deed"]` so stage 2's red check
   sees it (board 9f591a25). Flags live in `event.jev.flags: string[]`.
4. **Rank** (after stage 2): proposals sorted by `grounded + fit`, each gets `proposal.jev = {grounded, fit}`;
   `grounded < 1` adds flag `"weak-evidence"`. Never drops a proposal.
5. `diagnostics.jev = { enabled, ran: [step...], calls, ms, skippedChunks, routed, overrides, flags, errors }`.
   `event.jev.outcome` is Jev's own outcome reading whenever verify ran (so a disputed event can say what Jev read).
   `progression.js#normalizeGrowthEvent` persists a compact `jev` block; accepted proposals keep `proposal.jev`.

New pipeline export for party mode (below): `runProposalStageFor({ transport, request, events, config, validators, systemId, jev })`
— stage 2 alone for one character given already-extracted, already-attributed events; same
gating (`shouldPropose`), same repair/validate/gate, same result shape as the proposal half of
`runGatewayPipeline`.

`ai-gateway.js#createGatewayAdapter(config, { jevFactory = createJevClient })` builds the client
from `config.jev` and passes it through. The adapter also exposes `.jev` (client or null) and a
new `adapter.analyzeParty({ actors, notes, systemId })` (below).

## Party mode — on top of main's extraction cache (dev-integration + dev-gateway)

Re-scoped 2026-09-29 after origin/main landed `pipeline.js#createExtractionCache` (identical notes are
read once per adapter; `fresh: true` re-reads), a required LLM `actorName`/`actorRole` per event and a
per-event `redCheck`/`darkDeed`. What remains:
- `api.analyzePartyNotes(actors, notes, { fresh })` (dev-integration): a THIN one-click wrapper — GM
  check, dedupe, then main's `analyzeSessionNotes` per actor with bounded concurrency 2 and per-actor
  failure isolation (`{ actorId, name, error }`); the cache makes it one extraction. Returns
  `{ perActor, party: { ms, extractionCache: { hits, misses }, jev } }`. No new flags or roster.
- `session-notes.js#attributeEventsToActor`: a confident `event.jev.actorName`
  (`actorConfidence >= 0.6`) beats the LLM's name and the speaker heuristic; `event.jev.whole` keeps
  the event for everyone as "the party".
- `progression.js#normalizeGrowthEvent` persists a compact `jev` block; `_validateModelProposals`
  keeps `proposal.jev`; the Suggest-proposals adapter rebuild passes `jevFactory: () => adapter.jev`.
- Jev attribution in the pipeline is a SECOND OPINION on the LLM's `actorName`: it replaces it only
  under the witness guard (the LLM named the line's speaker and Jev says the speaker was a witness),
  otherwise adds the `actor-disputed` flag. Jev's dark-act answer is a second opinion on `darkDeed`:
  it never lowers severity; when Jev is confident and the LLM said `none`, add flag `dark-act` and
  theme `dark-deed` so stage 2's red check sees it.
- `adapter.analyzeParty` / `adapter.proposeFor` are no longer required; `runProposalStageFor` stays
  as the shared stage-2 helper if the gateway already has it (main's `presetEvents` path is the
  equivalent entry point).

## UI (dev-ui)

- Gateway settings app (`ai-provider-config.js`): a "Jev (TypeSafe) — optional speed-up" fieldset:
  enable, API key (password, client scope setting `jevApiKey`), endpoint, model, the four step
  toggles, thresholds under an "advanced" disclosure, and **Test Jev** (calls `ping`, shows ms and
  model list, or the error; a CORS failure says "your browser blocked the call: set Endpoint to a
  proxy that adds CORS headers"). Tuning goes into the existing client tuning JSON under `jev`.
- Growth dialog (`growth-ui.js`): an **Analyze party** action (pick PCs, one notes box) that calls
  `api.analyzePartyNotes`; per-event Jev chips: `outcome-disputed`, `dark-act`, attribution
  confidence < 0.8 ("who did this?"), and on proposals `weak-evidence`; a one-line summary
  "Jev: 3 chunks skipped, 14 events routed, 2 outcomes corrected, 612 ms".
- `lang/en.json` strings, `styles/*` chip styles.

## Harness (dev-harness)

- `tools/nlp-scale/sim-jev.js`: offline deterministic Jev (same wire format, `fetchImpl`) driven by
  corpus gold + keyword heuristics, with fault injection (`faultRate`: 5xx, timeout, bad JSON, 401).
- `run.mjs --jev` (real, needs `TYPESAFE_API_KEY`) and `--sim-jev`; report adds a Jev section:
  calls, ms p50/p95, chunks skipped (and how many of those held gold events = triage misses),
  attribution accuracy, outcome overrides right/wrong, red recall/false rate with and without Jev.
- Party corpus: `corpus/party-*.json` items `{ id, category:"party", notes, party:[names], gold:
  { perActor: { name: { minEvents, maxEvents, mustTags, outcome? } } } }` — at least 20, including
  the ember-road s1 lines (Luz reporting Tovin's kill; Wick's lost dice and dagger). Scores
  per-character credit. (Covers part of cloud packet C1, board c61ef1a8.)
- `playtest.mjs analyze --party` (one call for the party via `api.analyzePartyNotes`) and `--jev` /
  `--sim-jev`; `build-browser.mjs` bundles `jev.js`.
- Tests: `tests/ai-jev.test.mjs` (client wire format, retries, fatal 401, CORS-shaped TypeError,
  key never in diagnostics, each helper's request shape), `tests/ai-pipeline-jev.test.mjs` (triage
  skip, fail-open on every fault, attribution fixes the Luz/Tovin line, override threshold,
  disabled == identical output), `tests/api-party.test.mjs`.

## Change log
- 2026-09-29 orchestrator: contract created.
- 2026-09-29 (later) orchestrator: origin/main 4d1611a merged; Party mode section re-scoped onto main's extraction cache and LLM actorName/darkDeed (see above). Board items re-filed: 1656f47c gateway, 45499fb2 integration, 64e3c5ae ui, 9f76030d harness, 27346aba real-Jev QA. Owner will supply the key later, so every
  measurement in this change is offline (`--sim-jev`); the real-Jev numbers are an open item.
