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
  ["athletics", /\b(grappl(?:e|ed|ing)|shov(?:e|ed|ing)|lift(?:ed|ing)?|sw(?:am|im|imming)|force[d]? open|carr(?:y|ied|ying)|haul(?:ed|ing)?|heav(?:e|ed|ing)|dragg(?:ed|ing)|wrestl(?:e|ed|ing)|held (?:the )?(?:door|gate|weight))\b/i],
  ["craft", /\b(craft(?:ed|ing)?|repair(?:ed|ing)?|built|build(?:ing)?|cook(?:ed|ing)?|prepar(?:e|ed|ing)|forg(?:e|ed|ing)|mend(?:ed|ing)?|rigg(?:ed|ing)|jury-?rigg(?:ed|ing)|assembl(?:e|ed|ing))\b/i],
  ["deception", /\b(deceiv(?:e|ed|ing)|bluff(?:ed|ing)?|disguis(?:e|ed|ing)|feint(?:ed|ing)?|lied|lying|passed (?:himself|herself|themselves) off|played along)\b/i],
  ["diplomacy", /\b(negotiat(?:e|ed|ing)|persuad(?:e|ed|ing)|parley(?:ed|ing)?|diploma(?:t|cy)|talked (?:him|her|them|it) (?:out of|down|around)|haggl(?:e|ed|ing)|argued (?:with|for|against)|smoothed (?:it|things) over|convinc(?:e|ed|ing))\b/i],
  ["intimidation", /\b(intimidat(?:e|ed|ing)|demoraliz(?:e|ed|ing)|threaten(?:ed|ing)?|leaned on|loomed|stared (?:him|her|them) down|made (?:him|her|them) back off)\b/i],
  ["medicine", /\b(heal(?:ed|ing)?|treat(?:ed|ing)?|medicine|stabiliz(?:e|ed|ing)|first aid|bandag(?:e|ed|ing)|bound the wound|stitch(?:ed|ing)?|splint(?:ed|ing)?|tend(?:ed|ing)|patched (?:up|him|her|them)|staunch(?:ed|ing)?)\b/i],
  ["nature", /\b(nature|animals?|plants?|forest|wilderness|beasts?|herbs?)\b/i],
  ["occultism", /\b(occult|dreams?|psychic|spirits?|haunt(?:ed|ing)?|ritual|sigils?|ward(?:ed|ing)?|binding circle|banish(?:ed|ing)?|séance|seance)\b/i],
  ["performance", /\b(sing(?:ing|s)?|sang|songs?|perform(?:ed|ing)?|danc(?:e|ed|ing)|oratory|recit(?:e|ed|ing)|played (?:the )?(?:lute|fiddle|pipes))\b/i],
  ["religion", /\b(pray(?:ed|ing)?|prayers?|divine|holy|unholy|faith|deity|blessing|last rites)\b/i],
  ["society", /\b(society|city|laws?|customs?|nobles?|noble|bureaucrat|court|guild|ledgers?|seal of|house [A-Z])\b/],
  ["stealth", /\b(stealth|hid(?:e|den|ing|s)?|sneak(?:ed|ing|s)?|snuck|unseen|silent(?:ly)?|crept|creeping|slipp(?:ed|ing) (?:past|through|by)|stayed low|kept low|out of sight|shadow(?:ed|ing))\b/i],
  ["survival", /\b(track(?:ed|ing)?|forag(?:e|ed|ing)|survival|trail|camp(?:ed|ing)?|made camp|read the (?:ground|tracks|sky)|weathered)\b/i],
  ["thievery", /\b(lockpick(?:ed|ing)?|pick(?:ed|ing)? (?:the )?locks?|pickpocket(?:ed|ing)?|disabl(?:e|ed|ing)|traps?|thie(?:f|very|ves)|jimmied|slipped the latch|cut (?:the )?purse)\b/i],
  ["lore", /\b(lore|research(?:ed|ing)?|history|remember(?:ed|ing)?|recall(?:ed|ing)?|deciph(?:er|ered|ering)|piec(?:e|ed|ing)\b[^.!?]{0,40}\btogether|pored over|cross-referenc(?:e|ed|ing)|recogniz(?:e|ed|ing) the (?:seal|mark|name))\b/i],
  ["mobility", /\b(cross(?:ed|ing)?|climb(?:ed|ing)?|ran|run(?:ning)?|leap(?:ed|t|ing)?|jump(?:ed|ing)?|stride|strode|escap(?:e|ed|ing)|dash(?:ed|ing)?|crawl(?:ed|ing)?|scal(?:e|ed|ing)|sprint(?:ed|ing)?|took point)\b/i],
  ["water", /\b(canals?|rivers?|flood(?:ed|ing|s)?|water|sluice|rain|tides?|boat|swamp|dock|harbou?r|waterline)\b/i],
  ["support", /\b(help(?:ed|ing)?|aid(?:ed|ing)?|rescu(?:e|ed|ing)|protect(?:ed|ing)?|support(?:ed|ing)?|cover(?:ed|ing)? (?:him|her|them|the)|held (?:it|him|her|them) off|pulled (?:him|her|them) (?:out|clear)|carried (?:him|her|them))\b/i],
  ["martial", /\b(strikes?|struck|attack(?:ed|ing|s)?|fight(?:ing|s)?|fought|battle|defend(?:ed|ing)?|parr(?:y|ied|ies|ying)|swung|slash(?:ed|ing)?|stabb(?:ed|ing)|lung(?:e|ed|ing)|duel(?:ed|ling|ed)?|traded blows|drove (?:him|her|them|it) back|cut (?:him|her|them|it) down)\b/i],
  ["precision", /\b(aim(?:ed|ing)?|precise(?:ly)?|careful(?:ly)?|weak point|targeted|vitals?|threaded|exact(?:ly)?)\b/i],
  ["defense", /\b(block(?:ed|ing)?|shield(?:ed|ing)?|guard(?:ed|ing)\b|brac(?:e|ed|ing)|took cover|held (?:the )?line|held (?:it|him|her|them) off|warded off|took the (?:hit|blow)|deflect(?:ed|ing)?)\b/i],
  ["ranged", /\b(arrows?|bows?|crossbows?|thrown|threw|shoot(?:ing)?|shot|ranged|loosed|slings?)\b/i],
  ["leadership", /\b(lead(?:ing|s)?|led|command(?:ed|ing)?|rall(?:y|ied|ying)|organiz(?:e|ed|ing)|coordinat(?:e|ed|ing)|gave the order|kept (?:them|us) together|took charge)\b/i],
  ["alchemy", /\b(alchemy|alchemical|elixirs?|bombs?|reagents?|potions?|distill(?:ed|ing)?)\b/i],
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
const INTENT_ONLY_PATTERN =
  /\b(want(?:ed|s)? to|plan(?:ned|s)? to|mean(?:t|s) to|hop(?:ed|es) to|intend(?:ed|s)? to|(?:was|were) going to|thought about|considered|debated whether|argued about whether|wished (?:he|she|they) could)\b/i;
const BACKGROUND_STATE_PATTERN = /\bhad already been\b/i;

export function describesNoAction(sentence) {
  return INTENT_ONLY_PATTERN.test(sentence) || BACKGROUND_STATE_PATTERN.test(sentence);
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

export function outcomeFromSentence(sentence) {
  if (CRITICAL_FAILURE_PATTERN.test(sentence)) return "criticalFailure";
  if (/\b(critical(?:ly)?|exceptionally|spectacularly)\b/i.test(sentence)) return "criticalSuccess";
  if (/\b(succeed(?:ed|s)?|saved|rescu(?:ed|es)|completed|defeated|crossed|secured|solved|won)\b/i.test(sentence)) {
    return "success";
  }
  // Genuine effort is evidence even without success: a failed, honestly-attempted action still
  // gets recorded (at a lower weight -- see GROWTH_EVENT_OUTCOME_WEIGHTS) rather than discarded.
  if (/\b(fail(?:ed|s)?|miss(?:ed)?|fumbl(?:e|ed|es)|botch(?:ed)?|misfir(?:e|ed|es)|stumbl(?:e|ed)|fell short|couldn'?t\b|didn'?t (?:manage|quite))\b/i.test(sentence)) {
    return "failure";
  }
  return null;
}
