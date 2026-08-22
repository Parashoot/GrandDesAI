# The Wandering Inn → Pathfinder 2e Conversion Rules

A living reference document. Every character/class/skill mapping done for this campaign should follow these rules so the conversion stays internally consistent across the whole series.

---

## 1. Core Principle

The book runs on two **independent axes**: `[Class]` (what you level as) and `[Skill]` (what you can do). PF2e already separates these into **Class Feats** and **Skill Feats** on different progression tracks. We preserve that separation rather than collapsing everything into one feat pool.

---

## 2. Class Mapping Framework

### 2.1 Choosing a base PF2e class
For each book `[Class]`, pick the PF2e class whose **core fantasy and feat-chain shape** matches — not the one with the closest name. A `[Runner]` is not a "Rogue" just because both are fast; it's mechanically about sustained movement and endurance, which points to Ranger/Monk-style feats.

Priority order when choosing:
1. Does an existing PF2e class's feat *chain* (not just flavor) match how the book class grows?
2. If no class fits, is this closer to an **Archetype** (a secondary specialization layered onto a normal class) than a full class?
3. Only homebrew a class from scratch if neither of the above works — this should be rare.

### 2.2 Specializations (e.g. [Mage] → [Ice Mage])
The book explicitly marks many classes as specializations of a broader class. These map to:
- **Same PF2e class, narrower subclass/school/bloodline choice**, if the base class already has that granularity (e.g. Wizard schools, Sorcerer bloodlines).
- **An Archetype layered on the base class**, if PF2e's base class doesn't have built-in specialization tracks for that theme.

Do not invent a whole new PF2e class for a specialization — that inflates the homebrew workload for no mechanical benefit.

### 2.3 "Comma classes" / Class Consolidation
When the book merges two classes into one (noted on the wiki as teal "comma classes"), treat this as **PF2e multiclass archetype dedication**, taking the primary class as the chassis and the secondary as an archetype feat chain. Don't build a bespoke hybrid class.

### 2.4 Prestige / advanced classes
Book classes marked as a clear upgrade of a lower class (wiki: purple "prestige" entries) map to **class feats gated behind a level threshold and a narrative trigger**, not automatic level-up. This preserves the book's feel that advanced classes are *earned*, not just unlocked by XP.

### 2.5 Level correspondence
The book's classes level independently and open-endedly (no hard cap, multiple classes per person). PF2e has one unified character level (1–20). Conversion rule:

- **PF2e character level ≈ highest single book-class level the character has reached, scaled down**, using this rough band (adjust per campaign power level):

| Book class level | PF2e character level |
|---|---|
| 1–10 | 1–4 |
| 11–20 | 5–8 |
| 21–30 | 9–11 |
| 31–40 | 12–14 |
| 41–50+ | 15–18+ |

- Secondary/lower classes a character also holds are represented as **archetype dedications**, not additional character levels — they add breadth (feats, skills) without inflating power level.

**Validated against real data:** the source material explicitly states class levels are not equivalent across class types — a level 30 [King] is stated to be roughly as powerful as a level 60 [Mayor], i.e. a "prestige"-tier class is worth roughly double an ordinary one at the same number. The level band above assumed all classes scale the same; they don't.

### 2.6 Class Power Tier modifier
Before applying the Section 2.5 band, classify the book class into one of three tiers and apply the stated adjustment to its *effective* level before converting:

| Class Power Tier | Examples | Adjustment before banding |
|---|---|---|
| **Standard** | [Innkeeper], [Runner], [Mage], most profession/combat classes | Use level as-is |
| **Elevated** (military command, royalty-adjacent, "hero" classes) | [General], [Commander], [Wall Lord] | Effective level = book level × 1.3 |
| **Prestige/Capstone** (explicitly stated to compress power, e.g. [King], [Dragonslayer]-tier advancements) | [King], [Dragonslayer] | Effective level = book level × 2 |

Example: Zel Shivertail reached **Level 39 [General]** (Elevated tier) → effective level ≈ 51 → bottom of the 41–50+ band → **PF2e level ~15–16**. That reads correctly for "greatest Drake General of his generation" without maxing out the PF2e scale, which we want to reserve for World-Category threats (Dragons, Named-rank apex figures, Ivolethe-tier existences).

This band is a starting point, not gospel — revisit per-arc as we hit stranger cases (Named-rank adventurers, Horror Rank monsters, anything above Level 50).

### 2.7 Multiple simultaneous classes (avoiding archetype bloat)
Real book characters routinely hold 3+ classes at once (e.g. Klbkch has held [Commander]/[Guardsman], [Diplomat], and [Assassin] concurrently, at different levels each). Building a full PF2e archetype dedication for every one of these causes feat bloat and slows the game down. Rule:

1. **Primary class** (highest level, or most narratively central) → full PF2e base class.
2. **One secondary class** (next-highest, if it's regularly relevant at the table) → single Archetype Dedication feat chain, taken sparingly (2–4 feats total across the character's career, not a full parallel progression).
3. **Any further classes** (tertiary+) → **do not build mechanics for them.** Represent them narratively only (background, dialogue, DM-side flavor) unless a specific scene calls for one of their skills — at which point convert *that one skill* on the fly as a one-off action, not a permanent feat.

