/**
 * #11235 on real PostgreSQL: a hydrated index keeps the manifest's
 * content-less entries (empty and other recorded directories, symlinks), so it
 * lists the same tree the agent's inline rows do. Browse shows a directory
 * entry as a folder, search finds it as one, selection resolves it to the path
 * the agent restores, and none of them is a storage key.
 */
import './setup';

import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, runOutsideDbContext, withDbAccessContext } from '../../db';
import { hydrateSnapshotFileIndex } from '../../services/backupSnapshotFileIndex';
import {
  dirSegments,
  listSnapshotDirectory,
  resolveSelectedSnapshotPathsInDb,
  searchSnapshotFiles,
} from '../../services/backupSnapshotBrowse';
import { drizzleBrokeredReadStore } from '../../services/backupStorageSessionStore';
import { insertSnapshotRow, orgContext, seedWriteTenant } from './backupWriteFixtures';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const MOD_TIME = '2026-11-01T10:11:12Z';

/** The entries as agent/internal/backup/snapshot.go writes them. */
function manifestOf(snapshotId: string): Buffer {
  const key = (name: string) => `snapshots/${snapshotId}/files/${name}`;
  const files = [
    // A Windows folder recorded for its own ACL, with files beneath it.
    { sourcePath: 'C:\\Data\\Shared', backupPath: '', kind: 'dir', modTime: MOD_TIME },
    { sourcePath: 'C:\\Data\\Shared\\a.txt', backupPath: key('a'), size: 3, modTime: MOD_TIME },
    { sourcePath: 'C:\\Data\\Shared\\b.txt', backupPath: key('b'), size: 4, modTime: MOD_TIME },
    { sourcePath: 'C:\\Data\\Empty', backupPath: '', kind: 'dir', modTime: MOD_TIME },
    { sourcePath: 'C:\\Data\\link-to-a', backupPath: '', kind: 'symlink', linkTarget: 'Shared\\a.txt', modTime: MOD_TIME },
    { sourcePath: '/srv/empty', backupPath: '', kind: 'dir', modTime: MOD_TIME },
    { sourcePath: '/srv/current', backupPath: '', kind: 'symlink', linkTarget: 'releases/1', modTime: MOD_TIME },
    { sourcePath: '/srv/releases/1/app.bin', backupPath: key('app'), size: 9, modTime: MOD_TIME },
  ];
  return Buffer.from(JSON.stringify({ id: snapshotId, files }));
}

async function hydratedSnapshot() {
  const t = await seedWriteTenant({ jobStatus: 'completed' });
  const snapshotId = `snapshot-20261108T120000Z-${randomBytes(12).toString('hex')}`;
  const snapshotDbId = await insertSnapshotRow(t, snapshotId);
  const outcome = await runOutsideDbContext(() => hydrateSnapshotFileIndex(snapshotDbId, {
    includeUnreferenced: true,
    deps: { openManifest: async () => Readable.from([manifestOf(snapshotId)]) },
  }));
  const read = <T,>(fn: () => Promise<T>) => runOutsideDbContext(() => withDbAccessContext(orgContext(t.orgId), fn));
  return { snapshotDbId, outcome, read };
}

const shape = (entries: Array<{ name: string; type: string; path: string; fileCount?: number }>) =>
  entries.map((e) => [e.name, e.type, e.path, e.fileCount]);

