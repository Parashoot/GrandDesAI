import { ENTRY_POLARITIES, LINEAGE_OPERATIONS, POWER_TIERS, SKILL_TIERS, TITLE_GRANT_KEYS } from "./constants.js";
import { pf2eLevelBasedDc, proficiencyForLevel5e, validateMechanics } from "./mechanics.js";
import { diceFormula, readStructured } from "./systems/structured.js";
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

// ---------------------------------------------------------------------------------------------
// Structured mechanics budget (batch-3 contract section 2). The model writes numbers; this keeps
// them inside what a Skill of that tier should do for a character of that level, and says what it
// changed so the GM sees it in Proposal Details (it never silently rewrites). Scales, per tier 1/2/3:
//   damage / healing dice : tier + 1 + floor((level - 1) / 2) dice in total, one fewer at will
//                           (no uses, or per turn/round); flat bonus <= tier + floor(level / 4)
//   numeric save DC       : PF2e level-based DC + (tier - 1); dnd5e 8 + proficiency + 2 + tier
//   modifiers             : +tier (PF2e untyped: +max(1, tier - 1), it stacks with everything)
//   range                 : 60 / 120 / 240 ft; areas: bursts 10 / 20 / 30, cones 15 / 30 / 60, lines 30 / 60 / 120
//   condition value       : <= tier;  uses: 1 per turn/round, tier per encounter/hour, tier + 1 per day/rest
// Penalties (negative modifiers) are drawbacks and are left alone.
// ---------------------------------------------------------------------------------------------

const RANGE_CAP = [60, 120, 240];
const AREA_CAP = {
  cone: [15, 30, 60], line: [30, 60, 120],
  burst: [10, 20, 30], emanation: [10, 20, 30], sphere: [10, 20, 30], cube: [10, 20, 30], cylinder: [10, 20, 30]
};
const CLASS_TIER_BY_POWER = { standard: 1, elevated: 2, prestige: 3 };

/**
 * Clamps `structured` (entry.mechanics.structured) for a Skill/Class of `tier` on a character of
 * `level` in `systemId`. Returns { structured, clamps }: `structured` is the sanitized, clamped block
 * in the contract's shape (null when nothing usable was in it), `clamps` lists every change as
 * { path, from, to, reason }.
 */
