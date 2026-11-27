/**
 * #11736 step 2: the delta publisher, the inline-row reset and checkpoint GC,
 * against real Postgres, with BACKUP_INDEX_DELTA_PUBLISH=on.
 *
 * The hydrator is driven for real (storage is a manifest served from memory).
 * Each snapshot's tree is checked as stored: the checkpoint entries it does
 * not tombstone plus its own rows, compared as a multiset with the manifest.
 * The round trip (plan Task 6) then checks it through every reader: browse,
 * search, selection, the key budget (countIndexedFiles), brokered key grants
 * (filterIndexedKeys) and recovery-download membership
 * (authorizeExternalReference). Each must return the manifest, and the same
 * as for a control snapshot holding the manifest in 'rows' format.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/backupSnapshotIndexPublish.integration.test.ts
 */
import './setup';
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  decodeBrowseCursor,
  decodeSearchCursor,
  listSnapshotDirectory,
  readableSnapshotSourcePaths,
  resolveSelectedSnapshotPathsInDb,
  searchSnapshotFiles,
} from '../../services/backupSnapshotBrowse';
import { hydrateSnapshotFileIndex } from '../../services/backupSnapshotFileIndex';
import { drizzleBrokeredReadStore } from '../../services/backupStorageSessionStore';
import { authorizeExternalReference } from '../../services/recoveryDownloadService';
import { applyBackupCommandResultToJob } from '../../services/backupResultPersistence';
import {
  createIncomingIndexTable,
  lineageKeyOf,
  lineageLockKey,
  loadIncomingBatch,
  publishDeltaIndex,
} from '../../services/backupSnapshotIndexPublish';
import { CHECKPOINT_ORPHAN_TTL_MS, collectUnreferencedCheckpoints } from '../../services/backupTreeCheckpointGc';
import { isPgForeignKeyViolation } from '../../utils/pgErrors';
import {
  insertSnapshotRow,
  orgContext,
  seedWriteDevice,
  seedWriteTenant,
  WRITE_IDENTITY,
  type WriteTenant,
} from './backupWriteFixtures';
import { seedRowsIndex } from './helpers/backupIndexFixtures';
import { getTestDb } from './setup';

vi.mock('../../jobs/backupSnapshotFileIndexWorker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../jobs/backupSnapshotFileIndexWorker')>()),
  enqueueSnapshotFileIndexHydration: vi.fn(async () => 'queued'),
}));
vi.mock('../../jobs/backupSnapshotAttestationWorker', () => ({
  enqueueSnapshotAttestationVerification: vi.fn(async () => 'job'),
}));
// A seam for one test: the hydrator's publisher, told the manifest has more
// entries than it has, so its invariant (D9) fails inside a real hydration.
const publishSeam = vi.hoisted(() => ({ overstateBy: 0 }));
vi.mock('../../services/backupSnapshotIndexPublish', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../services/backupSnapshotIndexPublish')>();
  return {
    ...real,
    publishDeltaIndex: (tx: Parameters<typeof real.publishDeltaIndex>[0], a: Parameters<typeof real.publishDeltaIndex>[1]) =>
      real.publishDeltaIndex(tx, { ...a, eligibleEntries: a.eligibleEntries + publishSeam.overstateBy }),
  };
});

const runDb = it.runIf(!!process.env.DATABASE_URL);

const prevFlag = process.env.BACKUP_INDEX_DELTA_PUBLISH;
beforeAll(() => { process.env.BACKUP_INDEX_DELTA_PUBLISH = 'on'; });
beforeEach(() => {
  process.env.BACKUP_INDEX_DELTA_PUBLISH = 'on';
  publishSeam.overstateBy = 0;
});
afterAll(() => {
  if (prevFlag === undefined) delete process.env.BACKUP_INDEX_DELTA_PUBLISH;
  else process.env.BACKUP_INDEX_DELTA_PUBLISH = prevFlag;
});

type Entry = { sourcePath: string; backupPath: string; size?: number; kind?: 'dir' | 'symlink'; modTime?: string };

function newId(): string {
  return `snapshot-20261126T120000Z-${randomBytes(12).toString('hex')}`;
}

function manifestOf(snapshotId: string, entries: Entry[]): Buffer {
  return Buffer.from(JSON.stringify({ id: snapshotId, files: entries }));
}

/** `count` content entries whose objects live under `ownerId`. */
function filesOf(ownerId: string, count: number, from = 0): Entry[] {
  return Array.from({ length: count }, (_, k) => {
    const i = from + k;
    return { sourcePath: `C:/data/dir-${i % 7}/file-${String(i).padStart(5, '0')}.dat`, backupPath: `snapshots/${ownerId}/files/${i}`, size: i };
  });
}

const hydrate = (snapshotDbId: string, bytes: Buffer) =>
  runOutsideDbContext(() => hydrateSnapshotFileIndex(snapshotDbId, {
    includeUnreferenced: true,
    force: true,
    deps: { openManifest: async () => Readable.from([bytes]) },
  }));

type Snap = { dbId: string; snapshotId: string };

async function snapshotOf(t: WriteTenant, deviceId = t.deviceId): Promise<Snap> {
  const snapshotId = newId();
  const dbId = await insertSnapshotRow({ ...t, deviceId }, snapshotId);
  return { dbId, snapshotId };
}

const tupleOf = (r: { source_path: string; backup_path: string; size: unknown; kind: unknown; modified: string | null }) =>
  JSON.stringify([r.source_path, r.backup_path, r.size === null ? null : Number(r.size), r.kind ?? null, r.modified ?? null]);

/** The manifest's modTime as the column stores it: UTC, without a zone, to the second here. */
const storedModTime = (modTime: string | undefined) =>
  modTime ? new Date(modTime).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') : null;

const expectedTree = (entries: Entry[]) =>
  entries.map((e) => JSON.stringify([e.sourcePath, e.backupPath, e.size ?? null, e.kind ?? null, storedModTime(e.modTime)])).sort();

/**
 * The snapshot's tree as stored, read on the admin connection: for 'rows',
 * its rows; for 'delta', the checkpoint's entries it does not tombstone plus
 * its own entries. A sorted multiset.
 */
