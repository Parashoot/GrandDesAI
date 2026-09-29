// Board 7f1f20ae: the live dnd5e world's emergent-theme registry held trophy-taking/taking-trophies,
// pie-eating/pie-contest, wrestling/arm-wrestling/wrestling-instruction, holding-line/holding-the-line
// and carving/whittling -- each counted separately and each able to mint its own "<Theme> Knack" --
// and themes from deleted test actors shared the world list. These pin the fold (and what it
// deliberately does NOT fold), the load-time migration, per-actor counts, own-repeat Knacks and the
// orphan purge. Emergent themes are system-agnostic; the Knack is checked on both systems.
import assert from "node:assert/strict";
import test from "node:test";

import {
  foldDuplicateThemes,
  generateEmergentProposals,
  listThemes,
  normalizeEmergentThemeState,
  observeThemes,
  purgeOrphanThemes,
  recountThemeActors,
  sameTheme,
  setThemeMapping,
  themeFoldKey,
  themeMapFromState
} from "../scripts/emergent-themes.js";
import { validateSkillEntry } from "../scripts/validator.js";

const ev = (id, themes, outcome = "success", extra = {}) => ({ id, summary: `event ${id}`, tags: [], themes, outcome, ...extra });

const LIVE_PAIRS = [
  ["trophy-taking", "taking-trophies"],
  ["pie-eating", "pie-contest"],
  ["holding-line", "holding-the-line"],
  ["carving", "whittling"],
  ["wrestling", "arm-wrestling"]
];

test("the five duplicate pairs from the live world fold to one key", () => {
  for (const [a, b] of LIVE_PAIRS) {
    assert.ok(sameTheme(a, b), `${a} ~ ${b} (${themeFoldKey(a)} vs ${themeFoldKey(b)})`);
  }
  // Word order, stopwords, plural/verb endings and case all fold.
  assert.ok(sameTheme("Taking Trophies", "trophy-taking"));
  assert.ok(sameTheme("holding the line", "hold-lines"));
});

test("wrestling-instruction stays its own theme: teaching is not practicing (conservative, no subset rule)", () => {
  assert.ok(!sameTheme("wrestling", "wrestling-instruction"));
  assert.ok(!sameTheme("arm-wrestling", "wrestling-instruction"));
  // The same caution keeps other qualified activities apart.
  assert.ok(!sameTheme("carving", "ice-sculpting"));
  assert.ok(!sameTheme("pie-eating", "pie-baking"));
  assert.ok(!sameTheme("beekeeping", "bee-stings"));
});

function liveRegistry() {
  const r = (count, firstSeen, extra = {}) => ({ count, label: "x", firstSeen, lastSeen: firstSeen, ...extra });
  return {
    themes: {
      "trophy-taking": r(3, "2026-09-01T00:00:00Z"),
      "taking-trophies": r(1, "2026-09-02T00:00:00Z"),
      "pie-eating": r(1, "2026-09-03T00:00:00Z"),
      "pie-contest": r(2, "2026-09-02T00:00:00Z"),
      wrestling: r(2, "2026-09-01T00:00:00Z", { actors: { brakka: 2 } }),
      "arm-wrestling": r(1, "2026-09-04T00:00:00Z", { actors: { brakka: 1 } }),
      "wrestling-instruction": r(1, "2026-09-05T00:00:00Z"),
      "holding-line": r(1, "2026-09-06T00:00:00Z"),
      "holding-the-line": r(2, "2026-09-05T00:00:00Z"),
      carving: r(1, "2026-09-01T00:00:00Z"),
      whittling: r(1, "2026-09-02T00:00:00Z")
    }
  };
}

test("foldDuplicateThemes migrates the live registry: one survivor per group, the rest merged (not deleted)", () => {
  const { state, folded } = foldDuplicateThemes(liveRegistry());
  const into = Object.fromEntries(folded.map(({ from, into: target }) => [from, target]));
  assert.deepEqual(into, {
    "taking-trophies": "trophy-taking",   // most seen survives
    "pie-contest": "pie-eating",          // the synonym list's canonical slug survives even with fewer sightings
    "arm-wrestling": "wrestling",
    "holding-line": "holding-the-line",   // most seen survives
    whittling: "carving"
  });
  assert.equal(state.themes["trophy-taking"].count, 4);
  assert.equal(state.themes["pie-eating"].count, 3);
  assert.equal(state.themes["pie-eating"].firstSeen, "2026-09-02T00:00:00Z", "the earliest sighting is kept");
  assert.deepEqual(state.themes.wrestling.actors, { brakka: 3 });
  assert.equal(state.themes["taking-trophies"].mergeInto, "trophy-taking");
  assert.equal(state.themes["taking-trophies"].folded, true);
  assert.equal(state.themes["wrestling-instruction"].mergeInto, undefined, "left alone");
  // Idempotent: running it again changes nothing.
  const again = foldDuplicateThemes(state);
  assert.deepEqual(again.folded, []);
  assert.deepEqual(again.state, state);
});

