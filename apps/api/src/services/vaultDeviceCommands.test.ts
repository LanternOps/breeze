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
    configId: 'backup_snapshots.config_id',
  },
  backupConfigs: {
    id: 'backup_configs.id',
    orgId: 'backup_configs.org_id',
    provider: 'backup_configs.provider',
    providerConfig: 'backup_configs.provider_config',
  },
}));

const resolveBackupProviderConfigMock = vi.fn();
vi.mock('./backupProviderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./backupProviderConfig')>()),
  resolveBackupProviderConfig: (...args: unknown[]) => resolveBackupProviderConfigMock(...(args as [])),
}));

import {
  applyVaultConfigureCommandResult,
  buildVaultConfigurePayload,
  resolveVaultSyncSource,
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

describe('resolveVaultSyncSource', () => {
  const CONFIG_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

  beforeEach(() => {
    selectMock.mockReset();
    resolveBackupProviderConfigMock.mockReset();
  });

  it("defaults to the device's newest file-backup snapshot, scoped to device and org", async () => {
    const chain = chainMock([{ snapshotId: 'snap-latest', configId: null }]);
    selectMock.mockReturnValueOnce(chain);

    expect(await resolveVaultSyncSource(DEVICE_ID, ORG_ID)).toEqual({
      ok: true, snapshotId: 'snap-latest', destination: null,
    });
    expect(renderSql(chain.where.mock.calls[0]![0])).toBe(
      `(backup_snapshots.device_id = ${DEVICE_ID} and backup_snapshots.org_id = ${ORG_ID} ` +
      `and (backup_snapshots.backup_type = file or backup_snapshots.backup_type is null))`,
    );
    expect(renderSql(chain.orderBy.mock.calls[0]![0])).toBe('backup_snapshots.timestamp desc');
  });

  it('looks a named snapshot up on this device in this org only', async () => {
    const chain = chainMock([{ snapshotId: 'snap-named', configId: null }]);
    selectMock.mockReturnValueOnce(chain);

    expect(await resolveVaultSyncSource(DEVICE_ID, ORG_ID, 'snap-named')).toMatchObject({ ok: true, snapshotId: 'snap-named' });
    expect(renderSql(chain.where.mock.calls[0]![0])).toBe(
      `(backup_snapshots.device_id = ${DEVICE_ID} and backup_snapshots.org_id = ${ORG_ID} ` +
      'and backup_snapshots.snapshot_id = snap-named)',
    );
  });

  // #11858: the device's policy-linked local destination is not the helper's
  // default store. The command names the destination the snapshot was
  // written to, by reference; delivery resolves it into the outgoing frame.
  it('names the local destination the snapshot was written to', async () => {
    selectMock.mockReturnValueOnce(chainMock([{ snapshotId: 'snap-dest', configId: CONFIG_ID }]));
    const configChain = chainMock([{ provider: 'local' }]);
    selectMock.mockReturnValueOnce(configChain);

    expect(await resolveVaultSyncSource(DEVICE_ID, ORG_ID)).toEqual({
      ok: true,
      snapshotId: 'snap-dest',
      destination: { provider: 'local', providerConfigRef: { configId: CONFIG_ID, orgId: ORG_ID } },
    });
    expect(renderSql(configChain.where.mock.calls[0]![0])).toBe(
      `(backup_configs.id = ${CONFIG_ID} and backup_configs.org_id = ${ORG_ID})`,
    );
  });

  // The request path needs only the provider: the destination itself is
  // resolved at delivery. Reading the whole config would decrypt its secrets
  // here for nothing.
  it("reads only the destination's provider, never its config", async () => {
    selectMock.mockReturnValueOnce(chainMock([{ snapshotId: 'snap-dest', configId: CONFIG_ID }]));
    selectMock.mockReturnValueOnce(chainMock([{ provider: 'local' }]));

    await resolveVaultSyncSource(DEVICE_ID, ORG_ID);

    expect(selectMock.mock.calls[1]).toEqual([{ provider: 'backup_configs.provider' }]);
    expect(resolveBackupProviderConfigMock).not.toHaveBeenCalled();
  });

  it('names no destination for a snapshot written before destinations were recorded (the helper reads its own store)', async () => {
    selectMock.mockReturnValueOnce(chainMock([{ snapshotId: 'snap-old', configId: null }]));

    expect(await resolveVaultSyncSource(DEVICE_ID, ORG_ID)).toEqual({ ok: true, snapshotId: 'snap-old', destination: null });
    expect(resolveBackupProviderConfigMock).not.toHaveBeenCalled();
  });

  it('names no destination for a storage destination, which is never sent to a device for a read', async () => {
    selectMock.mockReturnValueOnce(chainMock([{ snapshotId: 'snap-s3', configId: CONFIG_ID }]));
    selectMock.mockReturnValueOnce(chainMock([{ provider: 's3' }]));

    expect(await resolveVaultSyncSource(DEVICE_ID, ORG_ID)).toEqual({ ok: true, snapshotId: 'snap-s3', destination: null });
  });

  it('refuses when the destination the snapshot was written to no longer resolves in this org', async () => {
    selectMock.mockReturnValueOnce(chainMock([{ snapshotId: 'snap-gone', configId: CONFIG_ID }]));
    selectMock.mockReturnValueOnce(chainMock([]));

    expect(await resolveVaultSyncSource(DEVICE_ID, ORG_ID)).toEqual({
      ok: false, status: 422, error: 'Backup destination configuration not found for this snapshot',
    });
  });

  it('refuses when the device has no file-backup snapshot yet', async () => {
    selectMock.mockReturnValueOnce(chainMock([]));

    expect(await resolveVaultSyncSource(DEVICE_ID, ORG_ID)).toEqual({
      ok: false, status: 400, error: 'No backup snapshot to sync yet: run a file backup on this device first',
    });
  });

  it('refuses a named snapshot that is not this device\'s', async () => {
    selectMock.mockReturnValueOnce(chainMock([]));

    expect(await resolveVaultSyncSource(DEVICE_ID, ORG_ID, 'snap-elsewhere')).toEqual({
      ok: false, status: 404, error: 'Backup snapshot not found for this device',
    });
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
