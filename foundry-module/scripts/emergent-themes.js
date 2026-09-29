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
import { classifyActorName } from "./session-notes.js";

// Same scale as progression.js's MINIMUM_EVIDENCE: three plain successes earn a proposal.
export const EMERGENT_THEME_EVIDENCE_THRESHOLD = 3;
export const EMERGENT_PROPOSAL_PREFIX = "proposal:emergent-";
// Separate own events a theme needs before it proposes a Knack. With today's outcome weights three
// weighted evidence already takes two events (a criticalSuccess is 1.6), so this changes nothing for
// a real actor; it states the rule outright so a weight retune can never let one event through.
export const MIN_OWN_THEME_EVENTS = 2;
const MAX_LABEL_LENGTH = 60;
const CANONICAL_TAGS = new Set(GROWTH_TAXONOMY.map(([tag]) => tag));

/**
 * Theme slug: the gateway core's slugifyTheme (scripts/ai/normalize.js) so a theme typed by the GM,
 * produced by the model, or stored on an old event all land on the same key. Idempotent.
 */
export function themeSlug(raw) {
  return slugifyTheme(raw);
}

// --- Near-duplicate folding (board 7f1f20ae) ---------------------------------------------------
//
// The model names the same activity several ways across sessions. The live dnd5e world had
// trophy-taking / taking-trophies, pie-eating / pie-contest, holding-line / holding-the-line,
// carving / whittling and wrestling / arm-wrestling, each counted separately and each able to mint
// its own "<Theme> Knack". Two slugs are the same theme when their FOLD KEYS match: stopwords
// dropped, each word lightly stemmed, word order ignored, plus a small hand-written synonym list.
//
// Deliberately conservative -- there is NO "one slug's words contain the other's" rule. That rule
// would fold "wrestling-instruction" into "wrestling", and those are different practices: a
// character who teaches wrestling is growing as a teacher (canon hands out teaching Classes of
// their own), and folding would let every lesson given pad the teacher's own Wrestling Knack.
// arm-wrestling IS listed as a synonym of wrestling (the tavern form of the same contest of
// strength against another body, which a Wrestling Knack's "+1 when clearly wrestling" covers).
// A GM who disagrees un-merges it in the Emergent Themes menu and it stays separate (keepSeparate).

const FOLD_STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "to", "in", "on", "at", "for", "with", "from", "by", "into", "onto",
  "my", "his", "her", "their", "its", "our", "your", "some"
]);

// Word-level synonyms: each variant counts as the canonical word wherever it appears in a slug.
const WORD_SYNONYMS = {
  carving: ["whittling", "whittle", "whittled", "woodcarving"],
  trophy: ["trophies", "keepsake", "keepsakes"]
};

// Whole-theme synonyms: each variant slug folds into the canonical slug (the key), and when both
// appear the canonical slug is the one that survives.
const THEME_SYNONYMS = {
  "pie-eating": ["pie-contest", "pie-eating-contest", "pie-contests"],
  wrestling: ["arm-wrestling", "armwrestling", "arm-wrestle"],
  "trophy-taking": ["trophy-hunting", "collecting-trophies"]
};

function stemWord(word) {
  let stem = word;
  if (stem.length <= 3) return stem;
  // Plurals first, then verb endings, so "takings" and "taking" and "take" all meet at "tak".
  if (stem.endsWith("ies") && stem.length > 4) stem = `${stem.slice(0, -3)}y`;
  else if (/(ss|x|z|ch|sh)es$/.test(stem) && stem.length > 4) stem = stem.slice(0, -2);
  else if (stem.endsWith("s") && !stem.endsWith("ss") && stem.length > 3) stem = stem.slice(0, -1);
  if (stem.endsWith("ing") && stem.length > 5) stem = stem.slice(0, -3);
  else if (stem.endsWith("ed") && stem.length > 4) stem = stem.slice(0, -2);
  if (/([b-df-hj-np-tv-z])\1$/.test(stem)) stem = stem.slice(0, -1); // "runn" -> "run", "dress" -> "dres"
  if (stem.endsWith("e") && stem.length > 3) stem = stem.slice(0, -1); // "take" meets "tak(ing)"
  return stem;
}

const WORD_SYNONYM_STEMS = new Map();
for (const [canonical, variants] of Object.entries(WORD_SYNONYMS)) {
  for (const variant of variants) WORD_SYNONYM_STEMS.set(stemWord(variant), stemWord(canonical));
}

