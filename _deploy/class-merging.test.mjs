import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGENDARY_TITLE_LEVEL,
  buildMergedClassName,
  computeMergeFocus,
  describeMergeRationale,
  mergeClassEntry,
  resolveMergedPowerTier
} from "../scripts/class-merging.js";
import { validateClassEntry } from "../scripts/validator.js";

// Three thematically disjoint sources (no tag overlap at all -> focus 0), used throughout the
// intentional-generalism tests below so the "unrewarded scatter" vs. "deliberate breadth" cases
// differ ONLY in the `intentional` flag, not in the underlying focus math.
function cinderwright({ power_tier }) {
  return { name: "Cinderwright", power_tier, is_primary: true, metadata: { id: "class:cinderwright", tags: ["fire", "craft"] } };
}
function nightwhisper({ power_tier }) {
  return { name: "Nightwhisper", power_tier, is_secondary: true, metadata: { id: "class:nightwhisper", tags: ["stealth", "occult"] } };
}
function hearthsong({ power_tier }) {
  return { name: "Hearthsong", power_tier, metadata: { id: "class:hearthsong", tags: ["support", "leadership"] } };
}

// Two source Classes, shaped exactly like the registry entries GrandDesignApi#getActorRegistry
// returns (name, power_tier, is_primary/is_secondary, metadata.{id,tags}) now that lineage.js's
// registerEntry persists those fields. Same two names throughout -- only their tag overlap and
// power tier change between fixtures, to isolate what the naming rule actually reacts to.
function spearmaster({ tags, power_tier }) {
  return {
    name: "Spearmaster",
    power_tier,
    is_primary: true,
    system_chassis: "Fighter",
    metadata: { id: "class:spearmaster", tags }
  };
}
function horizonsEdge({ tags, power_tier }) {
  return {
    name: "Horizon's Edge",
    power_tier,
    is_secondary: true,
    system_chassis: "Ranger",
    metadata: { id: "class:horizons-edge", tags }
  };
}

test("a moderately focused, standard-tier merge reads as one flowing phrase", () => {
  const sources = [
    spearmaster({ tags: ["martial", "precision"], power_tier: "standard" }),
    horizonsEdge({ tags: ["martial", "mobility"], power_tier: "standard" })
  ];
  const { focusScore } = computeMergeFocus(sources);
  const powerTier = resolveMergedPowerTier(sources, focusScore);
  const name = buildMergedClassName({ sourceClasses: sources, powerTier, focusScore, level: 10 });

  assert.ok(focusScore >= 0.2 && focusScore < 0.5, `expected middling focus, got ${focusScore}`);
  assert.equal(powerTier, "standard");
  assert.equal(name, "Spearmaster of Horizon's Edge");
});

test("the SAME two classes at high focus and elevated source tier become a prestige, comma-joined name", () => {
  const sources = [
    spearmaster({ tags: ["martial", "precision", "ranged"], power_tier: "elevated" }),
    horizonsEdge({ tags: ["martial", "precision", "mobility"], power_tier: "elevated" })
  ];
  const { focusScore } = computeMergeFocus(sources);
  const powerTier = resolveMergedPowerTier(sources, focusScore);
  const name = buildMergedClassName({ sourceClasses: sources, powerTier, focusScore, level: 25 });

  assert.ok(focusScore >= 0.5, `expected strong focus, got ${focusScore}`);
  assert.equal(powerTier, "prestige", "a tightly focused merge climbs one tier above its strongest source");
  assert.equal(name, "Spearmaster, Horizon's Edge", "prestige-tier focused merges keep both identities distinct, joined by a comma");
});

