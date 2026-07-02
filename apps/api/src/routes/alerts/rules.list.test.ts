import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Regression coverage for GET /alerts/rules dual-axis list branches (#2128,
// PR #2143): partner-scope callers see their own partner-wide alert rules
// (orgId NULL, partnerId set) unioned with their org-owned rules, both in the
// "all my orgs" view and in an org-filtered view. Org-scope callers are
// unaffected (no partner-wide branch). See ./rules.authz.test.ts for the
// RBAC/permission-gate coverage on the mutating routes — this file only
// covers the read path, which needs a working db.select() chain that
// rules.authz.test.ts's bare `{}` db mock does not provide.

const { authRef, dbQueueRef, capturedWhere } = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'organization' as string,
      partnerId: null as string | null,
      orgId: null as string | null,
      accessibleOrgIds: null as string[] | null,
      canAccessOrg: (_id: string) => true as boolean,
    },
  },
  // Queue of result arrays consumed in call order across the (up to three)
  // sequential db.select(...) calls a single request can make: an optional
  // organizations.partnerId lookup (system+orgId branch only), the count
  // select, then the rows select.
  dbQueueRef: { current: [] as unknown[][] },
  capturedWhere: { current: undefined as unknown },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: any, next: any) => next()),
  requireScope: () => async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    await next();
  },
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
}));

vi.mock('../../db/schema', () => ({
  alertRules: { id: 'id', orgId: 'orgId', partnerId: 'partnerId', isActive: 'isActive', createdAt: 'createdAt', templateId: 'templateId' },
  alertTemplates: {},
  alerts: {},
  devices: {},
  organizations: { id: 'id', partnerId: 'partnerId' },
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/partnerWideAccess', () => ({
  canManagePartnerWidePolicies: vi.fn(),
  PARTNER_WIDE_WRITE_DENIED_MESSAGE: 'x',
}));

vi.mock('./helpers', () => ({
  getPagination: vi.fn(() => ({ page: 1, limit: 50, offset: 0 })),
  ensureOrgAccess: vi.fn(() => true),
  getAlertRuleWithOrgCheck: vi.fn(),
  isRecord: vi.fn(),
  getOverrides: vi.fn(() => ({})),
  normalizeTargetsForRule: vi.fn(),
  getNotificationChannelIds: vi.fn(() => []),
  containsNotificationBindingOverride: vi.fn(() => false),
  validateAlertRuleNotificationBindings: vi.fn(),
  formatAlertRuleResponse: vi.fn((rule: unknown) => rule),
  resolveAlertTemplate: vi.fn(),
}));

// Chainable + thenable Drizzle stub. Every chain method (from/leftJoin/where/
// orderBy/limit/offset) returns the SAME chain object so it works regardless
// of exactly where the handler's `await` lands (count query: select().from().
// where(); rows query: select().from().leftJoin().where().orderBy().limit().
// offset(); org-partner lookup: select().from().where().limit()). The chain
// implements `.then()` directly (a thenable, not a real Promise) so `await
// chain` resolves to the next queued result array.
vi.mock('../../db', () => {
  function makeChain() {
    const chain: any = {
      from: () => chain,
      leftJoin: () => chain,
      where: (cond: unknown) => {
        capturedWhere.current = cond;
        return chain;
      },
      orderBy: () => chain,
      limit: () => chain,
      offset: () => chain,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(dbQueueRef.current.shift() ?? []).then(resolve, reject),
    };
    return chain;
  }
  return {
    db: { select: vi.fn(() => makeChain()) },
  };
});

import { rulesRoutes } from './rules';
import * as helpers from './helpers';
import { db } from '../../db';

function makeApp() {
  const app = new Hono();
  app.route('/alerts', rulesRoutes);
  return app;
}

function whereHasOrMarker() {
  // Real drizzle-orm and()/or()/eq() all produce `SQL` class instances, so
  // constructor.name can't distinguish them (verified empirically). But or()
  // splices a literal " or " text chunk between its branches, which survives
  // JSON.stringify — a single eq()/and(eq()) condition never contains it.
  return JSON.stringify(capturedWhere.current).includes(' or ');
}

const ORG_1 = '11111111-1111-4111-8111-111111111111';
const ORG_2 = '22222222-2222-4222-8222-222222222222';
const PARTNER_1 = '33333333-3333-4333-8333-333333333333';

