/**
 * #11736 step 2: the read layer resolves a `delta` snapshot to its effective
 * tree, and to nothing at all when its checkpoint cannot be trusted (R3).
 *
 * A delta snapshot stores only its differences from a checkpoint: adds (its
 * entries the checkpoint lacks) and tombstones (one per checkpoint entry its
 * tree lacks). Every reader goes through snapshotIndexEntries, so every reader
 * must see checkpoint entries not tombstoned by THIS snapshot, plus its adds.
 *
 * When the checkpoint is hidden from the caller (RLS) or names another org or
 * device, the snapshot must read as empty. Reading only the adds would be a
 * partial tree, and reading the tombstones as entries would list paths the
 * snapshot does not hold. The schema's composite pointer FK makes those states
 * unseedable at rest; they exist inside an org merge, which runs with
 * constraints deferred, so the tests reproduce them the same way in a
 * transaction that rolls back.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/backupSnapshotIndexDeltaGate.integration.test.ts
 */
import './setup';

import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  db,
  systemDbAccessContext,
  withDbAccessContext,
  withResolvedDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  listSnapshotDirectory,
  readableSnapshotSourcePaths,
  resolveSelectedSnapshotPathsInDb,
  searchSnapshotFiles,
} from '../../services/backupSnapshotBrowse';
import { readSnapshotIndexView } from '../../services/backupSnapshotIndexView';
import { drizzleBrokeredReadStore } from '../../services/backupStorageSessionStore';
import { authorizeExternalReference } from '../../services/recoveryDownloadService';
import {
  WRITE_IDENTITY,
  insertSnapshotRow,
  orgContext,
  seedWriteDevice,
  seedWriteTenant,
  type WriteTenant,
} from './backupWriteFixtures';
import {
  seedCheckpoint,
  seedDeltaIndex,
  seedRowsIndex,
  type IndexEntry,
} from './helpers/backupIndexFixtures';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const key = (snapshotId: string, name: string) => `snapshots/${snapshotId}/files/${name}`;
const mtime = (size: number) => new Date(Date.UTC(2026, 10, 1) + size * 60_000).toISOString();
const dir = (p: string): IndexEntry => ({ sourcePath: p, backupPath: '', size: null, modifiedAt: null, kind: 'dir' });
const file = (p: string, snapshotId: string, name: string, size: number): IndexEntry => (
  { sourcePath: p, backupPath: key(snapshotId, name), size, modifiedAt: mtime(size), kind: null }
);

type Lineage = {
  t: WriteTenant;
  fullId: string;
  incId: string;
  checkpointId: string;
  checkpoint: IndexEntry[];
  deltaDbId: string;
  deltaDigest: string;
  allKeys: string[];
};

/**
 * A checkpoint built from full snapshot `fullId`, and incremental `incId`
 * published as a delta against it: b.txt replaced, gone.txt deleted, d.txt
 * added. Its effective tree is /srv, a.txt (from the checkpoint), b.txt and
 * d.txt (its adds).
 */
