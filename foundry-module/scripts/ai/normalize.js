// Coercion layer between "whatever the model said" and the strict growth-event shape.
//
// The old gateway treated every tag the model wrote as either verbatim-canonical or garbage:
// "melee" (the model's perfectly reasonable word for our `martial`) was stripped, and an event whose
// only tag was "beekeeping" was discarded outright -- so a character who spent three sessions
// keeping bees earned nothing, because our 37-ish tag taxonomy never anticipated bees. That is the
// opposite of the Grand Design fantasy, where the odd, specific things people do are exactly what
// grow into odd, specific Classes. This module therefore never drops a word it does not recognize:
// a known synonym/inflection/typo/foreign word becomes the canonical tag, and anything genuinely new
// becomes an emergent *theme* slug that accumulates its own evidence (see emergent-themes.js, G2).
//
// Pure ESM, zero Foundry globals.

import { GROWTH_TAXONOMY, outcomeFromSentence, dangerGapFromSentence } from "../growth-taxonomy.js";

export const CANONICAL_TAGS = GROWTH_TAXONOMY.map(([tag]) => tag);
const CANONICAL_SET = new Set(CANONICAL_TAGS);
export const OUTCOMES = ["criticalSuccess", "success", "failure", "criticalFailure"];

// ---------------------------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------------------------

// Greek and Cyrillic are transliterated rather than stripped: a Greek GM's "μάχη" must not
// slugify to the empty string (and so vanish) before we get a chance to look it up.
const TRANSLIT = {
  α: "a", β: "v", γ: "g", δ: "d", ε: "e", ζ: "z", η: "i", θ: "th", ι: "i", κ: "k", λ: "l", μ: "m",
  ν: "n", ξ: "x", ο: "o", π: "p", ρ: "r", σ: "s", ς: "s", τ: "t", υ: "y", φ: "f", χ: "ch", ψ: "ps", ω: "o",
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "i", к: "k",
  л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts",
  ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  ß: "ss", æ: "ae", œ: "oe", ø: "o", ł: "l", đ: "d", þ: "th"
};

// "Bee-keeping!" and "bee keeping" should become the same theme as "beekeeping", or the same hobby
// splits its evidence three ways. We only glue a short first word onto a recognizable
// activity-noun suffix; "animal handling" stays "animal-handling".
const COMPOUND_SUFFIX = /^(keeping|keeper|working|picking|crafting|smithing|making|cracking|binding|weaving|smith|craft|work)$/;
const LEADING_ARTICLES = new Set(["the", "a", "an", "el", "la", "los", "las", "le", "les", "der", "die", "das", "il", "lo", "o", "os", "as", "ang", "mga"]);

function foldText(raw) {
  return String(raw ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[α-ωа-яßæœøłđþ]/g, (ch) => TRANSLIT[ch] ?? ch);
}

