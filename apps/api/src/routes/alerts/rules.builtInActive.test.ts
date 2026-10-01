import { LEGACY_ALERTING_GONE } from '../legacyAlertingGone';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// #7626 — PATCH /alerts/rules/:id/active is the one write left on legacy
// alert_rules: switching a built-in system anchor rule (patch job failures,
// reboot pending, policy violations) on or off. Every other legacy rule write
// stays retired (410).

const { authRef, grantedRef, mfaRef, dbState, getRuleMock, auditMock } = vi.hoisted(() => {
  const dbState = {
    template: undefined as Record<string, unknown> | undefined,
    updated: [] as Record<string, unknown>[],
    setCalls: [] as Record<string, unknown>[],
    whereCalls: [] as unknown[],
  };
  return {
    authRef: {
      current: {
        scope: 'organization' as string,
        user: { id: 'u-1', name: 'Tech', email: 'tech@org.example' },
        partnerId: null as string | null,
        orgId: 'org-1' as string | null,
        accessibleOrgIds: null as string[] | null,
        allowedSiteIds: undefined as string[] | undefined,
        canAccessOrg: (_id: string) => true as boolean,
      },
    },
    mfaRef: { current: true },
    grantedRef: { current: new Set<string>(['alerts:read', 'alerts:write']) },
    dbState,
    getRuleMock: vi.fn(),
    auditMock: vi.fn(),
  };
});

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
  siteAccessCheck: () => () => true,
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(dbState.template ? [dbState.template] : []),
        }),
      }),
    })),
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => {
        dbState.setCalls.push(values);
        return {
          where: (cond: unknown) => {
            dbState.whereCalls.push(cond);
            return { returning: () => Promise.resolve(dbState.updated) };
          },
        };
      },
    })),
  },
}));
vi.mock('../../db/schema', () => ({
  alertRules: { id: 'alert_rules.id', orgId: 'alert_rules.org_id', isActive: 'alert_rules.is_active', templateId: 'alert_rules.template_id' },
  alertTemplates: { id: 'alert_templates.id' },
  alerts: {}, devices: {}, deviceGroups: {}, sites: {},
  organizations: { id: 'id', partnerId: 'partnerId' },
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: auditMock }));
vi.mock('./helpers', () => ({
  getPagination: vi.fn(() => ({ page: 1, limit: 50, offset: 0 })),
  ensureOrgAccess: vi.fn(() => true),
  getAlertRuleWithOrgCheck: getRuleMock,
  isRecord: (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v),
  getOverrides: (v: unknown) => (typeof v === 'object' && v !== null ? v : {}),
  formatAlertRuleResponse: vi.fn((r: Record<string, unknown>, t: Record<string, unknown> | null) => ({
    id: r.id, isActive: r.isActive, systemManaged: t?.isBuiltIn === true,
  })),
}));

import { rulesRoutes } from './rules';

function makeApp() {
  const app = new Hono();
  app.route('/alerts', rulesRoutes);
  return app;
}

const RULE_ID = '5d4c3b2a-1111-4222-8333-444455556666';

const builtInRule = (over: Record<string, unknown> = {}) => ({
  id: RULE_ID,
  orgId: 'org-1',
  partnerId: null,
  templateId: 'tpl-builtin',
  name: 'Patch job failures',
  targetType: 'org',
  targetId: 'org-1',
  isActive: true,
  overrideSettings: { source: 'patch-job-finalizer' },
  managedByMonitorId: null,
  retiredAt: null,
  ...over,
});

