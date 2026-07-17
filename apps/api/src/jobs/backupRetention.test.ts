import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// ── Chainable Drizzle mock ────────────────────────────────────────────────
//
// Drizzle query builders are awaited directly (no explicit `.then()` call in
// source), so each intermediate method (`.from()`, `.where()`, `.leftJoin()`,
// etc.) must return an object that is itself awaitable. `chainable(rows)`
// returns an object whose chain methods are all no-ops returning itself,
// and whose `.then()` resolves with `rows` — letting one helper stand in for
// every query shape in backupRetention.ts (selects with joins/orderBy, plain
// deletes) without hand-rolling a different mock per call site.
function chainable(rows: unknown[]) {
  const obj: Record<string, unknown> = {
    from: () => obj,
    where: () => obj,
    leftJoin: () => obj,
    innerJoin: () => obj,
    orderBy: () => obj,
    limit: () => obj,
    then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return obj;
}

const selectQueue: unknown[][] = [];

const mockDb = {
  select: vi.fn(() => chainable(selectQueue.shift() ?? [])),
  delete: vi.fn(() => chainable([])),
  update: vi.fn(() => chainable([])),
};

vi.mock('../db', () => ({ db: mockDb }));

const fetchBackupObjectTextMock = vi.fn();
const listBackupObjectsUnderPrefixMock = vi.fn();
const deleteBackupObjectKeysMock = vi.fn();

vi.mock('../services/backupSnapshotStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/backupSnapshotStorage')>();
  return {
    ...actual,
    fetchBackupObjectText: fetchBackupObjectTextMock,
    listBackupObjectsUnderPrefix: listBackupObjectsUnderPrefixMock,
    deleteBackupObjectKeys: deleteBackupObjectKeysMock,
  };
});

const captureExceptionMock = vi.fn();
vi.mock('../services/sentry', () => ({ captureException: captureExceptionMock }));

const {
  computeExpiresAt,
  cleanupExpiredSnapshots,
  sweepUnreferencedBackupObjects,
  resolveBackupGcMaxDeletesPerRun,
  normalizeStorageIdentity,
  BACKUP_GC_GRACE_MS,
  BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS,
} = await import('./backupRetention');

const DAY_MS = 24 * 60 * 60 * 1000;
const AGENT_JOURNAL_MAX_AGE_MS = 7 * DAY_MS;
// Ages relative to the ACTUAL current threshold (not a hardcoded "7 days")
// so these fixtures stay correct even if the headroom formula changes again.
const JUST_PAST_MANIFESTLESS_THRESHOLD = () =>
  new Date(Date.now() - BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS - DAY_MS);
const EVEN_FURTHER_PAST_MANIFESTLESS_THRESHOLD = () =>
  new Date(Date.now() - BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS - 2 * DAY_MS);

function manifestJson(files: { backupPath: string }[]): string {
  return JSON.stringify({ formatVersion: 2, files });
}

describe('backup retention', () => {
  it('uses retentionDays when no GFS tiers are configured', () => {
    const expiresAt = computeExpiresAt(
      new Date('2026-03-31T00:00:00.000Z'),
      { daily: true },
      { retentionDays: 30 },
    );

    expect(expiresAt?.toISOString()).toBe('2026-04-30T00:00:00.000Z');
  });

  it('prefers the longest GFS-derived retention over retentionDays', () => {
    const expiresAt = computeExpiresAt(
      new Date('2026-03-31T00:00:00.000Z'),
      { daily: true, monthly: true },
      { retentionDays: 10, monthly: 2 },
    );

    expect(expiresAt?.toISOString()).toBe('2026-05-30T00:00:00.000Z');
  });
});

