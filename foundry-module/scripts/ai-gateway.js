import { GROWTH_TAXONOMY } from "./growth-taxonomy.js";
import { CLASS_EVOLUTION_LEVELS, DANGER_GAP_MULTIPLIERS, GROWTH_EVENT_OUTCOME_WEIGHTS, GROWTH_EVENTS_FLAG, GROWTH_PROPOSALS_FLAG, LEVEL_PROGRESSION_FLAG, MODULE_ID, SPELL_SCHOOLS } from "./constants.js";
import { getSystemAdapter } from "./systems/index.js";
import { VICE_TAGS } from "./vice-taxonomy.js";
import { validateClassEntry, validateSkillEntry } from "./validator.js";
import { AiProviderUnreachableError, AiProviderTimeoutError, assertSafeEndpoint, createTransport } from "./ai/transport.js";
import { normalizeGatewayConfig } from "./ai/gateway-config.js";
import { createExtractionCache, runGatewayPipeline } from "./ai/pipeline.js";
import { createJevClient } from "./ai/jev.js";
// Pure (constants/lineage/skill-evolution only): the merge power-tier rule authorAdvanced shares with the fallback.
import { computeMergeFocus, resolveMergedPowerTier, MERGE_FOCUS_STRONG_THRESHOLD, MERGE_FOCUS_WEAK_THRESHOLD } from "./class-merging.js";

// Backward-compatible re-exports: these used to be defined in this file.
export { AiProviderUnreachableError, AiProviderTimeoutError };
export { LEGACY_PROPOSAL_SYSTEM_PROMPT as PROPOSAL_SYSTEM_PROMPT } from "./ai/prompts.js";

export function createAiGatewayAdapter({ endpoint, getHeaders = () => ({}) }) {
  assertSafeEndpoint(endpoint);
  if (typeof getHeaders !== "function") {
    throw new Error("getHeaders must be a function.");
  }
  return async ({ actor, notes }) => {
    const response = await fetchOrExplain(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getHeaders() },
      body: JSON.stringify(buildAiGatewayRequest(actor, notes, typeof game !== "undefined" ? game.system.id : "pf2e"))
    });
    if (!response.ok) throw new Error(`AI gateway returned HTTP ${response.status}.`);
    return response.json();
  };
}

// A browser `fetch` that cannot reach its target rejects with a bare "Failed to fetch". The error
// class that turns that into something a GM can act on now lives in scripts/ai/transport.js (the
// one place that makes provider HTTP calls); it is re-exported here because existing callers and
// tests import it from this module.
async function fetchOrExplain(endpoint, init) {
  try {
    return await fetch(endpoint, init);
  } catch (error) {
    // Only a genuine transport failure lands here; an HTTP error status resolves normally and is
    // handled by the response.ok check in createAiGatewayAdapter.
    throw new AiProviderUnreachableError(endpoint, error);
  }
}

function activeSystemId() {
  return typeof game !== "undefined" && game?.system?.id ? game.system.id : "pf2e";
}

/**
 * The v2 gateway adapter (see docs/ai-gateway-v2-contract.md). Takes a full gateway config
 * (scripts/ai/gateway-config.js keys), builds a transport, and runs the extraction/proposal pipeline.
 *
 * The returned adapter keeps the long-standing signature `async ({ actor, notes, systemId? })` and
 * resolves to `{ events, proposals, themes, skippedEvents, skippedProposals, gatewayDiagnostics }`,
 * which still satisfies session-notes.js#validateAdapterEvents. It only rejects on a TOTAL failure
 * (provider unreachable, or nothing parseable after every repair turn) -- the single path on which
 * api.js#analyzeSessionNotes falls back to the local keyword analyzer.
 *
 * For G2's "Test connection" button the adapter also carries `adapter.ping()`,
 * `adapter.listModels()` and `adapter.config` (the normalized config, apiKey redacted).
 *
 * Jev (docs/jev-layer-contract.md): when `config.jev` is enabled (it needs its own apiKey) the
 * adapter builds a client with `jevFactory` and passes it to every pipeline run; `adapter.jev` is
 * that client or null. A rebuild from `adapter.config` (both keys redacted) keeps Jev only when it
 * is handed the live client: `{ jevFactory: () => adapter.jev }`.
 */
