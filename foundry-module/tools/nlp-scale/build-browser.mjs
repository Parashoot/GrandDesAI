#!/usr/bin/env node
// Bundles tools/nlp-scale/browser-entry.mjs (+ scripts/ai/*, lib.mjs, sim-model.js and everything
// they import) and the labeled corpus into ONE self-contained IIFE:
//
//   tools/nlp-scale/dist/nlp-scale.browser.js   ->  window.NlpScale = { runScale, startScale, brief, ... }
//
// Why a hand-rolled bundler instead of esbuild: the harness has to be buildable on a machine with no
// npm registry access (the sandbox this was written in has none), and the module graph is small,
// relative-import-only ESM that we control. This does exactly what is needed and nothing more:
// resolves relative `import ... from "./x.js"` / `export ... from` statements, wraps each module in a
// function scope with live-binding getters for its exports, executes them in dependency order, and
// inlines the corpus JSON. It refuses (loudly) anything it does not understand -- bare specifiers,
// dynamic import() -- rather than emitting a bundle that breaks at runtime.
//
//   node tools/nlp-scale/build-browser.mjs [--out path] [--check]
//     --check  also executes the bundle under Node with a fake window + the simulated model.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const ENTRY = join(HERE, "browser-entry.mjs");

const IDENT = "[A-Za-z_$][\\w$]*";
// Statements are matched only at the start of a line (after optional indentation): every module in
// this graph follows that style, and it keeps us from matching the word "import" inside strings.
const IMPORT_FROM = /^[ \t]*import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];?[ \t]*$/gm;
const IMPORT_BARE = /^[ \t]*import\s+["']([^"']+)["'];?[ \t]*$/gm;
const EXPORT_FROM = /^[ \t]*export\s+(\*|\{[\s\S]*?\})\s+from\s+["']([^"']+)["'];?[ \t]*$/gm;
const EXPORT_LIST = /^[ \t]*export\s+\{([\s\S]*?)\};?[ \t]*$/gm;
const EXPORT_DECL = new RegExp(`^([ \\t]*)export\\s+(async\\s+function\\*?|function\\*?|class|const|let|var)\\s+(${IDENT})`, "gm");
const EXPORT_DEFAULT = /^[ \t]*export\s+default\s+/gm;

function parseSpecifiers(list) {
  return list
    .replace(/^\{|\}$/g, "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [imported, local] = part.split(/\s+as\s+/).map((s) => s.trim());
      return { imported, local: local ?? imported };
    });
}

