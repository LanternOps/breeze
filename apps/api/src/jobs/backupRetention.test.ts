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
  BACKUP_GC_GRACE_MS,
} = await import('./backupRetention');

const DAY_MS = 24 * 60 * 60 * 1000;

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
    // cross-prefix backupPath — the incremental "reference" mechanism.
    selectQueue.push([destination]); // destinations
    selectQueue.push([{ snapshotId: 'B' }]); // retained snapshots for cfg-1

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

  it('keeps an unreferenced object that is still inside the grace window', async () => {
    selectQueue.push([destination]);
    selectQueue.push([{ snapshotId: 'B' }]);

    fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));

    const withinGrace = new Date(Date.now() - 1 * 60 * 60 * 1000); // 1h old, grace is 48h
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/B/manifest.json', lastModified: withinGrace },
      { key: 'snapshots/C/files/pending.dat', lastModified: withinGrace },
    ]);

    const result = await sweepUnreferencedBackupObjects();

    expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 0, skippedDestinations: 0 });
  });

  it('sweeps a manifest-less prefix entirely once every object under it clears the grace window', async () => {
    // "snapshots/C/" never got a manifest.json (partial/crashed run) — by
    // construction nothing can reference it (dedup only ever consults a
    // completed prior manifest), so once past grace it's cleaned wholesale.
    selectQueue.push([destination]);
    selectQueue.push([{ snapshotId: 'B' }]);

    fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));

    const old = new Date(Date.now() - 3 * DAY_MS);
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/B/manifest.json', lastModified: old },
      { key: 'snapshots/C/files/partial-1.dat', lastModified: old },
      { key: 'snapshots/C/files/partial-2.dat', lastModified: old },
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

  it('aborts the sweep for a destination whose manifest fetch fails, but still processes other destinations', async () => {
    const destinationBroken = { id: 'cfg-broken', provider: 's3', providerConfig: { bucket: 'b1', region: 'us-east-1' } };
    const destinationOk = { id: 'cfg-ok', provider: 's3', providerConfig: { bucket: 'b2', region: 'us-east-1' } };

    selectQueue.push([destinationBroken, destinationOk]); // destinations
    selectQueue.push([{ snapshotId: 'X' }]); // retained for destinationBroken
    selectQueue.push([{ snapshotId: 'Y' }]); // retained for destinationOk

    fetchBackupObjectTextMock
      .mockRejectedValueOnce(new Error('network error fetching manifest')) // destinationBroken
      .mockResolvedValueOnce(manifestJson([])); // destinationOk

    const old = new Date(Date.now() - 5 * DAY_MS);
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/Y/manifest.json', lastModified: old },
      { key: 'snapshots/Y/files/orphan.dat', lastModified: old },
    ]);

    deleteBackupObjectKeysMock.mockResolvedValueOnce({
      deletedKeys: ['snapshots/Y/files/orphan.dat'],
      failedKeys: [],
    });

    const result = await sweepUnreferencedBackupObjects();

    // destinationBroken never got as far as listing/deleting.
    expect(listBackupObjectsUnderPrefixMock).toHaveBeenCalledTimes(1);
    expect(listBackupObjectsUnderPrefixMock).toHaveBeenCalledWith(
      expect.objectContaining({ providerConfig: destinationOk.providerConfig }),
    );
    expect(deleteBackupObjectKeysMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ deleted: 1, skippedDestinations: 1 });
  });

  it('honors the per-run deletion cap, leaving the rest for a later run', async () => {
    process.env.BACKUP_GC_MAX_DELETES_PER_RUN = '1';

    selectQueue.push([destination]);
    selectQueue.push([{ snapshotId: 'B' }]);

    fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));

    const old = new Date(Date.now() - 10 * DAY_MS);
    const older = new Date(Date.now() - 20 * DAY_MS);
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

  it('skips a destination whose provider has no GC listing support, without touching storage', async () => {
    const unsupported = { id: 'cfg-azure', provider: 'azure_blob', providerConfig: {} };
    selectQueue.push([unsupported]);

    const result = await sweepUnreferencedBackupObjects();

    expect(fetchBackupObjectTextMock).not.toHaveBeenCalled();
    expect(listBackupObjectsUnderPrefixMock).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 0, skippedDestinations: 1 });
  });

  it('does not crash the sweep when a delete is rejected (e.g. object-lock) — counts it and moves on', async () => {
    selectQueue.push([destination]);
    selectQueue.push([{ snapshotId: 'B' }]);

    fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));

    const old = new Date(Date.now() - 10 * DAY_MS);
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
});
