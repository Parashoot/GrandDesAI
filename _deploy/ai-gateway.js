import { GROWTH_TAXONOMY } from "./growth-taxonomy.js";
import { CLASS_EVOLUTION_LEVELS, DANGER_GAP_MULTIPLIERS, GROWTH_EVENT_OUTCOME_WEIGHTS, LEVEL_PROGRESSION_FLAG, MODULE_ID, SPELL_SCHOOLS } from "./constants.js";
import { getSystemAdapter } from "./systems/index.js";
import { VICE_TAGS } from "./vice-taxonomy.js";

export function createAiGatewayAdapter({ endpoint, getHeaders = () => ({}) }) {
  assertSafeEndpoint(endpoint);
  if (typeof getHeaders !== "function") {
    throw new Error("getHeaders must be a function.");
  }
  return async ({ actor, notes }) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getHeaders() },
      body: JSON.stringify(buildAiGatewayRequest(actor, notes, typeof game !== "undefined" ? game.system.id : "pf2e"))
    });
    if (!response.ok) throw new Error(`AI gateway returned HTTP ${response.status}.`);
    return response.json();
  };
}

export function createChatCompletionsAdapter({ endpoint, model, getHeaders = () => ({}), requestOptions = {} }) {
  assertSafeEndpoint(endpoint);
  if (typeof model !== "string" || !model.trim()) throw new Error("An AI model name is required.");
  if (typeof getHeaders !== "function") throw new Error("getHeaders must be a function.");
  return async ({ actor, notes }) => {
    const request = buildAiGatewayRequest(actor, notes, typeof game !== "undefined" ? game.system.id : "pf2e");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getHeaders() },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: "Return only valid JSON matching the requested events and proposals schema. "
              + "Log failed attempts as events too, not just successes -- outcome may be criticalSuccess, success, criticalFailure, or failure; "
              + "see requirements.eventOutcomePhilosophy for exactly how to weigh and use failed attempts as evidence. "
              + "Name every generated proposal so it reads as belonging to the character's own class, not a generic label -- "
              + "see requirements.namingConvention for the exact naming pattern and worked examples. "
              + "A small minority of proposals may be metadata.polarity: \"red\" (taboo/vile origins) instead of the "
              + "default \"standard\" -- see requirements.polarityGuidance for exactly when that applies and what it requires. "
              + "Every tags array (on an event and on a proposal entry's metadata.tags) may ONLY contain values that appear verbatim in the allowedTags array in this request -- "
              + "never invent, pluralize, or reword a tag (for example, allowedTags has \"martial\" and \"defense\", not \"melee\" or \"defensive\"). "
              + "If nothing in allowedTags genuinely fits, use fewer tags or an empty array rather than inventing one; a proposal is rejected outright if any tag isn't in allowedTags. "
              + "Return {\"events\":[],\"proposals\":[]} when the evidence is insufficient. Do not grant, approve, or claim to create any item. "
              + "Every field is REQUIRED unless requirements.proposalSchema marks it optional -- never omit a required field, even if you think it is implied. "
              + "Always include, on every proposal's entry: name, mechanics.effect, mechanics.frequency {max, per}, gameItem.kind, and metadata.tags (only tags from allowedTags). "
              + "A skill entry also always needs tier (1, 2, or 3) and system_equivalent. A class entry also always needs level, power_tier, is_primary, is_secondary, and system_chassis. "
              + "Beyond that, requirements.requiredFieldsByKind lists the exact extra fields required for whichever gameItem.kind you choose -- check it every time, per kind, before answering. "
              + "requirements.exampleByKind has one complete, valid, fully-fielded example proposal for every kind (feat, action, reaction, free, passive, spell, weapon, and one class example) -- "
              + "find the entry matching your chosen kind and match its exact field set, changing only the content to fit these notes."
          },
          { role: "user", content: JSON.stringify(request) }
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
        ...requestOptions
      })
    });
    if (!response.ok) throw new Error(`AI provider returned HTTP ${response.status}.`);
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content ?? payload?.message?.content;
    if (typeof content !== "string") throw new Error("AI provider did not return a JSON chat-completion message.");
    try {
      return JSON.parse(content);
    } catch {
      throw new Error("AI provider returned malformed JSON.");
    }
  };
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
      existingGrandDesign: actor.getFlag(MODULE_ID, "registry") ?? {},
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
            metadata: { tags: ["string"], polarity: "standard | red (optional -- see requirements.polarityGuidance, omit unless red)", malignance: "REQUIRED only when polarity is red -- { vice, drawback }", lineage: { operation: "origin", sources: [], rationale: "string" } }
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
    }
  };
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
  return {
    feat: base({
      name: "Salvage Engineering", tier: 1, system_equivalent: `Engineer's Tools skill feat${equivalentSuffix}`,
      gameItem: { kind: "feat" },
      mechanics: { effect: "Once per encounter, attempt a Craft check to build a simple device from scavenged parts.", duration: "8 hours", frequency: { max: 1, per: "encounter" } },
      tags: ["craft", "support"], rationale: "Demonstrated repeated improvised crafting under pressure."
    }),
    passive: base({
      name: "Trail Sense", tier: 1, system_equivalent: `Survival exploration feat${equivalentSuffix}`,
      gameItem: { kind: "passive" },
      mechanics: { effect: "While exploring, an adjacent ally gains a +1 circumstance bonus to Survival checks to Avoid Getting Lost.", duration: "while exploring", frequency: { max: 1, per: "unlimited" } },
      tags: ["survival", "nature"], rationale: "Demonstrated instinctive terrain reading over repeated scenes."
    }),
    action: base({
      name: "Field Triage", tier: 1, system_equivalent: `Medicine support action${equivalentSuffix}`,
      gameItem: { kind: "action" },
      mechanics: { effect: "Attempt to Treat Wounds on one adjacent living creature. On a success, it regains 1d8 Hit Points.", duration: "10 minutes", frequency: { max: 1, per: "hour" }, actions: 2, roll: { kind: "Medicine check", formula: "1d20+7" } },
      tags: ["medicine", "support"], rationale: "Earned by treating a wounded ally under pressure."
    }),
    reaction: base({
      name: "Warden's Brace", tier: 2, system_equivalent: `Martial defense reaction${equivalentSuffix}`,
      gameItem: { kind: "reaction" },
      mechanics: { effect: "Gain resistance 2 to the triggering physical damage.", duration: "instant", frequency: { max: 1, per: "round" }, trigger: "You or an adjacent ally takes physical damage from a Strike.", roll: { kind: "Athletics check", formula: "1d20+8" } },
      tags: ["defense", "martial"], rationale: "Repeatedly intercepted attacks meant for allies."
    }),
    free: base({
      name: "Rallying Call", tier: 2, system_equivalent: `Leadership free action${equivalentSuffix}`,
      gameItem: { kind: "free" },
      mechanics: { effect: "One ally within 30 feet gains a +1 circumstance bonus to its next saving throw before the start of your next turn.", duration: "until the start of your next turn", frequency: { max: 1, per: "round" }, roll: { kind: "Diplomacy check", formula: "1d20+8" } },
      tags: ["leadership", "support"], rationale: "Repeatedly steadied a group under pressure with clear instructions."
    }),
    spell: base({
      name: "Ember Pulse", tier: 2, system_equivalent: `Rank 1 elemental spell${equivalentSuffix}`,
      gameItem: { kind: "spell", rank: 1, tradition: "primal", school: "evo" },
      mechanics: { effect: "Make a spell attack against one creature within 30 feet. On a success, deal 2d6 fire damage.", duration: "instant", frequency: { max: 2, per: "encounter" }, actions: 2, roll: { kind: "Spell attack", formula: "1d20+7" } },
      tags: ["fire", "spellcasting"], rationale: "Repeatedly called on a latent elemental affinity under pressure."
    }),
    weapon: base({
      name: "Silt Hook", tier: 1, system_equivalent: `Simple melee weapon${equivalentSuffix}`,
      gameItem: { kind: "weapon", damage: "1d6+2", damageType: "piercing", category: "simple", group: "knife", traits: ["agile"] },
      mechanics: { effect: "Make a melee Strike with a hooked canal tool.", duration: "instant", frequency: { max: 1, per: "round" }, actions: 1, roll: { kind: "Melee attack", formula: "1d20+6" } },
      tags: ["weapon", "tool", "melee"], rationale: "Adapted a salvaged tool into a reliable close-range weapon."
    }),
    class: {
      kind: "class",
      entry: {
        name: "Canal Hearthkeeper", level: 6, power_tier: "standard", is_primary: true, is_secondary: false,
        system_chassis: `Alchemist${equivalentSuffix}`,
        gameItem: { kind: "passive" },
        mechanics: { effect: "During daily preparations, create one temporary meal. The first ally who eats it gains 2 temporary Hit Points for 8 hours.", duration: "8 hours", frequency: { max: 1, per: "day" } },
        metadata: { tags: ["craft", "food", "flood-support"], lineage: { operation: "origin", sources: [], rationale: "Only ever proposed when actor.grandDesign.classEvolutionAvailable is true." } }
      },
      evidence: ["Session note analysis"]
    }
  };
}

function assertSafeEndpoint(endpoint) {
  if (typeof endpoint !== "string") throw new Error("The AI gateway endpoint must be a URL.");
  const url = new URL(endpoint);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("AI endpoints must use HTTPS, except a local localhost or loopback server.");
  }
}
