export const GROWTH_TAXONOMY = [
  ["acrobatics", /\b(balance|tumble|tightrope|somersault|vault(?:ed|ing)?)\b/i],
  ["arcana", /\b(arcana|rune|runes|arcane theory|identify magic)\b/i],
  ["athletics", /\b(grapple(?:d|ing)?|shove(?:d|ing)?|lift(?:ed|ing)?|sw(?:am|im|imming)|force open)\b/i],
  ["craft", /\b(craft(?:ed|ing)?|repair(?:ed|ing)?|build(?:ing)?|cook(?:ed|ing)?|prepare(?:d|ing)?|forge(?:d|ing)?)\b/i],
  ["deception", /\b(deceiv(?:e|ed|ing)|bluff(?:ed|ing)?|disguise(?:d|ing)?|feint(?:ed|ing)?)\b/i],
  ["diplomacy", /\b(negotiate(?:d|ing)?|persuade(?:d|ing)?|parley(?:ed|ing)?|diploma(?:t|cy))\b/i],
  ["intimidation", /\b(intimidat(?:e|ed|ing)|demoraliz(?:e|ed|ing)|threaten(?:ed|ing)?)\b/i],
  ["medicine", /\b(heal(?:ed|ing)?|treat(?:ed|ing)?|medicine|stabiliz(?:e|ed|ing)|first aid)\b/i],
  ["nature", /\b(nature|animal|plant|forest|wilderness|beast)\b/i],
  ["occultism", /\b(occult|dream|psychic|spirit|haunt)\b/i],
  ["performance", /\b(sing(?:ing)?|song|perform(?:ed|ing)?|dance(?:d|ing)?|oratory)\b/i],
  ["religion", /\b(pray(?:ed|ing)?|divine|holy|unholy|faith|deity)\b/i],
  ["society", /\b(society|city|law|custom|noble|bureaucrat)\b/i],
  ["stealth", /\b(stealth|hid(?:e|den|ing)|sneak(?:ed|ing)?|unseen|silent(?:ly)?)\b/i],
  ["survival", /\b(track(?:ed|ing)?|forage(?:d|ing)?|survival|trail|camp(?:ed|ing)?)\b/i],
  ["thievery", /\b(lockpick(?:ed|ing)?|pickpocket(?:ed|ing)?|disable(?:d|ing)?|trap|thie(?:f|very))\b/i],
  ["lore", /\b(lore|research(?:ed|ing)?|history|remember(?:ed|ing)?|recall)\b/i],
  ["mobility", /\b(cross(?:ed|ing)?|climb(?:ed|ing)?|run(?:ning)?|leap(?:ed|ing)?|jump(?:ed|ing)?|stride|escape(?:d|ing)?|dash(?:ed|ing)?)\b/i],
  ["water", /\b(canal|river|flood|water|sluice|rain|tide|boat|swamp)\b/i],
  ["support", /\b(help(?:ed|ing)?|aid(?:ed|ing)?|rescu(?:e|ed|ing)|protect(?:ed|ing)?|support(?:ed|ing)?)\b/i],
  ["martial", /\b(strike|struck|attack(?:ed|ing)?|fight(?:ing)?|battle|defend(?:ed|ing)?|parry)\b/i],
  ["precision", /\b(aim(?:ed|ing)?|precise|careful|weak point|targeted|vital)\b/i],
  ["defense", /\b(block(?:ed|ing)?|shield|guard(?:ed|ing)?|brace(?:d|ing)?|cover)\b/i],
  ["ranged", /\b(arrow|bow|crossbow|thrown|shoot(?:ing)?|ranged)\b/i],
  ["leadership", /\b(lead(?:ing)?|command(?:ed|ing)?|rall(?:y|ied|ying)|organize(?:d|ing)?|coordinate(?:d|ing)?)\b/i],
  ["alchemy", /\b(alchemy|alchemical|elixir|bomb|reagent|potion)\b/i],
  ["spellcasting", /\b(spell|cast(?:ing)?|magic|cantrip)\b/i],
  ["arcane", /\b(arcane|wizard|rune|evocation)\b/i],
  ["divine", /\b(divine|prayer|blessing|holy)\b/i],
  ["occult", /\b(occult|dream|psychic|mental)\b/i],
  ["primal", /\b(primal|druid|elemental|wild)\b/i],
  ["fire", /\b(fire|flame|ember|burn(?:ed|ing)?|heat)\b/i],
  ["cold", /\b(cold|ice|frost|freeze|winter)\b/i],
  ["electricity", /\b(lightning|electricity|thunder|storm|shock)\b/i],
  ["earth", /\b(earth|stone|rock|soil|wall)\b/i],
  ["air", /\b(air|wind|gust|sky|flight)\b/i],
  ["summoning", /\b(summon(?:ed|ing)?|called|conjure(?:d|ing)?|companion)\b/i]
];

export function outcomeFromSentence(sentence) {
  if (/\b(critical(?:ly)?|exceptionally|spectacularly)\b/i.test(sentence)) return "criticalSuccess";
  if (/\b(succeed(?:ed|s)?|saved|rescu(?:ed|es)|completed|defeated|crossed|secured|solved|won)\b/i.test(sentence)) {
    return "success";
  }
  return null;
}
