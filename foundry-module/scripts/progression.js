import {
  CLASS_EVOLUTION_LEVELS,
  DANGER_GAP_MULTIPLIERS,
  GRAND_DESIGN_MAX_LEVEL,
  GROWTH_EVENT_OUTCOME_WEIGHTS,
  GROWTH_EVENTS_FLAG,
  GROWTH_PROPOSALS_FLAG,
  LEVEL_PROGRESSION_FLAG,
  MODULE_ID
} from "./constants.js";
import { weightForTag } from "./tag-weighting.js";
import { checkForTag, pf2eLevelBasedDc, proficiencyForLevel5e, resolveRollCheck } from "./mechanics.js";
import { flavorProposalName } from "./naming.js";
import { normalizeAtonement, normalizeDarkDeed } from "./horror-rank.js";

// The weighted-evidence total a required tag needs before a proposal template fires. Calibrated
// against "success" outcomes (weight 1 each) so the long-standing rule of thumb -- three tagged
// successes earns a proposal -- is unchanged; the same threshold can now also be reached by more
// numerous failures/criticalFailures, or a mix, since they carry a smaller weight each rather than
// being excluded outright.
const MINIMUM_EVIDENCE = 3;
// Progress points a single "success" outcome contributes toward a Grand Design level; every other
// outcome scales off this via GROWTH_EVENT_OUTCOME_WEIGHTS (e.g. criticalSuccess = 1.6x this).
const BASE_SUCCESS_PROGRESS = 25;

const PROPOSAL_TEMPLATES = [
  {
    id: "canal-step",
    requiredTags: ["mobility", "water"],
    entry: {
      name: "Canal Step",
      tier: 1,
      system_equivalent: "Athletics or Acrobatics movement action",
      gameItem: { kind: "action" },
      mechanics: {
        effect: "Stride up to half your Speed. On a success, ignore difficult terrain from shallow water during that movement.",
        duration: "instant",
        frequency: { max: 1, per: "round" },
        actions: 1,
        roll: { kind: "Athletics check", formula: "", dc: 15 }
      },
      metadata: {
        tags: ["mobility", "water"],
        lineage: { operation: "origin", sources: [], rationale: "" }
      }
    }
  },
  {
    id: "field-ration",
    requiredTags: ["craft", "support"],
    entry: {
      name: "Field Ration",
      tier: 1,
      system_equivalent: "Crafting support feat",
      gameItem: { kind: "passive" },
      mechanics: {
        effect: "During daily preparations, create one temporary ration. The first ally who consumes it that day gains 1 temporary Hit Point for 8 hours.",
        duration: "8 hours",
        frequency: { max: 1, per: "day" }
      },
      metadata: {
        tags: ["craft", "support"],
        lineage: { operation: "origin", sources: [], rationale: "" }
      }
    }
  },
  {
    id: "measured-strike",
    requiredTags: ["martial", "precision"],
    entry: {
      name: "Measured Strike",
      tier: 2,
      system_equivalent: "Class-feat-scale martial action",
      gameItem: { kind: "action" },
      mechanics: {
        effect: "Make a melee Strike. On a success, deal 1d6 additional precision damage.",
        duration: "instant",
        frequency: { max: 1, per: "round" },
        actions: 1,
        roll: { kind: "Melee attack", formula: "", dc: 18 }
      },
      metadata: {
        tags: ["martial", "precision"],
        lineage: { operation: "origin", sources: [], rationale: "" }
      }
    }
  },
  {
    id: "ember-pulse",
    requiredTags: ["fire", "spellcasting"],
    entry: {
      name: "Ember Pulse",
      tier: 2,
      system_equivalent: "Rank 1 elemental spell",
      gameItem: { kind: "spell", rank: 1, tradition: "arcane", school: "evo" },
      mechanics: {
        effect: "Make a spell attack against one creature within 30 feet. On a success, deal 2d6 fire damage.",
        duration: "instant",
        frequency: { max: 2, per: "encounter" },
        actions: 2,
        roll: { kind: "Spell attack", formula: "", dc: 17 }
      },
      metadata: {
        tags: ["fire", "spellcasting"],
        lineage: { operation: "origin", sources: [], rationale: "" }
      }
    }
  },
  {
    id: "field-triage",
    requiredTags: ["medicine", "support"],
    entry: {
      name: "Field Triage",
      tier: 1,
      system_equivalent: "Medicine support action",
      gameItem: { kind: "action" },
      mechanics: {
        effect: "Attempt to Treat Wounds on one adjacent living creature. On a success, it regains 1d8 Hit Points.",
        duration: "10 minutes",
        frequency: { max: 1, per: "hour" },
        actions: 2,
        roll: { kind: "Medicine check", formula: "", dc: 15 }
      },
      metadata: {
        tags: ["medicine", "support"],
        lineage: { operation: "origin", sources: [], rationale: "" }
      }
    }
  },
  {
    id: "shadow-thread",
    requiredTags: ["stealth", "precision"],
    entry: {
      name: "Shadow Thread",
      tier: 2,
      system_equivalent: "Stealth reaction",
      gameItem: { kind: "reaction" },
      mechanics: {
        effect: "Step 5 feet into cover or concealment. On a success, the triggering ranged Strike takes a -1 circumstance penalty.",
        duration: "instant",
        frequency: { max: 1, per: "round" },
        trigger: "A creature targets you with a ranged Strike while you are concealed or in cover.",
        roll: { kind: "Stealth check", formula: "", dc: 18 }
      },
      metadata: {
        tags: ["stealth", "precision"],
        lineage: { operation: "origin", sources: [], rationale: "" }
      }
    }
  },
  {
    id: "rallying-call",
    requiredTags: ["leadership", "support"],
    entry: {
      name: "Rallying Call",
      tier: 2,
      system_equivalent: "Leadership free action",
      gameItem: { kind: "free" },
      mechanics: {
        effect: "One ally within 30 feet gains a +1 circumstance bonus to its next saving throw before the start of your next turn.",
        duration: "until the start of your next turn",
        frequency: { max: 1, per: "round" },
        roll: { kind: "Diplomacy check", formula: "", dc: 18 }
      },
      metadata: {
        tags: ["leadership", "support"],
        lineage: { operation: "origin", sources: [], rationale: "" }
      }
    }
  },
  {
    id: "warden-brace",
    requiredTags: ["defense", "martial"],
    entry: {
      name: "Warden's Brace",
      tier: 2,
      system_equivalent: "Martial defense reaction",
      gameItem: { kind: "reaction" },
      mechanics: {
        effect: "Gain resistance 2 to the triggering physical damage. On a success, an adjacent ally also gains the resistance.",
        duration: "instant",
        frequency: { max: 1, per: "round" },
        trigger: "You or an adjacent ally takes physical damage from a Strike.",
        roll: { kind: "Athletics check", formula: "", dc: 18 }
      },
      metadata: {
        tags: ["defense", "martial"],
        lineage: { operation: "origin", sources: [], rationale: "" }
      }
    }
  },
  {
    id: "trail-sense",
    requiredTags: ["survival", "nature"],
    entry: {
      name: "Trail Sense",
      tier: 1,
      system_equivalent: "Survival exploration feat",
      gameItem: { kind: "passive" },
      mechanics: {
        effect: "When you Follow the Expert in natural terrain, one ally gains a +1 circumstance bonus to Survival checks to Avoid Getting Lost.",
        duration: "while exploring natural terrain",
        frequency: { max: 1, per: "unlimited" }
      },
      metadata: {
        tags: ["survival", "nature"],
        lineage: { operation: "origin", sources: [], rationale: "" }
      }
    }
  },
  {
    id: "winter-veil",
    requiredTags: ["cold", "spellcasting"],
    entry: {
      name: "Winter Veil",
      tier: 2,
      system_equivalent: "Rank 1 cold spell",
      gameItem: { kind: "spell", rank: 1, tradition: "primal", school: "evo" },
      mechanics: {
        effect: "Make a spell attack against one creature within 30 feet. On a success, deal 2d6 cold damage and the target is concealed until the start of your next turn.",
        duration: "until the start of your next turn",
        frequency: { max: 2, per: "encounter" },
        actions: 2,
        roll: { kind: "Spell attack", formula: "", dc: 17 }
      },
      metadata: {
        tags: ["cold", "spellcasting"],
        lineage: { operation: "origin", sources: [], rationale: "" }
      }
    }
  },
  {
    id: "storm-arc",
    requiredTags: ["electricity", "spellcasting"],
    entry: {
      name: "Storm Arc",
      tier: 2,
      system_equivalent: "Rank 1 electricity spell",
      gameItem: { kind: "spell", rank: 1, tradition: "arcane", school: "evo" },
      mechanics: {
        effect: "Make a spell attack against one creature within 30 feet. On a success, deal 2d6 electricity damage.",
        duration: "instant",
        frequency: { max: 2, per: "encounter" },
        actions: 2,
        roll: { kind: "Spell attack", formula: "", dc: 17 }
      },
      metadata: {
        tags: ["electricity", "spellcasting"],
        lineage: { operation: "origin", sources: [], rationale: "" }
      }
    }
  }
];

