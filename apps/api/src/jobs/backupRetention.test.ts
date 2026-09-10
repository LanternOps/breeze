import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupSnapshots } from '../db/schema';

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
    groupBy: () => obj,
    limit: () => obj,
    for: () => obj,
    set: () => obj, // db.update(...).set({...}) — returns itself so .where()/.returning() still chain
    returning: () => obj, // db.delete(...).returning() / db.update(...).returning()
    then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return obj;
}

const selectQueue: unknown[][] = [];
const insertedRows: unknown[] = [];
// Captures every db.update(<table>).set(<payload>) call so a test can assert
// WHICH row(s) a write targeted (review round 1, finding 5: proving the
// cross-identity snapshotId self-heal collision guard needs to see the
// actual .set() payload, which the generic `chainable` no-op can't record).
const updateCalls: { table: unknown; payload: Record<string, unknown> }[] = [];

const mockDb = {
  select: vi.fn(() => chainable(selectQueue.shift() ?? [])),
  // selectDistinct shares the SAME selectQueue as select — from the test's
  // perspective they're both just "the next db read in source order".
  // identityHasLegacyHelper (D18 W02 capability gate) is the only
  // selectDistinct call site in backupRetention.ts.
  selectDistinct: vi.fn(() => chainable(selectQueue.shift() ?? [])),
  delete: vi.fn(() => chainable([])),
  update: vi.fn((table: unknown) => ({
    set: (payload: Record<string, unknown>) => {
      updateCalls.push({ table, payload });
      return chainable([]);
    },
  })),
  insert: vi.fn((_table: unknown) => ({
    values: (v: unknown) => {
      insertedRows.push(v);
      return chainable([]);
    },
  })),
};

const assertOutsideHeldDbContextMock = vi.fn();
vi.mock('../db', () => ({
  db: mockDb,
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  // D18 §3.7 review fix: cleanupExpiredSnapshots/sweepStorageIdentity assert
  // no ambient context is held on entry — a pass-through here (this suite's
  // mock has no real context tracking), but still a vi.fn() so the §3.7
  // tripwire test can assert it fires with the right operation label.
  assertOutsideHeldDbContext: assertOutsideHeldDbContextMock,
}));

// Redis-backed failed-key skip set (D18 W02, Task 6) — shared non-blocking
// client mock, mirroring alertCooldown.ts's isRedisAvailable()/getRedis() usage.
const redisSaddMock = vi.fn();
const redisExpireMock = vi.fn();
const redisSmembersMock = vi.fn();
let redisAvailableForTest = true;
vi.mock('../services/redis', () => ({
  isRedisAvailable: () => redisAvailableForTest,
  getRedis: () => (redisAvailableForTest ? { sadd: redisSaddMock, expire: redisExpireMock, smembers: redisSmembersMock } : null),
}));

// notFoundError mirrors what isBackupObjectNotFound (backupSnapshotStorage.ts)
// recognizes as "object absent" (S3's NoSuchKey / local's ENOENT) — used
// below as fetchBackupObjectTextMock's DEFAULT (base) implementation.
function notFoundError(): Error {
  return Object.assign(new Error('not found'), { name: 'NoSuchKey' });
}

// fetchBackupObjectTextMock's base implementation always rejects "not found".
// markLiveBackupObjects now fetches TWO keys per snapshot — the ordinary
// manifest, then (D15) the system-state manifest — and the vast majority of
// tests in this file only care about the ordinary one. vi.fn()'s queued
// `.mockResolvedValueOnce`/`.mockRejectedValueOnce` calls are consumed
// strictly in CALL order regardless of the key argument, so as long as each
// test queues exactly one entry per snapshot's ORDINARY manifest fetch (the
// existing, unchanged convention), the interleaved system-state fetch calls
// fall through to this base implementation and resolve as "no system state
// for this snapshot" — the routine, expected case for a file-mode snapshot —
// without every pre-existing test needing to queue a second entry. Tests that
// DO care about system-state behavior override this per-call via
// `mockImplementation`/explicit `.Once` queuing, same as any other vi.fn().
const fetchBackupObjectTextMock = vi.fn<
  (input: { provider: string | null | undefined; providerConfig: unknown; key: string }) => Promise<string>
>(async () => {
  throw notFoundError();
});
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
  resolveBackupGcGraceMs,
  resolveBackupManifestlessPrefixMaxAgeMs,
  normalizeStorageIdentity,
  orphanManifestSnapshotIds,
} = await import('./backupRetention');

const DAY_MS = 24 * 60 * 60 * 1000;
const AGENT_JOURNAL_MAX_AGE_MS = 7 * DAY_MS;
const MANIFESTLESS_WINDOW_MS_DEFAULT = 9 * DAY_MS;
// BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS is no longer a module-load export
// (D18 W02, Task 1) — its default (9 days) is a fixture constant here,
// independent of the real per-run resolver under test. The frozen-time
// boundary tests later in this file exercise the resolver's actual output
// directly; these two helpers only need "comfortably past the default" for
// tests that don't care about the exact boundary.
const JUST_PAST_MANIFESTLESS_THRESHOLD = () =>
  new Date(Date.now() - MANIFESTLESS_WINDOW_MS_DEFAULT - DAY_MS);
const EVEN_FURTHER_PAST_MANIFESTLESS_THRESHOLD = () =>
  new Date(Date.now() - MANIFESTLESS_WINDOW_MS_DEFAULT - 2 * DAY_MS);

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

