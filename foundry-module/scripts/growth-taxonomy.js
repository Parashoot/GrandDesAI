// Each entry is [tag, pattern]. These are matched against one sentence of a GM's session notes.
//
// Calibration note (2026-08-24): the original patterns were written against the module's own
// fixture prose and badly underfit real notes -- a 30-sentence sample of ordinary session writing
// matched a tag on only 7 sentences, and several of those were false positives fired by scenery
// NOUNS rather than anything a character did ("the first guard's blade" tagging `defense` off the
// noun "guard"; "the ledgers had already been burned" tagging `fire`). Meanwhile obvious evidence
// went untagged because only one inflection of a verb was listed -- `parry` did not match
// "parried", `fight(?:ing)?` did not match "fought", and `lockpick` did not match "picked the
// lock". The patterns below cover the inflections people actually write, and lean on
// describesNoAction() (see below) to drop intent-only and background sentences instead of trying
// to encode that distinction into every individual pattern.
export const GROWTH_TAXONOMY = [
  ["acrobatics", /\b(balance[ds]?|balancing|tumbl(?:e|ed|ing)|tightrope|somersault(?:ed|ing)?|vault(?:ed|ing)?|twist(?:ed|ing)? (?:away|clear)|rolled (?:clear|aside|with))\b/i],
  ["arcana", /\b(arcana|runes?|arcane theory|identif(?:y|ied) magic|glyph)\b/i],
  ["athletics", /\b(grappl(?:e|es|ed|ing)|shov(?:e|es|ed|ing)|lift(?:s|ed|ing)?|sw(?:am|im|ims|imming)|force[ds]?\b[^.!?]{0,20}\bopen\b|(?:kick|bash|smash|shoulder|break)(?:ed|es|s|ing)?\b[^.!?]{0,20}\b(?:door|gate|open)\b|broke\b[^.!?]{0,12}\b(?:door|gate)\b|carr(?:y|ies|ied|ying)|haul(?:s|ed|ing)?|heav(?:e|es|ed|ing)|dragg(?:ed|ing)|drags\b|wrestl(?:e|es|ed|ing)|held (?:the )?(?:door|gate|weight)|tripp(?:ed|ing)|trips\b)\b/i],
  ["craft", /\b(craft(?:ed|ing)?|repair(?:ed|ing)?|built|build(?:ing)?|cook(?:ed|ing)?|prepar(?:e|ed|ing)|forg(?:e|ed|ing)|mend(?:ed|ing)?|rigg(?:ed|ing)|jury-?rigg(?:ed|ing)|assembl(?:e|ed|ing))\b/i],
  ["deception", /\b(deceiv(?:e|ed|ing)|bluff(?:ed|ing)?|disguis(?:e|ed|ing)|feint(?:ed|ing)?|lied|lying|passed (?:himself|herself|themselves) off|played along)\b/i],
  ["diplomacy", /\b(negotiat(?:e|ed|ing)|persuad(?:e|ed|ing)|parley(?:ed|ing)?|diploma(?:t|cy)|talked\b[^.!?]{0,24}\b(?:out of|down|around|into)|haggl(?:e|ed|ing)|argued (?:with|for|against)|smoothed (?:it|things) over|convinc(?:e|ed|ing)|steered the conversation|curtsied|bowed to)\b/i],
  ["intimidation", /\b(intimidat(?:e|ed|ing)|demoraliz(?:e|ed|ing)|threaten(?:ed|ing)?|leaned on|loomed|stared\b[^.!?]{0,24}\bdown|made\b[^.!?]{0,20}\bback off)\b/i],
  ["medicine", /\b(heal(?:ed|ing)?|treat(?:ed|ing)?|medicine|stabiliz(?:e|ed|ing)|first aid|bandag(?:e|ed|ing)|bound the wound|stitch(?:ed|ing)?|splint(?:ed|ing)?|tend(?:ed|ing)|patched (?:up|him|her|them)|staunch(?:ed|ing)?|dressing)\b/i],
  ["nature", /\b(nature|animals?|plants?|forest|wilderness|beasts?|herbs?)\b/i],
  ["occultism", /\b(occult|dreams?|psychic|spirits?|haunt(?:ed|ing)?|ritual|sigils?|wards?|ward(?:ed|ing)?|binding|incantation|banish(?:ed|ing)?|séance|seance)\b/i],
  ["performance", /\b(sing(?:ing|s)?|sang|songs?|perform(?:ed|ing)?|danc(?:e|ed|ing)|oratory|recit(?:e|ed|ing)|played (?:the )?(?:lute|fiddle|pipes))\b/i],
  ["religion", /\b(pray(?:ed|ing)?|prayers?|divine|holy|unholy|faith|deity|blessing|last rites)\b/i],
  ["society", /\b(society|city|laws?|customs?|nobles?|noble|bureaucrat|court|guild|ledgers?|seal of|house [A-Z])\b/],
  ["stealth", /\b(stealth|hid(?:e|den|ing|s)?|sneak(?:ed|ing|s)?|snuck|unseen|silent(?:ly)?|crept|creeping|slipp(?:ed|ing) (?:past|through|by)|stayed low|kept low|out of sight|shadow(?:ed|ing))\b/i],
  ["survival", /\b(track(?:ed|ing)?|forag(?:e|ed|ing)|survival|trail|camp(?:ed|ing)?|made camp|read the (?:ground|tracks|sky)|weathered)\b/i],
  ["thievery", /\b(lockpick(?:ed|ing)?|pick(?:ed|ing)? (?:the )?locks?|work(?:ed|ing)? (?:the |on the )?locks?|pickpocket(?:ed|ing)?|disabl(?:e|ed|ing)|traps?|thie(?:f|very|ves)|jimmied|slipped the latch|cut (?:the )?purse)\b/i],
  ["lore", /\b(lore|research(?:ed|ing)?|history|remember(?:ed|ing)?|recall(?:ed|ing)?|deciph(?:er|ered|ering)|piec(?:e|ed|ing)\b[^.!?]{0,40}\btogether|pored over|cross-referenc(?:e|ed|ing)|recogniz(?:e|ed|ing) the (?:seal|mark|name)|read(?:ing)?\b[^.!?]{0,20}\b(?:scroll|tome|book|text|inscription|ledger|journal|map)s?\b)\b/i],
  ["mobility", /\b(cross(?:ed|ing)?|climb(?:ed|ing)?|ran|run(?:ning)?|leap(?:ed|t|ing)?|jump(?:ed|ing)?|stride|strode|escap(?:e|ed|ing)|dash(?:ed|ing)?|crawl(?:ed|ing)?|scal(?:e|ed|ing)|sprint(?:ed|ing)?|took point)\b/i],
  ["water", /\b(canals?|rivers?|flood(?:ed|ing|s)?|water|sluice|rain|tides?|boat|swamp|dock|harbou?r|waterline)\b/i],
  ["support", /\b(help(?:ed|ing)?|aid(?:ed|ing)?|rescu(?:e|ed|ing)|protect(?:ed|ing)?|support(?:ed|ing)?|cover(?:ed|ing)? (?:him|her|them|the)|held (?:it|him|her|them) off|pulled (?:him|her|them) (?:out|clear)|carried (?:him|her|them))\b/i],
  // "drove X back" / "cut X down" originally required a pronoun object (him/her/them/it), which
  // missed the extremely common case of a GM naming the target instead ("drove the second brigand
  // back", "cuts the pack leader down"). Broadened to allow any short noun phrase between the verb
  // and its particle. Also added the present-tense/gerund forms of strike and swing -- "strikes",
  // "striking", "swings" -- which a GM writing in present tense uses just as often as "struck"/
  // "swung" but which the old patterns, suffix-only for "struck" and unsuffixed for "swung", missed.
  ["martial", /\b(strik(?:e|es|ing)|struck|attack(?:ed|ing|s)?|fight(?:ing|s)?|fought|battle|defend(?:ed|ing)?|parr(?:y|ied|ies|ying)|swing(?:s|ing)?|swung|slash(?:ed|ing)?|stabb(?:ed|ing)|lung(?:e|ed|ing)|duel(?:ed|ling|ed)?|traded blows|dr(?:ove|ives?)\b[^.!?]{0,25}\bback\b|cuts?\b[^.!?]{0,25}\bdown\b|disarm(?:ed|ing)?|tripp(?:ed|ing)|knocked\b[^.!?]{0,20}\b(?:from|out of|off)\b)\b/i],
  ["precision", /\b(aim(?:ed|ing)?|precise(?:ly)?|careful(?:ly)?|weak point|targeted|vitals?|threaded|exact(?:ly)?)\b/i],
  // "held the gatehouse until dawn" was being dropped entirely -- and that sentence also carried a
  // danger gap, so the single most valuable kind of event the system recognizes was going in the
  // bin. Defensible positions are enumerated rather than matched as a bare "held the <anything>",
  // which would swallow "held the reins" and "held the baby".
  ["defense", /\b(block(?:ed|ing)?|shield(?:ed|ing)?|guard(?:ed|ing)\b|brac(?:e|ed|ing)|took cover|held (?:the |his |her |their )?(?:line|ground|gate|gatehouse|door|doorway|bridge|wall|pass|stair|breach|position)|held (?:it|him|her|them) off|warded off|took the (?:hit|blow)|deflect(?:ed|ing)?)\b/i],
  ["ranged", /\b(arrows?|bows?|crossbows?|thrown|threw|hurl(?:ed|ing)?|lob(?:bed|bing)?|flung|shoot(?:ing)?|shot|ranged|loosed|slings?)\b/i],
  ["leadership", /\b(lead(?:ing|s)?|led|command(?:ed|ing)?|rall(?:y|ied|ying)|organiz(?:e|ed|ing)|coordinat(?:e|ed|ing)|gave the order|kept (?:them|us) together|took charge)\b/i],
  ["alchemy", /\b(alchemy|alchemical|elixirs?|bombs?|reagents?|potions?|flasks?|distill(?:ed|ing)?)\b/i],
  ["spellcasting", /\b(spells?|cast(?:ing|s)?|magic|cantrips?|incantation)\b/i],
  ["arcane", /\b(arcane|wizard|runes?|evocation)\b/i],
  ["divine", /\b(divine|prayers?|blessing|holy)\b/i],
  ["occult", /\b(occult|dreams?|psychic|mental)\b/i],
  ["primal", /\b(primal|druid|elemental|wild)\b/i],
  ["fire", /\b(fires?|flames?|embers?|burn(?:ed|ing|s|t)?|heat|lit|ignit(?:e|ed|ing)|torch(?:ed|ing)?|scorch(?:ed|ing)?)\b/i],
  ["cold", /\b(cold|ice|frost|freez(?:e|ing)|froze|winter)\b/i],
  ["electricity", /\b(lightning|electricity|thunder|storm|shock)\b/i],
  ["earth", /\b(earth|stone|rocks?|soil|walls?|rubble)\b/i],
  ["air", /\b(air|winds?|gust|sky|flight)\b/i],
  ["summoning", /\b(summon(?:ed|ing|s)?|call(?:ed|ing)? (?:up|forth)|conjur(?:e|ed|ing)|companion)\b/i]
];

