import {
  ACTOR_FLAG,
  GROWTH_EVENTS_FLAG,
  GROWTH_PROPOSALS_FLAG,
  MODULE_ID,
  REGISTRY_FLAG
} from "./constants.js";
import {
  cloneRegistry,
  createFeatureSource,
  emptyRegistry,
  normalizeEntry,
  registerEntry
} from "./lineage.js";
import { clearTestScenario, runTestScenario } from "./test-scenario.js";
import { validateClassEntry, validateConversion, validateSkillEntry } from "./validator.js";
import {
  generateSkillProposals,
  growthFlags,
  normalizeGrowthEvent
} from "./progression.js";
import { analyzeSessionNotes, validateAdapterEvents } from "./session-notes.js";

export class GrandDesignApi {
  constructor() {
    this._proposalAdapter = null;
  }

  validate(payload) {
    return validateConversion(payload);
  }

  async applyToActor(actor, payload) {
    this.#assertPf2eActor(actor);
    this.#assertGm();

    const result = validateConversion(payload);
    if (!result.valid) {
      throw new Error(`Grand Design conversion is invalid: ${result.errors.join(" ")}`);
    }
    const registry = cloneRegistry(actor.getFlag(MODULE_ID, REGISTRY_FLAG) ?? emptyRegistry());
    const normalized = {
      character: payload.character.trim(),
      classes: payload.classes.map((entry) => normalizeEntry("class", entry, registry)),
      skills: (payload.skills ?? []).map((entry) => normalizeEntry("skill", entry, registry)),
      source: "grand-design-ai",
      updatedAt: new Date().toISOString()
    };
    const approved = await this.#approveEntries(actor, normalized, registry);
    await actor.update({
      [`flags.${MODULE_ID}.${ACTOR_FLAG}`]: normalized,
      [`flags.${MODULE_ID}.${REGISTRY_FLAG}`]: approved.registry
    });
    Hooks.callAll("grand-design-ai.conversionApplied", actor, normalized);
    return { conversion: normalized, approved };
  }

  async combineSkills(actor, entry) {
    return this.#approveEvolution(actor, "skill", entry, "combine");
  }

  async upgradeSkill(actor, entry) {
    return this.#approveEvolution(actor, "skill", entry, "upgrade");
  }

  async upgradeClass(actor, entry) {
    return this.#approveEvolution(actor, "class", entry, "upgrade");
  }

  async createConversionJournal(payload) {
    this.#assertGm();
    const result = validateConversion(payload);
    if (!result.valid) {
      throw new Error(`Grand Design conversion is invalid: ${result.errors.join(" ")}`);
    }
    return JournalEntry.create({
      name: `Grand Design: ${payload.character}`,
      pages: [
        {
          name: "Conversion",
          type: "text",
          text: {
            content: renderConversionHtml(payload),
            format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML
          }
        }
      ]
    });
  }

  getActorConversion(actor) {
    return actor?.getFlag(MODULE_ID, ACTOR_FLAG) ?? null;
  }

  getActorRegistry(actor) {
    return actor?.getFlag(MODULE_ID, REGISTRY_FLAG) ?? emptyRegistry();
  }

  getGrowth(actor) {
    return growthFlags(actor);
  }

  setProposalAdapter(adapter) {
    if (adapter !== null && typeof adapter !== "function") {
      throw new Error("A proposal adapter must be a function or null.");
    }
    this._proposalAdapter = adapter;
  }

  async analyzeSessionNotes(actor, notes) {
    this.#assertPf2eActor(actor);
    this.#assertGm();
    if (typeof notes !== "string" || !notes.trim()) {
      throw new Error("Session notes must be non-empty text.");
    }
    const source = this._proposalAdapter ? "adapter" : "local";
    const candidateEvents = this._proposalAdapter
      ? validateAdapterEvents(await this._proposalAdapter({ actor, notes }))
      : analyzeSessionNotes(notes);
    const recorded = [];
    let proposals = this.getGrowth(actor).proposals;
    for (const event of candidateEvents) {
      const result = await this.recordGrowthEvent(actor, event);
      recorded.push(result.event);
      proposals = result.proposals;
    }
    return { source, events: recorded, proposals };
  }

