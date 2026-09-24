// Emergent themes (AI gateway v2, 2026-09-23).
//
// Why this exists: the 38-tag growth taxonomy (growth-taxonomy.js) was only ever a vocabulary for
// the things we anticipated. Real tables do things nobody wrote a tag for -- a character keeps bees,
// runs a card table, draws maps, cooks for an inn full of refugees -- and before this file every one
// of those sentences was either force-fitted into the nearest wrong tag or thrown away as "no
// gameplay tag". Canon (The Wandering Inn) is built on exactly those unplanned Classes: [Innkeeper],
// [Beekeeper], [Gambler]. So an event may now carry free-vocabulary `themes` (slugs), those themes
// accumulate their own weighted evidence exactly like tags do, and once a theme has been practiced
// enough it yields a pending *placeholder* Skill proposal the GM can ask the AI to author properly.
//
// Pure ESM, zero Foundry globals: api.js, the Node tests and the scale harness all import it.
import { GROWTH_EVENT_OUTCOME_WEIGHTS } from "./constants.js";
import { GROWTH_TAXONOMY } from "./growth-taxonomy.js";
import { resolveTag as gatewayResolveTag, slugifyTheme } from "./ai/normalize.js";

// Same scale as progression.js's MINIMUM_EVIDENCE: three plain successes earn a proposal.
export const EMERGENT_THEME_EVIDENCE_THRESHOLD = 3;
export const EMERGENT_PROPOSAL_PREFIX = "proposal:emergent-";
const MAX_LABEL_LENGTH = 60;
const CANONICAL_TAGS = new Set(GROWTH_TAXONOMY.map(([tag]) => tag));

/**
 * Theme slug: the gateway core's slugifyTheme (scripts/ai/normalize.js) so a theme typed by the GM,
 * produced by the model, or stored on an old event all land on the same key. Idempotent.
 */
export function themeSlug(raw) {
  return slugifyTheme(raw);
}

export function isCanonicalTag(tag) {
  return CANONICAL_TAGS.has(tag);
}

