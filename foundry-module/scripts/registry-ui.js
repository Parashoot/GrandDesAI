import { MODULE_ID } from "./constants.js";
import {
  BUSY_NOTICE,
  actionButton,
  describeActionError,
  lineageSourceNames,
  normalizeHorrorRankView,
  openGrowthManager,
  prettifyEntryId,
  renderHorrorRankMeter,
  setBusy
} from "./growth-ui.js";

// The "Grand Design" registry panel (board 752369f6, 0860fd78; advanced-mechanics batch 2026-09-29).
// Until now a GM could only see a character's owned Classes/Skills/Titles on the sheet, and the
// advanced actions (evolve, merge, erosion...) lived in the console. The panel lists every owned
// entry with its lineage by NAME, dims superseded ones, and offers Evolve (Skills) and Merge (2+
// Classes). Neither approves anything: each asks the API for a PENDING proposal and then opens the
// Growth dialog on it, so the GM reviews it with the same Details / Edit / Approve / Reject as any
// other proposal.
//
// The API calls this panel uses (getOwnedEntries, requestSkillEvolution, requestClassMerge) are
// written in parallel by dev-integration: each is feature-detected, and the panel still renders
// from the registry flag (api.getActorRegistry) when getOwnedEntries is missing.
//
// Like growth-ui.js, it stays on Dialog v1 and runs long actions in the BODY with the same busy
// state, and it never touches growth-ui.js exports at module evaluation (the two import each other).

const EVOLVE = "gd-registry-evolve";
const MERGE = "gd-registry-merge";
const OPEN_GROWTH = "gd-registry-open-growth";
const LOCKABLE = `[data-action="${EVOLVE}"], [data-action="${MERGE}"], [data-action="${OPEN_GROWTH}"], input[name="gd-merge-class"]`;
const COMING_SOON = ["Combine Skills", "Cleanse", "Consolidate", "Revive"];

/**
 * { classes, skills, titles } of normalized owned entries: api.getOwnedEntries when it exists (the
 * contract), else read straight from the registry flag. Never throws on a malformed registry.
 */
export function collectOwnedEntries(api, actor) {
  if (typeof api?.getOwnedEntries === "function") {
    try {
      const owned = api.getOwnedEntries(actor);
      if (owned && typeof owned === "object") {
        return {
          classes: normalizeList("class", owned.classes),
          skills: normalizeList("skill", owned.skills),
          titles: normalizeList("title", owned.titles)
        };
      }
    } catch (error) {
      console.warn(`${MODULE_ID} | getOwnedEntries failed; reading the registry flag instead`, error);
    }
  }
  let registry = null;
  try {
    registry = typeof api?.getActorRegistry === "function" ? api.getActorRegistry(actor) : null;
  } catch {
    registry = null;
  }
  return ownedEntriesFromRegistry(registry);
}

/** The registry flag ({ classes: {id: entry}, skills, titles }) as owned-entry lists. Pure. */
export function ownedEntriesFromRegistry(registry) {
  const bucket = (kind, value) => normalizeList(kind, value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value).map(([id, entry]) => ({ ...(entry && typeof entry === "object" ? entry : {}), id: entry?.metadata?.id ?? id }))
    : value);
  return {
    classes: bucket("class", registry?.classes),
    skills: bucket("skill", registry?.skills),
    titles: bucket("title", registry?.titles)
  };
}

function normalizeList(kind, list) {
  return (Array.isArray(list) ? list : []).filter((entry) => entry && typeof entry === "object").map((entry) => normalizeOwnedEntry(kind, entry));
}

/**
 * One owned entry in the contract's shape. Accepts both the contract (top-level polarity, status,
 * lineage, effect) and the raw registry entry (all of that under metadata / mechanics). Pure.
 */
