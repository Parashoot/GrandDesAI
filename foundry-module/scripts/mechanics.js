import { FREQUENCY_PERIODS, GRAND_DESIGN_ITEM_KINDS, SPELL_SCHOOLS } from "./constants.js";

export function validateMechanics(entry, errors) {
  const item = entry.gameItem;
  const mechanics = entry.mechanics;
  if (!isRecord(item) || !GRAND_DESIGN_ITEM_KINDS.has(item.kind)) {
    errors.push(`[${entry.name}] requires gameItem.kind: feat, action, reaction, free, passive, spell, or weapon.`);
    return;
  }
  if (!isRecord(mechanics)) {
    errors.push(`[${entry.name}] requires a mechanics object.`);
    return;
  }
  if (!isNonEmptyString(mechanics.effect)) {
    errors.push(`[${entry.name}] mechanics.effect must state the tangible game benefit.`);
  }
  validateFrequency(entry.name, mechanics.frequency, errors);

  if (isActionable(item.kind)) validateAction(entry.name, item.kind, mechanics, errors);
  else validatePassive(entry.name, mechanics, errors);

  if (item.kind === "spell") {
    if (!Number.isInteger(item.rank) || item.rank < 0 || item.rank > 10) {
      errors.push(`[${entry.name}] spell rank must be an integer from 0 to 10.`);
    }
    if (!isNonEmptyString(item.tradition)) {
      errors.push(`[${entry.name}] spell requires a tradition (e.g. arcane/primal/divine/occult -- used by PF2e; ignored by systems without traditions).`);
    }
    // Not every system has "traditions" the way PF2e does, but every current system this module
    // supports does have a fixed spell-school enum, so it's required unconditionally here to
    // keep this validator system-agnostic -- an adapter that doesn't need it just ignores it.
    if (!SPELL_SCHOOLS.has(item.school)) {
      errors.push(`[${entry.name}] spell requires gameItem.school to be one of: ${[...SPELL_SCHOOLS].join(", ")}.`);
    }
  }
  if (item.kind === "weapon") {
    if (!isDiceFormula(item.damage)) {
      errors.push(`[${entry.name}] weapon requires a dice damage formula such as 1d6+2.`);
    }
    if (!isNonEmptyString(item.damageType)) {
      errors.push(`[${entry.name}] weapon requires a damage type.`);
    }
  }
}

/**
 * `options.systemId` picks the inline-roll syntax. lineage.js#createFeatureSource does not pass it
 * yet, so inside Foundry the active system (game.system.id) is read as a fallback; plain Node
 * callers without either get the old system-neutral `[[/r]]` link.
 */
