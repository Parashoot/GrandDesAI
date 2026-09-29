#!/usr/bin/env node
// Switch the running Foundry to another world: join the current one as Gamemaster (no password),
// return to setup (game.shutDown), launch the target world from /setup and wait until it is up.
//   node tools/playtest/switch-world.mjs <worldId> [--url http://localhost:30000]
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith("--"));
const URL = (argv.includes("--url") ? argv[argv.indexOf("--url") + 1] : "http://localhost:30000").replace(/\/$/, "");
if (!target) throw new Error("usage: switch-world.mjs <worldId>");
const status = async () => (await fetch(`${URL}/api/status`)).json().catch(() => ({}));

const before = await status();
if (before.world === target) { console.log(`already on ${target}`); process.exit(0); }
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  if (before.world) {
    await page.goto(`${URL}/join`, { waitUntil: "domcontentloaded" });
    await page.fill("#join-username", "Gamemaster");
    await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/join"), { timeout: 20000 }).catch(() => {}), page.click('button[name="join"]')]);
    await page.waitForFunction(() => globalThis.game?.ready === true, { timeout: 90000 });
    await page.evaluate(() => game.shutDown()).catch(() => {});
    for (let i = 0; i < 60 && (await status()).world; i++) await new Promise((r) => setTimeout(r, 1000));
  }
  await page.goto(`${URL}/setup`, { waitUntil: "domcontentloaded" });
  const res = await page.evaluate(async (world) => {
    const r = await fetch("/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "launchWorld", world }) });
    return `${r.status} ${(await r.text()).slice(0, 200)}`;
  }, target);
  console.log(`launch: ${res}`);
  for (let i = 0; i < 120; i++) {
    const s = await status();
    if (s.world === target) { console.log(`now on ${s.world} (${s.system} ${s.systemVersion})`); break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
} finally {
  await browser.close();
}