export function slugifyTheme(raw) {
  if (raw === null || raw === undefined) return "";
  // camelCase / PascalCase ("BeeKeeping", "animalHandling") -> words.
  const spaced = String(raw).replace(/([a-z])([A-Z])/g, "$1 $2");
  const words = foldText(spaced)
    .replace(/['’`]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  while (words.length > 1 && LEADING_ARTICLES.has(words[0])) words.shift();
  const joined = [];
  for (const word of words) {
    const prev = joined[joined.length - 1];
    if (prev && joined.length === 1 && prev.length <= 6 && COMPOUND_SUFFIX.test(word)) {
      joined[joined.length - 1] = prev + word;
    } else {
      joined.push(word);
    }
  }
  let slug = joined.join("-");
  if (slug.length > 32) {
    const cut = slug.slice(0, 33);
    const lastHyphen = cut.lastIndexOf("-");
    slug = lastHyphen > 8 ? cut.slice(0, lastHyphen) : slug.slice(0, 32);
  }
  return slug.replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------------------------
// Synonym table
// ---------------------------------------------------------------------------------------------
// Written as whitespace-separated word lists (hyphens for multi-word phrases) so the table stays
// readable; every key is passed through slugifyTheme at load, so accents and Greek script can be
// written naturally here and still match slugified model output. English inflections come first,
// then cheap multilingual equivalents (es, pt, fr, de, it, el, tl, ja-romaji). A word that is
// genuinely ambiguous across languages (French "voler" = fly AND steal, German "Gift" = poison,
// English "gift") is deliberately left out rather than guessed.
const SYNONYM_SOURCE = {
  acrobatics: `acrobatic acrobatically acrobat tumble tumbling tumbled balance balancing balanced tightrope
    somersault flip flipping backflip parkour agility agile dodge dodging dodged evasion evade evading evaded
    contortion contortionist tumble-through reflex-save acrobacia acrobacias equilibrio acrobatie akrobatik
    acrobazia akrobatiki ακροβασία ισορροπία karuwazа keiwaza`,
  arcana: `arcana-check magic-theory arcane-knowledge identify-magic detect-magic rune runes runic glyph glyphs
    runology spellcraft magical-theory arcanology recall-arcana`,
  athletics: `athletic athleticism strength strong str grapple grappling grappled grapples shove shoving shoved
    lift lifting lifted carry carrying carried haul hauling hauled heave heaving wrestle wrestling wrestled
    wrestler force-open forced-open forcing break-door broke-door kick-door kicked-door bash bashing bashed
    brawn might muscle muscles swim swimming swam swims fuerza atletismo athletisme athletik atletica
    αθλητισμός δύναμη lakas chikara nadar nadando nado nager natation schwimmen nuotare nuoto κολύμπι
    κολύμπησε lumangoy langoy oyogu`,
  craft: `crafting crafted crafter craftsman craftsmanship smithing blacksmithing blacksmith smith forging forged
    forge repair repairing repaired building built build construction carpentry carpenter woodworking tinkering
    tinker tinkered engineering engineer cooking cook cooked baking baked baker brewing brewed brewer sewing
    tailoring tailor leatherworking jewelcrafting jeweler pottery potter masonry mason fletching fletcher
    trapmaking invention inventing invented fabrication mending mended jury-rigging jury-rigged rigged artisan
    cocinar cocina cocino cocinó artesania herreria herrero forjar forjo construir reparar reparo artesanato
    cozinhar cozinhou ferreiro consertar artisanat forgeron cuisine cuisiner reparer handwerk schmieden kochen
    kochte bauen reparieren artigianato cucinare cucinato forgiare fabbro riparare κατασκευή χειροτεχνία
    μαγειρική μαγείρεψε σιδεράς paggawa pagluluto nagluto magluto ryouri kajiya tsukuru`,
  deception: `deceive deceiving deceived deceptive deceit bluff bluffing bluffed lie lying lied liar disguise
    disguised disguising feint feinting feinted con-artist conning trickery trick tricked tricking forgery
    impersonation impersonate impersonated misdirection subterfuge mentir mentira mintio engano engañar
    enganar enganou tromperie tromper mensonge lugen luegen tauschung taeuschung betrug inganno ingannare
    mentire εξαπάτηση ψέμα ξεγέλασε panlilinlang nagsinungaling linlang uso damasu`,
  diplomacy: `diplomatic diplomat persuade persuading persuaded persuasion persuasive negotiate negotiation
    negotiating negotiated haggle haggling haggled bargain bargaining bargained charm charming charmed charisma
    cha convince convinced convincing parley parleyed talk-down talked-down talking social socializing
    mediation mediate mediated gather-information make-an-impression flattery flatter rapport etiquette-talk
    persuadir persuasion persuasión diplomacia negociar negocio convencer convencio convenceu diplomatie
    negocier convaincre convaincu uberreden ueberreden verhandeln uberzeugen ueberzeugen persuadere diplomazia
    negoziare convincere convinto διπλωματία πειθώ διαπραγμάτευση έπεισε kumbinsihin nakumbinsi
    makipag-usap settoku koushou`,
  intimidation: `intimidate intimidating intimidated intimidates threaten threatening threatened threat threats
    menace menacing menaced coerce coercion coercing coerced demoralize demoralizing demoralized scare scaring
    scared frighten frightening frightened bully bullying bullied interrogation interrogate interrogating
    interrogated intimidar intimidacion amenazar amenazo ameacar ameacou intimider menacer einschuchtern
    einschuechtern bedrohen drohen intimidire minacciare εκφοβισμός απειλή απείλησε takutin tinakot odosu
    odoshi`,
  medicine: `medical medic heal healing healed healer first-aid firstaid treat-wounds treat-wound treating treated
    stabilize stabilizing stabilized bandage bandaging bandaged surgery surgeon doctor nursing triage cure
    curing cured stitch stitching stitched splint splinted poultice resuscitate resuscitated herbalism herbalist
    medicina curar curo curou sanar primeros-auxilios primeiros-socorros medecine soigner soin soigne medizin
    heilen heilte erste-hilfe curare guarire ιατρική θεραπεία γιάτρεψε θεράπευσε gamot ginamot lunas
    pagpapagaling iryou chiryou`,
  nature: `natural animal animals animal-handling handle-animal command-an-animal wildlife beast beasts plant plants
    herb herbs botany botanist taming tame tamed horsemanship horse-riding riding falconry gardening farming
    farmer druidcraft-lore naturaleza animales natureza animais natur tiere natura animali φύση ζώα kalikasan
    hayop shizen doubutsu`,
  occultism: `occult-knowledge occultism-check esoteric esoterica mysticism spirit-lore ritual rituals ritualism
    seance séance haunting curse-lore forbidden-lore ocultismo occultisme okkultismus occultismo αποκρυφισμός`,
  performance: `perform performing performed performer music musical musician sing singing sang sung song songs
    dance dancing danced dancer acting theater theatre oratory storytelling storyteller poetry poem poems poet
    recite reciting recited recital juggling juggle busking bard bardic bardic-inspiration instrument lute
    fiddle comedy jokes entertain entertaining entertained entertainment cantar canto canto cancion bailar
    baile danzar dancar musica interpretacion chanter chanson danser spectacle singen lied tanzen musik
    cantare canzone ballare τραγούδι τραγούδησε χορός χόρεψε μουσική kanta kumanta sayaw sumayaw utau
    odori ongaku`,
  religion: `religious pray praying prayed prayer prayers worship worshipping worshiped faith theology sermon
    preaching preach preached rites last-rites clergy priest priestly temple piety pious exorcism exorcise
    exorcised religion religión religiao rezar rezo orar oracion oracao prier priere beten gebet religione
    pregare preghiera θρησκεία προσευχή προσευχήθηκε dasal nagdasal panalangin inori inotta shuukyou`,
  society: `social-knowledge etiquette politics political law laws legal bureaucracy bureaucratic nobility noble
    court-intrigue intrigue heraldry guild guilds streetwise gossip rumors rumours high-society city-lore
    sociedad sociedade societe gesellschaft societa κοινωνία lipunan shakai politica politique politik`,
  stealth: `stealthy stealthily sneak sneaking sneaked snuck sneaky sneaks hide hiding hid hidden stalking stalk
    shadowing shadowed infiltrate infiltration infiltrating infiltrated skulk skulking prowl prowling silent
    silently quiet quietly camouflage conceal concealment concealing concealed unseen avoid-notice sigilo
    sigiloso sigilosamente esconderse escondio escondeu esconder furtivo furtivamente discricao furtivite
    discretion cacher cache schleichen schlich verstecken versteckte heimlich furtivita nascondersi nascosto
    κρυφά κρύφτηκε αθόρυβα palihim nagtago magtago shinobi kakureru onmitsu`,
  survival: `survive surviving survived survivalism survivalist track tracking tracked tracker forage foraging
    foraged hunt hunting hunted hunter fishing fished fisherman trapping trapper camping camp camped navigation
    navigate navigating navigated orienteering wilderness-survival scouting scout scouted pathfinding
    supervivencia sobrevivencia sobreviver rastrear rastreo cazar caza pescar pesca sobrevivencia cacar
    rastreamento survie chasser chasse pister peche uberleben ueberleben jagen jagd spurenlesen angeln
    sopravvivenza cacciare caccia pescare επιβίωση κυνήγι ψάρεμα pangangaso nangaso mangisda sabaibaru kari
    tsuri`,
  thievery: `thief thieving steal stealing stole stolen theft pickpocket pickpocketing pickpocketed lockpicking
    lockpick lockpicked lock-picking pick-lock picked-lock picklock picking-locks pick-the-lock open-lock
    disable-device disable-trap disabled-trap disarm-trap disarmed-trap trap-disarming sleight-of-hand
    sleight palming burglary burgle burgled larceny heist safecracking rob robbing robbed shoplifting
    cutpurse robar robo robó ladron ganzua abrir-cerradura carterista roubar roubou furto ladrao gazua vol
    crochetage crocheter voleur stehlen stahl diebstahl dieb schlossknacken rubare rubato ladro scassinare
    κλοπή κλέβω έκλεψε κλειδαριά pagnanakaw magnakaw nagnakaw nakaw nusumu dorobou`,
  lore: `knowledge research researching researched study studying studied scholarship scholar scholarly history
    historian recall recall-knowledge remember remembering remembered investigation investigate investigating
    investigated deduction deduce deduced decipher deciphering deciphered translation translate translating
    translated linguistics languages reading archaeology library books academia int conocimiento investigar
    historia estudiar estudio conhecimento pesquisa estudar savoir connaissance histoire recherche etudier
    wissen geschichte forschung studieren conoscenza storia ricerca studiare γνώση ιστορία έρευνα kaalaman
    kasaysayan pananaliksik chishiki rekishi kenkyuu`,
  mobility: `mobile movement move moving running run ran sprint sprinting sprinted dash dashing dashed climb
    climbing climbed climber jump jumping jumped leap leaping leapt leaped chase chasing chased pursuit
    pursue pursued flee fleeing fled escape escaping escaped speed travel traveling travelling traveled
    crawl crawling crawled traversal traverse traversed scaling scaled correr corrio saltar salto escalar
    trepar huir huyo escapar fuga pular pulou fugir fugiu courir sauter grimper fuir laufen rennen rannte
    springen klettern kletterte fliehen flucht correre saltare arrampicarsi fuggire τρέξιμο έτρεξε άλμα
    πήδηξε αναρρίχηση σκαρφάλωσε φυγή tumakbo tumalon umakyat tumakas hashiru nigeru`,
  water: `aquatic sailing sail sailed sailor boating boat rowing row rowed diving dive dived dove underwater naval
    seafaring seamanship ship tides tide flood flooded river ocean sea canal hydromancy water-magic agua
    navegar navego marinero agua-magia agua barco navegou marinheiro eau naviguer marin wasser segeln
    segelte seemann acqua navigare marinaio νερό θάλασσα ιστιοπλοΐα tubig dagat maglayag mizu umi`,
  support: `supportive help helping helped helper aid aiding aided assist assisting assisted assistance rescue
    rescuing rescued protect protecting protected teamwork buff buffing buffed escort escorted caretaking
    caregiving ayuda ayudar ayudo rescatar rescato rescate proteger protegio ajudar ajudou resgatar resgatou
    apoio apoyo aider aide secourir sauvetage proteger helfen half hilfe retten rettete rettung schutzen
    unterstutzen aiutare aiuto salvare salvato soccorso proteggere βοήθεια βοήθησε διάσωση έσωσε προστασία
    tulong tumulong iligtas niligtas tasukeru tasuketa tasuke mamoru`,
  martial: `melee combat fighting fight fought fighter battle battling battled attack attacking attacked attacks
    strike striking struck strikes swordplay swordsmanship sword swords swordsman fencing fencer dueling
    duelling duel dueled duelist brawling brawl brawled brawler unarmed unarmed-combat martial-arts
    martial-art hand-to-hand boxing boxer kickboxing weapon weapons weapon-skill weaponry axe spear
    spearmanship polearm mace hammer dagger knife-fighting blade blades slash slashing slashed stab stabbing
    stabbed parry parrying parried cleave cleaving power-attack power-strike action-surge extra-attack
    kill killing killed slay slaying slew slain warrior soldier soldiering rage raging combate lucha luchar
    lucho pelear pelea peleo atacar ataco ataque espada esgrima luta lutar lutou atacou combattre combattu
    attaquer attaque epee escrime bagarre kampf kampfen kaempfen kampfte angriff angreifen griff-an schwert
    nahkampf combattimento combattere combatte attaccare attacco spada scherma μάχη πολέμησε επίθεση
    επιτέθηκε σπαθί πάλη laban lumaban labanan sumalakay umatake atake tatakai tatakatta kougeki kenjutsu`,
  precision: `precise precisely accuracy accurate accurately aim aiming aimed careful carefully called-shot
    weak-point vital-spot sneak-attack finesse fine-control exactness targeting targeted pinpoint precision
    precisão precisao precisione prazision praezision ακρίβεια katumpakan`,
  defense: `defensive defend defending defended defender block blocking blocked blocks shield shields shielding
    shielded shield-block raise-shield raised-shield guard guarding guarded protection armor armour armored
    armoured tank tanking tanked resilience resist resisted resistance toughness fortitude take-cover
    took-cover hold-the-line held-the-line bracing brace braced deflect deflected deflecting defensa defender
    defendio bloquear bloqueo escudo defesa defendeu defense défense defendre bouclier parer verteidigung
    verteidigen verteidigte schild blocken difesa difendere difeso scudo parare άμυνα αμύνθηκε ασπίδα
    depensa ipagtanggol sanggalang bougyo mamori tate`,
  ranged: `range archery archer bow bows longbow shortbow crossbow crossbows arrow arrows shoot shooting shot shots
    sniping sniper snipe sniped marksman marksmanship throw throwing threw thrown javelin sling slinging
    firearm firearms gun guns gunslinger pistol musket dart darts knife-throwing projectile ranged-attack
    ranged-combat arqueria arquero arco ballesta disparar disparo disparo lanzar lanzo flecha tiro arqueiro
    besta atirar atirou tir-a-l-arc arc arbalete tirer lancer fleche bogenschiessen bogen armbrust schiessen
    werfen pfeil arciere balestra freccia τοξοβολία τόξο βέλος pana pumana ihagis kyuudou yumi`,
  leadership: `lead leading leader command commanding commanded commander rally rallying rallied inspire inspiring
    inspired organize organizing organized organise organised coordinate coordinating coordinated tactics
    tactical strategy strategic strategist orders gave-orders captain recruiting recruit recruited morale
    liderazgo liderar lidero lider mandar comandar organizar lideranca comando commandement diriger meneur
    rallier fuhrung fuehrung anfuhren anfuehren befehlen leitung guidare capo ηγεσία ηγήθηκε αρχηγός
    pamumuno pinuno namuno shiki shiki-wo-toru`,
  alchemy: `alchemical alchemist alchemize potion potions potion-making brew-potion elixir elixirs bomb bombs
    bomb-making poison poisons poisoning poisoned poisoner antidote reagent reagents mutagen mutagens distill
    distilling distillation tincture chemistry apothecary alquimia alquimista pocion pocao veneno alchimie
    empoisonner alchemie trank alchimia pozione veleno αλχημεία φίλτρο δηλητήριο alkimya renkinjutsu`,
  spellcasting: `spell spells cast casting casted caster spellcaster magic magical mage magery wizardry sorcery
    sorcerer witchcraft cantrip cantrips incantation spell-attack spellwork counterspell counterspelling
    enchant enchanting enchantment hechizo hechizos magia lanzar-hechizo conjuro feitico feiticaria magie
    sortilege zauber zaubern zauberspruch incantesimo μαγεία ξόρκι mahika salamangka mahou jumon majutsu`,
  arcane: `arcanist wizard wizards arcane-magic arcane-spell evocation evoke evoked abjuration transmutation
    illusion illusions necromancy arcano arcanes arkan`,
  divine: `divinity god gods goddess deity holy sacred blessed bless blessing smite smiting channel-divinity
    lay-on-hands cleric paladin miracle miracles turn-undead holy-magic divino divin gottlich heilig sagrado
    sacro θεϊκός ιερό banal kami shinsei`,
  occult: `occult-magic psychic psionic psionics mental mind mind-magic telepathy telepathic dream dreams curse
    curses cursed hex hexes hexing warlock eldritch eldritch-blast aberrant oculto okkult occulto psiquico
    psychique ψυχικός κατάρα sumpa noroi`,
  primal: `druid druidic druidism druidcraft shaman shamanism shamanic wild-magic wildshape wild-shape shapeshift
    shapeshifting shapeshifted elemental elementalism nature-magic primal-magic primordial druida druide
    δρυίδης`,
  fire: `flame flames fiery burn burning burned burnt ignite ignited ignition pyromancy pyromancer pyro fireball
    blaze blazing heat scorch scorching scorched inferno arson torch torching torched fuego fogo feu feuer
    fuoco φωτιά πυρ apoy honoo kaen`,
  cold: `ice icy frost frosty freeze freezing frozen froze chill chilling snow winter cryomancy blizzard hielo frio
    gelo glace froid eis kalte kalt ghiaccio freddo πάγος κρύο yelo lamig koori`,
  electricity: `electric electrical lightning thunder thunderous shock shocking storm stormcalling static spark
    sparks electromancy rayo relampago trueno electricidad raio trovao eletricidade foudre eclair electricite
    blitz donner elektrizitat fulmine tuono elettricita κεραυνός αστραπή ηλεκτρισμός kidlat kulog kaminari
    denki`,
  earth: `stone stones rock rocks soil dirt mud mountain geomancy earthbending tremor earthquake digging dig dug
    mining miner tierra piedra roca terra pedra terre pierre roche erde stein fels pietra roccia γη πέτρα
    βράχος lupa bato tsuchi iwa ishi`,
  air: `wind winds windy gust breeze flight fly flying flew levitate levitation levitating aeromancy sky glide
    gliding whirlwind tornado aire viento volar vento voar vent luft fliegen aria volare αέρας άνεμος πτήση
    hangin lumipad kaze sora`,
  summoning: `summon summons summoned summoner conjure conjuring conjured conjuration companion familiar familiars
    eidolon animal-companion call-forth called-forth invocar invocacion invocacao conjurar invoquer invocation
    beschworen beschwoeren beschworung evocare invocare κάλεσμα επίκληση ipatawag shoukan shoukanjutsu`
};

// Specific activities that DO fit a canonical tag but are distinctive enough that a GM would want
// them to grow into their own Skill some day (a [Cook] is not just "craft"). Resolving one of these
// yields the canonical tag AND a theme, so the evidence counts both ways. Foreign words point at the
// English theme so "cocinar" and "cooking" accumulate together.
const ALSO_THEME_SOURCE = {
  cooking: "cooking cook cooked cocinar cocina cocino cocinó cozinhar cozinhou cuisine cuisiner kochen kochte cucinare cucinato μαγειρική μαγείρεψε pagluluto nagluto magluto ryouri",
  baking: "baking baked baker",
  brewing: "brewing brewed brewer",
  smithing: "smithing blacksmithing blacksmith smith forging forged forge herreria herrero forjar ferreiro forgeron schmieden forgiare fabbro σιδεράς kajiya",
  carpentry: "carpentry carpenter woodworking",
  tinkering: "tinkering tinker tinkered engineering engineer invention inventing invented",
  tailoring: "sewing tailoring tailor",
  leatherworking: "leatherworking",
  jewelcrafting: "jewelcrafting jeweler",
  pottery: "pottery potter",
  masonry: "masonry mason",
  fletching: "fletching fletcher",
  trapmaking: "trapmaking",
  herbalism: "herbalism herbalist botany botanist",
  gardening: "gardening",
  farming: "farming farmer",
  horsemanship: "horsemanship horse-riding riding",
  falconry: "falconry",
  "animal-taming": "taming tame tamed",
  fishing: "fishing fished fisherman pescar pesca peche angeln pescare ψάρεμα mangisda tsuri",
  hunting: "hunting hunted hunter cazar caza cacar chasser chasse jagen jagd cacciare caccia κυνήγι pangangaso nangaso kari",
  trapping: "trapping trapper",
  sailing: "sailing sail sailed sailor seafaring seamanship navegar navego marinero navegou marinheiro naviguer marin segeln segelte seemann navigare marinaio ιστιοπλοΐα maglayag",
  rowing: "rowing rowed",
  diving: "diving dived",
  mining: "mining miner",
  poetry: "poetry poem poems poet",
  storytelling: "storytelling storyteller",
  juggling: "juggling juggle",
  busking: "busking",
  comedy: "comedy jokes",
  acting: "acting theater theatre",
  singing: "sing singing sang sung song songs cantar canto cancion chanter chanson singen cantare canzone τραγούδι τραγούδησε kanta kumanta utau",
  dancing: "dance dancing danced dancer bailar baile danzar dancar danser tanzen ballare χορός χόρεψε sayaw sumayaw odori",
  heraldry: "heraldry",
  politics: "politics political politica politique politik",
  interrogation: "interrogation interrogate interrogating interrogated",
  forgery: "forgery",
  haggling: "haggle haggling haggled bargain bargaining bargained",
  safecracking: "safecracking",
  swordsmanship: "swordplay swordsmanship swordsman fencing fencer",
  archery: "archery archer longbow shortbow",
  brawling: "brawling brawl brawled brawler boxing boxer",
  poisoncraft: "poisoning poisoner"
};

// Words that carry no activity at all -- a model filling a required field with "none" or "other"
// must not mint a theme called "other".
const NOISE_WORDS = new Set([
  "", "none", "null", "nil", "na", "n-a", "other", "others", "misc", "miscellaneous", "general", "generic", "unknown",
  "event", "events", "action", "actions", "activity", "skill", "skills", "check", "roll", "test", "attempt",
  "success", "failure", "critical", "tag", "tags", "theme", "themes", "emergent", "undefined", "true", "false",
  "something", "stuff", "thing", "things", "various", "no", "yes",
  // table shorthand that is an outcome or chatter, not an activity
  "nat", "nat20", "nat1", "crit", "crits", "tpk", "tpkd", "lol", "ez", "gg", "rip", "ooc", "ic", "dm", "gm", "pc", "npc",
  "dc", "hp", "ac", "xp", "roll", "rolled", "d20", "combat-round", "round", "turn"
]);

// Filler that surrounds the real word in things like "Athletics check (DC 15)" or "stealth roll".
const FILLER_PARTS = new Set(["skill", "check", "checks", "roll", "rolls", "rolled", "save", "saving", "throw", "test", "tests", "attempt",
  "dc", "vs", "ability", "using", "use", "used", "the", "a", "an", "of", "and", "or", "with", "w", "on", "at", "to", "for", "in"]);

function buildSynonymTable() {
  const table = {};
  for (const [tag, words] of Object.entries(SYNONYM_SOURCE)) {
    if (!CANONICAL_SET.has(tag)) continue; // taxonomy changed under us; never map onto a dead tag
    for (const word of words.split(/\s+/)) {
      const key = slugifyTheme(word);
      if (!key || CANONICAL_SET.has(key)) continue;
      if (!(key in table)) table[key] = tag;
    }
  }
  return table;
}

function buildAlsoTheme() {
  const map = {};
  for (const [theme, words] of Object.entries(ALSO_THEME_SOURCE)) {
    for (const word of words.split(/\s+/)) {
      const key = slugifyTheme(word);
      if (key && !(key in map)) map[key] = theme;
    }
  }
  return map;
}

export const TAG_SYNONYMS = Object.freeze(buildSynonymTable());
const ALSO_THEME = buildAlsoTheme();

// ---------------------------------------------------------------------------------------------
// Stemming + fuzzy matching
// ---------------------------------------------------------------------------------------------

// Deliberately crude suffix stripping (a full Porter stemmer is overkill and would cost bundle size
// in the browser). It only has to make "athletic" meet "athletics", "stealthy" meet "stealth",
// "alchemical" meet "alchemy" -- and it is applied symmetrically to both sides of the lookup.
export function stemWord(word) {
  let w = String(word).toLowerCase();
  if (w.length <= 4) return w;
  const rules = [
    [/ically$/, "ic"], [/ations?$/, "ate"], [/ies$/, "y"], [/ied$/, "y"], [/(ss|x|z|ch|sh)es$/, "$1"],
    [/([^s])s$/, "$1"], [/ingly$/, ""], [/ing$/, ""], [/edly$/, ""], [/ed$/, ""], [/ly$/, ""], [/ical$/, "ic"],
    [/ism$/, ""], [/ist$/, ""], [/ery$/, "er"], [/er$/, ""], [/ic$/, ""], [/al$/, ""], [/y$/, ""], [/e$/, ""]
  ];
  for (const [pattern, replacement] of rules) {
    if (w.length <= 4) break;
    const next = w.replace(pattern, replacement);
    if (next !== w && next.length >= 3) w = next;
  }
  // swimm -> swim, stabb -> stab
  if (/([bcdfgklmnprtvz])\1$/.test(w) && w.length > 4) w = w.slice(0, -1);
  return w;
}

function stemSlug(slug) {
  return slug.split("-").map(stemWord).join("-");
}

const STEM_INDEX = (() => {
  const index = new Map();
  for (const tag of CANONICAL_TAGS) index.set(stemSlug(tag), tag);
  for (const [key, tag] of Object.entries(TAG_SYNONYMS)) {
    const stem = stemSlug(key);
    if (stem.length >= 4 && !index.has(stem)) index.set(stem, tag);
  }
  return index;
})();

const FUZZY_KEYS = [...CANONICAL_TAGS, ...Object.keys(TAG_SYNONYMS)].filter((key) => key.length >= 5 && /^[a-z-]+$/.test(key));

export function levenshtein(a, b, limit = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  // Optimal-string-alignment distance: a swapped pair of letters ("stealht", "ahtletics") counts as
  // one edit, which is how people actually mistype.
  let prevPrev = null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(prev[j] + 1, current[j - 1] + 1, prev[j - 1] + cost);
      if (prevPrev && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) current[j] = Math.min(current[j], prevPrev[j - 2] + 1);
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > limit) return limit + 1;
    prevPrev = prev;
    prev = current;
  }
  return prev[b.length];
}

// The contract allows distance <= 2 for words >= 5 chars. In practice 2 edits on a 6-letter word is
// a third of the word and turned "poetry" into "pottery"; so 5-7 letter words get 1 edit and only
// 8+ letter words get 2 -- still inside the contract's bound, just stricter where it matters.
function fuzzyLimit(length) {
  if (length < 5) return 0;
  return length >= 8 ? 2 : 1;
}

function fuzzyMatch(slug) {
  const limit = fuzzyLimit(slug.length);
  if (!limit) return null;
  let best = null;
  for (const key of FUZZY_KEYS) {
    if (Math.abs(key.length - slug.length) > limit) continue;
    // People keep the first letter(s) when they mistype; without this, 8-letter "-ing" words
    // collide ("gambling" is 2 edits from "tumbling" and would become acrobatics).
    if (key[0] !== slug[0] && !(key[0] === slug[1] && key[1] === slug[0])) continue;
    const distance = levenshtein(slug, key, limit);
    if (distance === 2 && key[1] !== slug[1]) continue;
    if (distance <= limit && (!best || distance < best.distance || (distance === best.distance && CANONICAL_SET.has(key) && !CANONICAL_SET.has(best.key)))) {
      best = { key, distance };
      if (distance === 1 && CANONICAL_SET.has(key)) break;
    }
  }
  if (!best) return null;
  return CANONICAL_SET.has(best.key) ? best.key : TAG_SYNONYMS[best.key];
}

// ---------------------------------------------------------------------------------------------
// resolveTag
// ---------------------------------------------------------------------------------------------

function cleanRawTag(raw) {
  return String(raw)
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ") // "Athletics (DC 15)" -> "Athletics"
    .replace(/^\s*(#|tags?\s*[:=]|skills?\s*[:=]|category\s*[:=])\s*/i, "")
    .replace(/\bdc\s*\d+\b/gi, " ")
    .replace(/[+\-]?\d+\b/g, " ")
    .trim();
}

function normalizeCustomSynonyms(customSynonyms) {
  const out = {};
  if (!customSynonyms || typeof customSynonyms !== "object") return out;
  for (const [raw, value] of Object.entries(customSynonyms)) {
    const key = slugifyTheme(raw);
    if (key && typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return out;
}

const customCache = new WeakMap();
function customTable(customSynonyms) {
  if (!customSynonyms || typeof customSynonyms !== "object") return {};
  if (!customCache.has(customSynonyms)) customCache.set(customSynonyms, normalizeCustomSynonyms(customSynonyms));
  return customCache.get(customSynonyms);
}

function lookupSingle(slug, custom) {
  if (!slug) return null;
  if (CANONICAL_SET.has(slug)) return { tag: slug, via: "case" };
  if (custom[slug]) {
    const target = custom[slug];
    if (CANONICAL_SET.has(target)) return { tag: target, via: "custom-synonym" };
    const lower = target.toLowerCase();
    if (CANONICAL_SET.has(lower)) return { tag: lower, via: "custom-synonym" };
    const theme = slugifyTheme(target);
    if (theme) return { theme, via: "custom-synonym" };
  }
  if (TAG_SYNONYMS[slug]) return withAlsoTheme({ tag: TAG_SYNONYMS[slug], via: "synonym" }, slug);
  const unhyphenated = slug.replace(/-/g, "");
  if (unhyphenated !== slug) {
    if (CANONICAL_SET.has(unhyphenated)) return { tag: unhyphenated, via: "case" };
    if (TAG_SYNONYMS[unhyphenated]) return withAlsoTheme({ tag: TAG_SYNONYMS[unhyphenated], via: "synonym" }, unhyphenated);
  }
  const stem = stemSlug(slug);
  if (STEM_INDEX.has(stem)) return withAlsoTheme({ tag: STEM_INDEX.get(stem), via: "stem" }, slug);
  return null;
}

function withAlsoTheme(result, slug) {
  const theme = ALSO_THEME[slug];
  return theme ? { ...result, alsoTheme: theme } : result;
}

/**
 * Map one raw tag word from a model to a canonical tag, or to an emergent theme.
 * @returns {{tag:string, via:string, alsoTheme?:string} | {theme:string, via:string} | null}
 *   null only for empty/noise input ("none", "other", "") -- never for a real word.
 */
export function resolveTag(raw, { customSynonyms = {} } = {}) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") raw = String(raw);
  if (CANONICAL_SET.has(raw)) return { tag: raw, via: "exact" };
  const trimmed = raw.trim();
  if (CANONICAL_SET.has(trimmed)) return { tag: trimmed, via: "exact" };
  if (CANONICAL_SET.has(trimmed.toLowerCase())) return { tag: trimmed.toLowerCase(), via: "case" };

  const custom = customTable(customSynonyms);
  const fullSlug = slugifyTheme(trimmed);
  // GM synonyms win over everything else, including the cleaned form, so a GM can repoint even a
  // word we already know ("cooking" -> their own "hearthcraft" theme).
  if (custom[fullSlug]) return lookupSingle(fullSlug, custom);

  const slug = slugifyTheme(cleanRawTag(trimmed)) || fullSlug;
  if (NOISE_WORDS.has(slug)) return null;
  const direct = lookupSingle(slug, custom);
  if (direct) return direct;

  // Multi-word phrases: "melee combat", "athletics-check", "sneaky stuff". Strip filler, then try
  // the head noun (last word) first, then the rest.
  const parts = slug.split("-").filter((part) => part && !FILLER_PARTS.has(part));
  if (parts.length && parts.join("-") !== slug) {
    const reduced = lookupSingle(parts.join("-"), custom);
    if (reduced) return reduced;
  }
  if (parts.length > 1) {
    for (const part of [...parts].reverse()) {
      if (part.length < 3) continue;
      const hit = lookupSingle(part, custom);
      if (hit && hit.tag) return { tag: hit.tag, via: hit.via, ...(hit.alsoTheme ? { alsoTheme: hit.alsoTheme } : {}) };
    }
  }

  const fuzzyTarget = parts.length === 1 ? parts[0] : slug;
  const fuzzy = fuzzyMatch(fuzzyTarget);
  if (fuzzy) return { tag: fuzzy, via: "fuzzy" };

  const theme = parts.length ? parts.join("-") : slug;
  if (!theme || NOISE_WORDS.has(theme) || theme.length < 3) return null;
  return { theme, via: "emergent" };
}

// ---------------------------------------------------------------------------------------------
// Outcome / dangerGap coercion
// ---------------------------------------------------------------------------------------------

function plain(raw) {
  return foldText(String(raw).replace(/([a-z])([A-Z])/g, "$1 $2")).replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
}

const CRIT_FAIL_PATTERN = /\b(nat(?:ural)?\s*(?:1|one)(?!\d)|crit(?:ical(?:ly)?)?\s*(?:fail|failure|failed|miss|fumble)|fumble[ds]?|botch(?:ed|es)?|disaster|catastroph\w*|pifia|patzer|fallo critico|falha critica|echec critique|kritischer? fehlschlag|fallimento critico|krisimi apotychia|daishippai)\b/;
const CRIT_SUCCESS_PATTERN = /\b(nat(?:ural)?\s*(?:20|twenty)|crit(?:ical(?:ly)?)?(?:\s*(?:success|succeeded|hit|win))?|spectacular\w*|exceptional\w*|triumph\w*|flawless\w*|exito critico|critico|sucesso critico|succes critique|reussite critique|kritischer? erfolg|successo critico|krisimi epitychia|daiseikou)\b/;
const FAILURE_PATTERN = /\b(fail\w*|unsuccessful\w*|miss(?:ed|es)?|lost|lose|loss|no|not|nope|negative|bad|botch|fallo|fallido|fallida|fallo|fracas\w*|fall[oó]|falha\w*|falhou|echou\w*|echec|rate|fehlschlag\w*|fehlgeschlagen|gescheitert|misslungen|verfehlt|versagt|fallit\w*|fallimento|apotychia|apetyche|nabigo|bigo|shippai)\b/;
const SUCCESS_PATTERN = /\b(succe\w*|pass(?:ed)?|win|won|victory|yes|ok|okay|good|great|done|achieved|complete[ds]?|partial\w*|mixed|exito|exitos[oa]|logr\w*|sucesso|conseguiu|consigui\w*|succes|reussi\w*|erfolg\w*|geschafft|successo|riuscit\w*|epitychia|petyche|tagumpay|nagtagumpay|seikou|positive)\b/;

/** -> "criticalSuccess"|"success"|"failure"|"criticalFailure"|null */
export function coerceOutcome(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "boolean") return raw ? "success" : "failure";
  if (typeof raw === "number") return outcomeFromNumber(raw);
  if (typeof raw === "object") {
    for (const key of ["outcome", "result", "value", "status"]) {
      if (key in raw) return coerceOutcome(raw[key]);
    }
    return null;
  }
  const text = String(raw);
  if (OUTCOMES.includes(text)) return text;
  const p = plain(text);
  if (!p) return null;
  const compact = p.replace(/\s+/g, "");
  const exact = { criticalsuccess: "criticalSuccess", success: "success", failure: "failure", criticalfailure: "criticalFailure", critsuccess: "criticalSuccess", critfail: "criticalFailure", critfailure: "criticalFailure", nat20: "criticalSuccess", nat1: "criticalFailure" };
  if (exact[compact]) return exact[compact];
  if (/^[-+]?\d+(\.\d+)?$/.test(p)) return outcomeFromNumber(Number(p));
  if (CRIT_FAIL_PATTERN.test(p)) return "criticalFailure";
  // "critical" + a failure word in either order ("failed critically").
  if (/\bcrit\w*/.test(p) && FAILURE_PATTERN.test(p)) return "criticalFailure";
  if (CRIT_SUCCESS_PATTERN.test(p)) return "criticalSuccess";
  // "almost ... but" / "nearly" is how people narrate a miss without a failure word.
  if (/\b(almost|nearly|casi|quase|presque|fast|quasi)\b/.test(p)) return "failure";
  if (FAILURE_PATTERN.test(p)) return "failure";
  if (SUCCESS_PATTERN.test(p)) return "success";
  return null;
}

function outcomeFromNumber(n) {
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n < 1) return n >= 0.9 ? "criticalSuccess" : n >= 0.5 ? "success" : "failure";
  if (n === 0) return "failure";
  // Treat integers as a d20 face: 1 is the nat-1 fumble, 20 the nat-20, else a coarse split.
  if (Number.isInteger(n) && n >= 1 && n <= 20) {
    if (n === 1) return "criticalFailure";
    if (n === 20) return "criticalSuccess";
    return n >= 10 ? "success" : "failure";
  }
  return n > 20 ? "success" : null;
}

/** -> "moderate"|"severe"|undefined */
export function coerceDangerGap(raw) {
  if (raw === null || raw === undefined) return undefined;
  if (raw === true) return "moderate";
  if (raw === false) return undefined;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return undefined;
    if (raw < 1) return raw >= 0.66 ? "severe" : raw >= 0.33 ? "moderate" : undefined;
    return raw >= 5 ? "severe" : "moderate";
  }
  if (typeof raw === "object") return coerceDangerGap(raw.level ?? raw.value ?? raw.dangerGap);
  const p = plain(raw);
  if (!p) return undefined;
  if (/^(moderate|severe)$/.test(p)) return p;
  if (/^[-+]?\d+(\.\d+)?$/.test(p)) return coerceDangerGap(Number(p));
  if (/\b(none|no|low|minor|small|slight|trivial|n a|na|null|false|nil|normal|even|equal|ninguno|nenhum|aucun|kein\w*|nessun\w*)\b/.test(p)) return undefined;
  if (/\b(severe|extreme\w*|huge|massive|deadly|lethal|lopsided|overwhelming|impossible|hopeless\w*|very high|far|vastly|legendary|critical|severo|extremo|grave|enorme|severe|extrem|schwer|estremo|grave|sobra|matindi)\b/.test(p)) return "severe";
  if (/\b(moderate|medium|high|major|significant|big|large|tough|hard|outmatched|outnumbered|dangerous|stronger|risky|true|yes|moderado|alto|dificil|moyen|eleve|mittel|hoch|moderato|medio|mataas)\b/.test(p)) return "moderate";
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// coerceEvent
// ---------------------------------------------------------------------------------------------

const LANGUAGE_NAMES = {
  english: "en", spanish: "es", espanol: "es", castellano: "es", portuguese: "pt", portugues: "pt", brazilian: "pt",
  french: "fr", francais: "fr", german: "de", deutsch: "de", italian: "it", italiano: "it", greek: "el", ellinika: "el",
  tagalog: "tl", filipino: "tl", japanese: "ja", nihongo: "ja", romaji: "ja", dutch: "nl", polish: "pl", russian: "ru",
  chinese: "zh", korean: "ko", turkish: "tr", swedish: "sv", norwegian: "no", danish: "da", finnish: "fi", czech: "cs",
  romanian: "ro", hungarian: "hu", arabic: "ar", hindi: "hi", indonesian: "id", vietnamese: "vi", ukrainian: "uk", mixed: "mixed"
};

export function coerceLanguage(raw) {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const p = foldText(raw).trim();
  if (/^[a-z]{2,3}(?:[-_][a-z0-9]{2,4})?$/.test(p)) return p.replace("_", "-");
  const first = p.split(/[^a-z]+/).filter(Boolean);
  for (const word of first) if (LANGUAGE_NAMES[word]) return LANGUAGE_NAMES[word];
  return undefined;
}

const FIELD_ALIASES = {
  summary: ["summary", "summaryText", "description", "desc", "event", "action", "what", "text", "sentence", "details", "resumen", "resumo", "resume", "zusammenfassung", "riassunto", "perilipsi", "buod"],
  tags: ["tags", "tag", "canonicalTags", "skills", "skill", "categories", "category", "type", "types", "etiquetas", "etiquettes"],
  themes: ["themes", "theme", "activities", "activity", "topics", "keywords", "emergentThemes", "temas"],
  outcome: ["outcome", "result", "resultado", "resultat", "ergebnis", "risultato", "status", "success", "roll"],
  dangerGap: ["dangerGap", "danger_gap", "danger", "dangerLevel", "counterLeveling", "counter_leveling", "powerGap"],
  quote: ["quote", "source", "sourceText", "original", "originalText", "excerpt", "fragment", "evidence", "cita", "citacao", "citation", "zitat", "citazione"],
  actorName: ["actorName", "actor", "character", "characterName", "who", "name", "personaje", "personagem", "personnage"],
  language: ["language", "lang", "locale", "idioma", "langue", "sprache", "lingua"]
};

function pick(raw, field) {
  for (const key of FIELD_ALIASES[field]) {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== "") return { key, value: raw[key] };
  }
  // case-insensitive second pass ("Summary", "TAGS")
  const lowerMap = new Map(Object.keys(raw).map((key) => [key.toLowerCase().replace(/[_\s-]/g, ""), key]));
  for (const alias of FIELD_ALIASES[field]) {
    const real = lowerMap.get(alias.toLowerCase().replace(/[_\s-]/g, ""));
    if (real !== undefined && raw[real] !== undefined && raw[real] !== null && raw[real] !== "") return { key: real, value: raw[real] };
  }
  return null;
}

function toStringList(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string" || typeof item === "number") return toStringList(String(item));
      if (item && typeof item === "object") return toStringList(item.tag ?? item.name ?? item.theme ?? item.value ?? "");
      return [];
    });
  }
  if (typeof value === "object") return Object.keys(value).filter((key) => value[key]);
  // "stealth, thievery" / "martial/defense" / "stealth and athletics"
  return String(value).split(/\s*(?:[,;|/&+]|\band\b|\by\b|\bet\b|\bund\b|\be\b)\s*/i).map((part) => part.trim()).filter(Boolean);
}

