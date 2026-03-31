"""
Example: Rate limiter middleware demo.

Simulates requests from callers on different tiers to see rate limiting in action.

Usage:
    MAINLAYER_API_KEY=<key> python examples/middleware_demo.py
"""
import asyncio
import os
import httpx

BASE_URL = "http://localhost:8005"


async def simulate_caller(session: httpx.AsyncClient, caller_id: str, n_requests: int) -> None:
    print(f"\n--- Caller: {caller_id} ({n_requests} requests) ---")
    for i in range(n_requests):
        resp = await session.get(
            "/api/data",
            headers={"x-caller-id": caller_id},
        )
        tier = resp.headers.get("X-RateLimit-Tier", "?")
        remaining = resp.headers.get("X-RateLimit-Remaining", "?")

        if resp.status_code == 200:
            print(f"  [{i+1}] OK | tier={tier} remaining={remaining}")
        elif resp.status_code == 429:
            error = resp.json()
            retry = error.get("detail", {}).get("retry_after_seconds", "?")
            print(f"  [{i+1}] 429 RATE LIMITED | retry_after={retry}s | upgrade: {error.get('detail', {}).get('upgrade_url', '')}")
            break
        else:
            print(f"  [{i+1}] {resp.status_code} ERROR")


async def main() -> None:
    async with httpx.AsyncClient(base_url=BASE_URL) as client:
        # Check public endpoint
        resp = await client.get("/")
        print("Tier limits:", resp.json()["tiers"])

        # Simulate different callers
        await simulate_caller(client, "free-user-abc", 15)   # should hit limit
        await simulate_caller(client, "pro-user-xyz", 5)     # stays within limit


if __name__ == "__main__":
    asyncio.run(main())