export function createMechanicsHtml(entry, { systemId } = {}) {
  const { gameItem, mechanics } = entry;
  const parts = [
    `<p><strong>Effect:</strong> ${escapeHtml(mechanics.effect)}</p>`,
    `<p><strong>Frequency:</strong> ${formatFrequency(mechanics.frequency)}</p>`
  ];
  if (mechanics.duration) parts.push(`<p><strong>Duration:</strong> ${escapeHtml(mechanics.duration)}</p>`);
  if (mechanics.trigger) parts.push(`<p><strong>Trigger:</strong> ${escapeHtml(mechanics.trigger)}</p>`);
  if (mechanics.requirements) parts.push(`<p><strong>Requirements:</strong> ${escapeHtml(mechanics.requirements)}</p>`);
  if (mechanics.roll) {
    parts.push(`<p><strong>Resolution:</strong> ${renderRollResolution(mechanics.roll, systemId ?? globalThis.game?.system?.id)}</p>`);
  }
  if (gameItem.kind === "weapon") {
    parts.push(`<p><strong>Weapon damage:</strong> [[/r ${escapeHtml(gameItem.damage)}]] ${escapeHtml(gameItem.damageType)}</p>`);
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------------------------
// Real checks instead of a raw d20 (board 17c10e97). Every generated roll used to read the
// Acrobatics modifier and render `[[/r 1d20+N]]`, so a Medicine action rolled Acrobatics and the
// sheet's own roll dialog (proficiency, conditions, bonuses) was bypassed. Below: resolve the free
// text of `roll.kind` ("Athletics check", "Wisdom (Medicine) check", "Reflex save", "Constitution
// saving throw") to the system's own statistic, and render that system's check enricher.
// Pure (no Foundry globals) so progression.js, api.js and Node tests can all use it.
// ---------------------------------------------------------------------------------------------

const ABILITIES_5E = {
  str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma"
};
const ABILITY_BY_WORD = {
  strength: "str", str: "str", dexterity: "dex", dex: "dex", constitution: "con", con: "con",
  intelligence: "int", int: "int", wisdom: "wis", wis: "wis", charisma: "cha", cha: "cha"
};

// dnd5e 5.x system.skills keys, with the ability each defaults to (CONFIG.DND5E.skills).
const SKILLS_5E = {
  acr: { label: "Acrobatics", ability: "dex" },
  ani: { label: "Animal Handling", ability: "wis" },
  arc: { label: "Arcana", ability: "int" },
  ath: { label: "Athletics", ability: "str" },
  dec: { label: "Deception", ability: "cha" },
  his: { label: "History", ability: "int" },
  ins: { label: "Insight", ability: "wis" },
  itm: { label: "Intimidation", ability: "cha" },
  inv: { label: "Investigation", ability: "int" },
  med: { label: "Medicine", ability: "wis" },
  nat: { label: "Nature", ability: "int" },
  prc: { label: "Perception", ability: "wis" },
  prf: { label: "Performance", ability: "cha" },
  per: { label: "Persuasion", ability: "cha" },
  rel: { label: "Religion", ability: "int" },
  slt: { label: "Sleight of Hand", ability: "dex" },
  ste: { label: "Stealth", ability: "dex" },
  sur: { label: "Survival", ability: "wis" }
};
const PF2E_SKILLS = [
  "acrobatics", "arcana", "athletics", "crafting", "deception", "diplomacy", "intimidation", "medicine",
  "nature", "occultism", "performance", "religion", "society", "stealth", "survival", "thievery"
];
const PF2E_SAVES = ["fortitude", "reflex", "will"];

// Words a roll.kind may use, in either system's vocabulary (the AI and old templates mix them), to
// the statistic in each system. `null` = that system has no equivalent statistic.
const SKILL_WORDS = {
  acrobatics: { pf2e: "acrobatics", dnd5e: "acr" },
  "animal handling": { pf2e: "nature", dnd5e: "ani" },
  arcana: { pf2e: "arcana", dnd5e: "arc" },
  athletics: { pf2e: "athletics", dnd5e: "ath" },
  crafting: { pf2e: "crafting", dnd5e: null },
  craft: { pf2e: "crafting", dnd5e: null },
  deception: { pf2e: "deception", dnd5e: "dec" },
  diplomacy: { pf2e: "diplomacy", dnd5e: "per" },
  persuasion: { pf2e: "diplomacy", dnd5e: "per" },
  history: { pf2e: "society", dnd5e: "his" },
  society: { pf2e: "society", dnd5e: "his" },
  insight: { pf2e: "perception", dnd5e: "ins" },
  intimidation: { pf2e: "intimidation", dnd5e: "itm" },
  investigation: { pf2e: "perception", dnd5e: "inv" },
  medicine: { pf2e: "medicine", dnd5e: "med" },
  nature: { pf2e: "nature", dnd5e: "nat" },
  occultism: { pf2e: "occultism", dnd5e: "arc" },
  perception: { pf2e: "perception", dnd5e: "prc" },
  performance: { pf2e: "performance", dnd5e: "prf" },
  religion: { pf2e: "religion", dnd5e: "rel" },
  "sleight of hand": { pf2e: "thievery", dnd5e: "slt" },
  thievery: { pf2e: "thievery", dnd5e: "slt" },
  stealth: { pf2e: "stealth", dnd5e: "ste" },
  survival: { pf2e: "survival", dnd5e: "sur" }
};
const PF2E_SAVE_BY_ABILITY = { str: "fortitude", con: "fortitude", dex: "reflex", int: "will", wis: "will", cha: "will" };
const ABILITY_BY_PF2E_SAVE = { fortitude: "con", reflex: "dex", will: "wis" };

/**
 * Resolves a roll's free-text kind to the system's own statistic, or null when it is not one (an
 * attack roll, "Martial check"). Returns { type: "skill"|"save"|"perception"|"ability", key,
 * ability?, label }: `key` is the PF2e slug (athletics, reflex) or the dnd5e key (ath, dex).
 */
export function resolveRollCheck(kind, systemId) {
  if (typeof kind !== "string" || !kind.trim()) return null;
  const text = kind.toLowerCase();
  const is5e = systemId === "dnd5e";
  if (/\battack\b|\bstrike\b/.test(text)) return null;

  const abilityWord = firstWordMatch(text, Object.keys(ABILITY_BY_WORD).filter((word) => word.length > 3));
  const ability = abilityWord ? ABILITY_BY_WORD[abilityWord] : null;
  const pf2eSave = firstWordMatch(text, PF2E_SAVES);
  const isSave = /\bsav(e|es|ing throw)\b/.test(text) || Boolean(pf2eSave);
  if (isSave) {
    if (is5e) {
      const abl = ability ?? (pf2eSave ? ABILITY_BY_PF2E_SAVE[pf2eSave] : null);
      return abl ? { type: "save", key: abl, ability: abl, label: `${ABILITIES_5E[abl]} saving throw` } : null;
    }
    const save = pf2eSave ?? (ability ? PF2E_SAVE_BY_ABILITY[ability] : null);
    return save ? { type: "save", key: save, label: `${capitalize(save)} save` } : null;
  }

  const skillWord = firstWordMatch(text, Object.keys(SKILL_WORDS));
  if (skillWord) {
    const key = SKILL_WORDS[skillWord][is5e ? "dnd5e" : "pf2e"];
    if (key === "perception") return { type: "perception", key, label: "Perception check" };
    if (key && is5e) {
      const abl = ability ?? SKILLS_5E[key].ability;
      return { type: "skill", key, ability: abl, label: `${ABILITIES_5E[abl]} (${SKILLS_5E[key].label}) check` };
    }
    if (key) return { type: "skill", key, label: `${capitalize(key)} check` };
    // dnd5e has no Crafting skill: crafts are tool checks, most often Intelligence.
    if (is5e) return { type: "ability", key: ability ?? "int", ability: ability ?? "int", label: `${ABILITIES_5E[ability ?? "int"]} check` };
  }
  if (ability && is5e) return { type: "ability", key: ability, ability, label: `${ABILITIES_5E[ability]} check` };
  return null;
}

// The statistic a Grand Design gameplay tag (growth-taxonomy.js) is tested with, per system. Used
// by the fallback capstone / Class evolution so "Martial check" becomes a real Athletics check.
const CHECK_WORD_BY_TAG = {
  acrobatics: "acrobatics", arcana: "arcana", athletics: "athletics", craft: "crafting", deception: "deception",
  diplomacy: "diplomacy", intimidation: "intimidation", medicine: "medicine", nature: "nature", occultism: "occultism",
  performance: "performance", religion: "religion", society: "society", stealth: "stealth", survival: "survival",
  thievery: "thievery", lore: "society", mobility: "acrobatics", water: "athletics", support: "diplomacy",
  martial: "athletics", precision: "acrobatics", defense: "fortitude save", ranged: "perception",
  leadership: "diplomacy", alchemy: "crafting", spellcasting: "arcana", arcane: "arcana", divine: "religion",
  occult: "occultism", primal: "nature", fire: "arcana", cold: "arcana", electricity: "arcana", earth: "nature",
  air: "nature", summoning: "arcana"
};

/** The check a tag is tested with in this system; with no tag, the character's resolve (Will / Wisdom save). */
export function checkForTag(tag, systemId) {
  const word = (tag && CHECK_WORD_BY_TAG[tag]) ?? "will save";
  return resolveRollCheck(word, systemId) ?? resolveRollCheck("will save", systemId);
}

// GM Core "DCs by Level" (PF2e remaster), levels 0-25.
const PF2E_LEVEL_DCS = [14, 15, 16, 18, 19, 20, 22, 23, 24, 26, 27, 28, 30, 31, 32, 34, 35, 36, 38, 39, 40, 42, 44, 46, 48, 50];

export function pf2eLevelBasedDc(level) {
  const index = Math.max(0, Math.min(PF2E_LEVEL_DCS.length - 1, Number.isInteger(level) ? level : 1));
  return PF2E_LEVEL_DCS[index];
}

/** dnd5e proficiency bonus by character level (2 at 1-4 ... 6 at 17-20). */
export function proficiencyForLevel5e(level) {
  const lvl = Number.isInteger(level) && level > 0 ? Math.min(level, 20) : 1;
  return 2 + Math.floor((lvl - 1) / 4);
}

/**
 * A DC scaled to the CHARACTER (never the Grand Design level, which runs to 100: board 0ed137cb
 * found DC 60 on a level-50 capstone). PF2e: the level-based DC table. dnd5e: 8 + proficiency bonus
 * + the check's ability modifier, the same formula as the character's own save DCs.
 */
export function characterDc(actor, check, systemId) {
  const level = characterLevel(actor, systemId);
  if (systemId === "dnd5e") {
    const prof = finiteNumber(actor?.system?.attributes?.prof) ?? proficiencyForLevel5e(level);
    const abilityKey = check?.ability ?? "wis";
    const mod = finiteNumber(actor?.system?.abilities?.[abilityKey]?.mod) ?? 0;
    return 8 + prof + mod;
  }
  return pf2eLevelBasedDc(level);
}

export function characterLevel(actor, systemId) {
  const raw = systemId === "dnd5e" ? actor?.system?.details?.level : actor?.system?.details?.level?.value ?? actor?.system?.details?.level;
  const level = finiteNumber(raw);
  return Number.isInteger(level) && level >= 0 ? level : 1;
}

/**
 * The actor's own total modifier for a resolved check (or null when the sheet does not say). PF2e
 * prepared data keeps it on system.skills[slug].totalModifier/.value (saves and Perception alike);
 * dnd5e on system.skills[key].total and system.abilities[abl].save(.value)/.mod.
 */
export function checkModifier(actor, check, systemId) {
  if (!check) return null;
  const system = actor?.system ?? {};
  if (systemId === "dnd5e") {
    if (check.type === "skill") {
      const skill = system.skills?.[check.key];
      return finiteNumber(skill?.total) ?? finiteNumber(skill?.mod);
    }
    const ability = system.abilities?.[check.ability ?? check.key];
    if (check.type === "save") return finiteNumber(ability?.save?.value) ?? finiteNumber(ability?.save) ?? finiteNumber(ability?.mod);
    return finiteNumber(ability?.mod);
  }
  const stat = check.type === "save"
    ? system.saves?.[check.key]
    : check.type === "perception"
      ? system.perception ?? system.attributes?.perception
      : system.skills?.[check.key];
  return finiteNumber(stat?.totalModifier) ?? finiteNumber(stat?.mod) ?? finiteNumber(stat?.value);
}

/**
 * The system's inline check for a roll, or null if the kind is not a check the system can roll
 * itself. PF2e: @Check[athletics|dc:20] (pf2e 8.x TextEditorPF2e#createCheck: first param = type).
 * dnd5e 5.x: [[/check skill=ath ability=str dc=15]], [[/check ability=int dc=15]],
 * [[/save ability=dex dc=14]] (dnd5e enrichCheck/enrichSave; key=value config).
 */
export function checkEnricher(roll, systemId) {
  const check = resolveRollCheck(roll?.kind, systemId);
  if (!check) return null;
  const dc = Number.isFinite(Number(roll.dc)) && Number(roll.dc) > 0 ? Math.round(Number(roll.dc)) : null;
  if (systemId === "dnd5e") {
    const dcPart = dc ? ` dc=${dc}` : "";
    if (check.type === "save") return `[[/save ability=${check.ability}${dcPart}]]`;
    if (check.type === "ability") return `[[/check ability=${check.ability}${dcPart}]]`;
    return `[[/check skill=${check.key} ability=${check.ability}${dcPart}]]`;
  }
  if (systemId === "pf2e") return `@Check[${check.key}${dc ? `|dc:${dc}` : ""}]`;
  return null;
}

// The system check comes first. The flat `[[/r]]` roll is kept after it as a manual fallback (the
// check enricher needs the Item on a character that has the statistic; a GM reading it in a journal
// does not) -- and the fixture campaign in test-scenario.js still looks for it.
function renderRollResolution(roll, systemId) {
  const kind = escapeHtml(roll.kind);
  const flat = isDiceFormula(roll.formula) ? `[[/r ${escapeHtml(roll.formula)}]]` : "";
  const enricher = checkEnricher(roll, systemId);
  if (enricher) return `${kind} — ${enricher}${flat ? ` (flat roll: ${flat})` : ""}`;
  return `${kind} — ${flat}${roll.dc ? ` vs. DC ${escapeHtml(roll.dc)}` : ""}`;
}

function firstWordMatch(text, words) {
  let best = null;
  let bestIndex = Infinity;
  for (const word of words) {
    const match = new RegExp(`\\b${word.replace(/ /g, "\\s+")}\\b`).exec(text);
    if (match && (match.index < bestIndex || (match.index === bestIndex && word.length > best.length))) {
      best = word;
      bestIndex = match.index;
    }
  }
  return best;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "" || typeof value === "object") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function capitalize(word) {
  return word ? word[0].toUpperCase() + word.slice(1) : word;
}

function validateFrequency(name, frequency, errors) {
  if (!isRecord(frequency) || !Number.isInteger(frequency.max) || frequency.max < 1 || !FREQUENCY_PERIODS.has(frequency.per)) {
    errors.push(`[${name}] mechanics.frequency requires max >= 1 and a valid per value.`);
  }
}

function validateAction(name, kind, mechanics, errors) {
  if (!isRecord(mechanics.roll) || !isDiceFormula(mechanics.roll.formula) || !isNonEmptyString(mechanics.roll.kind)) {
    errors.push(`[${name}] ${kind} mechanics require a dice roll with kind and formula.`);
  }
  if (kind === "reaction" && !isNonEmptyString(mechanics.trigger)) {
    errors.push(`[${name}] reactions require a trigger.`);
  }
  if (kind === "action" && !Number.isInteger(mechanics.actions) || (kind === "action" && !(mechanics.actions >= 1 && mechanics.actions <= 3))) {
    errors.push(`[${name}] actions require an action cost from 1 to 3.`);
  }
}

function validatePassive(name, mechanics, errors) {
  if (!isNonEmptyString(mechanics.duration)) {
    errors.push(`[${name}] passive mechanics require a duration or explicit ongoing cadence.`);
  }
}

function isActionable(kind) {
  return ["action", "reaction", "free", "spell", "weapon"].includes(kind);
}

function isDiceFormula(value) {
  return typeof value === "string" && /^\d+d\d+(?:\s*[+-]\s*\d+)?$/i.test(value.trim());
}

function formatFrequency(frequency) {
  return `${frequency.max}/${frequency.per}`;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
