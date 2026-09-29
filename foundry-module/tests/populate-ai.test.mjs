import assert from "node:assert/strict";
import test from "node:test";

import { GrandDesignApi, derivePopulateAdapter } from "../scripts/api.js";
import { createGatewayAdapter } from "../scripts/ai-gateway.js";
import { AiProviderTimeoutError, AiProviderUnreachableError } from "../scripts/ai/transport.js";
import { createPopulateAdapter, coercePopulateResult, PopulateAiError, runPopulateStage } from "../scripts/ai/populate.js";
import { populateSchema, POPULATE_WEAPON_KEYS } from "../scripts/ai/schemas.js";
import { buildPopulateMessages } from "../scripts/ai/prompts.js";
import { applyPf2eStats, formulaForAverage, MONSTER_TEMPLATES, populate, specsFromAiEntries, WEAPON_BASE } from "../scripts/populate.js";
import { averageDamage, dnd5eRange, pf2eRange, pf2eStat, snapDnd5eCr } from "../scripts/systems/npc-stats.js";
import { buildNpcActorSourcePf2e } from "../scripts/systems/pf2e-adapter.js";
import { buildNpcActorSource5e } from "../scripts/systems/dnd5e-adapter.js";
import { populateSourceNote } from "../scripts/populate-ui.js";

// Board dee25a95: Populate never used the AI (setPopulateAdapter had no caller) and PF2e spawns got
// dnd5e CR blocks. These cover: the adapter is wired from the gateway adapter, every AI failure falls
// back with a stated reason, PF2e numbers come from the Building Creatures table by level, dnd5e local
// output is unchanged, and AI numbers are clamped to the system's range. No network anywhere.

