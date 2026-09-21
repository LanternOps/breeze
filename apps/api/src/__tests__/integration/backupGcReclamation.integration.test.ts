import './setup';

import { mkdtemp, mkdir, writeFile, utimes, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  backupConfigs,
  backupJobs,
  backupSnapshots,
  backupSnapshotRetirements,
  devices,
  organizations,
  partners,
  sites,
} from '../../db/schema';
import { sweepUnreferencedBackupObjects } from '../../jobs/backupRetention';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function writeAged(root: string, relPath: string, ageMs: number, contents = 'x'): Promise<void> {
  const full = join(root, relPath);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, contents);
  const t = new Date(Date.now() - ageMs);
  await utimes(full, t, t);
}

async function listAll(root: string, prefix = ''): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listAll(root, rel)));
    else out.push(rel);
  }
  return out;
}

async function seedOrgDeviceConfig(unique: string, rootPath: string, backupVersion = '0.112.0') {
  const [partner] = await db.insert(partners).values({
    name: `GC Partner ${unique}`, slug: `gc-partner-${unique}`, type: 'msp', plan: 'pro', status: 'active',
  }).returning({ id: partners.id });
  const [org] = await db.insert(organizations).values({
    currencyCode: 'USD', partnerId: partner!.id, name: `GC Org ${unique}`, slug: `gc-org-${unique}`, type: 'customer', status: 'active',
  }).returning({ id: organizations.id });
  const [site] = await db.insert(sites).values({ orgId: org!.id, name: `GC Site ${unique}` }).returning({ id: sites.id });
  const [device] = await db.insert(devices).values({
    orgId: org!.id, siteId: site!.id, agentId: `gc-agent-${unique}`, hostname: `gc-host-${unique}`,
    osType: 'linux', osVersion: '1', architecture: 'x86_64', agentVersion: '0.0.0-test',
    backupVersion, status: 'online',
  }).returning({ id: devices.id });
  const [config] = await db.insert(backupConfigs).values({
    orgId: org!.id, name: `GC Config ${unique}`, type: 'file', provider: 'local', providerConfig: { path: rootPath },
  }).returning({ id: backupConfigs.id });
  const identity = `local::${rootPath}`;
  return { orgId: org!.id, deviceId: device!.id, configId: config!.id, identity };
}

async function insertSnapshotRow(params: {
  orgId: string; deviceId: string; configId: string; snapshotId: string; identity: string;
  expiresAt?: Date | null; backupType?: 'file' | 'system_image' | 'application' | 'database';
}) {
  const [job] = await db.insert(backupJobs).values({
    orgId: params.orgId, configId: params.configId, deviceId: params.deviceId, status: 'completed', snapshotId: params.snapshotId,
  }).returning({ id: backupJobs.id });
  await db.insert(backupSnapshots).values({
    orgId: params.orgId, jobId: job!.id, deviceId: params.deviceId, configId: params.configId,
    snapshotId: params.snapshotId, storageIdentity: params.identity, expiresAt: params.expiresAt ?? null,
    backupType: params.backupType ?? 'file',
  });
}

runDb('scenario 1: retiring a base with an incremental child reclaims ONLY the base-exclusive object, keeping every shared backupPath the incremental references', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = await mkdtemp(join(tmpdir(), 'breeze-gc-'));

  const seed = await withSystemDbAccessContext(async () => {
    const seed = await seedOrgDeviceConfig(unique, root);

    // Base B has an object exclusively its own (only-in-b.dat) AND a
    // separately-tracked shared object (shared.dat) that C's manifest ALSO
    // references. Retiring B must reclaim only-in-b.dat, never shared.dat.
    await writeAged(root, 'snapshots/B/manifest.json', 1000, JSON.stringify({ files: [
      { backupPath: 'snapshots/B/files/only-in-b.dat' },
      { backupPath: 'snapshots/B/files/shared.dat' },
    ] }));
    await writeAged(root, 'snapshots/B/files/only-in-b.dat', 1000);
    await writeAged(root, 'snapshots/B/files/shared.dat', 1000);
    await writeAged(root, 'snapshots/C/manifest.json', 1000, JSON.stringify({ files: [
      { backupPath: 'snapshots/B/files/shared.dat' },
      { backupPath: 'snapshots/C/files/c.dat' },
    ] }));
    await writeAged(root, 'snapshots/C/files/c.dat', 1000);

    await insertSnapshotRow({ ...seed, snapshotId: 'C' });
    await db.insert(backupSnapshotRetirements).values({
      orgId: seed.orgId, configId: seed.configId, deviceId: seed.deviceId,
      snapshotId: 'B', storageIdentity: seed.identity, backupType: 'file', reason: 'expired', retiredAt: new Date(),
    });
    return seed;
  });

  await sweepUnreferencedBackupObjects();

  const afterFirstRun = await listAll(root);
  expect(afterFirstRun).not.toContain('snapshots/B/files/only-in-b.dat');
  expect(afterFirstRun).toContain('snapshots/B/files/shared.dat'); // still shared with C — must survive
  expect(afterFirstRun).toContain('snapshots/C/manifest.json');
  expect(afterFirstRun).toContain('snapshots/C/files/c.dat');
  // B's manifest IS reclaimed once its only deletable non-manifest candidate
  // (only-in-b.dat) is gone this run — shared.dat surviving (it's LIVE,
  // referenced by C's manifest by exact backupPath) does not block manifest
  // removal: nothing depends on B's own manifest.json to resolve that
  // reference, so deleting B's now-orphaned restore metadata is safe (v3
  // manifest-last rule: "no DELETABLE non-manifest key remains", not "no
  // live object remains under this prefix").
  expect(afterFirstRun).not.toContain('snapshots/B/manifest.json');

  const [retirementRow] = await withSystemDbAccessContext(() =>
    db.select().from(backupSnapshotRetirements).where(eq(backupSnapshotRetirements.storageIdentity, seed.identity)),
  );
  expect(retirementRow!.sweptAt).toBeNull();
});

