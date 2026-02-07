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
    title: 'patches.title'
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
  queueCommand: vi.fn()
}));

import { db } from '../../db';
import { getDeviceWithOrgCheck } from './helpers';
import { queueCommand } from '../../services/commandQueue';

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

describe('device patch routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', patchesRoutes);
  });

  it('queues install_patches command with patch metadata', async () => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({ id: DEVICE_ID, orgId: '11111111-1111-1111-1111-111111111111' } as any);
    vi.mocked(db.select).mockReturnValueOnce(selectWhereResult([
      { id: PATCH_ID, source: 'linux', externalId: 'apt:openssl', title: 'OpenSSL' }
    ]) as any);
    vi.mocked(queueCommand).mockResolvedValue({ id: 'cmd-install-1' } as any);

    const res = await app.request(`/devices/${DEVICE_ID}/patches/install`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ patchIds: [PATCH_ID] })
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.commandId).toBe('cmd-install-1');
    expect(body.patchCount).toBe(1);

    expect(queueCommand).toHaveBeenCalledWith(
      DEVICE_ID,
      'install_patches',
      {
        patchIds: [PATCH_ID],
        patches: [{ id: PATCH_ID, source: 'linux', externalId: 'apt:openssl', title: 'OpenSSL' }]
      },
      USER_ID
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
    vi.mocked(queueCommand).mockResolvedValue({ id: 'cmd-rollback-1' } as any);

    const res = await app.request(`/devices/${DEVICE_ID}/patches/${PATCH_ID}/rollback`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.commandId).toBe('cmd-rollback-1');
    expect(body.patchId).toBe(PATCH_ID);

    expect(queueCommand).toHaveBeenCalledWith(
      DEVICE_ID,
      'rollback_patches',
      {
        patchIds: [PATCH_ID],
        patches: [{ id: PATCH_ID, source: 'apple', externalId: 'apple:example', title: 'Example Patch' }]
      },
      USER_ID
    );
  });
});
