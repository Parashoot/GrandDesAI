import { MODULE_ID } from "./constants.js";

export function defaultAtlasAssetPath() {
  return `${game.modules.get(MODULE_ID)?.url ?? `modules/${MODULE_ID}`}/assets/atlas/grand-design-atlas.svg`;
}
