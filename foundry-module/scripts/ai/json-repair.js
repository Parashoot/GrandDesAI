// Lenient JSON recovery for LLM output.
//
// Why a hand-written parser instead of a pile of regex fixups: every real failure we have seen from
// local models is a *combination* of problems -- a ```json fence around output that was also cut off
// mid-string by num_predict, or a reply with a sentence of prose before it that also uses Python
// `True`. Regex passes applied one after another interfere with each other (a "fix single quotes"
// pass happily rewrites the apostrophe in "Kesh's lockpick"), whereas a tokenizer that understands
// where it is -- inside a string, between members, at end-of-input -- can apply each repair exactly
// where it is needed and nowhere else. The old gateway did `JSON.parse(content)` and on any failure
// threw "malformed JSON", which sent the GM straight to the keyword fallback; salvaging here is the
// first line of defence for "almost never fall back".
//
// Pure ESM, no Foundry globals: runs in Node tests, the Foundry browser, and the scale harness.

export class ModelJsonError extends Error {
  constructor(message, raw) {
    super(message);
    this.name = "ModelJsonError";
    this.raw = raw;
  }
}

/**
 * Parse whatever a model returned into a JSON value.
 * @param {string|object} text
 * @returns {{ value: any, repairs: string[] }}
 * @throws {ModelJsonError} only when nothing JSON-like exists in the text at all.
 */