/** "card-sharping" -> "Card Sharping" */
export function titleCaseTheme(slug) {
  return String(slug ?? "")
    .split(/[-\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function themeLabel(slug, themeMap = {}) {
  const label = themeMap?.[slug]?.label;
  return typeof label === "string" && label.trim() ? label.trim().slice(0, MAX_LABEL_LENGTH) : titleCaseTheme(slug);
}

/**
 * Splits a raw tag list (from a model or a GM) into canonical tags and emergent themes, using the
 * gateway's resolver (scripts/ai/normalize.js#resolveTag: exact, case, the big synonym table,
 * GM custom synonyms, stems, fuzzy). Anything it cannot place becomes a theme -- an unknown word is
 * never silently dropped; only what the resolver itself calls noise ("misc", "other") is.
 * `resolveTag` is injectable for tests.
 */
export function splitTagsAndThemes(rawTags, { resolveTag = gatewayResolveTag, customSynonyms = {} } = {}) {
  const tags = [];
  const themes = [];
  const remapped = {};
  for (const raw of Array.isArray(rawTags) ? rawTags : []) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const trimmed = raw.trim();
    if (CANONICAL_TAGS.has(trimmed)) {
      tags.push(trimmed);
      continue;
    }
    let resolved;
    try {
      resolved = resolveTag(trimmed, { customSynonyms: customSynonyms ?? {} });
    } catch {
      resolved = { theme: trimmed };
    }
    if (!resolved) continue; // resolver judged it noise
    if (resolved.alsoTheme) {
      const also = themeSlug(resolved.alsoTheme);
      if (also) themes.push(also);
    }
    if (resolved.tag && CANONICAL_TAGS.has(resolved.tag)) {
      tags.push(resolved.tag);
      remapped[trimmed] = resolved.tag;
      continue;
    }
    const slug = themeSlug(resolved.theme ?? trimmed);
    if (slug) themes.push(slug);
  }
  return { tags: [...new Set(tags)], themes: [...new Set(themes)], remapped };
}

// --- GM theme map -----------------------------------------------------------------------------

/**
 * Follows `mergeInto` links to the final theme a slug should count as (cycle-safe), or null when
 * that final theme is ignored.
 */
export function resolveThemeSlug(slug, themeMap = {}) {
  let current = slug;
  const seen = new Set();
  while (themeMap?.[current]?.mergeInto && !seen.has(current)) {
    seen.add(current);
    const next = themeSlug(themeMap[current].mergeInto);
    if (!next || next === current) break;
    current = next;
  }
  if (themeMap?.[current]?.ignored) return null;
  return current;
}

/**
 * Applies the GM's theme map to events without mutating them:
 *  - `ignored: true`  -> the theme is dropped from the event,
 *  - `mergeInto: slug` -> the theme counts as that other theme (chains followed),
 *  - `mapTo: tag`      -> the theme becomes that canonical tag (so it now feeds the ordinary
 *                         template proposals too) and leaves `themes`.
 * Events whose tags/themes don't change are returned as the same object.
 */
export function applyThemeMap(events, themeMap = {}) {
  if (!Array.isArray(events)) return [];
  if (!themeMap || !Object.keys(themeMap).length) return events;
  return events.map((event) => {
    const themes = Array.isArray(event?.themes) ? event.themes : [];
    if (!themes.length) return event;
    const nextThemes = [];
    const extraTags = [];
    let changed = false;
    for (const theme of themes) {
      const finalSlug = resolveThemeSlug(theme, themeMap);
      if (finalSlug === null) {
        changed = true;
        continue;
      }
      const mapTo = themeMap?.[finalSlug]?.mapTo ?? themeMap?.[theme]?.mapTo;
      if (mapTo && CANONICAL_TAGS.has(mapTo)) {
        extraTags.push(mapTo);
        changed = true;
        continue;
      }
      if (finalSlug !== theme) changed = true;
      nextThemes.push(finalSlug);
    }
    if (!changed) return event;
    const tags = [...new Set([...(Array.isArray(event.tags) ? event.tags : []), ...extraTags])];
    return { ...event, tags, themes: [...new Set(nextThemes)] };
  });
}

// --- Evidence and proposals -------------------------------------------------------------------

/** Map(slug -> weighted evidence), using the same outcome weights canonical tags use. */
export function themeEvidence(events) {
  const evidence = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const weight = GROWTH_EVENT_OUTCOME_WEIGHTS[event?.outcome];
    if (weight === undefined) continue;
    for (const theme of new Set(Array.isArray(event.themes) ? event.themes : [])) {
      if (typeof theme !== "string" || !theme) continue;
      evidence.set(theme, (evidence.get(theme) ?? 0) + weight);
    }
  }
  return evidence;
}

/**
 * A VALID placeholder Skill entry (passes validator.js#validateSkillEntry) for a theme. It is
 * deliberately modest -- tier 1, passive, a +1 to checks that are clearly this activity -- and is
 * flagged needsAuthoring on its proposal so the GM can ask the AI gateway to write the real thing
 * ("[Apiarist's Calm]") with actual mechanics. System-neutral wording: "a +1 bonus" reads correctly
 * in both PF2e (where the GM applies it as a circumstance bonus) and dnd5e.
 */
export function buildEmergentSkillEntry(slug, { label, evidenceIds = [], weight = 0 } = {}) {
  const name = `${label || titleCaseTheme(slug)} Knack`;
  const activity = (label || titleCaseTheme(slug)).toLowerCase();
  return {
    name,
    tier: 1,
    system_equivalent: "Placeholder emergent Skill (GM review) -- use \"Author with AI\" to write real mechanics",
    gameItem: { kind: "passive" },
    mechanics: {
      effect: `When you attempt a check whose purpose is clearly ${activity}, you gain a +1 bonus to that check `
        + "(a circumstance bonus in PF2e). The GM decides which checks qualify.",
      duration: `while practicing ${activity}`,
      frequency: { max: 1, per: "unlimited" }
    },
    metadata: {
      tags: [],
      themes: [slug],
      lineage: {
        operation: "origin",
        sources: [],
        rationale: `Emergent theme "${slug}" practiced across ${evidenceIds.length} recorded event(s), weighted evidence `
          + `${Number(weight).toFixed(2)}. Not in the fixed tag taxonomy -- this is a placeholder awaiting AI/GM authoring.`
      }
    }
  };
}

function registryHasTheme(registry, slug, name) {
  const skills = registry?.skills ?? {};
  if (skills[`skill:${registrySlug(name)}`]) return true;
  return Object.values(skills).some((entry) => Array.isArray(entry?.metadata?.themes) && entry.metadata.themes.includes(slug));
}

function registrySlug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/**
 * A theme with weighted evidence >= threshold and no approved Skill for it yields a pending
 * placeholder proposal. The GM's theme map is applied first, so an ignored theme never proposes,
 * a merged one proposes under its merge target, and a mapped one has become a canonical tag.
 */
export function generateEmergentProposals(events, registry, { themeMap = {}, threshold = EMERGENT_THEME_EVIDENCE_THRESHOLD } = {}) {
  const mapped = applyThemeMap(Array.isArray(events) ? events : [], themeMap);
  const evidence = themeEvidence(mapped);
  const proposals = [];
  for (const [slug, weight] of evidence) {
    if (weight < threshold) continue;
    const label = themeLabel(slug, themeMap);
    const evidenceIds = mapped
      .filter((event) => Array.isArray(event.themes) && event.themes.includes(slug) && event.id)
      .map((event) => event.id);
    const entry = buildEmergentSkillEntry(slug, { label, evidenceIds, weight });
    if (registryHasTheme(registry, slug, entry.name)) continue;
    proposals.push({
      id: `${EMERGENT_PROPOSAL_PREFIX}${slug}`,
      kind: "skill",
      status: "pending",
      source: "emergent",
      needsAuthoring: true,
      theme: slug,
      evidence: evidenceIds,
      entry
    });
  }
  return proposals;
}

// --- World-level "seen themes" state (the emergentThemes world setting) ------------------------

/** Always returns a well-formed { themes: { slug: {...} } } from whatever was stored. */
export function normalizeEmergentThemeState(raw) {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value || "{}");
    } catch {
      value = {};
    }
  }
  const themes = {};
  const source = value && typeof value === "object" && value.themes && typeof value.themes === "object" ? value.themes : {};
  for (const [rawSlug, record] of Object.entries(source)) {
    const slug = themeSlug(rawSlug);
    if (!slug || !record || typeof record !== "object") continue;
    themes[slug] = {
      count: Number.isFinite(record.count) && record.count >= 0 ? Math.floor(record.count) : 0,
      label: typeof record.label === "string" && record.label.trim() ? record.label.trim().slice(0, MAX_LABEL_LENGTH) : titleCaseTheme(slug),
      firstSeen: typeof record.firstSeen === "string" ? record.firstSeen : null,
      ...(typeof record.lastSeen === "string" ? { lastSeen: record.lastSeen } : {}),
      ...(record.mapTo && CANONICAL_TAGS.has(record.mapTo) ? { mapTo: record.mapTo } : {}),
      ...(record.mergeInto && themeSlug(record.mergeInto) && themeSlug(record.mergeInto) !== slug ? { mergeInto: themeSlug(record.mergeInto) } : {}),
      ...(record.ignored === true ? { ignored: true } : {}),
      ...(record.labelEdited === true ? { labelEdited: true } : {})
    };
  }
  return { themes };
}

