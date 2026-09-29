#!/usr/bin/env node
// Playtest runner: plays the Grand Design module through a real campaign, session by session,
// the way a GM would use it -- without Foundry. The DM (a person or a Claude "DM" agent) writes
// each session's notes; this script feeds them through the REAL module API (api.js ->
// analyzeSessionNotes -> the AI gateway against a local Ollama model), keeps every character's
// Grand Design state between sessions, resolves rests, approves or rejects proposals the way the DM
// decides, and writes what the GM would actually see: a readable report plus the real Growth dialog HTML.
//
// Why without Foundry: a playtest needs dozens of analyses across sessions and both systems; the
// module's pure API runs in Node against mock actors (same pattern as tests/api-gateway-v2), so a
// whole campaign replays in minutes and every artefact is a file an agent can read and critique.
// The live Foundry check (npm run test:live-ai) still covers the real UI/Item path.
//
//   node tools/playtest/playtest.mjs init    --campaign ember-road --system dnd5e \
//        --party "Brakka:Fighter:3:the-tank,Wick:Rogue:3:chaos-gremlin,Maren:Druid:3:cottagecore"
//   node tools/playtest/playtest.mjs analyze --campaign ember-road --session 1 [--notes file]
//        [--for all|Brakka,Wick] [--rest short|long|none] [--approve none|first|all]
//        [--proposal-mode when-earned|always|never] [--model qwen3.8:27b] [--sim]
//   node tools/playtest/playtest.mjs suggest --campaign ember-road --actor Maren[,Tovin]   ("Suggest proposals")
//   node tools/playtest/playtest.mjs approve --campaign ember-road --actor Wick --proposal <id|name> [--confirm]
//        (any pending kind: skill, class, title, an evolution or a merge)
//   node tools/playtest/playtest.mjs reject  --campaign ember-road --actor Wick --proposal <id|name> [--reason "..."]
//   node tools/playtest/playtest.mjs status  --campaign ember-road [--json]
// Advanced mechanics (the registry panel; each says "not available in this build" when the API lacks it):
//   node tools/playtest/playtest.mjs owned   --campaign ember-road [--actor Wick[,Maren]] [--json]
//        owned Classes/Skills/Titles with lineage, evolution-ready Skills, eroding Classes, Horror Rank
//   node tools/playtest/playtest.mjs evolve  --campaign ember-road --actor Wick --skill <name|id> [--sim]
//        api.requestSkillEvolution -> a pending upgrade proposal (approve it with approve)
//   node tools/playtest/playtest.mjs merge   --campaign ember-road --actor Wick --classes <a>,<b> [--sim]
//        api.requestClassMerge -> a pending combine proposal
//   node tools/playtest/playtest.mjs titles  --campaign ember-road [--actor Wick]     owned + pending Titles
//   node tools/playtest/playtest.mjs erosion --campaign ember-road [--actor Wick] [--threshold N]
// Every report.md also carries a per-PC "Advanced mechanics" block and a `usedFallback:` line for each
// AI call that fell back (analysis, milestone rewards at rest, fallback proposals).
//
// Files (foundry-module/playtests/<campaign>/):
//   campaign.json                    party, every actor's module flags, items, emergent themes
//   sessions/NN/notes.md             INPUT: the DM's session notes (write this first)
//   sessions/NN/transcript.md        optional: the played scene (DM + players), for reviewers
//   sessions/NN/report.md            OUTPUT: what the module did, per character, GM-readable
//   sessions/NN/report.json          OUTPUT: raw results (events, proposals, diagnostics)
//   sessions/NN/gm-view-<Name>.html  OUTPUT: the real Growth dialog the GM would see
//   sessions/NN/review.md            written by reviewers (DM view, player view, findings)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = join(HERE, "..", "..");
const PLAYTESTS = process.env.GD_PLAYTESTS ?? join(MODULE_ROOT, "playtests");

const { GrandDesignApi } = await import("../../scripts/api.js");
const { createGatewayAdapter } = await import("../../scripts/ai-gateway.js");
const { MODULE_ID } = await import("../../scripts/constants.js");
const { normalizeGatewayConfig } = await import("../../scripts/ai/gateway-config.js");
const { renderGrowthContent, statusBadge } = await import("../../scripts/growth-ui.js");
const { parseArgs, parseList, selectParty, resolveEntry, collectAdvanced, renderAdvancedSection, fallbackLines, describeRequestResult, NOT_AVAILABLE } = await import("./lib.mjs");

// ---- args & files -----------------------------------------------------------------------------

const campaignDir = (name) => join(PLAYTESTS, safeName(name));
const sessionDir = (name, n) => join(campaignDir(name), "sessions", String(n).padStart(2, "0"));
const safeName = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");