// dnd5e wording for every tag-triggered template. Playtest ember-road s1 (a dnd5e world) showed a
// template proposal reading "Attempt to Treat Wounds..." -- a PF2e-only activity -- because the
// templates above were written in PF2e terms only. Each variant replaces the PF2e entry's
// system_equivalent/gameItem/mechanics wholesale rather than patching words, so no PF2e term
// (Strike, Stride, circumstance bonus, "resistance 2", Treat Wounds, daily preparations, concealed,
// Follow the Expert, rank-N spell) can leak through. Frequencies stay inside FREQUENCY_PERIODS:
// "encounter" is mapped by systems/dnd5e-adapter.js to a short-rest recovery and never appears in
// the text a GM reads.
const DND5E_TEMPLATE_VARIANTS = {
  "canal-step": {
    system_equivalent: "Athletics or Acrobatics movement (bonus action)",
    gameItem: { kind: "free" },
    mechanics: {
      effect: "As a bonus action, move up to half your speed. On a successful Strength (Athletics) check, shallow water doesn't count as difficult terrain for that movement.",
      duration: "instant",
      frequency: { max: 1, per: "round" },
      actions: 1,
      roll: { kind: "Strength (Athletics) check", formula: "", dc: 15 }
    }
  },
  "field-ration": {
    system_equivalent: "Cook's utensils tool feature",
    gameItem: { kind: "passive" },
    mechanics: {
      effect: "When you finish a long rest, you prepare one special ration. The first ally who eats it before your next long rest gains 1 temporary hit point that lasts 8 hours.",
      duration: "8 hours",
      frequency: { max: 1, per: "day" }
    }
  },
  "measured-strike": {
    system_equivalent: "Fighting-style-scale martial feature",
    gameItem: { kind: "action" },
    mechanics: {
      effect: "When you hit a creature with a melee weapon attack, you can deal an extra 1d6 damage of the weapon's type to it (once per turn).",
      duration: "instant",
      frequency: { max: 1, per: "round" },
      actions: 1,
      roll: { kind: "Melee weapon attack", formula: "", dc: 13 }
    }
  },
  "ember-pulse": {
    system_equivalent: "1st-level evocation spell",
    gameItem: { kind: "spell", rank: 1, tradition: "arcane", school: "evo" },
    mechanics: {
      effect: "Make a ranged spell attack against one creature within 30 feet. On a hit, it takes 2d6 fire damage.",
      duration: "instant",
      frequency: { max: 2, per: "encounter" },
      actions: 1,
      roll: { kind: "Ranged spell attack", formula: "", dc: 13 }
    }
  },
  "field-triage": {
    system_equivalent: "Healer's-kit style Medicine action",
    gameItem: { kind: "action" },
    mechanics: {
      effect: "As an action, tend one creature within 5 feet of you that has at least 1 hit point. Make a Wisdom (Medicine) check; on a success, it regains 1d8 hit points.",
      duration: "instant",
      frequency: { max: 1, per: "hour" },
      actions: 1,
      roll: { kind: "Wisdom (Medicine) check", formula: "", dc: 12 }
    }
  },
  "shadow-thread": {
    system_equivalent: "Stealth reaction",
    gameItem: { kind: "reaction" },
    mechanics: {
      effect: "Move up to 5 feet into cover or a lightly obscured space. On a successful Dexterity (Stealth) check, the triggering ranged attack has disadvantage.",
      duration: "instant",
      frequency: { max: 1, per: "round" },
      trigger: "A creature you can see makes a ranged attack roll against you while you are in cover or lightly obscured.",
      roll: { kind: "Dexterity (Stealth) check", formula: "", dc: 14 }
    }
  },
  "rallying-call": {
    system_equivalent: "Leadership bonus action",
    gameItem: { kind: "free" },
    mechanics: {
      effect: "As a bonus action, choose one ally within 30 feet who can hear you. It gains a +1 bonus to its next saving throw made before the start of your next turn.",
      duration: "until the start of your next turn",
      frequency: { max: 1, per: "round" },
      actions: 1,
      roll: { kind: "Charisma (Persuasion) check", formula: "", dc: 14 }
    }
  },
  "warden-brace": {
    system_equivalent: "Martial defense reaction",
    gameItem: { kind: "reaction" },
    mechanics: {
      effect: "Reduce the triggering bludgeoning, piercing, or slashing damage by 1d6 + your proficiency bonus. On a successful Strength (Athletics) check, the reduction also applies to an ally within 5 feet hit by the same attack.",
      duration: "instant",
      frequency: { max: 1, per: "round" },
      trigger: "You or an ally within 5 feet of you is hit by a weapon attack.",
      roll: { kind: "Strength (Athletics) check", formula: "", dc: 14 }
    }
  },
  "trail-sense": {
    system_equivalent: "Survival exploration feature",
    gameItem: { kind: "passive" },
    mechanics: {
      effect: "While you guide the group through natural terrain, you and one ally have advantage on Wisdom (Survival) checks to avoid becoming lost.",
      duration: "while traveling through natural terrain",
      frequency: { max: 1, per: "unlimited" }
    }
  },
  "winter-veil": {
    system_equivalent: "1st-level evocation spell",
    gameItem: { kind: "spell", rank: 1, tradition: "primal", school: "evo" },
    mechanics: {
      effect: "Make a ranged spell attack against one creature within 30 feet. On a hit, it takes 2d6 cold damage and has disadvantage on attack rolls against you until the start of your next turn.",
      duration: "until the start of your next turn",
      frequency: { max: 2, per: "encounter" },
      actions: 1,
      roll: { kind: "Ranged spell attack", formula: "", dc: 13 }
    }
  },
  "storm-arc": {
    system_equivalent: "1st-level evocation spell",
    gameItem: { kind: "spell", rank: 1, tradition: "arcane", school: "evo" },
    mechanics: {
      effect: "Make a ranged spell attack against one creature within 30 feet. On a hit, it takes 2d6 lightning damage.",
      duration: "instant",
      frequency: { max: 2, per: "encounter" },
      actions: 1,
      roll: { kind: "Ranged spell attack", formula: "", dc: 13 }
    }
  }
};

