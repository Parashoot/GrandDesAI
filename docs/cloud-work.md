# Cloud work packets

Self-contained tasks a cloud Claude session (Claude Code on the web, Cowork, a remote agent) can do
**without** the owner's machine: no Ollama, no Foundry, no Obsidian vault. Everything here runs on
plain Node 22 (`cd foundry-module && npm test`, the simulated model `node tools/nlp-scale/run.mjs
--sim`). Each packet has a board item tagged `cloud` (`node tools/board.mjs list --tag cloud`).

Rules for every packet (same as `.claude/skills/grand-design-pm/SKILL.md`, Sub-agent working
agreement): read `CLAUDE.md` and `docs/ai-gateway-v2-contract.md` first; stay inside the files the
packet names; `npm test` must stay green; work on a branch named `cloud/<packet-id>` and open a PR
(never push to main); end the PR description with what you verified. Anything needing the real
model is marked **needs local verify** in the PR so the owner's next local session runs it.

---

## C1 - Party-recap corpus + per-character gold

**Why:** the first playtest (`foundry-module/playtests/ember-road/sessions/01/`) showed the
module's biggest failure: party-wide notes ("Name: text" lines, first person, one player
reporting another's deed) credited every event to every character. The scale corpus has no items
of that shape, so the harness can't measure the fix.

**Do:**
1. Add `foundry-module/tools/nlp-scale/corpus/party-recaps.json` with 40+ items in the existing
   corpus format: group-chat recaps ("Brakka: held the bridge..."), first-person lines ("Wick: i
   lost my dagger lol"), one character reporting another's action ("Luz: I saw Tovin kill the
   goblin that surrendered"), "we/the party" actions, GM lines with traps (next-session plans,
   rules questions, pizza), mixed shorthand and non-native English. Canonical tags only (see
   `tests/nlp-harness.test.mjs`).
2. Extend gold with optional per-character expectations, e.g.
   `"actors": { "Tovin": { "mustTags": ["martial|occult"], "minEvents": 1 }, "Luz": { "maxEvents": 1 } }`,
   and teach `tools/nlp-scale/lib.mjs` to score it (new metric `actorAcc`: share of actor
   expectations met, using each event's `actorName`, case-insensitive first-name match). Show it in
   the markdown report. Keep old items scoring exactly as before.
3. Make `tools/nlp-scale/sim-model.js` emit `actorName` for the new items so `npm test`'s
   fault-free sim still scores 100%.
4. Tests for the new metric in `tests/nlp-harness.test.mjs` (or a new test file).

**Files:** `foundry-module/tools/nlp-scale/**`, `foundry-module/tests/**` (new files preferred).
**needs local verify:** a real-model run `node tools/nlp-scale/run.mjs --model qwen3.8:27b --filter party-recaps --reps 3`.

---

## C2 - Scenario pack for playtests

**Why:** playtests are the best bug-finder we have (`.claude/skills/grand-design-pm/`), and
every session needs a prepared adventure that deliberately exercises the module.

**Do:** write `.claude/skills/grand-design-pm/references/scenarios.md`: 8 ready-to-run session
plans (4 for dnd5e, 4 for PF2e; levels 1-10), each with 3 beats (fight with a stated danger gap,
social/investigation, downtime with 5+ off-script hooks), NPCs, a list of "module traps" the DM
should plant in the notes (plans, rules questions, rumours, OOC), and the ground-truth checklist
the reviewer compares against. Include hooks for every persona in
`references/personas.md`, a dark-path escalation arc across sessions (red polarity), a
multilingual town, and one session built around a guild/profession (innkeeping, smithing,
cartography) to grow emergent-theme Skills. Link it from `SKILL.md`'s Playtest section.

**Files:** `.claude/skills/grand-design-pm/references/scenarios.md`, one line in `SKILL.md`.

---

## C3 - GM guide (player-facing docs)

**Why:** the module has grown a lot (AI gateway v2, emergent themes, red entries, consequences,
follow-up folding, per-system rules) and there is no guide for a GM who just installed it.

**Do:** write `docs/gm-guide.md` from the code and existing docs (`README.md`, `GAME_DESIGN.md`,
`foundry-module/README.md`, `docs/ai-gateway-v2-contract.md`, `scripts/growth-ui.js`,
`scripts/ai-provider-config.js`): install + Ollama setup (OLLAMA_ORIGINS, model choice with the
measured numbers from CLAUDE.md), writing session notes (what counts, what doesn't, examples in
every style), reading the Growth dialog, approving/rejecting, grant allowances and rests, emergent
themes, red entries and vices, every setting in the Gateway settings app explained, troubleshooting
(fallback reasons). Screenshots are not possible in the cloud: describe the UI in words and mark
`<!-- screenshot: ... -->` placeholders. Link it from `README.md`.

**Files:** `docs/gm-guide.md`, one link line in `README.md`.

---

## C4 - Test coverage for the non-AI rules

**Why:** the progression rules (class erosion, horror rank, lineage, combination skills, revival
penalty, skill evolution) are the game's heart; playtests will start approving entries and
leveling characters, and regressions there would be silent.

**Do:** read `foundry-module/scripts/{class-erosion,horror-rank,lineage,combination-skills,revival-penalty,skill-evolution,class-merging}.js`
against `GAME_DESIGN.md` and `wandering-inn-pf2e-conversion-rules.md`; list rules that have no
test (`grep` the tests), then add focused tests for them, both systems where the code branches on
system. If a test reveals a real bug, do NOT fix it: mark the test `test.todo`/`skip` with a
comment, and list the bug in the PR description with a minimal reproduction.

**Files:** `foundry-module/tests/**` (new files).

---

## C5 - Review: the AI pipeline, read cold

**Why:** `foundry-module/scripts/ai/pipeline.js` has grown through many measured iterations; a
careful cold read finds what incremental work misses.

**Do:** review `foundry-module/scripts/ai/*` and `scripts/ai-gateway.js` for correctness bugs
(error paths that could lose the GM's notes, cache/merge edge cases, schema/prompt drift,
unbounded loops, both-systems parity). Write `docs/reviews/ai-pipeline-review.md`: each finding
with file:line, a concrete failing input, and severity. Prove each finding with a failing unit
test in `foundry-module/tests/review-*.test.mjs` marked `test.todo` where needed. Do not change
production code.

**Files:** `docs/reviews/ai-pipeline-review.md`, `foundry-module/tests/review-*.test.mjs`.