test("the migration runs on every registry load (normalizeEmergentThemeState) and survives a JSON round trip", () => {
  const loaded = normalizeEmergentThemeState(JSON.stringify(liveRegistry()));
  const map = themeMapFromState(loaded);
  assert.equal(map["taking-trophies"].mergeInto, "trophy-taking");
  assert.equal(map.whittling.mergeInto, "carving");
  const reloaded = normalizeEmergentThemeState(JSON.stringify(loaded));
  assert.deepEqual(reloaded, loaded);
  // The settings list shows the survivors first with the summed counts.
  const top = listThemes(loaded).slice(0, 3).map((theme) => theme.slug);
  assert.ok(top.includes("trophy-taking"));
});

test("GM curation is never folded away, and un-merging a folded theme keeps it separate for good", () => {
  const registry = liveRegistry();
  registry.themes["pie-contest"].labelEdited = true;
  registry.themes["pie-contest"].label = "Pie Contest (the county fair)";
  const { state } = foldDuplicateThemes(registry);
  assert.equal(state.themes["pie-contest"].mergeInto, undefined, "a renamed theme is the GM's call");

  const loaded = normalizeEmergentThemeState(liveRegistry());
  const unmerged = setThemeMapping(loaded, "whittling", { label: "Whittling" });
  assert.equal(unmerged.themes.whittling.mergeInto, undefined);
  assert.equal(unmerged.themes.whittling.keepSeparate, true);
  const reloaded = normalizeEmergentThemeState(JSON.stringify(unmerged));
  assert.equal(reloaded.themes.whittling.mergeInto, undefined, "not re-folded on the next load");
  // Re-saving the form with the merge still selected keeps it a (fold) merge.
  const kept = setThemeMapping(loaded, "taking-trophies", { mergeInto: "trophy-taking" });
  assert.equal(kept.themes["taking-trophies"].folded, true);
  assert.equal(kept.themes["taking-trophies"].keepSeparate, undefined);
});

test("observeThemes: a new near-duplicate counts on the known theme, is not 'new', and records per-actor counts", () => {
  const first = observeThemes({ themes: {} }, [ev("a", ["trophy-taking"])], "2026-09-01T00:00:00Z", { actorId: "tovin" });
  assert.deepEqual(first.newlySeen, ["trophy-taking"]);
  assert.deepEqual(first.state.themes["trophy-taking"].actors, { tovin: 1 });
  const second = observeThemes(first.state, [ev("b", ["taking-trophies"])], "2026-09-02T00:00:00Z", { actorId: "wick" });
  assert.deepEqual(second.newlySeen, []);
  assert.equal(second.state.themes["trophy-taking"].count, 2);
  assert.deepEqual(second.state.themes["trophy-taking"].actors, { tovin: 1, wick: 1 });
  assert.equal(second.state.themes["taking-trophies"].mergeInto, "trophy-taking");
  // Both spellings in one event are one practice, not two.
  const third = observeThemes(second.state, [ev("c", ["trophy-taking", "taking-trophies"])], "2026-09-03T00:00:00Z", { actorId: "tovin" });
  assert.equal(third.state.themes["trophy-taking"].count, 3);
  assert.deepEqual(third.state.themes["trophy-taking"].actors, { tovin: 2, wick: 1 });
  // An event's own actorId wins over the caller's.
  const fourth = observeThemes(third.state, [ev("d", ["carving"], "success", { actorId: "maren" })], "2026-09-04T00:00:00Z", { actorId: "tovin" });
  assert.deepEqual(fourth.state.themes.carving.actors, { maren: 1 });
});

for (const systemId of ["pf2e", "dnd5e"]) {
  test(`[${systemId}] near-duplicate themes on one actor produce ONE Knack, not one per spelling`, () => {
    const events = [ev("a", ["pie-contest"]), ev("b", ["pie-eating"]), ev("c", ["pie-contest"]), ev("d", ["pie-eating"])];
    const proposals = generateEmergentProposals(events, {}, { systemId });
    assert.equal(proposals.length, 1, proposals.map((p) => p.id).join(", "));
    assert.equal(proposals[0].theme, "pie-eating", "the synonym list's canonical slug");
    assert.deepEqual(proposals[0].evidence, ["a", "b", "c", "d"]);
    assert.equal(validateSkillEntry(proposals[0].entry).valid, true);
    if (systemId === "dnd5e") assert.doesNotMatch(proposals[0].entry.mechanics.effect, /circumstance/);
  });
}

