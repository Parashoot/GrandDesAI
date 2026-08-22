"""JSONL loading and validation for reviewed project records."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .domain import BookClass, ConversionRequest, PowerTier


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"{path}:{line_number}: invalid JSON: {error.msg}") from error
        if not isinstance(value, dict):
            raise ValueError(f"{path}:{line_number}: each record must be a JSON object.")
        records.append(value)
    return records


def request_from_record(record: dict[str, Any]) -> ConversionRequest:
    try:
        classes = tuple(
            BookClass(
                name=item["name"],
                level=item["level"],
                power_tier=PowerTier(item["power_tier"]),
                is_primary=item.get("is_primary", False),
                is_secondary=item.get("is_secondary", False),
            )
            for item in record["classes"]
        )
        return ConversionRequest(character=record["character"], classes=classes)
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError(f"Invalid conversion record {record.get('id', '<unknown>')}: {error}") from error


def validate_source_record(record: dict[str, Any], kind: str) -> None:
    required = {"id", "summary", "source_url", "reviewer", "reviewed_on"}
    required.update(
        {"book_class", "power_tier", "pf2e_recommendation"}
        if kind == "class"
        else {"skill", "suggested_tier"}
    )
    missing = required.difference(record)
    if missing:
        raise ValueError(f"{kind} record {record.get('id', '<unknown>')} is missing {sorted(missing)}.")
    if not str(record["source_url"]).startswith("https://"):
        raise ValueError(f"{kind} record {record['id']} must use an HTTPS source_url.")
    if kind == "class":
        try:
            PowerTier(record["power_tier"])
        except ValueError as error:
            raise ValueError(f"class record {record['id']} has an invalid power_tier.") from error
    elif record["suggested_tier"] not in (1, 2, 3):
        raise ValueError(f"skill record {record['id']} has an invalid suggested_tier.")


def class_recommendations(path: Path) -> dict[str, str]:
    """Load reviewed PF2e chassis recommendations keyed by normalized book Class."""
    records = load_jsonl(path)
    for record in records:
        validate_source_record(record, "class")
    return {
        str(record["book_class"]).casefold(): str(record["pf2e_recommendation"])
        for record in records
    }
