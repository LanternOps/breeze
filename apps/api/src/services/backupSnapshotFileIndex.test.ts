import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SNAPSHOT_DB_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const STORAGE_IDENTITY = 'local::/srv/backups';

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set', 'orderBy', 'leftJoin', 'innerJoin']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const { selectMock, insertMock, updateMock, deleteMock, transactionMock, resolveSnapshotProviderConfigMock } = vi.hoisted(() => ({
  selectMock: vi.fn<(...args: unknown[]) => any>(),
  insertMock: vi.fn<(...args: unknown[]) => any>(),
  updateMock: vi.fn<(...args: unknown[]) => any>(),
  deleteMock: vi.fn<(...args: unknown[]) => any>(),
  transactionMock: vi.fn<(cb: (tx: unknown) => unknown) => unknown>(),
  resolveSnapshotProviderConfigMock: vi.fn<(...args: unknown[]) => any>(),
}));

vi.mock('../db', () => {
  const tx = {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
    delete: (...args: unknown[]) => deleteMock(...(args as [])),
  };
  return {
    db: { ...tx, transaction: (cb: (t: typeof tx) => unknown) => transactionMock(cb as (t: unknown) => unknown) },
    runOutsideDbContext: vi.fn((fn: () => any) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
  };
});
vi.mock('./recoveryBootstrap', () => ({
  resolveSnapshotProviderConfig: (...args: unknown[]) => resolveSnapshotProviderConfigMock(...args),
  getStringValue: (record: Record<string, unknown> | null, key: string) =>
    record && typeof record[key] === 'string' ? String(record[key]) : null,
  asRecord: (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
}));

import { hydrateSnapshotFileIndex, readSnapshotFileIndexState } from './backupSnapshotFileIndex';

function snapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SNAPSHOT_DB_ID, orgId: ORG_ID, deviceId: DEVICE_ID, snapshotId: 'snap-current',
    jobId: 'job-1', configId: 'config-1', storageIdentity: STORAGE_IDENTITY,
    fileIndexStatus: 'none', fileIndexHydratedAt: null, referencedFiles: 5,
    ...overrides,
  };
}

function manifestBytes(entries: Array<{ sourcePath: string; backupPath: string; size?: number }>) {
  return Buffer.from(JSON.stringify({ id: 'snap-current', files: entries }), 'utf8');
}

beforeEach(() => {
  vi.clearAllMocks();
  selectMock.mockImplementation(() => chainMock([]));
  insertMock.mockImplementation(() => chainMock([]));
  updateMock.mockImplementation(() => chainMock([snapshotRow({ fileIndexStatus: 'hydrating' })]));
  deleteMock.mockImplementation(() => chainMock([]));
  transactionMock.mockImplementation(async (cb: any) => cb({
    select: selectMock, insert: insertMock, update: updateMock, delete: deleteMock,
  }));
  resolveSnapshotProviderConfigMock.mockResolvedValue({
    snapshot: snapshotRow(),
    config: null,
    providerType: 'local',
    providerConfig: { path: '/srv/backups' },
  });
});

