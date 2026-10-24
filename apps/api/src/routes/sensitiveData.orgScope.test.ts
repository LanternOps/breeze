import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, inArray, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

// #9681: Sensitive Data dashboard, findings (report) and scans must honour the
// header org switcher's ?orgId= selection, narrowing only within the caller's
// accessible orgs. The real schema is used (not stubbed) so each route's WHERE
// clause can be rendered to SQL and asserted on.

const { whereCalls, selectMock } = vi.hoisted(() => {
  const whereCalls: unknown[] = [];
  const selectMock = vi.fn(() => {
    const chain: any = {};
    for (const method of ['from', 'innerJoin', 'leftJoin', 'orderBy', 'limit', 'offset', 'groupBy']) {
      chain[method] = vi.fn(() => chain);
    }
    chain.where = vi.fn((clause: unknown) => {
      whereCalls.push(clause);
      return chain;
    });
    chain.then = (resolve: (rows: unknown[]) => unknown, reject: (err: unknown) => unknown) =>
      Promise.resolve([]).then(resolve, reject);
    return chain;
  });
  return { whereCalls, selectMock };
});

vi.mock('../db', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SITE_A = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    const user = { id: 'user-1', email: 'test@example.com', name: 'Test User' };
    const shape = c.req.header('x-auth-shape') ?? 'partner';
    if (shape === 'org') {
      // An org-scoped user of ORG_A only.
      c.set('auth', {
        user, scope: 'organization', orgId: ORG_A, partnerId: null, partnerOrgAccess: null,
        accessibleOrgIds: [ORG_A],
        orgCondition: (column: any) => eq(column, ORG_A),
        canAccessOrg: (id: string) => id === ORG_A,
      });
    } else if (shape === 'system') {
      // System scope: no org condition at all.
      c.set('auth', {
        user, scope: 'system', orgId: null, partnerId: null, partnerOrgAccess: null,
        accessibleOrgIds: null,
        orgCondition: () => undefined,
        canAccessOrg: () => true,
      });
    } else {
      // A partner technician who can reach two client orgs.
      c.set('auth', {
        user, scope: 'partner', orgId: null,
        partnerId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        partnerOrgAccess: 'all',
        accessibleOrgIds: [ORG_A, ORG_B],
        orgCondition: (column: any) => inArray(column, [ORG_A, ORG_B]),
        canAccessOrg: (id: string) => id === ORG_A || id === ORG_B,
      });
    }
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    const restrict = c.req.header('x-restrict-site');
    c.set('permissions', { permissions: [], allowedSiteIds: restrict ? [restrict] : undefined });
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/commandQueue', () => ({
  CommandTypes: { ENCRYPT_FILE: 'encrypt_file', QUARANTINE_FILE: 'quarantine_file', SECURE_DELETE_FILE: 'secure_delete_file' },
  queueCommand: vi.fn(),
}));
vi.mock('../jobs/sensitiveDataJobs', () => ({ enqueueSensitiveDataScan: vi.fn() }));
vi.mock('../services/eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

import { sensitiveDataRoutes } from './sensitiveData';
import { db } from '../db';

const dialect = new PgDialect();

function renderedWheres(): { sql: string; params: unknown[] }[] {
  return whereCalls.map((clause) => dialect.sqlToQuery(clause as SQL));
}

const routes = [
  { path: '/sensitive-data/scans', table: 'sensitive_data_scans', selects: 1 },
  { path: '/sensitive-data/report', table: 'sensitive_data_findings', selects: 2 },
  { path: '/sensitive-data/dashboard', table: 'sensitive_data_findings', selects: 1 },
] as const;

describe('sensitive data reads honour the selected organization (#9681)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    whereCalls.length = 0;
    app = new Hono();
    app.route('/sensitive-data', sensitiveDataRoutes);
  });

  for (const route of routes) {
    describe(`GET ${route.path}`, () => {
      it('narrows every query to the selected org', async () => {
        const res = await app.request(`${route.path}?orgId=${ORG_A}`);

        expect(res.status).toBe(200);
        const wheres = renderedWheres();
        expect(wheres).toHaveLength(route.selects);
        for (const where of wheres) {
          expect(where.sql).toContain(`"${route.table}"."org_id" = $`);
          expect(where.params).toContain(ORG_A);
          // The accessible-org condition is still applied on top.
          expect(where.sql).toContain(`"${route.table}"."org_id" in (`);
        }
      });

      it('returns 403 for an org outside the caller\'s access and queries nothing', async () => {
        const res = await app.request(`${route.path}?orgId=${ORG_OTHER}`);

        expect(res.status).toBe(403);
        expect(selectMock).not.toHaveBeenCalled();
        expect(whereCalls).toHaveLength(0);
      });

      it('denies an org-scoped caller selecting another org (403)', async () => {
        const res = await app.request(`${route.path}?orgId=${ORG_B}`, { headers: { 'x-auth-shape': 'org' } });

        expect(res.status).toBe(403);
        expect(whereCalls).toHaveLength(0);
      });

      it('narrows a system-scope caller, which has no org condition, to the selected org', async () => {
        const res = await app.request(`${route.path}?orgId=${ORG_A}`, { headers: { 'x-auth-shape': 'system' } });

        expect(res.status).toBe(200);
        const wheres = renderedWheres();
        expect(wheres).toHaveLength(route.selects);
        for (const where of wheres) {
          expect(where.sql).toContain(`"${route.table}"."org_id" = $`);
          expect(where.params).toContain(ORG_A);
        }
      });

      it('keeps the site restriction when narrowing to the selected org', async () => {
        const res = await app.request(`${route.path}?orgId=${ORG_A}`, { headers: { 'x-restrict-site': SITE_A } });

        expect(res.status).toBe(200);
        const wheres = renderedWheres();
        expect(wheres).toHaveLength(route.selects);
        for (const where of wheres) {
          expect(where.sql).toContain(`"${route.table}"."org_id" = $`);
          expect(where.sql).toContain('"devices"."site_id" in (');
          expect(where.params).toEqual(expect.arrayContaining([ORG_A, SITE_A]));
        }
      });

      it('returns 400 for a malformed orgId', async () => {
        const res = await app.request(`${route.path}?orgId=not-a-uuid`);

        expect(res.status).toBe(400);
        expect(selectMock).not.toHaveBeenCalled();
      });

      it('keeps every accessible org when no org is selected', async () => {
        const res = await app.request(route.path);

        expect(res.status).toBe(200);
        const wheres = renderedWheres();
        expect(wheres).toHaveLength(route.selects);
        for (const where of wheres) {
          expect(where.sql).not.toContain(`"${route.table}"."org_id" = $`);
          expect(where.sql).toContain(`"${route.table}"."org_id" in (`);
          expect(where.params).toEqual(expect.arrayContaining([ORG_A, ORG_B]));
        }
      });
    });
  }
});

