import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Regression: GET /alerts/routing-rules must not 400 on load. The Notification
// Channels page fetches this list on mount with no ?orgId= when no specific org
// is selected (partner/system scope). The old handler hard-required auth.orgId
// and 400'd; it now mirrors GET /alerts/channels scope handling and returns an
// empty list for a clean tenant.

const { authRef, capturedWhere } = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'partner' as string,
      user: { id: 'u-1', name: 'Pat Partner', email: 'pat@partner.example' },
      partnerId: 'p-1' as string | null,
      orgId: null as string | null,
      accessibleOrgIds: [] as string[] | null,
      canAccessOrg: (_id: string) => true as boolean,
    },
  },
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

// A chainable Drizzle stub: select().from().where().orderBy() resolves to rows
// and records the where-condition so we can assert what was queried.
const rowsRef = { current: [] as unknown[] };
vi.mock('../../db', () => {
  const builder: any = {
    from: () => builder,
    where: (cond: unknown) => {
      capturedWhere.current = cond;
      return builder;
    },
    orderBy: () => Promise.resolve(rowsRef.current),
  };
  return { db: { select: () => builder } };
});
vi.mock('../../db/schema', () => ({
  notificationRoutingRules: { orgId: { name: 'org_id' }, partnerId: { name: 'partner_id' } },
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

import { routingRoutes } from './routing';

function makeApp() {
  const app = new Hono();
  app.route('/alerts', routingRoutes);
  return app;
}

/**
 * Flattens a drizzle condition (real `eq`/`and`/`or`/`isNull` from
 * drizzle-orm, not mocked) to its static text — same introspection approach
 * as channels.list.test.ts / policies.list.test.ts.
 */
function sqlText(q: unknown): string {
  if (q == null) return '';
  if (typeof q === 'string') return q;
  if (typeof q === 'number' || typeof q === 'boolean') return String(q);
  const obj = q as { queryChunks?: unknown[]; value?: unknown; name?: string };
  if (Array.isArray(obj.queryChunks)) {
    return obj.queryChunks.map(sqlText).join(' ');
  }
  if (Array.isArray(obj.value)) {
    return (obj.value as unknown[]).map(sqlText).join('');
  }
  if (typeof obj.value === 'string' || typeof obj.value === 'number') {
    return String(obj.value);
  }
  if (typeof obj.name === 'string') {
    return obj.name;
  }
  return '';
}

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';

describe('GET /alerts/routing-rules (list-on-load)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedWhere.current = undefined;
    rowsRef.current = [];
  });

  it('returns 200 with an empty list for a partner with no accessible orgs and no partnerId (no orgId)', async () => {
    authRef.current = {
      scope: 'partner',
      user: { id: 'u-1', name: 'Pat', email: 'pat@partner.example' },
      partnerId: null, orgId: null, accessibleOrgIds: [], canAccessOrg: () => true,
    } as typeof authRef.current;

    const res = await makeApp().request('/alerts/routing-rules');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: [] });
    // Short-circuited before touching the db — neither the org-accessible nor
    // the partner-wide (#2130) condition applies, so there is nothing to query.
    expect(capturedWhere.current).toBeUndefined();
  });

  it('queries for partner-wide rules when a partner has no accessible orgs but does have a partnerId (#2130)', async () => {
    authRef.current = {
      scope: 'partner',
      user: { id: 'u-1', name: 'Pat', email: 'pat@partner.example' },
      partnerId: 'p-1', orgId: null, accessibleOrgIds: [], canAccessOrg: () => true,
    } as typeof authRef.current;

    const res = await makeApp().request('/alerts/routing-rules');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: [] });
    // Not short-circuited: even with zero accessible orgs, a partner-scoped
    // caller still owns their own partner-wide rules (org_id NULL), so the
    // partner condition is queried.
    expect(capturedWhere.current).toBeDefined();
  });

  it('returns 200 (not 400) for a partner with accessible orgs but no orgId selected', async () => {
    authRef.current = {
      scope: 'partner',
      user: { id: 'u-1', name: 'Pat', email: 'pat@partner.example' },
      partnerId: 'p-1', orgId: null, accessibleOrgIds: ['org-a', 'org-b'], canAccessOrg: () => true,
    } as typeof authRef.current;

    const res = await makeApp().request('/alerts/routing-rules');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: [] });
    // Queried, scoped to the accessible orgs (inArray condition present).
    expect(capturedWhere.current).toBeDefined();
  });

  it('returns 200 for an org-scoped user (pinned to own org)', async () => {
    authRef.current = {
      scope: 'organization',
      user: { id: 'u-2', name: 'Olive Org', email: 'olive@org.example' },
      partnerId: null, orgId: 'org-1', accessibleOrgIds: null, canAccessOrg: () => true,
    } as typeof authRef.current;

    const res = await makeApp().request('/alerts/routing-rules');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: [] });
    expect(capturedWhere.current).toBeDefined();
  });

  it('403 (not 400) for an org-scoped user with no org context', async () => {
    authRef.current = {
      scope: 'organization',
      user: { id: 'u-3', name: 'No Org', email: 'noorg@org.example' },
      partnerId: null, orgId: null, accessibleOrgIds: null, canAccessOrg: () => true,
    } as typeof authRef.current;

    const res = await makeApp().request('/alerts/routing-rules');
    expect(res.status).toBe(403);
  });
});

