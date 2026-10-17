import './setup';

import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, withSystemDbAccessContext } from '../../db';
import {
  backupConfigs,
  backupJobs,
  backupSnapshotRetirements,
  backupSnapshots,
  devices,
  organizations,
  partners,
  sites,
} from '../../db/schema';
import { sweepUnreferencedBackupObjects, normalizeStorageIdentity } from '../../jobs/backupRetention';
import { __setBackupS3ClientFactoryForTests } from '../../services/backupSnapshotStorage';
import { loadReservationGcState } from '../../services/backupSnapshotIdReservations';
import { InMemoryS3 } from '../helpers/inMemoryS3';

/**
 * #7081 W02 — per-root GC evidence (Review Focus 2). One shared S3 bucket:
 * org A writes the legacy root (`snapshots/`), org B the prefixed root
 * (`orgB/snapshots/`). One GC run must reclaim each root's own garbage and
 * nothing else: never an object of one root on the evidence of another, never
 * an id recorded under another root, never anything outside the two roots.
 * Storage is an in-memory S3 behind the real list / get / delete code.
 */
const runDb = it.runIf(!!process.env.DATABASE_URL);
const s3 = new InMemoryS3();

beforeAll(() => __setBackupS3ClientFactoryForTests(() => s3.client() as never));
afterAll(() => __setBackupS3ClientFactoryForTests(null));

const DAY_MS = 24 * 60 * 60 * 1000;

function s3Config(bucket: string, prefix?: string): Record<string, unknown> {
  return {
    bucket,
    region: 'us-east-1',
    endpoint: 'https://s3.example.test',
    accessKey: 'test-access-key',
    secretKey: 'test-secret-key',
    ...(prefix ? { prefix } : {}),
  };
}

async function seedOrg(unique: string, partnerId: string, label: string, providerConfig: Record<string, unknown>) {
  const [org] = await db.insert(organizations).values({
    currencyCode: 'USD', partnerId, name: `Root Org ${label} ${unique}`, slug: `root-org-${label}-${unique}`, type: 'customer', status: 'active',
  }).returning({ id: organizations.id });
  const [site] = await db.insert(sites).values({ orgId: org!.id, name: `Root Site ${label}` }).returning({ id: sites.id });
  const [device] = await db.insert(devices).values({
    orgId: org!.id, siteId: site!.id, agentId: `root-agent-${label}-${unique}`, hostname: `root-host-${label}-${unique}`,
    osType: 'linux', osVersion: '1', architecture: 'x86_64', agentVersion: '0.0.0-test',
    backupVersion: '0.112.0', status: 'online',
  }).returning({ id: devices.id });
  const [config] = await db.insert(backupConfigs).values({
    orgId: org!.id, name: `Root Config ${label}`, type: 'file', provider: 's3', providerConfig,
  }).returning({ id: backupConfigs.id });
  return { orgId: org!.id, deviceId: device!.id, configId: config!.id };
}

async function insertSnapshot(
  owner: { orgId: string; deviceId: string; configId: string },
  snapshotId: string,
  identity: string,
  root: { keyLayout: 'legacy_flat' | 'prefixed_flat'; keyPrefix: string | null },
) {
  const [job] = await db.insert(backupJobs).values({
    orgId: owner.orgId, configId: owner.configId, deviceId: owner.deviceId, status: 'completed', snapshotId,
  }).returning({ id: backupJobs.id });
  await db.insert(backupSnapshots).values({
    orgId: owner.orgId, jobId: job!.id, deviceId: owner.deviceId, configId: owner.configId,
    snapshotId, storageIdentity: identity, backupType: 'file', ...root,
  });
}

function manifest(paths: string[]): string {
  return JSON.stringify({ formatVersion: 2, files: paths.map((backupPath) => ({ backupPath })) });
}

