#!/usr/bin/env node
// Live end-to-end check of the AI-first flows in the RUNNING world (joins as Gamemaster, no password).
// Sets the Gamemaster user's AI settings (user scope: this is the GM's real setting), then on a
// throwaway actor: analyze notes with the AI, check no templates/Knacks were minted, Suggest, Author
// with AI on a placeholder, a milestone rest (Class + capstone), and the Growth dialog's buttons and
// build stamp. Deletes the throwaway actor at the end. Prints PASS/FAIL per check.
//
//   node tools/playtest/live-verify.mjs [--url http://localhost:30000] [--keep]

import { chromium } from "playwright";

const argv = process.argv.slice(2);
const URL = (argv.includes("--url") ? argv[argv.indexOf("--url") + 1] : "http://localhost:30000").replace(/\/$/, "");
const KEEP = argv.includes("--keep");
const MOD = "grand-design-ai";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`); };

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
const logs = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); if (/grand-design-ai \| build/.test(m.text())) logs.push(m.text()); });
page.on("pageerror", (e) => errors.push(e.message));

async function join() {
  await page.goto(`${URL}/join`, { waitUntil: "domcontentloaded" });
  await page.fill("#join-username", "Gamemaster");
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/join"), { timeout: 20000 }).catch(() => {}), page.click('button[name="join"]')]);
  await page.waitForFunction(() => globalThis.game?.ready === true, { timeout: 90000 });
  await page.waitForTimeout(1500);
}

try {
  await join();
  const system = await page.evaluate(() => game.system.id);
  console.log(`world ${await page.evaluate(() => game.world.id)} (${system})`);
  check("build stamp logged at ready", logs.length > 0, logs[0] ?? "no build log line");

  const scope = await page.evaluate((mod) => ["aiProvider", "aiEndpoint", "aiModel", "aiApiKey"].map((k) => `${k}:${game.settings.settings.get(`${mod}.${k}`)?.scope}`).join(" "), MOD);
  check("provider/endpoint/model are user scope, key client", /aiProvider:user aiEndpoint:user aiModel:user aiApiKey:client/.test(scope), scope);

  await page.evaluate(async (mod) => {
    await game.settings.set(mod, "aiProvider", "ollama");
    await game.settings.set(mod, "aiEndpoint", "http://127.0.0.1:11434");
    await game.settings.set(mod, "aiModel", "qwen3.8:27b");
  }, MOD);
  await page.waitForTimeout(1500);
  const liveAttach = await page.evaluate((mod) => game.modules.get(mod).api.hasProposalAdapter(), MOD);
  check("adapter attaches on settings change without reload", liveAttach);
  const expected = await page.evaluate((mod) => { try { return game.settings.get(mod, "aiExpected"); } catch { return "unregistered"; } }, MOD);
  check("world marks AI expected", expected === true, String(expected));

  // Throwaway actor.
  const actorId = await page.evaluate(async () => {
    const a = await Actor.create({ name: "GD Live Check (delete me)", type: "character" });
    return a.id;
  });
  const notes = "Session: Kestra shot the bandit leader off the watchtower with one arrow. Then Kestra shot the rope bridge so it fell before the wolves crossed. At the fair Kestra won the archery contest, and she spent the evening fletching arrows for the militia. She also tried to shoot an apple off Tomas's head and missed badly.";
  const analysis = await page.evaluate(async ({ mod, id, notes }) => {
    const api = game.modules.get(mod).api; const actor = game.actors.get(id);
    await actor.update({ name: "Kestra" });
    const t = Date.now(); const r = await api.analyzeSessionNotes(actor, notes);
    const pr = api.getGrowth(actor).proposals;
    return { ms: Date.now() - t, source: r.source, error: r.adapterError, events: r.events.length, proposals: pr.map((p) => `${p.status}|${p.source}|${p.entry?.name}`) };
  }, { mod: MOD, id: actorId, notes });
  check("analyze reads notes with the AI", analysis.source === "adapter" && analysis.events >= 3, `${analysis.source}, ${analysis.events} events, ${(analysis.ms / 1000).toFixed(0)} s${analysis.error ? `, error ${analysis.error}` : ""}`);
  check("no templates or Knack placeholders minted for AI-read events", !analysis.proposals.some((p) => /\|(template|emergent)\|/.test(p)), analysis.proposals.join(" ; ") || "no proposals yet");

  // Placeholder via the local path, then Author with AI on it.
  const authored = await page.evaluate(async ({ mod, id }) => {
    const api = game.modules.get(mod).api; const actor = game.actors.get(id);
    for (let i = 0; i < 3; i++) await api.recordGrowthEvent(actor, { summary: `Kestra carved decoy ducks for the hunt (${i + 1}).`, tags: ["craft"], themes: ["decoy-carving"], outcome: "success" });
    const placeholder = api.getGrowth(actor).proposals.find((p) => p.status === "pending" && p.needsAuthoring);
    if (!placeholder) return { note: "no placeholder minted by the local path" };
    let refused = null;
    try { await api.approveProposal(actor, placeholder.id); } catch (e) { refused = e.message; }
    const t = Date.now();
    const r = await api.requestProposalAuthoring(actor, placeholder.id);
    const after = api.getGrowth(actor).proposals.find((p) => p.id === placeholder.id);
    return { before: placeholder.entry.name, after: after?.entry?.name, authoredBy: after?.authoredBy, needsAuthoring: after?.needsAuthoring, effect: after?.entry?.mechanics?.effect?.slice(0, 140), refused, ms: Date.now() - t, error: r?.error };
  }, { mod: MOD, id: actorId });
  check("approving a placeholder is refused while the AI is on", Boolean(authored.refused), authored.refused ?? authored.note ?? "approved without authoring");
  check("Author with AI replaces the placeholder in place", authored.authoredBy === "ai-gateway" && authored.after && authored.after !== authored.before, `${authored.before} -> ${authored.after} (${((authored.ms ?? 0) / 1000).toFixed(0)} s): ${authored.effect ?? authored.error ?? ""}`);

  const suggest = await page.evaluate(async ({ mod, id }) => {
    const api = game.modules.get(mod).api; const actor = game.actors.get(id);
    const t = Date.now(); const r = await api.requestGrowthProposals(actor);
    const skipped = [...(r.skipped ?? []), ...(r.skippedProposals ?? []), ...(r.adapterSkippedProposals ?? [])].map((s) => `${s.reason ?? "invalid"}:${s.name ?? s.proposal?.entry?.name ?? s.proposal?.name ?? "?"}${s.duplicateOf ? `~${s.duplicateOf}` : ""}`);
    return { ms: Date.now() - t, added: (r.added ?? []).map((p) => `${p.kind}:${p.entry?.name}`), skipped, keys: Object.keys(r ?? {}), diag: JSON.stringify(r?.gatewayDiagnostics ?? {}).slice(0, 1500), returned: (r.proposals ?? []).map((p) => p.entry?.name ?? p.name), pending: api.getGrowth(actor).proposals.filter((p) => p.status === "pending").length, error: r?.error };
  }, { mod: MOD, id: actorId });
  check("Suggest proposals returns AI proposals", suggest.added.length > 0, `${suggest.added.join(" | ")} (${(suggest.ms / 1000).toFixed(0)} s) pending ${suggest.pending}; skipped [${suggest.skipped.join(", ")}] returned [${suggest.returned.join(", ")}] diag ${suggest.diag}${suggest.error ? ` error ${suggest.error}` : ""}`);

  const milestone = await page.evaluate(async ({ mod, id }) => {
    const api = game.modules.get(mod).api; const actor = game.actors.get(id);
    const req = 100 + 19 * 35 + 19 * 19 * 4;
    await actor.update({ [`flags.${mod}.levelProgression`]: { level: 19, progress: req, grantAllowances: 0, capstoneAllowances: 0 } });
    const t = Date.now(); const r = await api.resolveLevelRest(actor, { restType: "long" });
    return { ms: Date.now() - t, gained: r.gainedLevels, cls: (r.classProposals ?? []).map((p) => `${p.source}${p.usedFallback ? "(fallback)" : ""}:${p.entry?.name}`), cap: (r.capstoneProposals ?? []).map((p) => `${p.source}${p.usedFallback ? "(fallback)" : ""}:${p.entry?.name} t${p.entry?.tier}`), warnings: r.warnings ?? [] };
  }, { mod: MOD, id: actorId });
  check("rest 19 -> 20 offers an AI Class", milestone.cls.length === 1 && !/fallback/.test(milestone.cls[0]), milestone.cls.join(" | ") || "none");
  check("rest 19 -> 20 offers an AI capstone", milestone.cap.length === 1 && !/fallback/.test(milestone.cap[0]), `${milestone.cap.join(" | ")}${milestone.warnings.length ? ` warnings: ${milestone.warnings.join("; ")}` : ""}`);

  // Growth dialog via the real sheet header button.
  await page.evaluate((id) => game.actors.get(id).sheet.render(true), actorId);
  await page.waitForTimeout(2500);
  // A permanent warning toast (e.g. a rest's fallback warning) can sit over the sheet header: log
  // what it says, then clear the toasts so the click reaches the button.
  const toasts = await page.evaluate(() => [...document.querySelectorAll("#notifications li")].map((li) => li.textContent.trim()));
  if (toasts.length) console.log(`toasts: ${toasts.join(" | ")}`);
  await page.evaluate(() => { ui.notifications?.clear?.(); document.querySelectorAll("#notifications li").forEach((li) => li.remove()); });
  await page.click(".grand-design-growth");
  await page.waitForTimeout(2500);
  const dialog = await page.evaluate(() => {
    const dlg = [...document.querySelectorAll(".app, .application, dialog")].reverse().find((el) => /Grand Design Growth/i.test(el.textContent ?? ""));
    if (!dlg) return null;
    const buttons = [...dlg.querySelectorAll("button")].map((b) => ({ text: b.textContent.trim().replace(/\s+/g, " "), disabled: b.disabled }));
    return { buttons, hasBuild: /Module build/.test(dlg.textContent), text: dlg.innerText.slice(0, 600) };
  });
  check("Growth dialog opens from the sheet", Boolean(dialog));
  if (dialog) {
    const suggestBtn = dialog.buttons.find((b) => /Suggest/.test(b.text));
    check("Suggest button enabled with the AI attached", suggestBtn && !suggestBtn.disabled, JSON.stringify(suggestBtn));
    check("Growth dialog shows the module build", dialog.hasBuild);
  }
  await page.screenshot({ path: "tools/playtest/live-verify.png" });

  if (!KEEP) {
    await page.evaluate((id) => game.actors.get(id)?.delete(), actorId);
    console.log("deleted the throwaway actor");
  }
  check("no browser console errors", errors.length === 0, errors.slice(0, 5).join(" | "));
} catch (error) {
  check("live verify ran to completion", false, error.message);
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}
