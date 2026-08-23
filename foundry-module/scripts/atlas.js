import { MODULE_ID } from "./constants.js";

export function defaultAtlasAssetPath() {
  return `modules/${MODULE_ID}/assets/atlas/grand-design-atlas.svg`;
}

export function resolveAtlasAssetPath(configuredPath) {
  if (typeof configuredPath !== "string" || !configuredPath.trim()) {
    return defaultAtlasAssetPath();
  }
  const path = configuredPath.trim();
  return isLegacyGithubAtlasPath(path) ? defaultAtlasAssetPath() : path;
}

export function isLegacyGithubAtlasPath(path) {
  return path.startsWith("https://github.com/Parashoot/GrandDesAI/assets/");
}

const SKETCH_MAP_COUNT = 5;

/** Large, hand-drawn pencil-sketch placeholder maps a GM can drop straight onto a scene. */
export function sketchMapAssetPaths() {
  return Array.from(
    { length: SKETCH_MAP_COUNT },
    (_, index) => `modules/${MODULE_ID}/assets/atlas/sketch-maps/sketch-map-${String(index + 1).padStart(2, "0")}.svg`
  );
}

/**
 * Picks one sketch-map asset per requested scene. Every scene gets a distinct map when the
 * pool is large enough; requests beyond the pool size wrap around and reuse earlier picks.
 * `random` is injectable so tests can make the selection deterministic.
 */
export function pickRandomSketchMapPaths(count, random = Math.random) {
  const pool = sketchMapAssetPaths();
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return Array.from({ length: count }, (_, index) => shuffled[index % shuffled.length]);
}
