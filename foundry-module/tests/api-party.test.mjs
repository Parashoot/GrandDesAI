import assert from "node:assert/strict";
import test from "node:test";

import { GrandDesignApi } from "../scripts/api.js";
import { createGatewayAdapter } from "../scripts/ai-gateway.js";
import { MODULE_ID } from "../scripts/constants.js";
import { normalizeGrowthEvent } from "../scripts/progression.js";
import { attributeEventsToActor, JEV_ATTRIBUTION_CONFIDENCE, WHOLE_PARTY_ACTOR } from "../scripts/session-notes.js";

// Party mode (docs/jev-layer-contract.md "Party mode", board 485cae73 / a48d97c0 / 6ca3c8e7):
// api.analyzePartyNotes is one click for the whole party -- an ordinary per-character analysis
// whose extraction the gateway's cache (pipeline.js#createExtractionCache) serves once -- plus the
// Jev attribution rules in attributeEventsToActor and the Jev blocks surviving the actor flag.
// Every API-level test runs on BOTH supported systems; the gateway is faked (no network).

const SYSTEMS = ["pf2e", "dnd5e"];

// Ember-road s1, trimmed: Luz reports Tovin's kill on HER line (the deed the gateway missed).
const NOTES = `Brakka: Held the bridge, troll ran off.

Tovin: torched a troll, and I may have quietly tidied up a loose end on the bridge.

Luz: Luz heal Brakka full HP, and she catch Tovin killing a goblin that was surrender, not happy.

GM: the troll was way out of their league and they still drove it off.`;

const ev = (summary, tags, extra = {}) => ({ summary, tags, themes: [], outcome: "success", quote: summary, ...extra });

// What a Jev-assisted extraction returns: the model named the SPEAKER (Luz) for the goblin kill;
// Jev, asked who did it, says Tovin.
function jevEvents() {
  return [
    ev("Brakka held the bridge against a troll.", ["defense"], { actorName: "Brakka", quote: "Held the bridge, troll ran off" }),
    ev("Tovin torched a troll.", ["fire", "spellcasting"], { actorName: "Tovin", quote: "torched a troll" }),
    ev("Luz healed Brakka to full.", ["medicine", "support"], { actorName: "Luz", quote: "Luz heal Brakka full HP" }),
    ev("Killed a goblin that had surrendered.", ["martial"], {
      actorName: "Luz",
      themes: ["dark-deed"],
      quote: "she catch Tovin killing a goblin that was surrender",
      jev: { actorName: "Tovin", actorConfidence: 0.91, whole: false, flags: ["dark-act"] }
    }),
    // The model pinned the party's win on one PC; Jev says it was the whole party's.
    ev("The party drove off a troll far above their level.", ["martial"], {
      actorName: "Brakka",
      dangerGap: "severe",
      quote: "they still drove it off",
      jev: { actorName: null, actorConfidence: 0.84, whole: true, flags: [] }
    }),
    // A low-confidence Jev guess must NOT move an event.
    ev("Brakka kept the goblins in line.", ["leadership"], {
      actorName: "Brakka",
      quote: "kept the goblins in line",
      jev: { actorName: "Tovin", actorConfidence: 0.4, whole: false, flags: [] }
    })
  ];
}

const JEV_DIAGNOSTICS = { enabled: true, ran: ["attribution"], calls: 1, ms: 42, skippedChunks: [], overrides: 0, flags: 1, errors: [] };

function skillProposal(name, evidence, tags = ["fire"]) {
  return {
    kind: "skill",
    evidence,
    entry: {
      name,
      tier: 1,
      system_equivalent: "Skill feat",
      gameItem: { kind: "passive" },
      mechanics: { effect: "Your fire deals 1 extra damage.", duration: "while active", frequency: { max: 1, per: "unlimited" } },
      metadata: { tags, lineage: { operation: "origin", sources: [], rationale: "Did it repeatedly." } }
    }
  };
}

