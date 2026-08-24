import assert from "node:assert/strict";
import test from "node:test";

import { buildClassFlavoredName, deriveClassMotif } from "../scripts/naming.js";

test("deriveClassMotif strips a generic class suffix and adds a themed one from the class's own tags", () => {
  const spearmaster = { name: "Spearmaster", metadata: { tags: ["martial", "precision"] } };
  assert.equal(deriveClassMotif(spearmaster), "Speartip");
});

test("buildClassFlavoredName ties a generated proposal's name to the character's own class", () => {
  const spearmaster = { name: "Spearmaster", metadata: { tags: ["martial", "precision"] } };
  assert.equal(buildClassFlavoredName(spearmaster, "Undead's Bane"), "Speartip: Undead's Bane");
});

test("a different class's tags produce a different, still-on-theme motif for the same suffix shape", () => {
  const hexweaver = { name: "Hexweaver", metadata: { tags: ["occult", "spellcasting"] } };
  // "weaver" is a generic suffix, stripped to root "Hex"; among the class's tags, spellcasting
  // outranks occult in MOTIF_SUFFIX_PRIORITY, so it wins the theme lookup.
  assert.equal(deriveClassMotif(hexweaver), "Hexrune");
  assert.equal(buildClassFlavoredName(hexweaver, "The Third Eye"), "Hexrune: The Third Eye");
});

test("a class name with no generic suffix keeps its own distinctive root as the motif", () => {
  const emberkin = { name: "Emberkin", metadata: { tags: ["fire"] } };
  assert.equal(deriveClassMotif(emberkin), "Emberkin");
});

test("a class name with no usable root at all falls back to a tag-based motif", () => {
  const theMaster = { name: "The Master", metadata: { tags: ["defense"] } };
  assert.equal(deriveClassMotif(theMaster), "Bulwark");
});

test("a class with neither a usable name nor recognized tags falls back to the default motif", () => {
  assert.equal(deriveClassMotif({ name: "", metadata: { tags: [] } }), "Path");
  assert.equal(deriveClassMotif(undefined), "Path");
});

test("buildClassFlavoredName requires a non-empty concept name", () => {
  const spearmaster = { name: "Spearmaster", metadata: { tags: ["martial"] } };
  assert.throws(() => buildClassFlavoredName(spearmaster, ""), /concept name/i);
  assert.throws(() => buildClassFlavoredName(spearmaster, "   "), /concept name/i);
});

// --- Red (taboo/debuffing) class motifs -----------------------------------------------------

test("a red class motifs from its vice, not its gameplay tags -- a bloodlust-vice class reads dark, not heroic", () => {
  const bloodboundReaver = {
    name: "Bloodbound Reaver",
    metadata: { tags: ["martial"], polarity: "red", malignance: { vice: "bloodlust", drawback: "Cannot disengage from a bloodied foe." } }
  };
  // "Reaver" ends in a generic suffix ("bound" isn't one, "Reaver" itself isn't stripped since
  // the root word picked is "Bloodbound" -- stripped of no generic suffix -- so the motif is the
  // stripped root as-is, matching the non-red code path for a name with a distinctive root.
  assert.equal(deriveClassMotif(bloodboundReaver), "Bloodbound");
});

test("a red class whose root strips a generic suffix picks its dark suffix from the vice, not a gameplay tag", () => {
  const bloodwarden = {
    name: "Bloodwarden",
    metadata: { tags: ["martial"], polarity: "red", malignance: { vice: "bloodlust", drawback: "Must attack the nearest bloodied creature first." } }
  };
  // "warden" is a generic suffix -> root "Blood"; vice "bloodlust" supplies suffix "reaver".
  assert.equal(deriveClassMotif(bloodwarden), "Bloodreaver");
  assert.equal(buildClassFlavoredName(bloodwarden, "First Kill"), "Bloodreaver: First Kill");
});

test("a red class with no usable name root falls back to the vice's own dark word, not the heroic tag-based fallback", () => {
  const theWarden = {
    name: "The Warden",
    metadata: { tags: ["defense"], polarity: "red", malignance: { vice: "subjugation", drawback: "Allies within 30 feet suffer disadvantage on saves against fear." } }
  };
  assert.equal(deriveClassMotif(theWarden), "Chain");
});

test("a standard (non-red) class with the same name/tags is unaffected -- polarity is what switches the table, not vice presence alone", () => {
  const theWarden = { name: "The Warden", metadata: { tags: ["defense"] } };
  assert.equal(deriveClassMotif(theWarden), "Bulwark");
});