async function storedTree(snapshotDbId: string): Promise<string[]> {
  const rows = (await getTestDb().execute(sql`
    SELECT f.source_path, f.backup_path, f.size, f.kind, to_char(f.modified_at, 'YYYY-MM-DD HH24:MI:SS') AS modified
      FROM backup_snapshot_files f
     WHERE f.snapshot_db_id = ${snapshotDbId}::uuid AND f.checkpoint_entry_no IS NULL
    UNION ALL
    SELECT e.source_path, e.backup_path, e.size, e.kind, to_char(e.modified_at, 'YYYY-MM-DD HH24:MI:SS') AS modified
      FROM backup_snapshots s
      JOIN backup_tree_checkpoint_entries e ON e.checkpoint_id = s.file_index_checkpoint_id
     WHERE s.id = ${snapshotDbId}::uuid AND s.file_index_format = 'delta'
       AND NOT EXISTS (
         SELECT 1 FROM backup_snapshot_files t
          WHERE t.snapshot_db_id = s.id AND t.checkpoint_entry_no = e.entry_no
       )
  `)) as unknown as Array<{ source_path: string; backup_path: string; size: unknown; kind: unknown; modified: string | null }>;
  return rows.map(tupleOf).sort();
}

async function indexState(snapshotDbId: string) {
  const [row] = (await getTestDb().execute(sql`
    SELECT s.file_index_format AS format, s.file_index_checkpoint_id AS checkpoint_id, s.file_index_status AS status,
           (SELECT count(*)::int FROM backup_snapshot_files f WHERE f.snapshot_db_id = s.id AND f.checkpoint_entry_no IS NULL) AS adds,
           (SELECT count(*)::int FROM backup_snapshot_files f WHERE f.snapshot_db_id = s.id AND f.checkpoint_entry_no IS NOT NULL) AS tombstones
      FROM backup_snapshots s WHERE s.id = ${snapshotDbId}::uuid
  `)) as unknown as Array<{ format: string; checkpoint_id: string | null; status: string; adds: number; tombstones: number }>;
  return row!;
}

async function checkpointsOfDevice(deviceId: string) {
  return (await getTestDb().execute(sql`
    SELECT id, entry_count, org_id, device_id, last_referenced_at
      FROM backup_tree_checkpoints WHERE device_id = ${deviceId}::uuid ORDER BY created_at, id
  `)) as unknown as Array<{ id: string; entry_count: number; org_id: string; device_id: string; last_referenced_at: Date }>;
}

async function checkpointExists(id: string): Promise<boolean> {
  const rows = (await getTestDb().execute(sql`SELECT 1 FROM backup_tree_checkpoints WHERE id = ${id}::uuid`)) as unknown as unknown[];
  return rows.length === 1;
}

async function expectRefusedAsForeignKey(fn: () => Promise<unknown>) {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected the statement to be refused').toBeDefined();
  expect(isPgForeignKeyViolation(caught)).toBe(true);
}

