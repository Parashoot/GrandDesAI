import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseArgs,
  parseList,
  selectParty,
  resolveEntry,
  ownedFromRegistry,
  nameIndex,
  describeLineage,
  collectAdvanced,
  renderAdvancedSection,
  fallbackLines,
  describeRequestResult,
  NOT_AVAILABLE
} from "../tools/playtest/lib.mjs";

// Board c4ec8cf7: the playtest runner must exercise evolve/merge/titles/erosion and report them.
// These are the pure parts of tools/playtest/playtest.mjs (arguments, lookups, report rendering).

const registry = {
  version: 1,
  classes: {
    "class:hedge-druid": { name: "Hedge Druid", level: 3, power_tier: "standard", metadata: { id: "class:hedge-druid", tags: ["nature"], lineage: { operation: "origin", sources: [] } }, mechanics: { effect: "Druid chassis." } },
    "class:thorn-warden": { name: "Thorn Warden", level: 5, power_tier: "elevated", metadata: { id: "class:thorn-warden", polarity: "standard", tags: ["nature"], lineage: { operation: "combine", sources: ["class:hedge-druid", "class:gone"] } } }
  },
  skills: {
    "skill:old-snare": { name: "Old Snare", tier: 1, status: "superseded", metadata: { id: "skill:old-snare", lineage: { operation: "origin", sources: [] } } },
    "skill:thornweave": { name: "Thornweave", tier: 2, metadata: { id: "skill:thornweave", lineage: { operation: "upgrade", sources: ["skill:old-snare"] } }, mechanics: { effect: "Restrain a mover." } }
  },
  titles: {
    "title:bee-thief": { name: "Bee Thief", achievement: "stole the abbey hives", metadata: { id: "title:bee-thief", polarity: "red" } }
  }
};

test("parseArgs: command, valued flags, bare flags, quoted lists", () => {
  const { cmd, flags } = parseArgs(["merge", "--campaign", "x", "--actor", "Maren", "--classes", "Hedge Druid,thorn", "--sim", "--confirm"]);
  assert.equal(cmd, "merge");
  assert.deepEqual(flags, { campaign: "x", actor: "Maren", classes: "Hedge Druid,thorn", sim: true, confirm: true });
  assert.deepEqual(parseArgs(["owned"]).flags, {});
});

test("parseList and selectParty", () => {
  assert.deepEqual(parseList(" a, b,,c "), ["a", "b", "c"]);
  assert.deepEqual(parseList(true), []);
  const party = [{ name: "Maren" }, { name: "Wick" }, { name: "Tovin" }];
  assert.equal(selectParty(party, undefined).length, 3);
  assert.deepEqual(selectParty(party, "wick, TOVIN").map((p) => p.name), ["Wick", "Tovin"]);
});

test("resolveEntry: id, exact name, unique substring; ambiguity and misses are errors", () => {
  const owned = ownedFromRegistry(registry);
  assert.equal(resolveEntry(owned.skills, "skill:thornweave").name, "Thornweave");
  assert.equal(resolveEntry(owned.skills, "old snare").id, "skill:old-snare");
  assert.equal(resolveEntry(owned.classes, "warden").id, "class:thorn-warden");
  assert.throws(() => resolveEntry(owned.skills, "e", "Skill"),/matches several Skills/);
  assert.throws(() => resolveEntry(owned.skills, "fireball", "Skill"), /no Skill matches "fireball" \(owned: Old Snare, Thornweave\)/);
  assert.throws(() => resolveEntry(owned.skills, "", "Skill"), /no Skill given/);
});

test("ownedFromRegistry mirrors the getOwnedEntries contract; lineage prints source names", () => {
  const owned = ownedFromRegistry(registry);
  assert.equal(owned.classes.length, 2);
  const warden = owned.classes.find((c) => c.id === "class:thorn-warden");
  assert.deepEqual({ kind: warden.kind, level: warden.level, power_tier: warden.power_tier, status: warden.status }, { kind: "class", level: 5, power_tier: "elevated", status: "active" });
  assert.equal(owned.skills.find((s) => s.id === "skill:old-snare").status, "superseded");
  assert.equal(owned.titles[0].polarity, "red");
  assert.equal(owned.titles[0].effect, "stole the abbey hives");
  const names = nameIndex(owned);
  // An unknown source id (e.g. a deleted Class) prints as its id rather than vanishing.
  assert.equal(describeLineage(warden.lineage, names), "combine of Hedge Druid + class:gone");
  assert.equal(describeLineage({ operation: "origin", sources: [] }, names), "");
  assert.deepEqual(ownedFromRegistry(undefined), { classes: [], skills: [], titles: [] });
});

function todayApi(extra = {}) {
  return {
    getActorRegistry: () => registry,
    checkSkillEvolutionReadiness: () => [
      { skillId: "skill:thornweave", name: "Thornweave", evidenceWeight: 5.5, hasCatalyst: true, definingMoments: [{ id: "e1" }] },
      { skillId: "skill:old-snare", name: "Old Snare", evidenceWeight: 9, hasCatalyst: true, definingMoments: [] }
    ],
    checkClassErosion: (_actor, options) => [{ classId: "class:hedge-druid", name: "Hedge Druid", sessionsSinceLastSeen: options.sessionThreshold ?? 3, neverSeen: false }],
    getHorrorRank: () => ({ points: 2, totalLevelsDocked: 1 }),
    getGrowth: () => ({
      proposals: [
        { id: "p1", status: "pending", kind: "title", entry: { name: "Butcher of Brackwater", metadata: { polarity: "red" } } },
        { id: "p2", status: "pending", kind: "skill", entry: { name: "Bramble Cage", metadata: { lineage: { operation: "upgrade", sources: ["skill:thornweave"] } } } },
        { id: "p3", status: "pending", kind: "skill", entry: { name: "Plain Skill" } },
        { id: "p4", status: "approved", kind: "title", entry: { name: "Old Title" } }
      ]
    }),
    ...extra
  };
}

