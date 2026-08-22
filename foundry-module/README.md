# Grand Design AI Foundry VTT module

This module targets Foundry VTT 12-13 with the PF2e game system installed. It is a GM-facing bridge between Grand Design conversion records and PF2e Actors; it is not a replacement PF2e system.

## Install from GitHub

In Foundry's **Add-on Modules** screen, choose **Install Module** and paste:

```text
https://raw.githubusercontent.com/Parashoot/GrandDesAI/main/foundry-module/module.json
```

Foundry downloads the versioned module ZIP. For local development, use the manual option below.

## Install locally

1. Copy the `foundry-module` directory to Foundry's `Data\modules\grand-design-ai` directory.
2. Start a PF2e world, enable **Grand Design AI**, and reload the world.
3. Open a PF2e Actor sheet as GM and select **Grand Design** in the header.
4. Paste a conversion record such as the structure in `examples\innkeeper.json`. Add each Skill's `tier` and `pf2e_equivalent` before import.

The module validates the input, stores the approved record in `flags.grand-design-ai.conversion`, and emits the `grand-design-ai.conversionApplied` hook. Other modules can retrieve `game.modules.get("grand-design-ai").api` to validate, apply, journal, or read conversions.

## Map scaffold

`assets\atlas\grand-design-atlas.svg` is an original, scalable campaign atlas. Configure its path in **Configure Settings > Grand Design AI** or replace it with a map asset that you are licensed to use. See [`../world-map.md`](../world-map.md) for scene setup.

Do not upload or distribute a derivative canonical map unless you have the right to do so.
