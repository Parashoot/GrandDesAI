#!/usr/bin/env node
// Live integration test: drives a real browser against a real, running Foundry VTT world and a
// real, running AI provider (Ollama by default) to exercise the actual Grand Design AI-gateway
// round trip end to end -- something tests/*.test.mjs deliberately cannot do, since those run
// under plain Node with no Foundry server, no browser, and no model to talk to.
//
// This is NOT part of `npm test` and never runs in CI or on every commit. It is slow (real model
// inference), stateful (creates and deletes real world documents), and its output is genuinely
// nondeterministic (a local LLM's proposals vary run to run) -- run it deliberately, by hand:
//
//   npm run test:live-ai
//
// Requirements before running:
//   - A Foundry VTT world is running locally (default http://localhost:30000) with the PF2e
//     system and the grand-design-ai module active.
//   - Unless FOUNDRY_AI_PROVIDER=disabled, an AI provider is reachable from that Foundry server's
//     browser context -- for the default "ollama" provider, that means Ollama is running locally
//     (http://127.0.0.1:11434) with the configured model pulled (default mistral-small3.1:24b).
//   - Playwright's browser binaries are installed: npx playwright install chromium
//
// Credentials are READ FROM ENVIRONMENT VARIABLES ONLY. Nothing here hardcodes, logs, or echoes
// a password, and this script must never be told a password over chat/CI logs. Either export it
// in your own shell, or copy tests/integration/.env.example to tests/integration/.env (gitignored)
// and fill it in -- this script loads that file itself on startup if it exists; you do not need to
// source it manually. Real shell/CI environment variables always take priority over the file.
//   FOUNDRY_GM_PASSWORD   Required only if your GM account has a password set.
//
// Optional overrides (all have sane defaults for a fresh local dev setup):
//   FOUNDRY_URL           Default http://localhost:30000
//   FOUNDRY_GM_USER       Default "Gamemaster"
//   FOUNDRY_AI_PROVIDER   Default "ollama". Use "disabled" to sanity-check the built-in
//                         heuristic fallback path instead of a real model.
//   FOUNDRY_AI_ENDPOINT   Overrides the provider's default endpoint.
//   FOUNDRY_AI_MODEL      Overrides the provider's default model.
//   FOUNDRY_HEADFUL=1     Show the browser window instead of running headless (useful the first
//                         time you run this, to confirm login actually works).

import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

loadLocalEnvFile();

const MODULE_ID = "grand-design-ai";
const FOUNDRY_URL = (process.env.FOUNDRY_URL ?? "http://localhost:30000").replace(/\/$/, "");
const GM_USER = process.env.FOUNDRY_GM_USER ?? "Gamemaster";
const GM_PASSWORD = process.env.FOUNDRY_GM_PASSWORD ?? "";
const AI_PROVIDER = process.env.FOUNDRY_AI_PROVIDER ?? "ollama";
const AI_ENDPOINT = process.env.FOUNDRY_AI_ENDPOINT ?? "";
const AI_MODEL = process.env.FOUNDRY_AI_MODEL ?? "";
const HEADFUL = process.env.FOUNDRY_HEADFUL === "1";

