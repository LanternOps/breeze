/**
 * Device purge keeps the purged device's backup storage objects, and storage
 * cleanup never reclaims them (#7982) — the device-scoped twin of
 * backupErasureFence.integration.test.ts (#7980).
 *
 * `purgeRemovedDevice` → `deleteDeviceCascade` deletes the device's
 * backup_snapshots, retirement, reservation and (through recovery_tokens'
 * ON DELETE CASCADE) recovery-media rows. Storage GC decides ownership of a
 * shared storage identity from exactly those rows, so without a record the
 * device's `snapshots/<id>/` prefixes look like old orphans and are reclaimed.
 * The purge now arms the same on-delete fence trigger org erasure uses.
 *
 * It also refuses while a backup-policy or configuration-policy legal hold
 * governs the device — the same sources org erasure checks.
 *
 * Real Postgres, the real `purgeRemovedDevice` and the real
 * `sweepUnreferencedBackupObjects` with a `local` storage root on a tmpdir.
 */
import './setup';

import { mkdtemp, mkdir, writeFile, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { sweepUnreferencedBackupObjects } from '../../jobs/backupRetention';
import { DeviceLifecycleError, purgeRemovedDevice } from '../../services/deviceLifecycle';
import { db, withSystemDbAccessContext } from '../../db';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;

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
  return out.sort();
}

async function exec<T = Record<string, unknown>>(statement: ReturnType<typeof sql>): Promise<T[]> {
  return (await getTestDb().execute(statement)) as unknown as T[];
}

