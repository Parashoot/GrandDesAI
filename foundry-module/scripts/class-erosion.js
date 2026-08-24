// Class Loss / behavioral erosion: canon classes like [Hero] or [King] can be lost if the
// behavior that defined them stops happening. This module is a GM ADVISORY check ONLY -- it never
// removes, docks, or modifies anything itself. It reads an actor's own recorded growth events and
// approved Class registry and reports which Classes haven't had a matching growth event in a
// while, so a GM can decide (narratively, at their own table) whether that Class should actually
// be at risk. Nothing here touches actor flags.
//
// "Session" is approximated as a distinct calendar date among growth events' own `occurredAt`
// timestamps -- there's no first-class session-id concept in the data model, and tabletop sessions
// naturally cluster onto distinct days, so this is a reasonable proxy without requiring a schema
// change. A GM whose table doesn't map cleanly onto "one date == one session" (e.g. two sessions
// in one calendar day) should read the sessionsSinceLastSeen count as approximate.
import { CLASS_EROSION_DEFAULT_SESSION_THRESHOLD } from "./constants.js";

function sessionKeyFor(event) {
  return typeof event?.occurredAt === "string" ? event.occurredAt.slice(0, 10) : null;
}

/**
 * Returns one `{classId, name, tags, sessionsSinceLastSeen, neverSeen}` entry for every approved
 * Class whose own tags haven't appeared in a growth event for at least `sessionThreshold` sessions
 * (including a Class that has NEVER once matched a growth event, once enough sessions have
 * passed -- `neverSeen: true` in that case). A Class with no tags of its own has nothing to check
 * behavior against and is never flagged. Purely a read -- callers decide what, if anything, to do
 * with the result.
 */
export function checkClassErosion(events, registry, { sessionThreshold = CLASS_EROSION_DEFAULT_SESSION_THRESHOLD } = {}) {
  const classes = registry?.classes ?? {};
  const orderedEvents = (Array.isArray(events) ? events : [])
    .filter((event) => sessionKeyFor(event) !== null)
    .slice()
    .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));

  const sessionKeys = [];
  for (const event of orderedEvents) {
    const key = sessionKeyFor(event);
    if (sessionKeys[sessionKeys.length - 1] !== key) sessionKeys.push(key);
  }
  const totalSessions = sessionKeys.length;
  const sessionIndex = new Map(sessionKeys.map((key, index) => [key, index]));

  const atRisk = [];
  for (const [classId, entry] of Object.entries(classes)) {
    const tags = entry.metadata?.tags ?? [];
    if (!tags.length) continue;
    const tagSet = new Set(tags);

    let lastSeenIndex = -1;
    for (const event of orderedEvents) {
      if (!(event.tags ?? []).some((tag) => tagSet.has(tag))) continue;
      const index = sessionIndex.get(sessionKeyFor(event));
      if (index > lastSeenIndex) lastSeenIndex = index;
    }

    const sessionsSinceLastSeen = lastSeenIndex === -1 ? totalSessions : totalSessions - 1 - lastSeenIndex;
    if (totalSessions > 0 && sessionsSinceLastSeen >= sessionThreshold) {
      atRisk.push({
        classId,
        name: entry.name,
        tags,
        sessionsSinceLastSeen,
        neverSeen: lastSeenIndex === -1
      });
    }
  }
  return atRisk;
}