const zeroRng = () => 0;
function seqRng(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function fakeTransport(replies) {
  const calls = [];
  return {
    calls,
    info: { model: "fake" },
    chat: async (request) => {
      calls.push(request);
      const next = replies.length > 1 ? replies.shift() : replies[0];
      if (next instanceof Error) throw next;
      return { content: typeof next === "string" ? next : JSON.stringify(next), ms: 5 };
    }
  };
}

const PF2E_REPLY = {
  entries: [
    { kind: "npc", name: "Forest Bandit", count: 3, level: 1, race: "human", role: "bandit", creatureType: "humanoid", size: "med", hp: 20, ac: 16, speed: 25, perception: 6, fortitude: 7, reflex: 9, will: 4, attributes: { str: 2, dex: 3, con: 1, int: 0, wis: 1, cha: 0 }, dc: 16, weapon: "shortsword", attack: { name: "Shortsword", bonus: 9, damage: "1d6+3", damageType: "piercing" }, bio: "Hungry deserters.", gdClass: "[Highwayman Lv. 3]" },
    // Absurd numbers on purpose: every one must be clamped to level 3's range.
    { kind: "npc", name: "Red Mara", count: 1, level: 3, hp: 400, ac: 35, perception: 40, fortitude: 1, reflex: 12, will: 9, attributes: { str: 9, dex: 4, con: 2, int: 1, wis: 1, cha: 3 }, dc: 60, weapon: "longsword", attack: { name: "Longsword", bonus: 30, damage: "10d12+40", damageType: "slashing" }, bio: "The crew's captain." }
  ]
};

const DND5E_REPLY = {
  entries: [
    { kind: "npc", name: "Bandit", count: 4, cr: 0.125, race: "human", creatureType: "humanoid", size: "med", hp: 11, ac: 12, speed: 30, abilities: { str: 11, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, dc: 11, weapon: "cutlass", attack: { name: "Scimitar", bonus: 3, damage: "1d6+1", damageType: "slashing" }, bio: "Road thugs." },
    { kind: "npc", name: "Bandit Captain", count: 1, cr: 2.2, hp: 900, ac: 31, abilities: { str: 15, dex: 16, con: 14, int: 14, wis: 11, cha: 14 }, dc: 40, weapon: "none", attack: { name: "Scimitar", bonus: 25, damage: "1d6+3", damageType: "slashing" }, bio: "Leads the ambush." }
  ]
};

// --- Tables ------------------------------------------------------------------------------------

test("PF2e Building Creatures tables cover levels -1..24 and read the published moderate values", () => {
  for (let level = -1; level <= 24; level += 1) {
    for (const stat of ["ac", "save", "attack", "damage", "dc", "hp"]) assert.ok(pf2eStat(stat, level) !== undefined, `${stat} @ ${level}`);
    const [lo, hi] = pf2eRange("ac", level);
    assert.ok(lo < pf2eStat("ac", level) && pf2eStat("ac", level) < hi);
  }
  assert.equal(pf2eStat("ac", 3), 18);
  assert.equal(pf2eStat("save", 3), 9);
  assert.equal(pf2eStat("attack", 3), 10);
  assert.equal(pf2eStat("hp", 3), 45);
  assert.equal(pf2eStat("dc", 3), 17);
  assert.equal(pf2eStat("damage", 3), "1d8+6");
  assert.equal(pf2eStat("ac", 99), pf2eStat("ac", 24), "levels clamp to the table");
});

test("dnd5e CR snapping and damage helpers", () => {
  assert.equal(snapDnd5eCr(0.3), 0.25);
  assert.equal(snapDnd5eCr("1/8"), 0.125);
  assert.equal(snapDnd5eCr(2.2), 2);
  assert.equal(snapDnd5eCr(99), 30);
  assert.equal(averageDamage("2d6+4"), 11);
  const f = formulaForAverage(20, 8);
  assert.ok(Math.abs(averageDamage(f) - 20) <= 1, f);
  assert.ok(!/-/.test(formulaForAverage(2, 12)), "never a negative modifier");
});

test("the dnd5e clamp ranges never contradict a curated CR block (goblin 1d6+2 at CR 1/4 was clamped on the first real run)", () => {
  for (const [keyword, t] of Object.entries(MONSTER_TEMPLATES)) {
    const within = (stat, value) => {
      const [lo, hi] = dnd5eRange(stat, t.cr);
      assert.ok(value >= lo && value <= hi, `${keyword} ${stat} ${value} not in [${lo}, ${hi}]`);
    };
    within("hp", t.hp);
    within("ac", t.ac);
    within("attack", t.attack.toHit);
    within("damage", averageDamage(t.attack.damage));
  }
});

// --- Local generator ---------------------------------------------------------------------------

test("a plural monster prompt finds its template ('3 goblins' used to spawn an approximated bandit block)", async () => {
  const { specs } = await populate("3 goblins", { rng: zeroRng });
  assert.equal(specs[0].templateKeyword, "goblin");
  assert.equal(specs[0].approximated, false);
  assert.equal(specs[0].hp, MONSTER_TEMPLATES.goblin.hp);
  const wolves = await populate("2 dire wolves", { rng: zeroRng });
  assert.equal(wolves.specs[0].templateKeyword, "dire wolf");
});

test("dnd5e local output is unchanged by the per-system stat step (every curated template)", async () => {
  for (const keyword of Object.keys(MONSTER_TEMPLATES)) {
    const plain = await populate(`a ${keyword}`, { rng: seqRng(7) });
    const dnd = await populate(`a ${keyword}`, { rng: seqRng(7), systemId: "dnd5e" });
    assert.deepEqual(dnd.specs, plain.specs, keyword);
    assert.equal(dnd.specs[0].hp, MONSTER_TEMPLATES[keyword].hp, `${keyword} keeps its CR block`);
    assert.equal(dnd.source, "local");
  }
  const npcPlain = await populate("a level 3 dwarven blacksmith", { rng: seqRng(3) });
  const npcDnd = await populate("a level 3 dwarven blacksmith", { rng: seqRng(3), systemId: "dnd5e" });
  assert.deepEqual(npcDnd.specs, npcPlain.specs);
});

test("PF2e local monsters get PF2e numbers by level, not the dnd5e CR block", async () => {
  const { specs } = await populate("3 bandits", { rng: zeroRng, systemId: "pf2e" });
  assert.equal(specs.length, 3);
  const bandit = specs[0];
  assert.equal(bandit.level, 0);
  assert.equal(bandit.system, "pf2e");
  assert.equal(bandit.ac, pf2eStat("ac", 0));
  assert.notEqual(bandit.ac, MONSTER_TEMPLATES.bandit.ac);
  assert.equal(bandit.hp, pf2eStat("hp", 0));
  assert.equal(bandit.attack.toHit, pf2eStat("attack", 0));
  for (const save of ["fortitude", "reflex", "will"]) {
    const [lo, hi] = pf2eRange("save", 0);
    assert.ok(bandit.saves[save] >= lo && bandit.saves[save] <= hi, save);
  }
  const troll = (await populate("a troll", { rng: zeroRng, systemId: "pf2e" })).specs[0];
  assert.equal(troll.level, 5);
  assert.equal(troll.hp, pf2eStat("hp", 5, "high"), "Con 20 makes HP a strength");
  const boss = (await populate("a boss troll", { rng: zeroRng, systemId: "pf2e" })).specs[0];
  assert.equal(boss.level, 8, "PF2e scales a boss by level, not an HP multiplier");
  const stated = (await populate("a level 7 ogre", { rng: zeroRng, systemId: "pf2e" })).specs[0];
  assert.equal(stated.level, 7);
  const party = (await populate("goblins for a party level 3", { rng: zeroRng, systemId: "pf2e" })).specs[0];
  assert.equal(party.level, -1, "a PARTY level is not the creature's level");
});

test("PF2e local NPCs keep their level and get armored/unarmored AC ratings and a Strike", async () => {
  const guard = (await populate("a level 5 guard", { rng: zeroRng, systemId: "pf2e" })).specs[0];
  assert.equal(guard.level, 5);
  assert.equal(guard.ac, pf2eStat("ac", 5, "high"));
  assert.equal(guard.attack.name, "Spear");
  assert.equal(guard.attack.damage, pf2eStat("damage", 5, guard.attack.toHit === pf2eStat("attack", 5, "high") ? "high" : "moderate"));
  assert.ok(guard.weaponSpec, "keeps the physical weapon too");
  const scholar = applyPf2eStats({ documentType: "actor", actorKind: "npc", level: 2, abilities: { str: 8, dex: 10, con: 10, int: 16, wis: 14, cha: 10 }, weaponSpec: { name: "Dagger", damageType: "piercing", traits: ["finesse", "light"] } }, { role: { armored: false, primaryAbilities: ["int", "wis"], tags: ["lore"] } });
  assert.equal(scholar.ac, pf2eStat("ac", 2, "low"));
  assert.equal(scholar.attack.toHit, pf2eStat("attack", 2, "low"));
  assert.deepEqual(scholar.attack.traits, ["finesse", "agile"]);
});

// --- AI stage ------------------------------------------------------------------------------------

test("populate schema is system-specific and its weapon enum matches WEAPON_BASE", () => {
  assert.deepEqual([...POPULATE_WEAPON_KEYS].sort(), Object.keys(WEAPON_BASE).sort());
  const pf2e = populateSchema("pf2e").properties.entries.items;
  const dnd = populateSchema("dnd5e").properties.entries.items;
  assert.ok(pf2e.required.includes("level") && pf2e.required.includes("fortitude") && !pf2e.properties.cr);
  assert.ok(dnd.required.includes("cr") && dnd.required.includes("abilities") && !dnd.properties.level);
  const pfMessages = buildPopulateMessages({ promptText: "a bandit ambush", systemId: "pf2e", partyLevel: 3 });
  assert.match(pfMessages[0].content, /level 3: AC 18/);
  assert.match(pfMessages[0].content, /Never use D&D 5e numbers/);
  assert.match(pfMessages[1].content, /average level is 3/);
  const dndMessages = buildPopulateMessages({ promptText: "a bandit ambush", systemId: "dnd5e", partyLevel: 3 });
  assert.match(dndMessages[0].content, /Challenge Rating/);
});

test("runPopulateStage sends the schema through the transport and coerces entries", async () => {
  const transport = fakeTransport([PF2E_REPLY]);
  const { entries, diagnostics } = await runPopulateStage({ transport, promptText: "a bandit ambush on a forest road, party level 3", systemId: "pf2e", partyLevel: 3 });
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].schema.properties.entries.items.properties.level.type, "integer");
  assert.equal(entries.length, 2);
  assert.equal(entries[0].weaponKey, "shortsword");
  assert.equal(entries[1].weaponKey, "sword", "longsword folds to the sword key");
  assert.equal(diagnostics.calls, 1);
});

