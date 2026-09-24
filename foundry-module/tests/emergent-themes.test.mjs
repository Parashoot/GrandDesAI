import assert from "node:assert/strict";
import test from "node:test";

import {
  applyThemeMap,
  buildEmergentSkillEntry,
  EMERGENT_PROPOSAL_PREFIX,
  EMERGENT_THEME_EVIDENCE_THRESHOLD,
  generateEmergentProposals,
  listThemes,
  normalizeEmergentThemeState,
  observeThemes,
  setThemeMapping,
  splitTagsAndThemes,
  themeEvidence,
  themeMapFromState
} from "../scripts/emergent-themes.js";
import { validateSkillEntry } from "../scripts/validator.js";
import { validateGrowthEvent } from "../scripts/progression.js";

// Emergent themes are how "Maren kept bees for three sessions" becomes a [Beekeeper]-flavored Skill
// instead of nothing. These pin the evidence math (same outcome weights as canonical tags), the
// proposal threshold, the registry exclusion, and every GM theme-map operation.

const ev = (id, themes, outcome = "success", tags = []) => ({ id, summary: `event ${id}`, tags, themes, outcome });

test("the evidence threshold is 3, on the same scale as canonical tags", () => {
  assert.equal(EMERGENT_THEME_EVIDENCE_THRESHOLD, 3);
});

test("themeEvidence weights outcomes like canonical tags (crit 1.6, success 1, critFail 0.5, fail 0.25)", () => {
  const evidence = themeEvidence([
    ev("a", ["beekeeping"], "criticalSuccess"),
    ev("b", ["beekeeping"], "success"),
    ev("c", ["beekeeping"], "criticalFailure"),
    ev("d", ["beekeeping"], "failure"),
    ev("e", ["gambling"], "success")
  ]);
  assert.ok(Math.abs(evidence.get("beekeeping") - 3.35) < 1e-9);
  assert.equal(evidence.get("gambling"), 1);
});

test("themeEvidence counts a theme once per event and ignores bad outcomes / junk", () => {
  const evidence = themeEvidence([ev("a", ["x", "x"]), ev("b", ["x"], "banana"), { themes: [5, "", null] }, null, "str"]);
  assert.equal(evidence.get("x"), 1);
  assert.equal(evidence.size, 1);
});

test("themeEvidence tolerates non-array input", () => {
  assert.equal(themeEvidence(undefined).size, 0);
  assert.equal(themeEvidence({}).size, 0);
});

test("no proposal below the threshold", () => {
  assert.deepEqual(generateEmergentProposals([ev("a", ["beekeeping"]), ev("b", ["beekeeping"])], {}), []);
});

test("three successes on a theme yield exactly one pending emergent proposal with the contract shape", () => {
  const proposals = generateEmergentProposals([ev("a", ["beekeeping"]), ev("b", ["beekeeping"]), ev("c", ["beekeeping"])], {});
  assert.equal(proposals.length, 1);
  const [proposal] = proposals;
  assert.equal(proposal.id, `${EMERGENT_PROPOSAL_PREFIX}beekeeping`);
  assert.equal(proposal.id, "proposal:emergent-beekeeping");
  assert.equal(proposal.kind, "skill");
  assert.equal(proposal.status, "pending");
  assert.equal(proposal.source, "emergent");
  assert.equal(proposal.needsAuthoring, true);
  assert.equal(proposal.theme, "beekeeping");
  assert.deepEqual(proposal.evidence, ["a", "b", "c"]);
});

test("the placeholder entry passes the real skill validator", () => {
  const [proposal] = generateEmergentProposals([ev("a", ["card-sharping"]), ev("b", ["card-sharping"]), ev("c", ["card-sharping"])], {});
  assert.deepEqual(validateSkillEntry(proposal.entry).errors, []);
  assert.deepEqual(proposal.entry.metadata.themes, ["card-sharping"]);
  assert.match(proposal.entry.name, /Card Sharping/);
});

test("buildEmergentSkillEntry is valid for odd slugs too", () => {
  for (const slug of ["x", "a-very-long-theme-slug-for-testing", "glassblowing", "b2b"]) {
    assert.deepEqual(validateSkillEntry(buildEmergentSkillEntry(slug, { evidenceIds: ["e1"], weight: 3 })).errors, [], slug);
  }
});

test("failures alone can reach the threshold (persistence counts): 12 failures = 3.0", () => {
  const events = Array.from({ length: 12 }, (_, i) => ev(`f${i}`, ["glassblowing"], "failure"));
  assert.equal(generateEmergentProposals(events, {}).length, 1);
  assert.equal(generateEmergentProposals(events.slice(0, 11), {}).length, 0);
});

