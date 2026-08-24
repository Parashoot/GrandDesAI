// Horror Rank: canon's consequence for accumulating vile/taboo (Red) power -- "terrible deeds
// grant non-real classes that progressively consume regular class levels." This module is the
// system-agnostic corruption-meter math; api.js is what actually calls it (every time a red-
// polarity Class/Skill/Title is approved) and persists the result to the actor's flags.
//
// Deliberately separate from vice-taxonomy.js/ENTRY_POLARITIES: those define what makes an entry
// red and what it must state as its own cost; this module is what happens to the REST of the
// character's Classes as red power piles up over time. The two are related but distinct axes --
// an entry's own malignance.drawback is a fixed, per-entry cost; Horror Rank is an accumulating,
// actor-wide consequence that can erode an entirely different, standard-polarity Class.
import { HORROR_RANK_LEVEL_PENALTY, HORROR_RANK_THRESHOLD } from "./constants.js";
import { cloneRegistry } from "./lineage.js";

export function emptyHorrorRank() {
  return { points: 0, totalLevelsDocked: 0 };
}

export function normalizeHorrorRank(value) {
  return {
    points: Number.isFinite(value?.points) && value.points >= 0 ? value.points : 0,
    totalLevelsDocked: Number.isInteger(value?.totalLevelsDocked) && value.totalLevelsDocked >= 0
      ? value.totalLevelsDocked
      : 0
  };
}

/**
 * Adds `amount` Horror Rank points. Every time accumulated points cross HORROR_RANK_THRESHOLD,
 * HORROR_RANK_LEVEL_PENALTY levels are docked from the actor's own strongest standard-polarity
 * Class (by `level`, read off the registry) -- the "class levels get eaten away" consequence canon
 * describes. A threshold crossing with no eligible standard-polarity Class left to erode (none
 * exist, or the strongest is already at level 1) still consumes the points -- there's simply
 * nothing left to dock this time, which is itself meaningful (the corruption has nowhere left to
 * go but the red Classes themselves, which this function deliberately never touches). Returns the
 * updated registry (a fresh clone -- the input is never mutated), the updated Horror Rank state,
 * and `dockedFrom`, a list of `{ classId, levelsDocked }` for every actual deduction made, so
 * callers can surface what just happened to the GM.
 */
export function applyHorrorRankIncrement(registry, horrorRank, amount) {
  const state = normalizeHorrorRank(horrorRank);
  let nextRegistry = cloneRegistry(registry);
  let points = state.points + (Number.isFinite(amount) ? amount : 0);
  let totalLevelsDocked = state.totalLevelsDocked;
  const dockedFrom = [];

  while (points >= HORROR_RANK_THRESHOLD) {
    points -= HORROR_RANK_THRESHOLD;
    const target = findStrongestClass(nextRegistry, { excludeRed: true });
    if (!target) continue;
    const levelsToDock = Math.min(HORROR_RANK_LEVEL_PENALTY, Math.max(0, target.entry.level - 1));
    if (levelsToDock <= 0) continue;
    nextRegistry.classes[target.id] = { ...target.entry, level: target.entry.level - levelsToDock };
    totalLevelsDocked += levelsToDock;
    dockedFrom.push({ classId: target.id, levelsDocked: levelsToDock });
  }

  return { registry: nextRegistry, horrorRank: { points, totalLevelsDocked }, dockedFrom };
}

/**
 * Finds the actor's own strongest (highest-`level`) approved Class on the registry. Shared by
 * Horror Rank (which excludes red Classes from being a docking target -- corruption shouldn't
 * erode itself) and revival-penalty.js (which deliberately does NOT exclude them -- death is a
 * toll paid regardless of what your strongest Class actually is). Pass `{ excludeRed: true }` for
 * the Horror Rank behavior; omit it (default false) for an unconditional "strongest Class, period."
 */
export function findStrongestClass(registry, { excludeRed = false } = {}) {
  let best = null;
  for (const [id, entry] of Object.entries(registry?.classes ?? {})) {
    if (excludeRed && entry?.metadata?.polarity === "red") continue;
    if (!Number.isInteger(entry?.level)) continue;
    if (!best || entry.level > best.entry.level) best = { id, entry };
  }
  return best;
}
