/**
 * #11736: what every reader of a snapshot's file index returns, for a full
 * snapshot followed by incrementals that replace, delete and re-add entries.
 *
 * The contract the storage change in #11736 step 2 has to keep. Today each
 * snapshot's tree is stored whole; step 2 stores an incremental as
 * differences against a shared checkpoint. Whatever the storage, every
 * snapshot below must browse, search, select, count and authorize exactly its
 * own tree:
 *
 *  - a replaced file is listed at its new size and authorizes only its new
 *    object, never the one it replaced (a stale entry must not authorize);
 *  - a deleted file or folder is gone from that snapshot onwards, and back
 *    when it is re-added, as a new object;
 *  - an incremental with no changes still has a complete tree;
 *  - another lineage's entries (another device, same org and paths) never
 *    leak into this one.
 *
 * Rows are written through `publishIndex`, the one seam step 2 redirects to
 * its publisher. Every assertion goes through the public reader functions.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/backupSnapshotIndexChain.integration.test.ts
 */
import './setup';

import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext } from '../../db';
import {
  listSnapshotDirectory,
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
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

type Entry = { sourcePath: string; backupPath: string; size: number | null; kind: 'dir' | 'symlink' | null };

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const key = (snapshotId: string, name: string) => `snapshots/${snapshotId}/files/${name}`;

/**
 * Writes `entries` as the snapshot's complete, server-built index (status
 * 'complete', bound to `digest`). #11736 step 2 replaces the body with its
 * publisher; the assertions below must not change.
 */
async function publishIndex(snapshotDbId: string, entries: Entry[], digest: string): Promise<void> {
  const admin = getTestDb();
  for (const e of entries) {
    await admin.execute(sql`
      INSERT INTO backup_snapshot_files (snapshot_db_id, source_path, backup_path, size, kind)
      VALUES (${snapshotDbId}, ${e.sourcePath}, ${e.backupPath}, ${e.size}, ${e.kind})
    `);
  }
  await admin.execute(sql`
    UPDATE backup_snapshots
    SET file_index_status = 'complete', file_index_manifest_sha256 = ${digest}, file_index_hydrated_at = now()
    WHERE id = ${snapshotDbId}
  `);
}

async function recordOrigin(t: WriteTenant, snapshotDbId: string, originSnapshotId: string): Promise<void> {
  await getTestDb().execute(sql`
    INSERT INTO backup_snapshot_origins (snapshot_db_id, origin_snapshot_id, origin_org_id, origin_device_id,
      origin_storage_identity, provenance, object_count)
    VALUES (${snapshotDbId}, ${originSnapshotId}, ${t.orgId}, ${t.deviceId}, ${WRITE_IDENTITY}, 'live', 1)
  `);
}

type Step = { put?: Entry[]; remove?: string[] };

type Chain = {
  t: WriteTenant;
  ids: string[];
  dbIds: string[];
  digests: string[];
  trees: Entry[][];
  otherDbId: string;
  allKeys: string[];
};

/**
 * One device's full snapshot S1 and four incrementals, each indexed as the
 * synthetic full its manifest is (unchanged entries keep the older object
 * key), plus one snapshot of another device in the same org.
 */
async function seedChain(): Promise<Chain> {
  const t = await seedWriteTenant({ jobStatus: 'completed' });
  const run = randomBytes(6).toString('hex');
  const ids = [1, 2, 3, 4, 5].map((n) => `snapshot-20261111T00000${n}Z-${run}`);
  const [s1, s2, , s4] = ids as [string, string, string, string, string];
  const dir = (p: string): Entry => ({ sourcePath: p, backupPath: '', size: null, kind: 'dir' });
  const file = (p: string, snapshotId: string, name: string, size: number): Entry => (
    { sourcePath: p, backupPath: key(snapshotId, name), size, kind: null }
  );

  const full: Entry[] = [
    dir('/srv/data'),
    file('/srv/data/a.txt', s1, 'a', 10),
    file('/srv/data/b.txt', s1, 'b', 11),
    file('/srv/data/gone.txt', s1, 'gone', 12),
    dir('/srv/data/sub'),
    file('/srv/data/sub/c.txt', s1, 'c', 13),
    { sourcePath: '/srv/data/link', backupPath: '', size: 0, kind: 'symlink' },
  ];
  const steps: Step[] = [
    // S2: b replaced, gone.txt deleted, d.txt added.
    { put: [file('/srv/data/b.txt', s2, 'b', 21), file('/srv/data/d.txt', s2, 'd', 22)], remove: ['/srv/data/gone.txt'] },
    // S3: the sub folder (its entry and its file) and the symlink deleted.
    { remove: ['/srv/data/sub', '/srv/data/sub/c.txt', '/srv/data/link'] },
    // S4: gone.txt and sub/c.txt re-added as new objects, a.txt replaced.
    {
      put: [
        file('/srv/data/gone.txt', s4, 'gone', 42),
        dir('/srv/data/sub'),
        file('/srv/data/sub/c.txt', s4, 'c', 43),
        file('/srv/data/a.txt', s4, 'a', 40),
      ],
    },
    // S5: nothing changed; every entry is a reference.
    {},
  ];

  const trees: Entry[][] = [full];
  for (const step of steps) {
    const byPath = new Map(trees[trees.length - 1]!.map((e) => [e.sourcePath, e]));
    for (const p of step.remove ?? []) byPath.delete(p);
    for (const e of step.put ?? []) byPath.set(e.sourcePath, e);
    trees.push([...byPath.values()]);
  }

  const dbIds: string[] = [];
  const digests: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const dbId = await insertSnapshotRow(t, ids[i]!);
    const digest = sha(`manifest ${ids[i]}`);
    await publishIndex(dbId, trees[i]!, digest);
    dbIds.push(dbId);
    digests.push(digest);
  }

  // Another device of the same org, same paths, its own objects.
  const otherDevice = await seedWriteDevice(t.orgId, t.siteId);
  const otherId = `snapshot-20261111T000009Z-${run}`;
  const otherDbId = await insertSnapshotRow({ ...t, deviceId: otherDevice }, otherId);
  await publishIndex(otherDbId, [
    file('/srv/data/a.txt', otherId, 'a', 99),
    file('/srv/data/other-only.txt', otherId, 'other', 98),
  ], sha(`manifest ${otherId}`));

  const allKeys = [...new Set([
    ...trees.flat().map((e) => e.backupPath).filter(Boolean),
    key(otherId, 'a'),
    key(otherId, 'other'),
  ])];
  return { t, ids, dbIds, digests, trees, otherDbId, allKeys };
}

