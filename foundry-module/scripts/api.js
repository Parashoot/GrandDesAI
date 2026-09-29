import {
  ACTOR_FLAG,
  CLASS_EVOLUTION_LEVELS,
  COMBINATIONS_FLAG,
  CONSOLIDATIONS_FLAG,
  GROWTH_EVENTS_FLAG,
  GROWTH_PROPOSALS_FLAG,
  HORROR_RANK_FLAG,
  HORROR_RANK_POINTS_PER_RED_APPROVAL,
  LEVEL_PROGRESSION_FLAG,
  MODULE_ID,
  REGISTRY_FLAG
} from "./constants.js";
import { applyHorrorRankIncrement, normalizeHorrorRank } from "./horror-rank.js";
import { checkClassErosion } from "./class-erosion.js";
import { applyRevivalPenalty } from "./revival-penalty.js";
import {
  cloneRegistry,
  createCombinationSource,
  createFeatureSource,
  createTitleSource,
  emptyRegistry,
  isActiveEntry,
  markSuperseded,
  normalizeEntry,
  registerEntry
} from "./lineage.js";
import {
  assessIntentionalBreadth,
  computeMergeFocus,
  mergeClassEntry,
  mergeClassMechanics,
  mergedSystemChassis,
  pickMergeSources
} from "./class-merging.js";
import {
  computeEvolutionPressure,
  evolveSkillEntry,
  growEvolvedMechanics,
  resolveEvolvedTier,
  uniqueRegistryId
} from "./skill-evolution.js";
import { VICE_TAGS, VICE_TAXONOMY } from "./vice-taxonomy.js";
import { buildCombinationGrowthEvent, buildCombinationSkill } from "./combination-skills.js";
import { clearTestScenario, runTestScenario } from "./test-scenario.js";
import { clearAiTestScenario, runAiTestScenario } from "./ai-test-scenario.js";
import { validateClassEntry, validateConversion, validateSkillEntry, validateTitleEntry } from "./validator.js";
import {
  generateSkillProposals,
  generateCapstoneProposal,
  generateClassEvolutionProposal,
  growthFlags,
  isCapstoneLevel,
  normalizeGrowthEvent,
  canApproveGeneratedProposal,
  progressionForEvent,
  levelProgressionFlags,
  resolveRest,
  spendCapstoneAllowance,
  spendGrantAllowance
} from "./progression.js";
import { attributeEventsToActor, classifyActorName, explainSessionNotes, proposalCitesOnlyOthers, validateAdapterEvents } from "./session-notes.js";
import { createAiGatewayAdapter, createGatewayAdapter } from "./ai-gateway.js";
import { normalizeGatewayConfig, pendingProposalCap } from "./ai/gateway-config.js";
import { characterDc, characterLevel, checkModifier, resolveRollCheck } from "./mechanics.js";
import { namingClassFor } from "./naming.js";
import {
  applyThemeMap,
  generateEmergentProposals,
  isCanonicalTag,
  listThemes,
  normalizeEmergentThemeState,
  observeThemes,
  setThemeMapping,
  splitTagsAndThemes,
  themeLabel,
  themeMapFromState,
  themeSlug
} from "./emergent-themes.js";
import { getSystemAdapter, isSupportedSystem, supportedSystemIds } from "./systems/index.js";
import { populate as runPopulate } from "./populate.js";

export class GrandDesignApi {
  constructor() {
    this._proposalAdapter = null;
    this._populateAdapter = null;
    // Dynamic tag reweighting (see tag-weighting.js/tag-weighting-settings.js): defaults to "every
    // tag weighs 1x" so GrandDesignApi stays fully Foundry-independent (and testable in plain
    // Node) without a provider wired in. main.js wires this to a world-settings-backed provider at
    // init, the same pluggable-adapter pattern setProposalAdapter/setPopulateAdapter already use.
    this._tagWeightsProvider = () => ({});
    // AI gateway v2: config + emergent-theme store, both pluggable for the same reason (main.js
    // wires Foundry settings; tests get defaults / an in-memory store).
    this._gatewayConfigProvider = () => ({});
    let themeState = { themes: {} };
    this._emergentThemeStore = {
      get: () => themeState,
      set: async (next) => {
        themeState = next;
      }
    };
    // Board 78ead05c: actor -> the long task running on it ("analyze", "rest", ...). Keyed by the
    // actor's uuid when it has one (the same Foundry actor reached from two sheets), else by the
    // object itself (plain test/harness actors).
    this._busyActors = new Map();
  }

  /** True while a long Grand Design task (analyze, re-analyze, author, suggest, approve, rest...) runs on this actor. */
  isBusy(actor) {
    return this._busyActors.has(busyKey(actor));
  }

  /** The label of the task running on this actor ("analyze", "rest", ...), or null. */
  getBusyTask(actor) {
    return this._busyActors.get(busyKey(actor)) ?? null;
  }

  // One long task per actor. A second one (a double click on "Analyze" while the first is still
  // waiting on the AI) is refused with an Error whose message starts "busy:" instead of running
  // twice: two analyses of the same notes double-recorded events and progress, and any write made
  // while an analysis was in flight was overwritten when the analysis saved its own snapshot.
  async _withActorLock(actor, label, fn) {
    const key = busyKey(actor);
    const running = this._busyActors.get(key);
    if (running) {
      throw new Error(`busy: ${actor?.name ?? "This character"} is still running "${running}"; wait for it to finish before "${label}".`);
    }
    this._busyActors.set(key, label);
    globalThis.Hooks?.callAll?.("grand-design-ai.busyChanged", actor, true, label);
    try {
      return await fn();
    } finally {
      this._busyActors.delete(key);
      globalThis.Hooks?.callAll?.("grand-design-ai.busyChanged", actor, false, label);
    }
  }

