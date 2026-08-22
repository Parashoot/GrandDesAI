import unittest

from grand_design.corpus import (
    score_ability_predictions,
    validate_ability_corpus,
    validate_power_bands,
)


class CorpusValidationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.bands = [
            {
                "level_band": "1-4",
                "minimum_level": 1,
                "maximum_level": 4,
                "maximum_spell_rank": 2,
                "maximum_actions": 2,
                "reference": "test",
            },
            {
                "level_band": "5-20",
                "minimum_level": 5,
                "maximum_level": 20,
                "maximum_spell_rank": 10,
                "maximum_actions": 3,
                "reference": "test",
            },
        ]
        self.record = {
            "id": "valid",
            "split": "train",
            "scenario": "An original test scenario.",
            "character_level": 4,
            "ability_name": "[Test]",
            "narrative_intent": "Test an ability.",
            "expected_tier": 2,
            "pf2e_anchor": {
                "reference_name": "Example",
                "reference_type": "spell",
                "spell_rank": 2,
            },
            "mechanics": {
                "actions": 2,
                "targets": "one creature",
                "duration": "instant",
                "effect_ceiling": "test",
                "requires_save": True,
                "narrative_trigger": False,
            },
            "guardrails": ["One bounded effect."],
        }

    def test_reports_split_and_tier_counts(self) -> None:
        evaluation = dict(self.record, id="eval", split="eval")

        counts = validate_ability_corpus([self.record, evaluation], self.bands)

        self.assertEqual(counts["train"], 1)
        self.assertEqual(counts["eval"], 1)
        self.assertEqual(counts["tier_2"], 2)

    def test_rejects_rank_above_level_envelope(self) -> None:
        invalid = dict(self.record, pf2e_anchor=dict(self.record["pf2e_anchor"], spell_rank=3))

        with self.assertRaisesRegex(ValueError, "spell rank exceeds"):
            validate_ability_corpus([invalid, dict(self.record, id="eval", split="eval")], self.bands)

    def test_rejects_bands_without_complete_level_coverage(self) -> None:
        incomplete = [dict(self.bands[0], maximum_level=3)]

        with self.assertRaisesRegex(ValueError, "cover every character level"):
            validate_power_bands(incomplete)

    def test_scores_only_safe_predictions(self) -> None:
        evaluation = dict(self.record, id="eval", split="eval")
        prediction = {
            "id": "eval",
            "expected_tier": 2,
            "spell_rank": 2,
            "actions": 2,
            "narrative_trigger": False,
        }

        score = score_ability_predictions([self.record, evaluation], [prediction], self.bands)

        self.assertEqual(score, {"total": 1, "exact": 1, "tier_correct": 1, "safe": 1})
