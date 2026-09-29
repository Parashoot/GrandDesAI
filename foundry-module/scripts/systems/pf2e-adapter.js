// PF2e-specific translation from a Grand Design entry (system-agnostic: name, tier/level,
// gameItem.kind, mechanics) into a real PF2e Foundry Item. This is the original
// createFeatureSource() logic, unchanged in behavior, extracted here so it lives alongside its
// dnd5e counterpart behind the shared systems/index.js dispatch instead of being the only path.

import { diceFormula, pf2eSaveFor, readStructuredFor, skillKeyFor, slug, stripSupersededLine, supersededLine } from "./structured.js";

export const SYSTEM_ID = "pf2e";
export const SYSTEM_LABEL = "Pathfinder Second Edition";
// Handed to the AI gateway's proposal prompt so generated mechanics read like this system's rules.
export const RULES_VOCABULARY = "Pathfinder 2e terms: Strike, actions (1-3) and reactions, circumstance/status/item bonuses and penalties, "
  + "the four degrees of success (critical success / success / failure / critical failure), DC, off-guard, resistance N, "
  + "skill actions (Treat Wounds, Demoralize, Recall Knowledge), spell rank, traits, frequency per round/minute/hour/day.";

export function buildItemSourcePf2e(kind, entry) {
  const type = itemTypeFor(entry.gameItem.kind);
  const level = kind === "class" ? Math.min(20, Math.max(1, entry.level)) : entry.tier;
  const category = kind === "class" ? "classfeature" : "skill";
  const system = {};

  if (type === "feat") {
    system.category = entry.gameItem.kind === "passive" && kind !== "class" ? "skill" : category;
    system.level = { value: level };
  } else if (type === "action") {
    system.actionType = { value: pf2eActionType(entry.gameItem.kind) };
    system.actions = { value: entry.mechanics.actions ?? null };
    system.category = "offensive";
  } else if (type === "spell") {
    system.level = { value: entry.gameItem.rank };
    system.traits = { traditions: { value: [entry.gameItem.tradition] }, value: [] };
    system.time = { value: `${entry.mechanics.actions ?? 1} action${entry.mechanics.actions === 1 ? "" : "s"}` };
    system.duration = { value: entry.mechanics.duration, sustained: false };
  } else if (type === "weapon") {
    const weaponDamage = parseWeaponDamage(entry.gameItem.damage);
    system.category = entry.gameItem.category ?? "simple";
    system.group = entry.gameItem.group ?? "club";
    system.damage = { dice: weaponDamage.dice, die: weaponDamage.die, damageType: entry.gameItem.damageType };
    system.traits = { value: entry.gameItem.traits ?? [] };
  }

  // Structured mechanics (batch 3): real rule elements, frequency, traits and spell data. Entries
  // without a structured block skip this entirely and come out exactly as before.
  const structured = readStructuredFor(entry, "pf2e");
  const descriptionHtml = structured ? applyStructuredPf2e(type, system, entry, structured) : "";

  // Nothing more to do after the embedded Item exists -- PF2e models everything through flat
  // system.* fields set above, with no equivalent of dnd5e's separate "Activity" documents.
  return { source: { type, system }, postCreate: null, descriptionHtml };
}

// --- Structured mechanics -> PF2e item data -----------------------------------------------------
// Field shapes checked against the installed pf2e 8.4.1 source: FrequencyField { max, per } with per
// in CONFIG.PF2E.frequencies (turn, round, PT1M, PT10M, PT1H, PT24H, day, ...); spells still use
// template.json (damage is a record of { formula, kinds, type, category, materials, applyMod },
// defense { save: { statistic, basic } } or { passive: { statistic } }, area { type, value },
// range { value: "30 feet" }); rule elements FlatModifier { selector, type, value, predicate } and
// RollOption { domain, option, toggleable }. Inline enrichers match the compendium's own text:
// @Damage[2d6[fire]], @Check[reflex|against:class-spell|basic], @Template[type:cone|distance:15].

// PF2e has no "per encounter" and no rests. An encounter plus the 10-minute Refocus is PF2e's own
// cadence for "recharges between fights"; a D&D short / long rest maps to an hour / a day.
const PF2E_FREQUENCY_BY_PER = {
  turn: "turn", round: "round", encounter: "PT10M", hour: "PT1H", day: "day", "short-rest": "PT1H", "long-rest": "day"
};
const PF2E_DAMAGE_TRAITS = new Set([
  "acid", "cold", "electricity", "fire", "sonic", "force", "mental", "poison", "vitality", "void", "spirit"
]);
// PF2e templates are burst / cone / emanation / line; the 5e solids become a burst of that radius.
const PF2E_TEMPLATE_BY_AREA = {
  cone: "cone", burst: "burst", emanation: "emanation", line: "line", sphere: "burst", cube: "burst", cylinder: "burst"
};
const PF2E_ROLL_OPTION_PATTERN = /^[a-z0-9][a-z0-9:-]*$/;

