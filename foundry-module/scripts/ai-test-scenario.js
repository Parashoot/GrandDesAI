import { MODULE_ID } from "./constants.js";

// Distinct from TEST_SCENARIO_FLAG ("The First Steam") on purpose: that campaign is deterministic
// fixture data and can be wiped automatically on every world launch (runTestScenarioOnLaunch).
// This campaign makes real calls to whatever AI provider is configured (Ollama by default) and
// its output is worth inspecting by hand, so it gets its own tag and its own cleanup.
const AI_TEST_SCENARIO_FLAG = "aiTestScenario";
const AI_TEST_SCENARIO_NAME = "GD AI Test - Live Provider Growth Campaign";
const REPORT_DIRECTORY = "grand-design-ai-reports";
const REPORT_FILENAME = "last-ai-test-report.json";
const SUBJECT_NAME = "GD AI Test - Kellin the Undercutter";

// Each beat is a genuinely different kind of fictional moment (skill-building labor, an offensive
// strike, a triggered defense, a spell-like effect, a leadership/support moment, a passive trait)
// so the model has a real opportunity to reach for every PF2e gameItem.kind it knows about --
// action, reaction, free, passive, spell, weapon -- rather than being told which kind to pick.
// Which kind (if any) it actually proposes for each beat is not asserted: that's a genuine local-model
// output, not a fixture, and is reported rather than gated on.
const SESSION_NOTE_BEATS = [
  {
    label: "Improvised competence (origin skill)",
    notes: "Kellin scraped together a rope-and-pulley rig from mining salvage to haul three trapped miners out of a collapsed shaft, succeeding on the first attempt with nothing but scavenged parts."
  },
  {
    label: "Offensive strike (action)",
    notes: "Kellin drove a reinforced mining pick through a chitin-plated cave lurker's one weak joint in a single decisive strike, dropping it before it could counterattack."
  },
  {
    label: "Triggered defense (reaction)",
    notes: "When the lurker's mate lunged out of the dark at an ally, Kellin twisted into its path at the last instant and turned the blow aside, taking the hit meant for someone else."
  },
  {
    label: "Elemental manifestation (spell-like)",
    notes: "Kellin pressed a palm to the tunnel wall and called up a surge of heat from an old geothermal vein, scorching the rock ahead and clearing a passage the crew thought was sealed for good."
  },
  {
    label: "Rallying leadership (free action)",
    notes: "With the tunnel filling with gas, Kellin called out clear, practiced evacuation instructions that kept the whole mining crew moving in order instead of panicking toward the same exit."
  },
  {
    label: "Ongoing instinct (passive)",
    notes: "Kellin has spent so many years reading rock strata by lamplight that they now instinctively sense when a tunnel is about to give way before anyone else in the crew notices."
  }
];

