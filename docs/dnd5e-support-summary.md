# Grand Design AI — dnd5e Support: Design & Overnight Test Summary

Completed overnight on 2026-08-23 while you were asleep. Module deployed to your live Foundry install (version 0.26.0) and tested against your real "EndexDND 5E" world. Everything below actually ran — nothing here is simulated or aspirational.

## What changed, in one paragraph

The module now supports both PF2e and dnd5e from a single manifest and a single codebase. All of Grand Design's actual logic — growth events, tags, proposal generation, the 0-100 meta-progression system, session-note parsing, validation — was already system-agnostic and needed zero changes. Only the code that builds a real Foundry Item from a Grand Design entry was PF2e-specific, so that's what got split out into per-system adapters behind a small dispatch layer.

## Architecture

```
scripts/
  mechanics.js, lineage.js, api.js, ai-gateway.js, ...   <- unchanged core logic
  systems/
    index.js            <- dispatch: getSystemAdapter(game.system.id)
    pf2e-adapter.js      <- extracted, behavior-identical to the old inline code
    dnd5e-adapter.js     <- new
```

`lineage.js#createFeatureSource(kind, entry, systemId)` now takes the active system id and delegates to the matching adapter for the Item's `type`/`system` fields, while the shared name, description HTML, and flags stay identical between systems. `api.js#_ensureFeatureItem` creates the Item and then runs the adapter's optional `postCreate(item)` step, which is where dnd5e's Activities get added (PF2e needs no such step — its data is flat on the Item).

`SUPPORTED_GAME_SYSTEMS = {pf2e, dnd5e}` gates module activation and the API's actor-system guard everywhere that used to hard-code `"pf2e"`.

## Level & progression mapping — the actual design decision

Grand Design's own leveling is a **homebrew 0-100 meta-progression track** (level requirement curve, `GRAND_DESIGN_MAX_LEVEL = 100`, class-evolution thresholds at 20/30/50, grant allowances) that lives entirely in actor flags. It is **not** PF2e's or dnd5e's native level system, and it needed **no changes at all** — it was already independent of the underlying TTRPG.

The only place a native system level mattered is *reporting the character's current level to the AI* so proposals stay level-appropriate. That's now `adapter.getCharacterLevel(actor)`:

- **PF2e**: `actor.system.details.level.value` (nested)
- **dnd5e**: `actor.system.details.level` (dnd5e already derives this as a plain integer summed from class-item levels — no nesting)

Everything else that differs between the systems is at the *Item-building* layer, not the leveling layer:

| Concern | PF2e | dnd5e |
|---|---|---|
| Ability effects | flat `system.actionType`, `system.damage.dice` | embedded `system.activities` (Activity documents), created via `item.createActivity(type, data)` |
| Spell rank/level | 0–10 | clamped to 0–9 (5e has no 10th-level spells) |
| Spell school | not required | now required on **both** systems (`gameItem.school`, one of `abj/con/div/enc/evo/ill/nec/trs`) — this was tightened universally, not just for 5e, so spell proposals are consistent either way |
| Weapon type | PF2e weapon categories | derived `simpleM/simpleR/martialM/martialR` from category + a ranged-weapon heuristic |
| Activation type | PF2e action cost | `gameItem.kind` → dnd5e `activation.type` (feat/action/spell→action, reaction→reaction, free→bonus, passive→none) |
| Frequency/uses | PF2e frequency | mapped to dnd5e `uses.recovery` periods where there's a clean fit (day→`lr`, encounter→`sr`, round→`turn`); minute/hour frequencies are left structurally uncapped since dnd5e has no matching recovery bucket — the cadence still reads in the description text |
| Weapon traits → properties | PF2e traits | best-effort map (agile/finesse→fin, thrown→thr, reach→rch, versatile→ver, light→lgt, heavy→hvy, ranged→amm); unrecognized traits are dropped rather than guessed at |

One correction made along the way: a thrown weapon (dagger, handaxe, javelin) stays a **Melee** weapon in 5e with the `thrown` property — it does not become a Ranged weapon. The adapter's ranged-detection was initially too broad and briefly misclassified these; fixed and covered by a regression test.

## What was tested

**Unit tests: 49/49 passing** (`npm test`), including 13 new dnd5e-adapter tests and a full end-to-end dnd5e campaign simulation through the real `GrandDesignApi`/growth-proposal pipeline with mocked Foundry globals.

**Live testing against your actual "EndexDND 5E" world** (Foundry 14.367, dnd5e 5.3.3), after deploying the refactored module there:

1. Ran the real AI-provider growth campaign (`api.runAiTestScenario()`) against your real Ollama — not the heuristic fallback. All 6 narrative beats resolved through the live model, 0 failures, entries generated across `feat`/`action`/`reaction`/`passive` kinds. (This particular run's events didn't accumulate a full level-up grant allowance — expected run-to-run variance from a live model — so nothing got auto-approved into an Item on *this* run. Fully rerunnable any time from the console.)
2. Because of that, I separately drove the exact same Item-creation code path (`createFeatureSource` → `createEmbeddedDocuments` → adapter `postCreate`) directly against a scratch actor in your live world for all three Item-building branches — **feat, spell, and weapon** — and confirmed real dnd5e Activity documents were created correctly:
   - feat → `utility` activity
   - spell (rank 1, school evo) → `attack` activity, `system.level === 1`, `system.school === "evo"`
   - weapon (martial, agile+thrown) → auto-populated `attack` activity, `type.value === "martialM"` (correctly stayed Melee despite "thrown")
   
   Scratch actor deleted afterward; your world is back to 0 actors, clean.
3. No console errors during any of this. One pre-existing, unrelated deprecation warning showed up (`FilePicker` global → namespaced under `foundry.applications.apps.FilePicker.implementation`, removed in Foundry v15) — harmless on v14, not part of tonight's work, flagging in case you want it cleaned up later.

## Deployment

Your repo at `C:\Users\parez\code\GrandDesAI\foundry-module\` and the live module at `...AppData\Local\FoundryVTT\Data\modules\grand-design-ai\` are both now on version **0.26.0** with the new `scripts/systems/` folder. Deployed the same way `tools/deploy-foundry-module.ps1` does it (mirrored, excluding `tests/`, `*.md`, `package.json`).

## Loose ends for you

- There's a stale `tests/` folder (leftover `.env` placeholder files, no real secrets) still sitting inside the **deployed** module directory (`Data/modules/grand-design-ai/tests/`) from before the deploy script's exclude list existed. It's harmless — Foundry only loads `esmodules` — but I don't have delete permission from this environment to remove it. Say the word and I'll either request delete permission or just move it aside.
- `module.json`'s dnd5e minimum compatibility is set to `4.0.0` (when the Activities API was introduced) — worth confirming that's the floor you actually want to support.
- Everything above is genuinely GM-reviewable by design: weapon trait mapping and activation-type inference are best-effort, not authoritative 5e rules calls.