function createMockActor(systemId, name) {
  const flags = { [MODULE_ID]: {} };
  return {
    id: `mock-${systemId}-${name}`,
    name,
    documentName: "Actor",
    type: "character",
    system: systemId === "dnd5e"
      ? { details: { level: 3 }, skills: { acr: { mod: 3, total: 5 }, med: { mod: 2, total: 4 } }, attributes: { prof: 2 } }
      : { details: { level: { value: 3 } }, skills: { acrobatics: { mod: 7 }, medicine: { totalModifier: 9 } } },
    items: { find: () => undefined, filter: () => [] },
    getFlag(module, key) {
      return flags[module]?.[key];
    },
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) {
        const [, , key] = path.split(".");
        flags[MODULE_ID][key] = value;
      }
      return this;
    }
  };
}

function party(systemId, names = ["Brakka", "Tovin", "Luz"]) {
  return names.map((name) => createMockActor(systemId, name));
}

async function withFoundry(systemId, fn, { isGM = true } = {}) {
  const originalGame = globalThis.game;
  const originalHooks = globalThis.Hooks;
  const originalWarn = console.warn;
  globalThis.game = { user: { isGM }, system: { id: systemId } };
  globalThis.Hooks = { callAll: () => {} };
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    globalThis.game = originalGame;
    globalThis.Hooks = originalHooks;
    console.warn = originalWarn;
  }
}

/**
 * A fake gateway adapter with the real one's extraction-cache behaviour: the first call for a given
 * notes text extracts (a "miss"), later calls for the same text are "hit"s, `fresh: true` extracts
 * again. `proposals` maps an actor name to its stage-2 proposals or an Error to throw on that call.
 */
function fakeCachingAdapter({ events = jevEvents(), proposals = {}, delayMs = 5 } = {}) {
  const cache = new Map();
  const calls = { extract: 0, adapter: [] };
  let inFlight = 0;
  let maxInFlight = 0;
  const adapter = async ({ actor, notes, systemId, fresh = false }) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      calls.adapter.push({ name: actor.name, systemId, fresh });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const planned = proposals[actor.name];
      if (planned instanceof Error) throw planned;
      let state;
      if (!cache.has(notes) || fresh) {
        calls.extract += 1;
        cache.set(notes, structuredClone(events));
        state = "miss";
      } else {
        state = "hit";
      }
      return {
        events: structuredClone(cache.get(notes)),
        proposals: planned ?? [],
        skippedProposals: [],
        gatewayDiagnostics: { model: "fake", pipeline: "two-stage", stages: [], extractionCache: state, jev: JEV_DIAGNOSTICS }
      };
    } finally {
      inFlight -= 1;
    }
  };
  return { adapter, calls, maxInFlight: () => maxInFlight };
}

const byName = (result, name) => result.perActor.find((entry) => entry.name === name);
const summaries = (entry) => entry.events.map((event) => event.summary);

// ---------------------------------------------------------------------------------------------
// session-notes.js#attributeEventsToActor: the Jev rules (system-independent)

test("attributeEventsToActor trusts a confident Jev actorName over the model's and the speaker label", () => {
  assert.equal(JEV_ATTRIBUTION_CONFIDENCE, 0.6);
  const tovin = attributeEventsToActor(jevEvents(), ["Tovin"], { notes: NOTES });
  const luz = attributeEventsToActor(jevEvents(), ["Luz"], { notes: NOTES });
  const kill = (list) => list.find((event) => /surrendered/.test(event.summary));
  assert.ok(kill(tovin.kept), "Tovin is credited with the kill Luz reported");
  assert.equal(kill(tovin.kept).actorName, "Tovin", "the kept event names the doer, not the reporter");
  assert.equal(kill(luz.kept), undefined, "Luz, the witness, is not");
  assert.ok(luz.attributedToOthers.some((entry) => entry.actorName === "Tovin" && /surrendered/.test(entry.summary)));
  // Exactly at the threshold counts; just under does not.
  const at = { ...ev("Did it.", ["martial"]), actorName: "Luz", jev: { actorName: "Tovin", actorConfidence: 0.6 } };
  const under = { ...at, jev: { actorName: "Tovin", actorConfidence: 0.59 } };
  assert.equal(attributeEventsToActor([at], ["Tovin"]).kept.length, 1);
  assert.equal(attributeEventsToActor([under], ["Tovin"]).kept.length, 0);
});

