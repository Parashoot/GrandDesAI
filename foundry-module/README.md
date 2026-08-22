# Grand Design AI Foundry VTT module

This module targets Foundry VTT 12-13 with the PF2e game system installed. It is a GM-facing bridge between Grand Design conversion records and PF2e Actors; it is not a replacement PF2e system.

## Install from GitHub

If this repository is made public or distributed through an authenticated module registry, Foundry's **Install Module** flow can use:

```text
https://raw.githubusercontent.com/Parashoot/GrandDesAI/main/foundry-module/module.json
```

The repository is currently private, so Foundry cannot download that URL anonymously. Use the manual/private option below unless you intentionally publish a release distribution.

## Install locally or from the private ZIP

1. Extract `releases\grand-design-ai.zip` into Foundry's `Data\modules\grand-design-ai` directory, or copy the `foundry-module` directory there while developing.
2. Start a PF2e world, enable **Grand Design AI**, and reload the world.
3. Open a PF2e Actor sheet as GM and select **Grand Design** in the header.
4. Paste `examples\foundry-innkeeper.json` from the repository, or provide the same shape for your own character.

The module validates the input, stores the approved record in `flags.grand-design-ai.conversion`, and emits the `grand-design-ai.conversionApplied` hook. On approval, it also adds each Class and Skill as an idempotent PF2e Item on the Actor sheet. The module never overwrites the Actor's core PF2e class; Grand Design Classes can coexist with the normal PF2e chassis.

## Required mechanics

Every approved entry must specify a `gameItem.kind` and `mechanics` object. Supported kinds are `feat`, `action`, `reaction`, `free`, `passive`, `spell`, and `weapon`.

- **Actions, reactions, free actions, spells, and weapons** require a dice formula, resolution kind, concrete effect, frequency, and duration. Reactions also require a trigger; actions require a 1-3 action cost.
- **Passives and feats** require a concrete effect, duration, and frequency. A passive without a stated cadence or benefit is rejected.
- **Spells** require a rank and tradition. **Weapons** require a dice damage formula and damage type.

The module renders the effect, frequency, duration, trigger, and inline dice roll in the Item description. It uses PF2e item types for actions, spells, and weapons, so the resulting records are tangible Actor-sheet entries rather than prose-only notes.

## Gameplay-driven skill proposals

The module can build a **pending** skill proposal from demonstrated, tagged gameplay. This is intentionally GM-approved: it records what happened but never grants a new ability automatically.

```js
const api = game.modules.get("grand-design-ai").api;
const result = await api.recordGrowthEvent(actor, {
  summary: "Mera crossed a flooded rope line to rescue a trapped resident.",
  tags: ["mobility", "water"],
  outcome: "success"
});

// After three successful events with both tags:
await api.approveSkillProposal(actor, "proposal:canal-step");
```

Each event is stored in `flags.grand-design-ai.growthEvents`; generated drafts are stored in `flags.grand-design-ai.growthProposals` with their exact evidence IDs. The first proposal templates cover water mobility, crafting support, precision martial play, and fire spellcasting. Every draft still passes the same mechanics validator before it can create an Item.

## Tags, lineage, and evolution

Every approved Class or Skill gets a stable registry ID, tags, and a lineage record in `flags.grand-design-ai.registry`. The same metadata is attached to its Actor Item. Tags such as `mobility`, `fire`, `support`, or `martial` make later review and combination traceable.

The module API exposes GM-only paths for `combineSkills`, `upgradeSkill`, and `upgradeClass`. A combine operation must list two existing registry IDs; an upgrade must list exactly one. Both preserve source links, inherit all source tags, and create a new approved Actor Item. This keeps the original entries intact and records the rationale for the evolution.

```js
const api = game.modules.get("grand-design-ai").api;
await api.combineSkills(actor, {
  name: "Steam Step",
  tier: 3,
  pf2e_equivalent: "Narrative-milestone-gated custom ability",
  metadata: {
    tags: ["mobility", "steam"],
    lineage: {
      operation: "combine",
      sources: ["skill:ember-step", "skill:mist-step"],
      rationale: "The character mastered both travel techniques."
    }
  }
});
```

## Acceptance campaign

[`TEST_SCENARIO.md`](TEST_SCENARIO.md) contains **The First Steam**, a complete programmatic PF2e test campaign. It creates tagged Actors, a Scene, a Journal Entry, and a Macro; imports and combines skills; verifies tags, lineage, idempotency, and map configuration; then returns a pass/fail report. It also provides a targeted cleanup command that removes only documents it created.

## Map scaffold

`assets\atlas\grand-design-atlas.svg` is an original, scalable campaign atlas. Configure its path in **Configure Settings > Grand Design AI** or replace it with a map asset that you are licensed to use. See [`../world-map.md`](../world-map.md) for scene setup.

The built-in atlas path is local to Foundry: `modules/grand-design-ai/assets/atlas/grand-design-atlas.svg`. Version 0.10.0 automatically migrates the older GitHub URL setting, which browsers block under CORS.

Do not upload or distribute a derivative canonical map unless you have the right to do so.
