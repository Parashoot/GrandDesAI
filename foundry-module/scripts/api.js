import {
  ACTOR_FLAG,
  GROWTH_EVENTS_FLAG,
  GROWTH_PROPOSALS_FLAG,
  LEVEL_PROGRESSION_FLAG,
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
  normalizeGrowthEvent,
  canApproveGeneratedProposal,
  levelProgressionFlags,
  progressionForEvent,
  resolveRest,
  spendGrantAllowance
} from "./progression.js";
import { analyzeSessionNotes, validateAdapterEvents } from "./session-notes.js";
import { createAiGatewayAdapter } from "./ai-gateway.js";

export class GrandDesignApi {
  constructor() {
    this._proposalAdapter = null;
  }

  validate(payload) {
    return validateConversion(payload);
  }

  async applyToActor(actor, payload) {
    this._assertPf2eActor(actor);
    this._assertGm();

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
    const approved = await this._approveEntries(actor, normalized, registry);
    await actor.update({
      [`flags.${MODULE_ID}.${ACTOR_FLAG}`]: normalized,
      [`flags.${MODULE_ID}.${REGISTRY_FLAG}`]: approved.registry
    });
    Hooks.callAll("grand-design-ai.conversionApplied", actor, normalized);
    return { conversion: normalized, approved };
  }

  async combineSkills(actor, entry) {
    return this._approveEvolution(actor, "skill", entry, "combine");
  }

  async upgradeSkill(actor, entry) {
    return this._approveEvolution(actor, "skill", entry, "upgrade");
  }

  async upgradeClass(actor, entry) {
    return this._approveEvolution(actor, "class", entry, "upgrade");
  }

