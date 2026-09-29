// Per-system stat tables for Populate (board dee25a95).
//
// Why this exists: populate.js's curated MONSTER_TEMPLATES are dnd5e CR blocks, and the PF2e adapter
// used to copy them verbatim with level = round(cr) -- so a PF2e "level 3 bandit" got AC 12 and 11 HP,
// numbers a PF2e party at level 3 shreds in one Strike. PF2e creatures are built from the Gamemastery
// Guide / Monster Core "Building Creatures" tables (statistic by level, rated terrible..extreme), and
// dnd5e creatures from the DMG "Monster Statistics by Challenge Rating" table. Both live here so the
// local generator can build numbers from them and so AI-written numbers can be clamped to them: an AI
// that says "level 3, AC 35, 400 HP" gets the extreme-end numbers for level 3, not a boss.
//
// Pure ESM, zero Foundry globals (scripts/ai/populate.js and Node tests import it).

// --- PF2e: Building Creatures tables, levels -1..24 -------------------------------------------------

const PF2E_MIN_LEVEL = -1;
const PF2E_MAX_LEVEL = 24;

// [extreme, high, moderate, low]
const PF2E_AC = [
  [18, 15, 14, 12], [19, 16, 15, 13], [19, 16, 15, 13], [21, 18, 17, 15], [22, 19, 18, 16], [24, 21, 20, 18],
  [25, 22, 21, 19], [27, 24, 23, 21], [28, 25, 24, 22], [30, 27, 26, 24], [31, 28, 27, 25], [33, 30, 29, 27],
  [34, 31, 30, 28], [36, 33, 32, 30], [37, 34, 33, 31], [39, 36, 35, 33], [40, 37, 36, 34], [42, 39, 38, 36],
  [43, 40, 39, 37], [45, 42, 41, 39], [46, 43, 42, 40], [48, 45, 44, 42], [49, 46, 45, 43], [51, 48, 47, 45],
  [52, 49, 48, 46], [54, 51, 50, 48]
];

// Saving throws and Perception: [extreme, high, moderate, low, terrible]
const PF2E_SAVES = [
  [9, 8, 5, 2, 0], [10, 9, 6, 3, 1], [11, 10, 7, 4, 2], [12, 11, 8, 5, 3], [14, 12, 9, 6, 4], [15, 14, 11, 8, 6],
  [17, 15, 12, 9, 7], [18, 17, 14, 11, 8], [20, 18, 15, 12, 10], [21, 19, 16, 13, 11], [23, 21, 18, 15, 12],
  [24, 22, 19, 16, 14], [26, 24, 21, 18, 15], [27, 25, 22, 19, 16], [29, 26, 23, 20, 18], [30, 28, 25, 22, 19],
  [32, 29, 26, 23, 20], [33, 30, 28, 25, 22], [35, 32, 29, 26, 23], [36, 33, 30, 27, 24], [38, 35, 32, 29, 26],
  [39, 36, 33, 30, 27], [41, 38, 35, 32, 28], [43, 39, 36, 33, 30], [44, 40, 37, 34, 31], [46, 42, 38, 36, 32]
];

// Hit Points: [high max, moderate (mid), low min]
const PF2E_HP = [
  [9, 8, 5], [20, 15, 11], [26, 20, 14], [40, 30, 21], [59, 45, 31], [78, 60, 42], [97, 75, 53], [123, 95, 67],
  [148, 115, 82], [173, 135, 97], [198, 155, 112], [223, 175, 127], [248, 195, 142], [273, 215, 157],
  [298, 235, 172], [323, 255, 187], [348, 275, 202], [373, 295, 217], [398, 315, 232], [423, 335, 247],
  [448, 355, 262], [473, 375, 277], [505, 400, 295], [544, 430, 317], [581, 460, 339], [633, 500, 367]
];

