// #11026 W02 T2: hydration over a stream. The manifest is spooled while hashing,
// validated in one pass, then written in a second, inside the fenced transaction.
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

/** The file rows a batch statement carries: its one JSON parameter. */
function batchRows(statement: unknown): Array<Record<string, unknown>> {
  const chunks = (statement as { queryChunks: unknown[] }).queryChunks;
  const json = chunks.find((c): c is string => typeof c === 'string' && c.startsWith('['));
  return json ? JSON.parse(json) : [];
}

const { selectMock, insertMock, executeMock, updateMock, deleteMock, transactionMock, resolveSnapshotProviderConfigMock, committed } = vi.hoisted(() => ({
  selectMock: vi.fn<(...args: unknown[]) => any>(),
  insertMock: vi.fn<(...args: unknown[]) => any>(),
  executeMock: vi.fn<(...args: unknown[]) => any>(),
  updateMock: vi.fn<(...args: unknown[]) => any>(),
  deleteMock: vi.fn<(...args: unknown[]) => any>(),
  transactionMock: vi.fn<(cb: (tx: unknown) => unknown) => unknown>(),
  resolveSnapshotProviderConfigMock: vi.fn<(...args: unknown[]) => any>(),
  // Rows written by a transaction that committed. A throw rolls back.
  committed: { rows: [] as Array<Record<string, unknown>>, deletes: 0, statuses: [] as string[] },
}));

function claimedAt(): unknown {
  for (const result of [...updateMock.mock.results].reverse()) {
    const set = (result.value as { set?: ReturnType<typeof vi.fn> })?.set;
    const claim = set?.mock.calls.map((c) => c[0]).find((v) => v?.fileIndexStatus === 'hydrating');
    if (claim) return claim.fileIndexHydratedAt;
  }
  return null;
}

function routeSelect(...args: unknown[]) {
  const fields = args[0];
  if (fields && typeof fields === 'object' && 'fileIndexHydratedAt' in fields && !('snapshotId' in fields)) {
    return chainMock([{
      fileIndexStatus: 'hydrating', fileIndexHydratedAt: claimedAt(), orgId: ORG_ID, deviceId: DEVICE_ID,
      metadata: {}, integrityStatus: null,
    }]);
  }
  return selectMock(...(args as []));
}

vi.mock('../db', () => {
  const tx = {
    select: (...args: unknown[]) => routeSelect(...args),
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

import { hydrateSnapshotFileIndex, type HydrationDeps } from './backupSnapshotFileIndex';
import { BackupObjectTooLargeError } from './backupSnapshotStorage';

type Entry = { sourcePath: string; backupPath: string; size?: number; modTime?: string; kind?: string; originalPath?: string };

const ownKey = (i: number) => `snapshots/snap-current/files/${i}`;
const entries = (count: number): Entry[] =>
  Array.from({ length: count }, (_, i) => ({ sourcePath: `/data/file-${i}.txt`, backupPath: ownKey(i), size: i, modTime: '2026-11-01T10:11:12.123456789Z' }));
const manifest = (files: unknown[], extra: Record<string, unknown> = {}) =>
  Buffer.from(JSON.stringify({ id: 'snap-current', files, ...extra }), 'utf8');

function snapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SNAPSHOT_DB_ID, orgId: ORG_ID, deviceId: DEVICE_ID, snapshotId: 'snap-current',
    jobId: 'job-1', configId: 'config-1', storageIdentity: STORAGE_IDENTITY,
    keyLayout: 'legacy_flat', keyPrefix: null, fileIndexStatus: 'none', fileIndexHydratedAt: null,
    ...overrides,
  };
}

function loadSnapshot(overrides: Record<string, unknown> = {}) {
  selectMock.mockReturnValueOnce(chainMock([snapshotRow(overrides)]));
  selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));
}

const stream = (bytes: Uint8Array, chunkSize = 64 * 1024) => {
  const chunks: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) chunks.push(Buffer.from(bytes.subarray(i, i + chunkSize)));
  return Readable.from(chunks);
};

let spoolRoot: string;
const deps = (open: HydrationDeps['openManifest'], extra: Partial<HydrationDeps> = {}): HydrationDeps => ({
  openManifest: open,
  spoolBaseDir: spoolRoot,
  ...extra,
});
const spoolDirs = () => readdir(spoolRoot);

