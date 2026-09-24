import assert from "node:assert/strict";
import test from "node:test";

import { ModelJsonError, parseModelJson } from "../scripts/ai/json-repair.js";
import { createRng, goldEvents } from "../tools/nlp-scale/sim-model.js";
import { loadCorpusSync } from "./helpers/corpus.mjs";

// Every repair named in docs/ai-gateway-v2-contract.md#json-repair gets its own pinned case below,
// then a seeded fuzz loop throws >1000 corrupted-but-realistic variants of real payloads at the
// parser. The invariant that matters to a GM is the fuzz one: whatever garbage a local model emits,
// parseModelJson either salvages it or throws ModelJsonError -- never a TypeError/RangeError that
// would escape the pipeline's error handling and turn into a fallback for the wrong reason.

const PAYLOAD = {
  events: [
    { summary: "Kesh parried the guard's blade.", tags: ["martial", "defense"], outcome: "success" },
    { summary: "Mira bound the wound.", tags: ["medicine"], outcome: "criticalSuccess", dangerGap: "moderate" }
  ]
};

function repairsOf(text) {
  return parseModelJson(text).repairs;
}

test("valid JSON parses on the fast path with no repairs", () => {
  const { value, repairs } = parseModelJson(JSON.stringify(PAYLOAD));
  assert.deepEqual(value, PAYLOAD);
  assert.deepEqual(repairs, []);
});

test("an already-parsed object is returned as-is", () => {
  const { value } = parseModelJson(PAYLOAD);
  assert.equal(value, PAYLOAD);
});

test("non-string, non-object input throws ModelJsonError", () => {
  assert.throws(() => parseModelJson(42), ModelJsonError);
  assert.throws(() => parseModelJson(undefined), ModelJsonError);
});

test("empty and whitespace-only output throw ModelJsonError", () => {
  assert.throws(() => parseModelJson(""), ModelJsonError);
  assert.throws(() => parseModelJson("   \n\t "), ModelJsonError);
});

test("pure prose throws ModelJsonError and keeps the raw text on .raw", () => {
  const raw = "I'm sorry, I can't find any events in these notes.";
  try {
    parseModelJson(raw);
    assert.fail("expected a throw");
  } catch (error) {
    assert.ok(error instanceof ModelJsonError);
    assert.equal(error.name, "ModelJsonError");
    assert.equal(error.raw, raw);
  }
});

test("a bare JSON scalar is not accepted as a payload", () => {
  assert.throws(() => parseModelJson("42"), ModelJsonError);
  assert.throws(() => parseModelJson("true"), ModelJsonError);
});

test("```json fences are stripped", () => {
  const { value, repairs } = parseModelJson("```json\n" + JSON.stringify(PAYLOAD) + "\n```");
  assert.deepEqual(value, PAYLOAD);
  assert.ok(repairs.includes("stripped-code-fence"));
});

test("a language-less fence with prose around it is stripped", () => {
  const { value } = parseModelJson("Here is the {events} array:\n```\n" + JSON.stringify(PAYLOAD) + "\n```\nHope that helps!");
  assert.deepEqual(value, PAYLOAD);
});

test("an unterminated fence (truncated reply) still yields the content", () => {
  const { value } = parseModelJson("```json\n" + JSON.stringify(PAYLOAD));
  assert.deepEqual(value, PAYLOAD);
});

test("<think> blocks are stripped, even when they contain braces", () => {
  const { value, repairs } = parseModelJson("<think>maybe {\"events\": []} is right? no.</think>\n" + JSON.stringify(PAYLOAD));
  assert.deepEqual(value, PAYLOAD);
  assert.ok(repairs.includes("stripped-think-block"));
});

test("an unterminated <think> block after the JSON is ignored", () => {
  const { value } = parseModelJson(JSON.stringify(PAYLOAD) + "\n<think>wait, I should also");
  assert.deepEqual(value, PAYLOAD);
});

test("a reply that is only an unterminated <think> block throws ModelJsonError", () => {
  assert.throws(() => parseModelJson("<think>The user wants {events}. Let me"), ModelJsonError);
});

test("prose before the JSON is stripped", () => {
  const { value, repairs } = parseModelJson("Sure! Here is the JSON you asked for:\n" + JSON.stringify(PAYLOAD));
  assert.deepEqual(value, PAYLOAD);
  assert.ok(repairs.includes("stripped-leading-prose"));
});

test("prose after the JSON is stripped", () => {
  const { value, repairs } = parseModelJson(JSON.stringify(PAYLOAD) + "\n\nI skipped the out-of-character chatter.");
  assert.deepEqual(value, PAYLOAD);
  assert.ok(repairs.includes("stripped-trailing-prose"));
});

