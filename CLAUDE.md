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
npm test                                    # 617 unit tests, ~30 s, no network
node tools/nlp-scale/job-runner.mjs         # job queue for real-model scale runs (see below)
node tools/nlp-scale/run.mjs --model qwen3:30b-a3b --reps 3            # full corpus vs local Ollama
node tools/nlp-scale/run.mjs --model qwen3:30b-a3b --filter traps,non-english --reps 5
node tools/nlp-scale/run.mjs --sim --fault-rate 0.3                    # offline, simulated model
node tools/nlp-scale/build-browser.mjs --check                         # one-file browser bundle
powershell -ExecutionPolicy Bypass -File ..\tools\deploy-foundry-module.ps1   # deploy to Foundry
node tools/playtest/playtest.mjs status --campaign <name>                # playtest campaigns (see skill)
node ../tools/board.mjs                     # the shared board (docs/board.json)
node ../tools/vault-export.mjs              # docs/spec/board/playtests -> Obsidian vault
```
Project management, the dev team and DM playtests: the `grand-design-pm` skill (`.claude/skills/grand-design-pm/`).
The Obsidian vault copy lives in `~/vault/MandoAI/Grand Design AI/` (generated `Context/`, owner's `Notes/`);
rerun the export after any docs, board or playtest change.
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

## Status (2026-09-24, evening) and open work
Default model **`qwen3.8:27b`** (both `GATEWAY_DEFAULTS.model` and `DEFAULT_OLLAMA_MODEL`).
Full corpus, extraction only (322 x 3, `--proposal-mode never`), `reports/2026-09-24T22-31-09-168Z-qwen3.8_27b.md`:
score 97.6%, fallback 0%, traps 100%, tag recall 99.5%, event-count 96.2% (novel 88.6%, red 73.3%),
tag Jaccard 0.92, outcome agreement 0.99, ~0.9 s/item.
Stage 2, `--proposal-mode always` on novel/long/red/counter-leveling (86 items),
`reports/2026-09-24T22-49-34-327Z-qwen3.8_27b.md`: every item got a proposal, 4 validator skips of 120,
red on red-worthy items 70%, red false positives 1.3%, no names built from the personal name.
Live Foundry check (`npm run test:live-ai`) passed 8/8 on dnd5e today. PF2e last passed live on
2026-09-24 morning; it was not re-run because a user was connected to the dnd5e world. Switching worlds
means `game.shutDown()` and clicking the world card's `[data-action="worldLaunch"]` on `/setup`, which
kicks connected users, so only do it when nobody is on.

How the event over-splitting was fixed: the model declares `continuesPrevious` per event (schema),
and `pipeline.js#mergeFollowUpEvents` folds only those into the event before them, keeping the payoff
as `consequence`. World setting "Fold follow-up lines into one event" (`mergeFollowUps`) turns it off.
Prompt-only attempts and a theme-based merge were tried first and failed (see the contract change log).

Harness note: `makeHarnessActor` has a pending grant allowance, so in `when-earned` mode every rep also
runs stage 2 and writes proposals (~9 s/rep). Use `--proposal-mode never` for extraction regressions.

1. **Residual over-splits** (15 of the 40 hard items, e.g. bl-005 "bought rope" after haggling,
   cs-es-04 climb/jump/grab, rd-003). Some of these are arguably fair splits; consider loosening gold.
2. **Red misses**: rd-006 (a year of life for a spell), rd-008 (trophies from kills), rd-010 (raising
   the dead without consent) still come out standard. Only false positive: nv-009 compulsive gambling.
3. **Stage-2 latency**: ~9 s p50 per analysis when proposing (1 extraction + 1 proposal call).
4. Re-run the live PF2e check when the server is free.
