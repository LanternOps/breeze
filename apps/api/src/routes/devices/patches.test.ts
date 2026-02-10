import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { patchesRoutes } from './patches';

const DEVICE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PATCH_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

vi.mock('drizzle-orm', () => ({
  eq: (left: unknown, right: unknown) => ({ op: 'eq', left, right }),
  inArray: (left: unknown, right: unknown) => ({ op: 'inArray', left, right }),
  desc: (value: unknown) => ({ op: 'desc', value })
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
}));

vi.mock('../../db/schema', () => ({
  patches: {
    id: 'patches.id',
    source: 'patches.source',
    externalId: 'patches.externalId',
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
  }
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => {
    c.set('auth', {
      user: { id: USER_ID, email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: '11111111-1111-1111-1111-111111111111',
      partnerId: null
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c, next) => next())
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgCheck: vi.fn()
}));

vi.mock('../../services/commandQueue', () => ({
  queueCommandForExecution: vi.fn()
}));

import { db } from '../../db';
import { getDeviceWithOrgCheck } from './helpers';
import { queueCommandForExecution } from '../../services/commandQueue';

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

describe('device patch routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', patchesRoutes);
  });

  it('separates actionable pending patches from missing records', async () => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({ id: DEVICE_ID, orgId: '11111111-1111-1111-1111-111111111111' } as any);
    vi.mocked(db.select).mockReturnValueOnce(selectPatchStatusResult([
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
    expect(body.data.pending[0].externalId).toBe('apple:OS Update A:1.0.1');
    expect(body.data.pending[0].description).toBe('Pending update');

    expect(body.data.missing).toHaveLength(1);
    expect(body.data.missing[0].id).toBe('22222222-2222-4222-8222-222222222222');
    expect(body.data.missing[0].status).toBe('missing');

    expect(body.data.installed).toHaveLength(1);
    expect(body.data.compliancePercent).toBe(50);
  });

  it('queues install_patches command with patch metadata', async () => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({ id: DEVICE_ID, orgId: '11111111-1111-1111-1111-111111111111' } as any);
    vi.mocked(db.select).mockReturnValueOnce(selectWhereResult([
      { id: PATCH_ID, source: 'linux', externalId: 'apt:openssl', title: 'OpenSSL' }
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
        patches: [{ id: PATCH_ID, source: 'linux', externalId: 'apt:openssl', title: 'OpenSSL' }]
      },
      { userId: USER_ID, preferHeartbeat: false }
    );
  });

  it('returns 404 when install patch IDs do not resolve to patch records', async () => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({ id: DEVICE_ID, orgId: '11111111-1111-1111-1111-111111111111' } as any);
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

  it('queues rollback_patches command for a device patch', async () => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({ id: DEVICE_ID, orgId: '11111111-1111-1111-1111-111111111111' } as any);
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
