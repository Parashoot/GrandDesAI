// Horror Rank stage suppression (owner decision 2026-09-29, conversion rules section 6): each stage
// gained switches off one class feat or archetype dedication (PF2e) / one feat or class feature
// (dnd5e) on the character sheet, GM-confirmed; losing a stage gives one back.
//
// Same approach as markSuperseded (the adapters' way to switch a replaced Grand Design Item off),
// but for the system's OWN feats and with an exact way back: everything the suppression overwrites
// is stashed in flags.grand-design-ai.horrorSuppressed, and restoreSuppressedFeature puts exactly
// that back. The Item stays on the sheet, labelled, so the player sees what the horror took.
//
// Pure (no Foundry globals): each function reads an Item (or its plain source) and returns the
// update object for item.update(), so the tests run the same code on both systems in Node.
import { HORROR_SUPPRESSED_ITEM_FLAG, MODULE_ID } from "../constants.js";

const FLAG_PATH = `flags.${MODULE_ID}.${HORROR_SUPPRESSED_ITEM_FLAG}`;
const NAME_MARK = " (suppressed)";
const LINE_CLASS = "grand-design-horror-suppressed";

// Read through _source when it exists: derived data (a PF2e feat's prepared rules, a dnd5e item's
// computed uses) is not what an update should write back.
function sourceOf(item) {
  return item?._source ?? item ?? {};
}

function flagsOf(item) {
  return sourceOf(item).flags?.[MODULE_ID] ?? item?.flags?.[MODULE_ID] ?? {};
}

function traitsOf(system) {
  const value = system?.traits?.value;
  return Array.isArray(value) ? value.map((trait) => String(trait).toLowerCase()) : [];
}

/** True for an Item the module made (a Class, Skill, Title, Combination...): never a candidate. */
export function isGrandDesignItem(item) {
  const flags = flagsOf(item);
  if (typeof item?.getFlag === "function" && item.getFlag(MODULE_ID, "registryId")) return true;
  // Only the suppression stash itself does not make an Item "ours".
  return Object.keys(flags).some((key) => key !== HORROR_SUPPRESSED_ITEM_FLAG);
}

/** True when the Item already carries a Horror Rank suppression. */
export function isSuppressedFeature(item) {
  const mark = flagsOf(item)?.[HORROR_SUPPRESSED_ITEM_FLAG];
  return Boolean(mark && typeof mark === "object");
}

/**
 * Is this a feature a Horror Rank stage may suppress? PF2e: a class feat (category "class", which
 * includes archetype feats) or anything with the dedication trait -- class FEATURES (category
 * "classfeature") are the chassis, not a choice, and stay. dnd5e: a feat Item of type "feat" or
 * "class" (a class feature). Never a Grand Design Item, never one already suppressed.
 */
export function isSuppressibleFeature(item, systemId) {
  if (!item || item.type !== "feat" || isGrandDesignItem(item) || isSuppressedFeature(item)) return false;
  const system = sourceOf(item).system ?? {};
  if (systemId === "pf2e") {
    const category = String(system.category ?? system.featType?.value ?? "").toLowerCase();
    const traits = traitsOf(system);
    return category === "class" || category === "archetype" || traits.includes("dedication");
  }
  if (systemId === "dnd5e") {
    const type = String(system.type?.value ?? "").toLowerCase();
    return type === "feat" || type === "class";
  }
  return false;
}

const COMBAT_WORDS = /\b(strike|attack|damage|weapon|spell attack|saving throw|basic (?:reflex|fortitude|will)|armor class|\bac\b|hit points|temporary hit points|reaction|shield|grapple|trip|shove|critical)\b/i;

/**
 * How combat-relevant a feature is (the design: "combat-relevant ones first"). A score, not a
 * verdict: things that fire in a fight (rule elements, actions/reactions, attack/save activities,
 * active effects) outrank a downtime or social feat. -> { score, reasons: [...] }.
 */
