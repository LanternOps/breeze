import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { patchesRoutes } from './patches';

const DEVICE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PATCH_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
  eq: (left: unknown, right: unknown) => ({ op: 'eq', left, right }),
  gte: (left: unknown, right: unknown) => ({ op: 'gte', left, right }),
  inArray: (left: unknown, right: unknown) => ({ op: 'inArray', left, right }),
  desc: (value: unknown) => ({ op: 'desc', value }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', strings, values })
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
  // #7647: the ambient request context. Org-scoped, own partner = the partner
  // resolvePartnerIdForOrg returns below, so the patch_policies /
  // patch_approvals reads are legible in place via the own-partner SELECT
  // branch and must NOT take the second-connection system escape.
  getCurrentDbAccessContext: vi.fn(() => ({
    scope: 'organization',
    orgId: '11111111-1111-1111-1111-111111111111',
    accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
    accessiblePartnerIds: [],
    currentPartnerId: 'dddddddd-dddd-dddd-dddd-dddddddddddd'
  }))
}));

vi.mock('../../db/schema', () => ({
  patches: {
    id: 'patches.id',
    source: 'patches.source',
    externalId: 'patches.externalId',
    packageId: 'patches.packageId',
    title: 'patches.title',
    description: 'patches.description',
    severity: 'patches.severity',
    category: 'patches.category',
    releaseDate: 'patches.releaseDate',
    requiresReboot: 'patches.requiresReboot'
  },
  devicePatches: {
    id: 'devicePatches.id',
    patchId: 'devicePatches.patchId',
    status: 'devicePatches.status',
    installedAt: 'devicePatches.installedAt',
    lastCheckedAt: 'devicePatches.lastCheckedAt',
    failureCount: 'devicePatches.failureCount',
    lastError: 'devicePatches.lastError',
    deviceId: 'devicePatches.deviceId'
  },
  patchApprovals: {
    partnerId: 'patchApprovals.partnerId',
    patchId: 'patchApprovals.patchId',
    status: 'patchApprovals.status'
  },
  deviceCommands: {
    id: 'deviceCommands.id',
    deviceId: 'deviceCommands.deviceId',
    type: 'deviceCommands.type',
    payload: 'deviceCommands.payload',
    status: 'deviceCommands.status',
    createdAt: 'deviceCommands.createdAt',
    completedAt: 'deviceCommands.completedAt',
    result: 'deviceCommands.result',
    createdBy: 'deviceCommands.createdBy'
  },
  users: {
    id: 'users.id',
    email: 'users.email'
  }
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: '11111111-1111-1111-1111-111111111111',
      partnerId: null
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('./helpers', async () => {
  const actual = await vi.importActual<typeof import('./helpers')>('./helpers');
  return {
    ...actual,
    getDeviceWithOrgCheck: vi.fn(),
    getDeviceWithOrgAndSiteCheck: vi.fn(),
  };
});

vi.mock('../patches/helpers', () => ({
  resolvePartnerIdForOrg: vi.fn().mockResolvedValue('dddddddd-dddd-dddd-dddd-dddddddddddd'),
}));

// #4223 deployment overlay — real SQL is covered by
// __tests__/integration/patchInstallFailureStatus.integration.test.ts.
vi.mock('../../services/patchInstallFailures', () => ({
  loadDevicePatchInstallState: vi.fn(async () => ({ failures: new Map(), latestByPatch: new Map() }))
}));

vi.mock('../../services/commandQueue', () => ({
  queueCommandForExecution: vi.fn()
}));

// #7625 ring-aware approval view — the real evaluator composition is covered
// by services/devicePatchApprovalView.test.ts; here only the route plumbing.
vi.mock('../../services/devicePatchApprovalView', () => ({
  loadDevicePatchApprovalView: vi.fn(async () => ({
    evaluation: { available: true, ring: null },
    byPatchId: new Map()
  }))
}));

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn()
}));

import { db } from '../../db';
import { devicePatches, patches } from '../../db/schema';
import { getDeviceWithOrgAndSiteCheck } from './helpers';
import { queueCommandForExecution } from '../../services/commandQueue';
import { resolvePartnerIdForOrg } from '../patches/helpers';
import { loadDevicePatchApprovalView } from '../../services/devicePatchApprovalView';
import { captureException } from '../../services/sentry';
import { getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../../db';

function selectWhereResult(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows)
      }),
      where: vi.fn().mockResolvedValue(rows)
    })
  };
}

function selectPatchStatusResult(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue(rows)
        })
      })
    })
  };
}

function selectWhereLimitResult(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows)
      })
    })
  };
}

function selectJoinWhereLimitResult(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows)
        })
      })
    })
  };
}

function selectWhereOrderLimitResult(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows)
        })
      })
    })
  };
}

function selectPatchHistoryRowsResult(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      leftJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              offset: vi.fn().mockResolvedValue(rows)
            })
          })
        })
      })
    })
  };
}