test("trailing commas in objects and arrays are removed", () => {
  const { value, repairs } = parseModelJson('{"events":[{"summary":"a","tags":["martial",],"outcome":"success",},],}');
  assert.deepEqual(value, { events: [{ summary: "a", tags: ["martial"], outcome: "success" }] });
  assert.ok(repairs.includes("removed-trailing-comma"));
});

test("single-quoted strings and keys are accepted", () => {
  const { value, repairs } = parseModelJson("{'events':[{'summary':'Kesh won','tags':['martial'],'outcome':'success'}]}");
  assert.equal(value.events[0].summary, "Kesh won");
  assert.ok(repairs.includes("fixed-single-quotes"));
});

test("an apostrophe inside a double-quoted string is never treated as a quote", () => {
  const { value } = parseModelJson('{"summary": "Kesh\'s lockpick snapped", "tags": ["thievery"],}');
  assert.equal(value.summary, "Kesh's lockpick snapped");
});

test("unquoted keys are quoted", () => {
  const { value, repairs } = parseModelJson('{events: [{summary: "x", tags: ["stealth"], outcome: "success"}]}');
  assert.deepEqual(value.events[0].tags, ["stealth"]);
  assert.ok(repairs.includes("quoted-unquoted-keys"));
});

test("smart quotes are accepted as string delimiters", () => {
  const { value, repairs } = parseModelJson("{“summary”: “Mira sang”, “tags”: [“performance”], “outcome”: “success”}");
  assert.equal(value.summary, "Mira sang");
  assert.deepEqual(value.tags, ["performance"]);
  assert.ok(repairs.includes("fixed-smart-quotes"));
});

test("// and /* */ comments are stripped", () => {
  const text = '{\n  // the events\n  "events": [ /* one */ {"summary":"x","tags":["lore"],"outcome":"success"} ]\n}';
  const { value, repairs } = parseModelJson(text);
  assert.equal(value.events.length, 1);
  assert.ok(repairs.includes("stripped-comments"));
});

test("a // inside a string value is not treated as a comment", () => {
  const { value } = parseModelJson('{"summary": "see https://example.com/notes", "tags": []}');
  assert.equal(value.summary, "see https://example.com/notes");
});

test("NaN / undefined / Infinity become null", () => {
  const { value, repairs } = parseModelJson('{"a": NaN, "b": undefined, "c": Infinity, "d": 1}');
  assert.deepEqual(value, { a: null, b: null, c: null, d: 1 });
  assert.ok(repairs.includes("fixed-non-json-literals"));
});

test("Python True/False/None literals are converted", () => {
  const { value, repairs } = parseModelJson('{"is_primary": True, "is_secondary": False, "dangerGap": None}');
  assert.deepEqual(value, { is_primary: true, is_secondary: false, dangerGap: null });
  assert.ok(repairs.includes("fixed-python-literals"));
});

test("a top-level array is returned as-is", () => {
  const { value } = parseModelJson(JSON.stringify(PAYLOAD.events));
  assert.ok(Array.isArray(value));
  assert.equal(value.length, 2);
});

test("truncation inside a string drops only the dangling element", () => {
  const full = JSON.stringify({ events: [...PAYLOAD.events, { summary: "Tovin picked the lock", tags: ["thievery"], outcome: "success" }] });
  const cut = full.slice(0, full.indexOf("Tovin picked") + 8);
  const { value, repairs } = parseModelJson(cut);
  assert.deepEqual(value.events, PAYLOAD.events);
  assert.ok(repairs.includes("closed-truncated-json"));
});

test("truncation with missing closing brackets closes them", () => {
  const full = JSON.stringify(PAYLOAD);
  const { value } = parseModelJson(full.slice(0, -2));
  assert.equal(value.events.length, 2);
  assert.deepEqual(value.events[0], PAYLOAD.events[0]);
});

test("a number cut off at end of input is not trusted", () => {
  const { value } = parseModelJson('{"name":"x","max": 1');
  assert.equal(value.name, "x");
  assert.equal("max" in value, false);
});

test("truncation right after an opening brace yields an empty container, not a crash", () => {
  const { value } = parseModelJson('{"events": [');
  assert.deepEqual(value, { events: [] });
});

test("two consecutive top-level objects are merged", () => {
  const { value, repairs } = parseModelJson('{"events": []}\n{"proposals": [{"kind":"skill"}]}');
  assert.deepEqual(value, { events: [], proposals: [{ kind: "skill" }] });
  assert.ok(repairs.includes("merged-multiple-objects"));
});

test("double-encoded JSON (a JSON string containing JSON) is decoded", () => {
  const { value, repairs } = parseModelJson(JSON.stringify(JSON.stringify(PAYLOAD)));
  assert.deepEqual(value, PAYLOAD);
  assert.ok(repairs.includes("decoded-double-encoded-json"));
});

