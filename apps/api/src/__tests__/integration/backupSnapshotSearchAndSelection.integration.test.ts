/**
 * #11026 W02 T4/T5 on real PostgreSQL: search over a snapshot's file index,
 * the browse and search statement timeouts, and selective-restore selection
 * walking the index in keyset pages.
 */
import './setup';

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
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
  IndexQueryTimeoutError,
  listSnapshotDirectory,
  resolveSelectedSnapshotPathsInDb,
  searchSnapshotFiles,
  SELECTION_PAGE_SIZE,
} from '../../services/backupSnapshotBrowse';

import { orgContext } from './backupWriteFixtures';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedSnapshot(paths: string[]) {
  const u = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [partner] = await db.insert(partners).values({
    name: `Search Partner ${u}`, slug: `search-partner-${u}`, type: 'msp', plan: 'pro', status: 'active',
  }).returning({ id: partners.id });
  const [org] = await db.insert(organizations).values({
    currencyCode: 'USD', partnerId: partner!.id, name: `Search Org ${u}`, slug: `search-org-${u}`,
    type: 'customer', status: 'active',
  }).returning({ id: organizations.id });
  const [site] = await db.insert(sites).values({ orgId: org!.id, name: `Search Site ${u}` }).returning({ id: sites.id });
  const [device] = await db.insert(devices).values({
    orgId: org!.id, siteId: site!.id, agentId: `search-agent-${u}`, hostname: `search-host-${u}`,
    osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
  }).returning({ id: devices.id });
  const [config] = await db.insert(backupConfigs).values({
    orgId: org!.id, name: `Search Config ${u}`, type: 'file', provider: 'local', providerConfig: {},
  }).returning({ id: backupConfigs.id });
  const [job] = await db.insert(backupJobs).values({
    orgId: org!.id, configId: config!.id, deviceId: device!.id, status: 'completed', startedAt: new Date(),
  }).returning({ id: backupJobs.id });
  const [snap] = await db.insert(backupSnapshots).values({
    orgId: org!.id, jobId: job!.id, deviceId: device!.id, configId: config!.id, snapshotId: `snap-${u}`,
    fileIndexStatus: 'agent',
  }).returning({ id: backupSnapshots.id, snapshotId: backupSnapshots.snapshotId, orgId: backupSnapshots.orgId, jobId: backupSnapshots.jobId, deviceId: backupSnapshots.deviceId });
  for (let i = 0; i < paths.length; i += 1000) {
    await db.insert(backupSnapshotFiles).values(paths.slice(i, i + 1000).map((p, j) => ({
      snapshotDbId: snap!.id, sourcePath: p, backupPath: `b/${i + j}`, size: 1,
    })));
  }
  return snap!;
}

/** Adds `count` rows `<prefix><n>` in one statement. */
async function seedMany(snapshotDbId: string, prefix: string, count: number) {
  await db.execute(sql`
    INSERT INTO backup_snapshot_files (snapshot_db_id, source_path, backup_path, size)
    SELECT ${snapshotDbId}, ${prefix} || lpad(g::text, 6, '0'), 'b/' || g, 1
    FROM generate_series(1, ${count}) g
  `);
}

async function attestMismatch(snap: { id: string; snapshotId: string; orgId: string; jobId: string; deviceId: string }) {
  const statement = JSON.stringify({ v: 1, snapshotId: snap.snapshotId });
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  await db.execute(sql`
    INSERT INTO backup_snapshot_attestations (org_id, snapshot_db_id, job_id, device_id, provider_snapshot_id, storage_identity,
      key_layout, verification_mode, accepted_via, result_received_at, format_version, statement, statement_sha256,
      manifest_key, manifest_sha256, manifest_size, status)
    VALUES (${snap.orgId}, ${snap.id}, ${snap.jobId}, ${snap.deviceId}, ${snap.snapshotId}, 's3::endpoint::bucket',
      'legacy_flat', 'server_fetched', 'agent_result', now(), 1, ${statement}, ${sha(statement)},
      ${`snapshots/${snap.snapshotId}/manifest.json`}, ${sha('m')}, 10, 'pending')
  `);
  await db.execute(sql`UPDATE backup_snapshot_attestations SET status = 'mismatch', verified_at = now() WHERE snapshot_db_id = ${snap.id}`);
}

