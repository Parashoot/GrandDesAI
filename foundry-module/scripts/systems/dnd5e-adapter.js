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

export const SYSTEM_ID = "dnd5e";
export const SYSTEM_LABEL = "Dungeons & Dragons Fifth Edition (2024 rules)";

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

export function equivalentLabel5e(kind, entry) {
  return kind === "class" ? entry.system_chassis ?? "Pending 5E class chassis review" : entry.system_equivalent;
}

function buildFeat(kind, entry, gameKind) {
  const system = {
    type: { value: kind === "class" ? "class" : "feat", subtype: kind === "class" ? "" : "general" }
  };
  const activationType = ACTIVATION_TYPE_BY_KIND[gameKind] ?? "action";
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
  return { source: { type: "weapon", system }, postCreate: null };
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
      cr: isMonster ? spec.cr : approximateCrFromLevel(spec.level),
      type: { value: isMonster ? (spec.creatureType ?? "humanoid") : "humanoid" },
      biography: { value: spec.bio ? `<p>${escapeHtml5e(spec.bio)}</p>` : "" }
    },
    traits: { size: isMonster ? (spec.size ?? "med") : "med" }
  };
  const source = { name: spec.name, type: "npc", system };

  const embeddedItems = [];
  if (!isMonster && spec.weaponSpec) {
    embeddedItems.push(buildWeaponItemData5e(spec.weaponSpec));
  }
  if (isMonster && spec.attack) {
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
