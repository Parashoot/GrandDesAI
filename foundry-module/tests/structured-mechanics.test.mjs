// Board 5a0cea2e / 6b2a26ce (batch 3, contract sections 2 and 4): an approved Skill with structured
// mechanics becomes real item data on both systems, the validator clamps its numbers by tier and
// character level and says so, and a superseded Item's mechanics switch off.
import assert from "node:assert/strict";
import test from "node:test";

import { createFeatureSource } from "../scripts/lineage.js";
import { buildItemSourcePf2e, markSupersededPf2e } from "../scripts/systems/pf2e-adapter.js";
import { buildItemSource5e, markSuperseded5e } from "../scripts/systems/dnd5e-adapter.js";
import { getSystemAdapter } from "../scripts/systems/index.js";
import { readStructured } from "../scripts/systems/structured.js";
import { clampEntryStructuredMechanics, clampStructuredMechanics } from "../scripts/validator.js";

// The contract's example: damage + basic Reflex save + 15-ft cone, +1 circumstance to AC, 1/encounter.
const STRUCTURED = {
  damage: [{ dice: "2d6", type: "fire" }],
  save: { save: "reflex", dc: "class", basic: true },
  area: { type: "cone", value: 15 },
  modifiers: [{ value: 1, type: "circumstance", selector: "ac" }],
  uses: { max: 1, per: "encounter" }
};

function entry(overrides = {}) {
  return {
    name: "Cinder Fan",
    tier: 1,
    system_equivalent: "A short-range fire cone",
    gameItem: { kind: "action" },
    mechanics: {
      effect: "Sweep a fan of embers; creatures in the cone save or burn, and the heat wards you.",
      frequency: { max: 1, per: "encounter" },
      actions: 2,
      roll: { kind: "Reflex save", formula: "2d6" },
      structured: structuredClone(STRUCTURED)
    },
    metadata: { id: "skill:cinder-fan", tags: ["fire"], lineage: { operation: "origin", sources: [], rationale: "Earned in play." } },
    ...overrides
  };
}

test("PF2e: the contract example becomes an action with frequency, traits, rule elements and enrichers", () => {
  const { source, descriptionHtml } = buildItemSourcePf2e("skill", entry());
  assert.equal(source.type, "action");
  const system = source.system;
  assert.deepEqual(system.actionType, { value: "action" });
  assert.deepEqual(system.actions, { value: 2 });
  assert.equal(system.category, "offensive");
  assert.deepEqual(system.frequency, { max: 1, per: "PT10M" });
  assert.deepEqual(system.traits.value, ["fire"]);
  assert.deepEqual(system.rules, [
    { key: "RollOption", domain: "all", option: "grand-design:cinder-fan", toggleable: true, label: "Cinder Fan (active)" },
    { key: "FlatModifier", selector: "ac", type: "circumstance", value: 1, label: "Cinder Fan", predicate: ["grand-design:cinder-fan"] }
  ]);
  assert.match(descriptionHtml, /@Damage\[2d6\[fire\]\]/);
  assert.match(descriptionHtml, /@Check\[reflex\|against:class-spell\|basic\]/);
  assert.match(descriptionHtml, /@Template\[type:cone\|distance:15\]/);
});

test("PF2e: a passive Skill's modifier is always on (no toggle), selectors map to PF2e statistics", () => {
  const passive = entry({
    gameItem: { kind: "passive" },
    mechanics: {
      effect: "Steady.", duration: "always", frequency: { max: 1, per: "unlimited" },
      structured: { modifiers: [
        { value: 1, type: "status", selector: "save:dex" },
        { value: 2, type: "circumstance", selector: "skill:athletics", predicate: "action:grapple" },
        { value: 1, type: "item", selector: "attack", predicate: "against the undead" }
      ] }
    }
  });
  const { source } = buildItemSourcePf2e("skill", passive);
  assert.equal(source.type, "feat");
  assert.equal(source.system.actionType, undefined, "a passive feat keeps PF2e's passive default");
  assert.deepEqual(source.system.rules, [
    { key: "FlatModifier", selector: "reflex", type: "status", value: 1, label: "Cinder Fan" },
    { key: "FlatModifier", selector: "athletics", type: "circumstance", value: 2, label: "Cinder Fan", predicate: ["action:grapple"] },
    // Prose predicates stay in the description; they never become a never-true roll option.
    { key: "FlatModifier", selector: "attack-roll", type: "item", value: 1, label: "Cinder Fan" }
  ]);
});

