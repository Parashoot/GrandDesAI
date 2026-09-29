// The gateway pipeline: notes in, validated events + repaired proposals out.
//
//   preprocess -> chunk -> [extract per chunk: schema-constrained call -> parseModelJson ->
//   coerceEvent -> repair turn if unusable] -> merge/dedupe -> [propose (per proposalMode):
//   schema-constrained call -> repairProposal -> validator -> one repair turn -> skip] -> result
//
// The invariant this file exists to protect: the GM's notes are never lost, and the only way out of
// here that sends the GM to the local keyword analyzer is a *total* failure (the provider is
// unreachable, or no chunk produced anything parseable after every repair turn). Every partial
// failure -- one bad event, one bad chunk, a broken proposal, a proposal stage that times out --
// degrades to "keep what worked and say what didn't" in skippedEvents / skippedProposals /
// diagnostics, because a half-good AI answer is still far better than the keyword dictionary.
//
// Pure ESM, zero Foundry globals.

import { parseModelJson, ModelJsonError } from "./json-repair.js";
import { coerceEvent, eventDedupeKey, resolveTag, slugifyTheme, stemWord, CANONICAL_TAGS, VICE_SYNONYMS, darkSeverityRank } from "./normalize.js";
import { coerceStructuredMechanics, fillStructuredFromEffect } from "./structured.js";
import { EVENT_EXTRACTION_SCHEMA, COMBINED_SCHEMA, proposalSchemaCapped } from "./schemas.js";
// Pure (no Foundry globals): the same per-character credit rule api.js applies to the events.
import { attributeEventsToActor } from "../session-notes.js";
import { buildExtractionMessages, buildProposalMessages, buildSingleMessages, buildRepairMessage, creativityTemperature } from "./prompts.js";
import { normalizeGatewayConfig } from "./gateway-config.js";
import { AiProviderUnreachableError, AiProviderHttpError, AiProviderTimeoutError } from "./transport.js";
import { triageChunks, attributeEvents, verifyEvents, rankProposals, sameName, noteLines } from "./jev.js";
import { GROWTH_EVENT_OUTCOME_WEIGHTS, FREQUENCY_PERIODS, GRAND_DESIGN_ITEM_KINDS, SPELL_SCHOOLS, LINEAGE_OPERATIONS, POWER_TIERS } from "../constants.js";
import { VICE_TAGS } from "../vice-taxonomy.js";
import { validateSkillEntry as defaultValidateSkill, validateClassEntry as defaultValidateClass, validateTitleEntry as defaultValidateTitle } from "../validator.js";

// Same scale as progression.js MINIMUM_EVIDENCE / emergent-themes EMERGENT_THEME_EVIDENCE_THRESHOLD.
export const EARNED_EVIDENCE_THRESHOLD = 3;
const CANONICAL_SET = new Set(CANONICAL_TAGS);

// ---------------------------------------------------------------------------------------------
// Proposal quality backstops (board 316705b6, b81a0357, 3962a001)
//
// The stage-2 prompt now tells the model what the actor already owns (buildProposalMessages), but a
// mid-sized local model does not always obey; these are the deterministic nets that catch what slips
// through, independent of the model's own judgement.
// ---------------------------------------------------------------------------------------------

const MECHANIC_STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "and", "or", "on", "in", "with", "their", "its", "it", "then", "once",
  "per", "using", "use", "uses", "against", "one", "that", "this", "for", "as", "is", "are", "be",
  "can", "gain", "gains", "grant", "grants", "from", "your", "you", "they", "them", "he", "she", "his",
  "her", "when", "if", "after", "before", "than", "into", "onto", "not", "no", "all", "any", "each",
  "every", "own", "until", "while", "who", "which", "was", "were", "has", "have"
]);

function mechanicTokens(text) {
  const words = String(text ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !MECHANIC_STOPWORDS.has(w));
  return new Set(words.map(stemWord));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Board 316705b6: registry dedupe was by name only, so "Sanctuary: Voice of Conviction" sailed past
 * "Sanctuary: Public Edict" -- same Persuasion/Intimidation-vs-one-foe-then-Wisdom-save mechanic --
 * just because the second half of the name differed. Compares the proposal's own mechanics text and
 * tags/themes against every owned Class/Skill's, independent of naming.
 */
export function findDuplicateOwnedMechanic(entry, ownedEntries, { textThreshold = 0.5, minTextTokens = 4 } = {}) {
  const entryTokens = mechanicTokens(`${entry?.mechanics?.effect ?? ""} ${entry?.mechanics?.trigger ?? ""}`);
  if (entryTokens.size < minTextTokens) return null; // too little text to compare meaningfully
  const entryTags = new Set([...(entry?.metadata?.tags ?? []), ...(entry?.metadata?.themes ?? [])]);
  for (const owned of ownedEntries) {
    const ownedTokens = mechanicTokens(`${owned?.mechanics?.effect ?? ""} ${owned?.mechanics?.trigger ?? ""}`);
    if (ownedTokens.size < minTextTokens) continue;
    if (jaccard(entryTokens, ownedTokens) < textThreshold) continue;
    const ownedTags = new Set([...(owned?.metadata?.tags ?? []), ...(owned?.metadata?.themes ?? [])]);
    // A strong text match is already the real signal; when both sides do have tags, require some tag
    // overlap too so a coincidental phrase match ("a short prayer" vs "a short chant") does not count.
    if (!entryTags.size || !ownedTags.size || jaccard(entryTags, ownedTags) > 0) return owned;
  }
  return null;
}

// Board 3574bd96: two "Suggest proposals" clicks left Briik with "Unbroken Bastion" AND "Unbroken
// Bulwark" pending, and one stage-2 call wrote five "Longbow: Precision Volley"-like archery Skills.
// The owned-entry check above never saw pending proposals or the batch's own siblings, and the name
// check was an exact slug match. Two entries of the same kind are near-duplicates when they
//   - do the same thing (the owned-mechanic rule: effect/trigger text Jaccard >= 0.5, tags agree), or
//   - share a word of their CONCEPT name (the part after "Motif:" -- every Skill of one character
//     shares its motif by design) on the same tags/themes with some shared mechanic wording (for two
//     Classes the shared word alone: they are alternatives for the same evolution), or
//   - are the same kind of game item on the same tags/themes with clearly overlapping mechanics.
// Distinct abilities of one discipline (an archery reaction vs. an archery passive with different
// text) stay apart.
function conceptTokens(name) {
  const text = String(name ?? "");
  const colon = text.indexOf(":");
  return mechanicTokens(colon >= 0 ? text.slice(colon + 1) : text);
}

function inferEntryKind(entry) {
  return entry && entry.tier === undefined && (entry.level !== undefined || entry.power_tier !== undefined) ? "class" : "skill";
}

// Accepts a stage-2 proposal ({kind, entry, evidence}) or a compact pending/rejected record
// ({kind, name, effect, trigger, tags, themes, gameItemKind}) from ai-gateway.js#buildAiGatewayRequest.
function proposalShape(candidate) {
  const entry = candidate?.entry ?? {};
  const name = entry.name ?? candidate?.name ?? "";
  return {
    kind: candidate?.kind ?? inferEntryKind(entry),
    itemKind: entry.gameItem?.kind ?? candidate?.gameItemKind ?? null,
    text: mechanicTokens(`${entry.mechanics?.effect ?? candidate?.effect ?? ""} ${entry.mechanics?.trigger ?? candidate?.trigger ?? ""}`),
    concept: conceptTokens(name),
    tags: new Set([...(entry.metadata?.tags ?? candidate?.tags ?? []), ...(entry.metadata?.themes ?? candidate?.themes ?? [])].map((t) => String(t).toLowerCase()))
  };
}

/** Why `a` and `b` are near-duplicates ("mechanic" | "name" | "same-ground"), or null. */
export function nearDuplicateReason(a, b, { textThreshold = 0.5, nameTextThreshold = 0.2, groundTextThreshold = 0.35, minTextTokens = 4, ignoreConcept = null } = {}) {
  const x = proposalShape(a);
  const y = proposalShape(b);
  // Live PF2e rest 19->20 (build 4b63072): the Class "Fletchwright, Horizon's Edge" was skipped as a
  // duplicate of the owned SKILLS "Fletchwright: ..." and the milestone fell back to a template. A Class
  // and a Skill are different kinds of growth: never duplicates of each other, whatever the wording.
  if (x.kind !== y.kind) return null;
  // The character's class motif ("Fletchwright") is shared by every entry on purpose; not a concept.
  if (ignoreConcept?.size) for (const token of ignoreConcept) { x.concept.delete(token); y.concept.delete(token); }
  const textOk = x.text.size >= minTextTokens && y.text.size >= minTextTokens;
  const text = textOk ? jaccard(x.text, y.text) : 0;
  const tagsAgree = !x.tags.size || !y.tags.size || jaccard(x.tags, y.tags) > 0;
  if (textOk && text >= textThreshold && tagsAgree) return "mechanic";
  const tagOverlap = x.tags.size && y.tags.size ? jaccard(x.tags, y.tags) : 0;
  const sharesConcept = [...x.concept].some((token) => y.concept.has(token));
  if (sharesConcept && tagOverlap >= 0.5 && (x.kind === "class" || text >= nameTextThreshold)) return "name";
  if (x.itemKind && x.itemKind === y.itemKind && tagOverlap >= 0.5 && text >= groundTextThreshold) return "same-ground";
  return null;
}

export function findNearDuplicate(candidate, others, options) {
  for (const other of others ?? []) {
    const reason = nearDuplicateReason(candidate, other, options);
    if (reason) return { other, reason };
  }
  return null;
}

// "Best-sourced": the proposal citing more distinct evidence; a tie keeps the model's own order.
function evidenceScore(proposal) {
  return new Set((Array.isArray(proposal?.evidence) ? proposal.evidence : []).map((e) => String(e).trim().toLowerCase()).filter(Boolean)).size;
}

function findByNameOrNearDuplicate(proposal, records, options) {
  const key = slugifyTheme(proposal.entry?.name);
  const exact = records.find((record) => slugifyTheme(record?.name ?? record?.entry?.name) === key);
  return exact ? { other: exact, reason: "name" } : findNearDuplicate(proposal, records, options);
}

/** The motif half of "Motif: Concept" names, collected from every name a gate compares against. */
export function motifTokens(names) {
  const tokens = new Set();
  for (const name of names) {
    const text = String(name ?? "");
    const colon = text.indexOf(":");
    if (colon > 0) for (const token of mechanicTokens(text.slice(0, colon))) tokens.add(token);
  }
  return tokens;
}

// Board 3962a001: system-specific vocabulary that never belongs in the other system's entries (the
// dnd5e RULES_VOCABULARY string already asks the model not to write these, but a repair turn still let
// "use your free action" and "if using a durability system" through). Deliberately short and
// unambiguous multi-word phrases only, to avoid false positives on ordinary English.
const FORBIDDEN_SYSTEM_TERMS = {
  dnd5e: [
    [/\bfree action\b/i, "free action"],
    [/\boff-?guard\b/i, "off-guard"],
    [/\bflat-?footed\b/i, "flat-footed"],
    [/\bper encounter\b/i, "per encounter"],
    [/\bdurability system\b/i, "durability system"]
  ],
  pf2e: [
    [/\bbonus action\b/i, "bonus action"],
    [/\bshort rest\b/i, "short rest"],
    [/\blong rest\b/i, "long rest"],
    [/\bdurability system\b/i, "durability system"],
    // salt-lantern s1 (PF2e playtest): "staggered" is a 3.5e/PF1 condition, not a PF2e one.
    [/\bstaggered\b/i, "staggered (not a PF2e condition)"],
    // PF2e's Craft skill is called Crafting; "Craft check"/"Craft skill" is the dnd5e/PF1 spelling.
    [/\bcraft (check|skill)\b/i, "Craft check/skill (PF2e skill is Crafting)"],
    // PF2e conditions run "until the end of your next turn" or count down a value; a flat "for N
    // round(s)" duration on one is dnd5e/PF1 phrasing that slipped in (salt-lantern s1: "blinded for
    // 1 round").
    [/\b(blinded|deafened|dazzled|stunned|slowed|clumsy|enfeebled|stupefied|sickened|drained|frightened|fascinated|fatigued|confused|paralyzed|prone|grabbed|restrained)\s+for\s+\d+\s+rounds?\b/i, "a PF2e condition given a flat round-count duration instead of its own rules"]
  ]
};

export function findForbiddenSystemTerm(systemId, entry) {
  const rules = FORBIDDEN_SYSTEM_TERMS[systemId];
  if (!rules) return null;
  const text = [entry?.name, entry?.mechanics?.effect, entry?.mechanics?.trigger, entry?.mechanics?.duration, entry?.system_equivalent, entry?.system_chassis]
    .filter((v) => typeof v === "string")
    .join(" ");
  for (const [pattern, label] of rules) if (pattern.test(text)) return label;
  return null;
}

// Board 3962a001: a proposal that hands a character a feature or proficiency their own base class
// already grants by the system's core rules -- a Warlock 3 "gaining" Pact Magic and Eldritch Blast, a
// Rogue "gaining" proficiency in Sleight of Hand and Thieves' Tools -- because stage 2 only ever saw
// actor.systemClass as a bare string with no sense of what that class already comes with. Small and
// best-effort on purpose: a hand-picked table of each class's signature day-one features, not a
// substitute for the prompt telling the model to never restate the character's own class chassis.
const BASELINE_CLASS_FEATURES = {
  dnd5e: {
    warlock: ["pact magic", "eldritch blast", "eldritch invocations"],
    rogue: ["sneak attack", "thieves' tools", "thieves tools", "expertise", "sleight of hand"],
    wizard: ["arcane recovery", "spellbook", "ritual casting"],
    cleric: ["channel divinity", "turn undead", "divine domain"],
    fighter: ["action surge", "second wind", "extra attack"],
    barbarian: ["rage", "unarmored defense", "danger sense"],
    bard: ["bardic inspiration", "jack of all trades"],
    paladin: ["divine smite", "lay on hands", "divine sense"],
    ranger: ["favored enemy", "natural explorer", "fighting style"],
    monk: ["ki points", "martial arts", "unarmored movement"],
    druid: ["wild shape"],
    sorcerer: ["sorcery points", "metamagic"]
  },
  pf2e: {
    rogue: ["sneak attack", "surprise attack"],
    fighter: ["attack of opportunity"],
    wizard: ["arcane spellcasting", "spellbook", "arcane school"],
    cleric: ["divine font", "channel energy", "divine spellcasting"],
    barbarian: ["rage", "instinct"],
    druid: ["wild shape", "wild order", "primal spellcasting"],
    monk: ["flurry of blows"],
    ranger: ["hunt prey"],
    bard: ["composition spells", "occult spellcasting"],
    sorcerer: ["bloodline", "arcane spellcasting"],
    champion: ["champion's reaction", "divine spellcasting"]
  }
};

export function findDuplicateClassFeature(entry, { systemClass, systemId } = {}) {
  const table = BASELINE_CLASS_FEATURES[systemId];
  if (!table || typeof systemClass !== "string" || !systemClass.trim()) return null;
  const lowerClass = systemClass.toLowerCase();
  const classKey = Object.keys(table).find((cls) => lowerClass.includes(cls));
  if (!classKey) return null;
  const text = `${entry?.name ?? ""} ${entry?.mechanics?.effect ?? ""}`.toLowerCase();
  for (const feature of table[classKey]) if (text.includes(feature)) return feature;
  return null;
}

// Board 3962a001: the same check as findDuplicateClassFeature, but against the actor's OWN sheet
// (ai-gateway.js#buildAiGatewayRequest's ownedFeatures -- real class-feature items and proficient
// skills, when the system adapter can read them) instead of the small hand-picked baseline table.
// Requires a whole-word match on the full feature/skill name (>= 4 chars) to avoid a generic short
// name coincidentally appearing inside unrelated effect text.
//
// Only when the proposal's BENEFIT is that feature: it grants proficiency/training/expertise in it,
// gains or learns it outright, or is simply named after it. Merely USING it is fine. The old
// any-mention match skipped a real capstone that just rolled an Athletics check for a PC trained in
// Athletics (dev-integration real-model run, 2026-09-29), and the milestone fell back to a template.
export function findDuplicateOwnedFeatureText(entry, ownedFeatures) {
  if (!Array.isArray(ownedFeatures) || !ownedFeatures.length) return null;
  const effect = String(entry?.mechanics?.effect ?? "");
  const name = String(entry?.name ?? "");
  const concept = (name.includes(":") ? name.slice(name.indexOf(":") + 1) : name).trim().toLowerCase();
  for (const feature of ownedFeatures) {
    if (typeof feature !== "string") continue;
    const trimmed = feature.trim();
    if (trimmed.length < 4) continue;
    if (concept === trimmed.toLowerCase()) return trimmed;
    const f = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const grants = [
      // "gain proficiency in X", "become trained in X", "expertise with Athletics and X"
      new RegExp(`\\b(proficiency|proficient|trained|training|expert|expertise|mastery|master|legendary)\\b[^.;]{0,40}\\b${f}\\b`, "i"),
      // "X proficiency", "X expertise"
      new RegExp(`\\b${f}\\s+(proficiency|expertise|training)\\b`, "i"),
      // "you gain X", "learn the X feature", "gain access to X"
      new RegExp(`\\b(gain|gains|learn|learns|acquire|acquires|grant|grants|receive|receives)\\s+(the\\s+|access\\s+to\\s+(the\\s+)?)?${f}\\b`, "i")
    ];
    if (grants.some((pattern) => pattern.test(effect))) return trimmed;
  }
  return null;
}

// Board 3962a001 (salt-lantern s1, PF2e): the naming rule (prompts.js) is explicit that the motif is
// a coined word, "never the bare class name itself", yet the model still wrote "Monk: Aerial
// Momentum", "Ranger: Salt-Wind Shot", "Champion's Bulwark". Only matches the bare class name used AS
// the motif (name starts with it, followed by ":" or a possessive "'s") -- a coined motif that merely
// contains the class word elsewhere is untouched.
export function findBareClassMotif(name, systemClass) {
  if (typeof name !== "string" || !name.trim() || typeof systemClass !== "string" || !systemClass.trim()) return null;
  // dnd5e multiclass reads like "Fighter 3 / Wizard 2"; strip levels and split on "/".
  const classNames = systemClass.split("/").map((part) => part.replace(/\d+/g, "").trim()).filter(Boolean);
  const trimmedName = name.trim();
  for (const cls of classNames) {
    const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`^${escaped}\\s*(:|['’]s\\b)`, "i").test(trimmedName)) return cls;
  }
  return null;
}

