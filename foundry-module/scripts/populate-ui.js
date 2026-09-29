// GM-facing UI for the "Populate" natural-language spawner (scripts/populate.js + api.js#populate).
// Follows the same classic `Dialog` pattern already proven by openImporter/openGrowthManager in
// main.js -- a plain textarea prompt box, a "Spawn" button that calls the API, and a chat-message
// summary (with clickable @UUID links to the newly created documents) so the GM has a durable
// record of what got created and can jump straight to it.

import { MODULE_ID } from "./constants.js";

export function openPopulate() {
  new Dialog({
    title: "Populate — Spawn from Natural Language",
    content: `<form class="grand-design-populate">
      <div class="form-group stacked">
        <label>Describe what to spawn</label>
        <textarea name="prompt" rows="4" placeholder="e.g. &quot;a grizzled dwarven blacksmith who deals in stolen goods, level 3&quot;, &quot;a pack of 3 goblin scouts&quot;, &quot;a +1 flaming shortsword&quot;"></textarea>
      </div>
      <p class="notes" style="opacity:0.75;font-size:0.9em;">
        Creates real Actors/Items in this world, fully GM-editable afterward, with numbers for this
        game system (PF2e by creature level, dnd5e by CR). Written by your AI Gateway when one is
        configured (Settings &rarr; Grand Design AI); without one, or if the AI fails, the built-in
        local generator is used and the chat card says why.
      </p>
    </form>`,
    buttons: {
      spawn: {
        icon: '<i class="fa-solid fa-wand-magic-sparkles"></i>',
        label: "Spawn",
        callback: async (html) => {
          const prompt = html.find('textarea[name="prompt"]').val()?.trim();
          if (!prompt) {
            ui.notifications.warn("Enter a description of what to spawn first.");
            return;
          }
          await runPopulateAndAnnounce(prompt);
        }
      },
      cancel: {
        icon: '<i class="fas fa-times"></i>',
        label: "Cancel"
      }
    },
    default: "spawn"
  }).render(true);
}

/**
 * Runs a Populate prompt through the API and posts the result -- used by both the Dialog above
 * and the `/populate <prompt>` chat-command fallback in main.js, so both entry points behave
 * identically.
 */
export async function runPopulateAndAnnounce(prompt) {
  const api = game.modules.get(MODULE_ID).api;
  try {
    // A local model can take a minute; the dialog has already closed, so say something is happening.
    if (api.hasPopulateAdapter?.()) ui.notifications.info("Populate: the AI Gateway is writing this -- it can take a minute on a local model.");
    const result = await api.populate(prompt);
    const { kind, created } = result;
    const names = created.map((doc) => doc.name).join(", ");
    ui.notifications.info(`Populate spawned ${created.length} ${kindLabel(kind, created.length)}: ${names}.`);
    // Board dee25a95: an AI failure must never be silent -- the GM is told the spawn came from the
    // local generator and why.
    const note = populateSourceNote(result);
    if (result.fallbackReason) ui.notifications.warn(note);
    await ChatMessage.create({
      speaker: { alias: "Grand Design AI — Populate" },
      content: renderSpawnChatContent(kind, created, prompt, note)
    });
    return result;
  } catch (error) {
    console.error(`${MODULE_ID} | Populate failed`, error);
    ui.notifications.error(error.message);
    return null;
  }
}

function kindLabel(kind, count) {
  const plural = count === 1 ? "" : "s";
  if (kind === "item") return `item${plural}`;
  if (kind === "monster") return `monster${plural}`;
  return `NPC${plural}`;
}

/** One line saying who wrote the spawn: the AI, or the local generator and why. Pure (tested). */
export function populateSourceNote({ source, fallbackReason, aiAvailable } = {}) {
  if (source === "ai") return "Written by the AI Gateway; numbers checked against this system's ranges.";
  if (fallbackReason) return `Populate used the built-in local generator because ${fallbackReason}.`;
  if (aiAvailable === false) return "No AI Gateway is configured: written by the built-in local generator.";
  return "Written by the built-in local generator.";
}

export function renderSpawnChatContent(kind, created, prompt, note = "") {
  const links = created.map((doc) => `<li>@UUID[${doc.uuid}]{${escapeHtml(doc.name)}}</li>`).join("");
  return `<div class="grand-design-populate-result">`
    + `<p><strong>Populate</strong> spawned ${created.length} ${escapeHtml(kindLabel(kind, created.length))} from: <em>"${escapeHtml(prompt)}"</em></p>`
    + `<ul>${links}</ul>`
    + (note ? `<p class="notes"><em>${escapeHtml(note)}</em></p>` : "")
    + `</div>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