/** Waits until another backend is blocked on a lock running a statement that matches `pattern`. */
async function waitForLockWaiters(pattern: string, n: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const rows = (await getTestDb().execute(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type IN ('Lock', 'advisory') AND pid <> pg_backend_pid() AND query ILIKE ${pattern}
    `)) as unknown as Array<{ n: number }>;
    if ((rows[0]?.n ?? 0) >= n) return;
    if (Date.now() > deadline) throw new Error(`fewer than ${n} backends blocked on ${pattern}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Tombstones that break D1: a path other than their checkpoint entry's (the
 * read layer would then hide nothing), an entry that does not exist, or an
 * object key or column values of their own. Read on the admin connection.
 */
async function malformedTombstones(snapshotDbId: string): Promise<number> {
  const rows = (await getTestDb().execute(sql`
    SELECT count(*)::int AS n
      FROM backup_snapshot_files f
      JOIN backup_snapshots s ON s.id = f.snapshot_db_id
      LEFT JOIN backup_tree_checkpoint_entries e
        ON e.checkpoint_id = s.file_index_checkpoint_id AND e.entry_no = f.checkpoint_entry_no
     WHERE f.snapshot_db_id = ${snapshotDbId}::uuid AND f.checkpoint_entry_no IS NOT NULL
       AND (e.source_path IS DISTINCT FROM f.source_path OR f.backup_path <> ''
            OR f.size IS NOT NULL OR f.modified_at IS NOT NULL OR f.kind IS NOT NULL)
  `)) as unknown as Array<{ n: number }>;
  return rows[0]!.n;
}

const NOT_MEMBER = 'key is not a member of the snapshot file index';
/** Refusals authorizeExternalReference gives only after a key passed the membership read. */
const PAST_MEMBERSHIP = new Set([
  'no verified origin record for this snapshot reference',
  'origin identity does not match the recovery token',
]);
/** The snapshot an object key of these manifests belongs to (`snapshots/<id>/files/…`). */
const ownerOf = (key: string) => key.split('/')[1]!;

/** Every reader's answer for one snapshot, in the org's request context. */
async function readersOf(t: WriteTenant, snapshotDbId: string, candidateKeys: string[], selectPaths: string[]) {
  const [state] = (await getTestDb().execute(sql`
    SELECT file_index_manifest_sha256 AS digest FROM backup_snapshots WHERE id = ${snapshotDbId}::uuid
  `)) as unknown as Array<{ digest: string | null }>;
  return withDbAccessContext(orgContext(t.orgId), async () => {
    const browse: string[] = [];
    const walk = async (segments: string[]): Promise<void> => {
      let cursor: { rank: 0 | 1; name: string } | null = null;
      for (let pages = 0; pages < 50; pages++) {
        const page = await listSnapshotDirectory({ snapshotDbId, segments, limit: 100, cursor });
        for (const e of page.entries) {
          if (e.type === 'directory') {
            browse.push(`${e.path}/ (${e.fileCount})`);
            await walk([...segments, e.name]);
          } else {
            browse.push(`${e.path} ${e.sizeBytes ?? '-'} ${e.modifiedAt ?? '-'}`);
          }
        }
        if (!page.nextCursor) return;
        cursor = decodeBrowseCursor(page.nextCursor);
      }
      throw new Error(`browse of /${segments.join('/')} did not end`);
    };
    await walk([]);

    // Search compares paths with forward slashes, so '/' matches every entry.
    const search: string[] = [];
    let after: string | null = null;
    for (let pages = 0; ; pages++) {
      if (pages > 50) throw new Error('search did not end');
      const page = await searchSnapshotFiles({ snapshotDbId, query: '/', limit: 100, after });
      search.push(...page.entries.map((e) => `${e.path} ${e.type} ${e.sizeBytes ?? '-'} ${e.modifiedAt ?? '-'}`));
      if (!page.nextCursor) break;
      after = decodeSearchCursor(page.nextCursor);
    }

    const membership: Record<string, string> = {};
    for (const key of candidateKeys) {
      const r = await authorizeExternalReference(db, {
        tokenId: 'token-11736-round-trip', snapshotDbId, key, originSnapshotId: ownerOf(key),
        orgId: t.orgId, deviceId: t.deviceId, pinnedStorageIdentity: WRITE_IDENTITY,
      });
      membership[key] = r.ok || PAST_MEMBERSHIP.has(r.reason) ? 'member' : r.reason;
    }

    return {
      browse,
      search,
      sourcePaths: await readableSnapshotSourcePaths(snapshotDbId),
      selection: await resolveSelectedSnapshotPathsInDb(snapshotDbId, selectPaths),
      count: await drizzleBrokeredReadStore.countIndexedFiles(snapshotDbId),
      keys: [...await drizzleBrokeredReadStore.filterIndexedKeys(snapshotDbId, candidateKeys, state?.digest ?? '')].sort(),
      membership,
    };
  });
}

/**
 * Plan Task 6: every reader returns exactly `entries` for the snapshot.
 *
 *  - Against a control: a snapshot of the same device holding `entries` in
 *    'rows' format with the same index state (status, digest, integrity),
 *    read by the same readers. That covers each reader's own shaping
 *    (directory counts, ordering, pages, path normalization).
 *  - Against the manifest itself, for a complete index: the key budget, the
 *    grants, recovery-download membership and the readable source paths.
 *  - Every tombstone keeps D1 (malformedTombstones).
 *
 * `gone` is what other snapshots of the test hold and this one must not:
 * those keys must not authorize and those paths must not resolve.
 */
async function expectReadersReturnManifest(
  t: WriteTenant,
  snap: Snap,
  entries: Entry[],
  gone: { keys: string[]; paths: string[] } = { keys: [], paths: [] },
): Promise<void> {
  expect(await malformedTombstones(snap.dbId), 'malformed tombstones').toBe(0);

  const ownKeys = [...new Set(entries.map((e) => e.backupPath).filter(Boolean))].sort();
  const candidateKeys = [...new Set([...ownKeys, ...gone.keys, `snapshots/${snap.snapshotId}/files/never-indexed`])].sort();
  const selectPaths = [...new Set([...entries.map((e) => e.sourcePath), ...gone.paths])];

  const control = await snapshotOf(t);
  await seedRowsIndex(control.dbId, entries.map((e) => ({
    sourcePath: e.sourcePath, backupPath: e.backupPath, size: e.size ?? null, modifiedAt: e.modTime ?? null, kind: e.kind ?? null,
  })), '0'.repeat(64));
  await getTestDb().execute(sql`
    UPDATE backup_snapshots c
       SET file_index_status = s.file_index_status, file_index_manifest_sha256 = s.file_index_manifest_sha256,
           integrity_status = s.integrity_status
      FROM backup_snapshots s
     WHERE c.id = ${control.dbId}::uuid AND s.id = ${snap.dbId}::uuid
  `);

  const published = await readersOf(t, snap.dbId, candidateKeys, selectPaths);
  expect(published).toEqual(await readersOf(t, control.dbId, candidateKeys, selectPaths));

  if ((await indexState(snap.dbId)).status !== 'complete') return;
  const ownKeySet = new Set(ownKeys);
  expect(published.count).toBe(entries.filter((e) => e.backupPath !== '').length);
  expect(published.keys).toEqual(ownKeys);
  expect(published.membership).toEqual(
    Object.fromEntries(candidateKeys.map((k) => [k, ownKeySet.has(k) ? 'member' : NOT_MEMBER])),
  );
  expect([...published.sourcePaths].sort()).toEqual(entries.map((e) => e.sourcePath).sort());
  expect(published.selection.ok, 'every path resolves only when nothing gone was asked for').toBe(gone.paths.length === 0);
}

describe('delta publish (#11736 step 2)', () => {
  runDb('a first hydration writes a checkpoint; a later one writes only its differences', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const s0 = await snapshotOf(t);
    const s1 = await snapshotOf(t);
    const base = filesOf(s0.snapshotId, 400);

    const first = await hydrate(s0.dbId, manifestOf(s0.snapshotId, base));
    expect(first).toMatchObject({ status: 'complete', entryCount: 400, rowsWritten: 0, checkpointEntriesWritten: 400 });
    const [h1, ...others] = await checkpointsOfDevice(t.deviceId);
    expect(others).toEqual([]);
    expect(h1).toMatchObject({ entry_count: 400, org_id: t.orgId, device_id: t.deviceId });
    expect(await indexState(s0.dbId)).toMatchObject({ format: 'delta', checkpoint_id: h1!.id, status: 'complete', adds: 0, tombstones: 0 });
    expect(await storedTree(s0.dbId)).toEqual(expectedTree(base));

    // An incremental: unchanged files keep s0's objects; 3 changed, 2 deleted, 4 added.
    const tree1 = [
      ...base.slice(0, 3).map((e, i) => ({ ...e, backupPath: `snapshots/${s1.snapshotId}/files/changed-${i}`, size: 9_000 + i })),
      ...base.slice(5),
      ...filesOf(s1.snapshotId, 4, 1_000),
    ];
    const second = await hydrate(s1.dbId, manifestOf(s1.snapshotId, tree1));

    expect(second).toMatchObject({ status: 'complete', entryCount: 402, rowsWritten: 12, checkpointEntriesWritten: 0 });
    expect(await indexState(s1.dbId)).toMatchObject({ format: 'delta', checkpoint_id: h1!.id, adds: 7, tombstones: 5 });
    expect(await storedTree(s1.dbId)).toEqual(expectedTree(tree1));
    // The first snapshot's tree is untouched by the second's tombstones.
    expect(await storedTree(s0.dbId)).toEqual(expectedTree(base));
    const [h1After] = await checkpointsOfDevice(t.deviceId);
    expect(new Date(h1After!.last_referenced_at).getTime()).toBeGreaterThanOrEqual(new Date(h1!.last_referenced_at).getTime());
  });

  runDb('duplicate paths and identical entries round-trip exactly', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const s0 = await snapshotOf(t);
    const s1 = await snapshotOf(t);
    const dupPath = { sourcePath: 'C:/dup/same-path', backupPath: `snapshots/${s0.snapshotId}/files/dup-a`, size: 1 };
    const identical = { sourcePath: 'C:/dup/identical', backupPath: `snapshots/${s0.snapshotId}/files/ident`, size: 7 };
    const noSize = { sourcePath: 'C:/dup/no-size', backupPath: `snapshots/${s0.snapshotId}/files/no-size` };
    const dir: Entry = { sourcePath: 'C:/dup', backupPath: '', kind: 'dir' };
    const base: Entry[] = [
      ...filesOf(s0.snapshotId, 100),
      dupPath, { ...dupPath, backupPath: `snapshots/${s0.snapshotId}/files/dup-b` },
      identical, identical, identical,
      noSize, { ...noSize, size: 0 },
      dir, dir,
    ];
    await hydrate(s0.dbId, manifestOf(s0.snapshotId, base));
    expect(await storedTree(s0.dbId)).toEqual(expectedTree(base));

    // One copy of the identical triple gone, a second copy of the NULL-size entry, one dir gone.
    const tree1: Entry[] = [
      ...filesOf(s0.snapshotId, 100),
      dupPath, { ...dupPath, backupPath: `snapshots/${s0.snapshotId}/files/dup-b` },
      identical, identical,
      noSize, noSize, { ...noSize, size: 0 },
      dir,
    ];
    await hydrate(s1.dbId, manifestOf(s1.snapshotId, tree1));

    expect(await indexState(s1.dbId)).toMatchObject({ format: 'delta', adds: 1, tombstones: 2 });
    expect(await storedTree(s1.dbId)).toEqual(expectedTree(tree1));
    expect(await storedTree(s0.dbId)).toEqual(expectedTree(base));
  });

  runDb('a delta past 5% writes a new checkpoint and later snapshots diff against it', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const [s0, s1, s2] = [await snapshotOf(t), await snapshotOf(t), await snapshotOf(t)];
    const base = filesOf(s0.snapshotId, 100);
    await hydrate(s0.dbId, manifestOf(s0.snapshotId, base));
    const [h1] = await checkpointsOfDevice(t.deviceId);

    // ceil(5% of 100) = 5; six additions is past it.
    const tree1 = [...base, ...filesOf(s1.snapshotId, 6, 500)];
    expect(await hydrate(s1.dbId, manifestOf(s1.snapshotId, tree1))).toMatchObject({ rowsWritten: 0, checkpointEntriesWritten: 106 });
    const headers = await checkpointsOfDevice(t.deviceId);
    expect(headers.map((h) => h.id)).toEqual([h1!.id, expect.any(String)]);
    const h2 = headers[1]!;
    expect(await indexState(s1.dbId)).toMatchObject({ format: 'delta', checkpoint_id: h2.id, adds: 0, tombstones: 0 });

    const tree2 = [...tree1, ...filesOf(s2.snapshotId, 1, 900)];
    await hydrate(s2.dbId, manifestOf(s2.snapshotId, tree2));
    expect(await indexState(s2.dbId)).toMatchObject({ format: 'delta', checkpoint_id: h2.id, adds: 1, tombstones: 0 });
    for (const [s, tree] of [[s0, base], [s1, tree1], [s2, tree2]] as const) {
      expect(await storedTree(s.dbId)).toEqual(expectedTree(tree));
    }
  });

  runDb('hydration out of order still reproduces each tree', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const [s0, s1, s2] = [await snapshotOf(t), await snapshotOf(t), await snapshotOf(t)];
    const base = filesOf(s0.snapshotId, 200);
    const tree1 = [...base.slice(1), ...filesOf(s1.snapshotId, 2, 700)];
    const tree2 = [...tree1.slice(1), ...filesOf(s2.snapshotId, 2, 800)];

    await hydrate(s0.dbId, manifestOf(s0.snapshotId, base));
    await hydrate(s2.dbId, manifestOf(s2.snapshotId, tree2));
    await hydrate(s1.dbId, manifestOf(s1.snapshotId, tree1));

    expect(await checkpointsOfDevice(t.deviceId)).toHaveLength(1);
    for (const [s, tree] of [[s0, base], [s1, tree1], [s2, tree2]] as const) {
      expect(await storedTree(s.dbId)).toEqual(expectedTree(tree));
    }
  });

  describe('two connections', () => {
    const adminSql = postgres(process.env.DATABASE_URL ?? '', { max: 1 });
    afterAll(async () => { await adminSql.end({ timeout: 5 }); });

    runDb('two concurrent hydrations of one lineage write one checkpoint', async () => {
      const t = await seedWriteTenant({ jobStatus: 'completed' });
      const origin = await snapshotOf(t); // live origin row, never hydrated itself
      const [s1, s2] = [await snapshotOf(t), await snapshotOf(t)];
      const tree = filesOf(origin.snapshotId, 50);
      const lineage = lineageKeyOf({ ...t, storageIdentity: WRITE_IDENTITY, backupType: 'file', keyLayout: 'legacy_flat', keyPrefix: null })!;

      // Hold the lineage lock so both publishes queue behind it at the same point.
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      let locked!: () => void;
      const lockHeld = new Promise<void>((r) => { locked = r; });
      const lockTx = adminSql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lineageLockKey(lineage)}, 0))`;
        locked();
        await held;
      });
      await lockHeld;
      let both: Promise<unknown[]> | undefined;
      try {
        both = Promise.all([hydrate(s1.dbId, manifestOf(s1.snapshotId, tree)), hydrate(s2.dbId, manifestOf(s2.snapshotId, tree))]);
        await waitForLockWaiters('%pg_advisory_xact_lock%', 2);
      } finally {
        release();
        await lockTx;
      }
      expect(await both).toMatchObject([{ status: 'complete' }, { status: 'complete' }]);

      const headers = await checkpointsOfDevice(t.deviceId);
      expect(headers).toHaveLength(1);
      expect((await indexState(s1.dbId)).checkpoint_id).toBe(headers[0]!.id);
      expect((await indexState(s2.dbId)).checkpoint_id).toBe(headers[0]!.id);
      expect(await storedTree(s1.dbId)).toEqual(expectedTree(tree));
      expect(await storedTree(s2.dbId)).toEqual(expectedTree(tree));
    });

    runDb('a header held by a publisher survives the sweep; once referenced it is kept', async () => {
      const t = await seedWriteTenant({ jobStatus: 'completed' });
      const [s0, s1] = [await snapshotOf(t), await snapshotOf(t)];
      await hydrate(s0.dbId, manifestOf(s0.snapshotId, filesOf(s0.snapshotId, 20)));
      const [h] = await checkpointsOfDevice(t.deviceId);
      // Unreferenced, and collectable once past the TTL.
      await getTestDb().execute(sql`DELETE FROM backup_snapshots WHERE id = ${s0.dbId}::uuid`);
      const pastTtl = new Date(Date.now() + CHECKPOINT_ORPHAN_TTL_MS + 60_000);

      await adminSql.begin(async (tx) => {
        // What publishDeltaIndex holds on the header it diffs against.
        await tx`SELECT id FROM backup_tree_checkpoints WHERE id = ${h!.id} FOR KEY SHARE`;
        await collectUnreferencedCheckpoints({ deadlineMs: Date.now() + 30_000, now: pastTtl });
        expect(await checkpointExists(h!.id)).toBe(true);
        // The publisher's reference, committed with its transaction.
        await tx`UPDATE backup_snapshots SET file_index_format = 'delta', file_index_checkpoint_id = ${h!.id} WHERE id = ${s1.dbId}`;
      });

      await collectUnreferencedCheckpoints({ deadlineMs: Date.now() + 30_000, now: pastTtl });
      expect(await checkpointExists(h!.id)).toBe(true);
    });
  });

  runDb('a failed delta invariant leaves the previous rows, format and checkpoints', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const s0 = await snapshotOf(t);
    const base = filesOf(s0.snapshotId, 40);
    await hydrate(s0.dbId, manifestOf(s0.snapshotId, base));
    const before = await indexState(s0.dbId);
    const headersBefore = await checkpointsOfDevice(t.deviceId);
    const lineage = lineageKeyOf({ ...t, storageIdentity: WRITE_IDENTITY, backupType: 'file', keyLayout: 'legacy_flat', keyPrefix: null })!;

    await expect(runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM backup_snapshots WHERE id = ${s0.dbId}::uuid FOR UPDATE`);
      await tx.execute(sql`DELETE FROM backup_snapshot_files WHERE snapshot_db_id = ${s0.dbId}::uuid`);
      await createIncomingIndexTable(tx);
      await loadIncomingBatch(tx, base.slice(1).map((e) => ({
        source_path: e.sourcePath, backup_path: e.backupPath, size: e.size ?? null, modified_at: null, kind: null,
      })));
      // One entry fewer was loaded than this claims the manifest has.
      return publishDeltaIndex(tx, { snapshotDbId: s0.dbId, lineage, manifestSha256: 'f'.repeat(64), eligibleEntries: 40 });
    })))).rejects.toThrow(/snapshot index delta does not reproduce the manifest/);

    expect(await indexState(s0.dbId)).toEqual(before);
    expect(await checkpointsOfDevice(t.deviceId)).toEqual(headersBefore);
    expect(await storedTree(s0.dbId)).toEqual(expectedTree(base));
  });

  runDb('flag off after deltas exist: old delta snapshots stay readable; new ones publish rows', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const [s0, s1] = [await snapshotOf(t), await snapshotOf(t)];
    const base = filesOf(s0.snapshotId, 30);
    await hydrate(s0.dbId, manifestOf(s0.snapshotId, base));
    const [h] = await checkpointsOfDevice(t.deviceId);

    process.env.BACKUP_INDEX_DELTA_PUBLISH = 'off';
    const tree1 = [...base, ...filesOf(s1.snapshotId, 1, 300)];
    expect(await hydrate(s1.dbId, manifestOf(s1.snapshotId, tree1))).toMatchObject({ rowsWritten: 31, checkpointEntriesWritten: 0 });
    expect(await indexState(s1.dbId)).toMatchObject({ format: 'rows', checkpoint_id: null, adds: 31, tombstones: 0 });
    expect(await indexState(s0.dbId)).toMatchObject({ format: 'delta', checkpoint_id: h!.id });
    expect(await storedTree(s0.dbId)).toEqual(expectedTree(base));

    // Re-hydrating the old delta snapshot with the flag off publishes it as rows.
    await hydrate(s0.dbId, manifestOf(s0.snapshotId, base));
    expect(await indexState(s0.dbId)).toMatchObject({ format: 'rows', checkpoint_id: null, adds: 30, tombstones: 0 });
    expect(await storedTree(s0.dbId)).toEqual(expectedTree(base));
    expect(await checkpointsOfDevice(t.deviceId)).toHaveLength(1);
  });

  runDb('inline agent rows on a failed delta snapshot reset it to rows format and read exactly the agent rows', async () => {
    const t = await seedWriteTenant({ jobStatus: 'running' });
    const s0 = await snapshotOf(t);
    await hydrate(s0.dbId, manifestOf(s0.snapshotId, filesOf(s0.snapshotId, 30)));
    // As a refused re-hydration leaves it.
    await getTestDb().execute(sql`UPDATE backup_snapshots SET file_index_status = 'failed' WHERE id = ${s0.dbId}::uuid`);
    expect(await indexState(s0.dbId)).toMatchObject({ format: 'delta', status: 'failed' });

    const agentFiles = [
      { sourcePath: 'C:/agent/one', backupPath: `snapshots/${s0.snapshotId}/files/a0`, size: 1 },
      { sourcePath: 'C:/agent/two', backupPath: `snapshots/${s0.snapshotId}/files/a1`, size: 2 },
    ];
    const outcome = await withDbAccessContext(orgContext(t.orgId), () => applyBackupCommandResultToJob({
      jobId: t.jobId, orgId: t.orgId, deviceId: t.deviceId, resultStatus: 'completed',
      result: {
        snapshotId: s0.snapshotId, filesBackedUp: agentFiles.length, bytesBackedUp: 3,
        snapshot: { id: s0.snapshotId, files: agentFiles },
      } as never,
      dispatchExpectationVerified: true,
    }));
    expect(outcome).toMatchObject({ applied: true, snapshotDbId: s0.dbId });

    expect(await indexState(s0.dbId)).toMatchObject({ format: 'rows', checkpoint_id: null, status: 'agent', adds: 2, tombstones: 0 });
    expect(await storedTree(s0.dbId)).toEqual(expectedTree(agentFiles));
  });
});