test("runPopulateStage repairs one bad reply, and throws PopulateAiError when nothing is usable", async () => {
  const repaired = fakeTransport(["not json at all, sorry", PF2E_REPLY]);
  const ok = await runPopulateStage({ transport: repaired, promptText: "x", systemId: "pf2e" });
  assert.equal(ok.diagnostics.repairs, 1);
  assert.equal(repaired.calls.length, 2);
  assert.match(repaired.calls[1].messages.at(-1).content, /could not be used/);
  const hopeless = fakeTransport(['{"entries":[]}']);
  await assert.rejects(runPopulateStage({ transport: hopeless, promptText: "x", systemId: "dnd5e" }), PopulateAiError);
  assert.equal(hopeless.calls.length, 2, "one repair turn, then give up");
});

test("coercePopulateResult caps the total at 20 and drops nameless entries", () => {
  const { entries } = coercePopulateResult({ entries: [{ name: "", cr: 1 }, { name: "Rat", cr: 0, count: 15 }, { name: "Wolf", cr: 0.25, count: 15 }] }, "dnd5e");
  assert.equal(entries.length, 2);
  assert.equal(entries[0].count + entries[1].count, 20);
});

test("AI PF2e entries become PF2e specs, clamped to the level's range with the adjustments stated", async () => {
  const adapter = createPopulateAdapter({ transport: fakeTransport([PF2E_REPLY]) });
  const result = await populate("a bandit ambush on a forest road, party level 3", { adapter, systemId: "pf2e", rng: zeroRng });
  assert.equal(result.source, "ai");
  assert.equal(result.fallbackReason, null);
  assert.equal(result.specs.length, 4);
  assert.deepEqual(result.specs.map((s) => s.name), ["Forest Bandit 1", "Forest Bandit 2", "Forest Bandit 3", "Red Mara"]);
  const bandit = result.specs[0];
  assert.equal(bandit.level, 1);
  assert.equal(bandit.ac, 16);
  assert.equal(bandit.attack.toHit, 9);
  assert.deepEqual(bandit.adjustments, []);
  assert.match(bandit.bio, /\[Highwayman Lv\. 3\]/);
  const mara = result.specs[3];
  assert.equal(mara.level, 3);
  assert.equal(mara.ac, pf2eRange("ac", 3)[1]);
  assert.equal(mara.hp, pf2eRange("hp", 3)[1]);
  assert.equal(mara.perception, pf2eRange("perception", 3)[1]);
  assert.equal(mara.saves.fortitude, pf2eRange("save", 3)[0]);
  assert.equal(mara.attack.toHit, pf2eRange("attack", 3)[1]);
  assert.ok(averageDamage(mara.attack.damage) <= pf2eRange("damage", 3)[1]);
  assert.equal(mara.dc, pf2eRange("dc", 3)[1]);
  assert.equal(mara.abilityMods.str, 4, "attribute modifiers cap by level");
  assert.match(mara.bio, /Numbers adjusted to PF2e level 3 ranges: .*AC 35 -> 22/);
});

