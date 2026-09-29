import { HORROR_RANK_THRESHOLD, MODULE_ID } from "./constants.js";
import { BUILD, describeBuild } from "./build-info.js";
// Cyclic on purpose (the panel reopens this dialog on its new proposal): both sides only touch the
// other's exports inside functions, never at module evaluation, so either can load first.
import { openRegistryPanel, ownedNameIndex, collectOwnedEntries, renderErosionList, activeErosion, describeAdvancedResult } from "./registry-ui.js";

// The Growth dialog (AI gateway v2, 2026-09-23): "fun and easy". A GM pastes notes written however
// they like -- any language, bullet points, shorthand -- and sees, right in the dialog, how the
// notes were read: one row per event with its summary, the original quote, tags, emergent themes
// (marked "new!" the first time the world sees them), an outcome icon and a danger-gap flame. What
// was skipped and how the gateway got there (attempts, repairs, ms) sits in a collapsed "Under the
// hood" section. Stays on Dialog v1 on purpose -- it works unchanged on Foundry V12 and V13.
//
// Every piece of data rendered here is read defensively: this dialog is the GM's only way back to
// their recorded history, so a malformed event/proposal degrades to a readable row, never a throw.
//
// Board 78ead05c / a0bcfd05 (2026-09-29): every action lives in the dialog BODY, not the v1 footer.
// A footer button closes the dialog before its callback runs, so a 30 s+ analysis showed nothing at
// all and a double click could start a second one. In the body the clicked button shows a spinner,
// every other action is disabled until it finishes, and the dialog is reopened afterwards so the new
// state renders. Proposals are one row each with their own Approve / Author / Retry / Edit / Reject.

const OUTCOME_ICONS = {
  criticalSuccess: { icon: "fa-solid fa-star", label: "Critical success" },
  success: { icon: "fa-solid fa-check", label: "Success" },
  failure: { icon: "fa-solid fa-xmark", label: "Failure (still counts as practice)" },
  criticalFailure: { icon: "fa-solid fa-skull", label: "Critical failure (a lesson learned)" }
};

// Every in-body action: the data-action value, the label while it runs, and the icon at rest.
const ACTIONS = Object.freeze({
  analyze: { action: "gd-analyze", busy: "Reading your notes... (can take a minute with a local model)" },
  reanalyze: { action: "gd-reanalyze", busy: "Re-reading the last notes..." },
  rest: { action: "gd-rest", busy: "Resolving the rest..." },
  approve: { action: "gd-approve-proposal", busy: "Approving..." },
  approveAsWritten: { action: "gd-approve-as-written", busy: "Approving..." },
  author: { action: "gd-author-proposal", busy: "The AI is writing it..." },
  retry: { action: "gd-retry-milestone", busy: "Asking the AI again..." },
  reject: { action: "gd-reject-proposal", busy: "Rejecting..." },
  save: { action: "gd-save-proposal", busy: "Saving..." },
  suggest: { action: "gd-suggest-proposals", busy: "Asking the AI for proposals... (about 10 s)" },
  // Board 752369f6: a Skill the last analysis found ready to evolve can be evolved from here too.
  evolve: { action: "gd-evolve-skill", busy: "The AI is evolving it..." }
});
// Not a long action (it only opens the panel), so it is not locked with the others.
const OPEN_REGISTRY = "gd-open-registry";
const LOCKABLE = Object.values(ACTIONS).map(({ action }) => `[data-action="${action}"]`).join(", ");

export function openGrowthManager(actor, { lastResult = null, draftNotes = "", focusProposalId = null, lastSuggest = null } = {}) {
  const api = game.modules.get(MODULE_ID).api;
  let content;
  let aiAttached = true;
  // Feature-detected: dev-integration adds these API calls in parallel; an older API must still open
  // the dialog (without the control) rather than offer an action that cannot run.
  const canSuggest = typeof api.requestGrowthProposals === "function";
  const canEdit = typeof api.updateProposal === "function";
  const canRetry = typeof api.retryMilestoneReward === "function";
  const canEvolve = typeof api.requestSkillEvolution === "function";
  const apiBusy = () => typeof api.isBusy === "function" && safe(() => api.isBusy(actor), false) === true;
  const busyAtOpen = apiBusy();
  try {
    aiAttached = safe(() => api.hasProposalAdapter(), true) !== false;
    const growth = api.getGrowth(actor);
    const progression = api.getLevelProgression(actor);
    const pending = (growth.proposals ?? []).filter((proposal) => proposal?.status === "pending");
    const lastAnalysis = safe(() => api.getLastAnalysis(actor), null);
    const status = statusBadge(safe(() => api.getGatewayConfig(), {}), lastResult ?? lastAnalysis, aiAttached);
    // Lineage by NAME (board 752369f6): an evolved/merged proposal cites its sources by id.
    const namesById = safe(() => ownedNameIndex(collectOwnedEntries(api, actor)), new Map());
    // Board 0860fd78: erosion is shown right after an analysis, when the GM is looking at what changed.
    const erosion = lastResult ? safe(() => activeErosion(api, actor), []) : [];
    // Board 21e944ed: the meter reads getHorrorRank (the new shape is feature-detected by the renderer).
    const horrorRank = typeof api.getHorrorRank === "function" ? safe(() => api.getHorrorRank(actor), null) : null;
    content = renderGrowthContent({
      growth, progression, pending, lastAnalysis, lastResult, status, draftNotes, canSuggest, canEdit, canRetry, aiAttached,
      busy: busyAtOpen, namesById, focusProposalId, lastSuggest, erosion, canEvolve, horrorRank, systemId: currentSystemId()
    });
  } catch (error) {
    console.error(`${MODULE_ID} | growth dialog render failed`, error);
    content = `<p>Grand Design could not render this actor's growth history: ${escapeHtml(error.message)}</p>`;
  }

  let running = false;
  let pollTimer = null;
  const typedNotes = (root) => String(root?.querySelector?.('textarea[name="growth-notes"]')?.value ?? "");
  const reopen = async (options) => {
    if (pollTimer) clearInterval(pollTimer);
    await safe(() => dialog.close(), null);
    openGrowthManager(actor, options);
  };

  /**
   * One long action, run in place. `work` returns what to reopen with ({ lastResult, draftNotes })
   * or `false` to leave the dialog as it is (nothing changed, e.g. empty notes). Whatever happens,
   * the notes the GM typed survive: on an error the reopened dialog gets them back.
   */
  const runAction = async (root, button, key, work) => {
    if (running || button?.disabled) return;
    if (apiBusy()) {
      ui.notifications.warn(BUSY_NOTICE);
      return;
    }
    const typed = typedNotes(root);
    running = true;
    setBusy(root, button, true, ACTIONS[key]?.busy);
    let next = { lastResult, draftNotes: typed };
    try {
      const outcome = await work(typed);
      if (outcome === false) {
        running = false;
        setBusy(root, button, false);
        return;
      }
      next = { lastResult, draftNotes: typed, ...(outcome ?? {}) };
    } catch (error) {
      const { level, message } = describeActionError(error);
      // A busy lock is expected traffic, not a failure worth a red console entry.
      if (level === "error") console.error(`${MODULE_ID} | ${key} failed`, error);
      ui.notifications[level](message);
    }
    running = false;
    await reopen(next);
  };

  const find = (id) => safe(() => (api.getGrowth(actor).proposals ?? []).find((proposal) => proposal?.id === id), null);
  const handlers = {
    [ACTIONS.analyze.action]: (root, button) => runAction(root, button, "analyze", async (notes) => {
      if (!notes.trim()) {
        ui.notifications.warn("Write or paste some session notes first -- any language, bullets, shorthand all work.");
        return false;
      }
      const result = await api.analyzeSessionNotes(actor, notes);
      reportAnalysis(result);
      // The notes are now recorded: the box starts empty again.
      return { lastResult: result, draftNotes: "" };
    }),
    [ACTIONS.reanalyze.action]: (root, button) => runAction(root, button, "reanalyze", async () => {
      const result = await api.reanalyzeLastNotes(actor);
      reportAnalysis(result);
      return { lastResult: result };
    }),
    [ACTIONS.rest.action]: (root, button) => runAction(root, button, "rest", async () => {
      const restType = root?.querySelector?.('select[name="growth-rest-type"]')?.value || "long";
      reportRest(await api.resolveLevelRest(actor, { restType }), restType);
    }),
    [ACTIONS.approve.action]: (root, button, id) => runAction(root, button, "approve", async () => {
      await api.approveProposal(actor, id);
      ui.notifications.info(`Approved: ${find(id)?.entry?.name ?? "the proposal"} was added to ${actor.name}.`);
    }),
    [ACTIONS.approveAsWritten.action]: async (root, button, id) => {
      const name = find(id)?.entry?.name ?? id;
      if (!(await confirmApproveAsWritten(name))) return;
      return runAction(root, button, "approveAsWritten", async () => {
        await api.approveProposal(actor, id, { confirm: true });
        ui.notifications.info(`Approved as written: ${name} was added to ${actor.name}.`);
      });
    },
    [ACTIONS.author.action]: (root, button, id) => runAction(root, button, "author", async () => {
      const { proposal } = await api.requestProposalAuthoring(actor, id);
      ui.notifications.info(`Authored: ${proposal?.entry?.name ?? id}. Open its Details, then Approve.`);
    }),
    [ACTIONS.retry.action]: (root, button, id) => runAction(root, button, "retry", async () => {
      const { level, message } = describeRetryResult(await api.retryMilestoneReward(actor, id));
      ui.notifications[level](message);
    }),
    [ACTIONS.reject.action]: (root, button, id) => runAction(root, button, "reject", async () => {
      const red = isRedProposal(find(id));
      await api.rejectProposal(actor, id);
      // Owner decision 2026-09-29: rejecting a red Skill refuses the power, not the stain.
      ui.notifications.info(red
        ? "Red proposal rejected: the power is refused, but the deeds stay recorded and still count toward Horror Rank."
        : "Grand Design proposal rejected. It will not be suggested again under this name.");
    }),
    [ACTIONS.save.action]: (root, button, id) => saveEdit(root, button, id),
    [ACTIONS.suggest.action]: (root, button) => runAction(root, button, "suggest", async () => {
      if (!canSuggest) {
        ui.notifications.warn("This version of Grand Design cannot suggest proposals on demand.");
        return false;
      }
      const result = await api.requestGrowthProposals(actor);
      const { level, message } = describeSuggestResult(result);
      ui.notifications[level](message);
      // Kept for the reopened dialog: a toast fades, the reasons under the button do not.
      return { lastSuggest: { skipped: result?.skipped ?? [], capReached: result?.capReached ?? null } };
    }),
    [ACTIONS.evolve.action]: (root, button) => runAction(root, button, "evolve", async () => {
      const skillId = button?.dataset?.entryId;
      if (!canEvolve || !skillId) return false;
      const result = await api.requestSkillEvolution(actor, skillId);
      const { level, message } = describeAdvancedResult(result, "evolve");
      ui.notifications[level](message, level === "warn" ? { permanent: true } : undefined);
      return { focusProposalId: result?.proposal?.id ?? null };
    }),
    [OPEN_REGISTRY]: () => {
      if (!running) openRegistryPanel(actor);
    }
  };

  // The edit form is validated by the API (validator.js) and its errors are shown IN the form, which
  // stays open with the GM's edits, instead of a toast and a reopen that would throw the edits away.
  const saveEdit = async (root, button, id) => {
    if (running || !canEdit) return;
    const form = button?.closest?.(".gd-edit-form");
    const errorBox = form?.querySelector?.(".gd-edit-errors");
    const proposal = find(id);
    if (!proposal) return;
    const { patch, errors } = buildProposalPatch(proposal, readEditFields(form));
    if (errors.length) {
      if (errorBox) errorBox.innerHTML = renderEditErrors(errors);
      return;
    }
    running = true;
    setBusy(root, button, true, ACTIONS.save.busy);
    let result;
    try {
      result = await api.updateProposal(actor, id, patch);
    } catch (error) {
      result = { ok: false, errors: [describeActionError(error).message] };
    }
    running = false;
    if (result?.ok === false) {
      setBusy(root, button, false);
      if (errorBox) errorBox.innerHTML = renderEditErrors(result.errors?.length ? result.errors : ["The proposal was not saved."]);
      return;
    }
    ui.notifications.info(`Saved your edits to ${result?.proposal?.entry?.name ?? patch.entry?.name ?? "the proposal"}. It is still pending: Approve when ready.`);
    // The validator may have clamped dice or bonuses to the tier: say so instead of changing them silently.
    const clamps = collectMechanicsClamps(result);
    if (clamps.length) ui.notifications.warn(`The validator adjusted the mechanics: ${clamps.slice(0, 4).join("; ")}${clamps.length > 4 ? "; ..." : ""}.`, { permanent: true });
    await reopen({ lastResult, draftNotes: typedNotes(root) });
  };

  const dialog = new Dialog(
    {
      title: `Grand Design Growth: ${actor.name}`,
      content,
      render: (html) => {
        // Dialog v1 hands over jQuery on V12/V13; accept a bare element too.
        const root = html?.[0] ?? html;
        // Suggest keeps a direct listener (it predates the delegated one and its tests click it).
        root?.querySelectorAll?.(`[data-action="${ACTIONS.suggest.action}"]`).forEach((button) => {
          button.addEventListener("click", (event) => {
            event.preventDefault();
            handlers[ACTIONS.suggest.action](root, button);
          });
        });
        // Delegated (one listener on the root): there is a row of buttons per pending proposal.
        root?.addEventListener?.("click", (event) => {
          const button = event.target?.closest?.("[data-action]");
          const action = button?.dataset?.action;
          if (!action || action === ACTIONS.suggest.action || !handlers[action]) return;
          event.preventDefault();
          handlers[action](root, button, button.dataset?.proposalId);
        });
        // The panel's Evolve/Merge lands here on the new proposal: bring its row into view.
        if (focusProposalId) safe(() => root?.querySelector?.(".gd-proposal.gd-focus")?.scrollIntoView?.({ block: "center" }), null);
        // Something else (another dialog, another GM, a macro) is working on this actor: the
        // buttons render disabled; reopen as soon as it is done so the fresh state shows.
        if (busyAtOpen) {
          const started = Date.now();
          pollTimer = setInterval(() => {
            if (root?.isConnected === false || Date.now() - started > 15 * 60 * 1000) return clearInterval(pollTimer);
            if (!apiBusy()) reopen({ lastResult, draftNotes: typedNotes(root) });
            return undefined;
          }, 1500);
        }
      },
      close: () => { if (pollTimer) clearInterval(pollTimer); },
      buttons: {
        close: { icon: '<i class="fas fa-times"></i>', label: "Close" }
      },
      default: "close"
    },
    { width: 760, height: "auto", resizable: true, classes: ["dialog", "grand-design-growth-dialog"] }
  );
  dialog.render(true);
}

