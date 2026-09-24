# Grand Design AI — working notes for Claude Code

Foundry VTT module (Wandering Inn–style "Grand Design" progression) for **PF2e and dnd5e**. Module
source: `foundry-module/`. Live install: `%LOCALAPPDATA%\FoundryVTT\Data\modules\grand-design-ai\`
(Foundry v14, worlds "Endex" = PF2e, "EndexDND 5E" = dnd5e; GM user "Gamemaster", no password).

## Rules
- Every feature targets **both** systems unless the user names one. Verify on both.
- Never lose the GM's notes: any AI failure falls back to the local analyzer with a stated reason.
- Comments explain *why*. Keep `scripts/ai/*` free of Foundry globals (it also runs in Node and the harness).
- Some old files are Windows read-only-ish: if a write fails with EPERM, delete and recreate the file.

## Commands (run from `foundry-module/`)
```powershell
npm test                                    # 604 unit tests, ~30 s, no network
node tools/nlp-scale/job-runner.mjs         # job queue for real-model scale runs (see below)
node tools/nlp-scale/run.mjs --model qwen3:30b-a3b --reps 3            # full corpus vs local Ollama
node tools/nlp-scale/run.mjs --model qwen3:30b-a3b --filter traps,non-english --reps 5
node tools/nlp-scale/run.mjs --sim --fault-rate 0.3                    # offline, simulated model
node tools/nlp-scale/build-browser.mjs --check                         # one-file browser bundle
powershell -ExecutionPolicy Bypass -File ..\tools\deploy-foundry-module.ps1   # deploy to Foundry
```
Reports land in `tools/nlp-scale/reports/<timestamp>-<model>.{json,md}`; the `.md` lists the worst 15
items with the model's real output.

## AI gateway v2 (2026-09-23) — where things are
Contract + change log: `docs/ai-gateway-v2-contract.md` (read it first).
- `scripts/ai/transport.js` — Ollama native `/api/chat` with JSON-Schema `format`, OpenAI-compatible
  `json_schema` with automatic downgrade, timeouts, 429/5xx retry.
- `scripts/ai/pipeline.js` — preprocess → chunk → stage 1 extraction (small prompt, multilingual,
  shorthand, few-shots) → coercion → repair turns → stage 2 proposals (repairProposal + validator +
  repair turn) → per-item skip. Transient network/timeout errors retry the chunk (`transientRetries`).
  Only total failure throws.
- `scripts/ai/json-repair.js`, `normalize.js` (1,900+ tag synonyms, fuzzy, multilingual outcomes),
  `schemas.js`, `prompts.js`, `gateway-config.js` (every tunable, clamped).
- Emergent themes: events carry free `themes` (beekeeping, innkeeping…); `scripts/emergent-themes.js`
  turns repeated themes into new Skill proposals; GM curates them in the "Emergent Themes" settings menu.
- UI: `scripts/ai-provider-config.js` (Gateway settings app), `scripts/growth-ui.js` (Growth dialog).
- Harness: `tools/nlp-scale/` — 322-item labeled corpus (13 categories, 14 languages), scoring,
  consistency metrics, simulated fault-injecting model.

## Status (2026-09-24) and open work
Default model is **`qwen3.8:27b`** (set in both `GATEWAY_DEFAULTS.model` and `DEFAULT_OLLAMA_MODEL`), chosen by
the phase-1 bake-off and confirmed on the full corpus (322 items × 3 reps, tuned prompt): score 96.1%,
fallback 0%, traps 100%, tag recall 99.4%, tag Jaccard 0.92, outcome agreement 0.99, p50 1.9 s/item.
Reports: `tools/nlp-scale/reports/2026-09-24T03-23-34-751Z-qwen3.8_27b.md` (worst-15 section shows the
residual pattern: a consequence clause split into a second event, mostly on novel-activities / red items).
Live Foundry check (`npm run test:live-ai`, headless Playwright, real Ollama) **passes on both worlds**;
switching the active world is done from `/setup` by clicking the world card's `[data-action="worldLaunch"]`
link after `game.shutDown()` (no admin password on this install).

1. **Stage-1 count precision.** Event-count accuracy is 90.9% overall but ~70% on novel-activities and
   red items: the model still splits "ran the inn all week / didn't lose a guest" into two events. Iterate
   on the few-shots in `scripts/ai/prompts.js`, re-run `--filter novel-activities,red-polarity-worthy --reps 3`.
2. **Stage-2 proposal quality at scale.** `--proposal-mode always` now really forces a proposal
   (`mustPropose`); read the latest `reports/*` run tagged `stage2-proposal-quality` for validator skips and
   naming quality. dnd5e wording is steered by `RULES_VOCABULARY` in `scripts/systems/dnd5e-adapter.js`.
3. Optional: the job runner (`node tools/nlp-scale/job-runner.mjs`) is not required -- Bash can reach
   Ollama directly -- but is handy for chaining runs; leave a `STOP` file in `queue/` to end it.
