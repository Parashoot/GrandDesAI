import { MODULE_ID, TEST_SCENARIO_FLAG } from "./constants.js";
import { defaultAtlasAssetPath, resolveAtlasAssetPath as resolveConfiguredAtlasAssetPath, pickRandomSketchMapPaths } from "./atlas.js";
import {
  combinedSkillFixture,
  canalStepGrowthEvents,
  TEST_ACTORS,
  TEST_ACTS,
  TEST_SCENARIO_NAME,
  testConversionFixture,
  mechanicsConversionFixture,
  upgradedClassFixture
} from "./test-fixtures.js";

export async function runTestScenario(api) {
  await clearTestScenario();
  const report = {
    name: TEST_SCENARIO_NAME,
    passed: [],
    failed: [],
    documents: {}
  };

  try {
    const campaign = await createCampaignDocuments(report);
    const ari = campaign.actors.ari;
    const mera = campaign.actors.mera;
    const atlasResponses = await Promise.all(campaign.sceneAssetPaths.map((assetPath) => atlasAssetResponds(assetPath)));
    report.atlas = {
      requestedPaths: campaign.sceneAssetPaths,
      persistedSources: campaign.scenes.map((scene) => sceneAtlasSource(scene)),
      assetsReachable: atlasResponses.every(Boolean)
    };

    await api.applyToActor(ari, testConversionFixture());
    assertEqual(report, "Act I import creates three Grand Design feature Items.", featureCount(ari), 3);
    assertEqual(
      report,
      "Act I import creates one Class registry entry.",
      Object.keys(api.getActorRegistry(ari).classes).length,
      1
    );
    assertEqual(
      report,
      "Act I import creates two Skill registry entries.",
      Object.keys(api.getActorRegistry(ari).skills).length,
      2
    );
    const canalChef = grandDesignItem(ari, "class:canal-chef");
    const emberStep = grandDesignItem(ari, "skill:ember-step");
    const mistStep = grandDesignItem(ari, "skill:mist-step");
    assert(
      report,
      "Passive Class feature has a tangible frequency and benefit description.",
      canalChef?.type === "feat" && canalChef.system.description.value.includes("Frequency:")
    );
    assert(
      report,
      "Action Skill creates a one-action PF2e action Item with an inline dice roll.",
      emberStep?.type === "action"
        && emberStep.system.actionType.value === "action"
        && emberStep.system.description.value.includes("[[/r 1d20+8]]")
    );
    assert(
      report,
      "Reaction Skill creates a triggered PF2e reaction Item with an inline dice roll.",
      mistStep?.type === "action"
        && mistStep.system.actionType.value === "reaction"
        && mistStep.system.description.value.includes("Trigger:")
    );
    await api.applyToActor(mera, mechanicsConversionFixture());
    const meraItems = mera.items.filter((item) => item.getFlag(MODULE_ID, "registryId"));
    assert(
      report,
      "Mechanics fixtures create a PF2e spell Item.",
      meraItems.some((item) => item.type === "spell")
    );
    assert(
      report,
      "Mechanics fixtures create a PF2e weapon Item.",
      meraItems.some((item) => item.type === "weapon")
    );
    const canalSpark = grandDesignItem(mera, "skill:canal-spark");
    const siltHook = grandDesignItem(mera, "skill:silt-hook");
    assert(
      report,
      "Spell Item exposes a ranked spell entry with an inline dice roll.",
      canalSpark?.type === "spell"
        && canalSpark.system.level.value === 1
        && canalSpark.system.description.value.includes("[[/r 1d20+7]]")
    );
    assert(
      report,
      "Weapon Item exposes its tangible damage die and damage type.",
      siltHook?.type === "weapon"
        && siltHook.system.damage.dice === 1
        && siltHook.system.damage.die === "d6"
        && siltHook.system.damage.damageType === "piercing"
    );
    let growthResult;
    for (const event of canalStepGrowthEvents()) {
        growthResult = await api.recordGrowthEvent(mera, event);
    }
    growthResult = await api.recordGrowthEvent(mera, {
      id: "event:canal-evacuation",
      summary: "Mera guided a family through the flooded canal to safety.",
      tags: ["mobility", "water", "support"],
      outcome: "success"
    });
    const canalStepProposal = growthResult.proposals.find(
        (proposal) => proposal.id === "proposal:canal-step"
    );
    assert(
        report,
        "Repeated tagged gameplay creates a pending, evidence-backed skill proposal.",
        canalStepProposal?.status === "pending" && canalStepProposal.evidence.length === 4
    );
    const restResult = await api.resolveLevelRest(mera, { restType: "short" });
    assert(
      report,
      "A short rest resolves earned progression into a level-up grant allowance.",
      restResult.gainedLevels.includes(1) && restResult.progression.grantAllowances === 1
    );
    await api.approveSkillProposal(mera, canalStepProposal.id);
    const canalStep = grandDesignItem(mera, "skill:canal-step");
    assert(
        report,
        "GM approval turns the generated proposal into a PF2e action Item.",
        canalStep?.type === "action" && canalStep.system.description.value.includes("[[/r")
    );
    assertEqual(
        report,
        "Approved proposals preserve the actor growth-event audit trail.",
        api.getGrowth(mera).events.length,
        4
    );
    assert(
        report,
        "Approved proposals are not offered again as pending drafts.",
        api.getGrowth(mera).proposals.find((proposal) => proposal.id === canalStepProposal.id)?.status === "approved"
    );

    await api.combineSkills(ari, combinedSkillFixture());
    let registry = api.getActorRegistry(ari);
    const steamStep = registry.skills["skill:steam-step"];
    assert(report, "Act II combined Skill is registered.", Boolean(steamStep));
    assertEqual(report, "Act II creates one additional feature Item.", featureCount(ari), 4);
    assertEqual(
      report,
      "Act II combined Skill retains both source IDs.",
      steamStep.metadata.lineage.sources.join("|"),
      "skill:ember-step|skill:mist-step"
    );
    assert(
      report,
      "Act II combined Skill inherits both parent tags.",
      ["fire", "water", "mobility"].every((tag) => steamStep.metadata.tags.includes(tag))
    );
    const steamStepItem = grandDesignItem(ari, "skill:steam-step");
    assert(
      report,
      "Combined Skill creates a PF2e free action Item with an inline dice roll.",
      steamStepItem?.type === "action"
        && steamStepItem.system.actionType.value === "free"
        && steamStepItem.system.description.value.includes("[[/r 1d20+10]]")
    );

    await api.upgradeClass(ari, upgradedClassFixture());
    registry = api.getActorRegistry(ari);
    const hearthkeeper = registry.classes["class:canal-hearthkeeper"];
    assert(report, "Act III upgraded Class is registered.", Boolean(hearthkeeper));
    assertEqual(report, "Act III creates one additional feature Item.", featureCount(ari), 5);
    assertEqual(
      report,
      "Act III Class upgrade retains its parent ID.",
      hearthkeeper.metadata.lineage.sources.join("|"),
      "class:canal-chef"
    );
    assert(
      report,
      "Act III Class upgrade inherits the parent tags.",
      ["craft", "food", "flood-support"].every((tag) => hearthkeeper.metadata.tags.includes(tag))
    );

    await api.applyToActor(ari, testConversionFixture());
    assertEqual(
      report,
      "Re-import is idempotent and preserves all five approved feature Items.",
      featureCount(ari),
      5
    );
    assertEqual(
      report,
      "The atlas campaign has three scenes.",
      campaign.scenes.length,
      TEST_ACTS.length
    );
    assert(
      report,
      "Every campaign scene is configured with a reachable, distinct pencil-sketch map asset.",
      report.atlas.assetsReachable
        && campaign.scenes.every(
          (scene, index) => scene.getFlag(MODULE_ID, "atlasAssetPath") === campaign.sceneAssetPaths[index]
        )
        && new Set(campaign.sceneAssetPaths).size === campaign.sceneAssetPaths.length
    );
    assert(
      report,
      "Every campaign scene contains placed encounter tokens.",
      campaign.scenes.every((scene) => scene.tokens.size >= 2)
    );
    assertEqual(report, "The campaign has five original test Actors.", Object.keys(campaign.actors).length, 5);
    assertEqual(report, "The campaign journal has three Act pages.", campaign.journal.pages.size, 3);
    assertEqual(report, "The encounter oracle has six outcomes.", campaign.table.results.size, 6);
    assertEqual(report, "The campaign creates runner and cleanup macros.", campaign.macros.length, 2);
    assert(
      report,
      "Every campaign document is explicitly isolated with the test flag.",
      allCampaignDocumentsAreTagged(campaign)
    );
  } catch (error) {
    report.failed.push(`Unexpected test campaign error: ${error.message}`);
    console.error(`${MODULE_ID} | test campaign failed`, error);
  }

  function sceneAtlasSource(scene) {
    return scene.background?.src ?? scene._source.background?.src;
  }

  report.expectedAssertions = report.passed.length + report.failed.length;
  report.ok = report.failed.length === 0;
  await persistTestReport(report);
  const summary = `${report.name}: ${report.passed.length}/${report.expectedAssertions} passed, ${report.failed.length} failed.`;
  if (report.ok) ui.notifications.info(summary);
  else {
    ui.notifications.error(summary);
    new Dialog({
      title: "Grand Design Campaign Test Failures",
      content: `<p><strong>${escapeHtml(summary)}</strong></p><p>Copy these failures for diagnosis:</p><textarea rows="12" readonly>${escapeHtml(report.failed.join("\n"))}</textarea>`,
      buttons: { close: { icon: '<i class="fas fa-times"></i>', label: "Close" } }
    }).render(true);
  }
  console.info(`${MODULE_ID} | ${summary}`, report);
  return report;
}

