/**
 * Real-PostgreSQL proof for the one-level, keyset-paged snapshot browse query
 * (#8230): grouping into directories/files, Windows vs POSIX roots (#7219),
 * paging, and that file paths stay selective-restore resolvable.
 */
import './setup';

import { createHash, randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
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
  readableSnapshotSourcePaths,
} from '../../services/backupSnapshotBrowse';
import { readSnapshotIndexView } from '../../services/backupSnapshotIndexView';

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

// #11026: a listing only ever comes from an index that may be trusted, decided
// in the same statement that reads the rows.
describe('the listing and selective restore read only a trustworthy index', () => {
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');

  async function attest(snapshotDbId: string, manifestSha256: string, status: 'pending' | 'verified' | 'mismatch') {
    const [snap] = await db
      .select({ orgId: backupSnapshots.orgId, jobId: backupSnapshots.jobId, deviceId: backupSnapshots.deviceId, snapshotId: backupSnapshots.snapshotId })
      .from(backupSnapshots)
      .where(eq(backupSnapshots.id, snapshotDbId));
    const statement = JSON.stringify({ v: 1, snapshotId: snap!.snapshotId });
    await db.execute(sql`
      INSERT INTO backup_snapshot_attestations (org_id, snapshot_db_id, job_id, device_id, provider_snapshot_id, storage_identity,
        key_layout, verification_mode, accepted_via, result_received_at, format_version, statement, statement_sha256,
        manifest_key, manifest_sha256, manifest_size, status)
      VALUES (${snap!.orgId}, ${snapshotDbId}, ${snap!.jobId}, ${snap!.deviceId}, ${snap!.snapshotId}, 's3::endpoint::bucket',
        'legacy_flat', 'server_fetched', 'agent_result', now(), 1, ${statement}, ${sha(statement)},
        ${`snapshots/${snap!.snapshotId}/manifest.json`}, ${manifestSha256}, 10, 'pending')
    `);
    if (status !== 'pending') {
      await db.execute(sql`UPDATE backup_snapshot_attestations SET status = ${status}, verified_at = now() WHERE snapshot_db_id = ${snapshotDbId}`);
    }
  }

  async function setIndex(snapshotDbId: string, values: { status: string; digest?: string | null; error?: string | null; integrity?: string }) {
    await db.update(backupSnapshots).set({
      fileIndexStatus: values.status,
      fileIndexManifestSha256: values.digest ?? null,
      fileIndexError: values.error ?? null,
      ...(values.integrity ? { integrityStatus: values.integrity } : {}),
    }).where(eq(backupSnapshots.id, snapshotDbId));
  }

  const listed = async (snapshotDbId: string) =>
    (await listSnapshotDirectory({ snapshotDbId, segments: [], limit: 50 })).entries.map((e) => e.name);

  const seed = () => seedSnapshot([{ p: '/etc/hosts' }, { p: '/etc/passwd' }]);

  runDb('an agent snapshot lists normally, with or without a pending attestation', async () => {
    await withSystemDbAccessContext(async () => {
      const id = await seed();
      await setIndex(id, { status: 'agent' });
      expect(await listed(id)).toEqual(['etc']);
      expect(await readableSnapshotSourcePaths(id)).toEqual(expect.arrayContaining(['/etc/hosts', '/etc/passwd']));
      await attest(id, sha('manifest'), 'pending');
      expect(await listed(id)).toEqual(['etc']);
      expect(await readableSnapshotSourcePaths(id)).toHaveLength(2);
    });
  });

  runDb('a snapshot with rows and a mismatched attestation returns nothing, whatever its status', async () => {
    await withSystemDbAccessContext(async () => {
      const id = await seed();
      await attest(id, sha('manifest'), 'mismatch');
      for (const status of ['none', 'agent', 'hydrating', 'complete', 'failed']) {
        await setIndex(id, { status, digest: sha('manifest'), error: status === 'failed' ? 'provider_error: x' : null });
        expect(await listed(id)).toEqual([]);
        expect(await readableSnapshotSourcePaths(id)).toEqual([]);
      }
    });
  });

  runDb('integrity_status attestation_failed with no attestation row returns nothing', async () => {
    await withSystemDbAccessContext(async () => {
      const id = await seed();
      await setIndex(id, { status: 'agent', integrity: 'attestation_failed' });
      expect(await listed(id)).toEqual([]);
      expect(await readableSnapshotSourcePaths(id)).toEqual([]);
    });
  });

  runDb('a complete index built from other bytes returns nothing; built from the attested bytes it lists', async () => {
    await withSystemDbAccessContext(async () => {
      const id = await seed();
      await attest(id, sha('manifest'), 'verified');
      await setIndex(id, { status: 'complete', digest: sha('other') });
      expect(await listed(id)).toEqual([]);
      expect(await readableSnapshotSourcePaths(id)).toEqual([]);
      await setIndex(id, { status: 'complete', digest: sha('manifest') });
      expect(await listed(id)).toEqual(['etc']);
      expect(await readableSnapshotSourcePaths(id)).toHaveLength(2);
    });
  });

  runDb('hydrating and failed rows built from other bytes are not readable', async () => {
    await withSystemDbAccessContext(async () => {
      const id = await seed();
      await attest(id, sha('manifest'), 'pending');
      await setIndex(id, { status: 'hydrating', digest: sha('other') });
      expect(await listed(id)).toEqual([]);
      await setIndex(id, { status: 'failed', digest: sha('other'), error: 'provider_error: x' });
      expect(await listed(id)).toEqual([]);
      await setIndex(id, { status: 'failed', digest: sha('manifest'), error: 'provider_error: x' });
      expect(await listed(id)).toEqual(['etc']);
    });
  });

  runDb('a failed index whose failure was the attestation is not readable, even with matching rows', async () => {
    await withSystemDbAccessContext(async () => {
      const id = await seed();
      await setIndex(id, { status: 'failed', error: 'manifest_differs_from_attestation: digest' });
      expect(await listed(id)).toEqual([]);
      await setIndex(id, { status: 'failed', error: 'attestation_failed: no match' });
      expect(await listed(id)).toEqual([]);
    });
  });

  // The listing gate (SQL) and the view (TS) state one rule twice. Over the
  // whole grid, with rows present, the view says ready exactly when rows list.
  runDb('the view says ready exactly when the gate lists rows, over status x attestation x digest x error', async () => {
    const attested = sha('manifest');
    const variants: Array<{ name: string; attestation: null | { digest: string; status: 'pending' | 'verified' | 'mismatch' }; integrity?: string }> = [
      { name: 'no attestation', attestation: null },
      { name: 'refused when reported', attestation: null, integrity: 'attestation_failed' },
      { name: 'pending', attestation: { digest: attested, status: 'pending' } },
      { name: 'verified', attestation: { digest: attested, status: 'verified' } },
      { name: 'mismatch', attestation: { digest: attested, status: 'mismatch' } },
    ];
    const statuses = ['none', 'agent', 'hydrating', 'complete', 'failed'];
    const digests = [null, attested, sha('other')];
    const errors = ['provider_error: x', 'manifest_invalid: x', 'attestation_failed: x', 'manifest_differs_from_attestation: x'];
    const disagreements: string[] = [];
    let checked = 0;

    // One tenant seed per transaction (the partner export lock hierarchy).
    for (const variant of variants) {
      await withSystemDbAccessContext(async () => {
        const id = await seed();
        const [own] = await db.select({ orgId: backupSnapshots.orgId }).from(backupSnapshots).where(eq(backupSnapshots.id, id));
        if (variant.attestation) await attest(id, variant.attestation.digest, variant.attestation.status);
        for (const status of statuses) {
          for (const digest of digests) {
            for (const error of status === 'failed' ? errors : [null]) {
              await setIndex(id, { status, digest, error, ...(variant.integrity ? { integrity: variant.integrity } : {}) });
              const listedAny = (await listed(id)).length > 0;
              const pathsAny = (await readableSnapshotSourcePaths(id)).length > 0;
              const view = await readSnapshotIndexView(id, own!.orgId);
              const ready = view?.view.state === 'ready';
              checked += 1;
              if (ready !== listedAny || listedAny !== pathsAny) {
                disagreements.push(`${variant.name} / ${status} / digest=${digest === null ? 'null' : digest === attested ? 'attested' : 'other'} / ${error}: view=${view?.view.state} listed=${listedAny} paths=${pathsAny}`);
              }
            }
          }
        }
      });
    }

    expect(checked).toBe(variants.length * (4 * digests.length + errors.length * digests.length));
    expect(disagreements).toEqual([]);
  });

  runDb('the view read reports the rows it can see and agrees with the condition', async () => {
    await withSystemDbAccessContext(async () => {
      const id = await seed();
      const [own] = await db.select({ orgId: backupSnapshots.orgId }).from(backupSnapshots).where(eq(backupSnapshots.id, id));
      await setIndex(id, { status: 'none' });
      expect(await readSnapshotIndexView(id, own!.orgId)).toMatchObject({ id, view: { state: 'ready' }, shouldRequestHydration: false });

      await db.delete(backupSnapshotFiles).where(eq(backupSnapshotFiles.snapshotDbId, id));
      await db.update(backupSnapshots).set({ fileCount: 18000 }).where(eq(backupSnapshots.id, id));
      expect(await readSnapshotIndexView(id, own!.orgId)).toMatchObject({ view: { state: 'building' }, shouldRequestHydration: true, fileCount: 18000 });

      expect(await readSnapshotIndexView(id, randomUUID())).toBeNull();
    });
  });
});