function isActivated(s) {
  return Boolean(s.damage || s.heal || s.save || s.attack);
}

// A passive Skill's modifiers are always on. Anything the character USES (an action, a feat with a
// damage/save effect) gates them behind a sheet toggle the player switches on while it applies --
// otherwise "1/encounter: +1 AC" would be a permanent +1 AC.
function modifiersAlwaysOn(type, entry, s) {
  if (type === "weapon") return true;
  return type === "feat" && (entry.gameItem.kind === "passive" || !isActivated(s));
}

// PF2e has no advantage. The nearest fixed effect is a +1 circumstance bonus to the same roll
// (the contract marks advantage dnd5e-only; a model or a GM edit can still put it on a PF2e entry).
function advantageAsModifier(s) {
  const on = s.advantage?.on;
  if (!on || on.startsWith("check:")) return s;
  const modifier = { value: 1, type: "circumstance", selector: on === "attack" ? "attack" : on };
  if (s.advantage.condition) modifier.predicate = s.advantage.condition;
  return { ...s, modifiers: [...(s.modifiers ?? []), modifier] };
}

function applyStructuredPf2e(type, system, entry, structured) {
  const s = advantageAsModifier(structured);
  const optionSlug = `grand-design:${slug(entry.name) || "ability"}`;
  const alwaysOn = modifiersAlwaysOn(type, entry, s);
  const traits = new Set(system.traits?.value ?? []);
  for (const part of s.damage ?? []) if (PF2E_DAMAGE_TRAITS.has(part.type)) traits.add(part.type);
  if (s.attack) traits.add("attack");
  if (s.heal) traits.add("healing");

  if (type === "feat" || type === "action") {
    if (type === "feat" && isActivated(s) && entry.gameItem.kind !== "passive") {
      system.actionType = { value: "action" };
      system.actions = { value: clampActions(entry.mechanics.actions) };
    }
    if (type === "action") {
      if (system.actionType?.value === "action") system.actions = { value: clampActions(entry.mechanics.actions) };
      system.category = isActivated(s) ? "offensive" : "defensive";
    }
    system.traits = { ...(system.traits ?? {}), value: [...traits] };
    if (s.uses) system.frequency = { max: s.uses.max, per: PF2E_FREQUENCY_BY_PER[s.uses.per] ?? "day" };
  } else if (type === "spell") {
    system.traits = { ...(system.traits ?? {}), value: [...traits] };
    const damage = {};
    for (const part of s.damage ?? []) {
      damage[damageId(Object.keys(damage).length)] = { formula: diceFormula(part), kinds: ["damage"], type: part.type, category: null, materials: [], applyMod: false };
    }
    if (s.heal) {
      damage[damageId(Object.keys(damage).length)] = { formula: diceFormula(s.heal), kinds: ["healing"], type: "untyped", category: null, materials: [], applyMod: false };
    }
    if (Object.keys(damage).length) system.damage = damage;
    if (s.save) system.defense = { save: { statistic: pf2eSaveFor(s.save.save), basic: s.save.basic } };
    else if (s.attack) system.defense = { passive: { statistic: "ac" } };
    if (s.area) system.area = { type: PF2E_TEMPLATE_BY_AREA[s.area.type], value: s.area.value };
    if (s.range) system.range = { value: `${s.range.value} feet` };
  }
  const rules = rulesPf2e(entry, s, optionSlug, alwaysOn, type);
  if (rules.length) system.rules = rules;
  return describeStructuredPf2e(entry, s, alwaysOn);
}

function rulesPf2e(entry, s, optionSlug, alwaysOn, type) {
  const modifiers = s.modifiers ?? [];
  if (!modifiers.length) return [];
  const rules = [];
  if (!alwaysOn) {
    rules.push({ key: "RollOption", domain: "all", option: optionSlug, toggleable: true, label: `${entry.name} (active)` });
  }
  for (const modifier of modifiers) {
    const predicate = [];
    if (!alwaysOn) predicate.push(optionSlug);
    // The model's predicate is kept only when it already is a roll option ("target:trait:undead");
    // prose ("against undead") stays in the description instead of becoming a never-true predicate.
    if (modifier.predicate && PF2E_ROLL_OPTION_PATTERN.test(modifier.predicate)) predicate.push(modifier.predicate);
    const rule = { key: "FlatModifier", selector: pf2eSelector(modifier.selector, type), type: modifier.type, value: modifier.value, label: entry.name };
    if (predicate.length) rule.predicate = predicate;
    rules.push(rule);
  }
  return rules;
}

