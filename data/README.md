# Data contract

All files are UTF-8 JSON Lines: one JSON object per line. Records contain paraphrased facts only; do not store chapter text or long wiki excerpts.

| File | Purpose | Required review |
| --- | --- | --- |
| `classes.jsonl` | Source-backed Class facts, power tiers, and a reviewed PF2e chassis recommendation | Source URL, reviewer, date |
| `skills.jsonl` | Source-backed Skill facts and suggested tiers | Source URL, reviewer, date |
| `evaluations/known_conversions.jsonl` | Human-approved expected conversion outputs | Rationale and reviewer |
| `ability_scenarios.jsonl` | Original ability scenarios with PF2e-bounded expected outputs | Power envelope and guardrails |
| `class_scenarios.jsonl` | Original player concepts with PF2e chassis and level-band targets | Feat-chain evidence and archetype limit |

`source_url` must identify the source page used for the fact. `reviewer` identifies the person who verified the paraphrase and conversion judgment. Use ISO `YYYY-MM-DD` dates.

Evaluation cases are not training data. Keep a meaningful held-out subset when a learned model is introduced.

`pf2e_recommendation` is a project judgment, not a quote from the source wiki. Mark it unresolved rather than guessing when the feat-chain analysis is incomplete.

The scenario corpora are original examples, not source canon. Their labels are conversion targets: a model may use their pattern but must still cite an actual PF2e comparison anchor and pass the power-envelope validator before a recommendation reaches a table.