test("spreading across three unrelated disciplines caps power at standard despite elevated sources, even though the name gets longer", () => {
  const cinderwright = { name: "Cinderwright", power_tier: "elevated", metadata: { id: "class:cinderwright", tags: ["fire", "craft"] } };
  const nightwhisper = { name: "Nightwhisper", power_tier: "elevated", metadata: { id: "class:nightwhisper", tags: ["stealth", "support"] } };
  const hearthsong = { name: "Hearthsong", power_tier: "elevated", metadata: { id: "class:hearthsong", tags: ["performance", "diplomacy"] } };
  const sources = [cinderwright, nightwhisper, hearthsong];

  const { focusScore } = computeMergeFocus(sources);
  const powerTier = resolveMergedPowerTier(sources, focusScore);
  const name = buildMergedClassName({ sourceClasses: sources, powerTier, focusScore, level: 15 });
  const focusedPairName = "Spearmaster, Horizon's Edge";

  assert.ok(focusScore < 0.2, `expected a generalist grab-bag with low focus, got ${focusScore}`);
  assert.equal(powerTier, "standard", "generalizing across unrelated disciplines dilutes power no matter the source tiers");
  assert.equal(name, "Cinderwright Nightwhisper Hearthsong");
  assert.ok(
    name.length > focusedPairName.length,
    "the generalist name is visibly longer than the focused pair's name, but weaker -- length alone isn't power"
  );
});

test("a tightly focused, prestige-tier merge at the level-50 checkpoint earns a legendary title instead of a name built from its sources", () => {
  const veiledSeer = { name: "Veiled Seer", power_tier: "prestige", is_primary: true, metadata: { id: "class:veiled-seer", tags: ["occult", "mystery"] } };
  const dreamWarden = { name: "Dream Warden", power_tier: "prestige", is_secondary: true, metadata: { id: "class:dream-warden", tags: ["occult", "mystery"] } };
  const sources = [veiledSeer, dreamWarden];

  const { focusScore } = computeMergeFocus(sources);
  const powerTier = resolveMergedPowerTier(sources, focusScore);
  const name = buildMergedClassName({ sourceClasses: sources, powerTier, focusScore, level: LEGENDARY_TITLE_LEVEL });

  assert.equal(focusScore, 1, "identical tag sets are maximally focused");
  assert.equal(powerTier, "prestige");
  assert.equal(name, "The Ephemeral Purveyor of Lost Dreams");
});

test("the same tightly focused pair below level 50 still gets the comma name, not the legendary title", () => {
  const veiledSeer = { name: "Veiled Seer", power_tier: "prestige", is_primary: true, metadata: { id: "class:veiled-seer", tags: ["occult", "mystery"] } };
  const dreamWarden = { name: "Dream Warden", power_tier: "prestige", is_secondary: true, metadata: { id: "class:dream-warden", tags: ["occult", "mystery"] } };
  const sources = [veiledSeer, dreamWarden];

  const name = buildMergedClassName({ sourceClasses: sources, powerTier: "prestige", focusScore: 1, level: 30 });

  assert.equal(name, "Veiled Seer, Dream Warden");
});

test("describeMergeRationale explains the specialization/generalization tradeoff in each direction", () => {
  const focused = describeMergeRationale({
    sourceClasses: [{ name: "A" }, { name: "B" }],
    focusScore: 0.75,
    powerTier: "prestige"
  });
  const generalist = describeMergeRationale({
    sourceClasses: [{ name: "A" }, { name: "B" }, { name: "C" }],
    focusScore: 0.1,
    powerTier: "standard"
  });

  assert.match(focused, /specialized/i);
  assert.match(generalist, /uncommitted/i);
});

test("mergeClassEntry produces a fully valid, approvable Class entry with computed name, tier, and lineage", () => {
  const sources = [
    spearmaster({ tags: ["martial", "precision", "ranged"], power_tier: "elevated" }),
    horizonsEdge({ tags: ["martial", "precision", "mobility"], power_tier: "elevated" })
  ];

  const entry = mergeClassEntry({
    sourceClasses: sources,
    level: 25,
    gameItem: { kind: "passive" },
    mechanics: {
      effect: "Once per round, a melee Strike that hits within 10 feet of a fallen ally deals 1d6 additional precision damage.",
      duration: "instant",
      frequency: { max: 1, per: "round" }
    },
    tags: ["signature"]
  });

  assert.equal(entry.name, "Spearmaster, Horizon's Edge");
  assert.equal(entry.power_tier, "prestige");
  assert.equal(entry.level, 25);
  assert.equal(entry.system_chassis, "Fighter", "inherits the primary source's chassis by default");
  assert.deepEqual(
    entry.metadata.tags.sort(),
    ["martial", "mobility", "precision", "ranged", "signature"].sort()
  );
  assert.deepEqual(entry.metadata.lineage.sources, ["class:spearmaster", "class:horizons-edge"]);
  assert.equal(entry.metadata.lineage.operation, "combine");
  assert.match(entry.metadata.lineage.rationale, /specialized/i);

  const validation = validateClassEntry(entry);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.valid, true);
});

