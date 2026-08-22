import { FREQUENCY_PERIODS, PF2E_ITEM_KINDS } from "./constants.js";

export function validateMechanics(entry, errors) {
  const item = entry.gameItem;
  const mechanics = entry.mechanics;
  if (!isRecord(item) || !PF2E_ITEM_KINDS.has(item.kind)) {
    errors.push(`[${entry.name}] requires gameItem.kind: feat, action, reaction, free, passive, spell, or weapon.`);
    return;
  }
  if (!isRecord(mechanics)) {
    errors.push(`[${entry.name}] requires a mechanics object.`);
    return;
  }
  if (!isNonEmptyString(mechanics.effect)) {
    errors.push(`[${entry.name}] mechanics.effect must state the tangible game benefit.`);
  }
  validateFrequency(entry.name, mechanics.frequency, errors);

  if (isActionable(item.kind)) validateAction(entry.name, item.kind, mechanics, errors);
  else validatePassive(entry.name, mechanics, errors);

  if (item.kind === "spell") {
    if (!Number.isInteger(item.rank) || item.rank < 0 || item.rank > 10) {
      errors.push(`[${entry.name}] spell rank must be an integer from 0 to 10.`);
    }
    if (!isNonEmptyString(item.tradition)) {
      errors.push(`[${entry.name}] spell requires a PF2e tradition.`);
    }
  }
  if (item.kind === "weapon") {
    if (!isDiceFormula(item.damage)) {
      errors.push(`[${entry.name}] weapon requires a dice damage formula such as 1d6+2.`);
    }
    if (!isNonEmptyString(item.damageType)) {
      errors.push(`[${entry.name}] weapon requires a damage type.`);
    }
  }
}

export function createMechanicsHtml(entry) {
  const { gameItem, mechanics } = entry;
  const parts = [
    `<p><strong>Effect:</strong> ${escapeHtml(mechanics.effect)}</p>`,
    `<p><strong>Frequency:</strong> ${formatFrequency(mechanics.frequency)}</p>`
  ];
  if (mechanics.duration) parts.push(`<p><strong>Duration:</strong> ${escapeHtml(mechanics.duration)}</p>`);
  if (mechanics.trigger) parts.push(`<p><strong>Trigger:</strong> ${escapeHtml(mechanics.trigger)}</p>`);
  if (mechanics.requirements) parts.push(`<p><strong>Requirements:</strong> ${escapeHtml(mechanics.requirements)}</p>`);
  if (mechanics.roll) {
    parts.push(
      `<p><strong>Resolution:</strong> ${escapeHtml(mechanics.roll.kind)} — [[/r ${escapeHtml(mechanics.roll.formula)}]]${mechanics.roll.dc ? ` vs. DC ${mechanics.roll.dc}` : ""}</p>`
    );
  }
  if (gameItem.kind === "weapon") {
    parts.push(`<p><strong>Weapon damage:</strong> [[/r ${escapeHtml(gameItem.damage)}]] ${escapeHtml(gameItem.damageType)}</p>`);
  }
  return parts.join("");
}

export function itemTypeFor(kind) {
  if (kind === "reaction" || kind === "free") return "action";
  if (kind === "passive") return "feat";
  return kind;
}

export function pf2eActionType(kind) {
  if (kind === "reaction") return "reaction";
  if (kind === "free") return "free";
  return "action";
}

function validateFrequency(name, frequency, errors) {
  if (!isRecord(frequency) || !Number.isInteger(frequency.max) || frequency.max < 1 || !FREQUENCY_PERIODS.has(frequency.per)) {
    errors.push(`[${name}] mechanics.frequency requires max >= 1 and a valid per value.`);
  }
}

function validateAction(name, kind, mechanics, errors) {
  if (!isRecord(mechanics.roll) || !isDiceFormula(mechanics.roll.formula) || !isNonEmptyString(mechanics.roll.kind)) {
    errors.push(`[${name}] ${kind} mechanics require a dice roll with kind and formula.`);
  }
  if (kind === "reaction" && !isNonEmptyString(mechanics.trigger)) {
    errors.push(`[${name}] reactions require a trigger.`);
  }
  if (kind === "action" && !Number.isInteger(mechanics.actions) || (kind === "action" && !(mechanics.actions >= 1 && mechanics.actions <= 3))) {
    errors.push(`[${name}] actions require an action cost from 1 to 3.`);
  }
}

function validatePassive(name, mechanics, errors) {
  if (!isNonEmptyString(mechanics.duration)) {
    errors.push(`[${name}] passive mechanics require a duration or explicit ongoing cadence.`);
  }
}

function isActionable(kind) {
  return ["action", "reaction", "free", "spell", "weapon"].includes(kind);
}

function isDiceFormula(value) {
  return typeof value === "string" && /^\d+d\d+(?:\s*[+-]\s*\d+)?$/i.test(value.trim());
}

function formatFrequency(frequency) {
  return `${frequency.max}/${frequency.per}`;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