// Wrong-system wording with an exact equivalent: [pattern, replacement, label]. PF2e "staggered"
// (lose actions) is closest to slowed 1; conditions end "until the end of your next turn".
const SYSTEM_TERM_REWRITES = {
  pf2e: [
    [/\bcraft (check|skill)\b/gi, "Crafting $1", "Crafting"],
    [/\bstaggered\b/gi, "slowed 1", "slowed 1"],
    [/\b(blinded|deafened|dazzled|stunned|slowed|clumsy|enfeebled|stupefied|sickened|drained|frightened|fascinated|fatigued|confused|paralyzed|prone|grabbed|restrained)(\s+\d)?\s+for\s+1\s+round\b/gi, "$1$2 until the end of your next turn", "condition-duration"]
  ]
};

/** "Monk: Aquatic Flow" -> "Tidewater: Aquatic Flow" style: a motif from the entry's theme or tag. */
export function recoinMotif(entry, className, theme) {
  const rest = String(entry?.name ?? "").replace(new RegExp(`^${className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(:|['’]s\\b)\\s*`, "i"), "").trim();
  const source = [theme, ...(entry?.metadata?.themes ?? []), ...(entry?.metadata?.tags ?? [])]
    .find((value) => typeof value === "string" && value.trim() && value.toLowerCase() !== className.toLowerCase());
  if (!rest || !source) return null;
  const motif = source.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase()).join("");
  return motif && motif.toLowerCase() !== rest.toLowerCase() ? `${motif}: ${rest}` : null;
}

// ---------------------------------------------------------------------------------------------
// Preprocessing
// ---------------------------------------------------------------------------------------------

/**
 * Normalize line endings, bullet glyphs and invisible characters so chunking sees clean structure.
 * Content words are never altered: the model (and `quote`) must see what the GM wrote.
 */
