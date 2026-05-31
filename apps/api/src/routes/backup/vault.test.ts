import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { vaultRoutes } from './vault';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const OTHER_DEVICE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const VAULT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';

vi.mock('../../services', () => ({}));

const queueCommandForExecutionMock = vi.fn();
const writeRouteAuditMock = vi.fn();

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));
const insertMock = vi.fn(() => chainMock([]));
const updateMock = vi.fn(() => chainMock([]));
let authState = {
  user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
  scope: 'organization' as const,
  partnerId: null,
  orgId: ORG_ID,
  token: { sub: 'user-123' },
};
let permissionsState: any;

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
}));

vi.mock('../../db/schema', () => ({
  localVaults: {
    id: 'local_vaults.id',
    orgId: 'local_vaults.org_id',
    deviceId: 'local_vaults.device_id',
    vaultPath: 'local_vaults.vault_path',
    vaultType: 'local_vaults.vault_type',
    isActive: 'local_vaults.is_active',
    retentionCount: 'local_vaults.retention_count',
    lastSyncAt: 'local_vaults.last_sync_at',
    lastSyncStatus: 'local_vaults.last_sync_status',
    lastSyncSnapshotId: 'local_vaults.last_sync_snapshot_id',
    syncSizeBytes: 'local_vaults.sync_size_bytes',
    lastSyncError: 'local_vaults.last_sync_error',
    createdAt: 'local_vaults.created_at',
    updatedAt: 'local_vaults.updated_at',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.org_id',
    siteId: 'devices.site_id',
  },
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: (...args: unknown[]) => writeRouteAuditMock(...(args as [])),
}));

vi.mock('../../services/commandQueue', () => ({
  queueCommandForExecution: (...args: unknown[]) => queueCommandForExecutionMock(...(args as [])),
  CommandTypes: {
    VAULT_SYNC: 'VAULT_SYNC',
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authState);
    if (permissionsState) {
      c.set('permissions', permissionsState);
    }
    return next();
  }),
  requirePermission: vi.fn(() => (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => (_c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
}));

import { authMiddleware } from '../../middleware/auth';

function makeVault(overrides: Record<string, unknown> = {}) {
  return {
    id: VAULT_ID,
    orgId: ORG_ID,
    deviceId: DEVICE_ID,
    vaultPath: 'D:/Backups/Vault',
    vaultType: 'local',
    isActive: true,
    retentionCount: 7,
    lastSyncAt: null,
    lastSyncStatus: null,
    lastSyncSnapshotId: null,
    syncSizeBytes: null,
    lastSyncError: null,
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
    updatedAt: new Date('2026-03-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('vault routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    selectMock.mockImplementation(() => chainMock([]));
    insertMock.mockReset();
    insertMock.mockImplementation(() => chainMock([]));
    updateMock.mockReset();
    updateMock.mockImplementation(() => chainMock([]));
    authState = {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: ORG_ID,
      token: { sub: 'user-123' },
    };
    permissionsState = undefined;
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', authState);
      if (permissionsState) {
        c.set('permissions', permissionsState);
      }
      return next();
    });
    app = new Hono();
    app.use('*', authMiddleware);
    app.route('/backup/vault', vaultRoutes);
  });

  it('returns an empty vault list', async () => {
    selectMock.mockReturnValueOnce(chainMock([]));

    const res = await app.request('/backup/vault', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
  });

  it('denies an explicit out-of-scope vault device filter for site-restricted users', async () => {
    permissionsState = { allowedSiteIds: [SITE_A] };
    selectMock.mockReturnValueOnce(chainMock([{ siteId: SITE_B }]));

    const res = await app.request(`/backup/vault?deviceId=${OTHER_DEVICE_ID}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Device not found or access denied' });
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('narrows vault lists to allowed device sites for site-restricted users', async () => {
    permissionsState = { allowedSiteIds: [SITE_A] };
    selectMock
      .mockReturnValueOnce(chainMock([
        { id: DEVICE_ID, siteId: SITE_A },
        { id: OTHER_DEVICE_ID, siteId: SITE_B },
      ]))
      .mockReturnValueOnce(chainMock([makeVault({ deviceId: DEVICE_ID })]));

    const res = await app.request('/backup/vault', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data.map((row: any) => row.deviceId)).toEqual([DEVICE_ID]);
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it('keeps unrestricted vault list behavior unchanged', async () => {
    selectMock.mockReturnValueOnce(chainMock([
      makeVault({ deviceId: DEVICE_ID }),
      makeVault({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', deviceId: OTHER_DEVICE_ID }),
    ]));

    const res = await app.request('/backup/vault', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data).toHaveLength(2);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('creates a vault config', async () => {
    insertMock.mockReturnValueOnce(chainMock([makeVault()]));

    const res = await app.request('/backup/vault', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        vaultPath: 'D:/Backups/Vault',
        vaultType: 'local',
        retentionCount: 7,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe(VAULT_ID);
    expect(body.vaultPath).toBe('D:/Backups/Vault');
  });

  it('updates a vault config', async () => {
    updateMock.mockReturnValueOnce(chainMock([makeVault({ vaultPath: 'E:/Vault' })]));

    const res = await app.request(`/backup/vault/${VAULT_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ vaultPath: 'E:/Vault' }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).vaultPath).toBe('E:/Vault');
  });

  it('deactivates a vault config', async () => {
    updateMock.mockReturnValueOnce(chainMock([makeVault({ isActive: false })]));

    const res = await app.request(`/backup/vault/${VAULT_ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, id: VAULT_ID });
  });

  it('dispatches a vault sync command', async () => {
    selectMock.mockReturnValueOnce(chainMock([makeVault()]));
    updateMock.mockReturnValueOnce(chainMock([]));
    queueCommandForExecutionMock.mockResolvedValueOnce(undefined);

    const res = await app.request(`/backup/vault/${VAULT_ID}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ snapshotId: 'snap-ext-001' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(VAULT_ID);
    expect(body.status).toBe('pending');
    expect(queueCommandForExecutionMock).toHaveBeenCalledWith(
      DEVICE_ID,
      'VAULT_SYNC',
      { vaultId: VAULT_ID, snapshotId: 'snap-ext-001' },
      expect.objectContaining({ userId: 'user-123' })
    );
  });

  it('should get vault status', async () => {
    selectMock.mockReturnValueOnce(chainMock([makeVault({
      lastSyncAt: new Date('2026-03-28T12:00:00.000Z'),
      lastSyncStatus: 'completed',
      lastSyncSnapshotId: 'snap-ext-001',
      syncSizeBytes: 1073741824,
      lastSyncError: null,
    })]));

    const res = await app.request(`/backup/vault/${VAULT_ID}/status`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(VAULT_ID);
    expect(body.deviceId).toBe(DEVICE_ID);
    expect(body.lastSyncError).toBeNull();
    expect(body.isActive).toBe(true);
    expect(body.lastSyncStatus).toBe('completed');
    expect(body.lastSyncSnapshotId).toBe('snap-ext-001');
    expect(body.syncSizeBytes).toBe(1073741824);
  });
});
