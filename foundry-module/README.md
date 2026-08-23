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

## Fast local deployment

For this development machine, do not wait for Foundry's module updater after a Git push. From `foundry-module`, run:

```powershell
npm run deploy:foundry
```

This mirrors the checked-out module directly into `C:\Users\parez\AppData\Local\FoundryVTT\Data\modules\grand-design-ai`, verifies that the deployed `module.json` version matches the source, and excludes development-only `node_modules` and `.git` directories. Then reload the active Foundry world (for example, **F5**); there is no need to return to Setup or use **Update**. The deployment target can be changed with:

```powershell
..\tools\deploy-foundry-module.ps1 -Destination "D:\Foundry\Data\modules\grand-design-ai"
```

Campaign runs also save their latest machine-readable report to `C:\Users\parez\AppData\Local\FoundryVTT\Data\grand-design-ai-reports\last-test-report.json`. Read it outside Foundry with:

```powershell
..\tools\read-foundry-test-report.ps1
```

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

The Actor sheet now has a GM-only **Growth** button. Paste session notes, review the tagged evidence and pending drafts, then choose **Approve Selected** to add a draft to the sheet. No console commands are required for normal use.

## Grand Design levels (0-100)

Grand Design progression is separate from PF2e's 1-20 level. Every successful recorded event adds progression (25 for a success, 40 for a critical success), while the amount required for the next level increases quadratically from 100 at level 0 through the level-100 cap.

- Levels resolve only through the Growth dialog's **Resolve Rest** button after a short or long rest. The GM API can mark an exceptional immediate resolution as `dire: true`.
- Each resolved level creates one pending-entry grant allowance. A generated Skill, feat, action, spell, weapon, or other validated entry consumes an allowance when the GM approves it. Evidence may be recorded at any time; it never grants an Item by itself.
- Generated Class creation, upgrade, or merge is additionally gated to Grand Design levels **20, 30, and 50**. The initial conversion import remains character setup, not a progression grant.

The exact current Grand Design level, accumulated progression, available grant allowances, and latest resolved rest are stored per Actor in `flags.grand-design-ai.levelProgression`.

## AI provider setup (local first)

The built-in note analyzer is always available and sends nothing off the computer. AI generation is opt-in and starts **disabled**. As a GM, open **Configure Settings → Grand Design AI → Configure AI Provider** and choose one of these OpenAI-compatible chat-completions providers:

1. **Recommended: Ollama local server.** Install [Ollama for Windows](https://docs.ollama.com/windows), then in PowerShell run `ollama pull mistral-small3.1:24b`. Select **Local Ollama**, leaving the default endpoint `http://127.0.0.1:11434/v1/chat/completions` and model `mistral-small3.1:24b`. This 24B model is the default because it is particularly strong at mechanically complete, structured drafts on a 24 GB-class GPU.
2. **Lower-footprint local model:** pull/select `qwen3:14b` in Ollama and replace the model field. Qwen3 14B is the practical quality/speed balance when the larger Mistral model is not comfortable. Use its non-thinking mode for cleaner JSON.
3. **GUI local option: LM Studio.** Start its local server, select **Local OpenAI-compatible server**, and use `http://127.0.0.1:1234/v1/chat/completions` plus the loaded model ID. Use a model of at least 7B parameters for reliable structured output.
4. **Hosted bring-your-own provider:** select **Hosted OpenAI-compatible API**, enter that provider's HTTPS chat-completions endpoint, model ID, and API key. [OpenRouter](https://openrouter.ai/docs/api-reference/overview) and OpenAI-compatible providers work with this shape. Create and fund/enable API access with the provider; a consumer chat subscription does not necessarily include API usage.

The API key field is intentionally password-masked and **client-scoped**: it stays in the configuring Foundry browser profile, is not saved in world data, and is never shared with players. It is not a hardware-backed secret vault; use a restricted local user profile and revoke/rotate a key if that profile is compromised. Remote endpoints must use HTTPS; plain HTTP is accepted only for `localhost` or `127.0.0.1`.

For predictable structured JSON, use a low temperature (the module uses 0.2), retain GM approval, and test a few notes before live play. The module asks the AI only for events and pending proposals; it validates every returned Class/Skill and cannot let the provider directly create an Item.
It supplies the current Grand Design level and available grant allowances, constrains output to the module taxonomy, and requires an explicit `{ events, proposals }` JSON envelope. Insufficient evidence should produce empty arrays rather than invented mechanics.

## Session-note model adapter

Use `analyzeSessionNotes(actor, notes)` to turn session prose into the same validated growth-event pipeline. The built-in local analyzer recognizes demonstrated water/mobility, crafting/support, martial/precision, and fire/spellcasting behavior only when the prose also signals success.

An AI integration can register a function with `setProposalAdapter(async ({ actor, notes }) => ({ events, proposals }))`. A proposal can be a `skill` or `class`, but it must use the same complete PF2e mechanics schema as a manual entry. The adapter is never given permission to create Items: returned events and proposals are validated, duplicates are rejected, and a GM must explicitly approve each proposal.

For a custom HTTPS JSON gateway, register it from a GM macro or a companion module:

```js
game.modules.get("grand-design-ai").api.setAiGateway({
  endpoint: "https://your-approved-ai-gateway.example/propose",
  getHeaders: () => ({ Authorization: "Bearer YOUR_GATEWAY_TOKEN" })
});
```

The module sends structured notes, actor context, allowed tags, and the required output schema. It does not store credentials or make any external request until a GM explicitly registers a gateway. Keep provider credentials and external note-sharing decisions outside this module.

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

`assets\atlas\sketch-maps\` ships five additional original, large (2048x1152) hand-drawn pencil-sketch placeholder maps (`sketch-map-01.svg` through `sketch-map-05.svg`), generated with `tools\generate-sketch-maps.mjs`. Each has unlabeled coastlines, rivers, mountains, forests, and a compass rose so a GM can relabel it freely for any biome. The programmatic test campaign (`TEST_SCENARIO.md`) randomly assigns a distinct one of these to each of its three Scenes on every run, unless the GM has configured a custom **Grand Design Atlas Asset**, in which case all Scenes use that image instead.

Do not upload or distribute a derivative canonical map unless you have the right to do so.
