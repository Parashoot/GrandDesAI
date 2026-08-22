import unittest

from grand_design.class_corpus import validate_class_corpus


class ClassCorpusTest(unittest.TestCase):
    def setUp(self) -> None:
        self.record = {
            "id": "train-valid",
            "split": "train",
            "concept": "A mobile original character.",
            "primary": {
                "book_class": "Runner",
                "book_level": 12,
                "power_tier": "standard",
                "feat_chain_evidence": ["movement", "survival"],
            },
            "secondaries": [],
            "expected": {
                "pf2e_chassis": "Ranger",
                "pf2e_level_band": "5-8",
                "archetypes": [],
            },
            "guardrails": ["No flight."],
        }

    def test_accepts_a_level_consistent_train_eval_pair(self) -> None:
        evaluation = dict(self.record, id="eval-valid", split="eval")

        self.assertEqual(validate_class_corpus([self.record, evaluation]), {"train": 1, "eval": 1})

    def test_rejects_level_band_mismatch(self) -> None:
        invalid = dict(self.record, expected=dict(self.record["expected"], pf2e_level_band="15-18"))

        with self.assertRaisesRegex(ValueError, "PF2e level band"):
            validate_class_corpus([invalid, dict(self.record, id="eval-valid", split="eval")])
