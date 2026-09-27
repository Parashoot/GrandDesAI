#!/usr/bin/env node
// Export Grand Design AI's docs, project spec, board, measurements and playtest logs into the
// owner's Obsidian vault, so the project can be read (and searched by local assistants) there.
// Same contract as MandoAI's scripts/vault_export.py:
//
//   node tools/vault-export.mjs              # write into <vault>/Grand Design AI/
//   node tools/vault-export.mjs --dry-run    # show what would change, write nothing
//   node tools/vault-export.mjs --out D:/v   # a different vault root
//   node tools/vault-export.mjs --force      # also regenerate generated files someone edited
//
// Vault root: --out, else $GD_VAULT, else ~/vault/MandoAI (the owner's open vault).
// Rules:
// - Generated notes live only in "Grand Design AI/Context/" (playtest logs in its Playtests/
//   subfolder), each with frontmatter (source, generated, tags, do_not_edit) and a banner.
// - A rerun overwrites only files this script wrote before AND nobody edited since
//   (.vault_export_manifest.json holds their hashes). An edited generated file is kept with a
//   warning unless --force. Nothing else is ever touched, except a one-time
//   "Grand Design AI/Notes/README.md" that is never overwritten.
// - Every note is scanned for secret-looking text first; any hit aborts and writes nothing.
// The vault syncs peer-to-peer (Syncthing); this script never sends anything anywhere.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_DIR = "Grand Design AI";
const CONTEXT_DIR = "Context";
const NOTES_DIR = "Notes";
const MANIFEST = ".vault_export_manifest.json";
const GENERATOR = "tools/vault-export.mjs";

const read = (rel) => (existsSync(join(REPO, rel)) ? readFileSync(join(REPO, rel), "utf8") : "");
const sha = (text) => createHash("sha256").update(text).digest("hex");

