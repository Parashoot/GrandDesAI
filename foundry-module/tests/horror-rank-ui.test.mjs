// Horror Rank UI (board 21e944ed, UI half; batch 3 contract sections 3 and 5). The API's new
// getHorrorRank shape and the horrorRankChanged hook are written in parallel, so both the contract
// shape and today's { points, totalLevelsDocked } are tested, for a dnd5e and a PF2e character.
import test from "node:test";
import assert from "node:assert/strict";

import {
  createHorrorRankNotifier,
  darkDeedsFromEvents,
  describeHorrorRankChange,
  normalizeHorrorRankView,
  renderDarkDeedBadge,
  renderEventLine,
  renderGrowthContent,
  renderHorrorRankMeter,
  renderProposal
} from "../scripts/growth-ui.js";
import { renderRegistryContent } from "../scripts/registry-ui.js";

const aiStatus = { kind: "ai", text: "AI: qwen3.8:27b", title: "" };

// Contract shape: Tovin (dnd5e, ember-road) killed a goblin that was surrendering, then worse.
const tovinState = {
  points: 135,
  stage: 1,
  nextThreshold: 200,
  totalLevelsDocked: 2,
  deeds: [
    { eventId: "e1", summary: "Tovin killed a goblin that was surrendering", vice: "cruelty", severity: "serious", points: 15 },
    { eventId: "e2", summary: "Tovin ate the fallen scout", vice: "desecration", severity: "monstrous", points: 40 }
  ]
};

test("normalizeHorrorRankView: contract shape is used as sent", () => {
  const view = normalizeHorrorRankView(tovinState);
  assert.equal(view.stage, 1);
  assert.equal(view.nextThreshold, 200);
  assert.equal(view.threshold, 100);
  assert.equal(view.totalLevelsDocked, 2);
  assert.equal(view.deeds.length, 2);
  assert.equal(view.derivedDeeds, false);
  assert.deepEqual(view.deeds[1], { eventId: "e2", summary: "Tovin ate the fallen scout", vice: "desecration", severity: "monstrous", points: 40 });
});

test("normalizeHorrorRankView: today's { points, totalLevelsDocked } plus events derive stage, next threshold and deeds", () => {
  const events = [
    { id: "a", summary: "Buck held the line", darkDeed: "none", darkSeverity: "none" },
    { id: "b", summary: "Buck tortured the smuggler for fun", darkDeed: "cruelty", darkSeverity: "monstrous" },
    { id: "c", summary: "Buck broke an oath to the harbour-master", darkDeed: "betrayal", darkSeverity: "minor" },
    { id: "d", summary: "Old event without the field" }
  ];
  const view = normalizeHorrorRankView({ points: 45, totalLevelsDocked: 0 }, events);
  assert.equal(view.stage, 0);
  assert.equal(view.nextThreshold, 100);
  assert.equal(view.derivedDeeds, true);
  assert.deepEqual(view.deeds.map((deed) => [deed.eventId, deed.vice, deed.severity, deed.points]), [["b", "cruelty", "monstrous", 40], ["c", "betrayal", "minor", 5]]);
  // Nothing at all (API missing, flag empty): a clean Stage 0, never a throw.
  assert.deepEqual(normalizeHorrorRankView(null), { points: 0, stage: 0, nextThreshold: 100, threshold: 100, totalLevelsDocked: 0, deeds: [], derivedDeeds: true, atonements: [], suppression: { due: 0, held: 0, suppressed: [], candidates: [], defaultCandidateId: null, restoreDefaultId: null }, docks: [], lockedOut: false });
  // The stage caps at 3 and the last stage has no next threshold.
  const last = normalizeHorrorRankView({ points: 999 });
  assert.equal(last.stage, 3);
  assert.equal(last.nextThreshold, null);
});

test("darkDeedsFromEvents ignores 'none', missing fields and junk", () => {
  assert.deepEqual(darkDeedsFromEvents([null, {}, { darkDeed: "none" }, { darkDeed: " None " }, "x"]), []);
  assert.equal(darkDeedsFromEvents([{ id: "z", darkDeed: "ruin", darkSeverity: "serious", summary: "s" }])[0].points, 15);
});

