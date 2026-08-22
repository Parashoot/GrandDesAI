# Continuation Prompt: The Wandering Inn → Pathfinder 2e Conversion Project

Paste this whole document as your first message in any new AI conversation (any model, any year) to pick this project back up with full context. It is self-contained — the AI does not need this specific chat history.

---

## Project summary

I'm converting **The Wandering Inn** (web serial by pirateaba, thewanderinginn.com) into a **Pathfinder 2e** tabletop campaign. The story's `[Class]` and `[Skill]` system (bracketed terms throughout the text) needs to be mapped onto PF2e mechanics — Classes, Archetypes, Feats — in a way that's consistent across the whole series, not ad-hoc per character.

**Primary source for extraction:** don't try to comb the raw chapters at thewanderinginn.com for `[Class]`/`[Skill]` mentions — that's slow and error-prone across 10M+ words. Instead use the community wikis, which already catalogue every known Class and Skill alphabetically with context:
- https://wiki.wanderinginn.com (List of Classes, List of Skills, Horror Ranks, Conditions, System messages pages)
- https://thewanderinginn.fandom.com (mirror/alternate wiki, sometimes has different detail)

Go to the raw chapters only when you need narrative context for *how* a character earned a specific Class/Skill, to judge tone for the conversion — not to hunt for the bracket tags themselves.

**Copyright note for the AI:** paraphrase everything from the wiki/chapters, never quote long passages. Class and Skill *names* (short bracketed titles) are fine to list verbatim — they're functional game terms, not the creative prose around them.

## The finalized ruleset

Follow this exactly. If a genuinely new situation doesn't fit any rule below, propose an extension consistent with the existing logic, flag it clearly as new, and add it to the Rulings Log at the end once I confirm it.

### 1. Core principle
Book Classes and Skills are independent axes. PF2e's Class Feats (class progression) and Skill Feats (skill progression) preserve that same separation — don't collapse them into one feat pool.

### 2. Class mapping
- **Pick PF2e class by feat-chain shape, not name similarity.** A [Runner] isn't a Rogue just because both are "fast" — it's about sustained movement, which points to Ranger/Monk-style feats.
- Priority: (1) does an existing class's feat chain match how the book class grows? (2) if not, is it closer to an Archetype layered on a normal class? (3) only homebrew a full class from scratch as a last resort.
- **Specializations** (e.g. [Mage] → [Ice Mage]): same PF2e class with a narrower subclass/school/bloodline if the class supports that granularity; otherwise an Archetype layered on the base class. Never build a whole new class for a specialization.
- **"Comma classes"** (book merges two classes into one): PF2e multiclass Archetype Dedication — primary class as chassis, secondary as the archetype's feat chain.
- **Prestige/advanced classes** (clear upgrade of a lower class): class feats gated behind both a level threshold AND a narrative trigger, never an automatic unlock.

### 3. Level correspondence
Book levels are open-ended and per-class; PF2e is unified 1–20.

**Step 1 — classify Class Power Tier:**
| Tier | Examples | Adjustment |
|---|---|---|
| Standard | [Innkeeper], [Runner], [Mage], most profession/combat classes | level as-is |
| Elevated (military command, hero-type) | [General], [Commander], [Wall Lord] | level × 1.3 |
| Prestige/Capstone (explicitly power-compressing) | [King], [Dragonslayer]-tier | level × 2 |

**Step 2 — convert effective level to PF2e level:**
| Book effective level | PF2e level |
|---|---|
| 1–10 | 1–4 |
| 11–20 | 5–8 |
| 21–30 | 9–11 |
| 31–40 | 12–14 |
| 41–50+ | 15–18+ |

Reserve PF2e levels 19–20 for World-Category threats (Dragons, apex Named-rank figures) — don't let ordinary high-level humanoids hit the ceiling.

### 4. Multiple simultaneous classes
Real characters routinely hold 3+ book classes at once. To avoid feat-tree bloat:
1. **Primary class** (highest level or most narratively central) → full PF2e base class.
2. **One secondary class** (if regularly relevant at the table) → single Archetype Dedication, taken sparingly (2–4 feats total across the character's whole career).
3. **Everything else** → narrative flavor only. No permanent feats. If a scene calls for one of those skills, convert *that single skill* as a one-off improvised action, not a permanent addition.

### 5. Skill tiering
Every `[Skill]` gets exactly one tier, decided by this checklist (stop at first "yes"):
1. Does it fundamentally change what the character *is*, not just what they can do? → **Tier 3**
2. Does it do something a spell/class feat already does mechanically, just reflavored? → **Tier 2**
3. Otherwise → **Tier 1**

| Tier | What it covers | Conversion |
|---|---|---|
| 1 — Minor/Common | Flavor, baseline competence (cooking, basic strikes) | PF2e Skill Feat, or pure fluff if it never comes up mechanically |
| 2 — Named Combat/Utility | Specific repeatable effect the character actively uses | PF2e Class Feat — reskin the closest existing feat/spell |
| 3 — Rare/Unique/Capstone | Character-defining, story-altering | Custom Archetype Dedication or standalone ability, gated behind a narrative milestone, not a level number. Build these only when they actually come up at the table. |

### 6. Horror Ranks (involuntary corruption track)
Gained from monstrous acts or body-horror transformation; degrades normal class levels and strips skills as it rises.
- Track as a **4-stage clock** (0–3), separate from character level.
- Each stage suppresses one class feat or archetype dedication (player's choice which, combat-relevant first if the scene is a fight).
- At Stage 3, the PF2e class mechanically remains but is narratively locked out of its normal fictional role until the Horror Rank drops.
- Reducing a stage restores one suppressed feat.
- Use sparingly — antagonists, corrupted NPCs, or a specific PC temptation arc. Not a common status effect.

### 7. Counter-Leveling
When a PC survives an encounter built at +2 or more over their normal level-appropriate difficulty (a fight they had no business winning), award a **full level** on the spot instead of normal XP/milestone pacing. This is the one sanctioned exception to level-ups only happening at milestones/session-end.

### 8. Documentation template
Use this format for every character mapped:
```
### [Character Name]
- Book Class(es):
- PF2e Class + Archetype(s):
- Book class level(s) → Power Tier → PF2e level:
- Key Skills:
  - [Skill Name] — Tier _ — PF2e equivalent:
- Open questions / judgment calls made:
```

## Rulings Log (keep appending here as new edge cases get resolved)
- Horror Ranks → 4-stage suppression clock, not literal level loss.
- 3+ simultaneous classes → one full class, one archetype max, rest narrative-only. Validated against Klbkch ([Guardsman]/[Commander], [Diplomat], [Assassin] held concurrently at different levels).
- High-level band validated against Zel Shivertail: Level 39 [General] (Elevated tier) → effective ~51 → PF2e ~15–16.
- *(Still open as of last session: exact stat-block approach for World-Category threats; whether "red"/non-refusable Horror-Rank-granted Skills need their own conversion template distinct from ordinary Tier 3.)*

## What to do when I bring you a new character or arc
1. Pull their Class(es)/Skill(s) from the wiki (search it, don't rely on memory — the wiki is updated as the story continues).
2. Apply the ruleset above in order: Class → Power Tier → Level → multi-class handling → Skill tiers.
3. Present it in the Section 8 template format.
4. Flag anything that didn't cleanly fit an existing rule instead of silently improvising — I'll decide if it becomes a new permanent rule.
5. If asked for a full arc, give me a roster table like the ones already established, and call out which open rulings questions that arc helps settle.
