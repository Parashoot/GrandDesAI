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
import {
  averageDamage,
  clampNumber,
  clampPf2eLevel,
  dnd5eCrRow,
  dnd5eRange,
  normalizeDamageFormula,
  pf2eRange,
  pf2eStat,
  snapDnd5eCr
} from "./systems/npc-stats.js";

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
    // "an ambush for a party level 3" names the PCs' level, not the creature's. dnd5e's local path
    // ignores levels on monsters, but PF2e's builds numbers from them, so it needs to tell the two apart.
    levelIsParty: /\bparty(?:'s)?\s+(?:of\s+)?level\s*\d+/i.test(lower) || /\blevel\s*\d+\s+party\b/i.test(lower),
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
  "giant rat": { pf2eLevel: -1, cr: 0.125, hp: 7, ac: 12, size: "sm", type: "beast", speed: 30, abilities: { str: 7, dex: 15, con: 11, int: 2, wis: 10, cha: 4 }, attack: { name: "Bite", toHit: 4, damage: "1d4+2", damageType: "piercing" } },
  kobold: { pf2eLevel: -1, cr: 0.125, hp: 5, ac: 12, size: "sm", type: "humanoid", speed: 30, abilities: { str: 7, dex: 15, con: 9, int: 8, wis: 7, cha: 8 }, attack: { name: "Dagger", toHit: 4, damage: "1d4+2", damageType: "piercing" } },
  goblin: { pf2eLevel: -1, cr: 0.25, hp: 7, ac: 15, size: "sm", type: "humanoid", speed: 30, abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 }, attack: { name: "Scimitar", toHit: 4, damage: "1d6+2", damageType: "slashing" } },
  wolf: { pf2eLevel: 1, cr: 0.25, hp: 11, ac: 13, size: "med", type: "beast", speed: 40, abilities: { str: 12, dex: 15, con: 12, int: 3, wis: 12, cha: 6 }, attack: { name: "Bite", toHit: 4, damage: "2d4+2", damageType: "piercing" } },
  skeleton: { pf2eLevel: -1, cr: 0.25, hp: 13, ac: 13, size: "med", type: "undead", speed: 30, abilities: { str: 10, dex: 14, con: 15, int: 6, wis: 8, cha: 5 }, attack: { name: "Shortsword", toHit: 4, damage: "1d6+2", damageType: "piercing" } },
  cultist: { pf2eLevel: 0, cr: 0.25, hp: 9, ac: 12, size: "med", type: "humanoid", speed: 30, abilities: { str: 11, dex: 12, con: 10, int: 10, wis: 11, cha: 10 }, attack: { name: "Scimitar", toHit: 3, damage: "1d6+1", damageType: "slashing" } },
  orc: { pf2eLevel: 1, cr: 0.5, hp: 15, ac: 13, size: "med", type: "humanoid", speed: 30, abilities: { str: 16, dex: 12, con: 16, int: 7, wis: 11, cha: 10 }, attack: { name: "Greataxe", toHit: 5, damage: "1d12+3", damageType: "slashing" } },
  bandit: { pf2eLevel: 0, cr: 0.125, hp: 11, ac: 12, size: "med", type: "humanoid", speed: 30, abilities: { str: 11, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, attack: { name: "Scimitar", toHit: 3, damage: "1d6+1", damageType: "slashing" } },
  zombie: { pf2eLevel: -1, cr: 0.25, hp: 22, ac: 8, size: "med", type: "undead", speed: 20, abilities: { str: 13, dex: 6, con: 16, int: 3, wis: 6, cha: 5 }, attack: { name: "Slam", toHit: 3, damage: "1d6+1", damageType: "bludgeoning" } },
  "dire wolf": { pf2eLevel: 3, cr: 1, hp: 37, ac: 14, size: "lg", type: "beast", speed: 50, abilities: { str: 17, dex: 15, con: 15, int: 3, wis: 12, cha: 7 }, attack: { name: "Bite", toHit: 5, damage: "2d6+3", damageType: "piercing" } },
  hobgoblin: { pf2eLevel: 1, cr: 0.5, hp: 11, ac: 18, size: "med", type: "humanoid", speed: 30, abilities: { str: 13, dex: 12, con: 12, int: 10, wis: 10, cha: 9 }, attack: { name: "Longsword", toHit: 3, damage: "1d8+1", damageType: "slashing" } },
  bugbear: { pf2eLevel: 2, cr: 1, hp: 27, ac: 16, size: "med", type: "humanoid", speed: 30, abilities: { str: 15, dex: 14, con: 13, int: 8, wis: 11, cha: 9 }, attack: { name: "Morningstar", toHit: 4, damage: "2d8+2", damageType: "piercing" } },
  ogre: { pf2eLevel: 3, cr: 2, hp: 59, ac: 11, size: "lg", type: "giant", speed: 40, abilities: { str: 19, dex: 8, con: 16, int: 5, wis: 7, cha: 7 }, attack: { name: "Greatclub", toHit: 6, damage: "2d8+4", damageType: "bludgeoning" } },
  troll: { pf2eLevel: 5, cr: 5, hp: 84, ac: 15, size: "lg", type: "giant", speed: 30, abilities: { str: 18, dex: 13, con: 20, int: 7, wis: 9, cha: 7 }, attack: { name: "Claw", toHit: 7, damage: "2d6+4", damageType: "slashing" } },
  owlbear: { pf2eLevel: 4, cr: 3, hp: 59, ac: 13, size: "lg", type: "monstrosity", speed: 40, abilities: { str: 20, dex: 12, con: 17, int: 3, wis: 12, cha: 7 }, attack: { name: "Claw", toHit: 7, damage: "2d8+5", damageType: "slashing" } }
};
const DEFAULT_MONSTER_TEMPLATE = MONSTER_TEMPLATES.bandit;

