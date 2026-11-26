/**
 * #11736 step 2: the delta publisher, the inline-row reset and checkpoint GC,
 * against real Postgres, with BACKUP_INDEX_DELTA_PUBLISH=on.
 *
 * The hydrator is driven for real (storage is a manifest served from memory).
 * Each snapshot's tree is checked as stored: the checkpoint entries it does
 * not tombstone plus its own rows, compared as a multiset with the manifest.
 * The round trip through the readers themselves (browse, selection, both
 * authorization reads) is added once the delta leg of the read layer is on
 * main.
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
import { hydrateSnapshotFileIndex } from '../../services/backupSnapshotFileIndex';
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