/** The template's entry in the active system's terms (PF2e entries are the originals). */
function templateEntryForSystem(template, systemId) {
  const entry = structuredClone(template.entry);
  const variant = systemId === "dnd5e" ? DND5E_TEMPLATE_VARIANTS[template.id] : null;
  if (!variant) return entry;
  return { ...entry, ...structuredClone(variant), metadata: entry.metadata };
}

// Canon guarantees a rare Skill at every 10th Grand Design level, distinct from the tag-triggered
// PROPOSAL_TEMPLATES above (which need specific evidence to unlock) and distinct from the 20/30/50
// class-evolution checkpoints (CLASS_EVOLUTION_LEVELS, which are about a Class evolving, not a new
// Skill appearing). A capstone fires purely on hitting the level -- no tag threshold required --
// because canon's capstones are guaranteed, not earned through a specific activity pattern.
const CAPSTONE_LEVEL_INTERVAL = 10;

export function isCapstoneLevel(level) {
  return Number.isInteger(level) && level > 0 && level % CAPSTONE_LEVEL_INTERVAL === 0;
}

/**
 * Builds the one guaranteed capstone Skill proposal for a level milestone. Canon flavors these by
 * "what the individual needs and desires" rather than handing out something generic -- the local
 * fallback here approximates that by reading whichever tag has the most weighted evidence across
 * the character's own growth-event history (not just tags matching a specific template's required
 * pair) and naming/framing the capstone around it; a character with no recorded events yet still
 * gets a usable, GM-editable capstone rather than nothing. Marked `isCapstone: true` so
 * canApproveGeneratedProposal/spendCapstoneAllowance route it through its own allowance track
 * instead of the ordinary per-rest grant allowance an evidence-triggered proposal uses.
 */
export function generateCapstoneProposal(level, events, existingRegistry, modifier = 0, { systemId = "pf2e", actorLevel, rollContext } = {}) {
  const weighableEvents = events.filter((event) => Object.prototype.hasOwnProperty.call(GROWTH_EVENT_OUTCOME_WEIGHTS, event.outcome));
  const topTag = topWeightedTag(weighableEvents);
  const ctx = normalizeRollContext(modifier, systemId, { actorLevel, rollContext });
  const entry = buildCapstoneEntry(level, topTag, systemId, ctx);
  const registryId = `skill:${slugify(entry.name)}`;
  // Disambiguate if a same-named capstone (e.g. the same top tag recurring at a later level) was
  // already approved, so this proposal doesn't collide with an existing registry entry.
  if (existingRegistry?.skills?.[registryId]) {
    entry.name = `${entry.name} (Level ${level})`;
  }
  return {
    id: `proposal:capstone-${level}`,
    kind: "skill",
    status: "pending",
    source: "capstone",
    systemId,
    isCapstone: true,
    milestoneLevel: level,
    evidence: topTag ? weighableEvents.filter((event) => event.tags.includes(topTag)).map((event) => event.id) : [],
    entry
  };
}

/**
 * Builds the deterministic, GM-editable Class-evolution proposal for a CLASS_EVOLUTION_LEVELS
 * milestone (20/30/50) when the AI gateway is unavailable or returns nothing usable
 * (api.js#resolveLevelRest's _resolveMilestoneReward). Same reasoning and shape as
 * generateCapstoneProposal above -- read whichever tag has the most weighted evidence and frame the
 * evolution around it -- but `source: "class-evolution"` (not `isCapstone`) so approving it spends
 * the ordinary per-rest grant allowance, exactly like any other generated Class.
 */
export function generateClassEvolutionProposal(level, events, existingRegistry, modifier = 0, { systemId = "pf2e", actorLevel = 1, systemClass = null, rollContext } = {}) {
  const weighableEvents = events.filter((event) => Object.prototype.hasOwnProperty.call(GROWTH_EVENT_OUTCOME_WEIGHTS, event.outcome));
  const topTag = topWeightedTag(weighableEvents);
  const ctx = normalizeRollContext(modifier, systemId, { actorLevel, rollContext });
  const entry = buildClassEvolutionEntry(level, topTag, systemId, actorLevel, systemClass, ctx);
  const registryId = `class:${slugify(entry.name)}`;
  // Same disambiguation as the capstone above: never collide with an already-approved Class of the
  // same generated name.
  if (existingRegistry?.classes?.[registryId]) {
    entry.name = `${entry.name} (Level ${level})`;
  }
  return {
    id: `proposal:class-evolution-${level}`,
    kind: "class",
    status: "pending",
    source: "class-evolution",
    systemId,
    milestoneLevel: level,
    evidence: topTag ? weighableEvents.filter((event) => event.tags.includes(topTag)).map((event) => event.id) : [],
    entry
  };
}