// MONSTER_KEYWORDS matches plurals ("3 goblins", "wolves"), but the templates are keyed singular: the
// plural used to miss its template and spawn an "approximated" bandit block named "Goblins ...".
function singularMonsterKeyword(keyword) {
  if (!keyword) return keyword;
  const word = keyword.toLowerCase();
  if (MONSTER_TEMPLATES[word]) return word;
  const singular = word.replace(/wolves$/, "wolf").replace(/s$/, "");
  return MONSTER_TEMPLATES[singular] ? singular : word;
}

/**
 * Builds a system-agnostic monster actor spec from parsed criteria. Falls back to the nearest
 * generic humanoid template (with `approximated: true`) when the prompt names a creature not in
 * MONSTER_TEMPLATES, so an unrecognized monster keyword still spawns something reasonable rather
 * than failing outright -- the spec honestly records that it was approximated, for the GM to see.
 */
export function generateMonsterSpec(criteria, { rng = Math.random } = {}) {
  const keyword = singularMonsterKeyword(criteria.monsterKeyword);
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

// --- Per-system stats (board dee25a95) -----------------------------------------------------------
// The curated templates above are dnd5e CR blocks. dnd5e keeps them as they are; a PF2e spawn gets its
// numbers rebuilt from the PF2e Building Creatures tables for its level (systems/npc-stats.js), with
// the template's ability scores deciding which statistics are its strengths and weaknesses. PF2e's own
// answer to "elite/boss" is a higher level, not a HP multiplier, so the power keyword shifts the level.

const PF2E_POWER_LEVEL_SHIFT = { Weak: -1, Veteran: 1, Alpha: 2, Boss: 3, Legendary: 4 };

function ratingFromScore(score) {
  if (score >= 18) return "high";
  if (score >= 14) return "moderate";
  if (score >= 10) return "low";
  return "terrible";
}

function pf2eAttributeCap(level) {
  return Math.max(4, 4 + Math.floor(Math.max(0, level) / 5));
}

function pf2eAttributesFromScores(scores = {}, level) {
  const cap = pf2eAttributeCap(level);
  return Object.fromEntries(ABILITY_KEYS.map((key) => [key, Math.min(cap, Math.max(-5, abilityMod(scores[key] ?? 10)))]));
}

function pf2eSpeed(speed5e) {
  const n = Number(speed5e);
  if (!Number.isFinite(n) || n <= 0) return 25;
  return Math.max(5, Math.round((n * 5) / 6 / 5) * 5);
}

// PF2e weapon trait vocabulary for the Strike built from a weapon (5e "light" ~ PF2e "agile").
const PF2E_STRIKE_TRAITS = { finesse: "finesse", light: "agile", thrown: "thrown-10", versatile: null, ranged: null };

/**
 * Rebuilds a locally generated actor spec's numbers for PF2e (level, AC, HP, saves, Perception, Strike,
 * DC). Items and non-actor specs pass through. Pure: returns a new spec.
 */
export function applyPf2eStats(spec, criteria = {}) {
  if (spec?.documentType !== "actor") return spec;
  const isMonster = spec.actorKind === "monster";
  const template = isMonster ? MONSTER_TEMPLATES[spec.templateKeyword] : null;
  const explicitLevel = Number.isFinite(criteria.level) && !criteria.levelIsParty ? criteria.level : null;
  let level;
  if (isMonster) {
    const base = explicitLevel ?? template?.pf2eLevel ?? (spec.cr < 0.25 ? -1 : spec.cr < 1 ? 0 : Math.round(spec.cr));
    level = clampPf2eLevel(base + (explicitLevel === null ? PF2E_POWER_LEVEL_SHIFT[criteria.powerModifier?.label] ?? 0 : 0));
  } else {
    level = clampPf2eLevel(spec.level ?? 1);
  }
  const scores = spec.abilities ?? {};
  const armored = isMonster ? (spec.ac ?? 12) >= 16 : Boolean(criteria.role?.armored);
  const soft = isMonster ? (spec.ac ?? 12) <= 11 : !armored && (scores.dex ?? 10) < 14;
  const acRating = armored ? "high" : soft ? "low" : "moderate";
  const hpRating = (scores.con ?? 10) >= 16 ? "high" : (scores.con ?? 10) <= 9 ? "low" : "moderate";
  const offense = Math.max(scores.str ?? 10, scores.dex ?? 10);
  const martial = isMonster || (criteria.role?.tags ?? []).includes("martial") || (criteria.role?.primaryAbilities ?? []).some((k) => k === "str" || k === "dex");
  const attackRating = offense >= 16 && martial ? "high" : martial ? "moderate" : "low";
  const base = isMonster ? spec.attack : spec.weaponSpec;
  const strikeTraits = isMonster
    ? []
    : (spec.weaponSpec?.traits ?? []).map((trait) => PF2E_STRIKE_TRAITS[trait]).filter(Boolean);
  return {
    ...spec,
    system: "pf2e",
    level,
    hp: pf2eStat("hp", level, hpRating),
    ac: pf2eStat("ac", level, acRating),
    perception: pf2eStat("perception", level, ratingFromScore(scores.wis ?? 10)),
    saves: {
      fortitude: pf2eStat("save", level, ratingFromScore(scores.con ?? 10)),
      reflex: pf2eStat("save", level, ratingFromScore(scores.dex ?? 10)),
      will: pf2eStat("save", level, ratingFromScore(scores.wis ?? 10))
    },
    abilityMods: pf2eAttributesFromScores(scores, level),
    dc: pf2eStat("dc", level),
    speed: pf2eSpeed(spec.speed),
    attack: {
      name: base?.name ?? "Fist",
      toHit: pf2eStat("attack", level, attackRating),
      damage: pf2eStat("damage", level, attackRating),
      damageType: base?.damageType ?? "bludgeoning",
      traits: strikeTraits
    }
  };
}

/** Local specs for `systemId`: PF2e numbers rebuilt by level, dnd5e left exactly as generated. */
export function applySystemStats(spec, systemId, criteria = {}) {
  return systemId === "pf2e" ? applyPf2eStats(spec, criteria) : spec;
}

// --- AI entries -> specs -----------------------------------------------------------------------

/** A dice formula averaging about `target`, on `die`-sided dice (for replacing an out-of-range AI formula). */
export function formulaForAverage(target, die = 8, rounding = Math.round) {
  const t = Math.max(1, rounding(target));
  const perDie = (die + 1) / 2;
  let dice = Math.max(1, Math.min(12, Math.round((t * 0.6) / perDie)));
  // Never a negative modifier: dnd5e's damage parser (and GMs) read "XdY+Z" only.
  while (dice > 1 && t - dice * perDie < 0) dice -= 1;
  const mod = Math.max(0, rounding(t - dice * perDie));
  return mod ? `${dice}d${die}+${mod}` : `${dice}d${die}`;
}

function clampWithNote(value, range, fallback, label, notes) {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) return fallback;
  const clamped = clampNumber(n, range, fallback);
  if (clamped !== Math.round(n)) notes.push(`${label} ${Math.round(n)} -> ${clamped}`);
  return clamped;
}

