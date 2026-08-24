export const MODULE_ID = "grand-design-ai";
export const ACTOR_FLAG = "conversion";
export const REGISTRY_FLAG = "registry";
export const TEST_SCENARIO_FLAG = "testScenario";
export const GROWTH_EVENTS_FLAG = "growthEvents";
export const GROWTH_PROPOSALS_FLAG = "growthProposals";
export const LEVEL_PROGRESSION_FLAG = "levelProgression";
// GM-declared pairs of an actor's own approved Classes that are narratively/thematically linked
// (canon's "Consolidation": a maid's combat Class consolidated with her domestic one gains combat
// evidence from kitchen work). Distinct from class-merging.js's one-time fusion -- this is ongoing
// and never creates or changes a Class, it only widens which growth-event tags count as evidence
// for each other. See progression.js#generateSkillProposals's consolidations parameter.
export const CONSOLIDATIONS_FLAG = "consolidations";

export const POWER_TIERS = new Set(["standard", "elevated", "prestige"]);
export const SKILL_TIERS = new Set([1, 2, 3]);
export const LINEAGE_OPERATIONS = new Set(["origin", "combine", "upgrade"]);
// Grand Design's own vocabulary for "what kind of mechanical entry is this" -- deliberately
// generic (not tied to any one TTRPG's Item schema) so the same set works for every supported
// game system's adapter. Kept as PF2E_ITEM_KINDS as well for backward compatibility with any
// external code/flags referencing the old name; both point at the same Set.
export const GRAND_DESIGN_ITEM_KINDS = new Set(["feat", "action", "reaction", "free", "passive", "spell", "weapon"]);
export const PF2E_ITEM_KINDS = GRAND_DESIGN_ITEM_KINDS;
// Spell "school" is a real enum-constrained field in some systems (e.g. dnd5e's abj/con/div/
// enc/evo/ill/nec/trs) even though it isn't meaningfully used by others (PF2e uses freeform
// "tradition" instead). Validated the same way regardless of active system so the AI-facing
// schema and validator stay system-agnostic; each system adapter reads whichever field it needs.
export const SPELL_SCHOOLS = new Set(["abj", "con", "div", "enc", "evo", "ill", "nec", "trs"]);
export const FREQUENCY_PERIODS = new Set(["round", "minute", "hour", "day", "encounter", "unlimited"]);
// A growth event's outcome and how much "evidence weight" it contributes -- both toward Grand
// Design progress points and toward the weighted-evidence threshold a proposal template needs.
// Genuine effort is evidence even without success: a character who tries and fails at the same
// kind of thing over and over is still practicing it, so failure/criticalFailure are valid
// outcomes, not rejected ones -- they're simply worth less than success/criticalSuccess, so a
// handful of successes still gets there far faster than a pile of failures, but enough failures
// (persistence) can still add up to real growth on their own. criticalFailure is weighted above
// plain failure on purpose: a dramatic, costly failure (getting hurt, a plan backfiring badly)
// tends to teach something concrete -- caution, a scar, a reflex -- even though the roll itself
// didn't succeed, which is exactly the kind of lesson an AI proposal is free to shape a defensive
// or resistance-flavored entry around instead of a mastery-flavored one.
export const GROWTH_EVENT_OUTCOME_WEIGHTS = {
  criticalSuccess: 1.6,
  success: 1,
  criticalFailure: 0.5,
  failure: 0.25
};
// Canon's "counter-leveling": a lower-level character who survives a severely mismatched fight
// grows faster than the outcome weight alone would suggest. `event.dangerGap` (optional, set by
// the GM, an AI-gateway adapter, or session-notes.js's own keyword heuristic) multiplies the
// progress points a growth event contributes (see progression.js#progressionForEvent) on top of
// its ordinary GROWTH_EVENT_OUTCOME_WEIGHTS weighting. Deliberately does NOT affect Skill-proposal
// evidence weighting (taggedEvidenceWeight) -- counter-leveling is about how much a lopsided fight
// teaches you, not about whether it counts as evidence of practicing a specific tagged activity.
export const DANGER_GAP_MULTIPLIERS = { moderate: 1.5, severe: 2.5 };
export const GRAND_DESIGN_MAX_LEVEL = 100;
export const CLASS_EVOLUTION_LEVELS = new Set([20, 30, 50]);
export const SUPPORTED_GAME_SYSTEMS = new Set(["pf2e", "dnd5e"]);
// Most Class/Skill entries are "standard". A "red" entry is a genuinely taboo, vile, or forced
// origin (see vice-taxonomy.js) -- still a real, potentially powerful entry, but one that must
// carry an explicit metadata.malignance {vice, drawback} rather than reading as an ordinary
// heroic ability. Ordinary morally-gray professions (thief, assassin, spy) are NOT red; only
// entries built from genuine vice or violation are.
export const ENTRY_POLARITIES = new Set(["standard", "red"]);
// Horror Rank (canon: "terrible deeds grant non-real classes that progressively consume regular
// class levels"). A per-actor corruption meter (HORROR_RANK_FLAG) that accrues points every time a
// red-polarity Class/Skill/Title is actually approved -- once accumulated points cross
// HORROR_RANK_THRESHOLD, HORROR_RANK_LEVEL_PENALTY levels are docked from the actor's own
// strongest standard-polarity Class. See horror-rank.js.
export const HORROR_RANK_FLAG = "horrorRank";
export const HORROR_RANK_POINTS_PER_RED_APPROVAL = 25;
export const HORROR_RANK_THRESHOLD = 100;
export const HORROR_RANK_LEVEL_PENALTY = 2;
// Revival penalty (canon: resurrection costs levels off the character's own highest Class). A
// one-shot GM action (api.applyRevivalPenalty), NOT an accumulating meter like Horror Rank --
// see revival-penalty.js. Deliberately does NOT exclude red Classes from being the docking target
// (unlike Horror Rank): death is a physical/mystical toll paid regardless of what your strongest
// Class actually is, not a corruption consequence.
export const REVIVAL_PENALTY_LEVELS = 10;
// Natural-language "Populate" spawn requests (scripts/populate.js) produce one of these document
// kinds. "npc" and "monster" both create a real Actor; the split exists only so the local
// heuristic and any registered AI adapter know which template bank/spec shape to use --
// mechanically an NPC and a monster are both just Foundry Actors of type "npc".
export const SPAWN_DOCUMENT_KINDS = new Set(["npc", "monster", "item"]);

