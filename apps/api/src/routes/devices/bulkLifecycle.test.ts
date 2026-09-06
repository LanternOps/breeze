import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const DEV_1 = '22222222-2222-4222-8222-222222222222';
const DEV_2 = '33333333-3333-4333-8333-333333333333';
const DEV_3 = '44444444-4444-4444-8444-444444444444';

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
    // Each item opens its own short transaction inside runBulkIsolated's
    // per-item context; the service under test is mocked, so the callback's
    // argument is only an opaque handle here.
    transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({ __tx: true })),
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'tech@example.com' },
      scope: 'organization',
      orgId: ORG_A,
      partnerId: 'partner-1',
      accessibleOrgIds: [ORG_A],
      canAccessOrg: (orgId: string) => orgId === ORG_A,
      token: { mfa: true },
    });
    c.set('permissions', { allowedSiteIds: null, scope: 'organization', orgId: ORG_A });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  dbAccessContextFromAuth: vi.fn(() => ({
    scope: 'organization',
    orgId: ORG_A,
    accessibleOrgIds: [ORG_A],
    accessiblePartnerIds: null,
    userId: 'user-1',
  })),
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

vi.mock('../../services/deviceLifecycle', () => ({
  restoreRemovedDevice: vi.fn(),
  purgeRemovedDevice: vi.fn(),
  DeviceLifecycleError: class DeviceLifecycleError extends Error {
    constructor(public code: string, message: string) {
      super(message);
      this.name = 'DeviceLifecycleError';
    }
    get status() {
      return this.code === 'NOT_FOUND' ? 404 : 409;
    }
  },
}));

vi.mock('./helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./helpers')>()),
  getDeviceWithOrgAndSiteCheck: vi.fn(),
}));

import { bulkLifecycleRoutes } from './bulkLifecycle';
import { restoreRemovedDevice, DeviceLifecycleError } from '../../services/deviceLifecycle';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
import { runOutsideDbContext, withDbAccessContext } from '../../db';
import { writeRouteAudit } from '../../services/auditEvents';

function accessibleDevice(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    orgId: ORG_A,
    siteId: 'site-1',
    hostname: `host-${id.slice(0, 4)}`,
    displayName: null,
    status: 'decommissioned',
    linkGroupId: null,
    ...overrides,
  } as never;
}

function post(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let app: Hono;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runOutsideDbContext).mockImplementation(((fn: () => unknown) => fn()) as never);
  vi.mocked(withDbAccessContext).mockImplementation((async (
    _ctx: unknown,
    fn: () => Promise<unknown>,
  ) => fn()) as never);
  app = new Hono();
  app.route('/devices', bulkLifecycleRoutes);
});

