# Grand Design AI

An evaluation-first foundation for an assistant that converts *The Wandering Inn*'s diegetic Class/Skill system to Pathfinder 2e. It turns the existing written rules into a small, testable software contract before any model is trained or connected.

## What is here

- `src/grand_design/domain.py`: typed input/output contracts for annotated conversion examples.
- `src/grand_design/rules.py`: the deterministic rules that must remain true regardless of the eventual model.
- `src/grand_design/model.py`: a `ConversionModel` protocol and a transparent rules-based baseline.
- `data/`: version-controlled JSONL records for source facts and evaluation cases.
- `tests/`: regression tests for established rulings and the baseline.

The model deliberately does **not** scrape websites or reproduce source prose. Add only concise, paraphrased facts from the project-approved wikis, with a source URL and a reviewer. See [`data/README.md`](data/README.md).

## Quick start

Requires Python 3.10 or later and no runtime dependencies.

```powershell
cd C:\Users\parez\code\GrandDesAI
python -m unittest discover -s tests -v
python -m grand_design.cli validate-data
python -m grand_design.cli evaluate
python -m grand_design.cli corpus-report
python -m grand_design.cli convert --input examples\innkeeper.json
```

Optional editable install exposes the `grand-design` command:

```powershell
python -m pip install -e .
grand-design evaluate
```

## Model-development workflow

1. Add a reviewed, paraphrased source fact to `data/classes.jsonl` or `data/skills.jsonl`.
2. Add a human-approved expected output to `data/evaluations/known_conversions.jsonl`.
3. Run `validate-data` and `evaluate`; the deterministic baseline establishes a reproducible floor.
4. Implement an adapter satisfying `ConversionModel` for an LLM, classifier, or fine-tuned model.
5. Keep the rules engine as a guardrail: flag unresolved cases instead of inventing permanent rulings.

The current fixture set is intentionally small. It verifies the known Zel Shivertail power-tier ruling and the one-primary-class/one-archetype limit demonstrated by Klbkch. Expand it with held-out examples before judging a learned model.

## PF2e-bounded ability corpus

`data/ability_scenarios.jsonl` contains original, deliberately unusual situations split into training and held-out evaluation examples. Each ability names a Pathfinder comparison anchor and declares its character level, spell-rank ceiling, action cost, target shape, duration, save posture, narrative trigger, and non-negotiable guardrails.

`data/pf2e_power_bands.json` is the hard limit: it advances the spell-rank ceiling every two character levels, and a record cannot use a spell-rank or action budget above its exact envelope. The validator also rejects Tier 3 abilities that lack a narrative trigger. Read [`data/PF2E_SOURCES.md`](data/PF2E_SOURCES.md) before adding records; verify the anchor against current Archives of Nethys rules instead of copying rules text into the dataset.

Use `evaluate-abilities --predictions path\to\predictions.jsonl` to score a model against the held-out ability records. Each prediction must provide its evaluation `id`, proposed `expected_tier`, `spell_rank`, `actions`, and `narrative_trigger`. The scorer reports exact agreement and tier accuracy, then marks a prediction safe only if it passes the same PF2e envelope validation as the corpus.

## Player-facing class corpus

`data/class_scenarios.jsonl` adds 24 original character concepts (**16 train / 8 held-out eval**) covering martial, magic, social, crafting, mobility, investigation, leadership, prestige, and world-category concepts. Every record identifies feat-chain evidence, the PF2e chassis, the exact level-band calculation, and whether a secondary Class is actually regular enough to justify its one archetype. The validator rejects unsupported chassis, incorrect power-tier scaling, unsupported secondary archetypes, and missing guardrails.

## Foundry VTT

[`foundry-module`](foundry-module) is a Foundry VTT 12-13 module for PF2e worlds. It validates approved conversion JSON, stores it on Actor flags, and exposes an API for later automation. [`GAME_DESIGN.md`](GAME_DESIGN.md) defines the campaign loop, while [`world-map.md`](world-map.md) documents the original zoomable atlas scaffold and how to replace it with a licensed map asset.

## Convert a character

`convert` accepts a reviewed JSON character profile and prints the project's per-character documentation template. Skills require two explicit human judgments, matching the established checklist:

- `changes_identity`: the ability fundamentally changes what the character is.
- `maps_to_existing_mechanic`: an existing PF2e feat or spell has the same mechanical effect.

This forces uncertain source interpretation into the input review step. The baseline then assigns a tier, preserves the one-primary-class/one-archetype limit, recommends a reviewed PF2e chassis when one exists, and flags choices that still need a person.

For a multi-Class character, mark exactly one Class as `is_primary: true` and, only when it is regularly relevant at the table, one different Class as `is_secondary: true`. The prototype never promotes an arbitrary second entry into an archetype.

## Existing project references

The human-readable source of truth remains:

- `wandering-inn-pf2e-conversion-rules.md`
- `AI-continuation-prompt.md`
- `wandering-inn-dm-starter-kit.docx`
- `wandering-inn-player-guide.docx`
- [`player-concept-gallery.md`](player-concept-gallery.md) for spoiler-light, original player-concept examples

When a machine-readable record conflicts with those documents, correct the record and add a regression test.
