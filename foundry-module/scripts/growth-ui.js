import { MODULE_ID } from "./constants.js";

// The Growth dialog (AI gateway v2, 2026-09-23): "fun and easy". A GM pastes notes written however
// they like -- any language, bullet points, shorthand -- and sees, right in the dialog, how the
// notes were read: one row per event with its summary, the original quote, tags, emergent themes
// (marked "new!" the first time the world sees them), an outcome icon and a danger-gap flame. What
// was skipped and how the gateway got there (attempts, repairs, ms) sits in a collapsed "Under the
// hood" section. Stays on Dialog v1 on purpose -- it works unchanged on Foundry V12 and V13.
//
// Every piece of data rendered here is read defensively: this dialog is the GM's only way back to
// their recorded history, so a malformed event/proposal degrades to a readable row, never a throw.

const OUTCOME_ICONS = {
  criticalSuccess: { icon: "fa-solid fa-star", label: "Critical success" },
  success: { icon: "fa-solid fa-check", label: "Success" },
  failure: { icon: "fa-solid fa-xmark", label: "Failure (still counts as practice)" },
  criticalFailure: { icon: "fa-solid fa-skull", label: "Critical failure (a lesson learned)" }
};

export function openGrowthManager(actor, { lastResult = null, draftNotes = "" } = {}) {
  const api = game.modules.get(MODULE_ID).api;
  let content;
  try {
    const growth = api.getGrowth(actor);
    const progression = api.getLevelProgression(actor);
    const pending = (growth.proposals ?? []).filter((proposal) => proposal?.status === "pending");
    const lastAnalysis = safe(() => api.getLastAnalysis(actor), null);
    const status = statusBadge(safe(() => api.getGatewayConfig(), {}), lastResult ?? lastAnalysis, api.hasProposalAdapter());
    content = renderGrowthContent({ growth, progression, pending, lastAnalysis, lastResult, status, draftNotes });
  } catch (error) {
    console.error(`${MODULE_ID} | growth dialog render failed`, error);
    content = `<p>Grand Design could not render this actor's growth history: ${escapeHtml(error.message)}</p>`;
  }

  // Dialog v1 closes before a callback runs, so whatever is in the notes box is captured first and
  // handed back to the reopened dialog on any error: the GM's typing is never lost.
  const run = (label, work) => async (html) => {
    const typed = String(html?.find?.('textarea[name="growth-notes"]')?.val?.() ?? "");
    try {
      await work(html);
    } catch (error) {
      console.error(`${MODULE_ID} | ${label} failed`, error);
      ui.notifications.error(error.message);
      openGrowthManager(actor, { lastResult, draftNotes: typed });
    }
  };

  new Dialog(
    {
      title: `Grand Design Growth: ${actor.name}`,
      content,
      buttons: {
        analyze: {
          icon: '<i class="fas fa-wand-magic-sparkles"></i>',
          label: "Analyze",
          callback: run("note analysis", async (html) => {
            const notes = html.find('textarea[name="growth-notes"]').val();
            if (!String(notes ?? "").trim()) {
              ui.notifications.warn("Write or paste some session notes first -- any language, bullets, shorthand all work.");
              openGrowthManager(actor, { lastResult });
              return;
            }
            ui.notifications.info("Reading your notes...");
            const result = await api.analyzeSessionNotes(actor, notes);
            reportAnalysis(result);
            openGrowthManager(actor, { lastResult: result });
          })
        },
        reanalyze: {
          icon: '<i class="fas fa-rotate"></i>',
          label: "Re-analyze last notes",
          callback: run("re-analysis", async () => {
            ui.notifications.info("Re-reading the last notes (the previous reading is replaced, not added to)...");
            const result = await api.reanalyzeLastNotes(actor);
            reportAnalysis(result);
            openGrowthManager(actor, { lastResult: result });
          })
        },
        author: {
          icon: '<i class="fas fa-feather-pointed"></i>',
          label: "Author with AI",
          callback: run("proposal authoring", async (html) => {
            const proposalId = html.find('select[name="growth-proposal"]').val();
            if (!proposalId) {
              ui.notifications.warn("Choose a pending proposal first.");
              openGrowthManager(actor, { lastResult, draftNotes: html.find('textarea[name="growth-notes"]').val() });
              return;
            }
            ui.notifications.info("Asking the AI to write this one properly...");
            const { proposal } = await api.requestProposalAuthoring(actor, proposalId);
            ui.notifications.info(`Authored: ${proposal.entry?.name ?? proposalId}. Review it, then Approve.`);
            openGrowthManager(actor, { lastResult });
          })
        },
        approve: {
          icon: '<i class="fas fa-check"></i>',
          label: "Approve",
          callback: run("proposal approval", async (html) => {
            const proposalId = html.find('select[name="growth-proposal"]').val();
            if (!proposalId) {
              ui.notifications.warn("Choose a pending proposal first.");
              openGrowthManager(actor, { lastResult, draftNotes: html.find('textarea[name="growth-notes"]').val() });
              return;
            }
            await api.approveProposal(actor, proposalId);
            ui.notifications.info("Grand Design proposal approved and added to the Actor.");
            openGrowthManager(actor, { lastResult });
          })
        },
        rest: {
          icon: '<i class="fas fa-bed"></i>',
          label: "Resolve Rest",
          callback: run("rest resolution", async (html) => {
            const restType = html.find('select[name="growth-rest-type"]').val();
            const result = await api.resolveLevelRest(actor, { restType });
            const levels = result.gainedLevels.length ? ` Reached level(s): ${result.gainedLevels.join(", ")}.` : " No level was reached.";
            ui.notifications.info(`Grand Design ${restType} rest resolved.${levels}`);
            openGrowthManager(actor, { lastResult });
          })
        },
        close: { icon: '<i class="fas fa-times"></i>', label: "Close" }
      },
      default: "analyze"
    },
    { width: 720, height: "auto", resizable: true, classes: ["dialog", "grand-design-growth-dialog"] }
  ).render(true);
}

