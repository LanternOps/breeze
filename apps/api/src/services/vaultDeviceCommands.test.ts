import { beforeEach, describe, expect, it, vi } from 'vitest';

const DEVICE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ORG_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** The string operands drizzle placed into a predicate (column names + values). */
function predicateOperands(node: unknown, acc: string[] = []): string[] {
  if (typeof node === 'string') {
    acc.push(node);
    return acc;
  }
  if (node === null || typeof node !== 'object') return acc;
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(chunks)) for (const chunk of chunks) predicateOperands(chunk, acc);
  return acc;
}

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'orderBy']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));

vi.mock('../db', () => ({
  db: { select: (...args: unknown[]) => selectMock(...(args as [])) },
}));

vi.mock('../db/schema', () => ({
  localVaults: {
    id: 'local_vaults.id',
    orgId: 'local_vaults.org_id',
    deviceId: 'local_vaults.device_id',
    vaultPath: 'local_vaults.vault_path',
    isActive: 'local_vaults.is_active',
    retentionCount: 'local_vaults.retention_count',
    createdAt: 'local_vaults.created_at',
  },
  backupSnapshots: {
    orgId: 'backup_snapshots.org_id',
    deviceId: 'backup_snapshots.device_id',
    snapshotId: 'backup_snapshots.snapshot_id',
    backupType: 'backup_snapshots.backup_type',
    timestamp: 'backup_snapshots.timestamp',
  },
}));

import { buildVaultConfigurePayload, resolveLatestVaultSyncSnapshotId } from './vaultDeviceCommands';

describe('buildVaultConfigurePayload', () => {
  beforeEach(() => {
    selectMock.mockReset();
  });

  it("configures the device's newest active vault", async () => {
    const chain = chainMock([{ vaultPath: 'F:\\Backup\\Vault', retentionCount: 5 }]);
    selectMock.mockReturnValueOnce(chain);

    const payload = await buildVaultConfigurePayload(DEVICE_ID, ORG_ID);

    expect(payload).toEqual({ vaultPath: 'F:\\Backup\\Vault', retentionCount: 5, enabled: true });
    const operands = predicateOperands(chain.where.mock.calls[0]![0]);
    expect(operands).toEqual(expect.arrayContaining([
      'local_vaults.device_id', DEVICE_ID,
      'local_vaults.org_id', ORG_ID,
      'local_vaults.is_active',
    ]));
    expect(chain.orderBy).toHaveBeenCalledTimes(1);
  });

  it('disables the vault on the device when it has no active vault left', async () => {
    selectMock.mockReturnValueOnce(chainMock([]));

    expect(await buildVaultConfigurePayload(DEVICE_ID, ORG_ID)).toEqual({ enabled: false });
  });
});

describe('resolveLatestVaultSyncSnapshotId', () => {
  beforeEach(() => {
    selectMock.mockReset();
  });

  it("returns the device's newest file-backup snapshot id, scoped to device and org", async () => {
    const chain = chainMock([{ snapshotId: 'snap-latest' }]);
    selectMock.mockReturnValueOnce(chain);

    expect(await resolveLatestVaultSyncSnapshotId(DEVICE_ID, ORG_ID)).toBe('snap-latest');
    const operands = predicateOperands(chain.where.mock.calls[0]![0]);
    expect(operands).toEqual(expect.arrayContaining([
      'backup_snapshots.device_id', DEVICE_ID,
      'backup_snapshots.org_id', ORG_ID,
      'backup_snapshots.backup_type',
    ]));
    expect(chain.orderBy).toHaveBeenCalledTimes(1);
  });

  it('returns null when the device has no file-backup snapshot', async () => {
    selectMock.mockReturnValueOnce(chainMock([]));

    expect(await resolveLatestVaultSyncSnapshotId(DEVICE_ID, ORG_ID)).toBeNull();
  });
});