function transformModule(source, file, resolveDep) {
  const deps = [];
  const exportsList = []; // { name, expr }
  const header = [];
  let code = source;
  let counter = 0;

  if (/(^|[^\w$.])import\s*\(/.test(code.replace(/\/\/.*$/gm, "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""'))) {
    throw new Error(`${relative(ROOT, file)}: dynamic import() is not supported by the mini bundler.`);
  }

  code = code.replace(EXPORT_FROM, (_, what, spec) => {
    const id = resolveDep(spec);
    deps.push(id);
    const tmp = `__reexp${counter++}`;
    header.push(`const ${tmp} = __require(${JSON.stringify(id)});`);
    if (what === "*") exportsList.push({ star: tmp });
    else for (const { imported, local } of parseSpecifiers(what)) exportsList.push({ name: local, expr: `${tmp}[${JSON.stringify(imported)}]` });
    return "";
  });

  code = code.replace(IMPORT_FROM, (_, clause, spec) => {
    const id = resolveDep(spec);
    deps.push(id);
    const tmp = `__imp${counter++}`;
    const lines = [`const ${tmp} = __require(${JSON.stringify(id)});`];
    let rest = clause.trim();
    const ns = new RegExp(`^\\*\\s+as\\s+(${IDENT})$`).exec(rest);
    if (ns) return `const ${ns[1]} = __require(${JSON.stringify(id)});`;
    const def = new RegExp(`^(${IDENT})\\s*(?:,\\s*([\\s\\S]*))?$`).exec(rest);
    if (def && !rest.startsWith("{")) {
      lines.push(`const ${def[1]} = ${tmp}.default;`);
      rest = def[2]?.trim() ?? "";
    }
    if (rest.startsWith("{")) {
      // Live bindings would need getters at every use site; destructuring at module start is safe
      // here because modules run in dependency order and nothing in this graph reassigns an export.
      const names = parseSpecifiers(rest).map(({ imported, local }) => (imported === local ? imported : `${imported}: ${local}`));
      lines.push(`const { ${names.join(", ")} } = ${tmp};`);
    } else if (rest) {
      throw new Error(`${relative(ROOT, file)}: unsupported import clause "${clause}"`);
    }
    return lines.join(" ");
  });

  code = code.replace(IMPORT_BARE, (_, spec) => {
    const id = resolveDep(spec);
    deps.push(id);
    return `__require(${JSON.stringify(id)});`;
  });

  code = code.replace(EXPORT_LIST, (_, list) => {
    for (const { imported, local } of parseSpecifiers(list)) exportsList.push({ name: local, expr: imported });
    return "";
  });

  code = code.replace(EXPORT_DECL, (_, indent, kind, name) => {
    exportsList.push({ name, expr: name });
    return `${indent}${kind} ${name}`;
  });

  if (EXPORT_DEFAULT.test(code)) {
    code = code.replace(EXPORT_DEFAULT, "const __default = ");
    exportsList.push({ name: "default", expr: "__default" });
  }

  if (/^[ \t]*(import|export)\s/m.test(code)) {
    const line = code.split("\n").find((l) => /^[ \t]*(import|export)\s/.test(l));
    throw new Error(`${relative(ROOT, file)}: could not transform statement: ${line.trim()}`);
  }

  const exportLines = exportsList.map((entry) =>
    entry.star
      ? `for (const __k of Object.keys(${entry.star})) if (__k !== "default" && !(__k in __exports)) Object.defineProperty(__exports, __k, { enumerable: true, get: () => ${entry.star}[__k] });`
      : `Object.defineProperty(__exports, ${JSON.stringify(entry.name)}, { enumerable: true, get: () => ${entry.expr} });`
  );
  // Export getters go FIRST so a (hypothetical) circular importer sees the bindings; hoisted
  // function declarations resolve immediately, const/class bindings once the body has run.
  const body = [...header, ...exportLines, code].join("\n");
  return { deps: [...new Set(deps)], body };
}

export function bundle({ entry = ENTRY, corpusDir = join(HERE, "corpus") } = {}) {
  const modules = new Map();
  const order = [];
  const visiting = new Set();

  const visit = (file) => {
    if (modules.has(file)) return;
    if (visiting.has(file)) throw new Error(`Circular import involving ${relative(ROOT, file)} is not supported.`);
    visiting.add(file);
    const source = readFileSync(file, "utf8");
    const resolveDep = (spec) => {
      if (!spec.startsWith(".")) throw new Error(`${relative(ROOT, file)}: bare import "${spec}" is not supported.`);
      return resolve(dirname(file), spec);
    };
    const result = transformModule(source, file, resolveDep);
    for (const dep of result.deps) visit(dep);
    visiting.delete(file);
    modules.set(file, result);
    order.push(file);
  };
  visit(entry);

  const corpusFiles = readdirSync(corpusDir).filter((name) => name.endsWith(".json")).sort();
  const corpus = corpusFiles.flatMap((name) => JSON.parse(readFileSync(join(corpusDir, name), "utf8")));
  const idOf = (file) => relative(ROOT, file).replace(/\\/g, "/");

  const parts = [];
  parts.push(`/* nlp-scale.browser.js -- generated by tools/nlp-scale/build-browser.mjs on ${new Date().toISOString()}. Do not edit. */`);
  parts.push(`/* modules: ${order.map(idOf).join(", ")} ; corpus items: ${corpus.length} */`);
  parts.push("(function () {");
  parts.push("\"use strict\";");
  parts.push("const __defs = Object.create(null);");
  parts.push("const __cache = Object.create(null);");
  parts.push("function __require(id) {");
  parts.push("  if (__cache[id]) return __cache[id];");
  parts.push("  const def = __defs[id];");
  parts.push("  if (!def) throw new Error('nlp-scale bundle: missing module ' + id);");
  parts.push("  const __exports = Object.create(null);");
  parts.push("  __cache[id] = __exports;");
  parts.push("  def(__exports);");
  parts.push("  return __exports;");
  parts.push("}");
  for (const file of order) {
    const { body } = modules.get(file);
    // Module ids are root-relative paths; rewrite the absolute ids in __require calls to match.
    const rewritten = body.replace(/__require\(("(?:[^"\\]|\\.)*")\)/g, (_, quoted) => `__require(${JSON.stringify(idOf(JSON.parse(quoted)))})`);
    parts.push(`// ---- ${idOf(file)} ----`);
    parts.push(`__defs[${JSON.stringify(idOf(file))}] = function (__exports) {\n${rewritten}\n};`);
  }
  parts.push(`const __CORPUS = ${JSON.stringify(corpus)};`);
  parts.push(`const __entry = __require(${JSON.stringify(idOf(entry))});`);
  parts.push("const __target = typeof window !== 'undefined' ? window : globalThis;");
  parts.push("__entry.installNlpScale(__target, __CORPUS);");
  parts.push("})();");
  return { code: parts.join("\n") + "\n", modules: order.map(idOf), corpusItems: corpus.length };
}

async function selfCheck(outFile) {
  // Execute the bundle the way a browser would: one script, a window global, a same-origin fetch.
  const { createSimModel } = await import("./sim-model.js");
  const corpus = readdirSync(join(HERE, "corpus")).filter((n) => n.endsWith(".json")).flatMap((n) => JSON.parse(readFileSync(join(HERE, "corpus", n), "utf8")));
  const sim = createSimModel({ corpus, seed: 1, faultRate: 0.2 });
  const seenUrls = [];
  const fakeWindow = {
    location: { origin: "http://localhost:11434" },
    fetch: (url, init) => {
      seenUrls.push(String(url));
      // Resolve the relative URL the way a browser on the Ollama origin would.
      return sim.fetch(new URL(String(url), "http://localhost:11434").href, init);
    }
  };
  const code = readFileSync(outFile, "utf8");
  new Function("window", code)(fakeWindow);
  const api = fakeWindow.NlpScale;
  if (!api || typeof api.runScale !== "function") throw new Error("bundle did not install window.NlpScale");
  const state = await api.runScale({ model: "sim", limit: 25, reps: 2, timeoutMs: 50 });
  if (state.status !== "done" || state.done !== 25) throw new Error(`self-check run incomplete: ${state.status} ${state.done}`);
  if (!seenUrls.length || !seenUrls.every((url) => url === "/api/chat")) throw new Error(`expected relative /api/chat requests, saw ${[...new Set(seenUrls)].join(", ")}`);
  const brief = api.brief();
  const md = api.renderMarkdown(api.lastRun);
  if (!md.includes("## By category")) throw new Error("markdown report missing sections");
  return { brief, requests: seenUrls.length };
}

async function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outFile = resolve(outIndex >= 0 ? args[outIndex + 1] : join(HERE, "dist", "nlp-scale.browser.js"));
  const { code, modules, corpusItems } = bundle();
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, code);
  console.log(`Wrote ${relative(process.cwd(), outFile)} (${(code.length / 1024).toFixed(0)} KiB, ${modules.length} modules, ${corpusItems} corpus items)`);
  if (args.includes("--check")) {
    const { brief, requests } = await selfCheck(outFile);
    console.log(`Self-check OK: ${requests} same-origin requests; ${JSON.stringify(brief.overall)}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}

export { selfCheck };