async function persistTestReport(report) {
  const directory = "grand-design-ai-reports";
  try {
    await FilePicker.createDirectory("data", directory);
  } catch (error) {
    if (!String(error.message).includes("EEXIST")) throw error;
  }
  const file = new File(
    [JSON.stringify({ ...report, completedAt: new Date().toISOString() }, null, 2)],
    "last-test-report.json",
    { type: "application/json" }
  );
  try {
    const result = await FilePicker.upload("data", directory, file, { notify: false });
    report.logPath = result.path;
  } catch (error) {
    report.logError = error.message;
    console.error(`${MODULE_ID} | could not persist test report`, error);
    ui.notifications.warn("Grand Design campaign report could not be saved to local Foundry Data.");
  }
}

async function createCampaignDocuments(report) {
  const sceneAssetPaths = resolveSceneAssetPaths(TEST_ACTS.length);
  const actors = {};
  for (const fixture of TEST_ACTORS) {
    actors[fixture.key] = await Actor.create({
      name: fixture.name,
      type: fixture.type,
      flags: { [MODULE_ID]: { [TEST_SCENARIO_FLAG]: true, role: fixture.role } }
    });
  }
  report.documents.actors = Object.values(actors).map((actor) => actor.id);

  const scenes = [];
  for (const [index, act] of TEST_ACTS.entries()) {
    const atlasAssetPath = sceneAssetPaths[index];
    const scene = await Scene.create({
      name: act.name,
      navigation: true,
      width: 2048,
      height: 1152,
      background: { src: atlasAssetPath },
      backgroundColor: "#000000",
      grid: { type: CONST.GRID_TYPES.GRIDLESS },
      flags: {
        [MODULE_ID]: {
          [TEST_SCENARIO_FLAG]: true,
          act: index + 1,
          atlasAssetPath
        }
      }
    });
    await scene.update({ background: { src: atlasAssetPath }, backgroundColor: "#000000" });
    await scene.createEmbeddedDocuments("Token", tokenFixtures(index, actors));
    scenes.push(game.scenes.get(scene.id) ?? scene);
  }
  await scenes[0].activate();
  report.documents.scenes = scenes.map((scene) => scene.id);

  const journal = await JournalEntry.create({
    name: "GD Test - The First Steam Campaign Guide",
    pages: TEST_ACTS.map((act, index) => ({
      name: act.journalTitle,
      type: "text",
      text: {
        content: `<h2>${act.journalTitle}</h2><p>${act.briefing}</p><p><strong>Campaign test checkpoint:</strong> Act ${index + 1}.</p>`,
        format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML
      }
    })),
    flags: { [MODULE_ID]: { [TEST_SCENARIO_FLAG]: true } }
  });
  report.documents.journal = journal.id;

  const table = await RollTable.create({
    name: "GD Test - Flood Encounter Oracle",
    formula: "1d6",
    results: [
      "Rising water",
      "Collapsed walkway",
      "Lost evacuee",
      "Brine Ripper trail",
      "Steam pressure surge",
      "Unexpected safe route"
    ].map((text, index) => ({ type: CONST.TABLE_RESULT_TYPES.TEXT, text, range: [index + 1, index + 1], weight: 1 })),
    flags: { [MODULE_ID]: { [TEST_SCENARIO_FLAG]: true } }
  });
  report.documents.table = table.id;

  const macros = await Macro.createDocuments([
    {
      name: "GD Test - Run The First Steam",
      type: "script",
      command: `await game.modules.get("${MODULE_ID}").api.runTestScenario();`,
      flags: { [MODULE_ID]: { [TEST_SCENARIO_FLAG]: true } }
    },
    {
      name: "GD Test - Cleanup The First Steam",
      type: "script",
      command: `await game.modules.get("${MODULE_ID}").api.clearTestScenario();`,
      flags: { [MODULE_ID]: { [TEST_SCENARIO_FLAG]: true } }
    }
  ]);
  report.documents.macros = macros.map((macro) => macro.id);

  return { actors, scenes, journal, table, macros, sceneAssetPaths };
}