/**
 * What the generated entries need to know about the character, kept as plain values/functions so
 * this file stays Foundry-free (api.js#rollContextFor builds it from the actor):
 *  - modifierFor(check, kind): the character's own modifier for a resolved check,
 *  - dcFor(check): a DC scaled to the CHARACTER level (mechanics.js#characterDc),
 *  - namingClass(tags): the Class a generated name is flavored from (naming.js#namingClassFor).
 * `modifier` is the legacy argument: a number (every roll) or a function(check, kind).
 */
function normalizeRollContext(modifier, systemId, { actorLevel, rollContext } = {}) {
  const ctx = rollContext ?? {};
  const level = Number.isInteger(ctx.actorLevel) ? ctx.actorLevel : Number.isInteger(actorLevel) ? actorLevel : 1;
  const legacy = (check, kind) => {
    const value = typeof modifier === "function" ? modifier(check, kind) : modifier;
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  };
  return {
    hasActor: typeof ctx.dcFor === "function",
    modifierFor: (check, kind) => {
      const value = typeof ctx.modifierFor === "function" ? ctx.modifierFor(check, kind) : null;
      return Number.isFinite(value) ? value : legacy(check, kind);
    },
    dcFor: (check) => {
      const value = typeof ctx.dcFor === "function" ? ctx.dcFor(check) : null;
      if (Number.isFinite(value)) return value;
      return systemId === "dnd5e" ? 8 + proficiencyForLevel5e(level) : pf2eLevelBasedDc(level);
    },
    namingClass: (tags) => (typeof ctx.namingClass === "function" ? ctx.namingClass(tags) : null)
  };
}

function formulaFor(modifier) {
  const value = Math.round(Number(modifier) || 0);
  return `1d20${value >= 0 ? "+" : ""}${value}`;
}

function topWeightedTag(events) {
  const tagWeights = new Map();
  for (const event of events) {
    const weight = GROWTH_EVENT_OUTCOME_WEIGHTS[event.outcome];
    for (const tag of event.tags) {
      tagWeights.set(tag, (tagWeights.get(tag) ?? 0) + weight);
    }
  }
  let topTag = null;
  let topWeight = -Infinity;
  for (const [tag, weight] of tagWeights) {
    if (weight > topWeight) {
      topTag = tag;
      topWeight = weight;
    }
  }
  return topTag;
}

// Board 0ed137cb: the fallback capstone used to say "the specific signature effect is left to the
// GM" -- nothing usable at the table. Each tag now falls in a family with a concrete default benefit
// (success / critical success), written once per system so no PF2e term reaches a dnd5e sheet.
const CAPSTONE_FAMILY_BY_TAG = {
  martial: "offense", athletics: "offense", precision: "offense", ranged: "offense",
  fire: "elemental", cold: "elemental", electricity: "elemental", earth: "elemental", air: "elemental",
  defense: "defense",
  mobility: "mobility", acrobatics: "mobility", water: "mobility",
  stealth: "stealth", thievery: "stealth", deception: "stealth",
  diplomacy: "inspire", leadership: "inspire", performance: "inspire", support: "inspire",
  intimidation: "fear",
  medicine: "heal",
  arcana: "lore", occultism: "lore", religion: "lore", society: "lore", lore: "lore", nature: "lore",
  spellcasting: "lore", arcane: "lore", divine: "lore", occult: "lore", primal: "lore", summoning: "lore",
  craft: "craft", alchemy: "craft",
  survival: "wild"
};

const ELEMENT_DAMAGE = {
  pf2e: { fire: "fire", cold: "cold", electricity: "electricity", earth: "bludgeoning", air: "slashing" },
  dnd5e: { fire: "fire", cold: "cold", electricity: "lightning", earth: "bludgeoning", air: "thunder" }
};

