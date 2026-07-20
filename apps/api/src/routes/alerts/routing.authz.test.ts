import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Regression for Finding #6 (MEDIUM): notification routing-rule mutations must
// gate on ALERTS_WRITE in addition to scope tier.

const { authRef, grantedRef } = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'organization' as string,
      user: { id: 'u-1', name: 'Reed Only', email: 'reed@org.example' },
      partnerId: null as string | null,
      orgId: 'org-1' as string | null,
      accessibleOrgIds: null as string[] | null,
      canAccessOrg: (_id: string) => true as boolean,
    },
  },
  grantedRef: { current: new Set<string>() },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: any, next: any) => next()),
  requireScope: () => async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    await next();
  },
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    if (!grantedRef.current.has(`${resource}:${action}`)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    await next();
  },
  requireMfa: () => async (_c: any, next: any) => next(),
}));

vi.mock('../../db', () => ({ db: {} }));
vi.mock('../../db/schema', () => ({ notificationRoutingRules: {} }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

import { routingRoutes } from './routing';

function makeApp() {
  const app = new Hono();
  app.route('/alerts', routingRoutes);
  return app;
}

const RULE_ID = '5d4c3b2a-1111-4222-8333-444455556666';
const ALERTS_READ = 'alerts:read';
const ALERTS_WRITE = 'alerts:write';

describe('notification routing rules authz (Finding #6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantedRef.current = new Set<string>();
    authRef.current = {
      scope: 'organization',
      user: { id: 'u-1', name: 'Reed Only', email: 'reed@org.example' },
      partnerId: null, orgId: 'org-1', accessibleOrgIds: null, canAccessOrg: () => true,
    } as typeof authRef.current;
  });

  it('403 on GET /alerts/routing-rules without ALERTS_READ', async () => {
    const res = await makeApp().request('/alerts/routing-rules');
    expect(res.status).toBe(403);
  });

  it('passes the read gate when ALERTS_READ is granted', async () => {
    grantedRef.current.add(ALERTS_READ);
    const res = await makeApp().request('/alerts/routing-rules');
    expect(res.status).not.toBe(403);
  });

  it('403 on POST /alerts/routing-rules without ALERTS_WRITE', async () => {
    const res = await makeApp().request('/alerts/routing-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'r', priority: 0, conditions: {}, channelIds: ['x'] }),
    });
    expect(res.status).toBe(403);
  });

  it('403 on DELETE /alerts/routing-rules/:id without ALERTS_WRITE', async () => {
    const res = await makeApp().request(`/alerts/routing-rules/${RULE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('passes the permission gate on POST when ALERTS_WRITE is granted', async () => {
    grantedRef.current.add(ALERTS_WRITE);
    const res = await makeApp().request('/alerts/routing-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).not.toBe(403);
  });

  it('passes the permission gate on DELETE when ALERTS_WRITE is granted', async () => {
    grantedRef.current.add(ALERTS_WRITE);
    const res = await makeApp().request(`/alerts/routing-rules/${RULE_ID}`, { method: 'DELETE' });
    expect(res.status).not.toBe(403);
  });
});
