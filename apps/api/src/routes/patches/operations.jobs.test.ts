import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  patches: { id: 'patches.id', title: 'patches.title' },
  devicePatches: {
    deviceId: 'devicePatches.deviceId',
    patchId: 'devicePatches.patchId',
    status: 'devicePatches.status',
  },
  patchJobs: {
    id: 'patchJobs.id',
    orgId: 'patchJobs.orgId',
    policyId: 'patchJobs.policyId',
    ringId: 'patchJobs.ringId',
    configPolicyId: 'patchJobs.configPolicyId',
    name: 'patchJobs.name',
    patches: 'patchJobs.patches',
    targets: 'patchJobs.targets',
    status: 'patchJobs.status',
    scheduledAt: 'patchJobs.scheduledAt',
    startedAt: 'patchJobs.startedAt',
    completedAt: 'patchJobs.completedAt',
    devicesTotal: 'patchJobs.devicesTotal',
    devicesCompleted: 'patchJobs.devicesCompleted',
    devicesFailed: 'patchJobs.devicesFailed',
    devicesPending: 'patchJobs.devicesPending',
    devicesQueued: 'patchJobs.devicesQueued',
    createdBy: 'patchJobs.createdBy',
    createdAt: 'patchJobs.createdAt',
  },
  patchJobResults: {
    id: 'patchJobResults.id',
    jobId: 'patchJobResults.jobId',
    deviceId: 'patchJobResults.deviceId',
    patchId: 'patchJobResults.patchId',
    status: 'patchJobResults.status',
    startedAt: 'patchJobResults.startedAt',
    completedAt: 'patchJobResults.completedAt',
    exitCode: 'patchJobResults.exitCode',
    output: 'patchJobResults.output',
    errorMessage: 'patchJobResults.errorMessage',
    rebootRequired: 'patchJobResults.rebootRequired',
    rebootedAt: 'patchJobResults.rebootedAt',
    createdAt: 'patchJobResults.createdAt',
  },
  patchRollbacks: { id: 'patchRollbacks.id' },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    hostname: 'devices.hostname',
  },
  users: {
    id: 'users.id',
    name: 'users.name',
  },
}));

// Mirror prod gate semantics (see approvals.test.ts): requirePermission
// returns 403 unless the caller has exactly the granted permission.
let grantedPermission: 'devices:read' | 'devices:execute' | null = 'devices:read';
vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    const required = `${resource}:${action}`;
    if (required !== grantedPermission) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return next();
  }),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_EXECUTE: { resource: 'devices', action: 'execute' },
  },
  canAccessSite: vi.fn(() => true),
}));

vi.mock('../../services/commandQueue', () => ({ queueCommandForExecution: vi.fn() }));
vi.mock('./helpers', () => ({
  getPagination: vi.fn((query: { page?: string; limit?: string }) => ({
    page: Number(query.page ?? 1),
    limit: Number(query.limit ?? 50),
    offset: 0,
  })),
  writePatchAuditForOrgIds: vi.fn(),
}));

import { operationsRoutes } from './operations';
import { db } from '../../db';
import { canAccessSite } from '../../services/permissions';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ORG_ID = '99999999-9999-4999-8999-999999999999';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const PATCH_ID = '44444444-4444-4444-8444-444444444444';

function mountApp(auth: Record<string, unknown>, permissions?: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as any).set('auth', auth);
    if (permissions) (c as any).set('permissions', permissions);
    await next();
  });
  app.route('/patches', operationsRoutes);
  return app;
}

function orgScopedAuth(orgId: string) {
  return {
    user: { id: 'user-1' },
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    canAccessOrg: (candidate: string) => candidate === orgId,
    orgCondition: (column: unknown) => ({ orgCondition: column, orgId }),
  };
}

// Chainable query-builder mock: every method returns `this`, and the object is
// also thenable so `await` resolves it to `result` (mirrors the shape of the
// real Drizzle builder without needing to hand-nest .from().where()... chains
// for every method-call permutation across the two endpoints under test).
//
// `capture`, when passed, records every (method, args) call so a test can
// assert on the actual join/where conditions built by the route — the plain
// pass-through chain otherwise swallows them, which would let a regression
// (e.g. dropping the `devices.orgId = job.orgId` guard on patch_job_results)
// through every test in this file silently (see the dedicated test below).
type CapturedCall = { method: string; args: unknown[] };
function chain(result: unknown, capture?: CapturedCall[]) {
  const record = (method: string) => (...args: unknown[]) => {
    capture?.push({ method, args });
    return chainObj;
  };
  const handler = {
    from: record('from'),
    leftJoin: record('leftJoin'),
    innerJoin: record('innerJoin'),
    where: record('where'),
    orderBy: record('orderBy'),
    limit: record('limit'),
    offset: record('offset'),
    then: (resolve: (value: unknown) => void) => resolve(result),
  };
  const chainObj: any = handler;
  return chainObj;
}