function clampDamage(formula, [min, max], fallback, notes) {
  const normalized = normalizeDamageFormula(formula);
  if (!normalized) {
    if (formula) notes.push(`damage "${formula}" -> ${fallback}`);
    return fallback;
  }
  const avg = averageDamage(normalized);
  if (avg < min || avg > max) {
    const die = Number(/d(\d+)/.exec(normalized)?.[1]) || 8;
    // Rounded toward the inside of the range, so the replacement is itself in range.
    const replaced = avg < min ? formulaForAverage(min, die, Math.ceil) : formulaForAverage(max, die, Math.floor);
    notes.push(`damage ${normalized} -> ${replaced}`);
    return replaced;
  }
  return normalized;
}

function aiBio(entry, notes, systemLabel) {
  const parts = [];
  if (entry.gdClass) parts.push(`Grand Design Class: ${entry.gdClass}.`);
  if (entry.bio) parts.push(entry.bio);
  if (notes.length) parts.push(`(Numbers adjusted to ${systemLabel} ranges: ${notes.join(", ")}.)`);
  parts.push("Written by Grand Design AI's Populate tool.");
  return parts.join(" ");
}

function aiWeaponSpec(entry, rng) {
  if (!entry.weaponKey || !(entry.weaponKey in WEAPON_BASE)) return null;
  return buildWeaponItemSpec({ weaponKey: entry.weaponKey, bonus: 0, rarity: "common" }, rng);
}