export async function runAiTestScenario(api) {
  await clearAiTestScenario();
  const report = {
    name: AI_TEST_SCENARIO_NAME,
    passed: [],
    failed: [],
    beats: [],
    generated: [],
    documents: {}
  };

  let subject;
  try {
    if (!api.hasProposalAdapter()) {
      throw new Error(
        "No AI provider is configured. Open Configure Settings -> Grand Design AI -> Configure AI Provider "
          + "and select Ollama (or another provider) before running the AI test campaign."
      );
    }

    subject = await Actor.create({
      name: SUBJECT_NAME,
      type: "character",
      flags: { [MODULE_ID]: { [AI_TEST_SCENARIO_FLAG]: true } }
    });
    report.documents.actor = subject.id;

    for (const beat of SESSION_NOTE_BEATS) {
      const entry = { label: beat.label, ok: false };
      try {
        const result = await api.analyzeSessionNotes(subject, beat.notes);
        entry.ok = true;
        entry.source = result.source;
        entry.eventsRecorded = result.events.length;
        assertEqual(
          report,
          `Beat "${beat.label}" is answered by the configured AI provider, not the local heuristic fallback.`,
          result.source,
          "adapter"
        );
      } catch (error) {
        entry.error = error.message;
        report.failed.push(`Beat "${beat.label}" raised an error calling the AI provider: ${error.message}`);
        console.error(`${MODULE_ID} | AI test campaign beat failed`, beat.label, error);
      }
      report.beats.push(entry);
    }

    const growthAfterBeats = api.getGrowth(subject);
    const aiProposals = growthAfterBeats.proposals.filter((proposal) => proposal.source === "ai-gateway");
    report.generated = aiProposals.map(summarizeProposal);
    report.kindsCovered = [...new Set(aiProposals.map((proposal) => proposal.entry.gameItem?.kind).filter(Boolean))];

    assert(
      report,
      "The live AI provider produced at least one validated Grand Design entry across the campaign.",
      aiProposals.length > 0
    );

    if (aiProposals.length > 0) {
      const restResult = await api.resolveLevelRest(subject, { restType: "short" });
      const progression = api.getLevelProgression(subject);
      if (progression.grantAllowances < 1) {
        // Not a failure: how many of the six beats the model logged as recordable events (versus
        // deciding a beat lacked evidence) is real, expected variance from a live model, and
        // reaching the level-1 progression threshold isn't guaranteed on every run. Reported for
        // visibility, not counted against the campaign.
        report.approvalSkippedReason =
          `No level-up grant allowance was earned from ${growthAfterBeats.events.length} recorded event(s) `
            + `(progress ${progression.progress.toFixed(1)}/100); nothing was approved into an Item this run.`;
      } else {
        const approvable = aiProposals.find((proposal) => proposal.status === "pending");
        if (approvable) {
          const approved = await api.approveProposal(subject, approvable.id);
          assert(
            report,
            "An AI-generated proposal was approved and turned into a real PF2e Item on the Actor.",
            Boolean(approved?.item?.id) && approved.item.name.includes(approvable.entry.name)
          );
          report.approved = summarizeProposal({ ...approvable, status: "approved" });
        } else {
          report.failed.push("A grant allowance was available but no pending AI-generated proposal remained to approve.");
        }
      }
      report.restResult = { gainedLevels: restResult.gainedLevels, progress: restResult.progression.progress };
    }
  } catch (error) {
    report.failed.push(`Unexpected AI test campaign error: ${error.message}`);
    console.error(`${MODULE_ID} | AI test campaign failed`, error);
  }

  report.expectedAssertions = report.passed.length + report.failed.length;
  report.ok = report.failed.length === 0;
  await persistReport(report);
  const summary = `${report.name}: ${report.passed.length}/${report.expectedAssertions} passed, ${report.failed.length} failed. `
    + `${report.generated.length} entr${report.generated.length === 1 ? "y" : "ies"} generated `
    + `(kinds: ${report.kindsCovered?.length ? report.kindsCovered.join(", ") : "none"}).`;
  if (report.ok) ui.notifications.info(summary);
  else {
    ui.notifications.error(summary);
    new Dialog({
      title: "Grand Design AI Test Campaign Failures",
      content: `<p><strong>${escapeHtml(summary)}</strong></p><p>Copy these failures for diagnosis:</p><textarea rows="12" readonly>${escapeHtml(report.failed.join("\n"))}</textarea>`,
      buttons: { close: { icon: '<i class="fas fa-times"></i>', label: "Close" } }
    }).render(true);
  }
  console.info(`${MODULE_ID} | ${summary}`, report);
  return report;
}

export async function clearAiTestScenario() {
  const documents = [...game.actors].filter((document) => document.getFlag(MODULE_ID, AI_TEST_SCENARIO_FLAG));
  for (const document of documents) await document.delete();
  return documents.length;
}

function summarizeProposal(proposal) {
  const entry = proposal.entry;
  return {
    id: proposal.id,
    kind: proposal.kind,
    status: proposal.status,
    name: entry.name,
    gameItemKind: entry.gameItem?.kind ?? null,
    systemEquivalent: entry.system_equivalent ?? entry.system_chassis ?? null,
    tier: entry.tier ?? null,
    effect: entry.mechanics?.effect ?? null,
    tags: entry.metadata?.tags ?? [],
    evidence: proposal.evidence ?? []
  };
}

async function persistReport(report) {
  try {
    await FilePicker.createDirectory("data", REPORT_DIRECTORY);
  } catch (error) {
    if (!String(error.message).includes("EEXIST")) throw error;
  }
  const file = new File(
    [JSON.stringify({ ...report, completedAt: new Date().toISOString() }, null, 2)],
    REPORT_FILENAME,
    { type: "application/json" }
  );
  try {
    const result = await FilePicker.upload("data", REPORT_DIRECTORY, file, { notify: false });
    report.logPath = result.path;
  } catch (error) {
    report.logError = error.message;
    console.error(`${MODULE_ID} | could not persist AI test report`, error);
    ui.notifications.warn("Grand Design AI test campaign report could not be saved to local Foundry Data.");
  }
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