runDb('per-root GC: each root reclaims only its own garbage, never across roots or outside them (#7081)', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const bucket = `gc-roots-${unique}`;
  const old = new Date(Date.now() - 20 * DAY_MS);
  const P = { keyLayout: 'prefixed_flat' as const, keyPrefix: 'orgB' };
  const LEGACY = { keyLayout: 'legacy_flat' as const, keyPrefix: null };

  const identity = normalizeStorageIdentity('s3', s3Config(bucket));
  expect(normalizeStorageIdentity('s3', s3Config(bucket, 'orgB'))).toBe(identity); // the prefix is not identity

  await withSystemDbAccessContext(async () => {
    const [partner] = await db.insert(partners).values({
      name: `Root Partner ${unique}`, slug: `root-partner-${unique}`, type: 'msp', plan: 'pro', status: 'active',
    }).returning({ id: partners.id });
    const orgA = await seedOrg(unique, partner!.id, 'a', s3Config(bucket));
    const orgB = await seedOrg(unique, partner!.id, 'b', s3Config(bucket, 'orgB'));

    await insertSnapshot(orgA, 'a1', identity, LEGACY);
    await insertSnapshot(orgB, 'b1', identity, P);
    await db.insert(backupSnapshotRetirements).values({
      orgId: orgB.orgId, configId: orgB.configId, deviceId: orgB.deviceId, snapshotId: 'b2', storageIdentity: identity,
      backupType: 'file', reason: 'expired', retiredAt: new Date(), ...P,
    });
  });

  // Org A, legacy root.
  s3.put(bucket, 'snapshots/a1/manifest.json', manifest(['snapshots/a1/files/a.dat']), old);
  s3.put(bucket, 'snapshots/a1/files/a.dat', 'a', old);
  s3.put(bucket, 'snapshots/a2/manifest.json', manifest(['snapshots/a2/files/x.dat']), old); // old orphan, no row
  s3.put(bucket, 'snapshots/a2/files/x.dat', 'x', old);
  // Org B, prefixed root.
  s3.put(bucket, 'orgB/snapshots/b1/manifest.json', manifest(['snapshots/b1/files/b.dat']), old);
  s3.put(bucket, 'orgB/snapshots/b1/files/b.dat', 'b', old);
  s3.put(bucket, 'orgB/snapshots/b2/manifest.json', manifest(['snapshots/b2/files/y.dat']), old); // retired
  s3.put(bucket, 'orgB/snapshots/b2/files/y.dat', 'y', old);
  // Each root holds an old, row-less group whose id is recorded under the OTHER root.
  s3.put(bucket, 'orgB/snapshots/a1/manifest.json', manifest([]), old);
  s3.put(bucket, 'orgB/snapshots/a1/files/q.dat', 'q', old);
  s3.put(bucket, 'snapshots/b1/manifest.json', manifest([]), old);
  s3.put(bucket, 'snapshots/b1/files/r.dat', 'r', old);
  // Outside both roots.
  s3.put(bucket, 'other/snapshots/zz/old.dat', 'o', old);
  s3.put(bucket, 'orgB/readme.txt', 'o', old);
  s3.put(bucket, 'snapshots-old/a2/x.dat', 'o', old);

  await sweepUnreferencedBackupObjects();

  expect(s3.keys(bucket)).toEqual([
    'orgB/readme.txt',
    'orgB/snapshots/a1/files/q.dat',
    'orgB/snapshots/a1/manifest.json',
    'orgB/snapshots/b1/files/b.dat',
    'orgB/snapshots/b1/manifest.json',
    'other/snapshots/zz/old.dat',
    'snapshots-old/a2/x.dat',
    'snapshots/a1/files/a.dat',
    'snapshots/a1/manifest.json',
    'snapshots/b1/files/r.dat',
    'snapshots/b1/manifest.json',
  ]);

  const calls = s3.callsFor(bucket);
  const listed = calls.flatMap((c) => (c.op === 'list' ? [c.prefix] : []));
  const deleted = calls.flatMap((c) => (c.op === 'delete' ? c.keys : []));
  const fetched = calls.flatMap((c) => (c.op === 'get' ? [c.key] : []));
  // Each root's `snapshots/` listed exactly once by the root pass.
  expect(listed.filter((p) => p === 'snapshots/')).toHaveLength(1);
  expect(listed.filter((p) => p === 'orgB/snapshots/')).toHaveLength(1);
  // Nothing outside the two roots was listed, fetched or deleted.
  const underARoot = (key: string) => key.startsWith('snapshots/') || key.startsWith('orgB/snapshots/');
  expect(listed.every(underARoot)).toBe(true);
  expect(fetched.every(underARoot)).toBe(true);
  expect(deleted.every(underARoot)).toBe(true);
  // Exactly each root's own garbage.
  expect([...deleted].sort()).toEqual([
    'orgB/snapshots/b2/files/y.dat',
    'orgB/snapshots/b2/manifest.json',
    'snapshots/a2/files/x.dat',
    'snapshots/a2/manifest.json',
  ]);
  // B's live manifest was read under B's root only.
  expect(fetched).toContain('orgB/snapshots/b1/manifest.json');
  expect(fetched).not.toContain('snapshots/b1/manifest.json');

  // Second run: B's retirement is confirmed swept from B's own listing.
  await sweepUnreferencedBackupObjects();
  const [retirement] = await withSystemDbAccessContext(() =>
    db.select({ sweptAt: backupSnapshotRetirements.sweptAt })
      .from(backupSnapshotRetirements)
      .where(eq(backupSnapshotRetirements.snapshotId, 'b2')));
  expect(retirement?.sweptAt).toBeInstanceOf(Date);
});