function pf2eSpecFromEntry(entry, name, rng) {
  const notes = [];
  const level = clampPf2eLevel(entry.level ?? 1);
  if (Number.isFinite(entry.level) && entry.level !== level) notes.push(`level ${entry.level} -> ${level}`);
  const cap = pf2eAttributeCap(level);
  const attributes = Object.fromEntries(ABILITY_KEYS.map((key) => [key, clampNumber(entry.attributes?.[key], [-5, cap], 0)]));
  const weaponSpec = aiWeaponSpec(entry, rng);
  const attack = entry.attack ?? {};
  return {
    documentType: "actor",
    actorKind: entry.kind === "monster" ? "monster" : "npc",
    source: "ai",
    system: "pf2e",
    name,
    race: entry.race ?? null,
    role: entry.role ?? null,
    creatureType: entry.creatureType ?? (entry.kind === "monster" ? null : "humanoid"),
    size: entry.size ?? "med",
    level,
    hp: clampWithNote(entry.hp, pf2eRange("hp", level), pf2eStat("hp", level), "HP", notes),
    ac: clampWithNote(entry.ac, pf2eRange("ac", level), pf2eStat("ac", level), "AC", notes),
    perception: clampWithNote(entry.perception, pf2eRange("perception", level), pf2eStat("perception", level), "Perception", notes),
    saves: {
      fortitude: clampWithNote(entry.saves?.fortitude, pf2eRange("save", level), pf2eStat("save", level), "Fortitude", notes),
      reflex: clampWithNote(entry.saves?.reflex, pf2eRange("save", level), pf2eStat("save", level), "Reflex", notes),
      will: clampWithNote(entry.saves?.will, pf2eRange("save", level), pf2eStat("save", level), "Will", notes)
    },
    abilityMods: attributes,
    dc: clampWithNote(entry.dc, pf2eRange("dc", level), pf2eStat("dc", level), "DC", notes),
    speed: clampNumber(entry.speed, [5, 80], 25),
    attack: {
      name: attack.name ?? weaponSpec?.name ?? "Strike",
      toHit: clampWithNote(attack.bonus, pf2eRange("attack", level), pf2eStat("attack", level), "Strike", notes),
      damage: clampDamage(attack.damage, pf2eRange("damage", level), pf2eStat("damage", level), notes),
      damageType: attack.damageType ?? weaponSpec?.damageType ?? "bludgeoning",
      traits: []
    },
    ...(weaponSpec ? { weaponKey: entry.weaponKey, weaponSpec } : {}),
    gdClass: entry.gdClass ?? null,
    adjustments: notes,
    bio: aiBio(entry, notes, `PF2e level ${level}`)
  };
}

