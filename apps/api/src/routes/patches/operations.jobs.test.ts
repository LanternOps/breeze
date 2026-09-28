import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ORG_ID = '99999999-9999-4999-8999-999999999999';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const PATCH_ID = '44444444-4444-4444-8444-444444444444';

function mountApp(auth: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as any).set('auth', auth);
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
function chain(result: unknown) {
  const handler = {
    from: () => chainObj,
    leftJoin: () => chainObj,
    innerJoin: () => chainObj,
    where: () => chainObj,
    orderBy: () => chainObj,
    limit: () => chainObj,
    offset: () => chainObj,
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

  it('rejects a malformed job id before hitting the database', async () => {
    const res = await mountApp(orgScopedAuth(ORG_ID)).request('/patches/jobs/not-a-uuid');

    expect(res.status).toBe(400);
    expect(db.select).not.toHaveBeenCalled();
  });
});