// Sentences that mention a gameplay noun but describe no action BY anyone at the table. Without
// this, the taxonomy happily tags a character's unrealized intention ("Kesh wanted to burn the
// rest of it down" -> fire) or pure background scenery ("the ledgers had already been burned" ->
// fire) as though the party had actually done the thing, which inflates evidence with events that
// never happened. Deliberately narrow: only unambiguous intent/desire framing, and only the
// "had already been ..." past-perfect-passive form that reads as prior state rather than a thing
// that just happened on screen.
// "thought about" and "considered" used to match bare, with no requirement that what followed was
// even a candidate action -- which meant "Tonight I sang the old harvest round... and for a moment
// nobody thought about the blood" (a real, completed performance) got discarded whole because an
// UNRELATED clause later in the same compound sentence happened to contain "thought about". A
// held-out complex-prose pass (2026-09-06) found this by using "thought about" as an incidental
// aside rather than as the sentence's own unrealized intent. Narrowed to require a following
// gerund (thought about burning it, considered attacking) since that is how these two phrases
// actually read when they DO describe an unrealized action; a bare noun after them ("the blood",
// "her options") does not. "debated whether"/"argued about whether" are left as-is -- they inherently
// pair with a specific deliberated choice and were not the source of this false positive.
const INTENT_ONLY_PATTERN =
  /\b(want(?:ed|s)? to|plan(?:ned|s|ning)? to|(?:am|is|are|'re|'m) (?:going|planning|hoping) to|next session|gonna|mean(?:t|s) to|hop(?:ed|es) to|intend(?:ed|s)? to|(?:was|were) going to|thought about \w+ing|considered \w+ing|debated whether|argued about whether|wished (?:he|she|they) could)\b/i;
