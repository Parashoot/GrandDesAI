import assert from "node:assert/strict";
import test from "node:test";

import { buildItemSource5e, getCharacterLevel5e, equivalentLabel5e } from "../scripts/systems/dnd5e-adapter.js";
import { createFeatureSource } from "../scripts/lineage.js";
import { getSystemAdapter, isSupportedSystem, supportedSystemIds } from "../scripts/systems/index.js";

function skillEntry(overrides) {
  return {
    name: "Test Entry",
    tier: 2,
    system_equivalent: "Some 5E comparison",
    metadata: {
      id: "skill:test-entry",
      tags: ["martial"],
      lineage: { operation: "origin", sources: [], rationale: "Because reasons." }
    },
    ...overrides
  };
}

test("systems/index exposes both supported systems and rejects unknown ones", () => {
  assert.ok(isSupportedSystem("pf2e"));
  assert.ok(isSupportedSystem("dnd5e"));
  assert.equal(isSupportedSystem("swade"), false);
  assert.deepEqual(new Set(supportedSystemIds()), new Set(["pf2e", "dnd5e"]));
  assert.throws(() => getSystemAdapter("swade"), /does not support the "swade" game system/);
});

test("dnd5e feat kind builds a 'feat' Item with a postCreate step that adds a utility activity", () => {
  const entry = skillEntry({
    gameItem: { kind: "feat" },
    mechanics: { effect: "Do a thing.", duration: "8 hours", frequency: { max: 1, per: "day" } }
  });
  const { source, postCreate } = buildItemSource5e("skill", entry);

  assert.equal(source.type, "feat");
  assert.equal(source.system.type.value, "feat");
  assert.equal(source.system.type.subtype, "general");
  assert.equal(typeof postCreate, "function");
});

test("dnd5e passive kind uses activation.type 'none' (always-on, no action cost)", async () => {
  const entry = skillEntry({
    gameItem: { kind: "passive" },
    mechanics: { effect: "Always helps.", duration: "always active", frequency: { max: 1, per: "unlimited" } }
  });
  const { postCreate } = buildItemSource5e("skill", entry);

  const calls = [];
  const fakeItem = { createActivity: async (type, data, opts) => calls.push({ type, data, opts }) };
  await postCreate(fakeItem);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "utility");
  assert.equal(calls[0].data.activation.type, "none");
  assert.equal(calls[0].data.activation.value, null);
  assert.deepEqual(calls[0].opts, { renderSheet: false });
});

test("dnd5e reaction kind sets activation.type 'reaction' and carries the trigger as activation.condition", async () => {
  const entry = skillEntry({
    gameItem: { kind: "reaction" },
    mechanics: {
      effect: "Intercept a blow.",
      duration: "instant",
      frequency: { max: 1, per: "round" },
      trigger: "An ally is struck.",
      roll: { kind: "Athletics check", formula: "1d20+8" }
    }
  });
  const { postCreate } = buildItemSource5e("skill", entry);
  const calls = [];
  await postCreate({ createActivity: async (type, data) => calls.push({ type, data }) });

  assert.equal(calls[0].type, "utility");
  assert.equal(calls[0].data.activation.type, "reaction");
  assert.equal(calls[0].data.activation.condition, "An ally is struck.");
  // 1/round frequency maps to dnd5e's "turn" recovery period (closest structural fit).
  assert.deepEqual(calls[0].data.uses, { max: "1", recovery: [{ period: "turn", type: "recoverAll" }] });
});

test("dnd5e free-action kind maps to a bonus action", async () => {
  const entry = skillEntry({
    gameItem: { kind: "free" },
    mechanics: {
      effect: "Rally an ally.",
      duration: "until the start of your next turn",
      frequency: { max: 1, per: "round" },
      roll: { kind: "Diplomacy check", formula: "1d20+8" }
    }
  });
  const { postCreate } = buildItemSource5e("skill", entry);
  const calls = [];
  await postCreate({ createActivity: async (type, data) => calls.push({ type, data }) });

  assert.equal(calls[0].data.activation.type, "bonus");
});

test("dnd5e action kind whose roll.kind mentions 'attack' creates an attack-type activity", async () => {
  const entry = skillEntry({
    gameItem: { kind: "action" },
    mechanics: {
      effect: "Strike hard.",
      duration: "instant",
      frequency: { max: 1, per: "round" },
      actions: 1,
      roll: { kind: "Melee attack", formula: "1d20+7" }
    }
  });
  const { postCreate } = buildItemSource5e("skill", entry);
  const calls = [];
  await postCreate({ createActivity: async (type, data) => calls.push({ type, data }) });

  assert.equal(calls[0].type, "attack");
  assert.equal(calls[0].data.activation.type, "action");
});

