import { MODULE_ID } from "./constants.js";

export function openGrowthManager(actor) {
  const api = game.modules.get(MODULE_ID).api;
  const growth = api.getGrowth(actor);
  const pending = growth.proposals.filter((proposal) => proposal.status === "pending");
  const content = renderGrowthContent(growth, pending);

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
            ui.notifications.info(`Recorded ${result.events.length} growth event(s) and found ${result.proposals.filter((proposal) => proposal.status === "pending").length} pending proposal(s).`);
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
      close: { icon: '<i class="fas fa-times"></i>', label: "Close" }
    },
    default: "analyze"
  }).render(true);
}

function renderGrowthContent(growth, pending) {
  const eventList = growth.events.length
    ? growth.events.map((event) => `<li><strong>${escapeHtml(event.outcome)}</strong>: ${escapeHtml(event.summary)} <em>(${escapeHtml(event.tags.join(", "))})</em></li>`).join("")
    : "<li>No recorded growth events.</li>";
  const options = pending.length
    ? pending.map((proposal) => `<option value="${escapeHtml(proposal.id)}">${escapeHtml(proposal.entry.name)} — ${escapeHtml(proposal.entry.pf2e_equivalent)}</option>`).join("")
    : '<option value="">No pending proposals</option>';
  const evidence = pending.length
    ? pending.map((proposal) => `<li><strong>${escapeHtml(proposal.entry.name)}</strong>: ${escapeHtml(proposal.entry.mechanics.effect)} <em>Evidence: ${escapeHtml(proposal.evidence.join(", "))}</em></li>`).join("")
    : "<li>No proposal has enough evidence yet.</li>";
  return `<form class="grand-design-growth">
    <div class="form-group stacked"><label>Session Notes</label><textarea name="growth-notes" rows="8" placeholder="Describe what the character accomplished and whether they succeeded."></textarea></div>
    <p>Only successful demonstrated behavior becomes evidence. Approval is always GM-controlled.</p>
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
