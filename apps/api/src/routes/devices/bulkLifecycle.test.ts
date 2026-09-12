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

/**
 * Mutable so a test can be a PARTNER-scope caller. It was hardcoded to
 * `scope: 'organization'`, which made the original "denies another partner's
 * run" test assert nothing: the partner branch it named was unreachable, and
 * the test passed on the org branch instead.
 */
const authState = vi.hoisted(() => ({
  scope: 'organization' as 'organization' | 'partner' | 'system',
  partnerId: 'partner-1' as string | null,
  accessibleOrgIds: ['11111111-1111-4111-8111-111111111111'] as string[],
  allowedSiteIds: undefined as string[] | undefined,
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'tech@example.com' },
      scope: authState.scope,
      orgId: authState.scope === 'organization' ? ORG_A : null,
      partnerId: authState.partnerId,
      accessibleOrgIds: authState.accessibleOrgIds,
      allowedSiteIds: authState.allowedSiteIds,
      canAccessOrg: (orgId: string) => authState.accessibleOrgIds.includes(orgId),
      token: { mfa: true },
    });
    c.set('permissions', { allowedSiteIds: null, scope: authState.scope, orgId: ORG_A });
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

vi.mock('../../jobs/deviceBulkPurge', () => ({
  enqueueDeviceBulkPurge: vi.fn(async () => ({ id: 'job' })),
  deviceBulkPurgeJobId: vi.fn((jobId: string) => `device-bulk-purge-v2-${jobId}`),
  getDeviceBulkPurgeQueue: vi.fn(),
}));

vi.mock('./helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./helpers')>()),
  getDeviceWithOrgAndSiteCheck: vi.fn(),
  getDevicesWithOrgAndSiteCheck: vi.fn(),
}));

import { bulkLifecycleRoutes } from './bulkLifecycle';
import { restoreRemovedDevice, DeviceLifecycleError } from '../../services/deviceLifecycle';
import {
  getDeviceWithOrgAndSiteCheck,
  getDevicesWithOrgAndSiteCheck,
  SITE_ACCESS_DENIED,
} from './helpers';
import { runOutsideDbContext, withDbAccessContext } from '../../db';
import { writeRouteAudit } from '../../services/auditEvents';
import { enqueueDeviceBulkPurge, getDeviceBulkPurgeQueue } from '../../jobs/deviceBulkPurge';

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
  authState.scope = 'organization';
  authState.partnerId = 'partner-1';
  authState.accessibleOrgIds = [ORG_A];
  authState.allowedSiteIds = undefined;
  // The batched lookup is what POST /bulk/permanent-delete calls. Route tests
  // script `getDeviceWithOrgAndSiteCheck` (used by bulk restore), so mirror its
  // verdicts here rather than making every test rig two mocks.
  vi.mocked(getDevicesWithOrgAndSiteCheck).mockImplementation(async (ctx, deviceIds, a) => {
    const out = new Map<string, unknown>();
    for (const id of deviceIds) {
      out.set(id, await vi.mocked(getDeviceWithOrgAndSiteCheck)(ctx, id, a));
    }
    return out as never;
  });
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

