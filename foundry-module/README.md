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

The module validates the input, stores the approved record in `flags.grand-design-ai.conversion`, and emits the `grand-design-ai.conversionApplied` hook. On approval, it also adds each Class and Skill as an idempotent PF2e custom feature Item on the Actor sheet. The module never overwrites the Actor's core PF2e class; Grand Design Classes are stored as class-feature Items so their fictional progression can coexist with the normal PF2e chassis.

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

## Map scaffold

`assets\atlas\grand-design-atlas.svg` is an original, scalable campaign atlas. Configure its path in **Configure Settings > Grand Design AI** or replace it with a map asset that you are licensed to use. See [`../world-map.md`](../world-map.md) for scene setup.

Do not upload or distribute a derivative canonical map unless you have the right to do so.
