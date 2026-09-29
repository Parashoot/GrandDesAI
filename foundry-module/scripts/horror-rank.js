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
  ATONEMENT_LEVELS,
  ATONEMENT_SEVERITY_EQUIVALENT,
  DARK_SEVERITIES,
  HORROR_RANK_LEVEL_PENALTY,
  HORROR_RANK_MAX_STAGE,
  HORROR_RANK_POINTS_BY_SEVERITY,
  HORROR_RANK_SETTINGS,
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
  // Parallel to dockedFrom: which of this call's crossings (0-based) each deduction paid for, so the
  // api can record each dock against its crossing (restoreDockedLevels) without changing dockedFrom.
  const dockCrossings = [];
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
    dockCrossings.push(i);
  }
  return { registry: nextRegistry, levelsDocked, dockedFrom, dockCrossings };
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
 * The GM's tuning (board 41384131): the points per deed severity and the threshold, each clamped to
 * HORROR_RANK_SETTINGS' range; a missing or non-numeric value keeps the default. Atonement uses the
 * same scale (ATONEMENT_SEVERITY_EQUIVALENT), so moving "serious" moves a serious atonement too.
 * -> { pointsBySeverity: { none, minor, serious, monstrous }, threshold }.
 */
export function resolveHorrorRankConfig(raw = {}) {
  const pick = (name, fallback) => {
    const { min, max } = HORROR_RANK_SETTINGS[name];
    const value = Number(raw?.[name] ?? raw?.pointsBySeverity?.[name]);
    if (raw?.[name] === null || raw?.[name] === "" || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.round(value)));
  };
  return {
    pointsBySeverity: {
      none: 0,
      minor: pick("minor", HORROR_RANK_POINTS_BY_SEVERITY.minor),
      serious: pick("serious", HORROR_RANK_POINTS_BY_SEVERITY.serious),
      monstrous: pick("monstrous", HORROR_RANK_POINTS_BY_SEVERITY.monstrous)
    },
    threshold: pick("threshold", HORROR_RANK_THRESHOLD)
  };
}

const DEFAULT_CONFIG = resolveHorrorRankConfig();
const configOf = (config) => (config?.pointsBySeverity && Number.isFinite(config?.threshold) ? config : config ? resolveHorrorRankConfig(config) : DEFAULT_CONFIG);

/**
 * Horror Rank points one recorded event is worth. A deed needs BOTH a vice and a severity: a
 * severity with vice "none" names no taboo, and a vice with severity "none" was judged too petty to
 * stain. Things done TO the PC never carry a dark deed (the gateway's rule, contract section 1).
 */
export function horrorPointsForDeed(event, config) {
  const { darkDeed, darkSeverity } = normalizeDarkDeed(event);
  if (darkDeed === "none" || darkSeverity === "none") return 0;
  return configOf(config).pointsBySeverity[darkSeverity] ?? 0;
}

/**
 * An event's atonement level ("none" | "minor" | "serious" | "profound"): genuine amends or
 * redemption by the doer (owner decision 2026-09-29). Missing, unknown, or from the local fallback
 * analyzer (which never sets it) = "none".
 */
export function normalizeAtonement(event) {
  const value = typeof event?.atonement === "string" ? event.atonement.trim().toLowerCase() : "";
  return ATONEMENT_LEVELS.includes(value) ? value : "none";
}

/** Points an event's atonement takes OFF the meter: the same scale as deeds (profound = monstrous). */
export function atonementPointsFor(event, config) {
  const level = normalizeAtonement(event);
  if (level === "none") return 0;
  return configOf(config).pointsBySeverity[ATONEMENT_SEVERITY_EQUIVALENT[level]] ?? 0;
}

export function horrorStageFor(points, threshold = HORROR_RANK_THRESHOLD) {
  const value = Number.isFinite(points) && points > 0 ? points : 0;
  const step = Number.isFinite(threshold) && threshold > 0 ? threshold : HORROR_RANK_THRESHOLD;
  return Math.min(HORROR_RANK_MAX_STAGE, Math.floor(value / step));
}

/**
 * Derives the Horror Rank from the recorded events. `docked` is how many threshold crossings were
 * already docked (the stored high-water mark); `legacyPoints` is the baseline a pre-2026-09-29 world
 * carried from red approvals; `config` is resolveHorrorRankConfig's shape (the GM's settings).
 * Pure: returns what the meter reads and how many NEW crossings to dock (`newDocks`); it never
 * touches a registry.
 *
 * Atonement (owner decision 2026-09-29) subtracts on the deeds' scale. The sum runs in RECORDED
 * order and is floored at 0 at every step: amends made before any deed cannot be banked against
 * deeds done later (the meter cannot go below clean), which keeps it a derived re-sum -- the same
 * events always give the same number, and a re-analysis never double counts either side.
 *
 * Returns { points, deedPoints, atonementPoints, legacyPoints, stage, crossings, newDocks,
 * nextThreshold, threshold, pointsBySeverity, deeds: [{ eventId, summary, vice, severity, points }],
 * atonements: [{ eventId, summary, level, points }] }. `nextThreshold` is the point total of the
 * next crossing (every crossing docks, even past stage 3, which is only the display cap).
 */
