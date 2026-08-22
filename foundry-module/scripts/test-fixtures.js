export const TEST_SCENARIO_NAME = "GD Test - The First Steam";

export const TEST_ACTS = [
  {
    name: "GD Test - Act I: Lantern Crossing",
    journalTitle: "Act I: The Rising Canal",
    briefing: "Evacuate Lantern Crossing before the canal breaks its banks."
  },
  {
    name: "GD Test - Act II: The Siltworks",
    journalTitle: "Act II: The Broken Siltworks",
    briefing: "Recover the pressure wheel while the old works flood from below."
  },
  {
    name: "GD Test - Act III: The Steam Bell",
    journalTitle: "Act III: The Bell That Calls the Tide",
    briefing: "Ring the steam bell and prove that Ari's new technique is earned."
  }
];

export const TEST_ACTORS = [
  { key: "ari", name: "GD Test - Ari of the Lantern Canal", type: "character", role: "player" },
  { key: "mera", name: "GD Test - Mera the Ropewalker", type: "character", role: "player" },
  { key: "warden", name: "GD Test - Warden of Lantern Crossing", type: "npc", role: "ally" },
  { key: "ripper", name: "GD Test - Brine Ripper", type: "npc", role: "hazard" },
  { key: "echo", name: "GD Test - Steam Bell Echo", type: "npc", role: "finale" }
];

export function testConversionFixture() {
  return {
    character: "Ari of the Lantern Canal",
    classes: [
      {
        name: "Canal Chef",
        level: 8,
        power_tier: "standard",
        is_primary: true,
        pf2e_chassis: "Alchemist",
        metadata: {
          tags: ["craft", "food", "flood-support"],
          lineage: {
            operation: "origin",
            sources: [],
            rationale: "Ari kept an evacuation fed and organized during the flood."
          }
        }
      }
    ],
    skills: [
      {
        name: "Ember Step",
        tier: 2,
        pf2e_equivalent: "Reskinned movement Class Feat",
        metadata: {
          tags: ["fire", "mobility"],
          lineage: {
            operation: "origin",
            sources: [],
            rationale: "Ari learned to cross hot canal grates without slowing down."
          }
        }
      },
      {
        name: "Mist Step",
        tier: 2,
        pf2e_equivalent: "Reskinned movement Class Feat",
        metadata: {
          tags: ["water", "mobility"],
          lineage: {
            operation: "origin",
            sources: [],
            rationale: "Ari learned to move through canal fog without losing the group."
          }
        }
      }
    ]
  };
}

export function upgradedClassFixture() {
  return {
    name: "Canal Hearthkeeper",
    level: 9,
    power_tier: "standard",
    pf2e_chassis: "Alchemist",
    metadata: {
      tags: ["craft", "food", "flood-support", "leadership"],
      lineage: {
        operation: "upgrade",
        sources: ["class:canal-chef"],
        rationale: "Ari turned emergency cooking into a reliable refuge for the whole district."
      }
    }
  };
}

export function combinedSkillFixture() {
  return {
    name: "Steam Step",
    tier: 3,
    pf2e_equivalent: "Narrative-milestone-gated custom ability",
    metadata: {
      tags: ["escape", "steam"],
      lineage: {
        operation: "combine",
        sources: ["skill:ember-step", "skill:mist-step"],
        rationale: "Ari combined heat and fog techniques while opening a flooded escape route."
      }
    }
  };
}