const inOrg = <T>(orgId: string, fn: () => Promise<T>) => withDbAccessContext(orgContext(orgId), fn);

async function browse(orgId: string, snapshotDbId: string, segments: string[]) {
  const page = await inOrg(orgId, () => listSnapshotDirectory({ snapshotDbId, segments, limit: 100 }));
  return page.entries.map((e) => (e.type === 'directory'
    ? `${e.name}/ (${e.fileCount})`
    : `${e.name} ${e.sizeBytes}`));
}

describe('a full snapshot and its incrementals each read as their own complete tree (#11736)', () => {
  runDb('browse lists each snapshot\'s own entries at their own versions', async () => {
    const c = await seedChain();
    const [s1, s2, s3, s4, s5] = c.dbIds as [string, string, string, string, string];

    // File counts include the symlink, never directory entries.
    expect(await browse(c.t.orgId, s1, [])).toEqual(['srv/ (5)']);
    expect(await browse(c.t.orgId, s3, [])).toEqual(['srv/ (3)']);
    expect(await browse(c.t.orgId, s5, [])).toEqual(['srv/ (5)']);

    expect(await browse(c.t.orgId, s1, ['srv', 'data'])).toEqual(['sub/ (1)', 'a.txt 10', 'b.txt 11', 'gone.txt 12', 'link 0']);
    expect(await browse(c.t.orgId, s2, ['srv', 'data'])).toEqual(['sub/ (1)', 'a.txt 10', 'b.txt 21', 'd.txt 22', 'link 0']);
    expect(await browse(c.t.orgId, s3, ['srv', 'data'])).toEqual(['a.txt 10', 'b.txt 21', 'd.txt 22']);
    expect(await browse(c.t.orgId, s4, ['srv', 'data'])).toEqual(['sub/ (1)', 'a.txt 40', 'b.txt 21', 'd.txt 22', 'gone.txt 42']);
    expect(await browse(c.t.orgId, s5, ['srv', 'data'])).toEqual(['sub/ (1)', 'a.txt 40', 'b.txt 21', 'd.txt 22', 'gone.txt 42']);

    expect(await browse(c.t.orgId, s3, ['srv', 'data', 'sub'])).toEqual([]);
    expect(await browse(c.t.orgId, s4, ['srv', 'data', 'sub'])).toEqual(['c.txt 43']);
  });

  runDb('search finds an entry only in the snapshots that hold it', async () => {
    const c = await seedChain();
    const search = (snapshotDbId: string, query: string) => inOrg(c.t.orgId, async () =>
      (await searchSnapshotFiles({ snapshotDbId, query, limit: 50, after: null })).entries.map((e) => `${e.path} ${e.sizeBytes ?? '-'}`));

    const gone = await Promise.all(c.dbIds.map((id) => search(id, 'gone')));
    expect(gone).toEqual([['/srv/data/gone.txt 12'], [], [], ['/srv/data/gone.txt 42'], ['/srv/data/gone.txt 42']]);
    const sub = await Promise.all(c.dbIds.map((id) => search(id, 'sub')));
    expect(sub).toEqual([
      ['/srv/data/sub -', '/srv/data/sub/c.txt 13'],
      ['/srv/data/sub -', '/srv/data/sub/c.txt 13'],
      [],
      ['/srv/data/sub -', '/srv/data/sub/c.txt 43'],
      ['/srv/data/sub -', '/srv/data/sub/c.txt 43'],
    ]);
    expect(await search(c.dbIds[0]!, 'other-only')).toEqual([]);
    expect(await search(c.dbIds[2]!, '.txt')).toEqual(['/srv/data/a.txt 10', '/srv/data/b.txt 21', '/srv/data/d.txt 22']);
  });

  runDb('selective restore resolves only what the snapshot holds', async () => {
    const c = await seedChain();
    const select = (i: number, paths: string[]) => inOrg(c.t.orgId, () => resolveSelectedSnapshotPathsInDb(c.dbIds[i]!, paths));

    expect(await select(0, ['/srv/data/gone.txt'])).toEqual({ ok: true, paths: ['/srv/data/gone.txt'] });
    expect(await select(1, ['/srv/data/gone.txt'])).toEqual({ ok: false, invalidPath: '/srv/data/gone.txt', reason: 'not_found' });
    expect(await select(3, ['/srv/data/gone.txt'])).toEqual({ ok: true, paths: ['/srv/data/gone.txt'] });

    expect(await select(2, ['/srv/data/sub'])).toEqual({ ok: false, invalidPath: '/srv/data/sub', reason: 'not_found' });
    expect(await select(4, ['/srv/data/sub/c.txt', '/srv/data/d.txt'])).toEqual({ ok: true, paths: ['/srv/data/sub/c.txt', '/srv/data/d.txt'] });
    expect(await select(0, ['/srv/data/other-only.txt'])).toEqual({ ok: false, invalidPath: '/srv/data/other-only.txt', reason: 'not_found' });
  });

  runDb('the readiness probe sees an incremental with no changes as indexed', async () => {
    const c = await seedChain();
    const empty = await insertSnapshotRow(c.t, `snapshot-20261111T000010Z-${randomBytes(6).toString('hex')}`);
    for (const id of [c.dbIds[4]!, empty]) {
      await getTestDb().execute(sql`
        UPDATE backup_snapshots SET file_index_status = 'hydrating', file_index_hydrated_at = now(), file_count = NULL WHERE id = ${id}
      `);
    }
    // 'hydrating' is the state where rows alone decide: listed when present, building when not.
    expect((await inOrg(c.t.orgId, () => readSnapshotIndexView(c.dbIds[4]!, c.t.orgId)))?.view).toEqual({ state: 'ready' });
    expect((await inOrg(c.t.orgId, () => readSnapshotIndexView(empty, c.t.orgId)))?.view).toEqual({ state: 'building' });
  });
});

