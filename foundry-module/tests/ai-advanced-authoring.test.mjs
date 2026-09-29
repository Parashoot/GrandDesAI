import assert from "node:assert/strict";
import test from "node:test";

import { buildAdvancedTarget, createGatewayAdapter } from "../scripts/ai-gateway.js";
import { AiProviderUnreachableError } from "../scripts/ai/transport.js";
import { isConsequenceOfOwnDeed, runGatewayPipeline, shapeTitle } from "../scripts/ai/pipeline.js";
import { buildAiGatewayRequest } from "../scripts/ai-gateway.js";
import { GROWTH_PROPOSALS_FLAG, LEVEL_PROGRESSION_FLAG } from "../scripts/constants.js";

// Advanced-mechanics batch, gateway half: adapter.authorAdvanced upgrade/combine (boards ebcc3f03,
// d4ae9326), Title proposals in stage 2 (7b616fea), a ban/eviction stays the PC's own event
// (07b9d93f), and an empty answer to a GM's Suggest gets one "something else" turn (live regression
// 2026-09-29). Both game systems; a scripted transport stands in for the model.

const SYSTEMS = ["pf2e", "dnd5e"];

function makeActor(systemId, { name = "Maren", registry = {}, proposals = [], gdLevel = 3, allowances = 0 } = {}) {
  const flags = { registry, [GROWTH_PROPOSALS_FLAG]: proposals, [LEVEL_PROGRESSION_FLAG]: { level: gdLevel, progress: 0, grantAllowances: allowances } };
  return {
    id: `actor-${systemId}`,
    name,
    type: "character",
    system: systemId === "dnd5e"
      ? { details: { level: 5 }, skills: { acr: { total: 6, mod: 3 } }, attributes: { prof: 3 } }
      : { details: { level: { value: 5 } }, skills: { acrobatics: { mod: 8 } } },
    ...(systemId === "dnd5e" ? { classes: { ranger: { name: "Ranger", type: "class", system: { levels: 5 } } } } : { class: { name: "Ranger" } }),
    items: { find: () => undefined, filter: () => [] },
    getFlag: (_scope, key) => flags[key]
  };
}

function scripted(replies) {
  const calls = [];
  return {
    calls,
    info: { model: "stub", provider: "ollama", endpoint: "http://127.0.0.1:11434" },
    async chat(args) {
      calls.push(args);
      const reply = typeof replies === "function" ? replies(args, calls.length) : replies[Math.min(calls.length - 1, replies.length - 1)];
      if (reply instanceof Error) throw reply;
      return { content: JSON.stringify(reply), ms: 1, truncated: false };
    }
  };
}

const adapterFor = (transport, extra = {}) => createGatewayAdapter({ proposalMode: "when-earned", ...extra }, { transportFactory: () => transport });
const systemText = (args) => args.messages.find((m) => m.role === "system").content;

const skill = (name, effect, { tier = 1, tags = ["ranged"], extra = {} } = {}) => ({
  kind: "skill",
  evidence: ["shot the sentry"],
  entry: {
    name, tier, system_equivalent: "Skill feat", gameItem: { kind: "passive" },
    mechanics: { effect, duration: "while active", frequency: { max: 1, per: "unlimited" } },
    metadata: { tags, ...extra }
  }
});

const cls = (name, effect, { level = 10, power = "standard", tags = ["ranged"] } = {}) => ({
  kind: "class",
  evidence: ["led the volley"],
  entry: {
    name, level, power_tier: power, is_primary: false, is_secondary: true, system_chassis: "Ranger chassis", gameItem: { kind: "passive" },
    mechanics: { effect, duration: "while active", frequency: { max: 1, per: "day" } },
    metadata: { tags }
  }
});

const SOURCE_EFFECT = "When you Strike a target you aimed at last turn, add +1 to the attack roll.";
const ownedSkill = { name: "Ridgeshot: Steady Aim", tier: 1, metadata: { id: "skill:steady-aim", tags: ["ranged", "precision"], lineage: { operation: "origin", sources: [] } }, mechanics: { effect: SOURCE_EFFECT } };
const MOMENTS = ["Maren shot the sentry off the ridge in the dark.", "Maren split the troll's eye at 60 feet.", "Maren hit the fleeing courier through a gap in the wagons."];

