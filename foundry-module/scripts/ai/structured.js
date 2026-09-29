// Structured mechanics for a proposal: `entry.mechanics.structured` (batch-3 contract section 2).
//
// Why: an approved Skill used to become a description-only Item. The prose effect ("deal 2d6 fire
// damage, basic Reflex save") was right, but nothing on the sheet could roll it. The model now writes
// the numbers a system adapter can turn into real item data (PF2e rule elements / @Damage, dnd5e
// activities / Active Effects) ALONGSIDE the prose -- and because this model follows schema fields far
// better than prompt rules, the vocabulary is enforced by the JSON Schema per system (a PF2e proposal
// cannot even emit a "dex" save or "advantage"; a 5e one cannot emit "off-guard" or a basic save).
//
// Division of labour: this file checks SHAPE and maps each system's words onto the agreed
// vocabulary (a field that cannot be read is dropped and reported, never guessed). validator.js
// (dev-systems) clamps the numbers by tier and level. Pure ESM, zero Foundry globals.

export const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"];

export const STRUCTURED_SAVES = {
  pf2e: ["fortitude", "reflex", "will"],
  dnd5e: ABILITIES
};

// Skill slugs are the full lowercase-hyphenated names on BOTH systems ("skill:sleight-of-hand"); an
// adapter that needs the dnd5e sheet key reads DND5E_SKILL_KEYS. Perception is its own selector
// ("perception") on both, as in the contract.
export const STRUCTURED_SKILLS = {
  pf2e: ["acrobatics", "arcana", "athletics", "crafting", "deception", "diplomacy", "intimidation", "medicine", "nature", "occultism", "performance", "religion", "society", "stealth", "survival", "thievery"],
  dnd5e: ["acrobatics", "animal-handling", "arcana", "athletics", "deception", "history", "insight", "intimidation", "investigation", "medicine", "nature", "performance", "persuasion", "religion", "sleight-of-hand", "stealth", "survival"]
};

export const DND5E_SKILL_KEYS = {
  acrobatics: "acr", "animal-handling": "ani", arcana: "arc", athletics: "ath", deception: "dec", history: "his", insight: "ins",
  intimidation: "itm", investigation: "inv", medicine: "med", nature: "nat", perception: "prc", performance: "prf", persuasion: "per",
  religion: "rel", "sleight-of-hand": "slt", stealth: "ste", survival: "sur"
};

export const STRUCTURED_DAMAGE_TYPES = {
  pf2e: ["acid", "bludgeoning", "cold", "electricity", "fire", "force", "mental", "piercing", "poison", "slashing", "sonic", "spirit", "vitality", "void", "bleed"],
  dnd5e: ["acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic", "piercing", "poison", "psychic", "radiant", "slashing", "thunder"]
};

// Condition ids as each system's Foundry data names them.
export const STRUCTURED_CONDITIONS = {
  pf2e: ["blinded", "broken", "clumsy", "concealed", "confused", "controlled", "dazzled", "deafened", "doomed", "drained", "dying", "encumbered", "enfeebled", "fascinated", "fatigued", "fleeing", "frightened", "grabbed", "hidden", "immobilized", "invisible", "off-guard", "paralyzed", "persistent-damage", "petrified", "prone", "quickened", "restrained", "sickened", "slowed", "stunned", "stupefied", "unconscious", "undetected", "wounded"],
  dnd5e: ["blinded", "charmed", "deafened", "exhaustion", "frightened", "grappled", "incapacitated", "invisible", "paralyzed", "petrified", "poisoned", "prone", "restrained", "stunned", "unconscious"]
};
// Conditions that carry a number (frightened 2, exhaustion 3); the value is dropped on the others.
const VALUED_CONDITIONS = {
  pf2e: new Set(["clumsy", "doomed", "drained", "dying", "enfeebled", "frightened", "sickened", "slowed", "stunned", "stupefied", "wounded"]),
  dnd5e: new Set(["exhaustion"])
};

