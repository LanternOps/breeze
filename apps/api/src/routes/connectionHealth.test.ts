import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const { state, rowsMock, whereMock, orderByMock, limitMock, distinctMock, distinctWhereMock } = vi.hoisted(() => ({
  state: { scope: 'partner' as string, permissions: [] as Array<{ resource: string; action: string }> },
  rowsMock: vi.fn(),
  whereMock: vi.fn(),
  orderByMock: vi.fn(),
  limitMock: vi.fn(),
  distinctMock: vi.fn(),
  distinctWhereMock: vi.fn(),
}));

vi.mock('../db', () => {
  const chain: any = {
    from: () => chain,
    where: (w: unknown) => { whereMock(w); return chain; },
    orderBy: (...o: unknown[]) => { orderByMock(...o); return chain; },
    limit: (n: number) => { limitMock(n); return rowsMock(); },
  };
  const distinct: any = {
    from: () => distinct,
    where: (w: unknown) => { distinctWhereMock(w); return Promise.resolve(distinctMock()); },
  };
  return { db: { select: () => chain, selectDistinct: () => distinct } };
});

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', { user: { id: 'user-1' }, scope: state.scope, partnerId: 'p-1', orgId: null });
    return next();
  }),
  requireScope: vi.fn((...scopes: string[]) => async (c: any, next: any) =>
    scopes.includes(c.get('auth').scope) ? next() : c.json({ error: 'Forbidden' }, 403)),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    if (!state.permissions.some((p) => p.resource === resource && p.action === action)) {
      return c.json({ error: 'Permission denied' }, 403);
    }
    c.set('permissions', { permissions: state.permissions });
    return next();
  }),
}));

import { connectionHealthRoutes } from './connectionHealth';

const ORGS_READ = { resource: 'organizations', action: 'read' };

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'a', partnerId: 'p-1', orgId: 'o-1', ownerUserId: 'u-secret', sourceKind: 'oauth_grant',
    sourceId: 's-1', condition: 'grant_revoked_reuse', severity: 'permanent', detail: 'd', displayName: 'Conn',
    fixHref: '/settings/connected-apps', ownerFixHref: '/account/connected-apps', viewPermission: 'connected_apps:read',
    repairPermission: 'connected_apps:manage', firstFailedAt: new Date('2026-10-01T00:00:00Z'),
    openedAt: new Date('2026-10-01T00:30:00Z'), lastObservedAt: new Date('2026-10-02T00:00:00Z'),
    healthyStreak: 0, flapCount: 0, resolvedAt: null, resolution: null,
    pendingNotice: 'opened', notifiedUserIds: ['u-secret'], ...over,
  };
}

const lastOrderBySql = () =>
  new PgDialect().sqlToQuery(sql.join(orderByMock.mock.calls.at(-1)! as SQL[], sql`, `)).sql;

const lastWhereSql = () => {
  const w = whereMock.mock.calls.at(-1)![0];
  return new PgDialect().sqlToQuery(w).sql;
};