runDb('per-root GC: a retirement under a prefixed root is not confirmed swept when only the legacy root listed (#7081)', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const bucket = `gc-roots-swept-${unique}`;
  const identity = normalizeStorageIdentity('s3', s3Config(bucket));

  await withSystemDbAccessContext(async () => {
    const [partner] = await db.insert(partners).values({
      name: `Root Partner ${unique}`, slug: `root-partner-${unique}`, type: 'msp', plan: 'pro', status: 'active',
    }).returning({ id: partners.id });
    const orgB = await seedOrg(unique, partner!.id, 'b', s3Config(bucket, 'orgB'));
    await db.insert(backupSnapshotRetirements).values({
      orgId: orgB.orgId, configId: orgB.configId, deviceId: orgB.deviceId, snapshotId: 'b9', storageIdentity: identity,
      backupType: 'file', reason: 'expired', retiredAt: new Date(), keyLayout: 'prefixed_flat', keyPrefix: 'orgB',
    });
  });
  // The prefixed root still holds b9; the legacy root holds nothing.
  s3.put(bucket, 'orgB/snapshots/b9/files/keep-for-now.dat', 'k', new Date());
  const original = s3.client();
  __setBackupS3ClientFactoryForTests(() => ({
    send: async (command: unknown) => {
      const input = (command as { input?: { Prefix?: string; Bucket?: string } }).input;
      if (input?.Bucket === bucket && input.Prefix === 'orgB/snapshots/') throw new Error('listing failed');
      return original.send(command);
    },
  }) as never);

  try {
    await sweepUnreferencedBackupObjects();
  } finally {
    __setBackupS3ClientFactoryForTests(() => s3.client() as never);
  }

  const [retirement] = await withSystemDbAccessContext(() =>
    db.select({ sweptAt: backupSnapshotRetirements.sweptAt })
      .from(backupSnapshotRetirements)
      .where(eq(backupSnapshotRetirements.snapshotId, 'b9')));
  expect(retirement?.sweptAt).toBeNull();
  expect(s3.keys(bucket)).toEqual(['orgB/snapshots/b9/files/keep-for-now.dat']);
});

