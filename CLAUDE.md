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
npm test                                    # 1447 unit tests, ~30 s, no network
node tools/nlp-scale/run.mjs --sim --party --sim-jev                   # party corpus, simulated Jev
node tools/nlp-scale/run.mjs --jev --party                             # real Jev (TYPESAFE_API_KEY)
node tools/nlp-scale/job-runner.mjs         # job queue for real-model scale runs (see below)
node tools/nlp-scale/run.mjs --model qwen3:30b-a3b --reps 3            # full corpus vs local Ollama
node tools/nlp-scale/run.mjs --model qwen3:30b-a3b --filter traps,non-english --reps 5
node tools/nlp-scale/run.mjs --sim --fault-rate 0.3                    # offline, simulated model
node tools/nlp-scale/build-browser.mjs --check                         # one-file browser bundle
node tools/jev-proxy.mjs                     # optional Jev in Foundry: CORS proxy, endpoint http://127.0.0.1:8788
node tools/playtest/live-verify.mjs          # live check in the running world (28 checks; switch-world.mjs to change)
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
- Optional **Jev (TypeSafe) layer**: `scripts/ai/jev.js` + contract `docs/jev-layer-contract.md`. Off without a key;
  fails open; triage before stage 1, second opinions on who-did-it / dark acts (flags, guarded overrides),
  proposal ranking. Settings fieldset + Test Jev; Growth dialog "Analyze party" + chips.
- Harness: `tools/nlp-scale/` — 322-item labeled corpus (13 categories, 14 languages), scoring,
  consistency metrics, simulated fault-injecting model.

## Status (2026-09-29) and open work
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

ember-road s1-s3 played (dnd5e). s3 (2026-09-28) used LOCAL-model players (`tools/playtest/players.mjs`,
mistral-small3.2:24b, no Claude tokens - Claude sub-agent players cost ~30k tokens/turn and haiku refused).
Landed: proposal rejection (`api.rejectProposal`, Reject button, `playtest.mjs reject`), "Suggest proposals"
fix (`presetEvents`), s2 extraction misses (a "then" clause never folds; few-shots for listed spells and
implied-verb downtime). s3: every approved Skill used in play was credited to its owner. 792 tests.

2026-09-28 (later): first PF2e campaign **salt-lantern** (s1-s2, local players; `playtests/salt-lantern/`):
PF2e jargon and degrees read correctly, per-PC credit clean, repeated failures earn a Skill (Buck's
Grappler's Resilience). Landed: proposal quality gates (owned-Skill / class-feature duplicates, wrong-system
terms rewritten or skipped, bare class motifs re-coined), pending cap, C5 review (eventDedupeKey includes the
actor; differentActors ignores titles). 840 tests + 1 todo. Foundry was down: the PF2e live check is pending.

2026-09-29: gap audit (3 code audits + live Foundry audit) filed 40 items under the epic "AI-first Grand
Design" (278670bb, 5 features). First batch landed and verified LIVE in EndexDND 5E (build c579a64,
`tools/playtest/live-verify.mjs` 15/15): "Author with AI" really authors (adapter.authorProposal, stage-2
target); no templates/Knack placeholders when the AI read the notes; authored templates survive; Class
evolutions stay approvable past their milestone; AI settings per USER (not browser) with an "AI expected"
warning; adapter rebuilds on settings change; rest shows fallback warnings; milestone capstones tier 3;
deploys stamp a build (0.28.x) shown at ready, in the Gateway form and Under the hood. 907 tests + 1 todo.
Foundry: the owner authorised Claude to log in as Gamemaster (no password) and drive the worlds.

2026-09-29 (later): AI-authoring batch by the dev team (4 worktree agents, 13 items, commit c010773 +
follow-up): milestone "Retry with AI" (`api.retryMilestoneReward`), fallback DCs/rolls from the character level
as real system checks (`@Check`, `[[/check]]`, `[[/save]]`), fallbacks named by the Class motif, proposal
Details/Edit (`api.updateProposal`)/per-row Approve/"Approve as written", in-dialog busy state + per-actor lock,
unique evolved/merged ids and names, emergent-theme slug folding, near-duplicate proposals gated against pending
and rejected ones, `actorRole` drops things done TO a PC, unreachable gateway settings exposed. Verified with the
real model on reruns `playtests/v0929-dnd5e` (ember-road s1) and `v0929-pf2e` (salt-lantern s1-s2); traps+novel
slice 96.8%, traps 100%. NOT yet clicked through in Foundry (dnd5e world occupied all session). 1040 tests.

