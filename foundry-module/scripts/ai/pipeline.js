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
import { coerceEvent, eventDedupeKey, resolveTag, slugifyTheme, CANONICAL_TAGS } from "./normalize.js";
import { EVENT_EXTRACTION_SCHEMA, PROPOSAL_SCHEMA, COMBINED_SCHEMA } from "./schemas.js";
import { buildExtractionMessages, buildProposalMessages, buildSingleMessages, buildRepairMessage, creativityTemperature } from "./prompts.js";
import { normalizeGatewayConfig } from "./gateway-config.js";
import { AiProviderUnreachableError, AiProviderHttpError, AiProviderTimeoutError } from "./transport.js";
import { GROWTH_EVENT_OUTCOME_WEIGHTS, FREQUENCY_PERIODS, GRAND_DESIGN_ITEM_KINDS, SPELL_SCHOOLS, LINEAGE_OPERATIONS, POWER_TIERS } from "../constants.js";
import { VICE_TAGS } from "../vice-taxonomy.js";
import { validateSkillEntry as defaultValidateSkill, validateClassEntry as defaultValidateClass } from "../validator.js";

// Same scale as progression.js MINIMUM_EVIDENCE / emergent-themes EMERGENT_THEME_EVIDENCE_THRESHOLD.
export const EARNED_EVIDENCE_THRESHOLD = 3;
const CANONICAL_SET = new Set(CANONICAL_TAGS);

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

