// Structured mechanics in proposal Details and the Edit form (board 5a0cea2e, UI half; batch 3
// contract section 2). entry.mechanics.structured and the validator's clamp report are written in
// parallel: the renderer reads every plausible clamp location, and wording follows each system.
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildProposalPatch,
  buildStructuredFromFields,
  collectMechanicsClamps,
  describeStructuredMechanics,
  readEditFields,
  renderProposal,
  renderProposalDetails,
  renderStructuredEditor
} from "../scripts/growth-ui.js";

const pf2eStructured = {
  damage: [{ dice: "2d6", type: "fire", bonus: 2 }, { dice: "1d4", type: "persistent-bleed" }],
  save: { save: "reflex", dc: "class", basic: true },
  modifiers: [{ value: 1, type: "circumstance", selector: "ac", predicate: "while holding the bridge" }, { value: -1, type: "status", selector: "save:will" }],
  area: { type: "cone", value: 15 },
  range: { value: 30, units: "ft" },
  condition: { id: "frightened", value: 1, duration: "until the end of your next turn" },
  uses: { max: 1, per: "day" }
};

const dnd5eStructured = {
  attack: { kind: "melee" },
  damage: [{ dice: "1d8", type: "radiant" }],
  heal: { dice: "1d8", bonus: 3 },
  save: { save: "dex", dc: 15, basic: true },
  modifiers: [{ value: 2, type: "untyped", selector: "skill:athletics" }],
  advantage: { on: "save:con", condition: "against poison" },
  area: { type: "sphere", value: 20 },
  condition: { id: "prone" },
  uses: { max: 2, per: "short-rest" }
};

const labelled = (rows) => Object.fromEntries(rows.map((row, index) => [`${row.label}#${rows.slice(0, index).filter((r) => r.label === row.label).length}`, row.text]));

test("describeStructuredMechanics: PF2e wording", () => {
  const rows = labelled(describeStructuredMechanics(pf2eStructured, "pf2e"));
  assert.equal(rows["Damage#0"], "2d6+2 fire plus 1d4 persistent-bleed damage");
  assert.equal(rows["Save#0"], "basic Reflex save against your class DC");
  assert.equal(rows["Modifier#0"], "+1 circumstance bonus to AC (while holding the bridge)");
  assert.equal(rows["Modifier#1"], "-1 status penalty to Will saves");
  assert.equal(rows["Area#0"], "15-foot cone");
  assert.equal(rows["Range#0"], "30 feet");
  assert.equal(rows["Condition#0"], "frightened 1 (until the end of your next turn)");
  assert.equal(rows["Frequency#0"], "once per day");
});

test("describeStructuredMechanics: dnd5e wording", () => {
  const rows = labelled(describeStructuredMechanics(dnd5eStructured, "dnd5e"));
  assert.equal(rows["Attack#0"], "melee weapon attack against AC");
  assert.equal(rows["Damage#0"], "1d8 radiant damage");
  assert.equal(rows["Healing#0"], "restores 1d8+3 hit points");
  assert.equal(rows["Save#0"], "Dexterity saving throw, DC 15 (half damage on a success)");
  assert.equal(rows["Modifier#0"], "+2 bonus to Athletics checks", "dnd5e has no bonus types");
  assert.equal(rows["Advantage#0"], "advantage on Constitution saving throws (against poison)");
  assert.equal(rows["Area#0"], "20-foot-radius sphere");
  assert.equal(rows["Condition#0"], "Prone condition");
  assert.equal(rows["Uses#0"], "2 per short rest");
});

