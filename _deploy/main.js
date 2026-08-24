import { GrandDesignApi } from "./api.js";
import { defaultAtlasAssetPath, isLegacyGithubAtlasPath } from "./atlas.js";
import { MODULE_ID } from "./constants.js";
import { openGrowthManager } from "./growth-ui.js";
import { openPopulate, runPopulateAndAnnounce } from "./populate-ui.js";
import { createConfiguredAiAdapter, registerAiProviderSettings } from "./ai-provider-config.js";
import { registerTagWeightingSettings, getConfiguredTagWeights } from "./tag-weighting-settings.js";
import { isSupportedSystem, supportedSystemIds } from "./systems/index.js";

Hooks.once("init", () => {
  registerAiProviderSettings();
  registerTagWeightingSettings();
  game.settings.register(MODULE_ID, "atlasAssetPath", {
    name: "Grand Design Atlas Asset",
    hint: "Path to a licensed world-map image or SVG to use as the Foundry scene background.",
    scope: "world",
    config: true,
    type: String,
    default: defaultAtlasAssetPath()
  });
  game.settings.register(MODULE_ID, "runTestScenarioOnLaunch", {
    name: "Run Test Campaign on Launch",
    hint: "GM only. Automatically runs 'The First Steam' test campaign every time this world finishes loading. Intended for development machines, not live play.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
  game.modules.get(MODULE_ID).api = new GrandDesignApi();
  game.modules.get(MODULE_ID).api.setTagWeightsProvider(getConfiguredTagWeights);
});

Hooks.once("ready", async () => {
  const atlasAssetPath = game.settings.get(MODULE_ID, "atlasAssetPath");
  if (game.user.isGM && isLegacyGithubAtlasPath(atlasAssetPath)) {
    await game.settings.set(MODULE_ID, "atlasAssetPath", defaultAtlasAssetPath());
    ui.notifications.info("Grand Design AI migrated the atlas setting to Foundry's local module asset.");
  }
  if (!isSupportedSystem(game.system.id)) {
    ui.notifications.warn(
      `Grand Design AI is loaded outside a supported game system (supported: ${supportedSystemIds().join(", ")}); actor sync is disabled.`
    );
  }
  if (game.user.isGM) {
    try {
      const adapter = createConfiguredAiAdapter();
      if (adapter) game.modules.get(MODULE_ID).api.setProposalAdapter(adapter);
    } catch (error) {
      console.warn(`${MODULE_ID} | AI provider is not configured`, error);
    }
  }
  if (game.user.isGM && game.settings.get(MODULE_ID, "runTestScenarioOnLaunch")) {
    if (game.system.id !== "pf2e") {
      ui.notifications.warn("Grand Design AI cannot auto-run the test campaign outside the PF2e system.");
    } else {
      try {
        await game.modules.get(MODULE_ID).api.runTestScenario();
      } catch (error) {
        console.error(`${MODULE_ID} | automatic test campaign run failed`, error);
        ui.notifications.error("Grand Design AI's automatic test campaign run failed. See console for details.");
      }
    }
  }
});

// Legacy Application (V1) sheet header hook. Still relevant for any system/version whose actor
// sheets have not migrated off the V1 Application framework.
Hooks.on("getActorSheetHeaderButtons", (sheet, buttons) => {
  if (!game.user.isGM || !isSupportedSystem(game.system.id) || !sheet.actor) {
    return;
  }
  buttons.unshift({
    class: "grand-design-import",
    icon: "fas fa-sparkles",
    label: "Grand Design",
    onclick: () => openImporter(sheet.actor)
  });
  buttons.unshift({
    class: "grand-design-growth",
    icon: "fas fa-seedling",
    label: "Growth",
    onclick: () => openGrowthManager(sheet.actor)
  });
});

// The "ultimate InnWorld Companion" prompt box: a GM types a plain-language description ("a
// grizzled dwarven blacksmith, level 3", "3 goblin scouts", "a +1 flaming shortsword") and gets a
// real, ready-to-use Actor/Item back. Three independent entry points reach the same
// api.populate() pipeline so this is never gated on one specific Foundry UI surface behaving as
// expected on any given version: a Scene Controls tool button, a `/populate` chat command, and
// (always available regardless of either) direct console/macro access via
// game.modules.get("grand-design-ai").api.populate("...").
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM || !isSupportedSystem(game.system.id)) return;
  const tool = {
    name: "grand-design-populate",
    title: "Populate (Grand Design AI)",
    icon: "fa-solid fa-wand-magic-sparkles",
    button: true,
    onClick: () => openPopulate(),
    onChange: () => openPopulate()
  };
  if (Array.isArray(controls)) {
    // Foundry < 13: `controls` is an array of control groups, each with a `tools` array.
    const group = controls.find((candidate) => candidate.name === "token") ?? controls[0];
    group?.tools?.push(tool);
  } else if (controls && typeof controls === "object") {
    // Foundry >= 13 (ApplicationV2-era scene controls): `controls` is an object keyed by
    // control-group name, each with a `tools` object keyed by tool name rather than an array.
    const group = controls.tokens ?? controls.token ?? Object.values(controls)[0];
    if (group) {
      group.tools ??= {};
      group.tools[tool.name] = tool;
    }
  }
});