export const STRUCTURED_AREAS = {
  pf2e: ["cone", "burst", "emanation", "line"],
  dnd5e: ["cone", "sphere", "cube", "cylinder", "line", "emanation"]
};

export const STRUCTURED_USES_PERIODS = {
  pf2e: ["turn", "round", "encounter", "hour", "day"],
  dnd5e: ["turn", "short-rest", "long-rest", "day"]
};

const ALL = (map) => [...new Set(Object.values(map).flat())];
const MODIFIER_TYPES = { pf2e: ["circumstance", "status", "item", "untyped"], dnd5e: ["untyped", "item"] };
const SYSTEMS = new Set(["pf2e", "dnd5e"]);
const sys = (systemId) => (SYSTEMS.has(systemId) ? systemId : null);

/** Every selector a modifier may target on this system (contract: ac|attack|damage|perception|initiative|save:x|skill:x). */
export function modifierSelectors(systemId) {
  const id = sys(systemId);
  const saves = id ? STRUCTURED_SAVES[id] : ALL(STRUCTURED_SAVES);
  const skills = id ? STRUCTURED_SKILLS[id] : ALL(STRUCTURED_SKILLS);
  return ["ac", "attack", "damage", "perception", "initiative", ...saves.map((s) => `save:${s}`), ...skills.map((s) => `skill:${s}`)];
}

/** What dnd5e advantage may apply to (contract: attack|save:x|skill:x|check:ability). */
export function advantageTargets() {
  return ["attack", ...ABILITIES.map((a) => `save:${a}`), ...STRUCTURED_SKILLS.dnd5e.map((s) => `skill:${s}`), "skill:perception", ...ABILITIES.map((a) => `check:${a}`)];
}

/**
 * JSON Schema for `mechanics.structured`, with this system's vocabulary as enums (a grammar-level
 * guarantee the model writes "reflex" in PF2e and "dex" in 5e). Unknown system -> the contract's
 * superset. Every sub-field is optional: a passive aura has no damage, and a required field is one a
 * small model fills with nonsense rather than leave out.
 */
export function structuredMechanicsSchema(systemId) {
  const id = sys(systemId);
  const pick = (map) => (id ? map[id] : ALL(map));
  const dice = { type: "string" };
  const properties = {
    attack: { type: "object", properties: { kind: { type: "string", enum: ["melee", "ranged", "spell"] } }, required: ["kind"] },
    damage: {
      type: "array",
      maxItems: 3,
      items: { type: "object", properties: { dice, type: { type: "string", enum: pick(STRUCTURED_DAMAGE_TYPES) }, bonus: { type: "integer" } }, required: ["dice", "type"] }
    },
    heal: { type: "object", properties: { dice, bonus: { type: "integer" } }, required: ["dice"] },
    save: {
      type: "object",
      properties: {
        save: { type: "string", enum: pick(STRUCTURED_SAVES) },
        // "class"/"spell" or a number: sent as a string so every provider's grammar accepts it
        // ("15" is coerced to 15 below); anyOf support varies between backends.
        dc: { type: "string" },
        ...(id === "dnd5e" ? {} : { basic: { type: "boolean" } })
      },
      required: ["save", "dc"]
    },
    modifiers: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          value: { type: "integer" },
          type: { type: "string", enum: pick(MODIFIER_TYPES) },
          selector: { type: "string", enum: modifierSelectors(id) },
          predicate: { type: "string" }
        },
        required: ["value", "type", "selector"]
      }
    },
    ...(id === "pf2e" ? {} : {
      advantage: { type: "object", properties: { on: { type: "string", enum: advantageTargets() }, condition: { type: "string" } }, required: ["on"] }
    }),
    range: { type: "object", properties: { value: { type: "integer" }, units: { type: "string", enum: ["ft"] } }, required: ["value", "units"] },
    area: { type: "object", properties: { type: { type: "string", enum: pick(STRUCTURED_AREAS) }, value: { type: "integer" } }, required: ["type", "value"] },
    condition: { type: "object", properties: { id: { type: "string", enum: pick(STRUCTURED_CONDITIONS) }, value: { type: "integer" }, duration: { type: "string" } }, required: ["id"] },
    uses: { type: "object", properties: { max: { type: "integer" }, per: { type: "string", enum: pick(STRUCTURED_USES_PERIODS) } }, required: ["max", "per"] }
  };
  return { type: "object", properties };
}