export function createGatewayAdapter(config = {}, { validators, transportFactory = createTransport, jevFactory = createJevClient } = {}) {
  const cfg = normalizeGatewayConfig(config);
  assertSafeEndpoint(cfg.endpoint, { allowPrivateHttp: cfg.allowPrivateHttp });
  if (typeof cfg.model !== "string" || !cfg.model.trim()) throw new Error("An AI model name is required.");
  const transport = transportFactory({
    provider: cfg.provider,
    endpoint: cfg.endpoint,
    allowPrivateHttp: cfg.allowPrivateHttp,
    model: cfg.model,
    apiKey: cfg.apiKey,
    timeoutMs: cfg.timeoutMs,
    fetchImpl: cfg.fetchImpl,
    getHeaders: cfg.getHeaders,
    extraBody: cfg.extraBody,
    sleep: cfg.sleep,
    maxRetries: cfg.maxRetries,
    ollamaOptions: { num_ctx: cfg.numCtx, num_predict: cfg.numPredict }
  });
  const injected = validators ?? { validateSkillEntry, validateClassEntry };
  // A Jev client that cannot be built just means Jev is off: it is an optional speed-up and must
  // never stop the gateway from being created. A redacted key (a rebuild from adapter.config without
  // the live client) is never sent to the default client -- it would 401 on every run.
  let jev = null;
  const redactedKey = /^\*+$/.test(cfg.jev.apiKey);
  if (cfg.jev.enabled && typeof jevFactory === "function" && !(redactedKey && jevFactory === createJevClient)) {
    try {
      jev = jevFactory({
        apiKey: cfg.jev.apiKey,
        endpoint: cfg.jev.endpoint,
        model: cfg.jev.model,
        timeoutMs: cfg.jev.timeoutMs,
        fetchImpl: cfg.jev.fetchImpl,
        sleep: cfg.sleep
      }) ?? null;
    } catch (error) {
      jev = null;
      console.warn("grand-design-ai | could not create the Jev client; continuing without Jev", error?.message ?? error);
    }
  }
  // One stage-1 reading per distinct notes/config, shared by every character this adapter analyses:
  // the same party recap pasted into five sheets used to cost five extractions (ember-road s1).
  // Lives on the adapter, so saving new gateway settings (which builds a new adapter) starts clean.
  const extractionCache = cfg.extractionCacheEntries > 0 && cfg.extractionCacheTtlMs > 0
    ? createExtractionCache({ maxEntries: cfg.extractionCacheEntries, ttlMs: cfg.extractionCacheTtlMs })
    : null;
  // `fresh: true` (a GM's explicit "re-analyze") reads the notes again instead of reusing the cache.
  // `events`: already-recorded events to propose from directly (api.requestGrowthProposals); stage 1 is skipped.
  // `milestone`: a guaranteed Grand Design milestone reward (api.requestGrowthProposals-style call
  // from api.resolveLevelRest) -- see pipeline.js#runGatewayPipeline's milestone param.
  const run = async ({ actor, notes, systemId, fresh = false, events = null, milestone = null, target = null, replacing = null, party = null }) => {
    const sys = systemId ?? cfg.systemId ?? activeSystemId();
    const request = buildAiGatewayRequest(actor, notes, sys);
    // `party`: the roster of a party analysis (api.analyzePartyNotes). It names every PC in the
    // extraction prompt and is Jev's attribution roster, so a PC who never speaks can still be named.
    if (Array.isArray(party) && party.length >= 2) request.party = party;
    // The placeholder being authored is itself pending: it must not count as the thing its own
    // replacement duplicates (the prompt's placeholder rule already says not to reuse it).
    if (replacing && Array.isArray(request.actor?.pendingProposals)) {
      request.actor.pendingProposals = request.actor.pendingProposals.filter((p) => !(replacing.id ? p.id === replacing.id : p.name === replacing.name));
    }
    // A Class request for a milestone the character has ALREADY passed (a multi-level rest, or the GM
    // resting on to 21 before asking) must not be stripped by the live-level gate: the milestone
    // level, not the current one, is what makes a Class available (board f48a1e52).
    if ((milestone?.kind === "class-evolution" || target?.kind === "class") && request.actor?.grandDesign) {
      request.actor.grandDesign.classEvolutionAvailable = true;
    }
    const result = await runGatewayPipeline({ transport, request, config: cfg, validators: injected, systemId: sys, extractionCache, refreshExtraction: fresh === true, presetEvents: Array.isArray(events) ? events : null, milestone, target, jev });
    return {
      events: result.events,
      proposals: result.proposals,
      themes: result.themes,
      skippedEvents: result.skippedEvents,
      skippedProposals: result.skippedProposals,
      gatewayDiagnostics: result.diagnostics
    };
  };
  const adapter = (args = {}) => run(args);
  // "Author with AI" (api.js#requestProposalAuthoring): stage 2 only, over the placeholder's own
  // cited events, told exactly what to write (board 3d80edf3). Never records events.
  adapter.authorProposal = ({ actor, proposal, events = [], theme = null, label = null, systemId } = {}) => {
    const kind = proposal?.kind === "class" ? "class" : "skill";
    const target = {
      kind,
      theme,
      label,
      ...(proposal?.isCapstone ? { isCapstone: true, tier: 3 } : {}),
      placeholder: { name: proposal?.entry?.name ?? label ?? "placeholder", effect: proposal?.entry?.mechanics?.effect }
    };
    return run({ actor, notes: "", systemId, events: Array.isArray(events) ? events : [], target, replacing: { id: proposal?.id ?? null, name: proposal?.entry?.name ?? null } });
  };
  // Boards ebcc3f03 / d4ae9326 (api.requestSkillEvolution / api.requestClassMerge): stage 2 only, like
  // authorProposal, for an entry built FROM owned ones. See buildAdvancedTarget for what is decided in
  // code (tier, power tier, lineage) and pipeline.js#applyAdvancedTarget for where it is enforced.
  // Throws on provider failure (the preset-events path re-throws) so the caller's fallback can say why.
  adapter.authorAdvanced = async ({ actor, operation, sources = [], events = [], systemId, name = null } = {}) => {
    const target = buildAdvancedTarget({ actor, operation, sources, name });
    const given = Array.isArray(events) ? events.filter((event) => event && typeof event.summary === "string" && event.summary.trim()) : [];
    // An evolution's defining moments ARE its evidence; when the caller passes only those (not the
    // full events), stage 2 still gets them as newEvents to cite.
    const moments = given.length ? [] : target.sources.flatMap((source) => (source.definingMoments ?? []).map((summary) => ({
      summary, tags: source.tags ?? [], themes: [], outcome: "success", actorName: actor?.name ?? ""
    })));
    return run({ actor, notes: "", systemId, events: [...given, ...moments], target });
  };
  adapter.ping = () => transport.ping();
  adapter.listModels = () => transport.listModels();
  adapter.transport = transport;
  adapter.clearExtractionCache = () => extractionCache?.clear();
  adapter.jev = jev;
  adapter.config = Object.freeze({
    ...cfg,
    apiKey: cfg.apiKey ? "********" : "",
    fetchImpl: undefined,
    getHeaders: undefined,
    sleep: undefined,
    jev: Object.freeze({ ...cfg.jev, apiKey: cfg.jev.apiKey ? "********" : "", fetchImpl: undefined })
  });
  return adapter;
}