describe('checkpoint GC (#11736 D8)', () => {
  runDb('keeps the newest unreferenced header of a live lineage, deletes an older one, and the newest after the TTL', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const [s0, s1] = [await snapshotOf(t), await snapshotOf(t)];
    const base = filesOf(s0.snapshotId, 40);
    await hydrate(s0.dbId, manifestOf(s0.snapshotId, base));
    await hydrate(s1.dbId, manifestOf(s1.snapshotId, [...base, ...filesOf(s1.snapshotId, 10, 400)])); // past 5%: new checkpoint
    const [older, newest] = await checkpointsOfDevice(t.deviceId);
    expect(newest).toBeDefined();

    // Both referenced: neither is collected, whatever the TTL.
    const pastTtl = new Date(Date.now() + CHECKPOINT_ORPHAN_TTL_MS + 60_000);
    await collectUnreferencedCheckpoints({ deadlineMs: Date.now() + 30_000, now: pastTtl });
    expect(await checkpointExists(older!.id)).toBe(true);
    expect(await checkpointExists(newest!.id)).toBe(true);

    // The older one loses its last reference: collected, since a newer header exists.
    await getTestDb().execute(sql`DELETE FROM backup_snapshots WHERE id = ${s0.dbId}::uuid`);
    await collectUnreferencedCheckpoints({ deadlineMs: Date.now() + 30_000 });
    expect(await checkpointExists(older!.id)).toBe(false);
    expect(await checkpointExists(newest!.id)).toBe(true);

    // The newest loses its last reference: kept within the TTL, collected after it.
    await getTestDb().execute(sql`DELETE FROM backup_snapshots WHERE id = ${s1.dbId}::uuid`);
    await collectUnreferencedCheckpoints({ deadlineMs: Date.now() + 30_000 });
    expect(await checkpointExists(newest!.id)).toBe(true);
    await collectUnreferencedCheckpoints({ deadlineMs: Date.now() + 30_000, now: pastTtl });
    expect(await checkpointExists(newest!.id)).toBe(false);
    // Its entries went with it.
    const entries = (await getTestDb().execute(sql`
      SELECT count(*)::int AS n FROM backup_tree_checkpoint_entries WHERE checkpoint_id IN (${older!.id}::uuid, ${newest!.id}::uuid)
    `)) as unknown as Array<{ n: number }>;
    expect(entries[0]!.n).toBe(0);
  });

  runDb('a newer header of another lineage does not make a header collectable', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const s0 = await snapshotOf(t);
    await hydrate(s0.dbId, manifestOf(s0.snapshotId, filesOf(s0.snapshotId, 10)));
    const [h] = await checkpointsOfDevice(t.deviceId);
    await getTestDb().execute(sql`DELETE FROM backup_snapshots WHERE id = ${s0.dbId}::uuid`);

    // Another device of the same org, same config and destination: a different lineage.
    const otherDevice = await seedWriteDevice(t.orgId, t.siteId);
    const s1 = await snapshotOf(t, otherDevice);
    await hydrate(s1.dbId, manifestOf(s1.snapshotId, filesOf(s1.snapshotId, 10)));

    await collectUnreferencedCheckpoints({ deadlineMs: Date.now() + 30_000 });
    expect(await checkpointExists(h!.id)).toBe(true);
  });
});