function rawFoldKey(slug) {
  const words = String(slug ?? "").split("-").filter(Boolean);
  const content = words.filter((word) => !FOLD_STOPWORDS.has(word));
  const kept = content.length ? content : words;
  const stems = kept.map((word) => {
    const stem = stemWord(word);
    return WORD_SYNONYM_STEMS.get(stem) ?? stem;
  });
  return [...new Set(stems)].sort().join(" ");
}

const THEME_SYNONYM_KEYS = new Map();
const CANONICAL_THEME_BY_KEY = new Map();
for (const [canonical, variants] of Object.entries(THEME_SYNONYMS)) {
  const canonicalKey = rawFoldKey(canonical);
  CANONICAL_THEME_BY_KEY.set(canonicalKey, canonical);
  for (const variant of variants) THEME_SYNONYM_KEYS.set(rawFoldKey(themeSlug(variant)), canonicalKey);
}

/**
 * The key two near-duplicate theme slugs share: "taking-trophies" and "trophy-taking" -> "tak trophy",
 * "holding-the-line" and "holding-line" -> "hold lin". Not a display value.
 */
export function themeFoldKey(raw) {
  const slug = themeSlug(raw);
  if (!slug) return "";
  const key = rawFoldKey(slug);
  return THEME_SYNONYM_KEYS.get(key) ?? key;
}

/** Whether two theme slugs name the same activity (see themeFoldKey). */
export function sameTheme(a, b) {
  const keyA = themeFoldKey(a);
  return Boolean(keyA) && keyA === themeFoldKey(b);
}

function isSynonymCanonical(slug) {
  return CANONICAL_THEME_BY_KEY.get(themeFoldKey(slug)) === slug;
}

function hasGmOverride(record) {
  return Boolean(record?.labelEdited || record?.mapTo || record?.ignored || record?.keepSeparate || (record?.mergeInto && !record?.folded));
}

/**
 * One-shot migration for the world registry (run on every load by normalizeEmergentThemeState, and
 * idempotent): near-duplicate slugs (same themeFoldKey) are folded into one surviving theme. The
 * survivor is the synonym list's canonical slug when present, else the most-seen one (then the
 * earliest seen, then the shorter slug). A folded slug is NOT deleted: it keeps its record with
 * `mergeInto: <survivor>, folded: true` -- the same mechanism a GM merge uses -- so events that
 * still carry the old slug count under the survivor, and the GM can un-merge it in the settings menu.
 * Its count and per-actor counts move onto the survivor. Records the GM has curated (renamed,
 * mapped, ignored, merged elsewhere, or explicitly kept separate) are never folded away.
 * Returns { state, folded: [{ from, into }] }.
 */
export function foldDuplicateThemes(registry) {
  const state = registry && typeof registry === "object" && registry.themes && typeof registry.themes === "object"
    ? { themes: { ...registry.themes } }
    : { themes: {} };
  const groups = new Map();
  for (const [slug, record] of Object.entries(state.themes)) {
    if (record?.mergeInto) continue; // already points somewhere; it is not a candidate either way
    const key = themeFoldKey(slug);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(slug);
  }
  const folded = [];
  for (const slugs of groups.values()) {
    if (slugs.length < 2) continue;
    const ranked = [...slugs].sort((a, b) => compareSurvivors(a, b, state.themes));
    const survivorSlug = ranked[0];
    const survivor = { ...state.themes[survivorSlug] };
    if (survivor.actors) survivor.actors = { ...survivor.actors };
    for (const slug of ranked.slice(1)) {
      const record = state.themes[slug];
      if (hasGmOverride(record)) continue;
      survivor.count = (survivor.count ?? 0) + (record.count ?? 0);
      if (record.actors && Object.keys(record.actors).length) {
        survivor.actors = { ...(survivor.actors ?? {}) };
        for (const [actorId, count] of Object.entries(record.actors)) {
          survivor.actors[actorId] = (survivor.actors[actorId] ?? 0) + count;
        }
      }
      if (record.firstSeen && (!survivor.firstSeen || record.firstSeen < survivor.firstSeen)) survivor.firstSeen = record.firstSeen;
      if (record.lastSeen && (!survivor.lastSeen || record.lastSeen > survivor.lastSeen)) survivor.lastSeen = record.lastSeen;
      const { actors: _moved, ...rest } = record;
      state.themes[slug] = { ...rest, count: 0, mergeInto: survivorSlug, folded: true };
      folded.push({ from: slug, into: survivorSlug });
    }
    state.themes[survivorSlug] = survivor;
  }
  return { state, folded };
}

