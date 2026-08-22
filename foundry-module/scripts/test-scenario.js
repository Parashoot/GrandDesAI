import { MODULE_ID, TEST_SCENARIO_FLAG } from "./constants.js";
import { defaultAtlasAssetPath } from "./atlas.js";
import {
  combinedSkillFixture,
  TEST_ACTORS,
  TEST_ACTS,
  TEST_SCENARIO_NAME,
  testConversionFixture,
  upgradedClassFixture
} from "./test-fixtures.js";

export async function runTestScenario(api) {
  await clearTestScenario();
  const report = {
    name: TEST_SCENARIO_NAME,
    expectedAssertions: 20,
    passed: [],
    failed: [],
    documents: {}
  };

  try {
    const campaign = await createCampaignDocuments(report);
    const ari = campaign.actors.ari;

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
      "Every campaign scene uses the configured atlas asset.",
      campaign.scenes.every((scene) => sameFoundryPath(sceneAtlasSource(scene), campaign.atlasAssetPath))
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

  if (report.passed.length !== report.expectedAssertions) {
    report.failed.push(
      `Expected ${report.expectedAssertions} assertions but completed ${report.passed.length}.`
    );
  }
  report.ok = report.failed.length === 0;
  const summary = `${report.name}: ${report.passed.length}/${report.expectedAssertions} passed, ${report.failed.length} failed.`;
  if (report.ok) ui.notifications.info(summary);
  else ui.notifications.error(summary);
  console.info(`${MODULE_ID} | ${summary}`, report);
  return report;
}

async function createCampaignDocuments(report) {
  const atlasAssetPath = resolveAtlasAssetPath();
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
    const scene = await Scene.create({
      name: act.name,
      navigation: true,
      width: 2048,
      height: 1152,
      background: { src: atlasAssetPath },
      grid: { type: CONST.GRID_TYPES.GRIDLESS },
      flags: { [MODULE_ID]: { [TEST_SCENARIO_FLAG]: true, act: index + 1 } }
    });
    await scene.update({ background: { src: atlasAssetPath } });
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

  return { actors, scenes, journal, table, macros, atlasAssetPath };
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

function assert(report, description, condition) {
  if (condition) report.passed.push(description);
  else report.failed.push(description);
}

function assertEqual(report, description, actual, expected) {
  assert(report, `${description} Expected ${expected}; received ${actual}.`, actual === expected);
}

function sameFoundryPath(actual, expected) {
  return typeof actual === "string"
    && typeof expected === "string"
    && actual.replaceAll("\\", "/") === expected.replaceAll("\\", "/");
}

function resolveAtlasAssetPath() {
  const configured = game.settings.get(MODULE_ID, "atlasAssetPath");
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : defaultAtlasAssetPath();
}