test("dnd5e spell kind sets level/school/method and a matching activity, with day/encounter frequency mapped to lr/sr recovery", async () => {
  const entry = skillEntry({
    gameItem: { kind: "spell", rank: 1, tradition: "arcane", school: "evo" },
    mechanics: {
      effect: "Deal fire damage.",
      duration: "instant",
      frequency: { max: 2, per: "encounter" },
      actions: 2,
      roll: { kind: "Spell attack", formula: "1d20+7" }
    }
  });
  const { source, postCreate } = buildItemSource5e("skill", entry);

  assert.equal(source.type, "spell");
  assert.equal(source.system.level, 1);
  assert.equal(source.system.school, "evo");
  assert.equal(source.system.method, "spell");

  const calls = [];
  await postCreate({ createActivity: async (type, data) => calls.push({ type, data }) });
  assert.equal(calls[0].type, "attack");
  assert.deepEqual(calls[0].data.uses, { max: "2", recovery: [{ period: "sr", type: "recoverAll" }] });
});

test("dnd5e spell rank is clamped into 0-9 (5E has no 10th-level spells, unlike PF2e's 0-10 ranks)", () => {
  const entry = skillEntry({
    gameItem: { kind: "spell", rank: 10, tradition: "arcane", school: "evo" },
    mechanics: { effect: "x", duration: "instant", frequency: { max: 1, per: "round" }, roll: { kind: "Spell attack", formula: "1d20+7" } }
  });
  const { source } = buildItemSource5e("skill", entry);
  assert.equal(source.system.level, 9);
});

test("dnd5e weapon kind sets structured damage/type and needs no postCreate (default attack activity auto-populates)", () => {
  const entry = skillEntry({
    gameItem: { kind: "weapon", damage: "1d6+2", damageType: "piercing", category: "simple", traits: ["agile", "thrown"] },
    mechanics: { effect: "Strike.", duration: "instant", frequency: { max: 1, per: "round" }, actions: 1, roll: { kind: "Melee attack", formula: "1d20+6" } }
  });
  const { source, postCreate } = buildItemSource5e("skill", entry);

  assert.equal(source.type, "weapon");
  assert.equal(source.system.type.value, "simpleM");
  assert.deepEqual(source.system.damage.base, { number: 1, denomination: 6, bonus: "2", types: ["piercing"] });
  assert.deepEqual(source.system.properties, ["fin", "thr"]);
  assert.equal(postCreate, null);
});

test("dnd5e martial ranged weapon traits select the martialR weaponType", () => {
  const entry = skillEntry({
    gameItem: { kind: "weapon", damage: "1d8", damageType: "piercing", category: "martial", traits: ["ranged"] },
    mechanics: { effect: "Shoot.", duration: "instant", frequency: { max: 1, per: "round" }, actions: 1, roll: { kind: "Ranged attack", formula: "1d20+6" } }
  });
  const { source } = buildItemSource5e("skill", entry);
  assert.equal(source.system.type.value, "martialR");
});

test("getCharacterLevel5e reads the already-derived plain integer dnd5e uses (unlike PF2e's nested {value})", () => {
  assert.equal(getCharacterLevel5e({ system: { details: { level: 7 } } }), 7);
  assert.equal(getCharacterLevel5e({ system: { details: {} } }), null);
});

test("equivalentLabel5e mirrors the PF2e adapter's class-vs-skill fallback text", () => {
  assert.equal(equivalentLabel5e("skill", { system_equivalent: "A feat" }), "A feat");
  assert.equal(equivalentLabel5e("class", { system_chassis: "Artificer" }), "Artificer");
  assert.equal(equivalentLabel5e("class", {}), "Pending 5E class chassis review");
});

test("createFeatureSource dispatches to the dnd5e adapter end-to-end and still produces the shared description HTML", () => {
  const entry = skillEntry({
    gameItem: { kind: "passive" },
    mechanics: { effect: "Always helps.", duration: "always active", frequency: { max: 1, per: "unlimited" } }
  });
  const { source, postCreate } = createFeatureSource("skill", entry, "dnd5e");

  assert.equal(source.type, "feat");
  assert.equal(source.name, "[Test Entry] Skill");
  assert.match(source.system.description.value, /Dungeons.*equivalent:/);
  assert.match(source.system.description.value, /Some 5E comparison/);
  assert.match(source.system.description.value, /Frequency:/);
  assert.equal(typeof postCreate, "function");
  assert.deepEqual(source.flags["grand-design-ai"], { registryId: "skill:test-entry", kind: "skill", metadata: entry.metadata });
});
