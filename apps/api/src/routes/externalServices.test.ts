import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const authState: { value: any } = {
  value: {
    user: { id: 'user-1', email: 'u@example.com', name: 'U' },
    partnerId: 'partner-1',
  },
};

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', authState.value);
    await next();
  },
}));

vi.mock('../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ email: 'u@example.com', name: 'U' }]),
        }),
      }),
    }),
  },
}));

vi.mock('../db/schema', () => ({
  users: {},
}));

const rateLimiterMock = vi.fn();
vi.mock('../services/rate-limit', () => ({
  rateLimiter: (...args: any[]) => rateLimiterMock(...args),
}));

vi.mock('../services/redis', () => ({
  getRedis: () => ({ _fake: true }),
}));

import { externalServicesRoutes } from './externalServices';

const fetchMock = vi.fn();
const originalFetch = global.fetch;

const defaultAllowed = () => ({
  allowed: true,
  remaining: 10,
  resetAt: new Date(Date.now() + 3600_000),
});

describe('externalServicesRoutes', () => {
  const originalEnv = process.env.BREEZE_BILLING_URL;

  beforeEach(() => {
    fetchMock.mockReset();
    rateLimiterMock.mockReset();
    rateLimiterMock.mockImplementation(async () => defaultAllowed());
    global.fetch = fetchMock as any;
    authState.value = {
      user: { id: 'user-1', email: 'u@example.com', name: 'U' },
      partnerId: 'partner-1',
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalEnv === undefined) {
      delete process.env.BREEZE_BILLING_URL;
    } else {
      process.env.BREEZE_BILLING_URL = originalEnv;
    }
  });

  const app = () => new Hono().route('/', externalServicesRoutes);

  describe('POST /billing/portal', () => {
    it('503 when BREEZE_BILLING_URL unset', async () => {
      delete process.env.BREEZE_BILLING_URL;
      const res = await app().request('/billing/portal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ returnUrl: 'https://example.com/back' }),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'not_configured' });
    });

    it('forwards to upstream and returns url', async () => {
      process.env.BREEZE_BILLING_URL = 'http://billing';
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ url: 'https://stripe/x' }), { status: 200 })
      );
      const res = await app().request('/billing/portal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ returnUrl: 'https://example.com/back' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ url: 'https://stripe/x' });
      expect(fetchMock).toHaveBeenCalledWith(
        'http://billing/portal-sessions',
        expect.objectContaining({ method: 'POST' })
      );
      const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body as string);
      expect(body).toEqual({ partner_id: 'partner-1', return_url: 'https://example.com/back' });
      // Rate limit key is scoped to user id
      expect(rateLimiterMock).toHaveBeenCalledWith(
        expect.anything(),
        'billing-portal:user:user-1',
        10,
        3600
      );
    });

    it('400 on invalid body', async () => {
      process.env.BREEZE_BILLING_URL = 'http://billing';
      const res = await app().request('/billing/portal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ returnUrl: 'not-a-url' }),
      });
      expect(res.status).toBe(400);
    });

    it('passes through 404 from upstream', async () => {
      process.env.BREEZE_BILLING_URL = 'http://billing';
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'no_billing_record' }), { status: 404 })
      );
      const res = await app().request('/billing/portal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ returnUrl: 'https://example.com/back' }),
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'no_billing_record' });
    });

    it('502 upstream_unavailable when fetch throws', async () => {
      process.env.BREEZE_BILLING_URL = 'http://billing';
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const res = await app().request('/billing/portal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ returnUrl: 'https://example.com/back' }),
      });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'upstream_unavailable' });
    });

    it('502 upstream_invalid_response on non-JSON body', async () => {
      process.env.BREEZE_BILLING_URL = 'http://billing';
      fetchMock.mockResolvedValueOnce(
        new Response('<html>gateway timeout</html>', { status: 502 })
      );
      const res = await app().request('/billing/portal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ returnUrl: 'https://example.com/back' }),
      });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'upstream_invalid_response' });
    });

    it('403 when auth.partnerId missing', async () => {
      process.env.BREEZE_BILLING_URL = 'http://billing';
      authState.value = {
        user: { id: 'user-1', email: 'u@example.com', name: 'U' },
        // no partnerId
      };
      const res = await app().request('/billing/portal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ returnUrl: 'https://example.com/back' }),
      });
      expect(res.status).toBe(403);
    });

    it('429 when rate limit exceeded', async () => {
      process.env.BREEZE_BILLING_URL = 'http://billing';
      rateLimiterMock.mockResolvedValueOnce({
        allowed: false,
        remaining: 0,
        resetAt: new Date(Date.now() + 42_000),
      });
      const res = await app().request('/billing/portal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ returnUrl: 'https://example.com/back' }),
      });
      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: string; retryAfter: number };
      expect(body.error).toBe('rate_limited');
      expect(body.retryAfter).toBeGreaterThan(0);
      expect(body.retryAfter).toBeLessThanOrEqual(42);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('POST /support', () => {
    it('503 when BREEZE_BILLING_URL unset', async () => {
      delete process.env.BREEZE_BILLING_URL;
      const res = await app().request('/support', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subject: 'hi', message: 'help' }),
      });
      expect(res.status).toBe(503);
    });

    it('forwards with user email and name', async () => {
      process.env.BREEZE_BILLING_URL = 'http://billing';
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );
      const res = await app().request('/support', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subject: 'hi', message: 'help' }),
      });
      expect(res.status).toBe(200);
      const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body as string);
      expect(body).toEqual({
        partner_id: 'partner-1',
        from_email: 'u@example.com',
        from_name: 'U',
        subject: 'hi',
        message: 'help',
      });
      expect(rateLimiterMock).toHaveBeenCalledWith(
        expect.anything(),
        'support:user:user-1',
        5,
        3600
      );
    });

    it('400 on missing fields', async () => {
      process.env.BREEZE_BILLING_URL = 'http://billing';
      const res = await app().request('/support', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subject: '' }),
      });
      expect(res.status).toBe(400);
    });

    it('429 when support rate limit exceeded', async () => {
      process.env.BREEZE_BILLING_URL = 'http://billing';
      rateLimiterMock.mockResolvedValueOnce({
        allowed: false,
        remaining: 0,
        resetAt: new Date(Date.now() + 10_000),
      });
      const res = await app().request('/support', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subject: 'hi', message: 'help' }),
      });
      expect(res.status).toBe(429);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