test("collectAdvanced with today's API: registry fallback, readiness from hasCatalyst, superseded skills dropped", () => {
  const adv = collectAdvanced(todayApi(), {}, { erosionThreshold: 2 });
  assert.equal(adv.ownedSource, "registry");
  assert.ok(adv.notes.some((n) => n.includes(`getOwnedEntries ${NOT_AVAILABLE}`)));
  assert.deepEqual(adv.evolutionReady.map((r) => r.skillId), ["skill:thornweave"]);
  assert.equal(adv.evolutionReady[0].pressure, 5.5);
  assert.equal(adv.erosion[0].sessionsSinceLastSeen, 2);
  assert.deepEqual(adv.horrorRank, { points: 2, totalLevelsDocked: 1 });
  assert.deepEqual(adv.pendingAdvanced.map((p) => p.id), ["p1", "p2"]);
});

test("collectAdvanced prefers getOwnedEntries and the analysis' own evolutionReady", () => {
  const api = todayApi({
    getOwnedEntries: () => ({ classes: [], skills: [{ id: "s", name: "S", kind: "skill", tier: 1, status: "active" }], titles: [] }),
    checkSkillEvolutionReadiness: () => {
      throw new Error("should not be called");
    }
  });
  const adv = collectAdvanced(api, {}, { analysis: { evolutionReady: [{ skillId: "s", name: "S", pressure: 7 }] } });
  assert.equal(adv.ownedSource, "getOwnedEntries");
  assert.equal(adv.readySource, "api");
  assert.deepEqual(adv.evolutionReady, [{ skillId: "s", name: "S", pressure: 7 }]);
  assert.deepEqual(adv.notes, []);
});

test("renderAdvancedSection: owned with lineage names, ready, erosion, Horror Rank, pending advanced", () => {
  const md = renderAdvancedSection(collectAdvanced(todayApi(), {}));
  const expected = [
    "### Advanced mechanics",
    "",
    "Owned (4 active, 1 superseded):",
    "- class: **Hedge Druid** (level 3, standard)",
    "- class: **Thorn Warden** (level 5, elevated; combine of Hedge Druid + class:gone)",
    "- skill: ~~Old Snare~~ (superseded) (tier 1)",
    "- skill: **Thornweave** (tier 2; upgrade of Old Snare)",
    "- title: **Bee Thief** (RED)",
    "",
    "Evolution ready: **Thornweave** (pressure 5.5)",
    "Erosion (Classes at risk): **Hedge Druid** (3 session(s) since its tags)",
    "Horror Rank: 2 point(s), 1 level(s) docked",
    "Pending advanced proposals: Butcher of Brackwater [title, RED]; Bramble Cage [skill/upgrade of Thornweave]",
    `_getOwnedEntries ${NOT_AVAILABLE} (read from the registry)_`,
    ""
  ].join("\n");
  assert.equal(md, expected);
});

test("renderAdvancedSection: empty actor and a build without getHorrorRank", () => {
  const md = renderAdvancedSection({ owned: { classes: [], skills: [], titles: [] }, evolutionReady: [], erosion: [], horrorRank: null, pendingAdvanced: [], notes: [] });
  assert.match(md, /- _nothing owned yet_/);
  assert.match(md, /Evolution ready: none/);
  assert.match(md, /Erosion \(Classes at risk\): none/);
  assert.match(md, new RegExp(`Horror Rank: ${NOT_AVAILABLE}`));
});

test("fallbackLines states every AI fallback with its reason, and nothing when the AI delivered", () => {
  assert.deepEqual(fallbackLines({ analysis: { source: "adapter" }, pending: [{ entry: { name: "A" } }] }), []);
  const lines = fallbackLines({
    analysis: { source: "local-fallback", adapterError: "timeout after 90s" },
    restResult: { warnings: ["Class evolution at Grand Design level 10: used the built-in template (no provider)."] },
    pending: [{ id: "x", usedFallback: true, fallbackReason: "AI returned no class", entry: { name: "Druid Evolution" } }],
    requests: [{ label: "evolve Thornweave", usedFallback: true, reason: "provider down" }]
  });
  assert.deepEqual(lines, [
    "analysis read by local-fallback: timeout after 90s",
    "rest: Class evolution at Grand Design level 10: used the built-in template (no provider).",
    'proposal "Druid Evolution" is a fallback: AI returned no class',
    "evolve Thornweave: usedFallback (provider down)"
  ]);
});

test("describeRequestResult: AI-authored vs fallback", () => {
  const proposal = { id: "p9", kind: "skill", entry: { name: "Bramble Cage", tier: 3, metadata: { lineage: { operation: "upgrade" } } } };
  assert.equal(describeRequestResult("evolve", { proposal, usedFallback: false }), 'evolve: pending proposal "Bramble Cage" (skill, tier 3, upgrade) -- authored by the AI');
  assert.equal(describeRequestResult("merge", { proposal: { id: "q", kind: "class", entry: { name: "M", level: 5, power_tier: "elevated" } }, usedFallback: true, reason: "timeout" }), 'merge: pending proposal "M" (class, level 5, elevated) -- usedFallback: timeout');
  assert.match(describeRequestResult("evolve", null), /no proposal/);
});
