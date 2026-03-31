"""Tests for the Mainlayer rate limiter."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from src.main import app, _limiter
from src.rate_limiter import RateLimiter, RateLimitResult
from src.tiers import ENTERPRISE, FREE, PRO, get_tier


# ---------------------------------------------------------------------------
# Tier tests
# ---------------------------------------------------------------------------


def test_get_tier_free():
    assert get_tier("free") == FREE
    assert FREE.requests_per_minute == 10


def test_get_tier_pro():
    assert get_tier("pro") == PRO
    assert PRO.requests_per_minute == 100


def test_get_tier_enterprise():
    assert get_tier("enterprise") == ENTERPRISE
    assert ENTERPRISE.is_unlimited is True
    assert ENTERPRISE.requests_per_minute is None


def test_get_tier_unknown_falls_back_to_free():
    t = get_tier("bogus-plan")
    assert t == FREE


# ---------------------------------------------------------------------------
# RateLimiter unit tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_free_tier_allows_up_to_limit():
    limiter = RateLimiter(api_key="", resource_id="")
    # Patch tier lookup to return FREE
    with patch.object(limiter, "get_tier", new_callable=AsyncMock, return_value=FREE):
        results = []
        for _ in range(FREE.requests_per_minute + 5):
            r = await limiter.check("test-user")
            results.append(r.allowed)

    assert results[:FREE.requests_per_minute] == [True] * FREE.requests_per_minute
    assert results[FREE.requests_per_minute:] == [False] * 5


@pytest.mark.asyncio
async def test_enterprise_tier_always_allowed():
    limiter = RateLimiter(api_key="", resource_id="")
    with patch.object(limiter, "get_tier", new_callable=AsyncMock, return_value=ENTERPRISE):
        results = [await limiter.check("enterprise-user") for _ in range(200)]

    assert all(r.allowed for r in results)


@pytest.mark.asyncio
async def test_different_identifiers_have_separate_windows():
    limiter = RateLimiter(api_key="", resource_id="")
    with patch.object(limiter, "get_tier", new_callable=AsyncMock, return_value=FREE):
        # Exhaust user-a
        for _ in range(FREE.requests_per_minute):
            await limiter.check("user-a")
        blocked_a = await limiter.check("user-a")

        # user-b should still be allowed
        allowed_b = await limiter.check("user-b")

    assert blocked_a.allowed is False
    assert allowed_b.allowed is True


@pytest.mark.asyncio
async def test_reset_clears_window():
    limiter = RateLimiter(api_key="", resource_id="")
    with patch.object(limiter, "get_tier", new_callable=AsyncMock, return_value=FREE):
        for _ in range(FREE.requests_per_minute):
            await limiter.check("reset-user")
        blocked = await limiter.check("reset-user")
        assert blocked.allowed is False

    limiter.reset("reset-user")

    with patch.object(limiter, "get_tier", new_callable=AsyncMock, return_value=FREE):
        allowed = await limiter.check("reset-user")
    assert allowed.allowed is True


# ---------------------------------------------------------------------------
# FastAPI integration tests
# ---------------------------------------------------------------------------


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _reset_limiter():
    yield
    # Flush state between tests
    _limiter._windows.clear()
    _limiter._cache._cache.clear()


def test_health(client):
    resp = client.get("/health")
    assert resp.status_code == 200


def test_public_root(client):
    resp = client.get("/")
    assert resp.status_code == 200
    assert "tiers" in resp.json()


@patch.object(RateLimiter, "get_tier", new_callable=AsyncMock, return_value=FREE)
def test_api_data_allowed(mock_tier, client):
    resp = client.get("/api/data", headers={"x-caller-id": "allowed-user"})
    assert resp.status_code == 200
    assert "data" in resp.json()


@patch.object(RateLimiter, "get_tier", new_callable=AsyncMock, return_value=FREE)
def test_api_data_rate_limited(mock_tier, client):
    # Exhaust the FREE limit
    for _ in range(FREE.requests_per_minute):
        client.get("/api/data", headers={"x-caller-id": "heavy-user"})

    resp = client.get("/api/data", headers={"x-caller-id": "heavy-user"})
    assert resp.status_code == 429
    body = resp.json()
    assert body["detail"]["error"] == "rate_limit_exceeded"


def test_api_requires_caller_id(client):
    resp = client.get("/api/data")
    assert resp.status_code == 422
