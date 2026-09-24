// Emergent themes' Foundry settings surface (AI gateway v2, 2026-09-23): the world-scoped
// `emergentThemes` setting (JSON: { themes: { slug: { count, label, firstSeen, mapTo?, mergeInto?,
// ignored? } } }) plus a settings-menu FormApplication where the GM renames a theme, merges it into
// another, maps it onto a canonical tag, or ignores it. All the logic lives in emergent-themes.js
// (pure, unit-tested); this file is Foundry-only wiring, imported ONLY from main.js -- the same split
// tag-weighting-settings.js uses. The FormApplication subclass is created lazily inside
// registerEmergentThemeSettings() so importing this file in plain Node never touches
// FormApplication.
import { MODULE_ID } from "./constants.js";
import { GROWTH_TAXONOMY } from "./growth-taxonomy.js";
import { listThemes, normalizeEmergentThemeState, setThemeMapping, titleCaseTheme } from "./emergent-themes.js";

export const EMERGENT_THEMES_SETTING = "emergentThemes";

export function registerEmergentThemeSettings() {
  game.settings.register(MODULE_ID, EMERGENT_THEMES_SETTING, {
    scope: "world",
    config: false,
    type: String,
    default: JSON.stringify({ themes: {} })
  });
  game.settings.registerMenu(MODULE_ID, "emergentThemesSetup", {
    name: "Emergent Themes",
    label: "Review Emergent Themes",
    hint: "Activities the tag list never anticipated (beekeeping, gambling, map-making...) that the AI has seen your players do. Rename, merge, map onto a gameplay tag, or ignore them.",
    icon: "fas fa-seedling",
    type: buildEmergentThemesSettingsClass(),
    restricted: true
  });
}

/** The store api.js#setEmergentThemeStore expects, backed by the world setting. */
export function createEmergentThemeStore() {
  return {
    get() {
      if (typeof game === "undefined" || !game?.settings?.get) return { themes: {} };
      try {
        return normalizeEmergentThemeState(game.settings.get(MODULE_ID, EMERGENT_THEMES_SETTING));
      } catch (error) {
        console.warn(`${MODULE_ID} | failed to read the emergent-themes setting`, error);
        return { themes: {} };
      }
    },
    async set(state) {
      // World settings are GM-writable only; a player client silently keeps its local view.
      if (!game?.user?.isGM) return;
      await game.settings.set(MODULE_ID, EMERGENT_THEMES_SETTING, JSON.stringify(normalizeEmergentThemeState(state)));
    }
  };
}

function buildEmergentThemesSettingsClass() {
  return class EmergentThemesSettings extends FormApplication {
    static get defaultOptions() {
      return foundry.utils.mergeObject(super.defaultOptions, {
        title: "Grand Design: Emergent Themes",
        id: "grand-design-ai-emergent-themes",
        classes: ["grand-design-emergent-themes"],
        template: null,
        width: 760,
        height: "auto",
        resizable: true
      });
    }

    getData() {
      return { themes: listThemes(createEmergentThemeStore().get()) };
    }

    async _renderInner() {
      const { themes } = this.getData();
      const tagOptions = (selected) =>
        ['<option value="">—</option>', ...GROWTH_TAXONOMY.map(([tag]) => `<option value="${tag}" ${tag === selected ? "selected" : ""}>${tag}</option>`)].join("");
      const mergeOptions = (self, selected) =>
        ['<option value="">—</option>', ...themes.filter((theme) => theme.slug !== self).map((theme) => `<option value="${escapeHtml(theme.slug)}" ${theme.slug === selected ? "selected" : ""}>${escapeHtml(theme.label)}</option>`)].join("");
      const rows = themes
        .map((theme) => `<tr class="${theme.ignored ? "gd-ignored" : ""}">
          <td><span class="gd-slug">${escapeHtml(theme.slug)}</span><br><small>seen ${theme.count}×${theme.firstSeen ? ` since ${escapeHtml(new Date(theme.firstSeen).toLocaleDateString())}` : ""}</small></td>
          <td><input type="text" name="label__${escapeHtml(theme.slug)}" value="${escapeHtml(theme.label)}" placeholder="${escapeHtml(titleCaseTheme(theme.slug))}"></td>
          <td><select name="mergeInto__${escapeHtml(theme.slug)}">${mergeOptions(theme.slug, theme.mergeInto)}</select></td>
          <td><select name="mapTo__${escapeHtml(theme.slug)}">${tagOptions(theme.mapTo)}</select></td>
          <td style="text-align:center"><input type="checkbox" name="ignored__${escapeHtml(theme.slug)}" ${theme.ignored ? "checked" : ""}></td>
        </tr>`)
        .join("");
      return $(`<form>
        <p>Every activity the AI noticed that the fixed gameplay-tag list doesn't cover shows up here. Themes practiced often enough become placeholder Skill proposals in the Growth dialog ("<em>Beekeeping Knack</em>") that you can have the AI author properly.</p>
        <p class="notes"><strong>Rename</strong> changes how it reads everywhere. <strong>Merge into</strong> counts it as another theme (e.g. "bee-keeping" → "beekeeping"). <strong>Map to tag</strong> turns it into ordinary evidence for a gameplay tag instead. <strong>Ignore</strong> stops it counting at all. Nothing is ever deleted from recorded events, so every choice is reversible.</p>
        ${themes.length
          ? `<table><thead><tr><th>Theme</th><th>Label</th><th>Merge into</th><th>Map to tag</th><th>Ignore</th></tr></thead><tbody>${rows}</tbody></table>`
          : "<p><em>No emergent themes seen yet. They appear after the AI reads notes about something the tag list doesn't cover.</em></p>"}
        <footer class="sheet-footer flexrow"><button type="submit"><i class="fas fa-save"></i> Save</button></footer>
      </form>`);
    }

    async _updateObject(_event, formData) {
      const store = createEmergentThemeStore();
      let state = store.get();
      const errors = [];
      for (const theme of listThemes(state)) {
        const slug = theme.slug;
        const mapping = {
          label: String(formData[`label__${slug}`] ?? "").trim() || undefined,
          mergeInto: String(formData[`mergeInto__${slug}`] ?? "").trim() || undefined,
          mapTo: String(formData[`mapTo__${slug}`] ?? "").trim() || undefined,
          ignored: Boolean(formData[`ignored__${slug}`])
        };
        try {
          state = setThemeMapping(state, slug, mapping);
        } catch (error) {
          errors.push(`${slug}: ${error.message}`);
        }
      }
      await store.set(state);
      if (errors.length) ui.notifications.warn(`Some theme changes were not saved: ${errors.join(" | ")}`);
      else ui.notifications.info("Grand Design emergent themes saved.");
    }
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