/** The part of the state the proposal/evidence logic needs. */
export function themeMapFromState(state) {
  const { themes } = normalizeEmergentThemeState(state);
  const map = {};
  for (const [slug, record] of Object.entries(themes)) {
    const entry = {};
    if (record.labelEdited) entry.label = record.label;
    if (record.mapTo) entry.mapTo = record.mapTo;
    if (record.mergeInto) entry.mergeInto = record.mergeInto;
    if (record.ignored) entry.ignored = true;
    if (Object.keys(entry).length) map[slug] = entry;
  }
  return map;
}

/**
 * Counts the themes on newly recorded events into the world state. Returns the next state and the
 * slugs seen for the first time (the Growth dialog marks those "new!"). `now` is injected so this
 * stays deterministic in tests. `countExisting: false` (used by a re-analysis of the same notes)
 * registers brand-new themes without bumping the counts of ones already seen.
 */
export function observeThemes(state, events, now = new Date().toISOString(), { countExisting = true } = {}) {
  const next = normalizeEmergentThemeState(state);
  const newlySeen = [];
  for (const event of Array.isArray(events) ? events : []) {
    for (const raw of new Set(Array.isArray(event?.themes) ? event.themes : [])) {
      const slug = themeSlug(raw);
      if (!slug) continue;
      const record = next.themes[slug];
      if (!record) {
        next.themes[slug] = { count: 1, label: titleCaseTheme(slug), firstSeen: now, lastSeen: now };
        newlySeen.push(slug);
      } else if (countExisting) {
        record.count += 1;
        record.lastSeen = now;
      }
    }
  }
  return { state: next, newlySeen: [...new Set(newlySeen)] };
}