for (const systemId of SYSTEMS) {
  test(`[${systemId}] authorAdvanced upgrade: stage 2 only, tier +1, upgrade lineage, the source is exempt from the owned-duplicate gate`, async () => {
    // The evolved effect deliberately re-uses most of the source's wording: that is an evolution, not a duplicate.
    const transport = scripted([{ proposals: [skill("Ridgeshot: Eye of the Storm", `${SOURCE_EFFECT} On a critical hit the target is also blinded until the end of your next turn.`, { tier: 1 })] }]);
    const actor = makeActor(systemId, { registry: { skills: { "skill:steady-aim": ownedSkill } } });
    const out = await adapterFor(transport).authorAdvanced({
      actor, operation: "upgrade", systemId,
      sources: [{ id: "skill:steady-aim", name: ownedSkill.name, kind: "skill", tier: 1, effect: SOURCE_EFFECT, tags: ["ranged"], polarity: "standard", definingMoments: MOMENTS }]
    });
    assert.equal(transport.calls.length, 1, "no extraction call");
    const sys = systemText(transport.calls[0]);
    assert.match(sys, /SKILL EVOLUTION/);
    assert.match(sys, /Ridgeshot: Steady Aim/);
    assert.match(sys, /tier 2/);
    assert.ok(!transport.calls[0].schema.properties.titles, "no titles in an evolution call");
    const newEvents = JSON.parse(transport.calls[0].messages[1].content).newEvents.map((e) => e.summary);
    assert.deepEqual(newEvents, MOMENTS, "the defining moments are the evidence");
    assert.equal(out.proposals.length, 1, JSON.stringify(out.skippedProposals));
    const entry = out.proposals[0].entry;
    assert.equal(out.proposals[0].kind, "skill");
    assert.equal(entry.tier, 2);
    assert.deepEqual(entry.metadata.lineage.sources, ["skill:steady-aim"]);
    assert.equal(entry.metadata.lineage.operation, "upgrade");
  });

  test(`[${systemId}] authorAdvanced upgrade: other owned Skills still gate; a tier-3 source stays tier 3; red carries forward`, async () => {
    const other = { name: "Ridgeshot: Volley", tier: 2, metadata: { id: "skill:volley", tags: ["ranged"] }, mechanics: { effect: "Once per round, make two ranged Strikes against different targets within 30 feet with a -2 penalty." } };
    const red = { ...ownedSkill, tier: 3, metadata: { ...ownedSkill.metadata, polarity: "red", malignance: { vice: "bloodlust", drawback: "You must finish a downed foe." } } };
    const registry = { skills: { "skill:steady-aim": red, "skill:volley": other } };
    const dup = scripted([{ proposals: [skill("Ridgeshot: Twin Fang", other.mechanics.effect)] }, { proposals: [] }]);
    const dupOut = await adapterFor(dup).authorAdvanced({ actor: makeActor(systemId, { registry }), operation: "upgrade", systemId, sources: [{ id: "skill:steady-aim", name: red.name, definingMoments: MOMENTS }] });
    assert.equal(dupOut.proposals.length, 0);
    assert.equal(dupOut.skippedProposals[0].reason, "duplicates-owned");
    const ok = scripted([{ proposals: [skill("Ridgeshot: Red Horizon", "Your first Strike each round against a wounded creature deals 1d6 extra damage.", { tier: 3 })] }]);
    const out = await adapterFor(ok).authorAdvanced({ actor: makeActor(systemId, { registry }), operation: "upgrade", systemId, sources: [{ id: "skill:steady-aim", name: red.name, definingMoments: MOMENTS }] });
    const entry = out.proposals[0].entry;
    assert.equal(entry.tier, 3, "max tier");
    assert.equal(entry.metadata.polarity, "red", "the source's registry polarity is read and carried forward");
    assert.equal(entry.metadata.malignance.vice, "bloodlust");
  });

  test(`[${systemId}] authorAdvanced combine: power tier from the focus score, level >= sources, combine lineage over every source`, async () => {
    const registry = {
      classes: {
        "class:archer": { name: "Ridge Archer", level: 12, power_tier: "standard", metadata: { id: "class:archer", tags: ["ranged", "precision"] }, mechanics: { effect: "Your ranged Strikes ignore lesser cover." } },
        "class:scout": { name: "Hill Scout", level: 8, power_tier: "elevated", metadata: { id: "class:scout", tags: ["ranged", "precision"] }, mechanics: { effect: "You and allies within 30 feet gain +1 to initiative." } }
      }
    };
    const transport = scripted([{ proposals: [cls("Ridge Archer of the Hills", "Once per day when you roll initiative, choose a foe; your ranged Strikes against it ignore cover until the end of the encounter.", { level: 3, power: "standard" })] }]);
    const out = await adapterFor(transport).authorAdvanced({ actor: makeActor(systemId, { registry, gdLevel: 20 }), operation: "combine", systemId, sources: [{ id: "class:archer" }, { id: "class:scout", name: "Hill Scout" }] });
    const sys = systemText(transport.calls[0]);
    assert.match(sys, /CLASS MERGE/);
    assert.match(sys, /power_tier "prestige"/, "identical tags = tight focus: one tier above the strongest (elevated)");
    assert.equal(out.proposals.length, 1, JSON.stringify(out.skippedProposals));
    const entry = out.proposals[0].entry;
    assert.equal(entry.power_tier, "prestige");
    assert.equal(entry.level, 12);
    assert.equal(entry.is_primary, true);
    assert.deepEqual(entry.metadata.lineage, { operation: "combine", sources: ["class:archer", "class:scout"], rationale: entry.metadata.lineage.rationale });
  });

  test(`[${systemId}] authorAdvanced: bad operation / source count throw; a dead provider throws instead of an empty result`, async () => {
    const adapter = adapterFor(scripted([{ proposals: [] }]));
    await assert.rejects(adapter.authorAdvanced({ actor: makeActor(systemId), operation: "evolve", sources: [{ id: "a" }] }), /unknown operation/);
    assert.throws(() => buildAdvancedTarget({ actor: makeActor(systemId), operation: "combine", sources: [{ id: "a" }] }), /at least two/);
    const dead = adapterFor(scripted([new AiProviderUnreachableError("http://127.0.0.1:11434", new Error("ECONNREFUSED"))]));
    await assert.rejects(dead.authorAdvanced({ actor: makeActor(systemId), operation: "upgrade", systemId, sources: [{ id: "skill:x", name: "X", definingMoments: MOMENTS }] }), AiProviderUnreachableError);
  });

  test(`[${systemId}] off-cycle merge holds at the strongest source's tier`, () => {
    const actor = makeActor(systemId, {
      gdLevel: 13,
      registry: { classes: { a: { name: "A", level: 5, power_tier: "elevated", metadata: { id: "a", tags: ["ranged"] } }, b: { name: "B", level: 4, power_tier: "standard", metadata: { id: "b", tags: ["ranged"] } } } }
    });
    const target = buildAdvancedTarget({ actor, operation: "combine", sources: [{ id: "a" }, { id: "b" }] });
    assert.equal(target.powerTier, "elevated");
    assert.equal(target.offCycle, true);
  });

  // ---- titles ----

  const KILL = { quote: "Brakka cut down Grushnak the Troll-King on the bridge", summary: "Brakka killed Grushnak the Troll-King on the bridge.", actorName: "Brakka", tags: ["martial"], themes: ["troll-slaying"], outcome: "success" };
  const title = (extra = {}) => ({ deed: "Brakka cut down Grushnak the Troll-King on the bridge", name: "Trollbane", description: "Bridge-folk say trolls cross to the other bank when she walks by.", polarity: "standard", vice: "none", tags: ["martial"], ...extra });

  test(`[${systemId}] stage 2 may return one Title: kind "title", achievement = the quoted deed, no mechanics`, async () => {
    const transport = scripted(() => ({ redCheck: [], proposals: [], titles: [title()] }));
    const actor = makeActor(systemId, { name: "Brakka" });
    const out = await adapterFor(transport, { proposalMode: "always" })({ actor, notes: "", events: [KILL], systemId });
    assert.ok(transport.calls[0].schema.properties.titles, "titles offered in open-ended stage 2");
    assert.match(systemText(transport.calls[0]), /TITLES \(rare\)/);
    const titles = out.proposals.filter((p) => p.kind === "title");
    assert.equal(titles.length, 1, JSON.stringify(out.skippedProposals));
    assert.equal(titles[0].entry.name, "Trollbane");
    assert.equal(titles[0].entry.achievement, KILL.quote);
    assert.equal(titles[0].entry.metadata.polarity, "standard");
    assert.deepEqual(titles[0].entry.tags, ["martial"]);
    assert.match(titles[0].rationale, /Grushnak/);
    assert.equal(titles[0].entry.mechanics, undefined);
  });

  test(`[${systemId}] titles are gated: owned or pending name, a deed not in this PC's events, the personal name; never in milestone/authoring calls`, async () => {
    const owned = makeActor(systemId, { name: "Brakka", registry: { titles: { "title:trollbane": { name: "The Trollbane", metadata: { id: "title:trollbane" } } } } });
    let out = await adapterFor(scripted(() => ({ redCheck: [], proposals: [], titles: [title()] })), { proposalMode: "always" })({ actor: owned, notes: "", events: [KILL], systemId });
    assert.equal(out.proposals.filter((p) => p.kind === "title").length, 0);
    assert.ok(out.skippedProposals.some((s) => s.reason === "already-exists"));
    const pending = makeActor(systemId, { name: "Brakka", proposals: [{ id: "p1", kind: "title", status: "pending", entry: { name: "Trollbane", description: "x", metadata: { tags: [] } } }] });
    out = await adapterFor(scripted(() => ({ redCheck: [], proposals: [], titles: [title()] })), { proposalMode: "always" })({ actor: pending, notes: "", events: [KILL], systemId });
    assert.ok(out.skippedProposals.some((s) => s.reason === "duplicates-pending"));
    out = await adapterFor(scripted(() => ({ redCheck: [], proposals: [], titles: [title({ deed: "Luz healed the whole village by moonlight" })] })), { proposalMode: "always" })({ actor: makeActor(systemId, { name: "Brakka" }), notes: "", events: [KILL], systemId });
    assert.ok(out.skippedProposals.some((s) => s.reason === "title-deed-not-in-events"));
    out = await adapterFor(scripted(() => ({ redCheck: [], proposals: [], titles: [title({ name: "Brakka the Bold" })] })), { proposalMode: "always" })({ actor: makeActor(systemId, { name: "Brakka" }), notes: "", events: [KILL], systemId });
    assert.ok(out.skippedProposals.some((s) => s.reason === "title-uses-personal-name"));
    const authoring = scripted(() => ({ proposals: [skill("Bridgewarden: Hold", "Allies adjacent to you gain +1 to AC while you stand on a bridge or in a doorway.")] }));
    await adapterFor(authoring).authorProposal({ actor: makeActor(systemId, { name: "Brakka" }), proposal: { id: "k", kind: "skill", entry: { name: "Knack" } }, events: [KILL], systemId });
    assert.ok(!authoring.calls[0].schema.properties.titles);
  });

  test(`[${systemId}] a red title needs a vice from the list (else standard) and is skipped when the table disallows red`, () => {
    const red = shapeTitle(title({ name: "Butcher of the Bridge", polarity: "red", vice: "cruelty", drawback: "Villagers bar their doors when you pass." }));
    assert.equal(red.proposal.entry.metadata.polarity, "red");
    assert.deepEqual(red.proposal.entry.metadata.malignance, { vice: "cruelty", drawback: "Villagers bar their doors when you pass." });
    assert.equal(shapeTitle(title({ polarity: "red", vice: "none" })).proposal.entry.metadata.polarity, "standard");
    assert.equal(shapeTitle(title({ polarity: "red", vice: "cruelty" }), { allowRed: false }).skip, "red-entries-disabled");
    assert.equal(shapeTitle({ name: "X" }).skip, "title-without-deed");
  });
}

