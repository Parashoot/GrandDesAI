// dnd5e-specific translation from a Grand Design entry (system-agnostic: name, tier/level,
// gameItem.kind, mechanics) into a real dnd5e Foundry Item.
//
// dnd5e (system version 5.x, current as of this module's dnd5e support) models "what a feature
// actually does" through embedded Activity documents (system.activities, keyed by id) rather
// than the flat system.actionType/system.damage.parts fields PF2e uses directly on the Item.
// Every field name and shape below was verified empirically against a live dnd5e 5.3.3 world
// (Foundry 14) via Item.create()/item.createActivity() rather than assumed from documentation,
// since a wrong field name here would silently produce a broken, unusable Item -- see
// AI_TEST_CAMPAIGN.md / the systems design notes for how that was checked.
//
// Fidelity matches the PF2e adapter's philosophy: only weapon damage dice/type are modeled as
// real structured combat data. Everything else (checks, triggers, frequency) is GM-adjudicated
// narrative text with an inline `[[/r formula]]` roll link in the description (already produced
// by mechanics.js#createMechanicsHtml, reused unchanged for both systems) plus a same-flavor
// Activity so the ability still shows up correctly in the sheet's action economy and can be used
// from there.

import { abilityForSave, diceFormula, readStructuredFor, skillKeyFor, stripSupersededLine, supersededLine } from "./structured.js";

export const SYSTEM_ID = "dnd5e";
export const SYSTEM_LABEL = "Dungeons & Dragons Fifth Edition (2024 rules)";
// Handed to the AI gateway's proposal prompt. Without it the model copies the Pathfinder-flavoured
// examples ("Strike", "circumstance bonus", "resistance 2", "per encounter") into 5e entries.
export const RULES_VOCABULARY = "D&D 5e (2024) terms: attack roll, action / bonus action / reaction, advantage and disadvantage, "
  + "ability checks and saving throws against a DC, proficiency bonus, resistance to a damage type (halves it, never a number), "
  + "temporary hit points, conditions (Prone, Frightened, Grappled, ...), spell level and spell slots, uses per short rest / long rest or per turn. "
  // Playtest ember-road s1: a proposal granted "Craft (Cooking) skill", which 5e does not have.
  + "Skills are only: Acrobatics, Animal Handling, Arcana, Athletics, Deception, History, Insight, Intimidation, Investigation, Medicine, "
  + "Nature, Perception, Performance, Persuasion, Religion, Sleight of Hand, Stealth, Survival. Crafts are tool proficiencies "
  + "(Cook's Utensils, Smith's Tools, Brewer's Supplies, Thieves' Tools...), never a \"Craft\" skill. "
  + "Never use Pathfinder terms such as Strike, circumstance bonus, off-guard / flat-footed, 'resistance 2' or 'per encounter'.";

// Grand Design's own gameItem.kind -> dnd5e activation.type. Round out with "special" for a
// generic passive fallback since dnd5e's "none" activation still shows an (unusable) Use button;
// "special"/"none" are both valid per CONFIG.DND5E.abilityActivationTypes, "none" reads cleanest
// for a true always-on passive.
const ACTIVATION_TYPE_BY_KIND = {
  feat: "action",
  action: "action",
  reaction: "reaction",
  free: "bonus",
  passive: "none",
  spell: "action",
  weapon: "action"
};

// Grand Design's mechanics.frequency.per -> dnd5e recovery period (CONFIG.DND5E.limitedUsePeriods).
// dnd5e's recovery vocabulary doesn't cleanly cover "per minute"/"per hour", so those are left
// uncapped structurally (the cadence is still stated in the description text) rather than forced
// into a misleading recovery bucket.
const RECOVERY_PERIOD_BY_FREQUENCY_PERIOD = {
  round: "turn",
  minute: null,
  hour: null,
  day: "lr",
  encounter: "sr",
  unlimited: null
};

// Best-effort PF2e-weapon-trait -> dnd5e weapon-property mapping. Approximate by design (the two
// systems' weapon trait vocabularies don't line up 1:1); unrecognized traits are dropped rather
// than guessed at, since an incorrect property is worse than a missing one and this is always
// GM-reviewable on the created Item afterward.
const WEAPON_PROPERTY_BY_TRAIT = {
  agile: "fin",
  finesse: "fin",
  thrown: "thr",
  reach: "rch",
  "two-hand": "two",
  twohanded: "two",
  versatile: "ver",
  light: "lgt",
  heavy: "hvy",
  ranged: "amm"
};