describe('cleanupExpiredSnapshots — object storage decoupling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue.length = 0;
  });

  it('deletes only the DB row for an expired snapshot and never touches object storage directly', async () => {
    // Regression test for the incremental-backup GC bug: row-level retention
    // used to eagerly delete a snapshot's whole storage prefix, which would
    // destroy objects a still-retained sibling snapshot's manifest
    // references. Object deletion is now exclusively GC's job.
    selectQueue.push([
      {
        id: 'snap-expired-1',
        snapshotId: 'snap-1',
        metadata: null,
        legalHold: false,
        isImmutable: false,
        immutableUntil: null,
        provider: 's3',
        providerConfig: { bucket: 'b', region: 'us-east-1' },
      },
    ]); // expired query
    selectQueue.push([]); // versionBoundSnapshots query (maxVersions pass)

    const result = await cleanupExpiredSnapshots('org-1');

    expect(result.deleted).toBe(1);
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(fetchBackupObjectTextMock).not.toHaveBeenCalled();
    expect(listBackupObjectsUnderPrefixMock).not.toHaveBeenCalled();
    expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
  });

  it('prunes the oldest snapshots past retention.maxVersions, skipping legal-hold and immutable rows', async () => {
    // Exercises the version-bound prune loop, which no other test reaches
    // (the versionBoundSnapshots query is normally fed []). One device/config
    // group with 5 snapshots (newest-first) and maxVersions=2: the 2 newest
    // are kept, the remaining 3 are pruning candidates. Of those, one is on
    // legal hold and one is still immutable (both skipped), leaving exactly one
    // prunable row.
    selectQueue.push([]); // expired query — nothing expired by date

    const future = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000);
    const retention = { maxVersions: 2 };
    const base = {
      deviceId: 'd1',
      configId: 'c1',
      metadata: null,
      provider: 's3',
      providerConfig: { bucket: 'b', region: 'us-east-1' },
      retention,
      legalHold: false,
      isImmutable: false,
      immutableUntil: null,
    };
    selectQueue.push([
      { ...base, id: 's1', snapshotId: 'snap-1', timestamp: new Date('2026-05-05') }, // kept (within maxVersions)
      { ...base, id: 's2', snapshotId: 'snap-2', timestamp: new Date('2026-05-04') }, // kept
      { ...base, id: 's3', snapshotId: 'snap-3', timestamp: new Date('2026-05-03'), legalHold: true }, // skipped (legal hold)
      { ...base, id: 's4', snapshotId: 'snap-4', timestamp: new Date('2026-05-02'), isImmutable: true, immutableUntil: future }, // skipped (immutable)
      { ...base, id: 's5', snapshotId: 'snap-5', timestamp: new Date('2026-05-01') }, // pruned by maxVersions
    ]); // versionBoundSnapshots query

    const result = await cleanupExpiredSnapshots('org-1');

    expect(result.prunedByMaxVersions).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.skippedLegalHold).toBe(1);
    expect(result.skippedImmutable).toBe(1);
    expect(mockDb.delete).toHaveBeenCalledTimes(1); // only s5 physically deleted
  });
});