function patch(body: unknown, id = RULE_ID) {
  return makeApp().request(`/alerts/rules/${id}/active`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('PATCH /alerts/rules/:id/active — built-in rule on/off (#7626)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mfaRef.current = true;
    grantedRef.current = new Set(['alerts:read', 'alerts:write']);
    authRef.current = {
      scope: 'organization',
      user: { id: 'u-1', name: 'Tech', email: 'tech@org.example' },
      partnerId: null, orgId: 'org-1', accessibleOrgIds: null, allowedSiteIds: undefined,
      canAccessOrg: () => true,
    } as typeof authRef.current;
    dbState.template = { id: 'tpl-builtin', isBuiltIn: true };
    dbState.updated = [builtInRule({ isActive: false })];
    dbState.setCalls = [];
    dbState.whereCalls = [];
    getRuleMock.mockResolvedValue(builtInRule());
  });

  it('switches a built-in rule off, writes only is_active, and audits the change', async () => {
    const res = await patch({ isActive: false });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: RULE_ID, isActive: false, systemManaged: true });
    expect(dbState.setCalls).toEqual([{ isActive: false }]);
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: 'org-1',
      action: 'alert_rule.update',
      resourceType: 'alert_rule',
      resourceId: RULE_ID,
      details: expect.objectContaining({ isActive: false, previousIsActive: true }),
    }));
  });

  it('scopes the UPDATE to the rule id AND its org', async () => {
    await patch({ isActive: false });

    const where = JSON.stringify(dbState.whereCalls[0]);
    expect(where).toContain('alert_rules.id');
    expect(where).toContain('alert_rules.org_id');
    expect(where).toContain('org-1');
  });

  it('404s without auditing when the UPDATE matches no row', async () => {
    dbState.updated = [];

    expect((await patch({ isActive: false })).status).toBe(404);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('switches a built-in rule back on', async () => {
    getRuleMock.mockResolvedValue(builtInRule({ isActive: false }));
    dbState.updated = [builtInRule({ isActive: true })];

    const res = await patch({ isActive: true });

    expect(res.status).toBe(200);
    expect(dbState.setCalls).toEqual([{ isActive: true }]);
  });

  it('keeps every other legacy rule write retired (410, nothing written)', async () => {
    dbState.template = { id: 'tpl-custom', isBuiltIn: false };

    const res = await patch({ isActive: false });

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual(LEGACY_ALERTING_GONE);
    expect(dbState.setCalls).toEqual([]);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it.each([
    ['monitor-managed', { managedByMonitorId: 'monitor-1' }],
    ['retired', { retiredAt: new Date('2026-09-01T00:00:00Z') }],
    ['partner-wide', { orgId: null, partnerId: 'partner-1' }],
  ])('refuses a %s rule even on a built-in template (410, nothing written)', async (_label, over) => {
    getRuleMock.mockResolvedValue(builtInRule(over));

    const res = await patch({ isActive: false });

    expect(res.status).toBe(410);
    expect(dbState.setCalls).toEqual([]);
  });

  it('404s a rule the caller cannot reach', async () => {
    getRuleMock.mockResolvedValue(null);

    expect((await patch({ isActive: false })).status).toBe(404);
    expect(dbState.setCalls).toEqual([]);
  });

  it('404s an org-wide built-in rule for a site-restricted caller', async () => {
    authRef.current = { ...authRef.current, allowedSiteIds: ['site-1'] };

    expect((await patch({ isActive: false })).status).toBe(404);
    expect(dbState.setCalls).toEqual([]);
  });

  it.each([
    ['missing isActive', {}],
    ['non-boolean isActive', { isActive: 'false' }],
    ['extra fields', { isActive: false, name: 'renamed' }],
    ['malformed JSON', '{invalid'],
  ])('rejects %s with 400 and writes nothing', async (_label, body) => {
    expect((await patch(body)).status).toBe(400);
    expect(dbState.setCalls).toEqual([]);
  });

  it('requires alerts:write', async () => {
    grantedRef.current = new Set(['alerts:read']);
    expect((await patch({ isActive: false })).status).toBe(403);
    expect(dbState.setCalls).toEqual([]);
  });

  it('requires MFA', async () => {
    mfaRef.current = false;
    expect((await patch({ isActive: false })).status).toBe(403);
    expect(dbState.setCalls).toEqual([]);
  });
});
