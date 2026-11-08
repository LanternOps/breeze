import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';

// A REAL agent manifest shape (KIT lab, PR #6491): content-less dir/symlink
// entries with backupPath "", systemd unit names with a literal backslash,
// dpkg info files with a colon. Shared with the Go side (objectkey_test.go,
// fakeserver_test.go) so the API and the agent are pinned to the same bytes.
const REAL_MANIFEST_FIXTURE = path.resolve(__dirname, '../../../../agent/internal/backup/bmr/testdata/real-manifest-shape.json');
const REAL_MANIFEST_ID = 'snapshot-20260921T192625Z-2e609375';
const REAL_MANIFEST_BASE_ID = 'snapshot-20260921T184722Z-3f770c73';

// Renders the text of the drizzle SQL condition chunks passed to `.where()` so
// we can assert on the *shape* of the CAS predicate without a real DB —
// vi.fn mocks don't evaluate SQL, so outcome-only assertions can't catch a
// staleness predicate that's semantically wrong but still "returns rows"
// under a dumb mock.
function sqlText(node: unknown): string {
  const out: string[] = [];
  const visit = (n: any) => {
    if (n && Array.isArray(n.queryChunks)) {
      for (const c of n.queryChunks) visit(c);
    } else if (n && Array.isArray(n.value)) {
      out.push(n.value.join(''));
    } else if (n && typeof n.name === 'string') {
      out.push(n.name);
    }
  };
  visit(node);
  return out.join('');
}

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SNAPSHOT_DB_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const STORAGE_IDENTITY = 'local::/srv/backups';

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set', 'orderBy', 'leftJoin', 'innerJoin', 'for']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

/** The file rows of one batch statement: its one JSON parameter (#11026). */
function batchRows(statement: unknown): Array<{ source_path: string; backup_path: string; size: number | null; modified_at: string | null; kind: string | null }> {
  const json = (statement as { queryChunks: unknown[] }).queryChunks.find((c): c is string => typeof c === 'string' && c.startsWith('['));
  return json ? JSON.parse(json) : [];
}

const { selectMock, insertMock, executeMock, updateMock, deleteMock, transactionMock, resolveSnapshotProviderConfigMock, fence } = vi.hoisted(() => ({
  selectMock: vi.fn<(...args: unknown[]) => any>(),
  insertMock: vi.fn<(...args: unknown[]) => any>(),
  executeMock: vi.fn<(...args: unknown[]) => any>(),
  updateMock: vi.fn<(...args: unknown[]) => any>(),
  deleteMock: vi.fn<(...args: unknown[]) => any>(),
  transactionMock: vi.fn<(cb: (tx: unknown) => unknown) => unknown>(),
  resolveSnapshotProviderConfigMock: vi.fn<(...args: unknown[]) => any>(),
  // The publish transaction's first statement (#11026 publish fence) locks the
  // snapshot row and re-reads the claim. It is answered here, outside the
  // ordered selectMock queue, echoing the claim this run stamped unless a test
  // overrides fields to simulate a newer state.
  fence: { override: {} as Record<string, unknown>, reads: [] as Array<Record<string, any>> },
}));

// The claim stamped by this run: the `file_index_hydrated_at` of the last
// `set({ fileIndexStatus: 'hydrating' })`.
function claimedAt(): unknown {
  for (const result of [...updateMock.mock.results].reverse()) {
    const set = (result.value as { set?: ReturnType<typeof vi.fn> })?.set;
    const claim = set?.mock.calls.map((c) => c[0]).find((v) => v?.fileIndexStatus === 'hydrating');
    if (claim) return claim.fileIndexHydratedAt;
  }
  return null;
}

function isFenceRead(fields: unknown): boolean {
  return !!fields && typeof fields === 'object' && 'fileIndexHydratedAt' in fields && !('snapshotId' in fields);
}

function routeSelect(...args: unknown[]) {
  if (isFenceRead(args[0])) {
    const chain = chainMock([{
      fileIndexStatus: 'hydrating', fileIndexHydratedAt: claimedAt(), orgId: ORG_ID, deviceId: DEVICE_ID,
      metadata: {}, integrityStatus: null, ...fence.override,
    }]);
    fence.reads.push(chain);
    return chain;
  }
  return selectMock(...(args as []));
}

vi.mock('../db', () => {
  const tx = {
    select: (...args: unknown[]) => routeSelect(...args),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    execute: (...args: unknown[]) => executeMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
    delete: (...args: unknown[]) => deleteMock(...(args as [])),
  };
  return {
    db: { ...tx, transaction: (cb: (t: typeof tx) => unknown) => transactionMock(cb as (t: unknown) => unknown) },
    runOutsideDbContext: vi.fn((fn: () => any) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
  };
});
const { refreshStatisticsMock } = vi.hoisted(() => ({
  refreshStatisticsMock: vi.fn<(rows: number, opts?: { minRows?: number }) => Promise<string>>(),
}));
vi.mock('./backupSnapshotFileIndexStatistics', () => ({
  refreshSnapshotFileIndexStatistics: (...args: [number, { minRows?: number }?]) => refreshStatisticsMock(...args),
}));
vi.mock('./recoveryBootstrap', () => ({
  resolveSnapshotProviderConfig: (...args: unknown[]) => resolveSnapshotProviderConfigMock(...args),
  getStringValue: (record: Record<string, unknown> | null, key: string) =>
    record && typeof record[key] === 'string' ? String(record[key]) : null,
  asRecord: (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
}));

import { redactIndexFailureReason, hydrateSnapshotFileIndex, readSnapshotFileIndexState } from './backupSnapshotFileIndex';
import { BackupObjectTooLargeError } from './backupSnapshotStorage';
import { setBackupMetricsRecorder } from './backupMetrics';

function snapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SNAPSHOT_DB_ID, orgId: ORG_ID, deviceId: DEVICE_ID, snapshotId: 'snap-current',
    jobId: 'job-1', configId: 'config-1', storageIdentity: STORAGE_IDENTITY,
    keyLayout: 'legacy_flat', keyPrefix: null,
    fileIndexStatus: 'none', fileIndexHydratedAt: null, referencedFiles: 5,
    ...overrides,
  };
}

