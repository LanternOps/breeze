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
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn())
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

vi.mock('../../services/commandQueue', () => ({
  queueCommandForExecution: vi.fn()
}));

import { db } from '../../db';
import { getDeviceWithOrgAndSiteCheck } from './helpers';
import { queueCommandForExecution } from '../../services/commandQueue';
import { resolvePartnerIdForOrg } from '../patches/helpers';

function selectWhereResult(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
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
    vi.mocked(db.select).mockReturnValueOnce(selectWhereLimitResult([
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
});