async function seedLineage(t?: WriteTenant): Promise<Lineage> {
  const tenant = t ?? await seedWriteTenant({ jobStatus: 'completed' });
  const run = randomBytes(6).toString('hex');
  const fullId = `snapshot-20261111T000001Z-${run}`;
  const incId = `snapshot-20261111T000002Z-${run}`;
  const checkpoint = [
    dir('/srv'),
    file('/srv/a.txt', fullId, 'a', 10),
    file('/srv/b.txt', fullId, 'b', 11),
    file('/srv/gone.txt', fullId, 'gone', 12),
  ];
  const tree = [
    dir('/srv'),
    file('/srv/a.txt', fullId, 'a', 10),
    file('/srv/b.txt', incId, 'b', 21),
    file('/srv/d.txt', incId, 'd', 22),
  ];
  const checkpointId = await seedCheckpoint(
    { orgId: tenant.orgId, deviceId: tenant.deviceId, configId: tenant.configId, storageIdentity: WRITE_IDENTITY },
    checkpoint,
  );
  const deltaDbId = await insertSnapshotRow(tenant, incId);
  const deltaDigest = sha(`manifest ${incId}`);
  const diff = await seedDeltaIndex(deltaDbId, checkpointId, checkpoint, tree, deltaDigest);
  // The fixture really is a delta: two adds and two tombstones, not a full copy.
  expect(diff.adds.map((e) => e.sourcePath)).toEqual(['/srv/b.txt', '/srv/d.txt']);
  expect(diff.tombstones.map((x) => x.sourcePath)).toEqual(['/srv/b.txt', '/srv/gone.txt']);

  for (const originSnapshotId of [fullId, incId]) {
    await getTestDb().execute(sql`
      INSERT INTO backup_snapshot_origins (snapshot_db_id, origin_snapshot_id, origin_org_id, origin_device_id,
        origin_storage_identity, provenance, object_count)
      VALUES (${deltaDbId}, ${originSnapshotId}, ${tenant.orgId}, ${tenant.deviceId}, ${WRITE_IDENTITY}, 'live', 1)
    `);
  }
  const allKeys = [...new Set([...checkpoint, ...tree].map((e) => e.backupPath).filter(Boolean))];
  return { t: tenant, fullId, incId, checkpointId, checkpoint, deltaDbId, deltaDigest, allKeys };
}

/** Everything every reader returns for one snapshot, run in the ambient DB context. */
async function readAll(l: Lineage, snapshotDbId = l.deltaDbId, digest = l.deltaDigest) {
  const browse = async (segments: string[]) => (await listSnapshotDirectory({ snapshotDbId, segments, limit: 100 }))
    .entries.map((e) => (e.type === 'directory' ? `${e.name}/ (${e.fileCount})` : `${e.name} ${e.sizeBytes}`));
  // `true`, or the refusal reason, so a refusal is pinned to the membership read.
  const authorize = async (k: string, originSnapshotId: string) => {
    const r = await authorizeExternalReference(db, {
      tokenId: 'token-11736-gate', snapshotDbId, key: k, originSnapshotId,
      orgId: l.t.orgId, deviceId: l.t.deviceId, pinnedStorageIdentity: WRITE_IDENTITY,
    });
    return r.ok ? true : r.reason;
  };
  return {
    root: await browse([]),
    srv: await browse(['srv']),
    search: (await searchSnapshotFiles({ snapshotDbId, query: 'txt', limit: 50, after: null }))
      .entries.map((e) => `${e.path} ${e.sizeBytes ?? '-'}`),
    selectable: await readableSnapshotSourcePaths(snapshotDbId),
    selectB: await resolveSelectedSnapshotPathsInDb(snapshotDbId, ['/srv/b.txt']),
    count: await drizzleBrokeredReadStore.countIndexedFiles(snapshotDbId),
    keys: [...await drizzleBrokeredReadStore.filterIndexedKeys(snapshotDbId, l.allKeys, digest)].sort(),
    authorizeAdd: await authorize(key(l.incId, 'd'), l.incId),
    authorizeCheckpointEntry: await authorize(key(l.fullId, 'a'), l.fullId),
    authorizeReplaced: await authorize(key(l.fullId, 'b'), l.fullId),
  };
}

const NOT_MEMBER = 'key is not a member of the snapshot file index';

const EMPTY = {
  root: [],
  srv: [],
  search: [],
  selectable: [],
  // An empty tree is no index at all, not one that lacks this path.
  selectB: { ok: false, reason: 'no_readable_index' },
  count: 0,
  keys: [],
  authorizeAdd: NOT_MEMBER,
  authorizeCheckpointEntry: NOT_MEMBER,
  authorizeReplaced: NOT_MEMBER,
};

class Rollback extends Error {}

/**
 * Runs `tamper` in system scope with every deferrable constraint deferred,
 * then `read` on the same transaction in `context` (an org's request context,
 * or system scope), then rolls it all back. Returns what `read` returned.
 */