function unique(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface SeededOrg {
  orgId: string;
  siteId: string;
  configId: string;
  identity: string;
}

async function seedPartner(): Promise<string> {
  const u = unique();
  const [row] = await exec<{ id: string }>(sql`
    INSERT INTO partners (name, slug, status, created_at, updated_at)
    VALUES (${`Purge Fence Partner ${u}`}, ${`purge-fence-partner-${u}`}, 'active', now(), now())
    RETURNING id
  `);
  return row!.id;
}

async function seedOrg(partnerId: string, rootPath: string): Promise<SeededOrg> {
  const u = unique();
  const [org] = await exec<{ id: string }>(sql`
    INSERT INTO organizations (partner_id, name, slug, status, currency_code, created_at, updated_at)
    VALUES (${partnerId}, ${`Purge Fence Org ${u}`}, ${`purge-fence-org-${u}`}, 'active', 'USD', now(), now())
    RETURNING id
  `);
  const orgId = org!.id;
  const [site] = await exec<{ id: string }>(sql`
    INSERT INTO sites (org_id, name, created_at, updated_at) VALUES (${orgId}, 'Purge Fence Site', now(), now()) RETURNING id
  `);
  const [config] = await exec<{ id: string }>(sql`
    INSERT INTO backup_configs (org_id, name, type, provider, provider_config)
    VALUES (${orgId}, ${`Purge Fence Config ${u}`}, 'file', 'local', ${JSON.stringify({ path: rootPath })}::jsonb)
    RETURNING id
  `);
  return { orgId, siteId: site!.id, configId: config!.id, identity: `local::${rootPath}` };
}

/** A device; `removed` puts it in the state Permanently Delete accepts. */
async function seedDevice(seed: SeededOrg, opts: { removed?: boolean } = {}): Promise<string> {
  const [device] = await exec<{ id: string }>(sql`
    INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version, backup_version, status)
    VALUES (${seed.orgId}, ${seed.siteId}, ${randomUUID()}, ${`purge-fence-host-${unique()}`}, 'linux', '1', 'x86_64',
            '0.0.0-test', '0.112.0', ${opts.removed ? 'decommissioned' : 'online'})
    RETURNING id
  `);
  return device!.id;
}

async function insertSnapshot(
  seed: SeededOrg,
  deviceId: string,
  snapshotId: string,
  opts: { policyId?: string } = {},
): Promise<string> {
  const [job] = await exec<{ id: string }>(sql`
    INSERT INTO backup_jobs (org_id, config_id, policy_id, device_id, status, snapshot_id)
    VALUES (${seed.orgId}, ${seed.configId}, ${opts.policyId ?? null}, ${deviceId}, 'completed', ${snapshotId}) RETURNING id
  `);
  const [snap] = await exec<{ id: string }>(sql`
    INSERT INTO backup_snapshots (org_id, job_id, device_id, config_id, snapshot_id, storage_identity, size, file_count, backup_type)
    VALUES (${seed.orgId}, ${job!.id}, ${deviceId}, ${seed.configId}, ${snapshotId}, ${seed.identity}, 4096, 2, 'file')
    RETURNING id
  `);
  return snap!.id;
}

async function writeSnapshotObjects(root: string, snapshotId: string, ageMs: number): Promise<string[]> {
  const own = [`snapshots/${snapshotId}/files/a.dat`, `snapshots/${snapshotId}/files/b.dat`];
  await writeAged(root, `snapshots/${snapshotId}/manifest.json`, ageMs, JSON.stringify({
    files: own.map((backupPath) => ({ backupPath })),
  }));
  for (const key of own) await writeAged(root, key, ageMs);
  return [`snapshots/${snapshotId}/manifest.json`, ...own];
}

async function insertBackupPolicy(seed: SeededOrg, legalHold: boolean): Promise<string> {
  const [row] = await exec<{ id: string }>(sql`
    INSERT INTO backup_policies (org_id, config_id, name, schedule, retention, targets, legal_hold, legal_hold_reason)
    VALUES (${seed.orgId}, ${seed.configId}, ${`policy-${unique()}`}, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
            ${legalHold}, ${legalHold ? 'litigation' : null})
    RETURNING id
  `);
  return row!.id;
}

function purge(deviceId: string) {
  return withSystemDbAccessContext(() => db.transaction((tx) => purgeRemovedDevice(tx, deviceId)));
}

describe('device purge preserves backup storage objects on a shared storage identity (#7982)', () => {
  runDb('REGRESSION: purging a device never lets GC reclaim its snapshot, retired or recovery-media objects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'breeze-purge-fence-'));
    const partnerId = await seedPartner();
    const a = await seedOrg(partnerId, root);
    const b = await seedOrg(partnerId, root);
    expect(a.identity).toBe(b.identity);
    const purged = await seedDevice(a, { removed: true });
    const kept = await seedDevice(a);
    const sibling = await seedDevice(b);

    const purgedKeys = await writeSnapshotObjects(root, 'PURGE-D1', THIRTY_DAYS_MS);
    const purgedSnapDbId = await insertSnapshot(a, purged, 'PURGE-D1');
    // An unswept retirement on the purged device: same fence as a live row.
    const retiredKeys = await writeSnapshotObjects(root, 'PURGE-RET', THIRTY_DAYS_MS);
    await exec(sql`
      INSERT INTO backup_snapshot_retirements (org_id, config_id, device_id, snapshot_id, storage_identity, backup_type, reason)
      VALUES (${a.orgId}, ${a.configId}, ${purged}, 'PURGE-RET', ${a.identity}, 'file', 'expired')
    `);
    // Recovery media is deleted through recovery_tokens' ON DELETE CASCADE,
    // not by its own cascade step; the trigger must still see it.
    const [token] = await exec<{ id: string }>(sql`
      INSERT INTO recovery_tokens (org_id, device_id, snapshot_id, token_hash, restore_type, status, expires_at)
      VALUES (${a.orgId}, ${purged}, ${purgedSnapDbId}, ${createHash('sha256').update(randomUUID()).digest('hex')},
              'full', 'active', now() + interval '1 hour')
      RETURNING id
    `);
    const bundleId = randomUUID();
    const mediaKeys = [
      `snapshots/rmedia/${bundleId}/bundle.tar.gz`,
      `snapshots/rmedia/${bundleId}/CHECKSUM.txt`,
      `snapshots/rmedia/${bundleId}/bundle.tar.gz.minisig`,
    ];
    for (const key of mediaKeys) await writeAged(root, key, THIRTY_DAYS_MS);
    await exec(sql`
      INSERT INTO recovery_media_artifacts (id, org_id, token_id, snapshot_id, platform, architecture, status,
                                            storage_key, checksum_storage_key, signature_storage_key, checksum_sha256)
      VALUES (${bundleId}, ${a.orgId}, ${token!.id}, ${purgedSnapDbId}, 'linux', 'amd64', 'ready',
              ${mediaKeys[0]}, ${mediaKeys[1]}, ${mediaKeys[2]}, ${'a'.repeat(64)})
    `);

    const keptKeys = await writeSnapshotObjects(root, 'PURGE-D2', THIRTY_DAYS_MS);
    await insertSnapshot(a, kept, 'PURGE-D2');
    const siblingKeys = await writeSnapshotObjects(root, 'PURGE-B1', THIRTY_DAYS_MS);
    await insertSnapshot(b, sibling, 'PURGE-B1');
    // Control: an old orphan nobody owns is still reclaimed, so the sweep
    // really ran over this identity.
    await writeAged(root, 'snapshots/PURGE-ORPHAN/manifest.json', TEN_DAYS_MS, JSON.stringify({ files: [] }));
    await writeAged(root, 'snapshots/PURGE-ORPHAN/files/o.dat', TEN_DAYS_MS);

    await purge(purged);
    expect(await exec(sql`SELECT id FROM devices WHERE id = ${purged}`)).toHaveLength(0);
    expect(await exec(sql`SELECT id FROM backup_snapshots WHERE device_id = ${purged}`)).toHaveLength(0);

    await sweepUnreferencedBackupObjects();

    const remaining = await listAll(root);
    for (const key of [...purgedKeys, ...retiredKeys, ...mediaKeys]) expect(remaining).toContain(key);
    for (const key of [...keptKeys, ...siblingKeys]) expect(remaining).toContain(key);
    expect(remaining).not.toContain('snapshots/PURGE-ORPHAN/manifest.json');
    expect(remaining).not.toContain('snapshots/PURGE-ORPHAN/files/o.dat');

    const targets = await exec<{ kind: string; source: string; snapshot_id: string | null; object_key: string | null; subject_org_id: string }>(sql`
      SELECT kind, source, snapshot_id, object_key, subject_org_id FROM backup_erasure_targets
       WHERE subject_org_id = ${a.orgId}
    `);
    expect(targets.every((t) => t.subject_org_id === a.orgId)).toBe(true);
    // One fence per prefix. PURGE-D1's may be recorded from its id
    // reservation, which the cascade deletes before the snapshot row.
    expect(targets.filter((t) => t.kind === 'snapshot_prefix').map((t) => t.snapshot_id).sort())
      .toEqual(['PURGE-D1', 'PURGE-RET']);
    expect(targets.filter((t) => t.kind === 'recovery_media_key').map((t) => t.object_key).sort())
      .toEqual([...mediaKeys].sort());
  });

  runDb('a purge fences only the purged device: a later ordinary delete of a sibling device\'s row is not fenced', async () => {
    const root = await mkdtemp(join(tmpdir(), 'breeze-purge-fence-'));
    const a = await seedOrg(await seedPartner(), root);
    const purged = await seedDevice(a, { removed: true });
    const kept = await seedDevice(a);
    await insertSnapshot(a, purged, 'PURGE-ONLY-1');
    await insertSnapshot(a, kept, 'PURGE-ONLY-2');

    await purge(purged);
    // Retention deleting the kept device's row later is ordinary GC, not a fence.
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM backup_snapshots WHERE snapshot_id = 'PURGE-ONLY-2'`));

    const fenced = await exec<{ snapshot_id: string }>(sql`
      SELECT snapshot_id FROM backup_erasure_targets WHERE subject_org_id = ${a.orgId} AND kind = 'snapshot_prefix'
    `);
    expect(fenced.map((r) => r.snapshot_id)).toEqual(['PURGE-ONLY-1']);
  });
});

describe('device purge refuses while a backup legal hold governs the device (#7982)', () => {
  runDb('a held backup policy the device\'s backups ran under refuses the purge and deletes nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'breeze-purge-fence-'));
    const a = await seedOrg(await seedPartner(), root);
    const device = await seedDevice(a, { removed: true });
    const policyId = await insertBackupPolicy(a, true);
    await insertSnapshot(a, device, 'PURGE-HOLD-BP', { policyId });

    const err = await purge(device).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceLifecycleError);
    expect((err as DeviceLifecycleError).code).toBe('BACKUP_PROTECTED');
    expect(await exec(sql`SELECT id FROM devices WHERE id = ${device}`)).toHaveLength(1);
    expect(await exec(sql`SELECT id FROM backup_snapshots WHERE device_id = ${device}`)).toHaveLength(1);
  });

  runDb('a held configuration policy effective for the device refuses the purge and deletes nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'breeze-purge-fence-'));
    const a = await seedOrg(await seedPartner(), root);
    const device = await seedDevice(a, { removed: true });
    await insertSnapshot(a, device, 'PURGE-HOLD-CP');
    const [policy] = await exec<{ id: string }>(sql`
      INSERT INTO configuration_policies (org_id, name, status) VALUES (${a.orgId}, 'Held backups', 'active') RETURNING id
    `);
    const [link] = await exec<{ id: string }>(sql`
      INSERT INTO config_policy_feature_links (config_policy_id, feature_type) VALUES (${policy!.id}, 'backup') RETURNING id
    `);
    await exec(sql`
      INSERT INTO config_policy_backup_settings (feature_link_id, org_id, retention)
      VALUES (${link!.id}, ${a.orgId}, ${JSON.stringify({ legalHold: true, legalHoldReason: 'regulator request' })}::jsonb)
    `);
    await exec(sql`
      INSERT INTO config_policy_assignments (config_policy_id, level, target_id) VALUES (${policy!.id}, 'organization', ${a.orgId})
    `);

    const err = await purge(device).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceLifecycleError);
    expect((err as DeviceLifecycleError).code).toBe('BACKUP_PROTECTED');
    expect(await exec(sql`SELECT id FROM devices WHERE id = ${device}`)).toHaveLength(1);
  });

  runDb('a held backup policy the device never ran under does not block its purge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'breeze-purge-fence-'));
    const a = await seedOrg(await seedPartner(), root);
    const device = await seedDevice(a, { removed: true });
    const other = await seedDevice(a);
    const heldPolicy = await insertBackupPolicy(a, true);
    await insertSnapshot(a, other, 'PURGE-OTHER-HELD', { policyId: heldPolicy });
    await insertSnapshot(a, device, 'PURGE-UNHELD', { policyId: await insertBackupPolicy(a, false) });

    await purge(device);
    expect(await exec(sql`SELECT id FROM devices WHERE id = ${device}`)).toHaveLength(0);
  });
});