test("attributeEventsToActor: Jev whole-party goes to everyone under the group label; low confidence and no jev change nothing", () => {
  assert.equal(WHOLE_PARTY_ACTOR, "the party");
  for (const name of ["Brakka", "Tovin", "Luz"]) {
    const { kept } = attributeEventsToActor(jevEvents(), [name], { notes: NOTES });
    const whole = kept.find((event) => /drove off a troll/.test(event.summary));
    assert.ok(whole, `${name} keeps the whole-party event`);
    assert.equal(whole.actorName, "the party", `${name}'s copy is the party's, not Brakka's`);
  }
  assert.equal(jevEvents()[4].actorName, "Brakka", "the source event is not mutated");
  const labelled = { ...ev("We drove it off.", ["martial"]), actorName: "the party", jev: { whole: true } };
  assert.equal(attributeEventsToActor([labelled], ["Luz"]).kept[0], labelled, "already labelled: same object");

  const tovin = attributeEventsToActor(jevEvents(), ["Tovin"], { notes: NOTES });
  assert.ok(!tovin.kept.some((event) => /goblins in line/.test(event.summary)), "a 0.4 Jev guess does not move Brakka's event");
  assert.ok(attributeEventsToActor(jevEvents(), ["Brakka"], { notes: NOTES }).kept.some((event) => /goblins in line/.test(event.summary)));

  // Without event.jev the old behaviour stands: the model said Luz, so Luz keeps the kill. (This is
  // exactly board 6ca3c8e7 -- the reason the Jev rule exists.)
  const plain = jevEvents().map(({ jev, ...event }) => event);
  assert.ok(attributeEventsToActor(plain, ["Luz"], { notes: NOTES }).kept.some((event) => /surrendered/.test(event.summary)));
  assert.ok(!attributeEventsToActor(plain, ["Tovin"], { notes: NOTES }).kept.some((event) => /surrendered/.test(event.summary)));
  // A confident Jev name that is the event's own actorName leaves the object untouched.
  const same = { ...ev("Tovin torched a troll.", ["fire"]), actorName: "Tovin", jev: { actorName: "Tovin", actorConfidence: 0.9 } };
  assert.equal(attributeEventsToActor([same], ["Tovin"]).kept[0], same);
});

// ---------------------------------------------------------------------------------------------
// Jev blocks survive the actor flag (dev-ui reads them as chips in the Growth dialog)

test("normalizeGrowthEvent keeps a compact jev block, and none when absent", () => {
  const base = { summary: "Tovin torched a troll.", tags: ["fire"], outcome: "success" };
  assert.equal("jev" in normalizeGrowthEvent(base, 1), false);
  assert.equal("jev" in normalizeGrowthEvent({ ...base, jev: null }, 1), false);
  assert.equal("jev" in normalizeGrowthEvent({ ...base, jev: { unknown: 1 } }, 1), false, "nothing known -> no block");

  const long = "x".repeat(100);
  const kept = normalizeGrowthEvent({
    ...base,
    jev: {
      actorName: ` ${long} `,
      actorConfidence: "0.91",
      whole: false,
      outcome: "failure",
      outcomeFrom: "success",
      flags: ["dark-act", "dark-act", 7, "", ...Array.from({ length: 10 }, (_, i) => `f${i}`)],
      probabilities: { Tovin: 0.91 }, // not a chip: dropped
      apiKey: "never"
    }
  }, 1).jev;
  assert.deepEqual(Object.keys(kept), ["actorName", "actorConfidence", "outcome", "outcomeFrom", "flags"]);
  assert.equal(kept.actorName, "x".repeat(64));
  assert.equal(kept.actorConfidence, 0.91);
  assert.equal(kept.outcome, "failure");
  assert.equal(kept.outcomeFrom, "success");
  assert.equal(kept.flags.length, 8);
  assert.deepEqual(kept.flags.slice(0, 2), ["dark-act", "f0"]);
  assert.deepEqual(normalizeGrowthEvent({ ...base, jev: { whole: true } }, 1).jev, { whole: true });
});