test("AI dnd5e entries keep dnd5e shape: CR snapped, numbers clamped for the CR", async () => {
  const adapter = createPopulateAdapter({ transport: fakeTransport([DND5E_REPLY]) });
  const result = await populate("a bandit ambush on a forest road, party level 3", { adapter, systemId: "dnd5e", rng: zeroRng });
  assert.equal(result.source, "ai");
  assert.equal(result.specs.length, 5);
  const bandit = result.specs[0];
  assert.equal(bandit.cr, 0.125);
  assert.equal(bandit.hp, 11);
  assert.equal(bandit.ac, 12);
  assert.equal(bandit.weaponSpec.weaponKey, "cutlass");
  const captain = result.specs[4];
  assert.equal(captain.cr, 2);
  assert.equal(captain.hp, dnd5eRange("hp", 2)[1]);
  assert.equal(captain.ac, dnd5eRange("ac", 2)[1]);
  assert.equal(captain.attack.toHit, dnd5eRange("attack", 2)[1]);
  assert.equal(captain.dc, dnd5eRange("dc", 2)[1]);
  assert.equal(captain.weaponSpec, undefined, "weapon none -> natural attack");
  assert.match(captain.bio, /CR 2\.2 -> 2/);
  const source = buildNpcActorSource5e(captain);
  assert.equal(source.source.system.details.cr, 2, "an AI NPC's CR is used, not a level approximation");
  assert.equal(source.embeddedItems.length, 1);
  assert.equal(source.embeddedItems[0].system.type.value, "natural");
});