test("unescaped quotes inside a summary are kept as text", () => {
  const { value } = parseModelJson('{"summary": "He yelled "run!" and fled", "tags": ["mobility"]}');
  assert.equal(value.summary, 'He yelled "run!" and fled');
  assert.deepEqual(value.tags, ["mobility"]);
});

test("raw newlines inside a string are tolerated", () => {
  const { value } = parseModelJson('{"summary": "line one\nline two", "tags": ["lore"], "x": 1,}');
  assert.equal(value.summary, "line one\nline two");
});

// Pretty-printed output is where a dropped comma actually happens (one member per line). On a single
// line `"x" "tags"` is genuinely ambiguous with an unescaped inner quote, which the parser resolves
// in favour of keeping summary text intact -- so this pins the multi-line form only.
test("a missing comma between members is inserted", () => {
  const { value, repairs } = parseModelJson('{"summary": "x"\n  "tags": ["lore"]\n  "outcome": "success"}');
  assert.deepEqual(value, { summary: "x", tags: ["lore"], outcome: "success" });
  assert.ok(repairs.includes("inserted-missing-comma"));
});

test("non-Latin content (Greek, Japanese, accents) survives repairs untouched", () => {
  const text = "```json\n{'quote': 'Ο Γιώργος πολέμησε', 'q2': 'Kenji wa tatakatta', 'q3': 'curó al herido',}\n```";
  const { value } = parseModelJson(text);
  assert.deepEqual(value, { quote: "Ο Γιώργος πολέμησε", q2: "Kenji wa tatakatta", q3: "curó al herido" });
});

test("a UTF-8 BOM is ignored", () => {
  const { value } = parseModelJson("﻿" + JSON.stringify(PAYLOAD));
  assert.deepEqual(value, PAYLOAD);
});

test("bareword enum values are quoted", () => {
  const { value } = parseModelJson('{"outcome": success, "per": day}');
  assert.deepEqual(value, { outcome: "success", per: "day" });
});

test("a dice formula left unquoted is kept as a string, not a number", () => {
  const { value } = parseModelJson('{"formula": 1d20+7, "max": 2}');
  assert.equal(value.formula, "1d20+7");
  assert.equal(value.max, 2);
});

test("ellipsis placeholders in arrays are skipped", () => {
  const { value } = parseModelJson('{"tags": ["martial", ...], "events": [{"a":1}, …]}');
  assert.deepEqual(value.tags, ["martial"]);
  assert.deepEqual(value.events, [{ a: 1 }]);
});

test("a mismatched closing bracket is tolerated", () => {
  const { value } = parseModelJson('{"events": [{"summary":"x"}}');
  assert.deepEqual(value.events, [{ summary: "x" }]);
});

test("every repair name is a non-empty kebab-case string", () => {
  const nasty = "Sure!\n```json\n{events: [{'summary': 'x', tags: ['martial',], outcome: True, // c\n}],}\n```\nbye";
  const repairs = repairsOf(nasty);
  assert.ok(repairs.length >= 3);
  for (const repair of repairs) assert.match(repair, /^[a-z]+(?:-[a-z]+)*$/);
});

// ---- fuzz ---------------------------------------------------------------------------------

function serialize(value, style, rng) {
  const q = style.quote;
  const str = (s) => {
    if (q === '"') return JSON.stringify(s);
    if (q === "'") return "'" + JSON.stringify(s).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'") + "'";
    return "“" + JSON.stringify(s).slice(1, -1) + "”";
  };
  const key = (k) => (style.unquotedKeys && /^[A-Za-z_]\w*$/.test(k) ? k : str(k));
  const lit = (v) => {
    if (!style.python) return String(v);
    return v === true ? "True" : v === false ? "False" : "None";
  };
  const trail = () => (style.trailingCommas && rng.chance(0.5) ? "," : "");
  const walk = (v) => {
    if (v === null || typeof v === "boolean") return lit(v);
    if (typeof v === "number") return String(v);
    if (typeof v === "string") return str(v);
    if (Array.isArray(v)) return "[" + v.map(walk).join(", ") + (v.length ? trail() : "") + "]";
    const members = Object.entries(v).map(([k, val]) => key(k) + ": " + walk(val));
    return "{" + members.join(", ") + (members.length ? trail() : "") + "}";
  };
  return walk(value);
}

function buildPayloads() {
  const corpus = loadCorpusSync();
  const payloads = [];
  for (const item of corpus) {
    const events = goldEvents(item);
    if (events.length) payloads.push({ events });
  }
  payloads.push({ proposals: [{ kind: "skill", entry: { name: "Beekeeper's Calm", tier: 1, is_primary: false, metadata: { tags: ["nature"], lineage: { operation: "origin", sources: [], rationale: "Kept bees." } } } }] });
  return payloads;
}

