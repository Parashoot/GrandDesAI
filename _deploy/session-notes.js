import { validateGrowthEvent } from "./progression.js";
import { dangerGapFromSentence, GROWTH_TAXONOMY, outcomeFromSentence } from "./growth-taxonomy.js";

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
  const events = Array.isArray(output) ? output : output?.events ?? [];
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
  const tags = GROWTH_TAXONOMY
    .filter(([, pattern]) => pattern.test(sentence))
    .map(([tag]) => tag);
  const outcome = outcomeFromSentence(sentence);
  if (!tags.length || !outcome) return null;
  const dangerGap = dangerGapFromSentence(sentence);
  return {
    id: `note:${Date.now()}-${index}`,
    summary: sentence.trim(),
    tags,
    outcome,
    ...(dangerGap ? { dangerGap } : {})
  };
}
