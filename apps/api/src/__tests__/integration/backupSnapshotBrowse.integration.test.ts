/**
 * Real-PostgreSQL proof for the one-level, keyset-paged snapshot browse query
 * (#8230): grouping into directories/files, Windows vs POSIX roots (#7219),
 * paging, and that file paths stay selective-restore resolvable.
 */
import './setup';

import { it, expect } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import {
  backupConfigs,
  backupJobs,
  backupSnapshotFiles,
  backupSnapshots,
  devices,
  organizations,
  partners,
  sites,
} from '../../db/schema';
import {
  decodeBrowseCursor,
  dirSegments,
  listSnapshotDirectory,
} from '../../services/backupSnapshotBrowse';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedSnapshot(paths: Array<{ p: string; size?: number }>) {
  const u = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [partner] = await db.insert(partners).values({
    name: `Browse Partner ${u}`, slug: `browse-partner-${u}`, type: 'msp', plan: 'pro', status: 'active',
  }).returning({ id: partners.id });
  const [org] = await db.insert(organizations).values({
    currencyCode: 'USD', partnerId: partner!.id, name: `Browse Org ${u}`, slug: `browse-org-${u}`,
    type: 'customer', status: 'active',
  }).returning({ id: organizations.id });
  const [site] = await db.insert(sites).values({ orgId: org!.id, name: `Browse Site ${u}` }).returning({ id: sites.id });
  const [device] = await db.insert(devices).values({
    orgId: org!.id, siteId: site!.id, agentId: `browse-agent-${u}`, hostname: `browse-host-${u}`,
    osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
  }).returning({ id: devices.id });
  const [config] = await db.insert(backupConfigs).values({
    orgId: org!.id, name: `Browse Config ${u}`, type: 'file', provider: 'local', providerConfig: {},
  }).returning({ id: backupConfigs.id });
  const [job] = await db.insert(backupJobs).values({
    orgId: org!.id, configId: config!.id, deviceId: device!.id, status: 'completed', startedAt: new Date(),
  }).returning({ id: backupJobs.id });
  const [snap] = await db.insert(backupSnapshots).values({
    orgId: org!.id, jobId: job!.id, deviceId: device!.id, configId: config!.id, snapshotId: `snap-${u}`,
  }).returning({ id: backupSnapshots.id });
  await db.insert(backupSnapshotFiles).values(paths.map((f, i) => ({
    snapshotDbId: snap!.id, sourcePath: f.p, backupPath: `b/${i}`, size: f.size ?? 1,
  })));
  return snap!.id;
}

runDb('lists one directory level, dirs first, preserving Windows/POSIX roots and file paths', async () => {
  const id = await withSystemDbAccessContext(() => seedSnapshot([
    { p: 'C:\\assure\\src\\a.txt', size: 5 },
    { p: 'C:\\assure\\src\\b.txt' },
    { p: 'C:\\assure\\readme.md' },
    { p: 'C:\\other\\x.bin' },
    { p: '/etc/hosts' },
    { p: '/etc/ssh/sshd_config' },
  ]));

  await withSystemDbAccessContext(async () => {
    const root = await listSnapshotDirectory({ snapshotDbId: id, segments: [], limit: 50 });
    expect(root.entries.map((e) => [e.name, e.type, e.path])).toEqual([
      ['C:', 'directory', '/C:'],
      ['etc', 'directory', '/etc'],
    ]);

    const assure = await listSnapshotDirectory({ snapshotDbId: id, segments: dirSegments('/C:/assure'), limit: 50 });
    expect(assure.entries.map((e) => [e.name, e.type, e.path])).toEqual([
      ['src', 'directory', '/C:/assure/src'],
      ['readme.md', 'file', 'C:/assure/readme.md'],
    ]);

    const src = await listSnapshotDirectory({ snapshotDbId: id, segments: dirSegments('C:\\assure\\src'), limit: 50 });
    expect(src.entries).toMatchObject([
      { name: 'a.txt', type: 'file', path: 'C:/assure/src/a.txt', sizeBytes: 5 },
      { name: 'b.txt', type: 'file', path: 'C:/assure/src/b.txt' },
    ]);

    const etc = await listSnapshotDirectory({ snapshotDbId: id, segments: ['etc'], limit: 50 });
    expect(etc.entries.map((e) => [e.name, e.path])).toEqual([
      ['ssh', '/etc/ssh'],
      ['hosts', '/etc/hosts'],
    ]);

    // A prefix that merely starts with the same characters must not match.
    const none = await listSnapshotDirectory({ snapshotDbId: id, segments: ['C:', 'assur'], limit: 50 });
    expect(none.entries).toEqual([]);
  });
});

runDb('pages with a keyset cursor without duplicates or gaps', async () => {
  const id = await withSystemDbAccessContext(() => seedSnapshot([
    ...Array.from({ length: 5 }, (_, i) => ({ p: `/d/dir${i}/f` })),
    ...Array.from({ length: 5 }, (_, i) => ({ p: `/d/file${i}.txt` })),
  ]));

  await withSystemDbAccessContext(async () => {
    const seen: string[] = [];
    let cursor: ReturnType<typeof decodeBrowseCursor> = null;
    let pages = 0;
    for (;;) {
      const page = await listSnapshotDirectory({ snapshotDbId: id, segments: ['d'], limit: 3, cursor });
      pages += 1;
      seen.push(...page.entries.map((e) => e.name));
      if (!page.nextCursor) break;
      cursor = decodeBrowseCursor(page.nextCursor);
      expect(cursor).not.toBeNull();
    }
    expect(pages).toBe(4);
    expect(seen).toEqual([
      'dir0', 'dir1', 'dir2', 'dir3', 'dir4',
      'file0.txt', 'file1.txt', 'file2.txt', 'file3.txt', 'file4.txt',
    ]);
  });
});
