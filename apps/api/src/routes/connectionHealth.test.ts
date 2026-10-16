import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';

const { state, rowsMock, whereMock } = vi.hoisted(() => ({
  state: { scope: 'partner' as string, permissions: [] as Array<{ resource: string; action: string }> },
  rowsMock: vi.fn(),
  whereMock: vi.fn(),
}));

vi.mock('../db', () => {
  const chain: any = {
    from: () => chain,
    where: (w: unknown) => { whereMock(w); return chain; },
    orderBy: () => chain,
    limit: () => rowsMock(),
  };
  return { db: { select: () => chain } };
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
    sourceId: 's-1', condition: 'token_revoked', severity: 'warning', detail: 'd', displayName: 'Conn',
    fixHref: '/settings/x', ownerFixHref: '/owner/fix', viewPermission: 'connected_apps:read',
    repairPermission: 'connected_apps:write', firstFailedAt: new Date('2026-10-01T00:00:00Z'),
    openedAt: new Date('2026-10-01T00:30:00Z'), lastObservedAt: new Date('2026-10-02T00:00:00Z'),
    healthyStreak: 0, flapCount: 0, resolvedAt: null, resolution: null,
    pendingNotice: 'opened', notifiedUserIds: ['u-secret'], ...over,
  };
}

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
    for (const secret of ['notifiedUserIds', 'ownerUserId', 'pendingNotice', 'ownerFixHref', 'u-secret', '/owner/fix']) {
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
