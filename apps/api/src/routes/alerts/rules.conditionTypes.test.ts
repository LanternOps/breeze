import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Regression coverage for #2948: the `custom` alert-condition type never had a
// registered evaluator handler, so conditionRegistry.evaluate() answered
// "Unknown condition type" and — because a root-level conditions array is an
// implicit AND — the whole rule could never fire. The route accepted it anyway
// (`conditions: z.any()`), so a tech could save a rule that silently monitored
// nothing. These endpoints must now reject any condition type with no handler.

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
  isRecord: vi.fn(() => false),
  getOverrides: vi.fn(() => ({})),
  normalizeTargetsForRule: vi.fn(() => ({ targetType: 'all', targetId: 'org-1', targetIds: [], targets: { type: 'all', ids: [] } })),
  getNotificationChannelIds: vi.fn(() => []),
  containsNotificationBindingOverride: vi.fn(() => false),
  validateAlertRuleNotificationBindings: vi.fn(async () => null),
  formatAlertRuleResponse: vi.fn((r: unknown) => r),
  // Undefined template => create stops at 500 "Failed to resolve alert
  // template", which is again past the guard.
  resolveAlertTemplate: vi.fn(async () => ({ template: undefined, created: false })),
}));

import { rulesRoutes } from './rules';

function makeApp() {
  const app = new Hono();
  app.route('/alerts', rulesRoutes);
  return app;
}

const RULE_ID = '5d4c3b2a-1111-4222-8333-444455556666';

function post(body: unknown) {
  return makeApp().request('/alerts/rules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function put(body: unknown) {
  return makeApp().request(`/alerts/rules/${RULE_ID}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID_RULE = {
  name: 'CPU high',
  severity: 'high' as const,
  targets: { type: 'all' as const, ids: [] },
};

describe('alert rule condition types (#2948)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authRef.current = {
      scope: 'organization',
      user: { id: 'u-1', name: 'Tess Tech', email: 'tess@org.example' },
      partnerId: null, orgId: 'org-1', accessibleOrgIds: null, canAccessOrg: () => true,
    } as typeof authRef.current;
  });

  it('rejects a create whose condition uses the retired `custom` type', async () => {
    const res = await post({
      ...VALID_RULE,
      conditions: [{ type: 'custom', field: 'foo', customCondition: '> 100' }],
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('custom');
    // The message must name what IS supported, or the tech has no next step.
    expect(body.error).toContain('threshold');
  });

  it('rejects an unregistered type nested inside a condition group', async () => {
    const res = await post({
      ...VALID_RULE,
      conditions: { logic: 'or', conditions: [
        { type: 'metric', metric: 'cpu', operator: 'gt', value: 85 },
        { type: 'custom', customCondition: 'x' },
      ] },
    });

    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('custom');
  });

  it('rejects an update that re-saves a stored `custom` condition', async () => {
    const res = await put({ conditions: [{ type: 'custom', customCondition: 'x' }] });

    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('custom');
  });

  it('lets supported types through the guard', async () => {
    const res = await post({
      ...VALID_RULE,
      conditions: [
        { type: 'metric', metric: 'cpu', operator: 'gt', value: 85 },
        { type: 'status', duration: 10 },
        { type: 'event_log', category: 'system', level: 'error', countThreshold: 1, windowMinutes: 15 },
      ],
    });

    // Not 400: the request fails later on the stubbed template resolution,
    // which proves it got past the condition-type guard.
    expect(res.status).not.toBe(400);
  });

  it('leaves an update with no conditions key untouched by the guard', async () => {
    const res = await put({ name: 'renamed' });

    expect(res.status).toBe(404);
  });
});