const VICE_SYNONYMS = {
  murder: "bloodlust", killing: "bloodlust", bloodthirst: "bloodlust", slaughter: "bloodlust", sadism: "cruelty", torment: "cruelty", torture: "cruelty",
  domination: "subjugation", tyranny: "subjugation", enslavement: "servitude", slavery: "servitude", bondage: "servitude", thrall: "servitude",
  drug: "addiction", drugs: "addiction", dependence: "addiction", compulsion: "addiction", greed: "corruption", pact: "corruption", taint: "corruption",
  sacrilege: "desecration", blasphemy: "desecration", defilement: "desecration", treachery: "betrayal", treason: "betrayal", backstab: "betrayal",
  destruction: "ruin", devastation: "ruin", arson: "ruin"
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
export function repairProposal(proposal, { systemId = "pf2e", actorLevel, grandDesignLevel, systemLabel, customSynonyms = {}, allowRed = true } = {}) {
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
  return {
    proposal: { kind, entry, evidence, ...(proposal.theme ? { theme: proposal.theme } : {}) },
    repairs
  };
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
 * @returns {Promise<{events, proposals, themes, skippedEvents, skippedProposals, diagnostics}>}
 */
export async function runGatewayPipeline({ transport, request, config = {}, validators = {}, systemId, sleep } = {}) {
  const started = nowMs();
  const cfg = normalizeGatewayConfig(config);
  const sysId = systemId ?? cfg.systemId ?? request?.actor?.system ?? "pf2e";
  const validate = {
    skill: validators.validateSkillEntry ?? defaultValidateSkill,
    class: validators.validateClassEntry ?? defaultValidateClass
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

  const skippedEvents = [];
  const skippedProposals = [];
  let events = [];
  const proposalBatches = [];

  if (!chunks.length) {
    diagnostics.totalMs = Math.round(nowMs() - started);
    return { events: [], proposals: [], themes: [], skippedEvents, skippedProposals, diagnostics };
  }

  // ---- extraction (or single combined call) per chunk ----
  const failures = [];
  const queue = chunks.map((text, index) => ({ text, index, depth: 0 }));
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

  events = dedupeEvents(events);

  // ---- proposals ----
  let proposals = [];
  if (cfg.pipeline === "single") {
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
    const decision = shouldPropose(events, request, cfg);
    diagnostics.proposalStage = { ran: decision.run, reason: decision.reason };
    if (decision.run) {
      try {
        const result = await proposeStage(events, decision, ctx);
        proposals = result.accepted;
        skippedProposals.push(...result.skipped);
      } catch (error) {
        // Never lose good events because the optional proposal stage failed.
        if (error instanceof AiProviderUnreachableError || error instanceof AiProviderTimeoutError) diagnostics.warnings.push(`proposal stage failed: ${error.message}`);
        skippedProposals.push({ reason: "proposal-stage-failed", error: error.message });
      }
    }
  }

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

function coerceAll(items, ctx, chunkIndex) {
  const accepted = [];
  const rejected = [];
  for (const raw of items) {
    const result = coerceEvent(raw, { customSynonyms: ctx.cfg.customSynonyms, emergentThemes: ctx.cfg.emergentThemes });
    if (result.event) {
      accepted.push(result.event);
      for (const c of result.coercions) ctx.diagnostics.coercions.push(c);
    } else {
      rejected.push({ event: raw, reason: result.rejected, chunk: chunkIndex });
    }
  }
  return { accepted, rejected };
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
    const { accepted, rejected } = coerceAll(located.items, ctx, job.index);
    const candidate = { events: accepted, skipped: rejected };
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
    const total = located.items.length;
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
    const { accepted, rejected } = coerceAll(locatedEvents.items, ctx, job.index);
    const candidate = { events: accepted, skipped: rejected, proposalBatch: batchFor(locatedProposals, messages, response, stage, cfg) };
    if (!best || candidate.events.length > best.events.length) best = candidate;
    const total = locatedEvents.items.length;
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

async function proposeStage(events, decision, ctx) {
  const { transport, request, cfg, diagnostics } = ctx;
  const stage = { stage: "propose", chunk: null, attempts: 0, ms: 0, repairs: [], errors: [] };
  diagnostics.stages.push(stage);
  const mustPropose = cfg.proposalMode === "always" || String(decision.reason ?? "").startsWith("grant-allowances");
  const messages = buildProposalMessages({ request, config: cfg, events, themeEvidence: decision.themeEvidence, tagEvidence: decision.tagEvidence, allowClass: decision.allowClass, mustPropose });
  const temperature = creativityTemperature(cfg);
  let items = null;
  let lastContent = "";
  for (let attempt = 0; attempt <= cfg.maxRepairAttempts; attempt += 1) {
    stage.attempts += 1;
    const response = await transport.chat({ messages, schema: PROPOSAL_SCHEMA, temperature, maxTokens: cfg.numPredict });
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
    messages.push(assistantEcho(response.content));
    break;
  }
  if (items === null) {
    return { accepted: [], skipped: [{ reason: "unparseable-proposal-response", errors: stage.errors.slice(-3), raw: String(lastContent).slice(0, 1000) }] };
  }
  const checked = await validateProposals(items, { messages, stage, temperature }, ctx);
  const gated = gateProposals(checked.accepted, ctx);
  return { accepted: gated.final, skipped: [...checked.skipped, ...gated.skipped] };
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
      const response = await transport.chat({ messages: conversation.messages, schema: PROPOSAL_SCHEMA, temperature: conversation.temperature, maxTokens: cfg.numPredict });
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

/** Class gating, dedupe against the registry and each other, and the maxProposals cap. */
function gateProposals(accepted, ctx) {
  const { request, cfg } = ctx;
  const gd = request?.actor?.grandDesign ?? {};
  const skipped = [];
  const registry = request?.actor?.existingGrandDesign ?? {};
  const existing = new Set([
    ...Object.values(registry.classes ?? {}).map((e) => slugifyTheme(e?.name)),
    ...Object.values(registry.skills ?? {}).map((e) => slugifyTheme(e?.name))
  ].filter(Boolean));
  const final = [];
  for (const proposal of accepted) {
    const key = slugifyTheme(proposal.entry.name);
    if (proposal.kind === "class" && gd.classEvolutionAvailable !== true) { skipped.push({ proposal, reason: "class-evolution-not-available" }); continue; }
    if (existing.has(key)) { skipped.push({ proposal, reason: "already-exists" }); continue; }
    if (final.length >= cfg.maxProposals) { skipped.push({ proposal, reason: "over-max-proposals" }); continue; }
    existing.add(key);
    final.push(proposal);
  }
  return { final, skipped };
}