export function buildItemSource5e(kind, entry) {
  const gameKind = entry.gameItem.kind;
  if (gameKind === "spell") return buildSpell(entry);
  if (gameKind === "weapon") return buildWeapon(entry);
  return buildFeat(kind, entry, gameKind);
}

export function getCharacterLevel5e(actor) {
  // dnd5e derives total character level from summed class-item levels; system.details.level is
  // the already-derived plain integer (unlike PF2e's nested { value } level field).
  return Number.isInteger(actor.system?.details?.level) ? actor.system.details.level : null;
}

// dnd5e characters can multiclass: actor.classes is { identifier: classItem }. Returns e.g.
// "Fighter 3 / Wizard 2" for the prompt, or null. Tolerates plain objects (harness, tests).
export function getCharacterClass5e(actor) {
  let classItems = actor?.classes && typeof actor.classes === "object" ? Object.values(actor.classes) : [];
  if (!classItems.length && typeof actor?.items?.filter === "function") classItems = actor.items.filter((item) => item?.type === "class");
  const labels = classItems
    .filter((item) => typeof item?.name === "string" && item.name.trim())
    .map((item) => {
      const levels = item.system?.levels;
      return classItems.length > 1 && Number.isInteger(levels) ? `${item.name.trim()} ${levels}` : item.name.trim();
    });
  return labels.length ? labels.join(" / ") : null;
}

// The 18 5e skills (system.skills keys). Board 3962a001: a proposal must never hand the character
// proficiency in a skill or tool they are already proficient with on the sheet.
const SKILL_LABELS_5E = {
  acr: "Acrobatics", ani: "Animal Handling", arc: "Arcana", ath: "Athletics", dec: "Deception",
  his: "History", ins: "Insight", itm: "Intimidation", inv: "Investigation", med: "Medicine",
  nat: "Nature", prc: "Perception", prf: "Performance", per: "Persuasion", rel: "Religion",
  slt: "Sleight of Hand", ste: "Stealth", sur: "Survival"
};

// Board 3962a001: "Hexblade: Infernal Pact" handed a Warlock 3 Pact Magic and Eldritch Blast --
// features every Warlock already has from level 1 -- because stage 2 only ever saw actor.systemClass
// as a bare string. Returns the character's own class/subclass feature names, proficient skills, and
// owned tool proficiency items, so the proposal prompt (and pipeline.js's deterministic backstop) can
// see what is already on the sheet. Best-effort and additive: an actor missing any of this (a plain
// harness object, an unusual sheet) simply contributes less, never throws.
export function getCharacterKnownFeatures5e(actor) {
  const names = new Set();
  const items = typeof actor?.items?.filter === "function"
    ? actor.items.filter((item) => ["feat", "class", "subclass", "tool"].includes(item?.type))
    : [];
  for (const item of items) if (typeof item?.name === "string" && item.name.trim()) names.add(item.name.trim());
  const skills = actor?.system?.skills;
  if (skills && typeof skills === "object") {
    for (const [key, skill] of Object.entries(skills)) {
      if (Number(skill?.value ?? 0) >= 1 && SKILL_LABELS_5E[key]) names.add(SKILL_LABELS_5E[key]);
    }
  }
  return [...names];
}

export function equivalentLabel5e(kind, entry) {
  return kind === "class" ? entry.system_chassis ?? "Pending 5E class chassis review" : entry.system_equivalent;
}

function buildFeat(kind, entry, gameKind) {
  const system = {
    type: { value: kind === "class" ? "class" : "feat", subtype: kind === "class" ? "" : "general" }
  };
  const activationType = ACTIVATION_TYPE_BY_KIND[gameKind] ?? "action";
  const structured = readStructuredFor(entry, SYSTEM_ID);
  if (structured) {
    return buildStructured5e({ type: "feat", system }, entry, structured, { activationType, isSpell: false, passive: gameKind === "passive" });
  }
  const postCreate = async (item) => {
    const activityType = gameKind === "passive" ? "utility" : activityTypeForRoll(entry.mechanics.roll?.kind);
    await item.createActivity(
      activityType,
      {
        activation: {
          type: activationType,
          value: activationType === "none" ? null : 1,
          condition: entry.mechanics.trigger ?? ""
        },
        duration: durationFromMechanics(entry.mechanics),
        uses: usesFromFrequency(entry.mechanics.frequency)
      },
      { renderSheet: false }
    );
  };
  return { source: { type: "feat", system }, postCreate };
}

