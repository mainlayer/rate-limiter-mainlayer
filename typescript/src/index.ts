import type { Request, Response, NextFunction, RequestHandler } from 'express';

const MAINLAYER_API_BASE = 'https://api.mainlayer.fr';

export interface RateLimiterConfig {
  apiKey: string;
  resourceId: string;
  /**
   * Custom error message returned to clients when rate limit is exceeded.
   * Defaults to "Rate limit exceeded. Purchase more credits at mainlayer.fr"
   */
  limitExceededMessage?: string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt?: Date;
}

export interface RateLimitOptions {
  apiKey: string;
  resourceId: string;
  /**
   * Extract identifier from request. Defaults to IP address.
   */
  getIdentifier?: (req: Request) => string;
  /**
   * Custom error message returned to clients when rate limit is exceeded.
   */
  limitExceededMessage?: string;
  /**
   * HTTP status code to use when rate limit is exceeded. Defaults to 429.
   */
  statusCode?: number;
}

export interface EntitlementResponse {
  allowed: boolean;
  remaining: number;
  reset_at?: string;
  message?: string;
}

export class MainlayerRateLimiter {
  private readonly apiKey: string;
  private readonly resourceId: string;
  private readonly limitExceededMessage: string;

  constructor(config: RateLimiterConfig) {
    if (!config.apiKey) {
      throw new Error('MainlayerRateLimiter: apiKey is required');
    }
    if (!config.resourceId) {
      throw new Error('MainlayerRateLimiter: resourceId is required');
    }

    this.apiKey = config.apiKey;
    this.resourceId = config.resourceId;
    this.limitExceededMessage =
      config.limitExceededMessage ??
      'Rate limit exceeded. Purchase more credits at mainlayer.fr';
  }

  /**
   * Express middleware that enforces credit-based rate limiting.
   * Uses the client IP address as the identifier by default.
   */
  middleware(getIdentifier?: (req: Request) => string): RequestHandler {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const identifier = getIdentifier
        ? getIdentifier(req)
        : this.extractIp(req);

      try {
        const result = await this.checkAndConsume(identifier);

        res.setHeader('X-RateLimit-Remaining', result.remaining);
        if (result.resetAt) {
          res.setHeader('X-RateLimit-Reset', result.resetAt.toISOString());
        }

        if (!result.allowed) {
          res.status(429).json({
            error: 'rate_limit_exceeded',
            message: this.limitExceededMessage,
            remaining: result.remaining,
            resetAt: result.resetAt?.toISOString(),
          });
          return;
        }

        next();
      } catch (err) {
        next(err);
      }
    };
  }

  /**
   * Check whether the given identifier has credits remaining and, if so,
   * consume one credit. Safe to call outside of an Express context.
   */
  async checkAndConsume(identifier: string): Promise<RateLimitResult> {
    if (!identifier) {
      throw new Error('MainlayerRateLimiter.checkAndConsume: identifier is required');
    }

    const response = await fetch(
      `${MAINLAYER_API_BASE}/v1/entitlements/consume`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          resource_id: this.resourceId,
          identifier,
          quantity: 1,
        }),
      }
    );

    if (!response.ok && response.status !== 402 && response.status !== 429) {
      const body = await response.text();
      throw new MainlayerApiError(
        `Mainlayer API request failed with status ${response.status}: ${body}`,
        response.status
      );
    }

    const data = (await response.json()) as EntitlementResponse;

    return {
      allowed: data.allowed,
      remaining: data.remaining ?? 0,
      resetAt: data.reset_at ? new Date(data.reset_at) : undefined,
    };
  }

  /**
   * Peek at remaining credits for an identifier without consuming any.
   */
  async peek(identifier: string): Promise<RateLimitResult> {
    if (!identifier) {
      throw new Error('MainlayerRateLimiter.peek: identifier is required');
    }

    const response = await fetch(
      `${MAINLAYER_API_BASE}/v1/entitlements/check`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          resource_id: this.resourceId,
          identifier,
        }),
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new MainlayerApiError(
        `Mainlayer API request failed with status ${response.status}: ${body}`,
        response.status
      );
    }

    const data = (await response.json()) as EntitlementResponse;

    return {
      allowed: data.allowed,
      remaining: data.remaining ?? 0,
      resetAt: data.reset_at ? new Date(data.reset_at) : undefined,
    };
  }

  private extractIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
      return first.trim();
    }
    return req.socket?.remoteAddress ?? 'unknown';
  }
}

/**
 * Error thrown when the Mainlayer API returns an unexpected error response.
 */
export class MainlayerApiError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'MainlayerApiError';
    this.statusCode = statusCode;
  }
}

/**
 * Factory function that creates an Express middleware enforcing credit-based
 * rate limiting via Mainlayer entitlements.
 *
 * @example
 * ```typescript
 * import express from 'express';
 * import { rateLimit } from '@mainlayer/rate-limiter';
 *
 * const app = express();
 *
 * app.use(rateLimit({
 *   apiKey: process.env.MAINLAYER_API_KEY!,
 *   resourceId: 'my-api-resource',
 * }));
 * ```
 */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  const limiter = new MainlayerRateLimiter({
    apiKey: options.apiKey,
    resourceId: options.resourceId,
    limitExceededMessage: options.limitExceededMessage,
  });

  const statusCode = options.statusCode ?? 429;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const identifier = options.getIdentifier
      ? options.getIdentifier(req)
      : extractIpFromRequest(req);

    try {
      const result = await limiter.checkAndConsume(identifier);

      res.setHeader('X-RateLimit-Remaining', result.remaining);
      if (result.resetAt) {
        res.setHeader('X-RateLimit-Reset', result.resetAt.toISOString());
      }

      if (!result.allowed) {
        res.status(statusCode).json({
          error: 'rate_limit_exceeded',
          message:
            options.limitExceededMessage ??
            'Rate limit exceeded. Purchase more credits at mainlayer.fr',
          remaining: result.remaining,
          resetAt: result.resetAt?.toISOString(),
        });
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

function extractIpFromRequest(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
    return first.trim();
  }
  return req.socket?.remoteAddress ?? 'unknown';
}
