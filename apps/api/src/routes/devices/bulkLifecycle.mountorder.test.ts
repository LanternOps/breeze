import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

// Mount-order regression guard for the bulk-lifecycle routes (#2787), modeled
// on links.mountorder.test.ts (#2138).
//
// bulkLifecycleRoutes MUST be mounted in devices/index.ts BEFORE coreRoutes.
// Every one of its paths starts with the static segment `bulk`, which core's
// `/:id` matcher would otherwise eat:
//
//   POST   /devices/bulk/restore          <- core's POST /:id/restore
//   POST   /devices/bulk/permanent-delete
//   GET    /devices/bulk/purge-runs/:jobId
//
// "bulk" is not a uuid, so `getDeviceWithOrgAndSiteCheck` returns null and the
// operator gets "Device not found" — the entire bulk surface dies while the
// isolated bulkLifecycle.test.ts stays green, because that file mounts the
// sub-router on its own. This test exercises the FULLY-ASSEMBLED deviceRoutes.

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_A_DEVICE = '22222222-2222-4222-8222-222222222222';

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/schema')>();
  return { ...actual };
});

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: vi.fn((c: any, next: any) => {
      const header = c.req.header('Authorization');
      if (!header?.startsWith('Bearer ')) {
        throw new HTTPException(401, { message: 'Missing or invalid authorization header' });
      }
      c.set('auth', {
        user: { id: 'user-1', email: 't@example.com' },
        scope: 'organization',
        orgId: ORG_A,
        partnerId: null,
        accessibleOrgIds: [ORG_A],
        canAccessOrg: (orgId: string) => orgId === ORG_A,
        canAccessSite: () => true,
        orgCondition: () => undefined,
      });
      return next();
    }),
    requireScope: vi.fn(() => async (_c: any, next: any) => next()),
    requirePermission: vi.fn(() => async (c: any, next: any) => {
      c.set('permissions', { permissions: [], orgId: ORG_A, scope: 'organization' });
      return next();
    }),
    requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  };
});

vi.mock('../../middleware/apiKeyAuth', () => ({
  apiKeyAuthMiddleware: vi.fn((_c: any, next: any) => next()),
  requireApiKeyScope: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../services/auditService', () => ({
  createAuditLog: vi.fn().mockResolvedValue(undefined),
}));

// Heavy modules imported by the assembled router at module load.
vi.mock('../../services/auditEvents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/auditEvents')>();
  return { ...actual, writeRouteAudit: vi.fn(), writeAuditEvent: vi.fn() };
});
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../services/remoteAccessPolicy', () => ({
  resolveRemoteAccessForDevice: vi.fn().mockResolvedValue({ policyId: null, settings: {} }),
}));
vi.mock('../../services/remoteAccessLauncher', () => ({
  resolveRemoteAccessLaunch: vi.fn().mockReturnValue({ launchUrl: null, skipReason: 'no_provider_configured' }),
}));
vi.mock('../agentWs', () => ({
  sendCommandToAgent: vi.fn(),
  isAgentConnected: vi.fn().mockReturnValue(false),
}));
vi.mock('../../services/commandQueue', () => ({
  CommandTypes: { SELF_UNINSTALL: 'self_uninstall' },
  queueCommandForExecution: vi.fn(),
}));
vi.mock('../agents/enrollment', () => ({
  getGlobalEnrollmentSecret: vi.fn().mockReturnValue(null),
}));

// The bulk routes' real collaborators. The point of this file is ROUTING, so
// everything past the handler entry is stubbed — reaching the handler at all
// is the assertion.
vi.mock('../../jobs/deviceBulkPurge', () => ({
  enqueueDeviceBulkPurge: vi.fn(async () => ({ id: 'device-bulk-purge-job' })),
  getDeviceBulkPurgeQueue: vi.fn(() => ({ getJob: vi.fn(async () => null) })),
}));

vi.mock('../../services/deviceLifecycle', () => ({
  restoreRemovedDevice: vi.fn(async () => ({
    device: { id: ORG_A_DEVICE, hostname: 'host-1' },
    uninstallAlreadyDispatched: false,
  })),
  purgeRemovedDevice: vi.fn(),
  DeviceLifecycleError: class DeviceLifecycleError extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
    get status() {
      return this.code === 'NOT_FOUND' ? 404 : 409;
    }
  },
}));

import { deviceRoutes } from './index';
import { db } from '../../db';

/** A drizzle-select chain (.from().where()...) resolving to `rows`. */
function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve(rows);
  chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(res, rej);
  return chain;
}

describe('bulk-lifecycle routes mount order (#2787)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', deviceRoutes);
  });

  /**
   * `getDeviceWithOrgAndSiteCheck` is what core's `/:id` handlers call. Rig it
   * to find the device so that, if core DID eat the path, the failure is a
   * routing-shaped 404 ("bulk" is not a uuid) rather than an ambiguous 500.
   */
  function rigDeviceLookup(rows: unknown[]) {
    vi.mocked(db.select).mockReturnValue(selectChain(rows) as never);
  }

  it('POST /devices/bulk/restore reaches the bulk handler, not core POST /:id/restore', async () => {
    rigDeviceLookup([
      { id: ORG_A_DEVICE, orgId: ORG_A, siteId: 'site-1', hostname: 'host-1', status: 'decommissioned' },
    ]);

    const res = await app.request('/devices/bulk/restore', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceIds: [ORG_A_DEVICE] }),
    });

    // The discriminating assertion: core's `/:id/restore` would 404 on the
    // literal id "bulk". A 400 would mean the zod validator never ran because
    // some other handler answered first.
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(400);
    expect(res.status).toBe(200);
  });

  it('POST /devices/bulk/permanent-delete reaches the bulk handler', async () => {
    rigDeviceLookup([
      { id: ORG_A_DEVICE, orgId: ORG_A, siteId: 'site-1', hostname: 'host-1', status: 'decommissioned' },
    ]);

    const res = await app.request('/devices/bulk/permanent-delete', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceIds: [ORG_A_DEVICE] }),
    });

    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(400);
    expect(res.status).toBe(202);
  });

  it('GET /devices/bulk/purge-runs/:jobId reaches the bulk handler, not core GET /:id', async () => {
    // The queue mock returns no job, so the handler's own 404 is the answer.
    // That is distinguishable from a routing miss by the BODY: core's GET /:id
    // would answer "Device not found".
    const res = await app.request('/devices/bulk/purge-runs/abc', {
      headers: { Authorization: 'Bearer test-token' },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Purge run not found' });
  });

  it('a no-credentials request is still rejected (401) through the assembled routes', async () => {
    const res = await app.request('/devices/bulk/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceIds: [ORG_A_DEVICE] }),
    });
    expect(res.status).toBe(401);
  });
});