function buildSpell(entry) {
  const activationType = ACTIVATION_TYPE_BY_KIND.spell;
  const system = {
    level: clamp(entry.gameItem.rank ?? 0, 0, 9),
    school: entry.gameItem.school,
    method: "spell",
    activation: { type: activationType, value: entry.mechanics.actions ?? 1 },
    duration: durationFromMechanics(entry.mechanics)
  };
  const structured = readStructuredFor(entry, SYSTEM_ID);
  if (structured) {
    return buildStructured5e({ type: "spell", system }, entry, structured, { activationType, isSpell: true, passive: false });
  }
  const postCreate = async (item) => {
    await item.createActivity(
      activityTypeForRoll(entry.mechanics.roll?.kind),
      {
        activation: { type: activationType, value: entry.mechanics.actions ?? 1 },
        duration: durationFromMechanics(entry.mechanics),
        uses: usesFromFrequency(entry.mechanics.frequency)
      },
      { renderSheet: false }
    );
  };
  return { source: { type: "spell", system }, postCreate };
}

function buildWeapon(entry) {
  const damage = parseWeaponDamage(entry.gameItem.damage);
  const isMartial = entry.gameItem.category === "martial";
  // "thrown" deliberately excluded: in 5E a thrown weapon (dagger, handaxe, javelin, ...) is
  // still classified as Melee, just with the thrown property -- being throwable doesn't make it
  // a Ranged weapon the way an actual bow/crossbow/sling is.
  const isRanged = (entry.gameItem.traits ?? []).some((trait) => /^ranged$|bow|sling|crossbow/i.test(trait));
  const system = {
    // dnd5e auto-populates a default "attack" Activity on weapon-type Items at creation time,
    // and that default activity includes the item's own damage.base via includeBase:true -- so
    // unlike feat/spell, no postCreate step is needed here to get a usable attack.
    type: { value: `${isMartial ? "martial" : "simple"}${isRanged ? "R" : "M"}` },
    damage: { base: { number: damage.number, denomination: damage.denomination, bonus: damage.bonus, types: [entry.gameItem.damageType] } },
    properties: mapWeaponProperties(entry.gameItem.traits)
  };
  const source = { type: "weapon", system };
  // A weapon keeps dnd5e's own default attack activity; structured modifiers still become a real
  // Active Effect (always on while the weapon is owned: a weapon has nothing to "switch on").
  const structured = readStructuredFor(entry, SYSTEM_ID);
  const effect = structured ? effectFromStructured5e(entry, structured, { disabled: false }) : null;
  if (effect) source.effects = [effect];
  return { source, postCreate: null, descriptionHtml: structured ? describeStructured5e(entry, structured, { toggled: false }) : "" };
}

// --- Structured mechanics -> dnd5e 5.x item data ----------------------------------------------
// Checked against the installed dnd5e 5.3.3 source: BaseActivityData (activation, duration, range
// { value, units }, target.template { type, size, units }, uses { spent, max, recovery[{ period,
// type }] }), DamageField { number, denomination, bonus, types, custom, scaling }, attack activity
// { attack: { ability, bonus, flat, type: { value, classification } }, damage: { includeBase, parts } },
// save activity { damage: { onSave, parts }, save: { ability: Set, dc: { calculation, formula } } }
// (calculation "" = the flat formula, "spellcasting", or an ability key), heal activity { healing },
// damage activity { damage: { parts } }. Recovery periods from CONFIG.DND5E.limitedUsePeriods;
// template types from CONFIG.DND5E.areaTargetTypes (emanation is "radius", a burst a "sphere").
// Modifiers and advantage are Active Effects on core dnd5e keys (no midi-qol): attributes.ac.bonus,
// bonuses.<mwak|rwak|msak|rsak>.<attack|damage>, bonuses.abilities.save, abilities.<abl>.bonuses.save,
// skills.<key>.bonuses.check, attributes.init.bonus, and the AdvantageModeField roll.mode keys.

