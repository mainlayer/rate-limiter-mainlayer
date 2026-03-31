import { MainlayerRateLimiter, MainlayerApiError, rateLimit } from '../src/index';
import type { Request, Response, NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

const mockFetch = jest.fn();
global.fetch = mockFetch;

function mockApiResponse(
  body: object,
  status = 200
): void {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

function mockApiError(status: number, message = 'Internal Server Error'): void {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => ({ error: message }),
    text: async () => message,
  });
}

// ---------------------------------------------------------------------------
// Express mock helpers
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  } as unknown as Request;
}

function makeRes(): { res: Response; json: jest.Mock; status: jest.Mock; setHeader: jest.Mock } {
  const json = jest.fn();
  const setHeader = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res = { status, json, setHeader } as unknown as Response;
  return { res, json, status, setHeader };
}

function makeNext(): NextFunction {
  return jest.fn() as unknown as NextFunction;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockFetch.mockReset();
});

// ===========================================================================
// Constructor validation
// ===========================================================================

describe('MainlayerRateLimiter constructor', () => {
  test('creates instance with valid config', () => {
    const limiter = new MainlayerRateLimiter({ apiKey: 'key_123', resourceId: 'res_abc' });
    expect(limiter).toBeInstanceOf(MainlayerRateLimiter);
  });

  test('throws when apiKey is missing', () => {
    expect(
      () => new MainlayerRateLimiter({ apiKey: '', resourceId: 'res_abc' })
    ).toThrow('apiKey is required');
  });

  test('throws when resourceId is missing', () => {
    expect(
      () => new MainlayerRateLimiter({ apiKey: 'key_123', resourceId: '' })
    ).toThrow('resourceId is required');
  });
});

// ===========================================================================
// checkAndConsume
// ===========================================================================

describe('MainlayerRateLimiter.checkAndConsume', () => {
  const limiter = new MainlayerRateLimiter({ apiKey: 'key_test', resourceId: 'res_test' });

  test('returns allowed=true with remaining credits', async () => {
    mockApiResponse({ allowed: true, remaining: 99, reset_at: '2026-04-01T00:00:00Z' });

    const result = await limiter.checkAndConsume('user_1');

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(99);
    expect(result.resetAt).toBeInstanceOf(Date);
  });

  test('returns allowed=false when credits are exhausted (402)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 402,
      json: async () => ({ allowed: false, remaining: 0 }),
      text: async () => '',
    });

    const result = await limiter.checkAndConsume('user_2');

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  test('returns allowed=false on 429 response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ allowed: false, remaining: 0 }),
      text: async () => '',
    });

    const result = await limiter.checkAndConsume('user_3');

    expect(result.allowed).toBe(false);
  });

  test('throws MainlayerApiError on 500 server error', async () => {
    mockApiError(500, 'Internal Server Error');

    await expect(limiter.checkAndConsume('user_4')).rejects.toThrow(MainlayerApiError);
  });

  test('throws MainlayerApiError on 401 unauthorized', async () => {
    mockApiError(401, 'Unauthorized');

    await expect(limiter.checkAndConsume('user_5')).rejects.toThrow(MainlayerApiError);
  });

  test('throws when identifier is empty', async () => {
    await expect(limiter.checkAndConsume('')).rejects.toThrow('identifier is required');
  });

  test('sends correct request body to Mainlayer API', async () => {
    mockApiResponse({ allowed: true, remaining: 50 });

    await limiter.checkAndConsume('wallet_xyz');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.mainlayer.xyz/v1/entitlements/consume',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer key_test',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          resource_id: 'res_test',
          identifier: 'wallet_xyz',
          quantity: 1,
        }),
      })
    );
  });

  test('handles missing reset_at gracefully', async () => {
    mockApiResponse({ allowed: true, remaining: 10 });

    const result = await limiter.checkAndConsume('user_6');

    expect(result.resetAt).toBeUndefined();
  });

  test('MainlayerApiError includes status code', async () => {
    mockApiError(503, 'Service Unavailable');

    try {
      await limiter.checkAndConsume('user_7');
    } catch (err) {
      expect(err).toBeInstanceOf(MainlayerApiError);
      expect((err as MainlayerApiError).statusCode).toBe(503);
    }
  });
});

// ===========================================================================
// peek
// ===========================================================================

describe('MainlayerRateLimiter.peek', () => {
  const limiter = new MainlayerRateLimiter({ apiKey: 'key_test', resourceId: 'res_test' });

  test('returns credit balance without consuming', async () => {
    mockApiResponse({ allowed: true, remaining: 42 });

    const result = await limiter.peek('user_peek');

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(42);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.mainlayer.xyz/v1/entitlements/check',
      expect.anything()
    );
  });

  test('throws when identifier is empty', async () => {
    await expect(limiter.peek('')).rejects.toThrow('identifier is required');
  });

  test('throws MainlayerApiError on non-ok response', async () => {
    mockApiError(500);

    await expect(limiter.peek('user_peek2')).rejects.toThrow(MainlayerApiError);
  });
});

