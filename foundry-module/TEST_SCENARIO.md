# The First Steam: Programmatic Foundry Acceptance Campaign

This isolated acceptance scenario verifies the entire Grand Design Foundry workflow inside a real PF2e world.

## Run it

As GM, create a Foundry Macro with this command:

```js
const report = await game.modules.get("grand-design-ai").api.runTestScenario();
console.table(report);
```

The macro creates only documents marked with `flags.grand-design-ai.testScenario`:

- `GD Test - Ari of the Lantern Canal`, a PF2e character with one Class and two Skills
- `GD Test - Warden of Lantern Crossing`, a control Actor
- `GD Test - Lantern Crossing`, a gridless scene using the configured atlas asset
- `GD Test - Scenario Briefing`, a Journal Entry
- `GD Test - Run The First Steam`, a reusable macro

It then automatically imports the conversion, combines `[Ember Step]` and `[Mist Step]` into `[Steam Step]`, checks inherited tags and source IDs, and re-imports the original conversion to prove that feature items are not duplicated.

## Expected result

The returned report has `ok: true`, **10 passed**, and **0 failed**. The Actor sheet has four Grand Design feature Items: one Class, two original Skills, and one combined Skill.

## Cleanup

Run this GM-only macro to delete only the tagged test documents:

```js
await game.modules.get("grand-design-ai").api.clearTestScenario();
```

The cleanup never deletes actors, scenes, journals, or macros without the module's explicit test flag.
