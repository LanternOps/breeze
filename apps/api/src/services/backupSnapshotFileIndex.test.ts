import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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
  // The claim's RETURNING (#6488) echoes the row the test's first select
  // loaded, as the real UPDATE would; a test that simulates a concurrent move
  // overrides the claim result explicitly.
  updateMock.mockImplementation(() => chainMock([{ id: SNAPSHOT_DB_ID }]));
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

  it('hydrates a REAL agent manifest (D-W09-1 + D-W09-2): empty backupPath on dir/symlink entries is skipped, a backslash in a systemd unit key is admitted', async () => {
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
      .mockReturnValueOnce(chainMock([{ id: 'origin-db-id', orgId: ORG_ID, deviceId: DEVICE_ID, storageIdentity: STORAGE_IDENTITY, metadata: {} }]));
    const deps = { fetchManifestBytes: vi.fn().mockResolvedValue(new Uint8Array(bytes)) };

    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });

    expect(outcome).toMatchObject({
      status: 'complete',
      entryCount: external.length + own.length,
      externalCount: external.length,
      originSnapshotIds: [REAL_MANIFEST_BASE_ID],
    });
    // Every content entry — backslash and colon keys included — is written verbatim as a file row.
    const insertedRows = insertMock.mock.results
      .map((r) => r.value)
      .flatMap((chain) => (chain?.values?.mock?.calls ?? []).flatMap((c: unknown[]) => c[0] as Array<{ backupPath: string }>));
    const insertedKeys = new Set(insertedRows.map((r) => r.backupPath));
    for (const f of [...external, ...own]) expect(insertedKeys.has(f.backupPath)).toBe(true);
    for (const f of contentless) expect(insertedKeys.has('')).toBe(false);
  });

  it('still fails manifest_invalid when a CONTENT entry (no kind) has an empty backupPath — the relaxation is by kind, not blanket — and the reason names the entry, not a zod dump', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow()]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    const entries = Array.from({ length: 3000 }, (_, i) => ({ sourcePath: `/bad${i}`, backupPath: '' }));
    const deps = { fetchManifestBytes: vi.fn().mockResolvedValue(manifestBytes(entries)) };
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
      fetchManifestBytes: vi.fn().mockResolvedValue(
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

  it('pins origins to the org/device the CLAIM returned, not the pre-claim read (#6488: concurrent org-move)', async () => {
    const MOVED_ORG_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    selectMock
      .mockReturnValueOnce(chainMock([snapshotRow()])) // pre-claim read: source org
      .mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]))
      .mockReturnValueOnce(chainMock([{
        id: 'origin-db-id', orgId: MOVED_ORG_ID, deviceId: DEVICE_ID, storageIdentity: STORAGE_IDENTITY,
        metadata: { storagePrefix: null },
      }]));
    // The claim waited out a move and re-evaluated against the moved row.
    updateMock.mockReturnValueOnce(chainMock([{
      id: SNAPSHOT_DB_ID, orgId: MOVED_ORG_ID, deviceId: DEVICE_ID, snapshotId: 'snap-current', storageIdentity: STORAGE_IDENTITY,
    }]));
    const deps = {
      fetchManifestBytes: vi.fn().mockResolvedValue(
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

  it('reclaims a stale hydrating row (>30min) — the CAS predicate itself expresses staleness', async () => {
    const now = new Date('2026-09-20T12:00:00Z');
    const hydratedAt = new Date(now.getTime() - 31 * 60 * 1000);
    selectMock.mockReturnValueOnce(chainMock([snapshotRow({ fileIndexStatus: 'hydrating', fileIndexHydratedAt: hydratedAt })]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    selectMock.mockReturnValueOnce(chainMock([{ id: 'origin-db-id', orgId: ORG_ID, deviceId: DEVICE_ID, storageIdentity: STORAGE_IDENTITY, metadata: {} }]));
    const deps = {
      now: () => now,
      fetchManifestBytes: vi.fn().mockResolvedValue(
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
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: { now: () => now, fetchManifestBytes: vi.fn() } });
    expect(outcome).toEqual({ status: 'skipped', reason: 'in_progress' });
  });

  it('classifies an unclassified throw after the CAS as provider_error, fails closed, and rethrows to the caller', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow()]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
    selectMock.mockReturnValueOnce(chainMock([{ id: 'origin-db-id', orgId: ORG_ID, deviceId: DEVICE_ID, storageIdentity: STORAGE_IDENTITY, metadata: {} }]));
    // insert during the file-row batch write throws an unclassified error
    insertMock.mockImplementationOnce(() => {
      throw new Error('boom: insert failed');
    });
    const deps = {
      fetchManifestBytes: vi.fn().mockResolvedValue(
        manifestBytes([{ sourcePath: '/a', backupPath: 'snapshots/snap-older/files/a.gz', size: 10 }]),
      ),
    };

    await expect(hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps })).rejects.toThrow(/boom: insert failed/);

    const lastUpdateChain = updateMock.mock.results.at(-1)!.value as { set: ReturnType<typeof vi.fn> };
    expect(lastUpdateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ fileIndexStatus: 'failed', fileIndexError: expect.stringMatching(/^provider_error: /) }),
    );
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