describe('GET /connection-health/incidents', () => {
  let app: Hono;
  const get = (path = '/connection-health/incidents') => app.request(path, { headers: { Authorization: 'Bearer t' } });

  beforeEach(() => {
    vi.clearAllMocks();
    state.scope = 'partner';
    state.permissions = [ORGS_READ, { resource: 'connected_apps', action: 'read' }];
    rowsMock.mockResolvedValue([]);
    distinctMock.mockReturnValue([{ viewPermission: 'connected_apps:read' }, { viewPermission: 'backup:read' }]);
    app = new Hono();
    app.onError((err, c) => c.json({ unhandled: err.message }, 500));
    app.route('/connection-health', connectionHealthRoutes);
  });

  it('returns only incidents whose view permission the caller holds', async () => {
    rowsMock.mockResolvedValue([row({ id: 'a' }), row({ id: 'b', viewPermission: 'backup:read' })]);
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).data.map((d: { id: string }) => d.id)).toEqual(['a']);
  });

  it('a partner caller without the view permission does not see the row', async () => {
    state.permissions = [ORGS_READ];
    rowsMock.mockResolvedValue([row()]);
    expect((await (await get()).json()).data).toEqual([]);
  });

  it('limit applies after the permission filter: the permitted view permissions are in the row WHERE', async () => {
    distinctMock.mockReturnValue([
      { viewPermission: 'connected_apps:read' }, { viewPermission: 'backup:read' }, { viewPermission: 'organizations:read' },
    ]);
    await get();
    const q = new PgDialect().sqlToQuery(whereMock.mock.calls.at(-1)![0]);
    expect(q.sql).toMatch(/"view_permission" in \(\$\d+, \$\d+\)/i);
    expect(q.params).toEqual(expect.arrayContaining(['connected_apps:read', 'organizations:read']));
    expect(q.params).not.toContain('backup:read');
    expect(limitMock).toHaveBeenCalledWith(501);
  });

  it('the distinct-permission probe uses the same status filter as the rows', async () => {
    await get();
    expect(new PgDialect().sqlToQuery(distinctWhereMock.mock.calls.at(-1)![0]).sql).toMatch(/"resolved_at" is null/i);
  });

  it('a caller holding none of the present view permissions gets nothing, without the row query', async () => {
    distinctMock.mockReturnValue([{ viewPermission: 'backup:read' }]);
    const body = await (await get()).json();
    expect(body).toEqual({ data: [], truncated: false });
    expect(rowsMock).not.toHaveBeenCalled();
  });

  it('flags truncation only when more than 500 rows match, and returns at most 500', async () => {
    rowsMock.mockResolvedValue(Array.from({ length: 501 }, (_, i) => row({ id: `r${i}` })));
    const over = await (await get()).json();
    expect(over.truncated).toBe(true);
    expect(over.data).toHaveLength(500);
    rowsMock.mockResolvedValue(Array.from({ length: 500 }, (_, i) => row({ id: `r${i}` })));
    expect((await (await get()).json()).truncated).toBe(false);
  });

  it('system scope skips the permission probe and filter', async () => {
    state.scope = 'system';
    await get();
    expect(distinctMock).not.toHaveBeenCalled();
    expect(new PgDialect().sqlToQuery(whereMock.mock.calls.at(-1)![0]).sql).not.toMatch(/view_permission/i);
  });

  it('system scope sees every row without the permission filter', async () => {
    state.scope = 'system';
    state.permissions = [ORGS_READ];
    rowsMock.mockResolvedValue([row({ id: 'a' }), row({ id: 'b', viewPermission: 'backup:read' })]);
    expect((await (await get()).json()).data).toHaveLength(2);
  });

  it('rejects organization scope with 403', async () => {
    state.scope = 'organization';
    expect((await get()).status).toBe(403);
    expect(rowsMock).not.toHaveBeenCalled();
  });

  it('rejects a caller without organizations:read', async () => {
    state.permissions = [{ resource: 'connected_apps', action: 'read' }];
    expect((await get()).status).toBe(403);
  });

  it('default (open) excludes pending and resolved rows in SQL', async () => {
    await get();
    const sql = lastWhereSql();
    expect(sql).toMatch(/"resolved_at" is null/i);
    expect(sql).toMatch(/"opened_at" is not null/i);
  });

  it('status=recent queries opened, resolved rows from the last 7 days', async () => {
    const before = Date.now();
    await get('/connection-health/incidents?status=recent');
    const w = whereMock.mock.calls.at(-1)![0];
    const q = new PgDialect().sqlToQuery(w);
    expect(q.sql).toMatch(/"resolved_at" is not null/i);
    expect(q.sql).toMatch(/"opened_at" is not null/i);
    expect(q.sql).toMatch(/"resolved_at" >/i);
    const cutoff = q.params.find((p) => typeof p === 'string' && /^\d{4}-/.test(p as string)) as string;
    const age = before - new Date(cutoff).getTime();
    expect(Math.abs(age - 7 * 24 * 3600 * 1000)).toBeLessThan(60_000);
  });

  it('open orders by opened_at, then id, both descending', async () => {
    await get();
    expect(lastOrderBySql()).toBe('"connection_health_incidents"."opened_at" desc, "connection_health_incidents"."id" desc');
  });

  it('recent orders by resolved_at, then id, both descending', async () => {
    await get('/connection-health/incidents?status=recent');
    expect(lastOrderBySql()).toBe('"connection_health_incidents"."resolved_at" desc, "connection_health_incidents"."id" desc');
  });

  it('rejects an unknown status value with 400', async () => {
    expect((await get('/connection-health/incidents?status=all')).status).toBe(400);
    expect(rowsMock).not.toHaveBeenCalled();
  });

  it('omits internal fields from the response', async () => {
    rowsMock.mockResolvedValue([row()]);
    const [item] = (await (await get()).json()).data;
    expect(Object.keys(item).sort()).toEqual([
      'condition', 'detail', 'displayName', 'firstFailedAt', 'fixHref', 'id', 'lastObservedAt',
      'openedAt', 'orgId', 'resolution', 'resolvedAt', 'severity', 'sourceKind',
    ]);
    const text = JSON.stringify(item);
    for (const secret of ['notifiedUserIds', 'ownerUserId', 'pendingNotice', 'ownerFixHref', 'u-secret', '/account/connected-apps']) {
      expect(text).not.toContain(secret);
    }
  });

  it('exposes no write methods', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await app.request('/connection-health/incidents', { method, headers: { Authorization: 'Bearer t' } });
      expect([404, 405]).toContain(res.status);
    }
  });
});
