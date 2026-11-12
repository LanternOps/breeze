import './setup';

import { mkdtemp, mkdir, writeFile, utimes, readdir, chmod, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
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
import { markReservationRetired } from '../../services/backupSnapshotIdReservations';

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

// The API and worker read a local destination only from
// <BACKUP_LOCAL_ROOT>/<org id>/<config id>. newDestinationDir() plans the org
// and config ids for one seeded destination so that directory is also the
// destination's stored path; a second seed on the same stored path gets its
// own ids and its own directory (`seed.dir`).
let operatorRoot = '';
const plannedIds = new Map<string, { orgId: string; configId: string }>();

beforeAll(async () => {
  operatorRoot = await mkdtemp(join(tmpdir(), 'breeze-gc-operator-'));
});
beforeEach(() => {
  vi.stubEnv('BACKUP_LOCAL_ROOT', operatorRoot);
});
afterAll(() => {
  vi.unstubAllEnvs();
});

async function newDestinationDir(): Promise<string> {
  const ids = { orgId: randomUUID(), configId: randomUUID() };
  const dir = join(operatorRoot, ids.orgId, ids.configId);
  await mkdir(dir, { recursive: true });
  plannedIds.set(dir, ids);
  return dir;
}

async function seedOrgDeviceConfig(unique: string, rootPath: string, backupVersion = '0.112.0') {
  const planned = plannedIds.get(rootPath);
  plannedIds.delete(rootPath);
  const [partner] = await db.insert(partners).values({
    name: `GC Partner ${unique}`, slug: `gc-partner-${unique}`, type: 'msp', plan: 'pro', status: 'active',
  }).returning({ id: partners.id });
  const [org] = await db.insert(organizations).values({
    ...(planned ? { id: planned.orgId } : {}),
    currencyCode: 'USD', partnerId: partner!.id, name: `GC Org ${unique}`, slug: `gc-org-${unique}`, type: 'customer', status: 'active',
  }).returning({ id: organizations.id });
  const [site] = await db.insert(sites).values({ orgId: org!.id, name: `GC Site ${unique}` }).returning({ id: sites.id });
  const [device] = await db.insert(devices).values({
    orgId: org!.id, siteId: site!.id, agentId: `gc-agent-${unique}`, hostname: `gc-host-${unique}`,
    osType: 'linux', osVersion: '1', architecture: 'x86_64', agentVersion: '0.0.0-test',
    backupVersion, status: 'online',
  }).returning({ id: devices.id });
  const [config] = await db.insert(backupConfigs).values({
    ...(planned ? { id: planned.configId } : {}),
    orgId: org!.id, name: `GC Config ${unique}`, type: 'file', provider: 'local', providerConfig: { path: rootPath },
  }).returning({ id: backupConfigs.id });
  const identity = `local::${rootPath}`;
  const dir = join(operatorRoot, org!.id, config!.id);
  await mkdir(dir, { recursive: true });
  return { orgId: org!.id, deviceId: device!.id, configId: config!.id, identity, dir };
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
  const root = await newDestinationDir();

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
  const root = await newDestinationDir();

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
  const root = await newDestinationDir();
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
  const root = await newDestinationDir();
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
  const root = await newDestinationDir();

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
  const root = await newDestinationDir();
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
  const root = await newDestinationDir();

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
  const root = await newDestinationDir();

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
  const root = await newDestinationDir();

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
  const root = await newDestinationDir();

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
  const root = await newDestinationDir();

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

runDb('scenario 9: a second org sharing the same physical storage identity can never defer another org\'s reclamation, and neither org\'s sweep ever deletes the other\'s live objects', async () => {
  const uniqueA = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-a`;
  const uniqueB = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-b`;
  const root = await newDestinationDir();

  // Both orgs' configs resolve to the SAME physical path (`root`) -- the
  // exact shape a cross-org storage-identity collision describes: config create validates shape
  // only, so nothing stops a second, unrelated org from registering the same
  // physical location. Org B's device is on a pre-server-base helper
  // version, which is what makes its identity's OWN reclamation defer to
  // the legacy "every listed manifest is a root" algorithm. Each org is
  // seeded in its OWN withSystemDbAccessContext call (not one shared
  // transaction) -- partner export locking requires every partner lock in a
  // transaction to be acquired before any organization lock, which two
  // interleaved seedOrgDeviceConfig calls in one transaction would violate;
  // this is an artifact of the test's own two-seed shape, unrelated to the
  // fix under test.
  const seedA = await withSystemDbAccessContext(() => seedOrgDeviceConfig(uniqueA, root, '0.112.0'));
  const seedB = await withSystemDbAccessContext(() => seedOrgDeviceConfig(uniqueB, root, '0.1.0'));

  await withSystemDbAccessContext(async () => {
    // Org A: a long-retired snapshot with one exclusively-its-own file --
    // ordinary reclamation should sweep it clean this run.
    await writeAged(root, 'snapshots/A-RETIRED/manifest.json', 20 * 24 * 60 * 60 * 1000, JSON.stringify({ files: [
      { backupPath: 'snapshots/A-RETIRED/files/only-in-a.dat' },
    ] }));
    await writeAged(root, 'snapshots/A-RETIRED/files/only-in-a.dat', 20 * 24 * 60 * 60 * 1000);
    await db.insert(backupSnapshotRetirements).values({
      orgId: seedA.orgId, configId: seedA.configId, deviceId: seedA.deviceId,
      snapshotId: 'A-RETIRED', storageIdentity: seedA.identity, backupType: 'file', reason: 'expired',
      retiredAt: new Date(),
    });

    // Org B: a live, retained snapshot -- must never be touched by org A's
    // (or anyone else's) sweep, however old.
    await writeAged(seedB.dir, 'snapshots/B-LIVE/manifest.json', 20 * 24 * 60 * 60 * 1000, JSON.stringify({ files: [
      { backupPath: 'snapshots/B-LIVE/files/b.dat' },
    ] }));
    await writeAged(seedB.dir, 'snapshots/B-LIVE/files/b.dat', 20 * 24 * 60 * 60 * 1000);
    await insertSnapshotRow({ ...seedB, snapshotId: 'B-LIVE', identity: seedB.identity });
  });

  expect(seedA.identity).toBe(seedB.identity); // sanity: genuinely one shared physical identity

  await sweepUnreferencedBackupObjects();

  const remaining = await listAll(root);
  const remainingB = await listAll(seedB.dir);

  // Org A's retirement was reclaimed -- proves org B's legacy-helper device
  // never deferred or blocked org A's OWN identity group. Pre-fix, one
  // shared (un-org-scoped) identity group meant B's device deferred BOTH
  // orgs' reclamation to the legacy "every listed manifest is a root"
  // algorithm, and A-RETIRED would still be present here.
  expect(remaining).not.toContain('snapshots/A-RETIRED/files/only-in-a.dat');
  expect(remaining).not.toContain('snapshots/A-RETIRED/manifest.json');

  // Org B's live snapshot is completely untouched -- proves org A's
  // independent sweep of the SAME physical bucket never treats another
  // org's objects as its own to reclaim.
  expect(remainingB).toContain('snapshots/B-LIVE/manifest.json');
  expect(remainingB).toContain('snapshots/B-LIVE/files/b.dat');
});

// ---------------------------------------------------------------------------
// Snapshot key layout: a storage identity holding ANY snapshot row whose
// key_layout this server does not understand is not swept at all this run —
// not even orphan reclamation of other snapshot prefixes — because the
// listing cannot tell that snapshot's objects apart from unreferenced ones.
// Checked across every org sharing the identity, and for rows whose
// storage_identity is still NULL but whose config maps to the identity.
// ---------------------------------------------------------------------------

const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;

async function insertLayoutRow(params: {
  orgId: string; deviceId: string; configId: string; snapshotId: string; identity: string | null; keyLayout: string;
}) {
  const [job] = await db.insert(backupJobs).values({
    orgId: params.orgId, configId: params.configId, deviceId: params.deviceId, status: 'completed', snapshotId: params.snapshotId,
  }).returning({ id: backupJobs.id });
  await db.insert(backupSnapshots).values({
    orgId: params.orgId, jobId: job!.id, deviceId: params.deviceId, configId: params.configId,
    snapshotId: params.snapshotId, storageIdentity: params.identity, keyLayout: params.keyLayout, backupType: 'file',
  });
}

/** One identity with a retained flat snapshot and an old orphan prefix the sweep would normally reclaim. */
// Snapshot ids are owned once across every organization and destination
// (backup_snapshot_id_reservations), so each identity keeps its own id.
async function seedLayoutIdentity(unique: string, root: string, kept = 'KEPT') {
  const seed = await withSystemDbAccessContext(async () => {
    const seed = await seedOrgDeviceConfig(unique, root);
    await writeAged(root, `snapshots/${kept}/manifest.json`, 1000, JSON.stringify({ files: [{ backupPath: `snapshots/${kept}/files/k.dat` }] }));
    await writeAged(root, `snapshots/${kept}/files/k.dat`, 1000);
    await insertSnapshotRow({ ...seed, snapshotId: kept });
    await writeAged(root, 'snapshots/ORPHAN/manifest.json', TEN_DAYS_MS, JSON.stringify({ files: [] }));
    await writeAged(root, 'snapshots/ORPHAN/files/o.dat', TEN_DAYS_MS);
    return seed;
  });
  return seed;
}

runDb.each([
  ['with its storage identity recorded', 'recorded'],
  ['with its storage identity still NULL (config maps to the identity)', 'null'],
] as const)('an identity holding a snapshot in an unsupported key layout %s is not swept at all', async (_name, identityShape) => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const rootX = await newDestinationDir();
  const rootY = await newDestinationDir();

  const seedX = await seedLayoutIdentity(`${unique}-x`, rootX);
  await seedLayoutIdentity(`${unique}-y`, rootY, 'KEPT-Y');
  await withSystemDbAccessContext(async () => {
    await insertLayoutRow({
      ...seedX, snapshotId: 'OTHERLAYOUT', identity: identityShape === 'recorded' ? seedX.identity : null, keyLayout: 'device_scoped',
    });
  });

  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await sweepUnreferencedBackupObjects();
    expect(error.mock.calls.some((args) => String(args[0]).includes('unsupported_key_layout') && String(args[0]).includes(seedX.identity))).toBe(true);
  } finally {
    error.mockRestore();
  }

  // X: nothing deleted, the orphan included.
  expect((await listAll(rootX)).sort()).toEqual([
    'snapshots/KEPT/files/k.dat', 'snapshots/KEPT/manifest.json',
    'snapshots/ORPHAN/files/o.dat', 'snapshots/ORPHAN/manifest.json',
  ]);
  // Y: an ordinary identity still sweeps its orphan.
  expect((await listAll(rootY)).sort()).toEqual(['snapshots/KEPT-Y/files/k.dat', 'snapshots/KEPT-Y/manifest.json']);
});