describe('sweepUnreferencedBackupObjects', () => {
  const destination = {
    id: 'cfg-1',
    provider: 's3',
    providerConfig: { bucket: 'backups', region: 'us-east-1' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue.length = 0;
    delete process.env.BACKUP_GC_MAX_DELETES_PER_RUN;
  });

  afterEach(() => {
    delete process.env.BACKUP_GC_MAX_DELETES_PER_RUN;
  });

  it('keeps an object referenced by a retained snapshot even though it lives under an older, deleted snapshot prefix', async () => {
    // Snapshot A's row is already gone (row-level retention ran); snapshot B
    // is still retained and its manifest references A's file via a
    // cross-prefix backupPath — the incremental "reference" mechanism. A has
    // no manifest.json in the listing (its own row/manifest are gone), so
    // group A is evaluated under the manifest-less/prefix-granularity rule;
    // both its objects are 10 days old (past the 7-day window), so orphan.dat
    // is swept while foo.dat survives purely because it's in the live set.
    selectQueue.push([]); // unattributedRows
    selectQueue.push([destination]); // destinations
    selectQueue.push([{ snapshotId: 'B' }]); // retained snapshots for the identity

    fetchBackupObjectTextMock.mockResolvedValueOnce(
      manifestJson([{ backupPath: 'snapshots/A/files/foo.dat' }]),
    );

    const old = new Date(Date.now() - 10 * DAY_MS);
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/B/manifest.json', lastModified: old },
      { key: 'snapshots/A/files/foo.dat', lastModified: old }, // referenced — must survive
      { key: 'snapshots/A/files/orphan.dat', lastModified: old }, // unreferenced + old — deleted
    ]);

    deleteBackupObjectKeysMock.mockResolvedValueOnce({
      deletedKeys: ['snapshots/A/files/orphan.dat'],
      failedKeys: [],
    });

    const result = await sweepUnreferencedBackupObjects();

    expect(deleteBackupObjectKeysMock).toHaveBeenCalledTimes(1);
    const deletedArg = deleteBackupObjectKeysMock.mock.calls[0]![0] as { keys: string[] };
    expect(deletedArg.keys).toEqual(['snapshots/A/files/orphan.dat']);
    expect(deletedArg.keys).not.toContain('snapshots/A/files/foo.dat');
    expect(deletedArg.keys).not.toContain('snapshots/B/manifest.json');
    expect(result).toEqual({ deleted: 1, skippedIdentities: 0, blockedIdentities: 0 });
  });

  it('keeps a loose unreferenced object under a manifest-bearing prefix that is still inside the 48h grace window', async () => {
    selectQueue.push([]);
    selectQueue.push([destination]);
    selectQueue.push([{ snapshotId: 'B' }]);

    fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));

    const withinGrace = new Date(Date.now() - 1 * 60 * 60 * 1000); // 1h old, grace is 48h
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/B/manifest.json', lastModified: withinGrace },
      { key: 'snapshots/B/files/pending.dat', lastModified: withinGrace }, // loose object under B's manifest-bearing prefix
    ]);

    const result = await sweepUnreferencedBackupObjects();

    expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 0, skippedIdentities: 0, blockedIdentities: 0 });
  });

  it('never deletes an object with no last-modified data, even if otherwise unreferenced (fail-closed per-object)', async () => {
    selectQueue.push([]);
    selectQueue.push([destination]);
    selectQueue.push([{ snapshotId: 'B' }]);

    fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));

    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/B/manifest.json', lastModified: new Date(Date.now() - 10 * DAY_MS) },
      { key: 'snapshots/B/files/unknown-age.dat', lastModified: null }, // no age proof
    ]);

    const result = await sweepUnreferencedBackupObjects();

    expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 0, skippedIdentities: 0, blockedIdentities: 0 });
  });

  // Manifest-less prefixes are protected at PREFIX granularity for
  // BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS (9 days = the agent's 7-day
  // journalMaxAge + 48h resume headroom), not the 48h loose-object grace.
  describe('manifest-less prefix protection', () => {
    it('leaves a manifest-less prefix entirely untouched while ANY of its objects is fresh (mixed-age)', async () => {
      selectQueue.push([]);
      selectQueue.push([destination]);
      selectQueue.push([{ snapshotId: 'B' }]);

      fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));

      const veryOld = new Date(Date.now() - 20 * DAY_MS);
      const fresh = new Date(Date.now() - 1 * DAY_MS); // well past 48h grace but inside the 7-day journal window
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/B/manifest.json', lastModified: veryOld },
        { key: 'snapshots/C/files/partial-old.dat', lastModified: veryOld },
        { key: 'snapshots/C/files/partial-fresh.dat', lastModified: fresh },
      ]);

      const result = await sweepUnreferencedBackupObjects();

      // The single fresh object protects the WHOLE "C" prefix — including
      // partial-old.dat, which on its own would look well past any grace.
      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result).toEqual({ deleted: 0, skippedIdentities: 0, blockedIdentities: 0 });
    });

    it('sweeps a manifest-less prefix in full once its newest object clears the (9-day) window', async () => {
      selectQueue.push([]);
      selectQueue.push([destination]);
      selectQueue.push([{ snapshotId: 'B' }]);

      fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));

      const allOld = JUST_PAST_MANIFESTLESS_THRESHOLD(); // past the (headroom-inclusive) window
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/B/manifest.json', lastModified: allOld },
        { key: 'snapshots/C/files/partial-1.dat', lastModified: allOld },
        { key: 'snapshots/C/files/partial-2.dat', lastModified: allOld },
      ]);

      deleteBackupObjectKeysMock.mockResolvedValueOnce({
        deletedKeys: ['snapshots/C/files/partial-1.dat', 'snapshots/C/files/partial-2.dat'],
        failedKeys: [],
      });

      const result = await sweepUnreferencedBackupObjects();

      const deletedArg = deleteBackupObjectKeysMock.mock.calls[0]![0] as { keys: string[] };
      expect(new Set(deletedArg.keys)).toEqual(
        new Set(['snapshots/C/files/partial-1.dat', 'snapshots/C/files/partial-2.dat']),
      );
      expect(result.deleted).toBe(2);
    });

    it('boundary regression: protects a resume opened just inside the agent journal window (day ~6.9) that legitimately runs past day 7', async () => {
      // The scenario the 48h headroom targets: using journalMaxAge (7 days)
      // alone as the sweep threshold would have swept
      // this prefix (its newest object is 7 days + a few hours old — past the
      // OLD threshold). With the 48h headroom, it must stay protected.
      selectQueue.push([]);
      selectQueue.push([destination]);
      selectQueue.push([{ snapshotId: 'B' }]);

      fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));

      const justPastOldSevenDayThreshold = new Date(Date.now() - AGENT_JOURNAL_MAX_AGE_MS - 6 * 60 * 60 * 1000); // 7d + 6h
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/B/manifest.json', lastModified: justPastOldSevenDayThreshold },
        { key: 'snapshots/D/files/resume-chunk.dat', lastModified: justPastOldSevenDayThreshold },
      ]);

      const result = await sweepUnreferencedBackupObjects();

      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result).toEqual({ deleted: 0, skippedIdentities: 0, blockedIdentities: 0 });
    });

    it('BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS is strictly larger than the agent journalMaxAge (7 days), not merely equal', () => {
      expect(BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS).toBeGreaterThan(AGENT_JOURNAL_MAX_AGE_MS);
      // Exact value pinned for regression safety: 7 days + 48h headroom = 9 days.
      expect(BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS).toBe(9 * DAY_MS);
    });
  });

  it('aborts the sweep for an identity whose manifest fetch fails, but still processes other identities', async () => {
    // Listing now happens before marking for EVERY identity (the dedup-source
    // race protection marks every listed manifest live), so both identities
    // get listed — the broken one's mark phase then fails on the manifest
    // fetch for its retained snapshot and aborts BEFORE any delete.
    const destinationBroken = { id: 'cfg-broken', provider: 's3', providerConfig: { bucket: 'b1', region: 'us-east-1' } };
    const destinationOk = { id: 'cfg-ok', provider: 's3', providerConfig: { bucket: 'b2', region: 'us-east-1' } };

    selectQueue.push([]); // unattributedRows
    selectQueue.push([destinationBroken, destinationOk]); // destinations
    selectQueue.push([{ snapshotId: 'X' }]); // retained for destinationBroken's identity
    selectQueue.push([{ snapshotId: 'Y' }]); // retained for destinationOk's identity

    fetchBackupObjectTextMock
      .mockRejectedValueOnce(new Error('network error fetching manifest')) // destinationBroken's snapshot X
      .mockResolvedValueOnce(manifestJson([])); // destinationOk's snapshot Y

    const old = JUST_PAST_MANIFESTLESS_THRESHOLD();
    listBackupObjectsUnderPrefixMock
      .mockResolvedValueOnce([]) // destinationBroken's identity — empty listing, mark still attempted+fails on X
      .mockResolvedValueOnce([
        { key: 'snapshots/Y/manifest.json', lastModified: old },
        { key: 'snapshots/Z/files/orphan.dat', lastModified: old }, // manifest-less, all-old — deletable
      ]);

    deleteBackupObjectKeysMock.mockResolvedValueOnce({
      deletedKeys: ['snapshots/Z/files/orphan.dat'],
      failedKeys: [],
    });

    const result = await sweepUnreferencedBackupObjects();

    // Both identities get listed; only the healthy one reaches delete.
    expect(listBackupObjectsUnderPrefixMock).toHaveBeenCalledTimes(2);
    expect(deleteBackupObjectKeysMock).toHaveBeenCalledTimes(1);
    expect(deleteBackupObjectKeysMock).toHaveBeenCalledWith(
      expect.objectContaining({ providerConfig: destinationOk.providerConfig }),
    );
    // The fail-closed identity is both skipped and BLOCKED (distinct signal),
    // and the failure is escalated to Sentry.
    expect(result).toEqual({ deleted: 1, skippedIdentities: 1, blockedIdentities: 1 });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it('honors the per-run deletion cap, leaving the rest for a later run', async () => {
    process.env.BACKUP_GC_MAX_DELETES_PER_RUN = '1';

    selectQueue.push([]);
    selectQueue.push([destination]);
    selectQueue.push([{ snapshotId: 'B' }]);

    fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));

    const old = JUST_PAST_MANIFESTLESS_THRESHOLD();
    const older = EVEN_FURTHER_PAST_MANIFESTLESS_THRESHOLD();
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/B/manifest.json', lastModified: old },
      { key: 'snapshots/A/files/orphan-1.dat', lastModified: old },
      { key: 'snapshots/A/files/orphan-2.dat', lastModified: older },
    ]);

    deleteBackupObjectKeysMock.mockResolvedValueOnce({
      deletedKeys: ['snapshots/A/files/orphan-2.dat'],
      failedKeys: [],
    });

    const result = await sweepUnreferencedBackupObjects();

    expect(deleteBackupObjectKeysMock).toHaveBeenCalledTimes(1);
    const deletedArg = deleteBackupObjectKeysMock.mock.calls[0]![0] as { keys: string[] };
    // Oldest-first: only 1 of the 2 deletable objects goes this run.
    expect(deletedArg.keys).toEqual(['snapshots/A/files/orphan-2.dat']);
    expect(result.deleted).toBe(1);
  });

  it('grace window matches BACKUP_GC_GRACE_MS (48h)', () => {
    expect(BACKUP_GC_GRACE_MS).toBe(48 * 60 * 60 * 1000);
  });

  it('skips an identity whose provider has no GC listing support, without touching storage', async () => {
    const unsupported = { id: 'cfg-azure', provider: 'azure_blob', providerConfig: {} };
    selectQueue.push([]);
    selectQueue.push([unsupported]);

    const result = await sweepUnreferencedBackupObjects();

    expect(fetchBackupObjectTextMock).not.toHaveBeenCalled();
    expect(listBackupObjectsUnderPrefixMock).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 0, skippedIdentities: 1, blockedIdentities: 0 });
  });

  it('does not crash the sweep when a delete is rejected (e.g. object-lock) — counts it and moves on', async () => {
    selectQueue.push([]);
    selectQueue.push([destination]);
    selectQueue.push([{ snapshotId: 'B' }]);

    fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));

    const old = JUST_PAST_MANIFESTLESS_THRESHOLD();
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/B/manifest.json', lastModified: old },
      { key: 'snapshots/A/files/locked.dat', lastModified: old },
    ]);

    deleteBackupObjectKeysMock.mockResolvedValueOnce({
      deletedKeys: [],
      failedKeys: [{ key: 'snapshots/A/files/locked.dat', error: 'AccessDenied: object locked' }],
    });

    const result = await sweepUnreferencedBackupObjects();

    expect(result).toEqual({ deleted: 0, skippedIdentities: 0, blockedIdentities: 0 });
  });

  // Sweep scope must be storage identity (provider + endpoint + bucket,
  // excluding prefix), not backupConfigs row, or two configs on one bucket
  // mass-delete each other's backups.
  describe('storage identity grouping', () => {
    it('unions retained snapshots across two configs sharing one physical bucket, so neither can delete the other\'s live objects', async () => {
      const configA = { id: 'cfg-a', provider: 's3', providerConfig: { bucket: 'shared-bucket', region: 'us-east-1' } };
      const configB = { id: 'cfg-b', provider: 's3', providerConfig: { bucket: 'shared-bucket', region: 'us-east-1' } };

      selectQueue.push([]); // unattributedRows
      selectQueue.push([configA, configB]); // destinations — same identity (same bucket)
      selectQueue.push([{ snapshotId: 'A' }, { snapshotId: 'B' }]); // retained rows unioned across BOTH configs

      // A's manifest has no references of its own; B's manifest (a
      // different config's snapshot, same bucket) references an object that
      // physically lives under A's prefix — the cross-config reference the
      // identity-scoped mark protects.
      fetchBackupObjectTextMock
        .mockResolvedValueOnce(manifestJson([])) // manifest for A
        .mockResolvedValueOnce(manifestJson([{ backupPath: 'snapshots/A/files/shared.dat' }])); // manifest for B

      const old = new Date(Date.now() - 10 * DAY_MS);
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/A/manifest.json', lastModified: old },
        { key: 'snapshots/A/files/shared.dat', lastModified: old }, // sits under A, referenced by B — must survive
        { key: 'snapshots/B/manifest.json', lastModified: old },
      ]);

      const result = await sweepUnreferencedBackupObjects();

      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result).toEqual({ deleted: 0, skippedIdentities: 0, blockedIdentities: 0 });
    });

    it('blocks the entire run when any backup_snapshots row has a null config_id (cannot be attributed to a bucket)', async () => {
      selectQueue.push([{ id: 'orphan-snap-1' }]); // unattributedRows — one exists
      selectQueue.push([destination]); // destinations — used only to size skippedIdentities

      const result = await sweepUnreferencedBackupObjects();

      expect(fetchBackupObjectTextMock).not.toHaveBeenCalled();
      expect(listBackupObjectsUnderPrefixMock).not.toHaveBeenCalled();
      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result).toEqual({ deleted: 0, skippedIdentities: 1, blockedIdentities: 0 });
    });

    it('belt-and-braces: fail-closed-skips every identity that coarsely collides on bucket+host despite normalizeStorageIdentity keeping them apart', async () => {
      // Genuine variant normalizeStorageIdentity does NOT currently collapse:
      // one config specifies the port explicitly, the other omits it. That's
      // a real gap (an implicit default port could mean the same physical
      // endpoint), so the two land in DIFFERENT identities by construction —
      // exactly the "unanticipated variant" the coarse check exists to catch.
      const configWithPort = {
        id: 'cfg-port',
        provider: 's3',
        providerConfig: { bucket: 'collide-bucket', endpoint: 'https://minio.local:9000' },
      };
      const configWithoutPort = {
        id: 'cfg-noport',
        provider: 's3',
        providerConfig: { bucket: 'collide-bucket', endpoint: 'https://minio.local' },
      };

      // Sanity check the premise: normalizeStorageIdentity really does treat
      // these as different (otherwise this test would be proving nothing).
      expect(normalizeStorageIdentity('s3', configWithPort.providerConfig))
        .not.toBe(normalizeStorageIdentity('s3', configWithoutPort.providerConfig));

      selectQueue.push([]); // unattributedRows
      selectQueue.push([configWithPort, configWithoutPort]); // destinations — 2 identities, coarsely the same bucket+host

      const result = await sweepUnreferencedBackupObjects();

      // Neither identity's retained-rows query, listing, mark, or delete
      // ever runs — both are excluded before any provider call.
      expect(fetchBackupObjectTextMock).not.toHaveBeenCalled();
      expect(listBackupObjectsUnderPrefixMock).not.toHaveBeenCalled();
      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result).toEqual({ deleted: 0, skippedIdentities: 2, blockedIdentities: 0 });
    });
  });

  // Dedup-source race: agents pick their reference base from the bucket
  // LISTING, not from DB rows, so a listed manifest must be treated as live
  // even with no (or not-yet-persisted) backup_snapshots row.
  it('keeps a listed manifest\'s exclusive objects live even though no backup_snapshots row retains it', async () => {
    selectQueue.push([]); // unattributedRows
    selectQueue.push([destination]); // destinations
    selectQueue.push([]); // retained snapshots for the identity — NONE (row never persisted)

    // Only ONE manifest fetch expected: snapshot NEW is picked up purely from
    // the listing (not from a retained row), and NEW is the only snapshot in
    // this bucket at all.
    fetchBackupObjectTextMock.mockResolvedValueOnce(
      manifestJson([{ backupPath: 'snapshots/OLD/files/base.dat' }]),
    );

    const recent = new Date(Date.now() - 1 * DAY_MS);
    const old = JUST_PAST_MANIFESTLESS_THRESHOLD();
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/NEW/manifest.json', lastModified: recent }, // listed manifest — no DB row
      { key: 'snapshots/OLD/files/base.dat', lastModified: old }, // referenced by NEW — must survive despite being old and manifest-less
    ]);

    const result = await sweepUnreferencedBackupObjects();

    expect(fetchBackupObjectTextMock).toHaveBeenCalledTimes(1);
    expect(fetchBackupObjectTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'snapshots/NEW/manifest.json' }),
    );
    expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 0, skippedIdentities: 0, blockedIdentities: 0 });
  });

  // FIX 5 — EVERY listed manifest is marked live, not just the newest by
  // object last-modified. The agent picks its incremental dedup base by the
  // manifest's INTERNAL timestamp (agent clock), which can diverge from the S3
  // object's last-modified; so protecting only the newest-by-last-modified
  // could sweep the in-flight backup's actual base out from under it.
  describe('marks every listed manifest, not just the newest (FIX 5)', () => {
    it('protects an OLDER listed manifest (the in-flight dedup base) whose object last-modified is older than a newer sibling', async () => {
      selectQueue.push([]); // unattributedRows
      selectQueue.push([destination]); // destinations
      selectQueue.push([]); // retained snapshots — NONE persisted yet (both are listing-only)

      // Two manifest-bearing snapshots in the listing. NEWER's manifest object
      // is more recently uploaded (server clock), but the in-flight backup is
      // deduping against OLDER (chosen by OLDER's internal agent-clock
      // timestamp), so OLDER references a base object that must survive. Under
      // the old "newest listed manifest only" rule, OLDER would NOT be marked
      // and its referenced base — being past the grace window and manifest-less
      // at that prefix — would be swept, dangling the in-flight reference.
      const newerUpload = new Date(Date.now() - 1 * DAY_MS);
      const olderUpload = new Date(Date.now() - 3 * DAY_MS);
      const baseObjOld = JUST_PAST_MANIFESTLESS_THRESHOLD();

      // Marks are driven by which manifests exist in the listing; both are
      // fetched. NEWER references nothing extra; OLDER references the base.
      fetchBackupObjectTextMock.mockImplementation(async (input: { key: string }) => {
        if (input.key === 'snapshots/NEWER/manifest.json') return manifestJson([]);
        if (input.key === 'snapshots/OLDER/manifest.json') {
          return manifestJson([{ backupPath: 'snapshots/BASE/files/base.dat' }]);
        }
        throw new Error(`unexpected manifest fetch: ${input.key}`);
      });

      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/NEWER/manifest.json', lastModified: newerUpload },
        { key: 'snapshots/OLDER/manifest.json', lastModified: olderUpload },
        { key: 'snapshots/BASE/files/base.dat', lastModified: baseObjOld }, // referenced by OLDER — must survive
      ]);

      const result = await sweepUnreferencedBackupObjects();

      // BOTH manifests were fetched (every listed manifest is marked), and the
      // OLDER manifest's referenced base was NOT deleted.
      expect(fetchBackupObjectTextMock).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'snapshots/NEWER/manifest.json' }),
      );
      expect(fetchBackupObjectTextMock).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'snapshots/OLDER/manifest.json' }),
      );
      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result).toEqual({ deleted: 0, skippedIdentities: 0, blockedIdentities: 0 });
    });
  });

  // FIX 6 — the mark phase only fetches snapshots/<id>/manifest.json for
  // FILE-type snapshots. A non-file snapshot (system_image / hyperv / mssql)
  // sharing a storage identity writes its manifest to a DIFFERENT key and
  // never appears under snapshots/<id>/manifest.json, so including it in the
  // retained set used to 404 the fetch and fail-close the WHOLE identity
  // forever. The retained-rows query now filters to backupType file / NULL.
  describe('non-file snapshots no longer wedge the file-backup sweep (FIX 6)', () => {
    it('does not fail-close the identity when a non-file snapshot shares the bucket', async () => {
      // The retained-rows query (filtered to file-type in SQL) returns only the
      // FILE snapshot; the system_image snapshot's row is excluded and so its
      // non-existent snapshots/IMG1/manifest.json is never fetched. (The SQL
      // WHERE clause itself is exercised by the integration suite — the mocked
      // query builder here can't filter, so we assert the downstream behavior
      // the filter produces: only the file manifest is fetched, no fail-close.)
      selectQueue.push([]); // unattributedRows
      selectQueue.push([destination]); // destinations
      selectQueue.push([{ snapshotId: 'FILE1' }]); // retained FILE-type snapshots ONLY (non-file filtered out)

      fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));

      const old = JUST_PAST_MANIFESTLESS_THRESHOLD();
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/FILE1/manifest.json', lastModified: old },
      ]);

      const result = await sweepUnreferencedBackupObjects();

      // Only the file manifest is fetched; the system_image manifest key is
      // never touched, so the identity is NOT blocked.
      expect(fetchBackupObjectTextMock).toHaveBeenCalledTimes(1);
      expect(fetchBackupObjectTextMock).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'snapshots/FILE1/manifest.json' }),
      );
      expect(fetchBackupObjectTextMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ key: 'snapshots/IMG1/manifest.json' }),
      );
      expect(result).toEqual({ deleted: 0, skippedIdentities: 0, blockedIdentities: 0 });
      expect(captureExceptionMock).not.toHaveBeenCalled();
    });

    it('still fail-closes AND increments blockedIdentities when a genuine FILE manifest is unfetchable', async () => {
      selectQueue.push([]); // unattributedRows
      selectQueue.push([destination]); // destinations
      selectQueue.push([{ snapshotId: 'FILE1' }]); // retained FILE-type snapshot

      // A genuine file manifest that fails to fetch (network/corruption) must
      // still abort the sweep for this identity — the FILE-type filter narrows
      // WHAT is fetched, it does NOT weaken the fail-closed guarantee.
      fetchBackupObjectTextMock.mockRejectedValueOnce(new Error('S3 500 fetching manifest'));

      const old = JUST_PAST_MANIFESTLESS_THRESHOLD();
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/FILE1/manifest.json', lastModified: old },
        { key: 'snapshots/ORPHAN/files/x.dat', lastModified: old }, // would be deletable, but the abort protects it
      ]);

      const result = await sweepUnreferencedBackupObjects();

      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result).toEqual({ deleted: 0, skippedIdentities: 1, blockedIdentities: 1 });
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    });
  });

  // A corrupt/unparseable manifest must abort the identity fail-closed (a live
  // set that silently dropped an unparseable manifest's references could
  // justify deleting still-referenced objects).
  describe('corrupt manifest parse (fail-closed)', () => {
    async function runWithManifestBody(body: string) {
      selectQueue.push([]); // unattributedRows
      selectQueue.push([destination]); // destinations
      selectQueue.push([{ snapshotId: 'B' }]); // retained
      fetchBackupObjectTextMock.mockResolvedValueOnce(body);
      const old = JUST_PAST_MANIFESTLESS_THRESHOLD();
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/B/manifest.json', lastModified: old },
        { key: 'snapshots/A/files/orphan.dat', lastModified: old }, // would be deletable if the live set were trusted
      ]);
      return sweepUnreferencedBackupObjects();
    }

    it('aborts the identity when the manifest body is invalid JSON', async () => {
      const result = await runWithManifestBody('{ this is not json');
      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result).toEqual({ deleted: 0, skippedIdentities: 1, blockedIdentities: 1 });
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    });

    it('aborts the identity when manifest.files is not an array', async () => {
      const result = await runWithManifestBody(JSON.stringify({ files: 'not-an-array' }));
      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result).toEqual({ deleted: 0, skippedIdentities: 1, blockedIdentities: 1 });
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    });
  });

  // Boundary tests for the strict-`>` timing operators. Time is frozen so
  // Date.now() inside the sweep matches the fixture ages to the millisecond;
  // otherwise the few-ms gap between constructing the fixture and the sweep
  // reading the clock would make a ±1ms assertion flaky.
  describe('timing-operator boundaries (strict >)', () => {
    const FIXED_NOW = 1_700_000_000_000;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(FIXED_NOW);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    // Manifest-bearing prefix, per-object 48h grace: an object is deletable
    // when `lastModified > graceThreshold` is FALSE, i.e. at age EXACTLY 48h it
    // is swept, and 1ms short of 48h it is kept.
    async function sweepLooseObjectAtAge(ageMs: number) {
      selectQueue.push([]); // unattributedRows
      selectQueue.push([destination]); // destinations
      selectQueue.push([{ snapshotId: 'B' }]); // retained
      fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([])); // B references nothing
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        // manifest.json is in the live set (markLive adds it) — never a candidate
        { key: 'snapshots/B/manifest.json', lastModified: new Date(FIXED_NOW - 30 * DAY_MS) },
        { key: 'snapshots/B/files/obj.dat', lastModified: new Date(FIXED_NOW - ageMs) },
      ]);
      deleteBackupObjectKeysMock.mockResolvedValueOnce({
        deletedKeys: ['snapshots/B/files/obj.dat'],
        failedKeys: [],
      });
      return sweepUnreferencedBackupObjects();
    }

    it('sweeps a loose object at EXACTLY 48h (not strictly inside the grace window)', async () => {
      const result = await sweepLooseObjectAtAge(BACKUP_GC_GRACE_MS);
      expect(result.deleted).toBe(1);
    });

    it('keeps a loose object 1ms short of 48h (still strictly inside the grace window)', async () => {
      const result = await sweepLooseObjectAtAge(BACKUP_GC_GRACE_MS - 1);
      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result.deleted).toBe(0);
    });

    it('sweeps a loose object 1ms past 48h', async () => {
      const result = await sweepLooseObjectAtAge(BACKUP_GC_GRACE_MS + 1);
      expect(result.deleted).toBe(1);
    });

    // Manifest-less prefix, 9-day prefix protection: the prefix is protected
    // when its newest object age is `> manifestlessThreshold` (strictly inside
    // the window). At age EXACTLY 9 days it is swept; 1ms short it is protected.
    async function sweepManifestlessPrefixAtNewestAge(ageMs: number) {
      selectQueue.push([]); // unattributedRows
      selectQueue.push([destination]); // destinations
      selectQueue.push([{ snapshotId: 'B' }]); // retained (marked, not in listing)
      fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        // No snapshots/C/manifest.json → C is a manifest-less prefix.
        { key: 'snapshots/C/files/partial.dat', lastModified: new Date(FIXED_NOW - ageMs) },
      ]);
      deleteBackupObjectKeysMock.mockResolvedValueOnce({
        deletedKeys: ['snapshots/C/files/partial.dat'],
        failedKeys: [],
      });
      return sweepUnreferencedBackupObjects();
    }

    it('sweeps a manifest-less prefix whose newest object is EXACTLY at the 9-day threshold', async () => {
      const result = await sweepManifestlessPrefixAtNewestAge(BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS);
      expect(result.deleted).toBe(1);
    });

    it('protects a manifest-less prefix whose newest object is 1ms short of the 9-day threshold', async () => {
      const result = await sweepManifestlessPrefixAtNewestAge(BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS - 1);
      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result.deleted).toBe(0);
    });

    it('sweeps a manifest-less prefix whose newest object is 1ms past the 9-day threshold', async () => {
      const result = await sweepManifestlessPrefixAtNewestAge(BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS + 1);
      expect(result.deleted).toBe(1);
    });
  });
});

