import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_ORG_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CONFIG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/**
 * Every WHERE predicate the service builds, in issue order.
 *
 * Recorded because the drizzle operators are mocked into inert plain objects:
 * without capturing them, deleting `eq(backupConfigs.orgId, …)` — Defence 1 —
 * or the site-scope `inArray(backupJobs.deviceId, …)` changes nothing the
 * suite can see. Site scope in particular has NO RLS backstop (it is an
 * app-layer-only axis), so a test that cannot see the predicate cannot claim
 * the isolation holds.
 */
const whereArgs: unknown[] = [];

/** All recorded predicates, serialized — for substring assertions. */
function wherePredicates(): string[] {
  return whereArgs.map((arg) => JSON.stringify(arg));
}

/**
 * A drizzle chain stand-in: every builder method returns the same
 * promise-shaped object, so `.from(...).where(...).limit(1)` and a bare
 * `.from(...)` both await to the same rows.
 */
function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'orderBy']) {
    chain[method] = vi.fn((...args: unknown[]) => {
      if (method === 'where') whereArgs.push(args[0]);
      return Object.assign(Promise.resolve(resolvedValue), chain);
    });
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

const captureExceptionMock = vi.fn();
const captureMessageMock = vi.fn();
vi.mock('./sentry', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...(args as [])),
  captureMessage: (...args: unknown[]) => captureMessageMock(...(args as [])),
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
  whereArgs.length = 0;
  for (const rows of rowSets) {
    selectMock.mockReturnValueOnce(chainMock(rows) as any);
  }
  selectMock.mockImplementation(() => chainMock([]) as any);
}

/** The four selects a run issues before any time-window work. */
function baseSelects(claimJobs: unknown[] = [], restorable: unknown[] = [], otherConfigs?: unknown[]) {
  return [
    [CONFIG_ROW],
    restorable,
    claimJobs,
    otherConfigs ?? [{ orgId: ORG_ID, provider: 's3', providerConfig: CONFIG_ROW.providerConfig }],
  ];
}

function claimingJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    orgId: ORG_ID,
    deviceId: DEVICE_ID,
    configId: CONFIG_ID,
    status: 'failed',
    createdAt: new Date('2026-08-01T08:00:00Z'),
    snapshotId: 'snap-1',
    ...overrides,
  };
}

function oneManifest(snapshotId = 'snap-1', writtenAt = '2026-08-01T10:20:00Z') {
  listBackupObjectsUnderPrefixMock.mockResolvedValue([
    { key: `snapshots/${snapshotId}/manifest.json`, lastModified: new Date(writtenAt) },
  ]);
}