test("mergeClassEntry rejects fewer than two sources", () => {
  assert.throws(
    () => mergeClassEntry({ sourceClasses: [spearmaster({ tags: ["martial"], power_tier: "standard" })], level: 5 }),
    /at least two/i
  );
});

test("mergeClassEntry requires every source to carry a registry ID", () => {
  const noId = { name: "Nameless", power_tier: "standard", metadata: { tags: ["martial"] } };
  assert.throws(
    () => mergeClassEntry({ sourceClasses: [spearmaster({ tags: ["martial"], power_tier: "standard" }), noId], level: 5 }),
    /registry ID/i
  );
});

test("an unrewarded (non-intentional) generalist blend of three disjoint sources stays capped at standard", () => {
  const sources = [cinderwright({ power_tier: "elevated" }), nightwhisper({ power_tier: "elevated" }), hearthsong({ power_tier: "elevated" })];
  const { focusScore } = computeMergeFocus(sources);
  assert.ok(focusScore < 0.2, `expected a fully disjoint blend, got focus ${focusScore}`);
  assert.equal(resolveMergedPowerTier(sources, focusScore), "standard");
  assert.equal(resolveMergedPowerTier(sources, focusScore, { intentional: false }), "standard");
});

test("an INTENTIONAL generalist blend of the same three disjoint sources is not punished -- it climbs a tier above their average", () => {
  const sources = [cinderwright({ power_tier: "elevated" }), nightwhisper({ power_tier: "elevated" }), hearthsong({ power_tier: "elevated" })];
  const { focusScore } = computeMergeFocus(sources);
  const tier = resolveMergedPowerTier(sources, focusScore, { intentional: true });
  // average source rank is "elevated" (1) across all three -> climbs one tier to "prestige",
  // same ceiling a tightly focused specialist merge can reach, because the breadth here was real.
  assert.equal(tier, "prestige");
});

test("an intentional generalist that actually climbed a tier keeps every source identity intact (comma-joined), unlike an unrewarded scatter", () => {
  const sources = [cinderwright({ power_tier: "elevated" }), nightwhisper({ power_tier: "elevated" }), hearthsong({ power_tier: "elevated" })];
  const { focusScore } = computeMergeFocus(sources);

  const punishedName = buildMergedClassName({ sourceClasses: sources, powerTier: "standard", focusScore, level: 10, intentional: false });
  assert.equal(punishedName, "Cinderwright Nightwhisper Hearthsong");

  const rewardedTier = resolveMergedPowerTier(sources, focusScore, { intentional: true });
  const rewardedName = buildMergedClassName({ sourceClasses: sources, powerTier: rewardedTier, focusScore, level: 10, intentional: true });
  assert.equal(rewardedName, "Cinderwright, Nightwhisper, Hearthsong");
});

test("an intentional generalist that reaches level 50 at prestige earns its own polymath legendary title, distinct from the tag-keyed specialist one", () => {
  const sources = [cinderwright({ power_tier: "prestige" }), nightwhisper({ power_tier: "prestige" }), hearthsong({ power_tier: "prestige" })];
  const { focusScore } = computeMergeFocus(sources);
  const tier = resolveMergedPowerTier(sources, focusScore, { intentional: true });
  assert.equal(tier, "prestige");
  const name = buildMergedClassName({ sourceClasses: sources, powerTier: tier, focusScore, level: LEGENDARY_TITLE_LEVEL, intentional: true });
  assert.equal(name, "The Boundless Polymath of Ten Thousand Paths");
});

