// Shared reader for a proposal's `entry.mechanics.structured` (batch-3 contract section 2): the
// machine-readable half of an entry (damage dice, save, modifiers, uses...) that the adapters turn
// into real item data. The model fills it and the pipeline already drops malformed fields, but an
// entry can also come from a GM edit, an old registry or a test, so every adapter reads it through
// here: anything that is not the documented shape is dropped (never guessed at) and an entry with
// nothing usable returns null, which makes the adapters take exactly the pre-structured path.
// Pure (no Foundry globals): the adapters, validator.js and Node tests all use it.

import { resolveRollCheck } from "../mechanics.js";

export const STRUCTURED_SAVES = ["fortitude", "reflex", "will", "str", "dex", "con", "int", "wis", "cha"];
export const MODIFIER_TYPES = ["circumstance", "status", "item", "untyped"];
export const AREA_TYPES = ["cone", "burst", "emanation", "line", "sphere", "cube", "cylinder"];
export const USES_PERIODS = ["turn", "round", "encounter", "hour", "day", "short-rest", "long-rest"];
export const ATTACK_KINDS = ["melee", "ranged", "spell"];
export const ABILITY_KEYS = ["str", "dex", "con", "int", "wis", "cha"];

const PF2E_SAVE_BY_KEY = {
  fortitude: "fortitude", reflex: "reflex", will: "will",
  str: "fortitude", con: "fortitude", dex: "reflex", int: "will", wis: "will", cha: "will"
};
const ABILITY_BY_SAVE_KEY = {
  fortitude: "con", reflex: "dex", will: "wis",
  str: "str", dex: "dex", con: "con", int: "int", wis: "wis", cha: "cha"
};

/** The structured block of an entry, sanitized; null when absent or when nothing in it is usable. */
export function readStructured(entry) {
  const raw = entry?.mechanics?.structured;
  if (!isRecord(raw)) return null;
  const out = {};
  const damage = (Array.isArray(raw.damage) ? raw.damage : isRecord(raw.damage) ? [raw.damage] : [])
    .map(readDamagePart)
    .filter(Boolean);
  if (damage.length) out.damage = damage;
  const heal = readDice(raw.heal);
  if (heal) out.heal = heal;
  const save = readSave(raw.save);
  if (save) out.save = save;
  if (isRecord(raw.attack) && ATTACK_KINDS.includes(raw.attack.kind)) out.attack = { kind: raw.attack.kind };
  const modifiers = (Array.isArray(raw.modifiers) ? raw.modifiers : []).map(readModifier).filter(Boolean);
  if (modifiers.length) out.modifiers = modifiers;
  const advantage = readAdvantage(raw.advantage);
  if (advantage) out.advantage = advantage;
  const range = positiveInt(raw.range?.value);
  if (range) out.range = { value: range, units: "ft" };
  if (isRecord(raw.area) && AREA_TYPES.includes(raw.area.type) && positiveInt(raw.area.value)) {
    out.area = { type: raw.area.type, value: positiveInt(raw.area.value) };
  }
  const condition = readCondition(raw.condition);
  if (condition) out.condition = condition;
  if (isRecord(raw.uses) && positiveInt(raw.uses.max) && USES_PERIODS.includes(raw.uses.per)) {
    out.uses = { max: positiveInt(raw.uses.max), per: raw.uses.per };
  }
  return Object.keys(out).length ? out : null;
}

function readDamagePart(part) {
  const dice = readDice(part);
  if (!dice) return null;
  const type = slug(part.type);
  return { ...dice, type: type || "untyped" };
}

/** { dice: "2d6", bonus? } or "2d6+3" -> { count, faces, bonus }. */
export function readDice(value) {
  if (!isRecord(value)) return null;
  const match = /^\s*(\d+)\s*d\s*(\d+)\s*(?:([+-])\s*(\d+))?\s*$/i.exec(String(value.dice ?? ""));
  if (!match) return null;
  const count = Number(match[1]);
  const faces = Number(match[2]);
  if (count < 1 || ![4, 6, 8, 10, 12].includes(faces)) return null;
  const inline = match[3] ? Number(`${match[3]}${match[4]}`) : 0;
  const bonus = inline + (Number.isInteger(value.bonus) ? value.bonus : 0);
  return { count, faces, bonus };
}

function readSave(save) {
  if (!isRecord(save) || !STRUCTURED_SAVES.includes(save.save)) return null;
  let dc = null;
  if (save.dc === "class" || save.dc === "spell") dc = save.dc;
  else if (Number.isInteger(Number(save.dc)) && Number(save.dc) > 0) dc = Number(save.dc);
  if (dc === null) dc = "class";
  return { save: save.save, dc, basic: save.basic === true };
}

function readModifier(modifier) {
  if (!isRecord(modifier)) return null;
  const value = Number(modifier.value);
  if (!Number.isInteger(value) || value === 0) return null;
  const selector = readSelector(modifier.selector);
  if (!selector) return null;
  const type = MODIFIER_TYPES.includes(modifier.type) ? modifier.type : "untyped";
  const out = { value, type, selector };
  if (typeof modifier.predicate === "string" && modifier.predicate.trim()) out.predicate = modifier.predicate.trim();
  return out;
}