test("renderHorrorRankMeter: stage pips, points / next threshold, flavour, levels lost, deeds quoting their summaries", () => {
  const html = renderHorrorRankMeter(tovinState);
  assert.match(html, /Horror Rank: Stage 1, Shadowed/);
  assert.match(html, /gd-horror-pip gd-on gd-current" title="Stage 1: Shadowed"/);
  assert.match(html, /135 \/ 200 points to Stage 2 \(Marked\)/);
  assert.match(html, /aria-valuenow="35"/, "35 of the 100 points between Stage 1 and Stage 2");
  assert.match(html, /The deeds are noticed/);
  assert.match(html, /2 Class levels lost to Horror Rank so far/);
  assert.match(html, /The deeds that made it \(2\)/);
  assert.match(html, /&ldquo;Tovin killed a goblin that was surrendering&rdquo;/);
  assert.match(html, /gd-dark-deed gd-dark-monstrous"[^>]*><i class="fas fa-skull"><\/i> desecration, monstrous/);
  assert.match(html, /\+40/);
  assert.match(html, /refuses the power, not the stain/);
});

test("renderHorrorRankMeter: a clean character gets one quiet line; the last stage says so", () => {
  const clean = renderHorrorRankMeter({ points: 0, totalLevelsDocked: 0 });
  assert.match(clean, /gd-horror-clean/);
  assert.match(clean, /Stage 0, Unstained/);
  assert.doesNotMatch(clean, /gd-horror-bar/);
  const horror = renderHorrorRankMeter({ points: 320, stage: 3, nextThreshold: null, deeds: [] });
  assert.match(horror, /Stage 3, Horror/);
  assert.match(horror, /320 points: the last stage/);
  assert.match(horror, /\[Guardsman\] who became a horror/);
});

test("renderHorrorRankMeter escapes deed summaries", () => {
  const html = renderHorrorRankMeter({ points: 15, deeds: [{ summary: "<img src=x onerror=alert(1)>", vice: "cruelty", severity: "serious" }] });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("dark-deed badge on events in Recorded Evidence and the reading of the last notes; none on clean events", () => {
  assert.equal(renderDarkDeedBadge({ darkDeed: "none", darkSeverity: "none" }), "");
  assert.equal(renderDarkDeedBadge({}), "");
  const line = renderEventLine({ id: "e1", summary: "Tovin killed a goblin that was surrendering", outcome: "success", darkDeed: "cruelty", darkSeverity: "serious", tags: ["combat"] });
  assert.match(line, /gd-chip gd-dark-deed gd-dark-serious/);
  assert.match(line, /cruelty, serious/);
  assert.match(line, /\+15 points/);
  const events = [
    { id: "e1", summary: "Tovin killed a goblin that was surrendering", outcome: "success", darkDeed: "cruelty", darkSeverity: "serious", tags: ["combat"] },
    { id: "e2", summary: "Tovin mended the cart", outcome: "success", darkDeed: "none", darkSeverity: "none", tags: ["crafting"] }
  ];
  const html = renderGrowthContent({ growth: { events }, progression: { level: 2, grantAllowances: 0 }, pending: [], status: aiStatus });
  const history = html.slice(html.indexOf('class="gd-history"'));
  assert.equal((history.match(/gd-dark-deed/g) ?? []).length, 1);
  // With today's API (no deeds list), the Growth dialog's meter lists the deed from the events.
  assert.match(html, /Horror Rank: Stage 0, Unstained/);
  assert.match(html, /The deed that made it \(1\)/);
});

test("Growth dialog shows the meter from getHorrorRank's contract shape (dnd5e and PF2e alike)", () => {
  for (const systemId of ["dnd5e", "pf2e"]) {
    const html = renderGrowthContent({ growth: { events: [] }, progression: { level: 4 }, pending: [], status: aiStatus, horrorRank: tovinState, systemId });
    assert.match(html, /Horror Rank: Stage 1, Shadowed/);
    assert.ok(html.indexOf("gd-horror") < html.indexOf("Pending Proposals"), "the meter sits in the header area");
  }
});

test("red proposal: a hint (not a blocker) that rejecting refuses the power, not the stain", () => {
  const red = {
    id: "p-red", status: "pending", kind: "skill", source: "ai-gateway",
    entry: { name: "Merciless Finish", tier: 1, mechanics: { effect: "..." }, metadata: { polarity: "red", malignance: { vice: "cruelty", drawback: "..." } } }
  };
  const html = renderProposal(red);
  assert.match(html, /gd-red-reject-hint/);
  assert.match(html, /refuses the power, not the stain/);
  assert.match(html, /data-action="gd-reject-proposal" data-proposal-id="p-red" aria-busy="false" title="Reject this red proposal: the power is refused/);
  assert.doesNotMatch(html, /data-action="gd-reject-proposal"[^>]*disabled/, "reject stays available");
  const plain = renderProposal({ ...red, entry: { ...red.entry, metadata: {} } });
  assert.doesNotMatch(plain, /gd-red-reject-hint/);
});

test("Registry panel: header chip with the stage plus the full meter; today's API shape still renders", () => {
  const owned = { classes: [], skills: [], titles: [] };
  const html = renderRegistryContent({ actorName: "Tovin", owned, horrorRank: tovinState });
  assert.match(html, /Horror Rank 135 \(Stage 1\), 2 level\(s\) docked/);
  assert.match(html, /Horror Rank: Stage 1, Shadowed/);
  assert.match(html, /Tovin ate the fallen scout/);
  const old = renderRegistryContent({ actorName: "Buck", owned, horrorRank: { points: 25, totalLevelsDocked: 0 }, events: [{ id: "b", summary: "Buck tortured the smuggler", darkDeed: "cruelty", darkSeverity: "monstrous" }] });
  assert.match(old, /Horror Rank 25 \(Stage 0\)/);
  assert.match(old, /25 \/ 100 points to Stage 1 \(Shadowed\)/);
  assert.match(old, /Buck tortured the smuggler/);
  const none = renderRegistryContent({ actorName: "Pim", owned });
  assert.match(none, /gd-horror-clean/);
});

test("describeHorrorRankChange: names the Class and the levels lost, and the stage change", () => {
  const notices = describeHorrorRankChange({
    actorName: "Brakka",
    state: { points: 210, stage: 2 },
    dockedFrom: [{ classId: "class:bridge-warden", levelsDocked: 1 }, { classId: "class:gone", levelsDocked: 0 }],
    previousStage: 1,
    className: (id) => (id === "class:bridge-warden" ? "Bridge Warden" : null)
  });
  assert.deepEqual(notices[0], { level: "warn", message: "Brakka's Bridge Warden lost 1 level to Horror Rank." });
  assert.equal(notices.length, 2, "a zero-level dock says nothing");
  assert.match(notices[1].message, /^Brakka's Horror Rank rose to Stage 2 \(Marked\)\./);
  // Unknown Class name: the id is prettified, never shown raw.
  const [fallback] = describeHorrorRankChange({ actorName: "Buck", dockedFrom: [{ classId: "class:harbour-brawler", levelsDocked: 2 }] });
  assert.equal(fallback.message, "Buck's Harbour Brawler lost 2 levels to Horror Rank.");
});

test("createHorrorRankNotifier: one notice per docking even when both hooks fire; stage rise announced once", () => {
  const seen = [];
  let clock = 1000;
  const notifier = createHorrorRankNotifier({
    notify: (level, message) => seen.push([level, message]),
    className: (_actor, id) => ({ "class:bridge-warden": "Bridge Warden" })[id] ?? null,
    now: () => clock
  });
  const brakka = { id: "a1", name: "Brakka" };
  const docked = [{ classId: "class:bridge-warden", levelsDocked: 2 }];
  notifier.changed(brakka, { points: 110, stage: 1 }, docked);
  notifier.docked(brakka, docked);
  assert.deepEqual(seen.map(([, message]) => message), [
    "Brakka's Bridge Warden lost 2 levels to Horror Rank.",
    "Brakka's Horror Rank rose to Stage 1 (Shadowed). The deeds are noticed. People lower their voices, and something in their Classes has started to recoil."
  ]);
  // Same stage again, no docks: silent.
  notifier.changed(brakka, { points: 125, stage: 1 }, []);
  assert.equal(seen.length, 2);
  // A later, separate docking of the same size is announced again once the window has passed.
  clock += 60_000;
  notifier.docked(brakka, docked);
  assert.equal(seen.length, 3);
  // Old API: only horrorRankLevelsDocked fires.
  notifier.docked({ id: "b2", name: "Buck" }, [{ classId: "class:harbour-brawler", levelsDocked: 2 }]);
  assert.equal(seen.at(-1)[1], "Buck's Harbour Brawler lost 2 levels to Horror Rank.");
  // A clean character's first change says nothing.
  notifier.changed({ id: "c3", name: "Pim" }, { points: 5, stage: 0 }, []);
  assert.equal(seen.length, 4);
});