const BACKGROUND_STATE_PATTERN = /\bhad already been\b/i;

// A held-out adversarial pass (2026-09-02) found a second way a sentence names a gameplay verb
// without describing anyone doing the thing: an attempt that explicitly did not happen at all.
// "She never even tried to persuade the guard" reads, on the taxonomy alone, as a successful
// diplomacy check -- it contains "persuade" and nothing else -- when the sentence's entire point is
// that nobody acted. This is a different shape than INTENT_ONLY_PATTERN (which catches "wanted to
// X", a desire that may or may not have been acted on) and needs its own pattern rather than a
// broadened one, since "never tried" and "wanted to" don't share wording.
// "never bothered to" originally required an explicit "nobody"/"no one" subject, and missed the
// equally common case of a NAMED character doing the not-doing ("Torv never bothered to check the
// reliquary for wards"), found in the same complex-prose pass noted above.
// "she didn't fight -- she talked" is a common way to narrate CHOOSING diplomacy over combat, and
// it contains the literal word "fight" -- which the `martial` pattern matched as if a fight had
// happened, from the same complex-prose pass noted above. This is a different thing from "didn't
// manage to fight" (a real, failed attempt, still evidence -- see outcomeFromSentence's failure
// list): "didn't fight" at all is not an attempt of any kind. Scoped to fight/attack specifically,
// the two verbs a GM is most likely to explicitly negate this way ("they didn't fight" / "she
// didn't attack") -- not a blanket "didn't <verb>" rule, which would also wrongly swallow a genuine
// double-negative like "didn't fumble it" (that IS a success).
const NEGATED_ATTEMPT_PATTERN =
  /\b(never (?:even )?tried|(?:refused|declined) to (?:even )?(?:try|attempt)|never bothered to|nobody (?:bothered|tried)|no one (?:bothered|tried)|didn'?t (?:even )?(?:try|bother|attempt)|(?:didn'?t|did not) (?:fight|attack))\b/i;

