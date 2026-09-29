import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHarnessRequest } from "../tools/nlp-scale/lib.mjs";

// Stage 2 only sees events credited to the analysed PC; corpus items name their own characters,
// so a named harness actor filtered out every event and redAcc was always null.
for (const system of ["pf2e", "dnd5e"]) {
  test(`harness request has no analysed PC name (${system})`, () => {
    const request = buildHarnessRequest({ notes: "Tovin burned the shrine." }, system);
    assert.equal(request.actor.name, "");
    assert.equal(request.actor.systemClass, "Fighter");
  });
}