const search = (snapshotDbId: string, query: string, opts: { limit?: number; after?: string | null } = {}) =>
  searchSnapshotFiles({ snapshotDbId, query, limit: opts.limit ?? 50, after: opts.after ?? null });

describe('searchSnapshotFiles', () => {
  const long = `/data/${'deep/'.repeat(700)}needle-at-the-end.txt`;
  const paths = [
    'C:\\Users\\alex\\Documents\\Quarterly Report.pdf',
    'C:\\Users\\alex\\Reports\\notes.txt',
    'C:\\Users\\alex\\100%_done.txt',
    'C:\\Users\\alex\\1000 done.txt',
    'C:\\Users\\alex\\x_y.txt',
    'C:\\Users\\alex\\xay.txt',
    '/home/zoë/日本語/ファイル.txt',
    '/home/zoë/caf\u0065\u0301.txt', // e + combining acute
    '/home/zoë/replacement-\uFFFD-char.txt',
    long,
  ];

  runDb('matches a substring in a file name and in a folder name, case-insensitively', async () => {
    await withSystemDbAccessContext(async () => {
      const snap = await seedSnapshot(paths);
      const byName = await search(snap.id, 'quarterly');
      expect(byName.entries.map((e) => e.path)).toEqual(['C:/Users/alex/Documents/Quarterly Report.pdf']);
      const byFolder = await search(snap.id, 'REPORTS');
      expect(byFolder.entries.map((e) => [e.name, e.path])).toEqual([['notes.txt', 'C:/Users/alex/Reports/notes.txt']]);
    });
  });

  runDb('treats % and _ as plain characters', async () => {
    await withSystemDbAccessContext(async () => {
      const snap = await seedSnapshot(paths);
      expect((await search(snap.id, '100%_')).entries.map((e) => e.name)).toEqual(['100%_done.txt']);
      expect((await search(snap.id, 'x_y')).entries.map((e) => e.name)).toEqual(['x_y.txt']);
      expect((await search(snap.id, '%%')).entries).toEqual([]);
    });
  });

  runDb('returns stored paths exactly, for long paths and names that do not look like ASCII', async () => {
    await withSystemDbAccessContext(async () => {
      const snap = await seedSnapshot(paths);
      expect((await search(snap.id, 'needle-at-the-end')).entries.map((e) => e.path)).toEqual([long]);
      expect((await search(snap.id, 'ファイル')).entries.map((e) => e.path)).toEqual(['/home/zoë/日本語/ファイル.txt']);
      expect((await search(snap.id, 'caf\u0065\u0301')).entries.map((e) => e.name)).toEqual(['caf\u0065\u0301.txt']);
      expect((await search(snap.id, '\uFFFD')).entries.map((e) => e.name)).toEqual(['replacement-\uFFFD-char.txt']);
    });
  });

  runDb('finds a stored Windows path whichever separator the person types', async () => {
    await withSystemDbAccessContext(async () => {
      const snap = await seedSnapshot(paths);
      const report = ['C:/Users/alex/Documents/Quarterly Report.pdf'];
      // The browser shows forward slashes, so that is what gets typed.
      expect((await search(snap.id, 'alex/documents/quarterly')).entries.map((e) => e.path)).toEqual(report);
      expect((await search(snap.id, 'alex\\documents\\quarterly')).entries.map((e) => e.path)).toEqual(report);
      // POSIX paths still match as stored.
      expect((await search(snap.id, 'zoë/日本語')).entries.map((e) => e.name)).toEqual(['ファイル.txt']);
    });
  });

  runDb("never reads another org's snapshot, by search or selection", async () => {
    // Each in its own transaction: one may not take a second partner's lock.
    const snap = await withSystemDbAccessContext(() => seedSnapshot(paths));
    const { orgId: otherOrgId } = await withSystemDbAccessContext(() => seedSnapshot(['C:\\other\\file.txt']));
    const asOrg = <T,>(orgId: string, fn: () => Promise<T>) =>
      runOutsideDbContext(() => withDbAccessContext(orgContext(orgId), fn));

    // The control: the same calls see the rows from inside the owning org.
    expect((await asOrg(snap.orgId, () => search(snap.id, 'quarterly'))).entries).toHaveLength(1);
    expect(await asOrg(snap.orgId, () => resolveSelectedSnapshotPathsInDb(snap.id, ['C:/Users/alex/Reports/notes.txt'])))
      .toEqual({ ok: true, paths: ['C:\\Users\\alex\\Reports\\notes.txt'] });

    expect((await asOrg(otherOrgId, () => search(snap.id, 'quarterly'))).entries).toEqual([]);
    expect(await asOrg(otherOrgId, () => resolveSelectedSnapshotPathsInDb(snap.id, ['C:/Users/alex/Reports/notes.txt'])))
      .toEqual({ ok: false, reason: 'no_readable_index' });
  });

  runDb('pages through matches, returning each once', async () => {
    await withSystemDbAccessContext(async () => {
      const snap = await seedSnapshot([]);
      await seedMany(snap.id, '/srv/match-', 237);
      await seedMany(snap.id, '/srv/other-', 50);
      const seen: string[] = [];
      let after: string | null = null;
      for (let pages = 0; pages < 10; pages += 1) {
        const page = await searchSnapshotFiles({ snapshotDbId: snap.id, query: 'match-', limit: 100, after });
        seen.push(...page.entries.map((e) => e.path));
        if (!page.nextCursor) break;
        after = Buffer.from(page.nextCursor, 'base64url').toString('utf8');
      }
      expect(seen).toHaveLength(237);
      expect(new Set(seen).size).toBe(237);
    });
  });

  runDb('reads nothing from an index that may not be listed', async () => {
    await withSystemDbAccessContext(async () => {
      const snap = await seedSnapshot(paths);
      await attestMismatch(snap);
      expect((await search(snap.id, 'alex')).entries).toEqual([]);
    });
  });

  runDb('a search past its statement timeout is IndexQueryTimeoutError, and the transaction stays usable', async () => {
    await withSystemDbAccessContext(async () => {
      const snap = await seedSnapshot([]);
      await seedMany(snap.id, '/srv/many/file-', 200_000);
      const failure = await searchSnapshotFiles({
        snapshotDbId: snap.id, query: 'no-such-file', limit: 50, after: null, statementTimeoutMs: 1,
      }).catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(IndexQueryTimeoutError);
      // Only the savepoint rolled back: the request can still answer.
      const [row] = await db.select({ id: backupSnapshots.id }).from(backupSnapshots).where(eq(backupSnapshots.id, snap.id));
      expect(row?.id).toBe(snap.id);
      // And the caller's own timeout is back in force.
      const [setting] = (await db.execute(sql`SELECT current_setting('statement_timeout') AS v`)) as unknown as Array<{ v: string }>;
      expect(setting!.v).not.toBe('1ms');
    });
  }, 120_000);

  runDb('a browse past its statement timeout is IndexQueryTimeoutError too', async () => {
    await withSystemDbAccessContext(async () => {
      const snap = await seedSnapshot([]);
      await seedMany(snap.id, '/srv/many/file-', 200_000);
      const failure = await listSnapshotDirectory({ snapshotDbId: snap.id, segments: [], limit: 50, statementTimeoutMs: 1 })
        .catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(IndexQueryTimeoutError);
      const ok = await listSnapshotDirectory({ snapshotDbId: snap.id, segments: [], limit: 50 });
      expect(ok.entries.map((e) => e.name)).toEqual(['srv']);
    });
  }, 120_000);

  runDb('a successful search leaves the transaction statement_timeout as it found it', async () => {
    await withSystemDbAccessContext(async () => {
      const snap = await seedSnapshot(paths);
      await db.execute(sql`SELECT set_config('statement_timeout', '0', true)`);
      await search(snap.id, 'alex');
      const [setting] = (await db.execute(sql`SELECT current_setting('statement_timeout') AS v`)) as unknown as Array<{ v: string }>;
      expect(setting!.v).toBe('0');
    });
  });
});