export function computeHorrorRank(events, { docked = 0, legacyPoints = 0, config } = {}) {
  const cfg = configOf(config);
  const deeds = [];
  const atonements = [];
  let deedPoints = 0;
  let atonementPoints = 0;
  const baseline = Number.isFinite(legacyPoints) && legacyPoints > 0 ? legacyPoints : 0;
  let running = baseline;
  // Re-analysis replaces events, so one id should never appear twice; if it does it counts once.
  const seen = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    const points = horrorPointsForDeed(event, cfg);
    const amends = atonementPointsFor(event, cfg);
    if (points <= 0 && amends <= 0) continue;
    if (event?.id) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
    }
    if (points > 0) {
      const { darkDeed, darkSeverity } = normalizeDarkDeed(event);
      deeds.push({ eventId: event?.id ?? null, summary: String(event?.summary ?? ""), vice: darkDeed, severity: darkSeverity, points });
      deedPoints += points;
      running += points;
    }
    if (amends > 0) {
      atonements.push({ eventId: event?.id ?? null, summary: String(event?.summary ?? ""), level: normalizeAtonement(event), points: amends });
      atonementPoints += amends;
      running = Math.max(0, running - amends);
    }
  }
  const points = running;
  const crossings = Math.floor(points / cfg.threshold);
  const alreadyDocked = Number.isInteger(docked) && docked > 0 ? docked : 0;
  return {
    points,
    deedPoints,
    atonementPoints,
    legacyPoints: baseline,
    stage: horrorStageFor(points, cfg.threshold),
    crossings,
    newDocks: Math.max(0, crossings - alreadyDocked),
    nextThreshold: (crossings + 1) * cfg.threshold,
    threshold: cfg.threshold,
    pointsBySeverity: { ...cfg.pointsBySeverity },
    deeds,
    atonements
  };
}

// A dock the api recorded (restoreDockedLevels needs to know which Class lost what, for which
// crossing, and whether it was already given back). Unknown keys are dropped.
function normalizeDockRecord(record) {
  if (!record || typeof record !== "object" || typeof record.classId !== "string") return null;
  const int = (value) => (Number.isInteger(value) ? value : null);
  const levelsDocked = int(record.levelsDocked);
  const crossing = int(record.crossing);
  if (!levelsDocked || levelsDocked <= 0 || !crossing || crossing <= 0) return null;
  return {
    id: typeof record.id === "string" && record.id ? record.id : `dock:${crossing}:${record.classId}`,
    crossing,
    classId: record.classId,
    levelsDocked,
    fromLevel: int(record.fromLevel),
    toLevel: int(record.toLevel),
    at: typeof record.at === "string" ? record.at : null,
    ...(typeof record.restoredAt === "string" ? { restoredAt: record.restoredAt, restoredLevels: int(record.restoredLevels) ?? levelsDocked } : {})
  };
}

// A stage's suppressed feature (or a GM waiver for it). Unknown keys are dropped.
function normalizeSuppressionRecord(record) {
  if (!record || typeof record !== "object") return null;
  const waived = record.waived === true;
  if (!waived && typeof record.itemId !== "string") return null;
  return {
    stage: Number.isInteger(record.stage) && record.stage > 0 ? record.stage : 1,
    itemId: waived ? null : record.itemId,
    itemName: typeof record.itemName === "string" ? record.itemName : "",
    at: typeof record.at === "string" ? record.at : null,
    ...(waived ? { waived: true } : {}),
    ...(typeof record.systemId === "string" ? { systemId: record.systemId } : {})
  };
}

/**
 * The stored flag in the derived model's shape: { version: 2, legacyPoints, thresholdsDocked,
 * totalLevelsDocked, points, stage, docks, suppressions }. A pre-2026-09-29 flag ({ points,
 * totalLevelsDocked }, accrued from red approvals, points reduced by each crossing) is migrated
 * without zeroing anything: its crossings are estimated from the levels they docked
 * (ceil(totalLevelsDocked / penalty)) and marked docked, and the baseline is those crossings' points
 * plus the old remainder -- so the stage still shows the past, nothing is re-docked, and the next
 * crossing lands exactly where the old meter's would have. (A past crossing that found nothing to
 * dock is invisible in the old data, so such a world can read one stage lower; where the next dock
 * lands is unaffected.) Docks from before the dock log have no record and cannot be restored by
 * restoreDockedLevels (their Class is unknown).
 */
