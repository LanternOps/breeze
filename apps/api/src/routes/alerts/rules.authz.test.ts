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
const ALERTS_READ = 'alerts:read';
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

  it.each(['/alerts/rules', `/alerts/rules/${RULE_ID}`])('403 on GET %s without ALERTS_READ', async (path) => {
    const res = await makeApp().request(path);
    expect(res.status).toBe(403);
  });

  it('403 on rule test simulation without ALERTS_READ', async () => {
    const res = await makeApp().request(`/alerts/rules/${RULE_ID}/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it('passes the list read gate when ALERTS_READ is granted', async () => {
    grantedRef.current.add(ALERTS_READ);
    const res = await makeApp().request('/alerts/rules');
    expect(res.status).not.toBe(403);
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

// ============================================================
// Partner-wide alert rules (#2128, epic #2135)
// ============================================================

describe('partner-wide alert rules (#2128)', () => {
  const PARTNER_ID = '99999999-9999-4999-8999-999999999999';

  function setPartnerAuth(partnerOrgAccess?: 'all' | 'selected' | 'none') {
    grantedRef.current = new Set<string>([ALERTS_WRITE]);
    authRef.current = {
      scope: 'partner',
      user: { id: 'u-1', name: 'Partner Admin', email: 'admin@msp.example' },
      partnerId: PARTNER_ID,
      partnerOrgAccess,
      orgId: null,
      accessibleOrgIds: ['org-1'],
      canAccessOrg: () => true,
    } as typeof authRef.current;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('denies partner-wide create without full partner org access (orgAccess selected)', async () => {
    setPartnerAuth('selected');
    const res = await makeApp().request('/alerts/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerScope: 'partner', name: 'Fleet CPU rule', severity: 'high', conditions: { type: 'metric' } }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toMatch(/full partner org access/);
  });

  it('rejects a non-"all" target on partner-wide create', async () => {
    setPartnerAuth('all');
    const res = await makeApp().request('/alerts/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerScope: 'partner', name: 'Fleet rule', severity: 'high', conditions: { type: 'metric' }, targetType: 'site', targetId: '5d4c3b2a-1111-4222-8333-444455556666' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/only support the "all" target/);
  });

  it('rejects org-scoped notification bindings on partner-wide create', async () => {
    setPartnerAuth('all');
    const res = await makeApp().request('/alerts/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerScope: 'partner',
        name: 'Fleet rule',
        severity: 'high',
        conditions: { type: 'metric' },
        notificationChannelIds: ['5d4c3b2a-1111-4222-8333-444455556666'],
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/notification channels/i);
  });

  it('denies DELETE of a partner-wide rule without the partner-wide capability', async () => {
    setPartnerAuth('selected');
    vi.mocked(helpers.getAlertRuleWithOrgCheck).mockResolvedValue({
      id: RULE_ID, orgId: null, partnerId: PARTNER_ID, name: 'Fleet rule', overrideSettings: null,
    } as never);

    const res = await makeApp().request(`/alerts/rules/${RULE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toMatch(/full partner org access/);
  });

  it('denies PUT of a partner-wide rule without the partner-wide capability', async () => {
    setPartnerAuth('none');
    vi.mocked(helpers.getAlertRuleWithOrgCheck).mockResolvedValue({
      id: RULE_ID, orgId: null, partnerId: PARTNER_ID, name: 'Fleet rule', overrideSettings: null,
    } as never);

    const res = await makeApp().request(`/alerts/rules/${RULE_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hijacked' }),
    });
    expect(res.status).toBe(403);
  });
});