test("fuzz: 1200 corrupted variants of real payloads either salvage correctly or throw ModelJsonError", () => {
  const rng = createRng(20260923);
  const payloads = buildPayloads();
  const lossless = ["fence", "prose", "think", "trailing", "singleQuotes", "unquotedKeys", "python", "smartQuotes", "comment", "combo"];
  const lossy = ["truncate", "truncateCombo", "garbage", "chop-start"];
  const counts = { salvagedExact: 0, salvagedPartial: 0, modelJsonError: 0 };
  for (let i = 0; i < 1200; i += 1) {
    const payload = payloads[rng.int(payloads.length)];
    const useLossy = rng.chance(0.45);
    const kind = useLossy ? rng.pick(lossy) : rng.pick(lossless);
    const style = { quote: '"', unquotedKeys: false, python: false, trailingCommas: false };
    if (kind === "singleQuotes") style.quote = "'";
    if (kind === "smartQuotes") style.quote = "“";
    if (kind === "unquotedKeys") style.unquotedKeys = true;
    if (kind === "python") style.python = true;
    if (kind === "trailing") style.trailingCommas = true;
    if (kind === "combo" || kind === "truncateCombo") Object.assign(style, { quote: rng.pick(['"', "'"]), unquotedKeys: rng.chance(0.5), python: rng.chance(0.5), trailingCommas: rng.chance(0.5) });
    let text = serialize(payload, style, rng);
    if (kind === "fence" || (kind === "combo" && rng.chance(0.5))) text = "```json\n" + text + "\n```";
    if (kind === "prose" || (kind === "combo" && rng.chance(0.5))) text = "Here are the events:\n" + text + "\nThat's all.";
    if (kind === "think" || (kind === "combo" && rng.chance(0.5))) text = "<think>{maybe} [not]</think>" + text;
    if (kind === "comment") text = text.replace("{", "{ // model comment\n");
    if (kind === "truncate" || kind === "truncateCombo") text = text.slice(0, 1 + rng.int(Math.max(1, text.length - 1)));
    if (kind === "garbage") {
      const pos = rng.int(text.length);
      const junk = rng.pick(["}", "]", "{", "[", ":", ",", '"', "'", "\\", "\u0000", "💀", "NaN", "}{", "]]]"]);
      text = text.slice(0, pos) + junk + text.slice(pos);
    }
    if (kind === "chop-start") text = text.slice(rng.int(Math.min(40, text.length)));

    let result;
    try {
      result = parseModelJson(text);
    } catch (error) {
      assert.ok(error instanceof ModelJsonError, `variant ${i} (${kind}) threw ${error?.name}: ${error?.message}\n${text.slice(0, 300)}`);
      counts.modelJsonError += 1;
      continue;
    }
    assert.ok(result && typeof result.value === "object" && result.value !== null, `variant ${i} (${kind}) returned a non-object`);
    assert.ok(Array.isArray(result.repairs), `variant ${i} (${kind}) returned no repairs array`);
    if (!useLossy) {
      assert.deepEqual(result.value, payload, `variant ${i} (${kind}) was not salvaged exactly:\n${text.slice(0, 400)}`);
      counts.salvagedExact += 1;
    } else if (kind === "truncate" || kind === "truncateCombo") {
      // Truncation may only ever LOSE trailing data: whatever survives in the events array must be
      // a complete, unmodified prefix of the original (the dangling element is dropped, never kept
      // half-filled).
      const got = result.value?.events;
      if (Array.isArray(got) && Array.isArray(payload.events)) {
        assert.ok(got.length <= payload.events.length);
        got.forEach((event, k) => assert.deepEqual(event, payload.events[k], `variant ${i}: truncated event ${k} was altered`));
      }
      counts.salvagedPartial += 1;
    } else {
      counts.salvagedPartial += 1;
    }
  }
  // All lossless corruptions must salvage; sanity-check the loop actually exercised both paths.
  assert.ok(counts.salvagedExact > 500, JSON.stringify(counts));
  assert.ok(counts.salvagedPartial > 300, JSON.stringify(counts));
});

test("fuzz: random byte soup never throws anything but ModelJsonError", () => {
  const rng = createRng(7);
  const alphabet = '{}[]:,"\'\\ \n\tabcdefTrueNoneNaN0123456789-+.eE/*#`<>think…“”';
  for (let i = 0; i < 400; i += 1) {
    let text = "";
    const length = 1 + rng.int(80);
    for (let k = 0; k < length; k += 1) text += alphabet[rng.int(alphabet.length)];
    try {
      const { value } = parseModelJson(text);
      assert.ok(value !== null && typeof value === "object");
    } catch (error) {
      assert.ok(error instanceof ModelJsonError, `soup ${i} threw ${error?.name}: ${JSON.stringify(text)}`);
    }
  }
});