describe('POST /devices/bulk/permanent-delete', () => {
  it('pre-rejects a non-removed device and enqueues only the removed ones', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockImplementation(async (_c, id) =>
      accessibleDevice(id as string, id === DEV_2 ? { status: 'online' } : {}),
    );

    const res = await post(app, '/devices/bulk/permanent-delete', { deviceIds: [DEV_1, DEV_2] });

    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      jobId: string;
      accepted: number;
      rejected: Array<{ deviceId: string; code: string }>;
    };
    expect(body.accepted).toBe(1);
    expect(body.rejected).toEqual([
      {
        deviceId: DEV_2,
        code: 'NOT_REMOVED',
        message: 'Device must be removed before permanent deletion',
      },
    ]);
    expect(body.jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // ONE batched lookup, not one round-trip per device (#2787 review minor).
    expect(getDevicesWithOrgAndSiteCheck).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getDevicesWithOrgAndSiteCheck).mock.calls[0]![1]).toEqual([DEV_1, DEV_2]);

    expect(enqueueDeviceBulkPurge).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(enqueueDeviceBulkPurge).mock.calls[0]![0];
    expect(sent.targets).toHaveLength(1);
    expect(sent.targets[0]).toMatchObject({ deviceId: DEV_1, orgId: ORG_A });
    // The status route denies another partner's run; the job payload is the
    // only place that ownership is recorded.
    expect(sent.partnerId).toBe('partner-1');
    expect(sent.authorization).toEqual({
      version: 1,
      siteAccess: { mode: 'unrestricted' },
    });
    expect(sent.jobId).toBe(body.jobId);
  });

  it('returns 409 and enqueues nothing when every selected device is rejected', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(null);

    const res = await post(app, '/devices/bulk/permanent-delete', { deviceIds: [DEV_1, DEV_2] });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; rejected: Array<{ code: string }> };
    expect(body.rejected.map((r) => r.code)).toEqual(['NOT_FOUND', 'NOT_FOUND']);
    // A job with zero targets would report "completed, 0 purged" and read to
    // the operator as though the delete had run.
    expect(enqueueDeviceBulkPurge).not.toHaveBeenCalled();
  });

  /**
   * A pending uninstall is deliberately NOT pre-checked here. The worker
   * refuses it under the devices row lock, keeping ONE source of truth for the
   * rule — a second copy in the route would be the thing that drifts, and it
   * would be checking a fact that can change between enqueue and execution
   * anyway.
   */
  it('does not pre-check the pending uninstall — the worker owns that refusal', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockImplementation(async (_c, id) =>
      accessibleDevice(id as string),
    );

    const res = await post(app, '/devices/bulk/permanent-delete', { deviceIds: [DEV_1] });

    expect(res.status).toBe(202);
    expect((await res.json()).accepted).toBe(1);
  });

  it('rejects more than 500 ids with 400', async () => {
    const ids = Array.from(
      { length: 501 },
      (_v, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const res = await post(app, '/devices/bulk/permanent-delete', { deviceIds: ids });
    expect(res.status).toBe(400);
    expect(enqueueDeviceBulkPurge).not.toHaveBeenCalled();
  });

  /**
   * The site allowlist has to survive the switch to a batched lookup — a batch
   * that dropped it would hand a site-scoped tech devices from sites they
   * cannot see, and the enqueue is a permanent delete.
   */
  it('rejects a device outside the caller site allowlist and enqueues only the rest', async () => {
    authState.scope = 'organization';
    vi.mocked(getDevicesWithOrgAndSiteCheck).mockResolvedValue(
      new Map<string, unknown>([
        [DEV_1, accessibleDevice(DEV_1)],
        [DEV_2, SITE_ACCESS_DENIED],
      ]) as never,
    );

    const res = await post(app, '/devices/bulk/permanent-delete', { deviceIds: [DEV_1, DEV_2] });

    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      accepted: number;
      rejected: Array<{ deviceId: string; code: string }>;
    };
    expect(body.accepted).toBe(1);
    expect(body.rejected).toEqual([
      { deviceId: DEV_2, code: 'SITE_ACCESS_DENIED', message: 'Access to this site denied' },
    ]);
    expect(vi.mocked(enqueueDeviceBulkPurge).mock.calls[0]![0].targets.map(t => t.deviceId))
      .toEqual([DEV_1]);
  });

  it('serializes the request-time site ceiling for the system-scoped worker', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(accessibleDevice(DEV_1));
    // AuthContext carries this independently of the permissions test double;
    // production auth derives both from the same live role assignment.
    authState.allowedSiteIds = ['site-1'];

    const res = await post(app, '/devices/bulk/permanent-delete', { deviceIds: [DEV_1] });

    expect(res.status).toBe(202);
    expect(vi.mocked(enqueueDeviceBulkPurge).mock.calls[0]![0].authorization).toEqual({
      version: 1,
      siteAccess: { mode: 'restricted', allowedSiteIds: ['site-1'] },
    });
  });
});