// Policies: the web client never sends a body orgId; fetchWithAuth appends the
// header switcher's ?orgId= query param instead. Create must resolve the target
// org from that (validated) query param, and the list must narrow to it.
describe('sensitive data policies honour the selected organization', () => {
  let app: Hono;
  let inserted: Record<string, unknown> | undefined;

  const body = { name: 'P', detectionClasses: ['pii'] };
  const post = (qs: string, extra: Record<string, unknown> = {}) =>
    app.request(`/sensitive-data/policies${qs}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, ...extra }),
    });

  beforeEach(() => {
    vi.clearAllMocks();
    whereCalls.length = 0;
    inserted = undefined;
    (db.insert as any).mockImplementation(() => ({
      values: (v: Record<string, unknown>) => {
        inserted = v;
        return {
          returning: async () => [{
            id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', name: v.name, orgId: v.orgId, partnerId: v.partnerId,
            scope: v.scope, detectionClasses: v.detectionClasses, schedule: null, isActive: true,
            createdAt: new Date(), updatedAt: new Date(),
          }],
        };
      },
    }));
    app = new Hono();
    app.route('/sensitive-data', sensitiveDataRoutes);
  });

  it('POST resolves the org from ?orgId when the body has none (multi-org partner)', async () => {
    const res = await post(`?orgId=${ORG_B}`);

    expect(res.status).toBe(201);
    expect(inserted?.orgId).toBe(ORG_B);
    expect(inserted?.partnerId).toBeNull();
  });

  it('POST body orgId wins over ?orgId', async () => {
    const res = await post(`?orgId=${ORG_B}`, { orgId: ORG_A });

    expect(res.status).toBe(201);
    expect(inserted?.orgId).toBe(ORG_A);
  });

  it('POST denies an inaccessible ?orgId (403) and inserts nothing', async () => {
    const res = await post(`?orgId=${ORG_OTHER}`);

    expect(res.status).toBe(403);
    expect(inserted).toBeUndefined();
  });

  it('POST still 400s for a multi-org partner with no org anywhere', async () => {
    const res = await post('');

    expect(res.status).toBe(400);
    expect(inserted).toBeUndefined();
  });

  it('GET narrows org-owned rows to ?orgId and keeps own partner-wide rows', async () => {
    const res = await app.request(`/sensitive-data/policies?orgId=${ORG_A}`);

    expect(res.status).toBe(200);
    expect(whereCalls).toHaveLength(1);
    const where = renderedWheres()[0]!;
    expect(where.sql).toContain('"sensitive_data_policies"."org_id" = $');
    expect(where.sql).toContain('"sensitive_data_policies"."org_id" in (');
    // The narrowing clause itself must keep partner-wide rows: the access
    // condition already renders one `org_id IS NULL`, so assert the OR form.
    expect(where.sql).toMatch(/\("sensitive_data_policies"\."org_id" = \$\d+ OR "sensitive_data_policies"\."org_id" IS NULL\)/i);
    expect(where.params).toContain(ORG_A);
  });

  it('GET returns 403 for an inaccessible ?orgId and queries nothing', async () => {
    const res = await app.request(`/sensitive-data/policies?orgId=${ORG_OTHER}`);

    expect(res.status).toBe(403);
    expect(whereCalls).toHaveLength(0);
  });

  it('GET without ?orgId keeps every accessible org', async () => {
    const res = await app.request('/sensitive-data/policies');

    expect(res.status).toBe(200);
    const where = renderedWheres()[0]!;
    expect(where.sql).not.toContain('"sensitive_data_policies"."org_id" = $');
    expect(where.params).toEqual(expect.arrayContaining([ORG_A, ORG_B]));
  });
});