/**
 * Turns an analyzeSessionNotes result into notifications a GM can act on. The quiet case --
 * zero events -- always comes with a reason.
 */
export function reportAnalysis(result) {
  const pendingCount = (result?.proposals ?? []).filter((proposal) => proposal?.status === "pending").length;
  if (result?.source === "local-fallback") {
    ui.notifications.error(`AI provider failed -- fell back to local keyword analysis. ${result.adapterError ?? ""}`, { permanent: true });
  }
  const events = result?.events ?? [];
  if (events.length) {
    const how = result.source === "adapter" ? "AI analysis" : "local keyword analysis";
    const newThemes = (result.themes ?? []).filter((theme) => theme.isNew).map((theme) => theme.label);
    const themeNote = newThemes.length ? ` New theme(s): ${newThemes.join(", ")}.` : "";
    ui.notifications.info(`Recorded ${events.length} growth event(s) via ${how}; ${pendingCount} pending proposal(s).${themeNote}`);
    return;
  }
  const diagnostics = result?.diagnostics;
  if (!diagnostics) {
    ui.notifications.warn("The AI read the notes but found nothing a character did. Try naming who did what and how it went.");
    return;
  }
  ui.notifications.warn(
    `No growth events found in ${diagnostics.sentences} sentence(s): `
      + `${diagnostics.droppedNoTag} mentioned nothing in the gameplay vocabulary, `
      + `${diagnostics.droppedNoAction} described an intention rather than something that happened.`
  );
  if (diagnostics.hint) ui.notifications.warn(diagnostics.hint, { permanent: true });
  console.warn(`${MODULE_ID} | dropped sentences`, diagnostics.dropped);
}

/** { kind: "ai"|"fallback"|"local", text, title } -- pure, exported for tests. */
export function statusBadge(config, lastRun, adapterAttached) {
  const provider = config?.provider ?? (adapterAttached ? "an AI provider" : "disabled");
  if (lastRun?.source === "local-fallback") {
    return { kind: "fallback", text: "Local fallback", title: `Last analysis fell back to the keyword analyzer: ${lastRun.adapterError ?? lastRun.diagnostics?.adapterError ?? "the AI provider failed"}` };
  }
  if (provider === "disabled" || !adapterAttached) {
    return { kind: "local", text: "Local", title: "No AI provider attached -- notes are read by the built-in keyword analyzer. Configure one in Grand Design AI Gateway settings." };
  }
  const model = lastRun?.gatewayDiagnostics?.model ?? lastRun?.diagnostics?.model ?? config?.model ?? "AI";
  return { kind: "ai", text: `AI: ${model}`, title: `Notes are read by ${model} via ${provider}.` };
}