const RECOVERY_BY_USES_PER = {
  turn: "turn", round: "turn", encounter: "sr", hour: "sr", day: "day", "short-rest": "sr", "long-rest": "lr"
};
const TEMPLATE_BY_AREA = {
  cone: "cone", burst: "sphere", emanation: "radius", line: "line", sphere: "sphere", cube: "cube", cylinder: "cylinder"
};
const ATTACK_KEYS = ["mwak", "rwak", "msak", "rsak"];
// "class" DC for a non-spell ability: 8 + proficiency + the character's best ability modifier --
// the 2024 rules' shape for a feature DC, computed by dnd5e itself from the actor's roll data.
const CLASS_DC_FORMULA = "8 + @prof + max(@abilities.str.mod, @abilities.dex.mod, @abilities.con.mod, @abilities.int.mod, @abilities.wis.mod, @abilities.cha.mod)";
const ADD_MODE = 2; // CONST.ACTIVE_EFFECT_MODES.ADD (a literal: this file also runs in Node)

function buildStructured5e(source, entry, s, { activationType, isSpell, passive }) {
  const toggled = !passive && isActivated5e(s);
  const effect = effectFromStructured5e(entry, s, { disabled: toggled });
  if (effect) source.effects = [effect];
  const activities = structuredActivities5e(entry, s, { activationType, isSpell, passive });
  const postCreate = async (item) => {
    for (const { type, data } of activities) await item.createActivity(type, data, { renderSheet: false });
  };
  return { source, postCreate, activities, descriptionHtml: describeStructured5e(entry, s, { toggled }) };
}

function isActivated5e(s) {
  return Boolean(s.damage || s.heal || s.save || s.attack);
}

/**
 * The Activities a structured entry needs, as { type, data } for item.createActivity(). One main
 * activity (attack > save > damage > heal > utility); a heal riding along with a damaging effect
 * gets its own heal activity so both roll from the sheet.
 */
export function structuredActivities5e(entry, s, { activationType, isSpell, passive }) {
  const base = {
    activation: {
      type: activationType,
      value: activationType === "none" ? null : (isSpell ? entry.mechanics.actions ?? 1 : 1),
      condition: entry.mechanics.trigger ?? ""
    },
    duration: durationFromMechanics(entry.mechanics),
    uses: s.uses ? usesFromStructured(s.uses) : usesFromFrequency(entry.mechanics.frequency)
  };
  // A spell's activities inherit range/target from the spell Item unless `override` is set (live
  // check: a spell attack's 60 ft came back empty without it); feats read the activity's own.
  const override = isSpell ? { override: true } : {};
  if (s.area) {
    base.target = { template: { type: TEMPLATE_BY_AREA[s.area.type], size: String(s.area.value), units: "ft" }, ...override };
    base.range = s.range ? { value: String(s.range.value), units: "ft", ...override } : { units: "self", ...override };
  } else if (s.range) {
    base.range = { value: String(s.range.value), units: "ft", ...override };
  }
  const parts = (s.damage ?? []).map((part) => damagePart5e(part, part.type ? [part.type] : []));
  const activities = [];
  if (s.attack) {
    const ranged = s.attack.kind === "ranged" || (s.attack.kind === "spell" && (s.range?.value ?? 0) > 10);
    activities.push({
      type: "attack",
      data: {
        ...base,
        attack: { ability: "", bonus: "", flat: false, type: { value: ranged ? "ranged" : "melee", classification: s.attack.kind === "spell" ? "spell" : "weapon" } },
        damage: { includeBase: false, parts }
      }
    });
  } else if (s.save) {
    activities.push({
      type: "save",
      data: {
        ...base,
        damage: { onSave: s.save.basic ? "half" : "none", parts },
        save: { ability: [abilityForSave(s.save.save)], dc: saveDc5e(s.save.dc, isSpell) }
      }
    });
  } else if (parts.length) {
    activities.push({ type: "damage", data: { ...base, damage: { parts } } });
  }
  if (s.heal) {
    activities.push({ type: "heal", data: { ...base, healing: damagePart5e(s.heal, ["healing"]) } });
  }
  if (!activities.length) {
    activities.push({ type: "utility", data: { ...base, ...(passive ? { activation: { ...base.activation, type: "none", value: null } } : {}) } });
  }
  return activities;
}

function damagePart5e(dice, types) {
  return {
    number: dice.count,
    denomination: dice.faces,
    bonus: dice.bonus ? String(dice.bonus) : "",
    types,
    custom: { enabled: false, formula: "" },
    scaling: { mode: "", number: 1, formula: "" }
  };
}

