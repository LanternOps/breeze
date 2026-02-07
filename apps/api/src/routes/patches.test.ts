import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { patchRoutes } from './patches';

const ACCESSIBLE_ORG_ID = '11111111-1111-1111-1111-111111111111';
const BLOCKED_ORG_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';

const DEVICE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DEVICE_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const DEVICE_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const DEVICE_D = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const PATCH_ID = '44444444-4444-4444-4444-444444444444';

vi.mock('drizzle-orm', () => {
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })) as unknown;

  return {
    and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
    eq: (left: unknown, right: unknown) => ({ op: 'eq', left, right }),
    inArray: (left: unknown, right: unknown) => ({ op: 'inArray', left, right }),
    desc: (value: unknown) => ({ op: 'desc', value }),
    sql
  };
});

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  patches: {
    id: 'patches.id',
    source: 'patches.source',
    externalId: 'patches.externalId',
    title: 'patches.title',
    severity: 'patches.severity',
    category: 'patches.category',
    osTypes: 'patches.osTypes',
    releaseDate: 'patches.releaseDate',
    requiresReboot: 'patches.requiresReboot',
    downloadSizeMb: 'patches.downloadSizeMb',
    createdAt: 'patches.createdAt'
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    osType: 'devices.osType'
  },
  devicePatches: {
    deviceId: 'devicePatches.deviceId',
    patchId: 'devicePatches.patchId',
    status: 'devicePatches.status',
    lastCheckedAt: 'devicePatches.lastCheckedAt'
  },
  patchApprovals: {
    orgId: 'patchApprovals.orgId',
    patchId: 'patchApprovals.patchId',
    status: 'patchApprovals.status',
    createdAt: 'patchApprovals.createdAt'
  },
  patchJobs: {
    orgId: 'patchJobs.orgId',
    status: 'patchJobs.status',
    createdAt: 'patchJobs.createdAt'
  },
  patchRollbacks: {
    deviceId: 'patchRollbacks.deviceId',
    patchId: 'patchRollbacks.patchId',
    initiatedBy: 'patchRollbacks.initiatedBy',
    status: 'patchRollbacks.status',
    reason: 'patchRollbacks.reason'
  }
}));

vi.mock('../services/commandQueue', () => ({
  queueCommand: vi.fn()
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => {
    c.set('auth', {
      user: { id: USER_ID, email: 'test@example.com', name: 'Test User' },
      token: { sub: USER_ID, scope: 'organization', type: 'access' },
      scope: 'organization',
      orgId: ACCESSIBLE_ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ACCESSIBLE_ORG_ID],
      canAccessOrg: (orgId: string) => orgId === ACCESSIBLE_ORG_ID,
      orgCondition: () => ({ op: 'orgCondition' })
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c, next) => next())
}));

import { db } from '../db';
import { queueCommand } from '../services/commandQueue';

function selectWhereResult(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows)
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

function selectPatchListResult(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            offset: vi.fn().mockResolvedValue(rows)
          })
        })
      })
    })
  };
}