// ---------------------------------------------------------------------------------------------
// Coercion: whatever the model wrote -> the contract shape, per system. Bad fields are dropped.
// ---------------------------------------------------------------------------------------------

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const plain = (v) => String(v ?? "").toLowerCase().trim().replace(/[_\s]+/g, " ");
const slug = (v) => plain(v).replace(/'/g, "").replace(/\s+/g, "-");

function toInt(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value === "string") {
    const m = /[-+]?\d+/.exec(value.replace(/\s+/g, ""));
    if (m) return Number(m[0]);
  }
  return undefined;
}

const SAVE_WORDS = [
  [/^(fort|fortitude|fortitude save)/, "fortitude"], [/^(ref|reflex)/, "reflex"], [/^will/, "will"],
  [/^str(ength)?\b/, "str"], [/^dex(terity)?\b/, "dex"], [/^con(stitution)?\b/, "con"],
  [/^int(elligence)?\b/, "int"], [/^wis(dom)?\b/, "wis"], [/^cha(risma)?\b/, "cha"]
];
// A save written in the other system's terms has one obvious counterpart.
const SAVE_TO_PF2E = { str: "fortitude", con: "fortitude", dex: "reflex", int: "will", wis: "will", cha: "will" };
const SAVE_TO_DND5E = { fortitude: "con", reflex: "dex", will: "wis" };

function coerceSave(raw, id) {
  const p = plain(raw).replace(/\b(saving throw|save|throw|check|basic)\b/g, "").trim();
  const found = SAVE_WORDS.find(([pattern]) => pattern.test(p))?.[1];
  if (!found) return undefined;
  if (id === "pf2e") return STRUCTURED_SAVES.pf2e.includes(found) ? found : SAVE_TO_PF2E[found];
  if (id === "dnd5e") return ABILITIES.includes(found) ? found : SAVE_TO_DND5E[found];
  return found;
}

function coerceAbility(raw) {
  const found = SAVE_WORDS.find(([pattern]) => pattern.test(plain(raw)))?.[1];
  return ABILITIES.includes(found) ? found : SAVE_TO_DND5E[found];
}

const SKILL_ALIASES = {
  craft: "crafting", crafting: "crafting", "sleight of hand": "sleight-of-hand", sleight: "sleight-of-hand", "animal handling": "animal-handling",
  persuade: "persuasion", persuasion: "persuasion", diplomacy: "diplomacy", intimidate: "intimidation", stealthy: "stealth", thieves: "thievery",
  lore: "history", investigate: "investigation", insightful: "insight", occult: "occultism", perform: "performance", medic: "medicine"
};
// Each system's skill for the other system's name, where there is one.
const SKILL_TO_PF2E = { persuasion: "diplomacy", "sleight-of-hand": "thievery", "animal-handling": "nature", history: "society", investigation: "society", insight: null };
const SKILL_TO_DND5E = { diplomacy: "persuasion", thievery: "sleight-of-hand", crafting: null, occultism: "arcana", society: "history" };
const DND5E_KEY_TO_SKILL = Object.fromEntries(Object.entries(DND5E_SKILL_KEYS).map(([name, key]) => [key, name]));