runDb('an unsupported key layout in ANOTHER org sharing the physical identity stops the sweep for every org on it', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = await newDestinationDir();

  const seedA = await seedLayoutIdentity(`${unique}-a`, root);
  const seedB = await withSystemDbAccessContext(() => seedOrgDeviceConfig(`${unique}-b`, root));
  expect(seedA.identity).toBe(seedB.identity);
  await withSystemDbAccessContext(async () => {
    await insertLayoutRow({ ...seedB, snapshotId: 'B-OTHERLAYOUT', identity: seedB.identity, keyLayout: 'device_scoped' });
  });

  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await sweepUnreferencedBackupObjects();
  } finally {
    error.mockRestore();
  }

  expect(await listAll(root)).toContain('snapshots/ORPHAN/manifest.json');
  expect(await listAll(root)).toContain('snapshots/ORPHAN/files/o.dat');
});

// ---------------------------------------------------------------------------
// Snapshot id reservations (brokered writes): a prefix whose id is reserved
// or sealing for ANY organization is never swept; an abandoned one only after
// the orphan window, and its reservation is then tombstoned.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

async function reserveId(params: {
  orgId: string; deviceId: string; configId: string; snapshotId: string; identity: string; state: string; updatedAt?: Date;
}) {
  await db.execute(sql`
    INSERT INTO backup_snapshot_id_reservations (snapshot_id, org_id, device_id, config_id, storage_identity, source, state, updated_at)
    VALUES (${params.snapshotId}, ${params.orgId}, ${params.deviceId}, ${params.configId}, ${params.identity},
            'server_minted', ${params.state}, ${(params.updatedAt ?? new Date()).toISOString()}::timestamptz)
  `);
}

