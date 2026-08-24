// The "Populate" pipeline: given a short GM prompt in plain language -- "a grizzled dwarven
// blacksmith who secretly deals in stolen goods, level 3", "a pack of 3 goblin scouts", "a +1
// flaming shortsword" -- produces one or more complete, ready-to-create spawn specs (an NPC, a
// monster, or an item). Two paths feed this:
//   - a registered adapter (same shape as the growth-proposal adapter: an AI gateway or any async
//     function) can parse richer natural language and hand back specs directly;
//   - the built-in local heuristic below always works with no AI configured, using a plain
//     keyword/regex parser plus curated template banks, so "Populate" is never gated on having an
//     AI provider set up.
// This module never touches Foundry globals -- turning a spec into a real Actor/Item happens in
// systems/*-adapter.js and scripts/api.js, the same separation the rest of Grand Design uses.
// Every random choice takes an injectable `rng` (defaults to Math.random) so tests can pass a
// fixed sequence and assert an exact result, while real GM use gets real variety each time.

import { SPAWN_DOCUMENT_KINDS } from "./constants.js";

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  couple: 2, few: 3, pair: 2, dozen: 12
};
const MAX_SPAWN_COUNT = 20;

// Compound weapon words (shortsword, warhammer, ...) are listed explicitly ahead of their plain
// root (sword, hammer) because \b...\b can't match a keyword that's merely a suffix of a larger
// word ("sword" has no word-boundary right before it inside "shortsword") -- and every keyword
// list below takes an optional trailing "s" so an ordinary plural ("3 goblins", "some swords")
// still matches instead of silently falling through to the npc/singular default.
const ITEM_KEYWORDS = /\b(shortsword|longsword|greatsword|broadsword|warhammer|cutlass|sword|blade|dagger|axe|hammer|mace|spear|bow|crossbow|staff|wand|ring|amulet|cloak|armor|armour|shield|potion|scroll|gauntlets|boots|helm|helmet|trinket|weapon)s?\b/i;
const PERSON_OVERRIDE = /\b(npc|person|man|woman|blacksmith|merchant|guard|priest|innkeeper|innkeep|thief|scholar|sailor|farmer|noble|bartender|barkeep|beggar|sage|healer|captain|smuggler|dockhand|bargeman)s?\b/i;
const MONSTER_KEYWORDS = /\b(goblin|orc|wolves|wolf|dire wolves|dire wolf|skeleton|zombie|bandit|cultist|giant rats|giant rat|ogre|troll|kobold|bugbear|hobgoblin|dragon|wyrmling|spider|ghoul|wraith|imp|owlbear)s?\b/i;
const MONSTER_OVERRIDE = /\b(monster|creature|beast)s?\b/i;

/** Infers spawn kind from the prompt: "item" | "monster" | "npc" (the default when nothing more specific matches). */
function inferKind(lowerText) {
  if (MONSTER_KEYWORDS.test(lowerText) || MONSTER_OVERRIDE.test(lowerText)) return "monster";
  if (ITEM_KEYWORDS.test(lowerText) && !PERSON_OVERRIDE.test(lowerText)) return "item";
  return "npc";
}

// "level 3" / "CR 3" number the individual creature, not how many to spawn -- strip those phrases
// out before hunting for a standalone spawn count, so "a level 3 blacksmith" spawns one level-3
// blacksmith instead of being misread as three of them.
function stripLevelAndCrPhrases(lowerText) {
  return lowerText.replace(/\blevel\s*\d+\b/gi, "").replace(/\bcr\s*\d+(?:\/\d+)?\b/gi, "");
}

function parseCount(lowerText) {
  const countSource = stripLevelAndCrPhrases(lowerText);
  const digitMatch = /\b(\d+)\s*x?\b/i.exec(countSource);
  if (digitMatch) return clampCount(parseInt(digitMatch[1], 10));
  for (const [word, value] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(countSource)) return clampCount(value);
  }
  return 1;
}

function clampCount(value) {
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(MAX_SPAWN_COUNT, Math.round(value));
}