function manifestBytes(entries: Array<{ sourcePath: string; backupPath: string; size?: number }>) {
  return Buffer.from(JSON.stringify({ id: 'snap-current', files: entries }), 'utf8');
}

// Wraps a bytes-returning stub as the stream-returning openManifest seam.
const openOf = (bytes: Uint8Array | Buffer) => vi.fn(async () => Readable.from([Buffer.from(bytes)]));

// Keep spool files out of the repo's apps/api/data: the default spool dir derives from PATCH_REPORT_STORAGE_PATH.
let spoolTmp: string;
const prevPatchReportPath = process.env.PATCH_REPORT_STORAGE_PATH;
beforeEach(() => {
  spoolTmp = mkdtempSync(join(tmpdir(), 'breeze-spool-test-'));
  process.env.PATCH_REPORT_STORAGE_PATH = join(spoolTmp, 'patch-reports');
});
afterEach(() => {
  if (prevPatchReportPath === undefined) delete process.env.PATCH_REPORT_STORAGE_PATH;
  else process.env.PATCH_REPORT_STORAGE_PATH = prevPatchReportPath;
  rmSync(spoolTmp, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  selectMock.mockImplementation(() => chainMock([]));
  insertMock.mockImplementation(() => chainMock([]));
  // As postgres-js answers: an array-like result carrying the row count.
  executeMock.mockImplementation(async (statement: unknown) => Object.assign([], { count: batchRows(statement).length }));
  // The claim's RETURNING (#6488) echoes the row the test's first select
  // loaded, as the real UPDATE would; a test that simulates a concurrent move
  // overrides the claim result explicitly.
  updateMock.mockImplementation(() => chainMock([{ id: SNAPSHOT_DB_ID }]));
  deleteMock.mockImplementation(() => chainMock([]));
  transactionMock.mockImplementation(async (cb: any) => cb({
    select: routeSelect, insert: insertMock, execute: executeMock, update: updateMock, delete: deleteMock,
  }));
  fence.override = {};
  fence.reads = [];
  refreshStatisticsMock.mockResolvedValue('below_threshold');
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
    const deps = { openManifest: vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' })) };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'manifest_missing', retryable: true });
  });

  it('fails terminally (not retryable) when the manifest object exceeds the fetch size cap', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow()]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    const tooLarge = new BackupObjectTooLargeError('snapshots/snap-current/manifest.json', 999999999, 1000);
    const deps = { openManifest: vi.fn().mockRejectedValue(tooLarge) };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'manifest_too_large', retryable: false });
  });

  it('fails closed and names the bad key when a manifest entry has an unparseable backupPath', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow()]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    const deps = {
      openManifest: openOf(
        manifestBytes([{ sourcePath: '/a', backupPath: 'snapshots/snap-current/../x' }]),
      ),
    };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'manifest_key_invalid', retryable: false });
    expect((outcome as { reason: string }).reason).toContain('snapshots/snap-current/../x');
  });

  it('hydrates a REAL agent manifest (D-W09-1 + D-W09-2, #11235): dir/symlink entries with an empty backupPath become rows with their kind, a backslash in a systemd unit key is admitted', async () => {
    const bytes = readFileSync(REAL_MANIFEST_FIXTURE);
    const manifest = JSON.parse(bytes.toString('utf8')) as { files: Array<{ backupPath: string; kind?: string }> };
    const contentless = manifest.files.filter((f) => f.backupPath === '');
    const external = manifest.files.filter((f) => f.backupPath.startsWith(`snapshots/${REAL_MANIFEST_BASE_ID}/`));
    const own = manifest.files.filter((f) => f.backupPath.startsWith(`snapshots/${REAL_MANIFEST_ID}/`));
    // The fixture must actually carry the traits that broke hydration on the KIT rig.
    expect(contentless.length).toBeGreaterThan(0);
    expect(contentless.every((f) => f.kind === 'dir' || f.kind === 'symlink')).toBe(true);
    expect(external.some((f) => f.backupPath.includes('\\x2d'))).toBe(true);
    expect(external.some((f) => f.backupPath.includes(':'))).toBe(true);

    selectMock
      .mockReturnValueOnce(chainMock([snapshotRow({ snapshotId: REAL_MANIFEST_ID })]))
      .mockReturnValueOnce(chainMock([{ referencedFiles: external.length }]))
      .mockReturnValueOnce(chainMock([{ id: 'origin-db-id', orgId: ORG_ID, deviceId: DEVICE_ID, storageIdentity: STORAGE_IDENTITY, keyLayout: 'legacy_flat', keyPrefix: null, metadata: {} }]));
    const deps = { openManifest: openOf(new Uint8Array(bytes)) };

    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });

    expect(outcome).toMatchObject({
      status: 'complete',
      entryCount: manifest.files.length,
      externalCount: external.length,
      originSnapshotIds: [REAL_MANIFEST_BASE_ID],
    });
    // Every content entry — backslash and colon keys included — is written verbatim as a file row.
    const insertedRows = executeMock.mock.calls.flatMap((c) => batchRows(c[0]));
    const insertedKeys = new Set(insertedRows.map((r) => r.backup_path));
    for (const f of [...external, ...own]) expect(insertedKeys.has(f.backupPath)).toBe(true);
    expect(insertedRows.filter((r) => r.backup_path !== '').every((r) => r.kind === null)).toBe(true);
    // Every content-less entry is a row too, with the kind the agent recorded.
    const contentlessRows = insertedRows.filter((r) => r.backup_path === '');
    expect(contentlessRows.map((r) => r.kind)).toEqual(contentless.map((f) => f.kind));
  });

  it('still fails manifest_invalid when a CONTENT entry (no kind) has an empty backupPath — the relaxation is by kind, not blanket — and the reason names the entry, not a zod dump', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow()]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    const entries = Array.from({ length: 3000 }, (_, i) => ({ sourcePath: `/bad${i}`, backupPath: '' }));
    const deps = { openManifest: openOf(manifestBytes(entries)) };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'manifest_invalid', retryable: false });
    const reason = (outcome as { reason: string }).reason;
    // First offending entry named by sourcePath, total count reported, and
    // NOT the multi-megabyte ZodError JSON for 3,000 issues.
    expect(reason).toContain('"/bad0"');
    expect(reason).toContain('2999 more issue(s)');
    expect(reason.length).toBeLessThan(400);
  });

  it('admits an UNKNOWN kind from a newer agent as long as a content entry names its object (forward compatible, fails closed only on missing object)', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow()]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    const deps = {
      openManifest: openOf(
        manifestBytes([{ sourcePath: '/a', backupPath: 'snapshots/snap-current/files/a.gz', kind: 'hardlink' } as never]),
      ),
    };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'complete', entryCount: 1 });
  });

  it('verifies an origin against a LIVE row on the same device/identity (provenance: live)', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([snapshotRow()])) // load snapshot
      .mockReturnValueOnce(chainMock([{ referencedFiles: 5 }])) // job.referencedFiles
      .mockReturnValueOnce(chainMock([{ // origin live row
        id: 'origin-db-id', orgId: ORG_ID, deviceId: DEVICE_ID, storageIdentity: STORAGE_IDENTITY, keyLayout: 'legacy_flat', keyPrefix: null,
        metadata: { storagePrefix: null },
      }]));
    const deps = {
      openManifest: openOf(
        manifestBytes([
          { sourcePath: '/a', backupPath: 'snapshots/snap-older/files/a.gz', size: 10 },
          { sourcePath: '/b', backupPath: 'snapshots/snap-current/files/b.gz', size: 20 },
        ]),
      ),
    };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'complete', entryCount: 2, externalCount: 1, originSnapshotIds: ['snap-older'] });
  });

  it('pins origins to the org/device the CLAIM returned, not the pre-claim read (#6488: concurrent org-move)', async () => {
    const MOVED_ORG_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    selectMock
      .mockReturnValueOnce(chainMock([snapshotRow()])) // pre-claim read: source org
      .mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]))
      .mockReturnValueOnce(chainMock([{
        id: 'origin-db-id', orgId: MOVED_ORG_ID, deviceId: DEVICE_ID, storageIdentity: STORAGE_IDENTITY, keyLayout: 'legacy_flat', keyPrefix: null,
        metadata: { storagePrefix: null },
      }]));
    // The claim waited out a move and re-evaluated against the moved row.
    updateMock.mockReturnValueOnce(chainMock([{
      id: SNAPSHOT_DB_ID, orgId: MOVED_ORG_ID, deviceId: DEVICE_ID, snapshotId: 'snap-current', storageIdentity: STORAGE_IDENTITY,
    }]));
    // ...and the row still holds that claim, in the moved org, at publish.
    fence.override = { orgId: MOVED_ORG_ID };
    const deps = {
      openManifest: openOf(
        manifestBytes([{ sourcePath: '/a', backupPath: 'snapshots/snap-older/files/a.gz', size: 10 }]),
      ),
    };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'complete', originSnapshotIds: ['snap-older'] });
    const originInsert = insertMock.mock.results
      .map((r) => (r.value as { values: ReturnType<typeof vi.fn> }).values.mock.calls[0]?.[0])
      .find((v) => Array.isArray(v) && v.some((row: Record<string, unknown>) => 'originOrgId' in row)) as
      | Array<Record<string, unknown>>
      | undefined;
    expect(originInsert).toEqual([expect.objectContaining({ originSnapshotId: 'snap-older', originOrgId: MOVED_ORG_ID, originDeviceId: DEVICE_ID })]);
  });

  it('verifies an origin against a RETIREMENT record when the live row is gone (provenance: retired)', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([snapshotRow()]))
      .mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]))
      .mockReturnValueOnce(chainMock([])) // no live row
      .mockReturnValueOnce(chainMock([{ // retirement row
        orgId: ORG_ID, deviceId: DEVICE_ID, storageIdentity: STORAGE_IDENTITY, snapshotId: 'snap-older', keyLayout: 'legacy_flat', keyPrefix: null,
      }]));
    const deps = {
      openManifest: openOf(
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
      openManifest: openOf(
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
      openManifest: openOf(
        manifestBytes([{ sourcePath: '/a', backupPath: 'snapshots/snap-older/files/a.gz', size: 10 }]),
      ),
    };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'origin_unverifiable', retryable: false });
  });

  it('writes rows in 250-row batches then publishes sha/counts/metadata in one final transaction', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([snapshotRow()]))
      .mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]))
      .mockReturnValueOnce(chainMock([{ id: 'origin-db-id', orgId: ORG_ID, deviceId: DEVICE_ID, storageIdentity: STORAGE_IDENTITY, keyLayout: 'legacy_flat', keyPrefix: null, metadata: {} }]));
    const entries = Array.from({ length: 300 }, (_, i) => ({
      sourcePath: `/f${i}`, backupPath: `snapshots/snap-older/files/f${i}.gz`, size: 1,
    }));
    const bytes = manifestBytes(entries);
    const deps = { openManifest: openOf(bytes) };

    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });

    expect(outcome).toMatchObject({ status: 'complete', entryCount: 300, externalCount: 300 });
    expect((outcome as { manifestSha256: string }).manifestSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    // 2 batches of file rows (250 + 50), written in the ONE publish
    // transaction so a reader never sees a partial index (#11026 D4).
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(executeMock.mock.calls.map((c) => batchRows(c[0]).length)).toEqual([250, 50]);
  });

  describe('statistics refresh after the publish (#11209)', () => {
    const publishable = () => {
      selectMock
        .mockReturnValueOnce(chainMock([snapshotRow()]))
        .mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]))
        .mockReturnValueOnce(chainMock([{ id: 'origin-db-id', orgId: ORG_ID, deviceId: DEVICE_ID, storageIdentity: STORAGE_IDENTITY, keyLayout: 'legacy_flat', keyPrefix: null, metadata: {} }]));
      return manifestBytes(Array.from({ length: 300 }, (_, i) => ({
        sourcePath: `/f${i}`, backupPath: `snapshots/snap-older/files/f${i}.gz`, size: 1,
      })));
    };

    it('asks for a refresh once the publish transaction has finished, with the rows it wrote and the threshold seam', async () => {
      const deps = { openManifest: openOf(publishable()), statisticsRefreshMinRows: 123 };

      const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });

      expect(outcome).toMatchObject({ status: 'complete', entryCount: 300 });
      expect(refreshStatisticsMock).toHaveBeenCalledTimes(1);
      expect(refreshStatisticsMock).toHaveBeenCalledWith(300, { minRows: 123 });
      const publishEnded = transactionMock.mock.results[0]!.value as Promise<unknown>;
      await publishEnded;
      expect(refreshStatisticsMock.mock.invocationCallOrder[0]!).toBeGreaterThan(transactionMock.mock.invocationCallOrder[0]!);
    });

    it('keeps the run complete, and the snapshot unfailed, when the refresh reports an error', async () => {
      refreshStatisticsMock.mockResolvedValue('error');
      const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: { openManifest: openOf(publishable()) } });

      expect(outcome).toMatchObject({ status: 'complete', entryCount: 300 });
      const statusWrites = updateMock.mock.results
        .flatMap((r) => ((r.value as { set?: ReturnType<typeof vi.fn> }).set?.mock.calls ?? []).map((c) => c[0]?.fileIndexStatus));
      expect(statusWrites).not.toContain('failed');
    });

    it('does not refresh after a run that published nothing', async () => {
      selectMock.mockReturnValueOnce(chainMock([snapshotRow({ referencedFiles: null })]));
      selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: null }]));
      expect(await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID)).toMatchObject({ status: 'skipped' });

      selectMock.mockReturnValueOnce(chainMock([snapshotRow()]));
      selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
      const missing = { openManifest: vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' })) };
      expect(await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: missing })).toMatchObject({ status: 'failed' });

      // Refused inside the publish transaction itself, so it reaches the code
      // after it.
      selectMock
        .mockReturnValueOnce(chainMock([snapshotRow()]))
        .mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]))
        .mockReturnValueOnce(chainMock([]))
        .mockReturnValueOnce(chainMock([]));
      const unverifiable = {
        openManifest: openOf(manifestBytes([{ sourcePath: '/a', backupPath: 'snapshots/snap-older/files/a.gz', size: 10 }])),
        statisticsRefreshMinRows: 0,
      };
      expect(await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: unverifiable })).toMatchObject({ status: 'failed', failure: 'origin_unverifiable' });

      expect(refreshStatisticsMock).not.toHaveBeenCalled();
    });
  });

  it('reclaims a stale hydrating row (>30min) — the CAS predicate itself expresses staleness', async () => {
    const now = new Date('2026-09-20T12:00:00Z');
    const hydratedAt = new Date(now.getTime() - 31 * 60 * 1000);
    selectMock.mockReturnValueOnce(chainMock([snapshotRow({ fileIndexStatus: 'hydrating', fileIndexHydratedAt: hydratedAt })]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    selectMock.mockReturnValueOnce(chainMock([{ id: 'origin-db-id', orgId: ORG_ID, deviceId: DEVICE_ID, storageIdentity: STORAGE_IDENTITY, keyLayout: 'legacy_flat', keyPrefix: null, metadata: {} }]));
    const deps = {
      now: () => now,
      openManifest: openOf(
        manifestBytes([{ sourcePath: '/a', backupPath: 'snapshots/snap-older/files/a.gz', size: 10 }]),
      ),
    };

    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });

    // The CAS where() must be an OR — status<>'hydrating' OR hydratedAt stale
    // OR hydratedAt null — never the bare `ne(status,'hydrating')` that can
    // never match a row whose status IS 'hydrating', no matter how stale.
    const casWhereCall = updateMock.mock.results.find((r) => {
      const chain = r.value as { where: ReturnType<typeof vi.fn> };
      return chain.where?.mock.calls.some((c) => sqlText(c[0]).includes('or'));
    });
    expect(casWhereCall, 'expected a CAS where() call whose predicate is an OR expressing staleness').toBeDefined();
    const whereArg = (casWhereCall!.value as { where: ReturnType<typeof vi.fn> }).where.mock.calls[0]?.[0];
    expect(sqlText(whereArg)).toContain('or');
    expect(sqlText(whereArg)).toContain('file_index_hydrated_at');

    // The claim itself must stamp hydratedAt = now so later staleness is
    // measured from the claim, not the original stale value.
    const casSetCall = updateMock.mock.results[0]!.value as { set: ReturnType<typeof vi.fn> };
    expect(casSetCall.set).toHaveBeenCalledWith(expect.objectContaining({ fileIndexStatus: 'hydrating', fileIndexHydratedAt: now }));

    expect(outcome).toMatchObject({ status: 'complete' });
  });

  it('still skips in_progress for a FRESH hydrating row (<30min)', async () => {
    const now = new Date('2026-09-20T12:00:00Z');
    const hydratedAt = new Date(now.getTime() - 5 * 60 * 1000);
    selectMock.mockReturnValueOnce(chainMock([snapshotRow({ fileIndexStatus: 'hydrating', fileIndexHydratedAt: hydratedAt })]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: { now: () => now, openManifest: vi.fn() } });
    expect(outcome).toEqual({ status: 'skipped', reason: 'in_progress' });
  });

  it('classifies an unclassified throw after the CAS as provider_error, fails closed, and rethrows to the caller', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow()]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    selectMock.mockReturnValueOnce(chainMock([{ id: 'origin-db-id', orgId: ORG_ID, deviceId: DEVICE_ID, storageIdentity: STORAGE_IDENTITY, keyLayout: 'legacy_flat', keyPrefix: null, metadata: {} }]));
    // insert during the file-row batch write throws an unclassified error
    executeMock.mockImplementationOnce(() => {
      throw new Error('boom: insert failed');
    });
    const deps = {
      openManifest: openOf(
        manifestBytes([{ sourcePath: '/a', backupPath: 'snapshots/snap-older/files/a.gz', size: 10 }]),
      ),
    };

    await expect(hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps })).rejects.toThrow(/boom: insert failed/);

    const lastUpdateChain = updateMock.mock.results.at(-1)!.value as { set: ReturnType<typeof vi.fn> };
    expect(lastUpdateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ fileIndexStatus: 'failed', fileIndexError: expect.stringMatching(/^provider_error: /) }),
    );
  });

  it('redactIndexFailureReason strips hosts, addresses and URLs but keeps the error code (#11280)', () => {
    expect(redactIndexFailureReason('connect ECONNREFUSED 127.0.0.1:9')).toBe('connect ECONNREFUSED [redacted]');
    expect(redactIndexFailureReason('getaddrinfo ENOTFOUND bucket.s3.example.net')).toBe('getaddrinfo ENOTFOUND [redacted]');
    expect(redactIndexFailureReason('request to https://s3.example.net/bucket/key failed')).toBe('request to [redacted] failed');
    expect(redactIndexFailureReason('connect ETIMEDOUT [2001:db8::1]:443')).toBe('connect ETIMEDOUT [redacted]');
    expect(redactIndexFailureReason('connect ECONNREFUSED minio:9000')).toBe('connect ECONNREFUSED [redacted]');
    expect(redactIndexFailureReason('connect ECONNREFUSED ::1:9000')).toBe('connect ECONNREFUSED [redacted]');
    expect(redactIndexFailureReason('2001:db8::1 unreachable')).toBe('[redacted] unreachable');
    expect(redactIndexFailureReason('manifest has no files key')).toBe('manifest has no files key');
    expect(redactIndexFailureReason("Hostname/IP does not match certificate's altnames: Host: bucket.example.net")).toBe("Hostname/IP does not match certificate's altnames: Host: [redacted]");
    expect(redactIndexFailureReason('The bucket is in another region; use endpoint bucket.s3.eu-west-1.amazonaws.com')).toBe('The bucket is in another region; use endpoint [redacted]');
    expect(redactIndexFailureReason('file.tar.gz missing')).toBe('file.tar.gz missing');
    expect(redactIndexFailureReason('manifest.json is not valid')).toBe('manifest.json is not valid');
    expect(redactIndexFailureReason('x'.repeat(500)).length).toBeLessThanOrEqual(200);
  });

  it('stores a provider connection failure as its code with the host and port redacted (#11280)', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow()]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    const openManifest = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:9'));

    await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: { openManifest } });

    const sets = updateMock.mock.results
      .flatMap((r) => (r.value as { set: ReturnType<typeof vi.fn> }).set.mock.calls.map((c) => c[0]));
    const failed = sets.find((v) => v?.fileIndexStatus === 'failed');
    expect(failed?.fileIndexError).toMatch(/^provider_error: .*ECONNREFUSED/);
    expect(failed?.fileIndexError).not.toMatch(/127\.0\.0\.1|:9\b/);
  });

  it('records a neutral provider_error reason when the claim phase throws after the CAS (#11179), then rethrows', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow()]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    // The CAS has stamped 'hydrating'; resolving the provider then throws.
    resolveSnapshotProviderConfigMock.mockRejectedValueOnce(new Error('kms unreachable at 10.0.0.9'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: { openManifest: vi.fn() } }))
      .rejects.toThrow(/kms unreachable/);

    const sets = updateMock.mock.results
      .flatMap((r) => (r.value as { set: ReturnType<typeof vi.fn> }).set.mock.calls.map((c) => c[0]));
    const failed = sets.find((v) => v?.fileIndexStatus === 'failed');
    expect(failed).toBeDefined();
    expect(failed.fileIndexError).toMatch(/^provider_error: /);
    // Neutral and bounded: the raw error text (which can name hosts) is not stored.
    expect(failed.fileIndexError).not.toMatch(/kms|10\.0\.0\.9/);
    expect(failed.fileIndexError.length).toBeLessThan(200);
    consoleError.mockRestore();
  });

  it('still rethrows the original claim-phase error when recording the reason also fails (#11179)', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow()]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    resolveSnapshotProviderConfigMock.mockRejectedValueOnce(new Error('kms down'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    updateMock
      .mockImplementationOnce(() => chainMock([{ id: SNAPSHOT_DB_ID }]))
      .mockImplementationOnce(() => { throw new Error('db gone'); });
    await expect(hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: { openManifest: vi.fn() } })).rejects.toThrow('kms down');
    consoleError.mockRestore();
  });

  it('on any hydration failure sets status failed with the reason, leaving whatever rows already wrote untouched', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow()]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    const deps = { openManifest: openOf(Buffer.from('not json')) };
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