// normalizeStorageIdentity must collapse cosmetic differences between configs
// describing the SAME physical bucket, or two configs on one bucket split into
// two identities and cross-config deletion comes back via the back door.
describe('normalizeStorageIdentity', () => {
  it('treats a blank S3 endpoint as identical to an explicit default AWS endpoint', () => {
    const blank = normalizeStorageIdentity('s3', { bucket: 'my-bucket' });
    const explicitGlobalDefault = normalizeStorageIdentity('s3', {
      bucket: 'my-bucket',
      endpoint: 'https://s3.amazonaws.com',
    });
    const explicitRegionalDefault = normalizeStorageIdentity('s3', {
      bucket: 'my-bucket',
      endpoint: 's3.us-west-2.amazonaws.com',
    });

    expect(blank).toBe(explicitGlobalDefault);
    expect(blank).toBe(explicitRegionalDefault);
  });

  it('treats an endpoint trailing slash and host case as cosmetic', () => {
    const withSlashAndMixedCase = normalizeStorageIdentity('s3', {
      bucket: 'my-bucket',
      endpoint: 'https://Minio.local:9000/',
    });
    const canonical = normalizeStorageIdentity('s3', {
      bucket: 'my-bucket',
      endpoint: 'https://minio.local:9000',
    });

    expect(withSlashAndMixedCase).toBe(canonical);
  });

  it('treats a scheme-less endpoint as identical to its https-schemed equivalent', () => {
    const schemeLess = normalizeStorageIdentity('s3', { bucket: 'my-bucket', endpoint: 'minio.local:9000' });
    const schemed = normalizeStorageIdentity('s3', { bucket: 'my-bucket', endpoint: 'https://minio.local:9000' });

    expect(schemeLess).toBe(schemed);
  });

  it('normalizes local provider paths (trailing slash, double slash, "." segments) via path.resolve', () => {
    const trailingSlash = normalizeStorageIdentity('local', { path: '/mnt/backups/' });
    const doubleSlash = normalizeStorageIdentity('local', { path: '/mnt//backups' });
    const dotSegment = normalizeStorageIdentity('local', { path: '/mnt/backups/./' });

    expect(trailingSlash).toBe(doubleSlash);
    expect(trailingSlash).toBe(dotSegment);
  });

  it('produces DIFFERENT identities for genuinely different buckets and hosts', () => {
    const bucketA = normalizeStorageIdentity('s3', { bucket: 'bucket-a', endpoint: 'https://minio.local:9000' });
    const bucketB = normalizeStorageIdentity('s3', { bucket: 'bucket-b', endpoint: 'https://minio.local:9000' });
    const differentHost = normalizeStorageIdentity('s3', { bucket: 'bucket-a', endpoint: 'https://other-host.local:9000' });
    const differentLocalPath = normalizeStorageIdentity('local', { path: '/mnt/backups' });

    expect(bucketA).not.toBe(bucketB);
    expect(bucketA).not.toBe(differentHost);
    expect(bucketA).not.toBe(differentLocalPath);
  });
});