const CAPSTONE_FAMILIES = {
  offense: {
    concept: "Decisive Blow",
    pf2e: () => ["your next Strike before the end of your turn deals an extra 3d6 damage of its normal type", "the extra damage is 5d6 and the target is off-guard until the start of your next turn"],
    dnd5e: () => ["your next weapon attack that hits before the end of your turn deals an extra 3d6 damage of the weapon's type", "the extra damage is 5d6 and the target can't take reactions until the start of your next turn"]
  },
  elemental: {
    concept: (tag) => `${titleCase(tag)} Surge`,
    pf2e: (tag) => [`each creature of your choice in a 15-foot emanation takes 4d6 ${ELEMENT_DAMAGE.pf2e[tag] ?? "force"} damage`, "the damage is 6d6 and those creatures are off-guard until the start of your next turn"],
    dnd5e: (tag) => [`each creature of your choice within 15 feet of you takes 4d6 ${ELEMENT_DAMAGE.dnd5e[tag] ?? "force"} damage`, "the damage is 6d6 and those creatures can't take reactions until the start of your next turn"]
  },
  defense: {
    concept: "Unyielding Bulwark",
    pf2e: () => ["you gain resistance to physical damage equal to half your level until the start of your next turn", "adjacent allies gain the same resistance"],
    dnd5e: () => ["you have resistance to bludgeoning, piercing, and slashing damage until the start of your next turn", "allies within 5 feet of you gain the same resistance"]
  },
  mobility: {
    concept: "Boundless Stride",
    pf2e: () => ["you Stride up to twice your Speed; this movement ignores difficult terrain and doesn't trigger reactions", "you also gain a +10-foot status bonus to all your Speeds for 1 minute"],
    dnd5e: () => ["you move up to twice your speed without provoking opportunity attacks, ignoring difficult terrain", "your speed also increases by 10 feet for 1 minute"]
  },
  stealth: {
    concept: "Vanishing Step",
    pf2e: () => ["you become undetected by all creatures until the end of your next turn or until you use a hostile action", "your first Strike while undetected this way deals an extra 2d6 precision damage"],
    dnd5e: () => ["you have the Invisible condition until the end of your next turn or until you make an attack roll, deal damage, or cast a spell", "your first attack that hits while invisible this way deals an extra 2d6 damage"]
  },
  inspire: {
    concept: "Rallying Presence",
    pf2e: () => ["each ally within 30 feet gains temporary Hit Points equal to your level and a +1 status bonus to attack rolls and saving throws until the end of your next turn", "the status bonus is +2"],
    dnd5e: () => ["each ally within 30 feet who can hear you gains temporary hit points equal to your character level and has advantage on its next attack roll or saving throw before the end of your next turn", "the temporary hit points are doubled"]
  },
  fear: {
    concept: "Dread Presence",
    pf2e: () => ["each enemy within 30 feet that can see or hear you becomes frightened 1", "those enemies become frightened 2 instead"],
    dnd5e: () => ["each enemy within 30 feet that can see or hear you has the Frightened condition until the end of your next turn", "their speed is also 0 while they are Frightened this way"]
  },
  heal: {
    concept: "Mending Hands",
    pf2e: () => ["one living creature within reach regains 4d8 + your level Hit Points", "it regains 8d8 + your level Hit Points instead and its frightened and sickened values drop by 1"],
    dnd5e: () => ["one creature within 5 feet of you regains 4d8 + your proficiency bonus hit points", "it regains 8d8 + your proficiency bonus hit points instead and one condition of your choice (Poisoned, Frightened, or Blinded) ends on it"]
  },
  lore: {
    concept: "Piercing Insight",
    pf2e: () => ["choose one creature you can see within 60 feet: it takes a -2 status penalty to saving throws against you and your allies until the end of your next turn", "you also learn its lowest saving throw and every weakness it has"],
    dnd5e: () => ["choose one creature you can see within 60 feet: it has disadvantage on saving throws against your spells and abilities until the end of your next turn", "you also learn its damage vulnerabilities, resistances, and immunities"]
  },
  craft: {
    concept: "Masterwork Moment",
    pf2e: () => ["you create one temporary consumable item of your level or lower from the materials at hand without paying its cost; it becomes inert at your next daily preparations", "you create two such items"],
    dnd5e: () => ["you create one common or uncommon consumable (such as a potion of healing) from the materials at hand; it becomes inert when you finish your next long rest", "you create two such items"]
  },
  wild: {
    concept: "Pathfinder's Instinct",
    pf2e: () => ["for 1 hour, you and up to five allies can't become lost, ignore difficult terrain from natural terrain, and gain a +10-foot status bonus to Speed", "the effect lasts 8 hours"],
    dnd5e: () => ["for 1 hour, you and up to five allies can't become lost, ignore difficult terrain from natural terrain, and your speeds increase by 10 feet", "the effect lasts 8 hours"]
  },
  resolve: {
    concept: "Hard-Won Resolve",
    pf2e: () => ["until the end of your next turn you gain a +2 status bonus to all checks and saving throws", "the bonus is +3 and you gain temporary Hit Points equal to your level"],
    dnd5e: () => ["until the end of your next turn you have advantage on ability checks and saving throws", "you also gain temporary hit points equal to your character level"]
  }
};

function capstoneFamily(topTag) {
  return CAPSTONE_FAMILIES[CAPSTONE_FAMILY_BY_TAG[topTag] ?? "resolve"];
}

function buildCapstoneEntry(level, topTag, systemId, ctx) {
  const family = capstoneFamily(topTag);
  const is5e = systemId === "dnd5e";
  const check = checkForTag(topTag, systemId);
  const dc = ctx.dcFor(check);
  const [success, critical] = (is5e ? family.dnd5e : family.pf2e)(topTag);
  const concept = typeof family.concept === "function" ? family.concept(topTag) : family.concept;
  const tags = topTag ? [topTag, "capstone"] : ["capstone"];
  // A PF2e capstone keeps its "+4 circumstance bonus" on the check (the boost that makes it a
  // capstone); dnd5e reads the same boost as advantage plus a flat +2.
  const boost = is5e ? "with advantage and a +2 bonus" : "with a +4 circumstance bonus";
  const activation = is5e ? "As an action" : "As a two-action activity";
  const critLead = is5e ? "If you beat the DC by 10 or more" : "On a critical success";
  return {
    name: flavorProposalName(ctx.namingClass(tags), concept),
    tier: 3,
    system_equivalent: `Rare capstone ability (Grand Design level ${level})`,
    gameItem: { kind: "action" },
    mechanics: {
      effect: `${activation}, once per day, attempt ${/^[AEIOU]/.test(check.label) ? "an" : "a"} ${check.label} against DC ${dc} ${boost}. `
        + `On a success, ${success}. ${critLead}, ${critical}.`,
      duration: "instant",
      frequency: { max: 1, per: "day" },
      // PF2e's two-action activity; in dnd5e the adapter reads `actions` as the activation count.
      actions: is5e ? 1 : 2,
      roll: { kind: check.label, formula: formulaFor(ctx.modifierFor(check, check.label)), dc }
    },
    metadata: {
      tags,
      lineage: {
        operation: "origin",
        sources: [],
        rationale: `Guaranteed capstone Skill unlocked at Grand Design level ${level} -- every 10th level grants one rare Skill regardless of tag evidence. `
          + `Built-in template around this character's strongest recorded discipline (${topTag ?? "none recorded yet"}).`
      }
    }
  };
}

// A Class needs level/power_tier/is_primary/is_secondary/system_chassis on top of the fields a Skill
// needs (see validator.js#validateClasses, ai-gateway.js's "class" example). gameItem.kind "passive"
// keeps it free of action-economy wording; the benefit is concrete (board 0ed137cb): a standing
// bonus on the discipline's real check, plus a once-per-day turn of a failure.
function buildClassEvolutionEntry(level, topTag, systemId, actorLevel, systemClass, ctx) {
  const themeLabel = topTag ? titleCase(topTag) : "Growth";
  const is5e = systemId === "dnd5e";
  const check = checkForTag(topTag, systemId);
  const plural = check.type === "save" ? `${check.label}s` : `${check.label.replace(/ check$/, "")} checks`;
  const tags = topTag ? [topTag] : [];
  const effect = is5e
    ? `You gain a +2 bonus to ${plural}. Once per long rest, when you fail one, you can reroll it and must use the new roll.`
    : `You gain a +1 status bonus to ${plural}. Once per day, when you roll a failure on one of them, you get a success instead.`;
  return {
    name: flavorProposalName(ctx.namingClass(tags), `${themeLabel} Ascendant`),
    level: Number.isInteger(actorLevel) && actorLevel >= 1 ? actorLevel : Math.max(1, level),
    power_tier: "standard",
    is_primary: false,
    is_secondary: false,
    system_chassis: systemClass
      ? `${systemClass} evolution (Grand Design level ${level})`
      : `${is5e ? "D&D 5e" : "PF2e"} Grand Design Class evolution (Grand Design level ${level}; no system class on the sheet)`,
    gameItem: { kind: "passive" },
    mechanics: {
      effect,
      duration: "ongoing",
      frequency: { max: 1, per: "day" }
    },
    metadata: {
      tags,
      lineage: {
        operation: "origin",
        sources: [],
        rationale: `Guaranteed Class evolution unlocked at Grand Design level ${level} -- every class-evolution level (20, 30, 50) grants one regardless of tag evidence. `
          + `Built-in template around this character's strongest recorded discipline (${topTag ?? "none recorded yet"}).`
      }
    }
  };
}