describe('cleanupExpiredSnapshots -- pins + retirement (D18 W01 section 3.2/3.3/3.7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue.length = 0;
    insertedRows.length = 0;
  });

  it('deletes only the DB row for an expired snapshot, writes a retirement row, and never touches object storage directly', async () => {
    // Regression test for the incremental-backup GC bug: row-level retention
    // used to eagerly delete a snapshot's whole storage prefix, which would
    // destroy objects a still-retained sibling snapshot's manifest
    // references. Object deletion is now exclusively GC's job.
    selectQueue.push([
      {
        id: 'snap-expired-1', snapshotId: 'snap-1', deviceId: 'device-1', configId: 'config-1',
        storageIdentity: 's3::e::b', backupType: 'file',
      },
    ]); // expired query (enumeration pass)
    selectQueue.push([{ id: 'snap-expired-1', legalHold: false, isImmutable: false, immutableUntil: null }]); // FOR UPDATE lock
    selectQueue.push([]); // backup pin -- none
    selectQueue.push([]); // restore pin -- none
    selectQueue.push([]); // recovery pin -- none
    selectQueue.push([]); // versionBoundSnapshots query (maxVersions pass) -- read AFTER the expired-row loop

    const result = await cleanupExpiredSnapshots('org-1');

    expect(result.deleted).toBe(1);
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(insertedRows).toEqual([
      expect.objectContaining({ snapshotId: 'snap-1', storageIdentity: 's3::e::b', reason: 'expired' }),
    ]);
    expect(fetchBackupObjectTextMock).not.toHaveBeenCalled();
    expect(listBackupObjectsUnderPrefixMock).not.toHaveBeenCalled();
    expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
  });

  it('skips a row pinned by an in-flight backup_jobs base pin and counts it as skippedPinned (no retirement written)', async () => {
    selectQueue.push([
      { id: 'snap-pinned', snapshotId: 'snap-pinned-provider', deviceId: 'device-1', configId: 'config-1', storageIdentity: 's3::e::b', backupType: 'file' },
    ]); // expired query
    selectQueue.push([{ id: 'snap-pinned', legalHold: false, isImmutable: false, immutableUntil: null }]); // FOR UPDATE lock
    selectQueue.push([{ id: 'job-1' }]); // backup pin -- found, short-circuits
    selectQueue.push([]); // versionBoundSnapshots query

    const result = await cleanupExpiredSnapshots('org-1');

    expect(result.skippedPinned).toBe(1);
    expect(result.deleted).toBe(0);
    expect(insertedRows.length).toBe(0);
  });

  it('re-reads legal hold under the FOR UPDATE lock, ignoring a stale enumeration-pass value (the enumeration select no longer even fetches it)', async () => {
    selectQueue.push([
      { id: 'snap-hold', snapshotId: 'snap-hold-provider', deviceId: 'device-1', configId: 'config-1', storageIdentity: 's3::e::b', backupType: 'file' },
    ]); // expired query
    selectQueue.push([{ id: 'snap-hold', legalHold: true, isImmutable: false, immutableUntil: null }]); // FOR UPDATE lock -- held
    selectQueue.push([]); // versionBoundSnapshots query

    const result = await cleanupExpiredSnapshots('org-1');

    expect(result.skippedLegalHold).toBe(1);
    expect(result.deleted).toBe(0);
    expect(insertedRows.length).toBe(0);
  });

  it('skips (does not retire) a row with an unresolved storage_identity and counts it as skippedUnresolved', async () => {
    selectQueue.push([
      { id: 'snap-unresolved', snapshotId: 'snap-unresolved-provider', deviceId: 'device-1', configId: null, storageIdentity: null, backupType: 'file' },
    ]); // expired query
    selectQueue.push([{ id: 'snap-unresolved', legalHold: false, isImmutable: false, immutableUntil: null }]); // FOR UPDATE lock
    selectQueue.push([]); // versionBoundSnapshots query

    const result = await cleanupExpiredSnapshots('org-1');

    expect(result.skippedUnresolved).toBe(1);
    expect(result.deleted).toBe(0);
    expect(insertedRows.length).toBe(0); // no invented 'unknown::<uuid>' retirement is ever written
  });

  it('prunes the oldest snapshots past retention.maxVersions, skipping legal-hold and immutable rows (both re-read under the lock)', async () => {
    // Exercises the version-bound prune loop, which no other test reaches
    // (the versionBoundSnapshots query is normally fed []). One device/config
    // group with 5 snapshots (newest-first) and maxVersions=2: the 2 newest
    // are kept, the remaining 3 are pruning candidates. Of those, one is on
    // legal hold and one is still immutable (both re-decided under the
    // FOR UPDATE lock, not from the enumeration pass), leaving exactly one
    // prunable row.
    selectQueue.push([]); // expired query -- nothing expired by date

    const future = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000);
    const retention = { maxVersions: 2 };
    const base = {
      deviceId: 'd1', configId: 'c1', storageIdentity: 's3::e::b', backupType: 'file' as const, retention,
    };
    selectQueue.push([
      { ...base, id: 's1', snapshotId: 'snap-1', timestamp: new Date('2026-05-05') }, // kept (within maxVersions)
      { ...base, id: 's2', snapshotId: 'snap-2', timestamp: new Date('2026-05-04') }, // kept
      { ...base, id: 's3', snapshotId: 'snap-3', timestamp: new Date('2026-05-03') }, // over cap, legal hold at lock time
      { ...base, id: 's4', snapshotId: 'snap-4', timestamp: new Date('2026-05-02') }, // over cap, immutable at lock time
      { ...base, id: 's5', snapshotId: 'snap-5', timestamp: new Date('2026-05-01') }, // pruned by maxVersions
    ]); // versionBoundSnapshots query

    // Per-candidate FOR UPDATE locks + pin checks, in slice order [s3, s4, s5]:
    selectQueue.push([{ id: 's3', legalHold: true, isImmutable: false, immutableUntil: null }]); // s3 lock -- held
    selectQueue.push([{ id: 's4', legalHold: false, isImmutable: true, immutableUntil: future }]); // s4 lock -- immutable
    selectQueue.push([{ id: 's5', legalHold: false, isImmutable: false, immutableUntil: null }]); // s5 lock -- clean
    selectQueue.push([]); // s5 backup pin -- none
    selectQueue.push([]); // s5 restore pin -- none
    selectQueue.push([]); // s5 recovery pin -- none

    const result = await cleanupExpiredSnapshots('org-1');

    expect(result.prunedByMaxVersions).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.skippedLegalHold).toBe(1);
    expect(result.skippedImmutable).toBe(1);
    expect(mockDb.delete).toHaveBeenCalledTimes(1); // only s5 physically deleted
    expect(insertedRows).toEqual([
      expect.objectContaining({ snapshotId: 'snap-5', reason: 'max_versions' }),
    ]);
  });

  it('logs and skips a row whose delete rejects with a FK violation (D17), and still deletes the next expired row', async () => {
    // Reproduces the live lab failure: a snapshot that was ever restored (or
    // verified/tokened) still has a NO-ACTION-FK history row pointing at it
    // (e.g. restore_jobs.snapshot_id), so its DELETE raised 23503. Before the
    // fix that aborted cleanupExpiredSnapshots entirely, so no other expired
    // row in the org -- let alone the object-storage sweep that runs after
    // this job in backupWorker.ts -- was ever reached. Per-row isolation
    // means the bad row is logged and skipped while the next expired row is
    // still deleted.
    selectQueue.push([
      { id: 'snap-fk-blocked', snapshotId: 'snap-blocked', deviceId: 'device-1', configId: 'config-1', storageIdentity: 's3::e::b', backupType: 'file' },
      { id: 'snap-ok', snapshotId: 'snap-2', deviceId: 'device-1', configId: 'config-1', storageIdentity: 's3::e::b', backupType: 'file' },
    ]); // expired query
    // Row 1 (snap-fk-blocked): lock + 3 pin checks, all clear, then the
    // delete itself throws.
    selectQueue.push([{ id: 'snap-fk-blocked', legalHold: false, isImmutable: false, immutableUntil: null }]);
    selectQueue.push([]); // backup pin
    selectQueue.push([]); // restore pin
    selectQueue.push([]); // recovery pin
    // Row 2 (snap-ok): lock + 3 pin checks, all clear, delete succeeds.
    selectQueue.push([{ id: 'snap-ok', legalHold: false, isImmutable: false, immutableUntil: null }]);
    selectQueue.push([]); // backup pin
    selectQueue.push([]); // restore pin
    selectQueue.push([]); // recovery pin
    selectQueue.push([]); // versionBoundSnapshots query (maxVersions pass)

    const fkError = Object.assign(
      new Error(
        'update or delete on table "backup_snapshots" violates foreign key constraint ' +
          '"restore_jobs_snapshot_id_backup_snapshots_id_fk" on table "restore_jobs"',
      ),
      { code: '23503', constraint_name: 'restore_jobs_snapshot_id_backup_snapshots_id_fk' },
    );

    mockDb.delete
      .mockImplementationOnce(() => ({ where: () => Promise.reject(fkError) }))
      .mockImplementationOnce(() => chainable([]));

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await cleanupExpiredSnapshots('org-1');

    expect(mockDb.delete).toHaveBeenCalledTimes(2); // both rows attempted
    expect(result.deleted).toBe(1); // only snap-ok
    expect(result.failed).toBe(1); // snap-fk-blocked counted as a failure, not silently dropped

    // The per-row error surfaces the snapshot id and the PG SQLSTATE/constraint
    // so an operator can tell an FK violation from an unrelated DB error.
    const rowErrorCall = consoleErrorSpy.mock.calls.find(
      ([msg]) => typeof msg === 'string' && msg.includes('snap-blocked'),
    );
    expect(rowErrorCall).toBeDefined();
    expect(rowErrorCall?.[0]).toContain('23503');
    expect(rowErrorCall?.[0]).toContain('restore_jobs_snapshot_id_backup_snapshots_id_fk');

    // A run-level summary is also logged when any row failed.
    expect(
      consoleErrorSpy.mock.calls.some(
        ([msg]) => typeof msg === 'string' && msg.includes('org-1') && msg.includes('1'),
      ),
    ).toBe(true);
    expect(captureExceptionMock).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});

describe('resolveBackupGcGraceMs (per-run)', () => {
  const prev = process.env.BACKUP_GC_GRACE_MS;
  const prevEnv = process.env.NODE_ENV;
  afterEach(() => {
    if (prev === undefined) delete process.env.BACKUP_GC_GRACE_MS; else process.env.BACKUP_GC_GRACE_MS = prev;
    if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
  });

  it('defaults to 48h when unset', () => {
    delete process.env.BACKUP_GC_GRACE_MS;
    expect(resolveBackupGcGraceMs()).toBe(48 * 60 * 60 * 1000);
  });

  it('honors a positive override outside production', () => {
    process.env.NODE_ENV = 'test';
    process.env.BACKUP_GC_GRACE_MS = '1000';
    expect(resolveBackupGcGraceMs()).toBe(1000);
  });

  it('floors an override below 1h in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.BACKUP_GC_GRACE_MS = '1000';
    expect(resolveBackupGcGraceMs()).toBe(60 * 60 * 1000);
  });

  it('re-resolves on every call (no module-load caching)', () => {
    process.env.NODE_ENV = 'test';
    process.env.BACKUP_GC_GRACE_MS = '5000';
    expect(resolveBackupGcGraceMs()).toBe(5000);
    process.env.BACKUP_GC_GRACE_MS = '9000';
    expect(resolveBackupGcGraceMs()).toBe(9000);
  });
});