  async recordGrowthEvent(actor, event) {
    this.#assertPf2eActor(actor);
    this.#assertGm();
    const growth = this.getGrowth(actor);
    const normalizedEvent = normalizeGrowthEvent(event, growth.events.length + 1);
    const events = [...growth.events, normalizedEvent];
    const modifier = actor.system?.skills?.acrobatics?.mod ?? 0;
    const generated = generateSkillProposals(events, this.getActorRegistry(actor), modifier);
    const known = new Map(growth.proposals.map((proposal) => [proposal.id, proposal]));
    for (const proposal of generated) {
      if (!known.has(proposal.id)) known.set(proposal.id, proposal);
    }
    const proposals = [...known.values()];
    await actor.update({
      [`flags.${MODULE_ID}.${GROWTH_EVENTS_FLAG}`]: events,
      [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: proposals
    });
    Hooks.callAll("grand-design-ai.growthEventRecorded", actor, normalizedEvent, proposals);
    return { event: normalizedEvent, proposals };
  }

  async approveSkillProposal(actor, id) {
    this.#assertPf2eActor(actor);
    this.#assertGm();
    const growth = this.getGrowth(actor);
    const proposal = growth.proposals.find((candidate) => candidate.id === id && candidate.status === "pending");
    if (!proposal) throw new Error(`No pending skill proposal exists for ${id}.`);
    const approved = await this.#approveEvolution(actor, "skill", proposal.entry, "origin");
    const proposals = growth.proposals.map((candidate) =>
      candidate.id === id ? { ...candidate, status: "approved", approvedAt: new Date().toISOString() } : candidate
    );
    await actor.update({ [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: proposals });
    Hooks.callAll("grand-design-ai.skillProposalApproved", actor, proposal, approved);
    return approved;
  }

  async runTestScenario() {
    this.#assertGm();
    if (game.system.id !== "pf2e") {
      throw new Error("The Grand Design test scenario requires the PF2e game system.");
    }
    return runTestScenario(this);
  }

  async clearTestScenario() {
    this.#assertGm();
    return clearTestScenario();
  }

  async #approveEvolution(actor, kind, entry, operation) {
    this.#assertPf2eActor(actor);
    this.#assertGm();
    const validation = kind === "class" ? validateClassEntry(entry) : validateSkillEntry(entry);
    if (!validation.valid) {
      throw new Error(`Grand Design ${kind} is invalid: ${validation.errors.join(" ")}`);
    }
    const registry = cloneRegistry(this.getActorRegistry(actor));
    const normalized = normalizeEntry(kind, entry, registry, operation);
    const approved = await this.#ensureFeatureItem(actor, kind, normalized, registry);
    await actor.update({ [`flags.${MODULE_ID}.${REGISTRY_FLAG}`]: approved.registry });
    Hooks.callAll("grand-design-ai.entryApproved", actor, kind, normalized);
    return approved;
  }

  async #approveEntries(actor, conversion, registry) {
    let nextRegistry = registry;
    const items = [];
    for (const entry of conversion.classes) {
      const approved = await this.#ensureFeatureItem(actor, "class", entry, nextRegistry);
      nextRegistry = approved.registry;
      items.push(approved);
    }
    for (const entry of conversion.skills) {
      const approved = await this.#ensureFeatureItem(actor, "skill", entry, nextRegistry);
      nextRegistry = approved.registry;
      items.push(approved);
    }
    return { registry: nextRegistry, items };
  }

  async #ensureFeatureItem(actor, kind, entry, registry) {
    const existing = actor.items.find(
      (item) => item.getFlag(MODULE_ID, "registryId") === entry.metadata.id
    );
    const item = existing ?? (await actor.createEmbeddedDocuments("Item", [createFeatureSource(kind, entry)]))[0];
    return {
      item,
      registry: registerEntry(kind, entry, item.id, registry)
    };
  }

  #assertGm() {
    if (!game.user?.isGM) {
      throw new Error("Only a GM can apply or publish Grand Design conversions.");
    }
  }

  #assertPf2eActor(actor) {
    if (game.system.id !== "pf2e") {
      throw new Error("Grand Design AI requires the PF2e game system.");
    }
    if (!actor?.documentName || actor.documentName !== "Actor") {
      throw new Error("A Foundry Actor is required.");
    }
  }
}

function renderConversionHtml(payload) {
  const classes = payload.classes
    .map((entry) => `<li>[${escapeHtml(entry.name)}] level ${entry.level} (${escapeHtml(entry.power_tier)})</li>`)
    .join("");
  const skills = (payload.skills ?? [])
    .map(
      (entry) =>
        `<li>[${escapeHtml(entry.name)}] - Tier ${entry.tier} - ${escapeHtml(entry.pf2e_equivalent)}</li>`
    )
    .join("");
  return `<h2>${escapeHtml(payload.character)}</h2><h3>Book Classes</h3><ul>${classes}</ul><h3>Skills</h3><ul>${skills}</ul>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