test("describeStructuredMechanics: cross-system parts are named, junk is skipped", () => {
  const pf2e = labelled(describeStructuredMechanics({ advantage: { on: "attack" }, uses: { max: 3, per: "long-rest" }, save: { save: "will", dc: "spell" }, attack: { kind: "spell" } }, "pf2e"));
  assert.equal(pf2e["Advantage#0"], "advantage on attack rolls: a dnd5e rule, ignored in PF2e");
  assert.equal(pf2e["Frequency#0"], "3 times per day");
  assert.equal(pf2e["Save#0"], "Will save against your spell DC");
  assert.equal(pf2e["Attack#0"], "spell attack roll against AC");
  const dnd = labelled(describeStructuredMechanics({ save: { save: "wis", dc: "class" }, uses: { max: 1, per: "encounter" } }, "dnd5e"));
  assert.equal(dnd["Save#0"], "Wisdom saving throw, DC 8 + proficiency bonus + ability modifier");
  assert.equal(dnd["Uses#0"], "1 per short rest");
  assert.deepEqual(describeStructuredMechanics({ damage: [{}, null], modifiers: [{ value: "x" }], range: { value: 0 } }, "pf2e"), []);
  assert.deepEqual(describeStructuredMechanics(null), []);
});

test("collectMechanicsClamps: strings and objects, from every plausible location, deduplicated", () => {
  const proposal = {
    clamps: ["damage dice 4d6 -> 2d6 (tier 1 budget)"],
    validation: { clamps: [{ field: "modifiers[0].value", from: 3, to: 1, reason: "PF2e tier 1 circumstance cap" }] },
    entry: { mechanics: { structuredClamps: [{ path: "advantage", from: "attack", to: null, message: "not a PF2e rule" }, "damage dice 4d6 -> 2d6 (tier 1 budget)"] } }
  };
  assert.deepEqual(collectMechanicsClamps(proposal), [
    "damage dice 4d6 -> 2d6 (tier 1 budget)",
    "modifiers[0].value: 3 -> 1 (PF2e tier 1 circumstance cap)",
    "advantage: attack -> removed (not a PF2e rule)"
  ]);
  // An updateProposal result ({ ok, proposal, clamps }).
  assert.deepEqual(collectMechanicsClamps({ ok: true, proposal: { clamped: ["uses 5 -> 3"] } }), ["uses 5 -> 3"]);
  assert.deepEqual(collectMechanicsClamps(null), []);
});

test("proposal Details render the structured mechanics in the world's system wording, plus the clamps", () => {
  const proposal = {
    id: "p1", status: "pending", kind: "skill", source: "ai-gateway",
    clamps: [{ field: "modifiers[0].value", from: 3, to: 1, reason: "tier 1 cap" }],
    entry: { name: "Bridge Warden's Stance", tier: 1, mechanics: { effect: "Hold the line.", structured: pf2eStructured } }
  };
  const pf2e = renderProposalDetails(proposal, new Map(), { systemId: "pf2e" });
  assert.match(pf2e, /Game mechanics \(PF2e\)/);
  assert.match(pf2e, /<dt>Save<\/dt><dd>basic Reflex save against your class DC<\/dd>/);
  assert.match(pf2e, /The validator adjusted it/);
  assert.match(pf2e, /modifiers\[0\]\.value: 3 -&gt; 1 \(tier 1 cap\)/);
  const dnd = renderProposalDetails({ ...proposal, entry: { ...proposal.entry, mechanics: { effect: "x", structured: dnd5eStructured } } }, new Map(), { systemId: "dnd5e" });
  assert.match(dnd, /Game mechanics \(D&amp;D 5e\)/);
  assert.match(dnd, /Dexterity saving throw, DC 15/);
  // The item the proposal builds wins over the world's system.
  const own = renderProposalDetails({ ...proposal, entry: { ...proposal.entry, gameItem: { system: "dnd5e" } } }, new Map(), { systemId: "pf2e" });
  assert.match(own, /Game mechanics \(D&amp;D 5e\)/);
  // No structured block and no clamps: nothing extra.
  assert.doesNotMatch(renderProposalDetails({ id: "p", kind: "skill", entry: { mechanics: { effect: "x" } } }), /gd-structured/);
});

