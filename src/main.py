"""
Rate Limiter Demo — FastAPI application.

Demonstrates using MainlayerRateLimiter as middleware. Agents with higher
Mainlayer subscription tiers get higher request rate limits.

Endpoints:
  GET  /                    Public endpoint (no rate limiting)
  GET  /api/data            Rate-limited endpoint (tier-based limits)
  GET  /api/heavy           Rate-limited, heavier endpoint
  GET  /tier                Check your current tier and rate limit info
  GET  /health              Health check
"""
from __future__ import annotations

import logging
import os
import time
from typing import Optional

from fastapi import FastAPI, Header, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .rate_limiter import RateLimiter
from .tiers import ENTERPRISE, FREE, PRO, get_tier

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Mainlayer Rate Limiter Demo",
    description="API rate limiting backed by Mainlayer subscription tiers.",
    version="1.0.0",
)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_limiter = RateLimiter(
    api_key=os.getenv("MAINLAYER_API_KEY", ""),
    resource_id=os.getenv("MAINLAYER_RESOURCE_ID", ""),
)


# ---------------------------------------------------------------------------
# Rate limit dependency
# ---------------------------------------------------------------------------


async def _apply_rate_limit(request: Request, caller_id: str) -> None:
    """
    Apply tier-based rate limiting.

    Raises HTTP 429 if the caller has exceeded their rate limit.
    """
    result = await _limiter.check(caller_id)
    request.state.rate_limit = result

    if not result.allowed:
        headers = {"X-RateLimit-Tier": result.tier}
        if result.retry_after_seconds is not None:
            headers["Retry-After"] = str(int(result.retry_after_seconds) + 1)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "error": "rate_limit_exceeded",
                "tier": result.tier,
                "limit": result.requests_per_minute,
                "retry_after_seconds": result.retry_after_seconds,
                "upgrade_url": "https://mainlayer.fr",
            },
            headers=headers,
        )


# ---------------------------------------------------------------------------
# Middleware: add rate limit headers to all responses
# ---------------------------------------------------------------------------


@app.middleware("http")
async def add_rate_limit_headers(request: Request, call_next):
    """Add rate limit headers to all responses."""
    start_time = time.monotonic() if hasattr(time, 'monotonic') else 0
    response = await call_next(request)
    rl = getattr(request.state, "rate_limit", None)
    if rl:
        response.headers["X-RateLimit-Tier"] = rl.tier
        if rl.remaining_this_minute is not None:
            response.headers["X-RateLimit-Remaining"] = str(rl.remaining_this_minute)
        if rl.requests_per_minute is not None:
            response.headers["X-RateLimit-Limit"] = str(rl.requests_per_minute)
        if rl.retry_after_seconds is not None:
            response.headers["Retry-After"] = str(int(rl.retry_after_seconds) + 1)
    return response


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/health", tags=["system"])
async def health():
    return {"status": "ok"}


@app.get("/", tags=["public"])
async def public_root():
    """Unrestricted public endpoint."""
    return {
        "message": "Mainlayer Rate Limiter Demo",
        "tiers": {
            FREE.name: f"{FREE.requests_per_minute} req/min",
            PRO.name: f"{PRO.requests_per_minute} req/min",
            ENTERPRISE.name: "unlimited",
        },
    }


@app.get("/tier", tags=["info"])
async def get_my_tier(
    request: Request,
    x_caller_id: str = Header(..., description="Your Mainlayer identifier"),
) -> dict:
    """Check your subscription tier and current rate limit allowance."""
    try:
        # Peek at tier without consuming a request
        tier = await _limiter.get_tier(x_caller_id)
        tier_obj = get_tier(tier.name)
        return {
            "identifier": x_caller_id,
            "tier": tier.name,
            "description": tier.description,
            "requests_per_minute": tier.requests_per_minute,
            "requests_per_day": tier.requests_per_day,
            "upgrade_url": "https://mainlayer.fr" if tier.name == "free" else None,
        }
    except Exception as e:
        logger.error(f"Error checking tier for {x_caller_id}: {e}")
        # Return FREE tier on error
        return {
            "identifier": x_caller_id,
            "tier": "free",
            "description": FREE.description,
            "requests_per_minute": FREE.requests_per_minute,
            "requests_per_day": FREE.requests_per_day,
            "upgrade_url": "https://mainlayer.fr",
            "note": "Using free tier due to temporary lookup error",
        }


@app.get("/api/data", tags=["api"])
async def get_data(
    request: Request,
    x_caller_id: str = Header(..., description="Your Mainlayer identifier"),
) -> dict:
    """Rate-limited data endpoint. Limit depends on your Mainlayer subscription tier."""
    await _apply_rate_limit(request, x_caller_id)
    return {
        "data": [{"id": i, "value": f"item-{i}"} for i in range(10)],
        "tier": request.state.rate_limit.tier,
    }


@app.get("/api/heavy", tags=["api"])
async def get_heavy_data(
    request: Request,
    x_caller_id: str = Header(..., description="Your Mainlayer identifier"),
) -> dict:
    """Heavy computation endpoint — also rate-limited by Mainlayer tier."""
    await _apply_rate_limit(request, x_caller_id)
    # Simulate heavier work
    result = sum(i * i for i in range(1_000))
    return {
        "computation": result,
        "tier": request.state.rate_limit.tier,
        "note": "This endpoint does expensive work — upgrade for higher limits.",
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("src.main:app", host="0.0.0.0", port=8005, reload=True)
