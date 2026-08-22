"""A swappable conversion-model interface and transparent baseline."""

from __future__ import annotations

from typing import Protocol

from .domain import (
    BookClass,
    CharacterConversion,
    CharacterProfile,
    ConversionPrediction,
    ConversionRequest,
    SkillConversion,
    SkillSignal,
)
from .rules import effective_level, pf2e_band, skill_tier


class ConversionModel(Protocol):
    """The narrow contract future learned-model adapters must satisfy."""

    def predict(self, request: ConversionRequest) -> ConversionPrediction:
        """Produce a conversion proposal that can be evaluated consistently."""


class RuleBasedModel:
    """Baseline enforcing settled project rulings, not a replacement for review."""

    def __init__(self, class_recommendations: dict[str, str] | None = None) -> None:
        self._class_recommendations = class_recommendations or {}

    def predict(self, request: ConversionRequest) -> ConversionPrediction:
        primary = _select_primary(request.classes)
        secondary = next((item for item in request.classes if item.is_secondary), None)
        narrative_only = tuple(
            item.name for item in request.classes if item != primary and item != secondary
        )
        level = effective_level(primary.level, primary.power_tier)
        review_needed = (
            len(request.classes) > 2
            or (len(request.classes) > 1 and secondary is None)
            or primary.power_tier.value == "prestige"
        )

        return ConversionPrediction(
            primary_class=primary.name,
            archetypes=(secondary.name,) if secondary else (),
            narrative_only=narrative_only,
            effective_level=level,
            pf2e_band=pf2e_band(level),
            needs_human_review=review_needed,
            rationale=(
                "Applied the primary-class rule, retained at most one secondary "
                "archetype, and left remaining classes as narrative-only."
            ),
        )

    def convert(self, profile: CharacterProfile) -> CharacterConversion:
        """Produce a complete proposal from reviewed Class and Skill evidence."""
        prediction = self.predict(profile.request)
        primary_key = prediction.primary_class.casefold()
        pf2e_class = self._class_recommendations.get(
            primary_key, "Unresolved; review feat-chain shape before selecting a chassis"
        )
        skills = tuple(self._convert_skill(skill) for skill in profile.skills)
        questions: list[str] = []
        if pf2e_class.startswith("Unresolved"):
            questions.append(f"No reviewed PF2e chassis recommendation exists for [{prediction.primary_class}].")
        if prediction.needs_human_review:
            questions.append("Confirm whether one secondary class is regularly relevant before retaining its archetype.")
        questions.extend(
            f"Choose a concrete PF2e equivalent for [{skill.name}]."
            for skill in skills
            if skill.needs_human_review
        )
        return CharacterConversion(
            class_prediction=prediction,
            pf2e_class=pf2e_class,
            skills=skills,
            open_questions=tuple(questions) or ("None.",),
        )

    @staticmethod
    def _convert_skill(skill: SkillSignal) -> SkillConversion:
        tier = skill_tier(skill.changes_identity, skill.maps_to_existing_mechanic)
        if skill.pf2e_equivalent:
            equivalent = skill.pf2e_equivalent
        elif tier == 1:
            equivalent = "Skill Feat or narrative flavor"
        elif tier == 2:
            equivalent = "Reskin the closest Class Feat or spell"
        else:
            equivalent = "Narrative-milestone-gated custom Archetype Dedication or ability"
        return SkillConversion(
            name=skill.name,
            tier=tier,
            pf2e_equivalent=equivalent,
            needs_human_review=tier in (2, 3) and not skill.pf2e_equivalent,
        )


def _select_primary(classes: tuple[BookClass, ...]) -> BookClass:
    return next((item for item in classes if item.is_primary), max(classes, key=lambda item: item.level))
