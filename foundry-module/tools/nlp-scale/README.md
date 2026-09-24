# nlp-scale — AI gateway scale & consistency harness

Measures how well the Grand Design AI gateway (`scripts/ai/*`) reads real session notes — broken
English, typos, texting shorthand, bullet lists, dice jargon, other languages, code-switching,
long recaps, unanticipated activities, and traps — against a **real model**, and how consistent it
is across repeated runs. The same code also runs offline against a simulated model (`sim-model.js`)
inside `npm test`.

| File | What it is |
|---|---|
| `corpus/*.json` | 322 labeled items, 13 categories, 14 language tags |
| `lib.mjs` | Environment-agnostic core: run items, score vs gold, aggregate, render markdown |
| `run.mjs` | Node CLI (Windows/macOS/Linux) |
| `sim-model.js` | Deterministic fake `fetch` (Ollama + OpenAI shapes) with fault injection |
| `browser-entry.mjs` / `build-browser.mjs` | One-file browser bundle `dist/nlp-scale.browser.js` → `window.NlpScale` |

## Running from a Windows terminal (PowerShell)

Node 18+ (22 recommended). No `npm install` needed. From the module folder:

```powershell
cd C:\Users\parez\code\GrandDesAI\foundry-module

# quick smoke test, 20 items, one rep
node tools/nlp-scale/run.mjs --provider ollama --endpoint http://127.0.0.1:11434 --model qwen3:30b-a3b --limit 20

# the full run used to pick a default model (322 items x 3 reps; hours on a single GPU)
node tools/nlp-scale/run.mjs --model qwen3:30b-a3b --reps 3 --concurrency 1 --out reports/

# only some categories / languages / items
node tools/nlp-scale/run.mjs --model qwen2.5:14b --filter traps,novel-activities --reps 3
node tools/nlp-scale/run.mjs --model qwen2.5:14b --lang es,el,tl
node tools/nlp-scale/run.mjs --model qwen2.5:14b --ids fl-001,nv-003,tr-005

# other knobs: --pipeline single|two-stage  --proposal-mode never|when-earned|always
#              --temperature 0.2 --num-ctx 16384 --num-predict 3072 --timeout-ms 180000
#              --system pf2e|dnd5e  --config my-gateway-config.json (houseRules, customSynonyms, ...)

# offline self-test with the simulated model and 30% injected faults (no Ollama needed)
node tools/nlp-scale/run.mjs --sim --fault-rate 0.3 --reps 2
```

(`npm run test:nlp-scale -- --model ...` does the same once the package.json script is added.)

Every run writes `reports/<timestamp>-<model>.json` (every item, every rep, full outputs) and a
`.md` report (summary, per-category and per-language tables, and the **worst 15 items with the
model's actual output** for eyeballing). A partial report is saved every 10 items, so an
interrupted run still leaves numbers. Use `--concurrency 1` for one local GPU — parallel requests
just queue inside Ollama and inflate latency.

## Running in the browser (the Ollama-origin tab)

```powershell
node tools/nlp-scale/build-browser.mjs --check   # writes dist/nlp-scale.browser.js and self-tests it under Node
```

Open `http://localhost:11434/` in a tab (Ollama answers "Ollama is running"), then inject the
contents of `dist/nlp-scale.browser.js` (paste into the DevTools console, or evaluate it through an
automation tool). Because the page origin **is** Ollama, the harness calls relative `/api/chat` —
no `OLLAMA_ORIGINS`/CORS setup. Then:

```js
NlpScale.startScale({ model: "qwen3:30b-a3b", reps: 3 })   // fire and forget
NlpScale.brief()                                            // poll: status, done/total, headline numbers
NlpScale.lastRun                                            // full live state (partial while running)
NlpScale.renderMarkdown(NlpScale.lastRun)                   // the same report run.mjs writes
NlpScale.exportJson()                                       // the full JSON report as a string
NlpScale.abort()                                            // stop after the in-flight item
await NlpScale.runScale({ model: "qwen2.5:14b", filter: "traps" }, console.log)  // awaitable form
NlpScale.runScale({ sim: { faultRate: 0.3 }, limit: 30 })    // offline self-test inside the page
```

Options: `model, endpoint ("" = same origin), provider, apiKey, reps, concurrency, filter, lang,
ids, limit, offset, systemId, timeoutMs, config: {...gateway config...}, sim: {faultRate, seed}`.

## Metrics

| Metric | Meaning |
|---|---|
| **fallback** | Share of runs where the pipeline threw — the GM would have been sent to the local keyword analyzer. Target ≈ 0. |
| **1st-try valid** | Share of pipeline stages (extract/propose per chunk) that needed no repair turn and logged no errors. |
| repair turns/call, JSON repairs/call | How hard the repair machinery worked (json-repair fixes like `stripped-code-fence`, and extra model turns). |
| **recall** | Share of gold `mustTags` groups present on some event. A group `"a\|b"` is satisfied by either tag. |
| **precision** | Share of predicted tags that are in `mustTags ∪ okTags` (okTags are deliberately generous). |
| F1 | Harmonic mean of the two. |
| **outcome** | The dominant event outcome is one of the gold alternatives (`"success\|criticalSuccess"`). |
| **dangerGap** | Some event carries an allowed gap; gold `"none"` means *no* event may carry one (control items). |
| **themes** | On novel activities: any predicted theme (event themes, result themes, proposal `metadata.themes`) matches `themesAny` by slug, substring or shared stem. |
| **traps** | `noEvents` items (intentions, questions, negated attempts, scenery, OOC talk, rules questions) returned zero events. |
| count | Event count within `[minEvents, maxEvents]`. |
| score | Mean of every check that applies to the item (0 on a total failure). |
| **tag Jaccard** | Consistency: mean pairwise Jaccard of each rep's union tag set (needs `--reps` ≥ 2). |
| outcome agree | Share of reps agreeing with the modal dominant outcome. |
| event-count stdev | Spread of event counts across reps. |
| p50 / p95 | Wall time per pipeline run, and per model call (from diagnostics). |

## Corpus format

```json
{ "id": "nv-001", "category": "novel-activities", "lang": "en", "notes": "...",
  "gold": { "mustTags": ["craft|support"], "okTags": ["nature"], "outcome": "success",
            "dangerGap": "severe|moderate", "themesAny": ["beekeeping", "apiculture"],
            "minEvents": 1, "maxEvents": 2, "noEvents": false, "forbidTags": ["fire"], "redWorthy": true } }
```

Tags must be canonical (`scripts/growth-taxonomy.js`); `tests/nlp-harness.test.mjs` enforces that
plus the category minimums. Non-native items carry `l1` (the writer's first language).
