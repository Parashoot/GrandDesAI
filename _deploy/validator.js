import { ENTRY_POLARITIES, LINEAGE_OPERATIONS, POWER_TIERS, SKILL_TIERS, TITLE_GRANT_KEYS } from "./constants.js";
import { validateMechanics } from "./mechanics.js";
import { VICE_TAGS } from "./vice-taxonomy.js";

export function validateConversion(payload) {
  const errors = [];

  if (!isRecord(payload)) {
    return { valid: false, errors: ["Conversion payload must be a JSON object."] };
  }
  if (!isNonEmptyString(payload.character)) {
    errors.push("character is required.");
  }
  if (!Array.isArray(payload.classes) || payload.classes.length === 0) {
    errors.push("At least one Class is required.");
  } else {
    validateClasses(payload.classes, errors);
  }
  if (payload.skills !== undefined) {
    if (!Array.isArray(payload.skills)) {
      errors.push("skills must be an array when present.");
    } else {
      validateSkills(payload.skills, errors);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateClassEntry(entry) {
  const errors = [];
  validateClasses([entry], errors);
  return { valid: errors.length === 0, errors };
}

export function validateSkillEntry(entry) {
  const errors = [];
  validateSkills([entry], errors);
  return { valid: errors.length === 0, errors };
}

// Titles (see lineage.js#createTitleSource, api.js#grantTitle) are a badge earned for a specific
// narrative achievement, not a usable ability -- so unlike Classes/Skills they carry no
// gameItem/mechanics and are never validated through validateMechanics. What they do require is
// the achievement text itself, and (when present) a well-formed `grants` bundle: at most one each
// of a Skill (validated as a real skill entry, cascaded into its own Item by api.js), a flavor
// Item, a reputation note, and a passive Condition.
export function validateTitleEntry(entry) {
  const errors = [];
  if (!isRecord(entry) || !isNonEmptyString(entry.name)) {
    errors.push("Every Title requires a name.");
    return { valid: false, errors };
  }
  if (!isNonEmptyString(entry.achievement)) {
    errors.push(`[${entry.name}] requires an achievement describing the specific deed that earned it.`);
  }
  validateMetadata(entry.metadata, entry.name, errors);
  if (entry.grants !== undefined) {
    validateTitleGrants(entry.grants, entry.name, errors);
  }
  return { valid: errors.length === 0, errors };
}

function validateTitleGrants(grants, name, errors) {
  if (!isRecord(grants)) {
    errors.push(`[${name}] grants must be an object when present.`);
    return;
  }
  for (const key of Object.keys(grants)) {
    if (!TITLE_GRANT_KEYS.has(key)) {
      errors.push(`[${name}] grants has an unrecognized key "${key}" (allowed: ${[...TITLE_GRANT_KEYS].join(", ")}).`);
    }
  }
  if (grants.skillEntry != null) {
    const skillValidation = validateSkillEntry(grants.skillEntry);
    if (!skillValidation.valid) {
      errors.push(`[${name}] grants.skillEntry is invalid: ${skillValidation.errors.join(" ")}`);
    }
  }
  if (grants.itemGrant != null) {
    if (!isRecord(grants.itemGrant) || !isNonEmptyString(grants.itemGrant.name) || !isNonEmptyString(grants.itemGrant.description)) {
      errors.push(`[${name}] grants.itemGrant requires a name and a description.`);
    }
  }
  if (grants.reputation != null && !isNonEmptyString(grants.reputation)) {
    errors.push(`[${name}] grants.reputation must be non-empty text when present.`);
  }
  if (grants.condition != null) {
    if (!isRecord(grants.condition) || !isNonEmptyString(grants.condition.name) || !isNonEmptyString(grants.condition.description)) {
      errors.push(`[${name}] grants.condition requires a name and a description.`);
    }
  }
}

function validateClasses(classes, errors) {
  let primaryCount = 0;
  let secondaryCount = 0;

  for (const entry of classes) {
    if (!isRecord(entry) || !isNonEmptyString(entry.name)) {
      errors.push("Every Class requires a name.");
      continue;
    }
    if (!Number.isInteger(entry.level) || entry.level < 1) {
      errors.push(`[${entry.name}] requires an integer level of at least 1.`);
    }
    if (!POWER_TIERS.has(entry.power_tier)) {
      errors.push(`[${entry.name}] requires a standard, elevated, or prestige power tier.`);
    }
    validateMetadata(entry.metadata, entry.name, errors);
    validateMechanics(entry, errors);
    primaryCount += entry.is_primary === true ? 1 : 0;
    secondaryCount += entry.is_secondary === true ? 1 : 0;
    if (entry.is_primary === true && entry.is_secondary === true) {
      errors.push(`[${entry.name}] cannot be both primary and secondary.`);
    }
  }
  if (primaryCount > 1) {
    errors.push("Only one Class can be primary.");
  }
  if (secondaryCount > 1) {
    errors.push("Only one Class can be secondary.");
  }
}

function validateSkills(skills, errors) {
  for (const skill of skills) {
    if (!isRecord(skill) || !isNonEmptyString(skill.name)) {
      errors.push("Every Skill requires a name.");
      continue;
    }
    if (!SKILL_TIERS.has(skill.tier)) {
      errors.push(`[${skill.name}] requires a tier from 1 to 3.`);
    }
    if (!isNonEmptyString(skill.system_equivalent)) {
      errors.push(`[${skill.name}] requires a PF2e equivalent or review note.`);
    }
    validateMetadata(skill.metadata, skill.name, errors);
    validateMechanics(skill, errors);
  }
}

function validateMetadata(metadata, name, errors) {
  if (metadata === undefined) {
    return;
  }
  if (!isRecord(metadata)) {
    errors.push(`[${name}] metadata must be an object.`);
    return;
  }
  if (metadata.tags !== undefined && (!Array.isArray(metadata.tags) || metadata.tags.some((tag) => !isNonEmptyString(tag)))) {
    errors.push(`[${name}] metadata.tags must contain non-empty strings.`);
  }
  if (metadata.polarity !== undefined && !ENTRY_POLARITIES.has(metadata.polarity)) {
    errors.push(`[${name}] metadata.polarity must be "standard" or "red".`);
  }
  // A "red" entry (see vice-taxonomy.js) must state a concrete cost -- otherwise it's just a
  // standard entry with a dark name, not an actual taboo/debuffing one. This is what stops red
  // polarity from being cosmetic: the vice must be one of the closed, abstracted taxonomy tags,
  // and the drawback must be a real stated cost, not left implicit.
  if (metadata.polarity === "red") {
    const malignance = metadata.malignance;
    if (!isRecord(malignance) || !isNonEmptyString(malignance.vice) || !isNonEmptyString(malignance.drawback)) {
      errors.push(`[${name}] red entries require metadata.malignance.vice and metadata.malignance.drawback.`);
    } else if (!VICE_TAGS.has(malignance.vice)) {
      errors.push(`[${name}] metadata.malignance.vice must be one of: ${[...VICE_TAGS].join(", ")}.`);
    }
  }
  if (metadata.lineage !== undefined) {
    if (!isRecord(metadata.lineage)) {
      errors.push(`[${name}] metadata.lineage must be an object.`);
      return;
    }
    if (metadata.lineage.operation !== undefined && !LINEAGE_OPERATIONS.has(metadata.lineage.operation)) {
      errors.push(`[${name}] has an unsupported lineage operation.`);
    }
    if (metadata.lineage.sources !== undefined && (!Array.isArray(metadata.lineage.sources) || metadata.lineage.sources.some((source) => !isNonEmptyString(source)))) {
      errors.push(`[${name}] metadata.lineage.sources must contain registry IDs.`);
    }
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