describe('file index bound to the snapshot attestation', () => {
  const bytes = manifestBytes([{ sourcePath: '/b', backupPath: 'snapshots/snap-current/files/b.gz', size: 20 }]);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const other = 'f'.repeat(64);
  const fileRowInserts = () => executeMock.mock.calls.length + insertMock.mock.calls.length;

  it('skips a complete index built from the attested manifest', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow({
      fileIndexStatus: 'complete', fileIndexManifestSha256: digest, attestation: { status: 'verified', manifestSha256: digest },
    })]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    expect(await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID)).toEqual({ status: 'skipped', reason: 'already_complete' });
  });

  it('rebuilds a complete index that was built from other manifest bytes than the attestation names', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow({
      fileIndexStatus: 'complete', fileIndexManifestSha256: other, attestation: { status: 'pending', manifestSha256: digest },
    })]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    const deps = { openManifest: openOf(bytes) };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'complete', manifestSha256: digest });
  });

  it('refuses manifest bytes that differ from the attestation before writing any row', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow({ attestation: { status: 'verified', manifestSha256: other } })]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    const deps = { openManifest: openOf(bytes) };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'manifest_differs_from_attestation', retryable: false });
    expect(fileRowInserts()).toBe(0);
    const failedSet = updateMock.mock.results.map((r) => r.value.set.mock.calls[0]?.[0]).find((v) => v?.fileIndexStatus === 'failed');
    expect(failedSet?.fileIndexError).toMatch(/^manifest_differs_from_attestation: /);
  });

  it('refuses to build an index for a snapshot whose attestation did not match, without reading storage', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow({ attestation: { status: 'mismatch', manifestSha256: digest } })]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    const deps = { openManifest: openOf(bytes) };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'attestation_failed', retryable: false });
    expect(deps.openManifest).not.toHaveBeenCalled();
  });

  it('refuses to build an index for a snapshot whose statement was refused when it was reported (no attestation row)', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow({ integrityStatus: 'attestation_failed' })]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    const deps = { openManifest: openOf(bytes) };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'attestation_failed', retryable: false });
    expect(deps.openManifest).not.toHaveBeenCalled();
  });

  it('a statement refused meanwhile (projection only) also keeps the index unpublished', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([snapshotRow()]))
      .mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]))
      .mockReturnValueOnce(chainMock([]));
    fence.override = { integrityStatus: 'attestation_failed' };
    const deps = { openManifest: openOf(bytes) };
    expect(await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps })).toMatchObject({ status: 'failed', failure: 'attestation_failed' });
    expect(fileRowInserts()).toBe(0);
  });

  it('re-checks under the snapshot row lock at publish: an attestation recorded meanwhile that names other bytes keeps the index unpublished', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([snapshotRow()])) // claim: no attestation yet
      .mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    const attestationRead = chainMock([{ status: 'pending', manifestSha256: other }]);
    // Final transaction: the snapshot row lock, then (a later statement, so a
    // fresh snapshot under READ COMMITTED) the attestation.
    selectMock.mockReturnValueOnce(attestationRead);
    const deps = { openManifest: openOf(bytes) };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'manifest_differs_from_attestation', retryable: false });
    expect(fence.reads).toHaveLength(1);
    expect(fence.reads[0]!.for).toHaveBeenCalledWith('update');
    expect(attestationRead.for).not.toHaveBeenCalled();
    const sets = updateMock.mock.results.map((r) => r.value.set.mock.calls[0]?.[0]);
    expect(sets.some((v) => v?.fileIndexStatus === 'complete')).toBe(false);
    // Refused before anything was replaced: the previous rows were not deleted.
    expect(deleteMock).not.toHaveBeenCalled();
    expect(fileRowInserts()).toBe(0);
  });

  it('a mismatched attestation recorded meanwhile also keeps the index unpublished', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([snapshotRow()]))
      .mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]))
      .mockReturnValueOnce(chainMock([{ status: 'mismatch', manifestSha256: digest }]));
    const deps = { openManifest: openOf(bytes) };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'attestation_failed' });
  });

  it('publishes when the attestation recorded meanwhile names the same bytes', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([snapshotRow()]))
      .mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]))
      .mockReturnValueOnce(chainMock([{ status: 'pending', manifestSha256: digest }]));
    const deps = { openManifest: openOf(bytes) };
    expect(await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps })).toMatchObject({ status: 'complete', manifestSha256: digest });
  });

  describe('readSnapshotFileIndexState', () => {
    const indexRow = (attestation: unknown) => chainMock([{
      status: 'complete', manifestSha256: digest, externalCount: 1, error: null, jobId: 'job-1', storageIdentity: STORAGE_IDENTITY,
      attestation,
    }]);

    it('reports a bound complete index as complete', async () => {
      selectMock
        .mockReturnValueOnce(indexRow({ status: 'verified', manifestSha256: digest }))
        .mockReturnValueOnce(chainMock([{ referencedFiles: 1 }]))
        .mockReturnValueOnce(chainMock([{ originSnapshotId: 'snap-older' }]));
      expect(await readSnapshotFileIndexState(SNAPSHOT_DB_ID)).toMatchObject({ status: 'complete', manifestSha256: digest, originSnapshotIds: ['snap-older'] });
    });

    it('reports a complete index built from other bytes than the attestation names as not built', async () => {
      selectMock
        .mockReturnValueOnce(indexRow({ status: 'pending', manifestSha256: other }))
        .mockReturnValueOnce(chainMock([{ referencedFiles: 1 }]));
      const state = await readSnapshotFileIndexState(SNAPSHOT_DB_ID);
      expect(state).toMatchObject({ status: 'none', manifestSha256: null, originSnapshotIds: [] });
    });

    it('reports the index of a snapshot whose statement was refused (no row) as failed', async () => {
      selectMock
        .mockReturnValueOnce(chainMock([{
          status: 'complete', manifestSha256: digest, externalCount: 1, error: null, jobId: 'job-1', storageIdentity: STORAGE_IDENTITY,
          integrityStatus: 'attestation_failed', attestation: null,
        }]))
        .mockReturnValueOnce(chainMock([{ referencedFiles: 1 }]));
      expect(await readSnapshotFileIndexState(SNAPSHOT_DB_ID)).toMatchObject({ status: 'failed', retryable: false });
    });

    it('reports the index of a snapshot whose attestation did not match as failed, not retryable', async () => {
      selectMock
        .mockReturnValueOnce(indexRow({ status: 'mismatch', manifestSha256: digest }))
        .mockReturnValueOnce(chainMock([{ referencedFiles: 1 }]));
      const state = await readSnapshotFileIndexState(SNAPSHOT_DB_ID);
      expect(state).toMatchObject({ status: 'failed', manifestSha256: null, retryable: false });
      expect(state?.error).toMatch(/^attestation_failed: /);
    });
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

// #7081: hydration reads the manifest under the snapshot's recorded key root
// and only verifies an origin whose recorded root is the same one (I4).
describe('hydrateSnapshotFileIndex key root (#7081)', () => {
  const PREFIX = 'msp/acme';
  const prefixedRow = (o: Record<string, unknown> = {}) => snapshotRow({ keyLayout: 'prefixed_flat', keyPrefix: PREFIX, ...o });
  const externalManifest = () => manifestBytes([
    { sourcePath: '/a', backupPath: 'snapshots/snap-older/files/a.gz', size: 10 },
    { sourcePath: '/b', backupPath: 'snapshots/snap-current/files/b.gz', size: 20 },
  ]);
  const liveOrigin = (root: Record<string, unknown>) => ({
    id: 'origin-db-id', orgId: ORG_ID, deviceId: DEVICE_ID, storageIdentity: STORAGE_IDENTITY, metadata: {}, ...root,
  });

  it('fetches the manifest at the physical key under the recorded root', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([prefixedRow()]))
      .mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    const deps = { openManifest: openOf(manifestBytes([{ sourcePath: '/b', backupPath: 'snapshots/snap-current/files/b.gz' }])) };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'complete', entryCount: 1 });
    expect(deps.openManifest).toHaveBeenCalledWith(expect.objectContaining({ key: `${PREFIX}/snapshots/snap-current/manifest.json` }));
  });

  it('accepts a live origin under the same root', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([prefixedRow()]))
      .mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]))
      .mockReturnValueOnce(chainMock([liveOrigin({ keyLayout: 'prefixed_flat', keyPrefix: PREFIX })]));
    const deps = { openManifest: openOf(externalManifest()) };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'complete', originSnapshotIds: ['snap-older'] });
  });

  it.each([
    ['a prefixed snapshot, live origin legacy', prefixedRow(), { keyLayout: 'legacy_flat', keyPrefix: null }],
    ['a prefixed snapshot, live origin under another prefix', prefixedRow(), { keyLayout: 'prefixed_flat', keyPrefix: 'msp/other' }],
    ['a legacy snapshot, live origin prefixed', snapshotRow(), { keyLayout: 'prefixed_flat', keyPrefix: PREFIX }],
  ])('fails origin_key_root_mismatch (terminal) for %s, writing no origins', async (_name, own, originRoot) => {
    selectMock
      .mockReturnValueOnce(chainMock([own]))
      .mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]))
      .mockReturnValueOnce(chainMock([liveOrigin(originRoot)]));
    const deps = { openManifest: openOf(externalManifest()) };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'origin_key_root_mismatch', retryable: false });
    expect(insertMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('fails origin_key_root_mismatch for a retired origin under another root', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([prefixedRow()]))
      .mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]))
      .mockReturnValueOnce(chainMock([])) // no live row
      .mockReturnValueOnce(chainMock([{
        orgId: ORG_ID, deviceId: DEVICE_ID, storageIdentity: STORAGE_IDENTITY, snapshotId: 'snap-older', keyLayout: 'legacy_flat', keyPrefix: null,
      }]));
    const deps = { openManifest: openOf(externalManifest()) };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'origin_key_root_mismatch', retryable: false });
  });

  it('fails key_root_invalid (terminal) without reading storage when the snapshot\'s own root is unreadable', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([prefixedRow({ keyPrefix: 'x/snapshots' })]))
      .mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    const deps = { openManifest: vi.fn() };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'key_root_invalid', retryable: false });
    expect(deps.openManifest).not.toHaveBeenCalled();
  });
});