export function clampStructuredMechanics(structured, { tier = 1, level = 1, systemId = "pf2e" } = {}) {
  const t = [1, 2, 3].includes(tier) ? tier : 1;
  const lvl = Number.isInteger(level) ? Math.min(20, Math.max(1, level)) : 1;
  const is5e = systemId === "dnd5e";
  const s = readStructured({ mechanics: { structured } });
  const clamps = [];
  if (!s) return { structured: null, clamps };
  const where = `tier ${t} at level ${lvl}`;
  const note = (path, from, to, reason) => clamps.push({ path, from, to, reason: `${reason} (${where})` });

  const atWill = !s.uses || s.uses.per === "turn" || s.uses.per === "round";
  const maxDice = Math.max(1, t + 1 + Math.floor((lvl - 1) / 2) - (atWill ? 1 : 0));
  const maxBonus = t + Math.floor(lvl / 4);
  const diceReason = `at most ${maxDice} dice${atWill ? " for an at-will ability" : ""}`;

  if (s.damage) {
    let budget = maxDice;
    const kept = [];
    s.damage.forEach((part, index) => {
      if (budget <= 0) {
        note(`damage[${index}]`, `${diceFormula(part)} ${part.type}`, null, `${diceReason}: extra damage part dropped`);
        return;
      }
      const next = { ...part };
      if (part.count > budget) {
        next.count = budget;
        note(`damage[${index}].dice`, `${part.count}d${part.faces}`, `${budget}d${part.faces}`, diceReason);
      }
      budget -= next.count;
      clampBonus(next, `damage[${index}].bonus`);
      kept.push(next);
    });
    s.damage = kept;
  }
  if (s.heal) {
    if (s.heal.count > maxDice) {
      note("heal.dice", `${s.heal.count}d${s.heal.faces}`, `${maxDice}d${s.heal.faces}`, diceReason);
      s.heal.count = maxDice;
    }
    clampBonus(s.heal, "heal.bonus");
  }
  if (s.save && typeof s.save.dc === "number") {
    const cap = is5e ? 8 + proficiencyForLevel5e(lvl) + 2 + t : pf2eLevelBasedDc(lvl) + (t - 1);
    if (s.save.dc > cap) {
      note("save.dc", s.save.dc, cap, `a fixed save DC of at most ${cap}`);
      s.save.dc = cap;
    }
  }
  for (const [index, modifier] of (s.modifiers ?? []).entries()) {
    const cap = !is5e && modifier.type === "untyped" ? Math.max(1, t - 1) : t;
    if (modifier.value > cap) {
      note(`modifiers[${index}].value`, modifier.value, cap, `a ${is5e ? "" : `${modifier.type} `}bonus of at most +${cap}`);
      modifier.value = cap;
    }
  }
  if (s.advantage && !is5e) {
    // Not a clamp of a number, but a change the GM should see: the PF2e adapter turns it into this.
    clamps.push({ path: "advantage", from: `advantage on ${s.advantage.on}`, to: "+1 circumstance bonus", reason: "PF2e has no advantage" });
  }
  if (s.range && s.range.value > RANGE_CAP[t - 1]) {
    note("range.value", s.range.value, RANGE_CAP[t - 1], `a range of at most ${RANGE_CAP[t - 1]} ft`);
    s.range.value = RANGE_CAP[t - 1];
  }
  if (s.area) {
    const cap = AREA_CAP[s.area.type][t - 1];
    if (s.area.value > cap) {
      note("area.value", s.area.value, cap, `a ${s.area.type} of at most ${cap} ft`);
      s.area.value = cap;
    }
  }
  if (s.condition?.value && s.condition.value > t) {
    note("condition.value", s.condition.value, t, `a condition value of at most ${t}`);
    s.condition.value = t;
  }
  if (s.uses) {
    const cap = s.uses.per === "turn" || s.uses.per === "round" ? 1 : ["encounter", "hour"].includes(s.uses.per) ? t : t + 1;
    if (s.uses.max > cap) {
      note("uses.max", s.uses.max, cap, `at most ${cap} use${cap === 1 ? "" : "s"} per ${s.uses.per.replace("-", " ")}`);
      s.uses.max = cap;
    }
  }
  return { structured: toContractShape(s), clamps };

  function clampBonus(dice, path) {
    if (dice.bonus > maxBonus) {
      note(path, dice.bonus, maxBonus, `a flat bonus of at most +${maxBonus}`);
      dice.bonus = maxBonus;
    }
  }
}

/**
 * clampStructuredMechanics() for a whole entry: the tier comes from the entry (a Skill's tier, a
 * Class's power tier), the level is the CHARACTER's level (never the Grand Design level). Returns
 * { entry, clamps } with a copy of the entry whose `mechanics.clamps` holds the same list (where
 * Proposal Details reads it); an entry without structured mechanics comes back unchanged.
 */
export function clampEntryStructuredMechanics(entry, { level, systemId } = {}) {
  if (!isRecord(entry?.mechanics) || entry.mechanics.structured === undefined) return { entry, clamps: [] };
  const tier = SKILL_TIERS.has(entry.tier) ? entry.tier : CLASS_TIER_BY_POWER[entry.power_tier] ?? 1;
  const { structured, clamps } = clampStructuredMechanics(entry.mechanics.structured, { tier, level, systemId });
  const mechanics = { ...entry.mechanics, clamps };
  if (structured) mechanics.structured = structured;
  else delete mechanics.structured;
  return { entry: { ...entry, mechanics }, clamps };
}

function toContractShape(s) {
  const dice = (part) => ({ dice: `${part.count}d${part.faces}`, ...(part.bonus ? { bonus: part.bonus } : {}) });
  const out = {};
  if (s.damage?.length) out.damage = s.damage.map((part) => ({ ...dice(part), type: part.type }));
  if (s.heal) out.heal = dice(s.heal);
  for (const key of ["save", "attack", "modifiers", "advantage", "range", "area", "condition", "uses"]) {
    if (s[key] !== undefined) out[key] = s[key];
  }
  return Object.keys(out).length ? out : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