describe('resolveSelectedSnapshotPathsInDb', () => {
  runDb('a 50,000-file folder walked in pages resolves to one prefix', async () => {
    await withSystemDbAccessContext(async () => {
      const snap = await seedSnapshot(['C:\\Users\\alex\\keep.txt']);
      await seedMany(snap.id, 'C:\\Users\\alex\\big\\f', 50_000);
      expect(50_000).toBeGreaterThan(SELECTION_PAGE_SIZE * 2);
      expect(await resolveSelectedSnapshotPathsInDb(snap.id, ['/C:/Users/alex/big'])).toEqual({ ok: true, paths: ['C:\\Users\\alex\\big'] });
    });
  }, 120_000);

  runDb('a mixed-separator folder of 50,000 is too_many; of 100 it expands', async () => {
    await withSystemDbAccessContext(async () => {
      const snap = await seedSnapshot([]);
      await seedMany(snap.id, 'C:\\mix\\a', 25_000);
      await seedMany(snap.id, 'C:/mix/b', 25_000);
      expect(await resolveSelectedSnapshotPathsInDb(snap.id, ['C:/mix'])).toMatchObject({ ok: false, reason: 'too_many' });
    });
    // A second partner in its own transaction: partner locks are taken before org locks.
    await withSystemDbAccessContext(async () => {
      const small = await seedSnapshot([]);
      await seedMany(small.id, 'C:\\mix\\a', 50);
      await seedMany(small.id, 'C:/mix/b', 50);
      const result = await resolveSelectedSnapshotPathsInDb(small.id, ['C:/mix']);
      expect(result.ok && result.paths.length).toBe(100);
    });
  }, 120_000);

  runDb('a file and a folder sharing a name, a sibling sharing a prefix, and an ambiguous POSIX name', async () => {
    await withSystemDbAccessContext(async () => {
      const snap = await seedSnapshot(['/data/pick.txt', '/data/pick.txt/inner', '/data/pick.txtx/a', '/srv/x\\y', '/srv\\x/y']);
      expect(await resolveSelectedSnapshotPathsInDb(snap.id, ['/data/pick.txt'])).toEqual({ ok: true, paths: ['/data/pick.txt'] });
      expect(await resolveSelectedSnapshotPathsInDb(snap.id, ['/data/pick.txtx'])).toEqual({ ok: true, paths: ['/data/pick.txtx'] });
      expect(await resolveSelectedSnapshotPathsInDb(snap.id, ['/srv/x/y'])).toEqual({ ok: false, invalidPath: '/srv/x/y', reason: 'ambiguous' });
    });
  });

  runDb('rows repeated across a page boundary are read once', async () => {
    await withSystemDbAccessContext(async () => {
      const snap = await seedSnapshot([]);
      await seedMany(snap.id, '/d/f', SELECTION_PAGE_SIZE - 1);
      await db.insert(backupSnapshotFiles).values([
        { snapshotDbId: snap.id, sourcePath: '/d/zzz', backupPath: 'b/x', size: 1 },
        { snapshotDbId: snap.id, sourcePath: '/d/zzz', backupPath: 'b/y', size: 1 },
      ]);
      expect(await resolveSelectedSnapshotPathsInDb(snap.id, ['/d/zzz'])).toEqual({ ok: true, paths: ['/d/zzz'] });
    });
  });

  runDb('an index that may not be listed resolves nothing: no_readable_index', async () => {
    await withSystemDbAccessContext(async () => {
      const snap = await seedSnapshot(['/etc/hosts']);
      await attestMismatch(snap);
      expect(await resolveSelectedSnapshotPathsInDb(snap.id, ['/etc/hosts'])).toEqual({ ok: false, reason: 'no_readable_index' });
    });
  });
});
