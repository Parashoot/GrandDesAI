import { validateGrowthEvent } from "./progression.js";
import {
  dangerGapFromSentence,
  describesNoAction,
  GROWTH_TAXONOMY,
  isAmbientScenery,
  normalizeNoteText,
  outcomeFromSentence,
  splitNoteLines
} from "./growth-taxonomy.js";

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
  // An ellipsis ("..." or "…") is three-dots-as-one-mark, a pause within a continuing thought, not
  // three sentence endings -- but the naive split below saw the trailing "." of "hands... and then"
  // as an ordinary sentence boundary and cut the sentence right there. That matters here specifically
  // because it can separate an action from the very next clause stating how it turned out ("Torv
  // worked the lock with steady hands... and then his hands weren't so steady, and the pick snapped")
  // -- the action gets tagged with no visible outcome and defaults to success, and the actual failure
  // one clause later has no gameplay tag of its own to attach to. Found in a held-out complex-prose
  // pass (2026-09-06). Ellipses are masked before splitting and restored after.
  //
  // 2026-09-23: notes are first split into LINES (bullets, one-thing-per-line shorthand with no
  // final punctuation -- see growth-taxonomy.js#splitNoteLines), and only then into sentences on
  // punctuation. Before this, "- Kesh atacked the goblin\n- Mira sneeked past" was one "sentence".
  const ELLIPSIS_MARKER = " ELLIPSIS ";
  const sentences = splitNoteLines(note).flatMap((line) =>
    line
      .replace(/\.\.\.|…/g, ELLIPSIS_MARKER)
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.split(ELLIPSIS_MARKER).join("..."))
      .filter((sentence) => sentence.trim())
  );
  const events = [];
  const dropped = [];
  let outcomeMatched = 0;
  // Danger-gap language and the action it qualifies are often written as two separate sentences --
  // "We were badly outnumbered. Halvard struck the leader down anyway." -- rather than one. Because
  // tagging and dangerGap detection both used to run per-sentence with no memory between them, the
  // context-only sentence had no tag of its own, was dropped as no-gameplay-tag, and the dangerGap
  // it carried was gone by the time the next sentence recorded the actual event -- silently losing
  // exactly the signal constants.js#DANGER_GAP_MULTIPLIERS calls the highest-value kind of evidence
  // the system has. A held-out complex-prose pass (2026-09-06) found this pattern in several
  // realistic voices (technical/mechanical recaps, noir narration). Fixed with a small amount of
  // carry-forward: a dangerGap phrase seen in a sentence that produces no event of its own is held
  // and applied to the next event that doesn't already carry its own dangerGap, then cleared.
  let pendingDangerGap;

  sentences.forEach((sentence, index) => {
    // Matching runs on a normalized copy (typos in action words fixed, texting shorthand expanded
    // -- growth-taxonomy.js#normalizeNoteText); the event summary keeps the GM's own words.
    const text = normalizeNoteText(sentence);
    const tags = GROWTH_TAXONOMY.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag);
    const explicitOutcome = outcomeFromSentence(text);
    if (explicitOutcome) outcomeMatched += 1;
    const sentenceDangerGap = dangerGapFromSentence(text);

    if (!tags.length) {
      if (sentenceDangerGap) pendingDangerGap = sentenceDangerGap;
      dropped.push({ sentence: sentence.trim(), reason: "no-gameplay-tag" });
      return;
    }
    if (describesNoAction(text)) {
      if (sentenceDangerGap) pendingDangerGap = sentenceDangerGap;
      dropped.push({ sentence: sentence.trim(), reason: "describes-no-action", tags });
      return;
    }
    // "Rain hammered the tin roof all night" tags cleanly (water) without a single character doing
    // anything -- see growth-taxonomy.js#isAmbientScenery. Scene-setting isn't evidence of growth.
    if (isAmbientScenery(text, tags)) {
      if (sentenceDangerGap) pendingDangerGap = sentenceDangerGap;
      dropped.push({ sentence: sentence.trim(), reason: "ambient-scenery-only", tags });
      return;
    }
    const dangerGap = sentenceDangerGap ?? pendingDangerGap;
    pendingDangerGap = undefined; // consumed by this event (or superseded by its own dangerGap) either way
    events.push({
      id: `note:${Date.now()}-${index}`,
      summary: sentence.trim(),
      tags,
      outcome: explicitOutcome ?? DEFAULT_OUTCOME,
      outcomeInferred: !explicitOutcome,
      ...(dangerGap ? { dangerGap } : {}),
      source: "local"
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
      droppedAmbient: dropped.filter((entry) => entry.reason === "ambient-scenery-only").length,
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
  if (dropped.every((entry) => entry.reason === "ambient-scenery-only")) {
    return "Every sentence only described the surroundings (weather, terrain) rather than something a character "
      + "did. Mention who did what -- \"Mirren waded the flooded canal\" counts; \"the canal was flooded\" alone "
      + "does not.";
  }
  return "Every sentence that matched a tag was framed as an intention, a question, or background rather than "
    + "something that actually happened at the table.";
}

/**
 * Checks an AI adapter's returned events against the growth-event schema.
 *
 * This used to throw on the FIRST invalid event, which meant one hallucinated field anywhere in a
 * batch -- an empty summary, an outcome value the model invented instead of copying from the
 * prompt -- discarded every other event the model got right along with it. A local GM notes analyzer
 * that drops one bad sentence and keeps the rest (session-notes.js#explainSessionNotes) but an AI
 * adapter that discards ten good events because of one bad one is a worse failure mode, not a
 * stricter one, and it is not hypothetical: a model is more likely to get one field wrong in a large
 * batch than to fail outright. Only a response with no usable shape at all -- not an array, and not
 * an object with an events array -- is still a hard failure, since there truly is nothing to salvage;
 * api.js#analyzeSessionNotes catches that one and falls back to the local analyzer exactly as it does
 * for a network failure. A per-event failure inside an otherwise well-shaped response is reported
 * back as `skipped` instead, so the GM can see what the model got wrong without losing what it got
 * right.
 *
 * The shape check itself was widened at the same time: `output?.events ?? []` used to treat ANY
 * object with no `events` key (a model that answered with the wrong top-level keys entirely, which
 * is a plausible way for a small local model to miss the requested schema) as "zero events, adapter
 * ran fine" -- silently. That is the original "0 events, no explanation" bug from a different angle:
 * the result would have reported source: "adapter" with nothing to show for it and no diagnostics,
 * because diagnostics only exist on the local-analysis path. An object with no recognizable events
 * array is now treated the same as any other unusable adapter response: a thrown error that
 * api.js#analyzeSessionNotes catches and turns into a local-fallback with a stated reason.
 */
export function validateAdapterEvents(output) {
  const hasEventsShape = Array.isArray(output) || (output !== null && typeof output === "object" && Array.isArray(output.events));
  if (!hasEventsShape) {
    throw new Error("A proposal adapter must return an event array or an object with an events array.");
  }
  const events = Array.isArray(output) ? output : output.events;
  const valid = [];
  const skipped = [];
  for (const event of events) {
    const validation = validateGrowthEvent(event);
    if (validation.valid) valid.push(event);
    else skipped.push({ event, errors: validation.errors });
  }
  return { events: valid, skipped };
}