async function inTamperedTransaction<T>(
  context: DbAccessContext,
  tamper: () => Promise<void>,
  read: () => Promise<T>,
): Promise<T> {
  let out: T | undefined;
  await expect(withResolvedDbAccessContext(
    async () => {
      await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      await tamper();
      return { context, value: null };
    },
    async () => {
      out = await read();
      throw new Rollback();
    },
  )).rejects.toBeInstanceOf(Rollback);
  return out as T;
}

async function headerVisible(checkpointId: string): Promise<number> {
  const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM backup_tree_checkpoints WHERE id = ${checkpointId}`)) as unknown as Array<{ n: number }>;
  return rows[0]!.n;
}

describe('the read layer resolves a delta snapshot (#11736 step 2)', () => {
  runDb('a delta snapshot reads checkpoint entries it does not tombstone plus its adds', async () => {
    const l = await seedLineage();
    expect(await withDbAccessContext(orgContext(l.t.orgId), () => readAll(l))).toEqual({
      root: ['srv/ (3)'],
      srv: ['a.txt 10', 'b.txt 21', 'd.txt 22'],
      search: ['/srv/a.txt 10', '/srv/b.txt 21', '/srv/d.txt 22'],
      selectable: ['/srv', '/srv/a.txt', '/srv/b.txt', '/srv/d.txt'],
      selectB: { ok: true, paths: ['/srv/b.txt'] },
      count: 3,
      keys: [key(l.fullId, 'a'), key(l.incId, 'b'), key(l.incId, 'd')].sort(),
      authorizeAdd: true,
      authorizeCheckpointEntry: true,
      authorizeReplaced: NOT_MEMBER,
    });
  });

  runDb('a delta snapshot whose checkpoint is not visible reads as empty, never as its adds', async () => {
    const l = await seedLineage();
    const other = await seedWriteTenant({ jobStatus: 'completed' });
    const result = await inTamperedTransaction(
      orgContext(l.t.orgId),
      async () => {
        await db.execute(sql`UPDATE backup_tree_checkpoints SET org_id = ${other.orgId} WHERE id = ${l.checkpointId}`);
      },
      async () => {
        // RLS really is in force: the moved header is invisible to org A.
        expect(await headerVisible(l.checkpointId)).toBe(0);
        return readAll(l);
      },
    );
    expect(result).toEqual(EMPTY);
    // Rolled back: the snapshot reads its tree again.
    expect((await withDbAccessContext(orgContext(l.t.orgId), () => readAll(l))).count).toBe(3);
  });

  runDb('a delta snapshot whose checkpoint names another device reads as empty', async () => {
    const l = await seedLineage();
    const otherDevice = await seedWriteDevice(l.t.orgId, l.t.siteId);
    const result = await inTamperedTransaction(
      orgContext(l.t.orgId),
      async () => {
        await db.execute(sql`UPDATE backup_tree_checkpoints SET device_id = ${otherDevice} WHERE id = ${l.checkpointId}`);
      },
      async () => {
        // Same org, so RLS shows the header: only the read layer's own check can refuse it.
        expect(await headerVisible(l.checkpointId)).toBe(1);
        return readAll(l);
      },
    );
    expect(result).toEqual(EMPTY);
  });

  runDb('a delta snapshot on a checkpoint of its own lineage reads the checkpoint\'s tree in every reader', async () => {
    const l = await seedLineage();
    // Only org and device are compared with the header (R3). Config, storage identity, backup type and key
    // root are not: later command results rewrite those snapshot columns (see the publish integration
    // test's lineage-rewrite case).
    const checkpointId = await seedCheckpoint(
      { orgId: l.t.orgId, deviceId: l.t.deviceId, configId: l.t.configId, storageIdentity: WRITE_IDENTITY },
      l.checkpoint,
    );
    const snapshotId = `snapshot-20261111T000007Z-${randomBytes(6).toString('hex')}`;
    const dbId = await insertSnapshotRow(l.t, snapshotId);
    const digest = sha(`manifest ${snapshotId}`);
    await seedDeltaIndex(dbId, checkpointId, l.checkpoint, l.checkpoint, digest);
    const read = await withDbAccessContext(orgContext(l.t.orgId), async () => {
      expect(await headerVisible(checkpointId)).toBe(1);
      return readAll(l, dbId, digest);
    });
    expect(read).toEqual({
      root: ['srv/ (3)'],
      srv: ['a.txt 10', 'b.txt 11', 'gone.txt 12'],
      search: ['/srv/a.txt 10', '/srv/b.txt 11', '/srv/gone.txt 12'],
      selectable: ['/srv', '/srv/a.txt', '/srv/b.txt', '/srv/gone.txt'],
      selectB: { ok: true, paths: ['/srv/b.txt'] },
      count: 3,
      keys: [key(l.fullId, 'a'), key(l.fullId, 'b'), key(l.fullId, 'gone')].sort(),
      // Past the membership read: this snapshot has no origin records of its own.
      authorizeAdd: NOT_MEMBER,
      authorizeCheckpointEntry: 'no verified origin record for this snapshot reference',
      authorizeReplaced: 'no verified origin record for this snapshot reference',
    });
  });

  runDb('a rows snapshot ignores stray tombstone rows', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const run = randomBytes(6).toString('hex');
    const s = `snapshot-20261111T000003Z-${run}`;
    const dbId = await insertSnapshotRow(t, s);
    const digest = sha(`manifest ${s}`);
    await seedRowsIndex(dbId, [dir('/srv'), file('/srv/a.txt', s, 'a', 10)], digest);
    // A tombstone row naming a real object key: never an entry, never a grant.
    await getTestDb().execute(sql`
      INSERT INTO backup_snapshot_files (snapshot_db_id, source_path, backup_path, checkpoint_entry_no)
      VALUES (${dbId}, '/srv/stray.txt', ${key(s, 'stray')}, 1)
    `);
    const read = await withDbAccessContext(orgContext(t.orgId), async () => ({
      srv: (await listSnapshotDirectory({ snapshotDbId: dbId, segments: ['srv'], limit: 100 })).entries.map((e) => e.name),
      search: (await searchSnapshotFiles({ snapshotDbId: dbId, query: 'stray', limit: 10, after: null })).entries,
      selectable: await readableSnapshotSourcePaths(dbId),
      count: await drizzleBrokeredReadStore.countIndexedFiles(dbId),
      keys: [...await drizzleBrokeredReadStore.filterIndexedKeys(dbId, [key(s, 'a'), key(s, 'stray')], digest)],
    }));
    expect(read).toEqual({ srv: ['a.txt'], search: [], selectable: ['/srv', '/srv/a.txt'], count: 1, keys: [key(s, 'a')] });
  });

  runDb('a tombstone in one snapshot never hides an entry in another snapshot of the same checkpoint', async () => {
    const l = await seedLineage();
    // A second incremental on the same checkpoint that changed nothing: an empty delta.
    const unchangedId = `snapshot-20261111T000004Z-${randomBytes(6).toString('hex')}`;
    const unchangedDbId = await insertSnapshotRow(l.t, unchangedId);
    const digest = sha(`manifest ${unchangedId}`);
    const diff = await seedDeltaIndex(unchangedDbId, l.checkpointId, l.checkpoint, l.checkpoint, digest);
    expect(diff).toEqual({ adds: [], tombstones: [] });

    const read = await withDbAccessContext(orgContext(l.t.orgId), () => readAll(l, unchangedDbId, digest));
    expect(read.srv).toEqual(['a.txt 10', 'b.txt 11', 'gone.txt 12']);
    expect(read.keys).toEqual([key(l.fullId, 'a'), key(l.fullId, 'b'), key(l.fullId, 'gone')].sort());
    expect(read.count).toBe(3);
    // And the first snapshot still reads its own tree.
    expect((await withDbAccessContext(orgContext(l.t.orgId), () => readAll(l))).srv).toEqual(['a.txt 10', 'b.txt 21', 'd.txt 22']);
  });

  runDb('the readiness probe sees an empty delta as indexed, and one whose checkpoint is hidden as not', async () => {
    const l = await seedLineage();
    const unchangedId = `snapshot-20261111T000005Z-${randomBytes(6).toString('hex')}`;
    const unchangedDbId = await insertSnapshotRow(l.t, unchangedId);
    await seedDeltaIndex(unchangedDbId, l.checkpointId, l.checkpoint, l.checkpoint, sha(`manifest ${unchangedId}`));
    // An empty delta stores no backup_snapshot_files row at all.
    const own = (await getTestDb().execute(sql`
      SELECT count(*)::int AS n FROM backup_snapshot_files WHERE snapshot_db_id = ${unchangedDbId}
    `)) as unknown as Array<{ n: number }>;
    expect(own[0]!.n).toBe(0);
    // 'hydrating' is the state where the entries alone decide: ready when there are any, building when not.
    await getTestDb().execute(sql`
      UPDATE backup_snapshots SET file_index_status = 'hydrating', file_index_hydrated_at = now(), file_count = NULL
      WHERE id = ${unchangedDbId}
    `);
    expect((await withDbAccessContext(orgContext(l.t.orgId), () => readSnapshotIndexView(unchangedDbId, l.t.orgId)))?.view)
      .toEqual({ state: 'ready' });

    const other = await seedWriteTenant({ jobStatus: 'completed' });
    const hidden = await inTamperedTransaction(
      orgContext(l.t.orgId),
      async () => {
        await db.execute(sql`UPDATE backup_tree_checkpoints SET org_id = ${other.orgId} WHERE id = ${l.checkpointId}`);
      },
      async () => (await readSnapshotIndexView(unchangedDbId, l.t.orgId))?.view,
    );
    expect(hidden).toEqual({ state: 'building' });
  });

  runDb('in system scope, a delta snapshot whose visible checkpoint names another org reads as empty', async () => {
    const l = await seedLineage();
    const other = await seedWriteTenant({ jobStatus: 'completed' });
    const result = await inTamperedTransaction(
      systemDbAccessContext('backupSnapshotIndexDeltaGate.test'),
      async () => {
        await db.execute(sql`UPDATE backup_tree_checkpoints SET org_id = ${other.orgId} WHERE id = ${l.checkpointId}`);
      },
      async () => {
        // System scope sees every header: only the read layer's org check can refuse it.
        expect(await headerVisible(l.checkpointId)).toBe(1);
        return readAll(l);
      },
    );
    expect(result).toEqual(EMPTY);
    // The same snapshot reads its full tree in system scope when the checkpoint matches.
    expect((await withDbAccessContext(systemDbAccessContext('backupSnapshotIndexDeltaGate.test'), () => readAll(l))).srv)
      .toEqual(['a.txt 10', 'b.txt 21', 'd.txt 22']);
  });

  runDb('a tombstone hides only the checkpoint entry it numbers, even among entries with the same path', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const run = randomBytes(6).toString('hex');
    const fullId = `snapshot-20261111T000001Z-${run}`;
    const incId = `snapshot-20261111T000002Z-${run}`;
    // Two entries for one path (a manifest does not make source_path unique), different objects.
    const first = { ...file('/srv/x.txt', fullId, 'x-one', 10) };
    const second = { ...file('/srv/x.txt', fullId, 'x-two', 10) };
    const checkpoint = [dir('/srv'), first, second];
    const checkpointId = await seedCheckpoint(
      { orgId: t.orgId, deviceId: t.deviceId, configId: t.configId, storageIdentity: WRITE_IDENTITY },
      checkpoint,
    );
    const dbId = await insertSnapshotRow(t, incId);
    const digest = sha(`manifest ${incId}`);
    const diff = await seedDeltaIndex(dbId, checkpointId, checkpoint, [dir('/srv'), first], digest);
    expect(diff).toEqual({ adds: [], tombstones: [{ entryNo: 3, sourcePath: '/srv/x.txt' }] });
    await getTestDb().execute(sql`
      INSERT INTO backup_snapshot_origins (snapshot_db_id, origin_snapshot_id, origin_org_id, origin_device_id,
        origin_storage_identity, provenance, object_count)
      VALUES (${dbId}, ${fullId}, ${t.orgId}, ${t.deviceId}, ${WRITE_IDENTITY}, 'live', 1)
    `);
    const read = await withDbAccessContext(orgContext(t.orgId), async () => {
      const authorize = async (k: string) => {
        const r = await authorizeExternalReference(db, {
          tokenId: 'token-11736-gate', snapshotDbId: dbId, key: k, originSnapshotId: fullId,
          orgId: t.orgId, deviceId: t.deviceId, pinnedStorageIdentity: WRITE_IDENTITY,
        });
        return r.ok ? true : r.reason;
      };
      return {
        search: (await searchSnapshotFiles({ snapshotDbId: dbId, query: 'x.txt', limit: 10, after: null })).entries.map((e) => e.path),
        count: await drizzleBrokeredReadStore.countIndexedFiles(dbId),
        keys: [...await drizzleBrokeredReadStore.filterIndexedKeys(dbId, [first.backupPath, second.backupPath], digest)],
        authorizeKept: await authorize(first.backupPath),
        authorizeTombstoned: await authorize(second.backupPath),
      };
    });
    expect(read).toEqual({
      search: ['/srv/x.txt'],
      count: 1,
      keys: [first.backupPath],
      authorizeKept: true,
      authorizeTombstoned: NOT_MEMBER,
    });
  });

  runDb('a tombstone row that carries an object key is never an entry or a grant of a delta snapshot', async () => {
    const l = await seedLineage();
    // gone.txt (checkpoint entry 4) is already tombstoned by the fixture. A second tombstone row for
    // it, written with the object's key instead of '', must not bring the key back.
    await getTestDb().execute(sql`
      INSERT INTO backup_snapshot_files (snapshot_db_id, source_path, backup_path, checkpoint_entry_no)
      VALUES (${l.deltaDbId}, '/srv/gone.txt', ${key(l.fullId, 'gone')}, 4)
    `);
    const read = await withDbAccessContext(orgContext(l.t.orgId), async () => {
      const r = await authorizeExternalReference(db, {
        tokenId: 'token-11736-gate', snapshotDbId: l.deltaDbId, key: key(l.fullId, 'gone'), originSnapshotId: l.fullId,
        orgId: l.t.orgId, deviceId: l.t.deviceId, pinnedStorageIdentity: WRITE_IDENTITY,
      });
      return {
        all: await readAll(l),
        authorizeGone: r.ok ? true : r.reason,
      };
    });
    expect(read.all.srv).toEqual(['a.txt 10', 'b.txt 21', 'd.txt 22']);
    expect(read.all.count).toBe(3);
    expect(read.all.keys).not.toContain(key(l.fullId, 'gone'));
    expect(read.authorizeGone).toBe(NOT_MEMBER);
  });

  runDb('the readiness probe sees a delta that tombstones every entry as not indexed', async () => {
    const l = await seedLineage();
    const emptiedId = `snapshot-20261111T000006Z-${randomBytes(6).toString('hex')}`;
    const emptiedDbId = await insertSnapshotRow(l.t, emptiedId);
    const diff = await seedDeltaIndex(emptiedDbId, l.checkpointId, l.checkpoint, [], sha(`manifest ${emptiedId}`));
    // It stores rows (one tombstone per entry), yet its tree is empty.
    expect([diff.adds.length, diff.tombstones.length]).toEqual([0, l.checkpoint.length]);
    await getTestDb().execute(sql`
      UPDATE backup_snapshots SET file_index_status = 'hydrating', file_index_hydrated_at = now(), file_count = NULL
      WHERE id = ${emptiedDbId}
    `);
    expect((await withDbAccessContext(orgContext(l.t.orgId), () => readSnapshotIndexView(emptiedDbId, l.t.orgId)))?.view)
      .toEqual({ state: 'building' });
  });
});