describe('patch routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/patches', patchRoutes);
  });

  it('queues patch scans in parallel and reports skipped/missing devices', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectWhereResult([
      { id: DEVICE_A, orgId: ACCESSIBLE_ORG_ID },
      { id: DEVICE_B, orgId: BLOCKED_ORG_ID },
      { id: DEVICE_C, orgId: ACCESSIBLE_ORG_ID }
    ]) as any);

    vi.mocked(queueCommand).mockImplementation(async (deviceId: string) => {
      if (deviceId === DEVICE_C) {
        throw new Error('queue failure');
      }
      return { id: `cmd-${deviceId}` } as any;
    });

    const res = await app.request('/patches/scan', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceIds: [DEVICE_A, DEVICE_B, DEVICE_C, DEVICE_D],
        source: 'apple'
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(false);
    expect(body.deviceCount).toBe(2);
    expect(body.queuedCommandIds).toEqual([`cmd-${DEVICE_A}`]);
    expect(body.failedDeviceIds).toEqual([DEVICE_C]);
    expect(body.skipped.missingDeviceIds).toEqual([DEVICE_D]);
    expect(body.skipped.inaccessibleDeviceIds).toEqual([DEVICE_B]);

    expect(queueCommand).toHaveBeenCalledTimes(2);
    expect(queueCommand).toHaveBeenCalledWith(DEVICE_A, 'patch_scan', { source: 'apple' }, USER_ID);
  });

  it('infers patch os from source when osTypes is missing', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectPatchListResult([
        {
          id: PATCH_ID,
          title: 'Safari Update',
          description: null,
          source: 'apple',
          severity: 'important',
          category: 'system',
          osTypes: null,
          inferredOs: null,
          releaseDate: null,
          requiresReboot: false,
          downloadSizeMb: null,
          createdAt: new Date('2026-02-07T00:00:00.000Z')
        }
      ]) as any)
      .mockReturnValueOnce(selectWhereResult([{ count: 1 }]) as any);

    const res = await app.request('/patches', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].os).toBe('macos');
  });

  it('infers patch os from associated device when source is third_party', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectPatchListResult([
        {
          id: PATCH_ID,
          title: 'Google Chrome',
          description: null,
          source: 'third_party',
          severity: 'important',
          category: 'application',
          osTypes: null,
          inferredOs: 'macos',
          releaseDate: null,
          requiresReboot: false,
          downloadSizeMb: null,
          createdAt: new Date('2026-02-07T00:00:00.000Z')
        }
      ]) as any)
      .mockReturnValueOnce(selectWhereResult([{ count: 1 }]) as any);

    const res = await app.request('/patches', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].os).toBe('macos');
  });

  it('returns compliance summary using joined patch filters', async () => {
    const groupBy = vi.fn().mockResolvedValue([
      { status: 'installed', count: 6 },
      { status: 'pending', count: 2 },
      { status: 'failed', count: 1 }
    ]);
    const where = vi.fn().mockReturnValue({ groupBy });
    const innerJoin = vi.fn().mockReturnValue({ where });

    vi.mocked(db.select)
      .mockReturnValueOnce(selectWhereResult([{ id: DEVICE_A }, { id: DEVICE_C }]) as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin
        })
      } as any);

    const res = await app.request(`/patches/compliance?orgId=${ACCESSIBLE_ORG_ID}&source=apple&severity=critical`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(innerJoin).toHaveBeenCalledTimes(1);
    expect(body.data.summary.total).toBe(9);
    expect(body.data.summary.installed).toBe(6);
    expect(body.data.summary.pending).toBe(2);
    expect(body.data.summary.failed).toBe(1);
    expect(body.data.filters).toEqual({ source: 'apple', severity: 'critical' });
  });

  it('queues rollback commands for accessible devices', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectWhereLimitResult([
        {
          id: PATCH_ID,
          source: 'apple',
          externalId: 'apple:example-patch',
          title: 'Example Patch'
        }
      ]) as any)
      .mockReturnValueOnce(selectWhereResult([
        { id: DEVICE_A, orgId: ACCESSIBLE_ORG_ID },
        { id: DEVICE_B, orgId: BLOCKED_ORG_ID }
      ]) as any);

    vi.mocked(queueCommand).mockResolvedValue({ id: 'cmd-rollback-1' } as any);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined)
    } as any);

    const res = await app.request(`/patches/${PATCH_ID}/rollback`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reason: 'Rollback validation',
        scheduleType: 'immediate',
        deviceIds: [DEVICE_A, DEVICE_B, DEVICE_D]
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.patchId).toBe(PATCH_ID);
    expect(body.deviceCount).toBe(1);
    expect(body.queuedCommandIds).toEqual(['cmd-rollback-1']);
    expect(body.skipped.inaccessibleDeviceIds).toEqual([DEVICE_B]);
    expect(body.skipped.missingDeviceIds).toEqual([DEVICE_D]);

    expect(queueCommand).toHaveBeenCalledWith(
      DEVICE_A,
      'rollback_patches',
      {
        patchIds: [PATCH_ID],
        patches: [
          {
            id: PATCH_ID,
            source: 'apple',
            externalId: 'apple:example-patch',
            title: 'Example Patch'
          }
        ],
        reason: 'Rollback validation'
      },
      USER_ID
    );
  });

  it('rejects scheduled rollback until scheduler support is implemented', async () => {
    const res = await app.request(`/patches/${PATCH_ID}/rollback`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scheduleType: 'scheduled',
        scheduledTime: '2026-02-08T12:00:00.000Z'
      })
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Scheduled rollback');
  });
});
