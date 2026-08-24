// Generated proposal names should read as belonging to the character's own class rather than as
// a generic template label -- e.g. for a "Spearmaster" class, an Undead-Slayer-style ability
// should read as "Speartip: Undead's Bane", not just "Undead Slayer". This module derives a
// short, class-flavored motif from a Class entry and uses it to prefix a proposal's own concept
// name. Deterministic (no Math.random / Date.now) so it's safe to call from anywhere, including
// plain Node tests.

// Words that describe a class's *role* rather than its identity -- stripped off the end of a
// compound class name (e.g. "Spearmaster" -> "Spear") so the motif reads as a thing, not a title.
const GENERIC_CLASS_SUFFIXES = [
  "master", "walker", "keeper", "warden", "adept", "knight", "guard", "wright",
  "sworn", "born", "touched", "bringer", "bearer", "ranger", "singer", "weaver"
];
// Standalone words too generic to be a motif on their own if a class name happens to be built
// entirely out of them (e.g. "The Master" or "Path Walker").
const GENERIC_CLASS_WORDS = new Set(["the", "of", "and", "a", "an", ...GENERIC_CLASS_SUFFIXES]);

// When a generic suffix is stripped off, the bare root often wants a themed one-word ending to
// still read as a motif ("Spear" alone is a weapon, not yet a title fragment; "Speartip" is).
// Picked by the class's own tags, in priority order, so the result stays tied to what the class
// actually does rather than to word-shape alone.
const MOTIF_SUFFIX_PRIORITY = [
  "martial", "precision", "defense", "ranged", "spellcasting", "arcane", "divine", "occult",
  "primal", "fire", "cold", "electricity", "earth", "air", "stealth", "craft", "alchemy",
  "medicine", "leadership", "support", "survival", "mobility", "summoning", "water"
];
const MOTIF_SUFFIX_BY_TAG = {
  martial: "tip", precision: "point", defense: "ward", ranged: "nock",
  spellcasting: "rune", arcane: "sigil", divine: "seal", occult: "veil", primal: "root",
  fire: "ember", cold: "rime", electricity: "spark", earth: "shard", air: "wisp",
  stealth: "shade", craft: "forge", alchemy: "vial", medicine: "salve",
  leadership: "banner", support: "hearth", survival: "trail", mobility: "stride",
  summoning: "bond", water: "tide"
};
// Fallback motif word banks, also keyed by tag, for a class whose name carries no distinctive
// root at all (e.g. it's entirely built from generic words).
const MOTIF_FALLBACK_BY_TAG = {
  martial: "Blade", precision: "Edge", defense: "Bulwark", ranged: "Arrow",
  spellcasting: "Rune", arcane: "Sigil", divine: "Grace", occult: "Veil", primal: "Root",
  fire: "Ember", cold: "Frost", electricity: "Storm", earth: "Stone", air: "Gale",
  stealth: "Shade", craft: "Forge", alchemy: "Vial", medicine: "Salve",
  leadership: "Banner", support: "Hearth", survival: "Trail", mobility: "Stride",
  summoning: "Bond", water: "Tide"
};
const DEFAULT_MOTIF = "Path";

// Dark counterparts to MOTIF_SUFFIX_BY_TAG / MOTIF_FALLBACK_BY_TAG, keyed by vice (see
// vice-taxonomy.js) instead of gameplay tag. A "red" Class/Skill (metadata.polarity === "red")
// carries a single metadata.malignance.vice rather than a priority list of tags, so the lookup
// here is a direct table hit, not a priority scan.
const RED_MOTIF_SUFFIX_BY_VICE = {
  bloodlust: "reaver", cruelty: "thorn", subjugation: "chain", servitude: "yoke",
  addiction: "thirst", corruption: "rot", desecration: "blight", betrayal: "knife", ruin: "ash"
};
const RED_MOTIF_FALLBACK_BY_VICE = {
  bloodlust: "Reaver", cruelty: "Thorn", subjugation: "Chain", servitude: "Yoke",
  addiction: "Thirst", corruption: "Rot", desecration: "Blight", betrayal: "Knife", ruin: "Ash"
};