describe('hydrated index with content-less entries (#11235)', () => {
  runDb('writes every manifest entry as a row, with the kind of each content-less one', async () => {
    const { snapshotDbId, outcome } = await hydratedSnapshot();

    expect(outcome).toMatchObject({ status: 'complete', entryCount: 8 });
    const rows = (await getTestDb().execute(sql`
      SELECT source_path, backup_path, kind FROM backup_snapshot_files
      WHERE snapshot_db_id = ${snapshotDbId} ORDER BY source_path COLLATE "C"
    `)) as unknown as Array<{ source_path: string; backup_path: string; kind: string | null }>;
    expect(rows.map((r) => [r.source_path, r.backup_path === '' ? '' : 'key', r.kind])).toEqual([
      ['/srv/current', '', 'symlink'],
      ['/srv/empty', '', 'dir'],
      ['/srv/releases/1/app.bin', 'key', null],
      ['C:\\Data\\Empty', '', 'dir'],
      ['C:\\Data\\Shared', '', 'dir'],
      ['C:\\Data\\Shared\\a.txt', 'key', null],
      ['C:\\Data\\Shared\\b.txt', 'key', null],
      ['C:\\Data\\link-to-a', '', 'symlink'],
    ]);
  });

  runDb('browse lists a directory entry once, as a folder, and counts only what is beneath it', async () => {
    const { snapshotDbId, read } = await hydratedSnapshot();
    const list = (dir: string) => read(() => listSnapshotDirectory({ snapshotDbId, segments: dirSegments(dir), limit: 50 }));

    expect(shape((await list('')).entries)).toEqual([
      ['C:', 'directory', '/C:', 3],
      ['srv', 'directory', '/srv', 2],
    ]);
    expect(shape((await list('/C:/Data')).entries)).toEqual([
      ['Empty', 'directory', '/C:/Data/Empty', 0],
      ['Shared', 'directory', '/C:/Data/Shared', 2],
      ['link-to-a', 'file', 'C:/Data/link-to-a', undefined],
    ]);
    expect(shape((await list('/srv')).entries)).toEqual([
      ['empty', 'directory', '/srv/empty', 0],
      ['releases', 'directory', '/srv/releases', 1],
      ['current', 'file', '/srv/current', undefined],
    ]);
    expect((await list('/C:/Data/Empty')).entries).toEqual([]);
  });

  runDb('search finds a directory entry as a folder at its browse path', async () => {
    const { snapshotDbId, read } = await hydratedSnapshot();
    const search = (query: string) => read(() => searchSnapshotFiles({ snapshotDbId, query, limit: 50, after: null }));

    const empty = (await search('empty')).entries.map((e) => [e.name, e.type, e.path]);
    expect(empty).toHaveLength(2);
    expect(empty).toEqual(expect.arrayContaining([
      ['Empty', 'directory', '/C:/Data/Empty'],
      ['empty', 'directory', '/srv/empty'],
    ]));
    expect((await search('link-to')).entries.map((e) => [e.name, e.type, e.path])).toEqual([
      ['link-to-a', 'file', 'C:/Data/link-to-a'],
    ]);
  });

  runDb('selection resolves an empty folder and a symlink to the paths the agent restores', async () => {
    const { snapshotDbId, read } = await hydratedSnapshot();
    const select = (paths: string[]) => read(() => resolveSelectedSnapshotPathsInDb(snapshotDbId, paths));

    expect(await select(['/C:/Data/Empty'])).toEqual({ ok: true, paths: ['C:\\Data\\Empty'] });
    expect(await select(['/srv/empty'])).toEqual({ ok: true, paths: ['/srv/empty'] });
    expect(await select(['C:/Data/link-to-a'])).toEqual({ ok: true, paths: ['C:\\Data\\link-to-a'] });
    expect(await select(['/srv/current'])).toEqual({ ok: true, paths: ['/srv/current'] });
  });

  runDb('a folder with its own entry still resolves to one prefix, not to a list of its files', async () => {
    const { snapshotDbId, read } = await hydratedSnapshot();

    expect(await read(() => resolveSelectedSnapshotPathsInDb(snapshotDbId, ['/C:/Data/Shared'])))
      .toEqual({ ok: true, paths: ['C:\\Data\\Shared'] });
  });

  runDb('a brokered session sizes its budget on storage keys only', async () => {
    const { snapshotDbId, read } = await hydratedSnapshot();

    expect(await read(() => drizzleBrokeredReadStore.countIndexedFiles(snapshotDbId))).toBe(3);
  });
});