describe('a checkpoint always names its snapshot\'s org and device', () => {
  runDb('the publisher refuses a lineage of another device before writing anything', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const s0 = await snapshotOf(t);
    const otherDevice = await seedWriteDevice(t.orgId, t.siteId);
    const lineage = lineageKeyOf({ ...t, deviceId: otherDevice, storageIdentity: WRITE_IDENTITY, backupType: 'file', keyLayout: 'legacy_flat', keyPrefix: null })!;

    await expect(runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(async (tx) => {
      await createIncomingIndexTable(tx);
      return publishDeltaIndex(tx, { snapshotDbId: s0.dbId, lineage, manifestSha256: 'f'.repeat(64), eligibleEntries: 0 });
    })))).rejects.toThrow(/another org or device/);
    expect(await checkpointsOfDevice(otherDevice)).toEqual([]);
  });

  runDb('the database refuses, in system scope, a pointer to another device\'s checkpoint and a header naming another org', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const other = await seedWriteTenant({ jobStatus: 'completed' });
    const s0 = await snapshotOf(t);
    const otherDevice = await seedWriteDevice(t.orgId, t.siteId);
    const s1 = await snapshotOf(t, otherDevice);
    await hydrate(s1.dbId, manifestOf(s1.snapshotId, filesOf(s1.snapshotId, 5)));
    const [foreign] = await checkpointsOfDevice(otherDevice);

    const inSystem = (fn: () => Promise<unknown>) => runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(fn)));
    // A snapshot of one device pointing at another device's checkpoint.
    await expectRefusedAsForeignKey(() => inSystem(() => db.execute(sql`
      UPDATE backup_snapshots SET file_index_format = 'delta', file_index_checkpoint_id = ${foreign!.id}::uuid WHERE id = ${s0.dbId}::uuid
    `)));
    // A header naming this org's device under another org: refused at commit.
    await expectRefusedAsForeignKey(() => inSystem(() => db.execute(sql`
      INSERT INTO backup_tree_checkpoints
        (org_id, device_id, config_id, storage_identity, backup_type, key_layout, entry_count, source_manifest_sha256)
      VALUES (${other.orgId}::uuid, ${t.deviceId}::uuid, ${other.configId}::uuid, ${WRITE_IDENTITY}, 'file', 'legacy_flat', 0, ${'f'.repeat(64)})
    `)));
    expect(await indexState(s0.dbId)).toMatchObject({ format: 'rows', checkpoint_id: null });
    expect(await checkpointsOfDevice(t.deviceId)).toEqual([]);
  });
});