const ADVANCED_OPERATIONS = { upgrade: "skill", combine: "class" };

/**
 * The stage-2 target for adapter.authorAdvanced. Sources are completed from the actor's registry
 * (tags, polarity, malignance, tier/level) when the caller passed only ids and names, so the prompt
 * and the red carry-over see the real entry. The merge's power tier is the conversion rules' merge
 * (class-merging.js: focus score from tag overlap, off-cycle cap) -- the same numbers the
 * deterministic fallback would reach, so AI and fallback never disagree on how strong a merge is.
 */
export function buildAdvancedTarget({ actor, operation, sources = [], name = null } = {}) {
  const kind = ADVANCED_OPERATIONS[operation];
  if (!kind) throw new Error(`authorAdvanced: unknown operation "${operation}" (expected "upgrade" or "combine").`);
  const list = Array.isArray(sources) ? sources.filter((source) => source && (source.id || source.name)) : [];
  if (operation === "upgrade" && list.length !== 1) throw new Error("authorAdvanced upgrade needs exactly one source Skill.");
  if (operation === "combine" && list.length < 2) throw new Error("authorAdvanced combine needs at least two source Classes.");
  const registry = actor?.getFlag?.(MODULE_ID, "registry") ?? {};
  const bucket = (kind === "class" ? registry.classes : registry.skills) ?? {};
  const full = list.map((source) => {
    const owned = (source.id && bucket[source.id]) || Object.values(bucket).find((entry) => entry?.name && entry.name === source.name) || {};
    const md = owned.metadata ?? {};
    const malignance = source.malignance ?? md.malignance;
    return {
      id: source.id ?? md.id ?? null,
      name: source.name ?? owned.name,
      kind,
      ...(kind === "skill" ? { tier: Number.isInteger(source.tier) ? source.tier : Number.isInteger(owned.tier) ? owned.tier : 1 } : {}),
      ...(kind === "class" ? {
        level: Number.isInteger(source.level) ? source.level : Number.isInteger(owned.level) ? owned.level : 1,
        power_tier: source.power_tier ?? owned.power_tier ?? "standard",
        ...(source.focus ?? owned.focus ? { focus: source.focus ?? owned.focus } : {})
      } : {}),
      effect: source.effect ?? owned.mechanics?.effect ?? "",
      tags: Array.isArray(source.tags) ? source.tags : Array.isArray(md.tags) ? md.tags : [],
      polarity: source.polarity ?? md.polarity ?? "standard",
      ...(malignance ? { malignance, vice: malignance.vice } : {}),
      ...(Array.isArray(source.definingMoments) ? { definingMoments: source.definingMoments.filter((m) => typeof m === "string" && m.trim()) } : {})
    };
  });
  const target = { kind, operation, sources: full, ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}) };
  if (operation === "upgrade") {
    target.tier = Math.min(3, (full[0].tier ?? 1) + 1);
    return target;
  }
  const shaped = full.map((source) => ({ power_tier: source.power_tier, metadata: { tags: source.tags } }));
  const { focusScore } = computeMergeFocus(shaped);
  const progression = actor?.getFlag?.(MODULE_ID, LEVEL_PROGRESSION_FLAG) ?? {};
  const gdLevel = Number.isInteger(progression.level) ? progression.level : null;
  const offCycle = gdLevel !== null && !CLASS_EVOLUTION_LEVELS.has(gdLevel);
  target.powerTier = resolveMergedPowerTier(shaped, focusScore, { offCycle });
  target.level = Math.max(...full.map((source) => source.level ?? 1));
  target.offCycle = offCycle;
  target.focusScore = Math.round(focusScore * 100) / 100;
  target.focusNote = `focus score ${target.focusScore}: ${focusScore >= MERGE_FOCUS_STRONG_THRESHOLD ? "tightly focused sources, one tier above the strongest" : focusScore < MERGE_FOCUS_WEAK_THRESHOLD ? "unrelated sources, a generalist blend capped at standard" : "related sources, holds at the strongest source's tier"}${offCycle ? "; off the Grand Design evolution cadence, so no tier bonus" : ""}`;
  return target;
}