export function preprocessNotes(notes) {
  return String(notes ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[​-‍﻿­]/g, "")
    .replace(/ /g, " ")
    .replace(/^[ \t]*(?:[•◦▪▫‣⁃●○■□►▶➤➢✦✧★☆–—]|[*+])[ \t]+/gm, "- ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Split on paragraph boundaries, then lines (bullet lists), then sentences, then whitespace, so no
 * chunk exceeds maxChars and no action is cut in half when that is avoidable.
 */
export function chunkNotes(text, maxChars = 2400) {
  const clean = String(text ?? "");
  if (clean.length <= maxChars) return clean ? [clean] : [];
  const pieces = [];
  const pushSplit = (segment, level) => {
    if (segment.length <= maxChars) { pieces.push(segment); return; }
    const splitters = [/\n\s*\n/, /\n/, /(?<=[.!?。！？;])\s+/, /\s+/];
    if (level >= splitters.length) {
      for (let i = 0; i < segment.length; i += maxChars) pieces.push(segment.slice(i, i + maxChars));
      return;
    }
    const parts = segment.split(splitters[level]).filter((part) => part.trim());
    if (parts.length <= 1) { pushSplit(segment, level + 1); return; }
    for (const part of parts) pushSplit(part, level + 1);
  };
  pushSplit(clean, 0);
  // Greedy re-pack so we don't send forty one-line chunks.
  const chunks = [];
  let current = "";
  for (const piece of pieces) {
    const joiner = current ? "\n" : "";
    if (current && current.length + joiner.length + piece.length > maxChars) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current}${joiner}${piece}` : piece;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

// ---------------------------------------------------------------------------------------------
// Shape location
// ---------------------------------------------------------------------------------------------

const EVENT_ARRAY_KEYS = ["events", "growthEvents", "growth_events", "Events", "event", "items", "results", "data", "entries", "actions", "eventos", "evenements", "ereignisse", "eventi"];
const PROPOSAL_ARRAY_KEYS = ["proposals", "proposal", "Proposals", "suggestions", "skills", "newSkills", "items", "results", "data", "propuestas", "propostas"];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function looksLikeEvent(value) {
  return isPlainObject(value) && ["summary", "description", "quote", "tags", "outcome", "action"].some((key) => key in value);
}

function looksLikeProposal(value) {
  return isPlainObject(value) && (["entry", "skillEntry", "classEntry"].some((key) => key in value) || ("name" in value && ("mechanics" in value || "gameItem" in value)));
}

/** Find the events array in whatever top-level shape the model produced. */
export function locateEvents(value) {
  if (Array.isArray(value)) return { items: value, via: "top-level-array" };
  if (!isPlainObject(value)) return null;
  for (const key of EVENT_ARRAY_KEYS) {
    if (Array.isArray(value[key])) return { items: value[key], via: key === "events" ? "events" : `alias:${key}` };
    if (isPlainObject(value[key]) && Array.isArray(value[key].events)) return { items: value[key].events, via: `nested:${key}.events` };
  }
  if (looksLikeEvent(value)) return { items: [value], via: "single-event-object" };
  // Any array of event-looking objects under an unexpected key.
  for (const [key, v] of Object.entries(value)) {
    if (Array.isArray(v) && v.length && v.every(looksLikeEvent)) return { items: v, via: `alias:${key}` };
  }
  return null;
}

export function locateProposals(value) {
  if (Array.isArray(value)) return { items: value, via: "top-level-array" };
  if (!isPlainObject(value)) return null;
  for (const key of PROPOSAL_ARRAY_KEYS) {
    if (Array.isArray(value[key])) return { items: value[key], via: key === "proposals" ? "proposals" : `alias:${key}` };
    if (key === "proposal" && looksLikeProposal(value[key])) return { items: [value[key]], via: "alias:proposal" };
  }
  if (looksLikeProposal(value)) return { items: [value], via: "single-proposal-object" };
  for (const [key, v] of Object.entries(value)) {
    if (Array.isArray(v) && v.length && v.every(looksLikeProposal)) return { items: v, via: `alias:${key}` };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Evidence math (mirrors progression.js weighting; dangerGap does NOT affect evidence)
// ---------------------------------------------------------------------------------------------

export function weightedEvidence(events) {
  const tags = {};
  const themes = {};
  for (const event of events ?? []) {
    const weight = GROWTH_EVENT_OUTCOME_WEIGHTS[event?.outcome] ?? 0;
    for (const tag of event?.tags ?? []) tags[tag] = (tags[tag] ?? 0) + weight;
    for (const theme of event?.themes ?? []) themes[theme] = (themes[theme] ?? 0) + weight;
  }
  return { tags, themes };
}

function addEvidence(a = {}, b = {}) {
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) out[key] = (out[key] ?? 0) + (Number(value) || 0);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Proposal repair
// ---------------------------------------------------------------------------------------------

const KIND_SYNONYMS = [
  [/^(feat|ability|skill|talent|power|perk|feature|technique|trick|class feature|skill feat|general feat)$/, "feat"],
  [/^(bonus action|bonus|action|actions|activity|1 action|2 actions|3 actions|one action|two actions|three actions|single action|attack|strike|maneuver|manoeuvre|stance|special action)$/, "action"],
  [/^(reaction|reactions|opportunity|counter|interrupt)$/, "reaction"],
  [/^(free|free action|free-action|instant action)$/, "free"],
  [/^(passive|aura|trait|always on|permanent|static|constant|ongoing|buff|boon|blessing)$/, "passive"],
  [/^(spell|spells|cantrip|ritual|focus spell|magic|incantation|invocation|hex|prayer|miracle)$/, "spell"],
  [/^(weapon|weapons|attack item|melee weapon|ranged weapon|sword|bow|axe|dagger|spear|hammer)$/, "weapon"]
];

const FREQUENCY_SYNONYMS = [
  [/(unlimited|at will|at-will|always|constant|no limit|none|infinite|any time|anytime|passive)/, "unlimited"],
  [/(long rest|daily|a day|per day|\/ ?day|day|days|dawn|sunrise|night|rest|week|month)/, "day"],
  [/(short rest|hour|hr\b|hours)/, "hour"],
  [/(encounter|combat|fight|battle|scene|skirmish)/, "encounter"],
  [/(minute|min\b|minutes)/, "minute"],
  [/(round|turn|rounds|turns)/, "round"]
];

const SCHOOL_NAMES = {
  abjuration: "abj", conjuration: "con", divination: "div", enchantment: "enc", evocation: "evo", illusion: "ill",
  necromancy: "nec", transmutation: "trs", abj: "abj", con: "con", div: "div", enc: "enc", evo: "evo", ill: "ill", nec: "nec", trs: "trs"
};


const ACTIONABLE = new Set(["action", "reaction", "free", "spell", "weapon"]);

function coerceInt(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value === "string") {
    const words = { one: 1, two: 2, three: 3, once: 1, twice: 2, thrice: 3, i: 1, ii: 2, iii: 3 };
    const w = value.trim().toLowerCase();
    if (words[w] !== undefined) return words[w];
    const diamonds = (value.match(/◆|◇|\[a\]|\[#\]/gi) ?? []).length;
    if (diamonds) return diamonds;
    const match = /-?\d+/.exec(value);
    if (match) return Number(match[0]);
  }
  return undefined;
}

function coerceBool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(true|yes|y|1|primary|secondary)$/i.test(value.trim())) return true;
    if (/^(false|no|n|0|)$/i.test(value.trim())) return false;
  }
  if (typeof value === "number") return value !== 0;
  return undefined;
}

export function normalizeDiceFormula(value) {
  if (typeof value === "number" && Number.isFinite(value)) return `1d20+${Math.round(value)}`;
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, "").toLowerCase();
  if (/^[+-]\d+$/.test(text)) return `1d20${text}`;
  const dice = /(\d*)d(\d+)((?:[+-]\d+)*)/.exec(text);
  if (!dice) return undefined;
  const count = dice[1] || "1";
  // "1d20+5+2" is not a formula the validator accepts; fold the modifiers into one.
  const mod = (dice[3].match(/[+-]\d+/g) ?? []).reduce((sum, term) => sum + Number(term), 0);
  return mod ? `${count}d${dice[2]}${mod > 0 ? "+" : "-"}${Math.abs(mod)}` : `${count}d${dice[2]}`;
}

/** A plausible check modifier when the model gave none: trained + key stat for the actor's level. */
export function estimateModifier(systemId, level) {
  const lvl = Number.isInteger(level) && level > 0 ? level : 1;
  if (systemId === "dnd5e") return 3 + 2 + Math.floor((Math.min(lvl, 20) - 1) / 4);
  return Math.min(lvl, 20) + 2 + 3;
}

function inferItemKind(entry) {
  const m = entry.mechanics ?? {};
  const g = entry.gameItem ?? {};
  if (g.damage || g.damageType) return "weapon";
  if (g.rank !== undefined || g.tradition || g.school) return "spell";
  if (m.trigger) return "reaction";
  if (m.actions !== undefined && m.roll) return "action";
  if (m.roll) return "action";
  return "feat";
}

function coerceItemKind(raw) {
  if (typeof raw !== "string") return undefined;
  const p = raw.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (GRAND_DESIGN_ITEM_KINDS.has(p)) return p;
  for (const [pattern, kind] of KIND_SYNONYMS) if (pattern.test(p)) return kind;
  if (/reaction/.test(p)) return "reaction";
  if (/free/.test(p)) return "free";
  if (/spell|cantrip/.test(p)) return "spell";
  if (/passive|aura/.test(p)) return "passive";
  if (/action/.test(p)) return "action";
  if (/weapon/.test(p)) return "weapon";
  if (/feat|skill|ability/.test(p)) return "feat";
  return undefined;
}

export function coerceFrequency(raw) {
  let max;
  let per;
  if (isPlainObject(raw)) {
    max = coerceInt(raw.max ?? raw.uses ?? raw.count ?? raw.times);
    per = raw.per ?? raw.period ?? raw.every ?? raw.reset ?? raw.recharge;
  } else if (typeof raw === "string") {
    const text = raw.toLowerCase();
    max = coerceInt(/\d+/.exec(text)?.[0] ?? (/\btwice\b/.test(text) ? "twice" : /\bthrice\b/.test(text) ? "thrice" : /\bonce\b/.test(text) ? "once" : undefined));
    per = text;
  } else if (typeof raw === "number") {
    max = coerceInt(raw);
  }
  let perValue;
  if (typeof per === "string") {
    const p = per.trim().toLowerCase();
    perValue = FREQUENCY_PERIODS.has(p) ? p : FREQUENCY_SYNONYMS.find(([pattern]) => pattern.test(p))?.[1];
  }
  perValue ??= "day";
  if (!Number.isInteger(max) || max < 1) max = 1;
  return { max: Math.min(max, 99), per: perValue };
}

function titleCase(slug) {
  return String(slug).split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

/**
 * Pull a proposal out of any of the wrappers models use, returning { kind, entry, evidence, theme }.
 */
export function normalizeProposalShape(raw) {
  if (!isPlainObject(raw)) return null;
  let kind = typeof raw.kind === "string" ? raw.kind.trim().toLowerCase() : typeof raw.type === "string" ? raw.type.trim().toLowerCase() : undefined;
  let entry = [raw.entry, raw.skillEntry, raw.classEntry, raw.skill, raw.class, raw.proposal, raw.item, raw.details].find(isPlainObject);
  if (!kind || !["skill", "class"].includes(kind)) {
    if (isPlainObject(raw.classEntry) || isPlainObject(raw.class)) kind = "class";
    else if (/class|evolution/.test(kind ?? "")) kind = "class";
    else kind = undefined;
  }
  if (!entry && ("name" in raw) && ("mechanics" in raw || "gameItem" in raw || "effect" in raw)) {
    const { kind: maybeItemKind, evidence: _e, theme: _t, ...rest } = raw;
    entry = { ...rest };
    // A bare entry's `kind` is usually its gameItem kind ("feat"), not skill/class.
    if (typeof maybeItemKind === "string" && coerceItemKind(maybeItemKind) && !isPlainObject(entry.gameItem)) entry.gameItem = { kind: maybeItemKind };
  }
  if (!entry) return null;
  if (!kind) kind = ("level" in entry || "power_tier" in entry || "system_chassis" in entry || "is_primary" in entry) && !("tier" in entry) ? "class" : "skill";
  let evidence = raw.evidence;
  if (typeof evidence === "string") evidence = [evidence];
  if (!Array.isArray(evidence)) evidence = [];
  evidence = evidence.map((item) => (typeof item === "string" ? item : item?.summary ?? JSON.stringify(item))).filter(Boolean).slice(0, 12);
  const theme = typeof raw.theme === "string" && raw.theme.trim() ? slugifyTheme(raw.theme) : undefined;
  return { kind, entry: JSON.parse(JSON.stringify(entry)), evidence, ...(theme ? { theme } : {}) };
}

/**
 * Fill the obvious gaps a validator would reject, without inventing substance. What counts as
 * "obvious" is exactly what mechanics.js/validator.js require but a GM would never care about the
 * specific value of: a missing duration on a passive, a frequency written as "per long rest", an
 * action cost written as "2 actions", a tier of "II", a roll formula of "d20+5". Real content gaps
 * (no effect text, a reaction with no trigger) are left for the repair turn, where the model that
 * wrote the proposal can fill them in properly.
 * @returns {{ proposal, repairs: string[], skip?: string }}
 */
export function repairProposal(proposal, { systemId = "pf2e", actorLevel, grandDesignLevel, systemLabel, systemClass, customSynonyms = {}, allowRed = true } = {}) {
  const repairs = [];
  const kind = proposal.kind === "class" ? "class" : "skill";
  const entry = isPlainObject(proposal.entry) ? proposal.entry : {};
  const label = systemLabel ?? (systemId === "dnd5e" ? "D&D 5e" : "Pathfinder 2e");
  const note = (text) => repairs.push(text);

  if (typeof entry.name !== "string" || !entry.name.trim()) {
    const fallback = proposal.theme ? titleCase(proposal.theme) : typeof entry.title === "string" ? entry.title : "";
    if (fallback) { entry.name = fallback; note("name-from-theme"); }
  } else {
    entry.name = entry.name.trim().replace(/^\[|\]$/g, "");
  }

  // gameItem
  if (typeof entry.gameItem === "string") { entry.gameItem = { kind: entry.gameItem }; note("gameItem-from-string"); }
  if (!isPlainObject(entry.gameItem)) { entry.gameItem = {}; note("gameItem-created"); }
  const rawKind = entry.gameItem.kind ?? entry.gameItem.type ?? entry.itemKind ?? entry.actionType;
  const itemKind = coerceItemKind(rawKind) ?? inferItemKind(entry);
  if (entry.gameItem.kind !== itemKind) { note(`gameItem.kind:${JSON.stringify(rawKind)}->${itemKind}`); entry.gameItem.kind = itemKind; }

  // mechanics
  if (!isPlainObject(entry.mechanics)) {
    entry.mechanics = {};
    note("mechanics-created");
  }
  const m = entry.mechanics;
  if (typeof m.effect !== "string" || !m.effect.trim()) {
    const effect = [entry.effect, entry.description, entry.benefit, m.description, m.benefit].find((v) => typeof v === "string" && v.trim());
    if (effect) { m.effect = effect.trim(); note("effect-from-description"); }
  }
  const frequency = coerceFrequency(m.frequency ?? entry.frequency ?? m.uses);
  if (!isPlainObject(m.frequency) || m.frequency.max !== frequency.max || m.frequency.per !== frequency.per) {
    note(`frequency:${JSON.stringify(m.frequency ?? null)}->${frequency.max}/${frequency.per}`);
  }
  m.frequency = frequency;
  if (!ACTIONABLE.has(itemKind) && (typeof m.duration !== "string" || !m.duration.trim())) {
    m.duration = itemKind === "passive" ? "while active" : "instant";
    note(`duration-defaulted:${m.duration}`);
  } else if (m.duration !== undefined && typeof m.duration !== "string") {
    m.duration = String(m.duration);
    note("duration-stringified");
  }
  if (typeof m.trigger !== "string" && typeof entry.trigger === "string") { m.trigger = entry.trigger; note("trigger-moved"); }
  // Batch 3 (board 5a0cea2e): the numbers a system adapter builds real item data from. A field with
  // a bad shape is dropped (and named here), never guessed: the prose effect still says what the
  // ability does, and the GM can add the missing number in the Edit form.
  if (m.structured !== undefined || entry.structured !== undefined) {
    const { structured, dropped, coercions } = coerceStructuredMechanics(m.structured ?? entry.structured, { systemId });
    delete entry.structured;
    for (const c of coercions) note(`structured.${c}`);
    for (const d of dropped) note(`structured-dropped:${d}`);
    if (structured) m.structured = structured;
    else delete m.structured;
  }
  if (typeof m.effect === "string" && m.effect.trim()) {
    const { structured, filled } = fillStructuredFromEffect(m.effect, m.structured ?? null, { systemId });
    if (filled.length) { m.structured = structured; note(`structured-from-effect:${filled.join(",")}`); }
  }

  const level = kind === "class" ? coerceInt(entry.level) : undefined;
  const modifier = estimateModifier(systemId, actorLevel);
  if (ACTIONABLE.has(itemKind)) {
    if (typeof m.roll === "string" || typeof m.roll === "number") { m.roll = { formula: m.roll }; note("roll-from-scalar"); }
    if (!isPlainObject(m.roll)) { m.roll = {}; note("roll-created"); }
    const formula = normalizeDiceFormula(m.roll.formula ?? m.roll.dice ?? m.roll.roll);
    const finalFormula = formula && /^\d+d\d+/.test(formula) ? (formula === "1d20" ? `1d20+${modifier}` : formula) : `1d20+${modifier}`;
    if (m.roll.formula !== finalFormula) { note(`roll.formula:${JSON.stringify(m.roll.formula ?? null)}->${finalFormula}`); m.roll.formula = finalFormula; }
    if (typeof m.roll.kind !== "string" || !m.roll.kind.trim()) {
      const firstTag = (entry.metadata?.tags ?? []).find((tag) => typeof tag === "string");
      m.roll.kind = itemKind === "spell" ? "Spell attack" : itemKind === "weapon" ? "Attack roll" : firstTag ? `${titleCase(slugifyTheme(firstTag))} check` : "Skill check";
      note(`roll.kind-defaulted:${m.roll.kind}`);
    }
    if (m.roll.dc !== undefined && !Number.isInteger(m.roll.dc)) {
      const dc = coerceInt(m.roll.dc);
      if (dc) m.roll.dc = dc; else delete m.roll.dc;
      note("roll.dc-coerced");
    }
  }
  if (itemKind === "action" || m.actions !== undefined) {
    const actions = coerceInt(m.actions ?? entry.actions ?? entry.actionCost);
    const clamped = Math.min(3, Math.max(1, Number.isInteger(actions) ? actions : 1));
    if (m.actions !== clamped && itemKind === "action") { note(`actions:${JSON.stringify(m.actions ?? null)}->${clamped}`); m.actions = clamped; }
    else if (itemKind !== "action" && m.actions !== undefined && !Number.isInteger(m.actions)) m.actions = clamped;
  }
  if (itemKind === "spell") {
    const g = entry.gameItem;
    let rank = coerceInt(g.rank ?? g.level ?? entry.rank);
    if (!Number.isInteger(rank)) rank = /cantrip/i.test(String(rawKind ?? "")) ? 0 : Math.min(3, Math.max(1, coerceInt(entry.tier) ?? 1));
    rank = Math.min(10, Math.max(0, rank));
    if (g.rank !== rank) { note(`gameItem.rank->${rank}`); g.rank = rank; }
    if (typeof g.tradition !== "string" || !g.tradition.trim()) {
      const tags = entry.metadata?.tags ?? [];
      g.tradition = ["arcane", "divine", "occult", "primal"].find((t) => tags.includes(t)) ?? "arcane";
      note(`gameItem.tradition-defaulted:${g.tradition}`);
    }
    if (!SPELL_SCHOOLS.has(g.school)) {
      const byName = SCHOOL_NAMES[String(g.school ?? "").toLowerCase().trim()];
      const tags = entry.metadata?.tags ?? [];
      const inferred = byName ?? (tags.includes("summoning") ? "con" : tags.includes("medicine") || tags.includes("defense") ? "abj" : tags.includes("lore") ? "div" : tags.includes("diplomacy") || tags.includes("occult") ? "enc" : "evo");
      note(`gameItem.school:${JSON.stringify(g.school ?? null)}->${inferred}`);
      g.school = inferred;
    }
  }
  if (itemKind === "weapon") {
    const g = entry.gameItem;
    const damage = normalizeDiceFormula(g.damage);
    const finalDamage = damage ?? "1d6";
    if (g.damage !== finalDamage) { note(`gameItem.damage:${JSON.stringify(g.damage ?? null)}->${finalDamage}`); g.damage = finalDamage; }
    if (typeof g.damageType !== "string" || !g.damageType.trim()) {
      const tags = entry.metadata?.tags ?? [];
      g.damageType = ["fire", "cold", "electricity"].find((t) => tags.includes(t)) ?? (tags.includes("ranged") ? "piercing" : "slashing");
      note(`gameItem.damageType-defaulted:${g.damageType}`);
    }
  }

  // kind-specific top-level fields
  if (kind === "skill") {
    let tier = coerceInt(entry.tier);
    if (!Number.isInteger(tier)) tier = 1;
    const clamped = Math.min(3, Math.max(1, tier));
    if (entry.tier !== clamped) { note(`tier:${JSON.stringify(entry.tier ?? null)}->${clamped}`); entry.tier = clamped; }
    if (typeof entry.system_equivalent !== "string" || !entry.system_equivalent.trim()) {
      entry.system_equivalent = `${label} ${itemKind} (GM review)`;
      note("system_equivalent-defaulted");
    }
  } else {
    const fallbackLevel = Number.isInteger(grandDesignLevel) && grandDesignLevel > 0 ? grandDesignLevel : Number.isInteger(actorLevel) && actorLevel > 0 ? actorLevel : 1;
    const finalLevel = Number.isInteger(level) && level >= 1 ? level : fallbackLevel;
    if (entry.level !== finalLevel) { note(`level->${finalLevel}`); entry.level = finalLevel; }
    const tier = String(entry.power_tier ?? "").toLowerCase().trim();
    const mapped = POWER_TIERS.has(tier) ? tier : /legend|epic|myth|prestig/.test(tier) ? "prestige" : /elev|advanc|high|rare|greater/.test(tier) ? "elevated" : "standard";
    if (entry.power_tier !== mapped) { note(`power_tier:${JSON.stringify(entry.power_tier ?? null)}->${mapped}`); entry.power_tier = mapped; }
    const primary = coerceBool(entry.is_primary) ?? false;
    let secondary = coerceBool(entry.is_secondary) ?? false;
    if (primary && secondary) { secondary = false; note("is_secondary-cleared-both-set"); }
    if (entry.is_primary !== primary) note("is_primary-coerced");
    if (entry.is_secondary !== secondary) note("is_secondary-coerced");
    entry.is_primary = primary;
    entry.is_secondary = secondary;
    if (typeof entry.system_chassis !== "string" || !entry.system_chassis.trim()) {
      entry.system_chassis = `${label} class archetype (GM review)`;
      note("system_chassis-defaulted");
    }
  }

  // metadata: canonical tags only; everything else becomes a theme rather than an error.
  if (!isPlainObject(entry.metadata)) { entry.metadata = {}; note("metadata-created"); }
  const md = entry.metadata;
  const tags = [];
  const themes = [];
  const rawTags = Array.isArray(md.tags) ? md.tags : typeof md.tags === "string" ? md.tags.split(/[,;|/]/) : [];
  for (const rawTag of rawTags) {
    const resolved = resolveTag(rawTag, { customSynonyms });
    if (resolved?.tag) {
      if (!tags.includes(resolved.tag)) tags.push(resolved.tag);
      if (resolved.via !== "exact") note(`metadata.tag:${rawTag}->${resolved.tag}`);
      if (resolved.alsoTheme && !themes.includes(resolved.alsoTheme)) themes.push(resolved.alsoTheme);
    } else if (resolved?.theme) {
      if (!themes.includes(resolved.theme)) themes.push(resolved.theme);
      note(`metadata.tag:${rawTag}->theme:${resolved.theme}`);
    }
  }
  const rawThemes = Array.isArray(md.themes) ? md.themes : typeof md.themes === "string" ? [md.themes] : [];
  for (const theme of [...rawThemes, proposal.theme]) {
    const slug = slugifyTheme(theme);
    if (!slug) continue;
    if (CANONICAL_SET.has(slug)) { if (!tags.includes(slug)) tags.push(slug); continue; }
    if (!themes.includes(slug)) themes.push(slug);
  }
  md.tags = tags;
  if (themes.length) md.themes = themes; else delete md.themes;

  if (md.polarity !== undefined) {
    const polarity = String(md.polarity).toLowerCase().trim();
    if (polarity === "red" || polarity === "standard") md.polarity = polarity;
    else { delete md.polarity; note("polarity-removed-invalid"); }
  }
  if (md.polarity === "standard" && md.malignance !== undefined) { delete md.malignance; note("malignance-removed-standard"); }
  if (md.polarity === "red") {
    if (!allowRed) return { proposal: { ...proposal, kind, entry }, repairs, skip: "red-entries-disabled" };
    if (isPlainObject(md.malignance) && typeof md.malignance.vice === "string" && !VICE_TAGS.has(md.malignance.vice)) {
      const v = md.malignance.vice.toLowerCase().trim();
      const mapped = VICE_TAGS.has(v) ? v : VICE_SYNONYMS[v];
      if (mapped) { md.malignance.vice = mapped; note(`malignance.vice->${mapped}`); }
    }
  }
  if (md.lineage !== undefined && !isPlainObject(md.lineage)) { md.lineage = {}; note("lineage-reset"); }
  if (isPlainObject(md.lineage)) {
    if (md.lineage.operation !== undefined && !LINEAGE_OPERATIONS.has(md.lineage.operation)) { md.lineage.operation = "origin"; note("lineage.operation->origin"); }
    if (md.lineage.sources !== undefined && !Array.isArray(md.lineage.sources)) { md.lineage.sources = []; note("lineage.sources-reset"); }
    if (Array.isArray(md.lineage.sources)) md.lineage.sources = md.lineage.sources.filter((s) => typeof s === "string" && s.trim());
  } else {
    md.lineage = { operation: "origin", sources: [], rationale: "Emerged from session-note evidence." };
  }

  const evidence = Array.isArray(proposal.evidence) && proposal.evidence.length ? proposal.evidence : ["Session note analysis"];
  const shaped = { kind, entry, evidence, ...(proposal.theme ? { theme: proposal.theme } : {}) };

  // Board 3962a001: a term from the OTHER system's action economy/rest vocabulary (or an invented
  // subsystem like "durability system") means the proposal was not actually written for this table's
  // rules and is rejected outright rather than patched -- unlike the gap-filling above, there is no
  // safe default term to substitute.
  // Some wrong terms DO have an exact equivalent in this system; those are rewritten, not rejected
  // (salt-lantern s1/s2: skipping them left a GM's "Suggest proposals" with nothing to choose from).
  for (const [pattern, replacement, label] of SYSTEM_TERM_REWRITES[systemId] ?? []) {
    for (const field of ["effect", "trigger", "duration"]) {
      const value = entry.mechanics?.[field];
      if (typeof value === "string" && pattern.test(value)) {
        entry.mechanics[field] = value.replace(pattern, replacement);
        note(`term->${label}`);
      }
    }
  }
  const forbiddenTerm = findForbiddenSystemTerm(systemId, entry);
  if (forbiddenTerm) return { proposal: shaped, repairs, skip: `wrong-system-terms:${forbiddenTerm}` };

  // Board 3962a001 (salt-lantern s1): the naming rule says never to use the bare class name as the
  // motif, yet "Monk: Aerial Momentum", "Champion's Bulwark" keep coming. Skipping them emptied a whole
  // Suggest for Buck (3 of 3 "Monk:"), so the motif is re-coined from the entry's own theme instead;
  // only a proposal with nothing to coin from is skipped.
  const bareMotif = findBareClassMotif(entry.name, systemClass);
  if (bareMotif) {
    const renamed = recoinMotif(entry, bareMotif, proposal.theme);
    if (!renamed) return { proposal: shaped, repairs, skip: `generic-class-motif:${bareMotif}` };
    entry.name = renamed;
    note(`motif-recoined:${bareMotif}`);
  }

  return { proposal: shaped, repairs };
}

// ---------------------------------------------------------------------------------------------
// Extraction cache
// ---------------------------------------------------------------------------------------------

// Why: a GM pastes ONE party recap into every character's sheet (and the playtest runner does the
// same), and stage 1 used to re-read the identical notes per character -- 20-36 s each, over two
// minutes for a party of five on ember-road s1. Extraction does not depend on which character is
// being analysed (prompts.js no longer names them), so it runs once and only stage 2, which IS per
// character, runs again. Bounded (LRU + TTL) because notes are large and a long session produces
// many; in-memory only, because a stale reading must never outlive a reload.

/**
 * @param {{maxEntries?:number, ttlMs?:number, now?:() => number}} [opts]
 * @returns {{ run(key:string, produce:() => Promise<object>): Promise<{value:object, hit:boolean}>, delete(key:string):void, clear():void, readonly size:number }}
 */
export function createExtractionCache({ maxEntries = 20, ttlMs = 30 * 60 * 1000, now = () => Date.now() } = {}) {
  const entries = new Map(); // key -> { promise, expires }
  const evict = () => {
    const t = now();
    for (const [key, entry] of entries) if (entry.expires <= t) entries.delete(key);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  };
  return {
    // Concurrent callers with the same key share ONE in-flight extraction (two sheets analysed at
    // once must not both pay for it). A failed or uncacheable extraction is dropped so the next
    // caller retries instead of inheriting the failure.
    async run(key, produce) {
      evict();
      const existing = entries.get(key);
      if (existing) {
        entries.delete(key);
        entries.set(key, existing); // refresh LRU position
        return { value: structuredClone(await existing.promise), hit: true };
      }
      const promise = Promise.resolve().then(produce);
      entries.set(key, { promise, expires: now() + ttlMs });
      evict();
      let value;
      try {
        value = await promise;
      } catch (error) {
        if (entries.get(key)?.promise === promise) entries.delete(key);
        throw error;
      }
      if (value?.cacheable === false && entries.get(key)?.promise === promise) entries.delete(key);
      return { value: structuredClone(value), hit: false };
    },
    delete(key) { entries.delete(key); },
    clear() { entries.clear(); },
    get size() { evict(); return entries.size; }
  };
}

/**
 * Everything the stage-1 result depends on, and nothing it does not (the actor, proposalMode,
 * creativity, maxProposals, namingStyle and allowRed only shape stage 2). The system id is included
 * although the extraction prompt is system-neutral today, so a future system-specific hint can never
 * serve one system's reading to the other.
 */
export function extractionCacheKey({ notes, systemId, cfg, transportInfo = {} }) {
  return JSON.stringify([
    "extract-v1",
    systemId ?? "",
    transportInfo.provider ?? cfg.provider,
    transportInfo.endpoint ?? cfg.endpoint,
    transportInfo.model ?? cfg.model,
    cfg.pipeline,
    cfg.chunkChars,
    cfg.temperature,
    cfg.numCtx,
    cfg.numPredict,
    cfg.maxRepairAttempts,
    cfg.outputLanguage,
    cfg.houseRules,
    cfg.toneHints,
    cfg.extractionExamples,
    cfg.customSynonyms,
    cfg.emergentThemes,
    cfg.mergeFollowUps,
    // Jev triage decides which chunks stage 1 reads at all, so a triaged reading is never served to
    // a run without Jev (or with another threshold), and vice versa.
    cfg.jev?.enabled && cfg.jev.triage ? [cfg.jev.endpoint, cfg.jev.model, cfg.jev.triageThreshold] : null,
    preprocessNotes(notes)
  ]);
}

// ---------------------------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------------------------

function nowMs() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

// Errors where retrying other chunks is pointless: the provider is down, the model doesn't exist,
// the key is wrong. Everything else is a per-chunk failure.
function isTransientTransportError(error) {
  return error instanceof AiProviderUnreachableError || error instanceof AiProviderTimeoutError;
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isFatalTransportError(error) {
  if (error instanceof AiProviderUnreachableError) return true;
  if (error instanceof AiProviderHttpError && [400, 401, 403, 404, 405, 413, 422].includes(error.status)) return true;
  return false;
}

function assistantEcho(content) {
  const text = String(content ?? "");
  return { role: "assistant", content: text.length > 8000 ? `${text.slice(0, 8000)}…` : text };
}

function summarizeRejections(rejected) {
  const counts = {};
  for (const item of rejected) counts[item.reason] = (counts[item.reason] ?? 0) + 1;
  return Object.entries(counts).map(([reason, count]) => {
    const hint = {
      "missing-summary": "every event needs a non-empty summary",
      "no-tags-or-themes": "every event needs at least one ALLOWED TAG or one theme slug",
      "not-an-object": "every item in events must be an object",
      "marked-not-an-event": "only include things that actually happened"
    }[reason] ?? reason;
    return `${count} event(s) rejected: ${hint}.`;
  });
}

/**
 * @param {object} args
 * @param {{chat:Function}} args.transport
 * @param {object} args.request buildAiGatewayRequest(...) output
 * @param {object} args.config gateway config (normalized here)
 * @param {{validateSkillEntry?:Function, validateClassEntry?:Function}} [args.validators]
 * @param {string} [args.systemId]
 * @param {ReturnType<typeof createExtractionCache>} [args.extractionCache] share stage 1 across calls
 * @param {boolean} [args.refreshExtraction] ignore (and replace) a cached stage-1 reading
 * @param {object[]} [args.presetEvents] already-recorded events: skip stage 1 and propose from these
 * @param {{kind:"capstone"|"class-evolution", level:number}} [args.milestone] a guaranteed Grand
 *   Design milestone reward (api.js#resolveLevelRest): stage 2 is told to return exactly the one
 *   kind of proposal this milestone grants, instead of its usual open-ended suggestion behavior.
 * @param {{kind:"skill"|"class", theme?:string, label?:string, tier?:number, isCapstone?:boolean, placeholder?:{name:string,effect?:string}}} [args.target]
 *   "Author with AI" (api.js#requestProposalAuthoring): stage 2 only, always runs, must return exactly
 *   one proposal of target.kind about target.theme/label (tier fixed for a capstone).
 * @param {object|null} [args.jev] a client from jev.js#createJevClient; used only when config.jev.enabled
 * @returns {Promise<{events, proposals, themes, skippedEvents, skippedProposals, diagnostics}>}
 */
export async function runGatewayPipeline({ transport, request, config = {}, validators = {}, systemId, sleep, extractionCache = null, refreshExtraction = false, presetEvents = null, milestone = null, target = null, jev = null } = {}) {
  const started = nowMs();
  const baseCfg = normalizeGatewayConfig(config);
  // An authoring request writes exactly one proposal whatever the table's maxProposals says.
  const cfg = target ? { ...baseCfg, maxProposals: 1 } : baseCfg;
  const sysId = systemId ?? cfg.systemId ?? request?.actor?.system ?? "pf2e";
  const validate = {
    skill: validators.validateSkillEntry ?? defaultValidateSkill,
    class: validators.validateClassEntry ?? defaultValidateClass,
    title: validators.validateTitleEntry ?? defaultValidateTitle
  };
  const diagnostics = {
    model: transport?.info?.model ?? cfg.model,
    provider: transport?.info?.provider ?? cfg.provider,
    pipeline: cfg.pipeline,
    chunks: 0,
    stages: [],
    coercions: [],
    warnings: [...(transport?.info?.endpointNotes ?? [])],
    proposalStage: { ran: false, reason: "" },
    totalMs: 0
  };
  const notes = preprocessNotes(request?.notes);
  const chunks = chunkNotes(notes, cfg.chunkChars);
  diagnostics.chunks = chunks.length;
  const ctx = { transport, request, cfg, diagnostics, validate, sysId };
  const sleepFn = typeof sleep === "function" ? sleep : typeof transport?.sleep === "function" ? transport.sleep : realSleep;
  // Jev is strictly additive: with it off (no key, disabled, no client) jevRun is null and not one
  // line below behaves differently, down to the diagnostics object's keys.
  const jevRun = startJevRun(cfg, jev);
  if (jevRun) {
    diagnostics.jev = jevRun.diag;
    ctx.jevRun = jevRun;
  }

  const skippedEvents = [];
  const skippedProposals = [];
  let events = [];
  const proposalBatches = [];

  if (!chunks.length && !Array.isArray(presetEvents)) {
    diagnostics.totalMs = Math.round(nowMs() - started);
    return { events: [], proposals: [], themes: [], skippedEvents, skippedProposals, diagnostics };
  }

  // ---- extraction (or single combined call) per chunk ----
  if (Array.isArray(presetEvents)) {
    // "Suggest proposals": the events are already recorded and validated. Re-reading them as notes
    // made stage 1 treat the "GM REQUEST" wrapper as out-of-character and return no events at all
    // (ember-road s2 prep, 2026-09-27), so stage 2 proposed nothing.
    events = presetEvents.filter((event) => event && typeof event.summary === "string" && event.summary.trim()).map((event) => ({ ...event }));
    diagnostics.extractionCache = "preset";
  } else if (cfg.pipeline === "single") {
    // One combined call per chunk also writes this actor's proposals, so it can never be shared.
    const extracted = await extractAllChunks(chunks, ctx, sleepFn);
    events = extracted.events;
    skippedEvents.push(...extracted.skippedEvents);
    proposalBatches.push(...extracted.proposalBatches);
    diagnostics.extractionCache = "off";
  } else {
    // Stage 1 runs in its own diagnostics scope so a cache hit can replay exactly what the original
    // reading recorded (stages, coercions, warnings), marked as cached.
    const produce = async () => {
      const scope = { stages: [], coercions: [], warnings: [] };
      const extracted = await extractAllChunks(chunks, { ...ctx, diagnostics: scope }, sleepFn);
      return { ...extracted, proposalBatches: [], diagnostics: scope, cacheable: extracted.chunkFailures === 0 };
    };
    let extracted;
    if (extractionCache) {
      const key = extractionCacheKey({ notes, systemId: sysId, cfg, transportInfo: transport?.info });
      // "Re-analyze" means read it again: drop the old reading, and store the new one for the rest
      // of the party.
      if (refreshExtraction) extractionCache.delete(key);
      const { value, hit } = await extractionCache.run(key, produce);
      extracted = value;
      diagnostics.extractionCache = hit ? "hit" : "miss";
    } else {
      extracted = await produce();
      diagnostics.extractionCache = "off";
    }
    const hit = diagnostics.extractionCache === "hit";
    diagnostics.stages.push(...extracted.diagnostics.stages.map((stage) => (hit ? { ...stage, cached: true } : stage)));
    diagnostics.coercions.push(...extracted.diagnostics.coercions);
    diagnostics.warnings.push(...extracted.diagnostics.warnings);
    events = extracted.events;
    skippedEvents.push(...extracted.skippedEvents);
    // Triage ran inside the producer (it decides what stage 1 reads); replay its skips on a hit.
    if (jevRun && Array.isArray(extracted.diagnostics.jevSkippedChunks)) {
      jevRun.diag.skippedChunks = extracted.diagnostics.jevSkippedChunks;
      if (hit) jevRun.diag.ran.push("triage:cached");
    }
  }

  // Attribution and verification are SECOND OPINIONS on the LLM's actorName / outcome / darkDeed.
  // They run before stage 2 (which sees the corrected doer and the dark-act flag), on copies: the
  // cache hands out clones already, but the preset path holds the caller's own recorded objects --
  // and those are already recorded, so they get no second opinion at all, only ranking.
  if (jevRun && !Array.isArray(presetEvents)) {
    events = events.map((event) => ({ ...event, tags: [...(event.tags ?? [])], themes: [...(event.themes ?? [])] }));
    await jevAnnotateEvents(jevRun, events, { request, notes, cfg });
  }
  let rankEvents = events;

  // ---- proposals ----
  let proposals = [];
  if (cfg.pipeline === "single" && !Array.isArray(presetEvents)) {
    diagnostics.proposalStage = { ran: true, reason: "single-pipeline" };
    const valid = [];
    for (const batch of proposalBatches) {
      const checked = await validateProposals(batch.items, batch.conversation, ctx);
      valid.push(...checked.accepted);
      skippedProposals.push(...checked.skipped);
    }
    const gated = gateProposals(valid, ctx);
    proposals = gated.final;
    skippedProposals.push(...gated.skipped);
  } else {
    // Stage 2 is per character: it sees only the events credited to THIS character (or the party, or
    // unnamed). Fed the whole party recap, Luz's proposal stage red-flagged Tovin's kill (ember-road
    // s1 re-run) -- one step from proposing Luz a red Skill for someone else's deed. The returned
    // events stay whole; api.js attributes them per character with the same rule.
    const ownEvents = request?.actor?.name ? attributeEventsToActor(events, [request.actor.name], { notes: String(request.notes ?? notes) }).kept : events;
    if (ownEvents.length !== events.length) diagnostics.proposalEvents = { own: ownEvents.length, total: events.length };
    rankEvents = ownEvents;
    const decision = target
      ? { ...shouldPropose(ownEvents, request, { ...cfg, proposalMode: "always" }), run: true, reason: "authoring-target", allowClass: target.kind === "class" }
      : shouldPropose(ownEvents, request, cfg);
    diagnostics.proposalStage = { ran: decision.run, reason: decision.reason };
    if (decision.run) {
      try {
        const result = await proposeStage(ownEvents, decision, ctx, milestone, target);
        proposals = result.accepted;
        skippedProposals.push(...result.skipped);
      } catch (error) {
        // With preset events (Suggest proposals, a milestone reward, Author with AI) stage 2 is the
        // WHOLE job and there are no newly read events to protect: swallowing a dead provider here
        // returned an empty result, so api.js's fallback said "did not return a usable proposal"
        // instead of naming the provider failure (dev-integration real-model run, 2026-09-29).
        if (Array.isArray(presetEvents)) throw error;
        // Never lose good events because the optional proposal stage failed.
        if (error instanceof AiProviderUnreachableError || error instanceof AiProviderTimeoutError) diagnostics.warnings.push(`proposal stage failed: ${error.message}`);
        skippedProposals.push({ reason: "proposal-stage-failed", error: error.message });
      }
    }
  }
  // An authoring target returns exactly one proposal: nothing to order, so no rank call.
  if (jevRun && !target) proposals = await jevRank(jevRun, proposals, rankEvents, request);

  const themes = summarizeThemes(events);
  diagnostics.coercions = diagnostics.coercions.slice(0, 300);
  diagnostics.totalMs = Math.round(nowMs() - started);
  if (transport?.compat) diagnostics.transportCompat = transport.compat;
  return {
    events: events.map((event) => ({ ...event, source: "adapter" })),
    proposals,
    themes,
    skippedEvents,
    skippedProposals,
    diagnostics
  };
}

/**
 * Stage 2 alone for one character over already-extracted events (docs/jev-layer-contract.md,
 * party mode). A thin wrapper over main's `presetEvents` path, so it IS the same gating, repair,
 * validation and Jev ranking as "Suggest proposals" -- and like that path it re-throws a provider
 * failure (there are no freshly read events to protect). Always two-stage: `diagnostics.pipeline`
 * is "two-stage" whatever the config says, because "single" combines stage 1 and 2 in one call and
 * has no stage-2-only form.
 * @returns {Promise<{ proposals, skippedProposals, diagnostics }>}
 */
export async function runProposalStageFor({ transport, request, events, config = {}, validators = {}, systemId, jev = null } = {}) {
  const result = await runGatewayPipeline({
    transport,
    request: { ...request, notes: "" },
    config: { ...normalizeGatewayConfig(config), pipeline: "two-stage" },
    validators,
    systemId,
    jev,
    presetEvents: Array.isArray(events) ? events : []
  });
  return { proposals: result.proposals, skippedProposals: result.skippedProposals, diagnostics: result.diagnostics };
}

// ---------------------------------------------------------------------------------------------
// Jev steps (docs/jev-layer-contract.md). Every one is fail-open: an error is recorded in
// diagnostics.jev.errors and the pipeline carries on exactly as if Jev were off. A Jev failure never
// throws out of here, so it can never send the GM to the local analyzer.
// ---------------------------------------------------------------------------------------------

// Attribution replaces the LLM's actorName only at or above this confidence (contract, fixed).
const JEV_ATTRIBUTION_CONFIDENCE = 0.6;

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

function startJevRun(cfg, jev) {
  if (!cfg.jev?.enabled || !jev || typeof jev.ask !== "function") return null;
  // routed = events whose actorName Jev set or confidently confirmed.
  const diag = { enabled: true, model: jev.info?.model ?? cfg.jev.model, ran: [], calls: 0, ms: 0, skippedChunks: [], routed: 0, overrides: [], flags: [], errors: [] };
  const run = { cfg: cfg.jev, diag, dead: null };
  // Counting wrapper: every request is one call; after a fatal error (401/403, a bad key) nothing
  // more is sent this run.
  const client = {
    info: jev.info,
    async ask(args) {
      if (run.dead) throw run.dead;
      diag.calls += 1;
      const t = nowMs();
      try {
        return await jev.ask(args);
      } finally {
        diag.ms += Math.round(nowMs() - t);
      }
    }
  };
  run.step = async (name, fn) => {
    if (run.dead) return null;
    try {
      const result = await fn(client);
      diag.ran.push(name);
      return result;
    } catch (error) {
      diag.errors.push({
        step: name,
        kind: error?.kind ?? "error",
        ...(error?.status ? { status: error.status } : {}),
        ...(error?.fatal ? { fatal: true } : {}),
        message: String(error?.message ?? error).slice(0, 300)
      });
      if (error?.fatal) run.dead = error;
      return null;
    }
  };
  return run;
}

// Returns the jobs to extract. Skips are recorded on `diagnostics` (the producer's scope, so a cache
// hit replays them) and on the run.
async function jevTriage(run, chunks, jobs, diagnostics) {
  const result = await run.step("triage", (client) => triageChunks(client, chunks, { threshold: run.cfg.triageThreshold }));
  if (!result || !Array.isArray(result.keep)) return jobs;
  const kept = jobs.filter((job) => result.keep[job.index] !== false);
  // "Nothing in any chunk is a character action" is far more likely a Jev miss than a real answer,
  // and acting on it would return zero events for notes the GM just typed -- so it is ignored.
  if (!kept.length) {
    diagnostics.warnings.push("jev triage would have skipped every chunk; all chunks were extracted anyway");
    return jobs;
  }
  const skipped = jobs
    .filter((job) => result.keep[job.index] === false)
    .map((job) => ({ chunk: job.index, p: round2(result.p?.[job.index]), text: job.text.slice(0, 160) }));
  run.diag.skippedChunks = skipped;
  diagnostics.jevSkippedChunks = skipped;
  return kept;
}

function jevInfo(event) {
  if (!isPlainObject(event.jev)) event.jev = { flags: [] };
  if (!Array.isArray(event.jev.flags)) event.jev.flags = [];
  return event.jev;
}

function addJevFlag(run, event, index, flag) {
  const info = jevInfo(event);
  if (!info.flags.includes(flag)) info.flags.push(flag);
  run.diag.flags.push({ event: index, flag });
}

const GROUP_NAME = /^(the party|the group|everyone|we|us)$/i;

// Who could have done things in these notes: an explicit `request.party`, else the speaker labels
// of the notes plus every doer the LLM named and the analysed character. Attribution is only asked
// when at least two candidates exist (with one name there is no one to confuse).
function jevRoster(request, events, notes) {
  const explicit = (Array.isArray(request?.party) ? request.party : [])
    .map((entry) => (typeof entry === "string" ? { name: entry.trim() } : isPlainObject(entry) && typeof entry.name === "string" ? { name: entry.name.trim(), aliases: Array.isArray(entry.aliases) ? entry.aliases : [] } : null))
    .filter((entry) => entry?.name);
  if (explicit.length >= 2) return explicit;
  const names = [];
  const add = (name) => {
    const clean = typeof name === "string" ? name.trim() : "";
    if (!clean || GROUP_NAME.test(clean) || names.some((known) => sameName(known, clean))) return;
    names.push(clean);
  };
  add(request?.actor?.name);
  for (const line of noteLines(notes)) add(line.speaker);
  for (const event of events) if (event.actorRole !== "target") add(event.actorName);
  return names.map((name) => ({ name }));
}

async function jevAnnotateEvents(run, events, { request, notes, cfg }) {
  // Things done TO a character (actorRole "target") have no doer to route and no outcome to judge.
  const subjects = events.map((event, index) => ({ event, index })).filter(({ event }) => event && event.actorRole !== "target");
  if (!subjects.length) return;
  const roster = jevRoster(request, events, notes);
  if (run.cfg.attribution && roster.length >= 2) {
    const results = await run.step("attribution", (client) => attributeEvents(client, subjects.map((s) => s.event), { roster, notes }));
    (results ?? []).forEach((r, k) => {
      const { event, index: i } = subjects[k];
      if (!r) return;
      const info = jevInfo(event);
      // Pinned names (dev-integration reads event.jev.actorName + actorConfidence): actorName is a
      // roster name or null (someone-else / whole-party); whole marks a whole-party deed.
      info.actorName = r.actorName ?? null;
      info.whole = r.whole === true;
      info.actorConfidence = round2(r.confidence);
      if (r.witnessOnly !== null && r.witnessOnly !== undefined) info.witnessOnly = round2(r.witnessOnly);
      if (!r.actorName || r.confidence < JEV_ATTRIBUTION_CONFIDENCE) return;
      const llm = typeof event.actorName === "string" ? event.actorName.trim() : "";
      if (llm && sameName(llm, r.actorName)) { run.diag.routed += 1; return; }
      // The LLM's usual mistake: crediting the character whose line reported the deed. Replace it
      // only when that is what happened (it named the line's speaker, and Jev agrees the speaker
      // only witnessed it); any other disagreement is a flag for the GM, not a silent change.
      const namedWitness = llm && r.speaker && sameName(llm, r.speaker) && (r.witnessOnly === null || r.witnessOnly >= 0.5);
      if (!llm || namedWitness) {
        info.actorFrom = llm || null;
        event.actorName = r.actorName;
        run.diag.routed += 1;
        run.diag.overrides.push({ event: i, field: "actorName", from: llm || null, to: r.actorName, confidence: round2(r.confidence) });
      } else {
        addJevFlag(run, event, i, "actor-disputed");
      }
    });
  }
  if (run.cfg.verify) {
    const oc = run.cfg.overrideConfidence;
    const results = await run.step("verify", (client) => verifyEvents(client, subjects.map((s) => s.event), { allowRed: cfg.allowRed }));
    (results ?? []).forEach((r, k) => {
      const { event, index: i } = subjects[k];
      if (!r) return;
      const info = jevInfo(event);
      // Jev's own reading, always, so a disputed event can say "Jev reads this as failure".
      info.outcome = r.outcome;
      info.outcomeConfidence = round2(r.outcomeConfidence);
      if (r.outcome && r.outcome !== "unclear" && r.outcome !== event.outcome) {
        if (r.outcomeConfidence >= oc) {
          info.outcomeFrom = event.outcome;
          run.diag.overrides.push({ event: i, field: "outcome", from: event.outcome, to: r.outcome, confidence: round2(r.outcomeConfidence) });
          event.outcome = r.outcome;
          delete event.outcomeInferred;
        } else {
          addJevFlag(run, event, i, "outcome-disputed");
        }
      }
      if (r.darkP !== null && r.darkP !== undefined) {
        info.darkP = round2(r.darkP);
        // A second opinion on darkDeed: never a vice of Jev's own, never a lower severity. When the
        // LLM said "none" and Jev is confident, the flag + theme make stage 2's red check look again.
        const signalled = Boolean(event.darkDeed) && event.darkDeed !== "none";
        if (r.darkP >= oc && !signalled) {
          addJevFlag(run, event, i, "dark-act");
          if (!event.themes.includes("dark-deed")) event.themes = [...event.themes, "dark-deed"];
        }
      }
    });
  }
}

async function jevRank(run, proposals, events, request) {
  if (!run.cfg.rank || !proposals.length) return proposals;
  const results = await run.step("rank", (client) => rankProposals(client, proposals, { events, actor: request?.actor }));
  if (!Array.isArray(results) || results.length !== proposals.length) return proposals;
  const scored = proposals.map((proposal, i) => {
    const r = results[i];
    const jev = { grounded: r.grounded, fit: r.fit };
    if (r.grounded < 1) {
      jev.flags = ["weak-evidence"];
      run.diag.flags.push({ proposal: proposal.entry?.name ?? i, flag: "weak-evidence" });
    }
    return { proposal: { ...proposal, jev }, score: r.grounded + r.fit, i };
  });
  // Stable: equal scores keep the LLM's order.
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.proposal);
}

/**
 * Extract (or, for pipeline "single", extract + propose) every chunk. Throws only on a total or
 * fatal failure. Returns deduped events; diagnostics go to ctx.diagnostics.
 */
async function extractAllChunks(chunks, ctx, sleepFn) {
  const { cfg, diagnostics } = ctx;
  const events = [];
  const skippedEvents = [];
  const proposalBatches = [];
  const failures = [];
  let queue = chunks.map((text, index) => ({ text, index, depth: 0 }));
  if (ctx.jevRun && ctx.jevRun.cfg.triage && chunks.length >= 2) queue = await jevTriage(ctx.jevRun, chunks, queue, diagnostics);
  let succeeded = 0;
  while (queue.length) {
    const job = queue.shift();
    try {
      const result = cfg.pipeline === "single"
        ? await combinedChunk(job, chunks.length, ctx)
        : await extractChunk(job, chunks.length, ctx);
      if (result.split) {
        queue.unshift(...result.split);
        diagnostics.warnings.push(`chunk ${job.index} was truncated by the model's output limit; re-extracting it in ${result.split.length} smaller pieces`);
        continue;
      }
      succeeded += 1;
      events.push(...result.events);
      skippedEvents.push(...result.skipped);
      if (result.proposalBatch) proposalBatches.push(result.proposalBatch);
    } catch (error) {
      // A single "Failed to fetch" or one call that blew the timeout is far more often a hiccup
      // (Ollama swapping a model into VRAM, a laptop waking up, a busy GPU) than a dead provider.
      // Measured with the simulated model at a 30% per-call fault rate, NOT retrying these sent
      // ~1.1% of runs to the local keyword fallback -- the exact outcome this gateway exists to
      // avoid. So a transient failure re-queues the same chunk (with backoff) up to
      // cfg.transientRetries times before it counts; only a provider that stays down is fatal.
      if (isTransientTransportError(error) && (job.transient ?? 0) < cfg.transientRetries) {
        const attempt = (job.transient ?? 0) + 1;
        diagnostics.warnings.push(`chunk ${job.index}: transient ${error.name ?? "error"} (${error.message.slice(0, 120)}); retry ${attempt}/${cfg.transientRetries}`);
        await sleepFn(cfg.transientBackoffMs * 2 ** (attempt - 1));
        queue.unshift({ ...job, transient: attempt });
        continue;
      }
      if (isFatalTransportError(error)) throw error;
      failures.push({ chunk: job.index, error });
      diagnostics.warnings.push(`chunk ${job.index} failed: ${error.message}`);
    }
  }
  if (!succeeded) {
    // Total failure: the one path that sends api.js to the local analyzer. Re-throw the first
    // error so its specific message (HTTP 500, timeout, malformed JSON) reaches the GM.
    throw failures[0]?.error ?? new Error("AI gateway produced no usable output.");
  }
  if (failures.length) {
    skippedEvents.push(...failures.map(({ chunk, error }) => ({ chunk, reason: "chunk-failed", error: error.message, text: chunks[chunk]?.slice(0, 400) })));
  }
  return { events: dedupeEvents(events), skippedEvents, proposalBatches, chunkFailures: failures.length };
}

