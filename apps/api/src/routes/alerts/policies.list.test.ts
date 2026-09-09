import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Sweep 2026-09-08 (G6-4) — GET /alerts/policies?orgId=<org> for a
// partner-scoped caller built the per-org filter as a bare
// `eq(escalationPolicies.orgId, query.orgId)`, unlike the sibling "all orgs"
// branch right below it (no ?orgId=) which already ORs in the partner's own
// partner-wide policies (org_id NULL, partner_id = auth.partnerId, #2130). A
// policy created via POST /alerts/policies with ownerScope: 'partner' was
// therefore invisible from every per-org view even though it applies to that
// org's devices.
//
// These tests inspect the actual `.where(...)` condition passed to Drizzle
// (real `and`/`or`/`eq`/`isNull` from drizzle-orm, not mocked) rather than
// trusting a canned mock row, per the repo's drizzle-mock conventions
// (assert on bound params/SQL structure, not a stub that would pass
// regardless of what was queried).

const { authRef } = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'partner' as string,
      user: { id: 'u-1', name: 'Pat Partner', email: 'pat@partner.example' },
      partnerId: 'p-1' as string | null,
      orgId: null as string | null,
      accessibleOrgIds: ['org-1'] as string[] | null,
      canAccessOrg: (_id: string) => true as boolean,
    },
  },
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
  siteAccessCheck: () => () => true,
}));

const countWhereRef = { current: undefined as unknown };
const listWhereRef = { current: undefined as unknown };
const rowsRef = { current: [] as unknown[] };

// A count query passes an object arg to select({ count: ... }); the list
// query calls select() with no args — that's how the route itself
// distinguishes the two, so the mock keys off the same signal.
vi.mock('../../db', () => ({
  db: {
    select: (arg?: unknown) => {
      if (arg) {
        return {
          from: () => ({
            where: (cond: unknown) => {
              countWhereRef.current = cond;
              return Promise.resolve([{ count: rowsRef.current.length }]);
            },
          }),
        };
      }
      return {
        from: () => ({
          where: (cond: unknown) => {
            listWhereRef.current = cond;
            return {
              orderBy: () => ({
                limit: () => ({
                  offset: () => Promise.resolve(rowsRef.current),
                }),
              }),
            };
          },
        }),
      };
    },
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

vi.mock('../../db/schema', () => ({
  escalationPolicies: {
    id: { name: 'id' },
    orgId: { name: 'org_id' },
    partnerId: { name: 'partner_id' },
    name: { name: 'name' },
    steps: { name: 'steps' },
    updatedAt: { name: 'updated_at' },
    createdAt: { name: 'created_at' },
  },
  organizations: { id: { name: 'id' }, partnerId: { name: 'partner_id' } },
  partners: { id: { name: 'id' } },
  alertRules: {},
  alertTemplates: {},
  alerts: {},
  devices: {},
  notificationChannels: {},
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

import { policiesRoutes } from './policies';

function makeApp() {
  const app = new Hono();
  app.route('/alerts', policiesRoutes);
  return app;
}

/**
 * Flattens a drizzle condition (real `eq`/`and`/`or`/`isNull`/`inArray`) to
 * its static text. Same introspection approach as channels.list.test.ts.
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

describe('GET /alerts/policies?orgId= — partner-wide read branch (sweep G6-4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    countWhereRef.current = undefined;
    listWhereRef.current = undefined;
    rowsRef.current = [];
  });

  it('includes the partner-wide branch for a PARTNER-scoped caller with ?orgId=', async () => {
    authRef.current = {
      scope: 'partner',
      user: { id: 'u-1', name: 'Pat', email: 'pat@partner.example' },
      partnerId: PARTNER_ID,
      orgId: null,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: () => true,
    } as typeof authRef.current;

    const res = await makeApp().request(`/alerts/policies?orgId=${ORG_ID}`);
    expect(res.status).toBe(200);

    const listText = sqlText(listWhereRef.current);
    expect(listText).toContain('org_id');
    expect(listText).toContain(ORG_ID);
    expect(listText).toContain('is null');
    expect(listText).toContain('partner_id');
    expect(listText).toContain(PARTNER_ID);

    const countText = sqlText(countWhereRef.current);
    expect(countText).toContain('is null');
    expect(countText).toContain(PARTNER_ID);
  });

  it('does NOT include a partner-wide branch for an ORG-scoped caller with ?orgId= (RLS is stricter than the app layer; never claim parity)', async () => {
    authRef.current = {
      scope: 'organization',
      user: { id: 'u-2', name: 'Olive Org', email: 'olive@org.example' },
      partnerId: PARTNER_ID,
      orgId: ORG_ID,
      accessibleOrgIds: null,
      canAccessOrg: () => true,
    } as typeof authRef.current;

    const res = await makeApp().request(`/alerts/policies?orgId=${ORG_ID}`);
    expect(res.status).toBe(200);

    const listText = sqlText(listWhereRef.current);
    expect(listText).toContain('org_id');
    expect(listText).toContain(ORG_ID);
    expect(listText).not.toContain('is null');
    expect(listText).not.toContain(PARTNER_ID);
  });
});