runDb('a reserved (in-progress) prefix survives the sweep, also when another org shares the storage; an unreserved one of the same age does not', async () => {
  const root = await newDestinationDir();
  const seedA = await withSystemDbAccessContext(() => seedOrgDeviceConfig(`${Date.now()}-ra`, root));
  const seedB = await withSystemDbAccessContext(() => seedOrgDeviceConfig(`${Date.now()}-rb`, root));
  await writeAged(root, 'snapshots/RES-A/files/part.dat', 10 * DAY_MS);
  await writeAged(seedB.dir, 'snapshots/RES-B/files/part.dat', 10 * DAY_MS);
  await writeAged(root, 'snapshots/NOT-RESERVED/files/part.dat', 10 * DAY_MS);
  await withSystemDbAccessContext(async () => {
    await reserveId({ ...seedA, snapshotId: 'RES-A', state: 'reserved' });
    await reserveId({ ...seedB, snapshotId: 'RES-B', state: 'sealing' });
  });

  await sweepUnreferencedBackupObjects();

  const remaining = await listAll(root);
  expect(remaining).toContain('snapshots/RES-A/files/part.dat');
  expect(await listAll(seedB.dir)).toContain('snapshots/RES-B/files/part.dat');
  expect(remaining).not.toContain('snapshots/NOT-RESERVED/files/part.dat');
});