function dedupeEvents(events) {
  const seen = new Map();
  const out = [];
  for (const event of events) {
    const key = eventDedupeKey(event);
    const existing = seen.get(key);
    if (existing) {
      for (const tag of event.tags) if (!existing.tags.includes(tag)) existing.tags.push(tag);
      for (const theme of event.themes ?? []) if (!existing.themes.includes(theme)) existing.themes.push(theme);
      if (!existing.dangerGap && event.dangerGap) existing.dangerGap = event.dangerGap;
      continue;
    }
    const copy = { ...event, tags: [...event.tags], themes: [...(event.themes ?? [])] };
    seen.set(key, copy);
    out.push(copy);
  }
  return out;
}

function summarizeThemes(events) {
  const map = new Map();
  for (const event of events) {
    const weight = GROWTH_EVENT_OUTCOME_WEIGHTS[event.outcome] ?? 0;
    for (const slug of event.themes ?? []) {
      const entry = map.get(slug) ?? { slug, weight: 0, count: 0 };
      entry.weight = Math.round((entry.weight + weight) * 100) / 100;
      entry.count += 1;
      map.set(slug, entry);
    }
  }
  return [...map.values()].sort((a, b) => b.weight - a.weight || a.slug.localeCompare(b.slug));
}

// Why this pass: every prompt-only variant tried on 2026-09-24 (rules, a payoff few-shot, a
// dedicated "consequence" field) left the same ~40 corpus items over-split -- "Erin ran the inn all
// week" then "Erin didn't lose a single guest" -- because the model reliably emits a stated payoff
// as its own event, which double-counts evidence. Merging on shared themes alone was tried and
// rejected: it also folded genuinely separate actions of one activity ("moved the hives" then
// "harvested honey"). So the model declares continuesPrevious per event (schemas.js) and this
// pass folds only those, into the event right before, never across chunks, and never when the
// follow-up names a new occasion.
export function mergeFollowUpEvents(events) {
  const out = [];
  let merged = 0;
  for (const event of events) {
    const prev = out[out.length - 1];
    if (prev && event.continuesPrevious === true && !marksNewOccasion(event) && !differentActors(prev, event)) {
      prev.tags = [...new Set([...prev.tags, ...event.tags])].slice(0, 4);
      prev.themes = [...new Set([...(prev.themes ?? []), ...(event.themes ?? [])])].slice(0, 4);
      const followUp = [event.summary, event.consequence].filter(Boolean).join(" ");
      prev.consequence = [prev.consequence, followUp].filter(Boolean).join(" ").slice(0, 240);
      if (prev.quote && event.quote) prev.quote = `${prev.quote} ... ${event.quote}`.slice(0, 400);
      if (!prev.actorName && event.actorName) prev.actorName = event.actorName;
      if (event.dangerGap && (!prev.dangerGap || (prev.dangerGap === "moderate" && event.dangerGap === "severe"))) prev.dangerGap = event.dangerGap;
      // The payoff line can be the one that reveals the deed ("...and then left him to hang"): the
      // folded event keeps the worse of the two, or Horror Rank would lose it with the line.
      if (event.darkDeed && event.darkDeed !== "none" && darkSeverityRank(event.darkSeverity) > darkSeverityRank(prev.darkSeverity)) {
        prev.darkDeed = event.darkDeed;
        prev.darkSeverity = event.darkSeverity;
      }
      // The first event is the action; its outcome stands unless the model had to guess it.
      if (prev.outcomeInferred && !event.outcomeInferred) {
        prev.outcome = event.outcome;
        delete prev.outcomeInferred;
      }
      merged += 1;
      continue;
    }
    const { continuesPrevious, ...kept } = event;
    out.push({ ...kept, tags: [...event.tags], themes: [...(event.themes ?? [])] });
  }
  return { events: out, merged };
}