  // Every AI call made on the GM's behalf gets an overall deadline on top of the transport's
  // per-request timeout: a pipeline of many requests (chunks, repairs, retries) could otherwise keep
  // the actor busy for a very long time. On expiry the caller's usual fallback runs with the reason
  // (the local analyzer for notes, the template for a milestone). The late answer is ignored.
  async _callAdapterWithDeadline(call, what) {
    const ms = aiDeadlineMs(this.getGatewayConfig());
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the AI ${what} did not finish within its ${formatDuration(ms)} overall deadline`)), ms);
    });
    const work = Promise.resolve().then(call);
    work.catch(() => {}); // a late failure after the deadline must not surface as an unhandled rejection
    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  validate(payload) {
    return validateConversion(payload);
  }

  async applyToActor(actor, payload) {
    this._assertSupportedSystemActor(actor);
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
    // Every red-polarity Class/Skill approved here (Horror Rank: constants.js#HORROR_RANK_*,
    // horror-rank.js) adds corruption points, which may in turn dock levels off the actor's own
    // strongest standard-polarity Class -- folded into this same actor.update call.
    let finalRegistry = approved.registry;
    let horrorRank = this.getHorrorRank(actor);
    const dockedFrom = [];
    for (const entry of [...normalized.classes, ...normalized.skills]) {
      if (entry.metadata?.polarity !== "red") continue;
      const result = applyHorrorRankIncrement(finalRegistry, horrorRank, HORROR_RANK_POINTS_PER_RED_APPROVAL);
      finalRegistry = result.registry;
      horrorRank = result.horrorRank;
      dockedFrom.push(...result.dockedFrom);
    }
    await actor.update({
      [`flags.${MODULE_ID}.${ACTOR_FLAG}`]: normalized,
      [`flags.${MODULE_ID}.${REGISTRY_FLAG}`]: finalRegistry,
      [`flags.${MODULE_ID}.${HORROR_RANK_FLAG}`]: horrorRank
    });
    Hooks.callAll("grand-design-ai.conversionApplied", actor, normalized);
    if (dockedFrom.length) Hooks.callAll("grand-design-ai.horrorRankLevelsDocked", actor, dockedFrom);
    return { conversion: normalized, approved: { ...approved, registry: finalRegistry } };
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

  async combineClasses(actor, entry) {
    return this._approveEvolution(actor, "class", entry, "combine");
  }

  /**
   * Computes (but does not approve) a merged Class entry from two-or-more of the actor's own
   * approved registry Classes -- name, power_tier, and lineage all derived from the sources
   * themselves per class-merging.js's rules (specialization vs. generalization, and the
   * fused-phrase / comma / legendary-title naming convention). Inspect or edit the result, then
   * hand it to `combineClasses(actor, entry)` to actually approve and create the Item.
   *
   * Pass `intentional: true` when the evidence shows the character deliberately pursued breadth
   * across these sources on purpose (not accidental dabbling) -- a generalist blend that would
   * otherwise be capped at standard power instead climbs a tier above its sources' own average.
   * `polarity`/`malignance` are normally auto-detected by contagion from red sources (see
   * class-merging.js#mergeClassEntry); pass them explicitly to override that.
   *
   * "Off-classing": automatically reads the actor's own current overall Grand Design level
   * (getLevelProgression) and hands it to mergeClassEntry as `actorLevel`, so a Class evolution
   * attempted off the Grand Design's own cadence (CLASS_EVOLUTION_LEVELS -- 20/30/50) is still
   * computed and returned, just capped at its sources' own tier instead of climbing further, and
   * flagged `offCycleEvolution: true` on the result. This mirrors, as a soft penalty rather than a
   * hard block, the same on-cadence check progression.js#canApproveGeneratedProposal already
   * enforces (as an outright block) for AI-generated Class proposals.
   */
  buildClassMergePreview(actor, { sourceIds, level, gameItem, mechanics, tags, rationale, systemChassis, intentional, polarity, malignance, name }) {
    const registry = this.getActorRegistry(actor);
    if (!Array.isArray(sourceIds) || sourceIds.length < 2) {
      throw new Error("Merging a Class requires at least two sourceIds.");
    }
    const sourceClasses = sourceIds.map((id) => {
      const source = registry.classes[id];
      if (!source) throw new Error(`No approved Class ${id} exists on this actor.`);
      return source;
    });
    const actorLevel = this.getLevelProgression(actor).level;
    // existingIds/existingNames: class-merging.js keeps a merged name from colliding with a Class
    // the actor already has.
    return mergeClassEntry({
      sourceClasses, level, gameItem, mechanics, tags, rationale, systemChassis, intentional, polarity, malignance, actorLevel, name,
      existingIds: registry.classes ?? {},
      existingNames: Object.values(registry.classes ?? {}).map((entry) => entry?.name).filter(Boolean)
    });
  }

  /**
   * Skill evolution (canon: [Power Strike] becomes [Minotaur Punch]). A GM ADVISORY read -- it
   * mutates nothing -- reporting, for every approved Skill on the actor (or just `sourceId` if
   * given), how much pressure the actor's own growth history is putting on it to evolve: the
   * weighted evidence accumulated *since the Skill was approved*, which recorded moments qualify as
   * the defining crisis canon's evolutions turn on, and whether both halves of that trigger are
   * actually met. See skill-evolution.js#computeEvolutionPressure for exactly what counts.
   */
  checkSkillEvolutionReadiness(actor, sourceId = null) {
    const registry = this.getActorRegistry(actor);
    // Only this character's own deeds push its Skills (events recorded before per-character
    // attribution may name someone else).
    const events = this._ownEvents(actor);
    const tagWeights = this.getTagWeights();
    // A superseded Skill (already evolved) is history; it is only reported when asked for by id.
    const entries = sourceId
      ? [[sourceId, registry.skills?.[sourceId]]].filter(([, entry]) => entry)
      : Object.entries(registry.skills ?? {}).filter(([, entry]) => isActiveEntry(entry));
    if (sourceId && !entries.length) {
      throw new Error(`No approved Skill ${sourceId} exists on this actor.`);
    }
    return entries.map(([skillId, entry]) => ({
      skillId,
      name: entry.name,
      tier: entry.tier,
      ...computeEvolutionPressure(entry, events, { tagWeights })
    }));
  }

  /**
   * Computes (but does not approve) the evolved form of one of the actor's own approved Skills --
   * name, tier, and lineage all derived from the source Skill plus the growth evidence recorded
   * since it was approved, exactly the way buildClassMergePreview derives a merged Class. Inspect
   * or edit the result, then hand it to `upgradeSkill(actor, entry)` to actually approve it and
   * create the Item.
   *
   * Like off-classing, an unearned evolution is softly penalized rather than blocked: with no
   * defining moment behind it (or with the practice behind it still too thin) the Skill still
   * evolves, it just holds at its current tier and is named as the plain refinement it actually is
   * ("Greater <Source>") rather than transforming. Pass `gameItem`/`mechanics` to say what the
   * evolved Skill does; omit them and the source's own are carried forward as a starting draft,
   * since this module never invents mechanics on a GM's behalf.
   */
  buildSkillEvolutionPreview(actor, { sourceId, name, gameItem, mechanics, tags, rationale, systemEquivalent, since, polarity, malignance }) {
    const registry = this.getActorRegistry(actor);
    const sourceSkill = registry.skills?.[sourceId];
    if (!sourceSkill) throw new Error(`No approved Skill ${sourceId} exists on this actor.`);
    return evolveSkillEntry({
      sourceSkill,
      events: this.getGrowth(actor).events,
      tagWeights: this.getTagWeights(),
      since,
      name,
      gameItem,
      mechanics,
      tags,
      rationale,
      systemEquivalent,
      polarity,
      malignance,
      // skill-evolution.js keeps the evolved name from colliding with a Skill the actor already has.
      existingIds: registry.skills ?? {},
      existingNames: Object.values(registry.skills ?? {}).map((entry) => entry?.name).filter(Boolean)
    });
  }

  /**
   * Board ebcc3f03: the Skills whose readiness (checkSkillEvolutionReadiness) now has BOTH halves of
   * canon's trigger -- enough practice since approval and a defining moment -- and that have no
   * evolution already pending. Run after every analysis and rest; listed on those results as
   * `evolutionReady: [{ skillId, name, pressure }]` and announced with the hook
   * `grand-design-ai.evolutionReady(actor, list)` when the list is not empty.
   */
  _evolutionReady(actor) {
    const pending = new Set(
      this.getGrowth(actor).proposals
        .filter((proposal) => proposal.status === "pending" && proposal.entry?.metadata?.lineage?.operation === "upgrade")
        .flatMap((proposal) => proposal.entry.metadata.lineage.sources ?? [])
    );
    return this.checkSkillEvolutionReadiness(actor)
      .filter((row) => row.hasCatalyst && !pending.has(row.skillId))
      .map(({ skillId, name, tier, ...pressure }) => ({ skillId, name, tier, pressure }));
  }

  _announceEvolutionReady(actor) {
    let ready = [];
    try {
      ready = this._evolutionReady(actor);
    } catch (error) {
      // An advisory read; it must never cost the GM the analysis or rest it rides on.
      console.warn(`${MODULE_ID} | could not check Skill evolution readiness`, error);
      return [];
    }
    if (ready.length) globalThis.Hooks?.callAll?.("grand-design-ai.evolutionReady", actor, ready);
    return ready;
  }

  // This character's own recorded events (not those naming another character).
  _ownEvents(actor) {
    const names = this._actorNames(actor);
    return this.getGrowth(actor).events.filter((event) => classifyActorName(event.actorName, names) !== "other");
  }

  /**
   * Everything the character holds in the Grand Design registry, for the registry panel:
   * `{ classes, skills, titles }`, each row `{ id, name, kind, tier | level, power_tier?, polarity,
   * status: "active" | "superseded", supersededBy?, lineage: { operation, sources, sourceNames,
   * rationale }, effect, itemId, evolutionReady? }`. Superseded entries are included (the UI dims
   * them); `sourceNames` resolves lineage ids to names so nothing has to show a registry id.
   */
  getOwnedEntries(actor) {
    const registry = this.getActorRegistry(actor);
    let ready = new Set();
    try {
      ready = new Set(this._evolutionReady(actor).map((row) => row.skillId));
    } catch {
      // advisory only
    }
    const nameOf = (bucket, id) => registry[bucket]?.[id]?.name ?? id;
    const row = (kind, bucket, id, entry) => {
      const lineage = entry.metadata?.lineage ?? {};
      const sources = Array.isArray(lineage.sources) ? lineage.sources : [];
      return {
        id,
        name: entry.name,
        kind,
        ...(kind === "class" ? { level: entry.level ?? null, power_tier: entry.power_tier ?? null } : {}),
        ...(kind === "skill" ? { tier: entry.tier ?? null } : {}),
        polarity: entry.metadata?.polarity === "red" ? "red" : "standard",
        ...(entry.metadata?.polarity === "red" && entry.metadata?.malignance ? { malignance: entry.metadata.malignance } : {}),
        status: isActiveEntry(entry) ? "active" : "superseded",
        ...(entry.supersededBy ? { supersededBy: entry.supersededBy, supersededByName: nameOf(bucket, entry.supersededBy) } : {}),
        lineage: {
          operation: lineage.operation ?? "origin",
          sources,
          sourceNames: sources.map((sourceId) => nameOf(bucket, sourceId)),
          rationale: lineage.rationale ?? ""
        },
        effect: kind === "title" ? entry.achievement ?? "" : entry.mechanics?.effect ?? "",
        itemId: entry.itemId ?? null,
        ...(kind === "skill" ? { evolutionReady: ready.has(id) } : {}),
        ...(entry.evolution ? { evolution: entry.evolution } : {}),
        ...(entry.offCycleEvolution !== undefined ? { offCycleEvolution: entry.offCycleEvolution } : {})
      };
    };
    const list = (kind, bucket) => Object.entries(registry[bucket] ?? {}).map(([id, entry]) => row(kind, bucket, id, entry));
    return { classes: list("class", "classes"), skills: list("skill", "skills"), titles: list("title", "titles") };
  }

  /**
   * Board ebcc3f03: evolve one of the character's own approved Skills into a PENDING proposal.
   * The AI writes it first (adapter.authorAdvanced, operation "upgrade": new name, mechanics that
   * grow the source's, rationale citing the defining moments); when there is no such entry point,
   * no provider, a failure or nothing usable, skill-evolution.js#evolveSkillEntry builds it from the
   * rules with grown mechanics (growEvolvedMechanics) and the reason is stated. Either way the rules
   * own the numbers: tier = source tier + 1 (max 3) with a catalyst, held without one; the registry
   * id and lineage { operation: "upgrade", sources: [skillId] } are set here, not trusted.
   * Approving it (approveProposal) supersedes the source. Needs no grant allowance: the evidence
   * that made the Skill ready is what earned it. Returns { proposal, usedFallback, reason, pressure }.
   */
  async requestSkillEvolution(actor, skillId) {
    this._assertSupportedSystemActor(actor);
    this._assertGm();
    return this._withActorLock(actor, "evolve", () => this._requestSkillEvolution(actor, skillId));
  }

  async _requestSkillEvolution(actor, skillId) {
    const registry = this.getActorRegistry(actor);
    const source = registry.skills?.[skillId];
    if (!source) throw new Error(`No approved Skill ${skillId} exists on ${actor.name ?? "this character"}.`);
    if (!isActiveEntry(source)) {
      throw new Error(`[${source.name}] was already evolved (superseded by ${registry.skills?.[source.supersededBy]?.name ?? source.supersededBy ?? "a later Skill"}).`);
    }
    const growth = this.getGrowth(actor);
    const pendingSame = growth.proposals.find((proposal) => proposal.status === "pending"
      && proposal.entry?.metadata?.lineage?.operation === "upgrade"
      && (proposal.entry.metadata.lineage.sources ?? []).includes(skillId));
    if (pendingSame) {
      throw new Error(`An evolution of [${source.name}] is already pending ("${pendingSame.entry?.name}"); approve or reject it first.`);
    }
    const systemId = game.system?.id;
    const ownEvents = this._ownEvents(actor);
    const tagWeights = this.getTagWeights();
    const pressure = computeEvolutionPressure(source, ownEvents, { tagWeights });
    const evolvedTier = resolveEvolvedTier(source.tier, { hasCatalyst: pressure.hasCatalyst });
    const rejected = rejectedProposalNames(growth.proposals);
    const existingNames = [...Object.values(registry.skills ?? {}).map((entry) => entry?.name).filter(Boolean)];
    const fallbackEntry = evolveSkillEntry({
      sourceSkill: source,
      events: ownEvents,
      tagWeights,
      existingIds: registry.skills ?? {},
      existingNames,
      mechanics: growEvolvedMechanics(source.mechanics, { fromTier: source.tier, toTier: evolvedTier, hasCatalyst: pressure.hasCatalyst, systemId })
    });
    const matchedIds = new Set(pressure.matchedEventIds);
    const sourcePayload = {
      id: skillId,
      name: source.name,
      kind: "skill",
      tier: source.tier,
      effect: source.mechanics?.effect ?? "",
      tags: source.metadata?.tags ?? [],
      polarity: source.metadata?.polarity === "red" ? "red" : "standard",
      definingMoments: pressure.definingMoments.map((moment) => moment.summary || moment.outcome)
    };
    const ai = await this._authorAdvanced(actor, {
      operation: "upgrade",
      sources: [sourcePayload],
      events: ownEvents.filter((event) => matchedIds.has(event.id)).slice(-15),
      systemId,
      wantedKind: "skill",
      label: `[${source.name}]`,
      shape: (candidate, notes) => this._shapeEvolvedEntry(candidate, { source, skillId, fallbackEntry, evolvedTier, registry, rejected, notes })
    });
    const usedFallback = !ai.entry;
    const entry = ai.entry ?? fallbackEntry;
    const notReady = pressure.hasCatalyst ? null : `not ready yet (${pressure.definingMoments.length ? `${pressure.evidenceWeight} of ${pressure.evidenceThreshold} weighted evidence` : "no defining moment"}), so it refines and holds at tier ${evolvedTier}`;
    const reason = [usedFallback ? ai.reason : null, ...(ai.notes ?? []), notReady].filter(Boolean).join("; ") || null;
    const proposal = {
      id: uniqueRegistryId(`proposal:evolve-${slugify(skillId.replace(/^skill:/, ""))}`, growth.proposals.map((candidate) => candidate.id)),
      kind: "skill",
      status: "pending",
      source: "skill-evolution",
      systemId,
      requestedBy: "gm",
      requestedAt: new Date().toISOString(),
      evidence: pressure.definingMoments.map((moment) => moment.id).filter(Boolean),
      lineage: { operation: "upgrade", sources: [skillId] },
      entry,
      ...(usedFallback ? { usedFallback: true, fallbackReason: ai.reason } : { authoredBy: "ai-gateway" })
    };
    await actor.update({ [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: [...growth.proposals, proposal] });
    globalThis.Hooks?.callAll?.("grand-design-ai.evolutionRequested", actor, proposal);
    return { proposal, usedFallback, reason, pressure };
  }

  /**
   * Board 7b616fea: merge two or more of the character's own active Classes into a PENDING Class
   * proposal (conversion rules 2.3/2.4). AI first (adapter.authorAdvanced, operation "combine"),
   * class-merging.js#mergeClassEntry with merged mechanics as the stated-reason fallback. The rules
   * own the numbers either way: the focus score (plus `intentional`, read from the evidence by
   * assessIntentionalBreadth unless passed) decides the power tier, off-cadence merges are capped,
   * red is contagious, the registry id and lineage { operation: "combine", sources: classIds } are
   * set here. `options.level` overrides the merged level (default: the highest source level).
   * Approving it supersedes every source. Returns { proposal, usedFallback, reason, focus, intentional }.
   */
  async requestClassMerge(actor, classIds, options = {}) {
    this._assertSupportedSystemActor(actor);
    this._assertGm();
    return this._withActorLock(actor, "merge", async () => {
      const result = await this._buildMergeProposal(actor, { classIds, ...options });
      const proposals = this.getGrowth(actor).proposals;
      await actor.update({ [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: [...proposals, result.proposal] });
      globalThis.Hooks?.callAll?.("grand-design-ai.classMergeRequested", actor, result.proposal);
      return result;
    });
  }

  async _buildMergeProposal(actor, { classIds, level, intentional, milestoneLevel = null, proposalId = null } = {}) {
    const ids = [...new Set(Array.isArray(classIds) ? classIds : [])];
    if (ids.length < 2) throw new Error("Merging Classes needs at least two different Class ids.");
    const registry = this.getActorRegistry(actor);
    const sourceClasses = ids.map((id) => {
      const entry = registry.classes?.[id];
      if (!entry) throw new Error(`No approved Class ${id} exists on ${actor.name ?? "this character"}.`);
      if (!isActiveEntry(entry)) throw new Error(`[${entry.name}] was already merged into ${registry.classes?.[entry.supersededBy]?.name ?? entry.supersededBy ?? "another Class"}.`);
      return entry;
    });
    const growth = this.getGrowth(actor);
    const pendingSame = growth.proposals.find((proposal) => proposal.status === "pending"
      && proposal.entry?.metadata?.lineage?.operation === "combine"
      && sameIds(proposal.entry.metadata.lineage.sources ?? [], ids));
    if (pendingSame) {
      throw new Error(`A merge of ${sourceClasses.map((entry) => `[${entry.name}]`).join(" and ")} is already pending ("${pendingSame.entry?.name}"); approve or reject it first.`);
    }
    const systemId = game.system?.id;
    const ownEvents = this._ownEvents(actor);
    const { focusScore } = computeMergeFocus(sourceClasses);
    const breadth = assessIntentionalBreadth(sourceClasses, ownEvents);
    const isIntentional = typeof intentional === "boolean" ? intentional : breadth.intentional;
    const mergedLevel = Number.isInteger(level) && level >= 1 ? level : Math.max(1, ...sourceClasses.map((entry) => (Number.isInteger(entry.level) ? entry.level : 1)));
    // At a Class milestone the merge is ON the cadence by definition; asked for between milestones it
    // is off-classing (mergeClassEntry caps it at its sources' own tier).
    const actorLevel = Number.isInteger(milestoneLevel) ? milestoneLevel : this.getLevelProgression(actor).level;
    const existingNames = Object.values(registry.classes ?? {}).map((entry) => entry?.name).filter(Boolean);
    const draft = mergeClassEntry({ sourceClasses, level: mergedLevel, intentional: isIntentional, actorLevel, existingIds: registry.classes ?? {}, existingNames, gameItem: { kind: "passive" }, mechanics: { effect: "-", duration: "ongoing", frequency: { max: 1, per: "unlimited" } } });
    const { gameItem, mechanics } = mergeClassMechanics(sourceClasses, { powerTier: draft.power_tier, systemId });
    const fallbackEntry = {
      ...draft,
      ...primaryFlags(sourceClasses),
      system_chassis: mergedSystemChassis(sourceClasses, systemId),
      gameItem,
      mechanics
    };
    const rejected = rejectedProposalNames(growth.proposals);
    const ai = await this._authorAdvanced(actor, {
      operation: "combine",
      sources: ids.map((id, index) => ({
        id,
        name: sourceClasses[index].name,
        kind: "class",
        level: sourceClasses[index].level ?? null,
        power_tier: sourceClasses[index].power_tier ?? "standard",
        effect: sourceClasses[index].mechanics?.effect ?? "",
        tags: sourceClasses[index].metadata?.tags ?? [],
        focus: Math.round(focusScore * 100) / 100
      })),
      events: ownEvents.slice(-15),
      systemId,
      wantedKind: "class",
      label: sourceClasses.map((entry) => `[${entry.name}]`).join(" + "),
      shape: (candidate, notes) => this._shapeMergedEntry(candidate, { fallbackEntry, registry, rejected, notes })
    });
    const usedFallback = !ai.entry;
    const entry = ai.entry ?? fallbackEntry;
    const reason = [usedFallback ? ai.reason : null, ...(ai.notes ?? [])].filter(Boolean).join("; ") || null;
    const proposal = {
      id: proposalId ?? uniqueRegistryId(`proposal:merge-${entry.metadata.id.replace(/^class:/, "")}`, growth.proposals.map((candidate) => candidate.id)),
      kind: "class",
      status: "pending",
      source: "class-merge",
      systemId,
      requestedAt: new Date().toISOString(),
      ...(Number.isInteger(milestoneLevel) ? { milestoneLevel } : { requestedBy: "gm" }),
      // Empty on purpose: a merge is earned by the Classes, not by particular events, so a re-analysis
      // that drops events never drops it (_removeRecordedEvents keeps evidence-less proposals).
      evidence: [],
      intentional: isIntentional,
      intentionalReason: typeof intentional === "boolean" ? "set by the GM" : breadth.reason,
      focusScore: Math.round(focusScore * 100) / 100,
      lineage: { operation: "combine", sources: ids },
      entry,
      ...(usedFallback ? { usedFallback: true, fallbackReason: ai.reason } : { authoredBy: "ai-gateway" })
    };
    return { proposal, usedFallback, reason, focus: proposal.focusScore, intentional: isIntentional };
  }

  /**
   * One adapter.authorAdvanced call, feature-detected (dev-gateway adds it in parallel). Returns
   * { entry, notes } with an entry the caller's `shape` fitted to the rules and that validates, or
   * { reason } saying why the deterministic builder has to stand in. Never throws.
   */
  async _authorAdvanced(actor, { operation, sources, events, systemId, wantedKind, label, shape }) {
    const adapter = this._proposalAdapter;
    if (!adapter) return { reason: "no AI provider is configured" };
    if (typeof adapter.authorAdvanced !== "function") {
      return { reason: "the AI gateway has no advanced-authoring entry point (adapter.authorAdvanced) yet, so the built-in rules wrote it" };
    }
    let output;
    try {
      output = await this._callAdapterWithDeadline(
        () => adapter.authorAdvanced({ actor, operation, sources, events, systemId }),
        operation === "upgrade" ? "Skill evolution" : "Class merge"
      );
    } catch (error) {
      return { reason: `the AI provider failed: ${error.message}` };
    }
    const candidates = Array.isArray(output?.proposals) ? output.proposals.filter((candidate) => candidate?.kind === wantedKind && candidate.entry && typeof candidate.entry === "object") : [];
    const gatewaySkipped = (Array.isArray(output?.skippedProposals) ? output.skippedProposals : [])
      .map((skip) => [skip?.proposal?.entry?.name, skip?.reason ?? skip?.errors?.join(" ")].filter(Boolean).join(": "))
      .filter(Boolean)
      .slice(0, 3);
    if (!candidates.length) {
      return { reason: `the AI did not return a ${wantedKind === "class" ? "Class" : "Skill"} for ${label}${gatewaySkipped.length ? ` (the gateway skipped ${gatewaySkipped.join("; ")})` : ""}` };
    }
    const notes = [];
    const shaped = shape(candidates[0], notes);
    const { accepted, skipped } = this._validateModelProposals([{ kind: wantedKind, evidence: candidates[0].evidence, entry: shaped }], actor, {
      customSynonyms: this.getGatewayConfig().customSynonyms
    });
    if (!accepted.length) {
      return { reason: `the AI's ${wantedKind === "class" ? "Class" : "Skill"} for ${label} did not validate (${skipped.flatMap((skip) => skip.errors ?? []).join(" ")})` };
    }
    return { entry: accepted[0].entry, notes };
  }

  // The AI's evolved Skill, fitted to the rules: id, tier, lineage, polarity and the evolution record
  // come from the fallback derivation; the AI owns the name, the mechanics and the words.
  _shapeEvolvedEntry(candidate, { source, skillId, fallbackEntry, evolvedTier, registry, rejected, notes }) {
    const entry = structuredClone(candidate.entry);
    entry.metadata = isPlainObject(entry.metadata) ? entry.metadata : {};
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const clash = !name
      || slugify(name) === slugify(source.name)
      || Object.values(registry.skills ?? {}).some((owned) => slugify(owned?.name ?? "") === slugify(name))
      || rejected.has(slugify(name));
    if (clash) {
      if (name) notes.push(`the AI's name "${name}" is already taken or rejected, so it is named [${fallbackEntry.name}]`);
      entry.name = fallbackEntry.name;
    } else {
      entry.name = name;
    }
    if (entry.tier !== evolvedTier) {
      if (Number.isInteger(entry.tier)) notes.push(`tier set to ${evolvedTier} by the evolution rules (the AI wrote ${entry.tier})`);
      entry.tier = evolvedTier;
    }
    if (typeof entry.system_equivalent !== "string" || !entry.system_equivalent.trim()) entry.system_equivalent = fallbackEntry.system_equivalent;
    if (!isPlainObject(entry.gameItem)) entry.gameItem = structuredClone(fallbackEntry.gameItem);
    if (!isPlainObject(entry.mechanics)) entry.mechanics = structuredClone(fallbackEntry.mechanics);
    const aiTags = [...(Array.isArray(entry.metadata.tags) ? entry.metadata.tags : []), ...(Array.isArray(entry.tags) ? entry.tags : [])];
    delete entry.tags;
    entry.metadata.tags = [...new Set([...aiTags, ...(source.metadata?.tags ?? [])])];
    Object.assign(entry.metadata, polarityFor(entry.metadata, source.metadata));
    if (entry.metadata.polarity !== "red") {
      delete entry.metadata.polarity;
      delete entry.metadata.malignance;
    }
    const rationale = entry.metadata.lineage?.rationale || candidate.rationale || fallbackEntry.metadata.lineage.rationale;
    entry.metadata.id = fallbackEntry.metadata.id;
    entry.metadata.lineage = { operation: "upgrade", sources: [skillId], rationale };
    entry.evolution = fallbackEntry.evolution;
    return entry;
  }

  // The AI's merged Class, fitted to the rules: power tier (focus score), level, primary/secondary,
  // id, lineage and red contagion come from the derivation; the AI owns name, mechanics and words.
  _shapeMergedEntry(candidate, { fallbackEntry, registry, rejected, notes }) {
    const entry = structuredClone(candidate.entry);
    entry.metadata = isPlainObject(entry.metadata) ? entry.metadata : {};
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const clash = !name
      || Object.values(registry.classes ?? {}).some((owned) => slugify(owned?.name ?? "") === slugify(name))
      || rejected.has(slugify(name));
    if (clash) {
      if (name) notes.push(`the AI's name "${name}" is already taken or rejected, so it is named [${fallbackEntry.name}]`);
      entry.name = fallbackEntry.name;
    } else {
      entry.name = name;
    }
    if (entry.power_tier !== fallbackEntry.power_tier) {
      if (entry.power_tier) notes.push(`power tier set to ${fallbackEntry.power_tier} by the merge rules (the AI wrote ${entry.power_tier})`);
      entry.power_tier = fallbackEntry.power_tier;
    }
    entry.level = fallbackEntry.level;
    entry.is_primary = fallbackEntry.is_primary;
    entry.is_secondary = fallbackEntry.is_secondary;
    entry.offCycleEvolution = fallbackEntry.offCycleEvolution;
    if (typeof entry.system_chassis !== "string" || !entry.system_chassis.trim()) entry.system_chassis = fallbackEntry.system_chassis;
    if (!isPlainObject(entry.gameItem)) entry.gameItem = structuredClone(fallbackEntry.gameItem);
    if (!isPlainObject(entry.mechanics)) entry.mechanics = structuredClone(fallbackEntry.mechanics);
    const aiTags = [...(Array.isArray(entry.metadata.tags) ? entry.metadata.tags : []), ...(Array.isArray(entry.tags) ? entry.tags : [])];
    delete entry.tags;
    entry.metadata.tags = [...new Set([...aiTags, ...(fallbackEntry.metadata.tags ?? [])])];
    // Red is contagious (class-merging.js): a red source makes the merge red whatever the AI wrote.
    const red = fallbackEntry.metadata.polarity === "red" ? fallbackEntry.metadata : null;
    Object.assign(entry.metadata, polarityFor(entry.metadata, red ?? { polarity: "standard" }));
    if (entry.metadata.polarity !== "red") {
      delete entry.metadata.polarity;
      delete entry.metadata.malignance;
    }
    const rationale = entry.metadata.lineage?.rationale || candidate.rationale || fallbackEntry.metadata.lineage.rationale;
    entry.metadata.id = fallbackEntry.metadata.id;
    entry.metadata.lineage = { operation: "combine", sources: fallbackEntry.metadata.lineage.sources, rationale };
    return entry;
  }

  // Marks the sources of an approved evolution/merge superseded in the registry and on their Items
  // (kept, renamed "(superseded)" and flagged, so the sheet shows the history instead of losing it).
  async _supersedeSources(actor, kind, sourceIds, byId) {
    const at = new Date().toISOString();
    const registry = markSuperseded(this.getActorRegistry(actor), kind, sourceIds, byId, at);
    for (const id of sourceIds) {
      const item = actor.items?.find?.((candidate) => candidate.getFlag?.(MODULE_ID, "registryId") === id);
      if (!item?.update) continue;
      const name = typeof item.name === "string" && !/\(superseded\)$/.test(item.name) ? `${item.name} (superseded)` : item.name;
      try {
        await item.update({ ...(name ? { name } : {}), [`flags.${MODULE_ID}.superseded`]: { by: byId, at } });
      } catch (error) {
        // The registry is the source of truth; a sheet Item that refuses the rename is only cosmetic.
        console.warn(`${MODULE_ID} | could not mark the superseded Item ${id}`, error);
      }
    }
    await actor.update({ [`flags.${MODULE_ID}.${REGISTRY_FLAG}`]: registry });
    globalThis.Hooks?.callAll?.("grand-design-ai.entriesSuperseded", actor, kind, sourceIds, byId);
    return registry;
  }

  // Ids of every combination any of these participants has cast, so a new one never reuses one.
  _existingCombinationIds(participants) {
    const ids = new Set();
    for (const participant of Array.isArray(participants) ? participants : []) {
      for (const entry of this.getCombinations(participant?.actor)) if (entry?.id) ids.add(entry.id);
    }
    return [...ids];
  }

  getCombinations(actor) {
    return actor?.getFlag(MODULE_ID, COMBINATIONS_FLAG) ?? [];
  }

  /**
   * Computes (but does not cast) a live multi-caster Combination Skill from several actors' own
   * approved Skills -- name, power, resonance band and rationale all derived by
   * combination-skills.js. `participants` is `[{ actor, skillId }]`, at least two, each from a
   * different actor. Nothing is created or written; this is the "what would happen if we did this"
   * read a GM wants before committing at the table.
   */
  previewCombinationSkill(participants, { effect, duration, rationale, polarity, malignance, id } = {}) {
    return buildCombinationSkill({
      contributions: this._resolveCombinationContributions(participants),
      id,
      effect: effect ?? "Pending GM effect description.",
      duration,
      rationale,
      polarity,
      malignance,
      existingIds: this._existingCombinationIds(participants)
    });
  }

  /**
   * Casts a live Combination Skill: several actors fire their own approved Skills together in one
   * moment (canon's multi-caster Combination Skills). Deliberately transient -- the combination
   * never enters anyone's Class/Skill registry. What it does instead is:
   *   1. put a temporary Item on EVERY participant so each player can see the working on their own
   *      sheet while it is live (removed again by endCombinationSkill),
   *   2. record it in each participant's own combination history (COMBINATIONS_FLAG), and
   *   3. record a growth event for each participant, tagged with the WHOLE combination's tag set
   *      rather than just their own contribution -- which is the reason this mechanic belongs in a
   *      progression tool at all, since standing inside someone else's working is how a character
   *      first accumulates evidence in a discipline they have never trained.
   *
   * A strongly resonant ("amplified") combination is recorded as a criticalSuccess by default,
   * which skill-evolution.js#isDefiningMoment counts as a defining moment -- so a great combination
   * can itself be the crisis that later evolves one of the Skills that made it. Pass an explicit
   * `outcome`/`dangerGap` to override, or `recordGrowth: false` to skip the growth half entirely.
   */
  async castCombinationSkill(participants, { effect, duration, rationale, polarity, malignance, id, recordGrowth = true, outcome, dangerGap } = {}) {
    this._assertGm();
    const contributions = this._resolveCombinationContributions(participants);
    const combination = buildCombinationSkill({
      contributions, id, effect, duration, rationale, polarity, malignance, existingIds: this._existingCombinationIds(participants)
    });

    const items = [];
    for (const contribution of contributions) {
      const participant = combination.participants.find((entry) => entry.actorId === contribution.actor.id);
      const { source, postCreate } = createCombinationSource(combination, participant, game.system.id);
      const [item] = await contribution.actor.createEmbeddedDocuments("Item", [source]);
      if (postCreate) await postCreate(item);
      items.push({ actorId: contribution.actor.id, itemId: item.id, item });

      if (recordGrowth) {
        await this.recordGrowthEvent(contribution.actor, buildCombinationGrowthEvent(combination, participant, { outcome, dangerGap }));
      }
      const history = [
        ...this.getCombinations(contribution.actor),
        {
          id: combination.id,
          name: combination.name,
          band: combination.band,
          power: combination.power,
          castAt: new Date().toISOString(),
          itemId: item.id,
          contributedSkillId: participant?.skillId ?? null,
          participants: combination.participants.map((entry) => entry.actorName),
          active: true
        }
      ];
      await contribution.actor.update({ [`flags.${MODULE_ID}.${COMBINATIONS_FLAG}`]: history });
    }

    Hooks.callAll("grand-design-ai.combinationCast", combination, items);
    return { combination, items };
  }

  /**
   * Ends a live combination: deletes the temporary Item from every participant who still has it and
   * marks that combination inactive in their history (the history entry itself is kept -- the table
   * should still be able to look back at what was cast). Safe to call on an actor who never had the
   * combination, or twice on the same one.
   */
  async endCombinationSkill(actors, combinationId) {
    this._assertGm();
    if (typeof combinationId !== "string" || !combinationId.trim()) {
      throw new Error("Ending a combination requires its combinationId.");
    }
    const endedAt = new Date().toISOString();
    const ended = [];
    for (const actor of Array.isArray(actors) ? actors : [actors]) {
      this._assertSupportedSystemActor(actor);
      const itemIds = actor.items
        .filter((item) => item.getFlag(MODULE_ID, "combinationId") === combinationId)
        .map((item) => item.id);
      if (itemIds.length) await actor.deleteEmbeddedDocuments("Item", itemIds);
      const history = this.getCombinations(actor).map((entry) =>
        entry.id === combinationId && entry.active ? { ...entry, active: false, endedAt } : entry
      );
      await actor.update({ [`flags.${MODULE_ID}.${COMBINATIONS_FLAG}`]: history });
      ended.push({ actorId: actor.id, removedItemIds: itemIds });
    }
    Hooks.callAll("grand-design-ai.combinationEnded", combinationId, ended);
    return { combinationId, ended };
  }

  _resolveCombinationContributions(participants) {
    if (!Array.isArray(participants) || participants.length < 2) {
      throw new Error("A Combination Skill requires at least two participants.");
    }
    return participants.map(({ actor, skillId }) => {
      this._assertSupportedSystemActor(actor);
      const skill = this.getActorRegistry(actor).skills?.[skillId];
      if (!skill) throw new Error(`${actor.name} has no approved Skill ${skillId} to contribute.`);
      if (!isActiveEntry(skill)) throw new Error(`${actor.name}'s [${skill.name}] has evolved into another Skill; contribute that one.`);
      return { actor, actorId: actor.id, actorName: actor.name, skill };
    });
  }

  /**
   * Grants a Title: a badge earned for a specific narrative achievement (not an ongoing activity
   * pattern the way Classes/Skills are), optionally bundling a reward -- entry.grants may carry a
   * skillEntry (a full Skill payload, approved and created the same way combineSkills/applyToActor
   * would), an itemGrant ({name, description} for a plain flavor Item), a reputation note, and/or
   * a condition ({name, description}), per constants.js#TITLE_GRANT_KEYS. Reputation/condition are
   * descriptive only -- recorded on the registry and in the Title Item's own description for GM
   * reference, with no further mechanical effect, since neither system has a clean generic hook
   * for "add an arbitrary reputation/condition" the way it does for Items.
   */
  async grantTitle(actor, entry) {
    this._assertSupportedSystemActor(actor);
    this._assertGm();
    const validation = validateTitleEntry(entry);
    if (!validation.valid) {
      throw new Error(`Grand Design title is invalid: ${validation.errors.join(" ")}`);
    }

    let registry = cloneRegistry(this.getActorRegistry(actor));
    const normalized = normalizeEntry("title", entry, registry);

    let grantedSkillId = null;
    let grantedItemId = null;
    if (normalized.grants?.skillEntry) {
      const normalizedSkill = normalizeEntry("skill", normalized.grants.skillEntry, registry);
      const approvedSkill = await this._ensureFeatureItem(actor, "skill", normalizedSkill, registry);
      registry = approvedSkill.registry;
      grantedSkillId = approvedSkill.item.id;
    }
    if (normalized.grants?.itemGrant) {
      const adapter = getSystemAdapter(game.system.id);
      const { source } = adapter.buildTitleGrantItemSource(normalized.grants.itemGrant);
      const [createdItem] = await actor.createEmbeddedDocuments("Item", [source]);
      grantedItemId = createdItem.id;
    }

    const titleEntry = { ...normalized, grantedSkillId, grantedItemId };
    const { source, postCreate } = createTitleSource(titleEntry, game.system.id);
    const [titleItem] = await actor.createEmbeddedDocuments("Item", [source]);
    if (postCreate) await postCreate(titleItem);
    let finalRegistry = registerEntry("title", titleEntry, titleItem.id, registry);

    // A red-polarity Title (yes, a Title itself can be red -- e.g. an infamous, ill-gotten one)
    // accrues Horror Rank the same as a red Class/Skill would. See applyToActor for the same logic.
    let horrorRank = this.getHorrorRank(actor);
    let dockedFrom = [];
    if (titleEntry.metadata?.polarity === "red") {
      const result = applyHorrorRankIncrement(finalRegistry, horrorRank, HORROR_RANK_POINTS_PER_RED_APPROVAL);
      finalRegistry = result.registry;
      horrorRank = result.horrorRank;
      dockedFrom = result.dockedFrom;
    }

    await actor.update({
      [`flags.${MODULE_ID}.${REGISTRY_FLAG}`]: finalRegistry,
      [`flags.${MODULE_ID}.${HORROR_RANK_FLAG}`]: horrorRank
    });
    Hooks.callAll("grand-design-ai.titleGranted", actor, titleEntry, titleItem);
    if (dockedFrom.length) Hooks.callAll("grand-design-ai.horrorRankLevelsDocked", actor, dockedFrom);
    return { item: titleItem, registry: finalRegistry, grantedSkillId, grantedItemId };
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

  getConsolidations(actor) {
    return actor?.getFlag(MODULE_ID, CONSOLIDATIONS_FLAG) ?? [];
  }

  /**
   * Class Loss / behavioral erosion (canon: classes like [Hero] or [King] can be lost if the
   * behavior that earned them stops). Purely a GM ADVISORY read -- it never removes, docks, or
   * modifies anything on the actor. Returns every approved Class whose own tags haven't appeared
   * in a recorded growth event for at least `sessionThreshold` sessions (default:
   * CLASS_EROSION_DEFAULT_SESSION_THRESHOLD), so a GM can decide at the table whether that Class is
   * actually at risk. See class-erosion.js for exactly how "session" is approximated.
   */
  checkClassErosion(actor, options = {}) {
    // A Class a merge replaced is not at risk of erosion; it is already gone.
    const registry = this.getActorRegistry(actor);
    const active = { ...registry, classes: Object.fromEntries(Object.entries(registry.classes ?? {}).filter(([, entry]) => isActiveEntry(entry))) };
    return checkClassErosion(this.getGrowth(actor).events, active, options);
  }

  /**
   * Revival penalty (canon: resurrection costs levels off the character's own highest Class). A
   * one-shot GM action, unlike Horror Rank's accumulating meter -- call this once, whenever a GM
   * actually revives the character. Docks up to `levels` (default REVIVAL_PENALTY_LEVELS) from the
   * actor's single strongest Class -- including a red one, unlike Horror Rank's docking, since a
   * resurrection toll is paid regardless of what that Class actually is. Returns `dockedFrom: null`
   * (no actor.update at all) if there was no eligible Class to dock from -- an empty registry, or
   * the actor's only Class already at level 1.
   */
  async applyRevivalPenalty(actor, levels) {
    this._assertSupportedSystemActor(actor);
    this._assertGm();
    const registry = this.getActorRegistry(actor);
    const result = applyRevivalPenalty(registry, levels);
    if (!result.dockedFrom) return result;
    await actor.update({ [`flags.${MODULE_ID}.${REGISTRY_FLAG}`]: result.registry });
    Hooks.callAll("grand-design-ai.revivalPenaltyApplied", actor, result.dockedFrom);
    return result;
  }

  getHorrorRank(actor) {
    return normalizeHorrorRank(actor?.getFlag(MODULE_ID, HORROR_RANK_FLAG));
  }

  /**
   * The "Blue" redemption path canon gives Blood Skills/Conditions: neutralizes an existing red
   * Class/Skill/Title back to standard polarity, clearing its malignance, and records a
   * `metadata.cleansed` note ({at, rationale, formerVice}) so the redemption itself is traceable
   * in the registry rather than looking like the entry was always standard. Both the registry
   * entry and (if the real Item document is still present on the actor) its own flags are updated
   * so the sheet and the registry never disagree about whether an entry is still red.
   *
   * Deliberately scoped: cleansing stops the entry from counting as red for future contagion
   * (class-merging.js#resolveMergedPolarity reads metadata.polarity, which this clears) and stops
   * it from generating further Horror Rank on its own, but it does NOT retroactively refund Horror
   * Rank points already accrued or un-dock levels already docked by a past threshold crossing --
   * the corruption it already caused already happened; cleansing only stops it from being a
   * standing source of taint going forward.
   */
  async cleanseEntry(actor, kind, entryId, rationale = "") {
    this._assertSupportedSystemActor(actor);
    this._assertGm();
    const bucketName = kind === "class" ? "classes" : kind === "skill" ? "skills" : kind === "title" ? "titles" : null;
    if (!bucketName) throw new Error(`Unknown Grand Design entry kind: ${kind}.`);
    const registry = this.getActorRegistry(actor);
    const entry = registry[bucketName]?.[entryId];
    if (!entry) throw new Error(`No approved ${kind} ${entryId} exists on this actor.`);
    if (entry.metadata?.polarity !== "red") {
      throw new Error(`[${entry.name}] is not a red entry -- there is nothing to cleanse.`);
    }

    const formerVice = entry.metadata.malignance?.vice ?? null;
    const cleansed = { at: new Date().toISOString(), rationale: String(rationale ?? "").trim(), formerVice };

    // Foundry's Document#update deep-merges an object-valued flag into whatever is already
    // stored there by default, so a plain `delete cleansedMetadata.polarity` followed by a
    // default update() silently failed to actually remove "polarity" -- the old value got
    // merged right back in from the previously-persisted data (confirmed against a live world).
    // The fix is NOT {recursive: false} -- that disables merging for the WHOLE update payload,
    // which (also confirmed live) wipes out every sibling flag key at every level it touches
    // (e.g. it deleted the Item's own registryId/kind/achievement flags, and would have wiped
    // the actor's horrorRank/growthEvents/etc. flags too, since a REGISTRY_FLAG-wide replace
    // touches the same "flags.grand-design-ai" object those live under). The correct, precisely-
    // scoped fix is Foundry's own "-=" deletion-key dot-path syntax, which removes exactly the
    // two named keys and leaves every sibling key (other registry entries, other actor flags,
    // other Item flags) merged normally, untouched.
    const registryMetadataPath = `flags.${MODULE_ID}.${REGISTRY_FLAG}.${bucketName}.${entryId}.metadata`;
    const item = actor.items?.find?.((candidate) => candidate.getFlag(MODULE_ID, "registryId") === entryId);
    if (item) {
      await item.update({
        [`flags.${MODULE_ID}.metadata.-=polarity`]: null,
        [`flags.${MODULE_ID}.metadata.-=malignance`]: null,
        [`flags.${MODULE_ID}.metadata.cleansed`]: cleansed
      });
    }

    await actor.update({
      [`${registryMetadataPath}.-=polarity`]: null,
      [`${registryMetadataPath}.-=malignance`]: null,
      [`${registryMetadataPath}.cleansed`]: cleansed
    });
    Hooks.callAll("grand-design-ai.entryCleansed", actor, kind, entryId);
    return this.getActorRegistry(actor)[bucketName][entryId];
  }

  /**
   * Declares two of an actor's own approved Classes "consolidated" (canon's Consolidation: a
   * maid's combat Class consolidated with her domestic one gains combat evidence from kitchen
   * work). Ongoing, not a one-time effect -- from now on a growth event tagged for either Class's
   * own tags also counts as evidence for the other's (see progression.js#generateSkillProposals).
   * Distinct from combineClasses/class-merging.js: this never creates, renames, or changes either
   * Class, it only widens which future growth events count as evidence for tag-triggered Skill
   * proposals.
   */
  async setConsolidation(actor, classIdA, classIdB, note = "") {
    this._assertSupportedSystemActor(actor);
    this._assertGm();
    if (classIdA === classIdB) {
      throw new Error("A Class cannot be consolidated with itself.");
    }
    const registry = this.getActorRegistry(actor);
    if (!registry.classes[classIdA]) throw new Error(`No approved Class ${classIdA} exists on this actor.`);
    if (!registry.classes[classIdB]) throw new Error(`No approved Class ${classIdB} exists on this actor.`);
    const key = consolidationKey(classIdA, classIdB);
    const existing = this.getConsolidations(actor);
    if (existing.some((entry) => consolidationKey(...entry.classIds) === key)) {
      throw new Error("These two Classes are already consolidated.");
    }
    const consolidations = [...existing, { classIds: [classIdA, classIdB], note: String(note ?? "").trim() }];
    await actor.update({ [`flags.${MODULE_ID}.${CONSOLIDATIONS_FLAG}`]: consolidations });
    Hooks.callAll("grand-design-ai.consolidationSet", actor, classIdA, classIdB);
    return consolidations;
  }

  async removeConsolidation(actor, classIdA, classIdB) {
    this._assertSupportedSystemActor(actor);
    this._assertGm();
    const key = consolidationKey(classIdA, classIdB);
    const consolidations = this.getConsolidations(actor).filter((entry) => consolidationKey(...entry.classIds) !== key);
    await actor.update({ [`flags.${MODULE_ID}.${CONSOLIDATIONS_FLAG}`]: consolidations });
    Hooks.callAll("grand-design-ai.consolidationRemoved", actor, classIdA, classIdB);
    return consolidations;
  }

  /**
   * Dynamic tag reweighting (canon: Isthekenous actively repatches which tags grant which XP over
   * time). `provider` is a zero-arg function returning the current `{tag: multiplier}` map --
   * called fresh every time getTagWeights() is read, so a GM's edit through the settings UI takes
   * effect on the very next growth event, no reload needed. main.js wires this to a world-settings
   * provider (tag-weighting-settings.js) at init; tests and any other caller with no provider set
   * get the default "every tag weighs 1x" via the constructor's own no-op provider.
   */
  setTagWeightsProvider(provider) {
    if (typeof provider !== "function") {
      throw new Error("A tag-weights provider must be a function.");
    }
    this._tagWeightsProvider = provider;
  }

  getTagWeights() {
    return this._tagWeightsProvider() ?? {};
  }

  setProposalAdapter(adapter) {
    if (adapter !== null && typeof adapter !== "function") {
      throw new Error("A proposal adapter must be a function or null.");
    }
    this._proposalAdapter = adapter;
  }

  hasProposalAdapter() {
    return this._proposalAdapter !== null;
  }

  /** The adapter currently in use (so a caller can swap it temporarily and restore it). */
  getProposalAdapter() {
    return this._proposalAdapter;
  }

  setAiGateway(config) {
    this.setProposalAdapter(createAiGatewayAdapter(config));
  }

  /**
   * AI gateway v2 customization surface. `provider` is a zero-arg function returning the current
   * gateway config (scripts/ai/gateway-config.js keys: emergentThemes, proposalMode, customSynonyms,
   * provider/endpoint/model...). main.js wires it to ai-provider-config.js#getGatewayConfig (client
   * + world settings merged); tests and plain-Node callers get the defaults ({}), under which
   * emergent themes are ON -- the same default GATEWAY_DEFAULTS uses.
   */
  setGatewayConfigProvider(provider) {
    if (typeof provider !== "function") throw new Error("A gateway-config provider must be a function.");
    this._gatewayConfigProvider = provider;
  }

  getGatewayConfig() {
    try {
      return this._gatewayConfigProvider?.() ?? {};
    } catch (error) {
      console.warn(`${MODULE_ID} | gateway config provider failed; using defaults`, error);
      return {};
    }
  }

  /**
   * Where the world-level "seen emergent themes" state lives. `store` = { get() -> state|string,
   * set(state) -> Promise }. main.js wires it to the `emergentThemes` world setting
   * (emergent-themes-settings.js); the default is an in-memory store so GrandDesignApi stays
   * Foundry-independent and testable.
   */
  setEmergentThemeStore(store) {
    if (!store || typeof store.get !== "function" || typeof store.set !== "function") {
      throw new Error("An emergent-theme store needs get() and set(state).");
    }
    this._emergentThemeStore = store;
  }

  getEmergentThemes() {
    const state = normalizeEmergentThemeState(this._emergentThemeStore.get());
    return { ...state, list: listThemes(state), themeMap: themeMapFromState(state) };
  }

  /**
   * GM action from the Emergent Themes settings menu (or a macro): rename a theme, merge it into
   * another, map it onto a canonical tag, or ignore it. `mapping` = { label?, mergeInto?, mapTo?,
   * ignored? } or null to clear. Takes effect on the next growth event / analysis -- evidence is
   * always recomputed from the stored raw themes, so a mapping is reversible.
   */
  async setEmergentThemeMapping(slug, mapping) {
    this._assertGm();
    const next = setThemeMapping(this._emergentThemeStore.get(), slug, mapping);
    await this._emergentThemeStore.set(next);
    Hooks.callAll("grand-design-ai.emergentThemeMapped", slug, mapping);
    return this.getEmergentThemes();
  }

  _emergentEnabled() {
    return this.getGatewayConfig().emergentThemes !== false;
  }

  _themeMap() {
    return themeMapFromState(this._emergentThemeStore.get());
  }

  async _observeThemes(events, { countExisting = true, actor = null } = {}) {
    if (!this._emergentEnabled()) return [];
    const withThemes = events.filter((event) => Array.isArray(event?.themes) && event.themes.length);
    if (!withThemes.length) return [];
    try {
      const { state, newlySeen } = observeThemes(this._emergentThemeStore.get(), withThemes, new Date().toISOString(), {
        countExisting,
        ...(actor?.id ? { actorId: actor.id } : {})
      });
      await this._emergentThemeStore.set(state);
      return newlySeen;
    } catch (error) {
      // Theme bookkeeping is a nice-to-have; it must never cost the GM an analysis.
      console.warn(`${MODULE_ID} | could not update the emergent-theme registry`, error);
      return [];
    }
  }

  /**
   * Analyzes free-form session notes into growth events (and, via the AI gateway, proposals).
   *
   * AI gateway v2 (2026-09-23) changes, per docs/ai-gateway-v2-contract.md:
   *  - the adapter may return the rich shape { events, proposals, themes, skippedEvents,
   *    skippedProposals, gatewayDiagnostics }; all of it is surfaced on the result,
   *  - model PROPOSALS are now tolerant per proposal: an invalid one lands in
   *    `adapterSkippedProposals` with its errors instead of throwing for the whole batch (the gateway
   *    pipeline already repairs proposals before they get here, so a shape error that survives is a
   *    one-off, not a systemic regression worth losing the notes over),
   *  - unknown tags become emergent themes (events and proposal metadata) instead of being dropped,
   *  - the notes + a diagnostics summary are stored per actor (flag "lastAnalysis") so the GM can
   *    re-run them (reanalyzeLastNotes).
   * The invariant is unchanged: any adapter failure -> local analysis with a stated reason; the GM's
   * notes are never lost.
   */
  async analyzeSessionNotes(actor, notes, options = {}) {
    this._assertSupportedSystemActor(actor);
    this._assertGm();
    return this._withActorLock(actor, "analyze", () => this._analyzeSessionNotes(actor, notes, options));
  }

  async _analyzeSessionNotes(actor, notes, { replaceEventIds = [], fresh = false } = {}) {
    this._assertSupportedSystemActor(actor);
    this._assertGm();
    if (typeof notes !== "string" || !notes.trim()) {
      throw new Error("Session notes must be non-empty text.");
    }
    // An AI provider that is configured but unreachable must never cost a GM the notes they just
    // typed (the original "Failed to fetch" bug). Parsing the adapter's output happens inside the
    // same try/catch as the call itself, so a nonsense body falls back to the local analyzer the
    // same way a dead connection does.
    const gatewayCore = await loadGatewayCore();
    const config = this.getGatewayConfig();
    let adapterOutput = null;
    let adapterError = null;
    let adapterEvents = null; // { events, skipped } once the adapter has produced a usable shape
    if (this._proposalAdapter) {
      try {
        // `fresh`: skip the gateway's shared reading of these notes (one reading serves the whole
        // party; see pipeline.js#createExtractionCache) -- a GM who asks to re-analyze wants a new one.
        const adapter = this._proposalAdapter;
        adapterOutput = await this._callAdapterWithDeadline(
          () => adapter({ actor, notes, systemId: game.system?.id, ...(fresh ? { fresh: true } : {}) }),
          "analysis"
        );
        adapterEvents = validateAdapterEvents(adapterOutput);
      } catch (error) {
        adapterError = error;
        console.warn(`${MODULE_ID} | AI provider failed; falling back to local note analysis`, error);
      }
    }
    const usedAdapter = this._proposalAdapter !== null && adapterError === null;
    const source = usedAdapter ? "adapter" : this._proposalAdapter ? "local-fallback" : "local";
    // The local path reports how it reached its answer (see session-notes.js#explainSessionNotes):
    // "0 events" must never come back unexplained.
    const localAnalysis = usedAdapter ? null : explainSessionNotes(notes);
    const emergentEnabled = this._emergentEnabled();
    const { events: sanitizedEvents, rejectedTags } = usedAdapter
      ? this._sanitizeEventTags(adapterEvents.events, { customSynonyms: config.customSynonyms, emergentEnabled })
      : { events: localAnalysis.events, rejectedTags: [] };
    // Party-wide notes are analysed once per character, so only this character's events are
    // recorded here (session-notes.js#attributeEventsToActor): an event naming someone else goes to
    // `attributedToOthers` instead of inflating this sheet (playtest ember-road s1: five PCs each
    // credited with all ~18 party events and Grand Design level 0 -> 3 from one session).
    const actorNames = this._actorNames(actor);
    const { kept: taggedEvents, dropped: otherEvents, attributedToOthers } = attributeEventsToActor(sanitizedEvents, actorNames, { notes });

    // Re-analysis: drop the events the previous run of these same notes recorded (and their progress)
    // before recording the new interpretation, so re-running never double-counts evidence.
    if (replaceEventIds.length) await this._removeRecordedEvents(actor, replaceEventIds);

    const recorded = [];
    let eventProposals = this.getGrowth(actor).proposals;
    for (const event of taggedEvents) {
      const result = await this.recordGrowthEvent(actor, { ...event, source: usedAdapter ? "adapter" : "local" }, { observeThemes: false, fromAdapter: usedAdapter });
      recorded.push(result.event);
      eventProposals = result.proposals;
    }
    // A re-analysis of the same notes registers any newly noticed theme but does not re-count old ones.
    const newlySeenThemes = await this._observeThemes(recorded, { countExisting: !replaceEventIds.length, actor });

    const { accepted: validProposals, skipped: invalidProposals } = usedAdapter
      ? this._validateModelProposals(adapterOutput?.proposals ?? [], actor, { customSynonyms: config.customSynonyms })
      : { accepted: [], skipped: [] };
    // The gateway's stage 2 sees every event in the notes, so it can build a proposal for this
    // character purely out of someone else's deeds; one whose evidence cites only other characters
    // is skipped (and reported) rather than offered.
    // A rejected proposal is kept on the actor (never deleted), so the SAME id merging back in via
    // mergeProposals already leaves it alone -- but the gateway can re-author the same idea under a
    // fresh id, so its name is also checked here.
    const rejectedNames = rejectedProposalNames(eventProposals);
    const modelProposals = [];
    for (const proposal of validProposals) {
      if (proposalCitesOnlyOthers(proposal, { actorNames, ownEvents: taggedEvents, otherEvents })) {
        invalidProposals.push({ proposal, errors: [`Evidence cites only other characters' actions, not ${actor.name ?? "this character"}'s.`], reason: "attributed-to-others" });
      } else if (rejectedNames.has(slugify(proposal.entry?.name ?? ""))) {
        invalidProposals.push({ proposal, errors: [`The GM already rejected a proposal named ${proposal.entry?.name}.`], reason: "rejected" });
      } else {
        modelProposals.push(stampClassEvolutionLevel(proposal, this.getLevelProgression(actor).level));
      }
    }
    const mergedProposals = mergeProposals(eventProposals, modelProposals);
    // Board b81a0357: trim to the pending-proposal cap AFTER merging, so it catches proposals that
    // piled up on the actor from earlier analyses too, not just this batch.
    const allowances = this.getLevelProgression(actor).grantAllowances;
    const { proposals, dropped: cappedOutProposals, cap: pendingCap } = capPendingAiProposals(mergedProposals, config, allowances, { countAll: true });
    const cappedIds = new Set(proposals.map((p) => p.id));

    const adapterSkippedEvents = usedAdapter
      ? [...(Array.isArray(adapterOutput?.skippedEvents) ? adapterOutput.skippedEvents : []), ...adapterEvents.skipped]
      : [];
    const adapterSkippedProposals = [
      ...(usedAdapter ? [...(Array.isArray(adapterOutput?.skippedProposals) ? adapterOutput.skippedProposals : []), ...invalidProposals] : []),
      ...cappedOutProposals.map((proposal) => ({
        proposal,
        reason: "pending-cap",
        errors: [`${actor.name ?? "This character"} already has ${pendingCap} pending AI proposals; kept the strongest/newest.`]
      }))
    ];
    const gatewayDiagnostics = usedAdapter && adapterOutput && typeof adapterOutput === "object" && !Array.isArray(adapterOutput)
      ? adapterOutput.gatewayDiagnostics ?? adapterOutput.diagnostics ?? null
      : null;
    const themes = summarizeThemes(recorded, newlySeenThemes, this.getEmergentThemes().themes);

    const lastAnalysis = {
      notes,
      at: new Date().toISOString(),
      source,
      eventIds: recorded.map((event) => event.id),
      proposalIds: modelProposals.map((proposal) => proposal.id).filter((id) => cappedIds.has(id)),
      diagnostics: summarizeDiagnostics({ source, gatewayDiagnostics, adapterError, localAnalysis, recorded, adapterSkippedEvents, adapterSkippedProposals, attributedToOthers }),
      // Kept short (flag-safe): who else the notes were about, so the Growth dialog can say
      // "12 events belonged to other characters" and list them.
      ...(attributedToOthers.length ? { attributedToOthers: attributedToOthers.slice(0, 50) } : {})
    };
    await actor.update({
      [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: proposals,
      [`flags.${MODULE_ID}.${LAST_ANALYSIS_FLAG}`]: lastAnalysis
    });
    // Board ebcc3f03: new evidence may have pushed a Skill to evolve; say so right away.
    const evolutionReady = this._announceEvolutionReady(actor);
    return {
      source,
      adapterConfigured: this.hasProposalAdapter(),
      events: recorded,
      proposals,
      themes,
      attributedToOthers,
      evolutionReady,
      ...(adapterError ? { adapterError: adapterError.message } : {}),
      ...(localAnalysis ? { diagnostics: localAnalysis.diagnostics } : {}),
      ...(gatewayDiagnostics ? { gatewayDiagnostics } : {}),
      ...(adapterSkippedEvents.length ? { adapterSkippedEvents } : {}),
      ...(adapterSkippedProposals.length ? { adapterSkippedProposals } : {}),
      ...(rejectedTags.length ? { adapterRejectedTags: rejectedTags } : {}),
      ...(emergentEnabled ? {} : { emergentThemesDisabled: true })
    };
  }

  getLastAnalysis(actor) {
    return actor?.getFlag(MODULE_ID, LAST_ANALYSIS_FLAG) ?? null;
  }

  /**
   * Re-runs the last notes analyzed for this actor (e.g. after fixing the AI provider, switching
   * model, or editing house rules). By default the events that previous run recorded -- and the
   * progress and still-pending AI proposals they produced -- are replaced, not added to, so a
   * re-analysis never double-counts. Pass { replace: false } to keep them and add a second reading.
   */
  async reanalyzeLastNotes(actor, { replace = true } = {}) {
    this._assertSupportedSystemActor(actor);
    this._assertGm();
    return this._withActorLock(actor, "re-analyze", async () => {
      const last = this.getLastAnalysis(actor);
      if (!last?.notes) throw new Error(`No previous session notes are stored for ${actor.name ?? "this actor"}.`);
      if (replace && Array.isArray(last.proposalIds) && last.proposalIds.length) {
        const stale = new Set(last.proposalIds);
        // A proposal the GM edited is theirs now; a re-analysis does not throw it away.
        const proposals = this.getGrowth(actor).proposals.filter((proposal) => !(stale.has(proposal.id) && proposal.status === "pending" && !proposal.editedAt));
        await actor.update({ [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: proposals });
      }
      return this._analyzeSessionNotes(actor, last.notes, { replaceEventIds: replace ? last.eventIds ?? [] : [], fresh: true });
    });
  }

  async _removeRecordedEvents(actor, eventIds) {
    const remove = new Set(eventIds);
    const growth = this.getGrowth(actor);
    const removed = growth.events.filter((event) => remove.has(event.id));
    if (!removed.length) return;
    const events = growth.events.filter((event) => !remove.has(event.id));
    const levelProgression = this.getLevelProgression(actor);
    const lostProgress = removed.reduce((sum, event) => sum + progressionForEvent(event), 0);
    // A pending proposal whose every cited event was just removed no longer has any evidence behind it.
    // Except a milestone reward (guaranteed by the level, not by the evidence: dropping it stranded
    // the capstone allowance, board b375d56c) and a proposal the GM edited.
    const proposals = growth.proposals.filter((proposal) =>
      proposal.status !== "pending"
      || isMilestoneProposal(proposal)
      || proposal.editedAt
      // A Skill evolution or Class merge the GM asked for is theirs, like an edit.
      || proposal.requestedBy === "gm"
      || !Array.isArray(proposal.evidence)
      || !proposal.evidence.length
      || proposal.evidence.some((id) => !remove.has(id))
    );
    await actor.update({
      [`flags.${MODULE_ID}.${GROWTH_EVENTS_FLAG}`]: events,
      [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: proposals,
      [`flags.${MODULE_ID}.${LEVEL_PROGRESSION_FLAG}`]: { ...levelProgression, progress: Math.max(0, levelProgression.progress - lostProgress) }
    });
  }

  /**
   * Checks an AI provider end to end: reachability + latency (ping), the models it offers
   * (listModels), and a one-sentence sample extraction through the real adapter (nothing is
   * recorded). Defaults to the saved config + attached adapter; the settings form passes its UNSAVED
   * `config` and a freshly built `adapter` so the GM can test before saving. Never throws -- the UI
   * shows whatever comes back.
   */
  async testAiConnection({
    actor = null,
    sampleNotes = "Kesh parried the guard's blade, then talked the captain into letting them pass.",
    config: overrideConfig,
    adapter: overrideAdapter
  } = {}) {
    const started = Date.now();
    const config = overrideConfig ?? this.getGatewayConfig();
    const adapter = overrideAdapter !== undefined ? overrideAdapter : this._proposalAdapter;
    const result = { ok: false, provider: config.provider ?? null, endpoint: config.endpoint ?? null, model: config.model ?? null, models: [], ms: null };
    if (!config.provider || config.provider === "disabled") {
      return { ...result, error: "No AI provider is configured -- Grand Design uses the built-in local analyzer." };
    }
    let probe = typeof adapter?.ping === "function" ? adapter : null;
    if (!probe) {
      const gatewayCore = await loadGatewayCore();
      if (gatewayCore?.createTransport) {
        try {
          probe = gatewayCore.createTransport({ ...config, ollamaOptions: { num_ctx: config.numCtx, num_predict: config.numPredict } });
        } catch (error) {
          return { ...result, ms: Date.now() - started, error: error.message };
        }
      }
    }
    if (probe) {
      try {
        const ping = await probe.ping();
        Object.assign(result, {
          ok: Boolean(ping?.ok),
          ms: ping?.ms ?? null,
          models: Array.isArray(ping?.models) ? ping.models : [],
          ...(ping?.model ? { model: ping.model } : {}),
          ...(ping?.modelAvailable !== undefined ? { modelAvailable: ping.modelAvailable } : {}),
          ...(ping?.error ? { error: String(ping.error) } : {})
        });
      } catch (error) {
        return { ...result, ms: Date.now() - started, error: error.message };
      }
      if (!result.ok) return result;
      if (result.modelAvailable === false) return { ...result, ok: false };
    }
    if (!adapter) {
      return { ...result, error: result.error ?? "The provider answered, but no adapter is attached -- save the settings to attach it." };
    }
    try {
      const sampleStarted = Date.now();
      const output = await adapter({ actor: actor ?? sampleActor(), notes: sampleNotes, systemId: typeof game !== "undefined" ? game?.system?.id : undefined });
      const { events } = validateAdapterEvents(output);
      result.ok = true;
      result.sample = {
        notes: sampleNotes,
        ms: Date.now() - sampleStarted,
        events: events.map((event) => ({ summary: event.summary, tags: event.tags ?? [], themes: event.themes ?? [], outcome: event.outcome }))
      };
      if (output?.gatewayDiagnostics?.model) result.model = output.gatewayDiagnostics.model;
    } catch (error) {
      result.ok = false;
      result.error = error.message;
    }
    result.ms ??= Date.now() - started;
    return result;
  }

  /**
   * Asks the AI gateway to author a real Skill for a placeholder proposal (an emergent-theme
   * "<Theme> Knack", or any pending proposal flagged needsAuthoring). The authored entry replaces
   * the placeholder's entry in place (same proposal id, same evidence) once it validates; nothing is
   * approved. If the gateway exposes a stage-2-only call (`authorProposal` on the adapter) it is
   * used; otherwise the ordinary adapter is called with a synthetic note built from the cited
   * evidence, and only its proposals are read (its events are NOT recorded -- they would double-count).
   */
  async requestProposalAuthoring(actor, proposalId) {
    this._assertSupportedSystemActor(actor);
    this._assertGm();
    return this._withActorLock(actor, "author", () => this._requestProposalAuthoring(actor, proposalId));
  }

  async _requestProposalAuthoring(actor, proposalId) {
    if (!this._proposalAdapter) throw new Error("Authoring a proposal needs a configured AI provider (Grand Design AI Gateway settings).");
    const growth = this.getGrowth(actor);
    const proposal = growth.proposals.find((candidate) => candidate.id === proposalId && candidate.status === "pending");
    if (!proposal) throw new Error(`No pending proposal exists for ${proposalId}.`);
    const gatewayCore = await loadGatewayCore();
    const config = this.getGatewayConfig();
    const evidenceEvents = growth.events.filter((event) => (proposal.evidence ?? []).includes(event.id));
    const theme = proposal.theme ?? proposal.entry?.metadata?.themes?.[0] ?? null;
    const label = theme ? themeLabel(theme, this._themeMap()) : proposal.entry?.name ?? "this activity";

    const wantedKind = proposal.kind ?? "skill";
    const hasAuthorEntry = typeof this._proposalAdapter.authorProposal === "function";
    let output;
    const adapter = this._proposalAdapter;
    try {
      output = await this._callAdapterWithDeadline(() => (hasAuthorEntry
        ? adapter.authorProposal({ actor, proposal, events: evidenceEvents, theme, label, systemId: game.system?.id })
        : adapter({ actor, notes: buildAuthoringNotes(actor, label, theme, evidenceEvents), systemId: game.system?.id })), "authoring");
    } catch (error) {
      // The placeholder stays exactly as it was; the GM is told why.
      throw new Error(`The AI provider failed while authoring "${label}" (the placeholder is unchanged): ${error.message}`);
    }
    const candidates = Array.isArray(output) ? [] : Array.isArray(output?.proposals) ? output.proposals : output?.entry ? [output] : [];
    const { accepted, skipped } = this._validateModelProposals(candidates.map((candidate) => ({ kind: "skill", ...candidate })), actor, {
      customSynonyms: config.customSynonyms
    });
    // With the stage-2 entry point the model was told the kind, so a different kind is refused; the
    // legacy notes-wrapper path could only ever ask for a Skill, so it keeps taking whatever came back.
    const authored = accepted.find((candidate) => candidate.kind === wantedKind) ?? (hasAuthorEntry ? null : accepted[0]);
    if (!authored) {
      const gatewaySkipped = Array.isArray(output?.skippedProposals) ? output.skippedProposals : [];
      const reasons = [...skipped, ...gatewaySkipped]
        .map((entry) => entry.errors?.join(" ") ?? entry.error ?? entry.reason)
        .filter(Boolean)
        .join(" | ");
      throw new Error(`The AI did not return a usable ${wantedKind === "class" ? "Class" : "Skill"} for "${label}" (the placeholder is unchanged).${reasons ? ` ${reasons}` : ""}`);
    }
    const entry = structuredClone(authored.entry);
    entry.metadata ??= {};
    if (theme) entry.metadata.themes = [...new Set([...(entry.metadata.themes ?? []), theme])];
    // A capstone is a tier-3 Skill by definition (progression.js#buildCapstoneEntry).
    if (proposal.isCapstone && wantedKind === "skill" && entry.tier !== 3) entry.tier = 3;
    // The original id, evidence, isCapstone and milestoneLevel stay (spread), so the entry still
    // spends the right allowance and is still the same row in the Growth list. A rewritten TEMPLATE
    // becomes an ai-gateway proposal (origin "template") so the next recorded event leaves it alone.
    const updated = {
      ...proposal,
      kind: authored.kind,
      entry,
      needsAuthoring: false,
      authoredBy: "ai-gateway",
      authoredAt: new Date().toISOString(),
      ...(proposal.source === "template" ? { source: "ai-gateway", origin: "template" } : {})
    };
    const proposals = growth.proposals.map((candidate) => (candidate.id === proposalId ? updated : candidate));
    await actor.update({ [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: proposals });
    Hooks.callAll("grand-design-ai.proposalAuthored", actor, updated);
    return { proposal: updated, skipped, ...(output?.gatewayDiagnostics ? { gatewayDiagnostics: output.gatewayDiagnostics } : {}) };
  }

  /**
   * "Suggest proposals" (Growth dialog button): runs the AI gateway's proposal stage for this actor
   * NOW, from the growth this character has already recorded, with proposalMode "always" semantics
   * -- for the case the ember-road playtest hit, where a long rest left grant allowances and nothing
   * to spend them on. New proposals are merged into the pending list (nothing is approved, no event
   * is recorded). Returns { proposals (the full list), added (the new ones), skipped }.
   *
   * The gateway adapter only takes notes, so the character's own recorded events are replayed as a
   * short synthetic note (buildSuggestionNotes); the events it re-extracts from that note are
   * discarded (recording them would double-count). A v2 gateway adapter whose configured mode is not
   * "always" is re-wrapped around the SAME transport with proposalMode "always"; any other adapter
   * gets `proposalMode: "always"` in its arguments and the explicit GM request in the note.
   */
  async requestGrowthProposals(actor) {
    this._assertSupportedSystemActor(actor);
    this._assertGm();
    return this._withActorLock(actor, "suggest", () => this._requestGrowthProposals(actor));
  }

  async _requestGrowthProposals(actor) {
    if (!this._proposalAdapter) {
      throw new Error(
        "Suggesting proposals needs a configured AI provider (Grand Design AI Gateway settings). Without one, "
          + "Grand Design only proposes its built-in templates once enough tagged evidence is recorded."
      );
    }
    const growth = this.getGrowth(actor);
    const actorNames = this._actorNames(actor);
    // Events recorded before per-character attribution existed may name other characters; they are
    // not this character's evidence.
    const ownEvents = growth.events.filter((event) => classifyActorName(event.actorName, actorNames) !== "other");
    if (!ownEvents.length) {
      throw new Error(`${actor.name ?? "This character"} has no recorded growth yet -- analyze some session notes first.`);
    }
    const config = this.getGatewayConfig();
    const systemId = game.system?.id;
    const adapter = this._alwaysProposeAdapter();
    let output;
    try {
      // `events` lets the v2 gateway propose from the recorded events directly (stage 1 read the GM-request
      // wrapper as out-of-character and found nothing); `notes` stays for any other adapter.
      output = await this._callAdapterWithDeadline(
        () => adapter({ actor, notes: buildSuggestionNotes(actor, ownEvents), events: ownEvents.slice(-15), systemId, proposalMode: "always" }),
        "suggestion"
      );
    } catch (error) {
      throw new Error(`The AI provider could not suggest proposals: ${error.message}`);
    }
    const candidates = Array.isArray(output) ? [] : Array.isArray(output?.proposals) ? output.proposals : [];
    const { accepted, skipped } = this._validateModelProposals(candidates, actor, { customSynonyms: config.customSynonyms });
    const pendingNames = new Set(growth.proposals.filter((proposal) => proposal.status === "pending").map((proposal) => slugify(proposal.entry?.name ?? "")));
    const rejectedNames = rejectedProposalNames(growth.proposals);
    const known = new Set(growth.proposals.map((proposal) => proposal.id));
    const idByName = (status) => (key) => growth.proposals.find((candidate) => candidate.status === status && slugify(candidate.entry?.name ?? "") === key)?.id ?? null;
    const added = [];
    for (const proposal of accepted) {
      const key = slugify(proposal.entry.name);
      if (known.has(proposal.id) || pendingNames.has(key)) {
        const duplicateOf = known.has(proposal.id) ? proposal.id : idByName("pending")(key) ?? added.find((candidate) => slugify(candidate.entry?.name ?? "") === key)?.id ?? null;
        skipped.push({ proposal, errors: [`A pending proposal named ${proposal.entry.name} already exists.`], reason: "duplicate", duplicateOf });
        continue;
      }
      if (rejectedNames.has(key)) {
        skipped.push({ proposal, errors: [`The GM already rejected a proposal named ${proposal.entry.name}.`], reason: "rejected", duplicateOf: idByName("rejected")(key) });
        continue;
      }
      known.add(proposal.id);
      pendingNames.add(key);
      added.push({ ...stampClassEvolutionLevel(proposal, this.getLevelProgression(actor).level), requestedAt: new Date().toISOString() });
    }
    const mergedProposals = mergeProposals(growth.proposals, added);
    // Board b81a0357: same cap as analyzeSessionNotes, applied here too since "Suggest proposals" is
    // the other place AI proposals land on the actor.
    const { proposals, dropped: cappedOutProposals, cap: pendingCap, pending: pendingCount } = capPendingAiProposals(mergedProposals, config, this.getLevelProgression(actor).grantAllowances, { countAll: true });
    const cappedIds = new Set(proposals.map((p) => p.id));
    const keptAdded = added.filter((proposal) => cappedIds.has(proposal.id));
    if (keptAdded.length) {
      await actor.update({ [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: proposals });
      Hooks.callAll("grand-design-ai.growthProposalsSuggested", actor, keptAdded);
    }
    const adapterSkipped = Array.isArray(output?.skippedProposals) ? output.skippedProposals : [];
    const cappedSkipped = cappedOutProposals.map((proposal) => ({
      proposal,
      reason: "pending-cap",
      errors: [`${actor.name ?? "This character"} already has ${pendingCap} pending AI proposals; kept the strongest/newest.`]
    }));
    // Board 43ff2ae9: "0 new proposal(s)" must come with why. Every skip (the gateway's quality gates,
    // validation, duplicates, rejected names, the pending cap) is reported as { name, reason,
    // duplicateOf, message } -- `proposal`/`errors` stay for older callers -- and `capReached` says
    // when the character's pending list is full, so the GM knows to approve or reject first.
    const capReached = cappedOutProposals.length || pendingCount >= pendingCap ? { pending: pendingCount, cap: pendingCap } : null;
    return {
      proposals,
      added: keptAdded,
      skipped: [...adapterSkipped, ...skipped, ...cappedSkipped].map(describeSkip),
      capReached,
      ...(output?.gatewayDiagnostics ? { gatewayDiagnostics: output.gatewayDiagnostics } : {})
    };
  }

  // A v2 gateway adapter (ai-gateway.js#createGatewayAdapter exposes .config and .transport) built
  // with proposalMode "when-earned"/"never" would skip stage 2 for a character with no allowance, so
  // it is rebuilt around the same transport (which holds the real API key; .config's is redacted)
  // with proposalMode "always". Anything else is used as-is.
  _alwaysProposeAdapter() {
    const adapter = this._proposalAdapter;
    if (!adapter?.config || !adapter?.transport || adapter.config.proposalMode === "always") return adapter;
    try {
      return createGatewayAdapter({ ...adapter.config, apiKey: "", proposalMode: "always" }, { transportFactory: () => adapter.transport });
    } catch (error) {
      console.warn(`${MODULE_ID} | could not force proposalMode "always"; using the configured adapter`, error);
      return adapter;
    }
  }

  // Every name the notes might use for this character: the actor name and its token name.
  _actorNames(actor) {
    return [actor?.name, actor?.prototypeToken?.name].filter((name) => typeof name === "string" && name.trim());
  }

  // `fromAdapter`: the event came from the AI gateway's reading of the notes. Stage 2 already covers
  // templates and themes for those, so minting a template or a "<Theme> Knack" placeholder as well
  // duplicated its proposals (board d8c96c43); the local path (no adapter, or one that failed) still
  // generates both.
  async recordGrowthEvent(actor, event, { observeThemes: observe = true, fromAdapter = false } = {}) {
    this._assertSupportedSystemActor(actor);
    this._assertGm();
    const growth = this.getGrowth(actor);
    const normalizedEvent = normalizeGrowthEvent(event, growth.events.length + 1);
    const events = [...growth.events, normalizedEvent];
    const levelProgression = this.getLevelProgression(actor);
    const updatedProgression = {
      ...levelProgression,
      progress: levelProgression.progress + progressionForEvent(normalizedEvent)
    };
    const systemId = game.system?.id;
    const registry = this.getActorRegistry(actor);
    const rollContext = rollContextFor(actor, systemId, registry);
    const emergentEnabled = this._emergentEnabled();
    const themeMap = emergentEnabled ? this._themeMap() : {};
    // The GM's theme map is applied before template matching too: a theme mapped onto a canonical
    // tag ("beekeeping" -> nature) is then ordinary evidence for that tag's templates.
    const mappedEvents = applyThemeMap(events, themeMap);
    const pendingAiThemes = pendingAiProposalThemes(growth.proposals);
    const generated = fromAdapter
      ? []
      : [
        ...generateSkillProposals(mappedEvents, registry, 0, this.getConsolidations(actor), this.getTagWeights(), { systemId, rollContext }),
        ...(emergentEnabled ? generateEmergentProposals(events, registry, { themeMap, systemId, excludeThemes: pendingAiThemes, actorNames: this._actorNames(actor) }) : [])
      ];
    const known = new Map(growth.proposals.map((proposal) => [proposal.id, proposal]));
    // Template/theme proposal ids are already stable per template or theme, so a rejected one is
    // normally re-matched by id below and left alone; this name check is the fallback for the case
    // an id changes (a re-slugified name, a re-authored placeholder) but the idea is the same one the
    // GM already said no to.
    const rejectedNames = rejectedProposalNames(growth.proposals);
    for (const proposal of generated) {
      const existing = known.get(proposal.id);
      if (!existing) {
        if (rejectedNames.has(slugify(proposal.entry?.name ?? ""))) continue;
        known.set(proposal.id, proposal);
      } else if (existing.status === "pending") {
        // Anything the AI authored (a placeholder, a rewritten template) keeps its authored entry;
        // only its evidence list is refreshed (board 0a1c8463).
        // A GM edit (updateProposal) is kept the same way.
        const authored = existing.authoredBy === "ai-gateway" || Boolean(existing.editedAt) || (existing.source === "emergent" && existing.needsAuthoring === false);
        known.set(proposal.id, authored ? { ...existing, evidence: proposal.evidence } : proposal);
      }
    }
    const proposals = [...known.values()];
    await actor.update({
      [`flags.${MODULE_ID}.${GROWTH_EVENTS_FLAG}`]: events,
      [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: proposals,
      [`flags.${MODULE_ID}.${LEVEL_PROGRESSION_FLAG}`]: updatedProgression
    });
    if (observe) await this._observeThemes([normalizedEvent], { actor });
    Hooks.callAll("grand-design-ai.growthEventRecorded", actor, normalizedEvent, proposals);
    return { event: normalizedEvent, proposals };
  }
  async approveSkillProposal(actor, id, options = {}) {
    return this.approveProposal(actor, id, options);
  }

  async approveProposal(actor, id, options = {}) {
    this._assertSupportedSystemActor(actor);
    this._assertGm();
    return this._withActorLock(actor, "approve", () => this._approveProposal(actor, id, options));
  }

  async _approveProposal(actor, id, { confirm = false } = {}) {
    const growth = this.getGrowth(actor);
    const proposal = growth.proposals.find((candidate) => candidate.id === id && candidate.status === "pending");
    if (!proposal) throw new Error(`No pending skill proposal exists for ${id}.`);
    // A generic "<Theme> Knack" placeholder is not something to approve when the AI can write the real
    // one; `confirm: true` approves it as-is (board 3d80edf3).
    if (proposal.needsAuthoring && this._proposalAdapter && confirm !== true) {
      throw new Error(`"${proposal.entry?.name ?? id}" is a generic placeholder: use "Author with AI" first, or approve it with confirm: true to accept it as written.`);
    }
    const kind = proposal.kind ?? "skill";
    const operation = proposal.entry?.metadata?.lineage?.operation ?? "origin";
    const levelProgression = this.getLevelProgression(actor);
    // What pays for the proposal. A Title is earned by its deed and a requested evolution/merge by the
    // readiness or the GM's choice, so neither spends (nor needs) a grant allowance; a merge offered
    // as a Class milestone's reward spends it like the milestone's other option.
    const needsAllowance = proposal.isCapstone === true
      || (kind !== "title" && !(["skill-evolution", "class-merge"].includes(proposal.source) && !Number.isInteger(proposal.milestoneLevel)));
    if (needsAllowance) {
      const eligibility = canApproveGeneratedProposal(levelProgression, proposal);
      if (!eligibility.valid) throw new Error(eligibility.error);
    }
    let approved;
    if (kind === "title") {
      // grantTitle creates the Title Item and accrues Horror Rank for a red Title.
      approved = await this.grantTitle(actor, proposal.entry);
    } else {
      approved = await this._approveEvolution(actor, kind, proposal.entry, operation);
    }
    // Conversion rules 2.3/2.4: an evolved or merged entry replaces its sources.
    let superseded = [];
    if (kind !== "title" && (operation === "upgrade" || operation === "combine")) {
      superseded = proposal.entry.metadata?.lineage?.sources ?? [];
      if (superseded.length) {
        approved = { ...approved, registry: await this._supersedeSources(actor, kind, superseded, proposal.entry.metadata.id) };
      }
    }
    const proposals = growth.proposals.map((candidate) =>
      candidate.id === id ? { ...candidate, status: "approved", approvedAt: new Date().toISOString() } : candidate
    );
    // A capstone proposal (progression.js#generateCapstoneProposal) is guaranteed by hitting a
    // level divisible by 10, not by the ordinary per-rest grant allowance every other generated
    // proposal spends -- so it draws down its own allowance track instead.
    const spend = proposal.isCapstone ? spendCapstoneAllowance : spendGrantAllowance;
    await actor.update({
      [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: proposals,
      ...(needsAllowance ? { [`flags.${MODULE_ID}.${LEVEL_PROGRESSION_FLAG}`]: spend(levelProgression) } : {})
    });
    Hooks.callAll("grand-design-ai.skillProposalApproved", actor, proposal, approved);
    return superseded.length ? { ...approved, superseded } : approved;
  }

  /**
   * The GM's "no" (playtest ember-road s2: "Warden's Duty: Gatekeeper" was not a Skill,
   * "Honeycomb: Artisan's Trade" was garbled). Only a pending proposal can be rejected; approving or
   * rejecting a proposal that is already approved/rejected is refused the same way approveProposal
   * refuses a non-pending id. Nothing is deleted -- the proposal and its cited evidence events stay on
   * the actor, just marked `status: "rejected"` so it drops out of every "pending" filter (the Growth
   * dialog's list, requestGrowthProposals' and analyzeSessionNotes' duplicate-name checks) without
   * losing the GM's evidence. Calling this twice on the same id is a no-op the second time (idempotent)
   * rather than an error, so a double-click or a retried command never throws.
   */
  async rejectProposal(actor, id, options = {}) {
    this._assertSupportedSystemActor(actor);
    this._assertGm();
    return this._withActorLock(actor, "reject", () => this._rejectProposal(actor, id, options));
  }

  async _rejectProposal(actor, id, { reason } = {}) {
    const growth = this.getGrowth(actor);
    const proposal = growth.proposals.find((candidate) => candidate.id === id);
    if (proposal?.status === "rejected") return proposal;
    if (!proposal || proposal.status !== "pending") throw new Error(`No pending skill proposal exists for ${id}.`);
    const trimmedReason = typeof reason === "string" ? reason.trim() : "";
    const rejected = {
      ...proposal,
      status: "rejected",
      rejectedAt: new Date().toISOString(),
      ...(trimmedReason ? { rejectedReason: trimmedReason } : {})
    };
    const proposals = growth.proposals.map((candidate) => (candidate.id === id ? rejected : candidate));
    await actor.update({ [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: proposals });
    Hooks.callAll("grand-design-ai.proposalRejected", actor, rejected);
    return rejected;
  }

  /**
   * The GM's edit of a PENDING proposal (the Growth dialog's proposal editor). `patch` is either
   * `{ entry: <edited entry> }` -- each top-level entry field it carries replaces the stored one
   * (mechanics, gameItem wholesale; metadata merged so the registry id and lineage survive) -- or
   * shortcut fields merged one by one: name, tier, system_equivalent, system_chassis, level,
   * power_tier, is_primary, is_secondary, effect (alias description), duration, trigger,
   * requirements, frequency, actions, roll (merged into the stored roll), gameItem (merged), tags,
   * themes, mechanics (merged), metadata (merged). Both may be combined; the shortcuts apply last.
   * Tags go through the same canonical/synonym/theme split the AI's proposals do.
   *
   * The result is validated with validator.js; an invalid edit is NOT saved. Returns
   * `{ ok, errors, proposal }` -- `proposal` is the saved one on success, the unchanged stored one
   * otherwise (null if the id is unknown). Approved and rejected proposals are never touched. The
   * edited proposal stays pending, is stamped `editedBy: "gm"`/`editedAt`, and is from then on kept
   * as written by recorded events and re-analyses (like an AI-authored one).
   */
  async updateProposal(actor, proposalId, patch = {}) {
    this._assertSupportedSystemActor(actor);
    this._assertGm();
    return this._withActorLock(actor, "edit", async () => {
      const growth = this.getGrowth(actor);
      const proposal = growth.proposals.find((candidate) => candidate.id === proposalId) ?? null;
      if (!proposal) return { ok: false, errors: [`No proposal exists for ${proposalId}.`], proposal: null };
      if (proposal.status !== "pending") {
        return { ok: false, errors: [`Only a pending proposal can be edited; "${proposal.entry?.name ?? proposalId}" is ${proposal.status}.`], proposal };
      }
      const { entry, errors: patchErrors } = applyProposalPatch(proposal.entry, patch, { customSynonyms: this.getGatewayConfig().customSynonyms });
      if (patchErrors.length) return { ok: false, errors: patchErrors, proposal };
      const kind = proposal.kind ?? "skill";
      if (kind === "title") {
        // A Title has no mechanics: the editor's description/effect is the deed it was earned for.
        const deed = patch.achievement ?? patch.description ?? patch.effect;
        if (typeof deed === "string") entry.achievement = deed.trim();
        if (!Object.keys(entry.mechanics ?? {}).length || proposal.entry?.mechanics === undefined) delete entry.mechanics;
      }
      const validation = kind === "class" ? validateClassEntry(entry) : kind === "title" ? validateTitleEntry(entry) : validateSkillEntry(entry);
      const errors = [...validation.errors];
      if (proposal.isCapstone && entry.tier !== 3) errors.push(`[${entry.name}] a capstone Skill is always tier 3.`);
      const registry = this.getActorRegistry(actor);
      const bucket = kind === "class" ? registry.classes : kind === "title" ? registry.titles : registry.skills;
      const evolvedFrom = new Set(entry.metadata?.lineage?.sources ?? []);
      const clashId = typeof entry.name === "string" ? `${kind}:${slugify(entry.name)}` : null;
      // The id an evolved/merged entry keeps is its own (metadata.id); only an owned entry that is not
      // one of its sources under the same name is a clash.
      if (clashId && bucket?.[clashId] && !evolvedFrom.has(clashId)) {
        errors.push(`[${entry.name}] is already an approved ${kind === "class" ? "Class" : kind === "title" ? "Title" : "Skill"} on ${actor.name ?? "this character"}.`);
      }
      if (errors.length) return { ok: false, errors, proposal };
      const updated = {
        ...proposal,
        entry,
        status: "pending",
        editedBy: "gm",
        editedAt: new Date().toISOString(),
        // Written by the GM now: no longer a generic placeholder waiting for "Author with AI".
        ...(proposal.needsAuthoring ? { needsAuthoring: false } : {})
      };
      const proposals = growth.proposals.map((candidate) => (candidate.id === proposalId ? updated : candidate));
      await actor.update({ [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: proposals });
      Hooks.callAll("grand-design-ai.proposalUpdated", actor, updated);
      return { ok: true, errors: [], proposal: updated };
    });
  }

  /**
   * Board b375d56c: asks for a milestone reward (a capstone Skill or a Class evolution) again -- after
   * the template fallback stood in for the AI, after the GM rejected it, or when its row went missing.
   * Runs _resolveMilestoneReward exactly as the rest did (AI first; the template with a stated reason
   * if the AI cannot deliver) and puts the result back PENDING under the same milestone id, so the
   * capstone/grant allowance the rest earned can still be spent (a rejection never consumed it).
   * `proposalId` is the milestone's id ("proposal:capstone-20", "proposal:class-evolution-30"); a
   * milestone the character has reached can be asked for even if no row exists for it. An approved
   * milestone is refused. The replaced version is remembered in `previousAttempts` (a rejected name
   * stays rejected: the AI's answer is not accepted under that name again).
   * Returns { proposal, usedFallback, reason? }.
   */
  async retryMilestoneReward(actor, proposalId) {
    this._assertSupportedSystemActor(actor);
    this._assertGm();
    return this._withActorLock(actor, "retry milestone", async () => {
      const growth = this.getGrowth(actor);
      const existing = growth.proposals.find((candidate) => candidate.id === proposalId) ?? null;
      const parsed = parseMilestoneId(proposalId);
      const kind = existing ? milestoneKind(existing) : parsed?.kind;
      const level = Number.isInteger(existing?.milestoneLevel) ? existing.milestoneLevel : parsed?.level;
      if (!kind || !Number.isInteger(level)) {
        throw new Error(`${proposalId} is not a milestone reward (a capstone Skill or a Class evolution); use "Suggest proposals" or "Author with AI" instead.`);
      }
      if (existing?.status === "approved") {
        throw new Error(`"${existing.entry?.name ?? proposalId}" was already approved; there is nothing to retry.`);
      }
      const reached = this.getLevelProgression(actor).level;
      const isMilestone = kind === "capstone" ? isCapstoneLevel(level) : CLASS_EVOLUTION_LEVELS.has(level);
      if (!isMilestone || level > reached) {
        throw new Error(`Grand Design level ${level} grants no ${kind === "capstone" ? "capstone Skill" : "Class evolution"} ${actor.name ?? "this character"} has reached (current level ${reached}).`);
      }
      const systemId = game.system?.id;
      const registry = this.getActorRegistry(actor);
      const actorNames = this._actorNames(actor);
      const ownEvents = growth.events.filter((event) => classifyActorName(event.actorName, actorNames) !== "other");
      const rejectedNames = rejectedProposalNames(growth.proposals);
      if (existing?.status === "rejected" && existing.entry?.name) rejectedNames.add(slugify(existing.entry.name));
      const { proposal, usedFallback, reason } = await this._resolveMilestoneReward(actor, {
        kind, level, ownEvents, registry, systemId, config: this.getGatewayConfig(), rejectedNames
      });
      const previousAttempts = [
        ...(Array.isArray(existing?.previousAttempts) ? existing.previousAttempts : []),
        ...(existing
          ? [{
            name: existing.entry?.name ?? null,
            status: existing.status,
            ...(existing.usedFallback ? { usedFallback: true } : {}),
            ...(existing.rejectedAt ? { rejectedAt: existing.rejectedAt } : {}),
            ...(existing.rejectedReason ? { rejectedReason: existing.rejectedReason } : {})
          }]
          : [])
      ].slice(-5);
      const replacement = {
        ...proposal,
        retriedAt: new Date().toISOString(),
        retryCount: (existing?.retryCount ?? 0) + 1,
        ...(previousAttempts.length ? { previousAttempts } : {})
      };
      const latest = this.getGrowth(actor).proposals;
      const proposals = latest.some((candidate) => candidate.id === replacement.id)
        ? latest.map((candidate) => (candidate.id === replacement.id ? replacement : candidate))
        : [...latest, replacement];
      await actor.update({ [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: proposals });
      Hooks.callAll("grand-design-ai.milestoneRewardRetried", actor, replacement);
      return { proposal: replacement, usedFallback, ...(usedFallback ? { reason } : {}) };
    });
  }

  /**
   * Every milestone reward the character has reached, with what became of it: status "pending",
   * "approved", "rejected" or "missing" (no row: e.g. dropped by an older re-analysis). A GM (or the
   * Growth dialog) can hand any non-approved one to retryMilestoneReward.
   */
  getMilestoneRewards(actor) {
    const reached = this.getLevelProgression(actor).level;
    const proposals = this.getGrowth(actor).proposals;
    const rewards = [];
    for (let level = 10; level <= reached; level += 10) {
      const kinds = [["capstone", `proposal:capstone-${level}`]];
      if (CLASS_EVOLUTION_LEVELS.has(level)) kinds.push(["class-evolution", `proposal:class-evolution-${level}`]);
      for (const [kind, proposalId] of kinds) {
        const row = proposals.find((candidate) => candidate.id === proposalId);
        rewards.push({
          kind,
          level,
          proposalId,
          status: row?.status ?? "missing",
          ...(row?.entry?.name ? { name: row.entry.name } : {}),
          ...(row?.usedFallback ? { usedFallback: true, fallbackReason: row.fallbackReason } : {}),
          retryable: row?.status !== "approved"
        });
      }
    }
    return rewards;
  }

  async runTestScenario() {
    this._assertGm();
    if (game.system.id !== "pf2e") {
      // "The First Steam" is a deterministic fixture campaign whose assertions hard-code PF2e's
      // Item schema (system.actionType.value, system.damage.dice/die, etc.) on purpose, as a
      // fixed regression check -- it intentionally does not generalize the way the live
      // AI-provider campaign (runAiTestScenario) does.
      throw new Error("The Grand Design test scenario ('The First Steam') requires the PF2e game system.");
    }
    return runTestScenario(this);
  }

  /**
   * Every Grand Design level divisible by 10 guarantees one capstone Skill (progression.js#isCapstoneLevel),
   * and every level in CLASS_EVOLUTION_LEVELS (20/30/50) also guarantees a Class evolution -- canon
   * promises both automatically, so the GM should never have to separately click "Suggest proposals"
   * to get what a level-up already earned (owner request, 2026-09-28). Resolved right here, with the
   * same configured AI gateway and per-actor events "Suggest proposals" uses, one milestone at a
   * time so a capstone-only request never gets handed a Class and vice versa even when one level
   * grants both. See _resolveMilestoneReward for the guarantee that this never costs the GM the rest
   * result: the level-up itself is persisted BEFORE any AI call, and a missing/throwing/empty AI
   * answer always falls back to a deterministic template.
   */
  async resolveLevelRest(actor, options) {
    this._assertSupportedSystemActor(actor);
    this._assertGm();
    return this._withActorLock(actor, "rest", () => this._resolveLevelRest(actor, options));
  }

  async _resolveLevelRest(actor, options) {
    const result = resolveRest(this.getLevelProgression(actor), options);

    // Persisted first and unconditionally: whatever happens below (network down, AI provider
    // misbehaving), the GM's level-up is never lost.
    await actor.update({ [`flags.${MODULE_ID}.${LEVEL_PROGRESSION_FLAG}`]: result.progression });

    let capstoneProposals = [];
    let classProposals = [];
    const warnings = [];
    const milestones = [
      ...result.capstoneLevelsUnlocked.map((level) => ({ kind: "capstone", level })),
      ...result.classEvolutionUnlocked.map((level) => ({ kind: "class-evolution", level }))
    ];

    if (milestones.length) {
      const growth = this.getGrowth(actor);
      const registry = this.getActorRegistry(actor);
      const systemId = game.system?.id;
      const actorNames = this._actorNames(actor);
      // Same rule requestGrowthProposals uses: events recorded for another character (or before
      // per-character attribution existed) are not this character's evidence.
      const ownEvents = growth.events.filter((event) => classifyActorName(event.actorName, actorNames) !== "other");
      const config = this.getGatewayConfig();
      const rejectedNames = rejectedProposalNames(growth.proposals);
      for (const { kind, level } of milestones) {
        const { proposal, usedFallback, reason } = await this._resolveMilestoneReward(actor, {
          kind, level, ownEvents, registry, systemId, config, rejectedNames
        });
        if (kind === "capstone") capstoneProposals.push(proposal);
        else classProposals.push(proposal);
        if (usedFallback) {
          warnings.push(
            `${kind === "capstone" ? "Capstone Skill" : "Class evolution"} at Grand Design level ${level}: `
              + `used the built-in template (${reason}). The GM should review and flesh it out.`
          );
        }
        // Board 7b616fea: with two or more active Classes a Class milestone also offers a MERGE of the
        // best-focused pair (conversion rules 2.3/2.4), next to the new-Class option; either spends the
        // milestone's grant allowance.
        if (kind === "class-evolution") {
          const merge = await this._milestoneMerge(actor, level, registry, growth.proposals);
          if (merge) {
            classProposals.push(merge.proposal);
            if (merge.usedFallback) {
              warnings.push(`Class merge at Grand Design level ${level}: used the built-in merge rules (${merge.reason}). The GM should review it.`);
            }
          }
        }
      }
      await actor.update({
        [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: mergeProposals(growth.proposals, [...capstoneProposals, ...classProposals])
      });
    }

    Hooks.callAll("grand-design-ai.levelsResolved", actor, result);
    const evolutionReady = this._announceEvolutionReady(actor);
    return { ...result, capstoneProposals, classProposals, evolutionReady, ...(warnings.length ? { warnings } : {}) };
  }

  // The merge half of a Class milestone, or null when the character has fewer than two active
  // Classes or already has this milestone's merge. A failure here never costs the rest: it is
  // reported as a warning-free null (the new-Class option is still there).
  async _milestoneMerge(actor, level, registry, existingProposals) {
    const proposalId = `proposal:class-merge-${level}`;
    if (existingProposals.some((candidate) => candidate.id === proposalId)) return null;
    const active = Object.values(registry.classes ?? {}).filter(isActiveEntry);
    const pair = pickMergeSources(active);
    if (pair.length < 2) return null;
    try {
      return await this._buildMergeProposal(actor, {
        classIds: pair.map((entry) => entry.metadata.id),
        milestoneLevel: level,
        proposalId
      });
    } catch (error) {
      console.warn(`${MODULE_ID} | could not build the Class merge for Grand Design level ${level}`, error);
      return null;
    }
  }

  /**
   * One milestone reward (a capstone Skill, or a Class evolution), tried through the AI gateway
   * first -- same `_alwaysProposeAdapter`/events-as-evidence path `requestGrowthProposals` uses --
   * and falling back to a deterministic template (generateCapstoneProposal /
   * generateClassEvolutionProposal) whenever the AI can't deliver: no provider configured, the
   * adapter throws or times out, or it returns nothing of the requested kind that validates. The
   * rest itself is never at risk here -- this only ever produces a proposal, one way or the other.
   */
  async _resolveMilestoneReward(actor, { kind, level, ownEvents, registry, systemId, config, rejectedNames = new Set() }) {
    const isCapstone = kind === "capstone";
    // Board 0ed137cb / 17c10e97 / 9ebbf3c9: the template reads the character (level-based DC, the
    // real modifier of the check it rolls, a name flavored from its Class), not the Grand Design level.
    const rollContext = rollContextFor(actor, systemId, registry);
    const buildFallback = () => {
      if (isCapstone) return generateCapstoneProposal(level, ownEvents, registry, 0, { systemId, rollContext });
      const adapter = getSystemAdapter(systemId);
      return generateClassEvolutionProposal(level, ownEvents, registry, 0, {
        systemId,
        actorLevel: adapter.getCharacterLevel(actor),
        systemClass: adapter.getCharacterClass?.(actor) ?? null,
        rollContext
      });
    };

    // The template stands in for the AI: the proposal itself says so (usedFallback + fallbackReason),
    // so the Growth dialog can label it a template and not only the rest warning.
    const fallback = (reason) => ({
      proposal: { ...buildFallback(), usedFallback: true, fallbackReason: reason },
      usedFallback: true,
      reason
    });
    if (!this._proposalAdapter) {
      return fallback("no AI provider is configured");
    }
    // The adapter marks a Class milestone as available for THE MILESTONE LEVEL (ai-gateway.js), not the
    // live one, so a rest that crossed several levels still gets an AI Class (board f48a1e52).

    const adapter = this._alwaysProposeAdapter();
    let output;
    try {
      output = await this._callAdapterWithDeadline(() => adapter({
        actor,
        notes: buildSuggestionNotes(actor, ownEvents),
        events: ownEvents.slice(-15),
        systemId,
        proposalMode: "always",
        milestone: { kind, level }
      }), "milestone reward");
    } catch (error) {
      return fallback(`the AI provider failed: ${error.message}`);
    }
    const candidates = Array.isArray(output) ? [] : Array.isArray(output?.proposals) ? output.proposals : [];
    const wantedKind = isCapstone ? "skill" : "class";
    const { accepted } = this._validateModelProposals(
      candidates.filter((candidate) => candidate?.kind === wantedKind),
      actor,
      { customSynonyms: config.customSynonyms }
    );
    // A name the GM already rejected is not offered again (a retry after a rejection must bring
    // something new).
    const authored = accepted.find((candidate) => !rejectedNames.has(slugify(candidate.entry?.name ?? "")));
    if (!authored) {
      // Say WHY when the gateway dropped what the model wrote (a quality gate), not only that nothing came.
      const gatewaySkipped = Array.isArray(output?.skippedProposals) ? output.skippedProposals : [];
      const why = gatewaySkipped
        .map((skip) => [skip?.proposal?.entry?.name, skip?.reason ?? skip?.errors?.join(" ")].filter(Boolean).join(": "))
        .filter(Boolean)
        .slice(0, 3)
        .join("; ");
      return fallback(accepted.length
        ? `the AI only proposed "${accepted[0].entry.name}" again, which the GM already rejected`
        : `the AI did not return a usable milestone proposal${why ? ` (the gateway skipped ${why})` : ""}`);
    }
    const proposal = {
      id: isCapstone ? `proposal:capstone-${level}` : `proposal:class-evolution-${level}`,
      kind: wantedKind,
      status: "pending",
      source: isCapstone ? "capstone" : "class-evolution",
      systemId,
      milestoneLevel: level,
      ...(isCapstone ? { isCapstone: true } : {}),
      evidence: Array.isArray(authored.evidence) ? authored.evidence : [],
      authoredBy: "ai-gateway",
      entry: structuredClone(authored.entry)
    };
    // A capstone is a rare tier-3 Skill by definition; the live check (2026-09-29, dnd5e) got a tier-1
    // "Fletchwright: Precision Volley" from the model, so the tier is set here, not trusted.
    if (isCapstone && proposal.entry.tier !== 3) proposal.entry.tier = 3;
    return { proposal, usedFallback: false };
  }

  async clearTestScenario() {
    this._assertGm();
    return clearTestScenario();
  }

  async runAiTestScenario() {
    this._assertGm();
    if (!isSupportedSystem(game.system.id)) {
      throw new Error(
        `The Grand Design AI test campaign does not support the "${game.system.id}" game system yet. `
          + `Supported systems: ${supportedSystemIds().join(", ")}.`
      );
    }
    return runAiTestScenario(this);
  }

  async clearAiTestScenario() {
    this._assertGm();
    return clearAiTestScenario();
  }

  setPopulateAdapter(adapter) {
    if (adapter !== null && typeof adapter !== "function") {
      throw new Error("A Populate adapter must be a function or null.");
    }
    this._populateAdapter = adapter;
  }

  hasPopulateAdapter() {
    return this._populateAdapter !== null;
  }

  /**
   * The GM-facing "Populate" pipeline: parses a natural-language prompt (scripts/populate.js
   * either hands it to a registered AI adapter or falls back to its own local heuristic bank) and
   * creates real, ready-to-use Foundry documents from it -- one or more NPC/monster Actors, or a
   * standalone Item -- through this world's game-system adapter so every field lands in the shape
   * that system actually expects. Returns `{ kind, created }` where `created` holds the real
   * Actor/Item documents (already in the world, already visible in their directories).
   */
  async populate(promptText) {
    this._assertGm();
    if (!isSupportedSystem(game.system.id)) {
      throw new Error(
        `Grand Design AI's Populate tool does not support the "${game.system.id}" game system yet. `
          + `Supported systems: ${supportedSystemIds().join(", ")}.`
      );
    }
    const { kind, specs } = await runPopulate(promptText, { adapter: this._populateAdapter });
    const adapter = getSystemAdapter(game.system.id);
    const created = [];
    for (const spec of specs) {
      if (kind === "item") {
        const { source } = adapter.buildEquipmentItemSource(spec);
        created.push(await Item.create(source));
      } else {
        const { source, embeddedItems } = adapter.buildNpcActorSource(spec);
        const actor = await Actor.create(source);
        if (embeddedItems?.length) await actor.createEmbeddedDocuments("Item", embeddedItems);
        created.push(actor);
      }
    }
    Hooks.callAll("grand-design-ai.populated", kind, created);
    return { kind, created };
  }

  /**
   * Validates AI proposals one by one. Returns { accepted, skipped }: an invalid proposal is
   * reported in `skipped` with its errors instead of throwing for the whole batch (AI gateway v2
   * contract -- this intentionally reverses the old fail-loud rule, because the gateway pipeline now
   * repairs proposals first and one surviving bad proposal should not cost the GM nine good events
   * and proposals). Tags are cleaned before validation: canonical tags stay in metadata.tags,
   * synonyms resolve to their canonical tag, and anything unknown moves to metadata.themes.
   */
  _validateModelProposals(proposals, actor, { customSynonyms } = {}) {
    const accepted = [];
    const skipped = [];
    if (!Array.isArray(proposals)) {
      return { accepted, skipped: [{ proposal: proposals, errors: ["AI gateway proposals must be an array."] }] };
    }
    const registry = this.getActorRegistry(actor);
    const systemId = globalThis.game?.system?.id;
    for (const proposal of proposals) {
      if (!proposal || !["skill", "class", "title"].includes(proposal.kind)) {
        skipped.push({ proposal, errors: ["AI gateway proposal kind must be skill, class or title."], reason: "invalid" });
        continue;
      }
      // Board d4ae9326: Titles (named kills, rescues, infamy) have their own shape -- the deed, no
      // mechanics -- and are granted through grantTitle on approval.
      if (proposal.kind === "title") {
        const { entry, error } = titleEntryFromProposal(proposal);
        const validation = entry ? validateTitleEntry(entry) : { valid: false, errors: [error] };
        if (!validation.valid) {
          skipped.push({ proposal, errors: [`Invalid AI title proposal: ${validation.errors.join(" ")}`], reason: "invalid" });
          continue;
        }
        const registryId = `title:${slugify(entry.name)}`;
        if (registry.titles?.[registryId]) {
          skipped.push({ proposal, errors: [`AI proposed an already held Title: ${entry.name}.`], reason: "owned", duplicateOf: registryId });
          continue;
        }
        accepted.push({
          id: proposal.id ?? `proposal:ai-${registryId}`,
          kind: "title",
          status: "pending",
          evidence: Array.isArray(proposal.evidence) ? proposal.evidence : [],
          entry,
          source: "ai-gateway"
        });
        continue;
      }
      if (!proposal.entry || typeof proposal.entry !== "object") {
        skipped.push({ proposal, errors: [`Invalid AI ${proposal.kind} proposal: it has no "entry" object (got keys: ${Object.keys(proposal).join(", ")}).`] });
        continue;
      }
      const entry = structuredClone(proposal.entry);
      if (entry.metadata && typeof entry.metadata === "object" && entry.metadata.tags !== undefined) {
        const { tags, themes } = splitTagsAndThemes(Array.isArray(entry.metadata.tags) ? entry.metadata.tags : [], { customSynonyms });
        entry.metadata.tags = tags;
        const existingThemes = Array.isArray(entry.metadata.themes) ? entry.metadata.themes.map(themeSlug).filter(Boolean) : [];
        const allThemes = [...new Set([...existingThemes, ...themes])];
        if (allThemes.length) entry.metadata.themes = allThemes;
      }
      const validation = proposal.kind === "class" ? validateClassEntry(entry) : validateSkillEntry(entry);
      if (!validation.valid) {
        skipped.push({ proposal, errors: [`Invalid AI ${proposal.kind} proposal: ${validation.errors.join(" ")}`], reason: "invalid" });
        continue;
      }
      const registryId = `${proposal.kind}:${slugify(entry.name)}`;
      const bucket = proposal.kind === "class" ? registry.classes : registry.skills;
      if (bucket?.[registryId]) {
        skipped.push({ proposal, errors: [`AI proposed an already approved ${proposal.kind}: ${entry.name}.`], reason: "owned", duplicateOf: registryId });
        continue;
      }
      // Board 17c10e97: the model guesses the roll bonus ("1d20+9" for a +21 Athletics); when the roll
      // names a statistic the sheet has, the flat fallback roll uses the sheet's own modifier.
      const check = entry.mechanics?.roll ? resolveRollCheck(entry.mechanics.roll.kind, systemId) : null;
      const sheetModifier = check ? checkModifier(actor, check, systemId) : null;
      if (sheetModifier !== null) entry.mechanics.roll.formula = `1d20${sheetModifier >= 0 ? "+" : ""}${Math.round(sheetModifier)}`;
      accepted.push({
        id: proposal.id ?? `proposal:ai-${registryId}`,
        kind: proposal.kind,
        status: "pending",
        evidence: Array.isArray(proposal.evidence) ? proposal.evidence : [],
        entry,
        source: "ai-gateway"
      });
    }
    return { accepted, skipped };
  }

  // Events are individually cheap and individually replaceable. A canonical tag is kept; a synonym
  // the gateway's resolver recognizes is remapped to its canonical tag; anything else becomes an
  // emergent THEME (AI gateway v2) rather than being dropped -- "beekeeping" is real evidence of
  // something, just not something the fixed taxonomy anticipated. Every non-canonical tag is still
  // reported in adapterRejectedTags so the GM can see what the model said. With emergent themes
  // switched off, unknown tags are dropped as before, and an event left with no tag is dropped.
  _sanitizeEventTags(events, { customSynonyms, emergentEnabled = true } = {}) {
    const sanitized = [];
    const rejectedTags = [];
    for (const event of events) {
      const rawTags = Array.isArray(event.tags) ? event.tags : [];
      const { tags, themes, remapped } = splitTagsAndThemes(rawTags, { customSynonyms });
      const rejected = rawTags.filter((tag) => typeof tag === "string" && !isCanonicalTag(tag.trim()));
      const eventThemes = emergentEnabled
        ? [...new Set([...(Array.isArray(event.themes) ? event.themes.map(themeSlug).filter(Boolean) : []), ...themes])]
        : [];
      if (rejected.length) {
        rejectedTags.push({
          summary: event.summary,
          rejected,
          ...(Object.keys(remapped).length ? { remapped } : {}),
          ...(emergentEnabled && themes.length ? { movedToThemes: themes } : {})
        });
      }
      if (!tags.length && !eventThemes.length) continue;
      const { themes: _dropped, ...rest } = event;
      sanitized.push({ ...rest, tags, ...(eventThemes.length ? { themes: eventThemes } : {}) });
    }
    return { events: sanitized, rejectedTags };
  }
  async _approveEvolution(actor, kind, entry, operation) {
    this._assertSupportedSystemActor(actor);
    this._assertGm();
    const validation = kind === "class" ? validateClassEntry(entry) : validateSkillEntry(entry);
    if (!validation.valid) {
      throw new Error(`Grand Design ${kind} is invalid: ${validation.errors.join(" ")}`);
    }

    const registry = cloneRegistry(this.getActorRegistry(actor));
    const normalized = normalizeEntry(kind, entry, registry, operation);
    // Two different entries can slug to the same registry id ("Warden's Brace" / "Wardens Brace");
    // approving the second silently replaced the first's registry record. Re-approving the SAME
    // entry (same name) stays allowed -- _ensureFeatureItem reuses its Item.
    const bucket = kind === "class" ? registry.classes : registry.skills;
    const clash = bucket?.[normalized.metadata.id];
    if (clash && clash.name !== normalized.name) {
      throw new Error(`[${normalized.name}] would overwrite the approved ${kind === "class" ? "Class" : "Skill"} [${clash.name}] (same registry id ${normalized.metadata.id}); rename it first.`);
    }
    const approved = await this._ensureFeatureItem(actor, kind, normalized, registry);

    let finalRegistry = approved.registry;
    let horrorRank = this.getHorrorRank(actor);
    let dockedFrom = [];
    if (normalized.metadata?.polarity === "red") {
      const result = applyHorrorRankIncrement(finalRegistry, horrorRank, HORROR_RANK_POINTS_PER_RED_APPROVAL);
      finalRegistry = result.registry;
      horrorRank = result.horrorRank;
      dockedFrom = result.dockedFrom;
    }
    await actor.update({
      [`flags.${MODULE_ID}.${REGISTRY_FLAG}`]: finalRegistry,
      [`flags.${MODULE_ID}.${HORROR_RANK_FLAG}`]: horrorRank
    });
    Hooks.callAll("grand-design-ai.entryApproved", actor, kind, normalized);
    if (dockedFrom.length) Hooks.callAll("grand-design-ai.horrorRankLevelsDocked", actor, dockedFrom);
    return { ...approved, registry: finalRegistry };
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
    let item = existing;
    if (!item) {
      const { source, postCreate } = createFeatureSource(kind, entry, game.system.id);
      item = (await actor.createEmbeddedDocuments("Item", [source]))[0];
      // dnd5e (and potentially future systems) models an ability's actual effect as a separate
      // embedded Activity document rather than flat fields on the Item itself, so it can only be
      // added once the Item exists. PF2e's adapter has no postCreate step and this is a no-op.
      if (postCreate) await postCreate(item);
    }
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

  _assertSupportedSystemActor(actor) {
    if (!isSupportedSystem(game.system.id)) {
      throw new Error(
        `Grand Design AI does not support the "${game.system.id}" game system yet. `
          + `Supported systems: ${supportedSystemIds().join(", ")}.`
      );
    }
    if (!actor?.documentName || actor.documentName !== "Actor") {
      throw new Error("A Foundry Actor is required.");
    }
  }
}

// Per-actor record of the last notes analyzed (api.js-local on purpose: constants.js is shared).
export const LAST_ANALYSIS_FLAG = "lastAnalysis";

// The gateway core (scripts/ai/index.js, owned by the gateway-core agent) is loaded lazily so this
// file -- and every plain-Node test that imports it -- keeps working even if that directory is
// missing or fails to load; every use below degrades gracefully to null.
let gatewayCorePromise = null;
export function loadGatewayCore() {
  gatewayCorePromise ??= import("./ai/index.js").catch((error) => {
    console.warn(`${MODULE_ID} | AI gateway core unavailable; using built-in fallbacks`, error?.message ?? error);
    return null;
  });
  return gatewayCorePromise;
}

function summarizeThemes(recordedEvents, newlySeen, knownThemes = {}) {
  const counts = new Map();
  for (const event of recordedEvents) {
    for (const theme of event.themes ?? []) counts.set(theme, (counts.get(theme) ?? 0) + 1);
  }
  const fresh = new Set(newlySeen);
  return [...counts].map(([slug, count]) => ({
    slug,
    label: knownThemes[slug]?.label ?? themeLabel(slug),
    count,
    isNew: fresh.has(slug),
    ...(knownThemes[slug]?.mapTo ? { mapTo: knownThemes[slug].mapTo } : {}),
    ...(knownThemes[slug]?.mergeInto ? { mergeInto: knownThemes[slug].mergeInto } : {}),
    ...(knownThemes[slug]?.ignored ? { ignored: true } : {})
  }));
}

/** Small, flag-safe summary of how an analysis went (the full diagnostics stay on the result). */
export function summarizeDiagnostics({ source, gatewayDiagnostics, adapterError, localAnalysis, recorded = [], adapterSkippedEvents = [], adapterSkippedProposals = [], attributedToOthers = [] }) {
  const stages = Array.isArray(gatewayDiagnostics?.stages) ? gatewayDiagnostics.stages : [];
  return {
    source,
    events: recorded.length,
    attributedToOthers: attributedToOthers.length,
    skippedEvents: adapterSkippedEvents.length,
    skippedProposals: adapterSkippedProposals.length,
    ...(gatewayDiagnostics
      ? {
          model: gatewayDiagnostics.model ?? null,
          provider: gatewayDiagnostics.provider ?? null,
          pipeline: gatewayDiagnostics.pipeline ?? null,
          chunks: gatewayDiagnostics.chunks ?? null,
          attempts: stages.reduce((sum, stage) => sum + (Number(stage.attempts) || 0), 0),
          repairs: stages.reduce((sum, stage) => sum + (Array.isArray(stage.repairs) ? stage.repairs.length : 0), 0),
          totalMs: gatewayDiagnostics.totalMs ?? null
        }
      : {}),
    ...(adapterError ? { adapterError: String(adapterError.message ?? adapterError).slice(0, 500) } : {}),
    ...(localAnalysis ? { sentences: localAnalysis.diagnostics.sentences, hint: localAnalysis.diagnostics.hint } : {})
  };
}

// testAiConnection needs an actor-shaped object for buildAiGatewayRequest; nothing is written to it.
function sampleActor() {
  return {
    id: "grand-design-sample",
    name: "Sample Adventurer",
    documentName: "Actor",
    system: { details: { level: { value: 1 } }, skills: {} },
    items: [],
    getFlag: () => undefined
  };
}

// Synthetic note for requestProposalAuthoring when the gateway has no stage-2-only entry point.
export function buildAuthoringNotes(actor, label, theme, evidenceEvents) {
  const lines = evidenceEvents.slice(-8).map((event) => `- ${event.quote ?? event.summary} (${event.outcome})`);
  return [
    `GM REQUEST: author ONE new Grand Design Skill proposal (kind "skill") for ${actor?.name ?? "this character"} `
      + `built around the activity "${label}"${theme ? ` (emergent theme: ${theme})` : ""}. `
      + "It is not covered by the fixed tag list; name it in-world and give it concrete, modest tier-1 or tier-2 mechanics "
      + "that work in both PF2e and D&D 5e terms. Put the theme in metadata.themes. Evidence so far:",
    ...lines
  ].join("\n");
}

// Synthetic note for requestGrowthProposals: the character's own most recent growth, as evidence
// lines the proposal stage can cite verbatim. Summaries (not quotes) because a quote from party notes
// can be first-person ("lost my dagger") and would lose who did it.
export function buildSuggestionNotes(actor, events, { limit = 15 } = {}) {
  const name = actor?.name ?? "this character";
  const lines = events.slice(-limit).map((event) => {
    const themes = Array.isArray(event.themes) && event.themes.length ? `; themes: ${event.themes.join(", ")}` : "";
    return `- ${event.summary} (${event.outcome}; tags: ${(event.tags ?? []).join(", ") || "none"}${themes})`;
  });
  return [
    `GM REQUEST: suggest new Grand Design proposals for ${name} now. Every line below is something ${name} `
      + `personally did (already recorded). Build proposals only from these deeds, cite the lines you used as evidence, `
      + "and use this game system's own rules terms.",
    ...lines
  ].join("\n");
}

/**
 * What a generated entry (template, fallback capstone / Class) needs to know about the character
 * (progression.js#normalizeRollContext). Board 17c10e97: every generated roll used to carry the
 * Acrobatics modifier; now each roll gets the modifier of the check it actually names, read from the
 * sheet. Board 0ed137cb: DCs from the character level. Board 9ebbf3c9: names from its Class.
 */
export function rollContextFor(actor, systemId, registry) {
  let systemClass = null;
  try {
    systemClass = getSystemAdapter(systemId).getCharacterClass?.(actor) ?? null;
  } catch {
    systemClass = null;
  }
  return {
    actorLevel: characterLevel(actor, systemId),
    modifierFor: (check, kind) => checkModifier(actor, check, systemId) ?? attackModifier(actor, kind, systemId),
    dcFor: (check) => characterDc(actor, check, systemId),
    namingClass: (tags) => namingClassFor(registry ?? {}, systemClass, tags)
  };
}

// An attack roll has no single statistic on the sheet the way a skill does; estimate the usual
// to-hit so the flat roll is not a +0 (or someone's Acrobatics). null = nothing to go on.
function attackModifier(actor, kind, systemId) {
  if (typeof kind !== "string" || !/\battack\b|\bstrike\b/i.test(kind) || resolveRollCheck(kind, systemId)) return null;
  const abilities = actor?.system?.abilities ?? {};
  const mod = (key) => Number(abilities?.[key]?.mod) || 0;
  const isSpell = /spell/i.test(kind);
  if (systemId === "dnd5e") {
    const prof = Number(actor?.system?.attributes?.prof) || 2;
    const spellAbility = actor?.system?.attributes?.spellcasting;
    return prof + (isSpell ? mod(spellAbility || "int") : Math.max(mod("str"), mod("dex")));
  }
  const spellDc = Number(actor?.system?.attributes?.spellDC?.value);
  if (isSpell && Number.isFinite(spellDc) && spellDc > 10) return spellDc - 10;
  const level = characterLevel(actor, systemId);
  // Trained proficiency (level + 2) plus the better of Strength/Dexterity.
  return level + 2 + Math.max(mod("str"), mod("dex"));
}

function busyKey(actor) {
  return typeof actor?.uuid === "string" && actor.uuid ? actor.uuid : actor;
}

// Overall deadline for one AI task: the GM can set `analysisDeadlineMs`; otherwise four per-request
// timeouts (gateway-config.js#timeoutMs, 3 minutes by default -> 12 minutes), never under a minute.
export function aiDeadlineMs(config = {}) {
  const explicit = Number(config?.analysisDeadlineMs);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  let timeoutMs = 180000;
  try {
    timeoutMs = normalizeGatewayConfig(config).timeoutMs;
  } catch {
    // defaults
  }
  return Math.max(60000, timeoutMs * 4);
}

function formatDuration(ms) {
  return ms >= 60000 ? `${Math.round(ms / 60000)}-minute` : `${Math.max(1, Math.round(ms / 1000))}-second`;
}

function milestoneKind(proposal) {
  if (proposal?.isCapstone || proposal?.source === "capstone") return "capstone";
  if (proposal?.source === "class-evolution") return "class-evolution";
  return null;
}

function isMilestoneProposal(proposal) {
  return milestoneKind(proposal) !== null && Number.isInteger(proposal?.milestoneLevel);
}

function parseMilestoneId(proposalId) {
  const match = /^proposal:(capstone|class-evolution)-(\d+)$/.exec(String(proposalId ?? ""));
  return match ? { kind: match[1], level: Number(match[2]) } : null;
}

const PATCH_ENTRY_FIELDS = ["name", "tier", "system_equivalent", "system_chassis", "level", "power_tier", "is_primary", "is_secondary"];
const PATCH_MECHANICS_FIELDS = ["effect", "duration", "trigger", "requirements", "frequency", "actions", "roll"];
const PATCH_OTHER_FIELDS = ["entry", "description", "achievement", "gameItem", "mechanics", "metadata", "tags", "themes"];

/**
 * api.updateProposal's merge. Returns { entry, errors } -- errors only for a malformed patch (unknown
 * field, wrong type); the merged entry itself is validated by the caller with validator.js.
 */
export function applyProposalPatch(original, patch, { customSynonyms } = {}) {
  const errors = [];
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { entry: structuredClone(original ?? {}), errors: ["The proposal patch must be an object."] };
  }
  const unknown = Object.keys(patch).filter((key) => ![...PATCH_ENTRY_FIELDS, ...PATCH_MECHANICS_FIELDS, ...PATCH_OTHER_FIELDS].includes(key));
  if (unknown.length) errors.push(`Unknown proposal field(s): ${unknown.join(", ")}.`);
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  let entry = structuredClone(original ?? {});

  // { entry }: the editor's whole edited entry. Each field it carries replaces the stored one; the
  // metadata is merged so the registry id / lineage / polarity the editor did not show survive.
  if (patch.entry !== undefined) {
    if (!isObject(patch.entry)) {
      errors.push("patch.entry must be an object.");
    } else {
      const edited = structuredClone(patch.entry);
      const metadata = isObject(edited.metadata) ? { ...(entry.metadata ?? {}), ...edited.metadata } : entry.metadata;
      entry = { ...entry, ...edited, ...(metadata ? { metadata } : {}) };
    }
  }
  const text = (value) => (typeof value === "string" ? value.trim() : value);
  for (const field of PATCH_ENTRY_FIELDS) {
    if (patch[field] !== undefined) entry[field] = text(patch[field]);
  }
  if (patch.gameItem !== undefined) {
    if (isObject(patch.gameItem)) entry.gameItem = { ...(entry.gameItem ?? {}), ...patch.gameItem };
    else errors.push("gameItem must be an object.");
  }
  if (patch.mechanics !== undefined) {
    if (isObject(patch.mechanics)) entry.mechanics = { ...(entry.mechanics ?? {}), ...structuredClone(patch.mechanics) };
    else errors.push("mechanics must be an object.");
  }
  entry.mechanics = isObject(entry.mechanics) ? entry.mechanics : {};
  const effect = patch.effect ?? patch.description;
  if (effect !== undefined) entry.mechanics.effect = text(effect);
  for (const field of ["duration", "trigger", "requirements", "actions"]) {
    if (patch[field] === null) delete entry.mechanics[field];
    else if (patch[field] !== undefined) entry.mechanics[field] = text(patch[field]);
  }
  if (patch.frequency !== undefined) {
    if (isObject(patch.frequency)) entry.mechanics.frequency = { ...(entry.mechanics.frequency ?? {}), ...patch.frequency };
    else errors.push("frequency must be an object like { max: 1, per: \"day\" }.");
  }
  if (patch.roll === null) {
    delete entry.mechanics.roll;
  } else if (patch.roll !== undefined) {
    if (isObject(patch.roll)) entry.mechanics.roll = { ...(entry.mechanics.roll ?? {}), ...patch.roll };
    else errors.push("roll must be an object like { kind, formula, dc }.");
  }
  if (patch.metadata !== undefined) {
    if (isObject(patch.metadata)) entry.metadata = { ...(entry.metadata ?? {}), ...structuredClone(patch.metadata) };
    else errors.push("metadata must be an object.");
  }
  entry.metadata = isObject(entry.metadata) ? entry.metadata : {};
  if (patch.themes !== undefined) {
    if (Array.isArray(patch.themes)) entry.metadata.themes = patch.themes.map(themeSlug).filter(Boolean);
    else errors.push("themes must be an array of strings.");
  }
  // Tags from the editor go through the same split as the AI's: canonical tags stay, synonyms
  // resolve, anything else becomes an emergent theme -- whichever way they arrived.
  const tagSource = patch.tags !== undefined ? patch.tags : patch.entry?.metadata?.tags ?? patch.metadata?.tags;
  if (tagSource !== undefined) {
    if (!Array.isArray(tagSource) || tagSource.some((tag) => typeof tag !== "string")) {
      errors.push("tags must be an array of strings.");
    } else {
      const { tags, themes } = splitTagsAndThemes(tagSource.map((tag) => tag.trim()).filter(Boolean), { customSynonyms });
      entry.metadata.tags = tags;
      const merged = [...new Set([...(Array.isArray(entry.metadata.themes) ? entry.metadata.themes : []), ...themes])];
      if (merged.length) entry.metadata.themes = merged;
    }
  }
  return { entry, errors };
}

function mergeProposals(existing, additions) {
  const merged = new Map(existing.map((proposal) => [proposal.id, proposal]));
  for (const proposal of additions) {
    if (!merged.has(proposal.id)) merged.set(proposal.id, proposal);
  }
  return [...merged.values()];
}

/**
 * Board b81a0357: AI-authored pending proposals accumulated without limit (Tovin had 5 pending for a
 * single grant allowance, Luz 4). Applied every time the pending set changes (analyzeSessionNotes,
 * requestGrowthProposals): if the actor's pending ai-gateway proposals exceed the cap
 * (gateway-config.js#pendingProposalCap, grantAllowances + slack), only the strongest/newest are kept
 * and the rest are dropped, reported once with reason "pending-cap" rather than left to pile up
 * silently. Template/emergent proposals (a different accumulation mechanism, not this board item) are
 * untouched.
 * @returns {{ proposals: object[], dropped: object[], cap: number, pending: number }} (`pending`: the
 *   counted pending proposals left after trimming)
 */
function capPendingAiProposals(proposals, config, allowances, { countAll = false } = {}) {
  const cap = pendingProposalCap(config, allowances);
  // With an AI provider configured every pending source counts (templates and "<Theme> Knack"
  // placeholders sat on top of the AI's proposals: Briik had 12 pending, board d8c96c43) and the
  // unauthored ones go first. Guaranteed milestone rewards (capstone, class-evolution) never compete.
  const counted = (p) => p.status === "pending" && (countAll ? ["ai-gateway", "template", "emergent"].includes(p.source) : p.source === "ai-gateway");
  const isPlaceholder = (p) => p.source !== "ai-gateway" && p.authoredBy !== "ai-gateway" && !p.editedAt && !(p.source === "emergent" && p.needsAuthoring === false);
  const pendingAi = proposals.filter(counted);
  if (pendingAi.length <= cap) return { proposals, dropped: [], cap, pending: pendingAi.length };
  const scored = pendingAi
    .map((p, i) => ({
      p,
      i,
      placeholder: isPlaceholder(p) ? 1 : 0,
      evidence: Array.isArray(p.evidence) ? p.evidence.length : 0,
      at: Date.parse(p.requestedAt ?? p.approvedAt ?? "") || 0
    }))
    // Best (more citing evidence) first, newest first among ties, and original order as the last
    // tiebreak so the result is stable.
    .sort((a, b) => (a.placeholder - b.placeholder) || (b.evidence - a.evidence) || (b.at - a.at) || (b.i - a.i));
  const keepIds = new Set(scored.slice(0, cap).map((s) => s.p.id));
  const dropped = pendingAi.filter((p) => !keepIds.has(p.id));
  const droppedIds = new Set(dropped.map((p) => p.id));
  return { proposals: proposals.filter((p) => !droppedIds.has(p.id)), dropped, cap, pending: pendingAi.length - dropped.length };
}

// A Class the AI wrote while a Class evolution was available stays approvable after the character
// levels past that milestone (progression.js#canApproveGeneratedProposal reads this).
function stampClassEvolutionLevel(proposal, level) {
  return proposal.kind === "class" && CLASS_EVOLUTION_LEVELS.has(level) && !Number.isInteger(proposal.milestoneLevel)
    ? { ...proposal, classEvolutionLevel: level }
    : proposal;
}

// Themes already carried by a pending AI-authored proposal (theme field or entry metadata).
function pendingAiProposalThemes(proposals) {
  const themes = new Set();
  for (const p of Array.isArray(proposals) ? proposals : []) {
    if (p?.status !== "pending" || (p.source !== "ai-gateway" && p.authoredBy !== "ai-gateway")) continue;
    for (const theme of [p.theme, ...(Array.isArray(p.entry?.metadata?.themes) ? p.entry.metadata.themes : [])]) {
      if (typeof theme === "string" && theme) themes.add(theme);
    }
  }
  return [...themes];
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// The slugified names of an actor's rejected proposals. Kept (not just relied on for id equality)
// so a proposal regenerated under a different id -- the gateway re-authoring it, or a template GM
// house rules touched -- still cannot reappear under the exact name the GM already said no to.
function rejectedProposalNames(proposals) {
  const list = Array.isArray(proposals) ? proposals : [];
  return new Set(
    [
      ...list.filter((proposal) => proposal?.status === "rejected").map((proposal) => proposal.entry?.name),
      // A retried milestone (retryMilestoneReward) replaces its rejected row in place; the name it
      // had stays rejected.
      ...list.flatMap((proposal) => (Array.isArray(proposal?.previousAttempts) ? proposal.previousAttempts : [])
        .filter((attempt) => attempt?.status === "rejected")
        .map((attempt) => attempt.name))
    ]
      .map((name) => slugify(name ?? ""))
      .filter(Boolean)
  );
}

// One skipped proposal as the Growth dialog shows it (board 43ff2ae9). Skips come from three places
// with slightly different shapes (the gateway's skippedProposals, _validateModelProposals, the
// duplicate/rejected/cap checks); all become { name, reason, duplicateOf, message } plus the
// original `proposal`/`errors` for callers that read those.
export function describeSkip(skip) {
  const proposal = skip?.proposal ?? null;
  const errors = Array.isArray(skip?.errors) ? skip.errors : typeof skip?.error === "string" ? [skip.error] : [];
  const message = errors.join(" ") || (typeof skip?.message === "string" ? skip.message : "") || String(skip?.reason ?? "skipped");
  const name = proposal?.entry?.name ?? proposal?.name ?? skip?.name ?? null;
  return {
    name: typeof name === "string" && name.trim() ? name.trim() : null,
    reason: typeof skip?.reason === "string" && skip.reason ? skip.reason : "invalid",
    duplicateOf: skip?.duplicateOf ?? null,
    message,
    proposal,
    errors: errors.length ? errors : [message]
  };
}

function sameIds(a, b) {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// A merged Class takes the sources' place in the character's line-up: primary if any source was.
function primaryFlags(sourceClasses) {
  const isPrimary = sourceClasses.some((entry) => entry?.is_primary === true);
  return { is_primary: isPrimary, is_secondary: !isPrimary && sourceClasses.some((entry) => entry?.is_secondary === true) };
}

function validMalignance(malignance) {
  return isPlainObject(malignance) && VICE_TAGS.has(malignance.vice) && typeof malignance.drawback === "string" && malignance.drawback.trim()
    ? { vice: malignance.vice, drawback: malignance.drawback.trim() }
    : null;
}

// Red never washes out of an evolution or a merge (skill-evolution.js / class-merging.js): a red
// source keeps the result red, with the AI's malignance when it is a valid one and the source's
// otherwise. A standard source only turns red when the AI states a valid vice and drawback.
function polarityFor(aiMetadata, sourceMetadata) {
  const aiMalignance = aiMetadata?.polarity === "red" ? validMalignance(aiMetadata.malignance) : null;
  if (sourceMetadata?.polarity === "red") {
    return { polarity: "red", malignance: aiMalignance ?? validMalignance(sourceMetadata.malignance) ?? sourceMetadata.malignance };
  }
  if (aiMalignance) return { polarity: "red", malignance: aiMalignance };
  return { polarity: "standard" };
}

// Board d4ae9326: a stage-2 title proposal ({ name, description, tags, metadata: { polarity, vice? } })
// as a Title entry validator.js#validateTitleEntry and api.grantTitle accept. The deed is the
// achievement text. A red Title needs a vice from the taxonomy and a stated drawback: the vice comes
// from metadata.vice / malignance.vice / a vice tag; the drawback defaults to the infamy the vice
// itself describes. Returns { entry } or { error }.
export function titleEntryFromProposal(proposal) {
  const raw = isPlainObject(proposal?.entry) ? proposal.entry : {};
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return { error: "A Title proposal needs a name." };
  const metadataIn = isPlainObject(raw.metadata) ? raw.metadata : {};
  const achievement = [raw.achievement, raw.description, metadataIn.achievement, proposal?.rationale]
    .find((value) => typeof value === "string" && value.trim());
  if (!achievement) return { error: `[${name}] needs the deed that earned it (description).` };
  const tags = [...new Set([...(Array.isArray(raw.tags) ? raw.tags : []), ...(Array.isArray(metadataIn.tags) ? metadataIn.tags : [])]
    .filter((tag) => typeof tag === "string" && tag.trim()).map((tag) => tag.trim()))];
  const metadata = {
    tags,
    ...(Array.isArray(metadataIn.themes) && metadataIn.themes.length ? { themes: metadataIn.themes } : {}),
    lineage: { operation: "origin", sources: [], rationale: typeof proposal?.rationale === "string" ? proposal.rationale.trim() : "" }
  };
  if (metadataIn.polarity === "red") {
    const vice = [metadataIn.vice, metadataIn.malignance?.vice, ...tags].find((value) => typeof value === "string" && VICE_TAGS.has(value.trim().toLowerCase()));
    if (!vice) return { error: `[${name}] is a red Title but names no vice from the taxonomy (${[...VICE_TAGS].join(", ")}).` };
    const viceKey = vice.trim().toLowerCase();
    const described = VICE_TAXONOMY.find(([tag]) => tag === viceKey)?.[1] ?? "";
    const drawback = [metadataIn.malignance?.drawback, metadataIn.drawback].find((value) => typeof value === "string" && value.trim())
      ?? `Infamy: those who know of the deed treat the bearer with fear and suspicion. ${described}`.trim();
    metadata.polarity = "red";
    metadata.malignance = { vice: viceKey, drawback: drawback.trim() };
  }
  return { entry: { name, achievement: achievement.trim(), metadata } };
}

function consolidationKey(classIdA, classIdB) {
  return [classIdA, classIdB].sort().join("|");
}

function renderConversionHtml(payload) {
  const classes = payload.classes
    .map((entry) => `<li>[${escapeHtml(entry.name)}] level ${entry.level} (${escapeHtml(entry.power_tier)})</li>`)
    .join("");
  const skills = (payload.skills ?? [])
    .map(
      (entry) =>
        `<li>[${escapeHtml(entry.name)}] - Tier ${entry.tier} - ${escapeHtml(entry.system_equivalent)}</li>`
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