describe('resolveBackupManifestlessPrefixMaxAgeMs (per-run)', () => {
  const prev = process.env.BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS;
  afterEach(() => {
    if (prev === undefined) delete process.env.BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS;
    else process.env.BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS = prev;
  });

  it('defaults to 9 days (journalMaxAge + 48h), strictly greater than journalMaxAge', () => {
    delete process.env.BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS;
    const resolved = resolveBackupManifestlessPrefixMaxAgeMs();
    expect(resolved).toBe(9 * 24 * 60 * 60 * 1000);
    expect(resolved).toBeGreaterThan(AGENT_JOURNAL_MAX_AGE_MS);
  });

  it('never allows an override at or below journalMaxAge in production (floor holds)', () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS = String(AGENT_JOURNAL_MAX_AGE_MS);
    try {
      expect(resolveBackupManifestlessPrefixMaxAgeMs()).toBeGreaterThan(AGENT_JOURNAL_MAX_AGE_MS);
    } finally {
      if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
    }
  });
});

describe('orphanManifestSnapshotIds (pure)', () => {
  it('returns only young, unretained, unretired manifest-bearing ids', () => {
    const groups = new Map([
      ['young', { items: [], manifestItem: { key: 'snapshots/young/manifest.json', lastModified: new Date(Date.now() - DAY_MS) } }],
      ['old', { items: [], manifestItem: { key: 'snapshots/old/manifest.json', lastModified: new Date(Date.now() - 20 * DAY_MS) } }],
      ['retained', { items: [], manifestItem: { key: 'snapshots/retained/manifest.json', lastModified: new Date(Date.now() - 20 * DAY_MS) } }],
      ['retired', { items: [], manifestItem: { key: 'snapshots/retired/manifest.json', lastModified: new Date(Date.now() - DAY_MS) } }],
      ['nomanifest', { items: [{ key: 'snapshots/nomanifest/files/a', lastModified: new Date() }], manifestItem: null }],
    ]);

    const ids = orphanManifestSnapshotIds(
      groups as any,
      new Set(['retained']),
      new Map([['retired', 'retirement-row-id']]),
      Date.now(),
      9 * DAY_MS,
    );
    expect(ids.sort()).toEqual(['young']);
  });

  it('treats a manifest object with unknown last-modified as young (fail-closed protect)', () => {
    const groups = new Map([
      ['unknownage', { items: [], manifestItem: { key: 'snapshots/unknownage/manifest.json', lastModified: null } }],
    ]);
    const ids = orphanManifestSnapshotIds(groups as any, new Set(), new Map(), Date.now(), 9 * DAY_MS);
    expect(ids).toEqual(['unknownage']);
  });
});