runDb('per-root GC: an erasure-fenced prefixed manifest is read under its fence\'s root and keeps what it references there (#7081)', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const bucket = `gc-roots-fence-${unique}`;
  const identity = normalizeStorageIdentity('s3', s3Config(bucket));
  const old = new Date(Date.now() - 20 * DAY_MS);
  const erasedOrgId = randomUUID();

  await withSystemDbAccessContext(async () => {
    const [partner] = await db.insert(partners).values({
      name: `Root Partner ${unique}`, slug: `root-partner-${unique}`, type: 'msp', plan: 'pro', status: 'active',
    }).returning({ id: partners.id });
    const orgB = await seedOrg(unique, partner!.id, 'b', s3Config(bucket, 'orgB'));
    await db.insert(backupSnapshotRetirements).values({
      orgId: orgB.orgId, configId: orgB.configId, deviceId: orgB.deviceId, snapshotId: 'e0', storageIdentity: identity,
      backupType: 'file', reason: 'expired', retiredAt: new Date(), keyLayout: 'prefixed_flat', keyPrefix: 'orgB',
    });
    // An erased org's fenced incremental e1, under the prefixed root, whose
    // manifest references an object of e0.
    await db.execute(sql`
      INSERT INTO backup_erasure_manifests (id, subject_org_id) VALUES (${randomUUID()}, ${erasedOrgId})
    `);
    await db.execute(sql`
      INSERT INTO backup_erasure_targets (manifest_id, subject_org_id, kind, source, storage_identity, provider, snapshot_id, key_layout, key_prefix, state)
      SELECT id, ${erasedOrgId}, 'snapshot_prefix', 'snapshot', ${identity}, 's3', 'e1', 'prefixed_flat', 'orgB', 'fenced'
        FROM backup_erasure_manifests WHERE subject_org_id = ${erasedOrgId}
    `);
  });

  s3.put(bucket, 'orgB/snapshots/e1/manifest.json', manifest(['snapshots/e1/files/own.dat', 'snapshots/e0/files/shared.dat']), old);
  s3.put(bucket, 'orgB/snapshots/e1/files/own.dat', 'o', old);
  s3.put(bucket, 'orgB/snapshots/e0/manifest.json', manifest(['snapshots/e0/files/shared.dat', 'snapshots/e0/files/junk.dat']), old);
  s3.put(bucket, 'orgB/snapshots/e0/files/shared.dat', 's', old);
  s3.put(bucket, 'orgB/snapshots/e0/files/junk.dat', 'j', old);

  await sweepUnreferencedBackupObjects();

  expect(s3.keys(bucket)).toEqual([
    'orgB/snapshots/e0/files/shared.dat',
    'orgB/snapshots/e1/files/own.dat',
    'orgB/snapshots/e1/manifest.json',
  ]);
  const fetched = s3.callsFor(bucket).flatMap((c) => (c.op === 'get' ? [c.key] : []));
  expect(fetched).toContain('orgB/snapshots/e1/manifest.json');
  expect(fetched.some((key) => key.startsWith('snapshots/'))).toBe(false);
  const refs = await withSystemDbAccessContext(() => db.execute(sql`
    SELECT state, referenced_keys FROM backup_erasure_fence_refs WHERE storage_identity = ${identity} AND snapshot_id = 'e1'
  `)) as unknown as Array<{ state: string; referenced_keys: string[] }>;
  expect(refs).toEqual([{ state: 'resolved', referenced_keys: ['snapshots/e0/files/shared.dat'] }]);
});

runDb('loadReservationGcState reports each reclaimable reservation\'s recorded key root, null when unreadable (#7081)', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const identity = normalizeStorageIdentity('s3', s3Config(`gc-roots-res-${unique}`));
  const old = new Date(Date.now() - 20 * DAY_MS);
  const ids = { legacy: `res-l-${unique}`, prefixed: `res-p-${unique}`, bad: `res-x-${unique}` };
  await withSystemDbAccessContext(async () => {
    const [partner] = await db.insert(partners).values({
      name: `Root Partner ${unique}`, slug: `root-partner-${unique}`, type: 'msp', plan: 'pro', status: 'active',
    }).returning({ id: partners.id });
    const org = await seedOrg(unique, partner!.id, 'r', s3Config(`gc-roots-res-${unique}`));
    for (const [id, layout, prefix] of [
      [ids.legacy, 'legacy_flat', null],
      [ids.prefixed, 'prefixed_flat', 'orgB'],
      [ids.bad, 'device_scoped', null],
    ] as const) {
      await db.execute(sql`
        INSERT INTO backup_snapshot_id_reservations (snapshot_id, org_id, device_id, config_id, storage_identity, source, state, key_layout, key_prefix, updated_at)
        VALUES (${id}, ${org.orgId}, ${org.deviceId}, ${org.configId}, ${identity}, 'server_minted', 'abandoned', ${layout}, ${prefix}, ${old.toISOString()}::timestamptz)
      `);
    }
  });

  const state = await withSystemDbAccessContext(() => loadReservationGcState(Date.now(), DAY_MS));
  const byId = new Map(state.reclaimable.map((r) => [r.snapshotId, r.root]));
  expect(byId.get(ids.legacy)).toEqual({ layout: 'legacy_flat', prefix: null });
  expect(byId.get(ids.prefixed)).toEqual({ layout: 'prefixed_flat', prefix: 'orgB' });
  expect(byId.has(ids.bad)).toBe(true);
  expect(byId.get(ids.bad)).toBeNull();
});
