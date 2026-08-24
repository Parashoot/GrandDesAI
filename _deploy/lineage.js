import { LINEAGE_OPERATIONS } from "./constants.js";
import { createMechanicsHtml } from "./mechanics.js";
import { getSystemAdapter } from "./systems/index.js";

export function emptyRegistry() {
  return { version: 1, classes: {}, skills: {}, titles: {} };
}

// Single source of truth for "which registry bucket does this entry kind live in" -- used by both
// normalizeEntry (reading lineage sources) and registerEntry (writing the approved entry), so
// adding a fourth kind in the future only ever means updating this one function plus
// REGISTRY_ENTRY_KINDS in constants.js.
function bucketFor(kind, registry) {
  if (kind === "class") return registry.classes;
  if (kind === "skill") return registry.skills;
  if (kind === "title") return registry.titles;
  throw new Error(`Unknown Grand Design entry kind: ${kind}.`);
}

function bucketNameFor(kind) {
  if (kind === "class") return "classes";
  if (kind === "skill") return "skills";
  if (kind === "title") return "titles";
  throw new Error(`Unknown Grand Design entry kind: ${kind}.`);
}

export function normalizeEntry(kind, entry, registry, operation = "origin") {
  const bucket = bucketFor(kind, registry);
  const metadata = entry.metadata ?? {};
  const lineage = metadata.lineage ?? {};
  const requestedOperation = lineage.operation ?? operation;
  const sourceIds = uniqueStrings(lineage.sources ?? []);
  const id = metadata.id ?? `${kind}:${slugify(entry.name)}`;

  if (!LINEAGE_OPERATIONS.has(requestedOperation)) {
    throw new Error(`Unsupported lineage operation: ${requestedOperation}.`);
  }
  if (requestedOperation === "combine" && sourceIds.length < 2) {
    throw new Error("A combined entry must reference at least two approved source entries.");
  }
  if (requestedOperation === "upgrade" && sourceIds.length !== 1) {
    throw new Error("An upgraded entry must reference exactly one approved source entry.");
  }
  for (const sourceId of sourceIds) {
    if (!bucket[sourceId]) {
      throw new Error(`Lineage source ${sourceId} is not an approved ${kind}.`);
    }
  }

  const inheritedTags = sourceIds.flatMap((sourceId) => bucket[sourceId].metadata.tags);
  return {
    ...entry,
    metadata: {
      id,
      tags: uniqueStrings([...(metadata.tags ?? []), ...inheritedTags]),
      lineage: {
        operation: requestedOperation,
        sources: sourceIds,
        rationale: stringOrEmpty(lineage.rationale)
      },
      // Red/taboo status (constants.js#ENTRY_POLARITIES, vice-taxonomy.js) must survive
      // normalization -- rebuilding metadata from scratch here previously dropped it silently,
      // which meant an approved red entry lost its polarity/malignance the moment it was
      // registered, breaking class-merging's red-by-contagion detection for any later merge that
      // used it as a source. Only carried through when actually present, so a standard entry's
      // normalized metadata stays exactly as before (no stray `polarity: undefined` field).
      ...(metadata.polarity !== undefined ? { polarity: metadata.polarity } : {}),
      ...(metadata.malignance !== undefined ? { malignance: metadata.malignance } : {})
    }
  };
}