// Sweep 2026-09-08 (G6-4) — GET /alerts/routing-rules?orgId=<org> for a
// partner-scoped caller built the per-org filter as a bare
// `eq(notificationRoutingRules.orgId, query.orgId)`, unlike the "all orgs"
// branch (no ?orgId=) right below it, which already ORs in the partner's own
// partner-wide rules (org_id NULL, partner_id = auth.partnerId, #2130). A
// routing rule created via POST /alerts/routing-rules with
// ownerScope: 'partner' was therefore invisible from every per-org view even
// though it applies to that org's devices.
describe('GET /alerts/routing-rules?orgId= — partner-wide read branch (sweep G6-4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedWhere.current = undefined;
    rowsRef.current = [];
  });

  it('includes the partner-wide branch for a PARTNER-scoped caller with ?orgId=', async () => {
    authRef.current = {
      scope: 'partner',
      user: { id: 'u-1', name: 'Pat', email: 'pat@partner.example' },
      partnerId: PARTNER_ID, orgId: null, accessibleOrgIds: [ORG_ID], canAccessOrg: () => true,
    } as typeof authRef.current;

    const res = await makeApp().request(`/alerts/routing-rules?orgId=${ORG_ID}`);
    expect(res.status).toBe(200);

    const whereText = sqlText(capturedWhere.current);
    expect(whereText).toContain('org_id');
    expect(whereText).toContain(ORG_ID);
    expect(whereText).toContain('is null');
    expect(whereText).toContain('partner_id');
    expect(whereText).toContain(PARTNER_ID);
  });

  it('does NOT include a partner-wide branch for an ORG-scoped caller with ?orgId= (RLS is stricter than the app layer; never claim parity)', async () => {
    authRef.current = {
      scope: 'organization',
      user: { id: 'u-2', name: 'Olive Org', email: 'olive@org.example' },
      // An org token carries a partnerId too — this must not leak the branch.
      partnerId: PARTNER_ID, orgId: ORG_ID, accessibleOrgIds: null, canAccessOrg: () => true,
    } as typeof authRef.current;

    const res = await makeApp().request(`/alerts/routing-rules?orgId=${ORG_ID}`);
    expect(res.status).toBe(200);

    const whereText = sqlText(capturedWhere.current);
    expect(whereText).toContain('org_id');
    expect(whereText).not.toContain('is null');
    expect(whereText).not.toContain(PARTNER_ID);
  });
});
