import { MODULE_ID } from "./constants.js";

export function openGrowthManager(actor) {
  const api = game.modules.get(MODULE_ID).api;
  const growth = api.getGrowth(actor);
  const progression = api.getLevelProgression(actor);
  const pending = growth.proposals.filter((proposal) => proposal.status === "pending");
  const content = renderGrowthContent(growth, progression, pending);

  new Dialog({
    title: `Grand Design Growth: ${actor.name}`,
    content,
    buttons: {
      analyze: {
        icon: '<i class="fas fa-wand-magic-sparkles"></i>',
        label: "Analyze Notes",
        callback: async (html) => {
          const notes = html.find('textarea[name="growth-notes"]').val();
          try {
            const result = await api.analyzeSessionNotes(actor, notes);
            reportAnalysis(result);
            openGrowthManager(actor);
          } catch (error) {
            console.error(`${MODULE_ID} | note analysis failed`, error);
            ui.notifications.error(error.message);
          }
        }
      },
      approve: {
        icon: '<i class="fas fa-check"></i>',
        label: "Approve Selected",
        callback: async (html) => {
          const proposalId = html.find('select[name="growth-proposal"]').val();
          if (!proposalId) {
            ui.notifications.warn("Choose a pending proposal first.");
            return;
          }
          try {
            await api.approveProposal(actor, proposalId);
            ui.notifications.info("Grand Design proposal approved and added to the Actor.");
            openGrowthManager(actor);
          } catch (error) {
            console.error(`${MODULE_ID} | proposal approval failed`, error);
            ui.notifications.error(error.message);
          }
        }
      },
      rest: {
        icon: '<i class="fas fa-bed"></i>',
        label: "Resolve Rest",
        callback: async (html) => {
          const restType = html.find('select[name="growth-rest-type"]').val();
          try {
            const result = await api.resolveLevelRest(actor, { restType });
            const levels = result.gainedLevels.length ? ` Reached level(s): ${result.gainedLevels.join(", ")}.` : " No level was reached.";
            ui.notifications.info(`Grand Design ${restType} rest resolved.${levels}`);
            openGrowthManager(actor);
          } catch (error) {
            console.error(`${MODULE_ID} | rest resolution failed`, error);
            ui.notifications.error(error.message);
          }
        }
      },
      close: { icon: '<i class="fas fa-times"></i>', label: "Close" }
    },
    default: "analyze"
  }).render(true);
}

/**
 * Turns an analyzeSessionNotes result into notifications a GM can act on.
 *
 * The case that matters most is the quiet one: zero events. That used to produce a cheerful
 * "Recorded 0 growth event(s)" with no indication of whether the notes were unusable, the keyword
 * vocabulary missed everything, or a configured AI provider had silently fallen over. Each of
 * those needs a different response from the GM, so each gets its own message.
 */
function reportAnalysis(result) {
  const pendingCount = result.proposals.filter((proposal) => proposal.status === "pending").length;

  if (result.source === "local-fallback") {
    ui.notifications.error(`AI provider unreachable -- fell back to local keyword analysis. ${result.adapterError}`, { permanent: true });
  }
  if (result.events.length) {
    const how = result.source === "adapter" ? "AI analysis" : "local keyword analysis";
    ui.notifications.info(`Recorded ${result.events.length} growth event(s) via ${how}; ${pendingCount} pending proposal(s).`);
    return;
  }

  // Nothing was recorded -- say why.
  const diagnostics = result.diagnostics;
  if (!diagnostics) {
    ui.notifications.warn("The AI provider read the notes but returned no events. Try describing concrete actions and how they went.");
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

function renderGrowthContent(growth, progression, pending) {
  // Every field below is read defensively. A Class proposal has no system_equivalent, an AI
  // gateway can return a proposal with no evidence array, and a hand-authored entry may carry no
  // mechanics at all -- and this dialog is the GM's only way back to their recorded history, so it
  // must never be the thing that throws. A single malformed proposal degrades to a readable row
  // instead of taking the whole window down.
  const eventList = growth.events.length
    ? growth.events
        .map((event) => `<li><strong>${escapeHtml(event.outcome ?? "unknown")}</strong>: ${escapeHtml(event.summary ?? "")} <em>(${escapeHtml((event.tags ?? []).join(", ") || "untagged")})</em></li>`)
        .join("")
    : "<li>No recorded growth events.</li>";
  const options = pending.length
    ? pending
        .map((proposal) => {
          const label = proposal.entry?.system_equivalent ?? `${proposal.kind ?? "entry"} proposal`;
          return `<option value="${escapeHtml(proposal.id)}">${escapeHtml(proposal.entry?.name ?? proposal.id)} — ${escapeHtml(label)}</option>`;
        })
        .join("")
    : '<option value="">No pending proposals</option>';
  const evidence = pending.length
    ? pending
        .map((proposal) => {
          const effect = proposal.entry?.mechanics?.effect ?? "(no effect text on this proposal)";
          const cited = Array.isArray(proposal.evidence) && proposal.evidence.length ? proposal.evidence.join(", ") : "none cited";
          return `<li><strong>${escapeHtml(proposal.entry?.name ?? proposal.id)}</strong>: ${escapeHtml(effect)} <em>Evidence: ${escapeHtml(cited)}</em></li>`;
        })
        .join("")
    : "<li>No proposal has enough evidence yet.</li>";
  return `<form class="grand-design-growth">
    <h3>Grand Design Level ${progression.level}/100</h3>
    <p><strong>${Math.floor(progression.progress)} progression</strong> toward the next level; <strong>${progression.grantAllowances}</strong> level-up grant allowance(s) available.</p>
    <div class="form-group"><label>Resolve progression at rest</label><select name="growth-rest-type"><option value="short">Short Rest</option><option value="long">Long Rest</option></select></div>
    <p>Generated entries can only be granted after resolving a level-up at rest. Class evolution is reserved for levels 20, 30, and 50.</p>
    <hr>
    <div class="form-group stacked"><label>Session Notes</label><textarea name="growth-notes" rows="8" placeholder="Describe what the character attempted and how it went — success or failure both count."></textarea></div>
    <p>Both successes and genuine failed attempts become evidence — successes count for more, but real effort still counts, even a long string of failures. Approval is always GM-controlled.</p>
    <hr><h3>Pending Proposals</h3><select name="growth-proposal">${options}</select><ul>${evidence}</ul>
    <hr><h3>Recorded Evidence</h3><ul>${eventList}</ul>
  </form>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