function coerceSkill(raw, id) {
  let p = plain(raw).replace(/\b(skill|checks?|rolls?)\b/g, "").trim();
  if (DND5E_KEY_TO_SKILL[p]) p = DND5E_KEY_TO_SKILL[p];
  p = SKILL_ALIASES[p] ?? p.replace(/\s+/g, "-");
  if (p === "perception") return "perception";
  const lists = id ? [id] : ["pf2e", "dnd5e"];
  if (lists.some((l) => STRUCTURED_SKILLS[l].includes(p))) return p;
  const mapped = id === "pf2e" ? SKILL_TO_PF2E[p] : id === "dnd5e" ? SKILL_TO_DND5E[p] : undefined;
  return mapped && STRUCTURED_SKILLS[id].includes(mapped) ? mapped : undefined;
}

function coerceSelector(raw, id) {
  const p = plain(raw).replace(/\b(rolls?|bonus|penalty|to|the|your|all)\b/g, " ").replace(/\s+/g, " ").trim();
  if (/^(ac|armor class|armour class|defense)$/.test(p)) return "ac";
  if (/^(attack|attacks|attack roll|strike|strikes|weapon attack|spell attack)$/.test(p)) return "attack";
  if (/^(damage|damage roll|weapon damage)$/.test(p)) return "damage";
  if (/^(perception|skill:perception|skill perception|prc)$/.test(p)) return "perception";
  if (/^(initiative|init)$/.test(p)) return "initiative";
  const [head, ...rest] = p.split(":");
  const tail = rest.join(":").trim();
  if (head === "save" || head === "saving throw") { const s = coerceSave(tail, id); return s ? `save:${s}` : undefined; }
  if (head === "skill" || head === "check") { const s = coerceSkill(tail, id); return s === "perception" ? "perception" : s ? `skill:${s}` : undefined; }
  const save = /\b(save|saving throw|saves)\b/.test(p) ? coerceSave(p, id) : undefined;
  if (save) return `save:${save}`;
  const skill = coerceSkill(p, id);
  if (skill) return skill === "perception" ? "perception" : `skill:${skill}`;
  return undefined;
}

function coerceAdvantageTarget(raw) {
  const p = plain(raw).replace(/\b(advantage|on|the|your|rolls?)\b/g, " ").replace(/\s+/g, " ").trim();
  if (/^(attack|attacks|attack roll|weapon attack|spell attack)$/.test(p)) return "attack";
  const [head, ...rest] = p.split(":");
  const tail = rest.join(":").trim();
  if (head === "check" && coerceAbility(tail) && !coerceSkill(tail, "dnd5e")) return `check:${coerceAbility(tail)}`;
  if (head === "save" || /\b(save|saving throw)\b/.test(p)) { const s = coerceSave(tail || p, "dnd5e"); return s ? `save:${s}` : undefined; }
  const skill = coerceSkill(tail || p, "dnd5e");
  if (skill) return `skill:${skill}`;
  const ability = coerceAbility(tail || p);
  return ability ? `check:${ability}` : undefined;
}

const DAMAGE_SYNONYMS = {
  slash: "slashing", slashes: "slashing", pierce: "piercing", blunt: "bludgeoning", bludgeon: "bludgeoning", crushing: "bludgeoning",
  flame: "fire", flames: "fire", burning: "fire", burn: "fire", heat: "fire", frost: "cold", ice: "cold", freezing: "cold",
  electric: "electricity", shock: "electricity", acidic: "acid", poisonous: "poison", venom: "poison", toxic: "poison",
  sound: "sonic", psychic: "psychic", mental: "mental", holy: "spirit", unholy: "spirit", positive: "vitality", negative: "void", bleeding: "bleed", persistent: "bleed"
};
const DAMAGE_TO_PF2E = { lightning: "electricity", thunder: "sonic", psychic: "mental", radiant: "vitality", necrotic: "void" };
const DAMAGE_TO_DND5E = { electricity: "lightning", sonic: "thunder", mental: "psychic", vitality: "radiant", spirit: "radiant", void: "necrotic" };