export function combatRelevance(item, systemId) {
  const system = sourceOf(item).system ?? {};
  const reasons = [];
  let score = 0;
  const description = String(system.description?.value ?? "");
  if (systemId === "pf2e") {
    const rules = Array.isArray(system.rules) ? system.rules : [];
    if (rules.length) {
      score += 2;
      reasons.push("rule elements");
    }
    const actionType = String(system.actionType?.value ?? "").toLowerCase();
    if (["action", "reaction", "free"].includes(actionType)) {
      score += 2;
      reasons.push(actionType);
    }
    const combatTraits = traitsOf(system).filter((trait) => ["attack", "flourish", "stance", "press", "rage", "open"].includes(trait));
    if (combatTraits.length) {
      score += 3;
      reasons.push(combatTraits.join("/"));
    }
  } else if (systemId === "dnd5e") {
    const activities = Object.values(system.activities && typeof system.activities === "object" ? system.activities : {});
    if (activities.some((activity) => ["attack", "save", "damage", "heal"].includes(String(activity?.type ?? "")))) {
      score += 3;
      reasons.push("attack/save activity");
    } else if (activities.length) {
      score += 1;
      reasons.push("activity");
    }
    const effects = effectSources(item);
    if (effects.some((effect) => Array.isArray(effect.changes) && effect.changes.length)) {
      score += 2;
      reasons.push("active effect");
    }
  }
  if (COMBAT_WORDS.test(description.replace(/<[^>]+>/g, " "))) {
    score += 1;
    reasons.push("combat text");
  }
  return { score, reasons };
}

function featureLevel(item, systemId) {
  const system = sourceOf(item).system ?? {};
  if (systemId === "pf2e") return Number(system.level?.value) || 0;
  return Number(system.prerequisites?.level ?? system.requirements?.level) || 0;
}

/**
 * The actor's suppressible features, best default first: most combat-relevant, then highest level,
 * then name. -> [{ itemId, name, level, combat, reasons }]. `items` is any iterable of Items.
 */
export function listSuppressibleFeatures(items, systemId) {
  const list = [];
  for (const item of items ?? []) {
    if (!isSuppressibleFeature(item, systemId)) continue;
    const { score, reasons } = combatRelevance(item, systemId);
    list.push({ itemId: item.id ?? item._id, name: String(item.name ?? ""), level: featureLevel(item, systemId), combat: score, reasons });
  }
  return list
    .filter((candidate) => candidate.itemId)
    .sort((a, b) => b.combat - a.combat || b.level - a.level || a.name.localeCompare(b.name));
}

