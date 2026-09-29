# AI pipeline review (cold read) — 2026-09-28

Scope: `foundry-module/scripts/ai/*` and `foundry-module/scripts/ai-gateway.js`, read cold for
correctness bugs. Every finding below was reproduced by calling the real (exported) function with a
concrete input and reading the actual output — no speculation. Proof for each lives in
`foundry-module/tests/review-ai-pipeline.test.mjs` as a `test.todo` whose body still executes its
assertions (Node's test runner reports TODO failures without failing the run), so `npm test` stays
green while the assertion documents the bug.

Areas read and found sound (not repeated below): `createExtractionCache`/`extractionCacheKey` (key
completeness, LRU/TTL, concurrency dedup via a shared in-flight promise, `cacheable` eviction — all
correct against their own design intent); `coerceEvent`/`normalize.js` per-event rejection paths
(every rejection is reported in `skippedEvents`, never silent); `transport.js`'s 400-downgrade and
429/5xx retry loops (all bounded); `json-repair.js`'s recursive-descent loops (each branch advances
`pos`, all bounded by `eof()`); `gateway-config.js` clamping (every numeric input finite-checked
before `Math.min/max`); the `presetEvents` ("Suggest proposals") path (filters to events with a
non-empty `summary`, skips stage 1 cleanly); pf2e/dnd5e parity in `ai-gateway.js` (every
system-specific string is parameterized through `getSystemAdapter(systemId)`, nothing hardcoded to
one system).

---

## 1. `differentActors()` false-negative on short common words merges different actors' events, misattributing tags and evidence

**File:** `foundry-module/scripts/ai/pipeline.js:927-933` (used by `mergeFollowUpEvents`, line 879-904)

```js
function differentActors(prev, event) {
  const a = String(prev.actorName ?? "").trim().toLowerCase();
  const b = String(event.actorName ?? "").trim().toLowerCase();
  if (!a || !b || a === b || b === "the party") return false;
  const named = `${prev.summary ?? ""} ${prev.quote ?? ""}`.toLowerCase();
  return !b.split(/\s+/).some((token) => token.length >= 3 && named.includes(token));
}
```

Unlike every other actor-name comparison in this codebase (`session-notes.js#significantTokens`,
which strips titles/articles via `NAME_STOPWORDS` and normalizes diacritics/punctuation via
`nameTokens`), this function tokenizes `event.actorName` with a bare `.split(/\s+/)` and accepts a
match against `prev`'s text on ANY token of length >= 3 — including titles ("sir", "lord", "lady")
and ordinary words that happen to already appear in the previous event's unrelated text.

**Concrete failing input** (proven in the test file, "differentActors" section):

```js
mergeFollowUpEvents([
  { summary: "Tovin the sir knight bowed to the king.", quote: "", tags: ["leadership"], themes: [], outcome: "success", actorName: "Tovin" },
  { summary: "Sir Aldric stole the crown jewels.", quote: "", tags: ["thievery"], themes: [], outcome: "success", actorName: "Sir Aldric", continuesPrevious: true }
]);
```

**Observed:** the two events merge into one. `differentActors` returns `false` because "sir" (from
`event.actorName = "Sir Aldric"`, length 3) is present in `prev`'s text ("...the **sir** knight...")
for an unrelated reason. The merged event keeps `actorName: "Tovin"`, gains the `"thievery"` tag, and
Sir Aldric's entire action ("stole the crown jewels") is demoted to unattributed prose in
`consequence`. Aldric's event — and his credit for it — no longer exists anywhere in the output.

**Expected:** two different named actors' events must never merge regardless of what words their
names happen to share with unrelated prior text; `differentActors` should return `true` here exactly
as the "Maren"/"Wick"/etc. cases already covered by `party-attribution.test.mjs` expect for the
`attributeEventsToActor` codepath. The same stopword-filtered, punctuation/diacritic-normalized
tokenization already used elsewhere (`significantTokens`) should be used here too.

**Severity: high.** This is a silent cross-character misattribution of GM notes, not just a lost
event — the wrong actor gains evidence (tags/themes) for something they never did, which can steer a
Skill/Class proposal at a wronged or wrongly-credited character. Reachable any time an actor's name
or nickname contains a title word ("Sir", "Lord", "Lady", "Captain", "Brother"...) or any ordinary
3+ letter word that also appears incidentally in the previous event's summary/quote.

---

## 2. `dedupeEvents()` has no actor awareness at all — two different actors' events with a similar generic summary silently collapse into one, losing the second actor's event

**File:** `foundry-module/scripts/ai/pipeline.js:838-855`, keyed by
`foundry-module/scripts/ai/normalize.js:853-859` (`eventDedupeKey`)

```js
function dedupeEvents(events) {
  const seen = new Map();
  const out = [];
  for (const event of events) {
    const key = eventDedupeKey(event);          // summary words + outcome — actorName is NOT part of the key
    const existing = seen.get(key);
    if (existing) {
      for (const tag of event.tags) if (!existing.tags.includes(tag)) existing.tags.push(tag);
      for (const theme of event.themes ?? []) if (!existing.themes.includes(theme)) existing.themes.push(theme);
      if (!existing.dangerGap && event.dangerGap) existing.dangerGap = event.dangerGap;
      continue;                                   // event is dropped; existing.actorName is never touched
    }
    ...
```