export const NO_PROVIDER_TITLE = "Needs an AI provider. Set one in Grand Design AI Gateway settings (Game Settings > Configure Settings).";
export const BUSY_NOTICE = "Grand Design is still working on this character (an analysis, rest or AI call is running). Wait for it to finish, then try again.";
const SUGGEST_LABEL = "Suggest proposals";

// Busy state for any in-body action. Every action button (and any footer button) is disabled so the
// GM cannot approve or re-analyze against a proposal list that is about to change. Exported for the
// registry panel, which passes its own lockable buttons and body class.
export function setBusy(root, clicked, busy, busyLabel = "Working...", { lockable = LOCKABLE, container = ".grand-design-growth" } = {}) {
  const scope = root?.closest?.(".app, .application, .window-app") ?? root;
  scope?.querySelectorAll?.(`${lockable}, .dialog-buttons button, .dialog-button`).forEach((button) => {
    if (busy) {
      button.dataset && (button.dataset.gdWasDisabled = button.disabled ? "1" : "");
      button.disabled = true;
    } else {
      // Buttons rendered disabled on purpose (no AI provider) stay disabled.
      button.disabled = button.dataset?.gdWasDisabled === "1";
    }
  });
  root?.querySelector?.(container)?.classList.toggle("gd-busy", busy);
  if (!clicked) return;
  clicked.setAttribute("aria-busy", busy ? "true" : "false");
  const label = clicked.querySelector(".gd-btn-label") ?? clicked.querySelector(".gd-suggest-label");
  const icon = clicked.querySelector("i");
  if (label) {
    if (busy) label.dataset && (label.dataset.gdRestLabel = label.textContent);
    label.textContent = busy ? busyLabel : label.dataset?.gdRestLabel || label.textContent;
  }
  if (icon) {
    if (busy) icon.dataset && (icon.dataset.gdRestIcon = icon.className);
    icon.className = busy ? "fas fa-spinner fa-spin" : icon.dataset?.gdRestIcon || icon.className;
  }
}

async function confirmApproveAsWritten(name) {
  const title = "Approve a placeholder as written?";
  const content = `<p><strong>${escapeHtml(name)}</strong> is a generic placeholder, not a Skill the AI wrote from this character's deeds.</p><p>"Author with AI" writes real mechanics first. Approve it exactly as written anyway (it spends a grant allowance)?</p>`;
  try {
    const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
    if (typeof DialogV2?.confirm === "function") return (await DialogV2.confirm({ window: { title }, content, rejectClose: false })) === true;
    if (typeof Dialog?.confirm === "function") return (await Dialog.confirm({ title, content, yes: () => true, no: () => false, defaultYes: false })) === true;
  } catch (error) {
    console.warn(`${MODULE_ID} | approve-as-written confirmation failed`, error);
  }
  return false;
}

/**
 * { level, message } for an error thrown by a Growth-dialog action -- pure, exported for tests. The
 * API's per-actor lock throws an Error whose message starts "busy:"; that is not a failure, so it is
 * a friendly warning rather than a red error toast.
 */
export function describeActionError(error) {
  const raw = String(error?.message ?? error ?? "").trim();
  if (/^busy:/i.test(raw)) {
    const detail = raw.replace(/^busy:\s*/i, "").trim();
    return { level: "warn", message: detail ? `Grand Design is still working on this character: ${detail} Try again when it finishes.` : BUSY_NOTICE };
  }
  return { level: "error", message: raw || "Grand Design could not complete that action." };
}

/**
 * { level, message } for a retryMilestoneReward result. The API returns the proposal plus whether
 * the template had to stand in again; accept a bare proposal too, since the shape is being settled
 * in parallel (dev-integration).
 */
export function describeRetryResult(result) {
  const proposal = result?.proposal ?? (result?.entry ? result : null);
  const name = proposal?.entry?.name ?? "the milestone reward";
  const fellBack = result?.usedFallback === true || proposal?.usedFallback === true;
  if (fellBack) {
    const reason = result?.reason ?? proposal?.fallbackReason;
    return { level: "warn", message: `The AI still could not write ${name}${reason ? ` (${reason})` : ""}; the template stays. Edit it, or retry later.` };
  }
  return { level: "info", message: `The AI rewrote ${name}. Open its Details, then Approve.` };
}
/**
 * { level: "info"|"warn", message } for a requestGrowthProposals result -- pure, exported for tests.
 * `added` is accepted as a count or as the list of added proposals, so the notification stays right
 * whichever shape the API settles on.
 */
export function describeSuggestResult(result) {
  const added = Array.isArray(result?.added) ? result.added.length : Math.max(0, Math.floor(Number(result?.added) || 0));
  const cap = describeCapReached(result?.capReached);
  const reasons = [...new Set((Array.isArray(result?.skipped) ? result.skipped : []).map(describeSkippedProposal).filter(Boolean))];
  const why = reasons.length ? ` Skipped: ${reasons.slice(0, 3).join("; ")}${reasons.length > 3 ? `; and ${reasons.length - 3} more` : ""}.` : "";
  if (added > 0) {
    return { level: "info", message: `${added} new proposal${added === 1 ? "" : "s"} -- pick one and Approve to spend a grant allowance.${why}` };
  }
  // Board 43ff2ae9: "nothing new" says why whenever the API told us.
  if (cap) return { level: "warn", message: `${cap}${why}` };
  if (reasons.length) return { level: "warn", message: `Nothing new was added.${why}` };
  return {
    level: "warn",
    message: "The AI found nothing new to propose from this character's recorded evidence yet. Analyze more session notes and try again."
  };
}

/** "5 proposals already pending -- approve or reject some first." or "" -- pure, exported for tests. */
export function describeCapReached(capReached) {
  if (!capReached || typeof capReached !== "object") return "";
  const pending = Math.max(0, Math.floor(Number(capReached.pending) || 0));
  const cap = Math.max(0, Math.floor(Number(capReached.cap) || 0));
  const count = pending || cap;
  if (!count) return "";
  return `${count} proposal${count === 1 ? " is" : "s are"} already pending${cap && pending > cap ? ` (the cap is ${cap})` : ""} -- approve or reject some first.`;
}

const SKIP_LABELS = Object.freeze({
  duplicate: "already pending",
  pending: "already pending",
  "already-pending": "already pending",
  "pending-duplicate": "already pending",
  "near-duplicate": "too close to a pending one",
  rejected: "you rejected it before",
  owned: "already owned",
  "owned-duplicate": "already owned",
  "already-owned": "already owned",
  "class-feature": "duplicates a class feature",
  "pending-cap": "over the pending cap",
  cap: "over the pending cap",
  "wrong-system": "not a rule of this game system"
});

/**
 * One skipped Suggest candidate as a short reason, e.g. "already pending: Iron Grip". Accepts the
 * contract shape ({ name, reason, duplicateOf }) and the older one ({ proposal, errors, reason })
 * the API returned before dev-integration's change. Pure, exported for tests.
 */
export function describeSkippedProposal(skipped) {
  if (!skipped || typeof skipped !== "object") return "";
  const name = String(skipped.name ?? skipped.proposal?.entry?.name ?? skipped.proposal?.name ?? "").trim();
  const duplicateOf = String(skipped.duplicateOf ?? "").trim();
  const reason = String(skipped.reason ?? "").trim();
  const target = duplicateOf && duplicateOf.toLowerCase() !== name.toLowerCase()
    ? (name ? `${name} (same as ${duplicateOf})` : duplicateOf)
    : name;
  const label = SKIP_LABELS[reason.toLowerCase()];
  if (label) return target ? `${label}: ${target}` : label;
  const error = Array.isArray(skipped.errors) ? skipped.errors.find((text) => typeof text === "string" && text.trim()) : "";
  if (error) return name && !error.includes(name) ? `${name}: ${error.trim()}` : error.trim();
  return target ? `${target}${reason ? ` (${reason})` : ""}` : reason;
}

/** The lasting "why nothing new" note under the Suggest button (a toast fades). Exported for tests. */
export function renderSuggestOutcome(lastSuggest) {
  if (!lastSuggest || typeof lastSuggest !== "object") return "";
  const cap = describeCapReached(lastSuggest.capReached);
  const reasons = [...new Set((Array.isArray(lastSuggest.skipped) ? lastSuggest.skipped : []).map(describeSkippedProposal).filter(Boolean))];
  if (!cap && !reasons.length) return "";
  const items = reasons.slice(0, 8).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("");
  const more = reasons.length > 8 ? `<li><em>...and ${reasons.length - 8} more</em></li>` : "";
  return `<div class="gd-suggest-outcome"><p><i class="fas fa-circle-info"></i> <strong>Last suggestion:</strong> ${cap ? escapeHtml(cap) : "some ideas were not added:"}</p>${items ? `<ul>${items}${more}</ul>` : ""}</div>`;
}

/**
 * After an analysis: Skills now ready to evolve (result.evolutionReady, contract) and Classes at
 * risk of erosion (board 0860fd78). Empty when there is nothing to say. Exported for tests.
 */