// A follow-up that names a new occasion ("on Wednesday", "again", "the next day", "later") is
// repeated effort -- exactly the evidence progression should count -- so it is never folded.
// "then" (and "and then") is here too: it is the plain-English marker for "a new, separate action
// follows", even by the same actor in the same breath ("Entangle only got 1 of 4, THEN Thorn Lash
// pinned it"). The model is asked to leave continuesPrevious false for exactly this case (see the
// "kesh ... then he kick door" few-shot in prompts.js) but does not always get it right at this
// model size (2026-09-28, ember-road s2 board 0cd50d30: Maren's Thorn Lash was folded into her
// Entangle, losing the hit as its own event) -- this deterministic guard catches it regardless of
// what the model set continuesPrevious to.
const NEW_OCCASION = /\b(again|later|next|another|afterwards?|then|the following|meanwhile|every|each|mon|tues|wednes|thurs|fri|satur|sun)(day)?\b|\bday \d|\b(d[ií]a|jour|tag|giorno)\b/i;
function marksNewOccasion(event) {
  return NEW_OCCASION.test(`${event.quote ?? ""} ${event.summary ?? ""}`);
}

// A payoff is the same person's. Folding "Tovin killed the goblin" into the line before it because
// the model flagged it as a follow-up of Luz's heal would hand Tovin's deed to Luz -- exactly the
// per-character credit this field now carries. Unnamed events can still fold into anyone's.
// A result the group shares ("the party got the camp location") or one that lands on someone the
// previous event already names ("Brin carried Holt" -> "Holt's fever broke") is still that event's
// payoff: with actorName required the model names those too, and blocking them re-split exactly
// the consequences the fold exists for (2026-09-27 A/B: rd-007, bl-018).
function differentActors(prev, event) {
  const a = String(prev.actorName ?? "").trim().toLowerCase();
  const b = String(event.actorName ?? "").trim().toLowerCase();
  if (!a || !b || a === b || b === "the party") return false;
  // Whole-word match on name tokens, titles and filler excluded (C5 review: "Sir Aldric stole..."
  // folded into Tovin's event because "sir" appeared in Tovin's text).
  const named = new Set(`${prev.summary ?? ""} ${prev.quote ?? ""}`.toLowerCase().split(/[^\p{L}\p{N}]+/u));
  return !b.split(/[^\p{L}\p{N}]+/u).some((token) => token.length >= 3 && !ACTOR_TITLE_WORDS.has(token) && named.has(token));
}
const ACTOR_TITLE_WORDS = new Set(["sir", "lady", "lord", "dame", "the", "and", "master", "mistress", "captain", "brother", "sister", "father", "mother", "old", "young", "von", "van", "del"]);

