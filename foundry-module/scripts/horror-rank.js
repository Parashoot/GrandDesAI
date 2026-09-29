// Horror Rank: canon's consequence for accumulating vile/taboo (Red) power -- "terrible deeds
// grant non-real classes that progressively consume regular class levels." This module is the
// system-agnostic corruption-meter math; api.js calls it whenever the actor's recorded growth events
// change and persists the result to the actor's flags.
//
// Owner decision 2026-09-29: the meter accrues from the red DEEDS the notes record (each event's
// darkDeed/darkSeverity, filled by the AI gateway), not from approving red entries. Rejecting a red
// Skill refuses the power, not the stain. So the meter is DERIVED: computeHorrorRank re-sums the
// events every time, which makes a re-analysis idempotent (the same notes read twice are the same
// deeds) and lets a removed event lower the points. Docking is the one thing that is NOT derived:
// a threshold crossing docks levels once (thresholdsDocked is a high-water mark) and losing points
// never refunds it -- the levels were really lost; a GM restore would be a separate, deliberate act.
//
// Deliberately separate from vice-taxonomy.js/ENTRY_POLARITIES: those define what makes an entry
// red and what it must state as its own cost; this module is what happens to the REST of the
// character's Classes as red power piles up over time. The two are related but distinct axes --
// an entry's own malignance.drawback is a fixed, per-entry cost; Horror Rank is an accumulating,
// actor-wide consequence that can erode an entirely different, standard-polarity Class.
import {
  DARK_SEVERITIES,
  HORROR_RANK_LEVEL_PENALTY,
  HORROR_RANK_MAX_STAGE,
  HORROR_RANK_POINTS_BY_SEVERITY,
  HORROR_RANK_THRESHOLD
} from "./constants.js";
import { VICE_TAGS } from "./vice-taxonomy.js";
import { cloneRegistry, isActiveEntry } from "./lineage.js";

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
  let points = state.points + (Number.isFinite(amount) ? amount : 0);
  let crossings = 0;
  while (points >= HORROR_RANK_THRESHOLD) {
    points -= HORROR_RANK_THRESHOLD;
    crossings += 1;
  }
  const docked = applyHorrorRankDocks(registry, crossings);
  return {
    registry: docked.registry,
    horrorRank: { points, totalLevelsDocked: state.totalLevelsDocked + docked.levelsDocked },
    dockedFrom: docked.dockedFrom.map(({ classId, levelsDocked }) => ({ classId, levelsDocked }))
  };
}

/**
 * Docks HORROR_RANK_LEVEL_PENALTY levels (clamped so a Class never drops below level 1) from the
 * strongest active standard-polarity Class, once per crossing. A crossing with nothing eligible to
 * dock is still spent. Returns a fresh registry (the input is never mutated), the total levels
 * docked, and `dockedFrom`: [{ classId, levelsDocked, fromLevel, toLevel }] per actual deduction.
 */
export function applyHorrorRankDocks(registry, crossings) {
  const nextRegistry = cloneRegistry(registry);
  const dockedFrom = [];
  let levelsDocked = 0;
  const count = Number.isInteger(crossings) && crossings > 0 ? crossings : 0;
  for (let i = 0; i < count; i += 1) {
    const target = findStrongestClass(nextRegistry, { excludeRed: true });
    if (!target) continue;
    const levelsToDock = Math.min(HORROR_RANK_LEVEL_PENALTY, Math.max(0, target.entry.level - 1));
    if (levelsToDock <= 0) continue;
    const toLevel = target.entry.level - levelsToDock;
    nextRegistry.classes[target.id] = { ...target.entry, level: toLevel };
    levelsDocked += levelsToDock;
    dockedFrom.push({ classId: target.id, levelsDocked: levelsToDock, fromLevel: target.entry.level, toLevel });
  }
  return { registry: nextRegistry, levelsDocked, dockedFrom };
}

// --- Derived Horror Rank (2026-09-29) -------------------------------------------------------------

/**
 * The dark-deed fields of a growth event, each validated on its own: `darkDeed` is a vice id from
 * vice-taxonomy.js or "none"; `darkSeverity` is one of constants.js#DARK_SEVERITIES. Anything else
 * (missing, a typo, an event from the local fallback analyzer, which never fills them) is "none".
 */
export function normalizeDarkDeed(event) {
  const clean = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");
  const vice = clean(event?.darkDeed);
  const severity = clean(event?.darkSeverity);
  return {
    darkDeed: VICE_TAGS.has(vice) ? vice : "none",
    darkSeverity: DARK_SEVERITIES.includes(severity) ? severity : "none"
  };
}

/**
 * Horror Rank points one recorded event is worth. A deed needs BOTH a vice and a severity: a
 * severity with vice "none" names no taboo, and a vice with severity "none" was judged too petty to
 * stain. Things done TO the PC never carry a dark deed (the gateway's rule, contract section 1).
 */
