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

/**
 * Render a drizzle SQL fragment built over this file's string-stubbed columns
 * to text, so a test pins operators, literal values and sort direction, not
 * just which columns appear.
 */
function renderSql(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node !== 'object') return String(node);
  if (Array.isArray(node)) return node.map(renderSql).join('');
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(chunks)) return chunks.map(renderSql).join('');
  const value = (node as { value?: unknown }).value;
  return Array.isArray(value) ? value.join('') : renderSql(value);
}

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'orderBy']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));
const updateSetMock = vi.fn();
const updateWhereMock = vi.fn();
const updateMock = vi.fn(() => ({
  set: (...args: unknown[]) => {
    updateSetMock(...args);
    return { where: (...w: unknown[]) => { updateWhereMock(...w); return Promise.resolve([]); } };
  },
}));

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
  },
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
    lastSyncStatus: 'local_vaults.last_sync_status',
    lastSyncError: 'local_vaults.last_sync_error',
    updatedAt: 'local_vaults.updated_at',
  },
  backupSnapshots: {
    orgId: 'backup_snapshots.org_id',
    deviceId: 'backup_snapshots.device_id',
    snapshotId: 'backup_snapshots.snapshot_id',
    backupType: 'backup_snapshots.backup_type',
    timestamp: 'backup_snapshots.timestamp',
  },
}));

import {
  applyVaultConfigureCommandResult,
  buildVaultConfigurePayload,
  resolveLatestVaultSyncSnapshotId,
} from './vaultDeviceCommands';

describe('buildVaultConfigurePayload', () => {
  beforeEach(() => {
    selectMock.mockReset();
  });

  it("configures the device's newest active vault", async () => {
    const chain = chainMock([{ vaultPath: 'F:\\Backup\\Vault', retentionCount: 5 }]);
    selectMock.mockReturnValueOnce(chain);

    const payload = await buildVaultConfigurePayload(DEVICE_ID, ORG_ID);

    expect(payload).toEqual({ vaultPath: 'F:\\Backup\\Vault', retentionCount: 5, enabled: true });
    expect(renderSql(chain.where.mock.calls[0]![0])).toBe(
      `(local_vaults.device_id = ${DEVICE_ID} and local_vaults.org_id = ${ORG_ID} and local_vaults.is_active = true)`,
    );
    expect(renderSql(chain.orderBy.mock.calls[0]![0])).toBe('local_vaults.created_at desc');
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
    expect(renderSql(chain.where.mock.calls[0]![0])).toBe(
      `(backup_snapshots.device_id = ${DEVICE_ID} and backup_snapshots.org_id = ${ORG_ID} ` +
      `and (backup_snapshots.backup_type = file or backup_snapshots.backup_type is null))`,
    );
    expect(renderSql(chain.orderBy.mock.calls[0]![0])).toBe('backup_snapshots.timestamp desc');
  });

  it('returns null when the device has no file-backup snapshot', async () => {
    selectMock.mockReturnValueOnce(chainMock([]));

    expect(await resolveLatestVaultSyncSnapshotId(DEVICE_ID, ORG_ID)).toBeNull();
  });
});

// #8385: vault_configure now reaches the device. When the helper cannot apply
// it, the failure must show on the vault, not only in device_commands.
describe('applyVaultConfigureCommandResult', () => {
  beforeEach(() => {
    updateMock.mockClear();
    updateSetMock.mockClear();
    updateWhereMock.mockClear();
  });

  it('marks the configured vault failed with the agent error', async () => {
    await applyVaultConfigureCommandResult({
      deviceId: DEVICE_ID,
      command: { payload: { vaultPath: 'F:\\Backup\\Vault', retentionCount: 3, enabled: true } },
      resultStatus: 'failed',
      stderr: 'failed to initialize vault manager: failed to create vault directory: access denied',
    });

    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({
      lastSyncStatus: 'failed',
      lastSyncError: expect.stringContaining('access denied'),
    }));
    expect(renderSql(updateWhereMock.mock.calls[0]![0])).toBe(
      `(local_vaults.device_id = ${DEVICE_ID} and local_vaults.vault_path = F:\\Backup\\Vault and local_vaults.is_active = true)`,
    );
  });

  it('writes nothing for a successful configure', async () => {
    await applyVaultConfigureCommandResult({
      deviceId: DEVICE_ID,
      command: { payload: { vaultPath: 'F:\\Backup\\Vault', enabled: true } },
      resultStatus: 'completed',
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('writes nothing for a failed disable, which names no vault', async () => {
    await applyVaultConfigureCommandResult({
      deviceId: DEVICE_ID,
      command: { payload: { enabled: false } },
      resultStatus: 'failed',
      stderr: 'boom',
    });
    expect(updateMock).not.toHaveBeenCalled();
  });
});