// Board 4f3192e0: the model marks an entry "target" when it only happened TO the character (read,
// offered a deal, attacked, told a secret). Not their deed, so not their evidence; kept visible in
// skippedEvents. Deliberately NOT counted as a rejection: a chunk that is all "target" entries is a
// correct reading ("nothing he did"), not a broken one that deserves a repair turn.
function isTargetOnly(raw) {
  return isPlainObject(raw) && typeof raw.actorRole === "string" && /^\s*(target|victim|recipient|passive)\b/i.test(raw.actorRole);
}

// Board 07b9d93f (ember-road s1): "I got banned from a pie tent" was marked "target" and dropped. A
// ban, arrest or eviction is the one trace the notes give of the character's own misdeed, so it stays
// their event, as a failure. A backstop to the prompt rule: the model still reaches for "target"
// because grammatically something was done to them. Words that say it was undeserved ("falsely",
// "framed") keep the model's reading.
const PUNISHMENT_PATTERN = /\b(banned|barred|banished|blacklisted|evicted|expelled|exiled|arrested|jailed|imprisoned|locked up|fined|thrown out|kicked out|chased out|run out of|tossed out|booted (out|from))\b/i;
const UNDESERVED_PATTERN = /\b(falsely|wrongly|wrongfully|framed|by mistake|mistaken|innocent)\b/i;

export function isConsequenceOfOwnDeed(raw) {
  if (!isTargetOnly(raw)) return false;
  const text = `${raw.quote ?? ""} ${raw.summary ?? ""} ${raw.consequence ?? ""}`;
  if (!String(raw.actorName ?? "").trim()) return false;
  return PUNISHMENT_PATTERN.test(text) && !UNDESERVED_PATTERN.test(text);
}

function asOwnMisdeed(raw) {
  const outcome = String(raw.outcome ?? "").trim();
  const themes = Array.isArray(raw.themes) ? raw.themes : [];
  const tags = Array.isArray(raw.tags) ? raw.tags : [];
  return {
    ...raw,
    actorRole: "doer",
    outcome: outcome === "criticalFailure" ? outcome : "failure",
    // coerceEvent needs a tag or a theme; a bare ban often came with neither.
    ...(tags.length || themes.length ? {} : { themes: ["misconduct"] })
  };
}

function coerceAll(items, ctx, chunkIndex) {
  const accepted = [];
  const rejected = [];
  const happenedTo = [];
  let droppedPrevious = false;
  for (const item of items) {
    const ownDeed = isConsequenceOfOwnDeed(item);
    if (ownDeed) ctx.diagnostics.coercions.push("target->doer:consequence-of-own-deed");
    const original = ownDeed ? asOwnMisdeed(item) : item;
    if (isTargetOnly(original)) {
      happenedTo.push({ event: original, reason: "happened-to-actor", chunk: chunkIndex });
      droppedPrevious = true;
      continue;
    }
    // A follow-up of a dropped "target" entry must not fold into the unrelated event before it.
    const raw = droppedPrevious && isPlainObject(original) && original.continuesPrevious ? { ...original, continuesPrevious: false } : original;
    droppedPrevious = false;
    const result = coerceEvent(raw, { customSynonyms: ctx.cfg.customSynonyms, emergentThemes: ctx.cfg.emergentThemes });
    if (result.event) {
      accepted.push(result.event);
      for (const c of result.coercions) ctx.diagnostics.coercions.push(c);
    } else {
      rejected.push({ event: raw, reason: result.rejected, chunk: chunkIndex });
    }
  }
  if (ctx.cfg.mergeFollowUps === false) {
    for (const event of accepted) delete event.continuesPrevious;
    return { accepted, rejected, happenedTo };
  }
  const { events: folded, merged } = mergeFollowUpEvents(accepted);
  if (merged) ctx.diagnostics.coercions.push(`merged-follow-up-events:${merged}`);
  return { accepted: folded, rejected, happenedTo };
}

async function extractChunk(job, chunkCount, ctx) {
  const { transport, request, cfg, diagnostics } = ctx;
  const stage = { stage: "extract", chunk: job.index, attempts: 0, ms: 0, repairs: [], errors: [] };
  diagnostics.stages.push(stage);
  const messages = buildExtractionMessages({ notesChunk: job.text, request, config: cfg, chunkIndex: job.index, chunkCount });
  // Extraction is a reading task: keep it near-deterministic regardless of creativity.
  const temperature = Math.min(cfg.temperature, 0.3);
  let best = null;
  let lastParseError = null;
  for (let attempt = 0; attempt <= cfg.maxRepairAttempts; attempt += 1) {
    stage.attempts += 1;
    const response = await transport.chat({ messages, schema: EVENT_EXTRACTION_SCHEMA, temperature, maxTokens: cfg.numPredict });
    stage.ms += Math.round(response.ms ?? 0);
    let parsed;
    try {
      parsed = parseModelJson(response.content);
    } catch (error) {
      lastParseError = error;
      stage.errors.push(`unparseable: ${error.message}`);
      messages.push(assistantEcho(response.content), buildRepairMessage({ stage: "extract", errors: [`Your reply was not valid JSON (${error.message}).`], expectedShape: "{\"events\":[...]}" }));
      continue;
    }
    stage.repairs.push(...parsed.repairs);
    const located = locateEvents(parsed.value);
    if (!located) {
      if (isPlainObject(parsed.value) && !Object.keys(parsed.value).length) {
        best = best ?? { events: [], skipped: [] };
        stage.errors.push("empty-object-treated-as-no-events");
        break;
      }
      const keys = isPlainObject(parsed.value) ? Object.keys(parsed.value).slice(0, 8).join(", ") : typeof parsed.value;
      stage.errors.push(`wrong-shape: ${keys}`);
      messages.push(assistantEcho(response.content), buildRepairMessage({ stage: "extract", errors: [`The top level must be {"events":[...]}, but your reply had: ${keys}.`], expectedShape: "{\"events\":[...]}" }));
      continue;
    }
    if (located.via !== "events") stage.repairs.push(`events-${located.via}`);
    const { accepted, rejected, happenedTo } = coerceAll(located.items, ctx, job.index);
    const candidate = { events: accepted, skipped: [...rejected, ...happenedTo] };
    if (!best || candidate.events.length > best.events.length) best = candidate;

    const wasTruncated = response.truncated || parsed.repairs.includes("closed-truncated-json");
    if (wasTruncated && job.text.length >= 600 && job.depth < 2) {
      // A repair turn would be cut off at the same output limit; halving the input is what helps.
      const halves = chunkNotes(job.text, Math.ceil(job.text.length / 2) + 50);
      if (halves.length > 1) {
        stage.errors.push("truncated-output: splitting chunk");
        return { events: [], skipped: [], split: halves.map((text) => ({ text, index: job.index, depth: job.depth + 1 })) };
      }
    }
    const total = located.items.length - happenedTo.length;
    if (total > 0 && rejected.length / total > 0.5 && attempt < cfg.maxRepairAttempts) {
      const errors = summarizeRejections(rejected);
      stage.errors.push(...errors);
      messages.push(assistantEcho(response.content), buildRepairMessage({ stage: "extract", errors, expectedShape: "{\"events\":[...]}" }));
      continue;
    }
    break;
  }
  if (!best) {
    throw new ModelJsonError(`AI provider returned malformed JSON after ${stage.attempts} attempt(s)${lastParseError ? `: ${lastParseError.message}` : " (no events array found)."}`, null);
  }
  return best;
}

// Snapshot the conversation so a later proposal repair turn continues from THIS reply.
function batchFor(located, messages, response, stage, cfg) {
  return {
    items: located?.items ?? [],
    conversation: { messages: [...messages, assistantEcho(response.content)], stage, temperature: cfg.temperature }
  };
}

async function combinedChunk(job, chunkCount, ctx) {
  const { transport, request, cfg, diagnostics } = ctx;
  const stage = { stage: "single", chunk: job.index, attempts: 0, ms: 0, repairs: [], errors: [] };
  diagnostics.stages.push(stage);
  const chunkRequest = chunkCount > 1 ? { ...request, notes: job.text, notesPart: `${job.index + 1}/${chunkCount}` } : { ...request, notes: job.text };
  const messages = buildSingleMessages({ request: chunkRequest, config: cfg });
  let best = null;
  let lastParseError = null;
  for (let attempt = 0; attempt <= cfg.maxRepairAttempts; attempt += 1) {
    stage.attempts += 1;
    const response = await transport.chat({ messages, schema: COMBINED_SCHEMA, temperature: cfg.temperature, maxTokens: cfg.numPredict });
    stage.ms += Math.round(response.ms ?? 0);
    let parsed;
    try {
      parsed = parseModelJson(response.content);
    } catch (error) {
      lastParseError = error;
      stage.errors.push(`unparseable: ${error.message}`);
      messages.push(assistantEcho(response.content), buildRepairMessage({ stage: "extract", errors: [`Your reply was not valid JSON (${error.message}).`], expectedShape: "{\"events\":[...],\"proposals\":[...]}" }));
      continue;
    }
    stage.repairs.push(...parsed.repairs);
    const value = parsed.value;
    const locatedEvents = locateEvents(Array.isArray(value) ? value : isPlainObject(value) ? value : null);
    const locatedProposals = isPlainObject(value) ? locateProposals({ proposals: value.proposals ?? value.suggestions }) : null;
    if (!locatedEvents) {
      if (isPlainObject(value) && (!Object.keys(value).length || Array.isArray(value.proposals))) {
        // {} or {proposals:[...]} alone: "nothing happened" is an acceptable answer.
        best = { events: [], skipped: [], proposalBatch: batchFor(locatedProposals, messages, response, stage, cfg) };
        if (!Object.keys(value).length) stage.errors.push("empty-object-treated-as-no-events");
        break;
      }
      const keys = isPlainObject(value) ? Object.keys(value).slice(0, 8).join(", ") : typeof value;
      stage.errors.push(`wrong-shape: ${keys}`);
      messages.push(assistantEcho(response.content), buildRepairMessage({ stage: "extract", errors: [`The top level must be {"events":[...],"proposals":[...]}, but your reply had: ${keys}.`], expectedShape: "{\"events\":[...],\"proposals\":[...]}" }));
      continue;
    }
    const { accepted, rejected, happenedTo } = coerceAll(locatedEvents.items, ctx, job.index);
    const candidate = { events: accepted, skipped: [...rejected, ...happenedTo], proposalBatch: batchFor(locatedProposals, messages, response, stage, cfg) };
    if (!best || candidate.events.length > best.events.length) best = candidate;
    const total = locatedEvents.items.length - happenedTo.length;
    if (total > 0 && rejected.length / total > 0.5 && attempt < cfg.maxRepairAttempts) {
      const errors = summarizeRejections(rejected);
      stage.errors.push(...errors);
      messages.push(assistantEcho(response.content), buildRepairMessage({ stage: "extract", errors, expectedShape: "{\"events\":[...],\"proposals\":[...]}" }));
      continue;
    }
    break;
  }
  if (!best) {
    throw new ModelJsonError(`AI provider returned malformed JSON after ${stage.attempts} attempt(s)${lastParseError ? `: ${lastParseError.message}` : " (no events array found)."}`, null);
  }
  return best;
}