export function normalizeOwnedEntry(kind, raw) {
  const metadata = raw?.metadata && typeof raw.metadata === "object" ? raw.metadata : {};
  const id = String(raw?.id ?? metadata.id ?? `${kind}:${String(raw?.name ?? "unnamed").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
  const supersededBy = raw?.supersededBy ?? metadata.supersededBy ?? null;
  const status = String(raw?.status ?? metadata.status ?? (supersededBy ? "superseded" : "active")) === "superseded" ? "superseded" : "active";
  const lineage = raw?.lineage && typeof raw.lineage === "object" ? raw.lineage : metadata.lineage && typeof metadata.lineage === "object" ? metadata.lineage : null;
  const effect = [raw?.effect, raw?.mechanics?.effect, raw?.description, raw?.achievement]
    .find((text) => typeof text === "string" && text.trim()) ?? "";
  return {
    id,
    name: String(raw?.name ?? prettifyEntryId(id)),
    kind,
    ...(kind === "class" ? { level: raw?.level, power_tier: raw?.power_tier } : {}),
    ...(kind === "skill" ? { tier: raw?.tier } : {}),
    ...(kind === "title" ? { achievement: raw?.achievement ?? "" } : {}),
    polarity: raw?.polarity ?? metadata.polarity ?? "standard",
    vice: raw?.vice ?? metadata.malignance?.vice ?? null,
    status,
    supersededBy,
    lineage,
    effect: String(effect),
    tags: Array.isArray(raw?.tags) ? raw.tags : Array.isArray(metadata.tags) ? metadata.tags : []
  };
}

/** id -> name over every owned entry, superseded ones included (lineage points at them). Pure. */
export function ownedNameIndex(owned) {
  const index = new Map();
  for (const list of [owned?.classes, owned?.skills, owned?.titles]) {
    for (const entry of Array.isArray(list) ? list : []) if (entry?.id) index.set(entry.id, entry.name);
  }
  return index;
}

/** checkClassErosion, limited to Classes still active (a superseded Class cannot erode). */
export function activeErosion(api, actor, owned = null) {
  if (typeof api?.checkClassErosion !== "function") return [];
  const atRisk = api.checkClassErosion(actor);
  if (!Array.isArray(atRisk)) return [];
  const classes = (owned ?? collectOwnedEntries(api, actor)).classes;
  const superseded = new Set(classes.filter((entry) => entry.status === "superseded").map((entry) => entry.id));
  return atRisk.filter((risk) => risk?.classId && !superseded.has(risk.classId));
}

/** "No deed matching its tags (leadership, defense) in 3 sessions." Pure, exported for tests. */
export function describeErosion(risk) {
  const sessions = Math.max(0, Math.floor(Number(risk?.sessionsSinceLastSeen) || 0));
  const tags = Array.isArray(risk?.tags) && risk.tags.length ? ` (${risk.tags.slice(0, 4).join(", ")})` : "";
  if (risk?.neverSeen) return `No recorded deed has matched its tags${tags} yet, across ${sessions} session${sessions === 1 ? "" : "s"}.`;
  return `No deed matching its tags${tags} in the last ${sessions} session${sessions === 1 ? "" : "s"}.`;
}

/** The at-risk Classes as a list (used by the panel and after an analysis). Exported for tests. */
export function renderErosionList(atRisk) {
  const rows = (Array.isArray(atRisk) ? atRisk : []).map((risk) =>
    `<li class="gd-erosion"><i class="fas fa-hourglass-half"></i> <strong>${escapeHtml(risk?.name ?? risk?.classId ?? "A Class")}</strong>: ${escapeHtml(describeErosion(risk))} <span class="gd-hint">Advisory: nothing is removed; play to it or let it fade.</span></li>`).join("");
  return rows ? `<ul class="gd-erosion-list">${rows}</ul>` : "";
}

/**
 * skillId -> { ready, pressure } from api.checkSkillEvolutionReadiness (exists) plus the last
 * result's evolutionReady (contract). "Ready" means the rules' catalyst is met (enough practice AND
 * a defining moment); Evolve still works without it, as a plain refinement.
 */
export function evolutionReadiness(api, actor, lastResult = null) {
  const map = new Map();
  try {
    const rows = typeof api?.checkSkillEvolutionReadiness === "function" ? api.checkSkillEvolutionReadiness(actor) : [];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row?.skillId) continue;
      const weight = Number(row.evidenceWeight);
      const threshold = Number(row.evidenceThreshold);
      map.set(row.skillId, {
        ready: row.hasCatalyst === true,
        pressure: Number.isFinite(weight) && Number.isFinite(threshold) && threshold > 0 ? `${round(weight)}/${round(threshold)}` : null,
        definingMoments: Array.isArray(row.definingMoments) ? row.definingMoments.length : 0
      });
    }
  } catch (error) {
    console.warn(`${MODULE_ID} | checkSkillEvolutionReadiness failed`, error);
  }
  for (const row of Array.isArray(lastResult?.evolutionReady) ? lastResult.evolutionReady : []) {
    if (!row?.skillId) continue;
    const known = map.get(row.skillId) ?? { pressure: null, definingMoments: 0 };
    map.set(row.skillId, { ...known, ready: true, pressure: known.pressure ?? (Number.isFinite(Number(row.pressure)) ? String(round(Number(row.pressure))) : null) });
  }
  return map;
}

/**
 * { level, message } for a requestSkillEvolution / requestClassMerge result ({ proposal,
 * usedFallback, reason }). A fallback is always named with its reason (CLAUDE.md: never a silent
 * fallback). Pure, exported for tests.
 */
export function describeAdvancedResult(result, operation = "evolve") {
  const proposal = result?.proposal ?? (result?.entry ? result : null);
  const noun = operation === "merge" ? "merged Class" : "evolved Skill";
  if (!proposal) return { level: "warn", message: `Nothing was proposed for the ${noun}.${result?.reason ? ` ${result.reason}` : ""}` };
  const name = proposal.entry?.name ?? proposal.id ?? `the ${noun}`;
  if (result?.usedFallback === true || proposal.usedFallback === true) {
    const reason = result?.reason ?? proposal.fallbackReason;
    return {
      level: "warn",
      message: `The AI could not write the ${noun}${reason ? ` (${reason})` : ""}; the built-in rules proposed ${name} instead. Review its Details before you approve.`
    };
  }
  return { level: "info", message: `${name} is pending in the Growth dialog: open its Details, then Approve or Reject. Approving it supersedes the source${operation === "merge" ? "s" : ""}.` };
}

/** The ids of the ticked Classes in the panel. Exported for tests (fake root). */
export function readSelectedClassIds(root) {
  const nodes = root?.querySelectorAll?.('input[name="gd-merge-class"]:checked') ?? [];
  return [...new Set([...nodes].map((node) => String(node?.value ?? "")).filter(Boolean))];
}

/** The panel's body HTML. Pure, exported for tests. */
export function renderRegistryContent({
  actorName = "", owned = { classes: [], skills: [], titles: [] }, erosion = [], readiness = new Map(),
  canEvolve = false, canMerge = false, busy = false, aiAttached = true, horrorRank = null, events = []
} = {}) {
  const names = ownedNameIndex(owned);
  const byStatus = (list) => [...(Array.isArray(list) ? list : [])].sort((a, b) => (a.status === "superseded") - (b.status === "superseded"));
  const classes = byStatus(owned?.classes);
  const skills = byStatus(owned?.skills);
  const titles = byStatus(owned?.titles);
  const risks = new Map((Array.isArray(erosion) ? erosion : []).filter((risk) => risk?.classId).map((risk) => [risk.classId, risk]));
  const activeClasses = classes.filter((entry) => entry.status !== "superseded");
  const lockTitle = (fallback) => (busy ? BUSY_NOTICE : fallback);
  const aiNote = aiAttached ? "" : " No AI is attached: the built-in rules write it (a stated fallback).";

  const classRows = classes.map((entry) => {
    const superseded = entry.status === "superseded";
    const risk = risks.get(entry.id);
    const pick = superseded || !canMerge ? "" : `<input type="checkbox" name="gd-merge-class" value="${escapeHtml(entry.id)}"${busy ? " disabled" : ""} aria-label="Select ${escapeHtml(entry.name)} to merge"> `;
    const chips = [
      Number.isFinite(Number(entry.level)) && entry.level !== null && entry.level !== undefined ? chip(`Lv ${Number(entry.level)}`) : "",
      entry.power_tier ? chip(entry.power_tier) : "",
      risk ? chip("at risk", "gd-at-risk", describeErosion(risk)) : ""
    ].join("");
    return ownedRow(entry, names, { pick, chips, footer: risk ? `<div class="gd-erosion-note"><i class="fas fa-hourglass-half"></i> ${escapeHtml(describeErosion(risk))}</div>` : "" });
  }).join("");

  const skillRows = skills.map((entry) => {
    const superseded = entry.status === "superseded";
    const ready = readiness?.get?.(entry.id);
    const chips = [
      Number.isFinite(Number(entry.tier)) && entry.tier !== null && entry.tier !== undefined ? chip(`Tier ${Number(entry.tier)}`) : "",
      !superseded && ready?.ready ? chip("ready to evolve", "gd-ready", "Enough practice and a defining moment: the rules' catalyst is met.") : ""
    ].join("");
    let action = "";
    if (!superseded) {
      const title = !canEvolve
        ? "This Grand Design version cannot evolve from the panel yet (needs api.requestSkillEvolution)."
        : `${ready?.ready ? "Ready: " : "Not ready yet (it would only refine, holding its tier). "}Ask for the evolved Skill; it arrives as a pending proposal.${aiNote}`;
      action = actionButton({
        action: EVOLVE,
        icon: "fas fa-dna",
        label: "Evolve",
        entryId: entry.id,
        variant: ready?.ready ? "gd-primary gd-ready-action" : "",
        disabled: busy || !canEvolve,
        title: lockTitle(title)
      });
    }
    const pressure = !superseded && ready?.pressure ? `<span class="gd-hint" title="Evidence weight since approval / threshold">practice ${escapeHtml(ready.pressure)}</span>` : "";
    return ownedRow(entry, names, { chips, action: `${pressure} ${action}`.trim() });
  }).join("");

  const titleRows = titles.map((entry) => ownedRow(entry, names, {
    chips: "",
    footer: entry.achievement && entry.achievement !== entry.effect ? `<div class="gd-owned-deed"><em>Deed:</em> ${escapeHtml(entry.achievement)}</div>` : ""
  })).join("");

  const mergeTitle = !canMerge
    ? "This Grand Design version cannot merge from the panel yet (needs api.requestClassMerge)."
    : activeClasses.length < 2
      ? "Merging needs two or more active Classes."
      : `Tick two or more Classes, then Merge; the merged Class arrives as a pending proposal.${aiNote}`;
  const mergeButton = actionButton({ action: MERGE, icon: "fas fa-code-merge", label: "Merge selected", disabled: busy || !canMerge || activeClasses.length < 2, title: lockTitle(mergeTitle) });
  // Board 21e944ed: a header chip for a glance, the full meter (stage, deeds) below the intro.
  const horrorView = normalizeHorrorRankView(horrorRank, events);
  const horror = horrorView.points > 0 || horrorView.totalLevelsDocked > 0
    ? `<span class="gd-chip gd-red" title="Accrued from the dark deeds recorded in the notes; each stage crossed docks Class levels.">Horror Rank ${escapeHtml(round(horrorView.points))} (Stage ${horrorView.stage})${horrorView.totalLevelsDocked > 0 ? `, ${escapeHtml(horrorView.totalLevelsDocked)} level(s) docked` : ""}</span>`
    : "";
  const section = (title, count, extra, rows, empty) =>
    `<section class="gd-registry-section"><h3>${escapeHtml(title)} (${count})${extra ? ` ${extra}` : ""}</h3>${rows ? `<ul class="gd-owned-list">${rows}</ul>` : `<p class="gd-hint">${escapeHtml(empty)}</p>`}</section>`;
  const soon = COMING_SOON.map((label) => `<button type="button" class="gd-action gd-coming-soon" disabled title="Coming soon: use the api from a macro for now.">${escapeHtml(label)}</button>`).join(" ");

  return `<form class="grand-design-registry${busy ? " gd-busy" : ""}">
    <header class="gd-growth-header">
      <h3>Grand Design registry${actorName ? `: ${escapeHtml(actorName)}` : ""}</h3>
      ${horror}
      ${actionButton({ action: OPEN_GROWTH, icon: "fas fa-seedling", label: "Growth dialog", disabled: busy, title: lockTitle("Pending proposals, session notes and evidence") })}
    </header>
    ${busy ? `<p class="gd-busy-notice"><i class="fas fa-spinner fa-spin"></i> ${escapeHtml(BUSY_NOTICE)}</p>` : ""}
    <p class="gd-hint">Evolve and Merge never change the character directly: each writes a <strong>pending proposal</strong> and opens it in the Growth dialog for you to approve or reject.</p>
    ${renderHorrorRankMeter(horrorRank, { events })}
    ${risks.size ? `<div class="gd-erosion-callout"><h4><i class="fas fa-hourglass-half"></i> Classes at risk of erosion</h4>${renderErosionList([...risks.values()])}</div>` : ""}
    ${section("Classes", classes.length, mergeButton, classRows, "No Classes yet.")}
    ${section("Skills", skills.length, "", skillRows, "No Skills yet.")}
    ${section("Titles", titles.length, "", titleRows, "No Titles yet.")}
    <p class="gd-coming-soon-row"><span class="gd-hint">Coming soon:</span> ${soon}</p>
  </form>`;
}

function ownedRow(entry, names, { pick = "", chips = "", action = "", footer = "" } = {}) {
  const superseded = entry.status === "superseded";
  const red = entry.polarity === "red" ? chip(`red${entry.vice ? `: ${entry.vice}` : ""}`, "gd-red", "Red (taboo) entry: it carries a real cost.") : "";
  const lineage = describeLineage(entry.lineage, names);
  const replacedBy = superseded
    ? chip(`superseded${entry.supersededBy ? ` by ${names.get(entry.supersededBy) ?? prettifyEntryId(entry.supersededBy)}` : ""}`, "gd-superseded-chip", "Kept on the sheet for history; it no longer grows.")
    : "";
  return `<li class="gd-owned gd-owned-${escapeHtml(entry.kind)}${superseded ? " gd-superseded" : ""}" data-entry-id="${escapeHtml(entry.id)}">
      <div class="gd-owned-head">${pick}<strong>${escapeHtml(entry.name)}</strong> ${chips}${red}${replacedBy}${action ? `<span class="gd-owned-actions">${action}</span>` : ""}</div>
      ${lineage ? `<div class="gd-owned-lineage"><i class="fas fa-code-branch"></i> ${escapeHtml(lineage)}</div>` : ""}
      ${entry.effect ? `<div class="gd-owned-effect">${escapeHtml(entry.effect)}</div>` : ""}
      ${footer}
    </li>`;
}

/** "Evolved from Iron Grip" / "Merged from Warden + Innkeeper" / "". Pure, exported for tests. */
export function describeLineage(lineage, names = new Map()) {
  if (!lineage || typeof lineage !== "object") return "";
  const sources = lineageSourceNames(lineage, names);
  if (!sources.length) return "";
  if (lineage.operation === "upgrade") return `Evolved from ${sources.join(", ")}`;
  if (lineage.operation === "combine") return `Merged from ${sources.join(" + ")}`;
  return `From ${sources.join(", ")}`;
}

export function openRegistryPanel(actor, { lastResult = null } = {}) {
  const api = game.modules.get(MODULE_ID).api;
  const canEvolve = typeof api.requestSkillEvolution === "function";
  const canMerge = typeof api.requestClassMerge === "function";
  const apiBusy = () => {
    try {
      return typeof api.isBusy === "function" && api.isBusy(actor) === true;
    } catch {
      return false;
    }
  };
  let content;
  try {
    const owned = collectOwnedEntries(api, actor);
    let erosion = [];
    try {
      erosion = activeErosion(api, actor, owned);
    } catch (error) {
      console.warn(`${MODULE_ID} | checkClassErosion failed`, error);
    }
    let horrorRank = null;
    try {
      horrorRank = typeof api.getHorrorRank === "function" ? api.getHorrorRank(actor) : null;
    } catch {
      horrorRank = null;
    }
    // Only for the deed list when getHorrorRank does not send one (today's API shape).
    let events = [];
    try {
      events = typeof api.getGrowth === "function" ? api.getGrowth(actor)?.events ?? [] : [];
    } catch {
      events = [];
    }
    const aiAttached = (() => {
      try {
        return api.hasProposalAdapter?.() !== false;
      } catch {
        return true;
      }
    })();
    content = renderRegistryContent({
      actorName: actor?.name, owned, erosion, readiness: evolutionReadiness(api, actor, lastResult),
      canEvolve, canMerge, busy: apiBusy(), aiAttached, horrorRank, events
    });
  } catch (error) {
    console.error(`${MODULE_ID} | registry panel render failed`, error);
    content = `<p>Grand Design could not render this character's registry: ${escapeHtml(error?.message ?? error)}</p>`;
  }

  let running = false;
  const close = async () => {
    try {
      await dialog.close();
    } catch {
      // Already closed.
    }
  };
  const busyOptions = { lockable: LOCKABLE, container: ".grand-design-registry" };

  // Same shape as the Growth dialog's runner: one action at a time, a spinner on the clicked button,
  // everything else locked; afterwards the Growth dialog opens on the new proposal, or the panel
  // reopens so its state is fresh.
  const runAction = async (root, button, busyLabel, operation, work) => {
    if (running || button?.disabled) return;
    if (apiBusy()) {
      ui.notifications.warn(BUSY_NOTICE);
      return;
    }
    running = true;
    setBusy(root, button, true, busyLabel, busyOptions);
    let proposalId = null;
    try {
      const result = await work();
      if (result === false) {
        running = false;
        setBusy(root, button, false, busyLabel, busyOptions);
        return;
      }
      const { level, message } = describeAdvancedResult(result, operation);
      ui.notifications[level](message, level === "warn" ? { permanent: true } : undefined);
      proposalId = result?.proposal?.id ?? null;
    } catch (error) {
      const { level, message } = describeActionError(error);
      if (level === "error") console.error(`${MODULE_ID} | ${operation} failed`, error);
      ui.notifications[level](message);
    }
    running = false;
    await close();
    if (proposalId) openGrowthManager(actor, { focusProposalId: proposalId });
    else openRegistryPanel(actor, { lastResult });
  };

  const handlers = {
    [EVOLVE]: (root, button) => runAction(root, button, "The AI is evolving it...", "evolve", async () => {
      const skillId = button?.dataset?.entryId;
      if (!canEvolve || !skillId) return false;
      return api.requestSkillEvolution(actor, skillId);
    }),
    [MERGE]: (root, button) => runAction(root, button, "The AI is merging them...", "merge", async () => {
      if (!canMerge) return false;
      const classIds = readSelectedClassIds(root);
      if (classIds.length < 2) {
        ui.notifications.warn("Tick two or more Classes to merge first.");
        return false;
      }
      return api.requestClassMerge(actor, classIds);
    }),
    [OPEN_GROWTH]: async () => {
      if (running) return;
      await close();
      openGrowthManager(actor);
    }
  };

  const dialog = new Dialog(
    {
      title: `Grand Design Registry: ${actor?.name ?? ""}`,
      content,
      render: (html) => {
        const root = html?.[0] ?? html;
        root?.addEventListener?.("click", (event) => {
          const button = event.target?.closest?.("[data-action]");
          const action = button?.dataset?.action;
          if (!action || !handlers[action]) return;
          event.preventDefault();
          handlers[action](root, button);
        });
      },
      buttons: { close: { icon: '<i class="fas fa-times"></i>', label: "Close" } },
      default: "close"
    },
    { width: 640, height: "auto", resizable: true, classes: ["dialog", "grand-design-registry-dialog"] }
  );
  dialog.render(true);
  return dialog;
}

function chip(text, extra = "", title = "") {
  return `<span class="gd-chip${extra ? ` ${extra}` : ""}"${title ? ` title="${escapeHtml(title)}"` : ""}>${escapeHtml(text)}</span>`;
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