export function renderAfterAnalysis(lastResult, erosion = [], { canEvolve = false, busy = false, aiAttached = true } = {}) {
  const ready = (Array.isArray(lastResult?.evolutionReady) ? lastResult.evolutionReady : []).filter((skill) => skill?.skillId);
  const atRisk = Array.isArray(erosion) ? erosion : [];
  if (!ready.length && !atRisk.length) return "";
  const readyRows = ready.map((skill) => {
    const evolve = canEvolve
      ? ` ${actionButton({ action: ACTIONS.evolve.action, icon: "fas fa-dna", label: "Evolve", entryId: skill.skillId, disabled: busy, title: busy ? BUSY_NOTICE : !aiAttached ? "Evolving without an AI uses the built-in rules (a stated fallback)." : "Ask the AI to write the evolved Skill; it arrives as a pending proposal." })}`
      : "";
    return `<li><strong>${escapeHtml(skill.name ?? skill.skillId)}</strong> is ready to evolve${Number.isFinite(Number(skill.pressure)) ? ` <span class="gd-hint">(pressure ${escapeHtml(Math.round(Number(skill.pressure) * 100) / 100)})</span>` : ""}.${evolve}</li>`;
  }).join("");
  return `<div class="gd-after-analysis">
    ${readyRows ? `<h4><i class="fas fa-dna"></i> Ready to evolve</h4><ul class="gd-evolution-ready">${readyRows}</ul>` : ""}
    ${atRisk.length ? `<h4><i class="fas fa-hourglass-half"></i> Classes at risk of erosion</h4>${renderErosionList(atRisk)}` : ""}
    <p class="gd-hint">Open the <strong>Registry</strong> for lineage, Evolve and Merge.</p>
  </div>`;
}

/**
 * The header's "what now?" line, as HTML (no user data in it). Approving a non-capstone proposal is
 * what spends a grant allowance (progression.js#spendGrantAllowance), so the hint says exactly that.
 * With nothing pending it points at Suggest proposals, but only when that button exists.
 */
export function allowanceHint(progression, pendingCount, canSuggest = true) {
  const allowances = Math.max(0, Math.floor(Number(progression?.grantAllowances) || 0));
  if (!allowances) return "";
  const noun = `${allowances} grant allowance${allowances === 1 ? "" : "s"} to spend`;
  if (pendingCount > 0) return `${noun} -- approve a proposal to use one.`;
  return canSuggest
    ? `${noun}, but no proposals yet -- use <strong>${SUGGEST_LABEL}</strong> below.`
    : `${noun}; proposals appear here once the recorded evidence supports one.`;
}

/**
 * Notifications for a resolveLevelRest result. Each fallback warning is permanent (the GM must
 * review a template that stands in for the AI's Skill/Class), and any new milestone proposals are
 * named so the GM knows to open them. Exported for tests.
 */