export function migrateHorrorRankState(stored, { threshold = HORROR_RANK_THRESHOLD } = {}) {
  const step = Number.isFinite(threshold) && threshold > 0 ? threshold : HORROR_RANK_THRESHOLD;
  const docks = (Array.isArray(stored?.docks) ? stored.docks : []).map(normalizeDockRecord).filter(Boolean);
  const suppressions = (Array.isArray(stored?.suppressions) ? stored.suppressions : []).map(normalizeSuppressionRecord).filter(Boolean);
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
      stage: horrorStageFor(points, step),
      docks,
      suppressions
    };
  }
  const legacy = normalizeHorrorRank(stored);
  const legacyCrossings = Math.ceil(legacy.totalLevelsDocked / HORROR_RANK_LEVEL_PENALTY);
  // The old meter's crossings were HORROR_RANK_THRESHOLD apart whatever the GM sets now.
  const legacyPoints = legacy.points + legacyCrossings * HORROR_RANK_THRESHOLD;
  return {
    version: 2,
    legacyPoints,
    thresholdsDocked: legacyCrossings,
    totalLevelsDocked: legacy.totalLevelsDocked,
    points: legacyPoints,
    stage: horrorStageFor(legacyPoints, step),
    docks,
    suppressions
  };
}

/**
 * Stage suppression bookkeeping (owner decision 2026-09-29): one feature per stage. `due` > 0 means
 * that many stages still need a feature suppressed (the GM confirms the default or picks another);
 * `due` < 0 means that many suppressed features are owed back (stages lost). Derived from the stage
 * and the records, so nothing is suppressed or restored twice.
 */
export function suppressionBalance(stage, suppressions = []) {
  const held = Array.isArray(suppressions) ? suppressions.length : 0;
  const target = Math.max(0, Math.min(HORROR_RANK_MAX_STAGE, Number.isInteger(stage) ? stage : 0));
  return { target, held, due: target - held };
}

/**
 * GM "Restore docked levels" (owner decision 2026-09-29): gives back the levels recorded docks took.
 * `ids` limits it to some docks (default: every unrestored one). Pure: returns a fresh registry, the
 * updated dock records (restored ones stamped `restoredAt`/`restoredLevels`, never restored twice),
 * `restored` [{ id, classId, levels, fromLevel, toLevel }], `skipped` [{ id, classId, reason }] and
 * `thresholdsDocked`: the high-water mark lowered only past crossings that are both restored and no
 * longer reached (`crossings` = the current meter's), so a later crossing of the same line docks
 * again -- once -- while a restore granted above the line never re-docks at once.
 */
export function restoreDockedLevels(registry, state, { ids = null, crossings = 0, at = new Date().toISOString() } = {}) {
  const nextRegistry = cloneRegistry(registry);
  const wanted = Array.isArray(ids) && ids.length ? new Set(ids) : null;
  const restored = [];
  const skipped = [];
  const docks = (state?.docks ?? []).map((dock) => {
    if (dock.restoredAt || (wanted && !wanted.has(dock.id))) return dock;
    const entry = nextRegistry.classes?.[dock.classId];
    if (!entry) {
      skipped.push({ id: dock.id, classId: dock.classId, reason: "class-missing" });
      return dock;
    }
    if (!isActiveEntry(entry)) {
      skipped.push({ id: dock.id, classId: dock.classId, reason: "class-superseded" });
      return dock;
    }
    const fromLevel = Number.isInteger(entry.level) ? entry.level : 1;
    const toLevel = fromLevel + dock.levelsDocked;
    nextRegistry.classes[dock.classId] = { ...entry, level: toLevel };
    restored.push({ id: dock.id, classId: dock.classId, levels: dock.levelsDocked, fromLevel, toLevel });
    return { ...dock, restoredAt: at, restoredLevels: dock.levelsDocked };
  });
  const levelsRestored = restored.reduce((sum, item) => sum + item.levels, 0);
  const thresholdsDocked = restoredHighWater(state?.thresholdsDocked ?? 0, docks, crossings);
  return { registry: nextRegistry, docks, restored, skipped, levelsRestored, thresholdsDocked };
}

// The highest crossing still counted as docked: every crossing up to the stored mark stays docked
// unless ALL its recorded docks were given back and the meter no longer reaches it. A crossing with
// no record (an older world, or one that found nothing to dock) stays docked.
function restoredHighWater(thresholdsDocked, docks, crossings) {
  const mark = Number.isInteger(thresholdsDocked) && thresholdsDocked > 0 ? thresholdsDocked : 0;
  const reached = Number.isInteger(crossings) && crossings > 0 ? crossings : 0;
  let highest = reached;
  for (let crossing = mark; crossing > reached; crossing -= 1) {
    const records = docks.filter((dock) => dock.crossing === crossing);
    if (!records.length || records.some((dock) => !dock.restoredAt)) {
      highest = crossing;
      break;
    }
  }
  return Math.min(mark, Math.max(highest, reached));
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
