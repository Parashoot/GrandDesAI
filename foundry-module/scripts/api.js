import { ACTOR_FLAG, MODULE_ID } from "./constants.js";
import { validateConversion } from "./validator.js";

export class GrandDesignApi {
  validate(payload) {
    return validateConversion(payload);
  }

  async applyToActor(actor, payload) {
    this.#assertPf2eActor(actor);
    this.#assertGm();

    const result = validateConversion(payload);
    if (!result.valid) {
      throw new Error(`Grand Design conversion is invalid: ${result.errors.join(" ")}`);
    }
    const normalized = {
      character: payload.character.trim(),
      classes: payload.classes.map((entry) => ({ ...entry })),
      skills: (payload.skills ?? []).map((entry) => ({ ...entry })),
      source: "grand-design-ai",
      updatedAt: new Date().toISOString()
    };
    await actor.update({ [`flags.${MODULE_ID}.${ACTOR_FLAG}`]: normalized });
    Hooks.callAll("grand-design-ai.conversionApplied", actor, normalized);
    return normalized;
  }

  async createConversionJournal(payload) {
    this.#assertGm();
    const result = validateConversion(payload);
    if (!result.valid) {
      throw new Error(`Grand Design conversion is invalid: ${result.errors.join(" ")}`);
    }
    return JournalEntry.create({
      name: `Grand Design: ${payload.character}`,
      pages: [
        {
          name: "Conversion",
          type: "text",
          text: {
            content: renderConversionHtml(payload),
            format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML
          }
        }
      ]
    });
  }

  getActorConversion(actor) {
    return actor?.getFlag(MODULE_ID, ACTOR_FLAG) ?? null;
  }

  #assertGm() {
    if (!game.user?.isGM) {
      throw new Error("Only a GM can apply or publish Grand Design conversions.");
    }
  }

  #assertPf2eActor(actor) {
    if (game.system.id !== "pf2e") {
      throw new Error("Grand Design AI requires the PF2e game system.");
    }
    if (!actor?.documentName || actor.documentName !== "Actor") {
      throw new Error("A Foundry Actor is required.");
    }
  }
}

function renderConversionHtml(payload) {
  const classes = payload.classes
    .map((entry) => `<li>[${escapeHtml(entry.name)}] level ${entry.level} (${escapeHtml(entry.power_tier)})</li>`)
    .join("");
  const skills = (payload.skills ?? [])
    .map(
      (entry) =>
        `<li>[${escapeHtml(entry.name)}] - Tier ${entry.tier} - ${escapeHtml(entry.pf2e_equivalent)}</li>`
    )
    .join("");
  return `<h2>${escapeHtml(payload.character)}</h2><h3>Book Classes</h3><ul>${classes}</ul><h3>Skills</h3><ul>${skills}</ul>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
