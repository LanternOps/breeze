import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { authRef } = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'organization' as string,
      user: { id: 'u-1', name: 'Tess Tech', email: 'tess@org.example' },
      partnerId: null as string | null,
      orgId: 'org-1' as string | null,
      accessibleOrgIds: null as string[] | null,
      canAccessOrg: (_id: string) => true as boolean,
    },
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: any, next: any) => next()),
  requireScope: () => async (c: any, next: any) => {
    c.set('auth', authRef.current);
    await next();
  },
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
  siteAccessCheck: () => () => true,
}));

vi.mock('../../db', () => ({ db: {} }));
vi.mock('../../db/schema', () => ({
  alertRules: { id: 'id', orgId: 'orgId', partnerId: 'partnerId', isActive: 'isActive', createdAt: 'createdAt', templateId: 'templateId' },
  alertTemplates: {}, alerts: {}, devices: {}, deviceGroups: {}, sites: {},
  organizations: { id: 'id', partnerId: 'partnerId' },
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/partnerWideAccess', () => ({
  canManagePartnerWidePolicies: vi.fn(() => true),
  PARTNER_WIDE_WRITE_DENIED_MESSAGE: 'denied',
}));
vi.mock('./helpers', () => ({
  getPagination: vi.fn(() => ({ page: 1, limit: 50, offset: 0 })),
  ensureOrgAccess: vi.fn(() => true),
  // Returning undefined makes the update route stop at 404 — far enough past
  // the condition-type guard to prove the guard did NOT fire, without needing a
  // full Drizzle chain stub.
  getAlertRuleWithOrgCheck: vi.fn(async () => undefined),
  // NOT stubbed to false: the overrideSettings/overrides passthrough merge
  // depends on it, and stubbing it away hid the bypass this file now covers.
  isRecord: vi.fn((v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v)),
  getOverrides: vi.fn(() => ({})),
  normalizeTargetsForRule: vi.fn(() => ({ targetType: 'all', targetId: 'org-1', targetIds: [], targets: { type: 'all', ids: [] } })),
  getNotificationChannelIds: vi.fn(() => []),
  containsNotificationBindingOverride: vi.fn(() => false),
  validateAlertRuleNotificationBindings: vi.fn(async () => null),
  formatAlertRuleResponse: vi.fn((r: unknown) => r),
  // Undefined template => create stops at 500 "Failed to resolve alert
  // template", which is again past the guard.
  resolveAlertTemplate: vi.fn(async () => ({ template: undefined, created: false })),
  retiredConditionReactivationError: vi.fn(async () => null),
}));

import { rulesRoutes } from './rules';
import { LEGACY_ALERTING_GONE } from '../legacyAlertingGone';

function makeApp() {
  const app = new Hono();
  app.route('/alerts', rulesRoutes);
  return app;
}

const RULE_ID = '5d4c3b2a-1111-4222-8333-444455556666';

describe('retired alert rule updates', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    { conditions: [{ type: 'custom', customCondition: 'x' }] },
    { name: 'renamed' },
    { overrideSettings: { conditions: [{ type: 'custom' }] } },
    { isActive: true },
    { isActive: false },
  ])('returns retirement guidance for update %j', async (body) => {
    const res = await makeApp().request(`/alerts/rules/${RULE_ID}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual(LEGACY_ALERTING_GONE);
  });
});