test("describeMergeRationale calls out intentional breadth explicitly, distinct from an uncommitted scatter", () => {
  const rationale = describeMergeRationale({
    sourceClasses: [{ name: "A" }, { name: "B" }, { name: "C" }],
    focusScore: 0.05,
    powerTier: "prestige",
    intentional: true
  });
  assert.match(rationale, /deliberate/i);
  assert.match(rationale, /intentional/i);
});

test("mergeClassEntry with intentional:true produces a fully valid Class entry at a rewarded tier", () => {
  const sources = [cinderwright({ power_tier: "elevated" }), nightwhisper({ power_tier: "elevated" }), hearthsong({ power_tier: "elevated" })];
  const entry = mergeClassEntry({
    sourceClasses: sources,
    level: 22,
    intentional: true,
    gameItem: { kind: "passive" },
    mechanics: { effect: "Once per day, apply a +1 circumstance bonus to any single skill check by drawing on an unrelated discipline.", duration: "instant", frequency: { max: 1, per: "day" } }
  });
  assert.equal(entry.power_tier, "prestige");
  assert.equal(entry.name, "Cinderwright, Nightwhisper, Hearthsong");
  const validation = validateClassEntry(entry);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.valid, true);
});

// --- Red (taboo/debuffing) merges -----------------------------------------------------------

function bloodboundReaver({ power_tier }) {
  return {
    name: "Bloodbound Reaver",
    power_tier,
    is_primary: true,
    metadata: {
      id: "class:bloodbound-reaver",
      tags: ["martial", "bloodlust"],
      polarity: "red",
      malignance: { vice: "bloodlust", drawback: "Cannot willingly disengage from a bloodied foe without a Will save." }
    }
  };
}
function veiledSeerStandard({ power_tier }) {
  return { name: "Veiled Seer", power_tier, is_secondary: true, metadata: { id: "class:veiled-seer", tags: ["occult", "bloodlust"] } };
}

test("a merge with one red source is red by contagion -- the standard source alone can't cleanse it", () => {
  const sources = [bloodboundReaver({ power_tier: "elevated" }), veiledSeerStandard({ power_tier: "elevated" })];
  const entry = mergeClassEntry({
    sourceClasses: sources,
    level: 10,
    gameItem: { kind: "passive" },
    mechanics: { effect: "Once per round, deal 1 extra damage against a bloodied foe.", duration: "instant", frequency: { max: 1, per: "round" } }
  });
  assert.equal(entry.metadata.polarity, "red");
  assert.equal(entry.metadata.malignance.vice, "bloodlust");
  assert.match(entry.metadata.malignance.drawback, /disengage/i);
  assert.match(entry.metadata.lineage.rationale, /malignance/i);
  const validation = validateClassEntry(entry);
  assert.deepEqual(validation.errors, []);
});

test("a red merge that reaches the legendary checkpoint gets a dark, vice-keyed title instead of the heroic one", () => {
  const a = { name: "Bloodbound Reaver", power_tier: "prestige", is_primary: true, metadata: { id: "class:a", tags: ["bloodlust"], polarity: "red", malignance: { vice: "bloodlust", drawback: "Cannot retreat from a bloodied foe." } } };
  const b = { name: "Crimson Oathbreaker", power_tier: "prestige", is_secondary: true, metadata: { id: "class:b", tags: ["bloodlust"], polarity: "red", malignance: { vice: "bloodlust", drawback: "Loses all allies' aid once per battle after the first kill." } } };
  const { focusScore } = computeMergeFocus([a, b]);
  assert.ok(focusScore >= 0.5, `expected a tightly focused red pair, got ${focusScore}`);
  const name = buildMergedClassName({ sourceClasses: [a, b], powerTier: "prestige", focusScore, level: LEGENDARY_TITLE_LEVEL, polarity: "red", vice: "bloodlust" });
  assert.equal(name, "The Blood-Soaked Reaver of a Thousand Kills");
});
