# AI Gateway v2 — Shared Contract (read before touching any gateway file)

Goal (user, 2026-09-23): the AI gateway is *the* point of the tool. It must almost never fall back to
the local keyword dictionary, must understand anyone's writing (non-native English, typos, texting
shorthand, bullet lists, dice/table jargon, other languages, code-switching), must be deeply
customizable, fun and easy to use, and must let *unanticipated* activities (beekeeping, gambling,
running an inn, cartography...) grow into new Skills/Classes instead of being discarded because they
are not in our 38-tag taxonomy.

Module root: `foundry-module/`. Tests: `node --test tests/*.test.mjs` (plain Node 22, no Foundry).
Everything under `scripts/ai/` must be **pure ESM with zero Foundry globals** (no `game`, `ui`,
`Hooks`, `foundry`, `FormApplication`) so it runs in Node tests, in the Foundry browser, and in the
scale harness. `fetch` / `AbortController` are allowed (injected where practical).

Live facts (measured 2026-09-23 on the user's machine): Ollama 0.34.3 at `http://127.0.0.1:11434`,
supports `format: <JSON Schema>` structured outputs on `/api/chat`. Installed models:
`qwen3:30b-a3b` (MoE, ~90 tok/s — fastest, has thinking; send `think:false`), `qwen3.8:27b`,
`mistral-small3.1:24b` (~20 tok/s, current default), `qwen2.5:14b` (~29 tok/s),
`nomic-embed-text` (embeddings, 768-d). Default model is decided by the scale test, not guessed.

## File ownership (do not edit files you don't own; ask the orchestrator via your final report)

| Owner | Files |
|---|---|
| **Agent G1 — gateway core** | `scripts/ai/json-repair.js`, `scripts/ai/normalize.js`, `scripts/ai/schemas.js`, `scripts/ai/prompts.js`, `scripts/ai/transport.js`, `scripts/ai/pipeline.js`, `scripts/ai/gateway-config.js`, `scripts/ai/index.js`, `scripts/ai-gateway.js` |
| **Agent G2 — integration, customization, UX, local fallback** | `scripts/api.js` (analyzeSessionNotes + proposal validation + new emergent-theme API only), `scripts/progression.js` (themes on events + emergent proposals), `scripts/session-notes.js`, `scripts/growth-taxonomy.js`, `scripts/ai-provider-config.js`, `scripts/growth-ui.js`, `scripts/main.js`, `scripts/emergent-themes.js` (new), `scripts/emergent-themes-settings.js` (new), `styles/grand-design.css`, `lang/en.json` |
| **Agent T — testing** | everything under `tests/` (new files; may fix existing tests only if a contract change requires it), `tools/nlp-scale/**` (new), `package.json` `scripts` entries |

Shared, append-only by anyone: this contract's "Change log" section at the bottom.

## Public interfaces

### `scripts/ai/json-repair.js` (G1)
```js
export class ModelJsonError extends Error {}        // .raw holds the original text
export function parseModelJson(text)                // -> { value, repairs: string[] }
```
Must salvage: markdown code fences, `<think>…</think>` blocks, prose before/after the JSON, trailing
commas, single-quoted strings/keys, unquoted keys, smart quotes, `//` comments, `NaN/undefined`,
Python `True/False/None`, a top-level array where an object was expected (returned as-is), and
**truncated output** (unterminated string / missing closing brackets — close them, drop the dangling
partial element). `repairs` names every fix applied (e.g. `"stripped-code-fence"`,
`"closed-truncated-json"`). Throws `ModelJsonError` only when nothing JSON-like exists.

### `scripts/ai/normalize.js` (G1)
```js
export const CANONICAL_TAGS                              // string[] — mirrors GROWTH_TAXONOMY tag names
export const TAG_SYNONYMS                                 // { rawSlug: canonicalTag } large table (≥250 entries, multilingual where cheap)
export function slugifyTheme(raw)                        // "Bee-keeping!" -> "beekeeping"; ≤ 32 chars, [a-z0-9-]
export function resolveTag(raw, { customSynonyms = {} } = {})
    // -> { tag: "martial", via: "exact"|"case"|"synonym"|"custom-synonym"|"stem"|"fuzzy" }
    //  | { theme: "beekeeping", via: "emergent" }        // unknown -> emergent theme, never silently dropped
export function coerceOutcome(raw)                       // -> "criticalSuccess"|"success"|"failure"|"criticalFailure"|null
    // accepts: enum values any case/spacing, "crit", "critical", "nat 20", "nat20", "natural 20",
    // "nat 1", "crit fail", "fumble", "succeeded", "win", "partial"/"mixed" (-> success), "botched",
    // "fail", numbers 0-1 or 1-20, and common non-English words (éxito, fallo, επιτυχία, αποτυχία, ...)
export function coerceDangerGap(raw)                     // -> "moderate"|"severe"|undefined (accepts "high", "extreme", "none", booleans...)
export function coerceEvent(rawEvent, opts)              // -> { event, coercions: string[] } | { rejected: reason }
    // event shape out: { summary, tags:[canonical, ≥0], themes:[slug], outcome, dangerGap?, quote?, actor?, language? }
    // An event with zero canonical tags but ≥1 theme is KEPT (tags: ["emergent"] is NOT used — see below).
```

### Event shape (shared by G1, G2, T)
A growth event may now carry, in addition to the existing `summary/tags/outcome/dangerGap/id/occurredAt`:
- `themes: string[]` — emergent theme slugs (free vocabulary, slugified). Optional.
- `quote: string` — the original source fragment from the notes (any language), ≤ 400 chars. Optional.
- `language: string` — BCP-47-ish code the note fragment was written in (`"en"`, `"es"`, `"el"`...). Optional.
- `actorName: string` — who did it, if the notes name someone. Optional.
- `source: "adapter"|"local"`. Optional.

**Validation change (G2 owns `progression.js#validateGrowthEvent`)**: an event is valid if it has
≥1 canonical tag **or** ≥1 theme. `tags` may be `[]` when `themes` is non-empty. Canonical tag
evidence math is unchanged; themes accumulate their own evidence (below).

### Emergent themes (G2)
`scripts/emergent-themes.js` (pure):
```js
export const EMERGENT_THEME_EVIDENCE_THRESHOLD = 3       // same scale as MINIMUM_EVIDENCE
export function themeEvidence(events)                    // -> Map(slug -> weighted evidence) using GROWTH_EVENT_OUTCOME_WEIGHTS
export function generateEmergentProposals(events, registry, { themeMap = {}, threshold } = {})
    // a theme with weighted evidence ≥ threshold and no approved skill for it yields a pending
    // proposal { id:`proposal:emergent-${slug}`, kind:"skill", status:"pending", source:"emergent",
    // needsAuthoring:true, theme: slug, evidence:[ids], entry:{ valid placeholder skill entry } }
export function applyThemeMap(events, themeMap)          // GM mapping: { slug: { mapTo?: canonicalTag, mergeInto?: slug, label?: string, ignored?: bool } }
```
World setting `emergentThemes` (JSON) holds the GM's theme map + seen counts; a settings menu lets the
GM rename, merge, map-to-tag, or ignore themes.

### `scripts/ai/transport.js` (G1)
```js
export function createTransport({ provider, endpoint, model, apiKey, timeoutMs, fetchImpl = globalThis.fetch, ollamaOptions })
  // -> { chat({ messages, schema?, temperature?, maxTokens? }) -> Promise<{ content: string, raw, ms }>,
  //      listModels() -> Promise<string[]>, ping() -> Promise<{ ok, ms, model, error? }> }
```
- `provider: "ollama"` → POST `/api/chat` with `{ model, messages, stream:false, think:false, format: schema ?? "json", options:{ num_ctx, num_predict, temperature } }`.
- `"openaiCompatible" | "hosted"` → `/v1/chat/completions` with `response_format:{type:"json_schema", json_schema:{name, schema, strict:false}}`; on HTTP 400 mentioning response_format, retry once with `{type:"json_object"}` and remember the downgrade.
- Timeout via AbortController → throws `AiProviderTimeoutError`. Transport failure → `AiProviderUnreachableError` (keep the existing helpful message; move/re-export it so `ai-gateway.js` still exports it). 5xx / 429 → retried with backoff inside `chat` (max 2).

### `scripts/ai/gateway-config.js` (G1) — the customization surface
```js
export const GATEWAY_DEFAULTS
export function normalizeGatewayConfig(partial)   // never throws; clamps/ignores bad values; returns full config
```
Keys (all optional in `partial`):
`provider, endpoint, model, apiKey, temperature (0-1.5, default 0.2), numCtx (default 16384), numPredict (default 3072), timeoutMs (default 180000), maxRepairAttempts (default 2), pipeline ("two-stage"|"single", default "two-stage"), chunkChars (default 2400), proposalMode ("when-earned"|"always"|"never", default "when-earned"), maxProposals (default 3), creativity ("grounded"|"balanced"|"wild", default "balanced"), allowRed (default true), emergentThemes (default true), outputLanguage ("en" default — summaries in this language; quotes keep the original), namingStyle (free text, default ""), houseRules (free text ≤ 4000 chars, default ""), customSynonyms ({raw: tag}), toneHints (free text), extractionExamples (array of {notes, events} GM-supplied few-shots, ≤ 5)`.

### `scripts/ai/pipeline.js` (G1)
```js
export async function runGatewayPipeline({ transport, request, config })
  // request = buildAiGatewayRequest(...) output (actor context, allowedTags, requirements…)
  // -> { events, proposals, themes, skippedEvents, skippedProposals, diagnostics }
```
Stages:
1. **Preprocess**: normalize newlines/bullets/emoji, keep original text; split into chunks ≤ `chunkChars` on paragraph/sentence boundaries.
2. **Extract** (per chunk): small, focused prompt + JSON Schema (`schemas.js#EVENT_EXTRACTION_SCHEMA`). Model is told notes may be in any language / broken English / shorthand; it must understand intent, write `summary` in `outputLanguage`, keep `quote` verbatim, map to canonical tags when one fits AND add `themes` for anything specific/novel. Parse with `parseModelJson`, coerce with `coerceEvent`. If the parse fails or coercion rejects >50% of events, send a **repair turn** (append assistant output + user message listing the exact errors) up to `maxRepairAttempts`.
3. **Propose** (per `proposalMode`): second prompt with the extracted events, actor registry, allowances, the existing schema/requirements/exampleByKind, house rules, naming style, creativity. JSON Schema-constrained. Each proposal goes through `repairProposal()` (fill obvious defaults: missing `duration` → "instant"/"while active", frequency {1,"day"}, `roll.formula` from actor modifier, tier clamped 1-3, tags resolved via `resolveTag` with unknown ones moved to `metadata.themes`), then the real validator; still-invalid proposals get one repair turn with validator errors; still-invalid after that → `skippedProposals` (never throws for the batch).
4. Return merged result + `diagnostics = { model, provider, pipeline, chunks, stages:[{stage, chunk, attempts, ms, repairs, errors}], coercions:[...], totalMs }`.

Only a **total** failure (transport dead on every attempt, or zero parseable output after all repairs)
throws — that is the only path where `api.js` falls back to the local analyzer.

### `scripts/ai-gateway.js` (G1) — backward compatible
Keep exports `createAiGatewayAdapter`, `createChatCompletionsAdapter`, `buildAiGatewayRequest`,
`AiProviderUnreachableError`. `createChatCompletionsAdapter(opts)` now builds a transport + runs
`runGatewayPipeline`, returning `{ events, proposals, themes, skippedProposals, gatewayDiagnostics }`
(still satisfies `validateAdapterEvents`). New: `createGatewayAdapter(config)` taking a full gateway
config. The adapter function signature stays `async ({ actor, notes, systemId? }) => output`.

### `api.js#analyzeSessionNotes` (G2)
- Accepts the richer adapter output; surfaces `gatewayDiagnostics`, `themes`, `adapterSkippedProposals` on the result.
- Proposals: tolerant per-proposal (invalid ones → `adapterSkippedProposals`, not a thrown batch error). **This intentionally reverses** the old fail-loud rule because the pipeline now repairs first; update the pinned test in `api.test.mjs` accordingly and say so in the change log.
- Proposal tags: canonical only in `metadata.tags`; unknown tags are moved to `metadata.themes` instead of throwing.
- Records emergent-theme evidence and merges `generateEmergentProposals` output into proposals.
- New API: `getEmergentThemes()`, `setEmergentThemeMapping(slug, mapping)`, `testAiConnection()`, `reanalyzeLastNotes(actor)`, `getLastAnalysis(actor)`.

### Scale harness (T) — `tools/nlp-scale/`
- `corpus/*.json`: labeled items `{ id, category, lang, notes, gold: { mustTags:[], okTags:[], outcome?, dangerGap?, themesAny?:[], minEvents?, maxEvents?, noEvents?:bool } }`. ≥ 300 items across: fluent, non-native English (several L1 patterns), heavy typos/phonetic, texting/shorthand, bullet/fragment lists, dice & table jargon, other languages (es, pt, el, de, fr, tl, it, ja-romaji...), code-switching, long multi-scene recaps, novel/unanticipated activities, negation/intent/question traps, scenery traps, red-polarity-worthy, counter-leveling.
- `run.mjs` (Node CLI) and `browser-runner.js` (same logic, callable in a page): runs `runGatewayPipeline` with a real transport, `--reps N`, `--concurrency`, `--model`, `--filter category`, `--limit`. Metrics: fallback rate (target ≈0), first-try schema-valid rate, post-repair valid rate, tag recall/precision/F1 vs gold, outcome accuracy, dangerGap accuracy, theme discovery on novel items, **consistency** across reps (mean pairwise Jaccard of tag sets, outcome modal agreement, event-count variance), latency p50/p95, per-category breakdown. Writes `reports/<timestamp>-<model>.json` + `.md`.
- `sim-model.js`: offline simulated model with fault injection (truncation, fences, prose, wrong keys, hallucinated tags, synonym tags, missing fields, bad enums, 5xx, timeouts) so the full pipeline is exercised **thousands** of times deterministically in `npm test`.

## Conventions
- Comments explain *why* (house style: see existing files). Keep the "never lose the GM's notes" invariant.
- No `Math.random` in pure logic unless seeded; no `Date.now` in pure logic except ids/timings.
- Both game systems by default (see project-policies). Nothing in `scripts/ai/` is system-specific.

## Change log
- 2026-09-23 orchestrator: contract created.
- 2026-09-23 G1 (gateway core) implemented `scripts/ai/*` + `ai-gateway.js`. Deviations / additions:
  - `coerceEvent` output uses `actorName` (the shared event shape), not `actor`. Events may also carry `outcomeInferred: true` (outcome was missing and inferred from the text) and the pipeline adds `source: "adapter"`.
  - `resolveTag` tag results may carry `alsoTheme` (e.g. `"cooking"` → `{tag:"craft", via:"synonym", alsoTheme:"cooking"}`) so distinctive activities count toward a canonical tag AND an emergent theme. Returns `null` (not a theme) for noise words ("none", "other", "nat20", "tpk", ...).
  - Fuzzy matching is stricter than "≤2 for ≥5 chars": ≤1 edit for 5-7 letters, ≤2 for 8+, first letter must match (or be a swapped pair), second letter must match at distance 2. Without this "gambling"→acrobatics (via "tumbling") and "poetry"→craft (via "pottery").
  - `slugifyTheme` joins a short first word onto compound suffixes only (keeping/keeper/working/picking/crafting/smithing/making/cracking/binding/weaving/smith/craft/work): "Bee-keeping!"/"bee keeping" → "beekeeping", "lock picking" → "lockpicking", but "animal handling" → "animal-handling". Greek/Cyrillic are transliterated.
  - Adapter/pipeline `themes` output shape: `[{ slug, weight, count }]` sorted by weight (this batch only).
  - `buildAiGatewayRequest` gained `growthHistory: { eventCount, tagEvidence, themeEvidence }` (weighted, from the actor's `growthEvents` flag; reads `event.themes` if G2 persists them) for "when-earned". Its `exampleByKind` weapon/class examples now use canonical tags only (were `tool/melee`, `food/flood-support`) plus `metadata.themes:["cooking"]` on the class example. Output keys unchanged.
  - Stage-2 proposals are `{ kind, entry, evidence, theme?, repairs? }`; `entry.metadata.tags` is canonical-only and unknown tags are in `entry.metadata.themes`. Pipeline pre-validates with validator.js and gates: class proposals when `classEvolutionAvailable` is false, names already in the registry, and > `maxProposals` go to `skippedProposals` with a `reason`.
  - `createChatCompletionsAdapter` (legacy) now defaults to `pipeline:"single"` (one call per chunk, like before); `createGatewayAdapter(config)` defaults to `"two-stage"`. G2: switch `ai-provider-config.js` to `createGatewayAdapter`. The adapter function also exposes `.ping()`, `.listModels()`, `.transport`, `.config` (apiKey redacted) for "Test connection".
  - Extra config keys accepted: `maxRetries` (0-5, default 2) and pass-through hooks `fetchImpl`, `getHeaders`, `sleep`, `extraBody`, `systemId`.
  - Transport: Ollama endpoints given as `/v1/...` are rewritten to native `/api/chat` (the /v1 shim ignores num_ctx). On a 400 the openai path also downgrades `max_tokens`→`max_completion_tokens` and drops explicitly "unsupported parameter"s; the ollama path downgrades schema→`"json"` and drops `think` if the server complains. New error classes `AiProviderTimeoutError`, `AiProviderHttpError` (message still "AI provider returned HTTP <n>."), `AiProviderResponseError`.
  - Truncated extraction output on a chunk ≥600 chars is re-extracted in halves instead of a repair turn (a repair would hit the same output limit).
  - Fatal (throws immediately, no other chunks tried): unreachable provider, HTTP 400/401/403/404/405/413/422. Any other per-chunk failure is recorded and the batch continues; only all-chunks-failed throws.
  - Existing assertions that must change (T): `tests/ai-gateway.test.mjs` — the two `assert.deepEqual(result, { events: [], proposals: [] })` checks (result now also has `themes`, `skippedEvents`, `skippedProposals`, `gatewayDiagnostics`; compare `result.events`/`result.proposals`), and `assert.equal(body.response_format.type, "json_object")` → `"json_schema"` (downgrades to json_object only after a 400).
- 2026-09-23 G2: integration landed. (1) **Intentional reversal**: `api.js#analyzeSessionNotes` model proposals are tolerant per proposal -- invalid ones go to `result.adapterSkippedProposals` (`{proposal, errors}`), never a thrown batch error. Pinned tests updated: `ai-adapter-adversarial.test.mjs` ("a proposal with a fundamentally wrong shape is skipped and reported"; "an event whose ONLY tag is unknown becomes an emergent-theme event") and `api.test.mjs` ({kind, skillEntry} -> skip-and-report; replacement staged because the file was write-locked, see G2 report). (2) Unknown event/proposal tags go through `normalize.js#resolveTag` (synonym -> canonical tag, else theme) via `emergent-themes.js#splitTagsAndThemes`; with world setting `emergentThemes:false` unknown event tags are dropped as before. (3) Events: `validateGrowthEvent` accepts ≥1 tag OR ≥1 theme; `normalizeGrowthEvent` keeps `themes/quote(≤400)/language/actorName/source`. (4) New api: `setGatewayConfigProvider(fn)`, `getGatewayConfig()`, `setEmergentThemeStore({get,set})`, `getEmergentThemes()`, `setEmergentThemeMapping(slug, mapping|null)`, `testAiConnection({config?, adapter?, actor?, sampleNotes?})`, `getLastAnalysis(actor)`, `reanalyzeLastNotes(actor, {replace=true})` (replaces the previous run's events/progress/pending AI proposals), `requestProposalAuthoring(actor, proposalId)` (uses `adapter.authorProposal` if G1 ever adds it; today it calls the adapter with a synthetic "GM REQUEST" note and reads only proposals). Actor flag `lastAnalysis` = `{notes, at, source, eventIds, proposalIds, diagnostics}`. (5) Settings: client `aiProvider/aiEndpoint/aiModel/aiApiKey` (kept from v1) + `aiGatewayClient` (JSON tuning); world `aiGatewayWorld` (JSON flavor) + `emergentThemes` (JSON theme state). Default Ollama model constant `ai-provider-config.js#DEFAULT_OLLAMA_MODEL = "qwen3:30b-a3b"` (note: `GATEWAY_DEFAULTS.model` in gateway-config.js still says mistral-small3.1:24b; the preset overrides it).
- 2026-09-24 phase-1 bake-off (52-item stratified sample, 1 rep, `tools/nlp-scale/reports/2026-09-24T03-*`): qwen2.5:14b 92.0% / p50 3.3s, qwen3.8:27b 89.8% / 1.9s, qwen3:30b-a3b 86.7% / 0.76s (traps 50%), mistral-small3.1:24b 81.4% / 5.1s (count 61.5%). Shared weakness: consequences split into extra events ("got stung twice", "visions", "the crit on the last hit") and scene-level duplicates. Prompt tuning in `prompts.js` (results folded into their action, habitual/cause-clause actions count, stricter OOC list, criticalSuccess only for explicit crits, romanized jargon, a 5th few-shot, sharper survival/water/defense/thievery/leadership meanings): qwen3.8:27b → **95.2%** (recall 100%, traps 100%, outcome 100%), qwen2.5:14b → 91.6%. **Default model is now `qwen3.8:27b`** in BOTH `GATEWAY_DEFAULTS.model` and `DEFAULT_OLLAMA_MODEL`. Full-corpus ×3 and `--proposal-mode always` runs queued next.
- 2026-09-24 live Foundry check (headless Playwright via `npm run test:live-ai`, real Ollama, qwen3.8:27b): **PASS on both worlds** (EndexDND 5E / dnd5e 5.3.3 and Endex / pf2e 8.4.1, Foundry 14.367) -- 8/8 assertions, all six gameItem kinds produced, one proposal approved into a real Item each. Two fixes were needed: (1) the campaign's six single-tag beats never reach the "when-earned" evidence threshold, so `ai-test-scenario.js` now runs stage 2 with `proposalMode:"always"` for its duration and restores the GM's adapter (`api.getProposalAdapter()` added); (2) even in "always" mode the model answered `{"proposals":[]}` because the prompt told it to -- `buildProposalMessages({ mustPropose })` (set by the pipeline for `proposalMode:"always"` or a pending grant allowance) now asks for at least one proposal. Also: dnd5e proposals were written in Pathfinder terms ("Strike", "circumstance bonus", "resistance 2") because `exampleByKind` is PF2e-flavoured; each system adapter now exports `RULES_VOCABULARY`, surfaced as `requirements.rulesVocabulary` and quoted in the stage-2 prompt. Verified 5e output now uses advantage / reaction / DC / conditions.
- 2026-09-24 full corpus, qwen3.8:27b, 322 × 3 reps, tuned prompt (`reports/2026-09-24T03-23-34-751Z-qwen3.8_27b.md`): score 96.1%, fallback 0.0%, first-try valid 100%, recall 99.4%, precision 95.4%, outcome 99.6%, traps 100%, count 90.9%, tag Jaccard 0.92, outcome agreement 0.99, event-count stdev 0.05, p50 1.9 s / p95 5.9 s per item. All targets met. Weakest: count on novel-activities (69.7%) and red-polarity (70%) -- a payoff clause ("didn't lose a single guest") still becomes a second event; a further few-shot was added afterwards.
- 2026-09-24 (evening) extraction over-splitting. The same 40 corpus items were over-split in every rep (a stated payoff or elaboration emitted as its own event: "ran the inn all week" + "didn't lose a single guest"). Tried and measured on those 40 × 3: a payoff few-shot (no change), a dedicated `consequence` field alone (31/120 correct counts vs 32 baseline), and a deterministic merge on shared theme plus compatible actor (rejected: it also folded separate actions of one activity, "moved the hives" then "harvested honey", which unit tests caught). Adopted: the event schema gains `consequence` (string) and required `continuesPrevious` (boolean, right after `quote`); `pipeline.js#mergeFollowUpEvents` folds flagged events into the previous one (tags/themes unioned, payoff kept in `consequence`, quotes joined) unless the follow-up names a new occasion (again, next, weekday...). 87/120 on the hard set; full corpus count accuracy 90.9% → 96.2% with no category regressing. New config `mergeFollowUps` (default true, world setting). `normalizeGrowthEvent` keeps `consequence`; the Growth dialog shows it after the summary. Note: "result" stays an alias of `outcome` in coercion, which is why the field is not called that.
- 2026-09-24 (evening) stage 2. (1) `request.actor.systemClass` from new adapter method `getCharacterClass` (pf2e `actor.class`, dnd5e `actor.classes` with multiclass levels); the naming rule now forbids the personal name and the bare class name and asks for a coined one-word motif. (2) "always"/grant-allowance runs waive the emergent-theme ">= 3 evidence" rule, which had made the model answer `{"proposals":[]}` for single-event novel activities. (3) The proposal schema is sent capped (`schemas.js#proposalSchemaCapped`, `maxItems = maxProposals`) because the model then looped out 15+ near-duplicates. (4) `newEvents` carry the verbatim `quote` and `consequence`; summaries had sanitized the cues red polarity needs. (5) A per-proposal "red check" listing every vice from `vice-taxonomy.js` (only when allowRed). Result on 86 items: proposals for 86/86 (was 64), red on red-worthy 70% (was 37.5%), red false positives 1.3% (new harness metric `redFalseRate`).
- 2026-09-27 attribution, shared extraction, red check (board 6ca3c8e7, c284b5ec, a48d97c0, 72dbac48). (1) `EVENT_ITEM_SCHEMA.actorName` is required and second (after `quote`): on main qwen3.8 left it empty on every event of the 89-item A/B slice. `normalize.js#coerceActorName` maps pronouns/placeholders to "" and every group spelling to "the party". (2) The extraction prompt no longer names the analysed character, gains a WHO DID IT section (a deed reported by another player belongs to the doer; never soften a deed), and a 6th few-shot (group-chat recap). (3) `createExtractionCache` (per adapter, LRU 20, TTL 30 min, `extractionCacheEntries`/`extractionCacheTtlMs`, `fresh: true` bypass, failed or partial readings never cached): ember-road s1 5 PCs 62 s total, 2-9 s after the first. (4) Follow-up folding skips a different character's own deed but still folds a result on "the party" or on someone the previous event names. (5) Stage 2 gets only `attributeEventsToActor(events, [actor.name])`, and with `allowRed` its schema requires `redCheck: [{event, vice: none|<vice>}]` before `proposals`; `diagnostics.redCheck` plus a warning when a flagged deed got no red proposal. Numbers (qwen3.8:27b, 1 rep): red slice with proposals always, redAcc 0.70 -> 0.90; 89-item extraction slice main vs branch, score 95.9% -> 95.2%, count 89.9% -> 87.6%, recall/outcome 100% both. ember-road s1 (proposal-mode always): Tovin "Hexblade: The Quiet End" red/cruelty citing the kill; every PC cites only its own events. Today's p50 is ~7 s per item on main as well (09-24: 1.9 s), which is an environment change, not this change.
- 2026-09-28 (ember-road s2/s3). (1) `api.requestGrowthProposals` passes `events` and the adapter/pipeline accept `presetEvents` (stage 1 skipped): stage 1 had read the "GM REQUEST" wrapper as out-of-character and returned 0 events (Maren 0 -> 3 proposals). (2) `mergeFollowUpEvents`: a quote/summary containing "then" is a new occasion and never folds (s2 lost Maren's Thorn Lash that way); few-shots for comma-listed spells with a result only on the last, and implied-verb downtime ("bread w/ Oren was amazing": baking present 8/13 -> 9/9 reps). 112-item slice (novel, long-multiscene, bullets, traps), 1 rep: score 96.4%, precision 97.1%, count 90.2%, traps 100%, fallback 0%. (3) New `api.rejectProposal` (status "rejected", reason, hook); rejected names are skipped by the gateway merge, Suggest proposals and templates. s3 on main: every approved Skill used in play credited to its owner.
- 2026-09-28 (salt-lantern, first PF2e playtest; dev-proposals + C5 review). Stage 2 now sees owned entries' effects and the actor's class features/proficiencies (`actor.ownedFeatures`); deterministic gates skip duplicates of owned Skills by mechanic (`duplicates-owned`), of base-class features (`duplicates-class-feature`, e.g. Rogue + Sleight of Hand: caught 3/4 live runs) and wrong-system terms; wrong terms with an exact PF2e equivalent are REWRITTEN (Craft->Crafting, staggered->slowed 1, "X for 1 round"->until the end of your next turn), and a bare class-name motif is re-coined from the theme instead of skipped (skipping had emptied Buck's whole Suggest: 0 -> 3). Pending AI proposals are capped per actor (`pendingProposalCapMin` 5 / `pendingProposalCapExtra` 2). C5 fixes: `eventDedupeKey` includes the actor (two PCs' identical "Picked a lock." no longer collapse), `differentActors` matches whole name tokens minus titles. 88-item slice (bullets, texting, traps, long-multiscene), 1 rep: score 98.7%, count 97.7%, precision 97.5%, traps 100%, fallback 0%.