runDb('an abandoned prefix is reclaimed only after the orphan window, and its reservation is then tombstoned', async () => {
  const root = await newDestinationDir();
  const seed = await withSystemDbAccessContext(() => seedOrgDeviceConfig(`${Date.now()}-ab`, root));
  await writeAged(root, 'snapshots/ABANDONED-OLD/files/part.dat', 40 * DAY_MS);
  await writeAged(root, 'snapshots/ABANDONED-NEW/files/part.dat', 40 * DAY_MS);
  await withSystemDbAccessContext(async () => {
    await reserveId({ ...seed, snapshotId: 'ABANDONED-OLD', state: 'abandoned', updatedAt: new Date(Date.now() - 40 * DAY_MS) });
    await reserveId({ ...seed, snapshotId: 'ABANDONED-NEW', state: 'abandoned' });
  });

  await sweepUnreferencedBackupObjects();
  let remaining = await listAll(root);
  expect(remaining).not.toContain('snapshots/ABANDONED-OLD/files/part.dat');
  expect(remaining).toContain('snapshots/ABANDONED-NEW/files/part.dat');

  // The next run's fresh listing confirms the prefix is gone: the reservation
  // is deleted and the id tombstoned.
  await sweepUnreferencedBackupObjects();
  remaining = await listAll(root);
  expect(remaining).toContain('snapshots/ABANDONED-NEW/files/part.dat');
  const rows = await withSystemDbAccessContext(() => db.execute(sql`
    SELECT
      (SELECT count(*) FROM backup_snapshot_id_reservations WHERE snapshot_id = 'ABANDONED-OLD')::int AS old_reservation,
      (SELECT reason FROM backup_snapshot_id_tombstones WHERE snapshot_id = 'ABANDONED-OLD') AS old_tombstone,
      (SELECT state FROM backup_snapshot_id_reservations WHERE snapshot_id = 'ABANDONED-NEW') AS new_state
  `));
  expect(rows[0]).toMatchObject({ old_reservation: 0, old_tombstone: 'abandoned_reclaimed', new_state: 'abandoned' });
});