describe('sweepUnreferencedBackupObjects', () => {
  const destination = {
    id: 'cfg-1',
    provider: 's3',
    providerConfig: { bucket: 'backups', region: 'us-east-1' },
  };
  const identityKeyFor = (d: typeof destination) => normalizeStorageIdentity(d.provider, d.providerConfig);

  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue.length = 0;
    updateCalls.length = 0;
    redisAvailableForTest = true;
    redisSmembersMock.mockResolvedValue([]);
    delete process.env.BACKUP_GC_MAX_DELETES_PER_RUN;
    // Belt-and-braces: vi.clearAllMocks() clears call history but NOT queued
    // .mockResolvedValueOnce/.mockRejectedValueOnce implementations — a test
    // that (by design, e.g. a fail-closed abort) consumes fewer/more storage
    // calls than another test expects can otherwise leak a stale queued
    // response into the NEXT test's calls. Full reset + restore the shared
    // "not found" default for fetchBackupObjectTextMock guarantees every test
    // in this block starts from a clean slate regardless of execution order.
    fetchBackupObjectTextMock.mockReset();
    fetchBackupObjectTextMock.mockImplementation(async () => {
      throw notFoundError();
    });
    listBackupObjectsUnderPrefixMock.mockReset();
    deleteBackupObjectKeysMock.mockReset();
  });

  afterEach(() => {
    delete process.env.BACKUP_GC_MAX_DELETES_PER_RUN;
  });

  // Convenience: pushes the 3 run-level reads (unattributedRows, destinations,
  // identityUsage) that precede every per-identity loop iteration.
  function pushRunLevel(dests: unknown[], unattributed: unknown[] = []) {
    selectQueue.push(unattributed);
    selectQueue.push(dests);
    const usage = dests.map((d: any) => ({ storageIdentity: identityKeyFor(d), count: 1 }));
    selectQueue.push(usage);
  }

  // Convenience: pushes the 4 per-identity reads, in the finalized order
  // (retainedRows, nullIdentityRows, retirementRows, capabilityRows).
  function pushIdentity(opts: {
    retained?: unknown[];
    nullRows?: unknown[];
    retirements?: unknown[];
    capability?: unknown[];
  } = {}) {
    selectQueue.push(opts.retained ?? []);
    selectQueue.push(opts.nullRows ?? []);
    selectQueue.push(opts.retirements ?? []);
    selectQueue.push(opts.capability ?? []);
  }

  it('keeps an object referenced by a retained snapshot even though it lives under an older, deleted snapshot prefix', async () => {
    pushRunLevel([destination]);
    pushIdentity({ retained: [{ snapshotId: 'B' }] });

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
    expect(result.deleted).toBe(1);
    expect(result.skippedIdentities).toBe(0);
    expect(result.blockedIdentities).toBe(0);
  });

  it('marks snapshots/<id>/layout.json live without fetching it, so the sweep never deletes a retained layout manifest', async () => {
    selectQueue.push([]); // unattributedRows
    selectQueue.push([destination]); // destinations
    selectQueue.push([{ snapshotId: 'A' }]); // retained

    fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));

    const old = new Date(Date.now() - 10 * DAY_MS);
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/A/manifest.json', lastModified: old },
      { key: 'snapshots/A/layout.json', lastModified: old },
      { key: 'snapshots/ORPHAN/layout.json', lastModified: old },
    ]);

    deleteBackupObjectKeysMock.mockResolvedValueOnce({
      deletedKeys: ['snapshots/ORPHAN/layout.json'],
      failedKeys: [],
    });

    const result = await sweepUnreferencedBackupObjects();

    // markLiveBackupObjects marks layout.json live unconditionally (no
    // round-trip fetch of it) — only the ordinary manifest and the
    // system-state manifest are ever fetched per snapshot.
    for (const call of fetchBackupObjectTextMock.mock.calls) {
      expect((call[0] as { key: string }).key).not.toBe('snapshots/A/layout.json');
    }
    expect(deleteBackupObjectKeysMock).toHaveBeenCalledTimes(1);
    const deletedArg = deleteBackupObjectKeysMock.mock.calls[0]![0] as { keys: string[] };
    expect(deletedArg.keys).toEqual(['snapshots/ORPHAN/layout.json']);
    expect(deletedArg.keys).not.toContain('snapshots/A/layout.json');
    expect(result).toEqual({ deleted: 1, skippedIdentities: 0, blockedIdentities: 0 });
  });

  it('keeps a loose unreferenced object under a manifest-bearing prefix that is still inside the 48h grace window', async () => {
    pushRunLevel([destination]);
    pushIdentity({ retained: [{ snapshotId: 'B' }] });

    fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));

    const withinGrace = new Date(Date.now() - 1 * 60 * 60 * 1000); // 1h old, grace is 48h
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/B/manifest.json', lastModified: withinGrace },
      { key: 'snapshots/B/files/pending.dat', lastModified: withinGrace },
    ]);

    const result = await sweepUnreferencedBackupObjects();

    expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
  });

  it('never deletes an object with no last-modified data, even if otherwise unreferenced (fail-closed per-object)', async () => {
    pushRunLevel([destination]);
    pushIdentity({ retained: [{ snapshotId: 'B' }] });

    fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));

    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/B/manifest.json', lastModified: new Date(Date.now() - 10 * DAY_MS) },
      { key: 'snapshots/B/files/unknown-age.dat', lastModified: null },
    ]);

    const result = await sweepUnreferencedBackupObjects();

    expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
  });

  describe('manifest-less prefix protection', () => {
    it('leaves a manifest-less prefix entirely untouched while ANY of its objects is fresh (mixed-age)', async () => {
      pushRunLevel([destination]);
      pushIdentity({ retained: [{ snapshotId: 'B' }] });

      fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));

      const veryOld = new Date(Date.now() - 20 * DAY_MS);
      const fresh = new Date(Date.now() - 1 * DAY_MS);
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/B/manifest.json', lastModified: veryOld },
        { key: 'snapshots/C/files/partial-old.dat', lastModified: veryOld },
        { key: 'snapshots/C/files/partial-fresh.dat', lastModified: fresh },
      ]);

      const result = await sweepUnreferencedBackupObjects();

      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result.deleted).toBe(0);
    });

    it('sweeps a manifest-less prefix in full once its newest object clears the (9-day) window', async () => {
      pushRunLevel([destination]);
      pushIdentity({ retained: [{ snapshotId: 'B' }] });

      fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));

      const allOld = JUST_PAST_MANIFESTLESS_THRESHOLD();
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
      pushRunLevel([destination]);
      pushIdentity({ retained: [{ snapshotId: 'B' }] });

      fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));

      const justPastOldSevenDayThreshold = new Date(Date.now() - AGENT_JOURNAL_MAX_AGE_MS - 6 * 60 * 60 * 1000);
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/B/manifest.json', lastModified: justPastOldSevenDayThreshold },
        { key: 'snapshots/D/files/resume-chunk.dat', lastModified: justPastOldSevenDayThreshold },
      ]);

      const result = await sweepUnreferencedBackupObjects();

      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result.deleted).toBe(0);
    });
  });

  it('aborts the sweep for an identity whose manifest fetch fails, but still processes other identities', async () => {
    const destinationBroken = { id: 'cfg-broken', provider: 's3', providerConfig: { bucket: 'b1', region: 'us-east-1' } };
    const destinationOk = { id: 'cfg-ok', provider: 's3', providerConfig: { bucket: 'b2', region: 'us-east-1' } };

    pushRunLevel([destinationBroken, destinationOk]);
    pushIdentity({ retained: [{ snapshotId: 'X' }] }); // destinationBroken's identity
    pushIdentity({ retained: [{ snapshotId: 'Y' }] }); // destinationOk's identity

    fetchBackupObjectTextMock
      .mockRejectedValueOnce(new Error('network error fetching manifest'))
      .mockResolvedValueOnce(manifestJson([]));

    const old = JUST_PAST_MANIFESTLESS_THRESHOLD();
    listBackupObjectsUnderPrefixMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { key: 'snapshots/Y/manifest.json', lastModified: old },
        { key: 'snapshots/Z/files/orphan.dat', lastModified: old },
      ]);

    deleteBackupObjectKeysMock.mockResolvedValueOnce({
      deletedKeys: ['snapshots/Z/files/orphan.dat'],
      failedKeys: [],
    });

    const result = await sweepUnreferencedBackupObjects();

    expect(listBackupObjectsUnderPrefixMock).toHaveBeenCalledTimes(2);
    expect(deleteBackupObjectKeysMock).toHaveBeenCalledTimes(1);
    expect(deleteBackupObjectKeysMock).toHaveBeenCalledWith(
      expect.objectContaining({ providerConfig: destinationOk.providerConfig }),
    );
    expect(result.deleted).toBe(1);
    expect(result.skippedIdentities).toBe(1);
    expect(result.blockedIdentities).toBe(1);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it('honors the per-run deletion cap, leaving the rest for a later run', async () => {
    process.env.BACKUP_GC_MAX_DELETES_PER_RUN = '1';

    pushRunLevel([destination]);
    pushIdentity({ retained: [{ snapshotId: 'B' }] });

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
    expect(deletedArg.keys).toEqual(['snapshots/A/files/orphan-2.dat']);
    expect(result.deleted).toBe(1);
  });

  it('grace window matches the default 48h', () => {
    expect(resolveBackupGcGraceMs()).toBe(48 * 60 * 60 * 1000);
  });

  it('skips an identity whose provider has no GC listing support, without touching storage', async () => {
    const unsupported = { id: 'cfg-azure', provider: 'azure_blob', providerConfig: {} };
    pushRunLevel([unsupported]);

    const result = await sweepUnreferencedBackupObjects();

    expect(fetchBackupObjectTextMock).not.toHaveBeenCalled();
    expect(listBackupObjectsUnderPrefixMock).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
    expect(result.skippedIdentities).toBe(1);
    expect(result.blockedIdentities).toBe(0);
  });

  it('does not crash the sweep when a delete is rejected (e.g. object-lock) — counts it and moves on', async () => {
    pushRunLevel([destination]);
    pushIdentity({ retained: [{ snapshotId: 'B' }] });

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

    expect(result.deleted).toBe(0);
    expect(result.skippedIdentities).toBe(0);
    expect(result.blockedIdentities).toBe(0);
  });

  describe('storage identity grouping', () => {
    it('unions retained snapshots across two configs sharing one physical bucket, so neither can delete the other\'s live objects', async () => {
      const configA = { id: 'cfg-a', provider: 's3', providerConfig: { bucket: 'shared-bucket', region: 'us-east-1' } };
      const configB = { id: 'cfg-b', provider: 's3', providerConfig: { bucket: 'shared-bucket', region: 'us-east-1' } };

      pushRunLevel([configA, configB]);
      pushIdentity({ retained: [{ snapshotId: 'A' }, { snapshotId: 'B' }] });

      fetchBackupObjectTextMock.mockImplementation(async (input: { key: string }) => {
        if (input.key === 'snapshots/A/manifest.json') return manifestJson([]);
        if (input.key === 'snapshots/B/manifest.json') {
          return manifestJson([{ backupPath: 'snapshots/A/files/shared.dat' }]);
        }
        if (input.key.endsWith('/system-state/manifest.json')) throw notFoundError();
        throw new Error(`unexpected manifest fetch: ${input.key}`);
      });

      const old = new Date(Date.now() - 10 * DAY_MS);
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/A/manifest.json', lastModified: old },
        { key: 'snapshots/A/files/shared.dat', lastModified: old },
        { key: 'snapshots/B/manifest.json', lastModified: old },
      ]);

      const result = await sweepUnreferencedBackupObjects();

      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result.deleted).toBe(0);
    });

    it('blocks the entire run when any backup_snapshots row has a null config_id (cannot be attributed to a bucket)', async () => {
      pushRunLevel([destination], [{ id: 'orphan-snap-1' }]);

      const result = await sweepUnreferencedBackupObjects();

      expect(fetchBackupObjectTextMock).not.toHaveBeenCalled();
      expect(listBackupObjectsUnderPrefixMock).not.toHaveBeenCalled();
      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result.deleted).toBe(0);
      expect(result.skippedIdentities).toBe(1);
      expect(result.blockedIdentities).toBe(0);
    });

    it('belt-and-braces: fail-closed-skips every identity that coarsely collides on bucket+host despite normalizeStorageIdentity keeping them apart', async () => {
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

      expect(normalizeStorageIdentity('s3', configWithPort.providerConfig))
        .not.toBe(normalizeStorageIdentity('s3', configWithoutPort.providerConfig));

      pushRunLevel([configWithPort, configWithoutPort]);

      const result = await sweepUnreferencedBackupObjects();

      expect(fetchBackupObjectTextMock).not.toHaveBeenCalled();
      expect(listBackupObjectsUnderPrefixMock).not.toHaveBeenCalled();
      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result.deleted).toBe(0);
      expect(result.skippedIdentities).toBe(2);
      expect(result.blockedIdentities).toBe(0);
    });
  });

  // D18 W02: replaces the old "every listed manifest is live forever" rule.
  // An orphan manifest with no row and no retirement is a root only while
  // younger than the orphan window (default 9 days).
  describe('orphan manifest root set (age-windowed, no row required)', () => {
    it('protects a young orphan manifest (no row, no retirement) as a root', async () => {
      pushRunLevel([destination]);
      pushIdentity(); // no retained rows, no NULL rows, no retirements, no legacy helper

      fetchBackupObjectTextMock.mockResolvedValueOnce(
        manifestJson([{ backupPath: 'snapshots/OLD/files/base.dat' }]),
      );

      const recent = new Date(Date.now() - 1 * DAY_MS);
      const old = JUST_PAST_MANIFESTLESS_THRESHOLD();
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/NEW/manifest.json', lastModified: recent },
        { key: 'snapshots/OLD/files/base.dat', lastModified: old },
      ]);

      const result = await sweepUnreferencedBackupObjects();

      expect(fetchBackupObjectTextMock).toHaveBeenCalledWith(expect.objectContaining({ key: 'snapshots/NEW/manifest.json' }));
      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result.deleted).toBe(0);
    });

    it('reclaims an orphan manifest once it clears the orphan window (default 9 days), with no retirement row', async () => {
      pushRunLevel([destination]);
      pushIdentity();

      const pastWindow = new Date(Date.now() - 10 * DAY_MS);
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/ABANDONED/manifest.json', lastModified: pastWindow },
        { key: 'snapshots/ABANDONED/files/x.dat', lastModified: pastWindow },
      ]);
      deleteBackupObjectKeysMock.mockResolvedValueOnce({ deletedKeys: ['snapshots/ABANDONED/files/x.dat'], failedKeys: [] });
      deleteBackupObjectKeysMock.mockResolvedValueOnce({ deletedKeys: ['snapshots/ABANDONED/manifest.json'], failedKeys: [] });

      const result = await sweepUnreferencedBackupObjects();

      expect(fetchBackupObjectTextMock).not.toHaveBeenCalled();
      expect(result.deleted).toBe(2);
      expect(result.orphansSwept).toBe(1);
    });

    it('a manifest object with unknown last-modified is treated as young (fail-closed protect)', async () => {
      pushRunLevel([destination]);
      pushIdentity();

      fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/UNKNOWNAGE/manifest.json', lastModified: null },
      ]);

      const result = await sweepUnreferencedBackupObjects();

      expect(fetchBackupObjectTextMock).toHaveBeenCalledWith(expect.objectContaining({ key: 'snapshots/UNKNOWNAGE/manifest.json' }));
      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result.deleted).toBe(0);
    });
  });

  describe('all backup types share one retained set via storage_identity (no more backupType filter)', () => {
    it('includes a system_image row in the retained set alongside a file row on the same identity', async () => {
      pushRunLevel([destination]);
      pushIdentity({ retained: [{ snapshotId: 'FILE1' }, { snapshotId: 'IMG1' }] });

      fetchBackupObjectTextMock.mockImplementation(async (input: { key: string }) => {
        if (input.key === 'snapshots/FILE1/manifest.json') return manifestJson([]);
        if (input.key === 'snapshots/IMG1/manifest.json') return manifestJson([]);
        if (input.key.endsWith('/system-state/manifest.json')) throw notFoundError();
        throw new Error(`unexpected manifest fetch: ${input.key}`);
      });

      const old = JUST_PAST_MANIFESTLESS_THRESHOLD();
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/FILE1/manifest.json', lastModified: old },
        { key: 'snapshots/IMG1/manifest.json', lastModified: old },
      ]);

      const result = await sweepUnreferencedBackupObjects();

      expect(fetchBackupObjectTextMock).toHaveBeenCalledWith(expect.objectContaining({ key: 'snapshots/FILE1/manifest.json' }));
      expect(fetchBackupObjectTextMock).toHaveBeenCalledWith(expect.objectContaining({ key: 'snapshots/IMG1/manifest.json' }));
      expect(result.blockedIdentities).toBe(0);
      expect(result.skippedIdentities).toBe(0);
    });

    it('still fail-closes AND increments blockedIdentities when ANY retained row\'s manifest is unfetchable', async () => {
      pushRunLevel([destination]);
      pushIdentity({ retained: [{ snapshotId: 'IMG1' }] });

      fetchBackupObjectTextMock.mockRejectedValueOnce(new Error('S3 500 fetching manifest'));

      const old = JUST_PAST_MANIFESTLESS_THRESHOLD();
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/IMG1/manifest.json', lastModified: old },
        { key: 'snapshots/ORPHAN/files/x.dat', lastModified: old },
      ]);

      const result = await sweepUnreferencedBackupObjects();

      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result.skippedIdentities).toBe(1);
      expect(result.blockedIdentities).toBe(1);
    });
  });

  describe('corrupt manifest parse (fail-closed)', () => {
    async function runWithManifestBody(body: string) {
      pushRunLevel([destination]);
      pushIdentity({ retained: [{ snapshotId: 'B' }] });
      fetchBackupObjectTextMock.mockResolvedValueOnce(body);
      const old = JUST_PAST_MANIFESTLESS_THRESHOLD();
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/B/manifest.json', lastModified: old },
        { key: 'snapshots/A/files/orphan.dat', lastModified: old },
      ]);
      return sweepUnreferencedBackupObjects();
    }

    it('aborts the identity when the manifest body is invalid JSON', async () => {
      const result = await runWithManifestBody('{ this is not json');
      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result.deleted).toBe(0);
      expect(result.skippedIdentities).toBe(1);
      expect(result.blockedIdentities).toBe(1);
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    });

    it('aborts the identity when manifest.files is not an array', async () => {
      const result = await runWithManifestBody(JSON.stringify({ files: 'not-an-array' }));
      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result.deleted).toBe(0);
      expect(result.skippedIdentities).toBe(1);
      expect(result.blockedIdentities).toBe(1);
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('timing-operator boundaries (strict >)', () => {
    const FIXED_NOW = 1_700_000_000_000;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(FIXED_NOW);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    async function sweepLooseObjectAtAge(ageMs: number) {
      pushRunLevel([destination]);
      pushIdentity({ retained: [{ snapshotId: 'B' }] });
      fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
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
      const result = await sweepLooseObjectAtAge(48 * 60 * 60 * 1000);
      expect(result.deleted).toBe(1);
    });

    it('keeps a loose object 1ms short of 48h (still strictly inside the grace window)', async () => {
      const result = await sweepLooseObjectAtAge(48 * 60 * 60 * 1000 - 1);
      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result.deleted).toBe(0);
    });

    it('sweeps a loose object 1ms past 48h', async () => {
      const result = await sweepLooseObjectAtAge(48 * 60 * 60 * 1000 + 1);
      expect(result.deleted).toBe(1);
    });

    async function sweepManifestlessPrefixAtNewestAge(ageMs: number) {
      pushRunLevel([destination]);
      pushIdentity({ retained: [{ snapshotId: 'B' }] });
      fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/C/files/partial.dat', lastModified: new Date(FIXED_NOW - ageMs) },
      ]);
      deleteBackupObjectKeysMock.mockResolvedValueOnce({
        deletedKeys: ['snapshots/C/files/partial.dat'],
        failedKeys: [],
      });
      return sweepUnreferencedBackupObjects();
    }

    it('sweeps a manifest-less prefix whose newest object is EXACTLY at the 9-day threshold', async () => {
      const result = await sweepManifestlessPrefixAtNewestAge(9 * DAY_MS);
      expect(result.deleted).toBe(1);
    });

    it('protects a manifest-less prefix whose newest object is 1ms short of the 9-day threshold', async () => {
      const result = await sweepManifestlessPrefixAtNewestAge(9 * DAY_MS - 1);
      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result.deleted).toBe(0);
    });

    it('sweeps a manifest-less prefix whose newest object is 1ms past the 9-day threshold', async () => {
      const result = await sweepManifestlessPrefixAtNewestAge(9 * DAY_MS + 1);
      expect(result.deleted).toBe(1);
    });
  });

  describe('D15 system-state GC (Option A)', () => {
    it('keeps system-state objects live when referenced by system-state/manifest.json', async () => {
      pushRunLevel([destination]);
      pushIdentity({ retained: [{ snapshotId: 'B' }] });

      fetchBackupObjectTextMock.mockImplementation(async (input: { key: string }) => {
        if (input.key === 'snapshots/B/manifest.json') return manifestJson([]);
        if (input.key === 'snapshots/B/system-state/manifest.json') {
          return JSON.stringify({ artifacts: [{ path: 'registry/SYSTEM' }, { path: 'boot/grub.cfg' }] });
        }
        throw new Error(`unexpected manifest fetch: ${input.key}`);
      });

      const old = JUST_PAST_MANIFESTLESS_THRESHOLD();
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/B/manifest.json', lastModified: old },
        { key: 'snapshots/B/system-state/manifest.json', lastModified: old },
        { key: 'snapshots/B/system-state/registry/SYSTEM', lastModified: old },
        { key: 'snapshots/B/system-state/boot/grub.cfg', lastModified: old },
      ]);

      const result = await sweepUnreferencedBackupObjects();

      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result.deleted).toBe(0);
    });

    it('deletes system-state objects under an old orphan prefix the same way ordinary file objects are', async () => {
      pushRunLevel([destination]);
      pushIdentity({ retained: [{ snapshotId: 'B' }] });

      fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));

      const old = JUST_PAST_MANIFESTLESS_THRESHOLD();
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/B/manifest.json', lastModified: old },
        { key: 'snapshots/EXPIRED/system-state/registry/SYSTEM', lastModified: old },
      ]);

      deleteBackupObjectKeysMock.mockResolvedValueOnce({
        deletedKeys: ['snapshots/EXPIRED/system-state/registry/SYSTEM'],
        failedKeys: [],
      });

      const result = await sweepUnreferencedBackupObjects();

      const deletedArg = deleteBackupObjectKeysMock.mock.calls[0]![0] as { keys: string[] };
      expect(deletedArg.keys).toEqual(['snapshots/EXPIRED/system-state/registry/SYSTEM']);
      expect(result.deleted).toBe(1);
    });

    it('does NOT sweep the group when the system-state manifest fetch fails with a non-404 error (fail-closed)', async () => {
      pushRunLevel([destination]);
      pushIdentity({ retained: [{ snapshotId: 'B' }] });

      fetchBackupObjectTextMock.mockImplementation(async (input: { key: string }) => {
        if (input.key === 'snapshots/B/manifest.json') return manifestJson([]);
        if (input.key === 'snapshots/B/system-state/manifest.json') {
          throw new Error('S3 500 fetching system state manifest');
        }
        throw new Error(`unexpected manifest fetch: ${input.key}`);
      });

      const old = JUST_PAST_MANIFESTLESS_THRESHOLD();
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/B/manifest.json', lastModified: old },
        { key: 'snapshots/B/system-state/registry/SYSTEM', lastModified: old },
      ]);

      const result = await sweepUnreferencedBackupObjects();

      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result.deleted).toBe(0);
      expect(result.skippedIdentities).toBe(1);
      expect(result.blockedIdentities).toBe(1);
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    });

    it('protects a retained system_image snapshot whose ordinary manifest object is absent from the bucket', async () => {
      pushRunLevel([destination]);
      pushIdentity({ retained: [{ snapshotId: 'IMG1' }] });

      const old = EVEN_FURTHER_PAST_MANIFESTLESS_THRESHOLD();
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/IMG1/system-state/manifest.json', lastModified: old },
        { key: 'snapshots/IMG1/system-state/registry/SYSTEM', lastModified: old },
      ]);

      const result = await sweepUnreferencedBackupObjects();

      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result.deleted).toBe(0);
      expect(result.skippedIdentities).toBe(1);
      expect(result.blockedIdentities).toBe(1);
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('§3.7 held-context tripwire', () => {
    it('calls assertOutsideHeldDbContext with the sweepStorageIdentity operation label before any storage call', async () => {
      pushRunLevel([destination]);
      pushIdentity();
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([]);

      await sweepUnreferencedBackupObjects();

      expect(assertOutsideHeldDbContextMock).toHaveBeenCalledWith('backupGC.sweepStorageIdentity');
    });
  });

  describe('a NULL-identity row becomes a root of I the moment it resolves; unresolved contributes only to deferral (§3.6 v3)', () => {
    it('fetches (and requires) the manifest of an UNRESOLVED NULL row too, and defers the whole identity if it is not found in the listing', async () => {
      pushRunLevel([destination]);
      pushIdentity({
        nullRows: [{ id: 'row-neverwritten', snapshotId: 'NEVERWRITTEN' }],
        retirements: [{ id: 'retirement-5', snapshotId: 'RETIRED5' }],
      });

      const t = new Date(Date.now() - 1000);
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/RETIRED5/manifest.json', lastModified: t },
        { key: 'snapshots/RETIRED5/files/x.dat', lastModified: t },
      ]);
      fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await sweepUnreferencedBackupObjects();
        expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
        expect(result.retiredSwept).toBe(0);
        expect(warn.mock.calls.some(([msg]) => String(msg).includes('deferred') && String(msg).includes('1 unresolved') && String(msg).includes('NEVERWRITTEN'))).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });

    it('fetch failure for a RESOLVED NULL row (found in the listing) still aborts the identity fail-closed', async () => {
      pushRunLevel([destination]);
      pushIdentity({ nullRows: [{ id: 'row-badfetch', snapshotId: 'BADFETCH' }] });

      const t = new Date(Date.now() - 1000);
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/BADFETCH/manifest.json', lastModified: t },
      ]);
      fetchBackupObjectTextMock.mockRejectedValueOnce(new Error('S3 500'));

      const result = await sweepUnreferencedBackupObjects();
      expect(result.blockedIdentities).toBe(1);
      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
    });
  });

  describe('deferral runs EXACTLY today\'s algorithm, not "rooted only" (§3.4 v3)', () => {
    it('legacy-helper deferral marks EVERY listed manifest live (including a retired one) and only reclaims loose/manifest-less objects', async () => {
      pushRunLevel([destination]);
      pushIdentity({
        retirements: [{ id: 'retirement-3', snapshotId: 'RETIRED3' }],
        capability: [{ deviceId: 'device-legacy', backupVersion: '0.109.0' }],
      });

      const t = new Date(Date.now() - 1000);
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/RETIRED3/manifest.json', lastModified: t },
        { key: 'snapshots/RETIRED3/files/x.dat', lastModified: t },
      ]);
      fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await sweepUnreferencedBackupObjects();
        expect(fetchBackupObjectTextMock).toHaveBeenCalledWith(expect.objectContaining({ key: 'snapshots/RETIRED3/manifest.json' }));
        expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
        expect(result.deferredIdentities).toBe(1);
        expect(result.retiredSwept).toBe(0);
        expect(warn.mock.calls.some(([msg]) => String(msg).includes('reclamation deferred') && String(msg).includes('legacy helper device-legacy 0.109.0'))).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });

    it('a deferred identity STILL reclaims a manifest-less prefix older than 9 days (that rule is unconditional)', async () => {
      pushRunLevel([destination]);
      pushIdentity({ capability: [{ deviceId: 'device-legacy', backupVersion: '0.109.0' }] });

      const old = JUST_PAST_MANIFESTLESS_THRESHOLD();
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/ORPHANPARTIAL/files/partial.dat', lastModified: old },
      ]);
      deleteBackupObjectKeysMock.mockResolvedValueOnce({ deletedKeys: ['snapshots/ORPHANPARTIAL/files/partial.dat'], failedKeys: [] });

      const result = await sweepUnreferencedBackupObjects();
      expect(result.deleted).toBe(1);
      expect(result.deferredIdentities).toBe(1);
    });
  });

  describe('self-heal writes by row id, guarded by storage_identity IS NULL (§3.6 v3)', () => {
    it('resolves a NULL row (found in listing) and reclaims a co-located retirement in the SAME run once nothing is unresolved', async () => {
      pushRunLevel([destination]);
      pushIdentity({
        nullRows: [{ id: 'row-healme', snapshotId: 'HEALME' }],
        retirements: [{ id: 'retirement-6', snapshotId: 'RETIRED6' }],
      });

      fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));
      const t = new Date(Date.now() - 1000);
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/HEALME/manifest.json', lastModified: t },
        { key: 'snapshots/RETIRED6/manifest.json', lastModified: t },
        { key: 'snapshots/RETIRED6/files/r.dat', lastModified: t },
      ]);
      deleteBackupObjectKeysMock.mockResolvedValueOnce({ deletedKeys: ['snapshots/RETIRED6/files/r.dat'], failedKeys: [] });
      deleteBackupObjectKeysMock.mockResolvedValueOnce({ deletedKeys: ['snapshots/RETIRED6/manifest.json'], failedKeys: [] });

      const result = await sweepUnreferencedBackupObjects();

      expect(result.deleted).toBe(2);
      expect(mockDb.update).toHaveBeenCalledWith(backupSnapshots);
      expect(result.retiredSwept).toBe(0); // not yet confirmed by a fresh listing
    });
  });

  describe('swept_at is set only once a FRESH listing confirms the prefix is gone (two-pass, §3.4 v3)', () => {
    it('does not set swept_at in the same pass as the deletes, but does on a later run once the listing shows it gone', async () => {
      pushRunLevel([destination]);
      pushIdentity({ retirements: [{ id: 'retirement-1', snapshotId: 'RETIRED1' }] });

      const t = new Date(Date.now() - 1000);
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/RETIRED1/manifest.json', lastModified: t },
        { key: 'snapshots/RETIRED1/files/x.dat', lastModified: t },
      ]);
      deleteBackupObjectKeysMock.mockResolvedValueOnce({ deletedKeys: ['snapshots/RETIRED1/files/x.dat'], failedKeys: [] });
      deleteBackupObjectKeysMock.mockResolvedValueOnce({ deletedKeys: ['snapshots/RETIRED1/manifest.json'], failedKeys: [] });

      const firstRun = await sweepUnreferencedBackupObjects();
      expect(firstRun.deleted).toBe(2);
      expect(firstRun.retiredSwept).toBe(0);

      pushRunLevel([destination]);
      pushIdentity({ retirements: [{ id: 'retirement-1', snapshotId: 'RETIRED1' }] });
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([]);

      const secondRun = await sweepUnreferencedBackupObjects();
      expect(secondRun.deleted).toBe(0);
      expect(secondRun.retiredSwept).toBe(1);
    });

    it('confirms swept_at IMMEDIATELY (first time it is ever swept) when a retirement is already fully absent from the listing', async () => {
      pushRunLevel([destination]);
      pushIdentity({ retirements: [{ id: 'retirement-7', snapshotId: 'RETIRED7' }] });
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([]);

      const result = await sweepUnreferencedBackupObjects();
      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result.retiredSwept).toBe(1);
    });

    it('a manifest-less "retired remnant" (manifest already gone from a prior run) is reclaimed immediately, with no 9-day wait', async () => {
      pushRunLevel([destination]);
      pushIdentity({ retirements: [{ id: 'retirement-8', snapshotId: 'RETIRED8' }] });

      const veryRecent = new Date(Date.now() - 1000);
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/RETIRED8/files/remnant.dat', lastModified: veryRecent },
      ]);
      deleteBackupObjectKeysMock.mockResolvedValueOnce({ deletedKeys: ['snapshots/RETIRED8/files/remnant.dat'], failedKeys: [] });

      const result = await sweepUnreferencedBackupObjects();
      expect(result.deleted).toBe(1);
    });
  });

  describe('Redis-backed skip set (delete-cap fairness) and cap accounting', () => {
    it('excludes a previously-failed key from candidates on a later run without re-attempting it', async () => {
      redisSmembersMock.mockResolvedValueOnce(['snapshots/ABANDONED/files/locked.dat']);
      pushRunLevel([destination]);
      pushIdentity();

      const pastWindow = new Date(Date.now() - 10 * DAY_MS);
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/ABANDONED/manifest.json', lastModified: pastWindow },
        { key: 'snapshots/ABANDONED/files/locked.dat', lastModified: pastWindow },
        { key: 'snapshots/ABANDONED/files/free.dat', lastModified: pastWindow },
      ]);
      deleteBackupObjectKeysMock.mockResolvedValueOnce({ deletedKeys: ['snapshots/ABANDONED/files/free.dat'], failedKeys: [] });

      await sweepUnreferencedBackupObjects();

      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ keys: expect.arrayContaining(['snapshots/ABANDONED/files/locked.dat']) }),
      );
    });

    it('records a failed key with a 7-day TTL after deleteBackupObjectKeys reports it', async () => {
      pushRunLevel([destination]);
      pushIdentity();

      const pastWindow = new Date(Date.now() - 10 * DAY_MS);
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/ABANDONED/manifest.json', lastModified: pastWindow },
        { key: 'snapshots/ABANDONED/files/locked.dat', lastModified: pastWindow },
      ]);
      deleteBackupObjectKeysMock.mockResolvedValueOnce({
        deletedKeys: [],
        failedKeys: [{ key: 'snapshots/ABANDONED/files/locked.dat', error: 'object-lock' }],
      });

      await sweepUnreferencedBackupObjects();

      expect(redisSaddMock).toHaveBeenCalledWith(expect.stringMatching(/^backup-gc:failed:/), 'snapshots/ABANDONED/files/locked.dat');
      expect(redisExpireMock).toHaveBeenCalledWith(expect.stringMatching(/^backup-gc:failed:/), 7 * 24 * 60 * 60);
    });

    it('degrades to no skip set (proceeds normally) when Redis is unavailable', async () => {
      redisAvailableForTest = false;
      pushRunLevel([destination]);
      pushIdentity();
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([]);
      const result = await sweepUnreferencedBackupObjects();
      expect(result.deleted).toBe(0);
    });

    it('a FAILED delete attempt consumes the per-run cap, not just successful deletes', async () => {
      pushRunLevel([destination]);
      pushIdentity({ retained: [{ snapshotId: 'B' }] });

      fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));
      process.env.BACKUP_GC_MAX_DELETES_PER_RUN = '1';
      try {
        const old = JUST_PAST_MANIFESTLESS_THRESHOLD();
        listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
          { key: 'snapshots/B/manifest.json', lastModified: old },
          { key: 'snapshots/B/files/a.dat', lastModified: old },
          { key: 'snapshots/B/files/b.dat', lastModified: old },
        ]);
        deleteBackupObjectKeysMock.mockResolvedValueOnce({
          deletedKeys: [],
          failedKeys: [{ key: 'snapshots/B/files/a.dat', error: 'object-lock' }],
        });

        await sweepUnreferencedBackupObjects();
        expect(deleteBackupObjectKeysMock).toHaveBeenCalledTimes(1);
      } finally {
        delete process.env.BACKUP_GC_MAX_DELETES_PER_RUN;
      }
    });

    it('a rooted-branch delete failure is recorded into the Redis skip set too (not just the retired/orphan branch)', async () => {
      pushRunLevel([destination]);
      pushIdentity({ retained: [{ snapshotId: 'B' }] });

      fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));
      const old = JUST_PAST_MANIFESTLESS_THRESHOLD();
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/B/manifest.json', lastModified: old },
        { key: 'snapshots/B/files/locked.dat', lastModified: old },
      ]);
      deleteBackupObjectKeysMock.mockResolvedValueOnce({
        deletedKeys: [],
        failedKeys: [{ key: 'snapshots/B/files/locked.dat', error: 'object-lock' }],
      });

      await sweepUnreferencedBackupObjects();
      expect(redisSaddMock).toHaveBeenCalledWith(expect.stringMatching(/^backup-gc:failed:/), 'snapshots/B/files/locked.dat');
    });
  });

  // Review round 1, finding 4 (pr-test-analyzer): every existing test proving
  // a retired group's manifest survives does so via a hard delete FAILURE.
  // These prove the OTHER two ways a non-manifest key can remain
  // undeletable this run — capped out, or skip-set-excluded — each of which
  // must ALSO block the manifest (the v3 rule is "no DELETABLE non-manifest
  // key remains", not "no FAILED non-manifest key remains").
  describe('manifest-last rule also holds when a non-manifest key is capped or skip-set-excluded, not just failed (review round 1, finding 4)', () => {
    it('does not delete the manifest when the per-run cap is exhausted before its non-manifest sibling is attempted', async () => {
      pushRunLevel([destination]);
      pushIdentity({ retirements: [{ id: 'retirement-cap', snapshotId: 'CAPPED' }] });

      process.env.BACKUP_GC_MAX_DELETES_PER_RUN = '1';
      try {
        const t = new Date(Date.now() - 1000);
        listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
          { key: 'snapshots/CAPPED/manifest.json', lastModified: t },
          { key: 'snapshots/CAPPED/files/a.dat', lastModified: t },
          { key: 'snapshots/CAPPED/files/b.dat', lastModified: t },
        ]);
        // Cap is 1: only ONE non-manifest delete attempt happens this run —
        // a.dat succeeds, b.dat is never even attempted (capped out).
        deleteBackupObjectKeysMock.mockResolvedValueOnce({ deletedKeys: ['snapshots/CAPPED/files/a.dat'], failedKeys: [] });

        await sweepUnreferencedBackupObjects();

        // Only the one non-manifest delete call happened — the cap was
        // exhausted, so the manifest was never even considered for deletion.
        expect(deleteBackupObjectKeysMock).toHaveBeenCalledTimes(1);
        expect(deleteBackupObjectKeysMock).not.toHaveBeenCalledWith(
          expect.objectContaining({ keys: expect.arrayContaining(['snapshots/CAPPED/manifest.json']) }),
        );
      } finally {
        delete process.env.BACKUP_GC_MAX_DELETES_PER_RUN;
      }
    });

    it('does not delete the manifest when its only non-manifest sibling is skip-set-excluded, not failed', async () => {
      redisSmembersMock.mockResolvedValueOnce(['snapshots/SKIPPED/files/locked-forever.dat']);
      pushRunLevel([destination]);
      pushIdentity({ retirements: [{ id: 'retirement-skip', snapshotId: 'SKIPPED' }] });

      const t = new Date(Date.now() - 1000);
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/SKIPPED/manifest.json', lastModified: t },
        { key: 'snapshots/SKIPPED/files/locked-forever.dat', lastModified: t }, // in the skip set — never attempted, not "failed"
      ]);

      await sweepUnreferencedBackupObjects();

      // No delete call at all: the only non-manifest candidate is skip-set
      // excluded before any attempt, and that alone must still block the
      // manifest.
      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
    });
  });

  // Review round 1, finding 5 (silent-failure-hunter / pr-test-analyzer):
  // backup_snapshots.snapshot_id has no uniqueness constraint, so two
  // DIFFERENT identities can legitimately have a NULL-identity row sharing
  // the exact same snapshotId string. The self-heal write-back is scoped by
  // PRIMARY ROW ID (never snapshotId alone) specifically to prevent one
  // identity's resolution from mis-healing a different identity's
  // same-named, still-unresolved row.
  describe('cross-identity snapshotId collision guard on self-heal (review round 1, finding 5)', () => {
    it('heals only the identity whose OWN listing resolves the row, even though a different identity has an unresolved row with the identical snapshotId', async () => {
      const destinationB = { id: 'cfg-b', provider: 's3', providerConfig: { bucket: 'other-bucket', region: 'us-east-1' } };

      pushRunLevel([destination, destinationB]);
      pushIdentity({ nullRows: [{ id: 'row-A', snapshotId: 'DUPLICATE' }] }); // identity A (destination)
      pushIdentity({ nullRows: [{ id: 'row-B', snapshotId: 'DUPLICATE' }] }); // identity B (destinationB) — same snapshotId, different row

      fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([])); // A's DUPLICATE manifest fetch (it resolves)
      const t = new Date(Date.now() - 1000);
      listBackupObjectsUnderPrefixMock
        .mockResolvedValueOnce([{ key: 'snapshots/DUPLICATE/manifest.json', lastModified: t }]) // identity A's listing — resolves
        .mockResolvedValueOnce([]); // identity B's listing — DUPLICATE never appears here, stays unresolved

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await sweepUnreferencedBackupObjects();
      } finally {
        warn.mockRestore();
      }

      // Exactly ONE self-heal write happened this run (identity A's), scoped
      // to identity A's key — if the guard mismatched by bare snapshotId
      // instead of row id, identity B's unresolved row could have been
      // healed too (or healed with the wrong identity's key).
      const selfHealCalls = updateCalls.filter((c) => 'storageIdentity' in c.payload);
      expect(selfHealCalls).toHaveLength(1);
      expect(selfHealCalls[0]!.payload.storageIdentity).toBe(identityKeyFor(destination));
    });
  });

  describe('unreachable storage identities (no config points at them any more)', () => {
    it('logs and counts a storage_identity with rows but no matching current config, without touching it', async () => {
      selectQueue.push([]); // unattributedRows
      selectQueue.push([destination]); // destinations
      selectQueue.push([
        { storageIdentity: identityKeyFor(destination), count: 2 },
        { storageIdentity: 'local::/var/orphaned-bucket-nobody-points-at', count: 5 },
      ]); // identityUsage
      pushIdentity();

      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([]);

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await sweepUnreferencedBackupObjects();
        expect(result.unreachableIdentities).toBe(1);
        expect(warn.mock.calls.some(([msg]) => String(msg).includes('unreachable identity local::/var/orphaned-bucket-nobody-points-at: 5 rows'))).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });
  });

  // Review round 1 (CRITICAL): a config edit can change the NORMALIZED
  // identity string while still pointing at the SAME physical bucket/
  // directory. Rows recorded under the OLD string are unreachable (no
  // current config produces that key) but their objects physically sit in
  // the bucket the NEW identity is about to sweep — invisible to the NEW
  // identity's root query, and (once old enough) indistinguishable from
  // genuine orphan garbage. These prove the identity is deferred instead.
  describe('review round 1: coarse alias detection defers a physical-location alias instead of reclaiming it', () => {
    it('defers an S3 identity that coarsely aliases a stale/unreachable identity (a port-only difference normalizeStorageIdentity does not collapse)', async () => {
      const aliasedDestination = {
        id: 'cfg-alias',
        provider: 's3',
        providerConfig: { bucket: 'MyBucket', endpoint: 'nyc3.digitaloceanspaces.com' },
      };
      const newKey = normalizeStorageIdentity(aliasedDestination.provider, aliasedDestination.providerConfig);
      // A stale identity string (no current config produces it) that differs
      // from newKey only by an explicit port — same host+bucket physically.
      const staleKey = 's3::nyc3.digitaloceanspaces.com:9000::MyBucket';

      selectQueue.push([]); // unattributedRows
      selectQueue.push([aliasedDestination]); // destinations
      selectQueue.push([
        { storageIdentity: staleKey, count: 3 },
        { storageIdentity: newKey, count: 1 },
      ]); // identityUsage
      pushIdentity(); // retained/nullRows/retirements/capability all empty

      // A lone, manifest-only "snapshot" well past ORPHAN_WINDOW — under the
      // NORMAL (non-deferred) algorithm this would be reclaimed as abandoned
      // orphan garbage (no row, no retirement, too old to be a young orphan).
      fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));
      const old = new Date(Date.now() - 30 * DAY_MS);
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/OLDORPHAN/manifest.json', lastModified: old },
      ]);

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await sweepUnreferencedBackupObjects();
        // Deferred -> today's algorithm marks EVERY listed manifest live ->
        // the lone manifest object is in the live set -> nothing deleted,
        // where the non-deferred algorithm would have reclaimed it.
        expect(fetchBackupObjectTextMock).toHaveBeenCalledWith(expect.objectContaining({ key: 'snapshots/OLDORPHAN/manifest.json' }));
        expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
        expect(result.deferredIdentities).toBe(1);
        expect(
          warn.mock.calls.some(([msg]) =>
            String(msg).includes(newKey) && String(msg).includes('aliases a stale/unreachable identity'),
          ),
        ).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });

    it('defers a local identity whose config path is a symlink alias of a stale/unreachable identity\'s real directory', async () => {
      const realDir = await mkdtemp(join(tmpdir(), 'breeze-gc-real-'));
      const linkPath = join(tmpdir(), `breeze-gc-link-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      await symlink(realDir, linkPath, 'dir');

      const destinationViaSymlink = { id: 'cfg-link', provider: 'local', providerConfig: { path: linkPath } };
      const newKey = normalizeStorageIdentity('local', destinationViaSymlink.providerConfig); // local::<linkPath> — path.resolve is lexical, does NOT follow the symlink
      const staleKey = `local::${realDir}`; // a stale identity recorded directly against the REAL directory

      selectQueue.push([]); // unattributedRows
      selectQueue.push([destinationViaSymlink]); // destinations
      selectQueue.push([
        { storageIdentity: staleKey, count: 2 },
        { storageIdentity: newKey, count: 1 },
      ]); // identityUsage
      pushIdentity();

      fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));
      const old = new Date(Date.now() - 30 * DAY_MS);
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/OLDORPHAN/manifest.json', lastModified: old },
      ]);

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await sweepUnreferencedBackupObjects();
        expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
        expect(result.deferredIdentities).toBe(1);
        expect(
          warn.mock.calls.some(([msg]) =>
            String(msg).includes(newKey) && String(msg).includes('aliases a stale/unreachable identity'),
          ),
        ).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });

    it('does NOT defer an identity whose coarse signature does not match any unreachable identity', async () => {
      // Sanity control: the previous two tests' mechanism must not defer
      // EVERY identity — only ones that actually coarse-match something
      // unreachable. destination/identityKeyFor here shares nothing with the
      // 'local::/var/orphaned-bucket-nobody-points-at' unreachable key used
      // elsewhere in this file.
      selectQueue.push([]);
      selectQueue.push([destination]);
      selectQueue.push([
        { storageIdentity: identityKeyFor(destination), count: 1 },
        { storageIdentity: 'local::/var/totally-unrelated-stale-path', count: 4 },
      ]);
      pushIdentity();
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([]);

      const result = await sweepUnreferencedBackupObjects();
      expect(result.deferredIdentities).toBe(0);
      expect(result.unreachableIdentities).toBe(1);
    });
  });

  // Review round 1: detectSuspiciousStorageIdentityCollisions previously
  // exempted 'local' entirely from its coarse-collision check, so two
  // CURRENT local configs whose paths are lexically different but resolve
  // (via a symlink) to the SAME physical directory were never caught —
  // each would see only its own retained snapshots and could delete the
  // other's live objects.
  describe('review round 1: local provider is now covered by the current-vs-current coarse collision check', () => {
    it('fail-closed-skips two CURRENT local configs whose paths are a symlink alias of the same physical directory', async () => {
      const realDir = await mkdtemp(join(tmpdir(), 'breeze-gc-real2-'));
      const linkPath = join(tmpdir(), `breeze-gc-link2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      await symlink(realDir, linkPath, 'dir');

      const configReal = { id: 'cfg-real', provider: 'local', providerConfig: { path: realDir } };
      const configLink = { id: 'cfg-link', provider: 'local', providerConfig: { path: linkPath } };

      expect(normalizeStorageIdentity('local', configReal.providerConfig))
        .not.toBe(normalizeStorageIdentity('local', configLink.providerConfig));

      pushRunLevel([configReal, configLink]); // 2 identities, symlink-aliased

      const result = await sweepUnreferencedBackupObjects();

      expect(fetchBackupObjectTextMock).not.toHaveBeenCalled();
      expect(listBackupObjectsUnderPrefixMock).not.toHaveBeenCalled();
      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
      expect(result.skippedIdentities).toBe(2);
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
