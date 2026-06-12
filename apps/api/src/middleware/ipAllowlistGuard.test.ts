import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mock the enforcement service so we control the decision.
vi.mock('../services/ipAllowlist', () => ({
  enforceIpAllowlist: vi.fn(),
  IP_NOT_ALLOWED_BODY: { code: 'ip_not_allowed', error: 'Access denied from this IP address' },
  isBlocked: (decision: { decision: string }) => decision.decision === 'deny',
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

import { ipAllowlistGuard } from './ipAllowlistGuard';
import { enforceIpAllowlist } from '../services/ipAllowlist';
import type { AuthContext } from './auth';

function appWithAuth(auth: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', auth as unknown as AuthContext);
    return ipAllowlistGuard(c, next);
  });
  app.get('/x', (c) => c.json({ ok: true }));
  return app;
}

describe('ipAllowlistGuard', () => {
  beforeEach(() => {
    vi.mocked(enforceIpAllowlist).mockReset();
  });

  it('passes the request through on allow', async () => {
    vi.mocked(enforceIpAllowlist).mockResolvedValue({ decision: 'allow' });
    const res = await appWithAuth({
      user: { id: 'u1', email: 'a@b.c', isPlatformAdmin: false },
      partnerId: 'p1',
    }).request('/x');
    expect(res.status).toBe(200);
  });

  it('passes the request through on skip', async () => {
    vi.mocked(enforceIpAllowlist).mockResolvedValue({ decision: 'skip', reason: 'empty_list' });
    const res = await appWithAuth({
      user: { id: 'u1', email: 'a@b.c', isPlatformAdmin: false },
      partnerId: 'p1',
    }).request('/x');
    expect(res.status).toBe(200);
  });

  it('returns 403 with ip_not_allowed on deny', async () => {
    vi.mocked(enforceIpAllowlist).mockResolvedValue({ decision: 'deny', reason: 'not_in_list' });
    const res = await appWithAuth({
      user: { id: 'u1', email: 'a@b.c', isPlatformAdmin: false },
      partnerId: 'p1',
    }).request('/x');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'ip_not_allowed' });
  });

  it('fails closed with 503 when the IP allowlist check fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(enforceIpAllowlist).mockRejectedValue(new Error('db unavailable'));
    const res = await ipAllowlistGuard({
      get: () => ({
        user: { id: 'u1', email: 'a@b.c', isPlatformAdmin: false },
        partnerId: 'p1',
      }),
      req: {
        method: 'GET',
        path: '/x',
        header: () => undefined,
      },
      json: (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
    } as any, vi.fn()) as Response;
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      code: 'ip_check_failed',
      error: 'Access temporarily unavailable',
    });
  });
});
