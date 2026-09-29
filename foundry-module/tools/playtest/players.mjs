#!/usr/bin/env node
// Player agents on the LOCAL model: each PC is a persona prompt plus its own chat history, answered
// by Ollama. Why: Claude sub-agents cost ~30k tokens of harness per turn, and small ones refused
// to role-play as "not a coding task" (ember-road s3). A local model costs nothing, and a different
// family from the module's (mistral vs qwen) keeps the players from sharing the reader's blind spots.
//
//   node tools/playtest/players.mjs --campaign ember-road --session 3 --scene scene.txt [--to Wick,Luz]
//        [--model mistral-small3.2:24b] [--each file.json]   (--each: {"Wick":"extra text for Wick only"})
//
// Personas: playtests/<campaign>/players.json  { "Brakka": "system prompt ...", ... }
// History:  playtests/<campaign>/sessions/NN/players-log.json (one chat per PC, appended every turn)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const flags = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i].replace(/^--/, "");
  flags[key] = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[(i += 1)] : true;
}
const dir = join(HERE, "..", "..", "playtests", String(flags.campaign));
const personas = JSON.parse(readFileSync(join(dir, "players.json"), "utf8"));
const logPath = join(dir, "sessions", String(flags.session).padStart(2, "0"), "players-log.json");
const log = existsSync(logPath) ? JSON.parse(readFileSync(logPath, "utf8")) : {};
const scene = readFileSync(String(flags.scene), "utf8").trim();
const each = flags.each ? JSON.parse(readFileSync(String(flags.each), "utf8")) : {};
const who = flags.to ? String(flags.to).split(",").map((s) => s.trim()) : Object.keys(personas);
const model = flags.model ?? "mistral-small3.2:24b";

const RULES = "\n\nReply ONLY with what your character does or says this turn: 1-3 sentences in character, then the dice you want rolled in brackets, e.g. [Athletics]. Never narrate outcomes; the DM decides them. Surprise the DM: use the world and try things the rules never anticipated.";

for (const name of who) {
  const history = (log[name] ??= []);
  history.push({ role: "user", content: [scene, each[name]].filter(Boolean).join("\n\n") });
  const response = await fetch("http://127.0.0.1:11434/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: false, options: { temperature: 0.9, num_predict: 200 }, messages: [{ role: "system", content: personas[name] + RULES }, ...history.slice(-12)] })
  });
  const reply = (await response.json()).message?.content?.trim() ?? "(no reply)";
  history.push({ role: "assistant", content: reply });
  console.log(`**${name}:** ${reply.replace(/\s+/g, " ")}`);
}
writeFileSync(logPath, `${JSON.stringify(log, null, 1)}\n`);