export function renderGrowthContent({ growth, progression, pending, lastAnalysis, lastResult, status, draftNotes = "" }) {
  const events = Array.isArray(growth?.events) ? growth.events : [];
  const options = pending.length
    ? pending
        .map((proposal) => {
          const label = proposal.entry?.system_equivalent ?? `${proposal.kind ?? "entry"} proposal`;
          const marker = proposal.needsAuthoring ? " ✎ (placeholder -- Author with AI)" : proposal.source === "emergent" ? " ✦" : "";
          return `<option value="${escapeHtml(proposal.id)}">${escapeHtml(proposal.entry?.name ?? proposal.id)}${escapeHtml(marker)} — ${escapeHtml(label)}</option>`;
        })
        .join("")
    : '<option value="">No pending proposals</option>';
  const evidence = pending.length
    ? pending.map((proposal) => renderProposal(proposal)).join("")
    : "<li>No proposal has enough evidence yet.</li>";
  const eventList = events.length
    ? events.slice(-40).reverse().map((event) => `<li class="gd-event-row">${renderEventLine(event)}</li>`).join("")
    : "<li>No recorded growth events.</li>";
  const hasLast = Boolean(lastAnalysis?.notes);

  return `<form class="grand-design-growth">
    <header class="gd-growth-header">
      <h3>Grand Design Level ${Number(progression?.level) || 0}/100</h3>
      <span class="gd-status gd-status-${escapeHtml(status.kind)}" title="${escapeHtml(status.title)}"><i class="fas ${status.kind === "ai" ? "fa-brain" : status.kind === "fallback" ? "fa-triangle-exclamation" : "fa-book"}"></i> ${escapeHtml(status.text)}</span>
    </header>
    <p><strong>${Math.floor(Number(progression?.progress) || 0)} progression</strong> toward the next level; <strong>${Number(progression?.grantAllowances) || 0}</strong> level-up grant allowance(s) available.</p>
    <div class="form-group"><label>Resolve progression at rest</label><select name="growth-rest-type"><option value="short">Short Rest</option><option value="long">Long Rest</option></select></div>
    <hr>
    <div class="form-group stacked"><label>Session Notes</label><textarea name="growth-notes" rows="8" placeholder="Write however you like — any language, bullet points, shorthand, typos are fine.&#10;- Kesh parried the captain, nat 20!&#10;- Mira kept the bees calm and harvested honey&#10;- Torv tried to pick the lock, it broke">${escapeHtml(draftNotes ?? "")}</textarea></div>
    <p class="gd-hint">Successes and honest failed attempts both count. Things the tag list doesn't cover (beekeeping, gambling, map-making...) become <em>themes</em> and can grow into brand-new Skills. Approval is always yours.${hasLast ? ` Last notes analyzed ${escapeHtml(formatWhen(lastAnalysis.at))} — use <strong>Re-analyze</strong> to read them again.` : ""}</p>
    ${renderInterpretation(events, lastAnalysis, lastResult)}
    <hr><h3>Pending Proposals</h3><select name="growth-proposal">${options}</select><ul class="gd-proposals">${evidence}</ul>
    <hr><details class="gd-history"><summary>Recorded Evidence (${events.length})</summary><ul>${eventList}</ul></details>
  </form>`;
}

