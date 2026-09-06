import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { siteDenied } = vi.hoisted(() => ({
  siteDenied: Symbol('SITE_ACCESS_DENIED'),
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123' },
      scope: 'organization',
      orgId: 'org-123',
      canAccessOrg: (orgId: string) => orgId === 'org-123',
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    c.set('permissions', {
      permissions: [{ resource: 'devices', action: 'execute' }],
      allowedSiteIds: c.req.header('x-site-restricted') === 'true' ? ['site-allowed'] : undefined,
    });
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgAndSiteCheck: vi.fn(),
  SITE_ACCESS_DENIED: siteDenied,
}));

vi.mock('../../services/commandQueue', () => ({
  executeCommand: vi.fn(),
}));

import { db } from '../../db';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
import { executeCommand } from '../../services/commandQueue';
import { diagnoseRoutes } from './diagnose';

/** Fluent mock for db.select(...).from(t).where(...)[.orderBy(...)].limit(n) */
function mockSelectChain(result: unknown) {
  const terminal = { limit: vi.fn().mockResolvedValue(result) };
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ orderBy: vi.fn().mockReturnValue(terminal), ...terminal }),
    }),
  } as any;
}

const DEVICE_ID = '11111111-2222-4333-8444-555555555555';

/**
 * A device_metrics row as Drizzle actually returns it: the throughput columns
 * are `bigint(..., { mode: 'bigint' })`, so they arrive as native BigInt.
 */
function metricsRow(capturedAt: string) {
  return {
    timestamp: new Date(capturedAt),
    cpuPercent: 12.5,
    ramPercent: 48.25,
    ramUsedMb: 7900,
    diskPercent: 61.5,
    diskUsedGb: 310.25,
    diskActivityAvailable: true,
    processCount: 312,
    diskReadBps: 2048n,
    diskWriteBps: 4096n,
    bandwidthInBps: 1200n,
    bandwidthOutBps: 900n,
  };
}

describe('device diagnose route', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', diagnoseRoutes);
  });

  it('denies diagnose when site scope excludes the device', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SITE_ACCESS_DENIED as never);

    const res = await app.request('/devices/device-1/diagnose', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'x-site-restricted': 'true' },
    });

    expect(res.status).toBe(403);
    expect(executeCommand).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('serialises recent metrics whose bigint counters arrive as native BigInt', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
      id: DEVICE_ID,
      hostname: 'macbook-pro',
      osType: 'darwin',
      osVersion: '15.3',
      status: 'online',
    } as never);
    vi.mocked(executeCommand).mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({
        imageBase64: 'zXNlZw==',
        width: 1920,
        height: 1080,
        capturedAt: '2026-09-05T12:00:00.000Z',
      }),
    } as never);
    vi.mocked(db.select)
      .mockReturnValueOnce(mockSelectChain([{ cpuModel: 'Apple M3', cpuCores: 8 }]))
      .mockReturnValueOnce(mockSelectChain([
        metricsRow('2026-09-05T12:00:00.000Z'),
        metricsRow('2026-09-05T11:55:00.000Z'),
      ]))
      .mockReturnValueOnce(mockSelectChain([]));

    const res = await app.request(`/devices/${DEVICE_ID}/diagnose`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.screenshot.imageBase64).toBe('zXNlZw==');
    expect(body.recentMetrics).toHaveLength(2);
    expect(body.recentMetrics[0]).toMatchObject({
      cpuPercent: 12.5,
      ramPercent: 48.25,
      diskPercent: 61.5,
      diskReadBps: 2048,
      diskWriteBps: 4096,
      bandwidthInBps: 1200,
      bandwidthOutBps: 900,
    });

    for (const metric of body.recentMetrics) {
      for (const [field, value] of Object.entries(metric)) {
        expect(typeof value, `${field} must not reach the response as BigInt`).not.toBe('bigint');
      }
    }
  });

  it('tolerates null throughput counters', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
      id: DEVICE_ID,
      hostname: 'macbook-pro',
      osType: 'darwin',
      osVersion: '15.3',
      status: 'online',
    } as never);
    vi.mocked(executeCommand).mockResolvedValue({ status: 'completed', stdout: '{}' } as never);
    vi.mocked(db.select)
      .mockReturnValueOnce(mockSelectChain([]))
      .mockReturnValueOnce(mockSelectChain([{
        ...metricsRow('2026-09-05T12:00:00.000Z'),
        diskActivityAvailable: null,
        diskReadBps: null,
        diskWriteBps: null,
        bandwidthInBps: null,
        bandwidthOutBps: null,
      }]))
      .mockReturnValueOnce(mockSelectChain([]));

    const res = await app.request(`/devices/${DEVICE_ID}/diagnose`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hardware).toBeNull();
    expect(body.recentMetrics[0]).toMatchObject({
      diskReadBps: null,
      diskWriteBps: null,
      bandwidthInBps: null,
      bandwidthOutBps: null,
    });
  });
});
