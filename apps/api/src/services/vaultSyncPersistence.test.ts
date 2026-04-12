import { beforeEach, describe, expect, it, vi } from 'vitest';

const VAULT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SNAPSHOT_DB_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEVICE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ORG_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'orderBy']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));
const updateWhereMock = vi.fn().mockResolvedValue(undefined);
const updateMock = vi.fn(() => ({
  set: vi.fn(() => ({
    where: updateWhereMock,
  })),
}));
const insertOnConflictMock = vi.fn().mockResolvedValue(undefined);
const insertMock = vi.fn(() => ({
  values: vi.fn(() => ({
    onConflictDoUpdate: insertOnConflictMock,
  })),
}));

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
  },

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  localVaults: {
    id: 'local_vaults.id',
    orgId: 'local_vaults.org_id',
    deviceId: 'local_vaults.device_id',
    vaultPath: 'local_vaults.vault_path',
    isActive: 'local_vaults.is_active',
    lastSyncAt: 'local_vaults.last_sync_at',
    lastSyncStatus: 'local_vaults.last_sync_status',
    lastSyncSnapshotId: 'local_vaults.last_sync_snapshot_id',
    syncSizeBytes: 'local_vaults.sync_size_bytes',
    lastSyncError: 'local_vaults.last_sync_error',
    updatedAt: 'local_vaults.updated_at',
  },
  backupSnapshots: {
    id: 'backup_snapshots.id',
    orgId: 'backup_snapshots.org_id',
    snapshotId: 'backup_snapshots.snapshot_id',
    deviceId: 'backup_snapshots.device_id',
    size: 'backup_snapshots.size',
    timestamp: 'backup_snapshots.timestamp',
  },
  vaultSnapshotInventory: {
    vaultId: 'vault_snapshot_inventory.vault_id',
    snapshotDbId: 'vault_snapshot_inventory.snapshot_db_id',
    orgId: 'vault_snapshot_inventory.org_id',
    externalSnapshotId: 'vault_snapshot_inventory.external_snapshot_id',
    syncedAt: 'vault_snapshot_inventory.synced_at',
    sizeBytes: 'vault_snapshot_inventory.size_bytes',
    fileCount: 'vault_snapshot_inventory.file_count',
    manifestVerified: 'vault_snapshot_inventory.manifest_verified',
    createdAt: 'vault_snapshot_inventory.created_at',
    updatedAt: 'vault_snapshot_inventory.updated_at',
  },
}));

import { applyVaultSyncCommandResult } from './vaultSyncPersistence';

describe('applyVaultSyncCommandResult', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates the vault row and upserts snapshot inventory for completed syncs', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([{ id: VAULT_ID, orgId: ORG_ID }]))
      .mockReturnValueOnce(
        chainMock([{ id: SNAPSHOT_DB_ID, orgId: ORG_ID, size: 2048 }])
      );

    await applyVaultSyncCommandResult({
      deviceId: DEVICE_ID,
      command: {
        payload: {
          vaultId: VAULT_ID,
          snapshotId: 'snap-ext-001',
        },
      },
      resultStatus: 'completed',
      stdout: JSON.stringify({
        vaultId: VAULT_ID,
        snapshotId: 'snap-ext-001',
        fileCount: 4,
        totalBytes: 4096,
        manifestVerified: true,
      }),
    });

    expect(updateMock).toHaveBeenCalled();
    expect(updateWhereMock).toHaveBeenCalled();
    expect(insertMock).toHaveBeenCalled();
    expect(insertOnConflictMock).toHaveBeenCalled();
  });

  it('updates the vault status without inventory for failed syncs', async () => {
    selectMock.mockReturnValueOnce(chainMock([{ id: VAULT_ID, orgId: ORG_ID }]));

    await applyVaultSyncCommandResult({
      deviceId: DEVICE_ID,
      command: {
        payload: {
          vaultId: VAULT_ID,
          snapshotId: 'snap-ext-002',
        },
      },
      resultStatus: 'failed',
      stderr: 'vault sync failed',
    });

    expect(updateMock).toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });
});
