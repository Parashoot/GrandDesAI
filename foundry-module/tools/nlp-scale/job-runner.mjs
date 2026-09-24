#!/usr/bin/env node
// A tiny, deliberately narrow job queue for the nlp-scale harness.
//
// Why this exists: the scale/consistency runs need a real local model (Ollama on this machine),
// but the agent that analyzes the results and iterates on the gateway works from a sandbox that
// can read/write this repo and cannot reach Ollama. Start this runner once in a terminal and the
// agent can queue runs by dropping JSON job files into tools/nlp-scale/queue/ -- results land in
// tools/nlp-scale/reports/ where it can read them.
//
// Safety: a job can ONLY run tools/nlp-scale/run.mjs, with arguments from an allowlist of flags.
// It never runs arbitrary commands. Stop it any time with Ctrl+C.
//
//   node tools/nlp-scale/job-runner.mjs
//
// Job file (queue/<name>.json): { "args": { "model": "qwen3:30b-a3b", "reps": 3, "filter": "traps" } }

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, existsSync, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const moduleRoot = join(here, "..", "..");
const queueDir = join(here, "queue");
const doneDir = join(queueDir, "done");
const reportsDir = join(here, "reports");
for (const dir of [queueDir, doneDir, reportsDir]) mkdirSync(dir, { recursive: true });

const ALLOWED_FLAGS = new Set([
  "provider", "endpoint", "model", "reps", "concurrency", "filter", "lang", "ids", "limit", "offset",
  "system", "pipeline", "proposalMode", "temperature", "numCtx", "numPredict", "timeoutMs", "chunkChars",
  "config", "out", "sim", "faultRate", "seed", "quiet", "tag"
]);
const kebab = (key) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const SAFE_VALUE = /^[\w.:,\-\/\\ ]{0,4000}$/;

function buildArgs(args = {}) {
  const out = [join(here, "run.mjs")];
  for (const [key, value] of Object.entries(args)) {
    if (!ALLOWED_FLAGS.has(key)) throw new Error(`flag not allowed: ${key}`);
    if (key === "tag") continue; // label only
    if (value === true) { out.push(`--${kebab(key)}`); continue; }
    if (value === false || value === null || value === undefined) continue;
    const text = String(value);
    if (!SAFE_VALUE.test(text)) throw new Error(`unsafe value for ${key}`);
    out.push(`--${kebab(key)}`, text);
  }
  if (!("out" in args)) out.push("--out", reportsDir);
  return out;
}

function runJob(name, job) {
  return new Promise((resolve) => {
    let argv;
    try { argv = buildArgs(job.args); } catch (error) { resolve({ code: -1, error: error.message }); return; }
    const logPath = join(reportsDir, `${name.replace(/\.json$/, "")}.log`);
    const log = createWriteStream(logPath);
    console.log(`[job-runner] ${new Date().toISOString()} START ${name}: node ${argv.slice(1).join(" ")}`);
    const child = spawn(process.execPath, argv, { cwd: moduleRoot });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.stdout.on("data", (d) => process.stdout.write(d));
    child.on("close", (code) => { log.end(); resolve({ code, logPath }); });
  });
}

console.log(`[job-runner] watching ${queueDir} (Ctrl+C to stop)`);
writeFileSync(join(queueDir, "runner.alive"), new Date().toISOString());
for (;;) {
  writeFileSync(join(queueDir, "runner.alive"), new Date().toISOString());
  if (existsSync(join(queueDir, "STOP"))) { console.log("[job-runner] STOP file found, exiting"); break; }
  const jobs = readdirSync(queueDir).filter((f) => f.endsWith(".json")).sort();
  if (!jobs.length) { await new Promise((r) => setTimeout(r, 5000)); continue; }
  const name = jobs[0];
  let job;
  try { job = JSON.parse(readFileSync(join(queueDir, name), "utf8")); } catch (error) { job = { args: {}, parseError: error.message }; }
  renameSync(join(queueDir, name), join(doneDir, name));
  const result = job.parseError ? { code: -1, error: job.parseError } : await runJob(name, job);
  writeFileSync(join(doneDir, name.replace(/\.json$/, ".result.json")), JSON.stringify({ ...result, finishedAt: new Date().toISOString() }, null, 2));
  console.log(`[job-runner] DONE ${name} -> exit ${result.code}${result.error ? ` (${result.error})` : ""}`);
}