export function reportRest(result, restType = "long") {
  const levels = result?.gainedLevels?.length ? ` Reached level(s): ${result.gainedLevels.join(", ")}.` : " No level was reached.";
  ui.notifications.info(`Grand Design ${restType} rest resolved.${levels}`);
  const names = [...(result?.capstoneProposals ?? []), ...(result?.classProposals ?? [])]
    .map((proposal) => proposal?.entry?.name ?? proposal?.id)
    .filter(Boolean);
  if (names.length) {
    ui.notifications.info(`New milestone proposal${names.length === 1 ? "" : "s"} waiting for your review: ${names.join(", ")}.`);
  }
  for (const warning of result?.warnings ?? []) ui.notifications.warn(String(warning), { permanent: true });
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
    const newThemes = (result.themes ?? []).filter((theme) => theme.isNew).map((theme) => theme.label);
    const themeNote = newThemes.length ? ` New theme(s): ${newThemes.join(", ")}.` : "";
    if (result.source === "adapter") {
      ui.notifications.info(`Recorded ${events.length} growth event(s) via AI analysis; ${pendingCount} pending proposal(s).${themeNote}`);
    } else {
      // A quiet info toast let a GM run on the keyword analyzer for weeks; no AI provider is a warning.
      const reason = result?.source === "local-fallback" ? "" : " No AI provider is attached -- set one in Grand Design AI Gateway settings for fuller readings.";
      ui.notifications.warn(`Recorded ${events.length} growth event(s) via the local keyword analyzer, not an AI; ${pendingCount} pending proposal(s).${themeNote}${reason}`);
    }
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

export function renderGrowthContent({
  growth, progression, pending, lastAnalysis, lastResult, status, draftNotes = "",
  canSuggest = true, canEdit = false, canRetry = false, aiAttached = true, busy = false,
  namesById = new Map(), focusProposalId = null, lastSuggest = null, erosion = [], canEvolve = false,
  horrorRank = null, systemId = null
}) {
  const events = Array.isArray(growth?.events) ? growth.events : [];
  pending = Array.isArray(pending) ? pending : [];
  const allowances = Math.max(0, Math.floor(Number(progression?.grantAllowances) || 0));
  // The stuck state found in the ember-road playtest: level-ups earned at rest, nothing to spend them on.
  const stuck = allowances > 0 && !pending.length;
  const hint = allowanceHint(progression, pending.length, canSuggest);
  const eventsById = new Map(events.filter((event) => event?.id).map((event) => [event.id, event]));
  const rowOptions = { canEdit, canRetry, aiAttached: aiAttached && status?.kind !== "local", busy, eventsById, namesById, focusProposalId, systemId };
  const rows = pending.length
    ? pending.map((proposal) => renderProposal(proposal, rowOptions)).join("")
    : stuck && canSuggest
      ? "" // the callout below explains the empty list and offers the way out
      : "<li>No proposal has enough evidence yet.</li>";
  const suggest = canSuggest ? `${renderSuggest({ stuck, allowances, status, busy })}${renderSuggestOutcome(lastSuggest)}` : "";
  const eventList = events.length
    ? events.slice(-40).reverse().map((event) => `<li class="gd-event-row">${renderEventLine(event)}</li>`).join("")
    : "<li>No recorded growth events.</li>";
  const hasLast = Boolean(lastAnalysis?.notes);
  const button = (key, icon, label, extra = {}) => actionButton({ action: ACTIONS[key].action, icon, label, disabled: busy, title: busy ? BUSY_NOTICE : "", ...extra });

  return `<form class="grand-design-growth${busy ? " gd-busy" : ""}">
    <header class="gd-growth-header">
      <h3>Grand Design Level ${Number(progression?.level) || 0}/100</h3>
      <span class="gd-status gd-status-${escapeHtml(status?.kind)}" title="${escapeHtml(status?.title)}"><i class="fas ${status?.kind === "ai" ? "fa-brain" : status?.kind === "fallback" ? "fa-triangle-exclamation" : "fa-book"}"></i> ${escapeHtml(status?.text)}</span>
      <button type="button" class="gd-action gd-open-registry" data-action="${OPEN_REGISTRY}"${busy ? " disabled" : ""} title="${busy ? escapeHtml(BUSY_NOTICE) : "Owned Classes, Skills and Titles: lineage, Evolve, Merge, erosion"}"><i class="fas fa-sitemap"></i> <span class="gd-btn-label">Registry</span></button>
    </header>
    ${busy ? `<p class="gd-busy-notice"><i class="fas fa-spinner fa-spin"></i> ${escapeHtml(BUSY_NOTICE)} This dialog refreshes by itself when it is done.</p>` : ""}
    ${renderHorrorRankMeter(horrorRank, { events, compact: true })}
    <p><strong>${Math.floor(Number(progression?.progress) || 0)} progression</strong> toward the next level; <strong>${allowances}</strong> level-up grant allowance(s) available.</p>
    ${hint ? `<p class="gd-allowance-hint"><i class="fas fa-gift"></i> ${hint}</p>` : ""}
    <div class="form-group gd-rest-row"><label>Resolve progression at rest</label><select name="growth-rest-type"><option value="short">Short Rest</option><option value="long">Long Rest</option></select>${button("rest", "fas fa-bed", "Resolve Rest")}</div>
    <hr>
    <div class="form-group stacked"><label>Session Notes</label><textarea name="growth-notes" rows="8" placeholder="Write however you like — any language, bullet points, shorthand, typos are fine.&#10;- Kesh parried the captain, nat 20!&#10;- Mira kept the bees calm and harvested honey&#10;- Torv tried to pick the lock, it broke">${escapeHtml(draftNotes ?? "")}</textarea></div>
    <div class="gd-action-row">${button("analyze", "fas fa-wand-magic-sparkles", "Analyze", { variant: "gd-primary" })}${hasLast ? button("reanalyze", "fas fa-rotate", "Re-analyze last notes") : ""}</div>
    <p class="gd-hint">Successes and honest failed attempts both count. Things the tag list doesn't cover (beekeeping, gambling, map-making...) become <em>themes</em> and can grow into brand-new Skills. Approval is always yours.${hasLast ? ` Last notes analyzed ${escapeHtml(formatWhen(lastAnalysis.at))} — use <strong>Re-analyze</strong> to read them again (the previous reading is replaced, not added to).` : ""}</p>
    ${renderInterpretation(events, lastAnalysis, lastResult)}
    ${renderAfterAnalysis(lastResult, erosion, { canEvolve, busy, aiAttached: rowOptions.aiAttached })}
    <hr><h3>Pending Proposals</h3>${stuck ? suggest : ""}${rows ? `<ul class="gd-proposals">${rows}</ul>` : ""}${stuck ? "" : suggest}
    <hr><details class="gd-history"><summary>Recorded Evidence (${events.length})</summary><ul>${eventList}</ul></details>
  </form>`;
}

/**
 * A body button (type="button": it must never submit the dialog form). `id` is a proposal id,
 * `entryId` an owned Class/Skill/Title id (registry panel, Evolve). Exported for the panel.
 */
export function actionButton({ action, icon, label, id = null, entryId = null, variant = "", disabled = false, title = "", aria = "" }) {
  const idAttr = (id !== null && id !== undefined ? ` data-proposal-id="${escapeHtml(id)}"` : "")
    + (entryId !== null && entryId !== undefined ? ` data-entry-id="${escapeHtml(entryId)}"` : "");
  return `<button type="button" class="gd-action${variant ? ` ${variant}` : ""}" data-action="${action}"${idAttr} aria-busy="false"${disabled ? " disabled" : ""}${title ? ` title="${escapeHtml(title)}"` : ""}${aria ? ` aria-label="${escapeHtml(aria)}"` : ""}><i class="${icon}"></i> <span class="gd-btn-label">${escapeHtml(label)}</span></button>`;
}

// Prominent call-to-action when allowances wait with nothing to spend them on; otherwise a small
// secondary button under the list (more ideas are still useful when the pending list is stale).
function renderSuggest({ stuck, allowances, status, busy = false }) {
  // With no AI attached the button would only throw "no provider": disable it and say why instead.
  const noProvider = status?.kind === "local";
  const disabled = noProvider ? ` disabled title="${escapeHtml(NO_PROVIDER_TITLE)}"` : busy ? ` disabled title="${escapeHtml(BUSY_NOTICE)}"` : "";
  const button = (variant) => `<button type="button" class="gd-suggest ${variant}" data-action="gd-suggest-proposals" aria-busy="false"${disabled}><i class="fas fa-lightbulb"></i> <span class="gd-suggest-label">${SUGGEST_LABEL}</span></button>`;
  const needsProvider = noProvider
    ? ' It needs an AI provider (set one in <a data-gd-open-gateway="1"><em>Grand Design AI Gateway</em></a> settings).'
    : "";
  if (stuck) {
    return `<div class="gd-suggest-callout"><p>${allowances} grant allowance${allowances === 1 ? " is" : "s are"} waiting, but no proposal has enough evidence yet. Ask the AI to suggest Skills or Classes now from everything already recorded; it takes about 10 seconds with a local model.${needsProvider}</p>${button("gd-suggest-primary")}</div>`;
  }
  return `<p class="gd-suggest-secondary">${button("gd-suggest-quiet")} <span class="gd-hint">Ask the AI for more proposals from the recorded evidence.${needsProvider}</span></p>`;
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
    ${who}<span class="gd-summary">${escapeHtml(event?.summary ?? "")}</span>${isDarkDeed(event) ? ` ${renderDarkDeedBadge(event)}` : ""}${typeof event?.consequence === "string" && event.consequence.trim() ? ` <span class="gd-consequence">&rarr; ${escapeHtml(event.consequence)}</span>` : ""}
    <span class="gd-chips">${tags}${themes || (!tags ? '<span class="gd-chip">untagged</span>' : "")}</span>${quote}`;
}


/**
 * A milestone reward (capstone Skill or milestone Class evolution) that the built-in template wrote
 * instead of the AI -- the ones "Retry with AI" re-asks (board b375d56c). An AI-written milestone
 * keeps source "capstone"/"class-evolution" but carries authoredBy "ai-gateway".
 */
export function isTemplateMilestone(proposal) {
  if (!proposal || typeof proposal !== "object") return false;
  const milestone = proposal.isCapstone === true || proposal.source === "capstone" || proposal.source === "class-evolution"
    || (proposal.kind === "class" && proposal.milestoneLevel !== undefined && proposal.milestoneLevel !== null);
  if (!milestone) return false;
  if (proposal.usedFallback === true) return true;
  return proposal.source !== "ai-gateway" && proposal.authoredBy !== "ai-gateway";
}

// "Author with AI" rewrites anything the AI did not write itself: a placeholder, a tag template, an
// emergent-theme knack. An AI-authored proposal is edited (or rejected) instead.
function canBeAuthored(proposal) {
  if (proposal.needsAuthoring) return true;
  // Titles have no mechanics for the AI to author: edit or reject them instead.
  if (proposal.kind === "title") return false;
  return proposal.source !== "ai-gateway" && proposal.authoredBy !== "ai-gateway";
}

// Exported so tests can check each control directly against a proposal's status/shape, not just
// indirectly through renderGrowthContent's own pending-only filtering.
export function renderProposal(proposal, { canEdit = false, canRetry = false, aiAttached = true, busy = false, eventsById = new Map(), namesById = new Map(), focusProposalId = null, systemId = null } = {}) {
  proposal = proposal && typeof proposal === "object" ? proposal : {};
  const entry = proposal.entry && typeof proposal.entry === "object" ? proposal.entry : {};
  const name = entry.name ?? proposal.id ?? "(unnamed proposal)";
  const isTitle = proposal.kind === "title";
  // A Title has no mechanics block (contract): its description is what it "does".
  const effect = entry.mechanics?.effect ?? (isTitle ? entry.description : undefined) ?? "(no effect text on this proposal)";
  const focused = focusProposalId !== null && focusProposalId !== undefined && proposal.id === focusProposalId;
  const cited = Array.isArray(proposal.evidence) && proposal.evidence.length ? `${proposal.evidence.length} event(s)` : "none cited";
  // A milestone reward that fell back to the built-in template keeps its source ("capstone" /
  // "class-evolution"); `usedFallback` (when the API sets it) is what says the AI did not write it.
  const fallback = proposal.usedFallback === true ? ' <span class="gd-chip" title="The AI could not write this one; review and flesh it out.">template</span>' : "";
  const badge = proposal.source === "emergent"
    ? `<span class="gd-chip gd-theme">theme: ${escapeHtml(proposal.theme ?? "?")}</span>`
    : proposal.source === "ai-gateway"
      ? '<span class="gd-chip gd-ai">AI</span>'
      : proposal.isCapstone || proposal.source === "capstone"
        ? `<span class="gd-chip gd-capstone">capstone</span>${fallback}`
        : proposal.source === "class-evolution"
          ? `<span class="gd-chip gd-class">class evolution</span>${fallback}`
          : '<span class="gd-chip">template</span>';
  const kind = proposal.kind === "class"
    ? '<span class="gd-chip gd-kind">Class</span>'
    : isTitle
      ? '<span class="gd-chip gd-kind gd-title-chip" title="A Title: a name the world knows this character by, earned by a deed.">Title</span>'
      : '<span class="gd-chip gd-kind">Skill</span>';
  const lineage = renderLineageChip(entry.metadata?.lineage, namesById);
  const red = entry.metadata?.polarity === "red" ? ` <span class="gd-chip gd-red" title="Red (taboo) entry: it carries a real cost.">red${entry.metadata?.malignance?.vice ? `: ${escapeHtml(entry.metadata.malignance.vice)}` : ""}</span>` : "";
  const authoring = proposal.needsAuthoring ? ' <em class="gd-needs-authoring">placeholder — "Author with AI" writes real mechanics</em>' : "";
  const actions = proposal.status === "pending" ? renderProposalActions(proposal, { canRetry, aiAttached, busy }) : "";
  const details = renderProposalDetails(proposal, eventsById, { open: focused, namesById, systemId });
  const edit = canEdit && proposal.status === "pending" ? renderEditForm(proposal, { busy, systemId }) : "";
  // Owner decision 2026-09-29: a hint, not a blocker. Rejecting refuses the power; the deeds still count.
  const redHint = isRedProposal(proposal) && proposal.status === "pending"
    ? '<p class="gd-hint gd-red-reject-hint"><i class="fas fa-skull"></i> Rejecting a red proposal refuses the power, not the stain: Horror Rank counts the dark deeds in the notes either way.</p>'
    : "";
  return `<li class="gd-proposal${focused ? " gd-focus" : ""}" data-proposal-id="${escapeHtml(proposal.id)}">
    <div class="gd-proposal-head"><strong>${escapeHtml(name)}</strong> ${kind} ${badge}${lineage}${red}${authoring}</div>
    <div class="gd-proposal-effect">${escapeHtml(effect)} <em>Evidence: ${escapeHtml(cited)}</em></div>
    ${actions ? `<div class="gd-proposal-actions">${actions}</div>` : ""}${redHint}
    ${details}${edit}
  </li>`;
}

function renderProposalActions(proposal, { canRetry, aiAttached, busy }) {
  const id = proposal.id;
  const lock = (needsAi) => ({
    disabled: busy || (needsAi && !aiAttached),
    title: busy ? BUSY_NOTICE : needsAi && !aiAttached ? NO_PROVIDER_TITLE : ""
  });
  const buttons = [];
  const retryable = isTemplateMilestone(proposal) && canRetry;
  if (proposal.needsAuthoring) {
    // Board 283ad7ca: approveProposal refuses a placeholder unless confirm: true, so a placeholder
    // row offers the two honest choices instead of an Approve that would only throw.
    buttons.push(actionButton({ action: ACTIONS.author.action, icon: "fas fa-feather-pointed", label: "Author with AI", id, variant: "gd-primary", ...lock(true) }));
    buttons.push(actionButton({ action: ACTIONS.approveAsWritten.action, icon: "fas fa-check-double", label: "Approve as written", id, ...lock(false), title: busy ? BUSY_NOTICE : "Approve this generic placeholder exactly as it reads (asks you to confirm)." }));
  } else {
    buttons.push(actionButton({ action: ACTIONS.approve.action, icon: "fas fa-check", label: "Approve", id, variant: "gd-primary", ...lock(false) }));
    if (retryable) {
      buttons.push(actionButton({ action: ACTIONS.retry.action, icon: "fas fa-rotate-right", label: "Retry with AI", id, ...lock(true), title: busy ? BUSY_NOTICE : !aiAttached ? NO_PROVIDER_TITLE : "The built-in template stood in for the AI here. Ask the AI to write this milestone reward again." }));
    } else if (canBeAuthored(proposal)) {
      buttons.push(actionButton({ action: ACTIONS.author.action, icon: "fas fa-feather-pointed", label: "Author with AI", id, ...lock(true) }));
    }
  }
  const rejectTitle = isRedProposal(proposal)
    ? "Reject this red proposal: the power is refused, but the deeds stay recorded and still count toward Horror Rank."
    : "Reject this proposal";
  buttons.push(actionButton({ action: ACTIONS.reject.action, icon: "fas fa-ban", label: "Reject", id, variant: "gd-reject", ...lock(false), title: busy ? BUSY_NOTICE : rejectTitle }));
  return buttons.join(" ");
}

const SOURCE_LABELS = {
  "ai-gateway": "Written by the AI",
  emergent: "Emergent theme",
  template: "Built-in tag template",
  capstone: "Milestone capstone",
  "class-evolution": "Milestone Class evolution"
};

/** The full proposal, read-only, in a collapsed <details>. Exported for tests. */
export function renderProposalDetails(proposal, eventsById = new Map(), { open = false, namesById = new Map(), systemId = null } = {}) {
  const entry = proposal?.entry && typeof proposal.entry === "object" ? proposal.entry : {};
  const mechanics = entry.mechanics && typeof entry.mechanics === "object" ? entry.mechanics : {};
  const metadata = entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {};
  const rows = [];
  const row = (label, value) => {
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) return;
    rows.push(`<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(Array.isArray(value) ? value.join(", ") : String(value))}</dd>`);
  };
  const isTitle = proposal?.kind === "title";
  row("Kind", proposal?.kind === "class" ? "Class" : isTitle ? "Title" : "Skill");
  if (isTitle) {
    row("Description", entry.description);
    // The deed: the title's own achievement text, else the rationale that quotes it (contract).
    row("Deed", entry.achievement ?? metadata.deed ?? proposal?.deed ?? metadata.lineage?.rationale ?? proposal?.rationale);
  }
  const lineage = metadata.lineage;
  if (lineage && (lineage.operation === "upgrade" || lineage.operation === "combine")) {
    row(lineage.operation === "upgrade" ? "Evolves" : "Merges", lineageSourceNames(lineage, namesById).join(lineage.operation === "combine" ? " + " : ", "));
  }
  const source = SOURCE_LABELS[proposal?.source] ?? proposal?.source;
  row("Source", proposal?.authoredBy === "ai-gateway" && proposal?.source !== "ai-gateway" ? `${source} (written by the AI)` : proposal?.usedFallback ? `${source} (built-in template: the AI could not write it)` : source);
  row("Fallback reason", proposal?.fallbackReason);
  row("Milestone level", proposal?.milestoneLevel);
  if (proposal?.kind === "class") {
    row("Class level", entry.level);
    row("Power tier", entry.power_tier);
    row("System chassis", entry.system_chassis);
    row("Primary / secondary", entry.is_primary ? "primary" : entry.is_secondary ? "secondary" : undefined);
  } else if (!isTitle) {
    row("Tier", entry.tier);
    row("System equivalent", entry.system_equivalent);
  }
  row("Item kind", entry.gameItem?.kind);
  row("Actions", mechanics.actions);
  row("Trigger", mechanics.trigger);
  row("Requirements", mechanics.requirements);
  row("Frequency", describeFrequency(mechanics.frequency));
  row("Duration", mechanics.duration);
  row("Roll", describeRoll(mechanics.roll));
  row("Effect", mechanics.effect);
  row("Tags", Array.isArray(metadata.tags) ? metadata.tags : undefined);
  row("Themes", Array.isArray(metadata.themes) ? metadata.themes : undefined);
  if (metadata.polarity === "red") {
    row("Polarity", "red (taboo)");
    row("Vice", metadata.malignance?.vice);
    row("Drawback", metadata.malignance?.drawback);
  }
  row("Rationale", metadata.lineage?.rationale || proposal?.rationale);
  const cited = Array.isArray(proposal?.evidence) ? proposal.evidence : [];
  const evidence = cited.slice(0, 8).map((id) => {
    const event = eventsById?.get?.(id);
    return `<li>${event ? `${event.actorName ? `<span class="gd-who">${escapeHtml(event.actorName)}:</span> ` : ""}${escapeHtml(event.summary ?? id)}${isDarkDeed(event) ? ` ${renderDarkDeedBadge(event)}` : ""}` : `<code>${escapeHtml(id)}</code>`}</li>`;
  }).join("");
  const more = cited.length > 8 ? `<li><em>...and ${cited.length - 8} more</em></li>` : "";
  return `<details class="gd-proposal-details"${open ? " open" : ""}><summary><i class="fas fa-circle-info"></i> Details</summary>
      <dl>${rows.join("")}</dl>${renderStructuredDetails(proposal, proposalSystem(proposal, systemId))}${evidence ? `<h4>Evidence</h4><ul class="gd-proposal-evidence">${evidence}${more}</ul>` : ""}
    </details>`;
}

/**
 * Source names of an upgrade/combine lineage, never raw ids (board 752369f6). `sources` may be ids,
 * names, or { id, name } objects; an id the actor no longer owns reads as its prettified slug.
 * Pure, exported for tests.
 */
export function lineageSourceNames(lineage, namesById = new Map()) {
  const sources = Array.isArray(lineage?.sources) ? lineage.sources : [];
  return sources.map((source) => {
    if (source && typeof source === "object") return String(source.name ?? namesById?.get?.(source.id) ?? prettifyEntryId(source.id));
    const known = namesById?.get?.(source);
    return known ?? prettifyEntryId(source);
  }).filter(Boolean);
}

/** "skill:iron-grip" -> "Iron Grip"; a plain name comes back as it is. Exported for tests. */
export function prettifyEntryId(id) {
  const text = String(id ?? "").trim();
  const match = /^(?:class|skill|title):(.+)$/i.exec(text);
  if (!match) return text;
  return match[1].split(/[-_]+/).filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

function renderLineageChip(lineage, namesById) {
  if (!lineage || (lineage.operation !== "upgrade" && lineage.operation !== "combine")) return "";
  const names = lineageSourceNames(lineage, namesById);
  if (!names.length) return "";
  return lineage.operation === "upgrade"
    ? ` <span class="gd-chip gd-lineage" title="Evolved from an owned Skill; approving it supersedes the source.">evolves ${escapeHtml(names.join(", "))}</span>`
    : ` <span class="gd-chip gd-lineage" title="Merges owned Classes; approving it supersedes the sources.">merges ${escapeHtml(names.join(" + "))}</span>`;
}

function describeFrequency(frequency) {
  if (!frequency || typeof frequency !== "object") return typeof frequency === "string" ? frequency : undefined;
  if (frequency.max === undefined && !frequency.per) return undefined;
  return `${frequency.max ?? 1} per ${frequency.per ?? "?"}`;
}

function describeRoll(roll) {
  if (!roll || typeof roll !== "object") return undefined;
  const parts = [roll.kind, roll.formula, roll.dc !== undefined && roll.dc !== null && roll.dc !== "" ? `DC ${roll.dc}` : ""].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

// The GM-editable fields. Kept to what a GM tweaks at the table; anything else on the entry is
// carried over untouched by buildProposalPatch.
const SKILL_TIERS = ["1", "2", "3"];
const POWER_TIERS = ["standard", "elevated", "prestige"];

function renderEditForm(proposal, { busy = false, systemId = null } = {}) {
  const entry = proposal.entry && typeof proposal.entry === "object" ? proposal.entry : {};
  const mechanics = entry.mechanics ?? {};
  const isClass = proposal.kind === "class";
  const field = (label, name, value, { type = "text", attrs = "" } = {}) =>
    `<div class="form-group"><label>${escapeHtml(label)}</label><input type="${type}" data-field="${name}" value="${escapeHtml(value ?? "")}"${attrs}></div>`;
  const select = (label, name, options, value) =>
    `<div class="form-group"><label>${escapeHtml(label)}</label><select data-field="${name}">${options.map((option) => `<option value="${escapeHtml(option)}"${String(value) === option ? " selected" : ""}>${escapeHtml(option)}</option>`).join("")}</select></div>`;
  const tagsField = field("Tags (comma separated)", "tags", Array.isArray(entry.metadata?.tags) ? entry.metadata.tags.join(", ") : "");
  const rationaleField = `<div class="form-group stacked"><label>Rationale</label><textarea data-field="rationale" rows="2">${escapeHtml(entry.metadata?.lineage?.rationale ?? "")}</textarea></div>`;
  const saveButton = actionButton({ action: ACTIONS.save.action, icon: "fas fa-floppy-disk", label: "Save changes", id: proposal.id, variant: "gd-primary", disabled: busy, title: busy ? BUSY_NOTICE : "Checked by the same validator as AI proposals; stays pending until you Approve." });
  if (proposal.kind === "title") {
    // A Title has no tier or mechanics block (contract): name, description, tags, rationale.
    return `<details class="gd-proposal-edit"><summary><i class="fas fa-pen"></i> Edit</summary>
      <div class="gd-edit-form" data-proposal-id="${escapeHtml(proposal.id)}">
        ${field("Name", "name", entry.name)}
        <div class="form-group stacked"><label>Description</label><textarea data-field="description" rows="3">${escapeHtml(entry.description ?? "")}</textarea></div>
        ${tagsField}
        ${rationaleField}
        <div class="gd-edit-errors" role="alert"></div>
        ${saveButton}
      </div>
    </details>`;
  }
  const kindFields = isClass
    ? `${field("Class level", "level", entry.level, { type: "number", attrs: ' min="1" max="20" step="1"' })}${select("Power tier", "power_tier", POWER_TIERS, entry.power_tier ?? "standard")}${field("System chassis", "system_chassis", entry.system_chassis)}`
    : `${select("Tier", "tier", SKILL_TIERS, entry.tier ?? 1)}${field("System equivalent", "system_equivalent", entry.system_equivalent)}`;
  return `<details class="gd-proposal-edit"><summary><i class="fas fa-pen"></i> Edit</summary>
      <div class="gd-edit-form" data-proposal-id="${escapeHtml(proposal.id)}">
        ${field("Name", "name", entry.name)}
        ${kindFields}
        ${field("Actions", "actions", mechanics.actions, { type: "number", attrs: ' min="0" max="3" step="1" placeholder="none"' })}
        ${field("Trigger", "trigger", mechanics.trigger, { attrs: ' placeholder="only for reactions"' })}
        ${field("Duration", "duration", mechanics.duration)}
        <div class="form-group stacked"><label>Effect</label><textarea data-field="effect" rows="3">${escapeHtml(mechanics.effect ?? "")}</textarea></div>
        ${renderStructuredEditor(mechanics.structured, proposalSystem(proposal, systemId))}
        ${field("Tags (comma separated)", "tags", Array.isArray(entry.metadata?.tags) ? entry.metadata.tags.join(", ") : "")}
        <div class="form-group stacked"><label>Rationale</label><textarea data-field="rationale" rows="2">${escapeHtml(entry.metadata?.lineage?.rationale ?? "")}</textarea></div>
        <div class="gd-edit-errors" role="alert"></div>
        ${actionButton({ action: ACTIONS.save.action, icon: "fas fa-floppy-disk", label: "Save changes", id: proposal.id, variant: "gd-primary", disabled: busy, title: busy ? BUSY_NOTICE : "Checked by the same validator as AI proposals; stays pending until you Approve." })}
      </div>
    </details>`;
}

/** { field: value } from an edit form's [data-field] inputs. Exported for tests (fake elements). */
export function readEditFields(form) {
  const fields = {};
  const nodes = form?.querySelectorAll?.("[data-field]") ?? [];
  for (const node of nodes) {
    const key = node?.dataset?.field ?? node?.getAttribute?.("data-field");
    // A checkbox (the structured editor's "basic save") reads as "true" or "".
    if (key) fields[key] = node?.type === "checkbox" ? (node.checked ? "true" : "") : String(node.value ?? "");
  }
  return fields;
}

/**
 * The patch sent to api.updateProposal(actor, id, patch): `{ entry }`, the WHOLE edited entry (the
 * original deep-copied, the edited fields applied), so a shallow or a deep merge on the API side
 * gives the same result and nothing the form does not show (gameItem, roll, lineage sources,
 * malignance...) is lost. Fields absent from `fields` are left alone; an emptied optional field is
 * removed. Only the obvious mistakes are caught here -- the API runs validator.js on the result.
 * Pure, exported for tests.
 */
export function buildProposalPatch(proposal, fields = {}) {
  const errors = [];
  const entry = structuredClone(proposal?.entry && typeof proposal.entry === "object" ? proposal.entry : {});
  // A Title carries no mechanics block (contract); do not invent an empty one on it.
  if (proposal?.kind !== "title" || entry.mechanics) entry.mechanics = entry.mechanics && typeof entry.mechanics === "object" ? entry.mechanics : {};
  entry.metadata = entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {};
  const has = (key) => Object.hasOwn(fields, key);
  const text = (key) => String(fields[key] ?? "").trim();
  const optional = (target, key, value) => {
    if (value === "") delete target[key];
    else target[key] = value;
  };

  if (has("name")) {
    if (!text("name")) errors.push("A name is required.");
    else entry.name = text("name").slice(0, 120);
  }
  if (has("effect") && entry.mechanics) {
    if (!text("effect")) errors.push("The effect cannot be empty: say what it does at the table.");
    else entry.mechanics.effect = text("effect");
  }
  if (proposal?.kind === "title") {
    if (has("description")) {
      if (!text("description")) errors.push("A Title needs a description: what the world calls them, and why.");
      else entry.description = text("description");
    }
  } else if (proposal?.kind === "class") {
    if (has("level")) {
      const level = Number(text("level"));
      if (!Number.isInteger(level) || level < 1) errors.push("Class level must be a whole number of 1 or more.");
      else entry.level = level;
    }
    if (has("power_tier")) {
      if (!POWER_TIERS.includes(text("power_tier"))) errors.push(`Power tier must be one of: ${POWER_TIERS.join(", ")}.`);
      else entry.power_tier = text("power_tier");
    }
    if (has("system_chassis")) optional(entry, "system_chassis", text("system_chassis"));
  } else {
    if (has("tier")) {
      const tier = Number(text("tier"));
      if (![1, 2, 3].includes(tier)) errors.push("Tier must be 1, 2 or 3.");
      else if (proposal?.isCapstone && tier !== 3) errors.push("A capstone is always tier 3.");
      else entry.tier = tier;
    }
    if (has("system_equivalent")) optional(entry, "system_equivalent", text("system_equivalent"));
  }
  if (has("actions") && entry.mechanics) {
    if (text("actions") === "") delete entry.mechanics.actions;
    else {
      const actions = Number(text("actions"));
      if (!Number.isInteger(actions) || actions < 0 || actions > 3) errors.push("Actions must be 0-3, or empty for none.");
      else entry.mechanics.actions = actions;
    }
  }
  if (has("trigger") && entry.mechanics) optional(entry.mechanics, "trigger", text("trigger"));
  if (has("duration") && entry.mechanics) optional(entry.mechanics, "duration", text("duration"));
  if (has("tags")) {
    entry.metadata.tags = [...new Set(text("tags").split(/[,;\n]/).map((tag) => tag.trim()).filter(Boolean))];
  }
  // Board 5a0cea2e: the structured editor's "s.*" fields rebuild mechanics.structured; parts the
  // form does not show are kept, an all-empty editor removes it. The API's validator clamps the rest.
  if (entry.mechanics && Object.keys(fields).some((key) => key.startsWith("s."))) {
    const built = buildStructuredFromFields(fields, entry.mechanics.structured);
    errors.push(...built.errors);
    if (built.structured) entry.mechanics.structured = built.structured;
    else delete entry.mechanics.structured;
  }
  if (has("rationale")) {
    entry.metadata.lineage = entry.metadata.lineage && typeof entry.metadata.lineage === "object"
      ? entry.metadata.lineage
      : { operation: "origin", sources: [], rationale: "" };
    entry.metadata.lineage.rationale = text("rationale");
  }
  return { patch: { entry }, errors };
}

function renderEditErrors(errors) {
  const list = (Array.isArray(errors) ? errors : [errors]).map((error) => `<li>${escapeHtml(typeof error === "string" ? error : error?.message ?? JSON.stringify(error))}</li>`).join("");
  return `<p><i class="fas fa-triangle-exclamation"></i> Not saved:</p><ul>${list}</ul>`;
}

// --- Horror Rank (board 21e944ed, UI half; batch 3 contract sections 3 and 5) --------------------
// Owner decision 2026-09-29: Horror Rank accrues from the red DEEDS the notes record, not from
// approvals. The meter shows the design's 4-stage clock (conversion rules section 6), the points
// toward the next stage, and every deed that made it, quoting its summary, so a GM can see WHY.
// api.getHorrorRank's new shape ({ points, stage, nextThreshold, totalLevelsDocked, deeds }) is being
// written in parallel: everything below also reads today's { points, totalLevelsDocked } and, when
// the API lists no deeds, derives them from the recorded events' darkDeed/darkSeverity.

// Display fallbacks only; the API's own numbers win whenever it sends them.
export const HORROR_SEVERITY_POINTS = Object.freeze({ minor: 5, serious: 15, monstrous: 40 });

// The design's four stages (wandering-inn-pf2e-conversion-rules.md section 6), in table language.
export const HORROR_STAGES = Object.freeze([
  { stage: 0, name: "Unstained", flavour: "No monstrous deed has marked them. The Grand Design keeps count all the same." },
  { stage: 1, name: "Shadowed", flavour: "The deeds are noticed. People lower their voices, and something in their Classes has started to recoil." },
  { stage: 2, name: "Marked", flavour: "The stain shows. Their Classes are eaten away as the horror grows, and the Skills tied to those levels with them." },
  { stage: 3, name: "Horror", flavour: "Their Classes have lost their reason to exist: a [Guardsman] who became a horror cannot stand guard. Only a long road back could change that." }
]);

/**
 * Any getHorrorRank result (new or old shape, or nothing) as { points, stage, nextThreshold,
 * threshold, totalLevelsDocked, deeds, derivedDeeds }. `events` (the actor's recorded growth events)
 * supply the deed list when the API does not. Pure, exported for tests.
 */
export function normalizeHorrorRankView(raw, events = [], { threshold = HORROR_RANK_THRESHOLD } = {}) {
  const points = Math.max(0, Number.isFinite(Number(raw?.points)) ? Number(raw.points) : 0);
  const step = Number.isFinite(Number(threshold)) && Number(threshold) > 0 ? Number(threshold) : 100;
  const rawStage = Number(raw?.stage);
  const hasStage = raw?.stage !== undefined && raw?.stage !== null && Number.isInteger(rawStage);
  const stage = Math.max(0, Math.min(3, hasStage ? rawStage : Math.floor(points / step)));
  const rawNext = Number(raw?.nextThreshold);
  const nextThreshold = stage >= 3
    ? null
    : raw?.nextThreshold !== undefined && raw?.nextThreshold !== null && Number.isFinite(rawNext) && rawNext > 0 ? rawNext : (stage + 1) * step;
  const totalLevelsDocked = Math.max(0, Math.floor(Number(raw?.totalLevelsDocked) || 0));
  const listed = Array.isArray(raw?.deeds) ? raw.deeds.filter((deed) => deed && typeof deed === "object") : null;
  const deeds = listed ?? darkDeedsFromEvents(events);
  return {
    points,
    stage,
    nextThreshold,
    // The step between stages, for the bar: the next threshold over the stages it covers.
    threshold: nextThreshold ? nextThreshold / (stage + 1) : step,
    totalLevelsDocked,
    deeds: deeds.map((deed) => {
      const severity = deed.severity ?? deed.darkSeverity ?? null;
      return {
        eventId: deed.eventId ?? deed.id ?? null,
        summary: String(deed.summary ?? "").trim(),
        vice: deed.vice ?? deed.darkDeed ?? null,
        severity,
        points: Number.isFinite(Number(deed.points)) && deed.points !== null ? Number(deed.points) : HORROR_SEVERITY_POINTS[severity] ?? 0
      };
    }),
    derivedDeeds: !listed
  };
}

/** The recorded events that are dark deeds (contract section 1). Pure, exported for tests. */
export function darkDeedsFromEvents(events = []) {
  return (Array.isArray(events) ? events : []).filter(isDarkDeed).map((event) => ({
    eventId: event.id ?? null,
    summary: event.summary ?? "",
    vice: event.darkDeed,
    severity: event.darkSeverity,
    points: HORROR_SEVERITY_POINTS[event.darkSeverity] ?? 0
  }));
}

/** True when an event carries a real dark deed (a vice, not "none"). Pure, exported for tests. */
export function isDarkDeed(event) {
  const vice = typeof event?.darkDeed === "string" ? event.darkDeed.trim().toLowerCase() : "";
  return Boolean(vice) && vice !== "none";
}

/** The dark-deed chip on an event row ("cruelty, serious"), or "". Pure, exported for tests. */
export function renderDarkDeedBadge(event) {
  if (!isDarkDeed(event)) return "";
  const severity = Object.hasOwn(HORROR_SEVERITY_POINTS, event.darkSeverity) ? event.darkSeverity : "";
  const points = HORROR_SEVERITY_POINTS[severity];
  const title = `Dark deed (${event.darkDeed}${severity ? `, ${severity}` : ""}): it counts toward Horror Rank${points ? ` (+${points} points)` : ""}, whatever you do with any red Skill it earns.`;
  return `<span class="gd-chip gd-dark-deed${severity ? ` gd-dark-${severity}` : ""}" title="${escapeHtml(title)}"><i class="fas fa-skull"></i> ${escapeHtml(event.darkDeed)}${severity ? `, ${escapeHtml(severity)}` : ""}</span>`;
}

/**
 * The Horror Rank meter: stage pips 0-3 with the stage's name and flavour, a bar of points toward
 * the next stage, levels lost so far and the deeds (each quoting its summary). A clean character
 * gets one quiet line, so the mechanic is visible without shouting. Pure, exported for tests.
 */
export function renderHorrorRankMeter(raw, { events = [], compact = false } = {}) {
  const view = normalizeHorrorRankView(raw, events);
  if (view.points <= 0 && !view.deeds.length && !view.totalLevelsDocked) {
    return `<p class="gd-horror gd-horror-clean"><i class="fas fa-skull"></i> <strong>Horror Rank:</strong> Stage 0, ${escapeHtml(HORROR_STAGES[0].name)}. <span class="gd-hint">Dark deeds recorded in the notes (cruelty, desecration...) would start this clock.</span></p>`;
  }
  const stage = HORROR_STAGES[view.stage];
  const floor = view.stage * view.threshold;
  const fill = view.nextThreshold
    ? Math.max(0, Math.min(100, Math.round(((view.points - floor) / Math.max(1, view.nextThreshold - floor)) * 100)))
    : 100;
  const pips = HORROR_STAGES.map((step) => `<span class="gd-horror-pip${step.stage <= view.stage ? " gd-on" : ""}${step.stage === view.stage ? " gd-current" : ""}" title="Stage ${step.stage}: ${escapeHtml(step.name)}">${step.stage}</span>`).join("");
  const progress = view.nextThreshold
    ? `${escapeHtml(round2(view.points))} / ${escapeHtml(round2(view.nextThreshold))} points to Stage ${view.stage + 1} (${escapeHtml(HORROR_STAGES[view.stage + 1].name)})`
    : `${escapeHtml(round2(view.points))} points: the last stage`;
  const docked = view.totalLevelsDocked
    ? `<p class="gd-horror-docked"><i class="fas fa-arrow-trend-down"></i> ${view.totalLevelsDocked} Class level${view.totalLevelsDocked === 1 ? "" : "s"} lost to Horror Rank so far.</p>`
    : "";
  const deedRows = view.deeds.slice(0, 12).map((deed) => {
    const badge = renderDarkDeedBadge({ darkDeed: deed.vice || "dark deed", darkSeverity: deed.severity });
    const quote = deed.summary ? `&ldquo;${escapeHtml(deed.summary)}&rdquo;` : `<code>${escapeHtml(deed.eventId ?? "deed")}</code>`;
    return `<li>${badge} ${deed.points ? `<span class="gd-horror-points">+${escapeHtml(round2(deed.points))}</span> ` : ""}${quote}</li>`;
  }).join("");
  const more = view.deeds.length > 12 ? `<li><em>...and ${view.deeds.length - 12} more</em></li>` : "";
  const deeds = deedRows
    ? `<details class="gd-horror-deeds"${compact ? "" : " open"}><summary>The deed${view.deeds.length === 1 ? "" : "s"} that made it (${view.deeds.length})</summary><ul>${deedRows}${more}</ul></details>`
    : "";
  return `<section class="gd-horror gd-horror-stage-${view.stage}" aria-label="Horror Rank">
    <div class="gd-horror-head"><i class="fas fa-skull"></i> <strong>Horror Rank: Stage ${view.stage}, ${escapeHtml(stage.name)}</strong> <span class="gd-horror-pips">${pips}</span></div>
    <div class="gd-horror-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${fill}"><span style="width: ${fill}%"></span></div>
    <p class="gd-horror-progress">${progress}</p>
    <p class="gd-horror-flavour"><em>${escapeHtml(stage.flavour)}</em></p>
    ${docked}${deeds}
    <p class="gd-hint">Horror Rank counts the dark deeds in the notes. Rejecting a red Skill refuses the power, not the stain.</p>
  </section>`;
}

/**
 * The GM notices for a Horror Rank change: one per Class that lost levels ("Brakka's Bridge Warden
 * lost 2 levels to Horror Rank."), plus one when the stage moved. `className(classId)` resolves a
 * Class name. Pure, exported for tests.
 */
export function describeHorrorRankChange({ actorName = "", state = null, dockedFrom = [], previousStage = null, className = () => null } = {}) {
  const who = actorName ? `${actorName}'s` : "This character's";
  const notices = [];
  for (const dock of Array.isArray(dockedFrom) ? dockedFrom : []) {
    const levels = Math.max(0, Math.floor(Number(dock?.levelsDocked) || 0));
    if (!levels) continue;
    const name = dock?.className ?? dock?.name ?? safe(() => className(dock?.classId), null) ?? prettifyEntryId(dock?.classId);
    notices.push({ level: "warn", message: `${who} ${name || "strongest Class"} lost ${levels} level${levels === 1 ? "" : "s"} to Horror Rank.` });
  }
  if (state && previousStage !== null && previousStage !== undefined) {
    const view = normalizeHorrorRankView(state);
    if (view.stage !== previousStage) {
      const rose = view.stage > previousStage;
      const stage = HORROR_STAGES[view.stage];
      notices.push({
        level: rose ? "warn" : "info",
        message: `${who} Horror Rank ${rose ? "rose" : "fell"} to Stage ${view.stage} (${stage.name}).${rose ? ` ${stage.flavour}` : ""}`
      });
    }
  }
  return notices;
}