function git(args) {
  try {
    return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

// ---- notes ------------------------------------------------------------------------------------

/** A repo markdown file exported as one note (the repo copy stays the source of truth). */
function docNote(title, rel, tags, blurb) {
  const body = read(rel);
  if (!body) return null;
  return { title, sources: [rel], tags, blurb, body: stripLeadingH1(body) };
}

function stripLeadingH1(text) {
  return text.replace(/^\uFEFF?#\s+[^\n]*\n+/, "");
}

function section(markdown, heading) {
  const start = markdown.indexOf(heading);
  if (start < 0) return "";
  const rest = markdown.slice(start + heading.length);
  const next = rest.search(/\n## /);
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}

function statusNote() {
  const claude = read("CLAUDE.md");
  const status = section(claude, "## Status");
  const log = git(["log", "--oneline", "-15"]);
  return {
    title: "Status and Recent Work",
    sources: ["CLAUDE.md", "git log"],
    tags: ["status"],
    blurb: "Where the project stands: default model, latest measurements, open work, recent commits.",
    body: `## Current status\n\n${status || "(no status section in CLAUDE.md)"}\n\n## Recent commits\n\n${log ? log.split("\n").map((l) => `- \`${l.slice(0, 7)}\` ${l.slice(8)}`).join("\n") : "(git unavailable)"}\n`
  };
}

function howToNote() {
  const claude = read("CLAUDE.md");
  const rules = section(claude, "## Rules");
  const commands = section(claude, "## Commands");
  return {
    title: "How-To Commands",
    sources: ["CLAUDE.md"],
    tags: ["howto"],
    blurb: "Project rules and the commands for tests, scale runs, playtests, board and deploy.",
    body: `## Rules\n\n${rules}\n\n## Commands\n\n${commands}\n\n## Board, playtests, vault\n\n\`\`\`powershell\nnode tools/board.mjs                      # open board items\nnode tools/board.mjs summary\nnode foundry-module/tools/playtest/playtest.mjs status --campaign <name>\nnode tools/vault-export.mjs              # refresh this vault folder\n\`\`\`\n`
  };
}

function boardNote() {
  const path = join(REPO, "docs", "board.json");
  if (!existsSync(path)) return null;
  const items = JSON.parse(readFileSync(path, "utf8")).items ?? [];
  const group = (status) => items.filter((item) => item.status === status);
  const row = (item) => `- **${item.title}** \`${item.id}\`${item.severity ? ` (${item.severity})` : ""}${item.tags?.length ? ` #${item.tags.join(" #")}` : ""}${item.owner ? ` @${item.owner}` : ""}${item.notes?.length ? `\n  - ${item.notes.at(-1)}` : ""}`;
  const block = (label, list) => `## ${label} (${list.length})\n\n${list.length ? list.map(row).join("\n") : "(none)"}\n`;
  return {
    title: "Board Snapshot",
    sources: ["docs/board.json", "tools/board.mjs"],
    tags: ["board", "tasks"],
    blurb: "The shared task board: what is being worked on, queued, blocked and recently done.",
    body: [block("Doing", group("doing")), block("Blocked", group("blocked")), block("To do", group("todo")), block("Done (latest 25)", group("done").sort((a, b) => b.updated - a.updated).slice(0, 25))].join("\n")
  };
}

async function taxonomyNote() {
  try {
    const { TAG_MEANINGS } = await import(new URL("../foundry-module/scripts/ai/prompts.js", import.meta.url));
    const { VICE_TAXONOMY } = await import(new URL("../foundry-module/scripts/vice-taxonomy.js", import.meta.url));
    return {
      title: "Growth and Vice Taxonomy",
      sources: ["foundry-module/scripts/ai/prompts.js", "foundry-module/scripts/vice-taxonomy.js"],
      tags: ["taxonomy", "spec"],
      blurb: "The canonical growth tags the AI may use, and the closed vice list for red (taboo) entries.",
      body: `## Growth tags\n\nEvents and proposals may only use these tags. Anything else becomes an emergent *theme*.\n\n| Tag | Meaning |\n|---|---|\n${Object.entries(TAG_MEANINGS).map(([tag, meaning]) => `| ${tag} | ${meaning} |`).join("\n")}\n\n## Vices (red entries)\n\n| Vice | Meaning |\n|---|---|\n${VICE_TAXONOMY.map(([vice, meaning]) => `| ${vice} | ${meaning} |`).join("\n")}\n`
    };
  } catch (error) {
    return null;
  }
}

function scaleNote() {
  const dir = join(REPO, "foundry-module", "tools", "nlp-scale", "reports");
  if (!existsSync(dir)) return null;
  const reports = readdirSync(dir).filter((f) => f.endsWith(".md")).sort().reverse().slice(0, 12);
  if (!reports.length) return null;
  const rows = reports.map((file) => {
    const text = readFileSync(join(dir, file), "utf8");
    const header = text.split("\n").slice(2, 8).join("\n");
    const overall = text.split("\n").find((l) => l.startsWith("| **overall**")) ?? "";
    return `### ${file.replace(/\.md$/, "")}\n\n${header}\n\n| group | items | score | recall | precision | F1 | outcome | dangerGap | themes | traps | count | fallback | 1st-try valid | tag Jaccard | outcome agree | p50 | p95 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n${overall}\n`;
  });
  return {
    title: "Scale Test Results",
    sources: ["foundry-module/tools/nlp-scale/reports/*.md"],
    tags: ["measurements", "nlp-scale"],
    blurb: "Headline numbers from the latest real-model scale runs (newest first).",
    body: `How to read these: see [[AI Gateway Contract]] and the harness README. Full reports with the worst items live in the repo.\n\n${rows.join("\n")}`
  };
}

function playtestNotes() {
  const root = join(REPO, "foundry-module", "playtests");
  if (!existsSync(root)) return [];
  const notes = [];
  for (const campaign of readdirSync(root)) {
    const cdir = join(root, campaign);
    if (!statSync(cdir).isDirectory()) continue;
    for (const file of walk(cdir).filter((f) => f.endsWith(".md"))) {
      const rel = relative(cdir, file).replace(/\\/g, "/");
      const title = `${campaign} - ${rel.replace(/\.md$/, "").replace(/\//g, " - ")}`;
      notes.push({ title, folder: "Playtests", sources: [relative(REPO, file).replace(/\\/g, "/")], tags: ["playtest", campaign], blurb: "", body: stripLeadingH1(readFileSync(file, "utf8")) });
    }
  }
  return notes;
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

async function buildNotes() {
  const notes = [
    docNote("What is Grand Design AI", "README.md", ["overview"], "The project in one page."),
    statusNote(),
    docNote("Game Design", "GAME_DESIGN.md", ["spec", "design"], "The Grand Design progression rules this module implements."),
    docNote("AI Gateway Contract", "docs/ai-gateway-v2-contract.md", ["spec", "ai-gateway"], "The AI gateway spec and its dated change log: every measured decision."),
    docNote("Foundry Module README", "foundry-module/README.md", ["foundry", "howto"], "Installing and using the Foundry module (PF2e and dnd5e)."),
    docNote("dnd5e Support", "docs/dnd5e-support-summary.md", ["spec", "dnd5e"], "How the module maps Grand Design entries onto D&D 5e."),
    docNote("Conversion Rules", "wandering-inn-pf2e-conversion-rules.md", ["spec", "pf2e"], "Wandering Inn to PF2e conversion rules."),
    docNote("Player Concept Gallery", "player-concept-gallery.md", ["examples"], "Example player concepts."),
    docNote("World Map", "world-map.md", ["world"], "The campaign world map notes."),
    docNote("Playtest Skill", ".claude/skills/grand-design-pm/SKILL.md", ["process", "playtest"], "How project management, the dev team and DM playtests work (the Claude skill)."),
    await taxonomyNote(),
    boardNote(),
    scaleNote(),
    howToNote(),
    ...playtestNotes()
  ].filter(Boolean);
  const index = {
    title: "_Index",
    sources: [GENERATOR],
    tags: ["index"],
    blurb: "",
    body: `The Grand Design AI context pack: a Foundry VTT module (PF2e and dnd5e) that turns session notes into Wandering Inn-style Skills and Classes through a local AI. One topic per note.\n\n${notes.filter((n) => !n.folder).map((n) => `- [[${n.title}]] - ${n.blurb}`).join("\n")}\n\n## Playtests\n\n${notes.filter((n) => n.folder === "Playtests").map((n) => `- [[${n.title}]]`).join("\n") || "(none yet)"}\n\nYour own notes go in \`${PROJECT_DIR}/${NOTES_DIR}/\`.\n`
  };
  return [index, ...notes];
}

// ---- rendering and writing --------------------------------------------------------------------

const yamlStr = (s) => JSON.stringify(String(s));

function render(note, generated) {
  const srcList = note.sources.map((s) => `  - ${yamlStr(s)}`).join("\n");
  const tags = ["grand-design", "grand-design-context", ...note.tags].map((t) => `  - ${t.replace(/[^\w-]/g, "-").toLowerCase()}`).join("\n");
  return `---\ntitle: ${yamlStr(note.title)}\nsource:\n${srcList}\ngenerated: ${generated}\ngenerator: ${GENERATOR}\ntags:\n${tags}\ndo_not_edit: true\n---\n> [!warning] Generated - do not edit here. Edit the source in the GrandDesAI repo (${note.sources.map((s) => `\`${s}\``).join(", ")}) and rerun \`node ${GENERATOR}\`. Your own notes go in \`${PROJECT_DIR}/${NOTES_DIR}/\`.\n\n# ${note.title}\n\n${note.body.trim()}\n`;
}

