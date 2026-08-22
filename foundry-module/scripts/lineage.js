import { LINEAGE_OPERATIONS } from "./constants.js";
import { createMechanicsHtml, itemTypeFor, pf2eActionType } from "./mechanics.js";

export function emptyRegistry() {
  return { version: 1, classes: {}, skills: {} };
}

export function normalizeEntry(kind, entry, registry, operation = "origin") {
  const bucket = kind === "class" ? registry.classes : registry.skills;
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
      }
    }
  };
}

export function registerEntry(kind, entry, itemId, registry) {
  const bucketName = kind === "class" ? "classes" : "skills";
  const next = cloneRegistry(registry);
  next[bucketName][entry.metadata.id] = {
    name: entry.name,
    itemId,
    approvedAt: new Date().toISOString(),
    metadata: entry.metadata,
    gameItem: entry.gameItem,
    mechanics: entry.mechanics
  };
  return next;
}

export function createFeatureSource(kind, entry) {
  const category = kind === "class" ? "classfeature" : "skill";
  const level = kind === "class" ? Math.min(20, Math.max(1, entry.level)) : entry.tier;
  const title = kind === "class" ? `[${entry.name}] Class` : `[${entry.name}] Skill`;
  const equivalent = kind === "class" ? entry.pf2e_chassis ?? "Pending PF2e chassis review" : entry.pf2e_equivalent;
  const tags = entry.metadata.tags.length ? entry.metadata.tags.join(", ") : "none";
  const sources = entry.metadata.lineage.sources.length
    ? entry.metadata.lineage.sources.join(", ")
    : "none";
  const source = {
    name: title,
    type: itemTypeFor(entry.gameItem.kind),
    system: {
      description: {
        value: `<p><strong>PF2e equivalent:</strong> ${escapeHtml(equivalent)}</p>${createMechanicsHtml(entry)}<p><strong>Tags:</strong> ${escapeHtml(tags)}</p><p><strong>Lineage:</strong> ${escapeHtml(entry.metadata.lineage.operation)}; sources: ${escapeHtml(sources)}</p><p>${escapeHtml(entry.metadata.lineage.rationale)}</p>`
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
  if (source.type === "feat") {
    source.system.category = entry.gameItem.kind === "passive" && kind !== "class" ? "skill" : category;
    source.system.level = { value: level };
  } else if (source.type === "action") {
    source.system.actionType = { value: pf2eActionType(entry.gameItem.kind) };
    source.system.actions = { value: entry.mechanics.actions ?? null };
    source.system.category = "offensive";
  } else if (source.type === "spell") {
    source.system.level = { value: entry.gameItem.rank };
    source.system.traits = { traditions: { value: [entry.gameItem.tradition] }, value: [] };
    source.system.time = { value: `${entry.mechanics.actions ?? 1} action${entry.mechanics.actions === 1 ? "" : "s"}` };
    source.system.duration = { value: entry.mechanics.duration, sustained: false };
  } else if (source.type === "weapon") {
    const weaponDamage = parseWeaponDamage(entry.gameItem.damage);
    source.system.category = entry.gameItem.category ?? "simple";
    source.system.group = entry.gameItem.group ?? "club";
    source.system.damage = { dice: weaponDamage.dice, die: weaponDamage.die, damageType: entry.gameItem.damageType };
    source.system.traits = { value: entry.gameItem.traits ?? [] };
  }
  return source;
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

function parseWeaponDamage(formula) {
  const match = /^(\d+)d(\d+)/i.exec(formula);
  return { dice: Number(match[1]), die: `d${match[2]}` };
}