function compareSurvivors(a, b, themes) {
  const ra = themes[a];
  const rb = themes[b];
  // An ignored or GM-kept-separate record should not absorb plain duplicates.
  const blockedA = ra?.ignored || ra?.keepSeparate ? 1 : 0;
  const blockedB = rb?.ignored || rb?.keepSeparate ? 1 : 0;
  if (blockedA !== blockedB) return blockedA - blockedB;
  const canonA = isSynonymCanonical(a) ? 0 : 1;
  const canonB = isSynonymCanonical(b) ? 0 : 1;
  if (canonA !== canonB) return canonA - canonB;
  if ((rb?.count ?? 0) !== (ra?.count ?? 0)) return (rb?.count ?? 0) - (ra?.count ?? 0);
  const fa = ra?.firstSeen ?? "￿";
  const fb = rb?.firstSeen ?? "￿";
  if (fa !== fb) return fa < fb ? -1 : 1;
  if (a.length !== b.length) return a.length - b.length;
  return a.localeCompare(b);
}

/**
 * Removes themes whose recorded actors no longer exist (test actors, deleted PCs). `liveActorIds` is
 * every actor id still in the world. Per-actor counts of deleted actors are dropped everywhere (and
 * taken off the theme's total); a theme is purged only when it HAD per-actor data and none of those
 * actors survive -- a legacy record without `actors` cannot be judged and is kept (see
 * recountThemeActors to backfill it) -- and never when the GM curated it or another theme still
 * merges into it. A folded duplicate goes with its survivor. Returns { state, purged: [slug] }.
 */
export function purgeOrphanThemes(state, liveActorIds = []) {
  const next = normalizeEmergentThemeState(state);
  const live = new Set([...(liveActorIds ?? [])].map(String));
  const orphaned = new Set();
  for (const [slug, record] of Object.entries(next.themes)) {
    const actors = record.actors ?? {};
    const ids = Object.keys(actors);
    if (!ids.length) continue;
    let removed = 0;
    const kept = {};
    for (const actorId of ids) {
      if (live.has(actorId)) kept[actorId] = actors[actorId];
      else removed += actors[actorId];
    }
    if (Object.keys(kept).length) record.actors = kept;
    else delete record.actors;
    record.count = Math.max(0, record.count - removed);
    if (!Object.keys(kept).length && !hasGmOverride(record) && !record.mergeInto) orphaned.add(slug);
  }
  // Folded duplicates follow their survivor out; a theme something else still merges into stays.
  for (const [slug, record] of Object.entries(next.themes)) {
    if (record.folded && record.mergeInto && orphaned.has(record.mergeInto) && !Object.keys(record.actors ?? {}).length) orphaned.add(slug);
  }
  for (const [slug, record] of Object.entries(next.themes)) {
    if (!orphaned.has(slug) && record.mergeInto && orphaned.has(record.mergeInto)) orphaned.delete(record.mergeInto);
  }
  for (const slug of orphaned) delete next.themes[slug];
  return { state: next, purged: [...orphaned] };
}

/**
 * Rebuilds each theme's per-actor counts from the actors' own stored growth events -- the backfill a
 * legacy registry (recorded before per-actor counts existed) needs before purgeOrphanThemes can tell
 * a test actor's theme from a real one. `actorEvents` = [{ actorId, events }]. Themes are resolved
 * through the registry's own merges/folds, so a folded duplicate's events count for its survivor.
 * The world total `count` is left alone (it also counts re-analyses and deleted actors' history).
 */