function pf2eSelector(selector, itemType) {
  // On a weapon, attack/damage modifiers belong to that weapon only, not to every Strike.
  if (itemType === "weapon" && (selector === "attack" || selector === "damage")) return `{item|_id}-${selector}`;
  if (selector === "attack") return "attack-roll";
  if (selector === "save:all") return "saving-throw";
  if (selector.startsWith("save:")) return pf2eSaveFor(selector.slice(5)) ?? "saving-throw";
  if (selector.startsWith("skill:")) return skillKeyFor(selector.slice(6), "pf2e") ?? "skill-check";
  return selector; // ac, damage, perception, initiative are PF2e selectors as they stand
}

function describeStructuredPf2e(entry, s, alwaysOn) {
  const lines = [];
  if (s.attack) lines.push(`Make a ${s.attack.kind === "spell" ? "spell attack roll" : `${s.attack.kind} Strike`} against the target's AC.`);
  if (s.damage) lines.push(`Damage: @Damage[${s.damage.map((part) => `${enricherFormula(part)}[${part.type}]`).join(",")}]`);
  if (s.save) {
    const dc = typeof s.save.dc === "number" ? `dc:${s.save.dc}` : "against:class-spell";
    lines.push(`Save: @Check[${pf2eSaveFor(s.save.save)}|${dc}${s.save.basic ? "|basic" : ""}]`);
  }
  if (s.heal) lines.push(`Healing: @Damage[${enricherFormula(s.heal)}[healing]]`);
  if (s.area) lines.push(`Area: @Template[type:${PF2E_TEMPLATE_BY_AREA[s.area.type]}|distance:${s.area.value}]`);
  if (s.range) lines.push(`Range: ${s.range.value} feet`);
  if (s.condition) {
    lines.push(`Condition: ${escapeHtmlPf2e(s.condition.id)}${s.condition.value ? ` ${s.condition.value}` : ""}${s.condition.duration ? ` (${escapeHtmlPf2e(s.condition.duration)})` : ""}`);
  }
  for (const modifier of s.modifiers ?? []) {
    const kind = modifier.value > 0 ? "bonus" : "penalty";
    lines.push(`${modifier.value > 0 ? "+" : ""}${modifier.value} ${modifier.type} ${kind} to ${escapeHtmlPf2e(selectorLabel(modifier.selector))}${modifier.predicate ? ` (${escapeHtmlPf2e(modifier.predicate)})` : ""}`);
  }
  if ((s.modifiers ?? []).length && !alwaysOn) lines.push(`Toggle "${escapeHtmlPf2e(entry.name)} (active)" on the character sheet while it applies.`);
  if (s.uses) lines.push(`Uses: ${s.uses.max} per ${s.uses.per.replace("-", " ")}`);
  return lines.length ? `<p><strong>Rules:</strong></p><ul>${lines.map((line) => `<li>${line}</li>`).join("")}</ul>` : "";
}

export function selectorLabel(selector) {
  if (selector === "ac") return "AC";
  if (selector === "save:all") return "saving throws";
  if (selector.startsWith("save:")) return `${selector.slice(5)} saves`;
  if (selector.startsWith("skill:")) return `${selector.slice(6)} checks`;
  return `${selector} rolls`;
}

function enricherFormula(dice) {
  return dice.bonus ? `(${diceFormula(dice)})` : diceFormula(dice);
}

function damageId(index) {
  return `grandDesignDmg${String(index).padStart(2, "0")}`;
}

function clampActions(actions) {
  return [1, 2, 3].includes(actions) ? actions : 1;
}

/**
 * Switches a superseded Skill/Class Item's mechanics off (contract section 4) and returns the
 * update for item.update(). The rule elements move to a flag (a GM can restore them by hand), the
 * frequency is spent, and the description opens with "Superseded by X". The Item itself stays: it
 * is the record the new entry's lineage points at. `by` is the superseding entry's name.
 */
