import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';

const { requirePermissionMock } = vi.hoisted(() => ({
  requirePermissionMock: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    const restricted = c.req.header('x-site-restricted');
    c.set('permissions', {
      permissions: [{ resource, action }],
      allowedSiteIds:
        restricted === 'true' ? ['site-allowed'] : restricted === 'empty' ? [] : undefined,
    });
    return next();
  }),
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    status: 'devices.status',
  },
}));

const ACCESSIBLE_ORG_ID = '0d4433c3-6fa5-4bfb-a217-c9d2924e3f01';

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1' },
      scope: 'organization',
      orgId: '0d4433c3-6fa5-4bfb-a217-c9d2924e3f01',
      accessibleOrgIds: ['0d4433c3-6fa5-4bfb-a217-c9d2924e3f01'],
      canAccessOrg: (orgId: string) => orgId === '0d4433c3-6fa5-4bfb-a217-c9d2924e3f01',
      // Real SQL fragment so tests can assert the condition reaches where().
      orgCondition: () => sql`ORG_CONDITION_SENTINEL`,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: requirePermissionMock,
}));

import { db } from '../../db';
import { statsRoutes } from './stats';

const registeredPermissionCalls = [...requirePermissionMock.mock.calls];

let lastWhereArg: unknown;

function mockGroupByRows(rows: Array<{ status: string; count: number | string }>) {
  lastWhereArg = undefined;
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation((arg: unknown) => {
        lastWhereArg = arg;
        return { groupBy: vi.fn().mockResolvedValue(rows) };
      }),
    }),
  } as any);
}

// Serialize a drizzle SQL tree (safely, despite cycles) so tests can assert
// that a given column/value actually made it into the WHERE conditions —
// the site-allowlist narrowing has no RLS backstop, so a dropped condition
// here would be a silent cross-site leak.
function sqlToString(node: unknown): string {
  const seen = new Set<object>();
  return JSON.stringify(node, (_k, v) => {
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return '[circular]';
      seen.add(v);
    }
    return v;
  });
}

describe('device stats route', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', statsRoutes);
  });

  it('requires explicit device read permission', () => {
    expect(registeredPermissionCalls).toContainEqual(['devices', 'read']);
  });

  it('aggregates counts by status with an exact online/offline split', async () => {
    // pg returns bigint counts as strings — the route must coerce them.
    mockGroupByRows([
      { status: 'online', count: '3' },
      { status: 'offline', count: 2 },
      { status: 'maintenance', count: '1' },
    ]);

    const res = await app.request('/devices/stats', {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      total: 6,
      online: 3,
      offline: 3,
      byStatus: { online: 3, offline: 2, maintenance: 1 },
    });
  });

  it('returns zeros for an empty fleet', async () => {
    mockGroupByRows([]);

    const res = await app.request('/devices/stats', {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ total: 0, online: 0, offline: 0, byStatus: {} });
  });

  it('pushes the org condition and decommissioned exclusion into WHERE', async () => {
    mockGroupByRows([]);

    const res = await app.request('/devices/stats', {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const rendered = sqlToString(lastWhereArg);
    expect(rendered).toContain('ORG_CONDITION_SENTINEL');
    expect(rendered).toContain('decommissioned');
  });

  it('narrows to the accessible orgId filter when supplied', async () => {
    mockGroupByRows([]);

    const res = await app.request(`/devices/stats?orgId=${ACCESSIBLE_ORG_ID}`, {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(sqlToString(lastWhereArg)).toContain(ACCESSIBLE_ORG_ID);
  });

  it('narrows site-restricted callers to their allowed sites', async () => {
    mockGroupByRows([{ status: 'online', count: 1 }]);

    const res = await app.request('/devices/stats', {
      headers: { Authorization: 'Bearer token', 'x-site-restricted': 'true' },
    });

    expect(res.status).toBe(200);
    expect(sqlToString(lastWhereArg)).toContain('site-allowed');
  });

  it('rejects an orgId filter outside the caller scope', async () => {
    const res = await app.request(
      '/devices/stats?orgId=0d4433c3-6fa5-4bfb-a217-c9d2924e3f8a',
      { headers: { Authorization: 'Bearer token' } }
    );

    expect(res.status).toBe(403);
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });

  it('short-circuits to zeros when the site allowlist is empty', async () => {
    const res = await app.request('/devices/stats', {
      headers: { Authorization: 'Bearer token', 'x-site-restricted': 'empty' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ total: 0, online: 0, offline: 0, byStatus: {} });
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });
});