function saveDc5e(dc, isSpell) {
  if (typeof dc === "number") return { calculation: "", formula: String(dc) };
  if (dc === "spell" || isSpell) return { calculation: "spellcasting", formula: "" };
  return { calculation: "", formula: CLASS_DC_FORMULA };
}

function usesFromStructured(uses) {
  const period = RECOVERY_BY_USES_PER[uses.per];
  return { spent: 0, max: String(uses.max), recovery: period ? [{ period, type: "recoverAll" }] : [] };
}

/**
 * One Active Effect carrying every structured modifier and advantage as core dnd5e changes, or
 * null. Always on for a passive; for something the character uses it starts disabled -- the player
 * switches it on while it applies (a "1/encounter: +1 AC" is not a permanent +1 AC). Advantage on
 * attack rolls has no core dnd5e key; it stays in the description.
 */
export function effectFromStructured5e(entry, s, { disabled }) {
  const changes = [];
  for (const modifier of s.modifiers ?? []) {
    const value = modifier.value > 0 ? `+${modifier.value}` : String(modifier.value);
    for (const key of modifierKeys5e(modifier.selector)) changes.push({ key, mode: ADD_MODE, value });
  }
  const advantageKey = advantageKey5e(s.advantage?.on);
  if (advantageKey) changes.push({ key: advantageKey, mode: ADD_MODE, value: "1" });
  if (!changes.length) return null;
  return {
    _id: "grandDesignEff01",
    name: entry.name,
    img: "icons/svg/aura.svg",
    transfer: true,
    disabled: Boolean(disabled),
    changes,
    description: s.advantage?.condition ? `<p>${escapeHtml5e(s.advantage.condition)}</p>` : ""
  };
}

function modifierKeys5e(selector) {
  if (selector === "ac") return ["system.attributes.ac.bonus"];
  if (selector === "attack") return ATTACK_KEYS.map((key) => `system.bonuses.${key}.attack`);
  if (selector === "damage") return ATTACK_KEYS.map((key) => `system.bonuses.${key}.damage`);
  if (selector === "initiative") return ["system.attributes.init.bonus"];
  if (selector === "perception") return ["system.skills.prc.bonuses.check"];
  if (selector === "save:all") return ["system.bonuses.abilities.save"];
  if (selector.startsWith("save:")) return [`system.abilities.${abilityForSave(selector.slice(5))}.bonuses.save`];
  if (selector.startsWith("skill:")) {
    const key = skillKeyFor(selector.slice(6), SYSTEM_ID);
    return key ? [`system.skills.${key}.bonuses.check`] : ["system.bonuses.abilities.skill"];
  }
  return [];
}

function advantageKey5e(on) {
  if (!on || on === "attack") return null;
  if (on.startsWith("save:")) return `system.abilities.${abilityForSave(on.slice(5))}.save.roll.mode`;
  if (on.startsWith("check:")) return `system.abilities.${on.slice(6)}.check.roll.mode`;
  if (on.startsWith("skill:")) {
    const key = skillKeyFor(on.slice(6), SYSTEM_ID);
    return key ? `system.skills.${key}.roll.mode` : null;
  }
  return null;
}

