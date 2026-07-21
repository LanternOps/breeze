import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let allowedSiteIds: string[] | undefined;

vi.mock('../../db', () => ({
  db: { select: vi.fn() },
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  devices: {
    id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId', status: 'devices.status',
    osType: 'devices.osType', agentVersion: 'devices.agentVersion', lastSeenAt: 'devices.lastSeenAt',
  },
  deviceSoftware: {}, deviceMetrics: {}, deviceHardware: {}, alerts: {}, alertRules: {},
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('auth', { scope: 'organization', orgId: ORG_ID, user: { id: 'user-1' } });
    c.set('permissions', {
      permissions: [{ resource: 'reports', action: 'export' }],
      allowedSiteIds,
    });
    await next();
  },
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('./helpers', () => ({
  ensureOrgAccess: vi.fn(async () => true),
  getOrgIdsForAuth: vi.fn(async () => [ORG_ID]),
}));

import { db } from '../../db';
import { dataRoutes } from './data';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/reports', dataRoutes);
  return app;
}

function mockComplianceQueries() {
  const whereOnly = (rows: unknown[]) => ({
    from: vi.fn(() => ({ where: vi.fn().mockResolvedValue(rows) })),
  });
  const grouped = (rows: unknown[], ordered = false) => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        groupBy: vi.fn(() => ordered
          ? { orderBy: vi.fn().mockResolvedValue(rows) }
          : Promise.resolve(rows)),
      })),
    })),
  });

  vi.mocked(db.select)
    .mockReturnValueOnce(whereOnly([{ count: 1 }]) as never)
    .mockReturnValueOnce(grouped([{ status: 'online', count: 1 }]) as never)
    .mockReturnValueOnce(grouped([{ osType: 'linux', count: 1 }]) as never)
    .mockReturnValueOnce(grouped([{ version: '1.0.0', count: 1 }], true) as never)
    .mockReturnValueOnce(whereOnly([{ count: 0 }]) as never);
}

describe('GET /reports/data/compliance site scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allowedSiteIds = [SITE_A];
  });

  it('rejects an explicitly denied sibling site before aggregate queries', async () => {
    const res = await buildApp().request(`/reports/data/compliance?siteId=${SITE_B}`);

    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('allows an explicitly authorized site', async () => {
    mockComplianceQueries();

    const res = await buildApp().request(`/reports/data/compliance?siteId=${SITE_A}`);

    expect(res.status).toBe(200);
    expect(db.select).toHaveBeenCalledTimes(5);
  });

  it('fails closed without queries when the caller has an empty site allowlist', async () => {
    allowedSiteIds = [];

    const res = await buildApp().request('/reports/data/compliance');

    expect(res.status).toBe(200);
    expect(db.select).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({
      data: { overview: {}, byOsType: [], agentVersions: [], issues: [] },
    });
  });
});
