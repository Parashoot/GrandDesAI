// Pure helpers for the playtest runner (playtest.mjs): argument parsing, name/id resolution, and the
// "advanced mechanics" read (owned entries with lineage, evolution readiness, erosion, Horror Rank)
// plus its report rendering. Kept out of playtest.mjs because that file runs its command on import;
// these are what the unit tests exercise (tests/playtest-advanced.test.mjs).
//
// The advanced-mechanics API (getOwnedEntries, requestSkillEvolution, requestClassMerge, the
// `evolutionReady` analysis field, title proposals) lands in a separate change, so everything here
// feature-detects: a method that is missing is reported as "not available in this build" and the
// read falls back to what today's API has (getActorRegistry, checkSkillEvolutionReadiness,
// checkClassErosion, getHorrorRank), so a report never silently drops a section.

export const NOT_AVAILABLE = "not available in this build";

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else {
      flags[key] = next;
      i += 1;
    }
  }
  return { cmd, flags };
}

/** "a, b,,c" -> ["a","b","c"]; a bare flag (true) or nothing -> []. */
export function parseList(value) {
  if (typeof value !== "string") return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Party members named by --actor (comma list, case-insensitive); none named = the whole party. */
export function selectParty(party, actorFlag) {
  const names = parseList(actorFlag).map((s) => s.toLowerCase());
  if (!names.length) return party;
  return party.filter((pc) => names.includes(String(pc.name).toLowerCase()));
}

/**
 * Finds one entry in a list of `{ id, name }` by exact id, then exact name, then a unique
 * case-insensitive substring of the name. Ambiguity is an error rather than a guess: evolving or
 * merging the wrong Class is not something a playtest should do silently.
 */
export function resolveEntry(entries, ref, what = "entry") {
  const needle = String(ref ?? "").trim();
  if (!needle) throw new Error(`no ${what} given`);
  const byId = entries.find((e) => e.id === needle);
  if (byId) return byId;
  const lower = needle.toLowerCase();
  const byName = entries.filter((e) => String(e.name ?? "").toLowerCase() === lower);
  if (byName.length === 1) return byName[0];
  const partial = entries.filter((e) => String(e.name ?? "").toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`"${needle}" matches several ${what}s: ${partial.map((e) => `${e.name} (${e.id})`).join(", ")}`);
  const known = entries.map((e) => e.name).join(", ") || "none";
  throw new Error(`no ${what} matches "${needle}" (owned: ${known})`);
}

const BUCKETS = [
  ["classes", "class"],
  ["skills", "skill"],
  ["titles", "title"]
];

/**
 * The same shape api.getOwnedEntries returns (contract: `{ classes, skills, titles }`, each
 * `{ id, name, kind, tier|level, power_tier?, polarity, status, lineage, effect }`), built from the
 * raw registry for builds that do not have it yet. "superseded" is read from wherever a build may
 * put it (entry.status or metadata.status); older registries have neither and are all active.
 */
export function ownedFromRegistry(registry) {
  const out = { classes: [], skills: [], titles: [] };
  for (const [bucket, kind] of BUCKETS) {
    for (const [id, entry] of Object.entries(registry?.[bucket] ?? {})) {
      if (!entry) continue;
      out[bucket].push({
        id,
        name: entry.name ?? id,
        kind,
        ...(kind === "class" ? { level: entry.level, power_tier: entry.power_tier } : {}),
        ...(kind === "skill" ? { tier: entry.tier } : {}),
        polarity: entry.metadata?.polarity ?? "standard",
        status: entry.status ?? entry.metadata?.status ?? "active",
        lineage: entry.metadata?.lineage ?? null,
        effect: entry.mechanics?.effect ?? entry.achievement ?? ""
      });
    }
  }
  return out;
}

/** Every id -> name the actor has ever owned, so lineage prints names (superseded sources included). */
export function nameIndex(owned) {
  const index = new Map();
  for (const [bucket] of BUCKETS) for (const e of owned?.[bucket] ?? []) index.set(e.id, e.name);
  return index;
}

export function describeLineage(lineage, names) {
  if (!lineage || !lineage.operation || lineage.operation === "origin") return "";
  const sources = (lineage.sources ?? []).map((id) => names.get(id) ?? id);
  return sources.length ? `${lineage.operation} of ${sources.join(" + ")}` : lineage.operation;
}

/**
 * Everything the report and the `owned` command show for one actor. `analysis` (optional) is the
 * analyzeSessionNotes/resolveLevelRest result: when the build reports `evolutionReady` itself we
 * trust it; otherwise readiness is computed from checkSkillEvolutionReadiness (hasCatalyst).
 */
export function collectAdvanced(api, actor, { analysis = null, restResult = null, erosionThreshold } = {}) {
  const notes = [];
  let owned;
  let ownedSource;
  if (typeof api.getOwnedEntries === "function") {
    owned = api.getOwnedEntries(actor);
    ownedSource = "getOwnedEntries";
  } else {
    owned = ownedFromRegistry(api.getActorRegistry(actor));
    ownedSource = "registry";
    notes.push(`getOwnedEntries ${NOT_AVAILABLE} (read from the registry)`);
  }
  owned = { classes: owned?.classes ?? [], skills: owned?.skills ?? [], titles: owned?.titles ?? [] };

  let evolutionReady = analysis?.evolutionReady ?? restResult?.evolutionReady ?? null;
  let readySource = evolutionReady ? "api" : null;
  if (!evolutionReady) {
    try {
      evolutionReady = (api.checkSkillEvolutionReadiness?.(actor) ?? [])
        .filter((row) => row.hasCatalyst)
        .map((row) => ({ skillId: row.skillId, name: row.name, pressure: row.evidenceWeight, definingMoments: (row.definingMoments ?? []).length }));
      readySource = "checkSkillEvolutionReadiness";
    } catch (error) {
      evolutionReady = [];
      notes.push(`evolution readiness failed: ${error.message}`);
    }
  }
  // Superseded Skills cannot evolve again; a build that reports them anyway should not mislead the DM.
  const superseded = new Set(owned.skills.filter((s) => s.status === "superseded").map((s) => s.id));
  evolutionReady = evolutionReady.filter((row) => !superseded.has(row.skillId));

  let erosion = [];
  try {
    erosion = api.checkClassErosion(actor, erosionThreshold ? { sessionThreshold: erosionThreshold } : {}) ?? [];
  } catch (error) {
    notes.push(`erosion check failed: ${error.message}`);
  }
  const horrorRank = typeof api.getHorrorRank === "function" ? api.getHorrorRank(actor) : null;
  if (!horrorRank) notes.push(`getHorrorRank ${NOT_AVAILABLE}`);
  const pendingAdvanced = (api.getGrowth?.(actor)?.proposals ?? [])
    .filter((p) => p.status === "pending" && (p.kind === "title" || ["upgrade", "combine"].includes(p.entry?.metadata?.lineage?.operation)))
    .map((p) => ({ id: p.id, name: p.entry?.name ?? p.id, kind: p.kind ?? "skill", operation: p.entry?.metadata?.lineage?.operation ?? null, sources: p.entry?.metadata?.lineage?.sources ?? [], polarity: p.entry?.metadata?.polarity ?? "standard" }));
  return { owned, ownedSource, evolutionReady, readySource, erosion, horrorRank, pendingAdvanced, notes };
}

function ownedLine(entry, names) {
  const bits = [];
  if (entry.kind === "class") bits.push(`level ${entry.level ?? "?"}${entry.power_tier ? `, ${entry.power_tier}` : ""}`);
  if (entry.kind === "skill") bits.push(`tier ${entry.tier ?? "?"}`);
  if (entry.polarity === "red") bits.push("RED");
  const lineage = describeLineage(entry.lineage, names);
  if (lineage) bits.push(lineage);
  const name = entry.status === "superseded" ? `~~${entry.name}~~ (superseded)` : `**${entry.name}**`;
  return `- ${entry.kind}: ${name}${bits.length ? ` (${bits.join("; ")})` : ""}`;
}

/** The per-PC "Advanced mechanics" block of report.md (and the `owned` command's output). */
export function renderAdvancedSection(adv, { heading = "### Advanced mechanics" } = {}) {
  const lines = [heading, ""];
  const names = nameIndex(adv.owned);
  const all = [...adv.owned.classes, ...adv.owned.skills, ...adv.owned.titles];
  lines.push(`Owned (${all.filter((e) => e.status !== "superseded").length} active${all.some((e) => e.status === "superseded") ? `, ${all.filter((e) => e.status === "superseded").length} superseded` : ""}):`);
  if (!all.length) lines.push("- _nothing owned yet_");
  for (const entry of all) lines.push(ownedLine(entry, names));
  lines.push("");
  lines.push(`Evolution ready: ${adv.evolutionReady.length ? adv.evolutionReady.map((r) => `**${r.name ?? r.skillId}** (pressure ${r.pressure ?? "?"})`).join(", ") : "none"}`);
  lines.push(`Erosion (Classes at risk): ${adv.erosion.length ? adv.erosion.map((c) => `**${c.name}** (${c.neverSeen ? "never seen in play" : `${c.sessionsSinceLastSeen} session(s) since its tags`})`).join(", ") : "none"}`);
  const hr = adv.horrorRank;
  lines.push(`Horror Rank: ${hr ? `${hr.points} point(s), ${hr.totalLevelsDocked} level(s) docked` : NOT_AVAILABLE}`);
  if (adv.pendingAdvanced?.length) {
    lines.push(`Pending advanced proposals: ${adv.pendingAdvanced.map((p) => `${p.name} [${p.kind}${p.operation ? `/${p.operation} of ${p.sources.map((id) => names.get(id) ?? id).join(" + ")}` : ""}${p.polarity === "red" ? ", RED" : ""}]`).join("; ")}`);
  }
  if (adv.notes.length) lines.push(`_${adv.notes.join("; ")}_`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Every place an AI call fell back to a template or the local analyzer, as report lines. The GM
 * rule is that a fallback is never silent; this makes the playtest report hold to it too.
 * Sources: the analysis itself (source != adapter), rest warnings (milestone rewards), pending
 * proposals marked `usedFallback`, and requestSkillEvolution/requestClassMerge results.
 */
export function fallbackLines({ analysis = null, restResult = null, pending = [], requests = [] } = {}) {
  const out = [];
  if (analysis && analysis.source && analysis.source !== "adapter") {
    out.push(`analysis read by ${analysis.source}${analysis.adapterError ? `: ${analysis.adapterError}` : ""}`);
  }
  for (const warning of restResult?.warnings ?? []) out.push(`rest: ${warning}`);
  for (const p of pending) {
    if (p?.usedFallback) out.push(`proposal "${p.entry?.name ?? p.id}" is a fallback${p.fallbackReason ? `: ${p.fallbackReason}` : ""}`);
  }
  for (const r of requests) {
    if (r?.usedFallback) out.push(`${r.label ?? "request"}: usedFallback${r.reason ? ` (${r.reason})` : ""}`);
  }
  return out;
}

/** One-line console summary of a requestSkillEvolution / requestClassMerge result. */
export function describeRequestResult(label, result) {
  const p = result?.proposal;
  const entry = p?.entry ?? {};
  const lineage = entry.metadata?.lineage;
  const head = `${label}: ${p ? `pending proposal "${entry.name ?? p.id}" (${p.kind ?? "?"}${entry.tier ? `, tier ${entry.tier}` : ""}${entry.level ? `, level ${entry.level}` : ""}${entry.power_tier ? `, ${entry.power_tier}` : ""}${lineage?.operation ? `, ${lineage.operation}` : ""})` : "no proposal"}`;
  const how = result?.usedFallback ? ` -- usedFallback${result.reason ? `: ${result.reason}` : ""}` : " -- authored by the AI";
  return head + how;
}