// The inline dnd5e enrichers ([[/damage]], [[/save]], [[/heal]], &Reference[condition]) make the
// description itself rollable, the same way the PF2e adapter uses @Damage/@Check.
function describeStructured5e(entry, s, { toggled }) {
  const lines = [];
  if (s.attack) lines.push(`Make a ${s.attack.kind === "spell" ? "spell" : s.attack.kind} attack roll against the target's AC.`);
  if (s.damage) lines.push(`Damage: ${s.damage.map((part) => `[[/damage ${diceFormula(part)}${part.type ? ` ${part.type}` : ""}]]`).join(" + ")}`);
  if (s.save) {
    const ability = abilityForSave(s.save.save);
    const dc = typeof s.save.dc === "number" ? ` dc=${s.save.dc}` : "";
    lines.push(`Save: [[/save ability=${ability}${dc}]]${s.save.basic ? " (half damage on a success)" : ""}`);
  }
  if (s.heal) lines.push(`Healing: [[/heal ${diceFormula(s.heal)}]]`);
  if (s.area) lines.push(`Area: ${s.area.value}-foot ${TEMPLATE_BY_AREA[s.area.type] === "radius" ? "emanation" : s.area.type}`);
  if (s.range) lines.push(`Range: ${s.range.value} feet`);
  if (s.condition) {
    lines.push(`Condition: &Reference[${escapeHtml5e(s.condition.id)}]${s.condition.value ? ` ${s.condition.value}` : ""}${s.condition.duration ? ` (${escapeHtml5e(s.condition.duration)})` : ""}`);
  }
  for (const modifier of s.modifiers ?? []) {
    lines.push(`${modifier.value > 0 ? "+" : ""}${modifier.value} to ${escapeHtml5e(selectorLabel5e(modifier.selector))}${modifier.predicate ? ` (${escapeHtml5e(modifier.predicate)})` : ""}`);
  }
  if (s.advantage) {
    lines.push(`Advantage on ${escapeHtml5e(selectorLabel5e(s.advantage.on))}${s.advantage.condition ? ` (${escapeHtml5e(s.advantage.condition)})` : ""}`);
  }
  if (toggled && ((s.modifiers ?? []).length || advantageKey5e(s.advantage?.on))) {
    lines.push(`Turn on the "${escapeHtml5e(entry.name)}" effect on the character sheet while it applies.`);
  }
  if (s.uses) lines.push(`Uses: ${s.uses.max} per ${s.uses.per.replace("-", " ")}`);
  return lines.length ? `<p><strong>Rules:</strong></p><ul>${lines.map((line) => `<li>${line}</li>`).join("")}</ul>` : "";
}

function selectorLabel5e(selector) {
  if (selector === "ac") return "AC";
  if (selector === "attack") return "attack rolls";
  if (selector === "damage") return "damage rolls";
  if (selector === "save:all") return "saving throws";
  if (selector.startsWith("save:")) return `${ABILITY_LABELS_5E[abilityForSave(selector.slice(5))] ?? selector.slice(5)} saving throws`;
  if (selector.startsWith("check:")) return `${ABILITY_LABELS_5E[selector.slice(6)] ?? selector.slice(6)} checks`;
  if (selector.startsWith("skill:")) {
    const key = skillKeyFor(selector.slice(6), SYSTEM_ID);
    return `${SKILL_LABELS_5E[key] ?? selector.slice(6)} checks`;
  }
  return selector;
}