// Minimal, dependency-free .env loader (no "dotenv" package required). Only fills in variables
// that aren't already set, so a real shell/CI export always wins over the file. Never logs a
// value -- only which keys, if any, it picked up.
function loadLocalEnvFile() {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), ".env");
  let contents;
  try {
    contents = readFileSync(envPath, "utf8");
  } catch {
    return; // No .env file -- that's fine, rely on real environment variables.
  }
  const loadedKeys = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loadedKeys.push(key);
    }
  }
  if (loadedKeys.length) {
    console.log(`Loaded ${loadedKeys.join(", ")} from tests/integration/.env`);
  }
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADFUL });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  try {
    console.log(`Joining ${FOUNDRY_URL} as "${GM_USER}"...`);
    await page.goto(`${FOUNDRY_URL}/join`, { waitUntil: "domcontentloaded" });
    await joinAsGm(page);

    console.log("Waiting for the world to finish loading...");
    await page.waitForFunction(() => globalThis.game?.ready === true, { timeout: 30000 });
    const systemId = await assertModuleActive(page);
    console.log(`World is running the "${systemId}" game system.`);

    console.log(`Configuring AI provider: ${AI_PROVIDER}${AI_ENDPOINT ? ` (${AI_ENDPOINT})` : ""}`);
    await configureAiProvider(page);

    console.log("Running the live AI-provider growth campaign (this makes real model calls; it may take a while)...");
    const report = await page.evaluate(() => game.modules.get("grand-design-ai").api.runAiTestScenario());

    printReport(report);

    console.log("Cleaning up test documents...");
    await page.evaluate(() => game.modules.get("grand-design-ai").api.clearAiTestScenario());

    if (consoleErrors.length) {
      console.warn(`\n${consoleErrors.length} browser console error(s) were logged during the run:`);
      for (const error of consoleErrors) console.warn(`  - ${error}`);
    }

    if (!report.ok) {
      console.error("\nFAIL: the live AI campaign reported failures (see above).");
      process.exitCode = 1;
    } else {
      console.log("\nPASS: live Foundry + AI-provider integration succeeded.");
      process.exitCode = 0;
    }
  } catch (error) {
    console.error("\nFAIL:", error.message ?? error);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

async function joinAsGm(page) {
  await page.fill("#join-username", GM_USER);
  // Foundry's join form is a combo-box: typing the exact username is sufficient to select it,
  // no dropdown click is required.
  const passwordField = page.locator("#join-password");
  if (await passwordField.count()) {
    if (GM_PASSWORD) {
      await passwordField.fill(GM_PASSWORD);
    } else {
      console.log("  (no FOUNDRY_GM_PASSWORD set -- attempting to join without a password)");
    }
  }
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/join"), { timeout: 15000 }).catch(() => {}),
    page.click('button[name="join"]')
  ]);
  const stillOnJoinScreen = new URL(page.url()).pathname.startsWith("/join");
  if (stillOnJoinScreen) {
    // Foundry's own notification banner is transient (it auto-fades in a few seconds) and its
    // markup has changed across versions, so it isn't a reliable thing to scrape here -- this
    // message covers the two most likely causes instead of guessing at DOM structure.
    throw new Error(
      `Could not join as "${GM_USER}" -- still on the join screen after submitting. `
        + "Either the account name is wrong, or it has a password and FOUNDRY_GM_PASSWORD "
        + `is ${GM_PASSWORD ? "set but incorrect" : "not set"}.`
    );
  }
}

const SUPPORTED_SYSTEMS = ["pf2e", "dnd5e"];

async function assertModuleActive(page) {
  const active = await page.evaluate(() => game.modules.get("grand-design-ai")?.active === true);
  if (!active) throw new Error("The grand-design-ai module is not active in this world.");
  const systemId = await page.evaluate(() => game.system.id);
  if (!SUPPORTED_SYSTEMS.includes(systemId)) {
    throw new Error(`Expected one of [${SUPPORTED_SYSTEMS.join(", ")}], found "${systemId}".`);
  }
  return systemId;
}

async function configureAiProvider(page) {
  await page.evaluate(
    async ({ moduleId, provider, endpoint, model }) => {
      await game.settings.set(moduleId, "aiProvider", provider);
      await game.settings.set(moduleId, "aiEndpoint", endpoint);
      await game.settings.set(moduleId, "aiModel", model);
      const { createConfiguredAiAdapter } = await import(`/modules/${moduleId}/scripts/ai-provider-config.js`);
      const adapter = createConfiguredAiAdapter();
      game.modules.get(moduleId).api.setProposalAdapter(adapter);
    },
    { moduleId: MODULE_ID, provider: AI_PROVIDER, endpoint: AI_ENDPOINT, model: AI_MODEL }
  );
}

function printReport(report) {
  console.log(`\n${report.name}`);
  console.log(`  ${report.passed?.length ?? 0}/${report.expectedAssertions ?? "?"} assertions passed, ${report.failed?.length ?? 0} failed.`);
  console.log(`  Beats run: ${report.beats?.length ?? 0} (${report.beats?.filter((beat) => beat.ok).length ?? 0} completed without error)`);
  console.log(`  gameItem.kind values the provider actually produced: ${report.kindsCovered?.join(", ") || "(none)"}`);

  if (report.generated?.length) {
    console.log(`\nGenerated by ${AI_PROVIDER}${AI_MODEL ? `/${AI_MODEL}` : ""}:`);
    for (const entry of report.generated) {
      console.log(`  - [${entry.gameItemKind ?? entry.kind}] ${entry.name} (${entry.status}) -- ${entry.systemEquivalent ?? "no system comparison given"}`);
      console.log(`      ${entry.effect ?? "(no effect text)"}`);
      if (entry.tags?.length) console.log(`      tags: ${entry.tags.join(", ")}`);
    }
  }

  if (report.approved) {
    console.log(`\nApproved into a real Item: ${report.approved.name}`);
  }

  if (report.failed?.length) {
    console.log("\nFailures:");
    for (const failure of report.failed) console.log(`  - ${failure}`);
  }
}

main();