test("the first spelling an actor used names the Knack (stable id as events accrue)", () => {
  const events = [ev("a", ["taking-trophies"]), ev("b", ["trophy-taking"]), ev("c", ["taking-trophies"])];
  // trophy-taking is the synonym-canonical slug for this key, so it wins regardless of order.
  assert.equal(generateEmergentProposals(events, {})[0].theme, "trophy-taking");
  const lines = [ev("a", ["holding-line"]), ev("b", ["holding-the-line"]), ev("c", ["holding-the-line"])];
  assert.equal(generateEmergentProposals(lines, {})[0].theme, "holding-line");
  assert.equal(generateEmergentProposals(lines.slice(0, 2).concat(lines.slice(2)), {})[0].id, "proposal:emergent-holding-line");
});

test("an approved Skill for one spelling (or a pending AI proposal) covers the other spelling", () => {
  const events = [ev("a", ["whittling"]), ev("b", ["whittling"]), ev("c", ["whittling"])];
  const registry = { skills: { "skill:woodsense": { name: "Woodsense", metadata: { themes: ["carving"] } } } };
  assert.deepEqual(generateEmergentProposals(events, registry), []);
  assert.deepEqual(generateEmergentProposals(events, {}, { excludeThemes: ["carving"] }), []);
});

test("a Knack needs the actor's OWN repeats: party-mates' events and a single big moment don't count", () => {
  const events = [
    ev("a", ["beekeeping"], "success", { actorName: "Maren" }),
    ev("b", ["beekeeping"], "success", { actorName: "Tovin" }),
    ev("c", ["beekeeping"], "success", { actorName: "Tovin" })
  ];
  assert.equal(generateEmergentProposals(events, {}).length, 1, "without actorNames every stored event counts (old behaviour)");
  assert.deepEqual(generateEmergentProposals(events, {}, { actorNames: ["Maren"] }), [], "Maren did it once; Tovin's two don't count for her");
  assert.equal(generateEmergentProposals(events, {}, { actorNames: ["Tovin"] }).length, 0, "Tovin: 2 own events = 2 evidence < 3");
  // An explicit repeat floor: one event is never practice, whatever its weight.
  assert.deepEqual(generateEmergentProposals([ev("a", ["gambling"], "criticalSuccess")], {}, { threshold: 1.5, minEvents: 2 }), []);
});

test("purgeOrphanThemes drops themes whose only actors are gone; legacy, curated and shared themes stay", () => {
  const state = normalizeEmergentThemeState({
    themes: {
      "pie-eating": { count: 3, label: "Pie Eating", firstSeen: null, actors: { "test-actor": 3 } },
      "pie-contest": { count: 0, label: "Pie Contest", firstSeen: null, mergeInto: "pie-eating", folded: true },
      beekeeping: { count: 5, label: "Beekeeping", firstSeen: null, actors: { maren: 4, "test-actor": 1 } },
      gambling: { count: 2, label: "Gambling", firstSeen: null }, // legacy: no per-actor data
      "card-sharping": { count: 1, label: "Card Tricks", labelEdited: true, firstSeen: null, actors: { "test-actor": 1 } }
    }
  });
  const { state: next, purged } = purgeOrphanThemes(state, ["maren", "tovin"]);
  assert.deepEqual(purged.sort(), ["pie-contest", "pie-eating"]);
  assert.equal(next.themes["pie-eating"], undefined);
  assert.deepEqual(next.themes.beekeeping.actors, { maren: 4 });
  assert.equal(next.themes.beekeeping.count, 4);
  assert.ok(next.themes.gambling, "legacy record without actors is kept");
  assert.ok(next.themes["card-sharping"], "GM-curated theme is kept");
});

test("recountThemeActors backfills per-actor counts from actors' stored events so legacy test themes can be purged", () => {
  const legacy = normalizeEmergentThemeState({
    themes: {
      "trophy-taking": { count: 4, label: "Trophy Taking", firstSeen: null },
      "taking-trophies": { count: 1, label: "Taking Trophies", firstSeen: null },
      "pie-eating": { count: 2, label: "Pie Eating", firstSeen: null }
    }
  });
  const recounted = recountThemeActors(legacy, [
    { actorId: "tovin", events: [ev("a", ["trophy-taking"]), ev("b", ["taking-trophies"])] },
    { actorId: "gd-test-actor", events: [ev("c", ["pie-eating"])] }
  ]);
  assert.deepEqual(recounted.themes["trophy-taking"].actors, { tovin: 2 }, "the folded spelling counts for its survivor");
  assert.equal(recounted.themes["trophy-taking"].count, 5, "world total untouched");
  const { purged } = purgeOrphanThemes(recounted, ["tovin"]);
  assert.deepEqual(purged, ["pie-eating"]);
});
