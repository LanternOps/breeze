import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mock the enforcement service so we control the decision.
const enforceMock = vi.fn();
vi.mock('../services/ipAllowlist', () => ({
  enforceIpAllowlist: (...args: unknown[]) => enforceMock(...args),
}));

import { ipAllowlistGuard } from './ipAllowlistGuard';
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
  beforeEach(() => enforceMock.mockReset());

  it('passes the request through on allow', async () => {
    enforceMock.mockResolvedValue({ decision: 'allow' });
    const res = await appWithAuth({
      user: { id: 'u1', email: 'a@b.c', isPlatformAdmin: false },
      partnerId: 'p1',
    }).request('/x');
    expect(res.status).toBe(200);
  });

  it('passes the request through on skip', async () => {
    enforceMock.mockResolvedValue({ decision: 'skip', reason: 'empty_list' });
    const res = await appWithAuth({
      user: { id: 'u1', email: 'a@b.c', isPlatformAdmin: false },
      partnerId: 'p1',
    }).request('/x');
    expect(res.status).toBe(200);
  });

  it('returns 403 with ip_not_allowed on deny', async () => {
    enforceMock.mockResolvedValue({ decision: 'deny', reason: 'not_in_list' });
    const res = await appWithAuth({
      user: { id: 'u1', email: 'a@b.c', isPlatformAdmin: false },
      partnerId: 'p1',
    }).request('/x');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'ip_not_allowed' });
  });
});
