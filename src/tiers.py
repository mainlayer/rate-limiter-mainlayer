"""
Tier definitions for Mainlayer credit-based rate limiting.

Higher subscription tiers get higher request rate limits.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional


@dataclass(frozen=True)
class Tier:
    name: str
    requests_per_minute: Optional[int]  # None = unlimited
    requests_per_day: Optional[int]     # None = unlimited
    description: str

    @property
    def is_unlimited(self) -> bool:
        return self.requests_per_minute is None


# ---------------------------------------------------------------------------
# Tier definitions
# ---------------------------------------------------------------------------

FREE = Tier(
    name="free",
    requests_per_minute=10,
    requests_per_day=1_000,
    description="Free tier — 10 requests/min, 1,000/day",
)

PRO = Tier(
    name="pro",
    requests_per_minute=100,
    requests_per_day=50_000,
    description="Pro tier — 100 requests/min, 50,000/day",
)

ENTERPRISE = Tier(
    name="enterprise",
    requests_per_minute=None,   # unlimited
    requests_per_day=None,      # unlimited
    description="Enterprise tier — unlimited requests",
)

# ---------------------------------------------------------------------------
# Lookup helpers
# ---------------------------------------------------------------------------

_TIERS: Dict[str, Tier] = {
    "free": FREE,
    "pro": PRO,
    "enterprise": ENTERPRISE,
}


def get_tier(name: str) -> Tier:
    """
    Return the Tier for the given plan name.

    Falls back to FREE for unknown plan names.
    """
    return _TIERS.get(name.lower(), FREE)


def tier_names() -> list[str]:
    return list(_TIERS.keys())
