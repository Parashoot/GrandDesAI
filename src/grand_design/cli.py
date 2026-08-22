"""Command-line validation and baseline evaluation."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .class_corpus import validate_class_corpus
from .corpus import score_ability_predictions, validate_ability_corpus
from .data import class_recommendations, load_jsonl, request_from_record, validate_source_record
from .domain import CharacterProfile, SkillSignal
from .model import RuleBasedModel

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_ROOT = PROJECT_ROOT / "data"


def validate_data() -> int:
    for filename, kind in (("classes.jsonl", "class"), ("skills.jsonl", "skill")):
        for record in load_jsonl(DATA_ROOT / filename):
            validate_source_record(record, kind)
    for record in load_jsonl(DATA_ROOT / "evaluations" / "known_conversions.jsonl"):
        request_from_record(record)
        if "expected" not in record:
            raise ValueError(f"Evaluation record {record.get('id', '<unknown>')} is missing expected output.")
    validate_ability_corpus(
        load_jsonl(DATA_ROOT / "ability_scenarios.jsonl"),
        json.loads((DATA_ROOT / "pf2e_power_bands.json").read_text(encoding="utf-8")),
    )
    validate_class_corpus(load_jsonl(DATA_ROOT / "class_scenarios.jsonl"))
    print("Data validation passed.")
    return 0


def evaluate() -> int:
    model = RuleBasedModel()
    failures = 0
    records = load_jsonl(DATA_ROOT / "evaluations" / "known_conversions.jsonl")
    for record in records:
        prediction = model.predict(request_from_record(record))
        expected = record["expected"]
        actual = {
            "primary_class": prediction.primary_class,
            "archetypes": list(prediction.archetypes),
            "narrative_only": list(prediction.narrative_only),
            "effective_level": prediction.effective_level,
            "pf2e_band": prediction.pf2e_band,
        }
        mismatch = {key: (expected[key], actual[key]) for key in expected if expected[key] != actual[key]}
        if mismatch:
            failures += 1
            print(f"FAIL {record['id']}: {mismatch}")
        else:
            print(f"PASS {record['id']}")
    print(f"{len(records) - failures}/{len(records)} evaluation cases passed.")
    return 1 if failures else 0


def corpus_report() -> int:
    ability_counts = validate_ability_corpus(
        load_jsonl(DATA_ROOT / "ability_scenarios.jsonl"),
        json.loads((DATA_ROOT / "pf2e_power_bands.json").read_text(encoding="utf-8")),
    )
    class_counts = validate_class_corpus(load_jsonl(DATA_ROOT / "class_scenarios.jsonl"))
    print(
        "Ability corpus: "
        f"{ability_counts['train']} train, {ability_counts['eval']} eval; "
        f"Tier 1: {ability_counts['tier_1']}, Tier 2: {ability_counts['tier_2']}, "
        f"Tier 3: {ability_counts['tier_3']}. "
        f"Class corpus: {class_counts['train']} train, {class_counts['eval']} eval."
    )
    return 0


def evaluate_abilities(predictions_path: Path) -> int:
    records = load_jsonl(DATA_ROOT / "ability_scenarios.jsonl")
    predictions = load_jsonl(predictions_path)
    power_bands = json.loads((DATA_ROOT / "pf2e_power_bands.json").read_text(encoding="utf-8"))
    score = score_ability_predictions(records, predictions, power_bands)
    print(
        "Held-out ability evaluation: "
        f"exact={score['exact']}/{score['total']}; "
        f"tier={score['tier_correct']}/{score['total']}; "
        f"safe={score['safe']}/{score['total']}."
    )
    return 0 if score["safe"] == score["total"] else 1


def convert(input_path: Path) -> int:
    record = json.loads(input_path.read_text(encoding="utf-8"))
    if not isinstance(record, dict):
        raise ValueError("Conversion input must be a JSON object.")
    request = request_from_record(record)
    try:
        skills = tuple(
            SkillSignal(
                name=item["name"],
                changes_identity=item["changes_identity"],
                maps_to_existing_mechanic=item["maps_to_existing_mechanic"],
                pf2e_equivalent=item.get("pf2e_equivalent"),
            )
            for item in record.get("skills", [])
        )
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError(f"Invalid skill input: {error}") from error
    model = RuleBasedModel(class_recommendations(DATA_ROOT / "classes.jsonl"))
    result = model.convert(CharacterProfile(request=request, skills=skills))
    prediction = result.class_prediction
    print(f"### {request.character}")
    print(f"- Book Class(es): {', '.join(item.name for item in request.classes)}")
    archetypes = ", ".join(prediction.archetypes) or "None"
    print(f"- PF2e Class + Archetype(s): {result.pf2e_class}; archetype(s): {archetypes}")
    print(
        "- Book class level(s) → Power Tier → PF2e level: "
        f"{prediction.primary_class} {next(item.level for item in request.classes if item.name == prediction.primary_class)} "
        f"→ {prediction.effective_level} effective → PF2e {prediction.pf2e_band}"
    )
    print("- Key Skills:")
    for skill in result.skills:
        print(f"  - [{skill.name}] — Tier {skill.tier} — PF2e equivalent: {skill.pf2e_equivalent}")
    print("- Open questions / judgment calls made:")
    for question in result.open_questions:
        print(f"  - {question}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Grand Design AI foundation tools.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("validate-data")
    subparsers.add_parser("evaluate")
    subparsers.add_parser("corpus-report")
    ability_parser = subparsers.add_parser("evaluate-abilities")
    ability_parser.add_argument("--predictions", required=True, type=Path)
    convert_parser = subparsers.add_parser("convert")
    convert_parser.add_argument("--input", required=True, type=Path)
    arguments = parser.parse_args()
    try:
        if arguments.command == "validate-data":
            return validate_data()
        if arguments.command == "evaluate":
            return evaluate()
        if arguments.command == "corpus-report":
            return corpus_report()
        if arguments.command == "evaluate-abilities":
            return evaluate_abilities(arguments.predictions)
        return convert(arguments.input)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        parser.error(str(error))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
