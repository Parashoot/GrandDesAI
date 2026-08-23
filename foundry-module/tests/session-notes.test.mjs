import assert from "node:assert/strict";
import test from "node:test";

import { analyzeSessionNotes, validateAdapterEvents } from "../scripts/session-notes.js";

test("local notes analyzer produces tagged successful events", () => {
  const events = analyzeSessionNotes(
    "Mera crossed the flooded canal and rescued a resident. She critically secured the flooded sluice gate with a rope."
  );

  assert.equal(events.length, 2);
  assert.deepEqual(events[0].tags.sort(), ["mobility", "support", "water"]);
  assert.equal(events[0].outcome, "success");
  assert.equal(events[1].outcome, "criticalSuccess");
});

test("adapter output must satisfy the same growth event contract", () => {
  assert.throws(() => validateAdapterEvents({ events: [{ summary: "", tags: [], outcome: "failure" }] }));
  assert.equal(
    validateAdapterEvents([{ summary: "Ari saved the ferry.", tags: ["water", "support"], outcome: "success" }]).length,
    1
  );
});