describe('hydration telemetry (#11026)', () => {
  const onSnapshotFileIndex = vi.fn();
  beforeEach(() => {
    onSnapshotFileIndex.mockClear();
    setBackupMetricsRecorder({ onSnapshotFileIndex });
  });
  afterEach(() => setBackupMetricsRecorder(null));

  const arrange = () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow()]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
  };

  it('counts a complete run by status', async () => {
    arrange();
    const bytes = manifestBytes([{ sourcePath: '/b', backupPath: 'snapshots/snap-current/files/b.gz', size: 20 }]);
    await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: { openManifest: openOf(bytes) } });
    expect(onSnapshotFileIndex).toHaveBeenCalledTimes(1);
    expect(onSnapshotFileIndex).toHaveBeenCalledWith('hydration', 'complete', 1);
  });

  it('counts a failure by its code, never its reason text', async () => {
    arrange();
    const deps = { openManifest: vi.fn().mockRejectedValue(Object.assign(new Error('secret-bucket'), { code: 'ENOENT' })) };
    await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(onSnapshotFileIndex).toHaveBeenCalledWith('hydration', 'manifest_missing', 1);
  });

  it('counts a skipped run by its reason', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow({ fileIndexStatus: 'complete' })]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID);
    expect(onSnapshotFileIndex).toHaveBeenCalledWith('hydration', 'already_complete', 1);
  });

  it('counts a superseded run as superseded, so lost claims are visible', async () => {
    arrange();
    fence.override = { fileIndexStatus: 'none' };
    const bytes = manifestBytes([{ sourcePath: '/b', backupPath: 'snapshots/snap-current/files/b.gz', size: 20 }]);
    await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: { openManifest: openOf(bytes) } });
    expect(onSnapshotFileIndex).toHaveBeenCalledWith('hydration', 'superseded', 1);
  });

  it('counts a run that threw as error, and still throws', async () => {
    arrange();
    executeMock.mockImplementationOnce(() => { throw new Error('boom'); });
    const bytes = manifestBytes([{ sourcePath: '/b', backupPath: 'snapshots/snap-current/files/b.gz', size: 20 }]);
    await expect(hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: { openManifest: openOf(bytes) } })).rejects.toThrow('boom');
    expect(onSnapshotFileIndex).toHaveBeenCalledWith('hydration', 'error', 1);
  });

  it('rethrows the original error when recording the failure also fails', async () => {
    arrange();
    executeMock.mockImplementationOnce(() => { throw new Error('boom'); });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Claim succeeds; the outer catch's failure write then fails too.
    updateMock
      .mockImplementationOnce(() => chainMock([{ id: SNAPSHOT_DB_ID }]))
      .mockImplementationOnce(() => { throw new Error('db gone'); });
    const bytes = manifestBytes([{ sourcePath: '/b', backupPath: 'snapshots/snap-current/files/b.gz', size: 20 }]);
    await expect(hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: { openManifest: openOf(bytes) } })).rejects.toThrow('boom');
    consoleError.mockRestore();
  });
});

