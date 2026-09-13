import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// #5289 — an alert rule compiled from a monitor definition
// (managed_by_monitor_id set) must refuse PUT and DELETE. Side editing a
// compiled row would silently drift from its monitor definition until the
// next compile overwrote it.

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
  grantedRef: { current: new Set<string>(['alerts:read', 'alerts:write']) },
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
vi.mock('../../db/schema', () => ({
  alertRules: { id: 'id', orgId: 'orgId', partnerId: 'partnerId', isActive: 'isActive', createdAt: 'createdAt', templateId: 'templateId' },
  alertTemplates: {}, alerts: {}, devices: {},
  organizations: { id: 'id', partnerId: 'partnerId' },
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
import * as helpers from './helpers';

function makeApp() {
  const app = new Hono();
  app.route('/alerts', rulesRoutes);
  return app;
}

const RULE_ID = '5d4c3b2a-1111-4222-8333-444455556666';
const MONITOR_ID = '6d4c3b2a-1111-4222-8333-444455556677';

describe('alert rules — managed-by-monitor guard (#5289)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantedRef.current = new Set(['alerts:read', 'alerts:write']);
    authRef.current = {
      scope: 'organization',
      user: { id: 'u-1', name: 'Reed Only', email: 'reed@org.example' },
      partnerId: null, orgId: 'org-1', accessibleOrgIds: null, canAccessOrg: () => true,
    } as typeof authRef.current;
  });

  it('PUT /alerts/rules/:id on a monitor-managed rule is 409 alert_rule_managed_by_monitor', async () => {
    vi.mocked(helpers.getAlertRuleWithOrgCheck).mockResolvedValue({
      id: RULE_ID, orgId: 'org-1', partnerId: null, name: 'Compiled rule',
      overrideSettings: null, managedByMonitorId: MONITOR_ID,
    } as never);

    const res = await makeApp().request(`/alerts/rules/${RULE_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hijacked' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'alert_rule_managed_by_monitor', monitorId: MONITOR_ID });
  });

  it('DELETE /alerts/rules/:id on a monitor-managed rule is 409 alert_rule_managed_by_monitor', async () => {
    vi.mocked(helpers.getAlertRuleWithOrgCheck).mockResolvedValue({
      id: RULE_ID, orgId: 'org-1', partnerId: null, name: 'Compiled rule',
      overrideSettings: null, managedByMonitorId: MONITOR_ID,
    } as never);

    const res = await makeApp().request(`/alerts/rules/${RULE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'alert_rule_managed_by_monitor', monitorId: MONITOR_ID });
  });
});