export function shouldPropose(events, request, cfg) {
  if (cfg.proposalMode === "never") return { run: false, reason: "proposalMode=never" };
  if (cfg.maxProposals <= 0) return { run: false, reason: "maxProposals=0" };
  const gd = request?.actor?.grandDesign ?? {};
  const allowances = Number.isInteger(gd.availableGrantAllowances) ? gd.availableGrantAllowances : 0;
  const allowClass = gd.classEvolutionAvailable === true;
  const fresh = weightedEvidence(events);
  const history = request?.growthHistory ?? {};
  const tagEvidence = addEvidence(history.tagEvidence, fresh.tags);
  const themeEvidence = addEvidence(history.themeEvidence, fresh.themes);
  const base = { tagEvidence, themeEvidence, allowClass };
  if (!events.length && allowances <= 0) return { ...base, run: false, reason: "no-new-events" };
  if (cfg.proposalMode === "always") return { ...base, run: true, reason: "proposalMode=always" };
  if (!events.length) return { ...base, run: false, reason: "no-new-events" };
  if (allowances > 0) return { ...base, run: true, reason: `grant-allowances=${allowances}` };
  if (allowClass) return { ...base, run: true, reason: "class-evolution-available" };
  // Only evidence that THIS batch touched counts as newly earned; stale history alone should not
  // re-trigger the stage on every analysis.
  const touched = [
    ...Object.keys(fresh.tags).map((tag) => ["tag", tag, tagEvidence[tag]]),
    ...Object.keys(fresh.themes).map((theme) => ["theme", theme, themeEvidence[theme]])
  ].filter(([, , weight]) => weight >= EARNED_EVIDENCE_THRESHOLD);
  if (touched.length) return { ...base, run: true, reason: `evidence>=${EARNED_EVIDENCE_THRESHOLD}: ${touched.slice(0, 5).map(([k, n]) => `${k}:${n}`).join(", ")}` };
  return { ...base, run: false, reason: "not-yet-earned" };
}

/** The events the model marked with a vice in its redCheck (see schemas.js#RED_CHECK_SCHEMA). */
export function readRedCheck(value) {
  const list = isPlainObject(value) && Array.isArray(value.redCheck) ? value.redCheck : [];
  return list
    .filter((item) => isPlainObject(item) && VICE_TAGS.has(String(item.vice ?? "").toLowerCase().trim()))
    .map((item) => ({ event: String(item.event ?? "").slice(0, 200), vice: String(item.vice).toLowerCase().trim() }))
    .slice(0, 20);
}

async function proposeStage(events, decision, ctx, milestone = null, target = null) {
  const { transport, request, cfg, diagnostics } = ctx;
  const stage = { stage: "propose", chunk: null, attempts: 0, ms: 0, repairs: [], errors: [] };
  diagnostics.stages.push(stage);
  const mustPropose = Boolean(milestone) || Boolean(target) || cfg.proposalMode === "always" || String(decision.reason ?? "").startsWith("grant-allowances");
  // A milestone request always names its own kind explicitly (api.js#resolveLevelRest calls capstone
  // and class-evolution separately, even when one level grants both): a capstone call never allows a
  // Class in the same breath, and a class-evolution call always allows one, regardless of what
  // decision.allowClass (derived from the actor's live grandDesign flag) would otherwise say.
  const allowClass = target ? target.kind === "class" : milestone ? milestone.kind === "class-evolution" : decision.allowClass;
  // Board 7b616fea: Titles only in an open-ended stage 2 (analysis, Suggest). A milestone, authoring
  // or evolution call asks for exactly one entry of one kind.
  const titles = !target && !milestone && cfg.titles !== false;
  const messages = buildProposalMessages({ request, config: cfg, events, themeEvidence: decision.themeEvidence, tagEvidence: decision.tagEvidence, allowClass, mustPropose, milestone, target, titles });
  const temperature = creativityTemperature(cfg);
  let items = null;
  let titleItems = [];
  let redFlags = [];
  let lastContent = "";
  for (let attempt = 0; attempt <= cfg.maxRepairAttempts; attempt += 1) {
    stage.attempts += 1;
    const response = await transport.chat({ messages, schema: proposalSchemaCapped(cfg.maxProposals, { redCheck: cfg.allowRed, titles, systemId: ctx.sysId }), temperature, maxTokens: cfg.numPredict });
    stage.ms += Math.round(response.ms ?? 0);
    lastContent = response.content;
    let parsed;
    try {
      parsed = parseModelJson(response.content);
    } catch (error) {
      stage.errors.push(`unparseable: ${error.message}`);
      messages.push(assistantEcho(response.content), buildRepairMessage({ stage: "propose", errors: [`Your reply was not valid JSON (${error.message}).`], expectedShape: "{\"proposals\":[...]}" }));
      continue;
    }
    stage.repairs.push(...parsed.repairs);
    const located = locateProposals(parsed.value);
    if (!located) {
      if (isPlainObject(parsed.value) && !Object.keys(parsed.value).length) { items = []; break; }
      const keys = isPlainObject(parsed.value) ? Object.keys(parsed.value).slice(0, 8).join(", ") : typeof parsed.value;
      stage.errors.push(`wrong-shape: ${keys}`);
      messages.push(assistantEcho(response.content), buildRepairMessage({ stage: "propose", errors: [`The top level must be {"proposals":[...]}, but your reply had: ${keys}.`], expectedShape: "{\"proposals\":[...]}" }));
      continue;
    }
    items = located.items;
    redFlags = readRedCheck(parsed.value);
    if (titles && isPlainObject(parsed.value) && Array.isArray(parsed.value.titles)) titleItems = parsed.value.titles;
    messages.push(assistantEcho(response.content));
    break;
  }
  if (items === null) {
    return { accepted: [], skipped: [{ reason: "unparseable-proposal-response", errors: stage.errors.slice(-3), raw: String(lastContent).slice(0, 1000) }] };
  }
  // A title is never sent back through the Skill/Class validator or its repair turn (it has no
  // mechanics); a {kind:"title"} object in the proposals array is moved to the titles path too.
  const inlineTitles = titles ? items.filter((item) => isPlainObject(item) && String(item.kind ?? "").toLowerCase() === "title") : [];
  if (inlineTitles.length) items = items.filter((item) => !inlineTitles.includes(item));
  const checked = await validateProposals(items, { messages, stage, temperature }, ctx);
  if (target?.operation) {
    checked.accepted = checked.accepted.map((proposal) => (proposal.kind === target.kind ? applyAdvancedTarget(proposal, target, ctx) : proposal));
  }
  // An authoring request is for ONE kind; a model that also wrote the other kind first must not use
  // up the single slot on it.
  const wrongKind = target ? checked.accepted.filter((p) => p.kind !== target.kind) : [];
  const gated = gateProposals(target ? checked.accepted.filter((p) => p.kind === target.kind) : checked.accepted, ctx, { guaranteed: Boolean(milestone) || Boolean(target), exempt: target?.sources ?? [] });
  checked.skipped.push(...wrongKind.map((proposal) => ({ proposal, reason: "wrong-kind-for-target" })));
  // Live regression (dnd5e live-verify, 2026-09-29): with 4 archery proposals pending, Suggest's stage
  // 2 answered {"proposals":[]} -- told never to re-propose what is pending, the model found nothing
  // left to say and said nothing, and the GM who pressed the button got no idea at all. When the GM
  // asked (mustPropose), an empty result gets ONE more turn that names what to avoid and where else
  // to look.
  if (mustPropose && (events.length || target) && !gated.final.length && cfg.maxRepairAttempts > 0) {
    const retried = await proposeSomethingElse({ messages, temperature, checked, gated, allowClass, target }, ctx);
    if (retried) {
      if (target?.operation) retried.accepted = retried.accepted.map((proposal) => applyAdvancedTarget(proposal, target, ctx));
      const again = gateProposals(retried.accepted, ctx, { guaranteed: Boolean(milestone) || Boolean(target), exempt: target?.sources ?? [] });
      gated.final.push(...again.final);
      gated.skipped.push(...retried.skipped, ...again.skipped);
    }
  }
  if (titles) {
    const titled = gateTitles([...titleItems, ...inlineTitles.map((item) => ({ ...(isPlainObject(item.entry) ? item.entry : {}), ...item }))], events, ctx);
    gated.final.push(...titled.accepted);
    gated.skipped.push(...titled.skipped);
  }
  // Surface the model's own red verdicts, and say so when it flagged a deed but still wrote nothing
  // red: the GM should know a dark act went unanswered rather than find out from the players.
  if (redFlags.length) {
    diagnostics.redCheck = redFlags;
    if (gated.final.some((p) => p.kind !== "title") && !gated.final.some((p) => p.kind !== "title" && p.entry?.metadata?.polarity === "red")) {
      diagnostics.warnings.push(`red check flagged ${redFlags.map((f) => `"${f.event}" (${f.vice})`).join(", ")} but no red proposal was written`);
    }
  }
  return { accepted: gated.final, skipped: [...checked.skipped, ...gated.skipped] };
}

// The one extra turn for an empty answer to a GM request (see proposeStage). Never throws: the first
// call already worked, so a failure here only means "still nothing".
async function proposeSomethingElse({ messages, temperature, checked, gated, allowClass, target }, ctx) {
  const { transport, request, cfg, diagnostics } = ctx;
  // Its own stage entry: the first reply was valid, so this is a second question, not a repair of it
  // (the harness counts a stage with attempts > 1 or errors as "not valid first try").
  const stage = { stage: "propose-retry", chunk: null, attempts: 0, ms: 0, repairs: [], errors: [], notes: [] };
  diagnostics.stages.push(stage);
  const skippedNames = [...checked.skipped, ...gated.skipped].map((s) => s?.proposal?.entry?.name).filter((n) => typeof n === "string" && n.trim());
  const avoid = [...new Set([
    ...skippedNames,
    ...(request?.actor?.pendingProposals ?? []).map((p) => p?.name),
    ...(request?.actor?.rejectedProposals ?? []).map((p) => p?.name)
  ].filter((n) => typeof n === "string" && n.trim()))].slice(0, 15);
  const kind = target ? `kind "${target.kind}"` : allowClass ? "a Skill or a Class" : "a Skill";
  const content = [
    `You returned no usable proposal${skippedNames.length ? ` (skipped as duplicates or invalid: ${skippedNames.slice(0, 6).map((n) => `"${n}"`).join(", ")})` : ""}, but the GM asked for suggestions now, so an empty list is wrong.`,
    `Propose ONE new ${kind} that is clearly UNLIKE ${avoid.length ? `these: ${avoid.map((n) => `"${n}"`).join(", ")}` : "anything the character already has"}.`,
    "Look elsewhere: build it on a different activity, theme or tag from newEvents than those cover (a craft, a social moment, a failure they keep repeating), or make a clearly different kind of ability (a reaction or an action instead of a passive, a spell, a weapon technique) with a different effect.",
    "Reply {\"proposals\":[...]} with exactly one complete proposal."
  ].join(" ");
  messages.push({ role: "user", content });
  diagnostics.coercions.push("propose:empty-retry");
  try {
    stage.attempts += 1;
    const response = await transport.chat({ messages, schema: proposalSchemaCapped(1, { redCheck: false, systemId: ctx.sysId }), temperature, maxTokens: cfg.numPredict });
    stage.ms += Math.round(response.ms ?? 0);
    const parsed = parseModelJson(response.content);
    const located = locateProposals(parsed.value);
    messages.push(assistantEcho(response.content));
    if (!located?.items?.length) { stage.notes.push("still no proposal"); return null; }
    const again = await validateProposals(located.items.slice(0, 1), { messages, stage, temperature }, ctx);
    const wanted = target ? again.accepted.filter((p) => p.kind === target.kind) : again.accepted;
    return { accepted: wanted, skipped: [...again.skipped, ...again.accepted.filter((p) => !wanted.includes(p)).map((proposal) => ({ proposal, reason: "wrong-kind-for-target" }))] };
  } catch (error) {
    stage.errors.push(`empty-retry failed: ${error.message}`);
    return null;
  }
}

/**
 * Normalize -> repairProposal -> validate; then ONE repair turn (continuing the conversation that
 * produced them) for the ones the validator still rejects, with the validator's exact errors.
 */
async function validateProposals(items, conversation, ctx) {
  const { request, cfg, validate, sysId, transport, diagnostics } = ctx;
  const gd = request?.actor?.grandDesign ?? {};
  const repairCtx = {
    systemId: sysId,
    actorLevel: request?.actor?.level,
    grandDesignLevel: gd.level,
    systemLabel: request?.actor?.systemLabel,
    systemClass: request?.actor?.systemClass,
    customSynonyms: cfg.customSynonyms,
    allowRed: cfg.allowRed
  };
  const accepted = [];
  const skipped = [];
  let invalid = [];

  const check = (raw, index, pass) => {
    const shaped = normalizeProposalShape(raw);
    if (!shaped) { skipped.push({ proposal: raw, reason: "not-a-proposal" }); return; }
    const { proposal, repairs, skip } = repairProposal(shaped, repairCtx);
    if (repairs.length) diagnostics.coercions.push(...repairs.map((r) => `proposal[${index}]:${r}`));
    if (skip) { skipped.push({ proposal, reason: skip }); return; }
    const validation = proposal.kind === "class" ? validate.class(proposal.entry) : validate.skill(proposal.entry);
    if (validation.valid) accepted.push({ ...proposal, ...(repairs.length ? { repairs } : {}) });
    else invalid.push({ proposal, errors: validation.errors, index, pass });
  };
  (items ?? []).forEach((raw, index) => check(raw, index, 1));

  if (invalid.length && conversation && cfg.maxRepairAttempts > 0) {
    const errors = invalid.map(({ proposal, errors: errs, index }) => `proposal ${index} ("${proposal.entry?.name ?? "unnamed"}", ${proposal.kind}): ${errs.join(" ")}`);
    conversation.stage.errors.push(...errors);
    conversation.messages.push(buildRepairMessage({ stage: "propose", errors, expectedShape: "{\"proposals\":[...]} containing ONLY the corrected versions of the listed proposals" }));
    const pending = invalid;
    invalid = [];
    try {
      conversation.stage.attempts += 1;
      // Board 96b5beea: no redCheck here. The red verdicts were already read from the first reply,
      // the repair message asks for {"proposals":[...]} only, and a required per-event redCheck made
      // the model re-walk every event again, spending numPredict on a list nobody reads.
      const response = await transport.chat({ messages: conversation.messages, schema: proposalSchemaCapped(cfg.maxProposals, { redCheck: false, systemId: ctx.sysId }), temperature: conversation.temperature, maxTokens: cfg.numPredict });
      conversation.stage.ms += Math.round(response.ms ?? 0);
      const parsed = parseModelJson(response.content);
      const located = locateProposals(parsed.value);
      (located?.items ?? []).forEach((raw, index) => check(raw, `repair-${index}`, 2));
      // anything the model did not return a fix for stays invalid
      const fixedNames = new Set(accepted.map((p) => p.entry?.name));
      for (const item of pending) if (!fixedNames.has(item.proposal.entry?.name)) invalid.push(item);
    } catch (error) {
      conversation.stage.errors.push(`repair turn failed: ${error.message}`);
      invalid.push(...pending);
    }
  }
  for (const { proposal, errors } of invalid) skipped.push({ proposal, reason: "invalid", errors });
  return { accepted, skipped };
}

