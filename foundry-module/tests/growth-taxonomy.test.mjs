import assert from "node:assert/strict";
import test from "node:test";

import { analyzeSessionNotes } from "../scripts/session-notes.js";
import { generateSkillProposals } from "../scripts/progression.js";

test("taxonomy recognizes diverse PF2e gameplay language", () => {
  const events = analyzeSessionNotes(
    "The wizard critically cast an arcane lightning spell and defeated the storm spirit. " +
    "The scout tracked the beast through the forest and secured the trail. " +
    "The medic healed, protected, and saved the wounded guard."
  );

  assert.deepEqual(events[0].tags.sort(), ["arcane", "electricity", "occultism", "spellcasting"]);
  assert.deepEqual(events[1].tags.sort(), ["nature", "survival"]);
  assert.deepEqual(events[2].tags.sort(), ["defense", "medicine", "support"]);
});

test("expanded proposal library produces separate bounded drafts", () => {
  const events = [
    ...Array.from({ length: 3 }, (_, index) => ({
      id: `cold-${index}`,
      summary: "Cast a cold spell successfully.",
      tags: ["cold", "spellcasting"],
      outcome: "success"
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      id: `medic-${index}`,
      summary: "Healed and supported an ally.",
      tags: ["medicine", "support"],
      outcome: "success"
    }))
  ];

  const ids = generateSkillProposals(events, { skills: {} }, 9).map((proposal) => proposal.id).sort();

  assert.deepEqual(ids, ["proposal:field-triage", "proposal:winter-veil"]);
});
