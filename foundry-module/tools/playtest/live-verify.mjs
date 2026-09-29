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

  // Throwaway actors.
  const extraActorIds = [];
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

  // Advanced mechanics (2026-09-29): approve a Skill, evolve it (AI upgrade or the rules' fallback,
  // with its reason), approve the evolution and check the source is superseded; a title proposal
  // path is exercised by the unit tests (the model proposes titles only for notable deeds).
  const advanced = await page.evaluate(async ({ mod, id }) => {
    const api = game.modules.get(mod).api; const actor = game.actors.get(id);
    if (typeof api.getOwnedEntries !== "function" || typeof api.requestSkillEvolution !== "function") return { missing: true };
    const skill = api.getGrowth(actor).proposals.find((p) => p.status === "pending" && p.kind === "skill" && !p.needsAuthoring);
    if (!skill) return { note: "no pending AI Skill to approve" };
    // Approving a generated Skill spends a grant allowance earned at rest; give the throwaway one.
    const lp = api.getLevelProgression(actor);
    await actor.update({ [`flags.${mod}.levelProgression`]: { ...lp, level: Math.max(1, lp.level ?? 0), grantAllowances: 1 } });
    await api.approveProposal(actor, skill.id, { confirm: true });
    const owned = api.getOwnedEntries(actor).skills.find((e) => e.name === skill.entry.name);
    if (!owned) return { note: `approved ${skill.entry.name} but getOwnedEntries does not list it` };
    const t = Date.now(); const r = await api.requestSkillEvolution(actor, owned.id);
    const evolvedName = r.proposal?.entry?.name;
    await api.approveProposal(actor, r.proposal.id, { confirm: true });
    const after = api.getOwnedEntries(actor).skills;
    const source = after.find((e) => e.id === owned.id);
    const evolved = after.find((e) => e.name === evolvedName);
    return { ms: Date.now() - t, source: owned.name, evolvedName, tier: `${owned.tier}->${evolved?.tier}`, usedFallback: r.usedFallback, reason: r.reason, sourceStatus: source?.status, lineage: evolved?.lineage?.sourceNames ?? evolved?.lineage?.sources };
  }, { mod: MOD, id: actorId });
  if (advanced.missing) check("advanced mechanics API present", false, "getOwnedEntries/requestSkillEvolution missing");
  else {
    check("Evolve writes an upgrade and supersedes the source", advanced.sourceStatus === "superseded" && Boolean(advanced.evolvedName), advanced.note ?? `${advanced.source} -> ${advanced.evolvedName} (tier ${advanced.tier}, lineage ${JSON.stringify(advanced.lineage)}, ${((advanced.ms ?? 0) / 1000).toFixed(0)} s)`);
    check("Evolve is written by the AI", advanced.usedFallback === false, advanced.usedFallback ? `fallback: ${advanced.reason}` : "ai");
  }

  // Structured mechanics (batch 3): the Skill approved above should be a real item, not a text stub.
  const itemData = await page.evaluate(({ mod, id }) => {
    const actor = game.actors.get(id);
    const items = actor.items.filter((i) => i.getFlag(mod, "registryId"));
    return items.map((i) => ({ name: i.name, rules: i.system?.rules?.length ?? 0, frequency: i.system?.frequency?.max ?? null, activities: i.system?.activities?.size ?? 0, effects: i.effects?.size ?? 0, superseded: Boolean(i.getFlag(mod, "superseded")) }));
  }, { mod: MOD, id: actorId });
  const live = itemData.filter((i) => !i.superseded);
  check("approved Skills become real items (rules/frequency or activities/effects)", live.some((i) => i.rules || i.frequency || i.activities || i.effects), JSON.stringify(itemData).slice(0, 300));
  const off = itemData.filter((i) => i.superseded);
  check("the superseded Item's mechanics are switched off", off.length > 0 && off.every((i) => !i.rules && !i.activities), JSON.stringify(off).slice(0, 200));

  // Horror Rank from deeds (owner decision 2026-09-29): an AI-read dark deed adds points.
  const horror = await page.evaluate(async ({ mod, id }) => {
    const api = game.modules.get(mod).api; const actor = game.actors.get(id);
    const before = api.getHorrorRank(actor).points;
    const r = await api.analyzeSessionNotes(actor, "Kestra dragged the bandit who had thrown down his sword and begged for mercy to the cliff and pushed him off, laughing.");
    const after = api.getHorrorRank(actor);
    return { before, after: after.points, stage: after.stage, deeds: (after.deeds ?? []).map((d) => `${d.vice}/${d.severity}:${d.summary}`), events: r.events.map((e) => `${e.darkDeed}/${e.darkSeverity}`) };
  }, { mod: MOD, id: actorId });
  check("a dark deed read by the AI raises Horror Rank", horror.after > horror.before, `${horror.before} -> ${horror.after} (stage ${horror.stage}) ${horror.deeds.join(" | ") || horror.events.join(",")}`);

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

  // Registry panel from the sheet header (the Growth dialog is left open; the header button is enough).
  await page.evaluate(() => { document.querySelectorAll("#notifications li").forEach((li) => li.remove()); });
  // DOM click: the open Growth dialog can overlap the sheet header, and this checks the button's
  // handler, not pointer hit-testing.
  const header = await page.evaluate(() => {
    const el = [...document.querySelectorAll(".grand-design-registry")].find((e) => e.tagName !== "FORM" && e.closest(".window-header, header"));
    if (!el) return false;
    el.click();
    return true;
  });
  if (header) await page.waitForTimeout(2500);
  const registry = await page.evaluate(() => {
    const form = document.querySelector("form.grand-design-registry");
    if (!form) return null;
    return { text: form.innerText.slice(0, 400), superseded: /superseded/i.test(form.innerText), evolve: [...form.querySelectorAll("button")].some((b) => /Evolve/.test(b.textContent)) };
  });
  check("Registry panel opens from the sheet header", Boolean(registry), header ? "" : "no header button found");
  if (registry) check("Registry lists owned Skills with Evolve and the superseded source", registry.evolve && registry.superseded, registry.text.replace(/\s+/g, " ").slice(0, 200));
  await page.screenshot({ path: "tools/playtest/live-verify-registry.png" });

  // Record corrections (board 4344c58a): revert the evolution (source comes back, its Item's mechanics
  // too), then move one recorded event to a second PC and delete another.
  const corrections = await page.evaluate(async ({ mod, id, evolvedName }) => {
    const api = game.modules.get(mod).api; const actor = game.actors.get(id);
    if (typeof api.revertApproval !== "function") return { missing: true };
    const out = {};
    const evolved = api.getOwnedEntries(actor).skills.find((e) => e.name === evolvedName && e.status !== "superseded");
    if (evolved) {
      try {
        const r = await api.revertApproval(actor, evolved.id);
        const restoredIds = (r.restored ?? []).map((x) => x.id ?? x);
        const items = actor.items.filter((i) => i.getFlag(mod, "registryId"));
        out.revert = { restored: restoredIds.length, stillSuperseded: items.filter((i) => i.getFlag(mod, "superseded")).length, liveItems: items.map((i) => ({ name: i.name, rules: i.system?.rules?.length ?? 0, activities: i.system?.activities?.size ?? 0 })) };
      } catch (e) { out.revert = { error: e.message }; }
    } else out.revert = { note: "no evolved entry to revert" };
    const other = await Actor.create({ name: "GD Live Check 2 (delete me)", type: "character" });
    out.otherId = other.id;
    await api.recordGrowthEvent(actor, { summary: "GD live check: carried a stranger's pack up the pass.", tags: ["athletics"], outcome: "success" });
    await api.recordGrowthEvent(actor, { summary: "GD live check: bet the ferryman and lost.", tags: ["deception"], outcome: "failure" });
    const events = api.getGrowth(actor).events;
    const move = events.find((e) => /stranger's pack/.test(e.summary)); const del = events.find((e) => /ferryman/.test(e.summary));
    try {
      await api.reassignRecordedEvent(actor, move.id, other);
      await api.deleteRecordedEvent(actor, del.id);
    } catch (e) { out.error = e.message; }
    const left = api.getGrowth(actor).events.map((e) => e.summary);
    const moved = api.getGrowth(other).events.find((e) => /stranger's pack/.test(e.summary));
    out.moved = Boolean(moved?.reassigned) && !left.some((s) => /stranger's pack/.test(s));
    out.deleted = !left.some((s) => /ferryman/.test(s));
    out.lanSetting = game.settings.settings.get(`${mod}.aiAllowPrivateHttp`)?.scope ?? null;
    return out;
  }, { mod: MOD, id: actorId, evolvedName: advanced.evolvedName });
  if (corrections.missing) check("record corrections API present", false);
  else {
    if (corrections.otherId) extraActorIds.push(corrections.otherId);
    check("Revert approval restores the superseded source and its mechanics", corrections.revert?.restored > 0 && corrections.revert.stillSuperseded === 0, JSON.stringify(corrections.revert).slice(0, 300));
    check("Move to... puts the event on the other PC, stamped reassigned", corrections.moved, corrections.error ?? "");
    check("Delete removes the recorded event", corrections.deleted, corrections.error ?? "");
    check("LAN plain-HTTP opt-in is a per-user setting", corrections.lanSetting === "user", String(corrections.lanSetting));
  }

  if (!KEEP) {
    for (const extra of extraActorIds) await page.evaluate((id) => game.actors.get(id)?.delete(), extra);
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