function titleCase(value) {
  return String(value).replace(/(^|[\s-])([a-z])/g, (match, sep, letter) => `${sep}${letter.toUpperCase()}`);
}

export function validateGrowthEvent(event) {
  const errors = [];
  if (!isRecord(event)) errors.push("Growth event must be an object.");
  if (!isNonEmptyString(event?.summary)) errors.push("Growth event summary is required.");
  // Emergent themes (AI gateway v2, 2026-09-23): an event is evidence if it carries at least one
  // canonical gameplay tag OR at least one emergent theme slug ("beekeeping", "gambling") -- the
  // activities a 38-tag taxonomy can never anticipate. `tags` may be [] (or omitted) when themes
  // carry the event; canonical-tag evidence math is unchanged either way.
  const tagsValid = event?.tags === undefined || (Array.isArray(event.tags) && event.tags.every(isNonEmptyString));
  const themesValid = event?.themes === undefined || (Array.isArray(event.themes) && event.themes.every(isNonEmptyString));
  if (!tagsValid) errors.push("Growth event tags must be an array of non-empty strings.");
  if (!themesValid) errors.push("Growth event themes must be an array of non-empty strings.");
  const tagCount = Array.isArray(event?.tags) ? event.tags.length : 0;
  const themeCount = Array.isArray(event?.themes) ? event.themes.length : 0;
  if (tagsValid && themesValid && tagCount === 0 && themeCount === 0) {
    errors.push("Growth event tags must contain at least one non-empty tag (or themes at least one emergent theme).");
  }
  if (!Object.prototype.hasOwnProperty.call(GROWTH_EVENT_OUTCOME_WEIGHTS, event?.outcome)) {
    errors.push(`Growth event outcome must be one of: ${Object.keys(GROWTH_EVENT_OUTCOME_WEIGHTS).join(", ")}.`);
  }
  // Counter-leveling (constants.js#DANGER_GAP_MULTIPLIERS): optional, and only meaningful as one
  // of the two recognized severity tiers -- anything else is rejected rather than silently ignored,
  // so a typo'd dangerGap value doesn't just quietly fail to apply its multiplier.
  if (event?.dangerGap !== undefined && !Object.prototype.hasOwnProperty.call(DANGER_GAP_MULTIPLIERS, event.dangerGap)) {
    errors.push(`Growth event dangerGap must be one of: ${Object.keys(DANGER_GAP_MULTIPLIERS).join(", ")}.`);
  }
  return { valid: errors.length === 0, errors };
}

export function normalizeGrowthEvent(event, index) {
  const validation = validateGrowthEvent(event);
  if (!validation.valid) throw new Error(validation.errors.join(" "));
  const themes = uniqueStrings(event.themes ?? []).map((theme) => theme.toLowerCase()).filter(Boolean);
  const optionalText = (value, max) => (isNonEmptyString(value) ? value.trim().slice(0, max) : undefined);
  const quote = optionalText(event.quote, MAX_QUOTE_LENGTH);
  const language = optionalText(event.language, 16);
  const actorName = optionalText(event.actorName, 120);
  const consequence = optionalText(event.consequence, 240);
  const source = GROWTH_EVENT_SOURCES.has(event.source) ? event.source : undefined;
  // Horror Rank is derived from these (horror-rank.js#computeHorrorRank), so they must survive
  // recording. Kept (validated, unknown values -> "none") whenever the reader supplied either field;
  // an event without them (the local fallback analyzer, older worlds) simply has no dark deed.
  const darkFields = event.darkDeed !== undefined || event.darkSeverity !== undefined ? normalizeDarkDeed(event) : null;
  // Atonement (owner decision 2026-09-29) lowers the derived meter, so it must survive recording too;
  // kept only when the reader supplied it (unknown values -> "none"), like the dark-deed fields.
  const atonement = event.atonement !== undefined ? normalizeAtonement(event) : undefined;
  const jev = compactJev(event.jev);
  const reassigned = compactReassigned(event.reassigned);
  return {
    id: event.id ?? `event:${Date.now()}-${index}`,
    summary: event.summary.trim(),
    tags: uniqueStrings(event.tags ?? []),
    outcome: event.outcome,
    occurredAt: event.occurredAt ?? new Date().toISOString(),
    ...(event.dangerGap !== undefined ? { dangerGap: event.dangerGap } : {}),
    ...(themes.length ? { themes: [...new Set(themes)] } : {}),
    ...(quote ? { quote } : {}),
    ...(language ? { language } : {}),
    ...(actorName ? { actorName } : {}),
    ...(consequence ? { consequence } : {}),
    ...(darkFields ?? {}),
    ...(atonement !== undefined ? { atonement } : {}),
    ...(source ? { source } : {}),
    ...(jev ? { jev } : {}),
    ...(reassigned ? { reassigned } : {})
  };
}

/**
 * Board 4344c58a: the GM's "Move to..." stamp (api.js#reassignRecordedEvent) -- who the notes had
 * credited and when the GM moved it. Only the known keys survive; anything else -> undefined.
 */
function compactReassigned(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const text = (entry) => (isNonEmptyString(entry) ? entry.trim().slice(0, 120) : null);
  return {
    fromActorId: text(value.fromActorId),
    fromActorName: text(value.fromActorName),
    originalActorName: text(value.originalActorName),
    by: "gm",
    at: text(value.at) ?? new Date().toISOString()
  };
}

/**
 * The Jev annotations (docs/jev-layer-contract.md) the Growth dialog shows as chips -- who did it
 * and how sure, whole-party, a corrected outcome, flags. Kept compact so it survives the actor flag
 * without bloating it: only the known keys, short strings, at most 8 flags. Absent -> undefined.
 */