function loadCampaign(name) {
  const path = join(campaignDir(name), "campaign.json");
  if (!existsSync(path)) throw new Error(`no campaign "${name}" (run init first): ${path}`);
  // Remember the folder it came from: a copied campaign folder keeps the original's internal name,
  // and saving by that name would overwrite the original campaign (board ad43ec26).
  const campaign = JSON.parse(readFileSync(path, "utf8"));
  Object.defineProperty(campaign, "folder", { value: safeName(name), enumerable: false });
  return campaign;
}

function saveCampaign(campaign) {
  const dir = campaignDir(campaign.folder ?? campaign.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "campaign.json"), `${JSON.stringify(campaign, null, 1)}\n`);
}

// ---- Foundry stand-ins ------------------------------------------------------------------------

function installFoundryGlobals(systemId) {
  globalThis.game = { user: { isGM: true }, system: { id: systemId }, settings: { get: () => undefined } };
  globalThis.Hooks = { callAll: () => {}, on: () => {} };
  globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
}

/** A mock Actor backed by a plain record in campaign.json, shaped like each system's real Actor. */
function makeActor(record, systemId) {
  record.flags ??= {};
  record.items ??= [];
  const level = record.level ?? 3;
  const itemsApi = {
    find: (fn) => record.items.map(itemView).find(fn),
    filter: (fn) => record.items.map(itemView).filter(fn),
    get: (id) => itemView(record.items.find((item) => item._id === id)),
    [Symbol.iterator]: () => record.items.map(itemView)[Symbol.iterator](),
    get size() {
      return record.items.length;
    }
  };
  function itemView(source) {
    if (!source) return undefined;
    return {
      ...source,
      id: source._id,
      getFlag: (scope, key) => source.flags?.[scope]?.[key],
      update: async (changes) => Object.assign(source, changes),
      // dnd5e 4+ Items get their activities after creation (systems/dnd5e-adapter.js postCreate).
      createActivity: async (type, data = {}) => {
        const id = `act${Math.random().toString(36).slice(2, 10)}`;
        source.system ??= {};
        source.system.activities = { ...(source.system.activities ?? {}), [id]: { _id: id, type, ...structuredClone(data) } };
        return source.system.activities[id];
      },
      delete: async () => {
        record.items = record.items.filter((item) => item._id !== source._id);
      }
    };
  }
  const classSource = { name: record.className, type: "class", system: { levels: level } };
  return {
    id: `pt-${safeName(record.name)}`,
    name: record.name,
    documentName: "Actor",
    type: "character",
    ...(systemId === "dnd5e"
      ? { system: { details: { level }, skills: { acr: { mod: 3, total: 5 } }, attributes: { prof: 2 } }, classes: { [safeName(record.className)]: classSource } }
      : { system: { details: { level: { value: level } }, skills: { acrobatics: { mod: 7 } } }, class: classSource }),
    items: itemsApi,
    getFlag: (scope, key) => (scope === MODULE_ID ? record.flags[key] : undefined),
    async setFlag(scope, key, value) {
      if (scope === MODULE_ID) record.flags[key] = value;
      return this;
    },
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) {
        const parts = path.split(".");
        if (parts[0] === "flags" && parts[1] === MODULE_ID) record.flags[parts.slice(2).join(".")] = value;
      }
      return this;
    },
    async createEmbeddedDocuments(type, sources) {
      if (type !== "Item") return [];
      const created = sources.map((source) => ({ ...structuredClone(source), _id: `pt${Math.random().toString(36).slice(2, 12)}` }));
      record.items.push(...created);
      return created.map(itemView);
    },
    async updateEmbeddedDocuments(_type, updates) {
      for (const update of updates) Object.assign(record.items.find((item) => item._id === update._id) ?? {}, update);
      return updates;
    },
    async deleteEmbeddedDocuments(_type, ids) {
      record.items = record.items.filter((item) => !ids.includes(item._id));
      return ids;
    }
  };
}

function buildApi(campaign, flags) {
  installFoundryGlobals(campaign.system);
  const api = new GrandDesignApi();
  const config = normalizeGatewayConfig({
    ...(campaign.gateway ?? {}),
    ...(flags.model ? { model: flags.model } : {}),
    ...(flags["proposal-mode"] ? { proposalMode: flags["proposal-mode"] } : {}),
    systemId: campaign.system
  });
  if (flags.sim) {
    // Offline dry run: the simulated model from the scale harness (no Ollama needed).
    return import("../nlp-scale/sim-model.js").then(({ createSimModel }) => {
      const sim = createSimModel({ faultRate: 0 });
      api.setGatewayConfigProvider(() => config);
      api.setProposalAdapter(createGatewayAdapter({ ...config, model: "sim", fetchImpl: sim.fetch, sleep: async () => {} }));
      wireThemes(api, campaign);
      return { api, config: { ...config, model: "sim" } };
    });
  }
  api.setGatewayConfigProvider(() => config);
  api.setProposalAdapter(createGatewayAdapter(config));
  wireThemes(api, campaign);
  return Promise.resolve({ api, config });
}

