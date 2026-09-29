#!/usr/bin/env node
// Live Populate check in the running world (board dee25a95): joins as Gamemaster, makes sure the AI
// gateway points at local Ollama, runs api.populate for one prompt, reads back what Foundry really
// stored on the created actors/items (the system's own derived AC/HP/saves), then deletes them.
//   node tools/playtest/live-populate.mjs [--prompt "a bandit ambush on a forest road"] [--keep]
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const URL = flag("url") || "http://localhost:30000";
const PROMPT = flag("prompt") || "a bandit ambush on a forest road";
const KEEP = argv.includes("--keep");
const MOD = "grand-design-ai";

const browser = await chromium.launch({ headless: !process.env.FOUNDRY_HEADFUL });
const errors = [];
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`); };
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const join = async () => {
    await page.goto(`${URL}/join`, { waitUntil: "domcontentloaded" });
    await page.fill("#join-username", "Gamemaster");
    await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/join"), { timeout: 20000 }).catch(() => {}), page.click('button[name="join"]')]);
    await page.waitForFunction(() => globalThis.game?.ready === true, { timeout: 60000 });
  };
  await join();
  const changed = await page.evaluate(async (mod) => {
    const want = { aiProvider: "ollama", aiEndpoint: "http://127.0.0.1:11434", aiModel: "qwen3.8:27b" };
    let changed = false;
    for (const [key, value] of Object.entries(want)) {
      if (game.settings.get(mod, key) !== value) { await game.settings.set(mod, key, value); changed = true; }
    }
    return changed;
  }, MOD);
  if (changed) { await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForFunction(() => globalThis.game?.ready === true, { timeout: 60000 }); }

  const out = await page.evaluate(async ({ mod, prompt, keep }) => {
    const api = game.modules.get(mod).api;
    const t = performance.now();
    const res = await api.populate(prompt);
    const ms = Math.round(performance.now() - t);
    const pf2e = game.system.id === "pf2e";
    const read = (doc) => {
      if (doc.documentName !== "Actor") return { item: doc.name, type: doc.type };
      const s = doc.system;
      const strikes = doc.items.filter((i) => i.type === "melee" || i.type === "weapon").map((i) => (pf2e ? `${i.name} +${i.system.bonus?.value}` : i.name));
      return pf2e
        ? { name: doc.name, level: s.details?.level?.value, ac: s.attributes?.ac?.value, hp: s.attributes?.hp?.max, fort: s.saves?.fortitude?.value, ref: s.saves?.reflex?.value, will: s.saves?.will?.value, per: s.perception?.mod ?? s.perception?.value, strikes }
        : { name: doc.name, cr: s.details?.cr, ac: s.attributes?.ac?.value, hp: s.attributes?.hp?.max, str: s.abilities?.str?.value, strikes };
    };
    const docs = res.created.map(read);
    if (!keep) for (const doc of res.created) await doc.delete();
    return { system: game.system.id, source: res.source, fallbackReason: res.fallbackReason, aiAvailable: res.aiAvailable, ms, docs };
  }, { mod: MOD, prompt: PROMPT, keep: KEEP });

  console.log(`${out.system}: source ${out.source}${out.fallbackReason ? ` (fallback: ${out.fallbackReason})` : ""}, ${out.ms} ms`);
  for (const doc of out.docs) console.log("  ", JSON.stringify(doc));
  check("populate adapter is wired from the gateway", out.aiAvailable === true);
  check("the AI wrote the spawn", out.source === "ai", out.fallbackReason ?? "");
  const actors = out.docs.filter((d) => d.name);
  check("actors were created", actors.length > 0, `${actors.length}`);
  if (out.system === "pf2e") {
    check("PF2e actors carry a level, saves and perception", actors.every((a) => Number.isFinite(a.level) && Number.isFinite(a.fort) && Number.isFinite(a.per)));
    check("PF2e AC/HP sit in the level range", actors.every((a) => a.ac >= 12 && a.ac <= 25 && a.hp >= 5), actors.map((a) => `L${a.level} AC${a.ac} HP${a.hp}`).join(", "));
  } else {
    check("dnd5e actors carry CR, AC and HP", actors.every((a) => a.cr !== undefined && Number.isFinite(a.ac) && a.hp > 0), actors.map((a) => `CR${a.cr} AC${a.ac} HP${a.hp}`).join(", "));
  }
  check("every actor has a strike", actors.every((a) => a.strikes.length > 0));
  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