/**
 * Derives a short, class-flavored motif word from a Class entry, e.g. { name: "Spearmaster",
 * metadata: { tags: ["martial", "precision"] } } -> "Speartip". Prefers the class's own name
 * (stripping a generic role suffix, then adding a themed one back based on the class's tags);
 * falls back to a pure tag-based word bank if the name has no usable root at all.
 *
 * A "red" class (metadata.polarity === "red", see vice-taxonomy.js) is motif'd from its
 * metadata.malignance.vice instead of its gameplay tags, so a generated proposal for a taboo
 * class reads with a matching dark flavor (e.g. a bloodlust-vice class motifs toward "-reaver"/
 * "Reaver" rather than a heroic "-tip"/"Blade").
 */
export function deriveClassMotif(characterClass) {
  const vice = characterClass?.metadata?.polarity === "red" ? characterClass?.metadata?.malignance?.vice : null;
  const tagOrder = orderedTags(characterClass?.metadata?.tags);
  const { root, suffixStripped } = extractCoreWord(characterClass?.name);
  if (root) {
    if (!suffixStripped) return capitalize(root);
    const suffix = vice ? RED_MOTIF_SUFFIX_BY_VICE[vice] : firstMatch(tagOrder, MOTIF_SUFFIX_BY_TAG);
    return suffix ? `${capitalize(root)}${suffix}` : capitalize(root);
  }
  if (vice && RED_MOTIF_FALLBACK_BY_VICE[vice]) return RED_MOTIF_FALLBACK_BY_VICE[vice];
  return firstMatch(tagOrder, MOTIF_FALLBACK_BY_TAG) ?? DEFAULT_MOTIF;
}

/**
 * Builds a full class-flavored proposal name: "{motif}: {conceptName}". `conceptName` is the
 * proposal's own idea (e.g. "Undead's Bane", from a session note about repeatedly fighting the
 * undead) -- this function only supplies the class-tied prefix, matching the module's naming
 * convention for both generated Skill proposals and Class evolutions.
 */
export function buildClassFlavoredName(characterClass, conceptName) {
  if (typeof conceptName !== "string" || !conceptName.trim()) {
    throw new Error("A concept name is required to build a class-flavored proposal name.");
  }
  return `${deriveClassMotif(characterClass)}: ${conceptName.trim()}`;
}

function extractCoreWord(name) {
  if (typeof name !== "string" || !name.trim()) return { root: null, suffixStripped: false };
  const words = name
    .split(/[\s'-]+/)
    .map((word) => word.replace(/[^A-Za-z]/g, ""))
    .filter(Boolean);
  for (const word of words) {
    if (word.length <= 2 || GENERIC_CLASS_WORDS.has(word.toLowerCase())) continue;
    const stripped = stripClassSuffix(word);
    if (stripped) return { root: stripped, suffixStripped: true };
    return { root: word, suffixStripped: false };
  }
  return { root: null, suffixStripped: false };
}

function stripClassSuffix(word) {
  const lower = word.toLowerCase();
  const suffix = GENERIC_CLASS_SUFFIXES.find(
    (candidate) => lower.endsWith(candidate) && lower.length > candidate.length + 2
  );
  return suffix ? word.slice(0, word.length - suffix.length) : null;
}

function orderedTags(tags) {
  return Array.isArray(tags) ? tags : [];
}

function firstMatch(tags, table) {
  const tagSet = new Set(tags);
  const match = MOTIF_SUFFIX_PRIORITY.find((tag) => tagSet.has(tag) && table[tag]);
  return match ? table[match] : undefined;
}

function capitalize(word) {
  return word.length ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word;
}
