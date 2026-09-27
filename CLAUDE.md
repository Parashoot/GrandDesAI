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
npm test                                    # 664 unit tests, ~30 s, no network
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

## Status (2026-09-27) and open work
Default model **`qwen3.8:27b`**. Scale numbers: see the 2026-09-24 entries in the contract change log and
`Scale Test Results` in the vault (extraction 97.6%, count 96.2%, traps 100%, fallback 0%).

**New process: the `grand-design-pm` skill** (board `node tools/board.mjs`, playtests
`foundry-module/tools/playtest/playtest.mjs`, dev team in worktrees, vault export). Push main before
spawning worktree agents or cloud sessions: they start from `origin/main`. Cloud-safe packets C1-C5 are in
`docs/cloud-work.md` (board tag `cloud`).

First playtest **ember-road** (dnd5e, 5 player agents), session 1: transcript, notes, report, review in
`foundry-module/playtests/ember-road/sessions/01/` (`report-before.md` = before the fixes). Fixed and
verified with the real model: party notes no longer credit every character with every event
(per-PC events 17-19 -> 2-7), template proposals are system-correct and sourced, and a "Suggest proposals"
button plus `api.requestGrowthProposals(actor)` covers grant allowances with nothing to approve.

2026-09-27 (later): attribution + red, verified with the real model on an ember-road s1 re-run
(`sessions/01/rerun-2026-09-27/`). `actorName` is now required and early in the event schema (it had been
empty on every event); the extraction prompt no longer names the analysed PC; a deed reported in another
player's line goes to the doer, in plain words (Tovin "killed a goblin that was surrendering", not "tidied
up a loose end"). Identical notes are read once per adapter (`pipeline.js#createExtractionCache`; 5 PCs
62 s instead of 2+ min; "Re-analyze" passes `fresh: true`). Stage 2 sees only the analysed PC's events and
fills a required per-event `redCheck` first: Tovin now gets a red cruelty Skill, red-slice redAcc 70% -> 90%.
Consequence: in "when-earned" mode a PC no longer earns proposals from party-mates' events (s1 now proposes
nothing until "Suggest proposals" / a grant allowance). Cost: count accuracy on an 89-item slice 89.9% ->
87.6% (1 rep, noise-level; see 40f4431d).

Open, in order (see the board):
1. Playtest sessions 2-3 of ember-road (approve proposals, use them in play), then a PF2e campaign.
2. Proposal quality: duplicates of class features (3962a001), rd-008 kill trophies still standard (9f591a25),
   residual over-splits (40f4431d).
3. Live Foundry: click "Suggest proposals" on both worlds; the PF2e live check is still pending.
4. Cloud packets C1-C5 (push main first).