import { MODULE_ID, TEST_SCENARIO_FLAG } from "./constants.js";
import {
  combinedSkillFixture,
  TEST_SCENARIO_NAME,
  testConversionFixture
} from "./test-fixtures.js";

export async function runTestScenario(api) {
  await clearTestScenario();
  const report = {
    name: TEST_SCENARIO_NAME,
    expectedAssertions: 9,
    passed: [],
    failed: [],
    documents: {}
  };

  try {
    const actor = await Actor.create({
      name: "GD Test - Ari of the Lantern Canal",
      type: "character",
      flags: { [MODULE_ID]: { [TEST_SCENARIO_FLAG]: true } }
    });
    const witness = await Actor.create({
      name: "GD Test - Warden of Lantern Crossing",
      type: "character",
      flags: { [MODULE_ID]: { [TEST_SCENARIO_FLAG]: true } }
    });
    report.documents.actors = [actor.id, witness.id];

    const atlasAssetPath = game.settings.get(MODULE_ID, "atlasAssetPath");
    const scene = await Scene.create({
      name: "GD Test - Lantern Crossing",
      navigation: true,
      background: {},
      grid: { type: CONST.GRID_TYPES.GRIDLESS },
      flags: { [MODULE_ID]: { [TEST_SCENARIO_FLAG]: true } }
    });
    await scene.update({ "background.src": atlasAssetPath });
    report.documents.scene = scene.id;

    const journal = await JournalEntry.create({
      name: "GD Test - Scenario Briefing",
      pages: [
        {
          name: "Briefing",
          type: "text",
          text: {
            content: "<h2>The First Steam</h2><p>Evacuate civilians across Lantern Crossing while a flood rises.</p>",
            format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML
          }
        }
      ],
      flags: { [MODULE_ID]: { [TEST_SCENARIO_FLAG]: true } }
    });
    report.documents.journal = journal.id;

    const macro = await Macro.create({
      name: "GD Test - Run The First Steam",
      type: "script",
      command: `await game.modules.get("${MODULE_ID}").api.runTestScenario();`,
      flags: { [MODULE_ID]: { [TEST_SCENARIO_FLAG]: true } }
    });
    report.documents.macro = macro.id;

    const conversion = testConversionFixture();
    await api.applyToActor(actor, conversion);
    assertEqual(report, "Initial import creates three Grand Design feature Items.", featureCount(actor), 3);
    assertEqual(
      report,
      "Initial import creates one Class registry entry.",
      Object.keys(api.getActorRegistry(actor).classes).length,
      1
    );
    assertEqual(
      report,
      "Initial import creates two Skill registry entries.",
      Object.keys(api.getActorRegistry(actor).skills).length,
      2
    );

    await api.combineSkills(actor, combinedSkillFixture());
    const registry = api.getActorRegistry(actor);
    const steamStep = registry.skills["skill:steam-step"];
    assert(report, "Combined Skill is registered.", Boolean(steamStep));
    assertEqual(report, "Combined Skill creates one additional feature Item.", featureCount(actor), 4);
    assertEqual(
      report,
      "Combined Skill retains both source IDs.",
      steamStep.metadata.lineage.sources.join("|"),
      "skill:ember-step|skill:mist-step"
    );
    assert(
      report,
      "Combined Skill inherits both parent tags.",
      ["fire", "water", "mobility"].every((tag) => steamStep.metadata.tags.includes(tag))
    );

    await api.applyToActor(actor, conversion);
    assertEqual(
      report,
      "Re-import is idempotent and does not duplicate existing feature Items.",
      featureCount(actor),
      4
    );

    assert(
      report,
      "Test scene uses the configured atlas asset.",
      sameFoundryPath(scene._source.background?.src, atlasAssetPath)
    );
    assert(report, "Test actor and witness remain isolated test documents.", Boolean(witness.getFlag(MODULE_ID, TEST_SCENARIO_FLAG)));
  } catch (error) {
    report.failed.push(`Unexpected test scenario error: ${error.message}`);
    console.error(`${MODULE_ID} | test scenario failed`, error);
  }

  if (report.passed.length !== report.expectedAssertions) {
    report.failed.push(
      `Expected ${report.expectedAssertions} assertions but completed ${report.passed.length}.`
    );
  }
  report.ok = report.failed.length === 0;
  const summary = `${report.name}: ${report.passed.length}/${report.expectedAssertions} passed, ${report.failed.length} failed.`;
  if (report.ok) {
    ui.notifications.info(summary);
  } else {
    ui.notifications.error(summary);
  }
  console.info(`${MODULE_ID} | ${summary}`, report);
  return report;
}

export async function clearTestScenario() {
  const documents = [
    ...game.actors,
    ...game.scenes,
    ...game.journal,
    ...game.macros
  ].filter((document) => document.getFlag(MODULE_ID, TEST_SCENARIO_FLAG));
  for (const document of documents) {
    await document.delete();
  }
  return documents.length;
}

function featureCount(actor) {
  return actor.items.filter((item) => item.getFlag(MODULE_ID, "registryId")).length;
}

function assert(report, description, condition) {
  if (condition) {
    report.passed.push(description);
  } else {
    report.failed.push(description);
  }
}

function assertEqual(report, description, actual, expected) {
  assert(report, `${description} Expected ${expected}; received ${actual}.`, actual === expected);
}

function sameFoundryPath(actual, expected) {
  return typeof actual === "string"
    && typeof expected === "string"
    && actual.replaceAll("\\", "/") === expected.replaceAll("\\", "/");
}
