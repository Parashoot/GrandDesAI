export const TEST_SCENARIO_NAME = "GD Test - The First Steam";

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
