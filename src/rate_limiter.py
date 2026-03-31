"""
RateLimiter — checks Mainlayer subscription tier and enforces per-minute limits.

Usage::

    limiter = RateLimiter(api_key="...", resource_id="...")
    result = await limiter.check("user-or-ip-identifier")
    if not result.allowed:
        raise HTTPException(429, "Rate limit exceeded")
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Deque, Dict, Optional

import httpx

from .tiers import FREE, Tier, get_tier

logger = logging.getLogger(__name__)

MAINLAYER_BASE_URL = os.getenv("MAINLAYER_BASE_URL", "https://api.mainlayer.xyz")
_TIER_CACHE_TTL = 60.0  # seconds


@dataclass
class RateLimitResult:
    allowed: bool
    tier: str
    requests_per_minute: Optional[int]  # None = unlimited
    remaining_this_minute: Optional[int]
    retry_after_seconds: Optional[float] = None


class _TierCache:
    """LRU-like cache for Mainlayer subscription tier lookups."""

    def __init__(self, ttl: float = _TIER_CACHE_TTL) -> None:
        self._ttl = ttl
        self._cache: Dict[str, tuple[Tier, float]] = {}

    def get(self, identifier: str) -> Optional[Tier]:
        entry = self._cache.get(identifier)
        if entry and time.monotonic() - entry[1] < self._ttl:
            return entry[0]
        return None

    def set(self, identifier: str, tier: Tier) -> None:
        self._cache[identifier] = (tier, time.monotonic())


class RateLimiter:
    """
    Credit-based rate limiter backed by Mainlayer subscription tiers.

    Sliding-window counter (per-minute) is kept in memory.
    Tier lookups are cached to reduce Mainlayer API calls.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        resource_id: Optional[str] = None,
        fail_open: bool = True,
    ) -> None:
        self._api_key = api_key or os.getenv("MAINLAYER_API_KEY", "")
        self._resource_id = resource_id or os.getenv("MAINLAYER_RESOURCE_ID", "")
        self._fail_open = fail_open
        self._cache = _TierCache()
        # Sliding window: identifier -> deque of request timestamps
        self._windows: Dict[str, Deque[float]] = defaultdict(deque)

    async def get_tier(self, identifier: str) -> Tier:
        """
        Look up the Mainlayer subscription tier for an identifier.

        Returns FREE tier on any error (fail-open behaviour).
        """
        cached = self._cache.get(identifier)
        if cached:
            return cached

        if not self._api_key or not self._resource_id:
            return FREE

        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(
                    f"{MAINLAYER_BASE_URL}/resources/{self._resource_id}/entitlements",
                    params={"identifier": identifier},
                    headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "Content-Type": "application/json",
                    },
                )
                if resp.is_success:
                    data = resp.json()
                    plan = data.get("plan", "free")
                    tier = get_tier(plan)
                    self._cache.set(identifier, tier)
                    return tier
        except (httpx.RequestError, Exception) as exc:
            logger.warning("Mainlayer tier lookup failed for %r: %s", identifier, exc)

        # Fall through to FREE on error
        return FREE

    async def check(self, identifier: str) -> RateLimitResult:
        """
        Check whether the identifier is within their rate limit.

        Records the request timestamp in the sliding window.
        Returns a RateLimitResult with `allowed` and `remaining` fields.
        """
        tier = await self.get_tier(identifier)

        if tier.is_unlimited:
            return RateLimitResult(
                allowed=True,
                tier=tier.name,
                requests_per_minute=None,
                remaining_this_minute=None,
            )

        limit = tier.requests_per_minute  # guaranteed non-None here
        window = self._windows[identifier]
        now = time.monotonic()
        cutoff = now - 60.0

        # Evict timestamps older than 1 minute
        while window and window[0] < cutoff:
            window.popleft()

        count_in_window = len(window)
        allowed = count_in_window < limit

        if allowed:
            window.append(now)

        remaining = max(0, limit - len(window))
        retry_after: Optional[float] = None
        if not allowed and window:
            retry_after = round(60.0 - (now - window[0]), 2)

        return RateLimitResult(
            allowed=allowed,
            tier=tier.name,
            requests_per_minute=limit,
            remaining_this_minute=remaining,
            retry_after_seconds=retry_after if not allowed else None,
        )

    def reset(self, identifier: str) -> None:
        """Reset the sliding window for an identifier (useful for testing)."""
        self._windows.pop(identifier, None)
        self._cache._cache.pop(identifier, None)