function tokenFixtures(actIndex, actors) {
  const antagonists = [actors.warden, actors.ripper, actors.echo];
  return [
    { name: actors.ari.name, actorId: actors.ari.id, x: 300, y: 500, disposition: CONST.TOKEN_DISPOSITIONS.FRIENDLY },
    { name: antagonists[actIndex].name, actorId: antagonists[actIndex].id, x: 1300, y: 580, disposition: CONST.TOKEN_DISPOSITIONS.HOSTILE }
  ];
}

export async function clearTestScenario() {
  const documents = [
    ...game.actors,
    ...game.scenes,
    ...game.journal,
    ...game.macros,
    ...game.tables
  ].filter((document) => document.getFlag(MODULE_ID, TEST_SCENARIO_FLAG));
  for (const document of documents) await document.delete();
  return documents.length;
}

function allCampaignDocumentsAreTagged(campaign) {
  return [
    ...Object.values(campaign.actors),
    ...campaign.scenes,
    campaign.journal,
    campaign.table,
    ...campaign.macros
  ].every((document) => document.getFlag(MODULE_ID, TEST_SCENARIO_FLAG));
}

function featureCount(actor) {
  return actor.items.filter((item) => item.getFlag(MODULE_ID, "registryId")).length;
}

function grandDesignItem(actor, registryId) {
  return actor.items.find((item) => item.getFlag(MODULE_ID, "registryId") === registryId);
}

function assert(report, description, condition) {
  if (condition) report.passed.push(description);
  else report.failed.push(description);
}

function assertEqual(report, description, actual, expected) {
  assert(report, `${description} Expected ${expected}; received ${actual}.`, actual === expected);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function atlasAssetResponds(assetPath) {
  try {
    const response = await fetch(assetPath, { method: "HEAD" });
    return response.ok;
  } catch (error) {
    console.warn(`${MODULE_ID} | atlas asset probe failed`, error);
    return false;
  }
}

function resolveSceneAssetPaths(sceneCount) {
  const configured = game.settings.get(MODULE_ID, "atlasAssetPath");
  const isCustomized = typeof configured === "string" && configured.trim() && configured.trim() !== defaultAtlasAssetPath();
  if (isCustomized) {
    const path = resolveConfiguredAtlasAssetPath(configured);
    return Array.from({ length: sceneCount }, () => path);
  }
  return pickRandomSketchMapPaths(sceneCount);
}