/**
 * Validates and applies one GM mapping. `mapping` = { label?, mapTo?, mergeInto?, ignored? }, or
 * null to clear every override for that slug. Throws a readable error on an invalid mapping (unknown
 * canonical tag, merging a theme into itself) because this is a direct GM action, not model output.
 */
export function setThemeMapping(state, slug, mapping) {
  const next = normalizeEmergentThemeState(state);
  const key = themeSlug(slug);
  if (!key) throw new Error("A theme slug is required.");
  const record = next.themes[key] ?? { count: 0, label: titleCaseTheme(key), firstSeen: null };
  delete record.mapTo;
  delete record.mergeInto;
  delete record.ignored;
  if (mapping === null) {
    record.label = titleCaseTheme(key);
    delete record.labelEdited;
    next.themes[key] = record;
    return next;
  }
  if (!mapping || typeof mapping !== "object") throw new Error("A theme mapping must be an object or null.");
  if (typeof mapping.label === "string" && mapping.label.trim()) {
    record.label = mapping.label.trim().slice(0, MAX_LABEL_LENGTH);
    record.labelEdited = record.label !== titleCaseTheme(key);
    if (!record.labelEdited) delete record.labelEdited;
  }
  if (mapping.mapTo) {
    if (!CANONICAL_TAGS.has(mapping.mapTo)) {
      throw new Error(`"${mapping.mapTo}" is not a canonical gameplay tag (allowed: ${[...CANONICAL_TAGS].join(", ")}).`);
    }
    record.mapTo = mapping.mapTo;
  }
  if (mapping.mergeInto) {
    const target = themeSlug(mapping.mergeInto);
    if (!target || target === key) throw new Error("A theme cannot be merged into itself.");
    // Refuse a merge that would close a cycle back to this theme.
    const probe = { ...themeMapFromState(next), [key]: { mergeInto: target } };
    let cursor = target;
    const seen = new Set([key]);
    while (probe[cursor]?.mergeInto) {
      if (seen.has(cursor)) throw new Error("That merge would create a loop between themes.");
      seen.add(cursor);
      cursor = probe[cursor].mergeInto;
      if (cursor === key) throw new Error("That merge would create a loop between themes.");
    }
    record.mergeInto = target;
    if (!next.themes[target]) next.themes[target] = { count: 0, label: titleCaseTheme(target), firstSeen: null };
  }
  if (mapping.ignored === true) record.ignored = true;
  next.themes[key] = record;
  return next;
}

/** Sorted list for UIs: most-practiced first. */
export function listThemes(state) {
  const { themes } = normalizeEmergentThemeState(state);
  return Object.entries(themes)
    .map(([slug, record]) => ({ slug, ...record }))
    .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));
}