// Strike attack bonus: [extreme, high, moderate, low]
const PF2E_ATTACK = [
  [10, 8, 6, 4], [10, 8, 6, 4], [11, 9, 7, 5], [13, 11, 9, 7], [14, 12, 10, 8], [16, 14, 12, 9], [17, 15, 13, 11],
  [19, 17, 15, 12], [20, 18, 16, 13], [22, 20, 18, 15], [23, 21, 19, 16], [25, 23, 21, 17], [27, 24, 22, 19],
  [28, 26, 24, 20], [29, 27, 25, 21], [31, 29, 27, 23], [32, 30, 28, 24], [34, 32, 30, 25], [35, 33, 31, 27],
  [37, 35, 33, 28], [38, 36, 34, 29], [40, 38, 36, 31], [41, 39, 37, 32], [43, 41, 39, 33], [44, 42, 40, 35],
  [46, 44, 42, 36]
];

// Strike damage: [extreme, high, moderate, low] as dice formulas (the table's own examples).
const PF2E_DAMAGE = [
  ["1d6+1", "1d4+1", "1d4", "1d4"], ["1d6+3", "1d6+2", "1d4+2", "1d4+1"], ["1d8+4", "1d6+3", "1d6+2", "1d4+2"],
  ["1d12+4", "1d10+4", "1d8+4", "1d6+3"], ["1d12+8", "1d10+6", "1d8+6", "1d6+5"], ["2d10+7", "2d8+5", "2d6+5", "2d4+4"],
  ["2d12+7", "2d8+7", "2d6+6", "2d4+6"], ["2d12+10", "2d8+9", "2d6+8", "2d4+7"], ["2d12+12", "2d10+9", "2d8+8", "2d6+6"],
  ["2d12+15", "2d10+11", "2d8+9", "2d6+8"], ["2d12+17", "2d10+13", "2d8+11", "2d6+9"], ["2d12+20", "2d12+13", "2d10+11", "2d6+10"],
  ["2d12+22", "2d12+15", "2d10+12", "2d8+10"], ["3d12+19", "3d10+14", "3d8+12", "3d6+10"], ["3d12+21", "3d10+16", "3d8+14", "3d6+11"],
  ["3d12+24", "3d10+18", "3d8+15", "3d6+13"], ["3d12+26", "3d12+17", "3d10+14", "3d6+14"], ["3d12+29", "3d12+18", "3d10+15", "3d6+15"],
  ["3d12+31", "3d12+19", "3d10+16", "3d6+16"], ["3d12+34", "3d12+20", "3d10+17", "3d6+17"], ["4d12+29", "4d10+20", "4d8+17", "4d6+14"],
  ["4d12+32", "4d10+22", "4d8+19", "4d6+15"], ["4d12+34", "4d10+24", "4d8+20", "4d6+17"], ["4d12+37", "4d10+26", "4d8+22", "4d6+18"],
  ["4d12+39", "4d10+28", "4d8+24", "4d6+19"], ["4d12+42", "4d10+30", "4d8+25", "4d6+21"]
];

// Spell / ability DC: [extreme, high, moderate]
const PF2E_DC = [
  [19, 16, 13], [19, 16, 13], [20, 17, 14], [22, 18, 15], [23, 20, 17], [25, 21, 18], [26, 22, 19], [27, 24, 21],
  [29, 25, 22], [30, 26, 23], [32, 28, 25], [33, 29, 26], [34, 30, 27], [36, 32, 29], [37, 33, 30], [39, 34, 31],
  [40, 36, 33], [41, 37, 34], [43, 38, 35], [44, 40, 37], [46, 41, 38], [47, 42, 39], [48, 44, 41], [50, 45, 42],
  [51, 46, 43], [52, 48, 45]
];

export function clampPf2eLevel(level) {
  const n = Number(level);
  if (!Number.isFinite(n)) return 1;
  return Math.min(PF2E_MAX_LEVEL, Math.max(PF2E_MIN_LEVEL, Math.round(n)));
}

function row(table, level) {
  return table[clampPf2eLevel(level) - PF2E_MIN_LEVEL];
}

const RATING_INDEX = { extreme: 0, high: 1, moderate: 2, low: 3, terrible: 4 };

