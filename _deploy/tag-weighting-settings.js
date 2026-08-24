// Dynamic tag reweighting's actual Foundry settings surface: a world-scoped setting storing a GM-
// edited {tag: multiplier} JSON map, plus a settings-menu FormApplication to edit it without
// touching code. The math itself lives in tag-weighting.js (fully Foundry-independent, unit
// tested); this file is the Foundry-only wiring, imported ONLY from main.js -- exactly the same
// split ai-provider-config.js already established, and for the same reason: `class ... extends
// FormApplication` below would throw at import time in the plain-Node test suite, where
// FormApplication doesn't exist. api.js never imports this file directly; main.js wires the two
// together via GrandDesignApi#setTagWeightsProvider, the same pluggable-adapter pattern already
// used for setProposalAdapter/setPopulateAdapter.
import { MODULE_ID } from "./constants.js";
import { normalizeTagWeights, setTagWeight, removeTagWeight } from "./tag-weighting.js";

const SETTING_KEY = "tagWeights";

export function registerTagWeightingSettings() {
  game.settings.register(MODULE_ID, SETTING_KEY, {
    scope: "world",
    config: false,
    type: String,
    default: "{}"
  });
  game.settings.registerMenu(MODULE_ID, "tagWeightingSetup", {
    name: "Tag Reweighting",
    label: "Configure Tag Reweighting",
    hint: "Reassign how much a growth-event tag counts as evidence toward a Skill proposal -- canon's Isthekenous dynamically repatches which tags grant which XP over time.",
    icon: "fas fa-sliders-h",
    type: TagWeightingSettings,
    restricted: true
  });
}

/**
 * Reads the GM-configured tag-weight overrides from the world setting. Safe to call even outside
 * a full Foundry environment -- returns {} (every tag at its default 1x) if `game`/`game.settings`
 * isn't available, or if the stored JSON is somehow malformed, rather than throwing.
 */
export function getConfiguredTagWeights() {
  if (typeof game === "undefined" || !game?.settings?.get) return {};
  try {
    return normalizeTagWeights(JSON.parse(game.settings.get(MODULE_ID, SETTING_KEY) || "{}"));
  } catch (error) {
    console.warn(`${MODULE_ID} | failed to parse the tag-weighting setting`, error);
    return {};
  }
}

async function persistTagWeights(next) {
  await game.settings.set(MODULE_ID, SETTING_KEY, JSON.stringify(next));
  return next;
}

class TagWeightingSettings extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      title: "Grand Design Tag Reweighting",
      id: "grand-design-ai-tag-weighting",
      template: null,
      width: 480
    });
  }

  getData() {
    return { tagWeights: getConfiguredTagWeights() };
  }

  async _renderInner() {
    const { tagWeights } = this.getData();
    const rows = Object.entries(tagWeights)
      .map(([tag, multiplier]) => `<div class="form-group"><label>${escapeHtml(tag)}</label>
        <input type="number" step="0.1" min="0" name="multiplier__${escapeHtml(tag)}" value="${multiplier}">
        <label><input type="checkbox" name="remove__${escapeHtml(tag)}"> remove</label></div>`)
      .join("");
    return $(`<form>
      <p>Reassign how strongly a growth-event tag counts as evidence toward a Skill proposal. A tag with no override here always weighs 1x. Set a multiplier above 1 to make a tag count for more, below 1 (down to 0) to make it count for less.</p>
      ${rows || "<p><em>No tags currently reweighted.</em></p>"}
      <div class="form-group"><label>Add/update a tag</label>
        <input type="text" name="newTag" placeholder="e.g. mobility">
        <input type="number" step="0.1" min="0" name="newMultiplier" placeholder="e.g. 1.5">
      </div>
      <footer class="sheet-footer flexrow"><button type="submit"><i class="fas fa-save"></i> Save</button></footer>
    </form>`);
  }

  async _updateObject(_event, formData) {
    let tagWeights = getConfiguredTagWeights();
    for (const [key, value] of Object.entries(formData)) {
      if (key.startsWith("remove__") && value) {
        tagWeights = removeTagWeight(tagWeights, key.slice("remove__".length));
      } else if (key.startsWith("multiplier__") && !formData[`remove__${key.slice("multiplier__".length)}`]) {
        const multiplier = Number(value);
        if (Number.isFinite(multiplier) && multiplier >= 0) {
          tagWeights = setTagWeight(tagWeights, key.slice("multiplier__".length), multiplier);
        }
      }
    }
    const newTag = String(formData.newTag ?? "").trim();
    const newMultiplier = Number(formData.newMultiplier);
    if (newTag && Number.isFinite(newMultiplier) && newMultiplier >= 0) {
      tagWeights = setTagWeight(tagWeights, newTag, newMultiplier);
    }
    await persistTagWeights(tagWeights);
    ui.notifications.info("Grand Design tag reweighting saved.");
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
