# rate-limiter-mainlayer
![CI](https://github.com/mainlayer/rate-limiter-mainlayer/actions/workflows/ci.yml/badge.svg) ![License](https://img.shields.io/badge/license-MIT-blue)

Rate limiter backed by Mainlayer credits. Higher subscription tier = higher rate limits. Free tier: 10 req/min. Pro: 100 req/min. Enterprise: unlimited.

## Install

```bash
pip install mainlayer fastapi uvicorn httpx
```

## Quickstart

```python
from src.rate_limiter import RateLimiter

limiter = RateLimiter(api_key="your-mainlayer-key", resource_id="your-resource-id")

# In your request handler:
result = await limiter.check("user-or-ip-identifier")
if not result.allowed:
    raise HTTPException(429, f"Rate limit exceeded. Retry in {result.retry_after_seconds}s")
```

## Features

- Tiered rate limits: free (10/min), pro (100/min), enterprise (unlimited)
- Sliding window algorithm — no bursty penalization at window boundaries
- Mainlayer subscription tier lookup with in-process caching (60s TTL)
- Express-style middleware plus standalone checker
- TypeScript + Python implementations

## Tiers

| Tier       | Requests/min | Requests/day |
|------------|-------------|-------------|
| free       | 10          | 1,000       |
| pro        | 100         | 50,000      |
| enterprise | unlimited   | unlimited   |

## Run demo

```bash
MAINLAYER_API_KEY=... MAINLAYER_RESOURCE_ID=... uvicorn src.main:app --port 8005 --reload
```

📚 [mainlayer.fr](https://mainlayer.fr)
