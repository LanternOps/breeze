import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_ORG_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CONFIG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/**
 * A drizzle chain stand-in: every builder method returns the same
 * promise-shaped object, so `.from(...).where(...).limit(1)` and a bare
 * `.from(...)` both await to the same rows.
 */
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
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
}));

vi.mock('../db/schema', () => ({
  backupConfigs: {
    id: 'backup_configs.id',
    orgId: 'backup_configs.org_id',
    provider: 'backup_configs.provider',
    providerConfig: 'backup_configs.provider_config',
  },
  backupJobs: {
    id: 'backup_jobs.id',
    orgId: 'backup_jobs.org_id',
    deviceId: 'backup_jobs.device_id',
    configId: 'backup_jobs.config_id',
    status: 'backup_jobs.status',
    snapshotId: 'backup_jobs.snapshot_id',
    startedAt: 'backup_jobs.started_at',
    completedAt: 'backup_jobs.completed_at',
    createdAt: 'backup_jobs.created_at',
  },
  backupSnapshots: {
    jobId: 'backup_snapshots.job_id',
    orgId: 'backup_snapshots.org_id',
    snapshotId: 'backup_snapshots.snapshot_id',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  eq: (a: unknown, b: unknown) => ({ op: 'eq', a, b }),
  inArray: (a: unknown, b: unknown) => ({ op: 'inArray', a, b }),
  isNull: (a: unknown) => ({ op: 'isNull', a }),
}));

vi.mock('../jobs/backupRetention', () => ({
  // Faithful enough for these tests: identity is provider + endpoint + bucket
  // (or local path), deliberately excluding any configured prefix.
  normalizeStorageIdentity: (provider: string, cfg: Record<string, unknown>) =>
    `${provider}::${cfg.endpoint ?? ''}::${cfg.bucket ?? cfg.path ?? ''}`,
}));

const listBackupObjectsUnderPrefixMock = vi.fn();
const fetchBackupObjectTextMock = vi.fn();
vi.mock('./backupSnapshotStorage', () => ({
  BACKUP_SNAPSHOT_ROOT_DIR: 'snapshots',
  BACKUP_SNAPSHOT_MANIFEST_KEY: 'manifest.json',
  backupSnapshotRootPrefix: () => 'snapshots',
  backupSnapshotManifestKey: (id: string) => `snapshots/${id}/manifest.json`,
  listBackupObjectsUnderPrefix: (...args: unknown[]) =>
    listBackupObjectsUnderPrefixMock(...(args as [])),
  fetchBackupObjectText: (...args: unknown[]) => fetchBackupObjectTextMock(...(args as [])),
}));

const applyBackupCommandResultToJobMock = vi.fn();
vi.mock('./backupResultPersistence', () => ({
  applyBackupCommandResultToJob: (...args: unknown[]) =>
    applyBackupCommandResultToJobMock(...(args as [])),
}));

import {
  BackupReconcileError,
  reconcileOrphanedBackupSnapshots,
} from './backupSnapshotReconcile';

const CONFIG_ROW = {
  id: CONFIG_ID,
  provider: 's3',
  providerConfig: { bucket: 'customer-bucket', endpoint: '', accessKey: 'AK', secretKey: 'SK' },
};

function manifest(snapshotId: string, files = 2) {
  return JSON.stringify({
    id: snapshotId,
    timestamp: '2026-08-01T10:15:00Z',
    size: 300,
    files: Array.from({ length: files }, (_, i) => ({
      sourcePath: `C:/data/file-${i}.txt`,
      backupPath: `snapshots/${snapshotId}/files/path_0/file-${i}.txt.gz`,
      size: 150,
      modTime: '2026-08-01T09:00:00-07:00',
    })),
  });
}

/**
 * Queue the `db.select()` results in the order the service issues them:
 *  1. the caller's backup_configs row
 *  2. backup_snapshots claim lookup   (system scope, skipped when no snapshots)
 *  3. backup_jobs claim lookup        (system scope, skipped when no snapshots)
 *  4. every backup_configs row        (system scope, shared-destination check)
 *  5. unattributed backup_jobs        (lazy — only if a time-window candidate exists)
 *  6. backup_snapshots rows for those jobs
 */
function queueSelects(rowSets: unknown[][]) {
  selectMock.mockReset();
  for (const rows of rowSets) {
    selectMock.mockReturnValueOnce(chainMock(rows) as any);
  }
  selectMock.mockImplementation(() => chainMock([]) as any);
}

describe('reconcileOrphanedBackupSnapshots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listBackupObjectsUnderPrefixMock.mockReset();
    fetchBackupObjectTextMock.mockReset();
    applyBackupCommandResultToJobMock.mockReset();
    applyBackupCommandResultToJobMock.mockResolvedValue({
      applied: true,
      snapshotDbId: 'snap-db-1',
      providerSnapshotId: 'x',
    });
  });

  it('refuses a config the caller org does not own', async () => {
    queueSelects([[]]);

    await expect(
      reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID })
    ).rejects.toMatchObject({ code: 'config_not_found' });
    expect(listBackupObjectsUnderPrefixMock).not.toHaveBeenCalled();
  });

  it('rejects a provider that cannot be enumerated', async () => {
    queueSelects([[{ ...CONFIG_ROW, provider: 'azure_blob' }]]);

    await expect(
      reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID })
    ).rejects.toBeInstanceOf(BackupReconcileError);
    expect(listBackupObjectsUnderPrefixMock).not.toHaveBeenCalled();
  });

  it('adopts a snapshot the job already recorded mid-run', async () => {
    listBackupObjectsUnderPrefixMock.mockResolvedValue([
      { key: 'snapshots/snap-1/manifest.json', lastModified: new Date('2026-08-01T10:20:00Z') },
      { key: 'snapshots/snap-1/files/a.gz', lastModified: new Date('2026-08-01T10:19:00Z') },
    ]);
    fetchBackupObjectTextMock.mockResolvedValue(manifest('snap-1'));
    queueSelects([
      [CONFIG_ROW],
      [], // no backup_snapshots row → not restorable yet
      [{ id: 'job-1', orgId: ORG_ID, deviceId: DEVICE_ID, status: 'failed', snapshotId: 'snap-1' }],
      [{ orgId: ORG_ID, provider: 's3', providerConfig: CONFIG_ROW.providerConfig }],
    ]);

    const result = await reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID });

    expect(result.snapshotsInStorage).toBe(1);
    expect(result.adopted).toBe(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      snapshotId: 'snap-1',
      matchedBy: 'job-snapshot-id',
      jobId: 'job-1',
      adopted: true,
      fileCount: 2,
      size: 300,
    });

    expect(applyBackupCommandResultToJobMock).toHaveBeenCalledTimes(1);
    const call = applyBackupCommandResultToJobMock.mock.calls[0]![0];
    expect(call).toMatchObject({
      jobId: 'job-1',
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      resultStatus: 'completed',
      source: 'reconcile',
    });
    expect(call.result.snapshot.files).toHaveLength(2);
    expect(call.result.metadata.storagePrefix).toBe('snapshots/snap-1');
  });

  // --- cross-tenant negatives ------------------------------------------------

  it('refuses to adopt a snapshot recorded by ANOTHER org\u2019s job', async () => {
    listBackupObjectsUnderPrefixMock.mockResolvedValue([
      { key: 'snapshots/snap-1/manifest.json', lastModified: new Date('2026-08-01T10:20:00Z') },
    ]);
    queueSelects([
      [CONFIG_ROW],
      [],
      // Visible only because the claim lookup runs in a system db context —
      // under the caller's own RLS this row would be invisible and the
      // snapshot would look unclaimed.
      [
        {
          id: 'job-other',
          orgId: OTHER_ORG_ID,
          deviceId: 'device-other',
          status: 'failed',
          snapshotId: 'snap-1',
        },
      ],
      [{ orgId: ORG_ID, provider: 's3', providerConfig: CONFIG_ROW.providerConfig }],
    ]);

    const result = await reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID });

    expect(result.adopted).toBe(0);
    expect(result.candidates[0]).toMatchObject({
      snapshotId: 'snap-1',
      skipReason: 'claimed-by-another-organization',
      jobId: null,
      adopted: false,
    });
    expect(applyBackupCommandResultToJobMock).not.toHaveBeenCalled();
    expect(fetchBackupObjectTextMock).not.toHaveBeenCalled();
  });

  it('refuses to re-adopt a snapshot that is already ANOTHER org\u2019s restore point', async () => {
    listBackupObjectsUnderPrefixMock.mockResolvedValue([
      { key: 'snapshots/snap-1/manifest.json', lastModified: new Date('2026-08-01T10:20:00Z') },
    ]);
    queueSelects([
      [CONFIG_ROW],
      [{ snapshotId: 'snap-1', orgId: OTHER_ORG_ID }],
      [],
      [{ orgId: ORG_ID, provider: 's3', providerConfig: CONFIG_ROW.providerConfig }],
    ]);

    const result = await reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID });

    expect(result.candidates[0]).toMatchObject({
      skipReason: 'claimed-by-another-organization',
      adopted: false,
    });
    expect(applyBackupCommandResultToJobMock).not.toHaveBeenCalled();
  });

  it('disables time-window matching when another org targets the same bucket', async () => {
    listBackupObjectsUnderPrefixMock.mockResolvedValue([
      { key: 'snapshots/snap-1/manifest.json', lastModified: new Date('2026-08-01T10:20:00Z') },
    ]);
    queueSelects([
      [CONFIG_ROW],
      [],
      [], // unclaimed by any job anywhere
      [
        { orgId: ORG_ID, provider: 's3', providerConfig: CONFIG_ROW.providerConfig },
        // Same bucket + endpoint, different tenant.
        {
          orgId: OTHER_ORG_ID,
          provider: 's3',
          providerConfig: { bucket: 'customer-bucket', endpoint: '', prefix: 'other' },
        },
      ],
    ]);

    const result = await reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID });

    expect(result.sharedDestination).toBe(true);
    expect(result.candidates[0]).toMatchObject({
      skipReason: 'shared-destination-ambiguous',
      adopted: false,
    });
    expect(applyBackupCommandResultToJobMock).not.toHaveBeenCalled();
    // The job lookup must not even run — nothing is attributable.
    expect(selectMock).toHaveBeenCalledTimes(4);
  });

  it('does not adopt onto a device outside a site-restricted caller\u2019s sites', async () => {
    listBackupObjectsUnderPrefixMock.mockResolvedValue([
      { key: 'snapshots/snap-1/manifest.json', lastModified: new Date('2026-08-01T10:20:00Z') },
    ]);
    queueSelects([
      [CONFIG_ROW],
      [],
      [{ id: 'job-1', orgId: ORG_ID, deviceId: DEVICE_ID, status: 'failed', snapshotId: 'snap-1' }],
      [{ orgId: ORG_ID, provider: 's3', providerConfig: CONFIG_ROW.providerConfig }],
    ]);

    const result = await reconcileOrphanedBackupSnapshots({
      orgId: ORG_ID,
      configId: CONFIG_ID,
      allowedDeviceIds: ['some-other-device'],
    });

    expect(result.adopted).toBe(0);
    expect(result.candidates[0]!.skipReason).toBe('no-matching-job');
    expect(applyBackupCommandResultToJobMock).not.toHaveBeenCalled();
  });

  // --- time-window attribution ----------------------------------------------

  it('adopts an unclaimed snapshot into the single job whose run window covers it', async () => {
    listBackupObjectsUnderPrefixMock.mockResolvedValue([
      { key: 'snapshots/snap-legacy/manifest.json', lastModified: new Date('2026-08-01T10:20:00Z') },
    ]);
    fetchBackupObjectTextMock.mockResolvedValue(manifest('snap-legacy', 3));
    queueSelects([
      [CONFIG_ROW],
      [],
      [],
      [{ orgId: ORG_ID, provider: 's3', providerConfig: CONFIG_ROW.providerConfig }],
      [
        {
          id: 'job-legacy',
          deviceId: DEVICE_ID,
          startedAt: new Date('2026-08-01T08:00:00Z'),
          completedAt: new Date('2026-08-01T11:00:00Z'),
          createdAt: new Date('2026-08-01T08:00:00Z'),
        },
      ],
      [], // none of those jobs already own a restore point
    ]);

    const result = await reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID });

    expect(result.adopted).toBe(1);
    expect(result.candidates[0]).toMatchObject({
      matchedBy: 'time-window',
      jobId: 'job-legacy',
      adopted: true,
      fileCount: 3,
    });
  });

  it('refuses to guess when two jobs could have produced the snapshot', async () => {
    listBackupObjectsUnderPrefixMock.mockResolvedValue([
      { key: 'snapshots/snap-legacy/manifest.json', lastModified: new Date('2026-08-01T10:20:00Z') },
    ]);
    queueSelects([
      [CONFIG_ROW],
      [],
      [],
      [{ orgId: ORG_ID, provider: 's3', providerConfig: CONFIG_ROW.providerConfig }],
      [
        {
          id: 'job-a',
          deviceId: DEVICE_ID,
          startedAt: new Date('2026-08-01T08:00:00Z'),
          completedAt: new Date('2026-08-01T11:00:00Z'),
          createdAt: new Date('2026-08-01T08:00:00Z'),
        },
        {
          id: 'job-b',
          deviceId: 'device-2',
          startedAt: new Date('2026-08-01T09:00:00Z'),
          completedAt: new Date('2026-08-01T12:00:00Z'),
          createdAt: new Date('2026-08-01T09:00:00Z'),
        },
      ],
      [],
    ]);

    const result = await reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID });

    expect(result.candidates[0]!.skipReason).toBe('ambiguous-job-match');
    expect(applyBackupCommandResultToJobMock).not.toHaveBeenCalled();
  });

  it('skips a snapshot written outside every job window', async () => {
    listBackupObjectsUnderPrefixMock.mockResolvedValue([
      { key: 'snapshots/snap-legacy/manifest.json', lastModified: new Date('2026-08-01T10:20:00Z') },
    ]);
    queueSelects([
      [CONFIG_ROW],
      [],
      [],
      [{ orgId: ORG_ID, provider: 's3', providerConfig: CONFIG_ROW.providerConfig }],
      [
        {
          id: 'job-old',
          deviceId: DEVICE_ID,
          startedAt: new Date('2026-07-01T08:00:00Z'),
          completedAt: new Date('2026-07-01T09:00:00Z'),
          createdAt: new Date('2026-07-01T08:00:00Z'),
        },
      ],
      [],
    ]);

    const result = await reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID });

    expect(result.candidates[0]!.skipReason).toBe('no-matching-job');
  });

  // --- listing hygiene, dry run, limits, manifest integrity -----------------

  it('ignores prefixes with no manifest and nested manifest.json objects', async () => {
    listBackupObjectsUnderPrefixMock.mockResolvedValue([
      // In-flight/abandoned upload: no manifest yet.
      { key: 'snapshots/snap-partial/files/a.gz', lastModified: new Date('2026-08-01T10:00:00Z') },
      // Customer data that merely happens to be called manifest.json.
      {
        key: 'snapshots/snap-1/files/path_0/manifest.json',
        lastModified: new Date('2026-08-01T10:00:00Z'),
      },
    ]);
    queueSelects([[CONFIG_ROW], [{ orgId: ORG_ID, provider: 's3', providerConfig: CONFIG_ROW.providerConfig }]]);

    const result = await reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID });

    expect(result.snapshotsInStorage).toBe(0);
    expect(result.candidates).toEqual([]);
  });

  it('reports what a dry run would adopt without writing anything', async () => {
    listBackupObjectsUnderPrefixMock.mockResolvedValue([
      { key: 'snapshots/snap-1/manifest.json', lastModified: new Date('2026-08-01T10:20:00Z') },
    ]);
    fetchBackupObjectTextMock.mockResolvedValue(manifest('snap-1'));
    queueSelects([
      [CONFIG_ROW],
      [],
      [{ id: 'job-1', orgId: ORG_ID, deviceId: DEVICE_ID, status: 'failed', snapshotId: 'snap-1' }],
      [{ orgId: ORG_ID, provider: 's3', providerConfig: CONFIG_ROW.providerConfig }],
    ]);

    const result = await reconcileOrphanedBackupSnapshots({
      orgId: ORG_ID,
      configId: CONFIG_ID,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.adopted).toBe(0);
    expect(result.candidates[0]).toMatchObject({ jobId: 'job-1', fileCount: 2, adopted: false });
    expect(applyBackupCommandResultToJobMock).not.toHaveBeenCalled();
  });

  it('caps adoptions at the per-call limit and reports the remainder', async () => {
    listBackupObjectsUnderPrefixMock.mockResolvedValue([
      { key: 'snapshots/snap-1/manifest.json', lastModified: new Date('2026-08-01T10:00:00Z') },
      { key: 'snapshots/snap-2/manifest.json', lastModified: new Date('2026-08-01T11:00:00Z') },
    ]);
    fetchBackupObjectTextMock.mockImplementation((input: any) =>
      Promise.resolve(manifest(input.key.split('/')[1]))
    );
    queueSelects([
      [CONFIG_ROW],
      [],
      [
        { id: 'job-1', orgId: ORG_ID, deviceId: DEVICE_ID, status: 'failed', snapshotId: 'snap-1' },
        { id: 'job-2', orgId: ORG_ID, deviceId: DEVICE_ID, status: 'failed', snapshotId: 'snap-2' },
      ],
      [{ orgId: ORG_ID, provider: 's3', providerConfig: CONFIG_ROW.providerConfig }],
    ]);

    const result = await reconcileOrphanedBackupSnapshots({
      orgId: ORG_ID,
      configId: CONFIG_ID,
      limit: 1,
    });

    expect(result.adopted).toBe(1);
    expect(result.remaining).toBe(1);
    expect(applyBackupCommandResultToJobMock).toHaveBeenCalledTimes(1);
    // Oldest-written first, so snap-1 is the one adopted.
    expect(applyBackupCommandResultToJobMock.mock.calls[0]![0].jobId).toBe('job-1');
    expect(result.candidates.find((c) => c.snapshotId === 'snap-2')!.skipReason).toBe('limit-reached');
  });

  it('refuses a manifest that declares a different snapshot id', async () => {
    listBackupObjectsUnderPrefixMock.mockResolvedValue([
      { key: 'snapshots/snap-1/manifest.json', lastModified: new Date('2026-08-01T10:20:00Z') },
    ]);
    fetchBackupObjectTextMock.mockResolvedValue(manifest('snap-somewhere-else'));
    queueSelects([
      [CONFIG_ROW],
      [],
      [{ id: 'job-1', orgId: ORG_ID, deviceId: DEVICE_ID, status: 'failed', snapshotId: 'snap-1' }],
      [{ orgId: ORG_ID, provider: 's3', providerConfig: CONFIG_ROW.providerConfig }],
    ]);

    const result = await reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID });

    expect(result.adopted).toBe(0);
    expect(result.candidates[0]!.skipReason).toBe('manifest-unreadable');
    expect(result.candidates[0]!.error).toContain('snap-somewhere-else');
    expect(applyBackupCommandResultToJobMock).not.toHaveBeenCalled();
  });

  it('drops an unparseable file mtime instead of failing the whole adoption', async () => {
    listBackupObjectsUnderPrefixMock.mockResolvedValue([
      { key: 'snapshots/snap-1/manifest.json', lastModified: new Date('2026-08-01T10:20:00Z') },
    ]);
    fetchBackupObjectTextMock.mockResolvedValue(
      JSON.stringify({
        id: 'snap-1',
        timestamp: '2026-08-01T10:15:00Z',
        files: [
          { sourcePath: 'C:/a.txt', backupPath: 'snapshots/snap-1/files/a.txt.gz', size: 1, modTime: 'garbage' },
          {
            sourcePath: 'C:/b.txt',
            backupPath: 'snapshots/snap-1/files/b.txt.gz',
            size: 2,
            modTime: '2026-08-01T09:00:00Z',
          },
        ],
      })
    );
    queueSelects([
      [CONFIG_ROW],
      [],
      [{ id: 'job-1', orgId: ORG_ID, deviceId: DEVICE_ID, status: 'failed', snapshotId: 'snap-1' }],
      [{ orgId: ORG_ID, provider: 's3', providerConfig: CONFIG_ROW.providerConfig }],
    ]);

    const result = await reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID });

    expect(result.adopted).toBe(1);
    const files = applyBackupCommandResultToJobMock.mock.calls[0]![0].result.snapshot.files;
    expect(files).toHaveLength(2);
    expect(files[0].modTime).toBeUndefined();
    expect(files[1].modTime).toBe('2026-08-01T09:00:00Z');
    // size falls back to the sum of the file sizes when the manifest omits it.
    expect(applyBackupCommandResultToJobMock.mock.calls[0]![0].result.bytesBackedUp).toBe(3);
  });

  it('reports a job that went terminal underneath the adoption instead of claiming success', async () => {
    listBackupObjectsUnderPrefixMock.mockResolvedValue([
      { key: 'snapshots/snap-1/manifest.json', lastModified: new Date('2026-08-01T10:20:00Z') },
    ]);
    fetchBackupObjectTextMock.mockResolvedValue(manifest('snap-1'));
    applyBackupCommandResultToJobMock.mockResolvedValue({
      applied: false,
      snapshotDbId: null,
      providerSnapshotId: 'snap-1',
    });
    queueSelects([
      [CONFIG_ROW],
      [],
      [{ id: 'job-1', orgId: ORG_ID, deviceId: DEVICE_ID, status: 'running', snapshotId: 'snap-1' }],
      [{ orgId: ORG_ID, provider: 's3', providerConfig: CONFIG_ROW.providerConfig }],
    ]);

    const result = await reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID });

    expect(result.adopted).toBe(0);
    expect(result.candidates[0]).toMatchObject({ adopted: false, skipReason: 'job-not-adoptable' });
  });

  it('skips a snapshot whose owning job is cancelled', async () => {
    listBackupObjectsUnderPrefixMock.mockResolvedValue([
      { key: 'snapshots/snap-1/manifest.json', lastModified: new Date('2026-08-01T10:20:00Z') },
    ]);
    queueSelects([
      [CONFIG_ROW],
      [],
      [{ id: 'job-1', orgId: ORG_ID, deviceId: DEVICE_ID, status: 'cancelled', snapshotId: 'snap-1' }],
      [{ orgId: ORG_ID, provider: 's3', providerConfig: CONFIG_ROW.providerConfig }],
    ]);

    const result = await reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID });

    expect(result.candidates[0]!.skipReason).toBe('job-not-adoptable');
    expect(applyBackupCommandResultToJobMock).not.toHaveBeenCalled();
  });

  it('reports an already-restorable snapshot in the caller\u2019s own org as a no-op', async () => {
    listBackupObjectsUnderPrefixMock.mockResolvedValue([
      { key: 'snapshots/snap-1/manifest.json', lastModified: new Date('2026-08-01T10:20:00Z') },
    ]);
    queueSelects([
      [CONFIG_ROW],
      [{ snapshotId: 'snap-1', orgId: ORG_ID }],
      [],
      [{ orgId: ORG_ID, provider: 's3', providerConfig: CONFIG_ROW.providerConfig }],
    ]);

    const result = await reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID });

    expect(result.candidates[0]!.skipReason).toBe('already-restorable');
    expect(applyBackupCommandResultToJobMock).not.toHaveBeenCalled();
  });

  it('surfaces an unreadable destination as a typed error', async () => {
    listBackupObjectsUnderPrefixMock.mockRejectedValue(new Error('AccessDenied'));
    queueSelects([[CONFIG_ROW]]);

    await expect(
      reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID })
    ).rejects.toMatchObject({ code: 'destination_unreadable' });
  });
});