runDb('scenario 2: a still-retained (non-expired) row is protected regardless of age — including one referenced by an in-progress base pin', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = await mkdtemp(join(tmpdir(), 'breeze-gc-'));

  await withSystemDbAccessContext(async () => {
    const seed = await seedOrgDeviceConfig(unique, root);
    // p.dat is a REFERENCED file in PINNED's own manifest (not a loose,
    // unreferenced object) — this scenario proves a retained row's live
    // content survives regardless of age, which is a different rule from the
    // 48h loose-object grace (covered by the unit suite's own boundary
    // tests). An unreferenced loose object under a retained prefix is
    // legitimately subject to that separate 48h rule, pin or no pin.
    await writeAged(
      root,
      'snapshots/PINNED/manifest.json',
      30 * 24 * 60 * 60 * 1000,
      JSON.stringify({ files: [{ backupPath: 'snapshots/PINNED/files/p.dat' }] }),
    );
    await writeAged(root, 'snapshots/PINNED/files/p.dat', 30 * 24 * 60 * 60 * 1000);
    await insertSnapshotRow({ ...seed, snapshotId: 'PINNED' });

    await db.insert(backupJobs).values({
      orgId: seed.orgId, configId: seed.configId, deviceId: seed.deviceId, status: 'running',
      baseSnapshotId: 'PINNED', publishLeaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
  });

  await sweepUnreferencedBackupObjects();

  const remaining = await listAll(root);
  expect(remaining.sort()).toEqual(['snapshots/PINNED/files/p.dat', 'snapshots/PINNED/manifest.json'].sort());
});

runDb('scenario 3: an orphan manifest past ORPHAN_WINDOW with no row and no retirement is reclaimed', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = await mkdtemp(join(tmpdir(), 'breeze-gc-'));
  const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;

  await withSystemDbAccessContext(async () => {
    await seedOrgDeviceConfig(unique, root);
    await writeAged(root, 'snapshots/ABANDONED/manifest.json', TEN_DAYS_MS, JSON.stringify({ files: [] }));
    await writeAged(root, 'snapshots/ABANDONED/files/a.dat', TEN_DAYS_MS);
  });

  await sweepUnreferencedBackupObjects();
  expect(await listAll(root)).toEqual([]);
});

runDb('scenario 3b: ORPHAN_WINDOW\'s lease-derived arm protects an orphan the 9-day default alone would already have swept', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = await mkdtemp(join(tmpdir(), 'breeze-gc-'));
  const NINE_DAYS_PLUS_MS = 9 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000;

  await withSystemDbAccessContext(async () => {
    await seedOrgDeviceConfig(unique, root);
    await writeAged(root, 'snapshots/LEASEWINDOW/manifest.json', NINE_DAYS_PLUS_MS, JSON.stringify({ files: [] }));
  });

  const prevLease = process.env.BACKUP_BASE_LEASE_MS;
  process.env.BACKUP_BASE_LEASE_MS = String(9 * 24 * 60 * 60 * 1000);
  try {
    await sweepUnreferencedBackupObjects();
    expect(await listAll(root)).toContain('snapshots/LEASEWINDOW/manifest.json');
  } finally {
    if (prevLease === undefined) delete process.env.BACKUP_BASE_LEASE_MS; else process.env.BACKUP_BASE_LEASE_MS = prevLease;
  }
});

