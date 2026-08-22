"""Stable, model-agnostic contracts for conversion records."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class PowerTier(str, Enum):
    STANDARD = "standard"
    ELEVATED = "elevated"
    PRESTIGE = "prestige"


@dataclass(frozen=True)
class BookClass:
    name: str
    level: int
    power_tier: PowerTier
    is_primary: bool = False
    is_secondary: bool = False

    def __post_init__(self) -> None:
        if not self.name.strip():
            raise ValueError("Book class name cannot be empty.")
        if self.level < 1:
            raise ValueError("Book class level must be at least 1.")
        if self.is_primary and self.is_secondary:
            raise ValueError("A book class cannot be both primary and secondary.")


@dataclass(frozen=True)
class SkillSignal:
    """Human-annotated evidence used to apply the documented tier checklist."""

    name: str
    changes_identity: bool
    maps_to_existing_mechanic: bool
    pf2e_equivalent: str | None = None

    def __post_init__(self) -> None:
        if not self.name.strip():
            raise ValueError("Skill name cannot be empty.")


@dataclass(frozen=True)
class ConversionRequest:
    character: str
    classes: tuple[BookClass, ...]

    def __post_init__(self) -> None:
        if not self.character.strip():
            raise ValueError("Character name cannot be empty.")
        if not self.classes:
            raise ValueError("At least one book class is required.")
        if sum(item.is_primary for item in self.classes) > 1:
            raise ValueError("Only one class can be explicitly primary.")
        if sum(item.is_secondary for item in self.classes) > 1:
            raise ValueError("Only one class can be explicitly secondary.")


@dataclass(frozen=True)
class CharacterProfile:
    """Complete, reviewed input for a table-ready character conversion."""

    request: ConversionRequest
    skills: tuple[SkillSignal, ...] = ()


@dataclass(frozen=True)
class SkillConversion:
    name: str
    tier: int
    pf2e_equivalent: str
    needs_human_review: bool


@dataclass(frozen=True)
class ConversionPrediction:
    primary_class: str
    archetypes: tuple[str, ...]
    narrative_only: tuple[str, ...]
    effective_level: int
    pf2e_band: str
    needs_human_review: bool
    rationale: str


@dataclass(frozen=True)
class CharacterConversion:
    """A renderable proposal in the project's per-character documentation format."""

    class_prediction: ConversionPrediction
    pf2e_class: str
    skills: tuple[SkillConversion, ...]
    open_questions: tuple[str, ...]