beforeEach(async () => {
  vi.clearAllMocks();
  spoolRoot = await mkdtemp(join(tmpdir(), 'breeze-spool-test-'));
  committed.rows = [];
  committed.deletes = 0;
  committed.statuses = [];
  selectMock.mockImplementation(() => chainMock([]));
  updateMock.mockImplementation(() => chainMock([{ id: SNAPSHOT_DB_ID }]));
  deleteMock.mockImplementation(() => chainMock([]));
  insertMock.mockImplementation(() => chainMock([]));
  // As postgres-js answers: an array-like result carrying the row count.
  executeMock.mockImplementation(async (statement: unknown) => Object.assign([], { count: batchRows(statement).length }));
  // A transaction applies its writes only if its callback returns: a throw
  // rolls everything back, so `committed` only ever holds published state.
  transactionMock.mockImplementation(async (cb: any) => {
    const rows: Array<Record<string, unknown>> = [];
    const statuses: string[] = [];
    let deletes = 0;
    const tx = {
      select: routeSelect,
      insert: (...args: unknown[]) => insertMock(...(args as [])),
      execute: async (statement: unknown) => {
        const result = await executeMock(statement);
        rows.push(...batchRows(statement));
        return result;
      },
      update: (...args: unknown[]) => {
        const chain = updateMock(...(args as []));
        const set = chain.set;
        chain.set = vi.fn((value: Record<string, unknown>) => {
          if (typeof value?.fileIndexStatus === 'string') statuses.push(value.fileIndexStatus);
          return set(value);
        });
        return chain;
      },
      delete: (...args: unknown[]) => {
        deletes += 1;
        return deleteMock(...(args as []));
      },
    };
    const result = await cb(tx);
    committed.rows.push(...rows);
    committed.deletes += deletes;
    committed.statuses.push(...statuses);
    return result;
  });
  resolveSnapshotProviderConfigMock.mockResolvedValue({
    snapshot: snapshotRow(),
    config: null,
    providerType: 'local',
    providerConfig: { path: '/srv/backups' },
  });
});

afterEach(async () => {
  await rm(spoolRoot, { recursive: true, force: true });
});