function coerceDamageType(raw, id) {
  let p = plain(raw).replace(/\bdamage\b/g, "").trim();
  p = DAMAGE_SYNONYMS[p] ?? p;
  if (id === "pf2e") p = DAMAGE_TO_PF2E[p] ?? p;
  if (id === "dnd5e") p = DAMAGE_TO_DND5E[p] ?? p;
  const allowed = id ? STRUCTURED_DAMAGE_TYPES[id] : ALL(STRUCTURED_DAMAGE_TYPES);
  return allowed.includes(p) ? p : undefined;
}

const DIE_FACES = new Set([2, 3, 4, 6, 8, 10, 12, 20]);
/** "2d6+3" -> { dice: "2d6", bonus: 3 }; a formula that is not N dice of a real die -> null. */
export function splitDice(raw) {
  const text = String(raw ?? "").replace(/\s+/g, "").toLowerCase();
  const m = /^(\d{0,2})d(\d{1,3})((?:[+-]\d+)*)$/.exec(text);
  if (!m) return null;
  const count = Number(m[1] || "1");
  const faces = Number(m[2]);
  if (count < 1 || count > 40 || !DIE_FACES.has(faces)) return null;
  const bonus = (m[3].match(/[+-]\d+/g) ?? []).reduce((sum, term) => sum + Number(term), 0);
  return { dice: `${count}d${faces}`, bonus };
}

function withBonus(out, bonus) {
  if (Number.isInteger(bonus) && bonus !== 0) out.bonus = bonus;
  return out;
}

const CONDITION_SYNONYMS = {
  "flat footed": "off-guard", flatfooted: "off-guard", "off guard": "off-guard", scared: "frightened", fear: "frightened", afraid: "frightened",
  grappled: "grappled", grabbed: "grabbed", knocked: "prone", "knocked prone": "prone", poisoned: "poisoned", sick: "sickened",
  blind: "blinded", deaf: "deafened", stun: "stunned", paralysed: "paralyzed", exhausted: "exhaustion", fatigue: "fatigued", slow: "slowed",
  "persistent damage": "persistent-damage", charmed: "charmed", fascinated: "fascinated"
};
const CONDITION_TO_PF2E = { grappled: "grabbed", charmed: "fascinated", poisoned: "sickened", exhaustion: "fatigued", incapacitated: "stunned" };
const CONDITION_TO_DND5E = { grabbed: "grappled", fascinated: "charmed", sickened: "poisoned", fatigued: "exhaustion", immobilized: "grappled", controlled: "charmed" };

function coerceConditionId(raw, id) {
  let p = plain(raw).replace(/[-]/g, " ").replace(/\s+\d+$/, "").trim();
  p = CONDITION_SYNONYMS[p] ?? p.replace(/\s+/g, "-");
  if (id === "pf2e") p = CONDITION_TO_PF2E[p] ?? p;
  if (id === "dnd5e") p = CONDITION_TO_DND5E[p] ?? p;
  const allowed = id ? STRUCTURED_CONDITIONS[id] : ALL(STRUCTURED_CONDITIONS);
  return allowed.includes(p) ? p : undefined;
}

const AREA_TO = {
  pf2e: { sphere: "burst", radius: "burst", circle: "burst", cube: "burst", square: "burst", cylinder: "burst", aura: "emanation" },
  dnd5e: { burst: "sphere", radius: "sphere", circle: "sphere", square: "cube", aura: "emanation" }
};

const USES_WORDS = [
  [/(short[- ]?rest|\bsr\b)/, "short-rest"], [/(long[- ]?rest|\blr\b)/, "long-rest"], [/(encounter|combat|fight|battle|scene)/, "encounter"],
  [/(turn)/, "turn"], [/(round)/, "round"], [/(hour|minute|min\b|10 ?min)/, "hour"], [/(day|daily|dawn|24)/, "day"]
];
const USES_TO = {
  pf2e: { "short-rest": "hour", "long-rest": "day" },
  dnd5e: { encounter: "short-rest", hour: "short-rest", round: "turn" }
};