describe('GET /patches/jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantedPermission = 'devices:read';
  });

  it('rejects a caller without devices:read with 403', async () => {
    grantedPermission = null;

    const res = await mountApp(orgScopedAuth(ORG_ID)).request('/patches/jobs');

    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns only the caller org jobs, tenant-scoped via auth.orgCondition', async () => {
    const jobRow = { id: JOB_ID, orgId: ORG_ID, name: 'AI-initiated patch install', status: 'scheduled' };
    vi.mocked(db.select)
      .mockReturnValueOnce(chain([jobRow]))
      .mockReturnValueOnce(chain([{ count: 1 }]));

    const res = await mountApp(orgScopedAuth(ORG_ID)).request('/patches/jobs');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [jobRow],
      pagination: { page: 1, limit: 50, total: 1 },
    });
  });

  it('never returns another organization\'s jobs (tenant isolation)', async () => {
    // The route itself only ever queries with the caller's orgCondition
    // applied; simulate the DB honoring that by returning no rows when the
    // caller's org doesn't match the row that would exist for OTHER_ORG_ID.
    vi.mocked(db.select)
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ count: 0 }]));

    const res = await mountApp(orgScopedAuth(OTHER_ORG_ID)).request('/patches/jobs');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [],
      pagination: { page: 1, limit: 50, total: 0 },
    });
  });
});

