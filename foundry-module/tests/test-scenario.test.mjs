import assert from "node:assert/strict";
import test from "node:test";

import { GrandDesignApi } from "../scripts/api.js";
import { runTestScenario, clearTestScenario } from "../scripts/test-scenario.js";
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
  get(id) {
    return this._items.find((doc) => doc.id === id);
  }
  remove(doc) {
    this._items = this._items.filter((item) => item !== doc);
  }
  [Symbol.iterator]() {
    return this._items[Symbol.iterator]();
  }
}

class BaseDocument {
  constructor(data, collection) {
    this.id = data.id ?? nextId();
    this.name = data.name;
    this._flags = structuredClone(data.flags ?? {});
    this._collection = collection;
  }
  getFlag(module, key) {
    return this._flags[module]?.[key];
  }
  async setFlag(module, key, value) {
    this._flags[module] = this._flags[module] ?? {};
    this._flags[module][key] = value;
    return this;
  }
  async update(changes) {
    for (const [path, value] of Object.entries(changes)) {
      this._applyPath(path, value);
    }
    return this;
  }
  _applyPath(path, value) {
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
      return;
    }
    if (parts.length === 1) {
      const isMergeableObject = (candidate) =>
        typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
      this[parts[0]] = isMergeableObject(value) && isMergeableObject(this[parts[0]])
        ? { ...this[parts[0]], ...value }
        : value;
      return;
    }
    let target = this;
    for (let i = 0; i < parts.length - 1; i++) {
      target[parts[i]] = target[parts[i]] ?? {};
      target = target[parts[i]];
    }
    target[parts[parts.length - 1]] = value;
  }
  async delete() {
    this._collection?.remove(this);
  }
}

class ItemMock {
  constructor(source) {
    this.id = nextId();
    this.name = source.name;
    this.type = source.type;
    this.system = source.system;
    this._flags = structuredClone(source.flags ?? {});
  }
  getFlag(module, key) {
    return this._flags[module]?.[key];
  }
}

class ActorMock extends BaseDocument {
  constructor(data, collection) {
    super(data, collection);
    this.documentName = "Actor";
    this.type = data.type;
    this.system = data.system ?? {};
    this._items = [];
    this.items = {
      find: (fn) => this._items.find(fn),
      filter: (fn) => this._items.filter(fn)
    };
  }
  async createEmbeddedDocuments(docType, sources) {
    if (docType !== "Item") throw new Error(`Mock actor does not support embedded ${docType}.`);
    const created = sources.map((source) => new ItemMock(source));
    this._items.push(...created);
    return created;
  }
}

class SceneMock extends BaseDocument {
  constructor(data, collection) {
    super(data, collection);
    this.background = data.background;
    this.backgroundColor = data.backgroundColor;
    this.grid = data.grid;
    this.width = data.width;
    this.height = data.height;
    this.navigation = data.navigation;
    this.tokens = new Map();
    this._source = { background: data.background };
  }
  async createEmbeddedDocuments(docType, sources) {
    if (docType !== "Token") throw new Error(`Mock scene does not support embedded ${docType}.`);
    for (const source of sources) {
      const tokenId = nextId();
      this.tokens.set(tokenId, { id: tokenId, ...source });
    }
    return [...this.tokens.values()];
  }
  async activate() {
    return this;
  }
}

class JournalEntryMock extends BaseDocument {
  constructor(data, collection) {
    super(data, collection);
    this.pages = new Map();
    (data.pages ?? []).forEach((page, index) => this.pages.set(String(index), page));
  }
}

class RollTableMock extends BaseDocument {
  constructor(data, collection) {
    super(data, collection);
    this.results = new Map();
    (data.results ?? []).forEach((result, index) => this.results.set(String(index), result));
  }
}

class MacroMock extends BaseDocument {}

function installFoundryMocks() {
  const actorsCollection = new MockCollection();
  const scenesCollection = new MockCollection();
  const journalCollection = new MockCollection();
  const macrosCollection = new MockCollection();
  const tablesCollection = new MockCollection();

  globalThis.game = {
    user: { isGM: true },
    system: { id: "pf2e" },
    settings: { get: (_module, key) => (key === "atlasAssetPath" ? "" : undefined) },
    actors: actorsCollection,
    scenes: scenesCollection,
    journal: journalCollection,
    macros: macrosCollection,
    tables: tablesCollection
  };
  globalThis.CONST = {
    GRID_TYPES: { GRIDLESS: 0 },
    TOKEN_DISPOSITIONS: { FRIENDLY: 1, HOSTILE: -1 },
    TABLE_RESULT_TYPES: { TEXT: 0 },
    JOURNAL_ENTRY_PAGE_FORMATS: { HTML: 1 }
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
  globalThis.Hooks = { callAll: () => {}, on: () => {}, once: () => {} };
  globalThis.FilePicker = {
    async createDirectory() {
      return true;
    },
    async upload(_source, directory, file) {
      return { path: `${directory}/${file.name}` };
    }
  };
  globalThis.fetch = async () => ({ ok: true });
  globalThis.Actor = {
    async create(data) {
      return actorsCollection.add(new ActorMock(data, actorsCollection));
    }
  };
  globalThis.Scene = {
    async create(data) {
      return scenesCollection.add(new SceneMock(data, scenesCollection));
    }
  };
  globalThis.JournalEntry = {
    async create(data) {
      return journalCollection.add(new JournalEntryMock(data, journalCollection));
    }
  };
  globalThis.RollTable = {
    async create(data) {
      return tablesCollection.add(new RollTableMock(data, tablesCollection));
    }
  };
  globalThis.Macro = {
    async createDocuments(dataArray) {
      return Promise.all(dataArray.map(async (data) => macrosCollection.add(new MacroMock(data, macrosCollection))));
    }
  };
}

test("the programmatic test campaign passes every assertion end to end", async () => {
  installFoundryMocks();
  const api = new GrandDesignApi();

  const report = await runTestScenario(api);

  assert.equal(report.failed.length, 0, `Unexpected campaign failures: ${report.failed.join(" | ")}`);
  assert.equal(report.ok, true);
  assert.equal(report.passed.length, report.expectedAssertions);
  assert.ok(report.passed.length >= 30);

  const remaining = await clearTestScenario();
  assert.ok(remaining >= 5, "Cleanup should remove every tagged test document.");

  const survivors = [...globalThis.game.actors, ...globalThis.game.scenes, ...globalThis.game.journal, ...globalThis.game.macros, ...globalThis.game.tables]
    .filter((document) => document.getFlag(MODULE_ID, "testScenario"));
  assert.equal(survivors.length, 0, "Cleanup must remove all tagged campaign documents.");
});
