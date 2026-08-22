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
        },
        gameItem: { kind: "passive" },
        mechanics: {
          effect: "At the start of each encounter, you and one ally who shares a prepared meal gain a +1 circumstance bonus to the first Recovery Check made that encounter.",
          duration: "until the end of the encounter",
          frequency: { max: 1, per: "encounter" }
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
        },
        gameItem: { kind: "action" },
        mechanics: {
          effect: "Stride up to half your Speed. On a success, ignore difficult terrain from hot metal or shallow water during that movement.",
          duration: "instant",
          frequency: { max: 1, per: "round" },
          actions: 1,
          roll: { kind: "Acrobatics check", formula: "1d20+8", dc: 18 }
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
        },
        gameItem: { kind: "reaction" },
        mechanics: {
          effect: "Step 5 feet. If this moves you out of an enemy's reach, the triggering Strike takes a -1 circumstance penalty.",
          duration: "instant",
          frequency: { max: 1, per: "round" },
          trigger: "A creature targets you with a melee Strike while you are concealed or in fog.",
          roll: { kind: "Stealth check", formula: "1d20+8", dc: 18 }
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
    },
    gameItem: { kind: "passive" },
    mechanics: {
      effect: "During a daily preparation, create one temporary meal. The first ally who eats it gains 2 temporary Hit Points for 8 hours.",
      duration: "8 hours",
      frequency: { max: 1, per: "day" }
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
    },
    gameItem: { kind: "free" },
    mechanics: {
      effect: "Step 10 feet through mist, smoke, or steam. This movement doesn't trigger reactions from creatures that cannot see through the obscuring effect.",
      duration: "instant",
      frequency: { max: 1, per: "round" },
      roll: { kind: "Acrobatics check", formula: "1d20+10", dc: 22 }
    }
  };
}

export function mechanicsItemFixtures() {
  return [
    {
      name: "Canal Spark",
      tier: 2,
      pf2e_equivalent: "Rank 1 elemental spell",
      gameItem: { kind: "spell", rank: 1, tradition: "primal" },
      mechanics: {
        effect: "A jet of boiling canal water deals fire damage to one creature within 30 feet.",
        duration: "instant",
        frequency: { max: 2, per: "encounter" },
        actions: 2,
        roll: { kind: "spell attack", formula: "1d20+7", dc: 17 }
      },
      metadata: {
        tags: ["fire", "water", "spell"],
        lineage: { operation: "origin", sources: [], rationale: "Mera learned to vent a pressure line safely." }
      }
    },
    {
      name: "Silt Hook",
      tier: 1,
      pf2e_equivalent: "Simple melee weapon",
      gameItem: { kind: "weapon", damage: "1d6+2", damageType: "piercing", category: "simple", group: "knife", traits: ["agile"] },
      mechanics: {
        effect: "Make a melee Strike with a hooked canal tool.",
        duration: "instant",
        frequency: { max: 1, per: "round" },
        actions: 1,
        roll: { kind: "melee attack", formula: "1d20+6", dc: 17 }
      },
      metadata: {
        tags: ["weapon", "tool", "melee"],
        lineage: { operation: "origin", sources: [], rationale: "Mera adapted a silt hook for close defense." }
      }
    }
  ];
}

export function mechanicsConversionFixture() {
  return {
    character: "Mera the Ropewalker",
    classes: [
      {
        name: "Ropewalker",
        level: 6,
        power_tier: "standard",
        is_primary: true,
        pf2e_chassis: "Ranger",
        gameItem: { kind: "passive" },
        mechanics: {
          effect: "While balancing on a rope or narrow surface, gain a +1 circumstance bonus to Acrobatics checks to Balance.",
          duration: "while you remain on the narrow surface",
          frequency: { max: 1, per: "unlimited" }
        },
        metadata: {
          tags: ["mobility", "balance", "passive"],
          lineage: { operation: "origin", sources: [], rationale: "Mera has crossed hanging canal ropes since childhood." }
        }
      }
    ],
    skills: mechanicsItemFixtures()
  };
}