runDb('a retired snapshot\'s reservation is tombstoned once its prefix is confirmed gone', async () => {
  const root = await newDestinationDir();
  const seed = await withSystemDbAccessContext(() => seedOrgDeviceConfig(`${Date.now()}-rt`, root));
  await withSystemDbAccessContext(async () => {
    await insertSnapshotRow({ ...seed, snapshotId: 'RETIRE-ME' });
    await db.execute(sql`DELETE FROM backup_snapshots WHERE snapshot_id = 'RETIRE-ME'`);
    await db.insert(backupSnapshotRetirements).values({
      orgId: seed.orgId, configId: seed.configId, deviceId: seed.deviceId,
      snapshotId: 'RETIRE-ME', storageIdentity: seed.identity, backupType: 'file', reason: 'expired', retiredAt: new Date(),
    });
    await markReservationRetired('RETIRE-ME', seed.orgId);
  });
  await sweepUnreferencedBackupObjects();
  const rows = await withSystemDbAccessContext(() => db.execute(sql`
    SELECT (SELECT count(*) FROM backup_snapshot_id_reservations WHERE snapshot_id = 'RETIRE-ME')::int AS reservation,
           (SELECT reason FROM backup_snapshot_id_tombstones WHERE snapshot_id = 'RETIRE-ME') AS tombstone
  `));
  expect(rows[0]).toMatchObject({ reservation: 0, tombstone: 'retired' });
});

// ---------------------------------------------------------------------------
// Local destinations: each (organization, configuration) has its own
// directory under BACKUP_LOCAL_ROOT, even when destinations share one stored
// path. The sweep lists and deletes in each directory on its own.
// ---------------------------------------------------------------------------

runDb('local destinations sharing a stored path are swept one directory at a time, each from its own listing', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const storedPath = await mkdtemp(join(tmpdir(), 'breeze-gc-stored-'));
  const OLD = 20 * DAY_MS;

  const seedA1 = await withSystemDbAccessContext(() => seedOrgDeviceConfig(`${unique}-a`, storedPath));
  const seedB1 = await withSystemDbAccessContext(() => seedOrgDeviceConfig(`${unique}-b`, storedPath));
  const seedA2 = await withSystemDbAccessContext(async () => {
    const [config] = await db.insert(backupConfigs).values({
      orgId: seedA1.orgId, name: `GC Config ${unique}-a2`, type: 'file', provider: 'local', providerConfig: { path: storedPath },
    }).returning({ id: backupConfigs.id });
    const dir = join(operatorRoot, seedA1.orgId, config!.id);
    await mkdir(dir, { recursive: true });
    return { ...seedA1, configId: config!.id, dir };
  });
  expect(new Set([seedA1.identity, seedA2.identity, seedB1.identity]).size).toBe(1);

  const units = [['A1', seedA1], ['A2', seedA2], ['B1', seedB1]] as const;
  await withSystemDbAccessContext(async () => {
    for (const [label, seed] of units) {
      await writeAged(seed.dir, `snapshots/${label}-LIVE/manifest.json`, OLD, JSON.stringify({ files: [
        { backupPath: `snapshots/${label}-LIVE/files/live.dat` },
      ] }));
      await writeAged(seed.dir, `snapshots/${label}-LIVE/files/live.dat`, OLD);
      await insertSnapshotRow({ ...seed, snapshotId: `${label}-LIVE` });

      await writeAged(seed.dir, `snapshots/${label}-RETIRED/manifest.json`, OLD, JSON.stringify({ files: [
        { backupPath: `snapshots/${label}-RETIRED/files/only.dat` },
      ] }));
      await writeAged(seed.dir, `snapshots/${label}-RETIRED/files/only.dat`, OLD);
      await db.insert(backupSnapshotRetirements).values({
        orgId: seed.orgId, configId: seed.configId, deviceId: seed.deviceId,
        snapshotId: `${label}-RETIRED`, storageIdentity: seed.identity, backupType: 'file', reason: 'expired', retiredAt: new Date(),
      });
    }
    // Recent objects under A1's retired id in the other directories belong
    // to those destinations, not to A1's retirement.
    await writeAged(seedA2.dir, 'snapshots/A1-RETIRED/files/only.dat', 1000);
    await writeAged(seedB1.dir, 'snapshots/A1-RETIRED/files/only.dat', 1000);
  });

  await sweepUnreferencedBackupObjects();
  await sweepUnreferencedBackupObjects();

  expect((await listAll(seedA1.dir)).sort()).toEqual([
    'snapshots/A1-LIVE/files/live.dat', 'snapshots/A1-LIVE/manifest.json',
  ]);
  expect((await listAll(seedA2.dir)).sort()).toEqual([
    'snapshots/A1-RETIRED/files/only.dat', 'snapshots/A2-LIVE/files/live.dat', 'snapshots/A2-LIVE/manifest.json',
  ]);
  expect((await listAll(seedB1.dir)).sort()).toEqual([
    'snapshots/A1-RETIRED/files/only.dat', 'snapshots/B1-LIVE/files/live.dat', 'snapshots/B1-LIVE/manifest.json',
  ]);
  expect(await listAll(storedPath)).toEqual([]);

  const retirements = await withSystemDbAccessContext(() =>
    db.select({ snapshotId: backupSnapshotRetirements.snapshotId, sweptAt: backupSnapshotRetirements.sweptAt })
      .from(backupSnapshotRetirements)
      .where(eq(backupSnapshotRetirements.storageIdentity, seedA1.identity)),
  );
  expect(retirements.map((r) => r.snapshotId).sort()).toEqual(['A1-RETIRED', 'A2-RETIRED', 'B1-RETIRED']);
  for (const row of retirements) expect(row.sweptAt, row.snapshotId).not.toBeNull();
});

