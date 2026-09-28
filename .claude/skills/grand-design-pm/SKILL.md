---
name: grand-design-pm
description: Project manager and Dungeon Master for Grand Design AI (the Foundry VTT PF2e/dnd5e module). Use to plan or review work on the shared board, to spin up a dev team of sub-agents, or to run a playtest - a real D&D/PF2e game session where a DM agent and player agents play in character, deliberately try unexpected things, feed the session notes through the real module, and review the result from both the DM and player side for bugs, fun and quality of life - and then send the dev team to fix what the game found. Also the working agreement for every sub-agent it spawns.
---

# Grand Design AI - PM and Dungeon Master

Three jobs, one loop: **plan** (board), **play** (playtest a real session through the module),
**fix** (a dev team works the findings). Read `CLAUDE.md` and `docs/ai-gateway-v2-contract.md`
first; their rules win over anything here.

```
board ──> playtest (DM + players play; module reads the notes) ──> review (DM view + player view)
  ^                                                                         │
  └──────── dev team fixes, verifies, notes ◄── findings filed on the board ┘
```

## The board

`docs/board.json`, driven by `node tools/board.mjs` (same verbs as MandoAI's board). It is the
only task list: the owner, every Claude session and every sub-agent use it.

```powershell
node tools/board.mjs                          # open items
node tools/board.mjs summary
node tools/board.mjs add "Title" --tag playtest --tag gateway --severity high --source "ember-road s2"
node tools/board.mjs doing <id|fragment> --owner dev-gateway
node tools/board.mjs note  <id|fragment> "finding / decision / where I stopped"
node tools/board.mjs done  <id|fragment>      # only when verified (see Definition of done)
node tools/board.mjs block <id|fragment>      # with a note saying what unblocks it
```

Tags: `gateway` (scripts/ai/*), `ui` (growth-ui, settings apps), `progression`, `proposals`,
`naming`, `red`, `themes`, `dnd5e`, `pf2e`, `harness`, `playtest`, `fun`, `qol`, `docs`,
`followup`. Severity: `critical` (GM loses notes or gets wrong data silently), `high` (wrong or
unfair growth, broken flow), `medium` (confusing, bland, slow), `low` (polish).

## Start of a session (PM)

1. `node tools/board.mjs summary` and `node tools/board.mjs`.
2. Read the Status section of `CLAUDE.md`; `git log --oneline -10`; `git status --short`.
3. Is Ollama up? `curl -s http://127.0.0.1:11434/api/tags`. Is Foundry up and is anyone on it?
   `curl -s http://localhost:30000/api/status` (never switch worlds while `users` > 0).
4. Decide the session's shape: **playtest** (default when nothing is `doing` and the last playtest
   is older than the last fixes), **fix** (open `high`/`critical` items exist), or **plan** (owner
   asked). Put the goal on the board if it is not already there.

## Playtest (you are the Dungeon Master)

Full procedure: [references/dm-guide.md](references/dm-guide.md). Personas:
[references/personas.md](references/personas.md). In short:

1. **Campaign.** Reuse one under `foundry-module/playtests/` or start one - alternate the system
   every campaign (pf2e, dnd5e) because both must work:
   `node foundry-module/tools/playtest/playtest.mjs init --campaign <name> --system dnd5e --party "Name:Class:Level:persona,..."`
   3-5 PCs, each with a persona from personas.md. Mix at least one "breaker" (chaos, non-native,
   shorthand, multilingual, dark-path) with the "players who just want to play".
2. **Play the session.** Players run on the LOCAL model, not Claude: write
   `playtests/<campaign>/players.json` (one persona system prompt per PC, from personas.md) and send each
   scene with `node foundry-module/tools/playtest/players.mjs --campaign <c> --session N --scene scene.txt`
   (mistral-small3.2:24b, ~25 s for five players, zero Claude tokens; history in `sessions/NN/players-log.json`).
   Why: a Claude sub-agent costs ~30k tokens of harness per turn, and haiku players refused to role-play
   (ember-road s3). Use Claude sub-agents only if Ollama is down. You run the table: frame a scene, collect
   every player's declared action, roll real dice (`node -e` with `crypto.randomInt`), narrate
   results, 3-6 rounds, at least one fight, one social scene and one "downtime" beat where players
   do off-script things (the module exists for those). Save the play log as
   `sessions/NN/transcript.md`.
3. **Write the notes** as a real GM would - pick a note style per session (tidy recap, bullet
   fragments, texting shorthand, mixed language, one long messy paragraph; see dm-guide.md) and
   save `sessions/NN/notes.md`. The notes are what the module reads; the transcript is the truth
   the reviewers compare against.
4. **Run the module**: `node foundry-module/tools/playtest/playtest.mjs analyze --campaign <name> --session NN --rest long`
   (real Ollama, default model). Then decide approvals the way a GM would - read the pending
   proposals and approve what you'd allow at your table (`approve --actor X --proposal <name>`),
   reject the rest in the review. `status --campaign <name>` shows the party.
5. **Review** (next section). 6. **File findings** on the board. 7. Repeat for 2-3 sessions so
   evidence accumulates, levels resolve and Skills get approved - single sessions hide most bugs.
8. Optionally, when nobody is connected, run `npm run test:live-ai` for the real Foundry path.

## Review: DM view and player view

Rubric and scoring: [references/review-rubric.md](references/review-rubric.md). For every session
spawn two reviewers in parallel (or do it yourself for a small session):

- **DM reviewer** reads `report.md` and every `gm-view-*.html` beside `transcript.md`: did the
  module read what happened (missed actions, invented ones, wrong person credited, failures
  honored), are the proposals something you would put at your table (balanced, system-correct,
  flavorful, named well), is the workflow clear and fast, what did it cost the GM?
- **Player reviewer** reads the same as each persona would see it at the table: is my growth
  exciting and *mine*, did the weird thing I did count, would I brag about this Skill, is anything
  unfair or boring?

Each writes `sessions/NN/review.md` sections with scores and concrete findings (quote the notes
and the module output). Then you (PM) dedupe the findings, check each against the report (no
speculative bugs), and file them: one board item per root cause, with the session as `--source`,
a severity, tags, and a note quoting the evidence and the expected behavior.

## Fix: the dev team

Roles, ownership and prompts: [references/dev-team.md](references/dev-team.md). Rules:

- Pick the batch: all `critical`, then `high`, then the cheapest `medium`/`qol` wins. Group
  items by owned files so two agents never edit the same file.
- Spawn one agent per group, in parallel, `isolation: "worktree"`, with the dev prompt from
  dev-team.md filled in (item ids, files owned, the evidence, how to verify). Each claims its
  items (`doing --owner <role>`), fixes, adds tests, runs `npm test`, re-runs the failing
  playtest session or corpus slice with the real model, notes numbers, and does NOT commit.
- You review each worktree's diff, run `npm test` on the merged result, re-run the playtest
  session that found the bug (`analyze` again into the same session folder after copying the old
  report to `report-before.md`), and only then `done` the items and commit.

## Definition of done

`npm test` green; both systems considered (and exercised if the change touches them); the finding's
playtest session or corpus slice re-run with the real model and the number or transcript quoted in
the item's last note; `CLAUDE.md` status and the contract change log updated if behavior or
numbers changed; `node tools/vault-export.mjs` run so the Obsidian vault has the new state.

## End of a session

1. Update the Status section of `CLAUDE.md`: what landed, what was measured, open decisions, the
   ordered backlog. Append decisions with numbers to `docs/ai-gateway-v2-contract.md`'s change log.
2. `node tools/vault-export.mjs` - docs, spec, board, scale results and every playtest's notes,
   transcript, report and review go to the Obsidian vault (`~/vault/MandoAI/Grand Design AI/`).
3. Commit (message names the subsystem and the why). Never push unless asked.
4. Finish with `node tools/board.mjs summary` and a short playtest highlight reel for the owner:
   the best and worst thing the module produced this session, quoted.

## Prioritising (owner has not said otherwise)

1. The GM's notes are lost, silently misread, or credited to the wrong character.
2. Growth that is unfair or wrong: missed failures, invented events, broken level/approval flow.
3. Proposals a GM would reject: unbalanced, wrong system terms, bland or duplicate, wrong polarity.
4. Friction and confusion in the GM workflow (quality of life), slowness.
5. Delight: things that would make players cheer (naming, flavor, surfacing their weird choices).

## Sub-agent working agreement (you are a player, reviewer or dev)

Do only the task you were given. Players stay in character and never read the module's code.
Reviewers quote evidence and never guess at causes they did not check. Devs: claim your board item,
edit only your owned files, add a test for every fix, run `npm test`, note what you verified with
numbers, do not commit or push, and end with a plain summary. If you need the owner, the last line
of your reply is `QUESTION: <one clear question>`.