test("AI item entries become weapon item specs", () => {
  const { kind, specs } = specsFromAiEntries([{ kind: "item", name: "Ashfang", count: 1, weaponKey: "shortsword", bonus: 1, rider: "fire", bio: "Warm to the touch." }], "pf2e");
  assert.equal(kind, "item");
  assert.equal(specs[0].documentType, "item");
  assert.equal(specs[0].name, "Ashfang");
  assert.equal(specs[0].bonus, 1);
  assert.equal(specs[0].rider, "fire");
});

// --- Failures fall back with a reason --------------------------------------------------------------

test("every AI failure falls back to the local generator with a stated reason, never a throw", async () => {
  const cases = [
    [new AiProviderTimeoutError("http://127.0.0.1:11434/api/chat", 1000), /timed out/],
    [new AiProviderUnreachableError("http://127.0.0.1:11434/api/chat", new Error("ECONNREFUSED")), /could not be reached/],
    ["{{{ garbage", /could not be used/]
  ];
  for (const systemId of ["pf2e", "dnd5e"]) {
    for (const [reply, reason] of cases) {
      const adapter = createPopulateAdapter({ transport: fakeTransport([reply]) });
      const result = await populate("3 goblins", { adapter, systemId, rng: zeroRng });
      assert.equal(result.source, "local", `${systemId} ${reason}`);
      assert.match(result.fallbackReason, reason);
      assert.equal(result.specs.length, 3);
      assert.equal(result.specs[0].templateKeyword, "goblin");
      if (systemId === "pf2e") assert.equal(result.specs[0].level, -1);
      else assert.equal(result.specs[0].hp, MONSTER_TEMPLATES.goblin.hp);
    }
  }
  const thrower = async () => { throw new Error("boom"); };
  const result = await populate("a dagger", { adapter: thrower, systemId: "dnd5e" });
  assert.equal(result.source, "local");
  assert.match(result.fallbackReason, /failed \(boom\)/);
  assert.match(populateSourceNote(result), /local generator because the AI provider failed/);
  assert.match(populateSourceNote({ source: "ai" }), /AI Gateway/);
  assert.match(populateSourceNote({ source: "local", aiAvailable: false }), /No AI Gateway/);
});

// --- Wiring --------------------------------------------------------------------------------------

function gatewayAdapter(fetchImpl) {
  return createGatewayAdapter({ provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "fake-model", fetchImpl });
}

test("the populate adapter follows the gateway adapter (built at ready, rebuilt on settings change)", () => {
  const api = new GrandDesignApi();
  assert.equal(api.hasPopulateAdapter(), false);
  const first = gatewayAdapter(async () => new Response("{}"));
  api.setProposalAdapter(first);
  assert.equal(api.hasPopulateAdapter(), true, "setProposalAdapter wires Populate to the same gateway");
  assert.equal(api.getPopulateAdapter().transport, first.transport);
  const rebuilt = gatewayAdapter(async () => new Response("{}"));
  api.setProposalAdapter(rebuilt);
  assert.equal(api.getPopulateAdapter().transport, rebuilt.transport, "a settings rebuild re-derives it");
  api.setProposalAdapter(null);
  assert.equal(api.hasPopulateAdapter(), false, "AI disabled -> local");
  // An explicitly registered adapter wins until it is cleared.
  const custom = async () => ({ kind: "item", specs: [] });
  api.setPopulateAdapter(custom);
  api.setProposalAdapter(rebuilt);
  assert.equal(api.getPopulateAdapter(), custom);
  api.setPopulateAdapter(null);
  assert.equal(api.getPopulateAdapter().transport, rebuilt.transport);
  assert.equal(derivePopulateAdapter(async () => ({})), null, "a plain function has no transport to reuse");
});

