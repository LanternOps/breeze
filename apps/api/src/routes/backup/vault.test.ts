import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { vaultRoutes } from './vault';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const VAULT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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
    createdAt: 'local_vaults.created_at',
    updatedAt: 'local_vaults.updated_at',
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
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
    updatedAt: new Date('2026-03-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('vault routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    authState = {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: ORG_ID,
      token: { sub: 'user-123' },
    };
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', authState);
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
    })]));

    const res = await app.request(`/backup/vault/${VAULT_ID}/status`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(VAULT_ID);
    expect(body.deviceId).toBe(DEVICE_ID);
    expect(body.isActive).toBe(true);
    expect(body.lastSyncStatus).toBe('completed');
    expect(body.lastSyncSnapshotId).toBe('snap-ext-001');
    expect(body.syncSizeBytes).toBe(1073741824);
  });
});