describe('restore authorization follows each snapshot\'s own tree (#11736)', () => {
  runDb('brokered key grants: exactly the snapshot\'s current objects, never a replaced, deleted or other-lineage one', async () => {
    const c = await seedChain();
    const [s1, s2, , s4] = c.ids as [string, string, string, string, string];
    const members = async (i: number) => [...await inOrg(c.t.orgId, () =>
      drizzleBrokeredReadStore.filterIndexedKeys(c.dbIds[i]!, c.allKeys, c.digests[i]!))].sort();

    expect(await members(0)).toEqual([key(s1, 'a'), key(s1, 'b'), key(s1, 'c'), key(s1, 'gone')].sort());
    // b replaced, gone deleted: the S1 objects for both stop authorizing.
    expect(await members(1)).toEqual([key(s1, 'a'), key(s1, 'c'), key(s2, 'b'), key(s2, 'd')].sort());
    expect(await members(2)).toEqual([key(s1, 'a'), key(s2, 'b'), key(s2, 'd')].sort());
    // Re-added entries authorize their new objects only; a replaced a.txt drops S1's.
    const s4Members = [key(s2, 'b'), key(s2, 'd'), key(s4, 'a'), key(s4, 'c'), key(s4, 'gone')].sort();
    expect(await members(3)).toEqual(s4Members);
    expect(await members(4)).toEqual(s4Members);

    // A key list holding only stale keys authorizes nothing.
    expect([...await inOrg(c.t.orgId, () => drizzleBrokeredReadStore.filterIndexedKeys(
      c.dbIds[3]!, [key(s1, 'a'), key(s1, 'b'), key(s1, 'c'), key(s1, 'gone')], c.digests[3]!))]).toEqual([]);
  });

  runDb('the session key budget counts each snapshot\'s content entries', async () => {
    const c = await seedChain();
    const counts = await Promise.all(c.dbIds.map((id) => inOrg(c.t.orgId, () => drizzleBrokeredReadStore.countIndexedFiles(id))));
    // Directory and symlink entries name no object.
    expect(counts).toEqual([4, 4, 3, 5, 5]);
  });

  runDb('recovery downloads: a referenced object authorizes, the object it replaced does not', async () => {
    const c = await seedChain();
    const [s1, s2, , s4] = c.ids as [string, string, string, string, string];
    const s4Db = c.dbIds[3]!;
    // Origins for both older snapshots are verified, so only membership decides.
    await recordOrigin(c.t, s4Db, s1);
    await recordOrigin(c.t, s4Db, s2);
    const authorize = (k: string, originSnapshotId: string) => inOrg(c.t.orgId, () => authorizeExternalReference(db, {
      tokenId: 'token-11736', snapshotDbId: s4Db, key: k, originSnapshotId,
      orgId: c.t.orgId, deviceId: c.t.deviceId, pinnedStorageIdentity: WRITE_IDENTITY,
    }));

    expect(await authorize(key(s2, 'b'), s2)).toEqual({ ok: true, originStoragePrefix: null });
    const notMember = { ok: false, reason: 'key is not a member of the snapshot file index' };
    expect(await authorize(key(s1, 'a'), s1)).toEqual(notMember); // replaced in S4
    expect(await authorize(key(s1, 'c'), s1)).toEqual(notMember); // deleted in S3, re-added as a new object in S4
    expect(await authorize(key(s1, 'gone'), s1)).toEqual(notMember); // deleted in S2, re-added in S4
    expect(await authorize(key(s1, 'b'), s1)).toEqual(notMember); // replaced in S2
  });
});