/**
 * Handlers for grand-design-ai.horrorRankChanged (contract) and the older horrorRankLevelsDocked,
 * announcing a docking once even when the API fires both. `notify(level, message)`,
 * `className(actor, classId)` and `now()` are injected so tests run without Foundry.
 */
export function createHorrorRankNotifier({ notify, className = () => null, now = () => Date.now(), windowMs = 5000 } = {}) {
  const lastStage = new Map();
  const recent = new Map();
  const key = (actor) => actor?.uuid ?? actor?.id ?? actor?.name ?? "actor";
  const announce = (actor, dockedFrom, extra = []) => {
    const id = key(actor);
    const docks = Array.isArray(dockedFrom) ? dockedFrom : [];
    const signature = JSON.stringify(docks.map((dock) => [dock?.classId, dock?.levelsDocked]));
    const seen = recent.get(id);
    const duplicate = docks.length > 0 && seen?.signature === signature && now() - seen.at < windowMs;
    if (docks.length) recent.set(id, { signature, at: now() });
    const notices = describeHorrorRankChange({ actorName: actor?.name, dockedFrom: duplicate ? [] : docks, className: (classId) => className(actor, classId) });
    for (const notice of [...notices, ...extra]) notify(notice.level, notice.message);
  };
  return {
    changed(actor, state, dockedFrom = []) {
      const id = key(actor);
      const stage = normalizeHorrorRankView(state).stage;
      // Unknown before this page load: a non-zero stage is announced once, a clean one not at all.
      const previous = lastStage.has(id) ? lastStage.get(id) : stage > 0 ? 0 : null;
      lastStage.set(id, stage);
      announce(actor, dockedFrom, describeHorrorRankChange({ actorName: actor?.name, state, previousStage: previous }));
    },
    docked(actor, dockedFrom = []) {
      announce(actor, dockedFrom);
    }
  };
}