// BACKUP_GC_MAX_DELETES_PER_RUN='' (unset-but-present, e.g. a templated .env)
// must behave as unset (default 2000), not as the explicit
// "0 = unlimited" convention: `Number('')` is 0 in JS, so without a trim+empty
// guard an accidentally-blank env var would silently disable the cap.
describe('resolveBackupGcMaxDeletesPerRun', () => {
  afterEach(() => {
    delete process.env.BACKUP_GC_MAX_DELETES_PER_RUN;
  });

  it('defaults to 2000 when unset', () => {
    delete process.env.BACKUP_GC_MAX_DELETES_PER_RUN;
    expect(resolveBackupGcMaxDeletesPerRun()).toBe(2000);
  });

  it('treats an empty string as unset, not as 0=unlimited', () => {
    process.env.BACKUP_GC_MAX_DELETES_PER_RUN = '';
    expect(resolveBackupGcMaxDeletesPerRun()).toBe(2000);
  });

  it('treats a whitespace-only string as unset, not as 0=unlimited', () => {
    process.env.BACKUP_GC_MAX_DELETES_PER_RUN = '   ';
    expect(resolveBackupGcMaxDeletesPerRun()).toBe(2000);
  });

  it('treats an explicit "0" as unlimited', () => {
    process.env.BACKUP_GC_MAX_DELETES_PER_RUN = '0';
    expect(resolveBackupGcMaxDeletesPerRun()).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('parses a positive override', () => {
    process.env.BACKUP_GC_MAX_DELETES_PER_RUN = '500';
    expect(resolveBackupGcMaxDeletesPerRun()).toBe(500);
  });

  it('falls back to the default for a negative/NaN override', () => {
    process.env.BACKUP_GC_MAX_DELETES_PER_RUN = 'not-a-number';
    expect(resolveBackupGcMaxDeletesPerRun()).toBe(2000);
  });
});