// ===========================================================================
// middleware
// ===========================================================================

describe('MainlayerRateLimiter.middleware', () => {
  const limiter = new MainlayerRateLimiter({ apiKey: 'key_mw', resourceId: 'res_mw' });

  test('calls next() when credits are available', async () => {
    mockApiResponse({ allowed: true, remaining: 5 });

    const mw = limiter.middleware();
    const req = makeReq();
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  test('responds 429 when credits are exhausted', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ allowed: false, remaining: 0 }),
      text: async () => '',
    });

    const mw = limiter.middleware();
    const req = makeReq();
    const { res, status } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(status).toHaveBeenCalledWith(429);
    expect(next).not.toHaveBeenCalled();
  });

  test('sets X-RateLimit-Remaining header', async () => {
    mockApiResponse({ allowed: true, remaining: 7 });

    const mw = limiter.middleware();
    const req = makeReq();
    const { res, setHeader } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 7);
  });

  test('sets X-RateLimit-Reset header when reset_at is present', async () => {
    const resetAt = '2026-04-01T00:00:00Z';
    mockApiResponse({ allowed: true, remaining: 3, reset_at: resetAt });

    const mw = limiter.middleware();
    const req = makeReq();
    const { res, setHeader } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(setHeader).toHaveBeenCalledWith('X-RateLimit-Reset', new Date(resetAt).toISOString());
  });

  test('uses X-Forwarded-For header for identifier', async () => {
    mockApiResponse({ allowed: true, remaining: 1 });

    const mw = limiter.middleware();
    const req = makeReq({ headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' } });
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.identifier).toBe('203.0.113.5');
  });

  test('uses custom getIdentifier function', async () => {
    mockApiResponse({ allowed: true, remaining: 2 });

    const mw = limiter.middleware((req) => (req.headers as Record<string, string>)['x-api-key'] ?? 'anon');
    const req = makeReq({ headers: { 'x-api-key': 'client_key_abc' } });
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.identifier).toBe('client_key_abc');
  });

  test('passes API errors to next(err)', async () => {
    mockApiError(500);

    const mw = limiter.middleware();
    const req = makeReq();
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(MainlayerApiError));
  });
});

// ===========================================================================
// rateLimit factory
// ===========================================================================

describe('rateLimit factory', () => {
  test('returns an Express RequestHandler', () => {
    const mw = rateLimit({ apiKey: 'key_rl', resourceId: 'res_rl' });
    expect(typeof mw).toBe('function');
    expect(mw.length).toBe(3);
  });

  test('allows request when credits available', async () => {
    mockApiResponse({ allowed: true, remaining: 10 });

    const mw = rateLimit({ apiKey: 'key_rl', resourceId: 'res_rl' });
    const req = makeReq();
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  test('blocks request with default 429 when credits exhausted', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ allowed: false, remaining: 0 }),
      text: async () => '',
    });

    const mw = rateLimit({ apiKey: 'key_rl', resourceId: 'res_rl' });
    const req = makeReq();
    const { res, status } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(status).toHaveBeenCalledWith(429);
  });

  test('uses custom statusCode option', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 402,
      json: async () => ({ allowed: false, remaining: 0 }),
      text: async () => '',
    });

    const mw = rateLimit({ apiKey: 'key_rl', resourceId: 'res_rl', statusCode: 402 });
    const req = makeReq();
    const { res, status } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(status).toHaveBeenCalledWith(402);
  });

  test('uses custom limitExceededMessage', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ allowed: false, remaining: 0 }),
      text: async () => '',
    });

    const mw = rateLimit({
      apiKey: 'key_rl',
      resourceId: 'res_rl',
      limitExceededMessage: 'Custom message',
    });
    const req = makeReq();
    const { res, status } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    const jsonCall = (status().json as jest.Mock).mock.calls[0][0];
    expect(jsonCall.message).toBe('Custom message');
  });

  test('uses custom getIdentifier function', async () => {
    mockApiResponse({ allowed: true, remaining: 5 });

    const mw = rateLimit({
      apiKey: 'key_rl',
      resourceId: 'res_rl',
      getIdentifier: (req) => (req.headers as Record<string, string>)['x-user-id'] ?? 'anon',
    });
    const req = makeReq({ headers: { 'x-user-id': 'user_999' } });
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.identifier).toBe('user_999');
  });
});
