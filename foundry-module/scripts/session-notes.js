import { validateGrowthEvent } from "./progression.js";

const TAG_PATTERNS = [
  ["water", /\b(canal|river|flood|water|sluice|rain|tide)\b/i],
  ["mobility", /\b(cross(?:ed|ing)?|climb(?:ed|ing)?|run(?:ning)?|leap(?:ed|ing)?|jump(?:ed|ing)?|sw(?:am|im|imming)|stride|escape(?:d|ing)?)\b/i],
  ["craft", /\b(craft(?:ed|ing)?|repair(?:ed|ing)?|build(?:ing)?|cook(?:ed|ing)?|prepare(?:d|ing)?)\b/i],
  ["support", /\b(help(?:ed|ing)?|aid(?:ed|ing)?|rescu(?:e|ed|ing)|heal(?:ed|ing)?|protect(?:ed|ing)?|support(?:ed|ing)?)\b/i],
  ["martial", /\b(strike|struck|attack(?:ed|ing)?|fight(?:ing)?|battle|defend(?:ed|ing)?)\b/i],
  ["precision", /\b(aim(?:ed|ing)?|precise|careful|weak point|targeted)\b/i],
  ["fire", /\b(fire|flame|ember|burn(?:ed|ing)?)\b/i],
  ["spellcasting", /\b(spell|cast(?:ing)?|magic|arcane|primal)\b/i]
];

export function analyzeSessionNotes(note) {
  if (typeof note !== "string" || !note.trim()) {
    throw new Error("Session notes must be non-empty text.");
  }
  return note
    .split(/(?<=[.!?])\s+/)
    .map((sentence, index) => eventFromSentence(sentence, index))
    .filter(Boolean);
}

export function validateAdapterEvents(output) {
  const events = Array.isArray(output) ? output : output?.events;
  if (!Array.isArray(events)) {
    throw new Error("A proposal adapter must return an event array or an object with events.");
  }
  for (const event of events) {
    const validation = validateGrowthEvent(event);
    if (!validation.valid) throw new Error(`Invalid adapter event: ${validation.errors.join(" ")}`);
  }
  return events;
}

function eventFromSentence(sentence, index) {
  const tags = TAG_PATTERNS
    .filter(([, pattern]) => pattern.test(sentence))
    .map(([tag]) => tag);
  const outcome = outcomeFromSentence(sentence);
  if (!tags.length || !outcome) return null;
  return {
    id: `note:${Date.now()}-${index}`,
    summary: sentence.trim(),
    tags,
    outcome
  };
}

function outcomeFromSentence(sentence) {
  if (/\b(critical(?:ly)?|exceptionally)\b/i.test(sentence)) return "criticalSuccess";
  if (/\b(succeed(?:ed|s)?|saved|rescu(?:ed|es)|completed|defeated|crossed|secured)\b/i.test(sentence)) {
    return "success";
  }
  return null;
}