export function registerEntry(kind, entry, itemId, registry) {
  const bucketName = bucketNameFor(kind);
  const next = cloneRegistry(registry);
  next[bucketName][entry.metadata.id] = {
    name: entry.name,
    itemId,
    approvedAt: new Date().toISOString(),
    metadata: entry.metadata,
    gameItem: entry.gameItem,
    mechanics: entry.mechanics,
    // Kind-specific fields kept on the registry entry (not just the one-off approval payload) so
    // later lineage operations -- most importantly class-merging.js's power/name math -- can read
    // a source's own tier, level, and chassis back out of the registry instead of needing the
    // original conversion payload still lying around. Additive and backward compatible: older
    // registry entries simply lack these fields, and every reader treats them as optional.
    ...(kind === "class"
      ? {
          level: entry.level,
          power_tier: entry.power_tier,
          is_primary: entry.is_primary === true,
          is_secondary: entry.is_secondary === true,
          system_chassis: entry.system_chassis,
          // Off-classing (class-merging.js#mergeClassEntry): whether this Class evolution was
          // forced through off the Grand Design's own cadence (CLASS_EVOLUTION_LEVELS). Only ever
          // set (true or false) on an entry that actually went through mergeClassEntry with an
          // actorLevel; a hand-authored Class/upgrade entry simply won't have this key at all,
          // which every reader should treat the same as "not applicable" rather than "on-cadence".
          ...(entry.offCycleEvolution !== undefined ? { offCycleEvolution: entry.offCycleEvolution } : {})
        }
      : kind === "skill"
      ? {
          tier: entry.tier,
          system_equivalent: entry.system_equivalent,
          // Skill evolution (skill-evolution.js#evolveSkillEntry): which Skill this evolved from,
          // whether a real defining moment catalyzed it or it merely refined, and the evidence
          // behind it. Same optionality contract as offCycleEvolution above -- a hand-authored
          // upgrade simply won't carry the key, which readers treat as "not applicable".
          ...(entry.evolution !== undefined ? { evolution: entry.evolution } : {})
        }
      : {
          // Title-specific: the deed that earned it, plus whatever it granted alongside itself
          // (a Skill/Item Item id created in the same approval, or descriptive reputation/
          // condition text -- see api.js#grantTitle and constants.js#TITLE_GRANT_KEYS).
          achievement: entry.achievement,
          grants: entry.grants ?? {},
          grantedSkillId: entry.grantedSkillId ?? null,
          grantedItemId: entry.grantedItemId ?? null
        })
  };
  return next;
}

/**
 * Builds the {type, system, flags} payload for actor.createEmbeddedDocuments("Item", [...]),
 * plus an optional async postCreate(item) step, for whichever game system is currently active.
 * The title/description/flags assembled here (name, PF2e-or-not "system equivalent" line,
 * mechanics HTML, tags, lineage) are entirely system-agnostic; only the actual system.* shape
 * (and, for dnd5e, the follow-up Activity) comes from the active system's adapter.
 */
export function createFeatureSource(kind, entry, systemId) {
  const adapter = getSystemAdapter(systemId);
  const title = kind === "class" ? `[${entry.name}] Class` : `[${entry.name}] Skill`;
  const equivalent = adapter.equivalentLabel(kind, entry);
  const tags = entry.metadata.tags.length ? entry.metadata.tags.join(", ") : "none";
  const sources = entry.metadata.lineage.sources.length
    ? entry.metadata.lineage.sources.join(", ")
    : "none";
  const { source: systemSource, postCreate } = adapter.buildItemSource(kind, entry);
  const source = {
    name: title,
    type: systemSource.type,
    system: {
      ...systemSource.system,
      description: {
        ...(systemSource.system?.description ?? {}),
        value: `<p><strong>${escapeHtml(adapter.label)} equivalent:</strong> ${escapeHtml(equivalent)}</p>${createMechanicsHtml(entry)}<p><strong>Tags:</strong> ${escapeHtml(tags)}</p><p><strong>Lineage:</strong> ${escapeHtml(entry.metadata.lineage.operation)}; sources: ${escapeHtml(sources)}</p><p>${escapeHtml(entry.metadata.lineage.rationale)}</p>`
      }
    },
    flags: {
      "grand-design-ai": {
        registryId: entry.metadata.id,
        kind,
        metadata: entry.metadata
      }
    }
  };
  return { source, postCreate };
}

/**
 * Builds the {type, system, flags} payload for a Title's own Item document -- a flavor badge, not
 * a usable ability, so unlike createFeatureSource there's no gameItem.kind/mechanics and (per the
 * adapters) no postCreate Activity step on any system: a Title has nothing to activate. What it
 * may have is a bundled reward (grants.skillEntry/itemGrant/reputation/condition -- see
 * constants.js#TITLE_GRANT_KEYS); api.js#grantTitle is what actually creates the granted Skill/
 * Item documents and records their ids on `entry`, this function just summarizes them into the
 * Title Item's own description text so the badge reads as a complete record of what it granted.
 */
