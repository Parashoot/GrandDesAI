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
