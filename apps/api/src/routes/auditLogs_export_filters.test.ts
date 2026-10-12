import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';

// #8366: GET /audit-logs/export must apply the same filters as the list /
// search endpoints, through the same condition builder, in the same tenant
// scope. The WHERE clause handed to the DB is compared list-vs-export.

vi.mock('../services', () => ({}));
vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  writeRouteAudit: vi.fn()
}));

const queryWheres: unknown[] = [];

vi.mock('../db', () => {
  const chain: any = {
    leftJoin: vi.fn(() => chain),
    where: vi.fn((w: unknown) =>
      Object.assign(Promise.resolve([{ count: 0 }]), {
        orderBy: vi.fn(() => {
          queryWheres.push(w);
          return { limit: vi.fn(() => ({ offset: vi.fn().mockResolvedValue([]) })) };
        })
      })
    )
  };
  return {
    db: { select: vi.fn(() => ({ from: vi.fn(() => chain) })) },
    withDbAccessContext: vi.fn(async (_c: any, fn: any) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: any) => fn()),
    runOutsideDbContext: vi.fn((fn: any) => fn()),
    SYSTEM_DB_ACCESS_CONTEXT: { scope: 'system', orgId: null, accessibleOrgIds: null }
  };
});

vi.mock('../db/schema', () => ({
  auditLogs: {
    orgId: 'orgId', actorId: 'actorId', timestamp: 'timestamp', id: 'id', partnerId: 'partnerId',
    action: 'action', actorEmail: 'actorEmail', resourceType: 'resourceType',
    resourceName: 'resourceName', details: 'details'
  },
  users: { id: 'id', name: 'name' },
  devices: { agentId: 'agentId', hostname: 'hostname', displayName: 'displayName', siteId: 'siteId' }
}));

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com' },
      scope: 'organization',
      orgId: '11111111-1111-4111-8111-111111111111',
      accessibleOrgIds: ['11111111-1111-4111-8111-111111111111'],
      canAccessOrg: (id: string) => id === '11111111-1111-4111-8111-111111111111',
      orgCondition: vi.fn(() => undefined)
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next())
}));

const dialect = new PgDialect();
const render = (w: unknown) => {
  if (!w) return 'NO_WHERE';
  const q = dialect.sqlToQuery(w as any);
  return JSON.stringify({ sql: q.sql, params: q.params });
};

describe('GET /audit-logs/export honours the list filters (#8366)', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.clearAllMocks();
    queryWheres.length = 0;
    const { auditLogRoutes } = await import('./auditLogs');
    app = new Hono();
    app.route('/audit-logs', auditLogRoutes);
  });

  const lastWhere = () => queryWheres[queryWheres.length - 1];

  const cases: Array<[string, string, string]> = [
    ['date range', 'from=2026-10-01T00:00:00.000Z&to=2026-10-09T00:00:00.000Z', '/audit-logs'],
    ['action', 'action=device.update', '/audit-logs'],
    ['resource', 'resource=device', '/audit-logs'],
    ['user', 'user=riley', '/audit-logs'],
    ['search', 'q=needle', '/audit-logs/search'],
    ['all combined', 'from=2026-10-01T00:00:00.000Z&to=2026-10-09T00:00:00.000Z&action=device&resource=dev&user=riley&q=needle', '/audit-logs/search'],
    ['pinned org', `orgId=${ORG_A}&action=device`, '/audit-logs']
  ];

  it.each(cases)('export WHERE equals the list WHERE for %s', async (_name, qs, listPath) => {
    const listRes = await app.request(`${listPath}?${qs}`);
    expect(listRes.status).toBe(200);
    const listWhere = lastWhere();
    queryWheres.length = 0;

    const exportRes = await app.request(`/audit-logs/export?${qs}`);
    expect(exportRes.status).toBe(200);
    expect(queryWheres).toHaveLength(1);
    expect(render(lastWhere())).toBe(render(listWhere));
  });

  it('control: filters change the WHERE (list-vs-export equality is not vacuous)', async () => {
    await app.request('/audit-logs/export');
    const unfiltered = render(lastWhere());
    queryWheres.length = 0;
    await app.request('/audit-logs/export?action=device.update&q=needle&from=2026-10-01T00:00:00.000Z');
    expect(render(lastWhere())).not.toBe(unfiltered);
  });

  it('keeps the legacy userId filter alongside the new filters', async () => {
    const uid = '33333333-3333-4333-8333-333333333333';
    await app.request('/audit-logs/export');
    const base = render(lastWhere());
    queryWheres.length = 0;
    await app.request(`/audit-logs/export?userId=${uid}&action=device`);
    const withUser = render(lastWhere());
    expect(withUser).not.toBe(base);
    expect(withUser).toContain(uid);
    expect(withUser).toContain('%device%');
  });

  it('rejects a pinned org the caller cannot access, like the list (403)', async () => {
    const listRes = await app.request(`/audit-logs?orgId=${ORG_B}`);
    expect(listRes.status).toBe(403);
    queryWheres.length = 0;
    const res = await app.request(`/audit-logs/export?orgId=${ORG_B}`);
    expect(res.status).toBe(403);
    expect(queryWheres).toHaveLength(0);
  });
});