describe('delta publish edges (#11736 step 2)', () => {
  runDb('tombstones alone can tip a delta past 5%', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const [s0, s1, s2] = [await snapshotOf(t), await snapshotOf(t), await snapshotOf(t)];
    const base = filesOf(s0.snapshotId, 100); // threshold ceil(5% of 100) = 5
    await hydrate(s0.dbId, manifestOf(s0.snapshotId, base));
    const [h1] = await checkpointsOfDevice(t.deviceId);

    // 3 additions + 2 removals = 5: still a delta.
    const tree1 = [...base.slice(2), ...filesOf(s1.snapshotId, 3, 500)];
    await hydrate(s1.dbId, manifestOf(s1.snapshotId, tree1));
    expect(await indexState(s1.dbId)).toMatchObject({ format: 'delta', checkpoint_id: h1!.id, adds: 3, tombstones: 2 });

    // 2 additions + 4 removals = 6: the removals tip it, a new checkpoint.
    const tree2 = [...base.slice(4), ...filesOf(s2.snapshotId, 2, 600)];
    await hydrate(s2.dbId, manifestOf(s2.snapshotId, tree2));
    const state2 = await indexState(s2.dbId);
    expect(state2).toMatchObject({ format: 'delta', adds: 0, tombstones: 0 });
    expect(state2.checkpoint_id).not.toBe(h1!.id);
    for (const [s, tree] of [[s0, base], [s1, tree1], [s2, tree2]] as const) {
      expect(await storedTree(s.dbId)).toEqual(expectedTree(tree));
    }
  });

  runDb('a change of modification time or kind alone is a changed entry', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const [s0, s1] = [await snapshotOf(t), await snapshotOf(t)];
    const stamped: Entry = { sourcePath: 'C:/m/stamped', backupPath: `snapshots/${s0.snapshotId}/files/stamped`, size: 3, modTime: '2026-01-02T03:04:05Z' };
    const link: Entry = { sourcePath: 'C:/m/link', backupPath: '', kind: 'dir' };
    const base = [...filesOf(s0.snapshotId, 60), stamped, link];
    await hydrate(s0.dbId, manifestOf(s0.snapshotId, base));

    const tree1 = [...filesOf(s0.snapshotId, 60), { ...stamped, modTime: '2026-01-02T03:04:06Z' }, { ...link, kind: 'symlink' as const }];
    await hydrate(s1.dbId, manifestOf(s1.snapshotId, tree1));

    expect(await indexState(s1.dbId)).toMatchObject({ format: 'delta', adds: 2, tombstones: 2 });
    expect(await storedTree(s1.dbId)).toEqual(expectedTree(tree1));
    expect(await storedTree(s0.dbId)).toEqual(expectedTree(base));
  });

  runDb('an empty manifest publishes an empty tree, and the next snapshot gets a checkpoint of its own', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const [s0, s1] = [await snapshotOf(t), await snapshotOf(t)];
    expect(await hydrate(s0.dbId, manifestOf(s0.snapshotId, []))).toMatchObject({ status: 'complete', entryCount: 0, rowsWritten: 0 });
    const [empty] = await checkpointsOfDevice(t.deviceId);
    expect(empty).toMatchObject({ entry_count: 0 });
    expect(await storedTree(s0.dbId)).toEqual([]);

    // ceil(5% of 0) = 0: any entry is past it.
    const tree1 = filesOf(s1.snapshotId, 1);
    await hydrate(s1.dbId, manifestOf(s1.snapshotId, tree1));
    const state1 = await indexState(s1.dbId);
    expect(state1).toMatchObject({ format: 'delta', adds: 0, tombstones: 0 });
    expect(state1.checkpoint_id).not.toBe(empty!.id);
    expect(await storedTree(s1.dbId)).toEqual(expectedTree(tree1));
  });

  runDb('a re-hydration whose delta fails the invariant leaves the previous rows, format and pointer', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const [s0, s1] = [await snapshotOf(t), await snapshotOf(t)];
    const base = filesOf(s0.snapshotId, 80);
    const tree1 = [...base.slice(1), ...filesOf(s1.snapshotId, 2, 400)];
    await hydrate(s0.dbId, manifestOf(s0.snapshotId, base));
    await hydrate(s1.dbId, manifestOf(s1.snapshotId, tree1));
    const before = await indexState(s1.dbId);
    expect(before).toMatchObject({ format: 'delta', adds: 2, tombstones: 1 });
    const headersBefore = await checkpointsOfDevice(t.deviceId);

    publishSeam.overstateBy = 1;
    await expect(hydrate(s1.dbId, manifestOf(s1.snapshotId, [...tree1, ...filesOf(s1.snapshotId, 1, 401)])))
      .rejects.toThrow(/snapshot index delta does not reproduce the manifest/);

    // Only the failure was recorded; the index it had is untouched.
    expect(await indexState(s1.dbId)).toEqual({ ...before, status: 'failed' });
    expect(await storedTree(s1.dbId)).toEqual(expectedTree(tree1));
    expect(await checkpointsOfDevice(t.deviceId)).toEqual(headersBefore);
  });

  runDb('one device keeps a checkpoint per config and per backup type', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const otherConfig = randomUUID();
    await getTestDb().execute(sql`
      INSERT INTO backup_configs (id, org_id, name, type, provider, provider_config)
      SELECT ${otherConfig}::uuid, org_id, 'Second', type, provider, provider_config FROM backup_configs WHERE id = ${t.configId}::uuid
    `);
    const s0 = await snapshotOf(t);
    const sConfig = await snapshotOf({ ...t, configId: otherConfig });
    const sType = await snapshotOf(t);
    await getTestDb().execute(sql`UPDATE backup_snapshots SET backup_type = 'database' WHERE id = ${sType.dbId}::uuid`);
    // The same tree everywhere: diffing against another lineage's checkpoint would write nothing.
    const tree = filesOf(s0.snapshotId, 30);

    await hydrate(s0.dbId, manifestOf(s0.snapshotId, tree));
    await hydrate(sConfig.dbId, manifestOf(sConfig.snapshotId, tree));
    await hydrate(sType.dbId, manifestOf(sType.snapshotId, tree));

    const pointers = await Promise.all([s0, sConfig, sType].map(async (s) => (await indexState(s.dbId)).checkpoint_id));
    expect(new Set(pointers).size).toBe(3);
    expect(await checkpointsOfDevice(t.deviceId)).toHaveLength(3);
    for (const s of [s0, sConfig, sType]) expect(await storedTree(s.dbId)).toEqual(expectedTree(tree));

    // A newer header of a sibling lineage does not make s0's collectable.
    await getTestDb().execute(sql`DELETE FROM backup_snapshots WHERE id = ${s0.dbId}::uuid`);
    await collectUnreferencedCheckpoints({ deadlineMs: Date.now() + 30_000 });
    expect(await checkpointExists(pointers[0]!)).toBe(true);
  });

  runDb('an empty agent index on a delta snapshot resets that snapshot only', async () => {
    const t = await seedWriteTenant({ jobStatus: 'running' });
    const [s0, s1] = [await snapshotOf(t), await snapshotOf(t)];
    const base = filesOf(s0.snapshotId, 20);
    await hydrate(s0.dbId, manifestOf(s0.snapshotId, base));
    await hydrate(s1.dbId, manifestOf(s1.snapshotId, base));
    const sibling = await indexState(s1.dbId);
    await getTestDb().execute(sql`UPDATE backup_snapshots SET file_index_status = 'failed' WHERE id = ${s0.dbId}::uuid`);

    await withDbAccessContext(orgContext(t.orgId), () => applyBackupCommandResultToJob({
      jobId: t.jobId, orgId: t.orgId, deviceId: t.deviceId, resultStatus: 'completed',
      result: { snapshotId: s0.snapshotId, filesBackedUp: 0, bytesBackedUp: 0, snapshot: { id: s0.snapshotId, files: [] } } as never,
      dispatchExpectationVerified: true,
    }));

    expect(await indexState(s0.dbId)).toMatchObject({ format: 'rows', checkpoint_id: null, adds: 0, tombstones: 0 });
    expect(await indexState(s1.dbId)).toEqual(sibling);
    expect(await storedTree(s1.dbId)).toEqual(expectedTree(base));
  });
});

