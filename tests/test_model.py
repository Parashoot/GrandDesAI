import unittest

from grand_design.domain import (
    BookClass,
    CharacterProfile,
    ConversionRequest,
    PowerTier,
    SkillSignal,
)
from grand_design.model import RuleBasedModel


class RuleBasedModelTest(unittest.TestCase):
    def test_only_one_secondary_class_becomes_an_archetype(self) -> None:
        request = ConversionRequest(
            character="Klbkch",
            classes=(
                BookClass("Guardsman", 30, PowerTier.STANDARD, is_primary=True),
                BookClass("Commander", 20, PowerTier.ELEVATED, is_secondary=True),
                BookClass("Diplomat", 12, PowerTier.STANDARD),
                BookClass("Assassin", 10, PowerTier.STANDARD),
            ),
        )

        prediction = RuleBasedModel().predict(request)

        self.assertEqual(prediction.primary_class, "Guardsman")
        self.assertEqual(prediction.archetypes, ("Commander",))
        self.assertEqual(prediction.narrative_only, ("Diplomat", "Assassin"))
        self.assertTrue(prediction.needs_human_review)

    def test_character_conversion_uses_tiered_skill_defaults(self) -> None:
        request = ConversionRequest(
            character="Example Innkeeper",
            classes=(BookClass("Innkeeper", 12, PowerTier.STANDARD, is_primary=True),),
        )
        result = RuleBasedModel({"innkeeper": "Bard (Polymath)"}).convert(
            CharacterProfile(
                request=request,
                skills=(
                    SkillSignal("Cooking", False, False),
                    SkillSignal("Rapid Slash", False, True),
                ),
            )
        )

        self.assertEqual(result.pf2e_class, "Bard (Polymath)")
        self.assertEqual([skill.tier for skill in result.skills], [1, 2])
        self.assertFalse(result.skills[0].needs_human_review)
        self.assertTrue(result.skills[1].needs_human_review)

    def test_unmarked_secondary_class_stays_narrative_only(self) -> None:
        request = ConversionRequest(
            character="Two Paths",
            classes=(
                BookClass("Runner", 12, PowerTier.STANDARD, is_primary=True),
                BookClass("Cook", 8, PowerTier.STANDARD),
            ),
        )

        prediction = RuleBasedModel().predict(request)

        self.assertEqual(prediction.archetypes, ())
        self.assertEqual(prediction.narrative_only, ("Cook",))
        self.assertTrue(prediction.needs_human_review)