describe('GET /alerts/rules (dual-axis list, #2128)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbQueueRef.current = [];
    capturedWhere.current = undefined;
    vi.mocked(helpers.ensureOrgAccess).mockReturnValue(true);
    vi.mocked(helpers.getPagination).mockReturnValue({ page: 1, limit: 50, offset: 0 } as never);
    vi.mocked(helpers.formatAlertRuleResponse).mockImplementation((rule: unknown) => rule as never);
  });

  it('org scope: returns only org-owned rules, no OR-branch in the where condition', async () => {
    authRef.current = {
      scope: 'organization',
      partnerId: null,
      orgId: 'org-1',
      accessibleOrgIds: null,
      canAccessOrg: () => true,
    } as typeof authRef.current;

    dbQueueRef.current = [
      [{ count: 1 }],
      [{ rule: { id: 'r1', orgId: 'org-1', partnerId: null, templateId: 't1', isActive: true, createdAt: '2026-01-01' }, template: null }],
    ];

    const res = await makeApp().request('/alerts/rules');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data).toHaveLength(1);
    expect(body.data[0].orgId).toBe('org-1');
    expect(whereHasOrMarker()).toBe(false);
  });

  it('org scope: 403 when auth.orgId is missing', async () => {
    authRef.current = {
      scope: 'organization',
      partnerId: null,
      orgId: null,
      accessibleOrgIds: null,
      canAccessOrg: () => true,
    } as typeof authRef.current;

    const res = await makeApp().request('/alerts/rules');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Organization context required' });
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });

  it('partner scope, no ?orgId=: unions org-owned rules with partner-wide rules', async () => {
    authRef.current = {
      scope: 'partner',
      partnerId: 'p-1',
      orgId: null,
      accessibleOrgIds: ['org-1', 'org-2'],
      canAccessOrg: () => true,
    } as typeof authRef.current;

    dbQueueRef.current = [
      [{ count: 2 }],
      [
        { rule: { id: 'r-org', orgId: 'org-1', partnerId: null, templateId: 't1', isActive: true, createdAt: '2026-01-01' }, template: null },
        { rule: { id: 'r-pw', orgId: null, partnerId: 'p-1', templateId: 't2', isActive: true, createdAt: '2026-01-02' }, template: null },
      ],
    ];

    const res = await makeApp().request('/alerts/rules');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data).toContainEqual(expect.objectContaining({ orgId: null, partnerId: 'p-1' }));
    expect(body.data).toContainEqual(expect.objectContaining({ orgId: 'org-1' }));
    expect(whereHasOrMarker()).toBe(true);
  });

  it('partner scope, no ?orgId=, no accessible orgs but has partnerId: returns partner-wide-only results (not the empty short-circuit)', async () => {
    authRef.current = {
      scope: 'partner',
      partnerId: 'p-1',
      orgId: null,
      accessibleOrgIds: [],
      canAccessOrg: () => true,
    } as typeof authRef.current;

    dbQueueRef.current = [
      [{ count: 1 }],
      [{ rule: { id: 'r-pw2', orgId: null, partnerId: 'p-1', templateId: 't3', isActive: true, createdAt: '2026-01-03' }, template: null }],
    ];

    const res = await makeApp().request('/alerts/rules');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data).toHaveLength(1);
    expect(body.data[0].orgId).toBeNull();
  });

  it('partner scope, no ?orgId=, no accessible orgs and no partnerId: 200 empty short-circuit, no db query', async () => {
    authRef.current = {
      scope: 'partner',
      partnerId: null,
      orgId: null,
      accessibleOrgIds: [],
      canAccessOrg: () => true,
    } as typeof authRef.current;

    const res = await makeApp().request('/alerts/rules');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [], pagination: { page: 1, limit: 50, total: 0 } });
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });

  it('partner scope with ?orgId=: org-filtered view still unions in partner-wide rules', async () => {
    authRef.current = {
      scope: 'partner',
      partnerId: PARTNER_1,
      orgId: null,
      accessibleOrgIds: [ORG_1],
      canAccessOrg: () => true,
    } as typeof authRef.current;
    vi.mocked(helpers.ensureOrgAccess).mockReturnValue(true);

    dbQueueRef.current = [
      [{ count: 2 }],
      [
        { rule: { id: 'r-c1', orgId: ORG_1, partnerId: null, templateId: 't1', isActive: true, createdAt: '2026-01-01' }, template: null },
        { rule: { id: 'r-c2', orgId: null, partnerId: PARTNER_1, templateId: 't2', isActive: true, createdAt: '2026-01-02' }, template: null },
      ],
    ];

    const res = await makeApp().request(`/alerts/rules?orgId=${ORG_1}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data).toHaveLength(2);
    expect(body.data).toContainEqual(expect.objectContaining({ orgId: ORG_1 }));
    expect(body.data).toContainEqual(expect.objectContaining({ orgId: null, partnerId: PARTNER_1 }));
    // Distinct code path from the no-orgId union (query.orgId branch), but
    // still an or(...) between the queried org and the partner-wide clause.
    expect(whereHasOrMarker()).toBe(true);
  });

  it('partner scope with ?orgId=: 403 when ensureOrgAccess denies, no rows query made', async () => {
    authRef.current = {
      scope: 'partner',
      partnerId: PARTNER_1,
      orgId: null,
      accessibleOrgIds: [ORG_1],
      canAccessOrg: () => true,
    } as typeof authRef.current;
    vi.mocked(helpers.ensureOrgAccess).mockReturnValue(false);

    const res = await makeApp().request(`/alerts/rules?orgId=${ORG_2}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Access to this organization denied' });
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });
});