describe('device patch routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', patchesRoutes);
  });

  it('separates actionable pending patches from missing records', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: '11111111-1111-1111-1111-111111111111' } as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(selectPatchStatusResult([
      {
        id: 'dp-1',
        patchId: '11111111-1111-4111-8111-111111111111',
        status: 'pending',
        installedAt: null,
        lastCheckedAt: '2026-02-09T10:00:00.000Z',
        failureCount: 0,
        lastError: null,
        externalId: 'apple:OS Update A:1.0.1',
        title: 'OS Update A',
        description: 'Pending update',
        severity: 'important',
        category: 'system',
        source: 'apple',
        releaseDate: '2026-02-01',
        requiresReboot: true
      },
      {
        id: 'dp-2',
        patchId: '22222222-2222-4222-8222-222222222222',
        status: 'missing',
        installedAt: null,
        lastCheckedAt: '2026-02-09T10:00:00.000Z',
        failureCount: 0,
        lastError: null,
        externalId: 'third_party:Old package entry:2.1.0',
        title: 'Old package entry',
        description: 'Not seen in latest scan',
        severity: 'unknown',
        category: 'application',
        source: 'third_party',
        releaseDate: null,
        requiresReboot: false
      },
      {
        id: 'dp-3',
        patchId: '33333333-3333-4333-8333-333333333333',
        status: 'installed',
        installedAt: '2026-02-08T10:00:00.000Z',
        lastCheckedAt: '2026-02-09T10:00:00.000Z',
        failureCount: 0,
        lastError: null,
        externalId: 'apple:Installed update:1.0.0',
        title: 'Installed update',
        description: 'Installed',
        severity: 'important',
        category: 'system',
        source: 'apple',
        releaseDate: '2026-02-03',
        requiresReboot: false
      }
      ]) as any)
      .mockReturnValueOnce(selectWhereOrderLimitResult([
        {
          status: 'completed',
          createdAt: '2026-02-09T09:59:00.000Z',
          completedAt: '2026-02-09T10:00:00.000Z'
        }
      ]) as any)
      .mockReturnValueOnce(selectWhereResult([
        { patchId: '11111111-1111-4111-8111-111111111111' }
      ]) as any);

    const res = await app.request(`/devices/${DEVICE_ID}/patches`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.pending).toHaveLength(1);
    expect(body.data.pending[0].id).toBe('11111111-1111-4111-8111-111111111111');
    expect(body.data.pending[0].status).toBe('pending');
    expect(body.data.pending[0].approvalStatus).toBe('approved');
    expect(body.data.pending[0].externalId).toBe('apple:OS Update A:1.0.1');
    expect(body.data.pending[0].description).toBe('Pending update');

    expect(body.data.missing).toHaveLength(1);
    expect(body.data.missing[0].id).toBe('22222222-2222-4222-8222-222222222222');
    expect(body.data.missing[0].status).toBe('missing');

    expect(body.data.installed).toHaveLength(1);
    expect(body.data.compliancePercent).toBe(50);
    expect(body.data.lastPatchScanAt).toBe('2026-02-09T10:00:00.000Z');
    expect(body.data.lastPatchScanStatus).toBe('completed');
  });

  // #7625 — a patch the linked update ring auto-approves used to read
  // "Pending approval" because approvalStatus only reflects manual
  // partner-wide approvals. effectiveApproval carries the ring-aware verdict;
  // approvalStatus keeps its manual-only meaning (the Install gate uses it).
  it('reports the ring-aware effectiveApproval for a patch the linked ring auto-approves', async () => {
    const RING_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const AUTO = '11111111-1111-4111-8111-111111111111';
    const HELD = '44444444-4444-4444-8444-444444444444';
    const INSTALLED = '55555555-5555-4555-8555-555555555555';
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: '11111111-1111-1111-1111-111111111111' } as any);
    const pendingRow = (patchId: string, title: string) => ({
      id: `dp-${patchId}`, patchId, status: 'pending', installedAt: null,
      lastCheckedAt: '2026-02-09T10:00:00.000Z', failureCount: 0, lastError: null,
      externalId: `KB-${title}`, title, description: null, severity: 'critical',
      category: 'security', source: 'microsoft', releaseDate: '2026-02-01', requiresReboot: false
    });
    vi.mocked(db.select)
      .mockReturnValueOnce(selectPatchStatusResult([
        pendingRow(AUTO, 'Auto'),
        pendingRow(HELD, 'Held'),
        { ...pendingRow(INSTALLED, 'Done'), status: 'installed', installedAt: '2026-02-05T00:00:00.000Z' }
      ]) as any)
      .mockReturnValueOnce(selectWhereOrderLimitResult([]) as any)
      // no manual approvals
      .mockReturnValueOnce(selectWhereResult([]) as any);
    // Record whether the view ran INSIDE the system-context escape. A bare
    // toHaveBeenCalled() on the db mocks would be vacuous here: the manual
    // approvals read above already calls both.
    let inSystemContext = false;
    let viewRanInSystemContext: boolean | null = null;
    vi.mocked(withSystemDbAccessContext).mockImplementation(async (fn: () => any) => {
      inSystemContext = true;
      try { return await fn(); } finally { inSystemContext = false; }
    });
    vi.mocked(loadDevicePatchApprovalView).mockImplementationOnce(async () => {
      viewRanInSystemContext = inSystemContext;
      return {
      evaluation: { available: true, ring: { id: RING_ID, name: 'Workstations Ring' } },
      byPatchId: new Map([
        [AUTO, { state: 'auto_approved', reason: 'ring_auto_approve', holdUntil: null }],
        [HELD, { state: 'deferred', reason: 'held_by_deferral', holdUntil: '2026-02-08T00:00:00.000Z' }]
      ])
      } as any;
    });

    const res = await app.request(`/devices/${DEVICE_ID}/patches`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const byId = new Map<string, any>(body.data.pending.map((p: any) => [p.id, p]));
    expect(byId.get(AUTO).effectiveApproval).toEqual({ state: 'auto_approved', reason: 'ring_auto_approve', holdUntil: null });
    expect(byId.get(HELD).effectiveApproval).toEqual({ state: 'deferred', reason: 'held_by_deferral', holdUntil: '2026-02-08T00:00:00.000Z' });
    // Back-compat: the manual-approval field is unchanged.
    expect(byId.get(AUTO).approvalStatus).toBe('pending');
    expect(body.data.approvalEvaluation).toEqual({ available: true, ring: { id: RING_ID, name: 'Workstations Ring' } });
    const combined = body.data.patches.find((p: any) => p.id === AUTO);
    expect(combined.effectiveApproval.state).toBe('auto_approved');
    // Only outstanding patches carry a verdict.
    expect(body.data.patches.find((p: any) => p.id === INSTALLED).effectiveApproval).toBeNull();
    // Evaluated for THIS device+org, in the request's OWN context (#7647):
    // neither read may open a second pooled connection.
    expect(loadDevicePatchApprovalView).toHaveBeenCalledWith(DEVICE_ID, '11111111-1111-1111-1111-111111111111');
    expect(viewRanInSystemContext).toBe(false);
    expect(runOutsideDbContext).not.toHaveBeenCalled();
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
  });

  // #7647: a tab load holds at most one pooled connection. Both partner-axis
  // reads (manual approvals + ring-aware view) run in the request context when
  // that context can see the device-org's partner via the own-partner branch.
  it('never escapes to a system context when the caller context covers the device partner', async () => {
    const PID = '11111111-1111-4111-8111-111111111111';
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: '11111111-1111-1111-1111-111111111111' } as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(selectPatchStatusResult([{
        id: 'dp-1', patchId: PID, status: 'pending', installedAt: null,
        lastCheckedAt: '2026-02-09T10:00:00.000Z', failureCount: 0, lastError: null,
        externalId: 'KB1', title: 'One', description: null, severity: 'critical',
        category: 'security', source: 'microsoft', releaseDate: '2026-02-01', requiresReboot: false
      }]) as any)
      .mockReturnValueOnce(selectWhereOrderLimitResult([]) as any)
      .mockReturnValueOnce(selectWhereResult([{ patchId: PID }]) as any);
    vi.mocked(loadDevicePatchApprovalView).mockResolvedValueOnce({
      evaluation: { available: true, ring: null },
      byPatchId: new Map([[PID, { state: 'approved', reason: 'manual', holdUntil: null }]])
    } as any);

    const res = await app.request(`/devices/${DEVICE_ID}/patches`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.pending[0].approvalStatus).toBe('approved');
    expect(body.data.pending[0].effectiveApproval).toEqual({ state: 'approved', reason: 'manual', holdUntil: null });
    expect(loadDevicePatchApprovalView).toHaveBeenCalledTimes(1);
    expect(runOutsideDbContext).not.toHaveBeenCalled();
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
  });

  // A context that cannot see the device-org's partner (no own partner, a
  // different partner) keeps the system escape — otherwise both reads would
  // silently come back empty under RLS and every patch would read unapproved.
  it('falls back to the system escape when the caller context cannot see the device partner', async () => {
    const PID = '11111111-1111-4111-8111-111111111111';
    vi.mocked(getCurrentDbAccessContext).mockReturnValue({
      scope: 'organization',
      orgId: '11111111-1111-1111-1111-111111111111',
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      accessiblePartnerIds: [],
      currentPartnerId: null
    } as any);
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: '11111111-1111-1111-1111-111111111111' } as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(selectPatchStatusResult([{
        id: 'dp-1', patchId: PID, status: 'pending', installedAt: null,
        lastCheckedAt: '2026-02-09T10:00:00.000Z', failureCount: 0, lastError: null,
        externalId: 'KB1', title: 'One', description: null, severity: 'critical',
        category: 'security', source: 'microsoft', releaseDate: '2026-02-01', requiresReboot: false
      }]) as any)
      .mockReturnValueOnce(selectWhereOrderLimitResult([]) as any)
      .mockReturnValueOnce(selectWhereResult([]) as any);
    vi.mocked(loadDevicePatchApprovalView).mockResolvedValueOnce({
      evaluation: { available: true, ring: null },
      byPatchId: new Map()
    } as any);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const res = await app.request(`/devices/${DEVICE_ID}/patches`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });
      expect(res.status).toBe(200);
      // approvals read + approval view, each through the escape
      expect(withSystemDbAccessContext).toHaveBeenCalledTimes(2);
      expect(runOutsideDbContext).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
      vi.mocked(getCurrentDbAccessContext).mockReset();
    }
  });

  it('degrades to approvalEvaluation.available=false (not a 500) when the ring evaluation throws', async () => {
    const PID = '11111111-1111-4111-8111-111111111111';
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: '11111111-1111-1111-1111-111111111111' } as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(selectPatchStatusResult([{
        id: 'dp-1', patchId: PID, status: 'pending', installedAt: null,
        lastCheckedAt: '2026-02-09T10:00:00.000Z', failureCount: 0, lastError: null,
        externalId: 'KB1', title: 'One', description: null, severity: 'critical',
        category: 'security', source: 'microsoft', releaseDate: '2026-02-01', requiresReboot: false
      }]) as any)
      .mockReturnValueOnce(selectWhereOrderLimitResult([]) as any)
      .mockReturnValueOnce(selectWhereResult([]) as any);
    const boom = new Error('ring config read failed');
    vi.mocked(loadDevicePatchApprovalView).mockRejectedValueOnce(boom);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await app.request(`/devices/${DEVICE_ID}/patches`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.approvalEvaluation).toEqual({ available: false, ring: null });
    expect(body.data.pending[0].effectiveApproval).toBeNull();
    expect(body.data.pending[0].approvalStatus).toBe('pending');
    expect(captureException).toHaveBeenCalledWith(boom, expect.anything(), expect.objectContaining({ deviceId: DEVICE_ID }));
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  // Todd's decision on #7637 (option B): the install poller passes
  // approvalView=0 so the 5 s poll does not open the second pooled connection
  // (runOutsideDbContext + withSystemDbAccessContext) on every tick.
  it('skips the ring-aware evaluation when approvalView=0 (install polling)', async () => {
    const PID = '11111111-1111-4111-8111-111111111111';
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: '11111111-1111-1111-1111-111111111111' } as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(selectPatchStatusResult([{
        id: 'dp-1', patchId: PID, status: 'pending', installedAt: null,
        lastCheckedAt: '2026-02-09T10:00:00.000Z', failureCount: 0, lastError: null,
        externalId: 'KB1', title: 'One', description: null, severity: 'critical',
        category: 'security', source: 'microsoft', releaseDate: '2026-02-01', requiresReboot: false
      }]) as any)
      .mockReturnValueOnce(selectWhereOrderLimitResult([]) as any)
      .mockReturnValueOnce(selectWhereResult([]) as any);

    const res = await app.request(`/devices/${DEVICE_ID}/patches?approvalView=0`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(loadDevicePatchApprovalView).not.toHaveBeenCalled();
    expect(body.data.approvalEvaluation).toBeNull();
    expect(body.data.pending[0].effectiveApproval).toBeNull();
    expect(body.data.patches[0].effectiveApproval).toBeNull();
    // The manual-approval field is still served.
    expect(body.data.pending[0].approvalStatus).toBe('pending');
  });

  it('rejects an unrecognised approvalView value', async () => {
    const res = await app.request(`/devices/${DEVICE_ID}/patches?approvalView=maybe`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });
    expect(res.status).toBe(400);
    expect(loadDevicePatchApprovalView).not.toHaveBeenCalled();
  });

  it('skips the ring evaluation when the device has nothing pending', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: '11111111-1111-1111-1111-111111111111' } as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(selectPatchStatusResult([]) as any)
      .mockReturnValueOnce(selectWhereOrderLimitResult([]) as any);

    const res = await app.request(`/devices/${DEVICE_ID}/patches`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.approvalEvaluation).toBeNull();
    expect(loadDevicePatchApprovalView).not.toHaveBeenCalled();
  });

  // #2727 — the "per-user apps were not scanned" signal.
  //
  // The agent's payload arrives wrapped: device_commands.result holds the
  // {status, exitCode, stdout} envelope with the handler's map JSON-ENCODED in
  // `stdout`. Reading the field off the envelope directly returns undefined, so
  // this asserts the unwrap actually happens — the note would silently never
  // render otherwise, which is the same class of silent under-report #2727 fixes.
  it.each([
    {
      name: 'unwraps the user-scope coverage signal from the stdout envelope',
      result: {
        status: 'completed',
        exitCode: 0,
        stdout: JSON.stringify({
          pendingCount: 3,
          userScopeScanned: false,
          userScopeSkipReason: 'no user helper session connected',
        }),
      },
      wantScanned: false,
      wantReason: 'no user helper session connected',
    },
    {
      name: 'reports a covered user scope as true',
      result: { status: 'completed', exitCode: 0, stdout: JSON.stringify({ userScopeScanned: true }) },
      wantScanned: true,
      wantReason: null,
    },
    {
      name: 'absent field stays null rather than collapsing to false',
      result: { status: 'completed', exitCode: 0, stdout: JSON.stringify({ pendingCount: 0 }) },
      wantScanned: null,
      wantReason: null,
    },
    {
      name: 'malformed stdout yields null, never a throw',
      result: { status: 'completed', exitCode: 0, stdout: 'not json at all' },
      wantScanned: null,
      wantReason: null,
    },
    {
      name: 'missing result yields null',
      result: null,
      wantScanned: null,
      wantReason: null,
    },
  ])('$name', async ({ result, wantScanned, wantReason }) => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: '11111111-1111-1111-1111-111111111111' } as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(selectPatchStatusResult([
        {
          id: 'dp-scope-1',
          patchId: '11111111-1111-4111-8111-111111111111',
          status: 'pending',
          scope: 'user',
          installedAt: null,
          lastCheckedAt: '2026-02-09T10:00:00.000Z',
          failureCount: 0,
          lastError: null,
          externalId: 'winget:Google.Chrome',
          title: 'Google Chrome',
          description: null,
          severity: 'unknown',
          category: 'application',
          source: 'third_party',
          releaseDate: null,
          requiresReboot: false
        }
      ]) as any)
      .mockReturnValueOnce(selectWhereOrderLimitResult([
        {
          status: 'completed',
          createdAt: '2026-02-09T09:59:00.000Z',
          completedAt: '2026-02-09T10:00:00.000Z',
          result,
        }
      ]) as any)
      .mockReturnValueOnce(selectWhereResult([]) as any);

    const res = await app.request(`/devices/${DEVICE_ID}/patches`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.lastPatchScanUserScopeScanned).toBe(wantScanned);
    expect(body.data.lastPatchScanUserScopeSkipReason).toBe(wantReason);
    // The per-row scope label reaches the client too — it drives the badge.
    expect(body.data.pending[0].scope).toBe('user');
  });

  it('excludes Linux installed package inventory from patch compliance', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: '11111111-1111-1111-1111-111111111111' } as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(selectPatchStatusResult([
        {
          id: 'dp-linux-pending',
          patchId: '11111111-1111-4111-8111-111111111111',
          status: 'pending',
          installedAt: null,
          lastCheckedAt: '2026-02-09T10:00:00.000Z',
          failureCount: 0,
          lastError: null,
          externalId: 'apt:openssl@3.0.2-0ubuntu1.20',
          packageId: 'apt:openssl',
          title: 'openssl',
          description: null,
          severity: 'unknown',
          category: 'system',
          source: 'linux',
          releaseDate: null,
          requiresReboot: false
        },
        {
          id: 'dp-linux-installed',
          patchId: '22222222-2222-4222-8222-222222222222',
          status: 'installed',
          installedAt: null,
          lastCheckedAt: '2026-02-09T10:00:00.000Z',
          failureCount: 0,
          lastError: null,
          externalId: 'apt:zlib1g',
          packageId: 'apt:zlib1g',
          title: 'zlib1g',
          description: null,
          severity: 'unknown',
          category: 'system',
          source: 'linux',
          releaseDate: null,
          requiresReboot: false
        }
      ]) as any)
      .mockReturnValueOnce(selectWhereOrderLimitResult([]) as any)
      .mockReturnValueOnce(selectWhereResult([]) as any);

    const res = await app.request(`/devices/${DEVICE_ID}/patches`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.pending).toHaveLength(1);
    expect(body.data.pending[0].externalId).toBe('apt:openssl@3.0.2-0ubuntu1.20');
    expect(body.data.installed).toHaveLength(0);
    expect(body.data.compliancePercent).toBe(0);
    expect(body.data.lastPatchScanAt).toBeNull();
    expect(body.data.lastPatchScanStatus).toBeNull();
  });

  it('includes successful Linux software updates in install patch history', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
      id: DEVICE_ID,
      orgId: '11111111-1111-1111-1111-111111111111',
      osType: 'linux'
    } as any);
    const countWhere = vi.fn().mockResolvedValue([{ count: 1 }]);
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: countWhere
        })
      } as any)
      .mockReturnValueOnce(selectPatchHistoryRowsResult([
        {
          id: 'cmd-software-1',
          type: 'software_update',
          payload: { name: 'netbird', source: 'device_software_tab' },
          status: 'completed',
          createdAt: '2026-06-22T02:45:00.000Z',
          completedAt: '2026-06-22T02:46:00.000Z',
          result: {
            status: 'completed',
            exitCode: 0,
            stdout: JSON.stringify({
              name: 'netbird',
              version: '',
              packageId: '',
              action: 'update',
              success: true
            })
          },
          createdBy: USER_ID,
          createdByEmail: 'test@example.com'
        }
      ]) as any);

    const completedAfter = '2026-06-15T00:00:00.000Z';
    const params = new URLSearchParams({
      type: 'install',
      status: 'completed',
      completedAfter
    });
    const res = await app.request(`/devices/${DEVICE_ID}/patches/history?${params.toString()}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    const whereClause = JSON.stringify(countWhere.mock.calls[0]?.[0]);
    expect(whereClause).toContain('software_update');
    expect(whereClause).toContain('"op":"gte"');
    expect(whereClause).toContain(completedAfter);
    expect(body.total).toBe(1);
    expect(body.history).toHaveLength(1);
    expect(body.history[0].type).toBe('software_update');
    expect(body.history[0].result).toMatchObject({
      installedCount: 1,
      failedCount: 0,
      success: true,
      results: [
        {
          id: 'netbird',
          installId: 'netbird',
          name: 'netbird',
          title: 'netbird',
          source: 'linux',
          externalId: 'netbird',
          status: 'installed'
        }
      ]
    });
  });

  it('queues install_patches command with patch metadata', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: '11111111-1111-1111-1111-111111111111' } as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(selectWhereResult([
        { id: PATCH_ID, source: 'linux', externalId: 'apt:openssl@3.0.2-0ubuntu1.20', packageId: 'apt:openssl', title: 'OpenSSL' }
      ]) as any)
      .mockReturnValueOnce(selectWhereResult([
        { patchId: PATCH_ID }
      ]) as any);
    vi.mocked(queueCommandForExecution).mockResolvedValue({
      command: {
        id: 'cmd-install-1',
        status: 'sent'
      }
    } as any);

    const res = await app.request(`/devices/${DEVICE_ID}/patches/install`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ patchIds: [PATCH_ID] })
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.commandId).toBe('cmd-install-1');
    expect(body.commandStatus).toBe('sent');
    expect(body.patchCount).toBe(1);

    expect(queueCommandForExecution).toHaveBeenCalledWith(
      DEVICE_ID,
      'install_patches',
      {
        patchIds: [PATCH_ID],
        patches: [{
          id: PATCH_ID,
          source: 'linux',
          externalId: 'apt:openssl@3.0.2-0ubuntu1.20',
          packageId: 'apt:openssl',
          title: 'OpenSSL'
        }]
      },
      { userId: USER_ID, preferHeartbeat: false }
    );
  });

  it('uses the device-observed KB selector instead of a global first-writer WUA UpdateID', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: '11111111-1111-1111-1111-111111111111' } as any);
    const observationWhere = vi.fn().mockResolvedValue([
      {
        id: PATCH_ID,
        source: 'microsoft',
        externalId: 'KB5034441',
        packageId: 'windows-update:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        title: 'Windows Security Update'
      }
    ]);
    const observationInnerJoin = vi.fn().mockReturnValue({ where: observationWhere });
    // The direct `where` member keeps this boundary test runnable against the
    // vulnerable baseline, where the query started from the global catalog.
    const observationFrom = vi.fn().mockReturnValue({
      innerJoin: observationInnerJoin,
      where: observationWhere
    });
    vi.mocked(db.select)
      .mockReturnValueOnce({ from: observationFrom } as any)
      .mockReturnValueOnce(selectWhereResult([{ patchId: PATCH_ID }]) as any);
    vi.mocked(queueCommandForExecution).mockResolvedValue({
      command: { id: 'cmd-install-kb', status: 'sent' }
    } as any);

    const res = await app.request(`/devices/${DEVICE_ID}/patches/install`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ patchIds: [PATCH_ID] })
    });

    expect(res.status).toBe(200);
    expect(observationFrom).toHaveBeenCalledWith(devicePatches);
    expect(observationInnerJoin).toHaveBeenCalledWith(patches, expect.anything());
    expect(JSON.stringify(observationWhere.mock.calls[0]?.[0])).toContain(DEVICE_ID);
    expect(JSON.stringify(observationWhere.mock.calls[0]?.[0])).toContain('pending');
    expect(JSON.stringify(observationWhere.mock.calls[0]?.[0])).toContain(PATCH_ID);
    expect(queueCommandForExecution).toHaveBeenCalledWith(
      DEVICE_ID,
      'install_patches',
      {
        patchIds: [PATCH_ID],
        patches: [{
          id: PATCH_ID,
          source: 'microsoft',
          externalId: 'KB5034441',
          packageId: null,
          title: 'Windows Security Update'
        }]
      },
      { userId: USER_ID, preferHeartbeat: false }
    );
  });

  it('drops the global selector for a KB-less Microsoft update (driver/feature rows)', async () => {
    // Driver and feature updates expose no KBArticleIDs, so the agent reports
    // the raw WUA UpdateID as externalId. Those rows are deduplicated globally
    // on (source, externalId) exactly like KB rows, and `packageId` is still
    // first-writer catalog metadata, so it must be dropped here too.
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: '11111111-1111-1111-1111-111111111111' } as any);
    const observationWhere = vi.fn().mockResolvedValue([
      {
        id: PATCH_ID,
        source: 'microsoft',
        externalId: 'aaaaaaaa-1111-2222-3333-444444444444',
        packageId: 'windows-update:99999999-9999-9999-9999-999999999999',
        title: 'Intel Corporation - Display - 31.0.101.5186'
      }
    ]);
    const observationFrom = vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({ where: observationWhere }),
      where: observationWhere
    });
    vi.mocked(db.select)
      .mockReturnValueOnce({ from: observationFrom } as any)
      .mockReturnValueOnce(selectWhereResult([{ patchId: PATCH_ID }]) as any);
    vi.mocked(queueCommandForExecution).mockResolvedValue({
      command: { id: 'cmd-install-driver', status: 'sent' }
    } as any);

    const res = await app.request(`/devices/${DEVICE_ID}/patches/install`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ patchIds: [PATCH_ID] })
    });

    expect(res.status).toBe(200);
    expect(queueCommandForExecution).toHaveBeenCalledWith(
      DEVICE_ID,
      'install_patches',
      {
        patchIds: [PATCH_ID],
        patches: [{
          id: PATCH_ID,
          source: 'microsoft',
          externalId: 'aaaaaaaa-1111-2222-3333-444444444444',
          packageId: null,
          title: 'Intel Corporation - Display - 31.0.101.5186'
        }]
      },
      { userId: USER_ID, preferHeartbeat: false }
    );
  });

  it('keeps the package selector for non-Microsoft sources', async () => {
    // Over-reach guard: for real package managers the packageId IS the install
    // selector and must survive untouched.
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: '11111111-1111-1111-1111-111111111111' } as any);
    const observationWhere = vi.fn().mockResolvedValue([
      {
        id: PATCH_ID,
        source: 'third_party',
        externalId: 'winget:Google.Chrome',
        packageId: 'winget:Google.Chrome',
        title: 'Google Chrome'
      }
    ]);
    const observationFrom = vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({ where: observationWhere }),
      where: observationWhere
    });
    vi.mocked(db.select)
      .mockReturnValueOnce({ from: observationFrom } as any)
      .mockReturnValueOnce(selectWhereResult([{ patchId: PATCH_ID }]) as any);
    vi.mocked(queueCommandForExecution).mockResolvedValue({
      command: { id: 'cmd-install-winget', status: 'sent' }
    } as any);

    const res = await app.request(`/devices/${DEVICE_ID}/patches/install`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ patchIds: [PATCH_ID] })
    });

    expect(res.status).toBe(200);
    expect(queueCommandForExecution).toHaveBeenCalledWith(
      DEVICE_ID,
      'install_patches',
      {
        patchIds: [PATCH_ID],
        patches: [{
          id: PATCH_ID,
          source: 'third_party',
          externalId: 'winget:Google.Chrome',
          packageId: 'winget:Google.Chrome',
          title: 'Google Chrome'
        }]
      },
      { userId: USER_ID, preferHeartbeat: false }
    );
  });

  it('rejects install when any requested patch is not approved', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: '11111111-1111-1111-1111-111111111111' } as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(selectWhereResult([
        { id: PATCH_ID, source: 'linux', externalId: 'apt:openssl', title: 'OpenSSL' }
      ]) as any)
      .mockReturnValueOnce(selectWhereResult([]) as any);

    const res = await app.request(`/devices/${DEVICE_ID}/patches/install`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ patchIds: [PATCH_ID] })
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('Only approved patches can be installed');
    expect(body.unapprovedPatchIds).toEqual([PATCH_ID]);
    expect(queueCommandForExecution).not.toHaveBeenCalled();
  });

  it('returns 409 and does not queue when resolvePartnerIdForOrg returns null (orphaned org fail-safe)', async () => {
    vi.mocked(resolvePartnerIdForOrg).mockResolvedValueOnce(null);
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: '11111111-1111-1111-1111-111111111111' } as any);
    vi.mocked(db.select).mockReturnValueOnce(selectWhereResult([
      { id: PATCH_ID, source: 'linux', externalId: 'apt:openssl', title: 'OpenSSL' }
    ]) as any);

    const res = await app.request(`/devices/${DEVICE_ID}/patches/install`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ patchIds: [PATCH_ID] })
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('Only approved patches can be installed');
    expect(body.unapprovedPatchIds).toEqual([PATCH_ID]);
    expect(queueCommandForExecution).not.toHaveBeenCalled();
  });

  it('returns 404 when install patch IDs do not resolve to patch records', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: '11111111-1111-1111-1111-111111111111' } as any);
    vi.mocked(db.select).mockReturnValueOnce(selectWhereResult([]) as any);

    const res = await app.request(`/devices/${DEVICE_ID}/patches/install`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ patchIds: [PATCH_ID] })
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain('No matching patches');
  });

  it('returns 404 with missingPatchIds when only some install patch IDs resolve', async () => {
    const RESOLVED_PATCH_ID = '11111111-1111-4111-8111-111111111111';
    const MISSING_PATCH_ID = '22222222-2222-4222-8222-222222222222';
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: '11111111-1111-1111-1111-111111111111' } as any);
    // Only the first patch resolves in patchRefs; the second is missing.
    vi.mocked(db.select).mockReturnValueOnce(selectWhereResult([
      { id: RESOLVED_PATCH_ID, source: 'linux', externalId: 'apt:openssl', title: 'OpenSSL' }
    ]) as any);

    const res = await app.request(`/devices/${DEVICE_ID}/patches/install`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ patchIds: [RESOLVED_PATCH_ID, MISSING_PATCH_ID] })
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Some patches were not found');
    expect(body.missingPatchIds).toEqual([MISSING_PATCH_ID]);
    // The missing-patch check short-circuits before the approval query and the queue.
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(queueCommandForExecution).not.toHaveBeenCalled();
  });

  it('does not issue the approvals query when a device has no patches', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: '11111111-1111-1111-1111-111111111111' } as any);
    // Device-patch list resolves to an empty array → patchIds is empty →
    // getApprovedPatchIdsForPartner short-circuits without an approvals query.
    vi.mocked(db.select)
      .mockReturnValueOnce(selectPatchStatusResult([]) as any)
      .mockReturnValueOnce(selectWhereOrderLimitResult([]) as any);

    const res = await app.request(`/devices/${DEVICE_ID}/patches`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.pending).toEqual([]);
    expect(body.data.missing).toEqual([]);
    expect(body.data.installed).toEqual([]);
    expect(body.data.compliancePercent).toBe(100);
    expect(body.data.lastPatchScanAt).toBeNull();
    // Only the device-patch list and last-scan queries ran; the approvals query was skipped.
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it('queues rollback_patches command for a device patch', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: '11111111-1111-1111-1111-111111111111' } as any);
    vi.mocked(db.select).mockReturnValueOnce(selectJoinWhereLimitResult([
      { id: PATCH_ID, source: 'apple', externalId: 'apple:example', title: 'Example Patch' }
    ]) as any);
    vi.mocked(queueCommandForExecution).mockResolvedValue({
      command: {
        id: 'cmd-rollback-1',
        status: 'sent'
      }
    } as any);

    const res = await app.request(`/devices/${DEVICE_ID}/patches/${PATCH_ID}/rollback`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.commandId).toBe('cmd-rollback-1');
    expect(body.commandStatus).toBe('sent');
    expect(body.patchId).toBe(PATCH_ID);

    expect(queueCommandForExecution).toHaveBeenCalledWith(
      DEVICE_ID,
      'rollback_patches',
      {
        patchIds: [PATCH_ID],
        patches: [{ id: PATCH_ID, source: 'apple', externalId: 'apple:example', title: 'Example Patch' }]
      },
      { userId: USER_ID, preferHeartbeat: false }
    );
  });

  it('binds the rollback target to the device\'s own installed observation (#5565)', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: '11111111-1111-1111-1111-111111111111' } as any);
    const observationLimit = vi.fn().mockResolvedValue([
      { id: PATCH_ID, source: 'apple', externalId: 'apple:example', title: 'Example Patch' }
    ]);
    const observationWhere = vi.fn().mockReturnValue({ limit: observationLimit });
    const observationInnerJoin = vi.fn().mockReturnValue({ where: observationWhere });
    // The direct `where` member keeps this boundary test runnable against the
    // vulnerable baseline, where the query started from the global catalog.
    const observationFrom = vi.fn().mockReturnValue({
      innerJoin: observationInnerJoin,
      where: observationWhere
    });
    vi.mocked(db.select).mockReturnValueOnce({ from: observationFrom } as any);
    vi.mocked(queueCommandForExecution).mockResolvedValue({
      command: { id: 'cmd-rollback-bound', status: 'sent' }
    } as any);

    const res = await app.request(`/devices/${DEVICE_ID}/patches/${PATCH_ID}/rollback`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' }
    });

    expect(res.status).toBe(200);
    expect(observationFrom).toHaveBeenCalledWith(devicePatches);
    expect(observationInnerJoin).toHaveBeenCalledWith(patches, expect.anything());
    const where = JSON.stringify(observationWhere.mock.calls[0]?.[0]);
    expect(where).toContain(DEVICE_ID);
    expect(where).toContain('installed');
    expect(where).toContain(PATCH_ID);
  });

  it('returns 404 and does not queue when the device has no installed observation of the patch (#5565)', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: '11111111-1111-1111-1111-111111111111' } as any);
    vi.mocked(db.select).mockReturnValueOnce(selectJoinWhereLimitResult([]) as any);

    const res = await app.request(`/devices/${DEVICE_ID}/patches/${PATCH_ID}/rollback`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' }
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Patch is not installed on this device' });
    expect(queueCommandForExecution).not.toHaveBeenCalled();
  });
});
