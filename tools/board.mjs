#!/usr/bin/env node
// Project board CLI for Grand Design AI -- the one shared task list for the owner, every Claude
// Code session and every sub-agent (dev team members, playtest DM/players). Same verbs as
// MandoAI's scripts/board.py so the habit carries over. Plain JSON file, no server, no deps.
//
//   node tools/board.mjs                         open items (todo + doing + blocked)
//   node tools/board.mjs list [--status done|todo|doing|blocked|open|all] [--tag x]
//   node tools/board.mjs add "Title" --tag playtest --tag ux [--source playtest-3] [--severity high]
//   node tools/board.mjs doing <id|title-fragment> [--owner dev-gateway]
//   node tools/board.mjs done  <id|title-fragment>
//   node tools/board.mjs block <id|title-fragment>
//   node tools/board.mjs todo  <id|title-fragment>        (back to the queue)
//   node tools/board.mjs note  <id|title-fragment> "what happened / where I stopped"
//   node tools/board.mjs show  <id|title-fragment>
//   node tools/board.mjs summary
//   add --json to any command for machine-readable output.
//
// Why a file and not an API: sub-agents run in worktrees and plain shells; a JSON file in the repo
// is the one thing all of them can read, diff and commit.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATUSES = ["todo", "doing", "blocked", "done"];
const SEVERITIES = ["low", "medium", "high", "critical"];

export function defaultBoardPath() {
  return process.env.GD_BOARD ?? join(ROOT, "docs", "board.json");
}

export function loadBoard(path = defaultBoardPath()) {
  if (!existsSync(path)) return { version: 1, items: [] };
  const data = JSON.parse(readFileSync(path, "utf8"));
  return { version: 1, items: Array.isArray(data.items) ? data.items : [] };
}

export function saveBoard(board, path = defaultBoardPath()) {
  mkdirSync(dirname(path), { recursive: true });
  // Write-then-rename so a crashed agent never leaves half a board behind.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(board, null, 1)}\n`);
  renameSync(tmp, path);
}

export function findItem(board, ref) {
  const needle = String(ref ?? "").trim().toLowerCase();
  if (!needle) return { error: "empty reference" };
  const byId = board.items.filter((item) => item.id === needle || item.id.startsWith(needle));
  if (byId.length === 1) return { item: byId[0] };
  const byTitle = board.items.filter((item) => item.title.toLowerCase().includes(needle));
  if (byTitle.length === 1) return { item: byTitle[0] };
  const open = byTitle.filter((item) => item.status !== "done");
  if (open.length === 1) return { item: open[0] };
  return { error: byTitle.length ? `${byTitle.length} items match "${ref}"` : `no item matches "${ref}"` };
}

export function addItem(board, title, { tags = [], source = "cli", severity = "", owner = "" } = {}) {
  const now = Date.now() / 1000;
  const item = {
    id: randomBytes(4).toString("hex"),
    title: String(title).trim(),
    status: "todo",
    notes: [],
    tags: [...new Set(tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))],
    ...(SEVERITIES.includes(severity) ? { severity } : {}),
    owner,
    source,
    created: now,
    updated: now
  };
  board.items.push(item);
  return item;
}

export function setStatus(item, status, { owner } = {}) {
  if (!STATUSES.includes(status)) throw new Error(`unknown status ${status}`);
  item.status = status;
  if (owner !== undefined) item.owner = owner;
  item.updated = Date.now() / 1000;
}

export function addNote(item, text) {
  item.notes.push(String(text).trim());
  item.updated = Date.now() / 1000;
}

function selectItems(board, { status = "open", tag = "" } = {}) {
  return board.items.filter((item) => {
    if (status === "open" && item.status === "done") return false;
    if (status !== "open" && status !== "all" && item.status !== status) return false;
    if (tag && !item.tags.includes(tag.toLowerCase())) return false;
    return true;
  });
}

function line(item) {
  const tags = item.tags.length ? ` [${item.tags.join(", ")}]` : "";
  const sev = item.severity ? ` {${item.severity}}` : "";
  const owner = item.owner ? ` @${item.owner}` : "";
  const note = item.notes.length ? `  -- ${item.notes.at(-1)}` : "";
  return `(${item.status.padEnd(7)}) ${item.id}  ${item.title}${sev}${tags}${owner}${note}`;
}

function summary(board) {
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  const tags = {};
  for (const item of board.items) {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
    if (item.status !== "done") for (const tag of item.tags) tags[tag] = (tags[tag] ?? 0) + 1;
  }
  return { counts, openByTag: tags, doing: board.items.filter((item) => item.status === "doing").map((item) => ({ id: item.id, title: item.title, owner: item.owner })) };
}

function parseArgs(argv) {
  const positional = [];
  const flags = { tag: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") flags.json = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      i += 1;
      if (key === "tag") flags.tag.push(value);
      else flags[key] = value;
    } else positional.push(arg);
  }
  return { positional, flags };
}

function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const [cmd = "list", ...rest] = positional;
  const path = flags.file ?? defaultBoardPath();
  const board = loadBoard(path);
  const out = (value, text) => console.log(flags.json ? JSON.stringify(value, null, 1) : text);
  const need = (ref) => {
    const found = findItem(board, ref);
    if (found.error) {
      console.error(found.error);
      process.exit(1);
    }
    return found.item;
  };

  switch (cmd) {
    case "list": {
      const items = selectItems(board, { status: flags.status ?? "open", tag: flags.tag[0] ?? "" });
      out(items, items.length ? items.map(line).join("\n") : "(none)");
      return;
    }
    case "add": {
      if (!rest[0]) throw new Error('usage: add "Title" [--tag x] [--severity high] [--source s]');
      const item = addItem(board, rest[0], { tags: flags.tag, source: flags.source ?? "cli", severity: flags.severity ?? "", owner: flags.owner ?? "" });
      saveBoard(board, path);
      out(item, line(item));
      return;
    }
    case "doing":
    case "done":
    case "block":
    case "todo": {
      const item = need(rest[0]);
      setStatus(item, cmd === "block" ? "blocked" : cmd, { owner: flags.owner });
      saveBoard(board, path);
      out(item, line(item));
      return;
    }
    case "note": {
      const item = need(rest[0]);
      if (!rest[1]) throw new Error('usage: note <ref> "text"');
      addNote(item, rest[1]);
      saveBoard(board, path);
      out(item, line(item));
      return;
    }
    case "show": {
      const item = need(rest[0]);
      out(item, [line(item), ...item.notes.map((note, i) => `  ${i + 1}. ${note}`)].join("\n"));
      return;
    }
    case "summary": {
      const s = summary(board);
      const text = [
        `todo ${s.counts.todo}  doing ${s.counts.doing}  blocked ${s.counts.blocked}  done ${s.counts.done}`,
        `open by tag: ${Object.entries(s.openByTag).sort((a, b) => b[1] - a[1]).map(([tag, n]) => `${tag} ${n}`).join(", ") || "(none)"}`,
        ...s.doing.map((item) => `doing: ${item.id} ${item.title}${item.owner ? ` @${item.owner}` : ""}`)
      ].join("\n");
      out(s, text);
      return;
    }
    default:
      console.error(`unknown command ${cmd}`);
      process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