describe('publish fence (#11026 D5): a superseded hydration never publishes', () => {
  const bytes = manifestBytes([{ sourcePath: '/b', backupPath: 'snapshots/snap-current/files/b.gz', size: 20 }]);
  const setsCarrying = (status: string) =>
    updateMock.mock.results.map((r) => r.value.set.mock.calls[0]?.[0]).filter((v) => v?.fileIndexStatus === status);
  const arrange = () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow()]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
  };
  const fetching = () => ({ openManifest: openOf(bytes) });

  it('a claim whose file_index_hydrated_at changed before the write phase is superseded and writes nothing', async () => {
    arrange();
    fence.override = { fileIndexHydratedAt: new Date('2030-01-01T00:00:00Z') }; // another worker reclaimed it
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: fetching() });
    expect(outcome).toEqual({ status: 'skipped', reason: 'superseded' });
    expect(deleteMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
    expect(setsCarrying('complete')).toHaveLength(0);
    expect(setsCarrying('failed')).toHaveLength(0);
    expect(fence.reads[0]!.for).toHaveBeenCalledWith('update');
  });

  it('an org move during the fetch (the tenancy trigger reset the index to none) is superseded, not complete', async () => {
    arrange();
    fence.override = { fileIndexStatus: 'none' };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: fetching() });
    expect(outcome).toEqual({ status: 'skipped', reason: 'superseded' });
    expect(setsCarrying('complete')).toHaveLength(0);
    expect(insertMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it.each([
    ['org', { orgId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }],
    ['device', { deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }],
  ])('a snapshot whose %s changed since the claim is superseded', async (_what, override) => {
    arrange();
    fence.override = override;
    expect(await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: fetching() })).toEqual({ status: 'skipped', reason: 'superseded' });
    expect(insertMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('a snapshot row gone at publish is superseded', async () => {
    arrange();
    transactionMock.mockImplementationOnce(async (cb: any) => cb({
      select: () => chainMock([]), insert: insertMock, update: updateMock, delete: deleteMock,
    }));
    expect(await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: fetching() })).toEqual({ status: 'skipped', reason: 'superseded' });
    expect(insertMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('a failure from a superseded run does not overwrite the newer state: it is scoped by the claim and reports superseded', async () => {
    arrange();
    // The claim lands; the later failure write matches no row (newer state).
    updateMock
      .mockImplementationOnce(() => chainMock([{ id: SNAPSHOT_DB_ID }]))
      .mockImplementationOnce(() => chainMock([]));
    const deps = { openManifest: vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' })) };
    expect(await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps })).toEqual({ status: 'skipped', reason: 'superseded' });
    const failWrite = updateMock.mock.results[1]!.value as { set: ReturnType<typeof vi.fn>; where: ReturnType<typeof vi.fn> };
    expect(failWrite.set).toHaveBeenCalledWith(expect.objectContaining({ fileIndexStatus: 'failed' }));
    const predicate = sqlText(failWrite.where.mock.calls[0]?.[0]);
    expect(predicate).toContain('file_index_status');
    expect(predicate).toContain('file_index_hydrated_at');
  });

  it('a failure from the run that still holds its claim is recorded as before', async () => {
    arrange();
    const deps = { openManifest: vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' })) };
    expect(await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps })).toMatchObject({ status: 'failed', failure: 'manifest_missing', retryable: true });
  });

  it('publishes complete scoped by the claim', async () => {
    arrange();
    expect(await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: fetching() })).toMatchObject({ status: 'complete' });
    const publish = updateMock.mock.results.find((r) => r.value.set.mock.calls[0]?.[0]?.fileIndexStatus === 'complete')!.value as {
      where: ReturnType<typeof vi.fn>;
    };
    expect(sqlText(publish.where.mock.calls[0]?.[0])).toContain('file_index_hydrated_at');
  });
});
