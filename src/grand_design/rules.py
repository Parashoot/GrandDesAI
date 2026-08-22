"""Deterministic rules extracted from the project conversion documents."""

from __future__ import annotations

import math

from .domain import PowerTier

_MULTIPLIERS = {
    PowerTier.STANDARD: 1.0,
    PowerTier.ELEVATED: 1.3,
    PowerTier.PRESTIGE: 2.0,
}


def effective_level(book_level: int, power_tier: PowerTier) -> int:
    """Return the rounded-up effective level used by the project level bands."""
    if book_level < 1:
        raise ValueError("Book level must be at least 1.")
    return math.ceil(book_level * _MULTIPLIERS[power_tier])


def pf2e_band(level: int) -> str:
    """Return the documented PF2e range without falsely choosing an exact level."""
    if level < 1:
        raise ValueError("Effective level must be at least 1.")
    if level <= 10:
        return "1-4"
    if level <= 20:
        return "5-8"
    if level <= 30:
        return "9-11"
    if level <= 40:
        return "12-14"
    return "15-18"


def skill_tier(changes_identity: bool, maps_to_existing_mechanic: bool) -> int:
    """Apply the project's ordered Skill-tier decision checklist."""
    if changes_identity:
        return 3
    if maps_to_existing_mechanic:
        return 2
    return 1