// Legacy factory, kept for existing callers (ai-provider-config.js) and tests. Its old options map
// onto the v2 gateway config:
//   transport "ollama-native" -> provider "ollama"; "openai" (default) -> provider "openaiCompatible"
//   requestOptions.options.{num_ctx,num_predict} -> numCtx/numPredict; any other requestOptions keys
//   are merged into every request body verbatim (e.g. { think:false }).
// It defaults to pipeline "single" -- ONE provider call per note chunk, exactly like the old
// adapter -- because callers of this factory were written against one-call semantics. New code
// should use createGatewayAdapter(config), whose default is the more robust "two-stage" pipeline.
//
// History: `transport: "ollama-native"` exists because Ollama's OpenAI-compatibility shim silently
// ignores an `options` object (including `num_ctx`) on /v1/chat/completions, so every response was
// truncated mid-JSON at the 4096-token default and silently fell back to the local analyzer. The v2
// transport goes further and rewrites an Ollama /v1 endpoint to the native /api/chat automatically.
export function createChatCompletionsAdapter({ endpoint, model, getHeaders = () => ({}), requestOptions = {}, transport = "openai", ...rest } = {}) {
  assertSafeEndpoint(endpoint, { allowPrivateHttp: rest.allowPrivateHttp === true });
  if (typeof model !== "string" || !model.trim()) throw new Error("An AI model name is required.");
  if (typeof getHeaders !== "function") throw new Error("getHeaders must be a function.");
  const { options: ollamaOpts, ...extraBody } = requestOptions && typeof requestOptions === "object" ? requestOptions : {};
  return createGatewayAdapter({
    pipeline: "single",
    ...rest,
    provider: transport === "ollama-native" ? "ollama" : (rest.provider ?? "openaiCompatible"),
    endpoint,
    model,
    getHeaders,
    extraBody,
    ...(ollamaOpts?.num_ctx ? { numCtx: ollamaOpts.num_ctx } : {}),
    ...(ollamaOpts?.num_predict ? { numPredict: ollamaOpts.num_predict } : {})
  });
}

// The newest `limit` proposals with this status, reduced to what the near-duplicate check and the
// prompt need (the full entries would crowd the context for nothing).
export function compactProposals(actor, status, limit = 20) {
  const all = actor?.getFlag?.(MODULE_ID, GROWTH_PROPOSALS_FLAG);
  if (!Array.isArray(all)) return [];
  return all
    .filter((proposal) => proposal?.status === status && proposal.entry?.name)
    .slice(-limit)
    .map((proposal) => {
      const entry = proposal.entry;
      return {
        ...(proposal.id ? { id: proposal.id } : {}),
        kind: proposal.kind === "class" ? "class" : proposal.kind === "title" ? "title" : "skill",
        name: entry.name,
        ...(typeof entry.mechanics?.effect === "string" ? { effect: entry.mechanics.effect.slice(0, 300) } : typeof entry.description === "string" ? { effect: entry.description.slice(0, 300) } : {}),
        ...(typeof entry.mechanics?.trigger === "string" ? { trigger: entry.mechanics.trigger.slice(0, 160) } : {}),
        ...(entry.gameItem?.kind ? { gameItemKind: entry.gameItem.kind } : {}),
        tags: Array.isArray(entry.metadata?.tags) ? entry.metadata.tags : [],
        themes: Array.isArray(entry.metadata?.themes) ? entry.metadata.themes : []
      };
    });
}