`eventDedupeKey` (`normalize.js:853-859`) is built purely from the slugified `summary` and `outcome`
— it never reads `actorName`. `dedupeEvents` runs unconditionally on the whole batch of events
returned from stage 1 (across chunks and repair attempts), with no equivalent of the
`differentActors` guard that `mergeFollowUpEvents` at least attempts (see finding 1).

**Concrete failing input** (proven in the test file, "dedupeEvents" section): a single mock model
reply returning two events for two different party members whose summaries are generic and
identically phrased (plausible whenever the model doesn't repeat the actor's name inside the
sentence, since the schema carries `actorName` as its own field):

```js
const ev = (actorName) => ({ quote: "picked a lock", summary: "Picked a lock.", tags: ["thievery"], themes: [], outcome: "success", dangerGap: "none", actorName });
transport: chat() resolves { events: [ev("Tovin"), ev("Maren")] }
```

**Observed:** `runGatewayPipeline(...)` returns exactly **one** event, `actorName: "Tovin"`. Maren's
"Picked a lock." event — her only evidence line in this batch — is gone; nothing in
`skippedEvents`/`diagnostics` mentions it was ever there.

**Expected:** events belonging to two different named actors must never be treated as duplicates of
each other; `eventDedupeKey` should incorporate `actorName` (or `dedupeEvents` should special-case
differing actor names the way `mergeFollowUpEvents`/`differentActors` at least tries to), and the
class-invariant this file states at the top ("the GM's notes are never lost... a half-good AI answer
is still far better than the keyword dictionary") should hold for this merge path too.

**Severity: high.** Same failure class as finding 1 (silent loss of one PC's evidence to another's
sheet) but via a different, unguarded code path that runs on every extraction regardless of
`continuesPrevious`/merge settings — `cfg.mergeFollowUps: false` does not protect against it, since
`dedupeEvents` is not gated by that flag at all.

---

## 3. Proposal repair-turn schema still requires `redCheck`, contradicting the repair message's stated `{"proposals":[...]}` shape

**File:** `foundry-module/scripts/ai/pipeline.js:1202-1222` (`validateProposals`'s repair branch),
schema built at `foundry-module/scripts/ai/schemas.js:167-176` (`proposalSchemaCapped`), repair text
from `foundry-module/scripts/ai/prompts.js:375-385` (`buildRepairMessage`)

When one or more proposals fail `validateSkillEntry`/`validateClassEntry` after `repairProposal`,
`validateProposals` sends ONE repair turn:

```js
conversation.messages.push(buildRepairMessage({
  stage: "propose", errors,
  expectedShape: "{\"proposals\":[...]} containing ONLY the corrected versions of the listed proposals"
}));                                                                        // pipeline.js:1205
...
const response = await transport.chat({
  messages: conversation.messages,
  schema: proposalSchemaCapped(cfg.maxProposals, { redCheck: cfg.allowRed }),  // pipeline.js:1210
  ...
});
```

`buildRepairMessage` (`prompts.js:375-385`) tells the model, in plain language, to reply with exactly
`{"proposals":[...]}` and "Fix every listed field; keep proposals that were already valid unchanged"
— it never mentions `redCheck`. But when `cfg.allowRed` is true (the default —
`gateway-config.js: allowRed: true`), `proposalSchemaCapped(..., { redCheck: true })` sets
`required: ["redCheck", "proposals"]` (`schemas.js:172-173`), the exact same requirement as the
*original* propose call that asks for a full per-event vice verdict "one entry per newEvent, in
order" (`prompts.js:282`). A structured-output-constrained model (Ollama `format`, OpenAI
`json_schema`) is therefore forced to reproduce a full `redCheck` array it was never asked for and
has no fresh event list to key it to, inside a repair turn whose purpose and token budget
(`maxTokens: cfg.numPredict`, unchanged) were sized for "just the fixed proposals."

**Observed vs expected (proven in the test file, "redCheck repair mismatch" section):** running the
existing "proposal the validator still rejects" scenario (a reaction proposal missing `trigger`,
`config: { proposalMode: "always" }`, default `allowRed: true`) and inspecting the repair-turn call
(`transport.calls[2]`) shows `schema.required` still contains `"redCheck"` even though
`transport.calls[2].messages.at(-1).content` (the just-appended repair instruction) says nothing
about it and promises `{"proposals":[...]}` only.

**Severity: medium.** Functionally the extra `redCheck` output is parsed and silently discarded
(`validateProposals` never reads it back), so this is not itself an observed data-loss bug today —
but it is exactly the "schema vs. repair turn" drift the review was asked to check for: it wastes
part of the fixed `numPredict` budget the repair turn has to work with reproducing an unrequested
field, which raises the odds of the repair reply itself being truncated (and thus the proposal fix
being lost) on a small/local model precisely when a repair is already needed. It is also a
maintenance trap: the code silently relies on the model ignoring the contradiction rather than the
message and schema agreeing.

---

## Summary

| # | Severity | Location |
|---|----------|----------|
| 1 | high | `foundry-module/scripts/ai/pipeline.js:927-933` (`differentActors`) |
| 2 | high | `foundry-module/scripts/ai/pipeline.js:838-855` + `foundry-module/scripts/ai/normalize.js:853-859` (`dedupeEvents`/`eventDedupeKey`) |
| 3 | medium | `foundry-module/scripts/ai/pipeline.js:1202-1222` + `foundry-module/scripts/ai/schemas.js:167-176` + `foundry-module/scripts/ai/prompts.js:375-385` (repair-turn schema vs. message) |
