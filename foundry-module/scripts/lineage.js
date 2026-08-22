import { LINEAGE_OPERATIONS } from "./constants.js";

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
    metadata: entry.metadata
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
  return {
    name: title,
    type: "feat",
    system: {
      category,
      level: { value: level },
      description: {
        value: `<p><strong>PF2e equivalent:</strong> ${escapeHtml(equivalent)}</p><p><strong>Tags:</strong> ${escapeHtml(tags)}</p><p><strong>Lineage:</strong> ${escapeHtml(entry.metadata.lineage.operation)}; sources: ${escapeHtml(sources)}</p><p>${escapeHtml(entry.metadata.lineage.rationale)}</p>`
      },
      traits: { value: [] }
    },
    flags: {
      "grand-design-ai": {
        registryId: entry.metadata.id,
        kind,
        metadata: entry.metadata
      }
    }
  };
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