export function horrorPointsForDeed(event) {
  const { darkDeed, darkSeverity } = normalizeDarkDeed(event);
  if (darkDeed === "none" || darkSeverity === "none") return 0;
  return HORROR_RANK_POINTS_BY_SEVERITY[darkSeverity] ?? 0;
}

export function horrorStageFor(points) {
  const value = Number.isFinite(points) && points > 0 ? points : 0;
  return Math.min(HORROR_RANK_MAX_STAGE, Math.floor(value / HORROR_RANK_THRESHOLD));
}

/**
 * Derives the Horror Rank from the recorded events. `docked` is how many threshold crossings were
 * already docked (the stored high-water mark); `legacyPoints` is the baseline a pre-2026-09-29 world
 * carried from red approvals. Pure: returns what the meter reads and how many NEW crossings to dock
 * (`newDocks`); it never touches a registry.
 *
 * Returns { points, deedPoints, legacyPoints, stage, crossings, newDocks, nextThreshold, threshold,
 * deeds: [{ eventId, summary, vice, severity, points }] }. `nextThreshold` is the point total of the
 * next crossing (every crossing docks, even past stage 3, which is only the display cap).
 */
export function computeHorrorRank(events, { docked = 0, legacyPoints = 0 } = {}) {
  const deeds = [];
  let deedPoints = 0;
  // Re-analysis replaces events, so one id should never appear twice; if it does it counts once.
  const seen = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    const points = horrorPointsForDeed(event);
    if (points <= 0) continue;
    if (event?.id) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
    }
    const { darkDeed, darkSeverity } = normalizeDarkDeed(event);
    deeds.push({ eventId: event?.id ?? null, summary: String(event?.summary ?? ""), vice: darkDeed, severity: darkSeverity, points });
    deedPoints += points;
  }
  const baseline = Number.isFinite(legacyPoints) && legacyPoints > 0 ? legacyPoints : 0;
  const points = baseline + deedPoints;
  const crossings = Math.floor(points / HORROR_RANK_THRESHOLD);
  const alreadyDocked = Number.isInteger(docked) && docked > 0 ? docked : 0;
  return {
    points,
    deedPoints,
    legacyPoints: baseline,
    stage: horrorStageFor(points),
    crossings,
    newDocks: Math.max(0, crossings - alreadyDocked),
    nextThreshold: (crossings + 1) * HORROR_RANK_THRESHOLD,
    threshold: HORROR_RANK_THRESHOLD,
    deeds
  };
}

/**
 * The stored flag in the derived model's shape: { version: 2, legacyPoints, thresholdsDocked,
 * totalLevelsDocked, points, stage }. A pre-2026-09-29 flag ({ points, totalLevelsDocked }, accrued
 * from red approvals, points reduced by each crossing) is migrated without zeroing anything: its
 * crossings are estimated from the levels they docked (ceil(totalLevelsDocked / penalty)) and marked
 * docked, and the baseline is those crossings' points plus the old remainder -- so the stage still
 * shows the past, nothing is re-docked, and the next crossing lands exactly where the old meter's
 * would have. (A past crossing that found nothing to dock is invisible in the old data, so such a
 * world can read one stage lower; where the next dock lands is unaffected.)
 */
export function migrateHorrorRankState(stored) {
  if (stored && stored.version === 2) {
    const nonNegative = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
    const nonNegativeInt = (value) => (Number.isInteger(value) && value > 0 ? value : 0);
    const points = nonNegative(stored.points);
    return {
      version: 2,
      legacyPoints: nonNegative(stored.legacyPoints),
      thresholdsDocked: nonNegativeInt(stored.thresholdsDocked),
      totalLevelsDocked: nonNegativeInt(stored.totalLevelsDocked),
      points,
      stage: horrorStageFor(points)
    };
  }
  const legacy = normalizeHorrorRank(stored);
  const legacyCrossings = Math.ceil(legacy.totalLevelsDocked / HORROR_RANK_LEVEL_PENALTY);
  const legacyPoints = legacy.points + legacyCrossings * HORROR_RANK_THRESHOLD;
  return {
    version: 2,
    legacyPoints,
    thresholdsDocked: legacyCrossings,
    totalLevelsDocked: legacy.totalLevelsDocked,
    points: legacyPoints,
    stage: horrorStageFor(legacyPoints)
  };
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
    // A Class a merge replaced (lineage.js#markSuperseded) is history, not a Class the character
    // still holds: docking it would cost nothing and spare the real one.
    if (!isActiveEntry(entry)) continue;
    if (!Number.isInteger(entry?.level)) continue;
    if (!best || entry.level > best.entry.level) best = { id, entry };
  }
  return best;
}