function textOf(value, max) {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : typeof value === "object" ? (value.text ?? value.value ?? "") : String(value);
  const clean = String(text).replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/**
 * Coerce one raw model event into the shared growth-event shape.
 * @param {object|string} rawEvent
 * @param {{customSynonyms?:object, emergentThemes?:boolean, maxTags?:number, maxThemes?:number}} opts
 * @returns {{event:object, coercions:string[]} | {rejected:string, coercions?:string[]}}
 */
export function coerceEvent(rawEvent, opts = {}) {
  const { customSynonyms = {}, emergentThemes = true, maxTags = 4, maxThemes = 4 } = opts;
  const coercions = [];
  let raw = rawEvent;
  if (typeof raw === "string") {
    raw = { summary: raw };
    coercions.push("string-event-wrapped");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { rejected: "not-an-object" };

  // A model that explicitly marks an entry as not having happened is telling us to drop it.
  const happened = raw.happened ?? raw.occurred ?? raw.isEvent;
  if (happened === false || /^(intent|intention|plan|question|scenery|hypothetical)$/i.test(String(raw.kind ?? raw.eventType ?? ""))) {
    return { rejected: "marked-not-an-event", coercions };
  }

  const summaryPick = pick(raw, "summary");
  const quotePick = pick(raw, "quote");
  let summary = textOf(summaryPick?.value, 500);
  let quote = textOf(quotePick && quotePick.key !== summaryPick?.key ? quotePick.value : undefined, 400);
  if (summaryPick && summaryPick.key !== "summary") coercions.push(`summary-from-${summaryPick.key}`);
  if (!summary && quote) {
    summary = textOf(quote, 500);
    coercions.push("summary-from-quote");
  }
  if (!summary) return { rejected: "missing-summary", coercions };

  const tags = [];
  const themes = [];
  const addTheme = (slug) => {
    const clean = slugifyTheme(slug);
    if (!clean || NOISE_WORDS.has(clean)) return;
    if (CANONICAL_SET.has(clean)) {
      if (!tags.includes(clean)) tags.push(clean);
      return;
    }
    if (!themes.includes(clean)) themes.push(clean);
  };

  const tagPick = pick(raw, "tags");
  for (const word of toStringList(tagPick?.value)) {
    const resolved = resolveTag(word, { customSynonyms });
    if (!resolved) continue;
    if (resolved.tag) {
      if (!tags.includes(resolved.tag)) tags.push(resolved.tag);
      if (resolved.via !== "exact") coercions.push(`tag:${word}->${resolved.tag}(${resolved.via})`);
      if (resolved.alsoTheme) addTheme(resolved.alsoTheme);
    } else if (resolved.theme) {
      addTheme(resolved.theme);
      coercions.push(`tag:${word}->theme:${resolved.theme}`);
    }
  }

  const themePick = pick(raw, "themes");
  for (const word of toStringList(themePick?.value)) {
    // A theme that is really a canonical tag (or a known synonym) counts as the tag; the theme
    // slug is still kept when the word is a distinctive activity (cooking) rather than an alias.
    const resolved = resolveTag(word, { customSynonyms });
    if (resolved?.tag && (resolved.via === "exact" || resolved.via === "case")) {
      if (!tags.includes(resolved.tag)) tags.push(resolved.tag);
      continue;
    }
    if (resolved?.tag && resolved.alsoTheme) {
      if (!tags.includes(resolved.tag)) tags.push(resolved.tag);
      addTheme(resolved.alsoTheme);
      continue;
    }
    addTheme(word);
  }

  // Last-resort salvage: an event the model described but forgot to tag gets tagged from its own
  // text using the local taxonomy patterns. Better a keyword tag on a real AI-extracted event than
  // losing the event.
  if (!tags.length && !themes.length) {
    const text = `${summary} ${quote}`;
    for (const [tag, pattern] of GROWTH_TAXONOMY) if (pattern.test(text) && !tags.includes(tag)) tags.push(tag);
    if (tags.length) coercions.push("tags-inferred-from-text");
  }

  if (!emergentThemes) themes.length = 0;
  if (!tags.length && !themes.length) return { rejected: "no-tags-or-themes", coercions };

  const outcomePick = pick(raw, "outcome");
  let outcome = coerceOutcome(outcomePick?.value);
  if (outcomePick && outcome && outcome !== outcomePick.value) coercions.push(`outcome:${JSON.stringify(outcomePick.value)}->${outcome}`);
  let outcomeInferred = false;
  if (!outcome) {
    outcome = outcomeFromSentence(quote || summary) ?? outcomeFromSentence(summary) ?? "success";
    outcomeInferred = true;
    coercions.push(`outcome-inferred:${outcome}`);
  }

  const dangerPick = pick(raw, "dangerGap");
  let dangerGap = coerceDangerGap(dangerPick?.value);
  if (dangerPick && dangerGap !== dangerPick.value && !(dangerGap === undefined && /^(none|)$/i.test(String(dangerPick.value)))) {
    coercions.push(`dangerGap:${JSON.stringify(dangerPick.value)}->${dangerGap ?? "none"}`);
  }
  if (dangerGap === undefined && !dangerPick) {
    // Only infer from explicit power-gap wording; never invent a multiplier.
    const inferred = dangerGapFromSentence(`${summary} ${quote}`);
    if (inferred) {
      dangerGap = inferred;
      coercions.push(`dangerGap-inferred:${inferred}`);
    }
  }

  const actorPick = pick(raw, "actorName");
  const actorName = textOf(actorPick?.value, 80);
  const language = coerceLanguage(pick(raw, "language")?.value);

  const event = {
    summary,
    tags: tags.slice(0, maxTags),
    themes: themes.slice(0, maxThemes),
    outcome,
    ...(outcomeInferred ? { outcomeInferred: true } : {}),
    ...(dangerGap ? { dangerGap } : {}),
    ...(quote ? { quote } : {}),
    ...(actorName ? { actorName } : {}),
    ...(language ? { language } : {})
  };
  return { event, coercions };
}

/**
 * Near-duplicate key for merging events across chunks and repair attempts: two events describing the
 * same action should not double the evidence. Uses the slugified summary's first words plus tags.
 */
export function eventDedupeKey(event) {
  const words = slugifyTheme(String(event.summary ?? "").slice(0, 200).replace(/-/g, " ")).split("-")
    // Numbers are kept even though they're short: "tended hive 1" and "tended hive 2" (or "round 1"
    // / "round 2") are different things that happened, not a duplicate to merge.
    .filter((word) => (word.length > 2 || /^\d+$/.test(word)) && !FILLER_PARTS.has(word));
  return `${words.slice(0, 8).join("-")}|${event.outcome}`;
}