/**
 * Class gating, dedupe against the registry, the GM's pending and rejected proposals and each other,
 * and the maxProposals cap.
 */
function gateProposals(accepted, ctx, { guaranteed = false, exempt = [] } = {}) {
  const { request, cfg, sysId } = ctx;
  const gd = request?.actor?.grandDesign ?? {};
  const skipped = [];
  const registry = request?.actor?.existingGrandDesign ?? {};
  // Boards ebcc3f03 / d4ae9326: an evolution or merge is BUILT from owned entries, so of course it
  // resembles them. The sources are left out of every owned-entry check (by registry key, metadata.id
  // or name); everything else the character owns still counts.
  const exemptKeys = new Set(exempt.flatMap((source) => [source?.id, slugifyTheme(source?.name)]).filter(Boolean));
  const isExempt = (key, entry) => exemptKeys.has(key) || exemptKeys.has(entry?.metadata?.id) || exemptKeys.has(slugifyTheme(entry?.name));
  // Kind comes from the registry bucket, not from guessing at the entry's fields.
  const ownedByKind = [
    ...Object.entries(registry.classes ?? {}).map(([key, entry]) => [key, entry, "class"]),
    ...Object.entries(registry.skills ?? {}).map(([key, entry]) => [key, entry, "skill"])
  ].filter(([key, entry]) => entry && !isExempt(key, entry));
  const ownedEntries = ownedByKind.map(([, entry]) => entry);
  // A source that itself mentions a base-class feature ("Sneak Attack" riders) was approved like
  // that; its evolved form naming the same feature is not a new restatement of the class chassis.
  const exemptFeatureText = exempt.map((source) => ({ name: source?.name, mechanics: { effect: source?.effect ?? "" } }));
  const existing = new Set(ownedByKind.map(([, e, kind]) => `${kind}:${slugifyTheme(e?.name)}`));
  const classFeatureCtx = { systemClass: request?.actor?.systemClass, systemId: request?.actor?.system ?? sysId };
  const ownedFeatures = Array.isArray(request?.actor?.ownedFeatures) ? request.actor.ownedFeatures : [];
  // Board 3574bd96: proposals already waiting for the GM, and ones the GM turned down. A milestone or
  // authoring call must return its ONE guaranteed entry, so it is only checked against its siblings
  // here; its prompt still lists the pending ones so it writes something new.
  const pending = guaranteed || !Array.isArray(request?.actor?.pendingProposals) ? [] : request.actor.pendingProposals;
  const rejected = guaranteed || !Array.isArray(request?.actor?.rejectedProposals) ? [] : request.actor.rejectedProposals;
  const ownedAsProposals = ownedByKind.map(([, entry, kind]) => ({ kind, entry }));
  const nearOptions = { ignoreConcept: motifTokens([...ownedEntries.map((e) => e?.name), ...pending.map((p) => p?.name), ...rejected.map((p) => p?.name), ...accepted.map((p) => p?.entry?.name)]) };
  const kept = [];
  for (const proposal of accepted) {
    const key = slugifyTheme(proposal.entry.name);
    if (proposal.kind === "class" && gd.classEvolutionAvailable !== true) { skipped.push({ proposal, reason: "class-evolution-not-available" }); continue; }
    if (existing.has(`${proposal.kind}:${key}`)) { skipped.push({ proposal, reason: "already-exists" }); continue; }
    const sameKindOwned = ownedAsProposals.filter((owned) => owned.kind === proposal.kind);
    const duplicateOwned = findDuplicateOwnedMechanic(proposal.entry, sameKindOwned.map((owned) => owned.entry)) ?? findNearDuplicate(proposal, sameKindOwned, nearOptions)?.other.entry;
    if (duplicateOwned) { skipped.push({ proposal, reason: "duplicates-owned", duplicateOf: duplicateOwned.name }); continue; }
    const duplicateFeature = findDuplicateClassFeature(proposal.entry, classFeatureCtx);
    if (duplicateFeature && !exemptFeatureText.some((source) => findDuplicateClassFeature(source, classFeatureCtx) === duplicateFeature)) { skipped.push({ proposal, reason: "duplicates-class-feature", duplicateOf: duplicateFeature }); continue; }
    const ownedFeatureHit = findDuplicateOwnedFeatureText(proposal.entry, ownedFeatures);
    const duplicateOwnedFeature = ownedFeatureHit && !exemptFeatureText.some((source) => findDuplicateOwnedFeatureText(source, ownedFeatures) === ownedFeatureHit) ? ownedFeatureHit : null;
    if (duplicateOwnedFeature) { skipped.push({ proposal, reason: "duplicates-owned-proficiency", duplicateOf: duplicateOwnedFeature }); continue; }
    const pendingDup = findByNameOrNearDuplicate(proposal, pending, nearOptions);
    if (pendingDup) { skipped.push({ proposal, reason: "duplicates-pending", duplicateOf: pendingDup.other.name, similarity: pendingDup.reason, ...(pendingDup.other.id ? { duplicateOfId: pendingDup.other.id } : {}) }); continue; }
    const rejectedDup = findByNameOrNearDuplicate(proposal, rejected, nearOptions);
    if (rejectedDup) { skipped.push({ proposal, reason: "duplicates-rejected", duplicateOf: rejectedDup.other.name, similarity: rejectedDup.reason }); continue; }
    // A sibling from this same call: keep the better-sourced of the two (the one citing more events).
    const siblingIndex = kept.findIndex((other) => slugifyTheme(other.entry.name) === key || nearDuplicateReason(proposal, other, nearOptions));
    if (siblingIndex >= 0) {
      const sibling = kept[siblingIndex];
      const similarity = slugifyTheme(sibling.entry.name) === key ? "name" : nearDuplicateReason(proposal, sibling, nearOptions);
      const [winner, loser] = evidenceScore(proposal) > evidenceScore(sibling) ? [proposal, sibling] : [sibling, proposal];
      kept[siblingIndex] = winner;
      skipped.push({ proposal: loser, reason: "duplicates-sibling", duplicateOf: winner.entry.name, similarity });
      continue;
    }
    kept.push(proposal);
  }
  // Capped after the sibling dedupe, so a duplicate never takes the slot a distinct idea needed.
  const final = kept.slice(0, cfg.maxProposals);
  for (const proposal of kept.slice(cfg.maxProposals)) skipped.push({ proposal, reason: "over-max-proposals" });
  return { final, skipped };
}

// ---------------------------------------------------------------------------------------------
// Advanced operations (boards ebcc3f03 / d4ae9326): adapter.authorAdvanced "upgrade" / "combine"
// ---------------------------------------------------------------------------------------------

/**
 * The model writes the evolved/merged entry's name and mechanics; the numbers the rules decide are
 * set here, not trusted to the model: tier = source + 1 (max 3), the merge's power tier from the
 * focus score (ai-gateway.js computes it with class-merging.js), a level no lower than the highest
 * source's, red carried forward from a red source, and lineage pointing at the source ids.
 */
export function applyAdvancedTarget(proposal, target, ctx = {}) {
  const entry = proposal.entry;
  const repairs = [...(proposal.repairs ?? [])];
  const sources = Array.isArray(target.sources) ? target.sources : [];
  const sourceIds = sources.map((source) => source?.id).filter((id) => typeof id === "string" && id.trim());
  if (target.operation === "upgrade" && Number.isInteger(target.tier) && entry.tier !== target.tier) {
    repairs.push(`tier:${entry.tier}->${target.tier}`);
    entry.tier = target.tier;
  }
  if (target.operation === "combine") {
    if (target.powerTier && entry.power_tier !== target.powerTier) {
      repairs.push(`power_tier:${entry.power_tier}->${target.powerTier}`);
      entry.power_tier = target.powerTier;
    }
    const minLevel = Number.isInteger(target.level) ? target.level : Math.max(1, ...sources.map((s) => (Number.isInteger(s?.level) ? s.level : 1)));
    if (!Number.isInteger(entry.level) || entry.level < minLevel) {
      repairs.push(`level:${entry.level}->${minLevel}`);
      entry.level = minLevel;
    }
    entry.is_primary = true;
    entry.is_secondary = false;
    if (target.offCycle) entry.offCycleEvolution = true;
  }
  if (typeof target.name === "string" && target.name.trim() && entry.name !== target.name.trim()) {
    repairs.push("name->gm-choice");
    entry.name = target.name.trim();
  }
  const md = (entry.metadata = isPlainObject(entry.metadata) ? entry.metadata : {});
  const redSource = sources.find((source) => source?.polarity === "red");
  if (redSource && md.polarity !== "red") {
    md.polarity = "red";
    md.malignance = isPlainObject(redSource.malignance)
      ? { ...redSource.malignance }
      : { vice: VICE_TAGS.has(redSource.vice) ? redSource.vice : "corruption", drawback: redSource.drawback || `Carries forward the cost of [${redSource.name}].` };
    repairs.push("polarity->red-from-source");
  }
  const own = typeof md.lineage?.rationale === "string" ? md.lineage.rationale.trim() : "";
  const rationale = own && !/^Emerged from session-note evidence/.test(own)
    ? own
    : target.operation === "upgrade"
      ? `[${sources[0]?.name ?? "the Skill"}] evolved through ${(sources[0]?.definingMoments ?? []).slice(0, 3).join("; ") || "sustained use"}.`
      : `Merged from ${sources.map((s) => `[${s?.name}]`).join(" and ")}.`;
  md.lineage = { operation: target.operation, sources: sourceIds, rationale };
  if (sources.some((source) => slugifyTheme(source?.name) === slugifyTheme(entry.name))) {
    ctx.diagnostics?.warnings?.push(`the ${target.operation === "upgrade" ? "evolved Skill" : "merged Class"} kept its source's name "${entry.name}"`);
  }
  return { ...proposal, entry, ...(repairs.length ? { repairs } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Titles (board 7b616fea)
// ---------------------------------------------------------------------------------------------

const TITLE_DEFAULT_DRAWBACK = "Those who know the deed fear or despise the bearer.";

/**
 * Shape one model title into a `kind: "title"` proposal, or return a skip reason. The entry is what
 * validator.js#validateTitleEntry needs (name, achievement, metadata) plus the batch contract's
 * `description` / `tags`; the rationale quotes the deed.
 */
export function shapeTitle(raw, { allowRed = true, customSynonyms = {} } = {}) {
  if (!isPlainObject(raw)) return { skip: "not-a-title" };
  const name = String(raw.name ?? raw.title ?? "").trim().replace(/^\[|\]$/g, "");
  const deed = String(raw.deed ?? raw.achievement ?? raw.quote ?? "").trim();
  if (!name) return { skip: "title-without-name" };
  if (!deed) return { skip: "title-without-deed" };
  const tags = [];
  for (const rawTag of Array.isArray(raw.tags) ? raw.tags : []) {
    const resolved = resolveTag(rawTag, { customSynonyms });
    if (resolved?.tag && !tags.includes(resolved.tag)) tags.push(resolved.tag);
  }
  let polarity = String(raw.polarity ?? raw.metadata?.polarity ?? "standard").toLowerCase().trim() === "red" ? "red" : "standard";
  let vice = String(raw.vice ?? raw.metadata?.vice ?? raw.metadata?.malignance?.vice ?? "").toLowerCase().trim();
  vice = VICE_TAGS.has(vice) ? vice : VICE_SYNONYMS[vice] ?? null;
  if (polarity === "red" && !allowRed) return { skip: "red-entries-disabled" };
  // A red title with no vice from the list is not a taboo title, just a dark-sounding name.
  if (polarity === "red" && !vice) polarity = "standard";
  const description = String(raw.description ?? "").trim() || `Earned by: ${deed}`;
  const drawback = String(raw.drawback ?? raw.metadata?.malignance?.drawback ?? "").trim() || TITLE_DEFAULT_DRAWBACK;
  const rationale = `Earned by: "${deed.slice(0, 240)}"`;
  const entry = {
    name,
    description,
    achievement: deed.slice(0, 400),
    tags,
    metadata: {
      tags,
      polarity,
      ...(polarity === "red" ? { vice, malignance: { vice, drawback } } : {}),
      lineage: { operation: "origin", sources: [], rationale }
    }
  };
  return { proposal: { kind: "title", entry, evidence: [deed.slice(0, 240)], rationale } };
}

// "The Bridge-Holder" and "Bridge-Holder" are one title.
function titleKey(name) {
  return slugifyTheme(String(name ?? "").replace(/^\s*(the|a|an)\s+/i, ""));
}

function gateTitles(rawTitles, events, ctx) {
  const { request, cfg, validate } = ctx;
  const accepted = [];
  const skipped = [];
  const registry = request?.actor?.existingGrandDesign ?? {};
  const taken = new Map();
  for (const entry of Object.values(registry.titles ?? {})) if (entry?.name) taken.set(titleKey(entry.name), "already-exists");
  for (const record of request?.actor?.pendingProposals ?? []) if (record?.kind === "title" && record.name) taken.set(titleKey(record.name), "duplicates-pending");
  for (const record of request?.actor?.rejectedProposals ?? []) if (record?.kind === "title" && record.name) taken.set(titleKey(record.name), "duplicates-rejected");
  const actorName = String(request?.actor?.name ?? "").trim().toLowerCase();
  for (const raw of rawTitles.slice(0, 3)) {
    const shaped = shapeTitle(raw, { allowRed: cfg.allowRed, customSynonyms: cfg.customSynonyms });
    if (shaped.skip) { skipped.push({ proposal: { kind: "title", entry: raw }, reason: shaped.skip }); continue; }
    const { proposal } = shaped;
    const key = titleKey(proposal.entry.name);
    if (taken.has(key)) { skipped.push({ proposal, reason: taken.get(key), duplicateOf: proposal.entry.name }); continue; }
    if (actorName && proposal.entry.name.toLowerCase().includes(actorName)) { skipped.push({ proposal, reason: "title-uses-personal-name" }); continue; }
    // The deed must be one of THIS character's events: a title for a party-mate's kill is the same
    // mis-credit that per-character stage 2 exists to prevent.
    if (!titleDeedMatchesEvent(proposal.entry.achievement, events)) { skipped.push({ proposal, reason: "title-deed-not-in-events" }); continue; }
    const validation = (validate?.title ?? defaultValidateTitle)(proposal.entry);
    if (!validation.valid) { skipped.push({ proposal, reason: "invalid", errors: validation.errors }); continue; }
    if (accepted.length >= 1) { skipped.push({ proposal, reason: "over-max-titles" }); continue; }
    taken.set(key, "duplicates-sibling");
    accepted.push(proposal);
  }
  return { accepted, skipped };
}

function titleDeedMatchesEvent(deed, events) {
  const deedTokens = mechanicTokens(deed);
  if (!deedTokens.size) return false;
  return (events ?? []).some((event) => {
    const tokens = mechanicTokens(`${event?.quote ?? ""} ${event?.summary ?? ""} ${event?.consequence ?? ""}`);
    let shared = 0;
    for (const token of deedTokens) if (tokens.has(token)) shared += 1;
    return shared >= Math.min(2, deedTokens.size);
  });
}