2026-09-29 (evening): advanced mechanics batch (4 agents): Skill evolution and Class merging are reachable and
AI-written (`adapter.authorAdvanced`, `api.requestSkillEvolution`/`requestClassMerge`, approval supersedes the
sources), title proposals ("Trollbane"), a Registry panel (sheet header), erosion callouts, Suggest explains
skips/cap, playtest.mjs owned/evolve/merge/titles/erosion. Two live regressions from the morning batch fixed
(empty Suggest with pending proposals; milestone Class gated as a duplicate of same-motif Skills).
**LIVE 19/19 in BOTH worlds** (build 3e75e8e); worlds switch with `node tools/playtest/switch-world.mjs <worldId>`
(owner authorised switching; "endex" = PF2e, "endexdnd-5e" = dnd5e). 1126 tests.

2026-09-29 (night): batch 3 (5 agents). Horror Rank accrues from recorded DARK DEEDS (owner decision): every
event carries `darkDeed`/`darkSeverity`, points 5/15/40, stage 0-3 meter + docking notices in the dialog and
Registry (darkDeedAcc 90%, 0% false on traps; Tovin 15 for the surrendering goblin). Approved growth is real
game data: `mechanics.structured` -> PF2e rule elements/frequency/spell data and dnd5e activities/Active Effects,
AI numbers clamped by tier + level, superseded Items switched off. **LIVE 22/22 in BOTH worlds** (build e091fe9).
1212 tests. Owner questions open in conversion rules section 6 (feat suppression? atonement? 5/15/40 + 100?).

2026-09-29 (cloud session, branch `claude/install-typesafe-skill-utldpd`): optional **Jev (TypeSafe) layer** by a
4-role dev team + Fable reviewers (`docs/jev-layer-contract.md`). `scripts/ai/jev.js` speaks `/v1/systemone`
directly (no dependency); every step fails open and Jev-off output is byte-identical (3948/3948 corpus variants).
Steps: triage (skip passages with no character action, cached with the reading), attribution as a second opinion
on the LLM's `actorName` (replaces only under a witness guard, else `actor-disputed`), dark-act flag when the LLM
said `none` (never lowers `darkDeed`), proposal `grounded`/`fit` + `weak-evidence`. `api.analyzePartyNotes`
(one click, over the extraction cache, covers 7f1f20ae), Gateway settings "Jev" fieldset + Test Jev (client-scoped
`jevApiKey`), Growth dialog "Analyze party" + chips. Harness: `sim-jev.js`, 26-item party corpus
(`corpus/party/`, per-PC gold, part of C1), `--jev/--sim-jev/--party`, `playtest.mjs analyze --party`.
Offline numbers: `--sim --party` 94.7% (attribution 91.3%) -> with sim-Jev **97.4% / 97.5%**, red recall 0 -> 100%
(after fixing a real bug: the per-PC split honoured a Jev name the pipeline had flagged disputed). 1361 tests.
Merged into main locally 2026-09-29 (fast-forward, not pushed).

2026-09-29 (late, local): **Jev in the browser needs a proxy**: api.typesafe.ai refuses EVERY browser origin (CORS),
so inside Foundry Jev only runs through `foundry-module/tools/jev-proxy.mjs` (endpoint http://127.0.0.1:8788; zero-dep,
forwards only /v1/systemone + /v1/models, never stores a key); a CORS block or timeout ends Jev for the run and the
dialog says "Jev did not run: <why>". Real numbers (party corpus 26x1): no roster 96.2% -> real Jev 97.2%; then the
**party roster** fix (analyzePartyNotes passes the PC names to the gateway prompt + Jev; e54491dd) gives 97.2% /
attribution 98.7% / idle-at-zero 100% WITHOUT Jev, and roster + Jev is identical. Jev today = GM-facing flags
(weak-evidence, outcome-disputed) for ~1.6 s/run and rare 10 s timeouts; everything works without it.
Also landed, **LIVE 28/28 in BOTH worlds** (build 9d1b59b, `tools/playtest/live-verify.mjs`): Populate uses the AI
(PF2e stats by level, local fallback with reason; `live-populate.mjs`), delete/move a recorded event and revert an
approval (4344c58a), opt-in plain HTTP to the LAN for Ollama / jev-proxy (2d795cac), and the owner's Horror Rank
answers (conversion rules 6): a stage suppresses one class feat/feature (GM confirms; exact restore on stage loss),
atonement deeds lower the meter (`atonement` field; 100% on 10 items, 0% invented on 48), restore docked levels,
points/threshold as world settings. 1447 tests.

Open, in order (see the board, epic 278670bb):
1. Playtest the new mechanics: salt-lantern s3 (PF2e) with evolve/merge/titles/Horror Rank (suppression, atonement).
2. Combos (e6d9185c), death/revival (b16101a9), cleanse/consolidation from atonement (54a5058f).
3. Follow-ups: Re-analyze re-reads GM-deleted deeds (0de0d5eb), bland tag motifs (e8ae42d0), same-name proposals
   across PCs, dnd5e merges restate sources, structured conditions text-only, PF2e superseded frequency.
4. Earlier items: softened dark deeds, over-splits, tier-1 balance, rd-008. (Owner: Stage 3 lock-out stays a story notice.)
