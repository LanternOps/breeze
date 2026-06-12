import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Regression for Finding #6 (MEDIUM): alert-template rule mutations (create/
// update/delete/toggle) must gate on ALERTS_WRITE in addition to scope tier.

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
vi.mock('../../db/schema', () => ({ alertRules: {}, alertTemplates: {} }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('./helpers', () => ({
  resolveScopedOrgId: vi.fn(() => 'org-1'),
  parseBoolean: vi.fn(() => undefined),
}));
vi.mock('../../utils/pagination', () => ({
  getPagination: vi.fn(() => ({ page: 1, limit: 50, offset: 0 })),
}));

import { ruleRoutes } from './rules';

function makeApp() {
  const app = new Hono();
  app.route('/alert-templates', ruleRoutes);
  return app;
}

const RULE_ID = '5d4c3b2a-1111-4222-8333-444455556666';
const ALERTS_WRITE = 'alerts:write';

describe('alert-template rules authz (Finding #6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantedRef.current = new Set<string>();
    authRef.current = {
      scope: 'organization',
      user: { id: 'u-1', name: 'Reed Only', email: 'reed@org.example' },
      partnerId: null, orgId: 'org-1', accessibleOrgIds: null, canAccessOrg: () => true,
    } as typeof authRef.current;
  });

  it('403 on POST /alert-templates/rules without ALERTS_WRITE', async () => {
    const res = await makeApp().request('/alert-templates/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'r' }),
    });
    expect(res.status).toBe(403);
  });

  it('403 on PATCH /alert-templates/rules/:id without ALERTS_WRITE', async () => {
    const res = await makeApp().request(`/alert-templates/rules/${RULE_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'r' }),
    });
    expect(res.status).toBe(403);
  });

  it('403 on DELETE /alert-templates/rules/:id without ALERTS_WRITE', async () => {
    const res = await makeApp().request(`/alert-templates/rules/${RULE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('403 on POST /alert-templates/rules/:id/toggle without ALERTS_WRITE', async () => {
    const res = await makeApp().request(`/alert-templates/rules/${RULE_ID}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(403);
  });

  it('passes the permission gate on POST when ALERTS_WRITE is granted', async () => {
    grantedRef.current.add(ALERTS_WRITE);
    const res = await makeApp().request('/alert-templates/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).not.toBe(403);
  });

  it('passes the permission gate on PATCH when ALERTS_WRITE is granted', async () => {
    grantedRef.current.add(ALERTS_WRITE);
    const res = await makeApp().request(`/alert-templates/rules/${RULE_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'r' }),
    });
    expect(res.status).not.toBe(403);
  });

  it('passes the permission gate on DELETE when ALERTS_WRITE is granted', async () => {
    grantedRef.current.add(ALERTS_WRITE);
    const res = await makeApp().request(`/alert-templates/rules/${RULE_ID}`, { method: 'DELETE' });
    expect(res.status).not.toBe(403);
  });
});
