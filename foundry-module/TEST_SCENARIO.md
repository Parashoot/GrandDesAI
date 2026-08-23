# The First Steam: Programmatic Foundry Test Campaign

This isolated three-act campaign verifies the Grand Design workflow inside a real PF2e world while creating a playable, original test adventure.

## Run it

As GM, create a Foundry Macro with this command:

```js
const report = await game.modules.get("grand-design-ai").api.runTestScenario();
console.table(report);
```

The macro creates only documents marked with `flags.grand-design-ai.testScenario`:

- Five original PF2e Actors: two player characters, one ally, and two escalating opposition Actors
- Three navigation Scenes: Lantern Crossing, the Siltworks, and the Steam Bell; each uses the atlas and has placed encounter tokens
- A three-page campaign journal, six-result Flood Encounter Oracle, and runner/cleanup macros

The story is structured as **Act I: evacuation**, **Act II: recovery**, and **Act III: a milestone finale**. It imports Ari's origin conversion, combines `[Ember Step]` and `[Mist Step]` into `[Steam Step]`, upgrades `[Canal Chef]` into `[Canal Hearthkeeper]`, then re-imports the origin conversion to prove idempotency. Every test Scene uses a black canvas background so a missing or unreachable atlas image never renders as Foundry's default tan/parchment color.

## Expected result

The returned report has `ok: true`, **34/34 passed**, and **0 failed**. It verifies complete passive, action, reaction, free-action, spell, and weapon mechanics, including tangible benefits, frequencies, triggers, PF2e item types, and inline dice rolls. It also proves that four successful gameplay events earn enough progression to resolve level 1 during a short rest before a generated Skill can be approved. Ari's Actor sheet has five Grand Design feature Items: the origin Class, two origin Skills, one combined Skill, and one upgraded Class. Mera's sheet verifies creation of both a PF2e spell Item and a PF2e weapon Item. The report's `atlas` object records the requested asset path, each persisted Scene source, and the module's live asset-load result.

## Cleanup

Run this GM-only macro to delete only the tagged test documents:

```js
await game.modules.get("grand-design-ai").api.clearTestScenario();
```

The cleanup never deletes actors, scenes, journals, or macros without the module's explicit test flag.
