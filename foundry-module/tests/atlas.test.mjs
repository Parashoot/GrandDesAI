import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultAtlasAssetPath,
  isLegacyGithubAtlasPath,
  resolveAtlasAssetPath
} from "../scripts/atlas.js";

test("atlas default always points to the local Foundry module route", () => {
  assert.equal(
    defaultAtlasAssetPath(),
    "modules/grand-design-ai/assets/atlas/grand-design-atlas.svg"
  );
});

test("legacy GitHub atlas setting migrates to the local module route", () => {
  const legacy = "https://github.com/Parashoot/GrandDesAI/assets/atlas/grand-design-atlas.svg";

  assert.equal(isLegacyGithubAtlasPath(legacy), true);
  assert.equal(resolveAtlasAssetPath(legacy), defaultAtlasAssetPath());
});