describe('POST /devices/bulk/restore', () => {
  it('restores every accessible removed device and reports per-device outcomes', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockImplementation(async (_c, id) => {
      if (id === DEV_3) return null;
      return accessibleDevice(id as string);
    });
    vi.mocked(restoreRemovedDevice).mockImplementation(async (_tx, id) => {
      if (id === DEV_2) {
        throw new DeviceLifecycleError('NOT_REMOVED', 'Device is not removed');
      }
      return { device: accessibleDevice(id) as never, uninstallAlreadyDispatched: false };
    });

    const res = await post(app, '/devices/bulk/restore', { deviceIds: [DEV_1, DEV_2, DEV_3] });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      succeeded: Array<{ deviceId: string; uninstallAlreadyDispatched: boolean }>;
      failed: Array<{ deviceId: string; code: string }>;
    };
    // One item failing must not abort the batch — that is the whole reason
    // each device runs in its own transaction.
    expect(body.succeeded).toEqual([{ deviceId: DEV_1, uninstallAlreadyDispatched: false }]);
    expect(body.failed).toEqual([
      { deviceId: DEV_2, code: 'NOT_REMOVED', message: 'Device is not removed' },
      { deviceId: DEV_3, code: 'NOT_FOUND', message: 'Device not found' },
    ]);
  });

  it('reports SITE_ACCESS_DENIED separately from NOT_FOUND', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SITE_ACCESS_DENIED as never);

    const res = await post(app, '/devices/bulk/restore', { deviceIds: [DEV_1] });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { failed: Array<{ code: string }> };
    expect(body.failed).toEqual([
      { deviceId: DEV_1, code: 'SITE_ACCESS_DENIED', message: 'Access to this site denied' },
    ]);
    expect(restoreRemovedDevice).not.toHaveBeenCalled();
  });

  it('surfaces uninstallAlreadyDispatched so the caller can warn about a machine already wiped', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockImplementation(async (_c, id) =>
      accessibleDevice(id as string),
    );
    vi.mocked(restoreRemovedDevice).mockResolvedValue({
      device: accessibleDevice(DEV_1) as never,
      uninstallAlreadyDispatched: true,
    });

    const res = await post(app, '/devices/bulk/restore', { deviceIds: [DEV_1] });
    const body = (await res.json()) as { succeeded: Array<{ uninstallAlreadyDispatched: boolean }> };
    expect(body.succeeded[0]!.uninstallAlreadyDispatched).toBe(true);
    expect(writeRouteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'device.restore',
        resourceId: DEV_1,
        details: expect.objectContaining({ uninstallAlreadyDispatched: true, bulk: true }),
      }),
    );
  });

  it('rejects more than 500 ids with 400', async () => {
    const ids = Array.from(
      { length: 501 },
      (_v, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const res = await post(app, '/devices/bulk/restore', { deviceIds: ids });
    expect(res.status).toBe(400);
    expect(getDeviceWithOrgAndSiteCheck).not.toHaveBeenCalled();
  });

  it('rejects an empty selection with 400', async () => {
    const res = await post(app, '/devices/bulk/restore', { deviceIds: [] });
    expect(res.status).toBe(400);
  });

  it('dedupes repeated ids so one device is never restored twice', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockImplementation(async (_c, id) =>
      accessibleDevice(id as string),
    );
    vi.mocked(restoreRemovedDevice).mockResolvedValue({
      device: accessibleDevice(DEV_1) as never,
      uninstallAlreadyDispatched: false,
    });

    const res = await post(app, '/devices/bulk/restore', { deviceIds: [DEV_1, DEV_1] });

    expect(res.status).toBe(200);
    expect(restoreRemovedDevice).toHaveBeenCalledTimes(1);
  });

  /**
   * Pins the route to `runBulkIsolated` rather than a bare loop on the request
   * transaction. Holding the ambient tx across up to 500 restores pins one
   * pooled connection — and every devices/device_commands row lock it takes —
   * until the last item finishes (#1105). The route is registered in
   * `middleware/selfManagedDbContextRoutes.ts` so no ambient tx exists to hold.
   */
  it('runs each item in its own short RLS transaction, outside the request context', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockImplementation(async (_c, id) =>
      accessibleDevice(id as string),
    );
    vi.mocked(restoreRemovedDevice).mockResolvedValue({
      device: accessibleDevice(DEV_1) as never,
      uninstallAlreadyDispatched: false,
    });

    await post(app, '/devices/bulk/restore', { deviceIds: [DEV_1, DEV_2] });

    expect(runOutsideDbContext).toHaveBeenCalledTimes(1);
    expect(withDbAccessContext).toHaveBeenCalledTimes(2);
  });

  it('keeps an unexpected per-device error from aborting the batch', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockImplementation(async (_c, id) =>
        accessibleDevice(id as string),
      );
      vi.mocked(restoreRemovedDevice).mockImplementation(async (_tx, id) => {
        if (id === DEV_1) throw new Error('connection terminated');
        return { device: accessibleDevice(id) as never, uninstallAlreadyDispatched: false };
      });

      const res = await post(app, '/devices/bulk/restore', { deviceIds: [DEV_1, DEV_2] });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        succeeded: Array<{ deviceId: string }>;
        failed: Array<{ deviceId: string; code: string }>;
      };
      expect(body.succeeded).toEqual([{ deviceId: DEV_2, uninstallAlreadyDispatched: false }]);
      expect(body.failed).toEqual([
        { deviceId: DEV_1, code: 'ERROR', message: 'Restore failed' },
      ]);
    } finally {
      consoleError.mockRestore();
    }
  });
});