test("Edit form carries the structured editor for Skills and Classes (per system), not for Titles", () => {
  const skill = { id: "p1", status: "pending", kind: "skill", entry: { name: "S", tier: 1, mechanics: { effect: "x", structured: pf2eStructured } } };
  const pf2e = renderProposal(skill, { canEdit: true, systemId: "pf2e" });
  assert.match(pf2e, /gd-structured-edit/);
  assert.match(pf2e, /data-field="s\.damage\.0\.dice" value="2d6"/);
  assert.match(pf2e, /data-field="s\.damage\.2\.dice" value=""/, "one blank row to add a damage part");
  assert.match(pf2e, /<option value="reflex" selected>/);
  assert.match(pf2e, /data-field="s\.save\.basic" checked/);
  assert.match(pf2e, /select data-field="s\.modifiers\.0\.type"/);
  assert.doesNotMatch(pf2e, /s\.advantage\.on/, "no advantage on PF2e");
  assert.match(pf2e, /<option value="burst">/);
  const dnd = renderProposal({ ...skill, entry: { ...skill.entry, mechanics: { effect: "x", structured: dnd5eStructured } } }, { canEdit: true, systemId: "dnd5e" });
  assert.match(dnd, /data-field="s\.advantage\.on" value="save:con"/);
  assert.match(dnd, /<option value="dex" selected>/);
  assert.match(dnd, /type="hidden" data-field="s\.modifiers\.0\.type" value="untyped"/);
  assert.match(dnd, /<option value="sphere" selected>/);
  const title = renderProposal({ id: "t", status: "pending", kind: "title", entry: { name: "Trollbane", description: "d" } }, { canEdit: true, systemId: "dnd5e" });
  assert.doesNotMatch(title, /gd-structured-edit/);
  assert.match(renderStructuredEditor(null, "pf2e"), /s\.heal\.dice/);
});

// The form's own fields, as readEditFields would read them from the rendered editor.
function fieldsFromHtml(html) {
  const fields = {};
  for (const match of html.matchAll(/<input type="(\w+)" data-field="([^"]+)"(?: value="([^"]*)")?([^>]*)>/g)) {
    fields[match[2]] = match[1] === "checkbox" ? (/checked/.test(match[4]) ? "true" : "") : (match[3] ?? "");
  }
  for (const match of html.matchAll(/<select data-field="([^"]+)">([^]*?)<\/select>/g)) {
    fields[match[1]] = /<option value="([^"]*)" selected>/.exec(match[2])?.[1] ?? "";
  }
  return fields;
}

test("round trip: an untouched structured editor gives back the same structured mechanics (both systems)", () => {
  for (const [systemId, structured] of [["pf2e", pf2eStructured], ["dnd5e", dnd5eStructured]]) {
    const fields = fieldsFromHtml(renderStructuredEditor(structured, systemId));
    const { structured: rebuilt, errors } = buildStructuredFromFields(fields, structured);
    assert.deepEqual(errors, [], systemId);
    assert.deepEqual(rebuilt, structured, systemId);
  }
});

