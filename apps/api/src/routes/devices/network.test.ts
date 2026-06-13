import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Tests for the network arm of the unified Devices list (issue #1322,
// phase 1): GET /devices/network surfaces approved, unlinked
// discovered_assets normalized into the shared list shape with
// deviceClass='network'.

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
  },
}));

vi.mock('../../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/schema')>();
  return { ...actual };
});

let accessibleOrgIds: string[] = ['org-1'];

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => async (c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'a@b.c', name: 'A' },
      scope: 'organization',
      orgId: 'org-1',
      partnerId: null,
      accessibleOrgIds,
      canAccessOrg: (orgId: string) => accessibleOrgIds.includes(orgId),
      orgCondition: () => undefined,
      token: { mfa: false },
    });
    return next();
  }),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    c.set('permissions', {
      permissions: [{ resource, action }],
      partnerId: null,
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'organization',
      allowedSiteIds: undefined,
    });
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

import { networkRoutes } from './network';
import { db } from '../../db';

/**
 * Rig the two query shapes the route uses:
 *   - row query: select().from().where().orderBy().limit().offset() → rows
 *   - count query (includeTotal): select().from().where() → [{count}]
 * The count query resolves the promise at `.where()`; the row query keeps
 * chaining. We disambiguate by returning a thenable from `.where()` that
 * also carries `.orderBy`.
 */
function rigNetworkRows(rows: unknown[], total?: number) {
  const offset = vi.fn().mockResolvedValue(rows);
  const limit = vi.fn().mockReturnValue({ offset });
  const orderBy = vi.fn().mockReturnValue({ limit });

  vi.mocked(db.select).mockImplementation(((arg: any) => {
    // The count query selects `{ count: sql }`; the row query selects the
    // full projection. Detect the count query by its single `count` key.
    const isCount = arg && typeof arg === 'object' && 'count' in arg && Object.keys(arg).length === 1;
    const where = isCount
      ? vi.fn().mockResolvedValue([{ count: total ?? rows.length }])
      : vi.fn().mockReturnValue({ orderBy });
    const from = vi.fn().mockReturnValue({ where });
    return { from } as never;
  }) as never);
}

describe('GET /devices/network — unified-list network arm (#1322)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    accessibleOrgIds = ['org-1'];
    app = new Hono();
    app.route('/devices', networkRoutes);
  });

  it('normalizes an approved unlinked asset into the shared list shape with deviceClass="network"', async () => {
    rigNetworkRows([
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        orgId: 'org-1',
        siteId: 'site-1',
        assetType: 'printer',
        hostname: 'hp-laserjet.local',
        label: 'Front Desk Printer',
        ipAddress: '10.0.0.42',
        macAddress: '00:11:22:33:44:55',
        manufacturer: 'HP',
        model: 'LaserJet 400',
        isOnline: true,
        responseTimeMs: 4.2,
        openPorts: [9100, 631],
        lastSeenAt: new Date('2026-06-13T10:00:00.000Z'),
        firstSeenAt: new Date('2026-06-01T10:00:00.000Z'),
        tags: ['lobby'],
        snmpMonitoringEnabled: true,
        networkMonitoringEnabled: false,
      },
    ]);

    const res = await app.request('/devices/network?limit=50', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    const row = body.data[0];

    expect(row).toMatchObject({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      deviceClass: 'network',
      assetType: 'printer',
      // Label wins as the display name.
      hostname: 'Front Desk Printer',
      status: 'online',
      ipAddress: '10.0.0.42',
      manufacturer: 'HP',
      model: 'LaserJet 400',
      responseTimeMs: 4.2,
      monitoringEnabled: true,
    });

    // Agent-only fields must be present-but-null so the web table renders "—".
    expect(row.cpuPercent).toBeNull();
    expect(row.ramPercent).toBeNull();
    expect(row.agentVersion).toBeNull();
    expect(row.osBuild).toBeNull();
    expect(row.hardware).toBeNull();
  });

  it('falls back to hostname then IP when no label is set, and maps offline status', async () => {
    rigNetworkRows([
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        orgId: 'org-1',
        siteId: 'site-1',
        assetType: 'router',
        hostname: 'gw-01',
        label: null,
        ipAddress: '10.0.0.1',
        macAddress: null,
        manufacturer: null,
        model: null,
        isOnline: false,
        responseTimeMs: null,
        openPorts: null,
        lastSeenAt: null,
        firstSeenAt: new Date('2026-06-01T10:00:00.000Z'),
        tags: null,
        snmpMonitoringEnabled: false,
        networkMonitoringEnabled: false,
      },
    ]);

    const res = await app.request('/devices/network', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.data[0];
    expect(row.hostname).toBe('gw-01');
    expect(row.status).toBe('offline');
    expect(row.assetType).toBe('router');
    expect(row.tags).toEqual([]);
  });

  it('returns total only when includeTotal=true', async () => {
    rigNetworkRows([], 7);

    const withTotal = await app.request('/devices/network?includeTotal=true', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });
    const withTotalBody = await withTotal.json();
    expect(withTotalBody.pagination.total).toBe(7);

    rigNetworkRows([]);
    const withoutTotal = await app.request('/devices/network', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });
    const withoutTotalBody = await withoutTotal.json();
    expect(withoutTotalBody.pagination.total).toBeUndefined();
  });

  it('rejects a single-org filter the caller cannot access with 403', async () => {
    rigNetworkRows([]);
    const res = await app.request('/devices/network?orgId=00000000-0000-4000-8000-000000000000', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/denied/i);
  });

  it('rejects an invalid assetType value via the query schema (400)', async () => {
    rigNetworkRows([]);
    const res = await app.request('/devices/network?assetType=bogus', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(400);
  });
});
