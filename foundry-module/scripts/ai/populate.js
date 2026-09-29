// The Populate stage of the AI gateway (board dee25a95).
//
// Why a stage of its own: Populate's dialog promised "uses your configured AI provider" but nothing
// ever registered a populate adapter, so every spawn came from the keyword generator. This is the same
// shape as the notes pipeline, cut down to one call: system-specific JSON Schema (Ollama `format` /
// OpenAI json_schema through transport.js), lenient JSON recovery, coercion, ONE repair turn, then a
// thrown PopulateAiError on total failure. It never falls back itself -- populate.js does that, so the
// GM is told why ("the AI provider timed out") instead of silently getting keyword output.
//
// The adapter returns raw entries in the system's own terms; populate.js turns them into spawn specs
// and clamps every number to the system's range for the level/CR (systems/npc-stats.js).
//
// Pure ESM, zero Foundry globals.

import { parseModelJson } from "./json-repair.js";
import { buildPopulateMessages } from "./prompts.js";
import { POPULATE_RIDERS, POPULATE_SIZES, POPULATE_WEAPON_KEYS, populateSchema } from "./schemas.js";

export const POPULATE_MAX_TOTAL = 20;
const KINDS = new Set(["npc", "monster", "item"]);

export class PopulateAiError extends Error {
  constructor(message, { cause = null, diagnostics = null } = {}) {
    super(message);
    this.name = "PopulateAiError";
    this.cause = cause;
    this.diagnostics = diagnostics;
  }
}

