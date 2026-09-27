# The dev team

Spawn with the Agent tool, one agent per role that has work, in parallel, each with
`isolation: "worktree"` so edits never collide. Only give a role files it owns; if a fix spans two
roles, split it into two board items or give it to one role and name the other role's file as a
read-only dependency.

| Role | Owns | Typical items |
|---|---|---|
| `dev-gateway` | `foundry-module/scripts/ai/*`, `scripts/ai-gateway.js` | misreads, splitting, tags, outcomes, stage-2 prompts, schemas, speed |
| `dev-integration` | `scripts/api.js`, `scripts/progression.js`, `scripts/emergent-themes.js`, `scripts/session-notes.js`, `scripts/growth-taxonomy.js` | credit per character, progression fairness, approval flow, themes, local fallback |
| `dev-systems` | `scripts/systems/*`, `scripts/validator.js`, `scripts/lineage.js`, `scripts/mechanics.js` | system terms, item building, balance checks, dnd5e/pf2e parity |
| `dev-ui` | `scripts/growth-ui.js`, `scripts/ai-provider-config.js`, `scripts/emergent-themes-settings.js`, `styles/*`, `lang/*`, `scripts/main.js` | GM workflow, clarity, quality-of-life features |
| `dev-harness` | `tests/**`, `foundry-module/tools/**`, `tools/*` (board, vault export) | new tests, corpus items from playtest findings, playtest runner features |

Every fix gets a test from `dev-harness` or from the fixing role (tests may be added by anyone;
existing tests change only when the contract changes, with a change-log line saying why).
Playtest findings that are about reading notes should also become corpus items in
`foundry-module/tools/nlp-scale/corpus/` so they stay fixed.

## Dev agent prompt (fill the blanks)

```
You are {role} on the Grand Design AI dev team (Foundry VTT module for PF2e and dnd5e,
repo root C:\Users\parez\code\GrandDesAI). Read CLAUDE.md, docs/ai-gateway-v2-contract.md and
.claude/skills/grand-design-pm/SKILL.md (Sub-agent working agreement) first.

Your board items: {ids and titles}. Claim them: node tools/board.mjs doing <id> --owner {role}.
Evidence from the playtest: {quotes from notes/report/transcript, expected behavior}.
You may edit ONLY: {owned files}. Read anything.

Do: find the root cause (check, don't guess), fix it for BOTH pf2e and dnd5e, add a regression
test, run `npm test` from foundry-module/ (must stay green), then verify against the real model:
{e.g. node foundry-module/tools/playtest/playtest.mjs analyze --campaign X --session N (copy
report.md to report-before.md first) | node foundry-module/tools/nlp-scale/run.mjs --ids ...}.
Note what you verified with numbers: node tools/board.mjs note <id> "...". Do not commit or push.
End with: files changed, tests added, before/after evidence, anything you could not fix and why.
```

## Merging (PM)

1. Read each agent's summary and its worktree diff. Reject anything outside its owned files.
2. Apply the diffs to the main tree one by one, `npm test` after each.
3. Re-run the playtest session(s) that found the bugs; compare with `report-before.md`.
4. `done` each verified item with a closing note, update `CLAUDE.md`/change log, `node tools/vault-export.mjs`, commit.