const SECRET_PATTERNS = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["']?[A-Za-z0-9/+_-]{12,}/i,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./
];

function scanSecrets(rendered) {
  const hits = [];
  const known = [process.env.FOUNDRY_GM_PASSWORD, process.env.OPENAI_API_KEY, process.env.ANTHROPIC_API_KEY].filter((v) => v && v.length >= 6);
  for (const [file, text] of Object.entries(rendered)) {
    for (const pattern of SECRET_PATTERNS) if (pattern.test(text)) hits.push(`${file}: matches ${pattern}`);
    for (const value of known) if (text.includes(value)) hits.push(`${file}: contains the value of a secret env var`);
  }
  return hits;
}

function fileName(title) {
  return `${title.replace(/[\\/:*?"<>|#^[\]]/g, "-").trim()}.md`;
}

function localIso() {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off >= 0 ? "+" : "-"}${pad(off / 60)}:${pad(off % 60)}`;
}

async function main(argv) {
  const flag = (name) => argv.includes(`--${name}`);
  const outIndex = argv.indexOf("--out");
  const vaultRoot = outIndex >= 0 ? argv[outIndex + 1] : process.env.GD_VAULT ?? join(homedir(), "vault", "MandoAI");
  if (!existsSync(vaultRoot)) throw new Error(`vault root not found: ${vaultRoot} (use --out or GD_VAULT)`);
  const projectDir = join(vaultRoot, PROJECT_DIR);
  const ctx = join(projectDir, CONTEXT_DIR);
  const manifestPath = join(ctx, MANIFEST);
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")).files ?? {} : {};

  const generated = localIso();
  const notes = await buildNotes();
  const rendered = {};
  for (const note of notes) rendered[note.folder ? `${note.folder}/${fileName(note.title)}` : fileName(note.title)] = render(note, generated);

  const secrets = scanSecrets(rendered);
  if (secrets.length) {
    console.error(`ABORT: secret-looking text found, nothing written:\n${secrets.map((s) => `  - ${s}`).join("\n")}`);
    process.exit(2);
  }

  const nextManifest = {};
  const actions = [];
  for (const [rel, text] of Object.entries(rendered)) {
    const path = join(ctx, rel);
    // Compare without the timestamp so an unchanged note is not rewritten on every run.
    const stable = (t) => t.replace(/^generated: .*$/m, "");
    if (existsSync(path)) {
      const current = readFileSync(path, "utf8");
      const known = manifest[rel];
      const editedByOwner = known && sha(current) !== known;
      const foreign = !known && !current.includes(`generator: ${GENERATOR}`);
      if ((editedByOwner || foreign) && !flag("force")) {
        actions.push(`keep  ${rel} (${foreign ? "not written by this script" : "edited since last export"}; --force to regenerate)`);
        if (known) nextManifest[rel] = known;
        continue;
      }
      if (stable(current) === stable(text)) {
        actions.push(`same  ${rel}`);
        nextManifest[rel] = sha(current);
        continue;
      }
      actions.push(`write ${rel}`);
    } else {
      actions.push(`new   ${rel}`);
    }
    nextManifest[rel] = sha(text);
    if (!flag("dry-run")) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
  }

  const notesReadme = join(projectDir, NOTES_DIR, "README.md");
  if (!existsSync(notesReadme)) {
    actions.push(`new   ../${NOTES_DIR}/README.md (one time)`);
    if (!flag("dry-run")) {
      mkdirSync(dirname(notesReadme), { recursive: true });
      writeFileSync(notesReadme, `# Grand Design AI Notes\n\nYour own notes about Grand Design AI go here: ideas, decisions, playtest reactions, anything.\n\n- \`tools/vault-export.mjs\` never writes, overwrites or deletes anything in this folder (it only created this README once).\n- The generated reference notes live in \`${CONTEXT_DIR}/\` (start at [[_Index]]). Don't edit those; they are overwritten on every export. Link to them with [[wikilinks]] instead.\n`);
    }
  }
  if (!flag("dry-run")) writeFileSync(manifestPath, `${JSON.stringify({ generator: GENERATOR, generated, files: nextManifest }, null, 2)}\n`);
  console.log(`${flag("dry-run") ? "[dry run] " : ""}${projectDir}`);
  for (const action of actions) console.log(`  ${action}`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