function dnd5eSpecFromEntry(entry, name, rng) {
  const notes = [];
  const cr = snapDnd5eCr(entry.cr ?? 1);
  if (Number.isFinite(entry.cr) && Math.abs(entry.cr - cr) > 1e-9) notes.push(`CR ${entry.cr} -> ${cr}`);
  const row = dnd5eCrRow(cr);
  const abilities = Object.fromEntries(ABILITY_KEYS.map((key) => [key, clampNumber(entry.abilities?.[key], [1, 30], 10)]));
  const weaponSpec = aiWeaponSpec(entry, rng);
  const attack = entry.attack ?? {};
  const hpDefault = Math.max(1, Math.round(row.hpMin * 0.3));
  const monster = entry.kind === "monster";
  const spec = {
    documentType: "actor",
    actorKind: monster ? "monster" : "npc",
    source: "ai",
    system: "dnd5e",
    name,
    race: entry.race ?? null,
    role: entry.role ?? null,
    cr,
    // dnd5e NPC specs carry a level too (the local generator's); a CR-derived one keeps callers that read it working.
    level: Math.max(1, Math.min(20, Math.round(cr * 2) || 1)),
    creatureType: entry.creatureType ?? "humanoid",
    size: entry.size ?? "med",
    hp: clampWithNote(entry.hp, dnd5eRange("hp", cr), hpDefault, "HP", notes),
    ac: clampWithNote(entry.ac, dnd5eRange("ac", cr), row.ac, "AC", notes),
    abilities,
    dc: clampWithNote(entry.dc, dnd5eRange("dc", cr), row.dc, "save DC", notes),
    speed: clampNumber(entry.speed, [5, 120], 30),
    attack: {
      name: attack.name ?? weaponSpec?.name ?? "Slam",
      toHit: clampWithNote(attack.bonus, dnd5eRange("attack", cr), row.attack, "attack", notes),
      damage: clampDamage(attack.damage, dnd5eRange("damage", cr), formulaForAverage(Math.max(2, (row.damageMin + row.damageMax) / 4), 6), notes),
      damageType: attack.damageType ?? weaponSpec?.damageType ?? "bludgeoning"
    },
    ...(weaponSpec ? { weaponKey: entry.weaponKey, weaponSpec } : {}),
    gdClass: entry.gdClass ?? null,
    adjustments: notes
  };
  spec.bio = aiBio(entry, notes, `dnd5e CR ${cr}`);
  return spec;
}

/**
 * Turns the populate stage's entries (scripts/ai/populate.js) into spawn specs for `systemId`, one per
 * copy, every number clamped to that system's range for the entry's level/CR. Returns { kind, specs }.
 */