function effectSources(item) {
  const raw = item?._source?.effects ?? item?.effects;
  const list = Array.isArray(raw) ? raw : typeof raw?.map === "function" ? raw.map((effect) => effect) : [];
  return list.map((effect) => effect?._source ?? effect).filter((effect) => typeof effect?._id === "string");
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** The label line the suppression puts at the top of the description. */
export function suppressedLine(stage) {
  const which = Number.isInteger(stage) && stage > 0 ? ` (Stage ${stage})` : "";
  return `<p class="${LINE_CLASS}"><strong>Suppressed by Horror Rank${escapeHtml(which)}.</strong> This feature does not work until the Horror Rank drops and the GM restores it.</p>`;
}

function stripSuppressedLine(html) {
  return String(html).replace(new RegExp(`^<p class="${LINE_CLASS}">[\\s\\S]*?<\\/p>`), "");
}

/**
 * The item.update() that switches a feature off. PF2e: rule elements emptied, frequency spent.
 * dnd5e: activities removed, Active Effects disabled, item uses spent. Both: " (suppressed)" on the
 * name and a line on top of the description. Everything overwritten is stashed in the Item's
 * horrorSuppressed flag ({ stage, at, prior: {...} }) for restoreSuppressedFeature.
 */
export function suppressFeature(item, systemId, { stage = null, at = new Date().toISOString() } = {}) {
  const source = sourceOf(item);
  const system = source.system ?? {};
  const prior = {};
  const update = {};
  const name = typeof item?.name === "string" ? item.name : source.name;
  if (typeof name === "string" && !name.endsWith(NAME_MARK)) update.name = `${name}${NAME_MARK}`;
  if (typeof system.description?.value === "string" || system.description) {
    update["system.description.value"] = suppressedLine(stage) + stripSuppressedLine(system.description?.value ?? "");
  }
  if (systemId === "pf2e") {
    const rules = Array.isArray(system.rules) ? system.rules : [];
    prior.rules = structuredClone(rules);
    update["system.rules"] = [];
    if (system.frequency && typeof system.frequency === "object") {
      if (Number.isFinite(system.frequency.value)) prior.frequencyValue = system.frequency.value;
      update["system.frequency.value"] = 0;
    }
  } else if (systemId === "dnd5e") {
    const activities = system.activities && typeof system.activities === "object" ? system.activities : {};
    prior.activities = structuredClone(activities);
    for (const id of Object.keys(activities)) update[`system.activities.-=${id}`] = null;
    const effects = effectSources(item);
    if (effects.length) {
      prior.disabledEffectIds = effects.filter((effect) => effect.disabled === true).map((effect) => effect._id);
      // Whole sources: a partial embedded document in a parent update is validated as a full one.
      update.effects = effects.map((effect) => ({ ...structuredClone(effect), disabled: true }));
    }
    if (system.uses?.max) {
      const spent = Number(system.uses.spent);
      prior.usesSpent = Number.isFinite(spent) ? spent : 0;
      update["system.uses.spent"] = Number(system.uses.max) || 0;
    }
  }
  update[FLAG_PATH] = { stage: Number.isInteger(stage) ? stage : null, at, systemId, prior };
  return update;
}

/**
 * The item.update() that undoes suppressFeature exactly: rules / activities / frequency / uses /
 * effect states back to what the stash recorded, the name and description marks removed, the flag
 * cleared. Returns null for an Item that carries no suppression.
 */
export function restoreSuppressedFeature(item, systemId) {
  const mark = flagsOf(item)?.[HORROR_SUPPRESSED_ITEM_FLAG];
  if (!mark || typeof mark !== "object") return null;
  const prior = mark.prior ?? {};
  const source = sourceOf(item);
  const system = source.system ?? {};
  const update = { [`flags.${MODULE_ID}.-=${HORROR_SUPPRESSED_ITEM_FLAG}`]: null };
  const name = typeof item?.name === "string" ? item.name : source.name;
  if (typeof name === "string" && name.endsWith(NAME_MARK)) update.name = name.slice(0, -NAME_MARK.length);
  if (typeof system.description?.value === "string") update["system.description.value"] = stripSuppressedLine(system.description.value);
  const bySystem = mark.systemId ?? systemId;
  if (bySystem === "pf2e") {
    if (Array.isArray(prior.rules)) update["system.rules"] = structuredClone(prior.rules);
    if (system.frequency && typeof system.frequency === "object") {
      const value = Number.isFinite(prior.frequencyValue) ? prior.frequencyValue : system.frequency.max;
      if (Number.isFinite(value)) update["system.frequency.value"] = value;
    }
  } else if (bySystem === "dnd5e") {
    if (prior.activities && typeof prior.activities === "object") update["system.activities"] = structuredClone(prior.activities);
    const effects = effectSources(item);
    if (effects.length) {
      const wasOff = new Set(Array.isArray(prior.disabledEffectIds) ? prior.disabledEffectIds : []);
      update.effects = effects.map((effect) => ({ ...structuredClone(effect), disabled: wasOff.has(effect._id) }));
    }
    if (Number.isFinite(prior.usesSpent)) update["system.uses.spent"] = prior.usesSpent;
  }
  return update;
}
