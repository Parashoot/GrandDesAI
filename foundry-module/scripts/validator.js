import { POWER_TIERS, SKILL_TIERS } from "./constants.js";

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
    if (!isNonEmptyString(skill.pf2e_equivalent)) {
      errors.push(`[${skill.name}] requires a PF2e equivalent or review note.`);
    }
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