function wireThemes(api, campaign) {
  campaign.emergentThemes ??= {};
  api.setEmergentThemeStore({ get: () => campaign.emergentThemes, set: async (state) => { campaign.emergentThemes = state; } });
}

// ---- commands ---------------------------------------------------------------------------------

function cmdInit(flags) {
  if (!flags.campaign || !flags.party) throw new Error('usage: init --campaign <name> --system pf2e|dnd5e --party "Name:Class:Level[:persona],..."');
  const system = flags.system === "dnd5e" ? "dnd5e" : "pf2e";
  const name = safeName(flags.campaign);
  if (existsSync(join(campaignDir(name), "campaign.json")) && !flags.force) throw new Error(`campaign ${name} exists (--force to reset it)`);
  const party = String(flags.party).split(",").map((spec) => {
    const [pcName, className = "Fighter", level = "3", persona = ""] = spec.split(":").map((s) => s.trim());
    return { name: pcName, className, level: Number(level) || 3, persona, flags: {}, items: [] };
  });
  const campaign = { name, system, created: new Date().toISOString(), sessionsPlayed: 0, gateway: {}, party, emergentThemes: {} };
  saveCampaign(campaign);
  mkdirSync(join(campaignDir(name), "sessions"), { recursive: true });
  console.log(`campaign ${name} (${system}) created with ${party.map((pc) => `${pc.name} the ${pc.className} ${pc.level}`).join(", ")}`);
  console.log(`next: write ${join(sessionDir(name, 1), "notes.md")} and run analyze --session 1`);
}

async function cmdAnalyze(flags) {
  const campaign = loadCampaign(flags.campaign);
  const n = Number(flags.session ?? campaign.sessionsPlayed + 1);
  const dir = sessionDir(campaign.folder ?? campaign.name, n);
  const notesPath = flags.notes ?? join(dir, "notes.md");
  if (!existsSync(notesPath)) throw new Error(`no notes at ${notesPath}`);
  const notes = readFileSync(notesPath, "utf8").replace(/^---[\s\S]*?---\s*/, "").trim();
  const { api, config } = await buildApi(campaign, flags);
  const who = !flags.for || flags.for === "all" ? campaign.party : campaign.party.filter((pc) => String(flags.for).split(",").map((s) => s.trim().toLowerCase()).includes(pc.name.toLowerCase()));
  const rest = ["short", "long"].includes(flags.rest) ? flags.rest : null;
  const approveMode = flags.approve ?? "none";

  const results = [];
  for (const pc of who) {
    const actor = makeActor(pc, campaign.system);
    const before = { progression: structuredClone(api.getLevelProgression(actor)), pending: api.getGrowth(actor).proposals.filter((p) => p.status === "pending").length };
    const started = Date.now();
    let analysis;
    let error = null;
    try {
      analysis = await api.analyzeSessionNotes(actor, notes);
    } catch (e) {
      error = e.message;
    }
    const ms = Date.now() - started;
    let restResult = null;
    if (!error && rest) restResult = await api.resolveLevelRest(actor, { restType: rest });
    const approved = [];
    if (!error && approveMode !== "none") {
      const pending = api.getGrowth(actor).proposals.filter((p) => p.status === "pending");
      for (const proposal of approveMode === "all" ? pending : pending.slice(0, 1)) {
        try {
          const done = await api.approveProposal(actor, proposal.id);
          approved.push({ id: proposal.id, name: proposal.entry?.name, item: done?.item?.name ?? null });
        } catch (e) {
          approved.push({ id: proposal.id, name: proposal.entry?.name, error: e.message });
        }
      }
    }
    const growth = api.getGrowth(actor);
    const progression = api.getLevelProgression(actor);
    const pending = growth.proposals.filter((p) => p.status === "pending");
    const html = renderGrowthContent({
      growth,
      progression,
      pending,
      lastAnalysis: pc.flags.lastAnalysis,
      lastResult: analysis ?? null,
      status: statusBadge(config, { source: analysis?.source ?? "local-fallback" }, true)
    });
    writeGmView(dir, pc.name, campaign, html);
    // Advanced mechanics after the analysis/rest/approvals: what the DM looks at before the next
    // session (who can evolve, which Class is eroding, Horror Rank). A read; never fails the session.
    let advanced;
    try {
      advanced = collectAdvanced(api, actor, { analysis, restResult });
    } catch (e) {
      advanced = { error: e.message };
    }
    const fallbacks = error ? [] : fallbackLines({ analysis, restResult, pending });
    results.push({ name: pc.name, className: pc.className, persona: pc.persona, restType: rest, ms, error, analysis, before, after: { progression, pending: pending.length }, restResult, approved, pending, advanced, fallbacks });
    console.log(`${pc.name}: ${error ? `ERROR ${error}` : `${analysis.source}, ${analysis.events.length} events, ${pending.length} pending proposals`} (${(ms / 1000).toFixed(1)}s)`);
  }
  campaign.sessionsPlayed = Math.max(campaign.sessionsPlayed, n);
  saveCampaign(campaign);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "report.json"), `${JSON.stringify({ campaign: campaign.name, system: campaign.system, session: n, model: config.model, proposalMode: config.proposalMode, at: new Date().toISOString(), notes, results }, null, 1)}\n`);
  writeFileSync(join(dir, "report.md"), renderReport(campaign, n, config, notes, results, existsSync(join(dir, "transcript.md"))));
  console.log(`report: ${join(dir, "report.md")}`);
}