describe('GET /patches/jobs — site-restricted callers', () => {
  const OTHER_DEVICE_ID = '55555555-5555-4555-8555-555555555555';

  beforeEach(() => {
    vi.clearAllMocks();
    grantedPermission = 'devices:read';
    vi.mocked(canAccessSite).mockImplementation((_p: any, siteId: string) => siteId === 'site-a');
  });

  afterEach(() => {
    vi.mocked(canAccessSite).mockImplementation(() => true);
  });

  it('only lists jobs that target a device in the caller\'s sites', async () => {
    const whereCalls: CapturedCall[] = [];
    vi.mocked(db.select)
      .mockReturnValueOnce(chain([], whereCalls))
      .mockReturnValueOnce(chain([{ count: 0 }]));

    const res = await mountApp(orgScopedAuth(ORG_ID), { allowedSiteIds: ['site-a'] }).request('/patches/jobs');

    expect(res.status).toBe(200);
    const whereCall = whereCalls.find((c) => c.method === 'where');
    const conditionText = JSON.stringify(whereCall?.args, (_key, value) =>
      typeof value === 'function' ? '[function]' : value,
    );
    expect(conditionText).toContain('devices.siteId');
    expect(conditionText).toContain('site-a');
  });

  it('returns only the target devices in the caller\'s sites', async () => {
    const jobRow = {
      id: JOB_ID,
      orgId: ORG_ID,
      name: 'Fleet patch',
      status: 'completed',
      targets: { deviceIds: [DEVICE_ID, OTHER_DEVICE_ID], configPolicyName: 'Baseline' },
    };
    vi.mocked(db.select)
      .mockReturnValueOnce(chain([jobRow]))
      .mockReturnValueOnce(chain([{ count: 1 }]))
      .mockReturnValueOnce(chain([
        { id: DEVICE_ID, siteId: 'site-a' },
        { id: OTHER_DEVICE_ID, siteId: 'site-b' },
      ]));

    const res = await mountApp(orgScopedAuth(ORG_ID), { allowedSiteIds: ['site-a'] }).request('/patches/jobs');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].targets).toEqual({ deviceIds: [DEVICE_ID], configPolicyName: 'Baseline' });
  });

  it('returns nothing for a caller restricted to zero sites, without querying', async () => {
    const res = await mountApp(orgScopedAuth(ORG_ID), { allowedSiteIds: [] }).request('/patches/jobs');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [], pagination: { page: 1, limit: 50, total: 0 } });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('job detail 404s when none of the job\'s devices are in the caller\'s sites', async () => {
    const jobRow = { id: JOB_ID, orgId: ORG_ID, name: 'Fleet patch', status: 'completed', targets: { deviceIds: [OTHER_DEVICE_ID] } };
    vi.mocked(db.select)
      .mockReturnValueOnce(chain([jobRow]))
      .mockReturnValueOnce(chain([{ id: 'r-out', deviceId: OTHER_DEVICE_ID, deviceSiteId: 'site-b' }]))
      .mockReturnValueOnce(chain([{ id: OTHER_DEVICE_ID, siteId: 'site-b' }]));

    const res = await mountApp(orgScopedAuth(ORG_ID), { allowedSiteIds: ['site-a'] }).request(`/patches/jobs/${JOB_ID}`);

    expect(res.status).toBe(404);
  });

  it('job detail also narrows target devices to the caller\'s sites', async () => {
    const jobRow = {
      id: JOB_ID,
      orgId: ORG_ID,
      name: 'Fleet patch',
      status: 'completed',
      targets: { deviceIds: [DEVICE_ID, OTHER_DEVICE_ID] },
    };
    vi.mocked(db.select)
      .mockReturnValueOnce(chain([jobRow]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([
        { id: DEVICE_ID, siteId: 'site-a' },
        { id: OTHER_DEVICE_ID, siteId: 'site-b' },
      ]));

    const res = await mountApp(orgScopedAuth(ORG_ID), { allowedSiteIds: ['site-a'] }).request(`/patches/jobs/${JOB_ID}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.targets).toEqual({ deviceIds: [DEVICE_ID] });
  });
});

describe('GET /patches/jobs/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantedPermission = 'devices:read';
  });

  it('rejects a caller without devices:read with 403', async () => {
    grantedPermission = null;

    const res = await mountApp(orgScopedAuth(ORG_ID)).request(`/patches/jobs/${JOB_ID}`);

    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns 404 when the job is not visible under RLS (cross-tenant probe)', async () => {
    vi.mocked(db.select).mockReturnValueOnce(chain([]));

    const res = await mountApp(orgScopedAuth(OTHER_ORG_ID)).request(`/patches/jobs/${JOB_ID}`);

    expect(res.status).toBe(404);
  });

  it('returns the job with its per-device results', async () => {
    const jobRow = {
      id: JOB_ID,
      orgId: ORG_ID,
      name: 'AI-initiated patch install',
      status: 'completed',
      createdByName: 'Ada Lovelace',
    };
    const resultRow = {
      id: 'result-1',
      deviceId: DEVICE_ID,
      deviceHostname: 'WORKSTATION-1',
      patchId: PATCH_ID,
      patchTitle: 'Security Update',
      status: 'completed',
    };
    vi.mocked(db.select)
      .mockReturnValueOnce(chain([jobRow]))
      .mockReturnValueOnce(chain([resultRow]));

    const res = await mountApp(orgScopedAuth(ORG_ID)).request(`/patches/jobs/${JOB_ID}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ...jobRow, results: [resultRow] } });
  });

  it('hides per-device results outside a site-restricted caller\'s allowed sites', async () => {
    const jobRow = { id: JOB_ID, orgId: ORG_ID, name: 'Fleet patch', status: 'completed' };
    const inSite = { id: 'r-in', deviceId: DEVICE_ID, deviceSiteId: 'site-a', status: 'completed' };
    const outSite = { id: 'r-out', deviceId: 'other-device', deviceSiteId: 'site-b', status: 'completed' };
    vi.mocked(canAccessSite).mockImplementation((_p: any, siteId: string) => siteId === 'site-a');
    vi.mocked(db.select)
      .mockReturnValueOnce(chain([jobRow]))
      .mockReturnValueOnce(chain([inSite, outSite]));

    const res = await mountApp(orgScopedAuth(ORG_ID), { allowedSiteIds: ['site-a'] }).request(`/patches/jobs/${JOB_ID}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.results).toEqual([{ id: 'r-in', deviceId: DEVICE_ID, status: 'completed' }]);
    vi.mocked(canAccessSite).mockImplementation(() => true);
  });

  it('rejects a malformed job id before hitting the database', async () => {
    const res = await mountApp(orgScopedAuth(ORG_ID)).request('/patches/jobs/not-a-uuid');

    expect(res.status).toBe(400);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('scopes patch_job_results to the JOB\'S org via the devices join (patch_job_results carries no org_id/RLS of its own)', async () => {
    // This is the regression this test exists to catch: dropping (or loosening)
    // the `eq(devices.orgId, job.orgId)` clause on the results query would
    // leak patch_job_results across tenants, because that table has no org_id
    // column and no RLS policy of its own (see the route's comment). A plain
    // pass-through chain() mock can't catch this — every arg is swallowed —
    // so this test captures the actual innerJoin call and asserts the
    // condition it built references the job's orgId.
    const jobRow = { id: JOB_ID, orgId: ORG_ID, name: 'AI-initiated patch install', status: 'completed' };
    const joinCalls: CapturedCall[] = [];

    vi.mocked(db.select)
      .mockReturnValueOnce(chain([jobRow]))
      .mockReturnValueOnce(chain([], joinCalls));

    const res = await mountApp(orgScopedAuth(ORG_ID)).request(`/patches/jobs/${JOB_ID}`);

    expect(res.status).toBe(200);
    const innerJoinCall = joinCalls.find((c) => c.method === 'innerJoin');
    expect(innerJoinCall).toBeDefined();
    const conditionText = JSON.stringify(innerJoinCall?.args, (_key, value) =>
      typeof value === 'function' ? '[function]' : value,
    );
    // The join must reference the org column and be scoped to THIS job's org
    // (not, say, an unscoped `devices.id = patch_job_results.device_id` alone).
    expect(conditionText).toContain('devices.orgId');
    expect(conditionText).toContain(ORG_ID);
  });
});