describe('hydrateSnapshotFileIndex over a stream', () => {
  it('a 5,000-entry manifest publishes the same rows and digest, in 250-row batches', async () => {
    loadSnapshot();
    const bytes = manifest(entries(5000));
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: deps(async () => stream(bytes)) });

    expect(outcome).toMatchObject({
      status: 'complete',
      entryCount: 5000,
      externalCount: 0,
      manifestSha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(committed.rows).toHaveLength(5000);
    expect(committed.rows[4999]).toEqual({
      source_path: '/data/file-4999.txt',
      backup_path: ownKey(4999),
      size: 4999,
      modified_at: '2026-11-01T10:11:12.123Z',
      kind: null,
    });
    const batches = executeMock.mock.calls.map((c) => batchRows(c[0]).length);
    expect(batches).toEqual(Array.from({ length: 20 }, () => 250));
    expect(committed.statuses).toContain('complete');
  });

  it('writes each batch as one parameter, not a parameter per value', async () => {
    // A 5,000-parameter statement cost more in query building than everything
    // else in the run put together, measured at 1.1M entries.
    loadSnapshot();
    await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: deps(async () => stream(manifest(entries(2500)))) });
    expect(insertMock).not.toHaveBeenCalled();
    for (const [statement] of executeMock.mock.calls) {
      const values = (statement as { queryChunks: unknown[] }).queryChunks.filter((c) => typeof c === 'string');
      expect(values).toHaveLength(2); // the snapshot id and the JSON
      expect(values[0]).toBe(SNAPSHOT_DB_ID);
    }
  });

  it('reads the manifest through openManifest with the key under the snapshot root', async () => {
    loadSnapshot();
    const open = vi.fn(async () => stream(manifest([])));
    await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: deps(open) });
    expect(open).toHaveBeenCalledWith({
      provider: 'local',
      providerConfig: { path: '/srv/backups' },
      key: 'snapshots/snap-current/manifest.json',
    });
  });

  it('a digest mismatch writes nothing and leaves the old rows', async () => {
    const bytes = manifest(entries(10));
    loadSnapshot({ attestation: { status: 'verified', manifestSha256: 'a'.repeat(64) } });
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: deps(async () => stream(bytes)) });

    expect(outcome).toMatchObject({ status: 'failed', failure: 'manifest_differs_from_attestation', retryable: false });
    expect(transactionMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('a bad entry at index 4,999 writes nothing, leaves the old rows, and names the entry', async () => {
    loadSnapshot();
    const files: unknown[] = entries(5000);
    files[4999] = { sourcePath: '/data/the-bad-one.txt', backupPath: '' };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: deps(async () => stream(manifest(files))) });

    expect(outcome).toMatchObject({ status: 'failed', failure: 'manifest_invalid', retryable: false });
    const reason = (outcome as { reason: string }).reason;
    expect(reason).toContain('files.4999.backupPath');
    expect(reason).toContain('"/data/the-bad-one.txt"');
    expect(transactionMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('counts every bad entry without keeping them, and reports them as one message', async () => {
    loadSnapshot();
    const files = Array.from({ length: 3000 }, (_, i) => ({ sourcePath: `/bad${i}`, backupPath: '' }));
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: deps(async () => stream(manifest(files))) });
    const reason = (outcome as { reason: string }).reason;
    expect(reason).toContain('"/bad0"');
    expect(reason).toContain('2999 more issue(s)');
    expect(reason.length).toBeLessThan(500);
  });

  it('an unparseable modTime is reported as a bad entry before anything is written', async () => {
    loadSnapshot();
    const files = [{ sourcePath: '/a', backupPath: ownKey(0), modTime: 'not a date' }];
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: deps(async () => stream(manifest(files))) });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'manifest_invalid' });
    expect((outcome as { reason: string }).reason).toContain('files.0.modTime');
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('a manifest of another snapshot is invalid, wherever the id sits in the document', async () => {
    loadSnapshot();
    const bytes = Buffer.from(JSON.stringify({ files: entries(3), id: 'snap-other' }));
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: deps(async () => stream(bytes)) });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'manifest_invalid' });
    expect((outcome as { reason: string }).reason).toContain('snap-other');
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('a manifest with no id is invalid', async () => {
    loadSnapshot();
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: deps(async () => stream(Buffer.from('{"files":[]}'))) });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'manifest_invalid' });
  });

  it.each([
    ['truncated', '{"id":"snap-current","files":[{"sourcePath":"/a"'],
    ['files of the wrong shape', '{"id":"snap-current","files":{}}'],
  ])('a %s manifest is manifest_invalid', async (_name, text) => {
    loadSnapshot();
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: deps(async () => stream(Buffer.from(text))) });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'manifest_invalid', retryable: false });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('an entry over the scanner limit is manifest_too_large, not invalid', async () => {
    loadSnapshot();
    const huge = 'x'.repeat(1024 * 1024 + 1);
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, {
      deps: deps(async () => stream(manifest([{ sourcePath: huge, backupPath: ownKey(0) }]))),
    });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'manifest_too_large', retryable: false });
  });

  it('refuses a manifest naming an unreasonable number of older snapshots before touching the database', async () => {
    loadSnapshot();
    const files = Array.from({ length: 10_001 }, (_, i) => ({
      sourcePath: `/f${i}`,
      backupPath: `snapshots/snapshot-${i}/files/x`,
    }));
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: deps(async () => stream(manifest(files))) });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'manifest_invalid' });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('over the cap, declared up front, is manifest_too_large and not retryable', async () => {
    loadSnapshot();
    const tooLarge = new BackupObjectTooLargeError('snapshots/snap-current/manifest.json', 3e9, 2e9);
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: deps(async () => { throw tooLarge; }) });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'manifest_too_large', retryable: false });
    expect(await spoolDirs()).toEqual([]);
  });

  it('over the cap, found mid-stream, is manifest_too_large and leaves no spool', async () => {
    loadSnapshot();
    const tooLarge = new BackupObjectTooLargeError('snapshots/snap-current/manifest.json', 3e9, 2e9);
    async function* source() {
      yield Buffer.alloc(1024);
      throw tooLarge;
    }
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: deps(async () => Readable.from(source())) });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'manifest_too_large', retryable: false });
    expect(await spoolDirs()).toEqual([]);
  });

  it('the spool enforces the cap itself, whatever source it is given', async () => {
    loadSnapshot();
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, {
      deps: deps(async () => stream(Buffer.alloc(100)), { spoolMaxBytes: 50 }),
    });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'manifest_too_large', retryable: false });
    expect(await spoolDirs()).toEqual([]);
  });

  it('a spool write failure (ENOSPC) is provider_error, retryable, with old rows intact and no spool left', async () => {
    loadSnapshot();
    const noSpace = () =>
      new Writable({
        write(_chunk, _encoding, callback) {
          callback(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }));
        },
      });
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, {
      deps: deps(async () => stream(manifest(entries(10))), { openSpoolWriter: noSpace }),
    });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'provider_error', retryable: true });
    expect((outcome as { reason: string }).reason).toContain('ENOSPC');
    expect(transactionMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(await spoolDirs()).toEqual([]);
  });

  it('a download that breaks mid-way is provider_error, retryable, with no spool left', async () => {
    loadSnapshot();
    async function* source() {
      yield Buffer.alloc(1024);
      throw new Error('connection reset');
    }
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: deps(async () => Readable.from(source())) });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'provider_error', retryable: true });
    expect(await spoolDirs()).toEqual([]);
  });

  it('a missing object is manifest_missing, retryable, with no spool left', async () => {
    loadSnapshot();
    const notFound = Object.assign(new Error('nope'), { code: 'ENOENT' });
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: deps(async () => { throw notFound; }) });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'manifest_missing', retryable: true });
    expect(await spoolDirs()).toEqual([]);
  });

  it('removes the spool after a successful publish', async () => {
    loadSnapshot();
    await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: deps(async () => stream(manifest(entries(3)))) });
    expect(await spoolDirs()).toEqual([]);
  });

  it('spools under a private directory while the run is using it', async () => {
    loadSnapshot();
    const seen: string[] = [];
    transactionMock.mockImplementationOnce(async () => {
      seen.push(...(await spoolDirs()));
      return { status: 'skipped', reason: 'superseded' };
    });
    await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: deps(async () => stream(manifest(entries(3)))) });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^breeze-manifest-/);
    expect(await spoolDirs()).toEqual([]);
  });

  it('removes the spool when publishing throws, records provider_error, and rethrows for the worker', async () => {
    loadSnapshot();
    transactionMock.mockImplementationOnce(async () => {
      throw new Error('deadlock detected');
    });
    await expect(
      hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: deps(async () => stream(manifest(entries(3)))) }),
    ).rejects.toThrow('deadlock detected');
    expect(await spoolDirs()).toEqual([]);
  });

  it('a count the database reports differently from the manifest rolls the whole write back', async () => {
    loadSnapshot();
    executeMock.mockImplementation(async () => Object.assign([], { count: 1 }));
    await expect(
      hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: deps(async () => stream(manifest(entries(3)))) }),
    ).rejects.toThrow(/expected to write 3 .* wrote 1/);
    expect(committed.rows).toHaveLength(0);
    expect(committed.statuses).not.toContain('complete');
    expect(await spoolDirs()).toEqual([]);
  });

  it('writes directory and symlink entries as rows with their kind, and counts them (#11235)', async () => {
    loadSnapshot();
    const files = [
      { sourcePath: '/d', backupPath: '', kind: 'dir' },
      { sourcePath: '/l', backupPath: '', kind: 'symlink', linkTarget: '/f' },
      { sourcePath: '/f', backupPath: ownKey(1) },
    ];
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: deps(async () => stream(manifest(files))) });
    expect(outcome).toMatchObject({ status: 'complete', entryCount: 3, externalCount: 0 });
    expect(committed.rows.map((r) => [r.source_path, r.backup_path, r.kind])).toEqual([
      ['/d', '', 'dir'],
      ['/l', '', 'symlink'],
      ['/f', ownKey(1), null],
    ]);
  });

  it('a manifest of nothing but directory and symlink entries publishes them all, with no origins (#11235)', async () => {
    loadSnapshot();
    const files = [
      { sourcePath: '/srv', backupPath: '', kind: 'dir' },
      { sourcePath: '/srv/empty', backupPath: '', kind: 'dir' },
      { sourcePath: '/srv/current', backupPath: '', kind: 'symlink', linkTarget: 'releases/1' },
    ];
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: deps(async () => stream(manifest(files))) });
    expect(outcome).toMatchObject({ status: 'complete', entryCount: 3, externalCount: 0, originSnapshotIds: [] });
    expect(committed.rows.map((r) => [r.source_path, r.kind])).toEqual([
      ['/srv', 'dir'],
      ['/srv/empty', 'dir'],
      ['/srv/current', 'symlink'],
    ]);
    expect(committed.statuses).toContain('complete');
  });

  it('indexes the original path of a VSS entry', async () => {
    loadSnapshot();
    const files = [{ sourcePath: '\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1\\x', originalPath: 'C:\\x', backupPath: ownKey(1) }];
    await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps: deps(async () => stream(manifest(files))) });
    expect(committed.rows.map((r) => r.source_path)).toEqual(['C:\\x']);
  });

  it('a null files key is an empty snapshot, as the agent writes a nil slice', async () => {
    loadSnapshot();
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, {
      deps: deps(async () => stream(Buffer.from('{"id":"snap-current","files":null}'))),
    });
    expect(outcome).toMatchObject({ status: 'complete', entryCount: 0 });
  });

  it('a manifest with no files key is invalid, not an empty snapshot', async () => {
    loadSnapshot();
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, {
      deps: deps(async () => stream(Buffer.from('{"id":"snap-current"}'))),
    });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'manifest_invalid', retryable: false });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('holds no DB context while the manifest downloads and validates', async () => {
    loadSnapshot();
    const order: string[] = [];
    transactionMock.mockImplementationOnce(async () => {
      order.push('transaction');
      return { status: 'skipped', reason: 'superseded' };
    });
    await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, {
      deps: deps(async () => {
        order.push('download');
        return stream(manifest(entries(1)));
      }),
    });
    expect(order).toEqual(['download', 'transaction']);
  });
});

