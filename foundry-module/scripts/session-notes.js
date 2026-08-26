import { validateGrowthEvent } from "./progression.js";
import { dangerGapFromSentence, describesNoAction, GROWTH_TAXONOMY, outcomeFromSentence } from "./growth-taxonomy.js";

// What a tagged sentence with no explicit outcome wording is worth. A GM who writes "Kesh parried
// the guard's blade and drove him into the canal" has recorded something the character DID; there
// is no reason to demand they also write the word "succeeded" before it counts.
//
// This used to be a hard gate -- eventFromSentence required BOTH a tag and an outcome match, and
// outcomeFromSentence only recognizes about twenty literal verbs (succeeded/saved/rescued/
// completed/defeated/crossed/secured/solved/won plus failure wording). Measured against a
// 30-sentence sample of ordinary session notes, ZERO sentences contained one of those words, so
// every sentence was silently discarded and the analyzer returned no events at all. Outcome
// wording is now a REFINEMENT that upgrades or downgrades an event (to criticalSuccess, failure,
// or criticalFailure) rather than a precondition for the event existing.
const DEFAULT_OUTCOME = "success";

export function analyzeSessionNotes(note) {
  return explainSessionNotes(note).events;
}

/**
 * The same analysis as analyzeSessionNotes, but reporting how it got there: how many sentences were
 * read, how many matched a gameplay tag, how many carried explicit outcome wording, and -- most
 * importantly -- exactly which sentences were dropped and why.
 *
 * This exists because the failure mode that matters here is silent: a GM pastes thirty sentences,
 * gets zero events back, and has no way to tell whether the notes were unusable, the tag vocabulary
 * missed everything, or the AI adapter they thought was configured never actually got wired up.
 * api.js#analyzeSessionNotes surfaces this on its result so "0 events" always comes with a reason.
 */
export function explainSessionNotes(note) {
  if (typeof note !== "string" || !note.trim()) {
    throw new Error("Session notes must be non-empty text.");
  }
  const sentences = note.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim());
  const events = [];
  const dropped = [];
  let outcomeMatched = 0;

  sentences.forEach((sentence, index) => {
    const tags = GROWTH_TAXONOMY.filter(([, pattern]) => pattern.test(sentence)).map(([tag]) => tag);
    const explicitOutcome = outcomeFromSentence(sentence);
    if (explicitOutcome) outcomeMatched += 1;

    if (!tags.length) {
      dropped.push({ sentence: sentence.trim(), reason: "no-gameplay-tag" });
      return;
    }
    if (describesNoAction(sentence)) {
      dropped.push({ sentence: sentence.trim(), reason: "describes-no-action", tags });
      return;
    }
    const dangerGap = dangerGapFromSentence(sentence);
    events.push({
      id: `note:${Date.now()}-${index}`,
      summary: sentence.trim(),
      tags,
      outcome: explicitOutcome ?? DEFAULT_OUTCOME,
      outcomeInferred: !explicitOutcome,
      ...(dangerGap ? { dangerGap } : {})
    });
  });

  return {
    events,
    diagnostics: {
      sentences: sentences.length,
      kept: events.length,
      outcomeMatched,
      outcomeInferred: events.filter((event) => event.outcomeInferred).length,
      droppedNoTag: dropped.filter((entry) => entry.reason === "no-gameplay-tag").length,
      droppedNoAction: dropped.filter((entry) => entry.reason === "describes-no-action").length,
      // Capped: this is a diagnostic for a human reading a notification, not a full transcript.
      dropped: dropped.slice(0, 12),
      hint: buildHint(sentences.length, events.length, dropped)
    }
  };
}

function buildHint(sentenceCount, keptCount, dropped) {
  if (keptCount) return null;
  if (!sentenceCount) return "No sentences were found -- session notes need sentence-ending punctuation to be split up.";
  if (dropped.every((entry) => entry.reason === "no-gameplay-tag")) {
    return "No sentence mentioned anything in the gameplay tag vocabulary. The local analyzer is keyword-based; "
      + "naming the concrete action (parried, climbed, picked the lock, bound the wound) is what it keys on. "
      + "A configured AI provider reads the notes properly instead -- check that result.source says \"adapter\", not \"local\".";
  }
  return "Every sentence that matched a tag was framed as an intention or as background rather than as something "
    + "that actually happened at the table.";
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