// ---- live PF2e rest 19->20: a Class is never a duplicate of an owned Skill; the motif is no concept ----

for (const systemId of SYSTEMS) {
  test(`[${systemId}] a Class sharing the Skills' motif and wording is not "duplicates-owned"; a same-kind copy still is`, async () => {
    const fletchSkill = (id, concept, effect) => [id, { name: `Fletchwright: ${concept}`, tier: 1, metadata: { id, tags: ["craft", "ranged"] }, mechanics: { effect } }];
    const skills = Object.fromEntries([
      fletchSkill("skill:reed", "Reed Shafts", "During a rest, craft 10 arrows from reeds; they deal +1 damage on your next ranged Strike."),
      fletchSkill("skill:horizon", "Horizon Shot", "Your ranged Strikes against targets beyond your first range increment ignore the range penalty.")
    ]);
    const classEntry = cls("Fletchwright, Horizon's Edge", "During a rest, craft 10 arrows from reeds; your ranged Strikes with them ignore the range penalty beyond your first range increment.", { level: 20, tags: ["craft", "ranged"] });
    const transport = scripted([{ proposals: [classEntry] }]);
    const out = await adapterFor(transport).authorProposal({ actor: makeActor(systemId, { registry: { skills }, gdLevel: 20 }), proposal: { id: "c", kind: "class", entry: { name: "Placeholder" } }, events: [{ summary: "Maren fletched arrows.", actorName: "Maren", tags: ["craft"], outcome: "success" }], systemId });
    assert.equal(out.proposals.length, 1, JSON.stringify(out.skippedProposals));
    assert.equal(out.proposals[0].kind, "class");
    // The same effect as an owned Skill, written as a Skill, is still a duplicate.
    const again = await adapterFor(scripted([{ proposals: [skill("Fletchwright: River Reeds", skills["skill:reed"].mechanics.effect, { tags: ["craft", "ranged"] })] }, { proposals: [] }]), { proposalMode: "always" })({ actor: makeActor(systemId, { registry: { skills } }), notes: "", events: [{ summary: "Maren fletched arrows.", actorName: "Maren", tags: ["craft"], outcome: "success" }], systemId });
    assert.ok(again.skippedProposals.some((s) => s.reason === "duplicates-owned"));
  });
}