runDb('scenario 4: a legacy helper on the identity defers to EXACTLY today\'s algorithm — the retired prefix is fully protected, not just its manifest', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = await mkdtemp(join(tmpdir(), 'breeze-gc-'));

  await withSystemDbAccessContext(async () => {
    const seed = await seedOrgDeviceConfig(unique, root, '0.109.0'); // pre-server-base helper
    await writeAged(root, 'snapshots/RETIREDLEGACY/manifest.json', 1000, JSON.stringify({ files: [] }));
    await writeAged(root, 'snapshots/RETIREDLEGACY/files/r.dat', 1000);
    await db.insert(backupSnapshotRetirements).values({
      orgId: seed.orgId, configId: seed.configId, deviceId: seed.deviceId,
      snapshotId: 'RETIREDLEGACY', storageIdentity: seed.identity, backupType: 'file', reason: 'expired', retiredAt: new Date(),
    });
    await db.insert(backupJobs).values({ orgId: seed.orgId, configId: seed.configId, deviceId: seed.deviceId, status: 'completed' });
  });

  await sweepUnreferencedBackupObjects();

  const remaining = await listAll(root);
  expect(remaining.sort()).toEqual(['snapshots/RETIREDLEGACY/files/r.dat', 'snapshots/RETIREDLEGACY/manifest.json'].sort());
});

runDb('scenario 5: an undeletable object blocks only that prefix\'s manifest, not other prefixes', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = await mkdtemp(join(tmpdir(), 'breeze-gc-'));
  const blockedDir = join(root, 'snapshots/RETIREDBLOCKED/files');

  await withSystemDbAccessContext(async () => {
    const seed = await seedOrgDeviceConfig(unique, root);
    await writeAged(root, 'snapshots/RETIREDBLOCKED/manifest.json', 1000, JSON.stringify({ files: [] }));
    await writeAged(root, 'snapshots/RETIREDBLOCKED/files/locked.dat', 1000);
    await db.insert(backupSnapshotRetirements).values({
      orgId: seed.orgId, configId: seed.configId, deviceId: seed.deviceId,
      snapshotId: 'RETIREDBLOCKED', storageIdentity: seed.identity, backupType: 'file', reason: 'expired', retiredAt: new Date(),
    });
  });

  // Local-provider delete is `rm(path, { force: true })`, which swallows
  // ENOENT — induce a REAL, permanent delete failure via a read-only parent
  // directory so unlink() inside it gets EACCES.
  await chmod(blockedDir, 0o500);
  try {
    await sweepUnreferencedBackupObjects();
  } finally {
    await chmod(blockedDir, 0o700); // restore before temp-dir cleanup
  }

  expect(await listAll(root)).toContain('snapshots/RETIREDBLOCKED/manifest.json');
});

runDb('scenario 6a: a NULL-identity row whose manifest IS found resolves in this run and its identity reclaims normally (no longer deferred)', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = await mkdtemp(join(tmpdir(), 'breeze-gc-'));

  const seed = await withSystemDbAccessContext(async () => {
    const seed = await seedOrgDeviceConfig(unique, root);

    await writeAged(root, 'snapshots/HEALME/manifest.json', 1000, JSON.stringify({ files: [] }));
    const [job] = await db.insert(backupJobs).values({
      orgId: seed.orgId, configId: seed.configId, deviceId: seed.deviceId, status: 'completed', snapshotId: 'HEALME',
    }).returning({ id: backupJobs.id });
    await db.insert(backupSnapshots).values({
      orgId: seed.orgId, jobId: job!.id, deviceId: seed.deviceId, configId: seed.configId,
      snapshotId: 'HEALME', storageIdentity: null, // deliberately unresolved
    });

    await writeAged(root, 'snapshots/RETIRED6A/manifest.json', 1000, JSON.stringify({ files: [] }));
    await writeAged(root, 'snapshots/RETIRED6A/files/r.dat', 1000);
    await db.insert(backupSnapshotRetirements).values({
      orgId: seed.orgId, configId: seed.configId, deviceId: seed.deviceId,
      snapshotId: 'RETIRED6A', storageIdentity: seed.identity, backupType: 'file', reason: 'expired', retiredAt: new Date(),
    });
    return seed;
  });

  await sweepUnreferencedBackupObjects();

  const remaining = await listAll(root);
  expect(remaining).not.toContain('snapshots/RETIRED6A/files/r.dat');
  expect(remaining).toContain('snapshots/HEALME/manifest.json');

  const [healedRow] = await withSystemDbAccessContext(() =>
    db.select().from(backupSnapshots).where(eq(backupSnapshots.snapshotId, 'HEALME')),
  );
  expect(healedRow!.storageIdentity).toBe(seed.identity);
});