describe('reconcileOrphanedBackupSnapshots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    whereArgs.length = 0;
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
      [claimingJob()],
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
    // The unattributed-job lookup must not even run — nothing is attributable.
    expect(wherePredicates().some((p) => p.includes('backup_jobs.config_id'))).toBe(false);
  });

  it('treats a bucket shared via an equivalent-but-different endpoint as shared', async () => {
    // normalizeStorageIdentity only canonicalises the default AWS endpoint, so
    // two orgs on the same Wasabi bucket via different regional hostnames get
    // different identities. A coarse provider+bucket backstop must still catch
    // it — a false "not shared" is a cross-tenant adoption.
    oneManifest();
    queueSelects(
      baseSelects([], [], [
        { orgId: ORG_ID, provider: 's3', providerConfig: CONFIG_ROW.providerConfig },
        {
          orgId: OTHER_ORG_ID,
          provider: 's3',
          providerConfig: { bucket: 'Customer-Bucket', endpoint: 'https://s3.us-east-2.wasabisys.com' },
        },
      ])
    );

    const result = await reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID });

    expect(result.sharedDestination).toBe(true);
    expect(result.candidates[0]!.skipReason).toBe('shared-destination-ambiguous');
  });

  it('still adopts an EXACT snapshot-id match on a shared destination', async () => {
    // The doc promises exact matches keep working when the bucket is shared —
    // they are unambiguous. Without this, reconcile could be silently disabled
    // for every shared-bucket tenant and nothing would notice.
    oneManifest();
    fetchBackupObjectTextMock.mockResolvedValue(manifest('snap-1'));
    queueSelects(
      baseSelects([claimingJob()], [], [
        { orgId: ORG_ID, provider: 's3', providerConfig: CONFIG_ROW.providerConfig },
        {
          orgId: OTHER_ORG_ID,
          provider: 's3',
          providerConfig: { bucket: 'customer-bucket', endpoint: '' },
        },
      ])
    );

    const result = await reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID });

    expect(result.sharedDestination).toBe(true);
    expect(result.adopted).toBe(1);
  });

  it('refuses a claiming job that belongs to a different destination', async () => {
    // The claim lookup is destination-blind (it must see other tenants), so the
    // config check is per-candidate. Adopting here would stamp the restore
    // point with a config whose bucket does not hold the objects.
    oneManifest();
    queueSelects(baseSelects([claimingJob({ configId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })]));

    const result = await reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID });

    expect(result.candidates[0]!.skipReason).toBe('job-on-another-config');
    expect(applyBackupCommandResultToJobMock).not.toHaveBeenCalled();
  });

  it('prefers the newest job when a journal resume left two rows on one snapshot id', async () => {
    // A resumed run reuses the SAME snapshot id under a NEW backup_jobs row,
    // and mid-run registration records it on both — so duplicates are now a
    // normal outcome, not a corruption. Scan order must not decide the winner.
    oneManifest();
    fetchBackupObjectTextMock.mockResolvedValue(manifest('snap-1'));
    queueSelects(
      baseSelects([
        claimingJob({ id: 'job-newer', createdAt: new Date('2026-08-01T09:00:00Z') }),
        claimingJob({ id: 'job-older', createdAt: new Date('2026-08-01T07:00:00Z') }),
      ])
    );

    const result = await reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID });

    expect(result.adopted).toBe(1);
    expect(applyBackupCommandResultToJobMock.mock.calls[0]![0].jobId).toBe('job-newer');
  });

  it('adopts a half-written completed job that never got its restore point', async () => {
    // Adoption is not atomic: the job UPDATE commits before the
    // backup_snapshots insert. A crash between them leaves a completed job with
    // no restore point, which must stay recoverable rather than being locked
    // out as "already completed" forever.
    oneManifest();
    fetchBackupObjectTextMock.mockResolvedValue(manifest('snap-1'));
    queueSelects(baseSelects([claimingJob({ status: 'completed' })]));

    const result = await reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID });

    expect(result.adopted).toBe(1);
    expect(applyBackupCommandResultToJobMock.mock.calls[0]![0].source).toBe('reconcile');
  });

  it('does not adopt onto a device outside a site-restricted caller\u2019s sites', async () => {
    listBackupObjectsUnderPrefixMock.mockResolvedValue([
      { key: 'snapshots/snap-1/manifest.json', lastModified: new Date('2026-08-01T10:20:00Z') },
    ]);
    queueSelects([
      [CONFIG_ROW],
      [],
      [claimingJob()],
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
      [claimingJob()],
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
        claimingJob(),
        claimingJob({ id: 'job-2', snapshotId: 'snap-2' }),
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
      [claimingJob()],
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
      [claimingJob()],
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
      [claimingJob({ status: 'running' })],
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
      [claimingJob({ status: 'cancelled' })],
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

  // --- the SQL-level filters the tenancy claims actually rest on -----------
  //
  // These predicates are the only thing standing between one tenant and
  // another's data on the site-scope axis (RLS does not defend site scope), so
  // they are asserted directly rather than inferred from returned rows — a
  // mock that ignores WHERE would otherwise pass with the filters deleted.

  it('scopes the destination lookup to the caller org', async () => {
    oneManifest();
    queueSelects(baseSelects([claimingJob()]));
    fetchBackupObjectTextMock.mockResolvedValue(manifest('snap-1'));

    await reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID });

    const configPredicate = wherePredicates()[0]!;
    expect(configPredicate).toContain('backup_configs.org_id');
    expect(configPredicate).toContain(ORG_ID);
    expect(configPredicate).toContain(CONFIG_ID);
  });

  it('scopes the time-window job lookup by org, config, site devices and status', async () => {
    oneManifest('snap-legacy');
    queueSelects([
      ...baseSelects(),
      [
        {
          id: 'job-legacy',
          deviceId: 'device-in',
          startedAt: new Date('2026-08-01T08:00:00Z'),
          completedAt: new Date('2026-08-01T11:00:00Z'),
          createdAt: new Date('2026-08-01T08:00:00Z'),
        },
      ],
      [],
    ]);
    fetchBackupObjectTextMock.mockResolvedValue(manifest('snap-legacy'));

    await reconcileOrphanedBackupSnapshots({
      orgId: ORG_ID,
      configId: CONFIG_ID,
      allowedDeviceIds: ['device-in'],
    });

    const jobPredicate = wherePredicates().find((p) => p.includes('backup_jobs.config_id'));
    expect(jobPredicate).toBeDefined();
    expect(jobPredicate).toContain('backup_jobs.org_id');
    expect(jobPredicate).toContain(ORG_ID);
    expect(jobPredicate).toContain(CONFIG_ID);
    // Site scope — no RLS backstop, so this predicate is load-bearing.
    expect(jobPredicate).toContain('backup_jobs.device_id');
    expect(jobPredicate).toContain('device-in');
    // Never attribute to a snapshot-bearing or non-dispatched job.
    expect(jobPredicate).toContain('isNull');
    expect(jobPredicate).toContain('running');
    expect(jobPredicate).toContain('failed');
    expect(jobPredicate).not.toContain('pending');
  });

  it('issues no job query at all when a site-restricted caller can see no devices', async () => {
    oneManifest('snap-legacy');
    queueSelects(baseSelects());

    const result = await reconcileOrphanedBackupSnapshots({
      orgId: ORG_ID,
      configId: CONFIG_ID,
      allowedDeviceIds: [],
    });

    expect(result.candidates[0]!.skipReason).toBe('no-matching-job');
    expect(wherePredicates().some((p) => p.includes('backup_jobs.config_id'))).toBe(false);
  });

  // --- time-window boundaries ----------------------------------------------

  it.each([
    ['inside the leading skew', '2026-08-01T07:01:00Z', true],
    ['outside the leading skew', '2026-08-01T06:59:00Z', false],
    ['inside the trailing skew', '2026-08-01T11:59:00Z', true],
    ['outside the trailing skew', '2026-08-01T12:01:00Z', false],
  ])('write time %s is %s', async (_label, writtenAt, shouldAdopt) => {
    oneManifest('snap-legacy', writtenAt);
    fetchBackupObjectTextMock.mockResolvedValue(manifest('snap-legacy'));
    queueSelects([
      ...baseSelects(),
      [
        {
          id: 'job-legacy',
          deviceId: DEVICE_ID,
          startedAt: new Date('2026-08-01T08:00:00Z'),
          completedAt: new Date('2026-08-01T11:00:00Z'),
          createdAt: new Date('2026-08-01T08:00:00Z'),
        },
      ],
      [],
    ]);

    const result = await reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID });

    expect(result.adopted).toBe(shouldAdopt ? 1 : 0);
  });

  it('caps an open-ended window so a long-hung job cannot claim a recent snapshot', async () => {
    // A `running` job has no completedAt. Treating "now" as the end would let a
    // job that hung months ago adopt anything written since.
    oneManifest('snap-legacy', new Date().toISOString());
    queueSelects([
      ...baseSelects(),
      [
        {
          id: 'job-hung',
          deviceId: DEVICE_ID,
          startedAt: new Date('2026-01-01T00:00:00Z'),
          completedAt: null,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
      [],
    ]);

    const result = await reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID });

    expect(result.candidates[0]!.skipReason).toBe('no-matching-job');
  });

  it('never attributes two snapshots to the same job', async () => {
    listBackupObjectsUnderPrefixMock.mockResolvedValue([
      { key: 'snapshots/snap-a/manifest.json', lastModified: new Date('2026-08-01T09:00:00Z') },
      { key: 'snapshots/snap-b/manifest.json', lastModified: new Date('2026-08-01T09:10:00Z') },
    ]);
    fetchBackupObjectTextMock.mockImplementation((input: any) =>
      Promise.resolve(manifest(input.key.split('/')[1]))
    );
    queueSelects([
      ...baseSelects(),
      [
        {
          id: 'job-only',
          deviceId: DEVICE_ID,
          startedAt: new Date('2026-08-01T08:00:00Z'),
          completedAt: new Date('2026-08-01T11:00:00Z'),
          createdAt: new Date('2026-08-01T08:00:00Z'),
        },
      ],
      [],
    ]);

    const result = await reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID });

    expect(result.adopted).toBe(1);
    expect(result.candidates.find((c) => c.snapshotId === 'snap-b')!.skipReason).toBe(
      'no-matching-job'
    );
  });

  it('skips a snapshot whose manifest has no last-modified time', async () => {
    listBackupObjectsUnderPrefixMock.mockResolvedValue([
      { key: 'snapshots/snap-legacy/manifest.json', lastModified: null },
    ]);
    queueSelects(baseSelects());

    const result = await reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID });

    expect(result.candidates[0]!.skipReason).toBe('no-matching-job');
  });

  // --- failure reporting ----------------------------------------------------

  it('reports a failed adoption WRITE as adoption-failed, not manifest-unreadable, and escalates it', async () => {
    // The manifest read fine. Mislabelling a DB failure as a storage problem
    // sends the operator to inspect a bucket that is perfectly healthy — and
    // the job row may already be terminal with no restore point, which is
    // #3006 recurring inside its own fix.
    oneManifest();
    fetchBackupObjectTextMock.mockResolvedValue(manifest('snap-1'));
    applyBackupCommandResultToJobMock.mockRejectedValue(new Error('statement timeout'));
    queueSelects(baseSelects([claimingJob()]));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID });

    expect(result.adopted).toBe(0);
    expect(result.candidates[0]).toMatchObject({
      skipReason: 'adoption-failed',
      error: 'statement timeout',
      adopted: false,
    });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('does not count an adoption whose restore-point row never came back', async () => {
    oneManifest();
    fetchBackupObjectTextMock.mockResolvedValue(manifest('snap-1'));
    applyBackupCommandResultToJobMock.mockResolvedValue({
      applied: true,
      snapshotDbId: null,
      providerSnapshotId: 'snap-1',
    });
    queueSelects(baseSelects([claimingJob()]));

    const result = await reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID });

    expect(result.adopted).toBe(0);
    expect(result.candidates[0]!.skipReason).toBe('adoption-failed');
  });

  it('counts skips by reason so a run that recovered nothing is visible', async () => {
    listBackupObjectsUnderPrefixMock.mockResolvedValue([
      { key: 'snapshots/snap-a/manifest.json', lastModified: new Date('2026-08-01T09:00:00Z') },
      { key: 'snapshots/snap-b/manifest.json', lastModified: new Date('2026-08-01T09:10:00Z') },
    ]);
    queueSelects(
      baseSelects([], [], [
        { orgId: ORG_ID, provider: 's3', providerConfig: CONFIG_ROW.providerConfig },
        { orgId: OTHER_ORG_ID, provider: 's3', providerConfig: { bucket: 'customer-bucket', endpoint: '' } },
      ])
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID });

    expect(result.adopted).toBe(0);
    expect(result.remaining).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.skippedByReason).toEqual({ 'shared-destination-ambiguous': 2 });
    // Unattributable customer data no rerun will ever clear — must be loud.
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('surfaces an unreadable destination as a typed error', async () => {
    listBackupObjectsUnderPrefixMock.mockRejectedValue(new Error('AccessDenied'));
    queueSelects([[CONFIG_ROW]]);

    await expect(
      reconcileOrphanedBackupSnapshots({ orgId: ORG_ID, configId: CONFIG_ID })
    ).rejects.toMatchObject({ code: 'destination_unreadable' });
  });
});