// ---- 07b9d93f: a ban / eviction / arrest is the PC's own misdeed ----

const target = (quote, extra = {}) => ({ quote, actorName: "Wick", actorRole: "target", continuesPrevious: false, summary: quote, tags: [], themes: [], outcome: "success", dangerGap: "none", ...extra });

test("isConsequenceOfOwnDeed: bans, evictions and arrests; not an offer, an attack or an undeserved arrest", () => {
  for (const quote of ["I got banned from a pie tent", "Brakka got thrown out of the Copper Kettle", "wick got arrested by the watch", "they evicted Wick from the inn"]) {
    assert.equal(isConsequenceOfOwnDeed(target(quote)), true, quote);
  }
  for (const quote of ["a smuggler tried to recruit him", "Kesh got ambushed by two bandits", "Wick was falsely arrested for the mayor's murder", "wick got sized up by the guild fence"]) {
    assert.equal(isConsequenceOfOwnDeed(target(quote)), false, quote);
  }
  assert.equal(isConsequenceOfOwnDeed({ ...target("I got banned"), actorRole: "doer" }), false, "only rescues target entries");
  assert.equal(isConsequenceOfOwnDeed({ ...target("got banned from the tent"), actorName: "" }), false, "needs a named character");
});

test("the pipeline keeps 'I got banned from a pie tent' as Wick's failure; tr-034-style offers are still dropped", async () => {
  const transport = scripted([{ events: [
    target("I got banned from a pie tent"),
    target("a woman who wants a year of my dreams read me very well", { actorName: "Tovin" })
  ] }]);
  const request = buildAiGatewayRequest(makeActor("dnd5e", { name: "Wick" }), "Wick: I got banned from a pie tent. Tovin: read very well by a woman.", "dnd5e");
  const out = await runGatewayPipeline({ transport, request, config: { proposalMode: "never" }, systemId: "dnd5e" });
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].actorName, "Wick");
  assert.equal(out.events[0].outcome, "failure");
  assert.deepEqual(out.events[0].themes, ["misconduct"]);
  assert.equal(out.skippedEvents.filter((s) => s.reason === "happened-to-actor").length, 1);
  assert.ok(out.diagnostics.coercions.includes("target->doer:consequence-of-own-deed"));
});

