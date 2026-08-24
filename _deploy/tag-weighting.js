// Dynamic tag reweighting: canon's Isthekenous actively repatches which tags grant which XP over
// time. Every growth-event tag currently contributes evidence toward a Skill proposal
// (progression.js#taggedEvidenceWeight) at the exact same rate forever -- this module is the pure
// math behind letting a GM reassign that per tag instead, without a code change. See
// tag-weighting-settings.js for the actual Foundry world-settings UI a GM uses to edit this map;
// this module only knows about a plain `{tag: multiplier}` object, so it's fully testable without
// any Foundry API at all.
//
// Deliberately does NOT touch progressionForEvent's raw Grand Design level progress -- that stays
// purely outcome/dangerGap-based. Tag weighting only affects which Skills a tag's own evidence is
// strong enough to justify proposing, the same scope Consolidation (progression.js) already
// established for "what counts as evidence for a tagged Skill" versus "how much the character grew
// overall."
const DEFAULT_TAG_WEIGHT = 1;

export function normalizeTagWeights(value) {
  const normalized = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [tag, multiplier] of Object.entries(value)) {
      if (typeof tag !== "string" || !tag.trim()) continue;
      if (!Number.isFinite(multiplier) || multiplier < 0) continue;
      normalized[tag.trim()] = multiplier;
    }
  }
  return normalized;
}

/** A tag with no configured override always weighs at the default 1x -- nothing changes until a GM actually reassigns it. */
export function weightForTag(tagWeights, tag) {
  const normalized = normalizeTagWeights(tagWeights);
  return Object.prototype.hasOwnProperty.call(normalized, tag) ? normalized[tag] : DEFAULT_TAG_WEIGHT;
}

/** Returns a NEW tagWeights map with `tag` reassigned to `multiplier` -- the input is never mutated. */
export function setTagWeight(tagWeights, tag, multiplier) {
  if (typeof tag !== "string" || !tag.trim()) {
    throw new Error("A tag reweight requires a non-empty tag.");
  }
  if (!Number.isFinite(multiplier) || multiplier < 0) {
    throw new Error("A tag's multiplier must be a non-negative number.");
  }
  return { ...normalizeTagWeights(tagWeights), [tag.trim()]: multiplier };
}

/** Returns a NEW tagWeights map with `tag`'s override removed (back to the 1x default) -- the input is never mutated. */
export function removeTagWeight(tagWeights, tag) {
  const next = { ...normalizeTagWeights(tagWeights) };
  delete next[tag];
  return next;
}
