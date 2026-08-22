"""Validation for original character concepts mapped to PF2e class chassis."""

from __future__ import annotations

from typing import Any

from .domain import PowerTier
from .rules import effective_level, pf2e_band

_CHASSIS = {
    "Alchemist",
    "Bard",
    "Champion",
    "Cleric",
    "Druid",
    "Fighter",
    "Inventor",
    "Investigator",
    "Kineticist",
    "Magus",
    "Monk",
    "Oracle",
    "Psychic",
    "Ranger",
    "Rogue",
    "Sorcerer",
    "Summoner",
    "Swashbuckler",
    "Thaumaturge",
    "Witch",
}


def validate_class_corpus(records: list[dict[str, Any]]) -> dict[str, int]:
    """Keep class examples mechanically bounded and useful for model evaluation."""
    seen_ids: set[str] = set()
    counts = {"train": 0, "eval": 0}
    for record in records:
        required = {"id", "split", "concept", "primary", "secondaries", "expected", "guardrails"}
        missing = required.difference(record)
        if missing:
            raise ValueError(f"Class record {record.get('id', '<unknown>')} is missing {sorted(missing)}.")
        if record["id"] in seen_ids:
            raise ValueError(f"Duplicate class record id: {record['id']}.")
        seen_ids.add(record["id"])
        if record["split"] not in counts:
            raise ValueError(f"{record['id']}: split must be train or eval.")
        if not isinstance(record["guardrails"], list) or not record["guardrails"]:
            raise ValueError(f"{record['id']}: at least one guardrail is required.")

        primary = record["primary"]
        try:
            tier = PowerTier(primary["power_tier"])
            expected_band = pf2e_band(effective_level(primary["book_level"], tier))
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f"{record['id']}: invalid primary class data.") from error
        if not isinstance(primary.get("feat_chain_evidence"), list) or len(primary["feat_chain_evidence"]) < 2:
            raise ValueError(f"{record['id']}: primary class needs at least two feat-chain evidence tags.")
        expected = record["expected"]
        if expected.get("pf2e_level_band") != expected_band:
            raise ValueError(
                f"{record['id']}: PF2e level band must be {expected_band} for its primary class."
            )
        chassis = expected.get("pf2e_chassis", "").split(" ", 1)[0]
        if chassis not in _CHASSIS:
            raise ValueError(f"{record['id']}: unsupported PF2e chassis {chassis!r}.")
        _validate_secondaries(record["id"], record["secondaries"], expected.get("archetypes"))
        counts[record["split"]] += 1
    if not counts["train"] or not counts["eval"]:
        raise ValueError("The class corpus must contain both train and eval records.")
    return counts


def _validate_secondaries(record_id: str, secondaries: Any, archetypes: Any) -> None:
    if not isinstance(secondaries, list) or not isinstance(archetypes, list):
        raise ValueError(f"{record_id}: secondaries and archetypes must be lists.")
    relevant = [secondary for secondary in secondaries if secondary.get("regularly_relevant")]
    if len(relevant) > 1 or len(archetypes) > 1:
        raise ValueError(f"{record_id}: only one secondary archetype is permitted.")
    if relevant:
        if not relevant[0].get("archetype") or archetypes != [relevant[0]["archetype"]]:
            raise ValueError(f"{record_id}: the relevant secondary must match its one archetype.")
    elif archetypes:
        raise ValueError(f"{record_id}: an archetype requires a regularly relevant secondary.")