function text(value, max = 400) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function int(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function num(value) {
  if (typeof value === "string" && value.includes("/")) {
    const [a, b] = value.split("/").map(Number);
    return b ? a / b : null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function abilityBlock(value) {
  if (!value || typeof value !== "object") return null;
  const out = {};
  for (const key of ["str", "dex", "con", "int", "wis", "cha"]) {
    const n = int(value[key] ?? value[key.toUpperCase()]);
    if (n !== null) out[key] = n;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Coerces one model entry into the stage's plain shape. Unknown enums become null (populate.js picks a
 * default) rather than failing the entry: a "Large" size or a "longsword" weapon is still a usable
 * creature. Returns { entry, errors } -- errors only for things a repair turn can fix (no name).
 */
export function coercePopulateEntry(raw, systemId) {
  const errors = [];
  if (!raw || typeof raw !== "object") return { entry: null, errors: ["an entry is not an object"] };
  const kindRaw = text(raw.kind).toLowerCase();
  const kind = KINDS.has(kindRaw) ? kindRaw : /item|weapon|object/.test(kindRaw) ? "item" : /monster|beast|creature|undead/.test(kindRaw) ? "monster" : "npc";
  const name = text(raw.name, 80);
  if (!name) errors.push("entry has no name");
  // Singular only when the plural is not itself a key ("cutlass" must not become "cutlas").
  const weaponWord = text(raw.weapon).toLowerCase();
  const weaponRaw = POPULATE_WEAPON_KEYS.includes(weaponWord) ? weaponWord : weaponWord.replace(/s$/, "");
  const weaponAliases = { longsword: "sword", greatsword: "sword", broadsword: "sword", blade: "sword", scimitar: "cutlass", rapier: "shortsword", handaxe: "axe", battleaxe: "axe", greataxe: "axe", greatclub: "club", quarterstaff: "staff", longbow: "bow", shortbow: "bow", javelin: "spear", pike: "spear", morningstar: "mace", knife: "dagger" };
  const weaponKey = POPULATE_WEAPON_KEYS.includes(weaponRaw) ? weaponRaw : weaponAliases[weaponRaw] ?? null;
  const sizeRaw = text(raw.size).toLowerCase();
  const sizeAliases = { small: "sm", medium: "med", large: "lg", gargantuan: "grg" };
  const attack = raw.attack && typeof raw.attack === "object"
    ? { name: text(raw.attack.name, 60) || null, bonus: int(raw.attack.bonus), damage: text(raw.attack.damage, 30) || null, damageType: text(raw.attack.damageType, 30).toLowerCase() || null }
    : null;
  const entry = {
    kind,
    name,
    count: Math.min(POPULATE_MAX_TOTAL, Math.max(1, int(raw.count) ?? 1)),
    race: text(raw.race, 40).toLowerCase() || null,
    role: text(raw.role, 40) || null,
    creatureType: text(raw.creatureType, 40).toLowerCase() || null,
    size: POPULATE_SIZES.includes(sizeRaw) ? sizeRaw : sizeAliases[sizeRaw] ?? null,
    hp: int(raw.hp),
    ac: int(raw.ac),
    speed: int(raw.speed),
    dc: int(raw.dc),
    weaponKey,
    attack,
    bonus: Math.min(4, Math.max(0, int(raw.bonus) ?? 0)),
    rider: POPULATE_RIDERS.includes(text(raw.rider).toLowerCase()) && text(raw.rider).toLowerCase() !== "none" ? text(raw.rider).toLowerCase() : null,
    bio: text(raw.bio, 600),
    gdClass: text(raw.gdClass, 80) || null
  };
  if (systemId === "pf2e") {
    entry.level = int(raw.level);
    entry.perception = int(raw.perception);
    entry.saves = { fortitude: int(raw.fortitude), reflex: int(raw.reflex), will: int(raw.will) };
    entry.attributes = abilityBlock(raw.attributes);
  } else {
    entry.cr = num(raw.cr);
    entry.abilities = abilityBlock(raw.abilities);
  }
  if (kind !== "item" && systemId === "pf2e" && entry.level === null) errors.push(`"${name || "entry"}" has no level`);
  if (kind !== "item" && systemId !== "pf2e" && entry.cr === null) errors.push(`"${name || "entry"}" has no cr`);
  return { entry, errors };
}

/** Coerces a whole reply. Entries that cannot be used are dropped; the total count is capped. */
export function coercePopulateResult(value, systemId) {
  const list = Array.isArray(value?.entries) ? value.entries : Array.isArray(value) ? value : value && typeof value === "object" && value.name ? [value] : [];
  const entries = [];
  const errors = [];
  let total = 0;
  for (const raw of list) {
    const { entry, errors: entryErrors } = coercePopulateEntry(raw, systemId);
    errors.push(...entryErrors);
    if (!entry || !entry.name) continue;
    if (total >= POPULATE_MAX_TOTAL) break;
    entry.count = Math.min(entry.count, POPULATE_MAX_TOTAL - total);
    total += entry.count;
    entries.push(entry);
  }
  if (!list.length) errors.push("the reply has no entries array");
  return { entries, errors };
}

/**
 * Runs the populate stage once. Throws PopulateAiError (with the provider/transport error as `cause`)
 * when the provider fails or no usable entry survives a repair turn.
 */
export async function runPopulateStage({ transport, promptText, systemId = "dnd5e", partyLevel = null, config = {}, signal } = {}) {
  if (!transport || typeof transport.chat !== "function") throw new PopulateAiError("No AI transport is available.");
  const schema = populateSchema(systemId);
  const messages = buildPopulateMessages({ promptText, systemId, partyLevel, config });
  const temperature = Number.isFinite(config.temperature) ? Math.max(0.3, config.temperature) : 0.5;
  const maxTokens = Math.min(Number.isFinite(config.numPredict) ? config.numPredict : 3072, 4096);
  const maxRepairs = Number.isInteger(config.maxRepairAttempts) ? Math.min(1, config.maxRepairAttempts) : 1;
  const diagnostics = { calls: 0, repairs: 0, ms: 0, model: transport.info?.model ?? null, errors: [] };
  let lastErrors = [];
  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    let reply;
    try {
      reply = await transport.chat({ messages, schema, temperature, maxTokens, signal });
    } catch (error) {
      diagnostics.errors.push(error?.message ?? String(error));
      throw new PopulateAiError(`The AI provider failed: ${error?.message ?? error}`, { cause: error, diagnostics });
    }
    diagnostics.calls += 1;
    diagnostics.ms += Number(reply?.ms) || 0;
    let value;
    try {
      value = parseModelJson(reply?.content).value;
    } catch (error) {
      lastErrors = [`the reply was not JSON (${error.message})`];
    }
    if (value !== undefined) {
      const { entries, errors } = coercePopulateResult(value, systemId);
      if (entries.length) return { entries, diagnostics: { ...diagnostics, dropped: errors } };
      lastErrors = errors.length ? errors : ["no usable entries"];
    }
    diagnostics.errors.push(...lastErrors);
    if (attempt < maxRepairs) {
      diagnostics.repairs += 1;
      messages.push({ role: "assistant", content: String(reply?.content ?? "").slice(0, 4000) });
      const list = lastErrors.slice(0, 8).map((error) => `- ${error}`).join("\n");
      messages.push({ role: "user", content: `Your previous reply could not be used:\n${list}\nReply again with the COMPLETE JSON only: {"entries":[...]} with at least one entry, every entry with a name and every required number.` });
    }
  }
  throw new PopulateAiError(`The AI answer could not be used (${lastErrors.join("; ")}).`, { diagnostics });
}

/**
 * The populate adapter api.populate calls: `({ promptText, systemId, partyLevel }) -> { format, entries,
 * diagnostics }`. Built from the gateway adapter's own transport, so it follows every settings change
 * that rebuilds the gateway adapter (api.js#setProposalAdapter).
 */
export function createPopulateAdapter({ transport, config = {} } = {}) {
  if (!transport || typeof transport.chat !== "function") throw new Error("createPopulateAdapter needs a transport with chat().");
  const adapter = async ({ promptText, systemId, partyLevel = null, signal } = {}) => {
    const sys = systemId ?? config.systemId ?? "dnd5e";
    const { entries, diagnostics } = await runPopulateStage({ transport, promptText, systemId: sys, partyLevel, config, signal });
    return { format: "populate-entries", systemId: sys, entries, diagnostics };
  };
  adapter.isGatewayPopulate = true;
  adapter.transport = transport;
  return adapter;
}