describe('hydrateSnapshotFileIndex', () => {
  it('skips a snapshot with no referenced files (not_referenced)', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow({ referencedFiles: null })]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: null }]));
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID);
    expect(outcome).toEqual({ status: 'skipped', reason: 'not_referenced' });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('skips an already-complete index unless force is set', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow({ fileIndexStatus: 'complete' })]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID);
    expect(outcome).toEqual({ status: 'skipped', reason: 'already_complete' });
  });

  it('skips a fresh in-progress hydration (CAS 0 rows)', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow()]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    updateMock.mockReturnValueOnce(chainMock([])); // CAS matched 0 rows: lost the race
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID);
    expect(outcome).toEqual({ status: 'skipped', reason: 'in_progress' });
  });

  it('fails not-retryable when storage_identity is NULL', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow({ storageIdentity: null })]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID);
    expect(outcome).toMatchObject({ status: 'failed', failure: 'storage_identity_unknown', retryable: false });
  });

  it('fails not-retryable on storage identity drift', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow()]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    resolveSnapshotProviderConfigMock.mockResolvedValueOnce({
      snapshot: snapshotRow(), config: null, providerType: 'local', providerConfig: { path: '/different/root' },
    });
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID);
    expect(outcome).toMatchObject({ status: 'failed', failure: 'storage_identity_drift', retryable: false });
  });

  it('fails retryable when the manifest object is missing', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow()]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    const deps = { fetchManifestBytes: vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' })) };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'manifest_missing', retryable: true });
  });

  it('fails closed and names the bad key when a manifest entry has an unparseable backupPath', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow()]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    const deps = {
      fetchManifestBytes: vi.fn().mockResolvedValue(
        manifestBytes([{ sourcePath: '/a', backupPath: 'snapshots/snap-current/../x' }]),
      ),
    };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'manifest_key_invalid', retryable: false });
    expect((outcome as { reason: string }).reason).toContain('snapshots/snap-current/../x');
  });

  it('verifies an origin against a LIVE row on the same device/identity (provenance: live)', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([snapshotRow()])) // load snapshot
      .mockReturnValueOnce(chainMock([{ referencedFiles: 5 }])) // job.referencedFiles
      .mockReturnValueOnce(chainMock([{ // origin live row
        id: 'origin-db-id', orgId: ORG_ID, deviceId: DEVICE_ID, storageIdentity: STORAGE_IDENTITY,
        metadata: { storagePrefix: null },
      }]));
    const deps = {
      fetchManifestBytes: vi.fn().mockResolvedValue(
        manifestBytes([
          { sourcePath: '/a', backupPath: 'snapshots/snap-older/files/a.gz', size: 10 },
          { sourcePath: '/b', backupPath: 'snapshots/snap-current/files/b.gz', size: 20 },
        ]),
      ),
    };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'complete', entryCount: 2, externalCount: 1, originSnapshotIds: ['snap-older'] });
  });

  it('verifies an origin against a RETIREMENT record when the live row is gone (provenance: retired)', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([snapshotRow()]))
      .mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]))
      .mockReturnValueOnce(chainMock([])) // no live row
      .mockReturnValueOnce(chainMock([{ // retirement row
        orgId: ORG_ID, deviceId: DEVICE_ID, storageIdentity: STORAGE_IDENTITY, snapshotId: 'snap-older',
      }]));
    const deps = {
      fetchManifestBytes: vi.fn().mockResolvedValue(
        manifestBytes([{ sourcePath: '/a', backupPath: 'snapshots/snap-older/files/a.gz', size: 10 }]),
      ),
    };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'complete', externalCount: 1, originSnapshotIds: ['snap-older'] });
  });

  it('fails origin_identity_pending (retryable) when a live origin row exists but its storage_identity is NULL', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([snapshotRow()]))
      .mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]))
      .mockReturnValueOnce(chainMock([{ id: 'origin-db-id', orgId: ORG_ID, deviceId: DEVICE_ID, storageIdentity: null, metadata: {} }]))
      .mockReturnValueOnce(chainMock([])); // and no retirement either
    const deps = {
      fetchManifestBytes: vi.fn().mockResolvedValue(
        manifestBytes([{ sourcePath: '/a', backupPath: 'snapshots/snap-older/files/a.gz', size: 10 }]),
      ),
    };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'origin_identity_pending', retryable: true });
  });

  it('fails origin_unverifiable (not retryable) when the only live row is under a DIFFERENT org', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([snapshotRow()]))
      .mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]))
      .mockReturnValueOnce(chainMock([])) // the org/device-scoped live-row query returns nothing for THIS org
      .mockReturnValueOnce(chainMock([])); // and no retirement scoped to this org/device either
    const deps = {
      fetchManifestBytes: vi.fn().mockResolvedValue(
        manifestBytes([{ sourcePath: '/a', backupPath: 'snapshots/snap-older/files/a.gz', size: 10 }]),
      ),
    };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'origin_unverifiable', retryable: false });
  });

  it('writes rows in 1,000-row batches then publishes sha/counts/metadata in one final transaction', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([snapshotRow()]))
      .mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]))
      .mockReturnValueOnce(chainMock([{ id: 'origin-db-id', orgId: ORG_ID, deviceId: DEVICE_ID, storageIdentity: STORAGE_IDENTITY, metadata: {} }]));
    const entries = Array.from({ length: 1500 }, (_, i) => ({
      sourcePath: `/f${i}`, backupPath: `snapshots/snap-older/files/f${i}.gz`, size: 1,
    }));
    const bytes = manifestBytes(entries);
    const deps = { fetchManifestBytes: vi.fn().mockResolvedValue(bytes) };

    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });

    expect(outcome).toMatchObject({ status: 'complete', entryCount: 1500, externalCount: 1500 });
    expect((outcome as { manifestSha256: string }).manifestSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    // 2 batches of file rows (1000 + 500) + 1 final publish transaction.
    expect(transactionMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('on any hydration failure sets status failed with the reason, leaving whatever rows already wrote untouched', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow()]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    const deps = { fetchManifestBytes: vi.fn().mockResolvedValue(Buffer.from('not json')) };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'manifest_invalid' });
    // `db.update(table)` is called with the table; the payload goes to `.set()`.
    // Assert the LAST update chain carried the failed status + prefixed error.
    const lastUpdateChain = updateMock.mock.results.at(-1)!.value as { set: ReturnType<typeof vi.fn> };
    expect(lastUpdateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ fileIndexStatus: 'failed', fileIndexError: expect.stringMatching(/^manifest_invalid: /) }),
    );
    expect(outcome).toMatchObject({ retryable: false });
  });
});

describe('readSnapshotFileIndexState', () => {
  it('returns null for an unknown snapshot', async () => {
    selectMock.mockReturnValueOnce(chainMock([]));
    expect(await readSnapshotFileIndexState('missing')).toBeNull();
  });

  it('returns the index state fields for a known snapshot', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([{
        status: 'complete', manifestSha256: 'abc', externalCount: 3,
        error: null, jobId: 'job-1', storageIdentity: STORAGE_IDENTITY,
      }]))
      .mockReturnValueOnce(chainMock([{ referencedFiles: 3 }]))
      .mockReturnValueOnce(chainMock([{ originSnapshotId: 'snap-older' }]));
    const state = await readSnapshotFileIndexState(SNAPSHOT_DB_ID);
    expect(state).toMatchObject({ status: 'complete', manifestSha256: 'abc', externalCount: 3 });
  });
});
