import { LEGACY_ALERTING_GONE } from '../legacyAlertingGone';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Retired write endpoints keep authentication and return the shared migration guidance.

const { authRef, grantedRef, mfaRef } = vi.hoisted(() => ({
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
  mfaRef: { current: true },
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
  requireMfa: () => async (c: any, next: any) => {
    if (!mfaRef.current) return c.json({ error: 'MFA required' }, 403);
    await next();
  },
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

function makeApp() {
  const app = new Hono();
  app.route('/alerts', rulesRoutes);
  return app;
}

const RULE_ID = '5d4c3b2a-1111-4222-8333-444455556666';

describe('alert rules — retired writes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mfaRef.current = true;
    grantedRef.current = new Set(['alerts:read', 'alerts:write']);
    authRef.current = {
      scope: 'organization',
      user: { id: 'u-1', name: 'Reed Only', email: 'reed@org.example' },
      partnerId: null, orgId: 'org-1', accessibleOrgIds: null, canAccessOrg: () => true,
    } as typeof authRef.current;
  });

  it.each([
    ['POST', `/alerts/rules`],
    ['PUT', `/alerts/rules/${RULE_ID}`],
    ['DELETE', `/alerts/rules/${RULE_ID}`],
    ['POST', `/alerts/rules/${RULE_ID}/test`],
  ].flatMap(([method, path]) => ['{}', '{invalid'].map(body => [method!, path!, body])))('%s %s is retired (body %s)', async (method, path, body) => {
    const response = await makeApp().request(path, { method,
      headers: { 'content-type': 'application/json' }, body: method === 'DELETE' ? undefined : body });
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual(LEGACY_ALERTING_GONE);
  });
  it('auth still precedes retirement', async () => {
    authRef.current = null as never;
    expect((await makeApp().request('/alerts/rules', { method: 'POST', body: '{}' })).status).toBe(401);
  });
  it('write permission still precedes retirement', async () => {
    grantedRef.current = new Set(['alerts:read']);
    expect((await makeApp().request('/alerts/rules', { method: 'POST', body: '{}' })).status).toBe(403);
  });
  it.each([
    ['POST', '/alerts/rules'],
    ['PUT', `/alerts/rules/${RULE_ID}`],
    ['DELETE', `/alerts/rules/${RULE_ID}`],
  ])('MFA still precedes retirement for %s %s', async (method, path) => {
    mfaRef.current = false;
    expect((await makeApp().request(path, { method })).status).toBe(403);
  });
  it('retains read permission without MFA for the retired simulation endpoint', async () => {
    mfaRef.current = false;
    grantedRef.current = new Set(['alerts:read']);
    expect((await makeApp().request(`/alerts/rules/${RULE_ID}/test`, { method: 'POST' })).status).toBe(410);
    grantedRef.current = new Set(['alerts:write']);
    expect((await makeApp().request(`/alerts/rules/${RULE_ID}/test`, { method: 'POST' })).status).toBe(403);
  });

});