// `/populate <description>` chat command -- a robust fallback entry point independent of scene
// control rendering. `/populate` with no description opens the same Dialog box as the toolbar
// button, so a GM who never finds the toolbar icon can still reach the tool from chat alone.
Hooks.on("chatMessage", (_chatLog, message) => {
  if (!/^\/populate\b/i.test(message.trim())) return true;
  if (!game.user.isGM || !isSupportedSystem(game.system.id)) {
    ui.notifications.warn("Populate requires GM permissions on a supported game system (PF2e or dnd5e).");
    return false;
  }
  const prompt = message.trim().replace(/^\/populate\s*/i, "").trim();
  if (!prompt) {
    openPopulate();
  } else {
    runPopulateAndAnnounce(prompt);
  }
  return false;
});

// dnd5e's actor sheets (and any other system that has migrated, per Foundry's V13 ApplicationV2
// rollout) extend Foundry's own core ActorSheetV2 base class, not the legacy Application the hook
// above targets -- so "getActorSheetHeaderButtons" never fires for them and the buttons silently
// never appeared. ApplicationV2 has no Hooks-based extension point for header controls at all
// (_getHeaderControls() just reads a static this.options.window.controls array baked in at render
// time), so the only way in is to hook the render event and insert real header-control buttons into
// the DOM directly. "renderActorSheetV2" is that core base class's own hook name -- hooking it here
// (rather than a system-specific sheet class name) keeps this system-agnostic, matching the rest of
// the module, and was confirmed firing empirically against a live dnd5e 5.3.3 world.
Hooks.on("renderActorSheetV2", (sheet, element) => {
  if (!game.user.isGM || !isSupportedSystem(game.system.id) || !sheet.actor) {
    return;
  }
  const header = element?.querySelector?.(".window-header");
  if (!header || header.querySelector(".grand-design-growth")) {
    return; // Already inserted on an earlier render pass of this same sheet instance.
  }
  const anchor = header.querySelector(".header-control");
  const importButton = buildHeaderControlButton("grand-design-import", "fa-solid fa-sparkles", "Grand Design", () => openImporter(sheet.actor));
  const growthButton = buildHeaderControlButton("grand-design-growth", "fa-solid fa-seedling", "Growth", () => openGrowthManager(sheet.actor));
  if (anchor) anchor.before(importButton, growthButton);
  else header.append(importButton, growthButton);
});

// ApplicationV2 header controls are icon-only (no room for a visible label like V1's), so the
// button's accessible name/tooltip carries what the V1 button's `label` used to show.
function buildHeaderControlButton(className, iconClass, tooltip, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `header-control icon ${iconClass} ${className}`;
  button.dataset.tooltip = tooltip;
  button.setAttribute("aria-label", tooltip);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    onClick();
  });
  return button;
}

function openImporter(actor) {
  new Dialog({
    title: "Apply Grand Design Conversion",
    content: `<form class="grand-design-conversion"><div class="form-group stacked"><label>Conversion JSON</label><textarea name="conversion" rows="16" placeholder='{"character":"Name","classes":[...],"skills":[...]}'></textarea></div></form>`,
    buttons: {
      apply: {
        icon: '<i class="fas fa-check"></i>',
        label: "Validate and Apply",
        callback: async (html) => {
          const source = html.find('textarea[name="conversion"]').val();
          let payload;
          try {
            payload = JSON.parse(source);
          } catch {
            ui.notifications.error("The conversion input is not valid JSON.");
            return;
          }
          const api = game.modules.get(MODULE_ID).api;
          const validation = api.validate(payload);
          if (!validation.valid) {
            ui.notifications.error(validation.errors.join(" "));
            return;
          }
          try {
            await api.applyToActor(actor, payload);
            ui.notifications.info(`Applied Grand Design conversion to ${actor.name}.`);
          } catch (error) {
            console.error(`${MODULE_ID} | conversion import failed`, error);
            ui.notifications.error(error.message);
          }
        }
      },
      cancel: {
        icon: '<i class="fas fa-times"></i>',
        label: "Cancel"
      }
    },
    default: "apply"
  }).render(true);
}