export function markSupersededPf2e(item, { by } = {}) {
  const system = item?._source?.system ?? item?.system ?? {};
  const rules = Array.isArray(system.rules) ? system.rules : [];
  const update = {
    "system.rules": [],
    "system.description.value": supersededLine(by) + stripSupersededLine(system.description?.value ?? ""),
    "flags.grand-design-ai.superseded": true
  };
  // Re-marking must not overwrite the stash with the already-emptied rules.
  if (rules.length) update["flags.grand-design-ai.supersededRules"] = structuredClone(rules);
  if (system.frequency) update["system.frequency.value"] = 0;
  return update;
}

export function getCharacterLevelPf2e(actor) {
  return actor.system?.details?.level?.value ?? null;
}

// The character's own class as the game system knows it ("Fighter"). The proposal prompt derives
// name motifs from it; without it the model fell back to the character's personal name.
// Tolerates plain objects (harness, tests) as well as real Actors.
export function getCharacterClassPf2e(actor) {
  const direct = actor?.class?.name;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const items = actor?.items;
  const found = typeof items?.find === "function" ? items.find((item) => item?.type === "class") : undefined;
  return typeof found?.name === "string" && found.name.trim() ? found.name.trim() : null;
}

// Board 3962a001: a proposal must never hand the character proficiency in a skill or feat it is
// already trained in. Returns the character's own class/ancestry/background feat names plus any
// skill trained (rank >= 1), so the proposal prompt (and pipeline.js's deterministic backstop) can
// see what is already on the sheet. Best-effort and additive, same as getCharacterClassPf2e above:
// a plain harness object or an unusual sheet just contributes less, never throws.
export function getCharacterKnownFeaturesPf2e(actor) {
  const names = new Set();
  const items = typeof actor?.items?.filter === "function"
    ? actor.items.filter((item) => ["feat", "class", "background", "ancestry"].includes(item?.type))
    : [];
  for (const item of items) if (typeof item?.name === "string" && item.name.trim()) names.add(item.name.trim());
  const skills = actor?.system?.skills;
  if (skills && typeof skills === "object") {
    for (const [key, skill] of Object.entries(skills)) {
      const rank = Number(skill?.rank ?? 0);
      if (rank < 1) continue;
      const label = typeof skill?.label === "string" && skill.label.trim() ? skill.label.trim() : titleCase(key);
      if (label) names.add(label);
    }
  }
  return [...names];
}

