import assert from "node:assert/strict";
import test from "node:test";

import { GrandDesignApi } from "../scripts/api.js";
import { runAiTestScenario, clearAiTestScenario } from "../scripts/ai-test-scenario.js";
import { MODULE_ID } from "../scripts/constants.js";

let idCounter = 0;
function nextId() {
  return `mock-${++idCounter}`;
}

class MockCollection {
  constructor() {
    this._items = [];
  }
  add(doc) {
    this._items.push(doc);
    return doc;
  }
  remove(doc) {
    this._items = this._items.filter((item) => item !== doc);
  }
  [Symbol.iterator]() {
    return this._items[Symbol.iterator]();
  }
}

class ItemMock {
  constructor(source) {
    this.id = nextId();
    this.name = source.name;
    this.type = source.type;
    this.system = source.system;
    this._flags = structuredClone(source.flags ?? {});
    this.activities = [];
  }
  getFlag(module, key) {
    return this._flags[module]?.[key];
  }
  // Minimal stand-in for dnd5e's real Item5e#createActivity(type, data, {renderSheet}) -- just
  // records what was asked for so tests can assert the postCreate step actually ran and passed
  // sane data, without needing a real dnd5e system loaded.
  async createActivity(type, data, options) {
    const activity = { type, data, options };
    this.activities.push(activity);
    return activity;
  }
}

class ActorMock {
  constructor(data, collection) {
    this.id = data.id ?? nextId();
    this.name = data.name;
    this.documentName = "Actor";
    this.type = data.type;
    this.system = data.system ?? { skills: { acrobatics: { mod: 6 } } };
    this._flags = structuredClone(data.flags ?? {});
    this._collection = collection;
    this._items = [];
    this.items = {
      find: (fn) => this._items.find(fn),
      filter: (fn) => this._items.filter(fn)
    };
  }
  getFlag(module, key) {
    return this._flags[module]?.[key];
  }
  async update(changes) {
    for (const [path, value] of Object.entries(changes)) {
      const parts = path.split(".");
      if (parts[0] === "flags") {
        const [, module, ...rest] = parts;
        this._flags[module] = this._flags[module] ?? {};
        let target = this._flags[module];
        for (let i = 0; i < rest.length - 1; i++) {
          target[rest[i]] = target[rest[i]] ?? {};
          target = target[rest[i]];
        }
        target[rest[rest.length - 1]] = value;
      }
    }
    return this;
  }
  async createEmbeddedDocuments(docType, sources) {
    if (docType !== "Item") throw new Error(`Mock actor does not support embedded ${docType}.`);
    const created = sources.map((source) => new ItemMock(source));
    this._items.push(...created);
    return created;
  }
  async delete() {
    this._collection?.remove(this);
  }
}

function installFoundryMocks(systemId = "pf2e") {
  const actorsCollection = new MockCollection();
  globalThis.game = {
    user: { isGM: true },
    system: { id: systemId },
    actors: actorsCollection
  };
  globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
  globalThis.Dialog = class {
    constructor(data) {
      this.data = data;
    }
    render() {
      return this;
    }
  };
  globalThis.Hooks = { callAll: () => {} };
  globalThis.FilePicker = {
    async createDirectory() {
      return true;
    },
    async upload(_source, directory, file) {
      return { path: `${directory}/${file.name}` };
    }
  };
  globalThis.Actor = {
    async create(data) {
      return actorsCollection.add(new ActorMock(data, actorsCollection));
    }
  };
  return { actorsCollection };
}

function skillEntry(name, kind, tags) {
  return {
    name,
    tier: 2,
    system_equivalent: "Reskinned class feat",
    gameItem: { kind },
    mechanics: kind === "reaction"
      ? {
        effect: `${name} triggers a defensive response.`,
        duration: "instant",
        frequency: { max: 1, per: "round" },
        trigger: "An enemy targets you or an ally.",
        roll: { kind: "Reflex check", formula: "1d20+7", dc: 18 }
      }
      : kind === "passive"
        ? {
          effect: `${name} grants an ongoing benefit.`,
          duration: "always active",
          frequency: { max: 1, per: "unlimited" }
        }
        : {
          effect: `${name} resolves a tangible benefit.`,
          duration: "instant",
          frequency: { max: 1, per: "round" },
          actions: 1,
          roll: { kind: "Athletics check", formula: "1d20+7", dc: 18 }
        },
    metadata: { tags, lineage: { operation: "origin", sources: [], rationale: `Earned via ${name}.` } }
  };
}

