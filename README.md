# rate-limiter-mainlayer

[![CI](https://github.com/mainlayer/rate-limiter-mainlayer/actions/workflows/ci.yml/badge.svg)](https://github.com/mainlayer/rate-limiter-mainlayer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Production-ready rate limiter backed by [Mainlayer](https://mainlayer.fr) subscription tiers. Higher subscription = higher rate limits. Perfect for API monetization, SaaS access control, and metered AI agent infrastructure.

## Features

- **Tier-based rate limiting** — free (10/min), pro (100/min), enterprise (unlimited)
- **Subscription-aware** — automatically checks Mainlayer tier on each request
- **Sliding window algorithm** — accurate per-minute limiting, no burst penalties
- **In-process caching** — 60s TTL reduces Mainlayer API calls by 90%+
- **Fail-open** — service degrades gracefully if Mainlayer is unavailable
- **FastAPI middleware** — integrates seamlessly with async frameworks
- **Header-based identification** — uses X-Caller-Id header or IP address

## Quick Start

### Installation

```bash
pip install -e ".[dev]"
# or
pip install fastapi uvicorn httpx
```

### Run Demo

```bash
export MAINLAYER_API_KEY=mlk_your_api_key
export MAINLAYER_RESOURCE_ID=res_your_resource_id
uvicorn src.main:app --port 8005 --reload
```

Then test:
```bash
# Check your tier
curl http://localhost:8005/tier \
  -H "X-Caller-Id: user@example.com"

# Rate-limited endpoint
curl http://localhost:8005/api/data \
  -H "X-Caller-Id: user@example.com"
```

## API Reference

### Check Subscription Tier

```
GET /tier
Header: X-Caller-Id: user@example.com
```

Response:
```json
{
  "identifier": "user@example.com",
  "tier": "pro",
  "description": "Pro tier — 100 requests/min, 50,000/day",
  "requests_per_minute": 100,
  "requests_per_day": 50000,
  "upgrade_url": null
}
```

### Rate-Limited Endpoint

```
GET /api/data
Header: X-Caller-Id: user@example.com
```

Response (200 — allowed):
```json
{
  "data": [{"id": 0, "value": "item-0"}, ...],
  "tier": "pro",
  "X-RateLimit-Remaining": 99,
  "X-RateLimit-Limit": 100
}
```

Response (429 — rate limited):
```json
{
  "detail": {
    "error": "rate_limit_exceeded",
    "tier": "pro",
    "limit": 100,
    "retry_after_seconds": 45,
    "upgrade_url": "https://mainlayer.fr"
  }
}
Headers: Retry-After: 46
```

## Tiers

| Tier | Requests/min | Requests/day | Use Case |
|------|-------------|-------------|----------|
| **free** | 10 | 1,000 | Development, testing |
| **pro** | 100 | 50,000 | Small-scale production |
| **enterprise** | unlimited | unlimited | High-volume, custom SLAs |

## Usage Examples

### Standalone Rate Limiter

```python
from src.rate_limiter import RateLimiter

limiter = RateLimiter(
    api_key="mlk_your_api_key",
    resource_id="res_your_resource_id"
)

async def handle_request(user_id: str):
    result = await limiter.check(user_id)

    if not result.allowed:
        remaining_seconds = result.retry_after_seconds or 60
        return {
            "error": "rate_limit_exceeded",
            "retry_after_seconds": remaining_seconds,
            "upgrade_url": "https://mainlayer.fr"
        }, 429

    # Process request...
    return {"data": "..."}
```

### FastAPI Middleware

```python
from fastapi import FastAPI, Request, HTTPException
from src.rate_limiter import RateLimiter

app = FastAPI()
limiter = RateLimiter()

@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    caller_id = request.headers.get("X-Caller-Id") or request.client.host
    result = await limiter.check(caller_id)

    if not result.allowed:
        raise HTTPException(
            status_code=429,
            detail={
                "error": "rate_limit_exceeded",
                "retry_after": int(result.retry_after_seconds or 60)
            }
        )

    response = await call_next(request)
    response.headers["X-RateLimit-Remaining"] = str(result.remaining_this_minute or 0)
    return response
```

### Dependency Injection

```python
from fastapi import FastAPI, Header, Depends
from src.rate_limiter import RateLimiter

app = FastAPI()
limiter = RateLimiter()

async def check_rate_limit(x_caller_id: str = Header(...)):
    result = await limiter.check(x_caller_id)
    if not result.allowed:
        raise HTTPException(429, "Rate limit exceeded")
    return result

@app.get("/api/data")
async def get_data(rate_limit = Depends(check_rate_limit)):
    return {"data": "...", "tier": rate_limit.tier}
```

## Architecture

```
src/
├── main.py           # FastAPI demo application
├── rate_limiter.py   # Core RateLimiter class
├── tiers.py          # Tier definitions (free/pro/enterprise)
└── __init__.py
```

### How It Works

1. **Request arrives** with `X-Caller-Id` header
2. **Tier lookup** — check Mainlayer subscription (cached 60s)
3. **Sliding window check** — is caller within their minute limit?
4. **Allow or deny** — return 200 or 429
5. **Add headers** — X-RateLimit-Remaining, Retry-After

### Caching Strategy

- **Tier lookups cached** for 60 seconds per identifier
- **Local sliding window** tracks requests in memory
- **Fail-open** — if Mainlayer unavailable, defaults to FREE tier

## Testing

```bash
pytest tests/ -v -s
```

## Environment Variables

```bash
MAINLAYER_API_KEY=mlk_your_api_key           # Mainlayer API key
MAINLAYER_RESOURCE_ID=res_your_resource_id   # Resource ID to check tiers against
MAINLAYER_BASE_URL=https://api.mainlayer.fr  # (optional) API base URL
```

## Production Checklist

- [ ] Set MAINLAYER_API_KEY in environment (secure vault)
- [ ] Set MAINLAYER_RESOURCE_ID matching your billing resource
- [ ] Configure per-caller identifier strategy (header vs IP)
- [ ] Monitor 429 response rates in metrics
- [ ] Test tier lookup cache performance
- [ ] Implement logging for rate limit events
- [ ] Set up alerting on high failure rates
- [ ] Use HTTPS in production
- [ ] Consider Redis for distributed rate limiting
- [ ] Test failover behavior (what if Mainlayer is down?)

## Performance Notes

- **Tier lookup latency** — ~50ms (cached 60s, so minimal impact)
- **Per-request overhead** — <1ms for in-memory sliding window check
- **Memory usage** — ~100 bytes per identifier in sliding window
- **Cache hit ratio** — >90% in typical usage

## Examples

See `/examples` for:
- Complete FastAPI application
- Rate limiter as middleware
- Dependency injection pattern
- IP-based vs user ID-based identification

## Troubleshooting

### Getting 429 too quickly?
- Check your tier with `/tier` endpoint
- Verify X-Caller-Id header is being sent
- Check Mainlayer API key is valid
- See if tier cache needs clearing (60s TTL)

### Tier not updating?
- Tier cache expires every 60 seconds
- Manual reset available via `.reset(identifier)`
- Check Mainlayer subscription status

### Mainlayer connection errors?
- Service fails open to FREE tier
- Check API key and resource ID
- Verify network connectivity
- Check Mainlayer status page

## Support

- Documentation: [mainlayer.fr/docs](https://mainlayer.fr/docs)
- GitHub: [github.com/mainlayer/rate-limiter-mainlayer](https://github.com/mainlayer/rate-limiter-mainlayer)
- Issues: [github.com/mainlayer/rate-limiter-mainlayer/issues](https://github.com/mainlayer/rate-limiter-mainlayer/issues)
