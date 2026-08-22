import { GrandDesignApi } from "./api.js";
import { MODULE_ID } from "./constants.js";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "atlasAssetPath", {
    name: "Grand Design Atlas Asset",
    hint: "Path to a licensed world-map image or SVG to use as the Foundry scene background.",
    scope: "world",
    config: true,
    type: String,
    default: `modules/${MODULE_ID}/assets/atlas/grand-design-atlas.svg`
  });
  game.modules.get(MODULE_ID).api = new GrandDesignApi();
});

Hooks.once("ready", () => {
  if (game.system.id !== "pf2e") {
    ui.notifications.warn("Grand Design AI is loaded outside the PF2e system; actor sync is disabled.");
  }
});

Hooks.on("getActorSheetHeaderButtons", (sheet, buttons) => {
  if (!game.user.isGM || game.system.id !== "pf2e" || !sheet.actor) {
    return;
  }
  buttons.unshift({
    class: "grand-design-import",
    icon: "fas fa-sparkles",
    label: "Grand Design",
    onclick: () => openImporter(sheet.actor)
  });
});

function openImporter(actor) {
  new Dialog({
    title: "Apply Grand Design Conversion",
    content: `<form><div class="form-group stacked"><label>Conversion JSON</label><textarea name="conversion" rows="16" placeholder='{"character":"Name","classes":[...],"skills":[...]}'></textarea></div></form>`,
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