const RACE_KEYWORDS = [
  ["dwarven", "dwarf"], ["dwarf", "dwarf"], ["elven", "elf"], ["elf", "elf"],
  ["half-elf", "half-elf"], ["halfling", "halfling"], ["gnome", "gnome"],
  ["half-orc", "half-orc"], ["orc", "orc"], ["tiefling", "tiefling"],
  ["dragonborn", "dragonborn"], ["human", "human"]
];

function inferRace(lowerText) {
  for (const [keyword, race] of RACE_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`, "i").test(lowerText)) return race;
  }
  return "human";
}

// Role keyword -> { primaryAbilities, weapon, armored, tags }. `weapon` keys into WEAPON_BASE
// (populate.js's own bank, reused for both NPC starting gear and standalone weapon items).
const ROLE_TABLE = {
  blacksmith: { primaryAbilities: ["str", "con"], weapon: "warhammer", armored: false, tags: ["craft"] },
  merchant: { primaryAbilities: ["cha", "int"], weapon: "dagger", armored: false, tags: ["persuasion"] },
  guard: { primaryAbilities: ["str", "con"], weapon: "spear", armored: true, tags: ["martial"] },
  priest: { primaryAbilities: ["wis", "cha"], weapon: "mace", armored: false, tags: ["religion"] },
  innkeeper: { primaryAbilities: ["cha", "con"], weapon: "club", armored: false, tags: ["persuasion"] },
  thief: { primaryAbilities: ["dex", "int"], weapon: "dagger", armored: false, tags: ["stealth"] },
  scholar: { primaryAbilities: ["int", "wis"], weapon: "dagger", armored: false, tags: ["lore"] },
  sailor: { primaryAbilities: ["str", "dex"], weapon: "cutlass", armored: false, tags: ["athletics"] },
  bargeman: { primaryAbilities: ["str", "con"], weapon: "spear", armored: false, tags: ["athletics", "water"] },
  dockhand: { primaryAbilities: ["str", "con"], weapon: "club", armored: false, tags: ["athletics", "water"] },
  farmer: { primaryAbilities: ["str", "con"], weapon: "hammer", armored: false, tags: ["survival"] },
  noble: { primaryAbilities: ["cha", "int"], weapon: "dagger", armored: false, tags: ["persuasion", "society"] },
  captain: { primaryAbilities: ["str", "cha"], weapon: "sword", armored: true, tags: ["leadership", "martial"] },
  smuggler: { primaryAbilities: ["dex", "cha"], weapon: "dagger", armored: false, tags: ["stealth", "deception"] },
  bartender: { primaryAbilities: ["cha", "wis"], weapon: "club", armored: false, tags: ["persuasion"] },
  beggar: { primaryAbilities: ["cha", "wis"], weapon: "dagger", armored: false, tags: ["deception"] },
  sage: { primaryAbilities: ["int", "wis"], weapon: "staff", armored: false, tags: ["lore"] },
  healer: { primaryAbilities: ["wis", "int"], weapon: "staff", armored: false, tags: ["medicine"] }
};
const DEFAULT_ROLE = { primaryAbilities: ["str", "con"], weapon: "club", armored: false, tags: [] };

function inferRole(lowerText) {
  for (const keyword of Object.keys(ROLE_TABLE)) {
    if (new RegExp(`\\b${keyword}\\b`, "i").test(lowerText)) return { key: keyword, ...ROLE_TABLE[keyword] };
  }
  return { key: null, ...DEFAULT_ROLE };
}

function inferLevel(lowerText) {
  const levelMatch = /\blevel\s*(\d+)\b/i.exec(lowerText) ?? /\bcr\s*(\d+(?:\/\d+)?)\b/i.exec(lowerText);
  if (!levelMatch) return null;
  const raw = levelMatch[1];
  if (raw.includes("/")) {
    const [num, den] = raw.split("/").map(Number);
    return den ? num / den : 1;
  }
  return Number.parseInt(raw, 10);
}

const POWER_KEYWORDS = [
  [/\b(weak|young|runt|scrawny)\b/i, { hpMult: 0.6, toHitBonus: -1, label: "Weak" }],
  [/\b(elite|veteran|hardened)\b/i, { hpMult: 1.5, toHitBonus: 1, label: "Veteran" }],
  [/\b(alpha|champion)\b/i, { hpMult: 1.75, toHitBonus: 2, label: "Alpha" }],
  [/\b(boss|warlord)\b/i, { hpMult: 2.5, toHitBonus: 3, label: "Boss" }],
  [/\b(legendary|ancient)\b/i, { hpMult: 3, toHitBonus: 4, label: "Legendary" }]
];
function inferPowerModifier(lowerText) {
  for (const [pattern, modifier] of POWER_KEYWORDS) {
    if (pattern.test(lowerText)) return modifier;
  }
  return { hpMult: 1, toHitBonus: 0, label: null };
}

/**
 * Parses a free-text spawn prompt into structured criteria. Never throws on ambiguous input --
 * every field always resolves to a usable default, since a partially-understood prompt should
 * still produce something spawnable rather than an error. The full original prompt is kept as
 * `flavor` so generators can weave leftover descriptive text into bios/descriptions even where
 * this parser doesn't explicitly understand it.
 */
export function parseSpawnCriteria(promptText) {
  const text = String(promptText ?? "").trim();
  if (!text) throw new Error("A Populate prompt is required.");
  const lower = text.toLowerCase();

  return {
    flavor: text,
    kind: inferKind(lower),
    count: parseCount(lower),
    race: inferRace(lower),
    role: inferRole(lower),
    level: inferLevel(lower),
    powerModifier: inferPowerModifier(lower),
    monsterKeyword: (MONSTER_KEYWORDS.exec(lower) ?? [])[0] ?? null,
    itemKeyword: (ITEM_KEYWORDS.exec(lower) ?? [])[0] ?? null
  };
}

// --- Names -------------------------------------------------------------------------------------

const NAME_SYLLABLES = {
  human: { first: ["Al", "Ber", "Cor", "Dun", "Ed", "Fen", "Gar", "Hal", "Ian", "Jor", "Kel", "Lor", "Mar", "Nor", "Os", "Pel", "Quin", "Ren", "Sil", "Tor"], last: ["ric", "wyn", "mont", "ford", "ley", "ton", "wood", "stone", "brook", "field"] },
  dwarf: { first: ["Thor", "Bal", "Dur", "Grim", "Ok", "Bor", "Dva", "Nor", "Vig", "Skal"], last: ["in", "ir", "ax", "grim", "din", "gard", "ok", "thal"] },
  elf: { first: ["Ael", "Fael", "Lir", "Syl", "Thal", "Elar", "Ithil", "Cael", "Nym", "Or"], last: ["wyn", "iel", "adrin", "aelis", "oril", "ithas"] },
  halfling: { first: ["Bram", "Dob", "Fen", "Hob", "Mer", "Pip", "Tob", "Wil"], last: ["foot", "burrow", "brook", "apple", "tuck", "berry"] },
  gnome: { first: ["Ficks", "Glim", "Nib", "Pip", "Wren", "Zib"], last: ["cog", "spark", "whistle", "gear", "fizz"] },
  orc: { first: ["Grosh", "Uzk", "Mog", "Krag", "Thok", "Rok"], last: ["gash", "tusk", "skull", "fist", "maw"] },
  "half-orc": { first: ["Grosh", "Dur", "Uzk", "Bor", "Thok", "Mar"], last: ["gash", "grim", "tusk", "din", "fist"] },
  tiefling: { first: ["Az", "Kael", "Mor", "Sar", "Vex", "Zar"], last: ["ash", "shade", "thorn", "cinder", "noc"] },
  dragonborn: { first: ["Bal", "Kri", "Rex", "Tor", "Vor", "Zar"], last: ["asis", "threax", "nex", "ithar", "onax"] },
  "half-elf": { first: ["Ael", "Cor", "Lir", "Mar", "Syl", "Ren"], last: ["wyn", "ford", "iel", "ley", "adrin"] }
};
const DEFAULT_NAME_SYLLABLES = NAME_SYLLABLES.human;

export function generateName(race, rng = Math.random) {
  const bank = NAME_SYLLABLES[race] ?? DEFAULT_NAME_SYLLABLES;
  return `${pick(bank.first, rng)}${pick(bank.last, rng)}`;
}

function pick(list, rng) {
  return list[Math.floor(rng() * list.length) % list.length];
}

// --- NPC actors ----------------------------------------------------------------------------

const ABILITY_KEYS = ["str", "dex", "con", "int", "wis", "cha"];

function rollAbilityScores(primaryAbilities, level, rng) {
  const scores = {};
  for (const key of ABILITY_KEYS) {
    const base = 10 + Math.floor(level / 4);
    const jitter = Math.floor(rng() * 5) - 2; // -2..+2
    const primaryBonus = primaryAbilities.includes(key) ? 2 + Math.floor(rng() * 3) : 0; // +2..+4
    scores[key] = clampAbility(base + jitter + primaryBonus);
  }
  return scores;
}

function clampAbility(value) {
  return Math.min(20, Math.max(3, value));
}

function abilityMod(score) {
  return Math.floor((score - 10) / 2);
}

function estimateNpcHp(level, conMod, rng) {
  const die = 8;
  let hp = die + conMod + Math.floor(rng() * 3);
  for (let i = 1; i < level; i += 1) hp += Math.ceil(die / 2) + 1 + conMod;
  return Math.max(1, hp);
}

/**
 * Builds a system-agnostic NPC actor spec from parsed criteria -- name, race, level, ability
 * scores, HP, AC, a starting weapon (from WEAPON_BASE), and a short generated bio weaving in the
 * prompt's own flavor text. A system adapter (systems/*-adapter.js) turns this into a real Actor
 * source; this function itself never touches Foundry globals.
 */
export function generateNpcSpec(criteria, { rng = Math.random } = {}) {
  const level = clampLevel(criteria.level ?? (1 + Math.floor(rng() * 4)));
  const abilities = rollAbilityScores(criteria.role.primaryAbilities, level, rng);
  const conMod = abilityMod(abilities.con);
  const hp = estimateNpcHp(level, conMod, rng);
  const ac = 10 + abilityMod(abilities.dex) + (criteria.role.armored ? 4 : 0);
  const weaponKey = criteria.role.weapon in WEAPON_BASE ? criteria.role.weapon : "club";
  return {
    documentType: "actor",
    actorKind: "npc",
    name: generateName(criteria.race, rng),
    race: criteria.race,
    role: criteria.role.key,
    level,
    abilities,
    hp,
    ac,
    speed: 30,
    tags: criteria.role.tags,
    weaponKey,
    weaponSpec: buildWeaponItemSpec({ weaponKey, bonus: 0, rarity: "common" }, rng),
    bio: buildNpcBio(criteria)
  };
}

function clampLevel(level) {
  return Math.min(20, Math.max(1, Math.round(level)));
}

function buildNpcBio(criteria) {
  const roleLabel = criteria.role.key ? capitalize(criteria.role.key) : "Local resident";
  const raceLabel = capitalize(criteria.race);
  return `${raceLabel} ${roleLabel}. Generated by Grand Design AI's Populate tool from the prompt: "${criteria.flavor}".`;
}

// --- Monster actors --------------------------------------------------------------------------

// Small curated bank of representative dnd5e-style stat blocks (CR 1/8 to CR 5). These are
// reference approximations for GM convenience -- close to commonly published SRD-tier numbers for
// the same named creatures, not a guaranteed exact match to any specific sourcebook printing --
// and every spawned monster is a normal, fully GM-editable Actor afterward.
export const MONSTER_TEMPLATES = {
  "giant rat": { cr: 0.125, hp: 7, ac: 12, size: "sm", type: "beast", speed: 30, abilities: { str: 7, dex: 15, con: 11, int: 2, wis: 10, cha: 4 }, attack: { name: "Bite", toHit: 4, damage: "1d4+2", damageType: "piercing" } },
  kobold: { cr: 0.125, hp: 5, ac: 12, size: "sm", type: "humanoid", speed: 30, abilities: { str: 7, dex: 15, con: 9, int: 8, wis: 7, cha: 8 }, attack: { name: "Dagger", toHit: 4, damage: "1d4+2", damageType: "piercing" } },
  goblin: { cr: 0.25, hp: 7, ac: 15, size: "sm", type: "humanoid", speed: 30, abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 }, attack: { name: "Scimitar", toHit: 4, damage: "1d6+2", damageType: "slashing" } },
  wolf: { cr: 0.25, hp: 11, ac: 13, size: "med", type: "beast", speed: 40, abilities: { str: 12, dex: 15, con: 12, int: 3, wis: 12, cha: 6 }, attack: { name: "Bite", toHit: 4, damage: "2d4+2", damageType: "piercing" } },
  skeleton: { cr: 0.25, hp: 13, ac: 13, size: "med", type: "undead", speed: 30, abilities: { str: 10, dex: 14, con: 15, int: 6, wis: 8, cha: 5 }, attack: { name: "Shortsword", toHit: 4, damage: "1d6+2", damageType: "piercing" } },
  cultist: { cr: 0.25, hp: 9, ac: 12, size: "med", type: "humanoid", speed: 30, abilities: { str: 11, dex: 12, con: 10, int: 10, wis: 11, cha: 10 }, attack: { name: "Scimitar", toHit: 3, damage: "1d6+1", damageType: "slashing" } },
  orc: { cr: 0.5, hp: 15, ac: 13, size: "med", type: "humanoid", speed: 30, abilities: { str: 16, dex: 12, con: 16, int: 7, wis: 11, cha: 10 }, attack: { name: "Greataxe", toHit: 5, damage: "1d12+3", damageType: "slashing" } },
  bandit: { cr: 0.125, hp: 11, ac: 12, size: "med", type: "humanoid", speed: 30, abilities: { str: 11, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, attack: { name: "Scimitar", toHit: 3, damage: "1d6+1", damageType: "slashing" } },
  zombie: { cr: 0.25, hp: 22, ac: 8, size: "med", type: "undead", speed: 20, abilities: { str: 13, dex: 6, con: 16, int: 3, wis: 6, cha: 5 }, attack: { name: "Slam", toHit: 3, damage: "1d6+1", damageType: "bludgeoning" } },
  "dire wolf": { cr: 1, hp: 37, ac: 14, size: "lg", type: "beast", speed: 50, abilities: { str: 17, dex: 15, con: 15, int: 3, wis: 12, cha: 7 }, attack: { name: "Bite", toHit: 5, damage: "2d6+3", damageType: "piercing" } },
  hobgoblin: { cr: 0.5, hp: 11, ac: 18, size: "med", type: "humanoid", speed: 30, abilities: { str: 13, dex: 12, con: 12, int: 10, wis: 10, cha: 9 }, attack: { name: "Longsword", toHit: 3, damage: "1d8+1", damageType: "slashing" } },
  bugbear: { cr: 1, hp: 27, ac: 16, size: "med", type: "humanoid", speed: 30, abilities: { str: 15, dex: 14, con: 13, int: 8, wis: 11, cha: 9 }, attack: { name: "Morningstar", toHit: 4, damage: "2d8+2", damageType: "piercing" } },
  ogre: { cr: 2, hp: 59, ac: 11, size: "lg", type: "giant", speed: 40, abilities: { str: 19, dex: 8, con: 16, int: 5, wis: 7, cha: 7 }, attack: { name: "Greatclub", toHit: 6, damage: "2d8+4", damageType: "bludgeoning" } },
  troll: { cr: 5, hp: 84, ac: 15, size: "lg", type: "giant", speed: 30, abilities: { str: 18, dex: 13, con: 20, int: 7, wis: 9, cha: 7 }, attack: { name: "Claw", toHit: 7, damage: "2d6+4", damageType: "slashing" } },
  owlbear: { cr: 3, hp: 59, ac: 13, size: "lg", type: "monstrosity", speed: 40, abilities: { str: 20, dex: 12, con: 17, int: 3, wis: 12, cha: 7 }, attack: { name: "Claw", toHit: 7, damage: "2d8+5", damageType: "slashing" } }
};
const DEFAULT_MONSTER_TEMPLATE = MONSTER_TEMPLATES.bandit;

/**
 * Builds a system-agnostic monster actor spec from parsed criteria. Falls back to the nearest
 * generic humanoid template (with `approximated: true`) when the prompt names a creature not in
 * MONSTER_TEMPLATES, so an unrecognized monster keyword still spawns something reasonable rather
 * than failing outright -- the spec honestly records that it was approximated, for the GM to see.
 */
export function generateMonsterSpec(criteria, { rng = Math.random } = {}) {
  const keyword = criteria.monsterKeyword;
  const template = keyword && MONSTER_TEMPLATES[keyword] ? MONSTER_TEMPLATES[keyword] : DEFAULT_MONSTER_TEMPLATE;
  const approximated = !(keyword && MONSTER_TEMPLATES[keyword]);
  const modifier = criteria.powerModifier;
  const hp = Math.max(1, Math.round(template.hp * modifier.hpMult));
  const name = modifier.label
    ? `${modifier.label} ${capitalize(keyword ?? "Bandit")}`
    : capitalize(keyword ?? "Bandit");
  return {
    documentType: "actor",
    actorKind: "monster",
    name: `${name} ${generateName(criteria.race === "human" ? "orc" : criteria.race, rng)}`.trim(),
    templateKeyword: keyword ?? "bandit",
    approximated,
    cr: template.cr,
    hp,
    ac: template.ac,
    size: template.size,
    creatureType: template.type,
    speed: template.speed,
    abilities: template.abilities,
    attack: { ...template.attack, toHit: template.attack.toHit + modifier.toHitBonus },
    bio: approximated
      ? `No exact template for "${keyword ?? criteria.flavor}" -- approximated as a ${template.type}. Generated by Grand Design AI's Populate tool from the prompt: "${criteria.flavor}".`
      : `Generated by Grand Design AI's Populate tool from the prompt: "${criteria.flavor}".`
  };
}

// --- Items ---------------------------------------------------------------------------------

export const WEAPON_BASE = {
  sword: { damage: "1d8", damageType: "slashing", category: "martial", group: "sword", traits: ["versatile"] },
  shortsword: { damage: "1d6", damageType: "piercing", category: "martial", group: "sword", traits: ["finesse", "light"] },
  cutlass: { damage: "1d6", damageType: "slashing", category: "martial", group: "sword", traits: ["finesse", "light"] },
  dagger: { damage: "1d4", damageType: "piercing", category: "simple", group: "knife", traits: ["finesse", "light", "thrown"] },
  axe: { damage: "1d8", damageType: "slashing", category: "martial", group: "axe", traits: [] },
  hammer: { damage: "1d6", damageType: "bludgeoning", category: "simple", group: "hammer", traits: [] },
  warhammer: { damage: "1d8", damageType: "bludgeoning", category: "martial", group: "hammer", traits: ["versatile"] },
  mace: { damage: "1d6", damageType: "bludgeoning", category: "simple", group: "mace", traits: [] },
  spear: { damage: "1d6", damageType: "piercing", category: "simple", group: "spear", traits: ["thrown", "versatile"] },
  bow: { damage: "1d8", damageType: "piercing", category: "martial", group: "bow", traits: ["ranged"] },
  crossbow: { damage: "1d8", damageType: "piercing", category: "simple", group: "crossbow", traits: ["ranged"] },
  staff: { damage: "1d6", damageType: "bludgeoning", category: "simple", group: "club", traits: ["versatile"] },
  club: { damage: "1d4", damageType: "bludgeoning", category: "simple", group: "club", traits: [] }
};

const MAGIC_RIDER_KEYWORDS = [
  [/\b(flaming|fire)\b/i, { rider: "fire", label: "Flaming" }],
  [/\b(frost|freezing|cold|ice)\b/i, { rider: "cold", label: "Frost" }],
  [/\b(shock|shocking|lightning)\b/i, { rider: "electricity", label: "Shocking" }],
  [/\b(venomous|poison(?:ed)?)\b/i, { rider: "poison", label: "Venomous" }],
  [/\b(holy|blessed)\b/i, { rider: "radiant", label: "Blessed" }]
];
const RARITY_BY_BONUS = { 0: "common", 1: "uncommon", 2: "rare", 3: "very rare", 4: "legendary" };

const WEAPON_KEYWORD_ALIASES = {
  sword: "sword", blade: "sword", longsword: "sword", greatsword: "sword", broadsword: "sword",
  shortsword: "shortsword", cutlass: "cutlass", warhammer: "warhammer",
  dagger: "dagger", axe: "axe", hammer: "hammer", mace: "mace", spear: "spear",
  bow: "bow", crossbow: "crossbow", staff: "staff"
};

function inferWeaponKeyFromKeyword(itemKeyword) {
  // itemKeyword comes from ITEM_KEYWORDS, which matches an optional trailing "s" for plurals
  // ("swords") -- strip that back off before looking the singular root up in the alias table.
  const raw = (itemKeyword ?? "").toLowerCase();
  const singular = WEAPON_KEYWORD_ALIASES[raw] ? raw : raw.replace(/s$/, "");
  return WEAPON_KEYWORD_ALIASES[singular] ?? "sword";
}

/**
 * Builds a system-agnostic weapon item spec. `bonus` is the parsed "+N" enhancement (0 for a
 * mundane item); `rarity` is inferred from that bonus plus whether an elemental rider was found,
 * unless explicitly overridden.
 */
export function buildWeaponItemSpec({ weaponKey, bonus = 0, rider = null, rarity }, rng = Math.random) {
  const base = WEAPON_BASE[weaponKey] ?? WEAPON_BASE.sword;
  const resolvedRarity = rarity ?? RARITY_BY_BONUS[Math.min(bonus + (rider ? 1 : 0), 4)] ?? "common";
  return {
    documentType: "item",
    itemKind: "weapon",
    // A plain capitalized default -- generateItemSpec overwrites this with the full name (any
    // magic prefix included) for a standalone item spawn, but an NPC/monster's starting-gear
    // weapon spec (built here directly, never routed through generateItemSpec) needs a real,
    // non-null name too so it doesn't get silently dropped when embedded on the Actor.
    name: capitalize(weaponKey),
    weaponKey,
    damage: base.damage,
    damageType: base.damageType,
    category: base.category,
    group: base.group,
    traits: base.traits,
    bonus,
    rider,
    rarity: resolvedRarity
  };
}

const BONUS_PATTERN = /\+(\d)\b/;

/** Builds a full item spec (weapon, for v1) from parsed criteria, including a generated name. */
export function generateItemSpec(criteria, { rng = Math.random } = {}) {
  const weaponKey = inferWeaponKeyFromKeyword(criteria.itemKeyword);
  const bonusMatch = BONUS_PATTERN.exec(criteria.flavor);
  const bonus = bonusMatch ? Math.min(4, Math.max(0, parseInt(bonusMatch[1], 10))) : 0;
  const riderMatch = MAGIC_RIDER_KEYWORDS.find(([pattern]) => pattern.test(criteria.flavor));
  const rider = riderMatch ? riderMatch[1].rider : null;
  const spec = buildWeaponItemSpec({ weaponKey, bonus, rider }, rng);
  const prefixParts = [];
  if (bonus > 0) prefixParts.push(`+${bonus}`);
  if (riderMatch) prefixParts.push(riderMatch[1].label);
  const baseName = capitalize(weaponKey);
  spec.name = prefixParts.length ? `${prefixParts.join(" ")} ${baseName}` : baseName;
  spec.bio = `Generated by Grand Design AI's Populate tool from the prompt: "${criteria.flavor}".`;
  return spec;
}

/**
 * The full pipeline in one call: parses `promptText`, expands its parsed count, and returns
 * `{ kind, specs }` where `specs` has one entry per requested copy (a pack of 3 goblins returns 3
 * distinct monster specs, each with its own rolled name/stats). `adapter`, if provided, is tried
 * first and must resolve to the same `{ kind, specs }` shape -- on any adapter failure or when no
 * adapter is registered, the local heuristic below is used instead so Populate always produces
 * something.
 */
export async function populate(promptText, { adapter = null, rng = Math.random } = {}) {
  if (adapter) {
    const result = await adapter({ promptText });
    if (result && SPAWN_DOCUMENT_KINDS.has(result.kind) && Array.isArray(result.specs)) {
      return result;
    }
  }
  const criteria = parseSpawnCriteria(promptText);
  const specs = [];
  for (let i = 0; i < criteria.count; i += 1) {
    if (criteria.kind === "item") specs.push(generateItemSpec(criteria, { rng }));
    else if (criteria.kind === "monster") specs.push(generateMonsterSpec(criteria, { rng }));
    else specs.push(generateNpcSpec(criteria, { rng }));
  }
  return { kind: criteria.kind, specs, criteria };
}

function capitalize(word) {
  return typeof word === "string" && word.length ? word[0].toUpperCase() + word.slice(1).toLowerCase() : String(word ?? "");
}