runDb('scenario 6b: a NULL-identity row whose manifest is NOT found defers the WHOLE identity to today\'s algorithm — nothing unrooted is deleted', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = await mkdtemp(join(tmpdir(), 'breeze-gc-'));

  await withSystemDbAccessContext(async () => {
    const seed = await seedOrgDeviceConfig(unique, root);

    // NEVERWRITTEN's row exists (mapped to this identity's config) but its
    // object was never actually written to THIS bucket — never appears in
    // the listing, so it can never resolve.
    const [job] = await db.insert(backupJobs).values({
      orgId: seed.orgId, configId: seed.configId, deviceId: seed.deviceId, status: 'completed', snapshotId: 'NEVERWRITTEN',
    }).returning({ id: backupJobs.id });
    await db.insert(backupSnapshots).values({
      orgId: seed.orgId, jobId: job!.id, deviceId: seed.deviceId, configId: seed.configId,
      snapshotId: 'NEVERWRITTEN', storageIdentity: null,
    });

    await writeAged(root, 'snapshots/RETIRED6B/manifest.json', 1000, JSON.stringify({ files: [] }));
    await writeAged(root, 'snapshots/RETIRED6B/files/r.dat', 1000);
    await db.insert(backupSnapshotRetirements).values({
      orgId: seed.orgId, configId: seed.configId, deviceId: seed.deviceId,
      snapshotId: 'RETIRED6B', storageIdentity: seed.identity, backupType: 'file', reason: 'expired', retiredAt: new Date(),
    });
  });

  await sweepUnreferencedBackupObjects();

  // Deferred (unresolved NULL row) -> today's algorithm -> RETIRED6B's
  // manifest is marked live (it's listed) and its loose object is only 1s
  // old, well inside the 48h grace -> nothing deleted at all.
  const remaining = await listAll(root);
  expect(remaining.sort()).toEqual(['snapshots/RETIRED6B/files/r.dat', 'snapshots/RETIRED6B/manifest.json'].sort());
});

runDb('scenario 7: system_image, application (hyperv), and database (mssql) rows are roots exactly like file rows (no backupType filter)', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = await mkdtemp(join(tmpdir(), 'breeze-gc-'));

  await withSystemDbAccessContext(async () => {
    const seed = await seedOrgDeviceConfig(unique, root);
    for (const [snapshotId, backupType] of [
      ['IMG1', 'system_image'], ['HV1', 'application'], ['SQL1', 'database'],
    ] as const) {
      await writeAged(root, `snapshots/${snapshotId}/manifest.json`, 20 * 24 * 60 * 60 * 1000, JSON.stringify({ files: [] }));
      await insertSnapshotRow({ ...seed, snapshotId, backupType });
    }
  });

  await sweepUnreferencedBackupObjects();

  // All three survive despite being 20 days old — they're rooted DB rows via
  // storage_identity (Task 3's fix), never filtered out by backupType, and
  // their manifest fetch must succeed (every mode publishes the same
  // snapshots/<id>/manifest.json layout).
  const remaining = await listAll(root);
  expect(remaining.sort()).toEqual([
    'snapshots/IMG1/manifest.json', 'snapshots/HV1/manifest.json', 'snapshots/SQL1/manifest.json',
  ].sort());
});

runDb('scenario 8: a swept retirement row is pruned after 30 days past sweptAt', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = await mkdtemp(join(tmpdir(), 'breeze-gc-'));

  const retirementId = await withSystemDbAccessContext(async () => {
    const seed = await seedOrgDeviceConfig(unique, root);
    const [row] = await db.insert(backupSnapshotRetirements).values({
      orgId: seed.orgId, configId: seed.configId, deviceId: seed.deviceId,
      snapshotId: 'LONGGONE', storageIdentity: seed.identity, backupType: 'file', reason: 'expired',
      retiredAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      sweptAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000), // swept 31 days ago
    }).returning({ id: backupSnapshotRetirements.id });
    return row!.id;
  });

  await sweepUnreferencedBackupObjects();

  const rows = await withSystemDbAccessContext(() =>
    db.select().from(backupSnapshotRetirements).where(eq(backupSnapshotRetirements.id, retirementId)),
  );
  expect(rows).toEqual([]);
});

runDb('scenario 8b: a retirement swept less than 30 days ago is NOT pruned', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = await mkdtemp(join(tmpdir(), 'breeze-gc-'));

  const retirementId = await withSystemDbAccessContext(async () => {
    const seed = await seedOrgDeviceConfig(unique, root);
    const [row] = await db.insert(backupSnapshotRetirements).values({
      orgId: seed.orgId, configId: seed.configId, deviceId: seed.deviceId,
      snapshotId: 'RECENTLYGONE', storageIdentity: seed.identity, backupType: 'file', reason: 'expired',
      retiredAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000),
      sweptAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000), // swept only 10 days ago
    }).returning({ id: backupSnapshotRetirements.id });
    return row!.id;
  });

  await sweepUnreferencedBackupObjects();

  const rows = await withSystemDbAccessContext(() =>
    db.select().from(backupSnapshotRetirements).where(eq(backupSnapshotRetirements.id, retirementId)),
  );
  expect(rows).toHaveLength(1);
});
