import assert from "node:assert/strict";
import test from "node:test";

import { emptyRegistry, normalizeEntry, registerEntry } from "../scripts/lineage.js";
import { validateConversion } from "../scripts/validator.js";

test("combined skills inherit source tags and retain source IDs", () => {
  let registry = emptyRegistry();
  const first = normalizeEntry(
    "skill",
    { name: "Ember Step", tier: 2, pf2e_equivalent: "Movement feat", metadata: { tags: ["fire", "mobility"] } },
    registry
  );
  registry = registerEntry("skill", first, "item-one", registry);
  const second = normalizeEntry(
    "skill",
    { name: "Mist Step", tier: 2, pf2e_equivalent: "Movement feat", metadata: { tags: ["water", "mobility"] } },
    registry
  );
  registry = registerEntry("skill", second, "item-two", registry);

  const combined = normalizeEntry(
    "skill",
    {
      name: "Steam Step",
      tier: 3,
      pf2e_equivalent: "Milestone ability",
      metadata: {
        tags: ["escape"],
        lineage: {
          operation: "combine",
          sources: [first.metadata.id, second.metadata.id],
          rationale: "The character learned to blend the two travel techniques."
        }
      }
    },
    registry
  );

  assert.deepEqual(combined.metadata.tags, ["escape", "fire", "mobility", "water"]);
  assert.deepEqual(combined.metadata.lineage.sources, [first.metadata.id, second.metadata.id]);
});

test("conversion validation rejects malformed lineage tags", () => {
  const result = validateConversion({
    character: "Test",
    classes: [{ name: "Runner", level: 4, power_tier: "standard" }],
    skills: [{
      name: "Dash",
      tier: 1,
      pf2e_equivalent: "Skill feat",
      metadata: { tags: ["valid", ""] }
    }]
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /metadata.tags/);
});