function compactJev(jev) {
  if (!jev || typeof jev !== "object" || Array.isArray(jev)) return undefined;
  const text = (value) => (isNonEmptyString(value) ? value.trim().slice(0, 64) : undefined);
  const number = (value) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value) : undefined);
  const flags = Array.isArray(jev.flags)
    ? uniqueStrings(jev.flags.filter(isNonEmptyString)).map((flag) => flag.slice(0, 64)).slice(0, 8)
    : [];
  const compact = {
    ...(text(jev.actorName) ? { actorName: text(jev.actorName) } : {}),
    ...(number(jev.actorConfidence) !== undefined ? { actorConfidence: number(jev.actorConfidence) } : {}),
    ...(jev.whole === true ? { whole: true } : {}),
    ...(text(jev.outcome) ? { outcome: text(jev.outcome) } : {}),
    ...(text(jev.outcomeFrom) ? { outcomeFrom: text(jev.outcomeFrom) } : {}),
    ...(flags.length ? { flags } : {})
  };
  return Object.keys(compact).length ? compact : undefined;
}

const MAX_QUOTE_LENGTH = 400;
const GROWTH_EVENT_SOURCES = new Set(["adapter", "local"]);

/**
 * `consolidations` (see constants.js#CONSOLIDATIONS_FLAG, api.js#setConsolidation) is an array of
 * `{ classIds: [idA, idB] }` GM-declared links between two of the actor's own approved Classes.
 * When present, a growth event tagged with one consolidated Class's own tags is treated as ALSO
 * carrying its counterpart Class's tags for evidence-weighting purposes only (the event's stored
 * tags on the actor are never rewritten) -- e.g. a maid whose combat Class is consolidated with her
 * domestic one gets combat-tag evidence credit from kitchen-work session notes, per canon's
 * Consolidation mechanic. This is deliberately independent of class-merging.js: consolidation never
 * creates, renames, or changes a Class, it only widens which events count as evidence for a
 * tag-triggered Skill proposal.
 */
/**
 * `tagWeights` (see tag-weighting.js, GM-configured via a world setting -- tag-weighting-settings.js)
 * is Dynamic tag reweighting: canon's Isthekenous actively repatches which tags grant which XP over
 * time, so a tag's contribution to a template's required-evidence threshold isn't hardcoded at 1x
 * forever. Omit it (default {}) and every tag weighs exactly as it always has -- this keeps every
 * existing caller that predates this feature completely unaffected.
 */
/**
 * `options.systemId` ("pf2e" default | "dnd5e") picks the wording of the generated entry: the
 * templates are written in PF2e terms and carry a dnd5e variant (DND5E_TEMPLATE_VARIANTS). Every
 * proposal is stamped `source: "template"` so the GM (and the Growth dialog) can tell a fixed
 * tag-template from an AI-written or emergent-theme proposal.
 */
export function generateSkillProposals(events, existingRegistry, modifier = 0, consolidations = [], tagWeights = {}, { systemId = "pf2e", rollContext } = {}) {
  // Every recognized outcome is usable evidence now, not just success/criticalSuccess -- genuine
  // repeated effort (including failure) counts, just at a lower weight (GROWTH_EVENT_OUTCOME_WEIGHTS).
  const weighableEvents = events.filter((event) => Object.prototype.hasOwnProperty.call(GROWTH_EVENT_OUTCOME_WEIGHTS, event.outcome));
  const consolidatedEvents = applyConsolidations(weighableEvents, existingRegistry, consolidations);
  const existingSkills = new Set(Object.keys(existingRegistry?.skills ?? {}));
  const ctx = normalizeRollContext(modifier, systemId, { rollContext });
  return PROPOSAL_TEMPLATES
    .filter((template) => template.requiredTags.every((tag) => taggedEvidenceWeight(consolidatedEvents, tag, tagWeights) >= MINIMUM_EVIDENCE))
    .map((template) => buildProposal(template, consolidatedEvents, ctx, tagWeights, systemId))
    // Already approved under its stable template id, its bare name (approvals before names were
    // class-flavored), or its flavored name.
    .filter((proposal) => ![
      proposal.entry.metadata.id,
      `skill:${slugify(templateEntryForSystem(PROPOSAL_TEMPLATES.find((t) => `proposal:${t.id}` === proposal.id), systemId).name)}`,
      `skill:${slugify(proposal.entry.name)}`
    ].some((id) => existingSkills.has(id)));
}

function applyConsolidations(events, registry, consolidations) {
  if (!Array.isArray(consolidations) || !consolidations.length || !registry) return events;
  // A symmetric tag-alias graph: consolidating Class A (tags X) with Class B (tags Y) means an
  // event carrying any tag in X should also be credited with every tag in Y, and vice versa.
  const aliasMap = new Map();
  for (const consolidation of consolidations) {
    const [idA, idB] = consolidation?.classIds ?? [];
    const classA = registry.classes?.[idA];
    const classB = registry.classes?.[idB];
    if (!classA || !classB) continue;
    const tagsA = classA.metadata?.tags ?? [];
    const tagsB = classB.metadata?.tags ?? [];
    for (const tag of tagsA) addAliases(aliasMap, tag, tagsB);
    for (const tag of tagsB) addAliases(aliasMap, tag, tagsA);
  }
  if (!aliasMap.size) return events;
  return events.map((event) => {
    const extra = event.tags.flatMap((tag) => [...(aliasMap.get(tag) ?? [])]);
    if (!extra.length) return event;
    return { ...event, tags: uniqueStrings([...event.tags, ...extra]) };
  });
}

function addAliases(map, tag, aliasTags) {
  if (!aliasTags.length) return;
  const set = map.get(tag) ?? new Set();
  for (const aliasTag of aliasTags) set.add(aliasTag);
  map.set(tag, set);
}

export function proposalId(proposal) {
  return `proposal:${slugify(proposal.entry.name)}`;
}