function titleCase(value) {
  return String(value ?? "").replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

export function equivalentLabelPf2e(kind, entry) {
  return kind === "class" ? entry.system_chassis ?? "Pending PF2e chassis review" : entry.system_equivalent;
}

function itemTypeFor(kind) {
  if (kind === "reaction" || kind === "free") return "action";
  if (kind === "passive") return "feat";
  return kind;
}

function pf2eActionType(kind) {
  if (kind === "reaction") return "reaction";
  if (kind === "free") return "free";
  return "action";
}

function parseWeaponDamage(formula) {
  const match = /^(\d+)d(\d+)/i.exec(formula);
  return { dice: Number(match[1]), die: `d${match[2]}` };
}

// --- Populate: NPC/monster/item spawning -------------------------------------------------------
// Best-effort PF2e translation of a populate.js spec, following PF2e's well-documented actor/item
// schema conventions (unlike dnd5e-adapter.js's live-verified fields, this hasn't been checked
// against a running PF2e world in this session -- every spawned Actor/Item remains fully
// GM-editable afterward, same as the rest of Grand Design's PF2e support).

const ABILITY_KEYS_PF2E = ["str", "dex", "con", "int", "wis", "cha"];

function abilityModPf2e(score) {
  return Math.floor(((score ?? 10) - 10) / 2);
}

export function buildNpcActorSourcePf2e(spec) {
  const isMonster = spec.actorKind === "monster";
  const abilities = spec.abilities ?? {};
  const system = {
    abilities: Object.fromEntries(ABILITY_KEYS_PF2E.map((key) => [key, { mod: abilityModPf2e(abilities[key]) }])),
    attributes: {
      hp: { value: spec.hp, max: spec.hp },
      ac: { value: spec.ac },
      speed: { value: spec.speed ?? 25 }
    },
    details: {
      level: { value: isMonster ? Math.round(spec.cr ?? 1) : (spec.level ?? 1) },
      biography: { value: spec.bio ?? "", public: spec.bio ?? "" }
    },
    traits: { size: { value: isMonster ? (spec.size ?? "med") : "med" }, value: [] }
  };
  const source = { name: spec.name, type: "npc", system };

  const embeddedItems = [];
  if (!isMonster && spec.weaponSpec) embeddedItems.push(buildWeaponItemDataPf2e(spec.weaponSpec));
  if (isMonster && spec.attack) embeddedItems.push(buildNaturalAttackItemDataPf2e(spec.attack));
  return { source, embeddedItems };
}

export function buildEquipmentItemSourcePf2e(spec) {
  return { source: buildWeaponItemDataPf2e(spec), postCreate: null };
}

function buildWeaponItemDataPf2e(weaponSpec) {
  const damage = parseWeaponDamage(weaponSpec.damage);
  const system = {
    category: weaponSpec.category ?? "simple",
    group: weaponSpec.group ?? "club",
    damage: { dice: damage.dice, die: damage.die, damageType: weaponSpec.damageType },
    traits: { value: weaponSpec.traits ?? [] },
    runes: { potency: Number.isInteger(weaponSpec.bonus) ? weaponSpec.bonus : 0 }
  };
  return { name: weaponSpec.name, type: "weapon", system };
}

// MONSTER_TEMPLATES' attack formulas (populate.js, shared across both systems) carry a static
// "+N" damage bonus baked into the dice string, e.g. "1d6+2" -- the dnd5e adapter's own
// parseWeaponDamage captures that group into system.damage.base.bonus, but the general-purpose
// parseWeaponDamage above (used by buildItemSourcePf2e for hand-authored entries) never has, so
// reusing it here would silently drop the bonus and under-power every spawned monster's attack
// relative to its dnd5e counterpart. A small dedicated parser keeps that pre-existing behavior
// untouched while still giving Populate's PF2e monsters the same damage the dnd5e ones get.
function parseAttackDamageWithBonus(formula) {
  const match = /^(\d+)d(\d+)(?:\s*\+\s*(\d+))?/i.exec(formula);
  return { dice: Number(match[1]), die: `d${match[2]}`, modifier: match[3] ? Number(match[3]) : 0 };
}

function buildNaturalAttackItemDataPf2e(attack) {
  const damage = parseAttackDamageWithBonus(attack.damage);
  const system = {
    category: "unarmed",
    group: "brawling",
    damage: { dice: damage.dice, die: damage.die, modifier: damage.modifier, damageType: attack.damageType },
    traits: { value: ["unarmed", "agile", "finesse"] }
  };
  return { name: attack.name, type: "weapon", system };
}

// --- Titles ---------------------------------------------------------------------------------
// A Title (lineage.js#createTitleSource) is a flavor badge earned for a specific achievement, not
// a usable ability -- a plain "general" category feat at level 0, with no equivalent of dnd5e's
// postCreate Activity step needed on this system either (PF2e feats have nothing to activate by
// themselves). buildTitleGrantItemSourcePf2e mirrors the dnd5e adapter's flavor-item builder for a
// Title's optional bundled reward Item, using PF2e's "equipment" type as the plainest physical-item
// container -- kept deliberately undetailed since Grand Design has no way to know what mechanical
// shape an arbitrary narrative reward item should take; the GM always finishes it.

export function buildTitleItemSourcePf2e() {
  const system = { category: "general", level: { value: 0 } };
  return { source: { type: "feat", system }, postCreate: null };
}

// --- Combination Skills -----------------------------------------------------------------------
// The temporary Item each participant in a live multi-caster combination receives
// (lineage.js#createCombinationSource). PF2e's own "effect" Item type looks like a tempting fit,
// but its schema (system.duration.unit/expiry/sustained, system.start, token icon requirements) has
// no counterpart at all in dnd5e, which models temporary states as ActiveEffect documents rather
// than Items -- so both adapters deliberately use their ordinary granted-ability type instead,
// keeping the combination a thing the participants can USE rather than a status sitting on them.
// "action" is PF2e's activated-ability type, the same one buildItemSourcePf2e already emits.

// Like the dnd5e adapter, this deliberately does NOT try to encode the combination's band as an
// item rarity -- neither system's granted-ability Item type carries a rarity field that survives
// document validation (rarity belongs to physical items), so doing so would be dead code that only
// looked like it did something. The band is stated in the Item's own description by
// lineage.js#describeCombinationHtml, which is where it actually reaches a player.
export function buildCombinationItemSourcePf2e() {
  const system = {
    actionType: { value: "action" },
    actions: { value: null },
    category: "offensive",
    traits: { value: [] }
  };
  return { source: { type: "action", system }, postCreate: null };
}

export function buildTitleGrantItemSourcePf2e(grant) {
  const system = { description: { value: `<p>${escapeHtmlPf2e(grant.description)}</p>` } };
  return { source: { name: grant.name, type: "equipment", system } };
}

function escapeHtmlPf2e(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