export function createTitleSource(entry, systemId) {
  const adapter = getSystemAdapter(systemId);
  const { source: systemSource, postCreate } = adapter.buildTitleItemSource(entry);
  const source = {
    name: `[${entry.name}] Title`,
    type: systemSource.type,
    system: {
      ...systemSource.system,
      description: {
        ...(systemSource.system?.description ?? {}),
        value: `<p><strong>Achievement:</strong> ${escapeHtml(entry.achievement)}</p>${describeTitleGrantsHtml(entry.grants)}`
      }
    },
    flags: {
      "grand-design-ai": {
        registryId: entry.metadata.id,
        kind: "title",
        metadata: entry.metadata,
        achievement: entry.achievement,
        grants: entry.grants ?? {}
      }
    }
  };
  return { source, postCreate };
}

/**
 * Builds the temporary Item every participant in a live Combination Skill receives
 * (combination-skills.js, api.js#castCombinationSkill). Unlike createFeatureSource/createTitleSource
 * this Item is NOT backed by a registry entry -- it is a transient badge that exists only while the
 * combination is live and is deleted again by api.js#endCombinationSkill -- so it carries a
 * `combinationId` flag rather than a `registryId`, which is also what lets the ender find exactly
 * the right Items to remove without touching anything permanent.
 *
 * Modeled as a plain granted ability on both systems rather than as a status effect: PF2e's
 * "effect" Item type and dnd5e's ActiveEffect documents have no common shape between them, and a
 * combination is a temporary *ability the participants can use*, not a condition sitting on them.
 */
export function createCombinationSource(combination, participant, systemId) {
  const adapter = getSystemAdapter(systemId);
  const { source: systemSource, postCreate } = adapter.buildCombinationItemSource(combination);
  const source = {
    name: `[${combination.name}] Combination`,
    type: systemSource.type,
    system: {
      ...systemSource.system,
      description: {
        ...(systemSource.system?.description ?? {}),
        value: describeCombinationHtml(combination, participant)
      }
    },
    flags: {
      "grand-design-ai": {
        combinationId: combination.id,
        kind: "combination",
        combination,
        contributedSkillId: participant?.skillId ?? null
      }
    }
  };
  return { source, postCreate };
}

function describeCombinationHtml(combination, participant) {
  const roster = combination.participants
    .map(
      (entry) =>
        `<li>${escapeHtml(entry.actorName)} — [${escapeHtml(entry.skillName)}] (tier ${entry.tier})${
          participant && entry.skillId === participant.skillId && entry.actorId === participant.actorId ? " <em>— your contribution</em>" : ""
        }</li>`
    )
    .join("");
  const shared = combination.resonance.sharedTags.length ? combination.resonance.sharedTags.join(", ") : "none";
  const malignance = combination.malignance
    ? `<p><strong>Malignance (${escapeHtml(combination.malignance.vice)}):</strong> ${escapeHtml(combination.malignance.drawback)}</p>`
    : "";
  return (
    `<p><strong>Effect:</strong> ${escapeHtml(combination.effect)}</p>`
    + `<p><strong>Duration:</strong> ${escapeHtml(combination.duration)}</p>`
    + `<p><strong>Power:</strong> ${combination.power} (${escapeHtml(combination.band)}; resonance ${combination.resonance.score})</p>`
    + `<p><strong>Casters:</strong></p><ul>${roster}</ul>`
    + `<p><strong>Shared tags:</strong> ${escapeHtml(shared)}</p>`
    + malignance
    + `<p>${escapeHtml(combination.rationale)}</p>`
  );
}

function describeTitleGrantsHtml(grants) {
  if (!grants) return "";
  const lines = [];
  if (grants.skillEntry) lines.push(`<li>Skill: ${escapeHtml(grants.skillEntry.name)}</li>`);
  if (grants.itemGrant) lines.push(`<li>Item: ${escapeHtml(grants.itemGrant.name)}</li>`);
  if (grants.reputation) lines.push(`<li>Reputation: ${escapeHtml(grants.reputation)}</li>`);
  if (grants.condition) lines.push(`<li>Condition: ${escapeHtml(grants.condition.name)}</li>`);
  if (!lines.length) return "";
  return `<p><strong>Grants:</strong></p><ul>${lines.join("")}</ul>`;
}

export function cloneRegistry(registry) {
  return structuredClone(registry ?? emptyRegistry());
}

export function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "unnamed";
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