// systemId defaults to "pf2e" (a plain literal, never `game.system.id`) so this function stays
// callable from plain Node tests with no Foundry `game` global; both call sites below that run
// inside an actual Foundry world pass the real active system id explicitly.
export function buildAiGatewayRequest(actor, notes, systemId = "pf2e") {
  const adapter = getSystemAdapter(systemId);
  const progression = actor.getFlag(MODULE_ID, LEVEL_PROGRESSION_FLAG) ?? {};
  const grandDesignLevel = Number.isInteger(progression.level) ? progression.level : 0;
  return {
    task: `grand-design-${systemId}-proposals`,
    notes,
    actor: {
      name: actor.name,
      system: systemId,
      systemLabel: adapter.label,
      level: adapter.getCharacterLevel(actor),
      systemClass: adapter.getCharacterClass?.(actor) ?? null,
      // Board 3962a001: the actor's own native class features/proficiencies, so stage 2 can tell a
      // proposal apart from something the character's base class already grants (buildProposalMessages,
      // pipeline.js#findDuplicateClassFeature). Best-effort: an adapter without this, or an actor with
      // nothing to report, contributes an empty list rather than failing the whole request.
      ownedFeatures: adapter.getCharacterKnownFeatures?.(actor) ?? [],
      existingGrandDesign: actor.getFlag(MODULE_ID, "registry") ?? {},
      // Board 3574bd96: what is already waiting for the GM, and what the GM turned down. Stage 2 never
      // saw either, so two "Suggest proposals" clicks produced "Unbroken Bastion" and then "Unbroken
      // Bulwark". The prompt shows them and pipeline.js#gateProposals skips near-duplicates of them.
      pendingProposals: compactProposals(actor, "pending"),
      rejectedProposals: compactProposals(actor, "rejected"),
      grandDesign: {
        level: grandDesignLevel,
        availableGrantAllowances: Number.isInteger(progression.grantAllowances) ? progression.grantAllowances : 0,
        classEvolutionAvailable: CLASS_EVOLUTION_LEVELS.has(grandDesignLevel)
      }
    },
    allowedTags: GROWTH_TAXONOMY.map(([tag]) => tag),
    requirements: {
      approvalRequired: true,
      outputMustBeJson: true,
      outputShape: {
        events: ["eventSchema"],
        proposals: ["proposalSchema"]
      },
      eventOutcomePhilosophy:
        "Not just successes: failure and criticalFailure are valid, GM-worthy evidence of genuine repeated effort, "
          + "not something to omit. A character who tries and fails at the same kind of thing over and over is still "
          + "practicing it -- log those attempts as events with outcome failure or criticalFailure rather than leaving "
          + "them out because nothing succeeded. Weight successes higher when deciding whether evidence adds up to a "
          + "proposal (criticalSuccess > success > criticalFailure > failure), but persistence through failure is real "
          + "evidence too, not zero evidence. A pattern of dramatic, costly failures at the same kind of task -- "
          + "criticalFailure, e.g. repeatedly getting hurt attempting something dangerous -- can justify a proposal "
          + "shaped by what was actually learned from failing (caution, resistance, a defensive reflex) instead of only "
          + "a mastery-flavored proposal for succeeding at it.",
      rulesVocabulary: adapter.rulesVocabulary,
      namingConvention:
        "Generated names should read as belonging to the character's own class, not as a generic label. For a Skill "
          + "proposal, prefer \"{class motif}: {concept}\" -- e.g. for a \"Spearmaster\" class, an Undead-Slayer-style "
          + "ability reads as \"Speartip: Undead's Bane\", not just \"Undead Slayer\"; derive the short motif (Speartip) "
          + "from the character's own class name and its dominant tags, then follow it with a colon and the concrete "
          + "concept. For a Class evolution, name length and form should track its actual power: a modest fusion of two "
          + "disciplines reads as one flowing phrase (\"Spearmaster of Horizon's Edge\"); a prestige-tier fusion that "
          + "keeps both source disciplines' full identity intact is written as the two names joined by a comma instead "
          + "of melted into one phrase (\"Spearmaster, Horizon's Edge\"); and a legendary evolution at or above level 50 "
          + "earns a wordy, grandiose title built from its dominant theme instead of its sources' literal names (\"The "
          + "Ephemeral Purveyor of Lost Dreams\"). A character who has spread across many unrelated disciplines instead "
          + "of following one path closely should still get a longer name from stacking all those sources together, "
          + "but the result is capped at standard power_tier regardless of how strong any single source was -- length "
          + "is not power, specialization is -- UNLESS the notes show that breadth was genuinely deliberate (the "
          + "character pursued many disciplines on purpose, as its own path), in which case it is not a punished "
          + "generalist blend at all and should read as a confident, capable one.",
      polarityGuidance:
        "Most Class/Skill entries are metadata.polarity: \"standard\" -- omit the field entirely for these, which is "
          + "almost every proposal. A small minority may instead be metadata.polarity: \"red\": a genuinely taboo, vile, "
          + "or forced origin -- killing that became compulsive rather than a last resort, breaking someone else's will "
          + "or freedom, an addiction the character no longer controls, a bargain that hollowed them out, a sacred trust "
          + "violated, a deliberate betrayal. Ordinary morally-gray professions -- thief, spy, contract killer, smuggler "
          + "-- are NOT red; they stay standard like any other Skill or Class. A red entry MUST also set "
          + `metadata.malignance: { vice, drawback }, where vice is EXACTLY one of: ${[...VICE_TAGS].join(", ")} -- never `
          + "invent a different vice word -- and drawback states a concrete mechanical or narrative cost the entry "
          + "carries; red power is never written as clean or costless. Keep the framing abstracted and non-graphic: name "
          + "and describe the vice's THEME, never depict graphic violence or sexual content in the name, effect, or "
          + "rationale. Only propose a red entry when the session notes actually describe this kind of vile, forced, or "
          + "self-destructive pattern happening -- never invent one that isn't there.",
      eventSchema: {
        summary: "string",
        tags: ["string"],
        outcome: Object.keys(GROWTH_EVENT_OUTCOME_WEIGHTS).join(" | "),
        dangerGap: `optional, omit unless clearly earned -- ${Object.keys(DANGER_GAP_MULTIPLIERS).join(" | ")}`
      },
      counterLevelingGuidance:
        "Most events omit dangerGap entirely. Set it only when the notes describe the character surviving (or "
          + "meaningfully contributing to surviving) a fight or challenge badly stacked against them -- outmatched, "
          + "outnumbered, facing a foe far above their own level or power. Use \"severe\" for a genuinely lopsided "
          + "mismatch the character had no business surviving; \"moderate\" for a tough, close-run fight against a "
          + "clearly stronger opponent. This multiplies how much Grand Design progress the event contributes (canon's "
          + "\"counter-leveling\"), not whether it counts as evidence for a Skill proposal -- never set it just because "
          + "the outcome was criticalSuccess or criticalFailure; it's specifically about the power gap, not the roll.",
      proposalSchema: {
        kind: "skill | class",
        entry: {
          note: "The entry object's exact fields depend on kind. Do not nest it under a skillEntry or classEntry key — the field must be named entry.",
          ifKindIsSkill: {
            name: "string",
            tier: "1 | 2 | 3 for skills",
            system_equivalent: `specific ${adapter.label} comparison`,
            gameItem: { kind: "feat | action | reaction | free | passive | spell | weapon" },
            mechanics: {
              effect: "concrete game benefit",
              duration: "string",
              frequency: { max: "integer >= 1", per: "round | minute | hour | day | encounter | unlimited" },
              roll: { kind: "required for action-like entries", formula: "dice formula such as 1d20+8" }
            },
            metadata: { tags: ["string"], polarity: "standard | red (optional -- see requirements.polarityGuidance, omit unless red)", malignance: "REQUIRED only when polarity is red -- { vice, drawback }", lineage: { operation: "origin | upgrade (upgrade only when evolving an owned Skill on request)", sources: ["approved registry IDs (empty for origin)"], rationale: "string" } }
          },
          ifKindIsClass: {
            name: "string",
            level: "integer >= 1",
            power_tier: "standard | elevated | prestige",
            is_primary: "boolean",
            is_secondary: "boolean",
            system_chassis: `specific ${adapter.label} chassis comparison`,
            gameItem: { kind: "feat | action | reaction | free | passive | spell | weapon" },
            mechanics: {
              effect: "concrete game benefit",
              duration: "string",
              frequency: { max: "integer >= 1", per: "round | minute | hour | day | encounter | unlimited" },
              roll: { kind: "required for action-like entries", formula: "dice formula such as 1d20+8" }
            },
            metadata: { tags: ["string"], polarity: "standard | red (optional -- see requirements.polarityGuidance, omit unless red)", malignance: "REQUIRED only when polarity is red -- { vice, drawback }", lineage: { operation: "origin | combine | upgrade", sources: ["approved registry IDs"], rationale: "string" } }
          }
        }
      },
      classProposalRule: "Only propose a Class entry when actor.grandDesign.classEvolutionAvailable is true; otherwise return a Skill proposal or no proposal.",
      // Exact required fields per gameItem.kind, mirrored 1:1 from the actual validator (mechanics.js).
      // "always required" fields (name, mechanics.effect, mechanics.frequency, gameItem.kind, and the
      // skill/class-specific fields) apply on top of this list regardless of kind. gameItem.school is
      // required for every spell on every system (see mechanics.js) even though only some systems'
      // adapters use it -- this keeps the validator itself system-agnostic.
      requiredFieldsByKind: {
        feat: ["mechanics.duration (string)"],
        passive: ["mechanics.duration (string)"],
        action: ["mechanics.roll.kind (string)", "mechanics.roll.formula (dice formula, e.g. 1d20+7)", "mechanics.actions (integer 1-3)"],
        reaction: ["mechanics.roll.kind (string)", "mechanics.roll.formula (dice formula)", "mechanics.trigger (string)"],
        free: ["mechanics.roll.kind (string)", "mechanics.roll.formula (dice formula)"],
        spell: [
          "mechanics.roll.kind (string)",
          "mechanics.roll.formula (dice formula)",
          "gameItem.rank (integer 0-9)",
          "gameItem.tradition (string, e.g. arcane/primal/divine/occult)",
          `gameItem.school (one of: ${[...SPELL_SCHOOLS].join(", ")})`
        ],
        weapon: ["mechanics.roll.kind (string)", "mechanics.roll.formula (dice formula)", "gameItem.damage (dice formula, e.g. 1d6+2)", "gameItem.damageType (string, e.g. piercing)"]
      },
      exampleByKind: buildExampleByKind(adapter)
    },
    // v2 addition: weighted evidence already on the actor, so the pipeline's "when-earned" proposal
    // mode can tell whether this batch pushes any tag or emergent theme over the threshold without
    // shipping the whole event history to the model.
    growthHistory: summarizeGrowthHistory(actor.getFlag(MODULE_ID, GROWTH_EVENTS_FLAG))
  };
}

