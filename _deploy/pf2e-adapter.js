// PF2e-specific translation from a Grand Design entry (system-agnostic: name, tier/level,
// gameItem.kind, mechanics) into a real PF2e Foundry Item. This is the original
// createFeatureSource() logic, unchanged in behavior, extracted here so it lives alongside its
// dnd5e counterpart behind the shared systems/index.js dispatch instead of being the only path.

export const SYSTEM_ID = "pf2e";
export const SYSTEM_LABEL = "Pathfinder Second Edition";

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

  // Nothing more to do after the embedded Item exists -- PF2e models everything through flat
  // system.* fields set above, with no equivalent of dnd5e's separate "Activity" documents.
  return { source: { type, system }, postCreate: null };
}

export function getCharacterLevelPf2e(actor) {
  return actor.system?.details?.level?.value ?? null;
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
