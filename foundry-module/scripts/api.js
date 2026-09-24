import {
  ACTOR_FLAG,
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
  normalizeEntry,
  registerEntry
} from "./lineage.js";
import { mergeClassEntry } from "./class-merging.js";
import { computeEvolutionPressure, evolveSkillEntry } from "./skill-evolution.js";
import { buildCombinationGrowthEvent, buildCombinationSkill } from "./combination-skills.js";
import { clearTestScenario, runTestScenario } from "./test-scenario.js";
import { clearAiTestScenario, runAiTestScenario } from "./ai-test-scenario.js";
import { validateClassEntry, validateConversion, validateSkillEntry, validateTitleEntry } from "./validator.js";
import {
  generateSkillProposals,
  generateCapstoneProposal,
  growthFlags,
  normalizeGrowthEvent,
  canApproveGeneratedProposal,
  progressionForEvent,
  levelProgressionFlags,
  resolveRest,
  spendCapstoneAllowance,
  spendGrantAllowance
} from "./progression.js";
import { explainSessionNotes, validateAdapterEvents } from "./session-notes.js";
import { createAiGatewayAdapter } from "./ai-gateway.js";
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
  buildClassMergePreview(actor, { sourceIds, level, gameItem, mechanics, tags, rationale, systemChassis, intentional, polarity, malignance }) {
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
    return mergeClassEntry({ sourceClasses, level, gameItem, mechanics, tags, rationale, systemChassis, intentional, polarity, malignance, actorLevel });
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
    const events = this.getGrowth(actor).events;
    const tagWeights = this.getTagWeights();
    const entries = sourceId
      ? [[sourceId, registry.skills?.[sourceId]]].filter(([, entry]) => entry)
      : Object.entries(registry.skills ?? {});
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
      malignance
    });
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
      malignance
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
    const combination = buildCombinationSkill({ contributions, id, effect, duration, rationale, polarity, malignance });

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
    return checkClassErosion(this.getGrowth(actor).events, this.getActorRegistry(actor), options);
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

  async _observeThemes(events, { countExisting = true } = {}) {
    if (!this._emergentEnabled()) return [];
    const withThemes = events.filter((event) => Array.isArray(event?.themes) && event.themes.length);
    if (!withThemes.length) return [];
    try {
      const { state, newlySeen } = observeThemes(this._emergentThemeStore.get(), withThemes, new Date().toISOString(), { countExisting });
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
  async analyzeSessionNotes(actor, notes, { replaceEventIds = [] } = {}) {
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
        adapterOutput = await this._proposalAdapter({ actor, notes, systemId: game.system?.id });
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
    const { events: taggedEvents, rejectedTags } = usedAdapter
      ? this._sanitizeEventTags(adapterEvents.events, { customSynonyms: config.customSynonyms, emergentEnabled })
      : { events: localAnalysis.events, rejectedTags: [] };

    // Re-analysis: drop the events the previous run of these same notes recorded (and their progress)
    // before recording the new interpretation, so re-running never double-counts evidence.
    if (replaceEventIds.length) await this._removeRecordedEvents(actor, replaceEventIds);

    const recorded = [];
    let eventProposals = this.getGrowth(actor).proposals;
    for (const event of taggedEvents) {
      const result = await this.recordGrowthEvent(actor, { ...event, source: usedAdapter ? "adapter" : "local" }, { observeThemes: false });
      recorded.push(result.event);
      eventProposals = result.proposals;
    }
    // A re-analysis of the same notes registers any newly noticed theme but does not re-count old ones.
    const newlySeenThemes = await this._observeThemes(recorded, { countExisting: !replaceEventIds.length });

    const { accepted: modelProposals, skipped: invalidProposals } = usedAdapter
      ? this._validateModelProposals(adapterOutput?.proposals ?? [], actor, { customSynonyms: config.customSynonyms })
      : { accepted: [], skipped: [] };
    const proposals = mergeProposals(eventProposals, modelProposals);

    const adapterSkippedEvents = usedAdapter
      ? [...(Array.isArray(adapterOutput?.skippedEvents) ? adapterOutput.skippedEvents : []), ...adapterEvents.skipped]
      : [];
    const adapterSkippedProposals = usedAdapter
      ? [...(Array.isArray(adapterOutput?.skippedProposals) ? adapterOutput.skippedProposals : []), ...invalidProposals]
      : [];
    const gatewayDiagnostics = usedAdapter && adapterOutput && typeof adapterOutput === "object" && !Array.isArray(adapterOutput)
      ? adapterOutput.gatewayDiagnostics ?? adapterOutput.diagnostics ?? null
      : null;
    const themes = summarizeThemes(recorded, newlySeenThemes, this.getEmergentThemes().themes);

    const lastAnalysis = {
      notes,
      at: new Date().toISOString(),
      source,
      eventIds: recorded.map((event) => event.id),
      proposalIds: modelProposals.map((proposal) => proposal.id),
      diagnostics: summarizeDiagnostics({ source, gatewayDiagnostics, adapterError, localAnalysis, recorded, adapterSkippedEvents, adapterSkippedProposals })
    };
    await actor.update({
      [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: proposals,
      [`flags.${MODULE_ID}.${LAST_ANALYSIS_FLAG}`]: lastAnalysis
    });
    return {
      source,
      adapterConfigured: this.hasProposalAdapter(),
      events: recorded,
      proposals,
      themes,
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
    const last = this.getLastAnalysis(actor);
    if (!last?.notes) throw new Error(`No previous session notes are stored for ${actor.name ?? "this actor"}.`);
    if (replace && Array.isArray(last.proposalIds) && last.proposalIds.length) {
      const stale = new Set(last.proposalIds);
      const proposals = this.getGrowth(actor).proposals.filter((proposal) => !(stale.has(proposal.id) && proposal.status === "pending"));
      await actor.update({ [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: proposals });
    }
    return this.analyzeSessionNotes(actor, last.notes, { replaceEventIds: replace ? last.eventIds ?? [] : [] });
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
    const proposals = growth.proposals.filter((proposal) =>
      proposal.status !== "pending"
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
    if (!this._proposalAdapter) throw new Error("Authoring a proposal needs a configured AI provider (Grand Design AI Gateway settings).");
    const growth = this.getGrowth(actor);
    const proposal = growth.proposals.find((candidate) => candidate.id === proposalId && candidate.status === "pending");
    if (!proposal) throw new Error(`No pending proposal exists for ${proposalId}.`);
    const gatewayCore = await loadGatewayCore();
    const config = this.getGatewayConfig();
    const evidenceEvents = growth.events.filter((event) => (proposal.evidence ?? []).includes(event.id));
    const theme = proposal.theme ?? proposal.entry?.metadata?.themes?.[0] ?? null;
    const label = theme ? themeLabel(theme, this._themeMap()) : proposal.entry?.name ?? "this activity";

    let output;
    if (typeof this._proposalAdapter.authorProposal === "function") {
      output = await this._proposalAdapter.authorProposal({ actor, proposal, events: evidenceEvents, theme, label, systemId: game.system?.id });
    } else {
      output = await this._proposalAdapter({ actor, notes: buildAuthoringNotes(actor, label, theme, evidenceEvents), systemId: game.system?.id });
    }
    const candidates = Array.isArray(output) ? [] : Array.isArray(output?.proposals) ? output.proposals : output?.entry ? [output] : [];
    const { accepted, skipped } = this._validateModelProposals(candidates.map((candidate) => ({ kind: "skill", ...candidate })), actor, {
      customSynonyms: config.customSynonyms
    });
    const authored = accepted.find((candidate) => candidate.kind === (proposal.kind ?? "skill")) ?? accepted[0];
    if (!authored) {
      const reasons = skipped.map((entry) => entry.errors?.join(" ")).filter(Boolean).join(" | ");
      throw new Error(`The AI did not return a usable Skill for "${label}".${reasons ? ` ${reasons}` : ""}`);
    }
    const entry = structuredClone(authored.entry);
    entry.metadata ??= {};
    if (theme) entry.metadata.themes = [...new Set([...(entry.metadata.themes ?? []), theme])];
    const updated = {
      ...proposal,
      kind: authored.kind,
      entry,
      needsAuthoring: false,
      authoredBy: "ai-gateway",
      authoredAt: new Date().toISOString()
    };
    const proposals = growth.proposals.map((candidate) => (candidate.id === proposalId ? updated : candidate));
    await actor.update({ [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: proposals });
    Hooks.callAll("grand-design-ai.proposalAuthored", actor, updated);
    return { proposal: updated, skipped, ...(output?.gatewayDiagnostics ? { gatewayDiagnostics: output.gatewayDiagnostics } : {}) };
  }

  async recordGrowthEvent(actor, event, { observeThemes: observe = true } = {}) {
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
    const modifier = actor.system?.skills?.acrobatics?.mod ?? 0;
    const registry = this.getActorRegistry(actor);
    const emergentEnabled = this._emergentEnabled();
    const themeMap = emergentEnabled ? this._themeMap() : {};
    // The GM's theme map is applied before template matching too: a theme mapped onto a canonical
    // tag ("beekeeping" -> nature) is then ordinary evidence for that tag's templates.
    const mappedEvents = applyThemeMap(events, themeMap);
    const generated = [
      ...generateSkillProposals(mappedEvents, registry, modifier, this.getConsolidations(actor), this.getTagWeights()),
      ...(emergentEnabled ? generateEmergentProposals(events, registry, { themeMap }) : [])
    ];
    const known = new Map(growth.proposals.map((proposal) => [proposal.id, proposal]));
    for (const proposal of generated) {
      const existing = known.get(proposal.id);
      if (!existing) {
        known.set(proposal.id, proposal);
      } else if (existing.status === "pending") {
        // An emergent placeholder the GM already had the AI author must keep its authored entry;
        // only its evidence list is refreshed.
        known.set(proposal.id, existing.source === "emergent" && existing.needsAuthoring === false
          ? { ...existing, evidence: proposal.evidence }
          : proposal);
      }
    }
    const proposals = [...known.values()];
    await actor.update({
      [`flags.${MODULE_ID}.${GROWTH_EVENTS_FLAG}`]: events,
      [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: proposals,
      [`flags.${MODULE_ID}.${LEVEL_PROGRESSION_FLAG}`]: updatedProgression
    });
    if (observe) await this._observeThemes([normalizedEvent]);
    Hooks.callAll("grand-design-ai.growthEventRecorded", actor, normalizedEvent, proposals);
    return { event: normalizedEvent, proposals };
  }
  async approveSkillProposal(actor, id) {
    return this.approveProposal(actor, id);
  }

  async approveProposal(actor, id) {
    this._assertSupportedSystemActor(actor);
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
    // A capstone proposal (progression.js#generateCapstoneProposal) is guaranteed by hitting a
    // level divisible by 10, not by the ordinary per-rest grant allowance every other generated
    // proposal spends -- so it draws down its own allowance track instead.
    const spend = proposal.isCapstone ? spendCapstoneAllowance : spendGrantAllowance;
    await actor.update({
      [`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`]: proposals,
      [`flags.${MODULE_ID}.${LEVEL_PROGRESSION_FLAG}`]: spend(levelProgression)
    });
    Hooks.callAll("grand-design-ai.skillProposalApproved", actor, proposal, approved);
    return approved;
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

  async resolveLevelRest(actor, options) {
    this._assertSupportedSystemActor(actor);
    this._assertGm();
    const result = resolveRest(this.getLevelProgression(actor), options);
    const updates = { [`flags.${MODULE_ID}.${LEVEL_PROGRESSION_FLAG}`]: result.progression };

    // Every Grand Design level divisible by 10 guarantees one capstone Skill proposal (see
    // progression.js#generateCapstoneProposal) -- generated here, right when the level is crossed,
    // and merged into the ordinary growth-proposal list so it shows up next to any tag-triggered
    // proposals for the GM to review/approve the same way.
    let capstoneProposals = [];
    if (result.capstoneLevelsUnlocked.length) {
      const growth = this.getGrowth(actor);
      const registry = this.getActorRegistry(actor);
      const modifier = actor.system?.skills?.acrobatics?.mod ?? 0;
      capstoneProposals = result.capstoneLevelsUnlocked.map((level) =>
        generateCapstoneProposal(level, growth.events, registry, modifier)
      );
      updates[`flags.${MODULE_ID}.${GROWTH_PROPOSALS_FLAG}`] = mergeProposals(growth.proposals, capstoneProposals);
    }

    await actor.update(updates);
    Hooks.callAll("grand-design-ai.levelsResolved", actor, result);
    return { ...result, capstoneProposals };
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
    for (const proposal of proposals) {
      if (!proposal || !["skill", "class"].includes(proposal.kind)) {
        skipped.push({ proposal, errors: ["AI gateway proposal kind must be skill or class."] });
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
        skipped.push({ proposal, errors: [`Invalid AI ${proposal.kind} proposal: ${validation.errors.join(" ")}`] });
        continue;
      }
      const registryId = `${proposal.kind}:${slugify(entry.name)}`;
      const bucket = proposal.kind === "class" ? registry.classes : registry.skills;
      if (bucket?.[registryId]) {
        skipped.push({ proposal, errors: [`AI proposed an already approved ${proposal.kind}: ${entry.name}.`] });
        continue;
      }
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
export function summarizeDiagnostics({ source, gatewayDiagnostics, adapterError, localAnalysis, recorded = [], adapterSkippedEvents = [], adapterSkippedProposals = [] }) {
  const stages = Array.isArray(gatewayDiagnostics?.stages) ? gatewayDiagnostics.stages : [];
  return {
    source,
    events: recorded.length,
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