export function describesNoAction(sentence) {
  if (INTENT_ONLY_PATTERN.test(sentence) || BACKGROUND_STATE_PATTERN.test(sentence) || NEGATED_ATTEMPT_PATTERN.test(sentence)) {
    return true;
  }
  // A question ("Did anyone actually check the door for traps?") asks whether something happened;
  // it is not itself an assertion that it did. GM notes are overwhelmingly declarative, so this
  // costs nothing on real prose and closes off a sentence shape the taxonomy has no other way to
  // recognize as non-evidence.
  if (sentence.trim().endsWith("?")) return true;
  return false;
}

// Tags whose patterns are, by necessity, mostly bare nouns describing the physical or magical
// surroundings (weather, terrain, ambient sound) rather than a verb naming something a character
// did. "Rain hammered the tin roof all night" tags cleanly as `water` with nobody at the table
// having done anything.
//
// The first version of this guard dropped every sentence whose ONLY matched tags came from this
// set, on the theory that these patterns are noun-only. That was wrong, and a pinned test caught it
// immediately: "Kesh burned the rest of it down." is a real action (arson) whose only lexical hook
// is the `fire` pattern's "burned", and "She critically secured the flooded sluice gate with a
// rope." is a real action whose only hook is `water`'s "sluice" -- both are exactly the kind of
// ordinary sentence a GM writes, and both were being discarded right alongside genuine scenery.
// Which tag fired is not what distinguishes the two cases; who or what the sentence's subject is
// does -- "Kesh burned..." / "She...secured..." name an actor, "Rain hammered...", "The walls were
// crumbling...", "It was cold..." do not. SCENERY_SUBJECT_PATTERN checks for that shape directly
// (a weather/terrain noun as the grammatical subject, paired with a stative or weather-intransitive
// verb) instead of inferring it from which tag matched, so an ambient tag is only grounds for
// dropping a sentence when the sentence itself reads as scene description.
export const AMBIENT_TAGS = new Set(["fire", "cold", "electricity", "earth", "air", "water", "nature"]);
const SCENERY_SUBJECT_PATTERN =
  /\b(it (?:was|is|had been))\b|\b(?:rain|thunder|wind|snow|fog|mist|storm|hail)\b[^.!?]{0,20}\b(?:hammered|rolled|howled|lashed|beat(?:ing)?|blew|raged|swept|pounded|drummed|whistled)\b|\b(?:walls?|ceiling|air|sky|ground|floor|river|water|weather)\b[^.!?]{0,20}\b(?:was|were|felt|smelled|looked)\b/i;