// ac | attack | damage | perception | initiative | save[:<save>] | skill:<skill>
function readSelector(selector) {
  if (typeof selector !== "string") return null;
  const text = selector.trim().toLowerCase();
  if (["ac", "attack", "damage", "perception", "initiative"].includes(text)) return text;
  if (text === "save" || text === "save:all" || text === "saves") return "save:all";
  const save = /^save:(.+)$/.exec(text);
  if (save) return STRUCTURED_SAVES.includes(save[1]) ? `save:${save[1]}` : null;
  const skill = /^skill:(.+)$/.exec(text);
  if (skill && skill[1].trim()) return `skill:${skill[1].trim()}`;
  return null;
}

function readAdvantage(advantage) {
  if (!isRecord(advantage) || typeof advantage.on !== "string") return null;
  const on = advantage.on.trim().toLowerCase();
  const ok = on === "attack"
    || (/^save:(.+)$/.test(on) && STRUCTURED_SAVES.includes(on.slice(5)))
    || (/^check:(.+)$/.test(on) && ABILITY_KEYS.includes(on.slice(6)))
    || /^skill:.+$/.test(on);
  if (!ok) return null;
  const out = { on };
  if (typeof advantage.condition === "string" && advantage.condition.trim()) out.condition = advantage.condition.trim();
  return out;
}

function readCondition(condition) {
  if (!isRecord(condition)) return null;
  const id = slug(condition.id);
  if (!id) return null;
  const out = { id };
  if (positiveInt(condition.value)) out.value = positiveInt(condition.value);
  if (typeof condition.duration === "string" && condition.duration.trim()) out.duration = condition.duration.trim();
  return out;
}

// --- per-system lookups ------------------------------------------------------------------------

export function pf2eSaveFor(key) {
  return PF2E_SAVE_BY_KEY[key] ?? null;
}

export function abilityForSave(key) {
  return ABILITY_BY_SAVE_KEY[key] ?? null;
}

/** "skill:athletics" / "skill:ath" -> the system's own skill key (athletics / ath), or null. */
export function skillKeyFor(slugText, systemId) {
  const text = String(slugText ?? "").trim().toLowerCase();
  if (!text) return null;
  const DND5E_KEYS = ["acr", "ani", "arc", "ath", "dec", "his", "ins", "itm", "inv", "med", "nat", "prc", "prf", "per", "rel", "slt", "ste", "sur"];
  if (systemId === "dnd5e" && DND5E_KEYS.includes(text)) return text;
  const check = resolveRollCheck(`${text.replace(/-/g, " ")} check`, systemId);
  if (check?.type === "skill" || check?.type === "perception") return check.key === "perception" && systemId === "dnd5e" ? "prc" : check.key;
  return null;
}

// The model writes damage types in either system's words. Each system gets its own; a type it
// does not know becomes untyped (PF2e) / no type (dnd5e) rather than an invalid value.
const PF2E_DAMAGE_TYPES = new Set([
  "acid", "bludgeoning", "cold", "electricity", "fire", "force", "mental", "piercing", "poison", "slashing",
  "sonic", "spirit", "vitality", "void", "bleed", "untyped"
]);
const DND5E_DAMAGE_TYPES = new Set([
  "acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic", "piercing", "poison", "psychic",
  "radiant", "slashing", "thunder"
]);
const PF2E_BY_5E_TYPE = { lightning: "electricity", thunder: "sonic", psychic: "mental", radiant: "vitality", necrotic: "void", holy: "spirit", unholy: "spirit", positive: "vitality", negative: "void" };
const DND5E_BY_PF2E_TYPE = { electricity: "lightning", sonic: "thunder", mental: "psychic", vitality: "radiant", void: "necrotic", spirit: "force", positive: "radiant", negative: "necrotic", holy: "radiant", unholy: "necrotic" };

export function damageTypeFor(type, systemId) {
  const text = slug(type);
  if (systemId === "dnd5e") {
    const mapped = DND5E_BY_PF2E_TYPE[text] ?? text;
    return DND5E_DAMAGE_TYPES.has(mapped) ? mapped : null;
  }
  const mapped = PF2E_BY_5E_TYPE[text] ?? text;
  return PF2E_DAMAGE_TYPES.has(mapped) ? mapped : "untyped";
}

/** readStructured() for one system: damage types translated into that system's vocabulary. */
export function readStructuredFor(entry, systemId) {
  const s = readStructured(entry);
  if (!s?.damage) return s;
  return { ...s, damage: s.damage.map((part) => ({ ...part, type: damageTypeFor(part.type, systemId) })) };
}

export function diceFormula({ count, faces, bonus }) {
  return `${count}d${faces}${bonus > 0 ? `+${bonus}` : bonus < 0 ? `${bonus}` : ""}`;
}

// The "Superseded by X" line both adapters' markSuperseded() put at the top of the description.
export function supersededLine(by) {
  const name = typeof by === "string" && by.trim() ? by.trim() : "a newer entry";
  return `<p class="grand-design-superseded"><strong>Superseded by ${escapeHtml(name)}.</strong> Its mechanics are switched off; it stays on the sheet as lineage.</p>`;
}

// Marking twice (a second supersede, a retry) keeps one line, not a stack.
export function stripSupersededLine(html) {
  return String(html).replace(/^<p class="grand-design-superseded">[\s\S]*?<\/p>/, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function slug(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function positiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