describe('round trip through the readers (#11736 step 2, plan Task 6)', () => {
  /** A whole-second modification time, as a manifest carries it. */
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 1) + minute * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
  const keyOf = (snap: Snap, name: string) => `snapshots/${snap.snapshotId}/files/${name}`;

  runDb('every reader returns exactly the manifest of each delta and of each new checkpoint', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const [s0, s1, s2, s3, s4] = [await snapshotOf(t), await snapshotOf(t), await snapshotOf(t), await snapshotOf(t), await snapshotOf(t)];
    const P = {
      reAdded: 'C:/case/re-added.dat',
      modified: 'C:/case/modified.dat',
      fileToDir: 'C:/case/file-to-dir',
      dirToFile: 'C:/case/dir-to-file',
      deleted: 'C:/case/deleted.dat',
    };
    const plain = filesOf(s0.snapshotId, 195);
    const base: Entry[] = [
      ...plain,
      { sourcePath: P.reAdded, backupPath: keyOf(s0, 're-added'), size: 5, modTime: at(1) },
      { sourcePath: P.modified, backupPath: keyOf(s0, 'modified'), size: 6, modTime: at(2) },
      { sourcePath: P.fileToDir, backupPath: keyOf(s0, 'file-to-dir'), size: 7, modTime: at(3) },
      { sourcePath: P.dirToFile, backupPath: '', kind: 'dir' },
      { sourcePath: P.deleted, backupPath: keyOf(s0, 'deleted'), size: 8, modTime: at(4) },
    ];
    // 200 entries: a delta of up to ceil(5% of 200) = 10 differences is kept.
    expect(base).toHaveLength(200);

    expect(await hydrate(s0.dbId, manifestOf(s0.snapshotId, base))).toMatchObject({ status: 'complete', checkpointEntriesWritten: 200 });
    const [h1] = await checkpointsOfDevice(t.deviceId);
    expect(await indexState(s0.dbId)).toMatchObject({ format: 'delta', checkpoint_id: h1!.id, adds: 0, tombstones: 0 });
    await expectReadersReturnManifest(t, s0, base);

    // S1, one delta with every kind of change, ten differences in all:
    //  - re-added: deleted and added again at the same path and size, as a new object;
    //  - modified: new object, size and modification time;
    //  - a file that became a directory (with a file beneath it), and a directory that became a file;
    //  - deleted.
    const tree1: Entry[] = [
      ...plain,
      { sourcePath: P.reAdded, backupPath: keyOf(s1, 're-added'), size: 5, modTime: at(1) },
      { sourcePath: P.modified, backupPath: keyOf(s1, 'modified'), size: 60, modTime: at(20) },
      { sourcePath: P.fileToDir, backupPath: '', kind: 'dir' },
      { sourcePath: `${P.fileToDir}/child.dat`, backupPath: keyOf(s1, 'child'), size: 9, modTime: at(21) },
      { sourcePath: P.dirToFile, backupPath: keyOf(s1, 'dir-to-file'), size: 10, modTime: at(22) },
    ];
    await hydrate(s1.dbId, manifestOf(s1.snapshotId, tree1));
    expect(await indexState(s1.dbId)).toMatchObject({ format: 'delta', checkpoint_id: h1!.id, adds: 5, tombstones: 5 });
    await expectReadersReturnManifest(t, s1, tree1, {
      keys: [keyOf(s0, 're-added'), keyOf(s0, 'modified'), keyOf(s0, 'file-to-dir'), keyOf(s0, 'deleted')],
      paths: [P.deleted],
    });

    // S2, an empty delta: the tree is the checkpoint's again, so the deleted file is back.
    await hydrate(s2.dbId, manifestOf(s2.snapshotId, base));
    expect(await indexState(s2.dbId)).toMatchObject({ format: 'delta', checkpoint_id: h1!.id, adds: 0, tombstones: 0 });
    await expectReadersReturnManifest(t, s2, base, {
      keys: [keyOf(s1, 're-added'), keyOf(s1, 'modified'), keyOf(s1, 'child'), keyOf(s1, 'dir-to-file')],
      paths: [`${P.fileToDir}/child.dat`],
    });

    // S3, past 5%: thirty files replaced. It writes a new checkpoint and stores no rows of its own.
    const tree3: Entry[] = [
      ...plain.map((e, i) => (i < 30 ? { ...e, backupPath: keyOf(s3, `r-${i}`), size: 50_000 + i } : e)),
      ...base.slice(plain.length),
    ];
    expect(await hydrate(s3.dbId, manifestOf(s3.snapshotId, tree3))).toMatchObject({ checkpointEntriesWritten: 200, rowsWritten: 0 });
    const headers = await checkpointsOfDevice(t.deviceId);
    expect(headers).toHaveLength(2);
    const h2 = headers[1]!;
    expect(await indexState(s3.dbId)).toMatchObject({ format: 'delta', checkpoint_id: h2.id, adds: 0, tombstones: 0 });
    await expectReadersReturnManifest(t, s3, tree3, { keys: plain.slice(0, 30).map((e) => e.backupPath), paths: [] });

    // S4 diffs against the new checkpoint: one file replaced, one deleted.
    const tree4: Entry[] = [
      { ...tree3[0]!, backupPath: keyOf(s4, 'r-0'), size: 70_000 },
      ...tree3.slice(2),
    ];
    await hydrate(s4.dbId, manifestOf(s4.snapshotId, tree4));
    expect(await indexState(s4.dbId)).toMatchObject({ format: 'delta', checkpoint_id: h2.id, adds: 1, tombstones: 2 });
    await expectReadersReturnManifest(t, s4, tree4, {
      keys: [keyOf(s3, 'r-0'), keyOf(s3, 'r-1'), plain[0]!.backupPath],
      paths: [tree3[1]!.sourcePath],
    });

    // The snapshots on the first checkpoint still read their own trees.
    await expectReadersReturnManifest(t, s1, tree1, { keys: [keyOf(s0, 'deleted')], paths: [P.deleted] });
    await expectReadersReturnManifest(t, s2, base);
  });

  runDb('the readers follow a delta snapshot that inline agent rows reset to rows format', async () => {
    const t = await seedWriteTenant({ jobStatus: 'running' });
    const s0 = await snapshotOf(t);
    const base = filesOf(s0.snapshotId, 40);
    await hydrate(s0.dbId, manifestOf(s0.snapshotId, base));
    expect(await indexState(s0.dbId)).toMatchObject({ format: 'delta' });
    await expectReadersReturnManifest(t, s0, base);
    // As a refused re-hydration leaves it.
    await getTestDb().execute(sql`UPDATE backup_snapshots SET file_index_status = 'failed' WHERE id = ${s0.dbId}::uuid`);

    const agentFiles: Entry[] = [
      { sourcePath: 'C:/agent/one', backupPath: `snapshots/${s0.snapshotId}/files/a0`, size: 1 },
      { sourcePath: 'C:/agent/two', backupPath: `snapshots/${s0.snapshotId}/files/a1`, size: 2 },
    ];
    await withDbAccessContext(orgContext(t.orgId), () => applyBackupCommandResultToJob({
      jobId: t.jobId, orgId: t.orgId, deviceId: t.deviceId, resultStatus: 'completed',
      result: {
        snapshotId: s0.snapshotId, filesBackedUp: agentFiles.length, bytesBackedUp: 3,
        snapshot: { id: s0.snapshotId, files: agentFiles },
      } as never,
      dispatchExpectationVerified: true,
    }));
    expect(await indexState(s0.dbId)).toMatchObject({ format: 'rows', checkpoint_id: null, status: 'agent' });

    // Agent rows read as exactly themselves, the checkpoint's entries nowhere, wherever an 'agent' index is served.
    await expectReadersReturnManifest(t, s0, agentFiles, {
      keys: base.slice(0, 3).map((e) => e.backupPath),
      paths: base.slice(0, 3).map((e) => e.sourcePath),
    });
  });
});
