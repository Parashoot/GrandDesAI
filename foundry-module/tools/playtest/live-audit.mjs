#!/usr/bin/env node
// Read-only live audit of the running Foundry world: joins as Gamemaster (no password), reports what
// the module actually exposes there - version, settings, whether the AI gateway is attached, the
// Growth dialog's real buttons for one character, scene tools, registered settings menus, console
// errors. Changes nothing in the world (client-scope settings in this headless browser only).
//
//   node tools/playtest/live-audit.mjs [--url http://localhost:30000] [--actor "Name"] [--with-ai]
//   --with-ai: set provider/endpoint/model in THIS headless browser, reload, and ping the gateway.
//
// Note: Foundry allows one connection per user; joining as Gamemaster takes over the owner's session.

import { chromium } from "playwright";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true] : null)).filter(Boolean));
const URL = String(args.url ?? "http://localhost:30000").replace(/\/$/, "");
const MOD = "grand-design-ai";
const errors = [];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(e.message));

async function join() {
  await page.goto(`${URL}/join`, { waitUntil: "domcontentloaded" });
  await page.fill("#join-username", "Gamemaster");
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/join"), { timeout: 20000 }).catch(() => {}), page.click('button[name="join"]')]);
  await page.waitForFunction(() => globalThis.game?.ready === true, { timeout: 60000 });
}

try {
  await join();
  if (args["with-ai"]) {
    await page.evaluate(async (mod) => {
      await game.settings.set(mod, "aiProvider", "ollama");
      await game.settings.set(mod, "aiEndpoint", "http://127.0.0.1:11434");
      await game.settings.set(mod, "aiModel", "qwen3.8:27b");
    }, MOD);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => globalThis.game?.ready === true, { timeout: 60000 });
  }

  const state = await page.evaluate(async ({ mod, actorName, withAi }) => {
    const module = game.modules.get(mod);
    const api = module?.api;
    const setting = (key) => { try { return game.settings.get(mod, key); } catch (e) { return `<unregistered: ${e.message}>`; } };
    const settingKeys = [...game.settings.settings.keys()].filter((k) => k.startsWith(`${mod}.`)).map((k) => k.slice(mod.length + 1));
    const menus = [...game.settings.menus.entries()].filter(([k]) => k.startsWith(`${mod}.`)).map(([k, v]) => ({ key: k.slice(mod.length + 1), name: v.name, restricted: v.restricted }));
    const apiMethods = api ? Object.getOwnPropertyNames(Object.getPrototypeOf(api)).filter((n) => n !== "constructor" && !n.startsWith("_")).sort() : [];
    const characters = game.actors.filter((a) => a.type === "character");
    const actor = (actorName && game.actors.getName(actorName)) || characters.find((a) => a.getFlag(mod, "levelProgression")) || characters[0];
    let ping = null;
    if (withAi && api?._proposalAdapter?.ping) {
      try { ping = await api._proposalAdapter.ping(); } catch (e) { ping = `error: ${e.message}`; }
    }
    return {
      world: game.world.id, system: `${game.system.id} ${game.system.version}`, foundry: game.version,
      module: { active: module?.active, version: module?.version },
      settings: Object.fromEntries(settingKeys.map((k) => [k, setting(k)])),
      menus, apiMethods,
      adapterAttached: Boolean(api?._proposalAdapter), adapterConfig: api?._proposalAdapter?.config ?? null, ping,
      gatewayConfig: api?.getGatewayConfig ? (({ apiKey, ...rest }) => rest)(api.getGatewayConfig()) : null,
      actors: { characters: characters.length, withGrandDesign: characters.filter((a) => a.getFlag(mod, "levelProgression") || a.getFlag(mod, "growthEvents")).map((a) => ({ name: a.name, level: a.getFlag(mod, "levelProgression")?.level, events: (a.getFlag(mod, "growthEvents") ?? []).length, pending: (a.getFlag(mod, "growthProposals") ?? []).filter((p) => p.status === "pending").length })) },
      auditActor: actor ? { id: actor.id, name: actor.name } : null,
      sceneTools: Object.values(ui.controls?.controls ?? {}).flatMap((g) => Object.values(g.tools ?? {}).map((t) => t.name)).filter((n) => /grand|populate/i.test(n)),
      macros: game.macros.filter((m) => /grand|design|populate/i.test(m.name)).map((m) => m.name),
      compendia: game.packs.filter((p) => p.metadata.packageName === mod).map((p) => p.metadata.label)
    };
  }, { mod: MOD, actorName: args.actor ?? null, withAi: Boolean(args["with-ai"]) });

  // Open the audit actor's sheet and the Growth dialog through the real header button.
  let growth = null;
  if (state.auditActor) {
    await page.evaluate((id) => game.actors.get(id).sheet.render(true), state.auditActor.id);
    await page.waitForTimeout(2500);
    const headerButtons = await page.$$eval(".window-header .header-control, .window-header a.header-button", (els) => els.map((e) => e.getAttribute("aria-label") || e.dataset.tooltip || e.textContent.trim()).filter(Boolean));
    const clicked = await page.$(".grand-design-growth");
    if (clicked) {
      await clicked.click();
      await page.waitForTimeout(2500);
      growth = await page.evaluate(() => {
        const dlg = [...document.querySelectorAll(".app, .application, dialog")].reverse().find((el) => /Grand Design|Growth/i.test(el.querySelector(".window-title, header")?.textContent ?? ""));
        if (!dlg) return { found: false };
        return {
          found: true,
          title: dlg.querySelector(".window-title, header")?.textContent.trim(),
          buttons: [...dlg.querySelectorAll("button, a.button, [data-action]")].map((b) => (b.textContent.trim() || b.dataset.action || b.getAttribute("aria-label") || "").replace(/\s+/g, " ")).filter(Boolean),
          inputs: [...dlg.querySelectorAll("select, textarea, input")].map((i) => `${i.tagName.toLowerCase()}[name=${i.name}]${i.tagName === "SELECT" ? ` options=${[...i.options].map((o) => o.value).join("|")}` : ""}`),
          headings: [...dlg.querySelectorAll("h2, h3, h4, legend")].map((h) => h.textContent.trim()),
          text: dlg.innerText.slice(0, 1500)
        };
      });
    }
    growth = { headerButtons, ...(growth ?? { found: false, note: "no .grand-design-growth header button" }) };
    await page.screenshot({ path: "tools/playtest/live-audit.png" });
  }

  console.log(JSON.stringify({ ...state, growthDialog: growth, consoleErrors: errors.slice(0, 20) }, null, 1));
} catch (error) {
  console.error("LIVE AUDIT FAILED:", error.message, "\nconsole errors:", errors.slice(0, 10));
  process.exitCode = 1;
} finally {
  await browser.close();
}