This keeps a Klbkch-type character playable without needing 3 parallel feat trees.

---

## 3. Skill Tiering System

Every `[Skill]` gets sorted into exactly one tier before conversion. Tier is based on **narrative weight**, not raw power.

### Tier 1 — Minor/Common Skills
Flavor, utility, or baseline-competence skills (cooking, cleaning, basic strikes, minor crafting). Anyone with the right class could plausibly have one.
- **Conversion:** PF2e Skill Feat, or pure fluff with no mechanical rules at all if it doesn't come up in play.

### Tier 2 — Named Combat/Utility Skills
Skills with a specific, repeatable mechanical effect the character actively uses (`[Rapid Slash]`, elemental spells, tactical abilities).
- **Conversion:** PF2e Class Feat — reskin the closest existing feat/spell where possible rather than writing new rules text from scratch.

### Tier 3 — Rare/Unique/Capstone Skills
Character-defining or story-altering abilities; ones the wiki or text flags as rare, unprecedented, or plot-relevant.
- **Conversion:** Custom Archetype Dedication or standalone homebrewed ability, **gated behind a narrative milestone**, not a level number. Write these last, and only for characters/skills that actually come up at the table — don't pre-build ones you may never use.

### Tier decision checklist
Ask in order, stop at first "yes":
1. Does it fundamentally change what the character *is* (not just what they can do)? → **Tier 3**
2. Does it do something a spell/class feat already does mechanically, just reflavored? → **Tier 2**
3. Otherwise → **Tier 1**

---

## 4. Per-Character Documentation Template

Use this format for every character mapped, so entries stay comparable:

```
### [Character Name]
- Book Class(es): 
- PF2e Class + Archetype(s):
- Book class level → PF2e level (per Section 2.5):
- Key Skills:
  - [Skill Name] — Tier _ — PF2e equivalent:
  - ...
- Open questions / judgment calls made:
```

---

## 6. Horror Ranks

Horror Ranks are a parallel, involuntary track the source material uses for characters who commit monstrous acts (the examples given are things like cannibalism) or undergo a body-horror transformation trigger. As Horror Rank rises, it actively degrades the character's normal class levels and strips the Skills tied to those lost levels; losing the Horror Rank *may* restore what was lost, though the source material leaves that ambiguous.

**Conversion: a Corruption-style clock, not a class.**
- Track Horror Rank as a **4-stage clock** (Stage 0–3), separate from character level, similar in spirit to Pathfinder's own Corruption rules.
- Each stage gained forces the **suppression of one class feat or one archetype dedication** (player's choice which, but combat-relevant ones first if the fiction calls for a fight-focused horror) — mechanically identical to "losing the skills tied to lost levels," without literally subtracting character levels (which would wreck action economy/HP math mid-campaign).
- At Stage 3, the character's PF2e class remains but is **narratively locked out of its normal fictional justification** (a [Guardsman] who's become a horror can't act as city guard anymore) until Horror Rank is reduced — this preserves the "class conditions can be violated" consequence without a full mechanical rebuild.
- Reducing Horror Rank by a stage restores one suppressed feat, GM's choice of order — mirrors the book's own uncertainty about whether restoration is guaranteed.
- Use this sparingly — it's for antagonists, corrupted NPCs, or a PC arc specifically built around the temptation/cost of power, not a common status effect.

### 6.1 Counter-Leveling
The source material has a named mechanic for the opposite case: facing overwhelming odds and surviving triggers unusually fast leveling. Conversion: when a PC survives an encounter that was built at +2 or more over their normal level-appropriate difficulty (i.e., a fight they had no business winning), award a **full level** on the spot instead of normal XP — this is the one place we allow level-ups outside of a milestone/session-end moment, specifically to preserve that "grew stronger because the odds were impossible" beat.

---

## 7. Rulings Log
Resolved questions, with the reasoning and source example that settled each one:

- **Horror Ranks:** resolved via Section 6 — a 4-stage suppression clock rather than literal level loss.
- **3+ simultaneous classes:** resolved via Section 2.7 — one full class, one archetype at most, everything else stays narrative-only. Validated against Klbkch, who canonically holds three classes at once ([Guardsman]/[Commander], [Diplomat], [Assassin]) at different levels.
- **Level band at the high end:** resolved via Section 2.6's Class Power Tier modifier, validated against Zel Shivertail (Level 39 [General], an Elevated-tier class) landing at PF2e ~15–16 rather than overflowing the scale.

### Still open
- Exact PF2e stat block for a "World-Category" threat (Dragons, apex Named-rank figures) — we haven't hit a character extreme enough yet to need it; punt until an arc requires one.
- Whether Tier 3 Skills gained via Horror Rank (the "red" Skills the system marks as non-refusable) should use the same Archetype Dedication conversion as ordinary Tier 3 Skills, or need their own template — flag this if a red Skill comes up in play.