// Grand Design entry kinds that live in the actor registry (lineage.js#emptyRegistry). "title" is
// a third kind alongside the original "class"/"skill": a Title is earned for a specific narrative
// achievement rather than an ongoing activity pattern, is never combined/upgraded the way a Class
// or Skill can be, and may bundle an optional reward (see TITLE_GRANT_KEYS) -- but it shares the
// same lineage/validation/registry plumbing since none of that plumbing actually cares which kind
// of entry it's normalizing.
export const REGISTRY_ENTRY_KINDS = new Set(["class", "skill", "title"]);
// The only reward types a Title's `grants` object may carry (Titles wiki page: a Title grants a
// Skill, an Item, a reputation note, or a passive Condition -- never more than one of each kind).
export const TITLE_GRANT_KEYS = new Set(["skillEntry", "itemGrant", "reputation", "condition"]);

// Skill evolution (canon: [Power Strike] becomes [Minotaur Punch]). The weighted-evidence total a
// Skill needs behind it -- on the same scale as GROWTH_EVENT_OUTCOME_WEIGHTS, so 4 successes, or a
// larger pile of failures, or any mix -- before a defining moment can actually transform it rather
// than merely refine it. Deliberately above progression.js's MINIMUM_EVIDENCE (3, what it takes to
// EARN a Skill in the first place): transforming something you already have should cost more than
// acquiring it did. See skill-evolution.js.
export const SKILL_EVOLUTION_EVIDENCE_THRESHOLD = 4;

// Live multi-caster Combination Skills (canon: several characters' Skills fired together in one
// moment produce something none of them could alone). See combination-skills.js. Transient by
// design -- a combination never enters anyone's Class/Skill registry; COMBINATIONS_FLAG is a
// per-actor HISTORY of the combinations that actor has taken part in, so a cast one can be found
// and ended again (its temporary Items removed) and so the table has a record afterward.
export const COMBINATIONS_FLAG = "combinations";
// Average pairwise tag overlap (plus the participant bonus below) at or above which contributed
// Skills genuinely amplify each other, and below which they are actively discordant. Same two-band
// shape as class-merging.js's MERGE_FOCUS_* thresholds, with a middle band that simply holds.
export const COMBINATION_RESONANCE_STRONG_THRESHOLD = 0.5;
export const COMBINATION_RESONANCE_WEAK_THRESHOLD = 0.2;
// The deliberate inversion of class-merging.js's GENERALIZATION_PENALTY_PER_EXTRA_SOURCE: every
// caster past the second ADDS resonance rather than subtracting it. A Class merge spreading across
// more paths is a less committed choice; a combination landing more casters in the same instant is
// simply harder to pull off.
export const COMBINATION_PARTICIPANT_RESONANCE_BONUS = 0.12;
// What an amplified combination multiplies its summed contributor tiers by, and the ceiling any
// combination's power is clamped to.
export const COMBINATION_AMPLIFIED_MULTIPLIER = 1.5;
export const COMBINATION_MAX_POWER = 12;

// Class Loss / behavioral erosion (canon: classes like [Hero] or [King] can be lost if the
// defining behavior that earned them stops). A GM ADVISORY check only -- see class-erosion.js --
// never automatic removal. "Session" is approximated as a distinct calendar date among a growth
// event's own `occurredAt` timestamps (no separate session-id concept exists in the data model),
// since tabletop sessions naturally fall on distinct days. This default can be overridden per call.
export const CLASS_EROSION_DEFAULT_SESSION_THRESHOLD = 3;