export function parseModelJson(text) {
  // Some transports (or tests) hand us an already-parsed object; that is not an error.
  if (text !== null && typeof text === "object") return { value: text, repairs: ["already-parsed"] };
  if (typeof text !== "string") throw new ModelJsonError("Model output was not text.", text);

  const repairs = [];
  let source = text.replace(/^﻿/, "");

  // Reasoning models (qwen3, deepseek-r1) put their chain of thought in <think> blocks even when
  // asked not to, and sometimes the think block itself contains braces that look like JSON.
  if (/<think>/i.test(source)) {
    const stripped = source.replace(/<think>[\s\S]*?<\/think>/gi, "");
    // An unterminated <think> (truncated while still "thinking") leaves nothing usable after it,
    // but anything BEFORE it is still fair game.
    source = stripped.replace(/<think>[\s\S]*$/i, "");
    repairs.push("stripped-think-block");
  }

  const trimmed = source.trim();
  if (!trimmed) throw new ModelJsonError("Model output was empty.", text);

  // Fast path: most schema-constrained replies are already valid JSON.
  try {
    const value = JSON.parse(trimmed);
    return finish(value, repairs, text);
  } catch {
    // fall through to the lenient path
  }

  // Prefer the content of a markdown fence when one exists: prose around fences often contains
  // braces of its own ("the {events} array below"). The closing fence may be missing if the reply
  // was truncated, so an unterminated fence runs to end of input.
  const fence = /```[ \t]*(?:json5?|javascript|js|JSON)?[ \t]*\r?\n?([\s\S]*?)(?:```|$)/.exec(trimmed);
  let body = trimmed;
  if (fence && fence[1].trim() && /[[{]/.test(fence[1])) {
    body = fence[1].trim();
    repairs.push("stripped-code-fence");
    try {
      return finish(JSON.parse(body), repairs, text);
    } catch {
      // continue leniently on the fenced body
    }
  }

  const candidates = candidateStarts(body);
  if (!candidates.length) {
    throw new ModelJsonError("Model output contained no JSON object or array.", text);
  }

  // Try each plausible start position in order. The first candidate that parses wins (anything
  // after it is merged or stripped below); a junk candidate in leading prose ("Sure! {here it is}:")
  // throws and is skipped. Candidates nested inside an accepted parse are ignored, and an empty
  // first object only loses to a later non-empty one.
  let best = null;
  for (const start of candidates.slice(0, 24)) {
    if (best && start < best.end) continue;
    const parser = new LenientParser(body, start);
    let result;
    try {
      result = parser.parseTop();
    } catch {
      continue;
    }
    if (!result || typeof result.value !== "object" || result.value === null) continue;
    const empty = Object.keys(result.value).length === 0;
    if (!best) {
      best = { ...result, start, empty };
      if (!empty) break;
    } else if (!empty) {
      best = { ...result, start, empty };
      break;
    }
  }
  if (!best) throw new ModelJsonError("Model output contained no parseable JSON.", text);

  if (best.start > 0 && body.slice(0, best.start).trim()) repairs.push("stripped-leading-prose");
  const rest = body.slice(best.end).trim();
  let value = best.value;
  if (rest) {
    // Some models emit the events object and then a second object for proposals. Merge the second
    // object's keys in rather than silently dropping half the answer.
    const merged = mergeTrailingObject(value, rest);
    if (merged) {
      value = merged;
      repairs.push("merged-multiple-objects");
    } else {
      repairs.push("stripped-trailing-prose");
    }
  }
  for (const repair of best.repairs) if (!repairs.includes(repair)) repairs.push(repair);
  return finish(value, repairs, text);
}

function finish(value, repairs, raw) {
  // Double-encoded JSON: the whole object came back as a JSON string literal.
  if (typeof value === "string") {
    const inner = value.trim();
    if (/^[[{]/.test(inner)) {
      const nested = parseModelJson(inner);
      return { value: nested.value, repairs: [...repairs, "decoded-double-encoded-json", ...nested.repairs] };
    }
    throw new ModelJsonError("Model output was a plain string, not a JSON object.", raw);
  }
  if (value === null || typeof value !== "object") {
    throw new ModelJsonError("Model output was a bare JSON scalar, not an object or array.", raw);
  }
  return { value, repairs };
}

function candidateStarts(body) {
  const starts = [];
  let inString = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '"' && body[i - 1] !== "\\") inString = !inString;
    if (!inString && (ch === "{" || ch === "[")) starts.push(i);
  }
  // Also include every raw brace position in case the quote tracking above was confused by prose
  // apostrophes/quotes -- dedupe and keep order.
  for (let i = 0; i < body.length; i += 1) if (body[i] === "{" || body[i] === "[") starts.push(i);
  return [...new Set(starts)].sort((a, b) => a - b);
}

function mergeTrailingObject(value, rest) {
  if (Array.isArray(value) || !/^[{[]/.test(rest)) return null;
  try {
    const parser = new LenientParser(rest, 0);
    const next = parser.parseTop();
    if (!next || typeof next.value !== "object" || next.value === null || Array.isArray(next.value)) return null;
    const merged = { ...value };
    for (const [key, v] of Object.entries(next.value)) if (!(key in merged)) merged[key] = v;
    return merged;
  } catch {
    return null;
  }
}

// Sentinel meaning "input ended before this value was complete".
const INCOMPLETE = Symbol("incomplete");

const OPEN_QUOTES = new Map([
  ['"', ['"']],
  ["'", ["'"]],
  ["“", ["”", "“", '"']], // “ ”
  ["”", ["”", "“", '"']],
  ["‘", ["’", "‘", "'"]], // ‘ ’
  ["’", ["’", "‘", "'"]],
  ["«", ["»"]], // « »
  ["`", ["`"]]
]);

const BAREWORD_LITERALS = new Map([
  ["true", true], ["True", true], ["TRUE", true],
  ["false", false], ["False", false], ["FALSE", false],
  ["null", null], ["None", null], ["NULL", null], ["Null", null], ["nil", null],
  ["undefined", null], ["NaN", null], ["Infinity", null], ["-Infinity", null]
]);

class LenientParser {
  constructor(text, start) {
    this.text = text;
    this.pos = start;
    this.repairs = new Set();
  }

  parseTop() {
    const result = this.parseValue();
    if (result === INCOMPLETE) throw new Error("nothing parsed");
    return { value: result.value, end: this.pos, repairs: [...this.repairs] };
  }

  // Returns { value, complete } or INCOMPLETE (nothing usable at all before EOF).
  parseValue() {
    this.skipWs();
    if (this.eof()) return INCOMPLETE;
    const ch = this.text[this.pos];
    if (ch === "{") return this.parseObject();
    if (ch === "[") return this.parseArray();
    if (OPEN_QUOTES.has(ch)) return this.parseString();
    if (/[-+0-9.]/.test(ch)) {
      const number = this.parseNumber();
      if (number) return number;
    }
    return this.parseBareword();
  }

  parseObject() {
    this.pos += 1; // {
    const out = {};
    for (;;) {
      this.skipWs();
      if (this.eof()) return this.truncated(out);
      let ch = this.text[this.pos];
      if (ch === "}") { this.pos += 1; return { value: out, complete: true }; }
      if (ch === "]") { this.pos += 1; this.repairs.add("fixed-mismatched-bracket"); return { value: out, complete: true }; }
      if (ch === ",") { this.pos += 1; this.repairs.add("removed-extra-comma"); continue; }
      const keyStart = this.pos;
      const key = this.parseKey();
      if (key === INCOMPLETE) return this.truncated(out);
      if (key === null) throw new Error(`bad key at ${keyStart}`);
      this.skipWs();
      if (this.eof()) return this.truncated(out);
      ch = this.text[this.pos];
      if (ch === ":" || ch === "=") {
        if (ch === "=") this.repairs.add("fixed-key-separator");
        this.pos += 1;
      } else {
        throw new Error(`expected ':' at ${this.pos}`);
      }
      const value = this.parseValue();
      if (value === INCOMPLETE) return this.truncated(out);
      if (!value.complete) {
        // The dangling partial element: a scalar cut off mid-way is dropped (a half summary is worse
        // than none); a container cut off mid-way keeps its complete children (an events array with
        // four finished events and a fifth cut off still yields four).
        if (value.value !== null && typeof value.value === "object") out[key] = value.value;
        return this.truncated(out);
      }
      out[key] = value.value;
      this.skipWs();
      if (this.eof()) return this.truncated(out);
      ch = this.text[this.pos];
      if (ch === ",") {
        this.pos += 1;
        this.skipWs();
        if (this.text[this.pos] === "}" || this.text[this.pos] === "]") this.repairs.add("removed-trailing-comma");
      } else if (ch === "}") {
        // loop closes
      } else if (ch === "]") {
        // mismatched close handled at loop top
      } else {
        this.repairs.add("inserted-missing-comma");
      }
    }
  }

  parseArray() {
    this.pos += 1; // [
    const out = [];
    for (;;) {
      this.skipWs();
      if (this.eof()) return this.truncated(out);
      let ch = this.text[this.pos];
      if (ch === "]") { this.pos += 1; return { value: out, complete: true }; }
      if (ch === "}") { this.pos += 1; this.repairs.add("fixed-mismatched-bracket"); return { value: out, complete: true }; }
      if (ch === ",") { this.pos += 1; this.repairs.add("removed-extra-comma"); continue; }
      const value = this.parseValue();
      if (value === INCOMPLETE) return this.truncated(out);
      if (!value.complete) {
        // Any element of an array that was cut off is the dangling partial element: drop it whole.
        this.repairs.add("dropped-truncated-element");
        return this.truncated(out);
      }
      out.push(value.value);
      this.skipWs();
      if (this.eof()) return this.truncated(out);
      ch = this.text[this.pos];
      if (ch === ",") {
        this.pos += 1;
        this.skipWs();
        if (this.text[this.pos] === "]" || this.text[this.pos] === "}") this.repairs.add("removed-trailing-comma");
      } else if (ch !== "]" && ch !== "}") {
        this.repairs.add("inserted-missing-comma");
      }
    }
  }

  truncated(value) {
    this.repairs.add("closed-truncated-json");
    return { value, complete: false };
  }

  parseKey() {
    this.skipWs();
    if (this.eof()) return INCOMPLETE;
    const ch = this.text[this.pos];
    if (OPEN_QUOTES.has(ch)) {
      if (ch !== '"') this.repairs.add(ch === "'" ? "fixed-single-quotes" : "fixed-smart-quotes");
      const result = this.parseString(true);
      if (!result.complete) return INCOMPLETE;
      return result.value;
    }
    const match = /^[A-Za-z_$À-￿][\w$\-À-￿]*/.exec(this.text.slice(this.pos, this.pos + 200));
    if (!match) return null;
    this.pos += match[0].length;
    this.repairs.add("quoted-unquoted-keys");
    return match[0];
  }

  parseString(isKey = false) {
    const open = this.text[this.pos];
    const closers = OPEN_QUOTES.get(open);
    if (!isKey && open !== '"') this.repairs.add(open === "'" ? "fixed-single-quotes" : "fixed-smart-quotes");
    this.pos += 1;
    let out = "";
    while (!this.eof()) {
      const ch = this.text[this.pos];
      if (ch === "\\") {
        const next = this.text[this.pos + 1];
        if (next === undefined) { this.pos += 1; break; }
        const escapes = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "/": "/", "\\": "\\", '"': '"', "'": "'" };
        if (next === "u") {
          const hex = this.text.slice(this.pos + 2, this.pos + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            this.pos += 6;
            continue;
          }
        }
        out += escapes[next] ?? next;
        this.pos += 2;
        continue;
      }
      if (closers.includes(ch)) {
        // An unescaped quote INSIDE a string ("he yelled "run!" and fled") is common in narrative
        // summaries. Only treat the quote as closing when what follows is structural.
        const after = this.peekNonWs(this.pos + 1);
        const structural = after === undefined || [",", "}", "]", ":"].includes(after) || (isKey && after === "=");
        const nextIsNewKey = after === '"' && /^\s*\n/.test(this.text.slice(this.pos + 1));
        if (structural || nextIsNewKey) {
          this.pos += 1;
          return { value: out, complete: true };
        }
        this.repairs.add("escaped-inner-quote");
        out += ch;
        this.pos += 1;
        continue;
      }
      if (ch === "\n" && open === '"') this.repairs.add("escaped-raw-newline");
      out += ch;
      this.pos += 1;
    }
    return { value: out, complete: false };
  }

  parseNumber() {
    const match = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(this.text.slice(this.pos, this.pos + 64));
    if (!match) return null;
    const after = this.text[this.pos + match[0].length];
    // "1d20+5" or "3rd" are not numbers -- let the bareword path turn them into strings.
    if (after !== undefined && /[A-Za-z_]/.test(after)) return null;
    this.pos += match[0].length;
    const atEof = this.eof();
    const num = Number(match[0]);
    if (match[0].startsWith("+") || match[0].startsWith(".") || match[0].endsWith(".")) this.repairs.add("fixed-number-format");
    // A number at the very end of input may have been cut ("max": 1 -> "max": 12 intended). Treat it
    // as incomplete so the member is dropped rather than trusted.
    return { value: Number.isFinite(num) ? num : null, complete: !atEof };
  }

  parseBareword() {
    const slice = this.text.slice(this.pos, this.pos + 400);
    const literal = /^-?[A-Za-z_][A-Za-z0-9_]*/.exec(slice);
    if (literal && BAREWORD_LITERALS.has(literal[0])) {
      const word = literal[0];
      if (!["true", "false", "null"].includes(word)) {
        this.repairs.add(/^(True|False|None)$/.test(word) ? "fixed-python-literals" : "fixed-non-json-literals");
      }
      this.pos += word.length;
      return { value: BAREWORD_LITERALS.get(word), complete: !this.eof() };
    }
    // Comments are skipped by skipWs; anything else unquoted up to a structural character is taken
    // as a string value (outcome: success, per: day).
    const bare = /^[^,{}[\]\n"]+/.exec(slice);
    if (!bare || !bare[0].trim()) throw new Error(`unexpected character at ${this.pos}`);
    // Refuse to swallow prose that obviously is not a value (e.g. "Here is the JSON:").
    if (bare[0].includes(":")) throw new Error(`prose at ${this.pos}`);
    this.pos += bare[0].length;
    this.repairs.add("quoted-bareword-value");
    return { value: bare[0].trim(), complete: !this.eof() };
  }

  skipWs() {
    for (;;) {
      while (!this.eof() && /[\s ​﻿]/.test(this.text[this.pos])) this.pos += 1;
      if (this.text.startsWith("//", this.pos)) {
        const end = this.text.indexOf("\n", this.pos);
        this.pos = end === -1 ? this.text.length : end + 1;
        this.repairs.add("stripped-comments");
        continue;
      }
      if (this.text.startsWith("/*", this.pos)) {
        const end = this.text.indexOf("*/", this.pos + 2);
        this.pos = end === -1 ? this.text.length : end + 2;
        this.repairs.add("stripped-comments");
        continue;
      }
      if (this.text[this.pos] === "#" && /^#[^\n]*/.test(this.text.slice(this.pos))) {
        const end = this.text.indexOf("\n", this.pos);
        this.pos = end === -1 ? this.text.length : end + 1;
        this.repairs.add("stripped-comments");
        continue;
      }
      // Ellipsis placeholders models sometimes leave in arrays: [ {...}, ... ]
      if (this.text.startsWith("...", this.pos) || this.text[this.pos] === "…") {
        this.pos += this.text[this.pos] === "…" ? 1 : 3;
        this.repairs.add("stripped-ellipsis");
        continue;
      }
      return;
    }
  }

  peekNonWs(from) {
    let i = from;
    while (i < this.text.length && /\s/.test(this.text[i])) i += 1;
    return this.text[i];
  }

  eof() {
    return this.pos >= this.text.length;
  }
}