test("the extraction prompt says a punishment stands for the PC's own misdeed", async () => {
  const transport = scripted([{ events: [] }]);
  await runGatewayPipeline({ transport, request: buildAiGatewayRequest(makeActor("pf2e"), "notes", "pf2e"), config: { proposalMode: "never" }, systemId: "pf2e" });
  assert.match(systemText(transport.calls[0]), /banned, barred, thrown or kicked out/);
});

// ---- live regression 2026-09-29: Suggest with 4 archery proposals pending answered nothing ----

for (const systemId of SYSTEMS) {
  test(`[${systemId}] mustPropose + an empty answer: one "propose something else" turn naming the pending ideas`, async () => {
    const pending = ["Longshot: Ridge Volley", "Longshot: Hawk Eye", "Longshot: Pinning Arrow", "Longshot: Wind Reader"].map((name, i) => ({
      id: `p${i}`, kind: "skill", status: "pending", entry: { name, mechanics: { effect: `Archery idea ${i}: +1 to ranged Strikes in situation ${i}.` }, metadata: { tags: ["ranged"] } }
    }));
    const events = [
      ...Array.from({ length: 4 }, (_, i) => ({ summary: `Maren shot a raider (${i}).`, quote: `shot raider ${i}`, actorName: "Maren", tags: ["ranged"], themes: ["archery"], outcome: "success" })),
      { summary: "Maren fletched a quiver of arrows from river reeds.", quote: "fletched arrows from reeds", actorName: "Maren", tags: ["craft"], themes: ["fletching"], outcome: "success" }
    ];
    const transport = scripted([
      { redCheck: [], proposals: [] },
      { proposals: [skill("Reedwright: River Fletching", "During a rest, craft 10 arrows from reeds; they deal +1 damage on your next ranged Strike.", { tags: ["craft"] })] }
    ]);
    const out = await adapterFor(transport, { proposalMode: "always" })({ actor: makeActor(systemId, { proposals: pending }), notes: "", events, systemId });
    assert.equal(transport.calls.length, 2);
    // The conversation array is shared and keeps growing; the retry is its last user turn.
    const retry = transport.calls[1].messages.findLast((m) => m.role === "user").content;
    assert.match(retry, /empty list is wrong/);
    assert.match(retry, /Longshot: Hawk Eye/);
    assert.equal(out.proposals.length, 1);
    assert.equal(out.proposals[0].entry.name, "Reedwright: River Fletching");
    assert.ok(out.gatewayDiagnostics.stages.some((s) => s.stage === "propose-retry"));
    assert.match(systemText(transport.calls[0]), /reason to look further, not to return nothing/);
  });

  test(`[${systemId}] no retry when the GM did not ask (when-earned, nothing owed)`, async () => {
    const transport = scripted([{ redCheck: [], proposals: [] }]);
    const events = Array.from({ length: 4 }, (_, i) => ({ summary: `Maren shot a raider (${i}).`, actorName: "Maren", tags: ["ranged"], themes: ["archery"], outcome: "success" }));
    await adapterFor(transport, { proposalMode: "when-earned" })({ actor: makeActor(systemId), notes: "", events, systemId });
    assert.equal(transport.calls.length, 1);
  });
}
