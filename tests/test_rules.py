import unittest

from grand_design.domain import PowerTier
from grand_design.rules import effective_level, pf2e_band, skill_tier


class RulesTest(unittest.TestCase):
    def test_elevated_level_rounds_up(self) -> None:
        self.assertEqual(effective_level(39, PowerTier.ELEVATED), 51)

    def test_documented_level_bands(self) -> None:
        self.assertEqual(pf2e_band(10), "1-4")
        self.assertEqual(pf2e_band(11), "5-8")
        self.assertEqual(pf2e_band(30), "9-11")
        self.assertEqual(pf2e_band(40), "12-14")
        self.assertEqual(pf2e_band(41), "15-18")

    def test_skill_tier_checklist_stops_at_first_match(self) -> None:
        self.assertEqual(skill_tier(True, True), 3)
        self.assertEqual(skill_tier(False, True), 2)
        self.assertEqual(skill_tier(False, False), 1)