describe('GET /devices/bulk/purge-runs/:jobId', () => {
  const JOB_ID = '55555555-5555-4555-8555-555555555555';

  function rigJob(job: unknown) {
    vi.mocked(getDeviceBulkPurgeQueue).mockReturnValue({
      getJob: vi.fn(async () => job),
    } as never);
  }

  function get(path: string) {
    return app.request(path, { headers: { Authorization: 'Bearer t' } });
  }

  it('returns state, progress and result to the owner', async () => {
    rigJob({
      data: {
        partnerId: 'partner-1',
        targets: [{ deviceId: DEV_1, orgId: ORG_A, hostname: 'host-1' }],
      },
      getState: async () => 'completed',
      progress: { done: 1, total: 1 },
      returnvalue: { purged: [DEV_1], skipped: [] },
      failedReason: null,
    });

    const res = await get(`/devices/bulk/purge-runs/${JOB_ID}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      state: 'completed',
      progress: { done: 1, total: 1 },
      result: { purged: [DEV_1], skipped: [] },
      failedReason: null,
    });
    expect(vi.mocked(getDeviceBulkPurgeQueue).mock.results[0]!.value.getJob).toHaveBeenCalledWith(
      `device-bulk-purge-v2-${JOB_ID}`,
    );
  });

  it('falls back to a zero-done progress before the worker has reported any', async () => {
    rigJob({
      data: {
        partnerId: 'partner-1',
        targets: [
          { deviceId: DEV_1, orgId: ORG_A, hostname: 'h1' },
          { deviceId: DEV_2, orgId: ORG_A, hostname: 'h2' },
        ],
      },
      getState: async () => 'waiting',
      // BullMQ's initial progress is the number 0, not an object — reporting
      // that raw would render "0 of undefined" in the UI.
      progress: 0,
      returnvalue: null,
      failedReason: null,
    });

    const res = await get(`/devices/bulk/purge-runs/${JOB_ID}`);
    expect(await res.json()).toMatchObject({ state: 'waiting', progress: { done: 0, total: 2 } });
  });

  it('returns 404 for an unknown job', async () => {
    rigJob(null);
    const res = await get(`/devices/bulk/purge-runs/${JOB_ID}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for an org-scope caller whose accessible orgs do not cover the run', async () => {
    // jobId is a UUID the caller was handed, not a secret, so ownership has to
    // be re-derived here — BullMQ enforces nothing (mirrors routes/orgMerge.ts).
    rigJob({
      data: {
        partnerId: 'partner-1',
        targets: [{ deviceId: DEV_1, orgId: 'someone-elses-org', hostname: 'h1' }],
      },
      getState: async () => 'active',
      progress: { done: 0, total: 1 },
      returnvalue: null,
      failedReason: null,
    });

    const res = await get(`/devices/bulk/purge-runs/${JOB_ID}`);
    expect(res.status).toBe(404);
    // Reported as "not found", never "forbidden": a cross-tenant probe must
    // not learn that the run exists.
    expect(await res.json()).toEqual({ error: 'Purge run not found' });
  });

  it("returns 404 for a partner-scope caller reading another partner's run", async () => {
    authState.scope = 'partner';
    authState.partnerId = 'partner-mine';
    authState.accessibleOrgIds = [ORG_A];
    rigJob({
      data: {
        partnerId: 'partner-theirs',
        targets: [{ deviceId: DEV_1, orgId: ORG_A, hostname: 'h1' }],
      },
      getState: async () => 'active',
      progress: { done: 0, total: 1 },
      returnvalue: null,
      failedReason: null,
    });

    const res = await get(`/devices/bulk/purge-runs/${JOB_ID}`);
    expect(res.status).toBe(404);
  });

  /**
   * The gap partnerId-equality alone leaves open. A partner member with
   * `org_access = 'selected'` shares the partner id with every org under it,
   * so the partner arm passes — but their selection may exclude the orgs this
   * run touched. For the same reason, routes/orgMerge.ts adds its own fresh
   * raw partner-member selection check.
   */
  it('returns 404 for a partner-scope caller whose org selection excludes a target org', async () => {
    authState.scope = 'partner';
    authState.partnerId = 'partner-1';
    authState.accessibleOrgIds = [ORG_A]; // selection does NOT include ORG_B
    rigJob({
      data: {
        partnerId: 'partner-1', // same partner — the partnerId arm passes
        targets: [
          { deviceId: DEV_1, orgId: ORG_A, hostname: 'h1' },
          { deviceId: DEV_2, orgId: 'org-b-outside-selection', hostname: 'h2' },
        ],
      },
      getState: async () => 'active',
      progress: { done: 0, total: 2 },
      returnvalue: null,
      failedReason: null,
    });

    const res = await get(`/devices/bulk/purge-runs/${JOB_ID}`);
    expect(res.status).toBe(404);
  });

  it('lets a partner-scope caller read their own run when the selection covers every target org', async () => {
    // The positive control: without it, the two denials above would pass
    // against a route that 404s unconditionally.
    authState.scope = 'partner';
    authState.partnerId = 'partner-1';
    authState.accessibleOrgIds = [ORG_A];
    rigJob({
      data: {
        partnerId: 'partner-1',
        targets: [{ deviceId: DEV_1, orgId: ORG_A, hostname: 'h1' }],
      },
      getState: async () => 'completed',
      progress: { done: 1, total: 1 },
      returnvalue: { purged: [DEV_1], skipped: [] },
      failedReason: null,
    });

    const res = await get(`/devices/bulk/purge-runs/${JOB_ID}`);
    expect(res.status).toBe(200);
  });

  /**
   * FAIL CLOSED on an unreadable payload. The org branch used to be guarded by
   * `&& payload &&`, so a job whose `data` was absent (an evicted/roundtripped
   * record, or a payload shape change) SKIPPED the tenancy check entirely and
   * returned the run to any caller — while the partner branch failed closed on
   * the same input. An unverifiable owner is not an authorised one.
   */
  it('returns 404 when the job payload is missing, rather than skipping the check', async () => {
    rigJob({
      data: undefined,
      getState: async () => 'active',
      progress: { done: 0, total: 0 },
      returnvalue: null,
      failedReason: null,
    });

    const res = await get(`/devices/bulk/purge-runs/${JOB_ID}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Purge run not found' });
  });

  it('still serves a system-scope caller a run with no readable payload', async () => {
    // System scope already spans every partner and org, so it is the one caller
    // for whom "cannot verify ownership" is not a denial.
    authState.scope = 'system';
    authState.partnerId = null;
    rigJob({
      data: undefined,
      getState: async () => 'active',
      progress: { done: 0, total: 0 },
      returnvalue: null,
      failedReason: null,
    });

    const res = await get(`/devices/bulk/purge-runs/${JOB_ID}`);
    expect(res.status).toBe(200);
  });

  it('surfaces failedReason for a failed run', async () => {
    rigJob({
      data: { partnerId: 'partner-1', targets: [{ deviceId: DEV_1, orgId: ORG_A, hostname: 'h1' }] },
      getState: async () => 'failed',
      progress: { done: 0, total: 1 },
      returnvalue: null,
      failedReason: 'Redis went away',
    });

    const res = await get(`/devices/bulk/purge-runs/${JOB_ID}`);
    expect(await res.json()).toMatchObject({ state: 'failed', failedReason: 'Redis went away' });
  });
});