describe('spoolManifest', () => {
  it('releases the source when the spool directory cannot be created', async () => {
    const { spoolManifest } = await import('./backupManifestSpool');
    const source = Readable.from([Buffer.from('{}')]);
    await expect(spoolManifest(source, { baseDir: join(spoolRoot, 'does-not-exist'), maxBytes: 1024 })).rejects.toMatchObject({ code: 'ENOENT' });
    expect(source.destroyed).toBe(true);
  });
});

describe('cleanStaleManifestSpools', () => {
  it('removes spools older than a day and leaves everything else', async () => {
    const { cleanStaleManifestSpools } = await import('./backupManifestSpool');
    const { mkdir, utimes } = await import('node:fs/promises');
    const stale = join(spoolRoot, 'breeze-manifest-old');
    const fresh = join(spoolRoot, 'breeze-manifest-new');
    const other = join(spoolRoot, 'something-else');
    for (const dir of [stale, fresh, other]) await mkdir(dir);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(stale, old, old);
    await utimes(other, old, old);

    await cleanStaleManifestSpools([spoolRoot]);

    expect((await readdir(spoolRoot)).sort()).toEqual(['breeze-manifest-new', 'something-else']);
  });

  it('does not throw when a directory cannot be read', async () => {
    const { cleanStaleManifestSpools } = await import('./backupManifestSpool');
    await expect(cleanStaleManifestSpools([join(spoolRoot, 'does-not-exist')])).resolves.toBeUndefined();
  });

  it('says so when a spool directory exists but cannot be read, and is quiet when it was never created', async () => {
    const { cleanStaleManifestSpools } = await import('./backupManifestSpool');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await cleanStaleManifestSpools([join(spoolRoot, 'does-not-exist')]);
      expect(warn).not.toHaveBeenCalled();

      const notADirectory = join(spoolRoot, 'a-file');
      await writeFile(notADirectory, 'x');
      await expect(cleanStaleManifestSpools([notADirectory])).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain(notADirectory);
    } finally {
      warn.mockRestore();
    }
  });
});