runDb('a retained snapshot recorded under the destination\'s previous stored path is kept', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-moved`;
  const root = await newDestinationDir();
  await withSystemDbAccessContext(async () => {
    const seed = await seedOrgDeviceConfig(unique, root);
    await writeAged(root, 'snapshots/OLD-PATH-LIVE/manifest.json', 20 * DAY_MS, JSON.stringify({ files: [
      { backupPath: 'snapshots/OLD-PATH-LIVE/files/a.dat' },
    ] }));
    await writeAged(root, 'snapshots/OLD-PATH-LIVE/files/a.dat', 20 * DAY_MS);
    // Recorded before the destination's Local Path was edited.
    await insertSnapshotRow({ ...seed, snapshotId: 'OLD-PATH-LIVE', identity: 'local::/old/device/path' });
  });

  await sweepUnreferencedBackupObjects();

  expect((await listAll(root)).sort()).toEqual([
    'snapshots/OLD-PATH-LIVE/files/a.dat', 'snapshots/OLD-PATH-LIVE/manifest.json',
  ]);
});

runDb('two destinations of one organization mounted on the same storage keep each other\'s retained snapshots', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-shared`;
  const rootA = await newDestinationDir();
  const otherStoredPath = await mkdtemp(join(tmpdir(), 'breeze-gc-stored-b-'));
  let dirB = '';
  await withSystemDbAccessContext(async () => {
    const seedA = await seedOrgDeviceConfig(unique, rootA);
    const [configB] = await db.insert(backupConfigs).values({
      orgId: seedA.orgId, name: `GC Config ${unique}-b`, type: 'file', provider: 'local', providerConfig: { path: otherStoredPath },
    }).returning({ id: backupConfigs.id });
    dirB = join(operatorRoot, seedA.orgId, configB!.id);
    // The same storage, mounted at both destination directories.
    for (const dir of [rootA, dirB]) {
      await writeAged(dir, 'snapshots/B-LIVE/manifest.json', 20 * DAY_MS, JSON.stringify({ files: [
        { backupPath: 'snapshots/B-LIVE/files/b.dat' },
      ] }));
      await writeAged(dir, 'snapshots/B-LIVE/files/b.dat', 20 * DAY_MS);
      // An old object the manifest does not reference: B's own sweep decides about it, never A's.
      await writeAged(dir, 'snapshots/B-LIVE/files/stray.dat', 20 * DAY_MS);
    }
    await insertSnapshotRow({ ...seedA, configId: configB!.id, snapshotId: 'B-LIVE', identity: `local::${otherStoredPath}` });
  });

  await sweepUnreferencedBackupObjects();

  expect((await listAll(rootA)).sort()).toEqual([
    'snapshots/B-LIVE/files/b.dat', 'snapshots/B-LIVE/files/stray.dat', 'snapshots/B-LIVE/manifest.json',
  ]);
  expect(await listAll(dirB)).toEqual(expect.arrayContaining(['snapshots/B-LIVE/files/b.dat', 'snapshots/B-LIVE/manifest.json']));
});