function renderInterpretation(events, lastAnalysis, lastResult) {
  const ids = new Set(Array.isArray(lastAnalysis?.eventIds) ? lastAnalysis.eventIds : []);
  const interpreted = lastResult?.events?.length ? lastResult.events : events.filter((event) => ids.has(event?.id));
  if (!interpreted.length && !lastResult && !lastAnalysis) return "";
  const newThemes = new Set((lastResult?.themes ?? []).filter((theme) => theme?.isNew).map((theme) => theme.slug));
  const rows = interpreted.length
    ? interpreted.map((event) => `<li class="gd-event-row">${renderEventLine(event, newThemes, true)}</li>`).join("")
    : "<li><em>Nothing a character did was found in the last notes.</em></li>";
  return `<hr><h3>How your last notes were read</h3><ul class="gd-interpretation">${rows}</ul>${renderUnderTheHood(lastAnalysis, lastResult)}`;
}

export function renderEventLine(event, newThemes = new Set(), withQuote = false) {
  const outcome = OUTCOME_ICONS[event?.outcome] ?? { icon: "fa-solid fa-circle-question", label: String(event?.outcome ?? "unknown") };
  const flames = event?.dangerGap === "severe" ? 2 : event?.dangerGap === "moderate" ? 1 : 0;
  const flameHtml = flames
    ? `<span class="gd-danger" title="Danger gap: ${escapeHtml(event.dangerGap)} (counter-leveling bonus)">${'<i class="fa-solid fa-fire"></i>'.repeat(flames)}</span>`
    : "";
  const tags = (Array.isArray(event?.tags) ? event.tags : []).map((tag) => `<span class="gd-chip gd-tag">${escapeHtml(tag)}</span>`).join("");
  const themes = (Array.isArray(event?.themes) ? event.themes : [])
    .map((theme) => `<span class="gd-chip gd-theme" title="Emergent theme">${escapeHtml(theme)}${newThemes.has(theme) ? ' <b class="gd-new">new!</b>' : ""}</span>`)
    .join("");
  const who = event?.actorName ? `<span class="gd-who">${escapeHtml(event.actorName)}:</span> ` : "";
  const quote = withQuote && typeof event?.quote === "string" && event.quote.trim() && event.quote.trim() !== String(event.summary ?? "").trim()
    ? `<details class="gd-quote"><summary>original${event.language ? ` (${escapeHtml(event.language)})` : ""}</summary><blockquote>${escapeHtml(event.quote)}</blockquote></details>`
    : "";
  return `<span class="gd-outcome gd-outcome-${escapeHtml(event?.outcome ?? "unknown")}" title="${escapeHtml(outcome.label)}"><i class="${outcome.icon}"></i></span>${flameHtml}
    ${who}<span class="gd-summary">${escapeHtml(event?.summary ?? "")}</span>
    <span class="gd-chips">${tags}${themes || (!tags ? '<span class="gd-chip">untagged</span>' : "")}</span>${quote}`;
}

function renderProposal(proposal) {
  const effect = proposal.entry?.mechanics?.effect ?? "(no effect text on this proposal)";
  const cited = Array.isArray(proposal.evidence) && proposal.evidence.length ? `${proposal.evidence.length} event(s)` : "none cited";
  const badge = proposal.source === "emergent"
    ? `<span class="gd-chip gd-theme">theme: ${escapeHtml(proposal.theme ?? "?")}</span>`
    : proposal.source === "ai-gateway"
      ? '<span class="gd-chip gd-ai">AI</span>'
      : proposal.isCapstone
        ? '<span class="gd-chip gd-capstone">capstone</span>'
        : '<span class="gd-chip">template</span>';
  const authoring = proposal.needsAuthoring ? ' <em class="gd-needs-authoring">placeholder — "Author with AI" writes real mechanics</em>' : "";
  return `<li><strong>${escapeHtml(proposal.entry?.name ?? proposal.id)}</strong> ${badge}${authoring}<br>${escapeHtml(effect)} <em>Evidence: ${escapeHtml(cited)}</em></li>`;
}