function coerceRange(raw) {
  let value;
  let units = "ft";
  if (isObj(raw)) { value = raw.value ?? raw.distance ?? raw.feet; units = plain(raw.units ?? raw.unit ?? "ft"); }
  else if (typeof raw === "number" || typeof raw === "string") {
    value = raw;
    const u = /(m|meters?|metres?|ft|feet|foot)\b/.exec(plain(raw));
    if (u) units = u[1];
  }
  if (/^touch$/.test(plain(value))) value = 5;
  let n = toInt(value);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  if (/^(m|meters?|metres?)$/.test(units)) n = Math.max(5, Math.round((n * 3.28) / 5) * 5);
  else if (!/^(ft|feet|foot|')$/.test(units || "ft")) return undefined;
  return n <= 10000 ? { value: n, units: "ft" } : undefined;
}

/**
 * Probe 2026-09-29 (qwen3.8:27b, both systems): the model routinely leaves out a damage roll or save
 * its OWN effect text states ("Each creature in a 15-foot burst takes 1d6 fire damage (basic Reflex
 * save against your spell DC)" came back as {area, uses} only). Copying those two out of the prose is
 * not guessing -- the numbers are the model's -- so damage and save are filled from the effect when
 * missing. Conditions are not: "is no longer frightened" reads the same to a regex.
 * @returns {{ structured: object|null, filled: string[] }}
 */
export function fillStructuredFromEffect(effect, structured, { systemId } = {}) {
  const id = sys(systemId);
  const text = String(effect ?? "");
  const out = structured ? { ...structured } : {};
  const filled = [];
  if (!out.damage) {
    const parts = [];
    for (const m of text.matchAll(/(\d{1,2}d\d{1,3}(?:\s*[+-]\s*\d+)?)\s+(?:points? of\s+)?([a-z]+)\s+damage/gi)) {
      const split = splitDice(m[1]);
      const type = coerceDamageType(m[2], id);
      if (split && type && !parts.some((p) => p.dice === split.dice && p.type === type)) parts.push(withBonus({ dice: split.dice, type }, split.bonus));
    }
    if (parts.length) { out.damage = parts.slice(0, 3); filled.push("damage"); }
  }
  if (!out.save) {
    const m = id === "dnd5e"
      ? /\b(strength|dexterity|constitution|intelligence|wisdom|charisma)\s+saving throw/i.exec(text)
      : /\b(basic\s+)?(fortitude|reflex|will)\s+sav(?:e|ing throw)/i.exec(text);
    // "advantage on Dexterity saving throws" / "+1 bonus to Will saves" buff a save; they are not a
    // save the ability forces on someone.
    const buffed = m && /(advantage|disadvantage|bonus|penalty|resistance)[^.]{0,30}$/i.test(text.slice(0, m.index));
    if (m && !buffed) {
      const save = coerceSave(id === "dnd5e" ? m[1] : m[2], id);
      const dcNum = /\bDC\s*(\d{1,2})\b/.exec(text);
      const dc = /spell (?:save )?DC/i.test(text) ? "spell" : dcNum ? Number(dcNum[1]) : "class";
      if (save) {
        out.save = { save, dc, ...(id !== "dnd5e" && m[1] ? { basic: true } : {}) };
        filled.push("save");
      }
    }
  }
  return { structured: Object.keys(out).length ? out : null, filled };
}

/**
 * Shape-check and map `mechanics.structured` for one system.
 * @returns {{ structured: object|null, dropped: string[], coercions: string[] }}
 */
export function coerceStructuredMechanics(raw, { systemId } = {}) {
  const id = sys(systemId);
  const dropped = [];
  const coercions = [];
  if (raw === undefined || raw === null) return { structured: null, dropped, coercions };
  if (!isObj(raw)) return { structured: null, dropped: ["structured:not-an-object"], coercions };
  const out = {};
  const drop = (field, why) => dropped.push(`${field}:${why}`);

  if (raw.attack !== undefined) {
    const k = plain(isObj(raw.attack) ? raw.attack.kind ?? raw.attack.type : raw.attack);
    const kind = /spell/.test(k) ? "spell" : /(ranged|bow|throw|shot|shoot)/.test(k) ? "ranged" : /(melee|weapon|strike|unarmed|reach)/.test(k) ? "melee" : undefined;
    if (kind) out.attack = { kind }; else drop("attack", "unknown-kind");
  }

  if (raw.damage !== undefined) {
    const parts = (Array.isArray(raw.damage) ? raw.damage : [raw.damage]).slice(0, 4);
    const kept = [];
    for (const part of parts) {
      const formula = isObj(part) ? part.dice ?? part.formula ?? part.amount : part;
      const split = splitDice(formula);
      const type = coerceDamageType(isObj(part) ? part.type ?? part.damageType : undefined, id);
      if (!split) { drop("damage", `bad-dice:${JSON.stringify(formula ?? null)}`); continue; }
      if (!type) { drop("damage", `bad-type:${JSON.stringify(isObj(part) ? part.type ?? null : null)}`); continue; }
      const extra = isObj(part) ? toInt(part.bonus) ?? 0 : 0;
      kept.push(withBonus({ dice: split.dice, type }, split.bonus + extra));
    }
    if (kept.length) out.damage = kept.slice(0, 3);
  }

  if (raw.heal !== undefined) {
    const formula = isObj(raw.heal) ? raw.heal.dice ?? raw.heal.formula ?? raw.heal.amount : raw.heal;
    const split = splitDice(formula);
    if (split) out.heal = withBonus({ dice: split.dice }, split.bonus + ((isObj(raw.heal) ? toInt(raw.heal.bonus) : 0) ?? 0));
    else drop("heal", `bad-dice:${JSON.stringify(formula ?? null)}`);
  }

  if (raw.save !== undefined) {
    const s = isObj(raw.save) ? raw.save : { save: raw.save };
    const save = coerceSave(s.save ?? s.type ?? s.ability, id);
    if (!save) drop("save", `unknown-save:${JSON.stringify(s.save ?? null)}`);
    else {
      const dcText = plain(s.dc);
      let dc;
      if (/class/.test(dcText)) dc = "class";
      else if (/spell/.test(dcText)) dc = "spell";
      else {
        const n = toInt(s.dc);
        if (Number.isInteger(n) && n >= 5 && n <= 60) dc = n;
      }
      if (dc === undefined) { dc = "class"; coercions.push(`save.dc:${JSON.stringify(s.dc ?? null)}->class`); }
      const basicWord = /\bbasic\b/.test(plain(s.save));
      const basic = s.basic === true || s.basic === "true" || basicWord;
      out.save = { save, dc, ...(id !== "dnd5e" && basic ? { basic: true } : {}) };
      if (id === "dnd5e" && basic) coercions.push("save.basic-dropped:dnd5e");
    }
  }

  if (raw.modifiers !== undefined) {
    const list = (Array.isArray(raw.modifiers) ? raw.modifiers : [raw.modifiers]).slice(0, 6);
    const kept = [];
    for (const mod of list) {
      if (!isObj(mod)) { drop("modifiers", "not-an-object"); continue; }
      const value = toInt(mod.value ?? mod.bonus ?? mod.amount);
      if (!Number.isInteger(value) || value === 0 || Math.abs(value) > 20) { drop("modifiers", `bad-value:${JSON.stringify(mod.value ?? null)}`); continue; }
      const rawSelector = mod.selector ?? mod.target ?? mod.on ?? mod.to;
      const selector = coerceSelector(rawSelector, id);
      if (!selector) { drop("modifiers", `bad-selector:${JSON.stringify(rawSelector ?? null)}`); continue; }
      let type = plain(mod.type ?? "untyped");
      if (!["circumstance", "status", "item", "untyped"].includes(type)) type = "untyped";
      // 5e has no bonus types: a "circumstance bonus" there is just a bonus.
      if (id === "dnd5e" && (type === "circumstance" || type === "status")) { coercions.push(`modifier.type:${type}->untyped`); type = "untyped"; }
      const predicate = typeof mod.predicate === "string" && mod.predicate.trim() ? mod.predicate.trim().slice(0, 200) : undefined;
      kept.push({ value, type, selector, ...(predicate ? { predicate } : {}) });
    }
    if (kept.length) out.modifiers = kept.slice(0, 4);
  }

  if (raw.advantage !== undefined) {
    if (id === "pf2e") drop("advantage", "not-a-pf2e-mechanic");
    else {
      const a = isObj(raw.advantage) ? raw.advantage : { on: raw.advantage };
      const on = coerceAdvantageTarget(a.on ?? a.target ?? a.roll);
      if (on) out.advantage = { on, ...(typeof a.condition === "string" && a.condition.trim() ? { condition: a.condition.trim().slice(0, 200) } : {}) };
      else drop("advantage", `bad-target:${JSON.stringify(a.on ?? null)}`);
    }
  }

  if (raw.range !== undefined) {
    const range = coerceRange(raw.range);
    if (range) out.range = range; else drop("range", `bad-range:${JSON.stringify(raw.range)}`);
  }

  if (raw.area !== undefined) {
    const a = isObj(raw.area) ? raw.area : {};
    let type = plain(a.type ?? a.shape);
    if (id) type = AREA_TO[id][type] ?? type;
    const allowed = id ? STRUCTURED_AREAS[id] : ALL(STRUCTURED_AREAS);
    const value = toInt(a.value ?? a.size ?? a.radius ?? a.length);
    if (allowed.includes(type) && Number.isInteger(value) && value > 0 && value <= 1000) out.area = { type, value };
    else drop("area", `bad-area:${JSON.stringify(raw.area)}`);
  }

  if (raw.condition !== undefined) {
    const c = isObj(raw.condition) ? raw.condition : { id: raw.condition };
    const rawId = c.id ?? c.slug ?? c.name ?? c.condition;
    const cid = coerceConditionId(rawId, id);
    if (!cid) drop("condition", `unknown-condition:${JSON.stringify(rawId ?? null)}`);
    else {
      const valued = id ? VALUED_CONDITIONS[id].has(cid) : VALUED_CONDITIONS.pf2e.has(cid) || VALUED_CONDITIONS.dnd5e.has(cid);
      let value = toInt(c.value ?? (/\d+$/.exec(String(rawId ?? ""))?.[0]));
      if (valued) value = Math.min(6, Math.max(1, Number.isInteger(value) ? value : 1));
      const duration = typeof c.duration === "string" && c.duration.trim() ? c.duration.trim().slice(0, 120) : undefined;
      out.condition = { id: cid, ...(valued ? { value } : {}), ...(duration ? { duration } : {}) };
    }
  }

  if (raw.uses !== undefined) {
    const u = isObj(raw.uses) ? raw.uses : { max: raw.uses, per: raw.uses };
    const max = toInt(u.max ?? u.uses ?? u.count);
    const text = plain(u.per ?? u.period ?? u.recovery);
    let per = USES_WORDS.find(([pattern]) => pattern.test(text))?.[1];
    if (per && id) per = USES_TO[id][per] ?? per;
    const allowed = id ? STRUCTURED_USES_PERIODS[id] : ALL(STRUCTURED_USES_PERIODS);
    if (Number.isInteger(max) && max >= 1 && max <= 99 && allowed.includes(per)) out.uses = { max, per };
    else drop("uses", `bad-uses:${JSON.stringify(raw.uses)}`);
  }

  return { structured: Object.keys(out).length ? out : null, dropped, coercions };
}
