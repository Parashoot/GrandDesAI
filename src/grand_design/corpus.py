"""Validation for original ability scenarios bounded by PF2e comparison envelopes."""

from __future__ import annotations

from typing import Any


_REQUIRED_RECORD_FIELDS = {
    "id",
    "split",
    "scenario",
    "character_level",
    "ability_name",
    "narrative_intent",
    "expected_tier",
    "pf2e_anchor",
    "mechanics",
    "guardrails",
}


def validate_ability_corpus(
    records: list[dict[str, Any]], power_bands: list[dict[str, Any]]
) -> dict[str, int]:
    """Reject malformed or power-creeping examples before they reach a model."""
    validate_power_bands(power_bands)
    seen_ids: set[str] = set()
    counts = {"train": 0, "eval": 0, "tier_1": 0, "tier_2": 0, "tier_3": 0}
    for record in records:
        missing = _REQUIRED_RECORD_FIELDS.difference(record)
        if missing:
            raise ValueError(f"Ability record {record.get('id', '<unknown>')} is missing {sorted(missing)}.")
        record_id = record["id"]
        if record_id in seen_ids:
            raise ValueError(f"Duplicate ability record id: {record_id}.")
        seen_ids.add(record_id)
        if record["split"] not in ("train", "eval"):
            raise ValueError(f"{record_id}: split must be train or eval.")
        if record["expected_tier"] not in (1, 2, 3):
            raise ValueError(f"{record_id}: expected_tier must be 1, 2, or 3.")
        if not isinstance(record["guardrails"], list) or not record["guardrails"]:
            raise ValueError(f"{record_id}: at least one explicit guardrail is required.")

        band = _band_for_level(record["character_level"], power_bands)
        anchor = record["pf2e_anchor"]
        mechanics = record["mechanics"]
        _validate_anchor(record_id, anchor, band)
        _validate_mechanics(record_id, mechanics, band, record["expected_tier"])

        counts[record["split"]] += 1
        counts[f"tier_{record['expected_tier']}"] += 1
    if not counts["train"] or not counts["eval"]:
        raise ValueError("The ability corpus must contain both train and eval records.")
    return counts


def score_ability_predictions(
    records: list[dict[str, Any]],
    predictions: list[dict[str, Any]],
    power_bands: list[dict[str, Any]],
) -> dict[str, int]:
    """Score model outputs against held-out targets and reject unsafe proposals."""
    validate_ability_corpus(records, power_bands)
    evaluation_records = {record["id"]: record for record in records if record["split"] == "eval"}
    prediction_by_id: dict[str, dict[str, Any]] = {}
    required = {"id", "expected_tier", "spell_rank", "actions", "narrative_trigger"}
    for prediction in predictions:
        missing = required.difference(prediction)
        if missing:
            raise ValueError(
                f"Prediction {prediction.get('id', '<unknown>')} is missing {sorted(missing)}."
            )
        prediction_id = prediction["id"]
        if prediction_id not in evaluation_records:
            raise ValueError(f"Prediction {prediction_id} is not a held-out evaluation record.")
        if prediction_id in prediction_by_id:
            raise ValueError(f"Duplicate prediction id: {prediction_id}.")
        prediction_by_id[prediction_id] = prediction
    missing_predictions = evaluation_records.keys() - prediction_by_id.keys()
    if missing_predictions:
        raise ValueError(f"Missing predictions for {sorted(missing_predictions)}.")

    result = {"total": len(evaluation_records), "exact": 0, "tier_correct": 0, "safe": 0}
    for record_id, record in evaluation_records.items():
        prediction = prediction_by_id[record_id]
        proposal = dict(record)
        proposal["expected_tier"] = prediction["expected_tier"]
        proposal["pf2e_anchor"] = dict(record["pf2e_anchor"], spell_rank=prediction["spell_rank"])
        proposal["mechanics"] = dict(
            record["mechanics"],
            actions=prediction["actions"],
            narrative_trigger=prediction["narrative_trigger"],
        )
        try:
            validate_ability_corpus([proposal, _minimal_eval_sentinel()], power_bands)
        except ValueError:
            continue
        result["safe"] += 1
        expected = (
            record["expected_tier"],
            record["pf2e_anchor"]["spell_rank"],
            record["mechanics"]["actions"],
            record["mechanics"]["narrative_trigger"],
        )
        actual = (
            prediction["expected_tier"],
            prediction["spell_rank"],
            prediction["actions"],
            prediction["narrative_trigger"],
        )
        result["tier_correct"] += prediction["expected_tier"] == record["expected_tier"]
        result["exact"] += actual == expected
    return result