test("buildProposalPatch: edits the structured mechanics and patches { entry } with mechanics.structured", () => {
  const proposal = { id: "p1", kind: "skill", entry: { name: "S", tier: 1, mechanics: { effect: "x", structured: pf2eStructured }, metadata: {} } };
  const fields = fieldsFromHtml(renderStructuredEditor(pf2eStructured, "pf2e"));
  Object.assign(fields, {
    "s.damage.0.dice": "3d6", "s.damage.1.dice": "", "s.damage.1.type": "", // second part removed
    "s.damage.2.dice": "1d6", "s.damage.2.type": "cold", // a new part
    "s.modifiers.1.value": "", "s.modifiers.1.selector": "", "s.modifiers.1.predicate": "", // modifier removed
    "s.save.basic": "", "s.save.dc": "21",
    "s.area.type": "", "s.area.value": "",
    "s.uses.max": "2", "s.uses.per": "hour"
  });
  const { patch, errors } = buildProposalPatch(proposal, fields);
  assert.deepEqual(errors, []);
  const structured = patch.entry.mechanics.structured;
  assert.deepEqual(structured.damage, [{ dice: "3d6", type: "fire", bonus: 2 }, { dice: "1d6", type: "cold" }]);
  assert.deepEqual(structured.modifiers, [pf2eStructured.modifiers[0]]);
  assert.deepEqual(structured.save, { save: "reflex", dc: 21 });
  assert.equal(structured.area, undefined);
  assert.deepEqual(structured.uses, { max: 2, per: "hour" });
  assert.equal(patch.entry.mechanics.effect, "x", "prose effect untouched");
  assert.deepEqual(proposal.entry.mechanics.structured, pf2eStructured, "the original is never mutated");
});

test("buildProposalPatch: emptying every part removes mechanics.structured; mistakes are reported in the form", () => {
  const proposal = { id: "p1", kind: "skill", entry: { name: "S", tier: 1, mechanics: { effect: "x", structured: { range: { value: 30, units: "ft" } } } } };
  const empty = Object.fromEntries(Object.keys(fieldsFromHtml(renderStructuredEditor(proposal.entry.mechanics.structured, "dnd5e"))).map((key) => [key, /^s\.modifiers\.\d+\.type$/.test(key) ? "untyped" : ""]));
  const cleared = buildProposalPatch(proposal, empty);
  assert.deepEqual(cleared.errors, []);
  assert.equal(Object.hasOwn(cleared.patch.entry.mechanics, "structured"), false);

  const { errors } = buildProposalPatch(proposal, {
    "s.damage.0.dice": "2d7", "s.damage.1.dice": "", "s.damage.1.type": "fire",
    "s.save.save": "", "s.save.dc": "15",
    "s.modifiers.0.value": "2", "s.modifiers.0.type": "untyped", "s.modifiers.0.selector": "armor",
    "s.modifiers.1.value": "", "s.modifiers.1.type": "untyped", "s.modifiers.1.selector": "ac",
    "s.advantage.on": "everything",
    "s.area.type": "cone", "s.area.value": "",
    "s.uses.max": "0", "s.uses.per": "day"
  });
  assert.equal(errors.length, 8, errors.join("\n"));
  assert.ok(errors.some((error) => /dice like 2d6/.test(error)));
  assert.ok(errors.some((error) => /needs dice/.test(error)));
  assert.ok(errors.some((error) => /which save/.test(error)));
  assert.ok(errors.some((error) => /what it modifies/.test(error)));
  assert.ok(errors.some((error) => /needs a value/.test(error)));
  assert.ok(errors.some((error) => /Advantage must be on/.test(error)));
  assert.ok(errors.some((error) => /size in feet/.test(error)));
  assert.ok(errors.some((error) => /^Uses must be a whole number of 1 or more/.test(error)));
});

test("buildProposalPatch without structured fields leaves mechanics.structured alone (older forms, Titles)", () => {
  const proposal = { id: "p1", kind: "skill", entry: { name: "S", tier: 1, mechanics: { effect: "x", structured: dnd5eStructured } } };
  const { patch } = buildProposalPatch(proposal, { name: "Renamed" });
  assert.deepEqual(patch.entry.mechanics.structured, dnd5eStructured);
});

test("readEditFields reads a checkbox as 'true' or ''", () => {
  const node = (field, props) => ({ dataset: { field }, ...props });
  const form = { querySelectorAll: () => [node("s.save.basic", { type: "checkbox", checked: true, value: "on" }), node("s.heal.dice", { type: "text", value: "1d8" }), node("x", { type: "checkbox", checked: false, value: "on" })] };
  assert.deepEqual(readEditFields(form), { "s.save.basic": "true", "s.heal.dice": "1d8", x: "" });
});