function summarizeGrowthHistory(events) {
  const tagEvidence = {};
  const themeEvidence = {};
  const list = Array.isArray(events) ? events : [];
  for (const event of list) {
    const weight = GROWTH_EVENT_OUTCOME_WEIGHTS[event?.outcome] ?? 0;
    for (const tag of Array.isArray(event?.tags) ? event.tags : []) tagEvidence[tag] = (tagEvidence[tag] ?? 0) + weight;
    for (const theme of Array.isArray(event?.themes) ? event.themes : []) themeEvidence[theme] = (themeEvidence[theme] ?? 0) + weight;
  }
  return { eventCount: list.length, tagEvidence, themeEvidence };
}

function buildExampleByKind(adapter) {
  const base = (overrides) => ({
    kind: "skill",
    entry: {
      name: overrides.name,
      tier: overrides.tier,
      system_equivalent: overrides.system_equivalent,
      gameItem: overrides.gameItem,
      mechanics: overrides.mechanics,
      metadata: { tags: overrides.tags, lineage: { operation: "origin", sources: [], rationale: overrides.rationale } }
    },
    evidence: ["Session note analysis"]
  });
  const equivalentSuffix = ` (${adapter.label})`;
  // Batch 3 (board 5a0cea2e): every example shows mechanics.structured in THIS system's words -- the
  // model copies example shapes far more faithfully than it follows a field description.
  const is5e = adapter.id === "dnd5e";
  const structured = {
    feat: { uses: { max: 1, per: is5e ? "short-rest" : "encounter" } },
    passive: is5e
      ? { advantage: { on: "skill:survival", condition: "to avoid getting lost while exploring" } }
      : { modifiers: [{ value: 1, type: "circumstance", selector: "skill:survival", predicate: "adjacent ally, Avoid Getting Lost" }] },
    action: { heal: { dice: "1d8" }, uses: { max: 1, per: is5e ? "short-rest" : "hour" } },
    reaction: { uses: { max: 1, per: is5e ? "turn" : "round" } },
    free: is5e
      ? { range: { value: 30, units: "ft" }, advantage: { on: "save:wis", condition: "the ally's next saving throw" }, uses: { max: 1, per: "turn" } }
      : { range: { value: 30, units: "ft" }, modifiers: [{ value: 1, type: "circumstance", selector: "save:will", predicate: "next saving throw" }], uses: { max: 1, per: "round" } },
    spell: is5e
      ? { area: { type: "cone", value: 15 }, damage: [{ dice: "2d6", type: "fire" }], save: { save: "dex", dc: "spell" }, uses: { max: 2, per: "long-rest" } }
      : { area: { type: "cone", value: 15 }, damage: [{ dice: "2d6", type: "fire" }], save: { save: "reflex", dc: "spell", basic: true }, uses: { max: 2, per: "day" } },
    weapon: { attack: { kind: "melee" }, damage: [{ dice: "1d6", type: "piercing", bonus: 2 }] },
    class: { uses: { max: 1, per: "day" } }
  };
  return {
    feat: base({
      name: "Salvage Engineering", tier: 1, system_equivalent: `Engineer's Tools skill feat${equivalentSuffix}`,
      gameItem: { kind: "feat" },
      mechanics: { effect: "Once per encounter, attempt a Craft check to build a simple device from scavenged parts.", structured: structured.feat, duration: "8 hours", frequency: { max: 1, per: "encounter" } },
      tags: ["craft", "support"], rationale: "Demonstrated repeated improvised crafting under pressure."
    }),
    passive: base({
      name: "Trail Sense", tier: 1, system_equivalent: `Survival exploration feat${equivalentSuffix}`,
      gameItem: { kind: "passive" },
      mechanics: { effect: "While exploring, an adjacent ally gains a +1 circumstance bonus to Survival checks to Avoid Getting Lost.", structured: structured.passive, duration: "while exploring", frequency: { max: 1, per: "unlimited" } },
      tags: ["survival", "nature"], rationale: "Demonstrated instinctive terrain reading over repeated scenes."
    }),
    action: base({
      name: "Field Triage", tier: 1, system_equivalent: `Medicine support action${equivalentSuffix}`,
      gameItem: { kind: "action" },
      mechanics: { effect: "Attempt to Treat Wounds on one adjacent living creature. On a success, it regains 1d8 Hit Points.", structured: structured.action, duration: "10 minutes", frequency: { max: 1, per: "hour" }, actions: 2, roll: { kind: "Medicine check", formula: "1d20+7" } },
      tags: ["medicine", "support"], rationale: "Earned by treating a wounded ally under pressure."
    }),
    reaction: base({
      name: "Warden's Brace", tier: 2, system_equivalent: `Martial defense reaction${equivalentSuffix}`,
      gameItem: { kind: "reaction" },
      mechanics: { effect: "Gain resistance 2 to the triggering physical damage.", structured: structured.reaction, duration: "instant", frequency: { max: 1, per: "round" }, trigger: "You or an adjacent ally takes physical damage from a Strike.", roll: { kind: "Athletics check", formula: "1d20+8" } },
      tags: ["defense", "martial"], rationale: "Repeatedly intercepted attacks meant for allies."
    }),
    free: base({
      name: "Rallying Call", tier: 2, system_equivalent: `Leadership free action${equivalentSuffix}`,
      gameItem: { kind: "free" },
      mechanics: { effect: "One ally within 30 feet gains a +1 circumstance bonus to its next saving throw before the start of your next turn.", structured: structured.free, duration: "until the start of your next turn", frequency: { max: 1, per: "round" }, roll: { kind: "Diplomacy check", formula: "1d20+8" } },
      tags: ["leadership", "support"], rationale: "Repeatedly steadied a group under pressure with clear instructions."
    }),
    spell: base({
      name: "Ember Pulse", tier: 2, system_equivalent: `Rank 1 elemental spell${equivalentSuffix}`,
      gameItem: { kind: "spell", rank: 1, tradition: "primal", school: "evo" },
      mechanics: { effect: is5e ? "Each creature in a 15-foot cone makes a Dexterity saving throw against your spell save DC, taking 2d6 fire damage on a failure or half as much on a success." : "Each creature in a 15-foot cone takes 2d6 fire damage (basic Reflex save against your spell DC).", structured: structured.spell, duration: "instant", frequency: { max: 2, per: "day" }, actions: 2, roll: { kind: is5e ? "Dexterity save" : "Reflex save", formula: "1d20+7" } },
      tags: ["fire", "spellcasting"], rationale: "Repeatedly called on a latent elemental affinity under pressure."
    }),
    weapon: base({
      name: "Silt Hook", tier: 1, system_equivalent: `Simple melee weapon${equivalentSuffix}`,
      gameItem: { kind: "weapon", damage: "1d6+2", damageType: "piercing", category: "simple", group: "knife", traits: ["agile"] },
      mechanics: { effect: "Make a melee Strike with a hooked canal tool.", structured: structured.weapon, duration: "instant", frequency: { max: 1, per: "round" }, actions: 1, roll: { kind: "Melee attack", formula: "1d20+6" } },
      tags: ["martial", "craft"], rationale: "Adapted a salvaged tool into a reliable close-range weapon."
    }),
    class: {
      kind: "class",
      entry: {
        name: "Canal Hearthkeeper", level: 6, power_tier: "standard", is_primary: true, is_secondary: false,
        system_chassis: `Alchemist${equivalentSuffix}`,
        gameItem: { kind: "passive" },
        mechanics: { effect: "During daily preparations, create one temporary meal. The first ally who eats it gains 2 temporary Hit Points for 8 hours.", structured: structured.class, duration: "8 hours", frequency: { max: 1, per: "day" } },
        metadata: { tags: ["craft", "support", "water"], themes: ["cooking"], lineage: { operation: "origin", sources: [], rationale: "Only ever proposed when actor.grandDesign.classEvolutionAvailable is true." } }
      },
      evidence: ["Session note analysis"]
    }
  };
}
