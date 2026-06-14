import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Regression test for Finding #6 (MEDIUM): alert-rule mutation endpoints must
// gate on the ALERTS_WRITE RBAC permission in addition to scope tier. RLS
// enforces tenancy but NOT intra-org role, so without this gate a read-only
// org user (who passes requireScope('organization') + own-org RLS) could
// create/update/delete alert rules.

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
  // Permission keys the caller currently holds (resource:action).
  grantedRef: { current: new Set<string>() },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: any, next: any) => next()),
  requireScope: () => async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    await next();
  },
  // Real requirePermission returns 403 when the caller lacks the grant. The mock
  // mirrors that so the regression actually exercises the gate.
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    if (!grantedRef.current.has(`${resource}:${action}`)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    await next();
  },
  requireMfa: () => async (_c: any, next: any) => next(),
}));

vi.mock('../../db', () => ({ db: {} }));
vi.mock('../../db/schema', () => ({
  alertRules: {}, alertTemplates: {}, alerts: {}, devices: {},
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('./helpers', () => ({
  getPagination: vi.fn(() => ({ page: 1, limit: 50, offset: 0 })),
  ensureOrgAccess: vi.fn(() => true),
  getAlertRuleWithOrgCheck: vi.fn(),
  normalizeTargetsForRule: vi.fn(() => ({ targetType: 'device', targetId: 'd-1', targetIds: ['d-1'], targets: [] })),
  formatAlertRuleResponse: vi.fn((r: unknown) => r),
  resolveAlertTemplate: vi.fn(),
}));

import { rulesRoutes } from './rules';

function makeApp() {
  const app = new Hono();
  app.route('/alerts', rulesRoutes);
  return app;
}

const RULE_ID = '5d4c3b2a-1111-4222-8333-444455556666';
const ALERTS_WRITE = 'alerts:write';

describe('alert rules authz (Finding #6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantedRef.current = new Set<string>();
    authRef.current = {
      scope: 'organization',
      user: { id: 'u-1', name: 'Reed Only', email: 'reed@org.example' },
      partnerId: null, orgId: 'org-1', accessibleOrgIds: null, canAccessOrg: () => true,
    } as typeof authRef.current;
  });

  it('403 on POST /alerts/rules without ALERTS_WRITE', async () => {
    const res = await makeApp().request('/alerts/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'r', severity: 'high' }),
    });
    expect(res.status).toBe(403);
  });

  it('403 on PUT /alerts/rules/:id without ALERTS_WRITE', async () => {
    const res = await makeApp().request(`/alerts/rules/${RULE_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'r' }),
    });
    expect(res.status).toBe(403);
  });

  it('403 on DELETE /alerts/rules/:id without ALERTS_WRITE', async () => {
    const res = await makeApp().request(`/alerts/rules/${RULE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('passes the permission gate on POST when ALERTS_WRITE is granted', async () => {
    grantedRef.current.add(ALERTS_WRITE);
    const res = await makeApp().request('/alerts/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    // Past the gate: a zValidator 400 (bad body) proves we are no longer blocked
    // by a permission 403.
    expect(res.status).not.toBe(403);
  });

  it('passes the permission gate on PUT when ALERTS_WRITE is granted', async () => {
    grantedRef.current.add(ALERTS_WRITE);
    const res = await makeApp().request(`/alerts/rules/${RULE_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'r' }),
    });
    // Past the gate: getAlertRuleWithOrgCheck mock returns undefined → 404
    // (not found), proving we are no longer blocked by a permission 403.
    expect(res.status).not.toBe(403);
  });

  it('passes the permission gate on DELETE when ALERTS_WRITE is granted', async () => {
    grantedRef.current.add(ALERTS_WRITE);
    const res = await makeApp().request(`/alerts/rules/${RULE_ID}`, { method: 'DELETE' });
    expect(res.status).not.toBe(403);
  });
});
