import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const SITE_ID = '44444444-4444-4444-8444-444444444444';

let allowedSiteIds: string[] | undefined;

vi.mock('../../db', () => {
  const createChain = (result: unknown = []) => {
    const chain: Record<string, any> = {};
    for (const method of ['from', 'where', 'groupBy', 'orderBy', 'limit']) {
      chain[method] = vi.fn(() => chain);
    }
    chain.then = (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected);
    return chain;
  };

  return {
    db: {
      select: vi.fn(() => createChain([])),
    },
  };
});

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'organization',
      orgId: '11111111-1111-4111-8111-111111111111',
      partnerId: null,
      accessibleOrgIds: ['11111111-1111-4111-8111-111111111111'],
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-4111-8111-111111111111',
      user: { id: '22222222-2222-4222-8222-222222222222', email: 'test@example.com' },
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    c.set('permissions', {
      permissions: [{ resource: 'devices', action: 'read' }],
      orgId: '11111111-1111-4111-8111-111111111111',
      roleId: 'role-1',
      scope: 'organization',
      ...(allowedSiteIds ? { allowedSiteIds } : {}),
    });
    return next();
  }),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
  },
  canAccessSite: (permissions: { allowedSiteIds?: string[] } | undefined, siteId: string) =>
    !permissions?.allowedSiteIds || permissions.allowedSiteIds.includes(siteId),
}));

import { db } from '../../db';
import { metricsRoutes } from './metrics';

function createChain(result: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'groupBy', 'orderBy', 'limit']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return chain;
}

function mockSelectOnce(result: unknown) {
  vi.mocked(db.select).mockImplementationOnce(() => createChain(result) as never);
}

const DEVICE = {
  id: DEVICE_ID,
  orgId: ORG_ID,
  siteId: SITE_ID,
  hostname: 'host-1',
  osType: 'linux',
  status: 'online',
};

const SITE = {
  timezone: 'America/Denver',
};

function rawMetricBucket(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    bucket: new Date('2026-06-18T12:00:00.000Z'),
    avgCpuPercent: 11.125,
    avgRamPercent: 22.25,
    avgRamUsedMb: 1024,
    avgDiskPercent: 33.375,
    avgDiskUsedGb: 44.5,
    diskActivityAvailable: true,
    totalDiskReadBytes: 1000n,
    totalDiskWriteBytes: 2000n,
    avgDiskReadBps: 300,
    avgDiskWriteBps: 400,
    totalDiskReadOps: 5n,
    totalDiskWriteOps: 6n,
    totalNetworkIn: 7000n,
    totalNetworkOut: 8000n,
    avgBandwidthIn: 900,
    avgBandwidthOut: 1000,
    avgProcessCount: 101,
    ...overrides,
  };
}

describe('device metrics route', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    allowedSiteIds = undefined;
    app = new Hono();
    app.route('/devices', metricsRoutes);
  });

  it('uses hourly metric rollups for long-range device history when available', async () => {
    mockSelectOnce([DEVICE]);
    mockSelectOnce([SITE]);
    mockSelectOnce([rawMetricBucket({
      avgCpuPercent: 42.678,
      totalDiskReadBytes: 0n,
      totalDiskWriteBytes: 0n,
      totalDiskReadOps: 0n,
      totalDiskWriteOps: 0n,
      totalNetworkIn: 0n,
      totalNetworkOut: 0n,
    })]);

    const res = await app.request(
      `/devices/${DEVICE_ID}/metrics?range=7d&endDate=2026-06-19T00:00:00.000Z`,
      { method: 'GET', headers: { Authorization: 'Bearer t' } }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.interval).toBe('1h');
    expect(body.timezone).toBe('America/Denver');
    expect(body.data).toEqual([
      {
        timestamp: '2026-06-18T12:00:00.000Z',
        cpu: 42.68,
        ram: 22.25,
        ramUsedMb: 1024,
        disk: 33.38,
        diskUsedGb: 44.5,
        diskActivityAvailable: true,
        diskReadBytes: 0,
        diskWriteBytes: 0,
        diskReadBps: 300,
        diskWriteBps: 400,
        diskReadOps: 0,
        diskWriteOps: 0,
        networkIn: 0,
        networkOut: 0,
        bandwidthInBps: 900,
        bandwidthOutBps: 1000,
        processCount: 101,
      },
    ]);
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(3);
  });

  it('falls back to raw device metrics when requested rollups are empty', async () => {
    mockSelectOnce([DEVICE]);
    mockSelectOnce([SITE]);
    mockSelectOnce([]);
    mockSelectOnce([rawMetricBucket()]);

    const res = await app.request(
      `/devices/${DEVICE_ID}/metrics?range=7d&endDate=2026-06-19T00:00:00.000Z`,
      { method: 'GET', headers: { Authorization: 'Bearer t' } }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0]).toMatchObject({
      timestamp: '2026-06-18T12:00:00.000Z',
      cpu: 11.13,
      diskReadBytes: 1000,
      networkIn: 7000,
    });
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(4);
  });

  it('keeps one-minute requests on raw metrics', async () => {
    mockSelectOnce([DEVICE]);
    mockSelectOnce([SITE]);
    mockSelectOnce([rawMetricBucket()]);

    const res = await app.request(
      `/devices/${DEVICE_ID}/metrics?interval=1m&startDate=2026-06-18T00:00:00.000Z&endDate=2026-06-19T00:00:00.000Z`,
      { method: 'GET', headers: { Authorization: 'Bearer t' } }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.interval).toBe('1m');
    expect(body.data[0].diskReadBytes).toBe(1000);
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(3);
  });

  it('does not query metrics when site scope denies the device', async () => {
    allowedSiteIds = ['55555555-5555-4555-8555-555555555555'];
    mockSelectOnce([DEVICE]);

    const res = await app.request(`/devices/${DEVICE_ID}/metrics?range=7d`, {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Access to this site denied' });
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
  });
});