  async createConversionJournal(payload) {
    this._assertGm();
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

  getLevelProgression(actor) {
    return levelProgressionFlags(actor);
  }

  setProposalAdapter(adapter) {
    if (adapter !== null && typeof adapter !== "function") {
      throw new Error("A proposal adapter must be a function or null.");
    }
    this._proposalAdapter = adapter;
  }

  setAiGateway(config) {
    this.setProposalAdapter(createAiGatewayAdapter(config));
  }

  async analyzeSessionNotes(actor, notes) {
    this._assertPf2eActor(actor);
    this._assertGm();
    if (typeof notes !== "string" || !notes.trim()) {
      throw new Error("Session notes must be non-empty text.");
    }
    const source = this._proposalAdapter ? "adapter" : "local";
    const adapterOutput = this._proposalAdapter ? await this._proposalAdapter({ actor, notes }) : null;
    const candidateEvents = this._proposalAdapter
      ? validateAdapterEvents(adapterOutput)
      : analyzeSessionNotes(notes);
    const recorded = [];
    let eventProposals = this.getGrowth(actor).proposals;
    for (const event of candidateEvents) {
      const result = await this.recordGrowthEvent(actor, event);
      recorded.push(result.event);
      eventProposals = result.proposals;
    }
    const modelProposals = this._proposalAdapter
      ? this._validateModelProposals(adapterOutput?.proposals ?? [], actor)
      : [];
    const proposals = mergeProposals(eventProposals, modelProposals);
    await actor.update({ [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: proposals });
    return { source, events: recorded, proposals };
  }

  async recordGrowthEvent(actor, event) {
    this._assertPf2eActor(actor);
    this._assertGm();
    const growth = this.getGrowth(actor);
    const normalizedEvent = normalizeGrowthEvent(event, growth.events.length + 1);
    const events = [...growth.events, normalizedEvent];
    const levelProgression = this.getLevelProgression(actor);
    const updatedProgression = {
      ...levelProgression,
      progress: levelProgression.progress + progressionForEvent(normalizedEvent)
    };
    const modifier = actor.system?.skills?.acrobatics?.mod ?? 0;
    const generated = generateSkillProposals(events, this.getActorRegistry(actor), modifier);
    const known = new Map(growth.proposals.map((proposal) => [proposal.id, proposal]));
    for (const proposal of generated) {
      if (!known.has(proposal.id)) known.set(proposal.id, proposal);
    }
    const proposals = [...known.values()];
    await actor.update({
      [`flags.${MODULE_ID}.${GROWTH_EVENTS_FLAG}`]: events,
      [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: proposals,
      [`flags.${MODULE_ID}.${LEVEL_PROGRESSION_FLAG}`]: updatedProgression
    });
    Hooks.callAll("grand-design-ai.growthEventRecorded", actor, normalizedEvent, proposals);
    return { event: normalizedEvent, proposals };
  }

  async approveSkillProposal(actor, id) {
    return this.approveProposal(actor, id);
  }

  async approveProposal(actor, id) {
    this._assertPf2eActor(actor);
    this._assertGm();
    const growth = this.getGrowth(actor);
    const proposal = growth.proposals.find((candidate) => candidate.id === id && candidate.status === "pending");
    if (!proposal) throw new Error(`No pending skill proposal exists for ${id}.`);
    const levelProgression = this.getLevelProgression(actor);
    const eligibility = canApproveGeneratedProposal(levelProgression, proposal);
    if (!eligibility.valid) throw new Error(eligibility.error);
    const approved = await this._approveEvolution(
      actor,
      proposal.kind ?? "skill",
      proposal.entry,
      proposal.entry.metadata?.lineage?.operation ?? "origin"
    );
    const proposals = growth.proposals.map((candidate) =>
      candidate.id === id ? { ...candidate, status: "approved", approvedAt: new Date().toISOString() } : candidate
    );
    await actor.update({
      [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: proposals,
      [`flags.${MODULE_ID}.${LEVEL_PROGRESSION_FLAG}`]: spendGrantAllowance(levelProgression)
    });
    Hooks.callAll("grand-design-ai.skillProposalApproved", actor, proposal, approved);
    return approved;
  }

  async runTestScenario() {
    this._assertGm();
    if (game.system.id !== "pf2e") {
      throw new Error("The Grand Design test scenario requires the PF2e game system.");
    }
    return runTestScenario(this);
  }

  async resolveLevelRest(actor, options) {
    this._assertPf2eActor(actor);
    this._assertGm();
    const result = resolveRest(this.getLevelProgression(actor), options);
    await actor.update({ [`flags.${MODULE_ID}.${LEVEL_PROGRESSION_FLAG}`]: result.progression });
    Hooks.callAll("grand-design-ai.levelsResolved", actor, result);
    return result;
  }

  async clearTestScenario() {
    this._assertGm();
    return clearTestScenario();
  }

  _validateModelProposals(proposals, actor) {
    if (!Array.isArray(proposals)) throw new Error("AI gateway proposals must be an array.");
    const registry = this.getActorRegistry(actor);
    return proposals.map((proposal) => {
      if (!proposal || !["skill", "class"].includes(proposal.kind)) {
        throw new Error("AI gateway proposal kind must be skill or class.");
      }
      const validation = proposal.kind === "class"
        ? validateClassEntry(proposal.entry)
        : validateSkillEntry(proposal.entry);
      if (!validation.valid) {
        throw new Error(`Invalid AI ${proposal.kind} proposal: ${validation.errors.join(" ")}`);
      }
      const registryId = `${proposal.kind}:${slugify(proposal.entry.name)}`;
      const bucket = proposal.kind === "class" ? registry.classes : registry.skills;
      if (bucket[registryId]) {
        throw new Error(`AI proposed an already approved ${proposal.kind}: ${proposal.entry.name}.`);
      }
      return {
        id: proposal.id ?? `proposal:ai-${registryId}`,
        kind: proposal.kind,
        status: "pending",
        evidence: Array.isArray(proposal.evidence) ? proposal.evidence : [],
        entry: proposal.entry,
        source: "ai-gateway"
      };
    });
  }

  async _approveEvolution(actor, kind, entry, operation) {
    this._assertPf2eActor(actor);
    this._assertGm();
    const validation = kind === "class" ? validateClassEntry(entry) : validateSkillEntry(entry);
    if (!validation.valid) {
      throw new Error(`Grand Design ${kind} is invalid: ${validation.errors.join(" ")}`);
    }

    const registry = cloneRegistry(this.getActorRegistry(actor));
    const normalized = normalizeEntry(kind, entry, registry, operation);
    const approved = await this._ensureFeatureItem(actor, kind, normalized, registry);
    await actor.update({ [`flags.${MODULE_ID}.${REGISTRY_FLAG}`]: approved.registry });
    Hooks.callAll("grand-design-ai.entryApproved", actor, kind, normalized);
    return approved;
  }

  async _approveEntries(actor, conversion, registry) {
    let nextRegistry = registry;
    const items = [];
    for (const entry of conversion.classes) {
      const approved = await this._ensureFeatureItem(actor, "class", entry, nextRegistry);
      nextRegistry = approved.registry;
      items.push(approved);
    }
    for (const entry of conversion.skills) {
      const approved = await this._ensureFeatureItem(actor, "skill", entry, nextRegistry);
      nextRegistry = approved.registry;
      items.push(approved);
    }
    return { registry: nextRegistry, items };
  }

  async _ensureFeatureItem(actor, kind, entry, registry) {
    const existing = actor.items.find(
      (item) => item.getFlag(MODULE_ID, "registryId") === entry.metadata.id
    );
    const item = existing ?? (await actor.createEmbeddedDocuments("Item", [createFeatureSource(kind, entry)]))[0];
    return {
      item,
      registry: registerEntry(kind, entry, item.id, registry)
    };
  }

  _assertGm() {
    if (!game.user?.isGM) {
      throw new Error("Only a GM can apply or publish Grand Design conversions.");
    }
  }

  _assertPf2eActor(actor) {
    if (game.system.id !== "pf2e") {
      throw new Error("Grand Design AI requires the PF2e game system.");
    }
    if (!actor?.documentName || actor.documentName !== "Actor") {
      throw new Error("A Foundry Actor is required.");
    }
  }
}

function mergeProposals(existing, additions) {
  const merged = new Map(existing.map((proposal) => [proposal.id, proposal]));
  for (const proposal of additions) {
    if (!merged.has(proposal.id)) merged.set(proposal.id, proposal);
  }
  return [...merged.values()];
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
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