export function recountThemeActors(state, actorEvents = []) {
  const next = normalizeEmergentThemeState(state);
  const map = themeMapFromState(next);
  const tallies = new Map();
  for (const { actorId, events } of Array.isArray(actorEvents) ? actorEvents : []) {
    if (!actorId) continue;
    for (const event of Array.isArray(events) ? events : []) {
      for (const raw of new Set(Array.isArray(event?.themes) ? event.themes : [])) {
        const slug = resolveThemeSlug(themeSlug(raw), map) ?? themeSlug(raw);
        if (!slug || !next.themes[slug]) continue;
        if (!tallies.has(slug)) tallies.set(slug, {});
        const perActor = tallies.get(slug);
        perActor[actorId] = (perActor[actorId] ?? 0) + 1;
      }
    }
  }
  for (const [slug, record] of Object.entries(next.themes)) {
    const perActor = record.mergeInto ? null : tallies.get(slug);
    if (perActor) record.actors = perActor;
    else delete record.actors;
  }
  return next;
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
 * ("[Apiarist's Calm]") with actual mechanics. "a +1 bonus" reads correctly in both systems; the
 * PF2e-only aside "(a circumstance bonus)" is added only when `systemId` is pf2e (the default, for
 * callers that predate the option), so a dnd5e table never reads a Pathfinder term.
 */
export function buildEmergentSkillEntry(slug, { label, evidenceIds = [], weight = 0, systemId = "pf2e" } = {}) {
  const name = `${label || titleCaseTheme(slug)} Knack`;
  const activity = (label || titleCaseTheme(slug)).toLowerCase();
  return {
    name,
    tier: 1,
    system_equivalent: "Placeholder emergent Skill (GM review) -- use \"Author with AI\" to write real mechanics",
    gameItem: { kind: "passive" },
    mechanics: {
      effect: `When you attempt a check whose purpose is clearly ${activity}, you gain a +1 bonus to that check`
        + `${systemId === "dnd5e" ? "" : " (a circumstance bonus)"}. The GM decides which checks qualify.`,
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
  // By fold key, so an approved Skill for "trophy-taking" also covers "taking-trophies".
  const key = themeFoldKey(slug);
  return Object.values(skills).some((entry) => Array.isArray(entry?.metadata?.themes)
    && entry.metadata.themes.some((theme) => theme === slug || themeFoldKey(theme) === key));
}

/**
 * Rewrites each event's themes so near-duplicates share one slug: per fold key, the synonym list's
 * canonical slug if it appears, else the first spelling in event order (events are append-only, so
 * this choice -- and the proposal id built from it -- stays stable as more events arrive).
 */
function foldEventThemes(events) {
  const representative = new Map();
  for (const event of events) {
    for (const theme of Array.isArray(event?.themes) ? event.themes : []) {
      const key = themeFoldKey(theme);
      if (!key) continue;
      const current = representative.get(key);
      if (!current || (!isSynonymCanonical(current) && isSynonymCanonical(theme))) representative.set(key, theme);
    }
  }
  return events.map((event) => {
    const themes = Array.isArray(event?.themes) ? event.themes : [];
    if (!themes.length) return event;
    const folded = [...new Set(themes.map((theme) => representative.get(themeFoldKey(theme)) ?? theme))];
    const changed = folded.length !== themes.length || folded.some((theme, index) => theme !== themes[index]);
    return changed ? { ...event, themes: folded } : event;
  });
}

function registrySlug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/**
 * A theme with weighted evidence >= threshold and no approved Skill for it yields a pending
 * placeholder proposal. The GM's theme map is applied first, so an ignored theme never proposes,
 * a merged one proposes under its merge target, and a mapped one has become a canonical tag.
 */
export function generateEmergentProposals(events, registry, {
  themeMap = {},
  threshold = EMERGENT_THEME_EVIDENCE_THRESHOLD,
  systemId = "pf2e",
  excludeThemes = [],
  // Board 7f1f20ae: a Knack needs the ACTOR'S OWN repeats. `actorNames` (the actor's name and its
  // parts) drops events whose actorName is clearly someone else (session-notes.js#classifyActorName
  // "other" -- e.g. events recorded before per-PC attribution existed), and `minEvents` requires
  // that many separate own events, so one big moment is never "practice".
  actorNames = null,
  // (A caller that lowers the evidence threshold below the default is asking for fewer events, so
  // the repeat rule relaxes with it unless `minEvents` is given.)
  minEvents = threshold >= EMERGENT_THEME_EVIDENCE_THRESHOLD ? MIN_OWN_THEME_EVENTS : 1
} = {}) {
  const excludedKeys = new Set(excludeThemes.map((theme) => themeFoldKey(theme)).filter(Boolean));
  const own = (Array.isArray(events) ? events : []).filter((event) =>
    !Array.isArray(actorNames) || !actorNames.length || classifyActorName(event?.actorName, actorNames) !== "other");
  const mapped = foldEventThemes(applyThemeMap(own, themeMap));
  const evidence = themeEvidence(mapped);
  const proposals = [];
  for (const [slug, weight] of evidence) {
    if (weight < threshold) continue;
    // A theme a pending AI proposal already covers must not also get a "<Theme> Knack" placeholder.
    if (excludedKeys.has(themeFoldKey(slug))) continue;
    const repeats = mapped.filter((event) => GROWTH_EVENT_OUTCOME_WEIGHTS[event?.outcome] !== undefined
      && Array.isArray(event.themes) && event.themes.includes(slug)).length;
    if (repeats < minEvents) continue;
    const label = themeLabel(slug, themeMap);
    const evidenceIds = mapped
      .filter((event) => Array.isArray(event.themes) && event.themes.includes(slug) && event.id)
      .map((event) => event.id);
    const entry = buildEmergentSkillEntry(slug, { label, evidenceIds, weight, systemId });
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
      ...(record.labelEdited === true ? { labelEdited: true } : {}),
      // Board 7f1f20ae: per-actor counts (so test actors and deleted PCs can be purged, and the GM
      // sees whose practice a theme is), the fold marker, and the GM's "keep this separate".
      ...(normalizeActorCounts(record.actors) ?? {}),
      ...(record.keepSeparate === true ? { keepSeparate: true } : {})
    };
    if (record.folded === true && themes[slug].mergeInto) themes[slug].folded = true;
  }
  // Near-duplicate slugs are folded every time the registry is read; it is idempotent, so this is the
  // one-shot migration for old worlds and a no-op afterwards.
  return foldDuplicateThemes({ themes }).state;
}

function normalizeActorCounts(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const actors = {};
  for (const [actorId, count] of Object.entries(raw)) {
    if (actorId && Number.isFinite(count) && count > 0) actors[actorId] = Math.floor(count);
  }
  return Object.keys(actors).length ? { actors } : null;
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
export function observeThemes(state, events, now = new Date().toISOString(), { countExisting = true, actorId = null } = {}) {
  const next = normalizeEmergentThemeState(state);
  const newlySeen = [];
  for (const event of Array.isArray(events) ? events : []) {
    // Per-actor counts (board 7f1f20ae): whose practice this is, so a deleted test actor's themes
    // can be purged. An event may carry its own actorId; otherwise the caller's applies.
    const owner = typeof event?.actorId === "string" && event.actorId ? event.actorId : actorId;
    const seenInEvent = new Set();
    for (const raw of new Set(Array.isArray(event?.themes) ? event.themes : [])) {
      const slug = themeSlug(raw);
      if (!slug) continue;
      // A brand-new slug that is a near-duplicate of a known theme ("taking-trophies" when
      // "trophy-taking" exists) is counted on the known theme and recorded as folded into it, so it
      // is neither "new!" nor a second Knack in waiting.
      let target = slug;
      if (!next.themes[slug]) {
        const twin = findFoldTwin(next, slug);
        if (twin) {
          next.themes[slug] = { count: 0, label: titleCaseTheme(slug), firstSeen: now, lastSeen: now, mergeInto: twin, folded: true };
          target = twin;
        }
      } else if (next.themes[slug].folded && next.themes[slug].mergeInto && next.themes[next.themes[slug].mergeInto]) {
        target = next.themes[slug].mergeInto;
      }
      if (seenInEvent.has(target)) continue; // two spellings in one event are still one practice
      seenInEvent.add(target);
      const record = next.themes[target];
      if (!record) {
        next.themes[target] = { count: 1, label: titleCaseTheme(target), firstSeen: now, lastSeen: now, ...(owner ? { actors: { [owner]: 1 } } : {}) };
        newlySeen.push(target);
      } else if (countExisting) {
        record.count += 1;
        record.lastSeen = now;
        if (owner) record.actors = { ...(record.actors ?? {}), [owner]: (record.actors?.[owner] ?? 0) + 1 };
      } else if (owner && !record.actors?.[owner]) {
        // A re-analysis does not re-count, but it may be the first time we learn whose theme it is.
        record.actors = { ...(record.actors ?? {}), [owner]: 1 };
      }
    }
  }
  return { state: next, newlySeen: [...new Set(newlySeen)] };
}

/** An existing, un-merged theme with the same fold key as `slug` (not `slug` itself), or null. */
function findFoldTwin(state, slug) {
  const key = themeFoldKey(slug);
  if (!key) return null;
  for (const [other, record] of Object.entries(state.themes)) {
    if (other === slug || record?.mergeInto || record?.keepSeparate) continue;
    if (themeFoldKey(other) === key) return other;
  }
  return null;
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
  // A theme the fold migration merged, which the GM now un-merges (a mapping without that
  // mergeInto), is kept separate from then on -- otherwise the next load would fold it right back.
  const wasFoldedInto = record.folded ? record.mergeInto : null;
  delete record.mapTo;
  delete record.mergeInto;
  delete record.ignored;
  delete record.folded;
  if (wasFoldedInto) {
    const stillMerged = mapping && typeof mapping === "object" && themeSlug(mapping.mergeInto ?? "") === wasFoldedInto;
    if (stillMerged) record.folded = true;
    else record.keepSeparate = true;
  }
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