function cmdApprove(flags) {
  return (async () => {
    const campaign = loadCampaign(flags.campaign);
    const pc = campaign.party.find((p) => p.name.toLowerCase() === String(flags.actor ?? "").toLowerCase());
    if (!pc) throw new Error(`no party member ${flags.actor}`);
    const { api } = await buildApi(campaign, { ...flags, sim: true });
    const actor = makeActor(pc, campaign.system);
    const ref = String(flags.proposal ?? "").toLowerCase();
    const proposal = api.getGrowth(actor).proposals.find((p) => p.status === "pending" && (p.id === flags.proposal || String(p.entry?.name ?? "").toLowerCase().includes(ref)));
    if (!proposal) throw new Error(`no pending proposal matches ${flags.proposal}`);
    // Any pending kind (skill, class, title, an upgrade/combine) goes through the same approveProposal the
    // Growth dialog uses; --confirm approves a generic placeholder as written (api needsAuthoring guard).
    const done = await api.approveProposal(actor, proposal.id, flags.confirm === true ? { confirm: true } : {});
    saveCampaign(campaign);
    const op = proposal.entry?.metadata?.lineage?.operation;
    console.log(`approved ${proposal.entry?.name} [${proposal.kind ?? "skill"}${op && op !== "origin" ? `/${op}` : ""}] for ${pc.name} -> item ${done?.item?.name ?? "(none)"}`);
  })();
}

// The GM's "no" (api.rejectProposal): mirrors cmdApprove exactly except for which API call it makes
// and that it prints the optional reason. Like approve, only a currently-pending proposal matches.
function cmdReject(flags) {
  return (async () => {
    const campaign = loadCampaign(flags.campaign);
    const pc = campaign.party.find((p) => p.name.toLowerCase() === String(flags.actor ?? "").toLowerCase());
    if (!pc) throw new Error(`no party member ${flags.actor}`);
    const { api } = await buildApi(campaign, { ...flags, sim: true });
    const actor = makeActor(pc, campaign.system);
    const ref = String(flags.proposal ?? "").toLowerCase();
    const proposal = api.getGrowth(actor).proposals.find((p) => p.status === "pending" && (p.id === flags.proposal || String(p.entry?.name ?? "").toLowerCase().includes(ref)));
    if (!proposal) throw new Error(`no pending proposal matches ${flags.proposal}`);
    const done = await api.rejectProposal(actor, proposal.id, { reason: flags.reason });
    saveCampaign(campaign);
    console.log(`rejected ${proposal.entry?.name} for ${pc.name}${done?.rejectedReason ? ` (${done.rejectedReason})` : ""}`);
  })();
}