function buildProposal(template, events, ctx, tagWeights = {}, systemId = "pf2e") {
  const evidenceEvents = events.filter((event) => template.requiredTags.some((tag) => event.tags.includes(tag)));
  const evidence = evidenceEvents.map((event) => event.id);
  // An event can match more than one of a template's required tags; when a GM has reweighted them
  // differently, credit that event at whichever matched tag currently carries the highest multiplier.
  const totalWeight = evidenceEvents.reduce((sum, event) => {
    const matchedTags = template.requiredTags.filter((tag) => event.tags.includes(tag));
    const multiplier = Math.max(...matchedTags.map((tag) => weightForTag(tagWeights, tag)));
    return sum + GROWTH_EVENT_OUTCOME_WEIGHTS[event.outcome] * multiplier;
  }, 0);
  const entry = templateEntryForSystem(template, systemId);
  if (entry.mechanics.roll) {
    // Board 17c10e97: the modifier of the check this template actually rolls (Medicine for Field
    // Triage), not the Acrobatics modifier every template used to get.
    const check = resolveRollCheck(entry.mechanics.roll.kind, systemId);
    entry.mechanics.roll.formula = formulaFor(ctx.modifierFor(check, entry.mechanics.roll.kind));
    // PF2e DCs scale with the character (a fixed DC 15 is trivial at level 12). dnd5e keeps the
    // template's own DC: bounded accuracy means 5e DCs are not meant to climb with level.
    if (check && systemId !== "dnd5e" && ctx.hasActor) entry.mechanics.roll.dc = ctx.dcFor(check);
  }
  // Board 9ebbf3c9: named after the character's Class ("Speartip: Measured Strike"). The registry id
  // stays the template's own, so a renamed Class never makes an approved template look new.
  entry.metadata.id = `skill:${template.id}`;
  entry.name = flavorProposalName(ctx.namingClass(template.requiredTags), entry.name);
  entry.metadata.lineage.rationale =
    `Generated after ${evidence.length} tagged event(s), weighted evidence ${totalWeight.toFixed(2)} `
      + `(successes count for more than failures, but persistence through failure counts too): ${evidence.join(", ")}. GM approval is required.`;
  return {
    id: `proposal:${template.id}`,
    kind: "skill",
    status: "pending",
    source: "template",
    systemId,
    evidence,
    entry
  };
}

function taggedEvidenceWeight(events, tag, tagWeights = {}) {
  const multiplier = weightForTag(tagWeights, tag);
  return events
    .filter((event) => event.tags.includes(tag))
    .reduce((sum, event) => sum + GROWTH_EVENT_OUTCOME_WEIGHTS[event.outcome] * multiplier, 0);
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => value.trim()))];
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function growthFlags(actor) {
  return {
    events: actor.getFlag(MODULE_ID, GROWTH_EVENTS_FLAG) ?? [],
    proposals: actor.getFlag(MODULE_ID, GROWTH_PROPOSALS_FLAG) ?? []
  };
}

export function levelProgressionFlags(actor) {
  return normalizeLevelProgression(actor.getFlag(MODULE_ID, LEVEL_PROGRESSION_FLAG));
}

export function progressionForEvent(event) {
  const dangerGapMultiplier = DANGER_GAP_MULTIPLIERS[event.dangerGap] ?? 1;
  return (GROWTH_EVENT_OUTCOME_WEIGHTS[event.outcome] ?? 0) * BASE_SUCCESS_PROGRESS * dangerGapMultiplier;
}

export function levelRequirement(level) {
  if (!Number.isInteger(level) || level < 0 || level >= GRAND_DESIGN_MAX_LEVEL) {
    throw new Error(`Level must be an integer from 0 to ${GRAND_DESIGN_MAX_LEVEL - 1}.`);
  }
  return 100 + level * 35 + level * level * 4;
}

export function resolveRest(progression, { restType, dire = false } = {}) {
  if (!["short", "long"].includes(restType) && !dire) {
    throw new Error("Levels can only be resolved during a short or long rest unless the scenario is marked dire.");
  }
  const next = normalizeLevelProgression(progression);
  const gainedLevels = [];
  while (next.level < GRAND_DESIGN_MAX_LEVEL && next.progress >= levelRequirement(next.level)) {
    next.progress -= levelRequirement(next.level);
    next.level += 1;
    next.grantAllowances += 1;
    if (isCapstoneLevel(next.level)) next.capstoneAllowances += 1;
    gainedLevels.push(next.level);
  }
  next.lastRestAt = new Date().toISOString();
  next.lastRestType = dire ? "dire" : restType;
  return {
    progression: next,
    gainedLevels,
    classEvolutionUnlocked: gainedLevels.filter((level) => CLASS_EVOLUTION_LEVELS.has(level)),
    capstoneLevelsUnlocked: gainedLevels.filter(isCapstoneLevel)
  };
}

export function canApproveGeneratedProposal(progression, proposal) {
  const state = normalizeLevelProgression(progression);
  if (proposal.isCapstone) {
    if (state.capstoneAllowances < 1) {
      return { valid: false, error: "No capstone Skill is currently available -- one unlocks automatically at each Grand Design level divisible by 10." };
    }
    return { valid: true, error: null };
  }
  if (state.grantAllowances < 1) {
    return { valid: false, error: "Resolve a Grand Design level-up at rest before granting a generated entry." };
  }
  // A Class made for a milestone (or by the AI while a Class was available) stays approvable after
  // the character rests past that level; only a Class with no such level needs the live one.
  const classLevel = Number.isInteger(proposal.milestoneLevel) ? proposal.milestoneLevel : proposal.classEvolutionLevel;
  if (proposal.kind === "class" && !CLASS_EVOLUTION_LEVELS.has(state.level) && !CLASS_EVOLUTION_LEVELS.has(classLevel)) {
    return {
      valid: false,
      error: `Generated Class evolution is only available at Grand Design levels 20, 30, or 50 (current level: ${state.level}).`
    };
  }
  return { valid: true, error: null };
}

export function spendGrantAllowance(progression) {
  const state = normalizeLevelProgression(progression);
  if (state.grantAllowances < 1) throw new Error("No Grand Design grant allowances are available.");
  return { ...state, grantAllowances: state.grantAllowances - 1 };
}

export function spendCapstoneAllowance(progression) {
  const state = normalizeLevelProgression(progression);
  if (state.capstoneAllowances < 1) throw new Error("No Grand Design capstone allowances are available.");
  return { ...state, capstoneAllowances: state.capstoneAllowances - 1 };
}

function normalizeLevelProgression(value) {
  const level = Number.isInteger(value?.level) && value.level >= 0 && value.level <= GRAND_DESIGN_MAX_LEVEL
    ? value.level
    : 0;
  const progress = Number.isFinite(value?.progress) && value.progress >= 0 ? value.progress : 0;
  const grantAllowances = Number.isInteger(value?.grantAllowances) && value.grantAllowances >= 0
    ? value.grantAllowances
    : 0;
  const capstoneAllowances = Number.isInteger(value?.capstoneAllowances) && value.capstoneAllowances >= 0
    ? value.capstoneAllowances
    : 0;
  return {
    level,
    progress,
    grantAllowances,
    capstoneAllowances,
    lastRestAt: value?.lastRestAt ?? null,
    lastRestType: value?.lastRestType ?? null
  };
}
