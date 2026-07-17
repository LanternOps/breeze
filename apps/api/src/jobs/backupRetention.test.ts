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

const {
  computeExpiresAt,
  cleanupExpiredSnapshots,
  sweepUnreferencedBackupObjects,
  resolveBackupGcMaxDeletesPerRun,
  BACKUP_GC_GRACE_MS,
  BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS,
} = await import('./backupRetention');

const DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * DAY_MS;

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
    expect(result).toEqual({ deleted: 1, skippedDestinations: 0 });
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
    expect(result).toEqual({ deleted: 0, skippedDestinations: 0 });
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
    expect(result).toEqual({ deleted: 0, skippedDestinations: 0 });
  });

  // CRITICAL 3 — manifest-less prefixes are protected at PREFIX granularity
  // for BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS (7 days, mirrors the agent's
  // journalMaxAge), not the 48h loose-object grace.
  describe('manifest-less prefix protection (CRITICAL 3)', () => {
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
      expect(result).toEqual({ deleted: 0, skippedDestinations: 0 });
    });

    it('sweeps a manifest-less prefix in full once its newest object clears the 7-day window', async () => {
      selectQueue.push([]);
      selectQueue.push([destination]);
      selectQueue.push([{ snapshotId: 'B' }]);

      fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));

      const allOld = new Date(Date.now() - SEVEN_DAYS_MS - DAY_MS); // 8 days — past the window
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

    it('BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS matches the agent journalMaxAge (7 days)', () => {
      expect(BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
    });
  });

  it('aborts the sweep for an identity whose manifest fetch fails, but still processes other identities', async () => {
    // Listing now happens before marking for EVERY identity (IMPORTANT 2
    // needs the listing to find the newest listed manifest), so both
    // identities get listed — the broken one's mark phase then fails on the
    // manifest fetch for its retained snapshot and aborts BEFORE any delete.
    const destinationBroken = { id: 'cfg-broken', provider: 's3', providerConfig: { bucket: 'b1', region: 'us-east-1' } };
    const destinationOk = { id: 'cfg-ok', provider: 's3', providerConfig: { bucket: 'b2', region: 'us-east-1' } };

    selectQueue.push([]); // unattributedRows
    selectQueue.push([destinationBroken, destinationOk]); // destinations
    selectQueue.push([{ snapshotId: 'X' }]); // retained for destinationBroken's identity
    selectQueue.push([{ snapshotId: 'Y' }]); // retained for destinationOk's identity

    fetchBackupObjectTextMock
      .mockRejectedValueOnce(new Error('network error fetching manifest')) // destinationBroken's snapshot X
      .mockResolvedValueOnce(manifestJson([])); // destinationOk's snapshot Y

    const old = new Date(Date.now() - SEVEN_DAYS_MS - DAY_MS);
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
    expect(result).toEqual({ deleted: 1, skippedDestinations: 1 });
  });

  it('honors the per-run deletion cap, leaving the rest for a later run', async () => {
    process.env.BACKUP_GC_MAX_DELETES_PER_RUN = '1';

    selectQueue.push([]);
    selectQueue.push([destination]);
    selectQueue.push([{ snapshotId: 'B' }]);

    fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));

    const old = new Date(Date.now() - SEVEN_DAYS_MS - DAY_MS);
    const older = new Date(Date.now() - SEVEN_DAYS_MS - 2 * DAY_MS);
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
    expect(result).toEqual({ deleted: 0, skippedDestinations: 1 });
  });

  it('does not crash the sweep when a delete is rejected (e.g. object-lock) — counts it and moves on', async () => {
    selectQueue.push([]);
    selectQueue.push([destination]);
    selectQueue.push([{ snapshotId: 'B' }]);

    fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));

    const old = new Date(Date.now() - SEVEN_DAYS_MS - DAY_MS);
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/B/manifest.json', lastModified: old },
      { key: 'snapshots/A/files/locked.dat', lastModified: old },
    ]);

    deleteBackupObjectKeysMock.mockResolvedValueOnce({
      deletedKeys: [],
      failedKeys: [{ key: 'snapshots/A/files/locked.dat', error: 'AccessDenied: object locked' }],
    });

    const result = await sweepUnreferencedBackupObjects();

    expect(result).toEqual({ deleted: 0, skippedDestinations: 0 });
  });

  // CRITICAL 1 — sweep scope must be storage identity (provider + endpoint +
  // bucket, excluding prefix), not backupConfigs row, or two configs on one
  // bucket mass-delete each other's backups.
  describe('storage identity grouping (CRITICAL 1 / IMPORTANT 1)', () => {
    it('unions retained snapshots across two configs sharing one physical bucket, so neither can delete the other\'s live objects', async () => {
      const configA = { id: 'cfg-a', provider: 's3', providerConfig: { bucket: 'shared-bucket', region: 'us-east-1' } };
      const configB = { id: 'cfg-b', provider: 's3', providerConfig: { bucket: 'shared-bucket', region: 'us-east-1' } };

      selectQueue.push([]); // unattributedRows
      selectQueue.push([configA, configB]); // destinations — same identity (same bucket)
      selectQueue.push([{ snapshotId: 'A' }, { snapshotId: 'B' }]); // retained rows unioned across BOTH configs

      // A's manifest has no references of its own; B's manifest (a
      // different config's snapshot, same bucket) references an object that
      // physically lives under A's prefix — the cross-config reference C1 protects.
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
      expect(result).toEqual({ deleted: 0, skippedDestinations: 0 });
    });

    it('blocks the entire run when any backup_snapshots row has a null config_id (cannot be attributed to a bucket)', async () => {
      selectQueue.push([{ id: 'orphan-snap-1' }]); // unattributedRows — one exists
      selectQueue.push([destination]); // destinations — used only to size skippedDestinations

      const result = await sweepUnreferencedBackupObjects();

      expect(fetchBackupObjectTextMock).not.toHaveBeenCalled();
      expect(listBackupObjectsUnderPrefixMock).not.toHaveBeenCalled();
      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result).toEqual({ deleted: 0, skippedDestinations: 1 });
    });
  });

  // IMPORTANT 2 — dedup-source race: agents pick their reference base from
  // the bucket LISTING, not from DB rows, so the newest listed manifest must
  // be treated as live even with no (or not-yet-persisted) backup_snapshots row.
  it('keeps the newest listed manifest\'s exclusive objects live even though no backup_snapshots row retains it', async () => {
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
    const old = new Date(Date.now() - SEVEN_DAYS_MS - DAY_MS);
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/NEW/manifest.json', lastModified: recent }, // newest manifest in the listing — no DB row
      { key: 'snapshots/OLD/files/base.dat', lastModified: old }, // referenced by NEW — must survive despite being old and manifest-less
    ]);

    const result = await sweepUnreferencedBackupObjects();

    expect(fetchBackupObjectTextMock).toHaveBeenCalledTimes(1);
    expect(fetchBackupObjectTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'snapshots/NEW/manifest.json' }),
    );
    expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 0, skippedDestinations: 0 });
  });
});

// MINOR — BACKUP_GC_MAX_DELETES_PER_RUN='' (unset-but-present, e.g. a
// templated .env) must behave as unset (default 2000), not as the explicit
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