// ---------------------------------------------------------------------------------------------
// api.analyzePartyNotes, both systems

for (const systemId of SYSTEMS) {
  test(`[${systemId}] one extraction for 3 PCs (cache), each PC its own reading, at most 2 at a time`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      const fake = fakeCachingAdapter();
      api.setProposalAdapter(fake.adapter);
      const actors = party(systemId);
      const result = await api.analyzePartyNotes(actors, NOTES);

      assert.equal(fake.calls.extract, 1, "one extraction for the whole party");
      assert.equal(fake.calls.adapter.length, 3, "one reading (stage 2) per PC");
      assert.ok(fake.calls.adapter.every((call) => call.systemId === systemId && call.fresh === false));
      assert.equal(fake.maxInFlight(), 2, "two readings overlap, never more");

      assert.equal(result.party.extractionCalls, 1);
      assert.deepEqual(result.party.extractionCache, { hit: 2, miss: 1, off: 0, preset: 0 });
      assert.deepEqual(result.party.jev, JEV_DIAGNOSTICS);
      assert.ok(Number.isFinite(result.party.ms));
      assert.deepEqual(result.perActor.map((entry) => [entry.actorId, entry.name]), actors.map((actor) => [actor.id, actor.name]));
      for (const actor of actors) {
        const entry = byName(result, actor.name);
        assert.equal(entry.source, "adapter");
        assert.equal(entry.error, undefined);
        assert.equal(api.getGrowth(actor).events.length, entry.events.length);
        assert.equal(api.getLastAnalysis(actor).notes, NOTES);
        assert.equal(api.isBusy(actor), false);
      }
    });
  });

  test(`[${systemId}] Luz/Tovin: with Jev attribution Tovin gets the kill and Luz does not; the whole-party event goes to all`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      api.setProposalAdapter(fakeCachingAdapter().adapter);
      const actors = party(systemId);
      const result = await api.analyzePartyNotes(actors, NOTES);
      const tovin = byName(result, "Tovin");
      const luz = byName(result, "Luz");
      const brakka = byName(result, "Brakka");
      assert.deepEqual(summaries(tovin), [
        "Tovin torched a troll.",
        "Killed a goblin that had surrendered.",
        "The party drove off a troll far above their level."
      ]);
      assert.equal(tovin.events[1].actorName, "Tovin");
      assert.deepEqual(tovin.events[1].jev, { actorName: "Tovin", actorConfidence: 0.91, flags: ["dark-act"] }, "the Jev block reached the sheet");
      assert.deepEqual(summaries(luz), ["Luz healed Brakka to full.", "The party drove off a troll far above their level."]);
      assert.ok(luz.attributedToOthers.some((entry) => entry.actorName === "Tovin" && /surrendered/.test(entry.summary)));
      assert.deepEqual(summaries(brakka), [
        "Brakka held the bridge against a troll.",
        "The party drove off a troll far above their level.",
        "Brakka kept the goblins in line."
      ]);
      for (const actor of actors) {
        const copy = api.getGrowth(actor).events.find((event) => /drove off a troll/.test(event.summary));
        assert.equal(copy.actorName, "the party");
        assert.deepEqual(copy.jev, { actorConfidence: 0.84, whole: true });
      }
      // 6 distinct events, 1 of them whole-party: every other event is credited exactly once.
      const total = result.perActor.reduce((sum, entry) => sum + entry.events.length, 0);
      assert.equal(total, 6 - 1 + 3);
    });
  });

  test(`[${systemId}] one PC's failure lands on its entry only; accepted proposals keep their jev block`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      const ranked = { ...skillProposal("Pyre Hand", ["Tovin torched a troll."]), jev: { grounded: 3, fit: 2, confidence: 0.8 } };
      const plain = skillProposal("Ember Step", ["Tovin torched a troll."], ["mobility"]);
      const fake = fakeCachingAdapter({ proposals: { Luz: new Error("model timed out"), Tovin: [ranked, plain] } });
      api.setProposalAdapter(fake.adapter);
      const actors = party(systemId);
      const result = await api.analyzePartyNotes(actors, NOTES);
      const luz = byName(result, "Luz");
      const tovin = byName(result, "Tovin");
      const brakka = byName(result, "Brakka");

      // The provider died on Luz's reading: analyzeSessionNotes' own fallback applies (never lose
      // the notes), so she is analysed locally with the reason, and nobody else notices.
      assert.equal(luz.source, "local-fallback");
      assert.equal(luz.adapterError, "model timed out");
      assert.ok(luz.events.length > 0, "Luz's notes were still read");
      assert.equal(brakka.source, "adapter");
      assert.equal(tovin.source, "adapter");

      const pyre = tovin.proposals.find((proposal) => proposal.entry.name === "Pyre Hand");
      assert.ok(pyre && pyre.source === "ai-gateway");
      assert.deepEqual(pyre.jev, { grounded: 3, fit: 2, confidence: 0.8 });
      assert.equal("jev" in tovin.proposals.find((proposal) => proposal.entry.name === "Ember Step"), false);
      assert.deepEqual(api.getGrowth(actors[1]).proposals.find((proposal) => proposal.entry.name === "Pyre Hand").jev, { grounded: 3, fit: 2, confidence: 0.8 }, "stored, not just returned");
    });
  });

  test(`[${systemId}] a PC whose sheet refuses the write gets { error }; the others complete`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      const fake = fakeCachingAdapter();
      api.setProposalAdapter(fake.adapter);
      const actors = party(systemId);
      actors[1].update = async () => { throw new Error("sheet is read-only"); };
      const result = await api.analyzePartyNotes(actors, NOTES);
      assert.deepEqual(byName(result, "Tovin"), { actorId: actors[1].id, name: "Tovin", error: "sheet is read-only" });
      assert.equal(api.isBusy(actors[1]), false, "the lock is released");
      assert.equal(byName(result, "Brakka").events.length, 3);
      assert.equal(byName(result, "Luz").events.length, 2);
      assert.equal(fake.calls.extract, 1);
    });
  });

  test(`[${systemId}] a busy PC is skipped with a reason; fresh re-extracts exactly once; duplicates analysed once`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      const fake = fakeCachingAdapter();
      api.setProposalAdapter(fake.adapter);
      const actors = party(systemId);
      await api.analyzePartyNotes(actors, NOTES);
      assert.equal(fake.calls.extract, 1);

      // Luz is mid-rest when the GM clicks Analyze party.
      let release;
      const resting = api._withActorLock(actors[2], "rest", () => new Promise((resolve) => { release = resolve; }));
      const second = await api.analyzePartyNotes([...actors, actors[0]], NOTES, { fresh: true });
      release();
      await resting;
      assert.deepEqual(byName(second, "Luz"), { actorId: actors[2].id, name: "Luz", skipped: "busy", busyWith: "rest" });
      assert.equal(second.perActor.length, 3, "Brakka twice is Brakka once");
      assert.equal(fake.calls.extract, 2, "fresh re-extracted once, the second PC reused it");
      assert.deepEqual(second.party.extractionCache, { hit: 1, miss: 1, off: 0, preset: 0 });
      assert.equal(second.party.extractionCalls, 1);
    });
  });

  test(`[${systemId}] no adapter: every PC is read locally, no extraction, no jev`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      const result = await api.analyzePartyNotes(party(systemId), NOTES);
      assert.ok(result.perActor.every((entry) => entry.source === "local" && entry.events.length > 0));
      assert.deepEqual(result.party.extractionCache, { hit: 0, miss: 0, off: 0, preset: 0 });
      assert.equal(result.party.extractionCalls, 0);
      assert.equal(result.party.jev, null);
      // Speaker labels still route events without the model: Tovin's torching is his alone.
      assert.ok(byName(result, "Tovin").events.some((event) => /torched/.test(event.summary)));
      assert.ok(!byName(result, "Brakka").events.some((event) => /torched/.test(event.summary)));
    });
  });

  test(`[${systemId}] GM-only, supported system, real notes`, async () => {
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      await assert.rejects(() => api.analyzePartyNotes(party(systemId), NOTES), /Only a GM/);
    }, { isGM: false });
    await withFoundry("sfrpg", async () => {
      const api = new GrandDesignApi();
      await assert.rejects(() => api.analyzePartyNotes(party(systemId), NOTES), /does not support/);
    });
    await withFoundry(systemId, async () => {
      const api = new GrandDesignApi();
      await assert.rejects(() => api.analyzePartyNotes([], NOTES), /at least one/);
      await assert.rejects(() => api.analyzePartyNotes(party(systemId), "   "), /non-empty/);
    });
  });
}