test("a custom threshold is honored", () => {
  assert.equal(generateEmergentProposals([ev("a", ["fishing"])], {}, { threshold: 1 }).length, 1);
  assert.equal(generateEmergentProposals([ev("a", ["fishing"]), ev("b", ["fishing"]), ev("c", ["fishing"])], {}, { threshold: 5 }).length, 0);
});

test("an approved registry Skill for the theme suppresses the proposal", () => {
  const events = [ev("a", ["beekeeping"]), ev("b", ["beekeeping"]), ev("c", ["beekeeping"])];
  const byTheme = { skills: { "skill:apiarist-calm": { name: "Apiarist's Calm", metadata: { themes: ["beekeeping"] } } } };
  assert.deepEqual(generateEmergentProposals(events, byTheme), []);
  const byName = { skills: { "skill:beekeeping-knack": { name: "Beekeeping Knack" } } };
  assert.deepEqual(generateEmergentProposals(events, byName), []);
});

test("an unrelated registry Skill does not suppress the proposal", () => {
  const events = [ev("a", ["beekeeping"]), ev("b", ["beekeeping"]), ev("c", ["beekeeping"])];
  assert.equal(generateEmergentProposals(events, { skills: { "skill:x": { name: "X", metadata: { themes: ["fishing"] } } } }).length, 1);
});

test("canonical tags on an event never become emergent proposals", () => {
  const events = [ev("a", [], "success", ["martial"]), ev("b", [], "success", ["martial"]), ev("c", [], "success", ["martial"])];
  assert.deepEqual(generateEmergentProposals(events, {}), []);
});

test("applyThemeMap: ignored themes are dropped", () => {
  const [out] = applyThemeMap([ev("a", ["vibes", "beekeeping"])], { vibes: { ignored: true } });
  assert.deepEqual(out.themes, ["beekeeping"]);
});

test("applyThemeMap: mergeInto folds synonyms into one theme (chains followed)", () => {
  const map = { "bee-keeping": { mergeInto: "apiculture" }, apiculture: { mergeInto: "beekeeping" } };
  const [out] = applyThemeMap([ev("a", ["bee-keeping", "apiculture"])], map);
  assert.deepEqual(out.themes, ["beekeeping"]);
});

test("applyThemeMap: mapTo turns a theme into a canonical tag", () => {
  const [out] = applyThemeMap([ev("a", ["cooking"], "success", ["support"])], { cooking: { mapTo: "craft" } });
  assert.deepEqual(out.tags, ["support", "craft"]);
  assert.deepEqual(out.themes, []);
  assert.equal(validateGrowthEvent(out).valid, true);
});

test("applyThemeMap: mapTo to a non-canonical tag is ignored (theme kept)", () => {
  const [out] = applyThemeMap([ev("a", ["cooking"])], { cooking: { mapTo: "cheffery" } });
  assert.deepEqual(out.themes, ["cooking"]);
});

test("applyThemeMap: label-only (rename) entries leave events untouched", () => {
  const events = [ev("a", ["cooking"])];
  const [out] = applyThemeMap(events, { cooking: { label: "Hearthcraft" } });
  assert.equal(out, events[0]);
});

test("applyThemeMap never mutates its input and returns the same object when nothing changes", () => {
  const events = [ev("a", ["beekeeping"]), ev("b", [], "success", ["martial"])];
  const snapshot = JSON.stringify(events);
  const out = applyThemeMap(events, { vibes: { ignored: true } });
  assert.equal(JSON.stringify(events), snapshot);
  assert.equal(out[0], events[0]);
  assert.equal(out[1], events[1]);
});

test("applyThemeMap survives a merge cycle", () => {
  assert.doesNotThrow(() => applyThemeMap([ev("a", ["x"])], { x: { mergeInto: "y" }, y: { mergeInto: "x" } }));
});

test("applyThemeMap with a non-array returns []", () => {
  assert.deepEqual(applyThemeMap(null, {}), []);
});

test("generateEmergentProposals applies the theme map first: merged evidence combines", () => {
  const events = [ev("a", ["bee-keeping"]), ev("b", ["apiculture"]), ev("c", ["beekeeping"])];
  const map = { "bee-keeping": { mergeInto: "beekeeping" }, apiculture: { mergeInto: "beekeeping" } };
  const proposals = generateEmergentProposals(events, {}, { themeMap: map });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].theme, "beekeeping");
  assert.deepEqual(proposals[0].evidence, ["a", "b", "c"]);
});