def _minimal_eval_sentinel() -> dict[str, Any]:
    """Satisfy corpus split validation when scoring one proposal at a time."""
    return {
        "id": "__scoring_sentinel__",
        "split": "train",
        "scenario": "Sentinel",
        "character_level": 1,
        "ability_name": "[Sentinel]",
        "narrative_intent": "Validation helper.",
        "expected_tier": 1,
        "pf2e_anchor": {
            "reference_name": "Skill action",
            "reference_type": "skill-action",
            "spell_rank": 0,
        },
        "mechanics": {
            "actions": 1,
            "targets": "self",
            "duration": "instant",
            "effect_ceiling": "none",
            "requires_save": False,
            "narrative_trigger": False,
        },
        "guardrails": ["Not a game ability."],
    }


def validate_power_bands(power_bands: list[dict[str, Any]]) -> None:
    """Ensure the configured envelopes continuously and unambiguously cover levels 1-20."""
    expected_minimum = 1
    required = {
        "level_band",
        "minimum_level",
        "maximum_level",
        "maximum_spell_rank",
        "maximum_actions",
        "reference",
    }
    for band in power_bands:
        missing = required.difference(band)
        if missing:
            raise ValueError(f"Power band is missing {sorted(missing)}.")
        if band["minimum_level"] != expected_minimum or band["maximum_level"] < expected_minimum:
            raise ValueError("Power bands must be ordered, contiguous, and non-overlapping.")
        if not 0 <= band["maximum_spell_rank"] <= 10:
            raise ValueError(f"{band['level_band']}: maximum_spell_rank must be between 0 and 10.")
        if not 1 <= band["maximum_actions"] <= 3:
            raise ValueError(f"{band['level_band']}: maximum_actions must be between 1 and 3.")
        expected_minimum = band["maximum_level"] + 1
    if expected_minimum != 21:
        raise ValueError("Power bands must cover every character level from 1 through 20.")


def _band_for_level(level: Any, power_bands: list[dict[str, Any]]) -> dict[str, Any]:
    if not isinstance(level, int) or isinstance(level, bool):
        raise ValueError("Character level must be an integer.")
    for band in power_bands:
        if band["minimum_level"] <= level <= band["maximum_level"]:
            return band
    raise ValueError(f"Character level {level} is outside the supported 1-20 range.")


def _validate_anchor(record_id: str, anchor: Any, band: dict[str, Any]) -> None:
    if not isinstance(anchor, dict):
        raise ValueError(f"{record_id}: pf2e_anchor must be an object.")
    required = {"reference_name", "reference_type", "spell_rank"}
    missing = required.difference(anchor)
    if missing:
        raise ValueError(f"{record_id}: pf2e_anchor is missing {sorted(missing)}.")
    if (
        not isinstance(anchor["spell_rank"], int)
        or isinstance(anchor["spell_rank"], bool)
        or not 0 <= anchor["spell_rank"] <= band["maximum_spell_rank"]
    ):
        raise ValueError(
            f"{record_id}: spell rank exceeds the {band['level_band']} PF2e comparison envelope."
        )
    if not isinstance(anchor["reference_name"], str) or not anchor["reference_name"].strip():
        raise ValueError(f"{record_id}: pf2e_anchor.reference_name cannot be empty.")
    if not isinstance(anchor["reference_type"], str) or not anchor["reference_type"].strip():
        raise ValueError(f"{record_id}: pf2e_anchor.reference_type cannot be empty.")


def _validate_mechanics(
    record_id: str, mechanics: Any, band: dict[str, Any], tier: int
) -> None:
    if not isinstance(mechanics, dict):
        raise ValueError(f"{record_id}: mechanics must be an object.")
    required = {
        "actions",
        "targets",
        "duration",
        "effect_ceiling",
        "requires_save",
        "narrative_trigger",
    }
    missing = required.difference(mechanics)
    if missing:
        raise ValueError(f"{record_id}: mechanics is missing {sorted(missing)}.")
    if (
        not isinstance(mechanics["actions"], int)
        or isinstance(mechanics["actions"], bool)
        or not 1 <= mechanics["actions"] <= band["maximum_actions"]
    ):
        raise ValueError(f"{record_id}: action cost exceeds the {band['level_band']} envelope.")
    if not isinstance(mechanics["requires_save"], bool) or not isinstance(
        mechanics["narrative_trigger"], bool
    ):
        raise ValueError(f"{record_id}: requires_save and narrative_trigger must be boolean.")
    if tier == 1 and mechanics["narrative_trigger"]:
        raise ValueError(f"{record_id}: Tier 1 abilities cannot require a narrative trigger.")
    if tier == 3 and not mechanics["narrative_trigger"]:
        raise ValueError(f"{record_id}: Tier 3 abilities require a narrative trigger.")