function installFoundryFakes(systemId) {
  const created = [];
  const saved = { game: globalThis.game, Actor: globalThis.Actor, Item: globalThis.Item, Hooks: globalThis.Hooks };
  globalThis.game = {
    user: { isGM: true },
    system: { id: systemId },
    actors: { contents: [{ type: "character", hasPlayerOwner: true, system: { details: { level: systemId === "pf2e" ? { value: 3 } : 3 } } }] }
  };
  globalThis.Actor = { create: async (source) => { const doc = { ...source, uuid: `Actor.${created.length}`, embedded: [], createEmbeddedDocuments: async (_t, items) => { doc.embedded.push(...items); } }; created.push(doc); return doc; } };
  globalThis.Item = { create: async (source) => { const doc = { ...source, uuid: `Item.${created.length}` }; created.push(doc); return doc; } };
  globalThis.Hooks = { callAll: () => {} };
  return { created, restore: () => Object.assign(globalThis, saved) };
}

for (const systemId of ["pf2e", "dnd5e"]) {
  test(`api.populate (${systemId}) uses the gateway's AI with the party level, and builds real sources`, async () => {
    const fakes = installFoundryFakes(systemId);
    try {
      const api = new GrandDesignApi();
      const reply = systemId === "pf2e" ? PF2E_REPLY : DND5E_REPLY;
      const bodies = [];
      api.setProposalAdapter(gatewayAdapter(async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ model: "fake-model", message: { role: "assistant", content: JSON.stringify(reply) }, done: true }), { status: 200 });
      }));
      const result = await api.populate("a bandit ambush on a forest road");
      assert.equal(result.source, "ai");
      assert.equal(result.fallbackReason, null);
      assert.equal(bodies.length, 1);
      assert.ok(bodies[0].format?.properties?.entries, "Ollama gets the populate JSON Schema as `format`");
      assert.match(bodies[0].messages[1].content, /average level is 3/);
      assert.equal(result.created.length, reply.entries.reduce((n, e) => n + e.count, 0));
      const actor = result.created[0];
      if (systemId === "pf2e") {
        assert.equal(actor.system.details.level.value, 1);
        assert.equal(actor.system.saves.reflex.value, 9);
        assert.equal(actor.system.perception.mod, 6);
        const strike = actor.embedded.find((item) => item.type === "melee");
        assert.equal(strike.system.bonus.value, 9);
        assert.equal(Object.values(strike.system.damageRolls)[0].damage, "1d6+3");
      } else {
        assert.equal(actor.system.details.cr, 0.125);
        assert.equal(actor.system.attributes.ac.flat, 12);
      }
    } finally {
      fakes.restore();
    }
  });

  test(`api.populate (${systemId}) falls back with a reason when the provider is down`, async () => {
    const fakes = installFoundryFakes(systemId);
    try {
      const api = new GrandDesignApi();
      api.setProposalAdapter(gatewayAdapter(async () => { throw new TypeError("Failed to fetch"); }));
      const result = await api.populate("2 wolves");
      assert.equal(result.source, "local");
      assert.match(result.fallbackReason, /could not be reached/);
      assert.equal(result.created.length, 2);
      if (systemId === "pf2e") assert.equal(result.created[0].system.details.level.value, 1);
    } finally {
      fakes.restore();
    }
  });
}

test("PF2e NPC source carries saves, Perception and a melee Strike; a legacy spec still builds", () => {
  const { source, embeddedItems } = buildNpcActorSourcePf2e({ actorKind: "monster", name: "Wolf", level: 1, hp: 20, ac: 15, perception: 7, saves: { fortitude: 7, reflex: 9, will: 5 }, abilityMods: { str: 2, dex: 3, con: 2, int: -4, wis: 1, cha: -2 }, creatureType: "animal", size: "med", speed: 35, attack: { name: "Jaws", toHit: 9, damage: "1d6+3", damageType: "piercing", traits: [] } });
  assert.equal(source.system.saves.fortitude.value, 7);
  assert.equal(source.system.perception.mod, 7);
  assert.deepEqual(source.system.traits.value, ["animal"]);
  assert.equal(embeddedItems.length, 1);
  assert.equal(embeddedItems[0].type, "melee");
  const legacy = buildNpcActorSourcePf2e({ actorKind: "monster", name: "Old", cr: 2, hp: 10, ac: 12, abilities: { str: 14 }, attack: { name: "Bite", toHit: 4, damage: "1d6+2", damageType: "piercing" } });
  assert.equal(legacy.source.system.details.level.value, 2);
  assert.equal(legacy.source.system.abilities.str.mod, 2);
});
