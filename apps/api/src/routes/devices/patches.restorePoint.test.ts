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
    status: 'patchApprovals.status',
    ringId: 'patchApprovals.ringId',
    updatedAt: 'patchApprovals.updatedAt'
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
import {
  buildRestorePointRequest,
  discardRestorePointRequest,
  linkRestorePointCommand,
} from '../../services/restorePointRequest';

vi.mock('../../services/restorePointRequest', () => ({
  buildRestorePointRequest: vi.fn(),
  linkRestorePointCommand: vi.fn(),
  discardRestorePointRequest: vi.fn(),
  restorePointPayloadField: (block: unknown) => (block ? { restorePoint: block } : {}),
}));

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const BLOCK = {
  v: 1,
  requestId: 'rp-request-1',
  enabled: true,
  label: 'install 1 update',
  resolvedAt: '2026-10-12T00:00:00.000Z',
  policyRevision: 'rev-1',
  validUntil: '2026-10-12T01:00:00.000Z',
};

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

const PATCH_ROW = {
  id: PATCH_ID,
  source: 'microsoft',
  externalId: 'KB5034441',
  packageId: 'windows-update:x',
  title: 'Windows Security Update',
  category: 'security'
};

function arrange(ids: string[] = [PATCH_ID]) {
  vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: ORG_ID, osType: 'windows' } as any);
  vi.mocked(db.select)
    .mockReturnValueOnce(selectWhereResult(ids.map((id) => ({ ...PATCH_ROW, id }))) as any)
    .mockReturnValueOnce(selectWhereResult(ids.map((patchId) => ({ patchId, status: 'approved', ringId: null, updatedAt: null }))) as any);
}

let app: Hono;

function install(patchIds: string[] = [PATCH_ID]) {
  return app.request(`/devices/${DEVICE_ID}/patches/install`, {
    method: 'POST',
    headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ patchIds })
  });
}

describe('POST /devices/:id/patches/install restore-point chokepoint', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(resolvePartnerIdForOrg).mockResolvedValue('dddddddd-dddd-dddd-dddd-dddddddddddd');
    vi.mocked(loadDevicePatchApprovalView).mockResolvedValue({
      evaluation: { available: true, ring: null },
      byPatchId: new Map()
    } as any);
    vi.mocked(getCurrentDbAccessContext).mockReturnValue({
      scope: 'organization',
      orgId: ORG_ID,
      accessibleOrgIds: [ORG_ID],
      accessiblePartnerIds: [],
      currentPartnerId: 'dddddddd-dddd-dddd-dddd-dddddddddddd'
    } as any);
    vi.mocked(runOutsideDbContext).mockImplementation((fn: any) => fn());
    vi.mocked(withSystemDbAccessContext).mockImplementation(async (fn: any) => fn());
    app = new Hono();
    app.route('/devices', patchesRoutes);
  });

  it('calls the chokepoint with the patch trigger, device os/org and a count label', async () => {
    arrange();
    vi.mocked(buildRestorePointRequest).mockResolvedValue(null);
    vi.mocked(queueCommandForExecution).mockResolvedValue({ command: { id: 'cmd-1', status: 'sent' } } as any);

    const res = await install();

    expect(res.status).toBe(200);
    expect(buildRestorePointRequest).toHaveBeenCalledTimes(1);
    expect(buildRestorePointRequest).toHaveBeenCalledWith({
      deviceId: DEVICE_ID,
      orgId: ORG_ID,
      osType: 'windows',
      trigger: 'patch',
      label: 'install 1 update',
    });
  });

  it('pluralizes the label for multiple patches', async () => {
    const second = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    arrange([PATCH_ID, second]);
    vi.mocked(buildRestorePointRequest).mockResolvedValue(null);
    vi.mocked(queueCommandForExecution).mockResolvedValue({ command: { id: 'cmd-1', status: 'sent' } } as any);

    const res = await install([PATCH_ID, second]);

    expect(res.status).toBe(200);
    expect(vi.mocked(buildRestorePointRequest).mock.calls[0]?.[0]).toMatchObject({ label: 'install 2 updates' });
  });

  it('stamps the block on the payload, keeps category, and links the command', async () => {
    arrange();
    vi.mocked(buildRestorePointRequest).mockResolvedValue(BLOCK as any);
    vi.mocked(queueCommandForExecution).mockResolvedValue({ command: { id: 'cmd-rp-1', status: 'sent' } } as any);

    const res = await install();

    expect(res.status).toBe(200);
    const payload = vi.mocked(queueCommandForExecution).mock.calls[0]?.[2] as any;
    expect(payload.restorePoint).toEqual(BLOCK);
    expect(payload.patchIds).toEqual([PATCH_ID]);
    expect(payload.patches).toHaveLength(1);
    for (const ref of payload.patches) expect(ref).toHaveProperty('category', 'security');
    expect(linkRestorePointCommand).toHaveBeenCalledTimes(1);
    expect(linkRestorePointCommand).toHaveBeenCalledWith(BLOCK, 'cmd-rp-1');
    expect(discardRestorePointRequest).not.toHaveBeenCalled();
  });

  it('leaves the payload exactly as before (no restorePoint, no category) when the chokepoint returns null', async () => {
    arrange();
    vi.mocked(buildRestorePointRequest).mockResolvedValue(null);
    vi.mocked(queueCommandForExecution).mockResolvedValue({ command: { id: 'cmd-1', status: 'sent' } } as any);

    const res = await install();

    expect(res.status).toBe(200);
    const payload = vi.mocked(queueCommandForExecution).mock.calls[0]?.[2] as any;
    expect(payload).not.toHaveProperty('restorePoint');
    expect(Object.keys(payload).sort()).toEqual(['patchIds', 'patches']);
    for (const ref of payload.patches) expect(ref).not.toHaveProperty('category');
    expect(payload.patches).toEqual([{
      id: PATCH_ID,
      source: 'microsoft',
      externalId: 'KB5034441',
      packageId: null,
      title: 'Windows Security Update'
    }]);
  });

  it('returns 503 and does not queue when the chokepoint throws', async () => {
    arrange();
    vi.mocked(buildRestorePointRequest).mockRejectedValue(new Error('resolver down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await install();

    errSpy.mockRestore();
    expect(res.status).toBe(503);
    expect(queueCommandForExecution).not.toHaveBeenCalled();
    expect(linkRestorePointCommand).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalled();
  });

  it('discards the request when queueing returns no command', async () => {
    arrange();
    vi.mocked(buildRestorePointRequest).mockResolvedValue(BLOCK as any);
    vi.mocked(queueCommandForExecution).mockResolvedValue({ error: 'queue down' } as any);

    const res = await install();

    expect(res.status).toBe(503);
    expect(discardRestorePointRequest).toHaveBeenCalledTimes(1);
    expect(discardRestorePointRequest).toHaveBeenCalledWith(BLOCK);
    expect(linkRestorePointCommand).not.toHaveBeenCalled();
  });
});