// ---------------------------------------------------------------------------------------------
// The gateway redacts config.jev.apiKey, so the "always propose" rebuild must reuse the client.

const transportStub = () => ({ async chat() { return { content: "{}", ms: 1 }; }, async ping() { return { ok: true }; }, async listModels() { return []; }, info: {} });
const gatewayExposesJev = (() => {
  try {
    return "jev" in createGatewayAdapter({ provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "m" }, { transportFactory: transportStub });
  } catch {
    return false;
  }
})();

test("_alwaysProposeAdapter hands the rebuilt adapter the same Jev client", { skip: !gatewayExposesJev && "gateway does not expose adapter.jev yet (dev-gateway)" }, async () => {
  await withFoundry("pf2e", async () => {
    const transport = transportStub();
    const jev = { ask: async () => ({ answers: {} }), info: { endpoint: "x", model: "jev-latest" } };
    const adapter = createGatewayAdapter(
      { provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "m", proposalMode: "never", jev: { enabled: true, apiKey: "secret" } },
      { transportFactory: () => transport, jevFactory: () => jev }
    );
    assert.equal(adapter.jev, jev);
    const api = new GrandDesignApi();
    api.setProposalAdapter(adapter);
    const rebuilt = api._alwaysProposeAdapter();
    assert.notEqual(rebuilt, adapter, "a 'never' adapter is rebuilt");
    assert.equal(rebuilt.jev, jev, "same client, not a redacted rebuild");
    assert.equal(rebuilt.transport, transport);
  });
});

test("_alwaysProposeAdapter tolerates an adapter without a Jev client", async () => {
  await withFoundry("pf2e", async () => {
    const transport = transportStub();
    const adapter = createGatewayAdapter({ provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "m", proposalMode: "never" }, { transportFactory: () => transport });
    const api = new GrandDesignApi();
    api.setProposalAdapter(adapter);
    const rebuilt = api._alwaysProposeAdapter();
    assert.notEqual(rebuilt, adapter);
    assert.equal(rebuilt.config.proposalMode, "always");
    assert.equal(rebuilt.transport, transport);
    assert.ok(rebuilt.jev === undefined || rebuilt.jev === null);
  });
});