// --- Structured mechanics (board 5a0cea2e, UI half; batch 3 contract section 2) -----------------
// entry.mechanics.structured is the game-readable half of a Skill: dice, saves, modifiers... The
// Details list reads it in the system's own words (PF2e "basic Reflex save against your class DC",
// dnd5e "Dexterity saving throw"), and the validator's clamps say what it cut to fit the tier.

const SAVES = Object.freeze({ pf2e: ["fortitude", "reflex", "will"], dnd5e: ["str", "dex", "con", "int", "wis", "cha"] });
const ABILITY_NAMES = Object.freeze({ str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma" });
const MODIFIER_TYPES = ["circumstance", "status", "item", "untyped"];
const USE_PERIODS = ["turn", "round", "encounter", "hour", "day", "short-rest", "long-rest"];
const AREA_TYPES = Object.freeze({ pf2e: ["cone", "burst", "emanation", "line"], dnd5e: ["cone", "sphere", "cube", "cylinder", "line"] });
const ATTACK_KINDS = ["melee", "ranged", "spell"];
const DC_KINDS = ["class", "spell"];
const DICE_PATTERN = /^\d{1,2}d(?:4|6|8|10|12|20)$/i;
const SELECTOR_PATTERN = /^(?:ac|attack|damage|perception|initiative|save:[a-z]+|skill:[a-z0-9-]+)$/;
const ADVANTAGE_PATTERN = /^(?:attack|save:[a-z]+|skill:[a-z0-9-]+|check:(?:str|dex|con|int|wis|cha))$/;

function systemOf(systemId) {
  return systemId === "dnd5e" ? "dnd5e" : "pf2e";
}

function titleCase(text) {
  return String(text ?? "").split(/[-_\s]+/).filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

function withBonus(dice, bonus) {
  const number = Number(bonus);
  return `${dice}${Number.isFinite(number) && number ? (number > 0 ? `+${number}` : `${number}`) : ""}`;
}

function saveName(save, system) {
  const slug = String(save ?? "").toLowerCase();
  return system === "dnd5e" ? `${ABILITY_NAMES[slug] ?? titleCase(slug)} saving throw` : `${titleCase(slug)} save`;
}

function selectorName(selector, system) {
  const text = String(selector ?? "");
  if (text === "ac") return "AC";
  if (text === "attack") return "attack rolls";
  if (text === "damage") return "damage rolls";
  if (text === "perception") return system === "dnd5e" ? "Wisdom (Perception) checks" : "Perception";
  if (text === "initiative") return system === "dnd5e" ? "initiative rolls" : "initiative";
  if (text.startsWith("save:")) return `${saveName(text.slice(5), system)}s`;
  if (text.startsWith("skill:")) return `${titleCase(text.slice(6))} checks`;
  if (text.startsWith("check:")) return `${ABILITY_NAMES[text.slice(6)] ?? titleCase(text.slice(6))} checks`;
  return text;
}

function describeDc(dc, system) {
  if (dc === "class") return system === "dnd5e" ? "DC 8 + proficiency bonus + ability modifier" : "your class DC";
  if (dc === "spell") return system === "dnd5e" ? "your spell save DC" : "your spell DC";
  const number = Number(dc);
  return dc !== "" && dc !== null && dc !== undefined && Number.isFinite(number) ? `DC ${number}` : "";
}

function describeUses(uses, system) {
  const max = Math.max(1, Math.floor(Number(uses?.max) || 1));
  const per = String(uses?.per ?? "?");
  if (system === "pf2e") {
    // PF2e frequencies have no rests: a short rest reads as 10 minutes, a long rest as a day.
    const times = max === 1 ? "once" : max === 2 ? "twice" : `${max} times`;
    const period = per === "short-rest" ? "10 minutes" : per === "long-rest" ? "day" : per;
    return `${times} per ${period}`;
  }
  // dnd5e recovers on rests; an "encounter" is what a short rest ends.
  const period = per === "encounter" ? "short rest" : per.replace("-", " ");
  return `${max} per ${period}`;
}

/**
 * [{ label, text }] for entry.mechanics.structured in the system's wording. Malformed parts are
 * skipped (the pipeline already drops bad shapes; this is belt and braces). Pure, exported for tests.
 */
export function describeStructuredMechanics(structured, systemId = "pf2e") {
  if (!structured || typeof structured !== "object") return [];
  const system = systemOf(systemId);
  const rows = [];
  const push = (label, text) => { if (text) rows.push({ label, text }); };
  const damage = (Array.isArray(structured.damage) ? structured.damage : []).filter((part) => part?.dice);
  if (damage.length) push("Damage", `${damage.map((part) => `${withBonus(part.dice, part.bonus)}${part.type ? ` ${part.type}` : ""}`).join(" plus ")} damage`);
  if (structured.heal?.dice) push("Healing", `restores ${withBonus(structured.heal.dice, structured.heal.bonus)} ${system === "pf2e" ? "Hit Points" : "hit points"}`);
  if (structured.attack?.kind) {
    const kind = structured.attack.kind;
    push("Attack", system === "pf2e"
      ? kind === "spell" ? "spell attack roll against AC" : `${kind} Strike against AC`
      : kind === "spell" ? "spell attack against AC" : `${kind} weapon attack against AC`);
  }
  if (structured.save?.save) {
    const { save, dc: rawDc, basic } = structured.save;
    const dc = describeDc(rawDc, system);
    push("Save", system === "pf2e"
      ? `${basic ? "basic " : ""}${saveName(save, system)}${dc ? ` against ${dc}` : ""}`
      : `${saveName(save, system)}${dc ? `, ${dc}` : ""}${basic ? " (half damage on a success)" : ""}`);
  }
  for (const modifier of Array.isArray(structured.modifiers) ? structured.modifiers : []) {
    const value = Number(modifier?.value);
    if (!Number.isFinite(value) || !modifier?.selector) continue;
    const kind = value < 0 ? "penalty" : "bonus";
    // dnd5e has no bonus types: every bonus there is untyped (and stacks unless the GM says not).
    const typed = system === "pf2e" && modifier.type && modifier.type !== "untyped" ? `${modifier.type} ${kind}` : kind;
    push("Modifier", `${value >= 0 ? "+" : ""}${value} ${typed} to ${selectorName(modifier.selector, system)}${modifier.predicate ? ` (${modifier.predicate})` : ""}`);
  }
  if (structured.advantage?.on) {
    const text = `advantage on ${selectorName(structured.advantage.on, "dnd5e")}${structured.advantage.condition ? ` (${structured.advantage.condition})` : ""}`;
    push("Advantage", system === "dnd5e" ? text : `${text}: a dnd5e rule, ignored in PF2e`);
  }
  const range = Number(structured.range?.value);
  if (range > 0) push("Range", system === "pf2e" ? `${range} feet` : `${range} ft.`);
  const area = Number(structured.area?.value);
  if (structured.area?.type && area > 0) {
    const radius = system === "dnd5e" && (structured.area.type === "sphere" || structured.area.type === "cylinder") ? "-radius" : "";
    push("Area", `${area}-foot${radius} ${structured.area.type}`);
  }
  if (structured.condition?.id) {
    const { id, duration } = structured.condition;
    const value = Number(structured.condition.value);
    const valued = Number.isFinite(value) && value > 0;
    const name = system === "pf2e"
      ? `${String(id).replace(/-/g, " ")}${valued ? ` ${value}` : ""}`
      : `${titleCase(id)}${valued ? ` (level ${value})` : ""} condition`;
    push("Condition", `${name}${duration ? ` (${duration})` : ""}`);
  }
  if (structured.uses && (structured.uses.max !== undefined || structured.uses.per)) push(system === "pf2e" ? "Frequency" : "Uses", describeUses(structured.uses, system));
  return rows;
}

/**
 * What validator.js clamped, as plain lines. Where the report lives is being settled in parallel
 * (dev-systems), so every plausible place is read; a clamp is a string or { field|path, from, to,
 * reason|message }. Accepts a proposal or an updateProposal result. Pure, exported for tests.
 */
export function collectMechanicsClamps(source) {
  const proposal = source?.proposal && typeof source.proposal === "object" ? source.proposal : null;
  const lines = [];
  for (const item of [source, proposal]) {
    if (!item || typeof item !== "object") continue;
    const entry = item.entry && typeof item.entry === "object" ? item.entry : {};
    const lists = [item.clamps, item.clamped, item.mechanicsClamps, item.validation?.clamps, item.validatorClamps,
      entry.mechanics?.clamps, entry.mechanics?.structuredClamps, entry.metadata?.clamps];
    for (const list of lists) {
      for (const clamp of Array.isArray(list) ? list : []) {
        const line = describeClamp(clamp);
        if (line && !lines.includes(line)) lines.push(line);
      }
    }
  }
  return lines;
}

function describeClamp(clamp) {
  if (typeof clamp === "string") return clamp.trim();
  if (!clamp || typeof clamp !== "object") return "";
  const show = (value) => (typeof value === "string" ? value : JSON.stringify(value));
  const field = String(clamp.field ?? clamp.path ?? clamp.key ?? "");
  const hasFrom = clamp.from !== undefined && clamp.from !== null;
  const hasTo = clamp.to !== undefined;
  const change = hasFrom || hasTo ? `${hasFrom ? show(clamp.from) : "?"} -> ${hasTo && clamp.to !== null ? show(clamp.to) : "removed"}` : "";
  const why = String(clamp.reason ?? clamp.message ?? "");
  const head = [field, change].filter(Boolean).join(": ");
  return head && why ? `${head} (${why})` : head || why;
}

/** Details block: structured mechanics + the validator's clamps, or "". Pure, exported for tests. */
export function renderStructuredDetails(proposal, systemId = "pf2e") {
  const rows = describeStructuredMechanics(proposal?.entry?.mechanics?.structured, systemId);
  const clamps = collectMechanicsClamps(proposal);
  if (!rows.length && !clamps.length) return "";
  const list = rows.map((row) => `<dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.text)}</dd>`).join("");
  const clampList = clamps.length
    ? `<div class="gd-clamps"><p><i class="fas fa-scale-balanced"></i> The validator adjusted it to fit the tier and level:</p><ul>${clamps.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul></div>`
    : "";
  return `<div class="gd-structured"><h4>Game mechanics (${systemOf(systemId) === "dnd5e" ? "D&amp;D 5e" : "PF2e"})</h4>${list ? `<dl>${list}</dl>` : ""}${clampList}</div>`;
}

/**
 * The structured-mechanics part of the Edit form: one fieldset per part, blank rows to add a damage
 * part or modifier. Field names are "s.<part>.<field>" (rows "s.damage.0.dice"); buildProposalPatch
 * turns them back into mechanics.structured. Exported for tests.
 */
export function renderStructuredEditor(structured, systemId = "pf2e") {
  const system = systemOf(systemId);
  const s = structured && typeof structured === "object" ? structured : {};
  const input = (label, name, value, { type = "text", attrs = "", size = "" } = {}) =>
    `<label class="gd-s-field${size ? ` gd-s-${size}` : ""}"><span>${escapeHtml(label)}</span><input type="${type}" data-field="${name}" value="${escapeHtml(value ?? "")}"${attrs}></label>`;
  const select = (label, name, options, value, { blank = true } = {}) => {
    const current = value === undefined || value === null ? "" : String(value);
    const list = [...(blank ? [""] : []), ...options, ...(current && !options.includes(current) ? [current] : [])];
    return `<label class="gd-s-field"><span>${escapeHtml(label)}</span><select data-field="${name}">${list.map((option) => `<option value="${escapeHtml(option)}"${current === option ? " selected" : ""}>${escapeHtml(option || "(none)")}</option>`).join("")}</select></label>`;
  };
  const damage = [...(Array.isArray(s.damage) ? s.damage : []), {}].map((part, index) =>
    `<div class="gd-s-row">${input("Dice", `s.damage.${index}.dice`, part?.dice, { attrs: ' placeholder="2d6"', size: "short" })}${input("Type", `s.damage.${index}.type`, part?.type, { attrs: ' placeholder="fire"' })}${input("Bonus", `s.damage.${index}.bonus`, part?.bonus, { type: "number", size: "short" })}</div>`).join("");
  const modifiers = [...(Array.isArray(s.modifiers) ? s.modifiers : []), {}].map((modifier, index) => {
    // dnd5e has no bonus types: the type is kept as it was (or untyped) without a control.
    const type = system === "pf2e"
      ? select("Type", `s.modifiers.${index}.type`, MODIFIER_TYPES, modifier?.type ?? (modifier?.value !== undefined ? "untyped" : ""))
      : `<input type="hidden" data-field="s.modifiers.${index}.type" value="${escapeHtml(modifier?.type ?? "untyped")}">`;
    return `<div class="gd-s-row">${input("Value", `s.modifiers.${index}.value`, modifier?.value, { type: "number", size: "short" })}${type}${input("On", `s.modifiers.${index}.selector`, modifier?.selector, { attrs: ` placeholder="ac, attack, damage, ${system === "pf2e" ? "save:reflex" : "save:dex"}, skill:athletics"` })}${input("When", `s.modifiers.${index}.predicate`, modifier?.predicate, { attrs: ' placeholder="optional"' })}</div>`;
  }).join("");
  const advantage = system === "dnd5e"
    ? `<fieldset><legend>Advantage</legend><div class="gd-s-row">${input("On", "s.advantage.on", s.advantage?.on, { attrs: ' placeholder="attack, save:dex, skill:stealth, check:str"' })}${input("When", "s.advantage.condition", s.advantage?.condition, { attrs: ' placeholder="optional"' })}</div></fieldset>`
    : "";
  return `<details class="gd-structured-edit"><summary><i class="fas fa-dice-d20"></i> Game mechanics (${system === "dnd5e" ? "D&amp;D 5e" : "PF2e"})</summary>
    <p class="gd-hint">Leave a part empty to remove it. The validator clamps dice and bonuses to the tier and level when you save.</p>
    <fieldset><legend>Damage</legend>${damage}</fieldset>
    <fieldset><legend>Healing</legend><div class="gd-s-row">${input("Dice", "s.heal.dice", s.heal?.dice, { attrs: ' placeholder="1d8"', size: "short" })}${input("Bonus", "s.heal.bonus", s.heal?.bonus, { type: "number", size: "short" })}</div></fieldset>
    <fieldset><legend>Attack and save</legend><div class="gd-s-row">${select("Attack", "s.attack.kind", ATTACK_KINDS, s.attack?.kind)}${select("Save", "s.save.save", SAVES[system], s.save?.save)}${input("DC", "s.save.dc", s.save?.dc, { attrs: ' placeholder="class, spell or a number"', size: "short" })}<label class="gd-s-field gd-s-check"><input type="checkbox" data-field="s.save.basic"${s.save?.basic ? " checked" : ""}> <span>${system === "pf2e" ? "basic save" : "half on success"}</span></label></div></fieldset>
    <fieldset><legend>Modifiers</legend>${modifiers}</fieldset>
    ${advantage}
    <fieldset><legend>Range, area, condition, uses</legend>
      <div class="gd-s-row">${input("Range (ft)", "s.range.value", s.range?.value, { type: "number", size: "short" })}${select("Area", "s.area.type", AREA_TYPES[system], s.area?.type)}${input("Area size (ft)", "s.area.value", s.area?.value, { type: "number", size: "short" })}</div>
      <div class="gd-s-row">${input("Condition", "s.condition.id", s.condition?.id, { attrs: ` placeholder="${system === "pf2e" ? "frightened" : "prone"}"` })}${input("Value", "s.condition.value", s.condition?.value, { type: "number", size: "short" })}${input("Duration", "s.condition.duration", s.condition?.duration, { attrs: ' placeholder="1 round"' })}</div>
      <div class="gd-s-row">${input("Uses", "s.uses.max", s.uses?.max, { type: "number", size: "short" })}${select("per", "s.uses.per", USE_PERIODS, s.uses?.per)}</div>
    </fieldset>
  </details>`;
}

/**
 * mechanics.structured rebuilt from the "s.*" edit fields: { structured, errors }. `structured` is
 * null when every part is empty (the key is then removed). Fields the form does not show are kept
 * from `previous` (the advantage block on PF2e, a damage part's extra keys). Pure, exported for tests.
 */
export function buildStructuredFromFields(fields = {}, previous = null) {
  const errors = [];
  const prior = previous && typeof previous === "object" ? previous : {};
  const get = (key) => String(fields[`s.${key}`] ?? "").trim();
  const has = (key) => Object.hasOwn(fields, `s.${key}`);
  const number = (key, label, { integer = true, min = -Infinity, max = Infinity } = {}) => {
    const text = get(key);
    if (text === "") return undefined;
    const value = Number(text);
    if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
      errors.push(`${label} must be a whole number${Number.isFinite(min) ? ` of ${min} or more` : ""}${Number.isFinite(max) ? ` up to ${max}` : ""}.`);
      return undefined;
    }
    return value;
  };
  const dice = (key, label) => {
    const text = get(key).replace(/\s+/g, "");
    if (text && !DICE_PATTERN.test(text)) errors.push(`${label} must be dice like 2d6 (d4, d6, d8, d10, d12 or d20); put a flat bonus in Bonus.`);
    return text && DICE_PATTERN.test(text) ? text.toLowerCase() : "";
  };
  const rows = (part) => {
    const indexes = new Set();
    for (const key of Object.keys(fields)) {
      const match = new RegExp(`^s\\.${part}\\.(\\d+)\\.`).exec(key);
      if (match) indexes.add(Number(match[1]));
    }
    return [...indexes].sort((a, b) => a - b);
  };
  const out = { ...prior };

  const damage = [];
  for (const index of rows("damage")) {
    const label = `Damage part ${index + 1}`;
    const partDice = dice(`damage.${index}.dice`, `${label} dice`);
    const type = get(`damage.${index}.type`).toLowerCase();
    const bonus = number(`damage.${index}.bonus`, `${label} bonus`, { min: -20, max: 50 });
    if (!partDice) {
      if ((type || bonus !== undefined) && !get(`damage.${index}.dice`)) errors.push(`${label} needs dice (like 2d6).`);
      continue;
    }
    damage.push({ ...(Array.isArray(prior.damage) ? prior.damage[index] ?? {} : {}), dice: partDice, type: type || "untyped", ...(bonus !== undefined ? { bonus } : {}) });
    if (bonus === undefined) delete damage.at(-1).bonus;
  }
  if (rows("damage").length) { if (damage.length) out.damage = damage; else delete out.damage; }

  if (has("heal.dice")) {
    const healDice = dice("heal.dice", "Healing dice");
    const bonus = number("heal.bonus", "Healing bonus", { min: -20, max: 50 });
    if (healDice) out.heal = { dice: healDice, ...(bonus !== undefined ? { bonus } : {}) };
    else { if (bonus !== undefined) errors.push("Healing needs dice (like 1d8)."); delete out.heal; }
  }
  if (has("attack.kind")) {
    const kind = get("attack.kind");
    if (kind && !ATTACK_KINDS.includes(kind)) errors.push(`Attack must be one of: ${ATTACK_KINDS.join(", ")}.`);
    if (kind && ATTACK_KINDS.includes(kind)) out.attack = { kind };
    else delete out.attack;
  }
  if (has("save.save")) {
    const save = get("save.save").toLowerCase();
    const dcText = get("save.dc").toLowerCase();
    if (!save) {
      if (dcText) errors.push("Pick which save the DC is for.");
      delete out.save;
    } else if (![...SAVES.pf2e, ...SAVES.dnd5e].includes(save)) {
      errors.push(`Save must be one of: ${[...SAVES.pf2e, ...SAVES.dnd5e].join(", ")}.`);
    } else {
      let dc = dcText || "class";
      if (!DC_KINDS.includes(dc)) {
        const value = Number(dc);
        if (!Number.isInteger(value) || value < 5 || value > 60) { errors.push('The save DC must be "class", "spell" or a number from 5 to 60.'); dc = null; } else dc = value;
      }
      if (dc !== null) out.save = { save, dc, ...(fields["s.save.basic"] === "true" ? { basic: true } : {}) };
    }
  }
  const modifiers = [];
  for (const index of rows("modifiers")) {
    const label = `Modifier ${index + 1}`;
    const value = number(`modifiers.${index}.value`, `${label} value`, { min: -10, max: 10 });
    const selector = get(`modifiers.${index}.selector`).toLowerCase();
    const type = get(`modifiers.${index}.type`) || "untyped";
    const predicate = get(`modifiers.${index}.predicate`);
    if (value === undefined && !selector) continue;
    if (value === undefined) { if (!get(`modifiers.${index}.value`)) errors.push(`${label} needs a value (like 1 or -1).`); continue; }
    if (!selector || !SELECTOR_PATTERN.test(selector)) { errors.push(`${label} must say what it modifies: ac, attack, damage, perception, initiative, save:<save> or skill:<skill>.`); continue; }
    if (!MODIFIER_TYPES.includes(type)) { errors.push(`${label} type must be one of: ${MODIFIER_TYPES.join(", ")}.`); continue; }
    modifiers.push({ value, type, selector, ...(predicate ? { predicate } : {}) });
  }
  if (rows("modifiers").length) { if (modifiers.length) out.modifiers = modifiers; else delete out.modifiers; }
  if (has("advantage.on")) {
    const on = get("advantage.on").toLowerCase();
    const condition = get("advantage.condition");
    if (on && !ADVANTAGE_PATTERN.test(on)) errors.push("Advantage must be on: attack, save:<ability>, skill:<skill> or check:<ability>.");
    else if (on) out.advantage = { on, ...(condition ? { condition } : {}) };
    else delete out.advantage;
  }
  if (has("range.value")) {
    const value = number("range.value", "Range", { min: 1, max: 1000 });
    if (value !== undefined) out.range = { value, units: "ft" };
    else delete out.range;
  }
  if (has("area.type")) {
    const type = get("area.type");
    const value = number("area.value", "Area size", { min: 1, max: 500 });
    if (type && ![...AREA_TYPES.pf2e, ...AREA_TYPES.dnd5e].includes(type)) errors.push("Unknown area shape.");
    else if (type && value === undefined) { if (!get("area.value")) errors.push("An area needs its size in feet."); }
    else if (type) out.area = { type, value };
    else delete out.area;
  }
  if (has("condition.id")) {
    const id = get("condition.id").toLowerCase().replace(/\s+/g, "-");
    const value = number("condition.value", "Condition value", { min: 1, max: 10 });
    const duration = get("condition.duration");
    if (id) out.condition = { id, ...(value !== undefined ? { value } : {}), ...(duration ? { duration } : {}) };
    else delete out.condition;
  }
  if (has("uses.max") || has("uses.per")) {
    const max = number("uses.max", "Uses", { min: 1, max: 20 });
    const per = get("uses.per");
    if (per && !USE_PERIODS.includes(per)) errors.push(`Uses must be per: ${USE_PERIODS.join(", ")}.`);
    else if (max !== undefined || per) out.uses = { max: max ?? 1, per: per || "day" };
    else delete out.uses;
  }
  return { structured: Object.keys(out).length ? out : null, errors };
}

export function renderUnderTheHood(lastAnalysis, lastResult) {
  const summary = lastAnalysis?.diagnostics ?? {};
  const gateway = lastResult?.gatewayDiagnostics ?? null;
  const rows = [];
  const push = (label, value) => {
    if (value !== undefined && value !== null && value !== "") rows.push(`<li><strong>${escapeHtml(label)}:</strong> ${escapeHtml(String(value))}</li>`);
  };
  push("Module build", describeBuild(BUILD));
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
  if (rows.length <= 1 && !stageRows && !skippedEvents && !skippedProposals && !rejectedTags && !dropped) return "";
  return `<details class="gd-under-the-hood"><summary><i class="fas fa-gears"></i> Under the hood</summary>
    <ul>${rows.join("")}</ul>
    ${stageRows ? `<h4>Stages</h4><ul>${stageRows}</ul>` : ""}
    ${skippedEvents ? `<h4>Skipped events</h4><ul>${skippedEvents}</ul>` : ""}
    ${skippedProposals ? `<h4>Skipped proposals</h4><ul>${skippedProposals}</ul>` : ""}
    ${rejectedTags ? `<h4>Non-canonical tags</h4><ul>${rejectedTags}</ul>` : ""}
    ${dropped ? `<h4>Sentences the local analyzer skipped</h4><ul>${dropped}</ul>` : ""}
  </details>`;
}

/** A red (taboo) proposal: its entry's polarity. Exported for tests. */
export function isRedProposal(proposal) {
  return proposal?.entry?.metadata?.polarity === "red";
}

// The system a proposal's mechanics are worded for: the item it builds, else the world's system.
function proposalSystem(proposal, systemId) {
  const own = proposal?.entry?.gameItem?.system ?? proposal?.system ?? null;
  return own === "pf2e" || own === "dnd5e" ? own : systemId;
}

function currentSystemId() {
  return safe(() => globalThis.game?.system?.id ?? null, null);
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
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