// The Growth dialog's "Suggest proposals" button (api.requestGrowthProposals): what a GM clicks when a
// grant allowance is waiting and nothing is pending. Real model; prints what the GM would read.
async function cmdSuggest(flags) {
  const campaign = loadCampaign(flags.campaign);
  const names = String(flags.actor ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const pcs = campaign.party.filter((p) => names.includes(p.name.toLowerCase()));
  if (!pcs.length) throw new Error("usage: suggest --campaign <name> --actor Name[,Name]");
  const { api } = await buildApi(campaign, flags);
  for (const pc of pcs) {
    const actor = makeActor(pc, campaign.system);
    const started = Date.now();
    try {
      const result = await api.requestGrowthProposals(actor);
      const created = result?.added ?? [];
      console.log(`${pc.name}: ${created.length} new proposal(s) (${((Date.now() - started) / 1000).toFixed(1)}s)`);
      if (flags.debug) console.log(JSON.stringify({ skipped: result?.skipped, diag: result?.gatewayDiagnostics }, null, 1).slice(0, 4000));
    } catch (e) {
      console.log(`${pc.name}: ERROR ${e.message}`);
    }
    saveCampaign(campaign);
    for (const p of api.getGrowth(actor).proposals.filter((x) => x.status === "pending")) {
      const md = p.entry?.metadata ?? {};
      console.log(`  * ${p.entry?.name} [${p.kind ?? ""}/${p.entry?.gameItem?.kind ?? ""}, tier ${p.entry?.tier ?? "-"}]${md.polarity === "red" ? ` RED ${md.malignance?.vice}: ${md.malignance?.drawback}` : ""}`);
      console.log(`      ${p.entry?.mechanics?.effect ?? ""} (${JSON.stringify(p.entry?.mechanics?.frequency ?? {})})`);
      console.log(`      evidence: ${(p.evidence ?? []).join(" / ")}`);
    }
  }
}

async function cmdStatus(flags) {
  const campaign = loadCampaign(flags.campaign);
  const { api } = await buildApi(campaign, { ...flags, sim: true });
  const rows = campaign.party.map((pc) => {
    const actor = makeActor(pc, campaign.system);
    const growth = api.getGrowth(actor);
    const prog = api.getLevelProgression(actor);
    const registry = api.getActorRegistry(actor);
    return {
      name: pc.name,
      className: pc.className,
      persona: pc.persona,
      gdLevel: prog.level ?? 0,
      progress: Math.round(prog.progress ?? 0),
      grantAllowances: prog.grantAllowances ?? 0,
      events: growth.events.length,
      pending: growth.proposals.filter((p) => p.status === "pending").map((p) => p.entry?.name),
      skills: Object.values(registry.skills ?? {}).map((s) => s.name),
      classes: Object.values(registry.classes ?? {}).map((c) => c.name),
      horrorRank: api.getHorrorRank(actor)
    };
  });
  if (flags.json) return console.log(JSON.stringify({ campaign: campaign.name, system: campaign.system, sessionsPlayed: campaign.sessionsPlayed, party: rows, emergentThemes: api.getEmergentThemes() }, null, 1));
  console.log(`${campaign.name} (${campaign.system}), ${campaign.sessionsPlayed} session(s) played`);
  for (const r of rows) {
    console.log(`- ${r.name} the ${r.className}${r.persona ? ` [${r.persona}]` : ""}: GD level ${r.gdLevel}, progress ${r.progress}, allowances ${r.grantAllowances}, ${r.events} events`);
    if (r.skills.length || r.classes.length) console.log(`    owns: ${[...r.classes, ...r.skills].join(", ")}`);
    if (r.pending.length) console.log(`    pending: ${r.pending.join(" | ")}`);
  }
}

// ---- advanced mechanics (evolve / merge / titles / erosion) ----------------------------------------
// The API for these lands separately (requestSkillEvolution, requestClassMerge, getOwnedEntries, title
// proposals); every command feature-detects and says "not available in this build" instead of failing,
// and shows what today's API can (previews, registry, readiness) so the DM still sees the state.

function findPc(campaign, name, usage) {
  const pc = campaign.party.find((p) => p.name.toLowerCase() === String(name ?? "").trim().toLowerCase());
  if (!pc) throw new Error(name && name !== true ? `no party member ${name}` : usage);
  return pc;
}

// `owned [--actor X[,Y]] [--json]`: owned entries with lineage, evolution readiness, erosion, Horror Rank.
async function cmdOwned(flags) {
  const campaign = loadCampaign(flags.campaign);
  const { api } = await buildApi(campaign, { ...flags, sim: true });
  const pcs = selectParty(campaign.party, flags.actor);
  const rows = pcs.map((pc) => ({ name: pc.name, ...collectAdvanced(api, makeActor(pc, campaign.system), { erosionThreshold: Number(flags.threshold) || undefined }) }));
  if (flags.json) return console.log(JSON.stringify(rows, null, 1));
  for (const row of rows) console.log(renderAdvancedSection(row, { heading: `## ${row.name}` }));
}

// `evolve --actor X --skill <name|id>`: the registry panel's Evolve button (api.requestSkillEvolution).
async function cmdEvolve(flags) {
  const usage = "usage: evolve --campaign <name> --actor X --skill <name|id> [--sim]";
  const campaign = loadCampaign(flags.campaign);
  const pc = findPc(campaign, flags.actor, usage);
  const { api } = await buildApi(campaign, flags);
  const actor = makeActor(pc, campaign.system);
  const { owned } = collectAdvanced(api, actor);
  const skill = resolveEntry(owned.skills, flags.skill, "Skill");
  if (skill.status === "superseded") throw new Error(`${skill.name} is superseded (already evolved)`);
  const readiness = api.checkSkillEvolutionReadiness(actor, skill.id)[0];
  console.log(`${pc.name} / ${skill.name}: evidence ${readiness?.evidenceWeight ?? "?"}/${readiness?.evidenceThreshold ?? "?"}, defining moments ${readiness?.definingMoments?.length ?? 0}, ready ${readiness?.hasCatalyst ? "yes" : "no"}`);
  if (typeof api.requestSkillEvolution !== "function") {
    console.log(`requestSkillEvolution ${NOT_AVAILABLE}`);
    try {
      const preview = api.buildSkillEvolutionPreview(actor, { sourceId: skill.id });
      console.log(`  preview (buildSkillEvolutionPreview, nothing saved): "${preview.name}" tier ${preview.tier}${preview.evolution?.catalyst === false ? " (refinement, no catalyst)" : ""}`);
    } catch (e) {
      console.log(`  preview failed: ${e.message}`);
    }
    return;
  }
  const started = Date.now();
  const result = await api.requestSkillEvolution(actor, skill.id);
  saveCampaign(campaign);
  console.log(`${describeRequestResult("evolve", result)} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  printProposal(result?.proposal);
}

// `merge --actor X --classes a,b`: the registry panel's Merge action (api.requestClassMerge).
async function cmdMerge(flags) {
  const usage = "usage: merge --campaign <name> --actor X --classes <name|id>,<name|id>[,...] [--sim]";
  const campaign = loadCampaign(flags.campaign);
  const pc = findPc(campaign, flags.actor, usage);
  const refs = parseList(flags.classes);
  if (refs.length < 2) throw new Error(`${usage} (at least two Classes)`);
  const { api } = await buildApi(campaign, flags);
  const actor = makeActor(pc, campaign.system);
  const { owned } = collectAdvanced(api, actor);
  const classes = refs.map((ref) => resolveEntry(owned.classes, ref, "Class"));
  if (new Set(classes.map((c) => c.id)).size < classes.length) throw new Error("the same Class is named twice");
  const stale = classes.filter((c) => c.status === "superseded");
  if (stale.length) throw new Error(`superseded (already merged): ${stale.map((c) => c.name).join(", ")}`);
  const ids = classes.map((c) => c.id);
  if (typeof api.requestClassMerge !== "function") {
    console.log(`requestClassMerge ${NOT_AVAILABLE}`);
    // The preview needs a level; the strongest source's is the natural starting point for a merge.
    const level = Math.max(1, ...classes.map((c) => Number(c.level) || 1));
    try {
      const preview = api.buildClassMergePreview(actor, { sourceIds: ids, level });
      console.log(`  preview (buildClassMergePreview, nothing saved): "${preview.name}" level ${preview.level ?? "?"}, ${preview.power_tier ?? "?"}${preview.offCycleEvolution ? " (off-cycle)" : ""}`);
    } catch (e) {
      console.log(`  preview failed: ${e.message}`);
    }
    return;
  }
  const started = Date.now();
  const result = await api.requestClassMerge(actor, ids);
  saveCampaign(campaign);
  console.log(`${describeRequestResult(`merge ${classes.map((c) => c.name).join(" + ")}`, result)} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  printProposal(result?.proposal);
}

function printProposal(p) {
  if (!p) return;
  const e = p.entry ?? {};
  console.log(`  id ${p.id}; approve with: approve --actor <X> --proposal ${p.id}`);
  if (e.mechanics?.effect) console.log(`  ${e.mechanics.effect}`);
  if (e.metadata?.lineage?.rationale ?? p.rationale) console.log(`  why: ${e.metadata?.lineage?.rationale ?? p.rationale}`);
}

// `titles [--actor X]`: owned Titles and pending title proposals (kind "title").
async function cmdTitles(flags) {
  const campaign = loadCampaign(flags.campaign);
  const { api } = await buildApi(campaign, { ...flags, sim: true });
  for (const pc of selectParty(campaign.party, flags.actor)) {
    const actor = makeActor(pc, campaign.system);
    const { owned } = collectAdvanced(api, actor);
    const pending = api.getGrowth(actor).proposals.filter((p) => p.status === "pending" && p.kind === "title");
    console.log(`${pc.name}: ${owned.titles.length} Title(s), ${pending.length} pending`);
    for (const t of owned.titles) console.log(`  owns [${t.name}]${t.polarity === "red" ? " RED" : ""}${t.effect ? ` - ${t.effect}` : ""}`);
    for (const p of pending) console.log(`  pending [${p.entry?.name}]${p.entry?.metadata?.polarity === "red" ? ` RED${p.entry?.metadata?.vice ? ` (${p.entry.metadata.vice})` : ""}` : ""} ${p.id}${p.rationale ? ` - ${p.rationale}` : ""}`);
  }
}

// `erosion [--actor X] [--threshold N]`: api.checkClassErosion, Classes whose behaviour stopped.
async function cmdErosion(flags) {
  const campaign = loadCampaign(flags.campaign);
  const { api } = await buildApi(campaign, { ...flags, sim: true });
  const threshold = Number(flags.threshold) || undefined;
  for (const pc of selectParty(campaign.party, flags.actor)) {
    const actor = makeActor(pc, campaign.system);
    const atRisk = api.checkClassErosion(actor, threshold ? { sessionThreshold: threshold } : {});
    const hr = api.getHorrorRank(actor);
    console.log(`${pc.name}: ${atRisk.length ? atRisk.map((c) => `${c.name} at risk (${c.neverSeen ? "never seen in play" : `${c.sessionsSinceLastSeen} session(s) since its tags`})`).join("; ") : "no Class at risk"}; Horror Rank ${hr.points} pt, ${hr.totalLevelsDocked} level(s) docked`);
  }
}

// ---- rendering --------------------------------------------------------------------------------

function writeGmView(dir, name, campaign, html) {
  mkdirSync(dir, { recursive: true });
  const css = existsSync(join(MODULE_ROOT, "styles", "grand-design.css")) ? readFileSync(join(MODULE_ROOT, "styles", "grand-design.css"), "utf8") : "";
  // Font Awesome icons are referenced by class only; the page is readable without them.
  writeFileSync(
    join(dir, `gm-view-${safeName(name)}.html`),
    `<!doctype html><html><head><meta charset="utf-8"><title>${name} - Growth (${campaign.name})</title><style>body{font-family:system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;background:#f4f1ea;color:#222}${css}</style></head><body><h2>${name} - Grand Design Growth</h2>${html}</body></html>\n`
  );
}

const flagsRest = (r) => (r.restType === "long" ? "Long" : "Short");

function renderReport(campaign, n, config, notes, results, hasTranscript) {
  const lines = [];
  lines.push(`# ${campaign.name} - session ${n} - module report`);
  lines.push("");
  lines.push(`System **${campaign.system}**, model \`${config.model}\`, proposals \`${config.proposalMode}\`, analysed ${new Date().toISOString().slice(0, 16).replace("T", " ")}.${hasTranscript ? " The played scene is in `transcript.md`." : ""}`);
  lines.push("");
  lines.push("## Session notes (as the DM wrote them)");
  lines.push("");
  lines.push(notes.split("\n").map((l) => `> ${l}`).join("\n"));
  lines.push("");
  for (const r of results) {
    lines.push(`## ${r.name} the ${r.className}${r.persona ? ` (player: ${r.persona})` : ""}`);
    lines.push("");
    if (r.error) {
      lines.push(`**ERROR:** ${r.error}`);
      lines.push("");
      continue;
    }
    const a = r.analysis;
    const fell = a.source !== "adapter";
    lines.push(`- Read by: **${a.source}**${fell ? ` -- FALLBACK${a.adapterError ? `: ${a.adapterError}` : ""}` : ""} in ${(r.ms / 1000).toFixed(1)}s`);
    // Every AI fallback (analysis, milestone rewards at rest, fallback proposals), stated with its reason.
    for (const f of (r.fallbacks ?? []).filter((line) => !line.startsWith("analysis read by"))) lines.push(`- usedFallback: ${f}`);
    const p0 = r.before.progression;
    const p1 = r.after.progression;
    lines.push(`- Grand Design level ${p0.level ?? 0} -> ${p1.level ?? 0}, progress ${Math.round(p0.progress ?? 0)} -> ${Math.round(p1.progress ?? 0)}, grant allowances ${p1.grantAllowances ?? 0}`);
    if (r.restResult) {
      const gained = r.restResult.gainedLevels ?? [];
      lines.push(`- ${flagsRest(r)} rest: ${gained.length ? `reached Grand Design level ${gained.join(", ")}` : "no level gained"}${r.restResult.classEvolutionUnlocked?.length ? ", CLASS EVOLUTION unlocked" : ""}${r.restResult.capstoneProposals?.length ? `, capstone proposals ${r.restResult.capstoneProposals.length}` : ""}`);
    }
    lines.push("");
    lines.push(`### What the module read (${a.events.length} event${a.events.length === 1 ? "" : "s"})`);
    lines.push("");
    if (!a.events.length) lines.push("_Nothing recorded._");
    for (const e of a.events) {
      const who = e.actorName ? `**${e.actorName}:** ` : "";
      const chips = [...(e.tags ?? []), ...(e.themes ?? []).map((t) => `~${t}`)].join(", ");
      lines.push(`- ${who}${e.summary}${e.consequence ? ` -> _${e.consequence}_` : ""} — \`${e.outcome}\`${e.dangerGap ? ` (danger: ${e.dangerGap})` : ""} [${chips}]`);
    }
    lines.push("");
    const newThemes = (a.themes ?? []).filter((t) => t.isNew).map((t) => t.slug);
    if (newThemes.length) {
      lines.push(`New emergent themes: ${newThemes.join(", ")}`);
      lines.push("");
    }
    lines.push(`### Proposals waiting for the GM (${r.pending.length})`);
    lines.push("");
    if (!r.pending.length) lines.push("_None._");
    for (const p of r.pending) {
      const e = p.entry ?? {};
      const kind = p.kind === "title" ? "TITLE" : e.gameItem?.kind ?? p.kind;
      const op = e.metadata?.lineage?.operation;
      const red = e.metadata?.polarity === "red" ? ` **RED (${e.metadata?.malignance?.vice ?? e.metadata?.vice ?? "?"})** drawback: ${e.metadata?.malignance?.drawback ?? "?"}` : "";
      lines.push(`- **${e.name ?? p.id}** (${kind}${e.tier ? `, tier ${e.tier}` : ""}${op === "upgrade" || op === "combine" ? `, ${op}` : ""}, ${p.source ?? "?"})${red}`);
      if (p.usedFallback) lines.push(`  - usedFallback${p.fallbackReason ? `: ${p.fallbackReason}` : ""}`);
      if (e.mechanics?.effect) lines.push(`  - ${e.mechanics.effect}`);
      const freq = e.mechanics?.frequency;
      const extra = [freq ? `${freq.max}/${freq.per}` : "", e.mechanics?.trigger ? `trigger: ${e.mechanics.trigger}` : "", e.system_equivalent ? `≈ ${e.system_equivalent}` : ""].filter(Boolean).join(" · ");
      if (extra) lines.push(`  - ${extra}`);
    }
    lines.push("");
    if (r.approved.length) {
      lines.push(`Approved this session: ${r.approved.map((x) => (x.error ? `${x.name} (FAILED: ${x.error})` : `${x.name} -> item "${x.item}"`)).join("; ")}`);
      lines.push("");
    }
    const skipped = [...(a.adapterSkippedProposals ?? []), ...(a.adapterSkippedEvents ?? [])];
    if (skipped.length) {
      lines.push(`<details><summary>Skipped by the gateway (${skipped.length})</summary>\n\n${skipped.slice(0, 10).map((s) => `- ${s.reason ?? "invalid"}: ${JSON.stringify(s.errors ?? s.error ?? s.proposal?.entry?.name ?? s.proposal?.name ?? s.event?.summary ?? s.event?.quote ?? "").slice(0, 200)}`).join("\n")}\n\n</details>`);
      lines.push("");
    }
    if (r.advanced?.error) lines.push(`### Advanced mechanics\n\n**ERROR reading advanced state:** ${r.advanced.error}\n`);
    else if (r.advanced) lines.push(renderAdvancedSection(r.advanced));
    lines.push(`GM screen: \`gm-view-${safeName(r.name)}.html\``);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

// ---- main -------------------------------------------------------------------------------------

const { cmd, flags } = parseArgs(process.argv.slice(2));
const quiet = console.warn;
console.warn = flags.verbose ? quiet : () => {}; // the module logs fallbacks on purpose; the report states them
try {
  if (cmd === "init") cmdInit(flags);
  else if (cmd === "analyze") await cmdAnalyze(flags);
  else if (cmd === "approve") await cmdApprove(flags);
  else if (cmd === "reject") await cmdReject(flags);
  else if (cmd === "suggest") await cmdSuggest(flags);
  else if (cmd === "status") await cmdStatus(flags);
  else if (cmd === "owned") await cmdOwned(flags);
  else if (cmd === "evolve") await cmdEvolve(flags);
  else if (cmd === "merge") await cmdMerge(flags);
  else if (cmd === "titles") await cmdTitles(flags);
  else if (cmd === "erosion") await cmdErosion(flags);
  else {
    console.error("commands: init | analyze | suggest | approve | reject | status | owned | evolve | merge | titles | erosion  (see the header of this file)");
    process.exit(1);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
