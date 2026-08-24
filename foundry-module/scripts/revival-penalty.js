// Revival penalty: canon's resurrection cost -- levels off the character's own highest Class. A
// one-shot GM action (see api.js#applyRevivalPenalty), NOT an accumulating meter the way Horror
// Rank is: this fires exactly once, whenever a GM actually applies it, docking a fixed number of
// levels immediately, rather than building up over time and crossing a threshold.
//
// Deliberately reuses horror-rank.js's findStrongestClass, but WITHOUT excluding red Classes: a
// resurrection toll is a physical/mystical cost paid regardless of what your strongest Class
// actually is, unlike Horror Rank's docking (which deliberately never erodes a red Class, since
// that's a corruption consequence specifically about NOT touching the taint itself).
import { REVIVAL_PENALTY_LEVELS } from "./constants.js";
import { cloneRegistry } from "./lineage.js";
import { findStrongestClass } from "./horror-rank.js";

/**
 * Docks up to `levels` (default REVIVAL_PENALTY_LEVELS) from the actor's single strongest Class
 * on the registry -- never split across multiple Classes, never below level 1. Returns the
 * updated registry (a fresh clone -- the input is never mutated) and `dockedFrom`: either
 * `{classId, levelsDocked}` for the Class actually docked, or `null` if there was no eligible
 * Class to dock from at all (an empty registry, or the actor's only Class is already level 1).
 */
export function applyRevivalPenalty(registry, levels = REVIVAL_PENALTY_LEVELS) {
  const nextRegistry = cloneRegistry(registry);
  const target = findStrongestClass(nextRegistry);
  if (!target) return { registry: nextRegistry, dockedFrom: null };

  const levelsToDock = Math.min(Number.isFinite(levels) ? levels : REVIVAL_PENALTY_LEVELS, Math.max(0, target.entry.level - 1));
  if (levelsToDock <= 0) return { registry: nextRegistry, dockedFrom: null };

  nextRegistry.classes[target.id] = { ...target.entry, level: target.entry.level - levelsToDock };
  return { registry: nextRegistry, dockedFrom: { classId: target.id, levelsDocked: levelsToDock } };
}