const ABILITY_LABELS_5E = { str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma" };

/**
 * Switches a superseded Skill/Class Item's mechanics off (contract section 4) and returns the
 * update for item.update(): every Activity is removed (its data stashed in a flag so a GM can
 * restore it), every Active Effect disabled, and the description opens with "Superseded by X".
 * The Item stays: it is the record the new entry's lineage points at. `by` is the new entry's name.
 */
export function markSuperseded5e(item, { by } = {}) {
  const source = item?._source ?? item ?? {};
  const system = source.system ?? {};
  const activities = system.activities && typeof system.activities === "object" ? system.activities : {};
  const update = {
    "system.description.value": supersededLine(by) + stripSupersededLine(system.description?.value ?? ""),
    "flags.grand-design-ai.superseded": true
  };
  const ids = Object.keys(activities);
  if (ids.length) update["flags.grand-design-ai.supersededActivities"] = structuredClone(activities);
  for (const id of ids) update[`system.activities.-=${id}`] = null;
  const effects = effectSources(item);
  // The whole effect source, not just { _id, disabled }: a partial embedded document in a parent
  // update is validated as a full one (live: "name: may not be undefined" warnings).
  if (effects.length) update.effects = effects.map((effect) => ({ ...structuredClone(effect), disabled: true }));
  // A feat's own item-level uses (the Combination badge, older items) are spent too.
  if (system.uses?.max) update["system.uses.spent"] = Number(system.uses.max) || 0;
  return update;
}

function effectSources(item) {
  const raw = item?._source?.effects ?? item?.effects;
  const list = Array.isArray(raw) ? raw : typeof raw?.map === "function" ? raw.map((effect) => effect) : [];
  return list.map((effect) => effect?._source ?? effect).filter((effect) => typeof effect?._id === "string");
}

function activityTypeForRoll(rollKind) {
  const text = (rollKind ?? "").toLowerCase();
  if (text.includes("attack")) return "attack";
  if (text.includes("save")) return "save";
  return "utility";
}

// Parses Grand Design's freeform mechanics.duration string (e.g. "8 hours", "instant", "until
// the start of your next turn") into dnd5e's { value, units } duration shape. Anything that
// doesn't match a recognized time unit falls back to "spec" (dnd5e's own "special duration,
// described in the text" bucket) rather than guessing -- the full text is always still visible
// in the created Item's description via createMechanicsHtml.
function durationFromMechanics(mechanics) {
  const raw = (mechanics.duration ?? "").trim().toLowerCase();
  if (!raw || raw === "instant" || raw === "instantaneous") return { units: "inst" };
  if (/permanent/.test(raw)) return { units: "perm" };
  const match = /(\d+)\s*(round|minute|hour|day|turn)/.exec(raw);
  if (match) return { value: match[1], units: match[2] };
  return { units: "spec" };
}

function usesFromFrequency(frequency) {
  const period = RECOVERY_PERIOD_BY_FREQUENCY_PERIOD[frequency?.per] ?? null;
  if (!period || !Number.isInteger(frequency?.max)) return { max: "", recovery: [] };
  return { max: String(frequency.max), recovery: [{ period, type: "recoverAll" }] };
}

function mapWeaponProperties(traits) {
  return [...new Set((traits ?? []).map((trait) => WEAPON_PROPERTY_BY_TRAIT[String(trait).toLowerCase()]).filter(Boolean))];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function parseWeaponDamage(formula) {
  const match = /^(\d+)d(\d+)(?:\s*\+\s*(\d+))?/i.exec(formula);
  return { number: Number(match[1]), denomination: Number(match[2]), bonus: match[3] ?? "" };
}

// --- Populate: NPC/monster/item spawning -------------------------------------------------------
// Turns a system-agnostic spec from scripts/populate.js into a real dnd5e Actor/Item source.
// Field names verified empirically against a live dnd5e 5.3.3 world the same way as the rest of
// this adapter (see the file header): system.abilities.{key}.value, system.attributes.hp/ac/
// movement, system.details.cr (auto-derives system.details.xp.value -- never set xp directly),
// system.traits.size, system.magicalBonus as a STRING, system.properties as a plain array.

const ABILITY_KEYS_5E = ["str", "dex", "con", "int", "wis", "cha"];

// dnd5e has no single canonical "NPC level -> CR" formula (NPCs aren't leveled the way PCs are);
// this is a deliberately simple, GM-adjustable approximation for a freshly spawned Populate NPC,
// not a claim of mechanical balance -- the created Actor's CR is always hand-editable afterward.
function approximateCrFromLevel(level) {
  return Math.max(0, Math.round((level ?? 1) / 2));
}

/**
 * Builds a dnd5e NPC Actor source (works for both "npc" and "monster" spec.actorKind) plus any
 * embedded Item sources (a starting weapon for an NPC, a natural attack for a monster) that
 * should be created on the Actor right after it exists. Mirrors buildItemSource5e's
 * {source, postCreate}-style split, but returns `embeddedItems` (plain array) instead of a single
 * postCreate callback since dnd5e weapon Items need no Activity-creation step of their own --
 * dnd5e auto-populates a usable default "attack" Activity on any weapon-type Item at creation.
 */
export function buildNpcActorSource5e(spec) {
  const isMonster = spec.actorKind === "monster";
  const abilities = spec.abilities ?? {};
  const system = {
    abilities: Object.fromEntries(ABILITY_KEYS_5E.map((key) => [key, { value: abilities[key] ?? 10 }])),
    attributes: {
      hp: { value: spec.hp, max: spec.hp },
      ac: { flat: spec.ac, calc: "flat" },
      movement: { walk: spec.speed ?? 30 }
    },
    details: {
      // An AI-written NPC (board dee25a95) states its CR; the local generator only has a level.
      cr: isMonster || Number.isFinite(spec.cr) ? spec.cr : approximateCrFromLevel(spec.level),
      type: { value: isMonster ? (spec.creatureType ?? "humanoid") : "humanoid" },
      biography: { value: spec.bio ? `<p>${escapeHtml5e(spec.bio)}</p>` : "" }
    },
    traits: { size: isMonster ? (spec.size ?? "med") : "med" }
  };
  const source = { name: spec.name, type: "npc", system };

  const embeddedItems = [];
  // A weapon when the spec has one (dnd5e derives its attack from the wielder), else its natural
  // attack. Local specs are unchanged by this: NPCs carry only a weapon, monsters only an attack.
  if (spec.weaponSpec) {
    embeddedItems.push(buildWeaponItemData5e(spec.weaponSpec));
  } else if (spec.attack) {
    embeddedItems.push(buildNaturalAttackItemData5e(spec.attack));
  }
  return { source, embeddedItems };
}

/** Builds a real dnd5e weapon Item source from a populate.js weapon item spec. */
export function buildEquipmentItemSource5e(spec) {
  return { source: buildWeaponItemData5e(spec), postCreate: null };
}

function buildWeaponItemData5e(weaponSpec) {
  const damage = parseWeaponDamage(weaponSpec.damage);
  const isMartial = weaponSpec.category === "martial";
  const bonus = Number.isInteger(weaponSpec.bonus) ? weaponSpec.bonus : 0;
  const properties = mapWeaponProperties(weaponSpec.traits);
  if (bonus > 0) properties.push("mgc");
  const system = {
    type: { value: `${isMartial ? "martial" : "simple"}M` },
    damage: {
      base: {
        number: damage.number,
        denomination: damage.denomination,
        bonus: bonus > 0 ? String(bonus) : "",
        types: [weaponSpec.damageType]
      }
    },
    properties: [...new Set(properties)],
    rarity: weaponSpec.rarity ?? "common"
  };
  if (bonus > 0) system.magicalBonus = String(bonus);
  return { name: weaponSpec.name, type: "weapon", system };
}

/** A monster's built-in attack (bite, claw, ...) modeled as a "natural" weapon-type Item. */
function buildNaturalAttackItemData5e(attack) {
  const damage = parseWeaponDamage(attack.damage);
  const system = {
    type: { value: "natural" },
    damage: {
      base: {
        number: damage.number,
        denomination: damage.denomination,
        bonus: damage.bonus ?? "",
        types: [attack.damageType]
      }
    },
    properties: []
  };
  return { name: attack.name, type: "weapon", system };
}

// --- Titles ---------------------------------------------------------------------------------
// A Title (lineage.js#createTitleSource) is a flavor badge earned for a specific achievement, not
// a usable ability -- modeled the same way a no-activation passive feat is (system.type.value
// "feat", subtype "general"), but with no postCreate Activity step at all, since there's nothing
// to activate. buildTitleGrantItemSource5e builds the separate, optional flavor Item a Title can
// bundle (Titles wiki page: "Wand of the Mrsha", "Bow of Thiypc's Promise") -- kept deliberately
// plain (a "loot"-type Item with just a name/description) since Grand Design has no way to know
// what mechanical shape an arbitrary narrative reward item should take; the GM always finishes it.

export function buildTitleItemSource5e() {
  const system = { type: { value: "feat", subtype: "general" } };
  return { source: { type: "feat", system }, postCreate: null };
}

export function buildTitleGrantItemSource5e(grant) {
  const system = { description: { value: `<p>${escapeHtml5e(grant.description)}</p>` }, rarity: "common" };
  return { source: { name: grant.name, type: "loot", system } };
}

// --- Combination Skills -----------------------------------------------------------------------
// dnd5e counterpart of buildCombinationItemSourcePf2e -- see that function for why a combination is
// modeled as a granted ability Item on both systems rather than as PF2e's "effect" Item type or
// dnd5e's ActiveEffect documents (the two have no common shape between them, and a combination is
// something the participants USE, not a status sitting on them). A "feat"-type Item with the
// "class" subtype is dnd5e's plainest granted-ability container, and takes no postCreate Activity
// step: a combination resolves at the table under the GM, not through an Item roll.

// Deliberately does NOT try to mark an amplified combination as "rare": dnd5e's feat schema has no
// rarity field at all (verified live against dnd5e 5.3.3 -- a rarity key on a feat is silently
// dropped), since rarity belongs to physical items. The band is already stated in the Item's own
// description by lineage.js#describeCombinationHtml, which is where it actually reaches a player.
export function buildCombinationItemSource5e() {
  const system = {
    type: { value: "class", subtype: "" },
    // dnd5e surfaces limited uses on the Item itself; a combination is a one-shot working that
    // api.js#endCombinationSkill deletes outright afterward, so a single use makes its
    // spend-once nature legible on the sheet for as long as it exists.
    uses: { spent: 0, max: "1", recovery: [] }
  };
  return { source: { type: "feat", system }, postCreate: null };
}

function escapeHtml5e(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