runDb('a destination whose stored path does not exist on the API server is still swept from its own directory', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-device-path`;
  const root = await newDestinationDir();
  const devicePath = '/nonexistent/device/backups';
  await withSystemDbAccessContext(async () => {
    const seed = await seedOrgDeviceConfig(unique, root);
    await db.update(backupConfigs).set({ providerConfig: { path: devicePath } }).where(eq(backupConfigs.id, seed.configId));
    await writeAged(root, 'snapshots/RETIRED-DEV/manifest.json', 20 * DAY_MS, JSON.stringify({ files: [
      { backupPath: 'snapshots/RETIRED-DEV/files/r.dat' },
    ] }));
    await writeAged(root, 'snapshots/RETIRED-DEV/files/r.dat', 20 * DAY_MS);
    await db.insert(backupSnapshotRetirements).values({
      orgId: seed.orgId, configId: seed.configId, deviceId: seed.deviceId,
      snapshotId: 'RETIRED-DEV', storageIdentity: `local::${devicePath}`, backupType: 'file', reason: 'expired',
      retiredAt: new Date(Date.now() - 20 * DAY_MS),
    });
  });

  await sweepUnreferencedBackupObjects();

  expect(await listAll(root)).toEqual([]);
});

async function reservationCount(snapshotId: string): Promise<number> {
  const rows = await withSystemDbAccessContext(() => db.execute(sql`
    SELECT count(*)::int AS n FROM backup_snapshot_id_reservations WHERE snapshot_id = ${snapshotId}
  `));
  return (rows[0] as { n: number }).n;
}

runDb('an abandoned local reservation with no destination is never released', async () => {
  const root = await newDestinationDir();
  const seed = await withSystemDbAccessContext(() => seedOrgDeviceConfig(`${Date.now()}-nocfg`, root));
  await withSystemDbAccessContext(() => db.execute(sql`
    INSERT INTO backup_snapshot_id_reservations (snapshot_id, org_id, device_id, config_id, storage_identity, source, state, updated_at)
    VALUES ('NO-CONFIG-ABANDONED', ${seed.orgId}, ${seed.deviceId}, NULL, ${seed.identity},
            'server_minted', 'abandoned', ${new Date(Date.now() - 40 * DAY_MS).toISOString()}::timestamptz)
  `));

  await sweepUnreferencedBackupObjects();
  await sweepUnreferencedBackupObjects();

  expect(await reservationCount('NO-CONFIG-ABANDONED')).toBe(1);
});

runDb('an abandoned reservation is kept while its own destination directory cannot be listed', async () => {
  const storedPath = await mkdtemp(join(tmpdir(), 'breeze-gc-stored-unlisted-'));
  const seedA = await withSystemDbAccessContext(() => seedOrgDeviceConfig(`${Date.now()}-listed`, storedPath));
  const seedB = await withSystemDbAccessContext(() => seedOrgDeviceConfig(`${Date.now()}-unlisted`, storedPath));
  expect(seedA.identity).toBe(seedB.identity);
  // B's destination directory is not provisioned, so B's listing fails.
  await rm(seedB.dir, { recursive: true, force: true });
  await withSystemDbAccessContext(() => reserveId({
    ...seedB, snapshotId: 'UNLISTED-ABANDONED', state: 'abandoned', updatedAt: new Date(Date.now() - 40 * DAY_MS),
  }));

  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await sweepUnreferencedBackupObjects();
    await sweepUnreferencedBackupObjects();
  } finally {
    error.mockRestore();
  }

  expect(await reservationCount('UNLISTED-ABANDONED')).toBe(1);
});