// A deterministic stand-in for a real Ollama call: it varies its response by beat label so the
// scenario's own bookkeeping (accumulating beats, collecting generated entries across the whole
// campaign, computing kindsCovered, approving one after a rest) is exercised the same way it would
// be against a real provider, without a network call or a running Foundry server.
function scriptedAdapter() {
  let call = 0;
  const responses = [
    { events: [{ summary: "Kellin improvised a rescue rig.", tags: ["craft", "mobility"], outcome: "success" }],
      proposals: [{ kind: "skill", entry: skillEntry("Salvage Rig", "action", ["craft", "mobility"]), evidence: ["note 1"] }] },
    { events: [{ summary: "Kellin struck the lurker's weak point.", tags: ["martial", "precision"], outcome: "success" }],
      proposals: [{ kind: "skill", entry: skillEntry("Weak-Point Strike", "action", ["martial", "precision"]), evidence: ["note 2"] }] },
    { events: [{ summary: "Kellin guarded an ally on reflex.", tags: ["defense", "martial"], outcome: "success" }],
      proposals: [{ kind: "skill", entry: skillEntry("Undercutter's Guard", "reaction", ["defense", "martial"]), evidence: ["note 3"] }] },
    // The model is allowed to decide there isn't enough evidence yet -- an empty response is valid
    // per the system prompt, and the scenario must not treat that as a hard failure.
    { events: [], proposals: [] },
    { events: [{ summary: "Kellin rallied the crew.", tags: ["leadership", "support"], outcome: "success" }],
      proposals: [{ kind: "skill", entry: skillEntry("Steady the Line", "free", ["leadership", "support"]), evidence: ["note 5"] }] },
    { events: [{ summary: "Kellin senses the rock.", tags: ["survival", "nature"], outcome: "success" }],
      proposals: [{ kind: "skill", entry: skillEntry("Stone Sense", "passive", ["survival", "nature"]), evidence: ["note 6"] }] }
  ];
  return async () => responses[Math.min(call++, responses.length - 1)];
}

test("the AI-provider test campaign fails clearly when no provider is configured", async () => {
  installFoundryMocks();
  const api = new GrandDesignApi();

  const report = await runAiTestScenario(api);

  assert.equal(report.ok, false);
  assert.ok(report.failed.some((message) => message.includes("No AI provider is configured")));
});

test("the AI-provider test campaign runs every beat, collects generated entries, and approves one", async () => {
  installFoundryMocks();
  const api = new GrandDesignApi();
  api.setProposalAdapter(scriptedAdapter());

  const report = await runAiTestScenario(api);

  assert.equal(report.failed.length, 0, `Unexpected campaign failures: ${report.failed.join(" | ")}`);
  assert.equal(report.ok, true);
  assert.equal(report.beats.length, 6);
  assert.ok(report.beats.every((beat) => beat.ok), "Every beat should complete without throwing.");
  assert.equal(report.generated.length, 5, "Five of the six scripted beats return a proposal; one deliberately returns none.");
  assert.deepEqual(
    new Set(report.kindsCovered),
    new Set(["action", "reaction", "free", "passive"]),
    "The campaign should report the real spread of gameItem.kind values the provider produced."
  );
  assert.ok(report.approved, "One generated proposal should have been approved into a real Item.");
  assert.equal(report.approved.status, "approved");

  const remaining = await clearAiTestScenario();
  assert.equal(remaining, 1);
});

// Same scripted campaign, run under dnd5e instead of PF2e -- this is the actual regression guard
// for "does the module still work end-to-end once the active system isn't PF2e", exercising the
// full analyze -> propose -> rest -> approve -> real-Item pipeline through the dnd5e adapter,
// including its postCreate step (adding an Activity to the created Item), not just the adapter's
// own unit tests in dnd5e-adapter.test.mjs.
test("the AI-provider test campaign also runs end-to-end under dnd5e, creating real Items with an Activity", async () => {
  const { actorsCollection } = installFoundryMocks("dnd5e");
  const api = new GrandDesignApi();
  api.setProposalAdapter(scriptedAdapter());

  const report = await runAiTestScenario(api);

  assert.equal(report.failed.length, 0, `Unexpected campaign failures: ${report.failed.join(" | ")}`);
  assert.equal(report.ok, true);
  assert.ok(report.approved, "One generated proposal should have been approved into a real dnd5e Item.");

  const subject = [...actorsCollection].find((actor) => actor.name.includes("Kellin"));
  const approvedItem = subject._items.find((item) => item.name.includes(report.approved.name));
  assert.ok(approvedItem, "The approved proposal's Item should exist on the dnd5e test actor.");
  assert.equal(approvedItem.type, "feat");
  assert.equal(approvedItem.activities.length, 1, "dnd5e feat Items need a postCreate Activity, unlike PF2e's flat fields.");

  const remaining = await clearAiTestScenario();
  assert.equal(remaining, 1);
});