test("PF2e: a structured spell gets damage, basic save defense, area and range", () => {
  const spell = entry({
    gameItem: { kind: "spell", rank: 1, tradition: "arcane", school: "evocation" },
    mechanics: {
      effect: "Flames.", frequency: { max: 1, per: "day" }, actions: 2, roll: { kind: "Reflex save", formula: "2d6" },
      structured: { damage: [{ dice: "2d6", type: "lightning", bonus: 1 }], save: { save: "dex", dc: "spell", basic: true }, area: { type: "sphere", value: 10 }, range: { value: 60, units: "ft" } }
    }
  });
  const { source } = buildItemSourcePf2e("skill", spell);
  assert.equal(source.type, "spell");
  assert.deepEqual(Object.values(source.system.damage), [
    { formula: "2d6+1", kinds: ["damage"], type: "electricity", category: null, materials: [], applyMod: false }
  ]);
  assert.deepEqual(source.system.defense, { save: { statistic: "reflex", basic: true } });
  assert.deepEqual(source.system.area, { type: "burst", value: 10 });
  assert.deepEqual(source.system.range, { value: "60 feet" });
  assert.ok(source.system.traits.value.includes("electricity"));
});

test("dnd5e: the contract example becomes a save activity with damage, DC formula, cone template and uses", async () => {
  const { source, postCreate, descriptionHtml } = buildItemSource5e("skill", entry());
  assert.equal(source.type, "feat");
  const calls = [];
  await postCreate({ createActivity: async (type, data, options) => calls.push({ type, data, options }) });
  assert.equal(calls.length, 1);
  const { type, data } = calls[0];
  assert.equal(type, "save");
  assert.deepEqual(data.save.ability, ["dex"]);
  assert.equal(data.save.dc.calculation, "");
  assert.match(data.save.dc.formula, /^8 \+ @prof \+ max\(@abilities\.str\.mod/);
  assert.equal(data.damage.onSave, "half");
  assert.deepEqual(data.damage.parts, [
    { number: 2, denomination: 6, bonus: "", types: ["fire"], custom: { enabled: false, formula: "" }, scaling: { mode: "", number: 1, formula: "" } }
  ]);
  assert.deepEqual(data.target, { template: { type: "cone", size: "15", units: "ft" } });
  assert.deepEqual(data.range, { units: "self" });
  assert.deepEqual(data.uses, { spent: 0, max: "1", recovery: [{ period: "sr", type: "recoverAll" }] });
  assert.equal(data.activation.type, "action");

  // The +1 AC is a real Active Effect on a core dnd5e key, off until the player switches it on.
  assert.equal(source.effects.length, 1);
  assert.equal(source.effects[0].transfer, true);
  assert.equal(source.effects[0].disabled, true);
  assert.deepEqual(source.effects[0].changes, [{ key: "system.attributes.ac.bonus", mode: 2, value: "+1" }]);
  assert.match(descriptionHtml, /\[\[\/damage 2d6 fire\]\]/);
  assert.match(descriptionHtml, /\[\[\/save ability=dex\]\]/);
});

test("dnd5e: attack, heal, fixed DC, advantage and passive modifiers map to core keys", async () => {
  const attack = entry({
    gameItem: { kind: "action" },
    mechanics: {
      effect: "Hurl a bolt.", frequency: { max: 1, per: "round" }, actions: 1, roll: { kind: "attack roll", formula: "1d20" },
      structured: { attack: { kind: "spell" }, damage: [{ dice: "1d10", type: "radiant" }], heal: { dice: "1d4" }, range: { value: 60, units: "ft" } }
    }
  });
  const built = buildItemSource5e("skill", attack);
  assert.deepEqual(built.activities.map((activity) => activity.type), ["attack", "heal"]);
  const [atk, heal] = built.activities;
  assert.deepEqual(atk.data.attack.type, { value: "ranged", classification: "spell" });
  assert.equal(atk.data.damage.includeBase, false);
  assert.deepEqual(atk.data.damage.parts[0].types, ["radiant"]);
  assert.deepEqual(atk.data.range, { value: "60", units: "ft" });
  const spellAttack = buildItemSource5e("skill", { ...attack, gameItem: { kind: "spell", rank: 1, school: "evocation" } });
  assert.deepEqual(spellAttack.activities[0].data.range, { value: "60", units: "ft", override: true }, "a spell activity overrides the spell Item range");
  assert.deepEqual(heal.data.healing.types, ["healing"]);

  const fixed = entry({ mechanics: { ...entry().mechanics, structured: { save: { save: "will", dc: 14 } } } });
  const [save] = buildItemSource5e("skill", fixed).activities;
  assert.deepEqual(save.data.save, { ability: ["wis"], dc: { calculation: "", formula: "14" } });
  assert.equal(save.data.damage.onSave, "none");

  const passive = entry({
    gameItem: { kind: "passive" },
    mechanics: {
      effect: "Keen.", duration: "always", frequency: { max: 1, per: "unlimited" },
      structured: {
        modifiers: [{ value: 2, type: "untyped", selector: "skill:perception" }, { value: 1, type: "status", selector: "save:all" }],
        advantage: { on: "skill:stealth", condition: "in dim light" }
      }
    }
  });
  const passiveBuilt = buildItemSource5e("skill", passive);
  assert.equal(passiveBuilt.source.effects[0].disabled, false, "a passive's effect is always on");
  assert.deepEqual(passiveBuilt.source.effects[0].changes, [
    { key: "system.skills.prc.bonuses.check", mode: 2, value: "+2" },
    { key: "system.bonuses.abilities.save", mode: 2, value: "+1" },
    { key: "system.skills.ste.roll.mode", mode: 2, value: "1" }
  ]);
  assert.equal(passiveBuilt.activities[0].type, "utility");
  assert.equal(passiveBuilt.activities[0].data.activation.type, "none");
});

test("createFeatureSource carries the rules lines and the dnd5e effects; entries without structured data are unchanged", () => {
  const { source } = createFeatureSource("skill", entry(), "dnd5e");
  assert.match(source.system.description.value, /<strong>Rules:<\/strong>/);
  assert.equal(source.effects.length, 1);
  const pf2e = createFeatureSource("skill", entry(), "pf2e").source;
  assert.equal(pf2e.system.rules.length, 2);
  assert.match(pf2e.system.description.value, /@Damage\[2d6\[fire\]\]/);

  const plain = entry();
  delete plain.mechanics.structured;
  for (const systemId of ["pf2e", "dnd5e"]) {
    const { source: plainSource } = createFeatureSource("skill", plain, systemId);
    assert.equal(plainSource.effects, undefined);
    assert.equal(plainSource.system.rules, undefined);
    assert.equal(plainSource.system.frequency, undefined);
    assert.doesNotMatch(plainSource.system.description.value, /Rules:/);
  }
  assert.deepEqual(buildItemSourcePf2e("skill", plain).source, { type: "action", system: { actionType: { value: "action" }, actions: { value: 2 }, category: "offensive" } });
});

test("readStructured drops malformed fields instead of guessing", () => {
  const s = readStructured({ mechanics: { structured: {
    damage: [{ dice: "lots", type: "fire" }, { dice: "3d7", type: "fire" }, { dice: "1d8+2", type: "Cold" }],
    save: { save: "luck" }, modifiers: [{ value: "a", selector: "ac" }, { value: 1, selector: "vibes" }],
    area: { type: "donut", value: 5 }, uses: { max: 0, per: "day" }
  } } });
  assert.deepEqual(s, { damage: [{ count: 1, faces: 8, bonus: 2, type: "cold" }] });
  assert.equal(readStructured({ mechanics: { structured: { save: "nope" } } }), null);
  assert.equal(readStructured({ mechanics: {} }), null);
});

test("validator clamps structured numbers by tier and character level and reports each clamp", () => {
  const { structured, clamps } = clampStructuredMechanics({
    damage: [{ dice: "6d6", type: "fire", bonus: 9 }, { dice: "2d4", type: "cold" }],
    save: { save: "reflex", dc: 30, basic: true },
    modifiers: [{ value: 3, type: "circumstance", selector: "ac" }, { value: -2, type: "untyped", selector: "perception" }],
    range: { value: 500, units: "ft" }, area: { type: "cone", value: 60 },
    condition: { id: "frightened", value: 3 }, uses: { max: 5, per: "encounter" }
  }, { tier: 1, level: 3, systemId: "pf2e" });

  // tier 1, level 3, limited use: 1 + 1 + 1 = 3 dice; bonus <= 1; DC <= 18; +1; 60 ft; 15-ft cone.
  assert.deepEqual(structured.damage, [{ dice: "3d6", bonus: 1, type: "fire" }]);
  assert.equal(structured.save.dc, 18);
  assert.equal(structured.modifiers[0].value, 1);
  assert.equal(structured.modifiers[1].value, -2, "penalties are drawbacks, left alone");
  assert.equal(structured.range.value, 60);
  assert.equal(structured.area.value, 15);
  assert.equal(structured.condition.value, 1);
  assert.equal(structured.uses.max, 1);
  const paths = clamps.map((clamp) => clamp.path);
  assert.deepEqual(paths, ["damage[0].dice", "damage[0].bonus", "damage[1]", "save.dc", "modifiers[0].value", "range.value", "area.value", "condition.value", "uses.max"]);
  assert.deepEqual(clamps.find((clamp) => clamp.path === "modifiers[0].value"), {
    path: "modifiers[0].value", from: 3, to: 1, reason: "a circumstance bonus of at most +1 (tier 1 at level 3)"
  });

  // Higher tier and level allow more; dnd5e DC uses 8 + proficiency + 2 + tier; at-will costs a die.
  const big = clampStructuredMechanics({ damage: [{ dice: "8d6", type: "fire" }], save: { save: "dex", dc: 17 } }, { tier: 3, level: 9, systemId: "dnd5e" });
  assert.deepEqual(big.structured.damage, [{ dice: "7d6", type: "fire" }]);
  assert.equal(big.structured.save.dc, 17);
  assert.equal(big.clamps.length, 1);
  assert.match(big.clamps[0].reason, /at-will/);

  // PF2e untyped bonuses stack with everything: tier 2 caps them at +1.
  const untyped = clampStructuredMechanics({ modifiers: [{ value: 2, type: "untyped", selector: "ac" }] }, { tier: 2, level: 5 });
  assert.equal(untyped.structured.modifiers[0].value, 1);
  const pf2eAdvantage = clampStructuredMechanics({ advantage: { on: "attack" } }, { systemId: "pf2e" });
  assert.equal(pf2eAdvantage.clamps[0].path, "advantage");
});

test("clampEntryStructuredMechanics reads the tier from the entry and stores the clamps on entry.mechanics.clamps", () => {
  const skill = entry({ mechanics: { ...entry().mechanics, structured: { modifiers: [{ value: 3, type: "circumstance", selector: "ac" }] } } });
  const { entry: clamped, clamps } = clampEntryStructuredMechanics(skill, { level: 4, systemId: "pf2e" });
  assert.equal(clamped.mechanics.structured.modifiers[0].value, 1);
  assert.deepEqual(clamped.mechanics.clamps, clamps);
  assert.equal(skill.mechanics.structured.modifiers[0].value, 3, "the input entry is not mutated");

  const klass = { name: "Warden", level: 12, power_tier: "prestige", mechanics: { effect: "x", structured: { modifiers: [{ value: 3, type: "status", selector: "ac" }] } } };
  assert.equal(clampEntryStructuredMechanics(klass, { level: 4, systemId: "dnd5e" }).clamps.length, 0);

  const plain = entry();
  delete plain.mechanics.structured;
  assert.deepEqual(clampEntryStructuredMechanics(plain, { level: 4 }), { entry: plain, clamps: [] });
});

test("markSuperseded switches a PF2e Item's rule elements and frequency off and says by what", () => {
  const { source } = createFeatureSource("skill", entry(), "pf2e");
  const item = { _source: { system: structuredClone(source.system) }, system: source.system };
  const update = getSystemAdapter("pf2e").markSuperseded(item, { by: "Cinder Storm" });
  assert.deepEqual(update["system.rules"], []);
  assert.equal(update["system.frequency.value"], 0);
  assert.equal(update["flags.grand-design-ai.supersededRules"].length, 2);
  assert.match(update["system.description.value"], /^<p class="grand-design-superseded"><strong>Superseded by Cinder Storm\.<\/strong>/);
  assert.match(update["system.description.value"], /Rules:/, "the old description is kept below the line");

  // Marking again keeps one line and does not overwrite the stash with the emptied rules.
  const again = markSupersededPf2e({ system: { rules: [], description: { value: update["system.description.value"] } } }, { by: "Cinder Storm" });
  assert.equal(again["system.description.value"].match(/Superseded by/g).length, 1);
  assert.equal(again["flags.grand-design-ai.supersededRules"], undefined);
});

test("markSuperseded removes a dnd5e Item's activities and disables its effects", () => {
  const item = {
    _source: {
      system: {
        description: { value: "<p>Old text</p>" },
        activities: { abc123: { type: "save", uses: { max: "1" } }, def456: { type: "heal" } }
      },
      effects: [{ _id: "grandDesignEff01", disabled: false, changes: [] }]
    }
  };
  const update = markSuperseded5e(item, { by: "Cinder Storm" });
  assert.equal(update["system.activities.-=abc123"], null);
  assert.equal(update["system.activities.-=def456"], null);
  assert.deepEqual(Object.keys(update["flags.grand-design-ai.supersededActivities"]), ["abc123", "def456"]);
  assert.deepEqual(update.effects, [{ _id: "grandDesignEff01", disabled: true, changes: [] }]);
  assert.match(update["system.description.value"], /Superseded by Cinder Storm\..*<p>Old text<\/p>$/);
  assert.equal(getSystemAdapter("dnd5e").markSuperseded, markSuperseded5e);
});