export function renderUnderTheHood(lastAnalysis, lastResult) {
  const summary = lastAnalysis?.diagnostics ?? {};
  const gateway = lastResult?.gatewayDiagnostics ?? null;
  const rows = [];
  const push = (label, value) => {
    if (value !== undefined && value !== null && value !== "") rows.push(`<li><strong>${escapeHtml(label)}:</strong> ${escapeHtml(String(value))}</li>`);
  };
  push("Read by", lastResult?.source ?? summary.source);
  push("Model", gateway?.model ?? summary.model);
  push("Provider", gateway?.provider ?? summary.provider);
  push("Pipeline", gateway?.pipeline ?? summary.pipeline);
  push("Chunks", gateway?.chunks ?? summary.chunks);
  const stages = Array.isArray(gateway?.stages) ? gateway.stages : [];
  push("Attempts", stages.length ? stages.reduce((sum, stage) => sum + (Number(stage?.attempts) || 0), 0) : summary.attempts);
  push("Repairs", stages.length ? stages.reduce((sum, stage) => sum + (Array.isArray(stage?.repairs) ? stage.repairs.length : 0), 0) : summary.repairs);
  push("Total time (ms)", gateway?.totalMs ?? summary.totalMs);
  push("Fallback reason", lastResult?.adapterError ?? summary.adapterError);
  push("Hint", lastResult?.diagnostics?.hint ?? summary.hint);
  const stageRows = stages
    .map((stage) => `<li>${escapeHtml(stage?.stage ?? "stage")}${stage?.chunk !== undefined ? ` #${escapeHtml(stage.chunk)}` : ""}: ${escapeHtml(stage?.attempts ?? "?")} attempt(s), ${escapeHtml(stage?.ms ?? "?")} ms${Array.isArray(stage?.repairs) && stage.repairs.length ? `, repairs: ${escapeHtml(stage.repairs.join(", "))}` : ""}${Array.isArray(stage?.errors) && stage.errors.length ? `, errors: ${escapeHtml(stage.errors.slice(0, 3).join("; "))}` : ""}</li>`)
    .join("");
  const skippedEvents = (lastResult?.adapterSkippedEvents ?? []).map((entry) => `<li>${escapeHtml(entry?.event?.summary ?? entry?.summary ?? entry?.raw?.summary ?? JSON.stringify(entry?.event ?? entry).slice(0, 160))} — ${escapeHtml((entry?.errors ?? [entry?.reason]).filter(Boolean).join(" "))}</li>`).join("");
  const skippedProposals = (lastResult?.adapterSkippedProposals ?? []).map((entry) => `<li>${escapeHtml(entry?.proposal?.entry?.name ?? entry?.proposal?.kind ?? "proposal")} — ${escapeHtml((entry?.errors ?? [entry?.reason]).filter(Boolean).join(" "))}</li>`).join("");
  const rejectedTags = (lastResult?.adapterRejectedTags ?? []).map((entry) => `<li>${escapeHtml((entry?.rejected ?? []).join(", "))}${entry?.movedToThemes?.length ? ` → themes: ${escapeHtml(entry.movedToThemes.join(", "))}` : ""}${entry?.remapped ? ` → ${escapeHtml(Object.entries(entry.remapped).map(([from, to]) => `${from}=${to}`).join(", "))}` : ""}</li>`).join("");
  const dropped = (lastResult?.diagnostics?.dropped ?? []).map((entry) => `<li>${escapeHtml(entry?.sentence ?? "")} — ${escapeHtml(entry?.reason ?? "")}</li>`).join("");
  if (!rows.length && !stageRows && !skippedEvents && !skippedProposals && !rejectedTags && !dropped) return "";
  return `<details class="gd-under-the-hood"><summary><i class="fas fa-gears"></i> Under the hood</summary>
    <ul>${rows.join("")}</ul>
    ${stageRows ? `<h4>Stages</h4><ul>${stageRows}</ul>` : ""}
    ${skippedEvents ? `<h4>Skipped events</h4><ul>${skippedEvents}</ul>` : ""}
    ${skippedProposals ? `<h4>Skipped proposals</h4><ul>${skippedProposals}</ul>` : ""}
    ${rejectedTags ? `<h4>Non-canonical tags</h4><ul>${rejectedTags}</ul>` : ""}
    ${dropped ? `<h4>Sentences the local analyzer skipped</h4><ul>${dropped}</ul>` : ""}
  </details>`;
}

function formatWhen(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "earlier" : date.toLocaleString();
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