test("generateEmergentProposals: ignored and mapped themes never propose", () => {
  const events = [ev("a", ["vibes", "cooking"]), ev("b", ["vibes", "cooking"]), ev("c", ["vibes", "cooking"])];
  assert.deepEqual(generateEmergentProposals(events, {}, { themeMap: { vibes: { ignored: true }, cooking: { mapTo: "craft" } } }), []);
});

test("generateEmergentProposals: a GM label renames the placeholder Skill", () => {
  const events = [ev("a", ["cooking"]), ev("b", ["cooking"]), ev("c", ["cooking"])];
  const [proposal] = generateEmergentProposals(events, {}, { themeMap: { cooking: { label: "Hearthcraft" } } });
  assert.equal(proposal.entry.name, "Hearthcraft Knack");
});

test("splitTagsAndThemes: canonical, synonym, alsoTheme and unknown words land in the right bucket", () => {
  const { tags, themes, remapped } = splitTagsAndThemes(["martial", "melee", "cooking", "beekeeping", "none", "", 5]);
  assert.deepEqual(tags, ["martial", "craft"]);
  assert.deepEqual(themes.sort(), ["beekeeping", "cooking"]);
  assert.equal(remapped.melee, "martial");
});

test("splitTagsAndThemes: a throwing resolver degrades to keeping the word as a theme", () => {
  const { themes } = splitTagsAndThemes(["Weird Thing"], { resolveTag: () => { throw new Error("boom"); } });
  assert.deepEqual(themes, ["weird-thing"]);
});

test("normalizeEmergentThemeState accepts garbage and JSON strings", () => {
  assert.deepEqual(normalizeEmergentThemeState(undefined), { themes: {} });
  assert.deepEqual(normalizeEmergentThemeState("{nope"), { themes: {} });
  const state = normalizeEmergentThemeState(JSON.stringify({ themes: { "Bee Keeping": { count: 2.7, mapTo: "bogus" }, x: null } }));
  assert.deepEqual(Object.keys(state.themes), ["beekeeping"]);
  assert.equal(state.themes.beekeeping.count, 2);
  assert.equal("mapTo" in state.themes.beekeeping, false);
});

test("observeThemes counts themes and reports first sightings deterministically", () => {
  const now = "2026-09-23T00:00:00.000Z";
  const first = observeThemes({}, [ev("a", ["beekeeping"]), ev("b", ["beekeeping", "fishing"])], now);
  assert.deepEqual(first.newlySeen, ["beekeeping", "fishing"]);
  assert.equal(first.state.themes.beekeeping.count, 2);
  const second = observeThemes(first.state, [ev("c", ["beekeeping"])], now);
  assert.deepEqual(second.newlySeen, []);
  assert.equal(second.state.themes.beekeeping.count, 3);
});

test("setThemeMapping: rename, map, merge, ignore, and clear round-trip through themeMapFromState", () => {
  let state = observeThemes({}, [ev("a", ["cooking", "bee-keeping", "vibes"])], "t").state;
  state = setThemeMapping(state, "cooking", { label: "Hearthcraft", mapTo: "craft" });
  state = setThemeMapping(state, "bee-keeping", { mergeInto: "apiculture" });
  state = setThemeMapping(state, "vibes", { ignored: true });
  const map = themeMapFromState(state);
  assert.deepEqual(map.cooking, { label: "Hearthcraft", mapTo: "craft" });
  assert.deepEqual(map.beekeeping, { mergeInto: "apiculture" });
  assert.deepEqual(map.vibes, { ignored: true });
  state = setThemeMapping(state, "cooking", null);
  assert.equal(themeMapFromState(state).cooking, undefined);
});

test("setThemeMapping rejects unknown tags, self-merges, and merge loops with readable errors", () => {
  const state = observeThemes({}, [ev("a", ["x", "y"])], "t").state;
  assert.throws(() => setThemeMapping(state, "x", { mapTo: "cheffery" }), /not a canonical gameplay tag/);
  assert.throws(() => setThemeMapping(state, "x", { mergeInto: "x" }), /into itself/);
  const merged = setThemeMapping(state, "x", { mergeInto: "y" });
  assert.throws(() => setThemeMapping(merged, "y", { mergeInto: "x" }), /loop/);
  assert.throws(() => setThemeMapping(state, "", {}), /slug is required/);
});

test("listThemes sorts most-practiced first", () => {
  const { state } = observeThemes({}, [ev("a", ["beta"]), ev("b", ["alpha", "beta"])], "t");
  assert.deepEqual(listThemes(state).map((t) => t.slug), ["beta", "alpha"]);
});