/** The PF2e Building Creatures statistic for `level` at `rating` (extreme/high/moderate/low/terrible). */
export function pf2eStat(stat, level, rating = "moderate") {
  const index = RATING_INDEX[rating] ?? 2;
  switch (stat) {
    case "ac": return row(PF2E_AC, level)[Math.min(index, 3)];
    case "save":
    case "perception": return row(PF2E_SAVES, level)[index];
    case "attack": return row(PF2E_ATTACK, level)[Math.min(index, 3)];
    case "damage": return row(PF2E_DAMAGE, level)[Math.min(index, 3)];
    case "dc": return row(PF2E_DC, level)[Math.min(index, 2)];
    case "hp": {
      const [high, moderate, low] = row(PF2E_HP, level);
      return rating === "high" || rating === "extreme" ? high : rating === "low" || rating === "terrible" ? low : moderate;
    }
    default: throw new Error(`Unknown PF2e statistic "${stat}".`);
  }
}

/** The sane [min, max] a PF2e creature of `level` may have for `stat` (terrible/low .. extreme/high). */
export function pf2eRange(stat, level) {
  switch (stat) {
    // One below "low" is allowed for AC (unarmored brutes, swarms); nothing above extreme.
    case "ac": return [pf2eStat("ac", level, "low") - 1, pf2eStat("ac", level, "extreme")];
    case "save":
    case "perception": return [pf2eStat("save", level, "terrible"), pf2eStat("save", level, "extreme")];
    case "attack": return [pf2eStat("attack", level, "low"), pf2eStat("attack", level, "extreme")];
    // High HP max plus a quarter: brutes sit above "high" in published creatures, never double it.
    case "hp": return [Math.max(1, row(PF2E_HP, level)[2]), Math.round(row(PF2E_HP, level)[0] * 1.25)];
    case "damage": return [averageDamage(pf2eStat("damage", level, "low")), averageDamage(pf2eStat("damage", level, "extreme"))];
    case "dc": return [pf2eStat("dc", level, "moderate") - 3, pf2eStat("dc", level, "extreme")];
    default: throw new Error(`Unknown PF2e statistic "${stat}".`);
  }
}

// --- dnd5e: DMG "Monster Statistics by Challenge Rating" --------------------------------------------

// cr, AC, HP min, HP max, attack bonus, damage/round min, damage/round max, save DC
const DND5E_CR_TABLE = [
  [0, 13, 1, 6, 3, 0, 1, 13], [0.125, 13, 7, 35, 3, 2, 3, 13], [0.25, 13, 36, 49, 3, 4, 5, 13], [0.5, 13, 50, 70, 3, 6, 8, 13],
  [1, 13, 71, 85, 3, 9, 14, 13], [2, 13, 86, 100, 3, 15, 20, 13], [3, 13, 101, 115, 4, 21, 26, 13], [4, 14, 116, 130, 5, 27, 32, 14],
  [5, 15, 131, 145, 6, 33, 38, 15], [6, 15, 146, 160, 6, 39, 44, 15], [7, 15, 161, 175, 6, 45, 50, 15], [8, 16, 176, 190, 7, 51, 56, 16],
  [9, 16, 191, 205, 7, 57, 62, 16], [10, 17, 206, 220, 7, 63, 68, 16], [11, 17, 221, 235, 8, 69, 74, 17], [12, 17, 236, 250, 8, 75, 80, 17],
  [13, 18, 251, 265, 8, 81, 86, 18], [14, 18, 266, 280, 8, 87, 92, 18], [15, 18, 281, 295, 8, 93, 98, 18], [16, 18, 296, 310, 9, 99, 104, 18],
  [17, 19, 311, 325, 10, 105, 110, 19], [18, 19, 326, 340, 10, 111, 116, 19], [19, 19, 341, 355, 10, 117, 122, 19], [20, 19, 356, 400, 10, 123, 140, 19],
  [21, 19, 401, 445, 11, 141, 158, 20], [22, 19, 446, 490, 11, 159, 176, 20], [23, 19, 491, 535, 11, 177, 194, 20], [24, 19, 536, 580, 12, 195, 212, 21],
  [25, 19, 581, 625, 12, 213, 230, 21], [26, 19, 626, 670, 12, 231, 248, 21], [27, 19, 671, 715, 13, 249, 266, 22], [28, 19, 716, 760, 13, 267, 284, 22],
  [29, 19, 761, 805, 13, 285, 302, 22], [30, 19, 806, 850, 14, 303, 320, 23]
];
export const DND5E_CR_VALUES = Object.freeze(DND5E_CR_TABLE.map((r) => r[0]));