export function isAmbientOnly(tags) {
  return tags.length > 0 && tags.every((tag) => AMBIENT_TAGS.has(tag));
}

export function isAmbientScenery(sentence, tags) {
  return isAmbientOnly(tags) && SCENERY_SUBJECT_PATTERN.test(sentence);
}

// A dramatic, costly failure (getting hurt, a plan backfiring badly) is its own outcome, checked
// before the generic "critical" catch below so "critically failed" isn't misread as a critical
// success just because it contains the word "critically".
const CRITICAL_FAILURE_PATTERN =
  /\b(critically|catastrophically|disastrously)\b[^.!?]{0,30}\b(fail(?:ed|s)?|blunder(?:ed)?|backfir(?:e|ed|es))\b|\b(fail(?:ed|s)?|blunder(?:ed)?|backfir(?:e|ed|es))\b[^.!?]{0,30}\b(critically|catastrophically|disastrously)\b|\b(badly (?:hurt|injured|burned)|blew up in (?:his|her|their|its) face)\b/i;

// Canon's "counter-leveling": a lower-level character who survives a badly mismatched fight grows
// faster than the outcome alone suggests (constants.js#DANGER_GAP_MULTIPLIERS). Checked "severe"
// before "moderate" so a sentence matching both (e.g. "hopelessly outmatched and outnumbered")
// gets the stronger multiplier rather than whichever pattern happened to be listed first.
const SEVERE_DANGER_GAP_PATTERN =
  /\b(hopelessly outmatched|vastly superior|far more powerful|way out of (?:his|her|their) league|shouldn'?t have (?:survived|won|made it)|against all odds|no business (?:winning|surviving))\b/i;
const MODERATE_DANGER_GAP_PATTERN =
  /\b(outmatched|outnumbered|outgunned|barely survived|barely (?:won|escaped)|close call|tough fight|difficult opponent|higher-level foe)\b/i;

export function dangerGapFromSentence(sentence) {
  if (SEVERE_DANGER_GAP_PATTERN.test(sentence)) return "severe";
  if (MODERATE_DANGER_GAP_PATTERN.test(sentence)) return "moderate";
  return undefined;
}

// Two more shapes a held-out pass turned up, both misread as plain success because the generic
// success check only looks for a positive verb and never checks what happened to it:
//   - "He succeeded in convincing absolutely no one." contains "succeeded" but its object is a
//     negation of the very outcome the verb claims.
//   - "She nearly talked him down, but he drew his sword anyway." / "He almost picked the lock but
//     the pick snapped." -- "nearly"/"almost" paired with a "but" clause is how people write a
//     failed attempt without using any word outcomeFromSentence otherwise recognizes as failure.
// Both are checked before the generic success/failure passes below so they win.
const NEGATED_SUCCESS_OBJECT_PATTERN = /\bsucceed(?:ed|s)?\b[^.!?]{0,40}\b(no ?one|nobody|nothing|none)\b/i;
const ALMOST_BUT_PATTERN = /\b(almost|nearly)\b[^.!?]{0,60}\bbut\b/i;

// Table shorthand (2026-09-23): players and GMs write "nat 20", "nat1", "crit!", "crit fail" far
// more often than "critically succeeded". Checked before every prose pattern below because a dice
// call is the most explicit outcome statement a note can carry. "crit fail" is checked before the
// bare "crit" so it is never read as a critical success.
const SHORTHAND_CRITICAL_FAILURE_PATTERN = /\b(nat(?:ural)?\s*-?\s*1|crit(?:ical)?\s*-?\s*fail(?:ed|s|ure)?|critfail(?:ed)?)\b/i;
const SHORTHAND_CRITICAL_SUCCESS_PATTERN = /\b(nat(?:ural)?\s*-?\s*20|crit(?:s|ted|ed)?)\b/i;
// Non-native / plain-speech failure wording ("the lock is broke", "it no work", "not success").
const PLAIN_FAILURE_PATTERN =
  /\b((?:is|was|got|get|gets) broke|(?:did ?n[o']?t|does ?n[o']?t|do ?n[o']?t|no|not) work(?:ed|s)?|no success|not succe(?:ed|ss)(?:ed|ful)?|no luck)\b/i;

export function outcomeFromSentence(sentence) {
  if (SHORTHAND_CRITICAL_FAILURE_PATTERN.test(sentence)) return "criticalFailure";
  if (SHORTHAND_CRITICAL_SUCCESS_PATTERN.test(sentence)) return "criticalSuccess";
  if (CRITICAL_FAILURE_PATTERN.test(sentence)) return "criticalFailure";
  if (PLAIN_FAILURE_PATTERN.test(sentence)) return "failure";
  if (NEGATED_SUCCESS_OBJECT_PATTERN.test(sentence) || ALMOST_BUT_PATTERN.test(sentence)) return "failure";
  if (/\b(critical(?:ly)?|exceptionally|spectacularly)\b/i.test(sentence)) return "criticalSuccess";
  if (/\b(succeed(?:ed|s)?|saved|rescu(?:ed|es)|completed|defeated|crossed|secured|solved|won)\b/i.test(sentence)) {
    return "success";
  }
  // Genuine effort is evidence even without success: a failed, honestly-attempted action still
  // gets recorded (at a lower weight -- see GROWTH_EVENT_OUTCOME_WEIGHTS) rather than discarded.
  // "the pick snapped" / "snapped clean off" is a common, narrow way to describe a tool breaking
  // mid-attempt (lockpicking especially). Deliberately scoped to breakage phrasing rather than a
  // bare "snapped", which is also how GMs describe a sharp tone of voice ("snapped at him") that has
  // nothing to do with success or failure.
  if (/\b(fail(?:ed|s|ing)?|miss(?:ed)?|fumbl(?:e|es|ed|ing)|botch(?:ed|ing)?|misfir(?:e|es|ed|ing)|stumbl(?:e|es|ed|ing)|fell short|couldn'?t\b|didn'?t (?:manage|quite)|came to nothing|amounted to nothing|was for naught|all for naught|in vain|pick snapped|snapped (?:clean )?(?:off|in half))\b/i.test(sentence)) {
    return "failure";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Ordinary-people input normalization for the LOCAL fallback analyzer (2026-09-23).
//
// The AI gateway is the primary reader of session notes now; this path only runs when no provider
// is configured or every provider attempt failed. When it does run, it should still cope with how
// real tables write: typos ("atacked", "persuaided", "sneeked", "healled"), texting shorthand
// ("w/", "b/c", "&"), and non-native phrasing. normalizeNoteText() produces a MATCHING copy of a
// sentence -- the event summary always keeps the GM's original words.
// ---------------------------------------------------------------------------------------------

const SHORTHAND_REPLACEMENTS = [
  [/\bw\/o\b/gi, "without"],
  [/\bw\//gi, "with "],
  [/\bb\/c\b/gi, "because"],
  [/\bbc\b/gi, "because"],
  [/\bthru\b/gi, "through"],
  [/\bppl\b/gi, "people"],
  [/\bu\b/gi, "you"],
  [/\bpc\b/gi, "character"],
  [/\bnpc\b/gi, "person"],
  [/\bbbeg\b/gi, "boss"],
  [/\s&\s/g, " and "],
  [/\s\+\s/g, " and "]
];

// Common misspellings that are too far from their target for the conservative fuzzy matcher below
// (consonant swaps, phonetic spellings), mapped explicitly.
const MISSPELLINGS = {
  negociated: "negotiated", negociate: "negotiate", convinse: "convince", convinsed: "convinced",
  pursuaded: "persuaded", pursuade: "persuade", persuated: "persuaded", decieved: "deceived", decieve: "deceive",
  inteligence: "intelligence", intimadated: "intimidated", thretened: "threatened",
  fougth: "fought", fougt: "fought", foght: "fought", figth: "fight", strucked: "struck",
  hided: "hid", hidded: "hid", sneeked: "sneaked", snuk: "snuck", climed: "climbed", clumb: "climbed",
  swimmed: "swam", runned: "ran", jumpt: "jumped", shooted: "shot", shoted: "shot",
  throwed: "threw", heald: "healed", healt: "healed", bandaid: "bandaged", sheild: "shield", sheilded: "shielded",
  blokced: "blocked", defened: "defended", lockpiked: "lockpicked", pickd: "picked", teh: "the", thier: "their",
  arow: "arrow", arows: "arrows", spel: "spell", spels: "spells", casted: "cast", prayd: "prayed",
  cooket: "cooked", repared: "repaired", fixd: "fixed", trakced: "tracked"
};

// Action vocabulary the conservative fuzzy matcher may correct TO. Deliberately limited to verb
// forms the taxonomy keys on; nothing outside this list is ever produced by a correction.
const ACTION_VOCABULARY = [
  "attacked", "attacking", "attack", "struck", "striking", "strikes", "slashed", "stabbed", "parried", "fought", "fighting",
  "defended", "defending", "blocked", "blocking", "shielded", "guarded", "deflected", "disarmed", "tripped",
  "persuaded", "persuade", "persuading", "convinced", "convince", "negotiated", "negotiate", "haggled", "bluffed",
  "deceived", "disguised", "intimidated", "intimidate", "threatened", "demoralized",
  "sneaked", "sneaking", "crept", "hidden", "hiding", "stealthily", "silently", "shadowed",
  "healed", "healing", "treated", "treating", "stabilized", "bandaged", "stitched", "splinted", "tended",
  "climbed", "climbing", "crossed", "jumped", "jumping", "leaped", "escaped", "sprinted", "dashed", "crawled", "scaled",
  "balanced", "tumbled", "vaulted", "somersaulted", "grappled", "grappling", "shoved", "lifted", "carried", "hauled",
  "wrestled", "dragged", "swimming", "tracked", "tracking", "foraged", "foraging", "camped",
  "lockpicked", "lockpicking", "picked", "pickpocketed", "disabled", "jimmied",
  "crafted", "crafting", "repaired", "repairing", "cooked", "cooking", "forged", "forging", "assembled", "prepared",
  "researched", "remembered", "recalled", "deciphered", "recognized",
  "prayed", "praying", "blessing", "performed", "performing", "danced", "dancing", "singing", "recited",
  "summoned", "summoning", "conjured", "casting", "spells", "cantrip", "incantation", "ritual", "banished",
  "rallied", "commanded", "organized", "coordinated", "leading", "helped", "helping", "rescued", "protected", "supported",
  "succeeded", "failed", "failing", "fumbled", "botched", "missed", "defeated", "secured", "completed",
  "arrows", "crossbow", "shooting", "loosed", "hurled", "aimed", "carefully", "precisely",
  "alchemical", "elixir", "potion", "potions", "distilled", "reagents", "burned", "ignited", "scorched", "froze", "freezing"
];
const ACTION_VOCABULARY_SET = new Set(ACTION_VOCABULARY);
// Correctly-spelled everyday words within one "cheap" edit of a vocabulary word. Never corrected.
const PROTECTED_WORDS = new Set([
  "attach", "attached", "stuck", "strokes", "bought", "sought", "tripped", "stripped", "healthy", "heated", "headed",
  "treaded", "treats", "climate", "crossing", "jumper", "carries", "career", "hauling", "tracked", "tracks", "picket",
  "pickled", "disables", "crated", "crafty", "cooker", "prepare", "prayer", "prayers", "danced", "dances", "singer",
  "reciter", "summons", "casting", "casts", "rallies", "command", "helper", "helps", "rescuer", "missed", "misses",
  "defeat", "secure", "arrow", "shooter", "aimed", "burned", "burner", "frozen", "failed", "fails", "blessed",
  "blessings", "hidden", "sneaks", "stitch", "tended", "tender", "leader", "leading", "loaded", "looked", "scaled",
  "scales", "vaulted", "shoved", "lifted", "lifter", "dragged", "dragon", "dragons", "potion", "reagent", "danced",
  "coached", "crashed", "cracked", "dashed", "washed", "wished", "fished", "hushed", "rushed", "pushed", "bashed",
  "smashed", "slashes", "boated", "beated", "greeted", "treated", "created", "started", "stared", "stored", "shared",
  "trapped", "massed", "loading", "options", "option", "crypt", "mapped", "tapped", "leaped", "helped", "healer",
  "leaded", "sealed", "dealed", "reached", "coasted", "toasted", "casted", "masted", "fasted", "lasted", "rested"
]);
const VOWELS = new Set(["a", "e", "i", "o", "u", "y"]);

/**
 * Whether `from` can become `to` with ONE edit of the kinds typos actually are: doubling or
 * undoubling a letter ("atacked", "healled"), inserting/deleting/substituting a vowel ("persuaided",
 * "sneeked", "clumbed"), or swapping two adjacent letters ("attakced"). Consonant substitutions are
 * deliberately NOT accepted -- "heated" is a real word one consonant away from "healed", and a
 * fallback analyzer that invents a medicine event from a sentence about a stove is worse than one
 * that misses a typo.
 */
export function isCheapTypoOf(from, to) {
  if (from === to) return false;
  const lengthDelta = from.length - to.length;
  if (Math.abs(lengthDelta) > 1) return false;
  if (lengthDelta === 0) {
    let i = 0;
    while (i < from.length && from[i] === to[i]) i += 1;
    if (i === from.length) return false;
    // adjacent transposition (never the first letter: "options" is not a typo of "potions")
    if (i > 0 && from[i] === to[i + 1] && from[i + 1] === to[i] && from.slice(i + 2) === to.slice(i + 2)) return true;
    // single vowel substitution -- only on longer words, where English has fewer real-word
    // neighbours ("massed"/"missed", "trapped"/"tripped" are both real)
    return from.length >= 7 && VOWELS.has(from[i]) && VOWELS.has(to[i]) && from.slice(i + 1) === to.slice(i + 1);
  }
  const [longer, shorter] = lengthDelta > 0 ? [from, to] : [to, from];
  let i = 0;
  while (i < shorter.length && longer[i] === shorter[i]) i += 1;
  if (longer.slice(i + 1) !== shorter.slice(i)) return false;
  const extra = longer[i];
  // The extra letter is a doubled neighbour, or a vowel.
  return VOWELS.has(extra) || longer[i - 1] === extra || longer[i + 1] === extra;
}

export function correctTypo(word) {
  const lower = word.toLowerCase();
  if (Object.hasOwn(MISSPELLINGS, lower)) return MISSPELLINGS[lower];
  // Short words are too dense in English for a one-edit correction to be safe ("crypt" -> "crept").
  if (lower.length < 6 || ACTION_VOCABULARY_SET.has(lower) || PROTECTED_WORDS.has(lower)) return word;
  for (const candidate of ACTION_VOCABULARY) {
    if (candidate.length >= 6 && isCheapTypoOf(lower, candidate)) return candidate;
  }
  return word;
}

/**
 * Produces the copy of a sentence the local analyzer matches against: shorthand expanded, typos
 * in action words corrected. Never used as the event summary.
 */
export function normalizeNoteText(sentence) {
  let text = String(sentence ?? "");
  for (const [pattern, replacement] of SHORTHAND_REPLACEMENTS) text = text.replace(pattern, replacement);
  return text.replace(/[A-Za-z]+/g, (word) => correctTypo(word));
}

const BULLET_PREFIX = /^\s*(?:[-*•·‣◦–—>]+|\(?\d{1,3}[.)]|\(?[a-z][.)](?=\s))\s*/;
const TERMINAL_PUNCTUATION = /[.!?…:;]["')\]]*\s*$/;

/**
 * Splits notes into analyzable segments the way people actually write them: bullet lists
 * (-, *, •, 1.), one-thing-per-line notes with no final punctuation, and ordinary prose. A line
 * that does NOT start a bullet and begins lowercase is treated as a hard-wrapped continuation of
 * the previous line rather than a new thought, so pasted prose with manual line breaks stays whole.
 */
export function splitNoteLines(note) {
  const lines = String(note ?? "").replace(/\r\n?/g, "\n").split("\n");
  const segments = [];
  for (const rawLine of lines) {
    if (!rawLine.trim()) {
      segments.push(null); // paragraph break: never join across it
      continue;
    }
    const isBullet = BULLET_PREFIX.test(rawLine) && /^\s*(?:[-*•·‣◦–—>]|\(?\d{1,3}[.)]|\(?[a-z][.)]\s)/.test(rawLine);
    const line = isBullet ? rawLine.replace(BULLET_PREFIX, "") : rawLine.trim();
    const previous = segments[segments.length - 1];
    // Only a LONG unpunctuated line reads as hard-wrapped prose; short lines are shorthand notes
    // ("nat 1 on the swim lol" / "the bard sang all night") and stay separate thoughts.
    if (!isBullet && previous && previous.length >= 60 && !TERMINAL_PUNCTUATION.test(previous) && /^[a-z]/.test(line)) {
      segments[segments.length - 1] = `${previous} ${line}`;
    } else {
      segments.push(line.trim());
    }
  }
  return segments.filter((segment) => segment && segment.trim());
}
