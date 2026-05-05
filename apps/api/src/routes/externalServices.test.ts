import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const authGates = vi.hoisted(() => ({
  permissionDenied: false,
  mfaDenied: false,
}));

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
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (authGates.permissionDenied) {
      return c.json({ error: 'Permission denied' }, 403);
    }
    await next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (authGates.mfaDenied) {
      return c.json({ error: 'MFA required' }, 403);
    }
    await next();
  }),
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    BILLING_MANAGE: { resource: 'billing', action: 'manage' },
  },
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
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
import { writeRouteAudit } from '../services/auditEvents';

const fetchMock = vi.fn();
const originalFetch = global.fetch;

const defaultAllowed = () => ({
  allowed: true,
  remaining: 10,
  resetAt: new Date(Date.now() + 3600_000),
});

describe('externalServicesRoutes', () => {
  const originalEnv = {
    BREEZE_BILLING_URL: process.env.BREEZE_BILLING_URL,
    DASHBOARD_URL: process.env.DASHBOARD_URL,
    PUBLIC_APP_URL: process.env.PUBLIC_APP_URL,
    CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS,
  };

  beforeEach(() => {
    fetchMock.mockReset();
    rateLimiterMock.mockReset();
    rateLimiterMock.mockImplementation(async () => defaultAllowed());
    global.fetch = fetchMock as any;
    process.env.DASHBOARD_URL = 'https://app.example.com';
    delete process.env.PUBLIC_APP_URL;
    delete process.env.CORS_ALLOWED_ORIGINS;
    authGates.permissionDenied = false;
    authGates.mfaDenied = false;
    authState.value = {
      user: { id: 'user-1', email: 'u@example.com', name: 'U' },
      partnerId: 'partner-1',
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  const app = () => new Hono().route('/', externalServicesRoutes);
  const parseFetchJsonBody = (callIndex = 0) => {
    const init = fetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined;
    expect(init).toBeDefined();
    expect(typeof init?.body).toBe('string');
    return JSON.parse(init!.body as string);
  };

  describe('POST /billing/portal', () => {
    it('503 when BREEZE_BILLING_URL unset', async () => {
      delete process.env.BREEZE_BILLING_URL;
      const res = await app().request('/billing/portal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ returnUrl: 'https://app.example.com/back' }),
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
        body: JSON.stringify({ returnUrl: 'https://app.example.com/back' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ url: 'https://stripe/x' });
      expect(fetchMock).toHaveBeenCalledWith(
        'http://billing/portal-sessions',
        expect.objectContaining({ method: 'POST' })
      );
      const body = parseFetchJsonBody();
      expect(body).toEqual({ partner_id: 'partner-1', return_url: 'https://app.example.com/back' });
      expect(writeRouteAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'billing.portal_session.create',
          resourceType: 'partner',
          resourceId: 'partner-1',
          result: 'success',
          details: {
            upstreamStatus: 200,
            returnUrlOrigin: 'https://app.example.com',
          },
        }),
      );
      // Rate limit key is scoped to user id
      expect(rateLimiterMock).toHaveBeenCalledWith(
        expect.anything(),
        'billing-portal:user:user-1',
        10,
        3600
      );
    });

    it('403 when caller lacks billing admin permission', async () => {
      process.env.BREEZE_BILLING_URL = 'http://billing';
      authGates.permissionDenied = true;
      const res = await app().request('/billing/portal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ returnUrl: 'https://app.example.com/back' }),
      });
      expect(res.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('403 when caller has not satisfied MFA', async () => {
      process.env.BREEZE_BILLING_URL = 'http://billing';
      authGates.mfaDenied = true;
      const res = await app().request('/billing/portal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ returnUrl: 'https://app.example.com/back' }),
      });
      expect(res.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
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

    it('400 when return URL origin is not allowed', async () => {
      process.env.BREEZE_BILLING_URL = 'http://billing';
      const res = await app().request('/billing/portal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ returnUrl: 'https://evil.example/back' }),
      });
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('allows return URL origins configured via CORS_ALLOWED_ORIGINS', async () => {
      process.env.BREEZE_BILLING_URL = 'http://billing';
      process.env.CORS_ALLOWED_ORIGINS = 'https://tenant.example, https://other.example';
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ url: 'https://stripe/x' }), { status: 200 })
      );
      const res = await app().request('/billing/portal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ returnUrl: 'https://tenant.example/billing/return' }),
      });
      expect(res.status).toBe(200);
      const body = parseFetchJsonBody();
      expect(body).toEqual({
        partner_id: 'partner-1',
        return_url: 'https://tenant.example/billing/return',
      });
    });

    it('passes through 404 from upstream', async () => {
      process.env.BREEZE_BILLING_URL = 'http://billing';
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'no_billing_record' }), { status: 404 })
      );
      const res = await app().request('/billing/portal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ returnUrl: 'https://app.example.com/back' }),
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
        body: JSON.stringify({ returnUrl: 'https://app.example.com/back' }),
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
        body: JSON.stringify({ returnUrl: 'https://app.example.com/back' }),
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
        body: JSON.stringify({ returnUrl: 'https://app.example.com/back' }),
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
        body: JSON.stringify({ returnUrl: 'https://app.example.com/back' }),
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
      const body = parseFetchJsonBody();
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