/** Snaps any number (or "1/4"-style string) to the nearest real dnd5e CR, 0..30. */
export function snapDnd5eCr(value) {
  let n = value;
  if (typeof n === "string" && n.includes("/")) {
    const [num, den] = n.split("/").map(Number);
    n = den ? num / den : NaN;
  }
  n = Number(n);
  if (!Number.isFinite(n)) return 1;
  let best = DND5E_CR_VALUES[0];
  for (const cr of DND5E_CR_VALUES) if (Math.abs(cr - n) < Math.abs(best - n)) best = cr;
  return best;
}

function dnd5eRow(cr) {
  const snapped = snapDnd5eCr(cr);
  return DND5E_CR_TABLE.find((r) => r[0] === snapped);
}

/** The DMG table row for a CR: { cr, ac, hpMin, hpMax, attack, damageMin, damageMax, dc }. */
export function dnd5eCrRow(cr) {
  const [snapped, ac, hpMin, hpMax, attack, damageMin, damageMax, dc] = dnd5eRow(cr);
  return { cr: snapped, ac, hpMin, hpMax, attack, damageMin, damageMax, dc };
}

/**
 * The sane [min, max] for a dnd5e creature of `cr`. Deliberately generous: the DMG HP bands describe
 * a creature's *effective* durability, and published creatures sit far below them (a CR 1/4 goblin has
 * 7 HP against a 36-49 band), so the floor is 15% of the band and the ceiling twice it. That keeps every
 * curated template untouched while still refusing a CR 1/2 "bandit" with 300 HP or AC 30.
 */
export function dnd5eRange(stat, cr) {
  const r = dnd5eCrRow(cr);
  switch (stat) {
    case "hp": return [Math.max(1, Math.floor(r.hpMin * 0.15)), Math.max(12, r.hpMax * 2)];
    case "ac": return [5, Math.min(25, r.ac + 5)];
    case "attack": return [0, r.attack + 4];
    // Per hit, with half again the band's round damage as headroom: published low-CR creatures hit above
    // the band (a CR 1/4 goblin's 1d6+2 averages 5.5 against 4-5), and the first real-model run clamped
    // exactly that. Still refuses a CR 1/4 bandit doing 3d10+8.
    case "damage": return [1, Math.max(6, Math.ceil(r.damageMax * 1.5))];
    case "dc": return [8, r.dc + 3];
    default: throw new Error(`Unknown dnd5e statistic "${stat}".`);
  }
}

// --- Shared helpers ------------------------------------------------------------------------------

/** Average of a "XdY+Z" / "XdY-Z" / "XdY" formula; NaN when it is not one. */
export function averageDamage(formula) {
  const match = /^\s*(\d+)\s*d\s*(\d+)\s*(?:([+-])\s*(\d+))?\s*$/i.exec(String(formula ?? ""));
  if (!match) return NaN;
  const dice = Number(match[1]);
  const die = Number(match[2]);
  const mod = match[4] ? Number(match[4]) * (match[3] === "-" ? -1 : 1) : 0;
  return dice * (die + 1) / 2 + mod;
}

/** "2d6 + 4" -> "2d6+4"; null when it is not a plain dice formula. */
export function normalizeDamageFormula(formula) {
  const match = /^\s*(\d+)\s*d\s*(\d+)\s*(?:([+-])\s*(\d+))?\s*$/i.exec(String(formula ?? ""));
  if (!match) return null;
  const dice = Math.min(12, Math.max(1, Number(match[1])));
  const die = [4, 6, 8, 10, 12].includes(Number(match[2])) ? Number(match[2]) : 6;
  // A negative modifier is dropped: the dnd5e damage parser reads "XdY+Z" only, and a -1 on a
  // spawned creature's damage is noise.
  const mod = match[4] && match[3] !== "-" ? Number(match[4]) : 0;
  return mod ? `${dice}d${die}+${mod}` : `${dice}d${die}`;
}

export function clampNumber(value, [min, max], fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