export function specsFromAiEntries(entries, systemId, { rng = Math.random } = {}) {
  const specs = [];
  let total = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry?.name) continue;
    const count = Math.max(1, Math.min(MAX_SPAWN_COUNT - total, Number.isInteger(entry.count) ? entry.count : 1));
    if (count <= 0) break;
    for (let i = 0; i < count; i += 1) {
      const name = count > 1 ? `${entry.name} ${i + 1}` : entry.name;
      if (entry.kind === "item") {
        const weaponKey = entry.weaponKey && entry.weaponKey in WEAPON_BASE ? entry.weaponKey : "sword";
        const spec = buildWeaponItemSpec({ weaponKey, bonus: entry.bonus ?? 0, rider: entry.rider ?? null }, rng);
        spec.name = entry.name;
        spec.source = "ai";
        spec.bio = entry.bio ? `${entry.bio} Written by Grand Design AI's Populate tool.` : "Written by Grand Design AI's Populate tool.";
        specs.push(spec);
      } else {
        specs.push(systemId === "pf2e" ? pf2eSpecFromEntry(entry, name, rng) : dnd5eSpecFromEntry(entry, name, rng));
      }
    }
    total += count;
    if (total >= MAX_SPAWN_COUNT) break;
  }
  const first = specs.find((spec) => spec.documentType === "actor");
  const kind = first ? first.actorKind : specs.length ? "item" : null;
  return { kind, specs };
}

function describeAdapterFailure(error) {
  const message = String(error?.message ?? error ?? "unknown error").replace(/^The AI provider failed:\s*/i, "");
  if (/timed? ?out|timeout/i.test(message)) return `the AI provider timed out (${message})`;
  if (/unreach|could not reach|fetch|ECONNREFUSED|network/i.test(message)) return `the AI provider could not be reached (${message})`;
  return `the AI provider failed (${message})`;
}

/**
 * The full pipeline in one call: parses `promptText`, expands its parsed count, and returns
 * `{ kind, specs, source, fallbackReason }` where `specs` has one entry per requested copy (a pack of 3
 * goblins returns 3 distinct monster specs). `adapter`, if provided, is tried first:
 *   - the gateway populate adapter (scripts/ai/populate.js) returns `{ format: "populate-entries", entries }`,
 *     turned into specs here with every number clamped to `systemId`'s range;
 *   - any other adapter may return a ready `{ kind, specs }` (kept for custom adapters and tests).
 * Any adapter failure -- a throw, a timeout, an unusable answer -- falls back to the local generator
 * and says why in `fallbackReason`; this function never throws for an adapter's sake.
 */
export async function populate(promptText, { adapter = null, rng = Math.random, systemId = null, partyLevel = null } = {}) {
  let fallbackReason = null;
  let diagnostics = null;
  if (adapter) {
    try {
      const result = await adapter({ promptText, systemId, partyLevel });
      if (result?.format === "populate-entries") {
        diagnostics = result.diagnostics ?? null;
        const built = specsFromAiEntries(result.entries, systemId, { rng });
        if (built.specs.length) return { ...built, source: "ai", fallbackReason: null, diagnostics };
        fallbackReason = "the AI answer had no usable entries";
      } else if (result && SPAWN_DOCUMENT_KINDS.has(result.kind) && Array.isArray(result.specs) && result.specs.length) {
        return { ...result, source: "ai", fallbackReason: null };
      } else {
        fallbackReason = "the AI answer was not in a usable shape";
      }
    } catch (error) {
      fallbackReason = describeAdapterFailure(error);
      diagnostics = error?.diagnostics ?? null;
    }
  }
  const criteria = parseSpawnCriteria(promptText);
  const specs = [];
  for (let i = 0; i < criteria.count; i += 1) {
    let spec;
    if (criteria.kind === "item") spec = generateItemSpec(criteria, { rng });
    else if (criteria.kind === "monster") spec = generateMonsterSpec(criteria, { rng });
    else spec = generateNpcSpec(criteria, { rng });
    specs.push(applySystemStats(spec, systemId, criteria));
  }
  return { kind: criteria.kind, specs, criteria, source: "local", fallbackReason, diagnostics };
}

function capitalize(word) {
  return typeof word === "string" && word.length ? word[0].toUpperCase() + word.slice(1).toLowerCase() : String(word ?? "");
}
