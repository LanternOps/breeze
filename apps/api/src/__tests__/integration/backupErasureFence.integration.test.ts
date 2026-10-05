/**
 * Org erasure keeps the erased org's backup storage objects, and storage
 * cleanup never reclaims them.
 *
 * Erasure deletes the org's backup_snapshots / retirement / reservation and
 * recovery-media rows. Backup storage GC sweeps per STORAGE IDENTITY, which
 * several orgs of one MSP commonly share, and decides ownership from those
 * rows. Without a record of what the erased org owned, its prefixes look like
 * old orphans to a sibling org's sweep and get reclaimed. These scenarios run
 * the real `cascadeDeleteOrg` and the real `sweepUnreferencedBackupObjects`
 * against real Postgres and a `local` storage root on a tmpdir.
 */
import './setup';

import { mkdtemp, mkdir, writeFile, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { __backupGcTestHooks, sweepUnreferencedBackupObjects } from '../../jobs/backupRetention';
import {
  __tenantCascadeTestHooks,
  cascadeDeleteOrg,
  deleteBackupSnapshotsCascadeStep,
  TenantCascadeRefusalError,
  topologicalCascadeOrder,
} from '../../services/tenantCascade';
import { captureBackupErasureFence, setBackupErasureContext } from '../../services/backupErasureFence';
import { db, withSystemDbAccessContext } from '../../db';
import * as orgMergeModule from '../../services/orgMerge';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const PERFORMED_BY = '00000000-0000-0000-0000-0000000000ab';
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

async function seedPartner(): Promise<string> {
  const u = unique();
  const [row] = await exec<{ id: string }>(sql`
    INSERT INTO partners (name, slug, status, created_at, updated_at)
    VALUES (${`Fence Partner ${u}`}, ${`fence-partner-${u}`}, 'active', now(), now())
    RETURNING id
  `);
  return row!.id;
}

interface SeededOrg {
  orgId: string;
  partnerId: string;
  siteId: string;
  deviceId: string;
  configId: string;
  identity: string;
}

async function seedOrg(partnerId: string, rootPath: string): Promise<SeededOrg> {
  const u = unique();
  const [org] = await exec<{ id: string }>(sql`
    INSERT INTO organizations (partner_id, name, slug, status, currency_code, created_at, updated_at)
    VALUES (${partnerId}, ${`Fence Org ${u}`}, ${`fence-org-${u}`}, 'active', 'USD', now(), now())
    RETURNING id
  `);
  const orgId = org!.id;
  const [site] = await exec<{ id: string }>(sql`
    INSERT INTO sites (org_id, name, created_at, updated_at) VALUES (${orgId}, 'Fence Site', now(), now()) RETURNING id
  `);
  const [device] = await exec<{ id: string }>(sql`
    INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version, backup_version, status)
    VALUES (${orgId}, ${site!.id}, ${randomUUID()}, ${`fence-host-${u}`}, 'linux', '1', 'x86_64', '0.0.0-test', '0.112.0', 'online')
    RETURNING id
  `);
  const [config] = await exec<{ id: string }>(sql`
    INSERT INTO backup_configs (org_id, name, type, provider, provider_config)
    VALUES (${orgId}, ${`Fence Config ${u}`}, 'file', 'local', ${JSON.stringify({ path: rootPath })}::jsonb)
    RETURNING id
  `);
  return {
    orgId, partnerId, siteId: site!.id, deviceId: device!.id, configId: config!.id, identity: `local::${rootPath}`,
  };
}

async function insertSnapshot(seed: SeededOrg, snapshotId: string, opts: { identity?: string | null } = {}): Promise<string> {
  const [job] = await exec<{ id: string }>(sql`
    INSERT INTO backup_jobs (org_id, config_id, device_id, status, snapshot_id)
    VALUES (${seed.orgId}, ${seed.configId}, ${seed.deviceId}, 'completed', ${snapshotId}) RETURNING id
  `);
  const identity = opts.identity === undefined ? seed.identity : opts.identity;
  const [snap] = await exec<{ id: string }>(sql`
    INSERT INTO backup_snapshots (org_id, job_id, device_id, config_id, snapshot_id, storage_identity, size, file_count, backup_type)
    VALUES (${seed.orgId}, ${job!.id}, ${seed.deviceId}, ${seed.configId}, ${snapshotId}, ${identity}, 4096, 2, 'file')
    RETURNING id
  `);
  return snap!.id;
}

async function writeSnapshotObjects(root: string, snapshotId: string, ageMs: number, extraRefs: string[] = []): Promise<string[]> {
  const own = [`snapshots/${snapshotId}/files/a.dat`, `snapshots/${snapshotId}/files/b.dat`];
  await writeAged(root, `snapshots/${snapshotId}/manifest.json`, ageMs, JSON.stringify({
    files: [...own, ...extraRefs].map((backupPath) => ({ backupPath })),
  }));
  for (const key of own) await writeAged(root, key, ageMs);
  return [`snapshots/${snapshotId}/manifest.json`, ...own];
}

async function insertRecoveryToken(seed: SeededOrg, snapshotDbId: string): Promise<string> {
  const [token] = await exec<{ id: string }>(sql`
    INSERT INTO recovery_tokens (org_id, device_id, snapshot_id, token_hash, restore_type, status, expires_at)
    VALUES (${seed.orgId}, ${seed.deviceId}, ${snapshotDbId}, ${createHash('sha256').update(randomUUID()).digest('hex')},
            'full', 'active', now() + interval '1 hour')
    RETURNING id
  `);
  return token!.id;
}

describe('org erasure preserves backup storage objects on a shared storage identity', () => {
  const priorEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...priorEnv };
    delete __backupGcTestHooks.beforeIdentityState;
    delete __backupGcTestHooks.afterFenceRead;
  });

  runDb('REGRESSION: erasing org A never lets org B\'s sweep reclaim A\'s prefixes; B\'s own GC is unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'breeze-fence-'));
    const partnerId = await seedPartner();
    const a = await seedOrg(partnerId, root);
    const b = await seedOrg(partnerId, root);
    expect(a.identity).toBe(b.identity);

    const aKeys = await writeSnapshotObjects(root, 'FENCE-A1', THIRTY_DAYS_MS);
    await insertSnapshot(a, 'FENCE-A1');
    const bKeys = await writeSnapshotObjects(root, 'FENCE-B1', THIRTY_DAYS_MS);
    await insertSnapshot(b, 'FENCE-B1');
    // B's normal behaviour: an old orphan nobody owns is still reclaimed.
    await writeAged(root, 'snapshots/FENCE-BORPHAN/manifest.json', TEN_DAYS_MS, JSON.stringify({ files: [] }));
    await writeAged(root, 'snapshots/FENCE-BORPHAN/files/o.dat', TEN_DAYS_MS);

    await cascadeDeleteOrg(a.orgId, PERFORMED_BY);
    const orgRows = await exec(sql`SELECT id FROM organizations WHERE id = ${a.orgId}`);
    expect(orgRows).toHaveLength(0);

    await sweepUnreferencedBackupObjects();

    const remaining = await listAll(root);
    for (const key of aKeys) expect(remaining).toContain(key);
    for (const key of bKeys) expect(remaining).toContain(key);
    expect(remaining).not.toContain('snapshots/FENCE-BORPHAN/manifest.json');
    expect(remaining).not.toContain('snapshots/FENCE-BORPHAN/files/o.dat');
  });

  runDb('an erased org\'s incremental snapshot keeps the objects it references under an older, row-less prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'breeze-fence-'));
    const partnerId = await seedPartner();
    const a = await seedOrg(partnerId, root);
    await seedOrg(partnerId, root); // B keeps a config on the identity, so a sweep runs after A is gone

    // A0: a legacy base whose row is long gone (no row, no retirement, no
    // reservation). Its base.dat is still referenced by A2's manifest.
    await writeAged(root, 'snapshots/FENCE-A0/manifest.json', THIRTY_DAYS_MS, JSON.stringify({
      files: [{ backupPath: 'snapshots/FENCE-A0/files/base.dat' }],
    }));
    await writeAged(root, 'snapshots/FENCE-A0/files/base.dat', THIRTY_DAYS_MS);
    const a2Keys = await writeSnapshotObjects(root, 'FENCE-A2', THIRTY_DAYS_MS, ['snapshots/FENCE-A0/files/base.dat']);
    await insertSnapshot(a, 'FENCE-A2');

    await cascadeDeleteOrg(a.orgId, PERFORMED_BY);
    await sweepUnreferencedBackupObjects();

    const remaining = await listAll(root);
    for (const key of a2Keys) expect(remaining).toContain(key);
    expect(remaining).toContain('snapshots/FENCE-A0/files/base.dat');
  });

  runDb('recovery media bundles, boot media and their checksum/signature sidecars are captured and never reclaimed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'breeze-fence-'));
    const partnerId = await seedPartner();
    const a = await seedOrg(partnerId, root);
    await seedOrg(partnerId, root);

    await writeSnapshotObjects(root, 'FENCE-R1', THIRTY_DAYS_MS);
    const snapDbId = await insertSnapshot(a, 'FENCE-R1');
    const tokenId = await insertRecoveryToken(a, snapDbId);

    // A recovery-media prefix configured to sit inside GC's snapshots/ root.
    const bundleId = randomUUID();
    const bootId = randomUUID();
    const mediaKeys = [
      `snapshots/rmedia/${bundleId}/bundle.tar.gz`,
      `snapshots/rmedia/${bundleId}/CHECKSUM.txt`,
      `snapshots/rmedia/${bundleId}/bundle.tar.gz.minisig`,
      `snapshots/rmedia/${bootId}/boot.iso`,
      `snapshots/rmedia/${bootId}/boot.iso.sha256`,
      `snapshots/rmedia/${bootId}/boot.iso.minisig`,
    ];
    for (const key of mediaKeys) await writeAged(root, key, THIRTY_DAYS_MS);
    await exec(sql`
      INSERT INTO recovery_media_artifacts (id, org_id, token_id, snapshot_id, platform, architecture, status,
                                            storage_key, checksum_storage_key, signature_storage_key, checksum_sha256)
      VALUES (${bundleId}, ${a.orgId}, ${tokenId}, ${snapDbId}, 'linux', 'amd64', 'ready',
              ${mediaKeys[0]}, ${mediaKeys[1]}, ${mediaKeys[2]}, ${'a'.repeat(64)})
    `);
    await exec(sql`
      INSERT INTO recovery_boot_media_artifacts (id, org_id, token_id, snapshot_id, bundle_artifact_id, platform, architecture,
                                                 status, storage_key, checksum_storage_key, signature_storage_key)
      VALUES (${bootId}, ${a.orgId}, ${tokenId}, ${snapDbId}, ${bundleId}, 'linux', 'amd64', 'ready',
              ${mediaKeys[3]}, ${mediaKeys[4]}, ${mediaKeys[5]})
    `);

    await cascadeDeleteOrg(a.orgId, PERFORMED_BY);
    await sweepUnreferencedBackupObjects();

    const remaining = await listAll(root);
    for (const key of mediaKeys) expect(remaining).toContain(key);
  });
});

describe('org erasure refuses while a backup legal hold applies', () => {
  runDb('a backup_policies.legal_hold on the org refuses erasure and deletes nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'breeze-fence-'));
    const a = await seedOrg(await seedPartner(), root);
    await exec(sql`
      INSERT INTO backup_policies (org_id, config_id, name, schedule, retention, targets, legal_hold, legal_hold_reason)
      VALUES (${a.orgId}, ${a.configId}, 'held', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, true, 'litigation')
    `);

    await expect(cascadeDeleteOrg(a.orgId, PERFORMED_BY)).rejects.toThrow(TenantCascadeRefusalError);
    const orgRows = await exec(sql`SELECT id FROM organizations WHERE id = ${a.orgId}`);
    expect(orgRows).toHaveLength(1);
    const deviceRows = await exec(sql`SELECT id FROM devices WHERE id = ${a.deviceId}`);
    expect(deviceRows).toHaveLength(1);
  });

  runDb('a legal hold derived from an assigned configuration policy refuses erasure and deletes nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'breeze-fence-'));
    const a = await seedOrg(await seedPartner(), root);
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

    await expect(cascadeDeleteOrg(a.orgId, PERFORMED_BY)).rejects.toThrow(TenantCascadeRefusalError);
    const orgRows = await exec(sql`SELECT id FROM organizations WHERE id = ${a.orgId}`);
    expect(orgRows).toHaveLength(1);
  });

  runDb('a configuration policy WITHOUT a legal hold does not block erasure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'breeze-fence-'));
    const a = await seedOrg(await seedPartner(), root);
    const [policy] = await exec<{ id: string }>(sql`
      INSERT INTO configuration_policies (org_id, name, status) VALUES (${a.orgId}, 'Plain backups', 'active') RETURNING id
    `);
    const [link] = await exec<{ id: string }>(sql`
      INSERT INTO config_policy_feature_links (config_policy_id, feature_type) VALUES (${policy!.id}, 'backup') RETURNING id
    `);
    await exec(sql`
      INSERT INTO config_policy_backup_settings (feature_link_id, org_id, retention)
      VALUES (${link!.id}, ${a.orgId}, ${JSON.stringify({ legalHold: false })}::jsonb)
    `);
    await exec(sql`
      INSERT INTO config_policy_assignments (config_policy_id, level, target_id) VALUES (${policy!.id}, 'organization', ${a.orgId})
    `);

    await cascadeDeleteOrg(a.orgId, PERFORMED_BY);
    const orgRows = await exec(sql`SELECT id FROM organizations WHERE id = ${a.orgId}`);
    expect(orgRows).toHaveLength(0);
  });
});

type TargetRow = {
  kind: string;
  source: string;
  storage_identity: string | null;
  provider: string | null;
  snapshot_id: string | null;
  object_key: string | null;
  size_bytes: string | number | null;
  state: string;
};

async function targetsFor(orgId: string): Promise<TargetRow[]> {
  return exec<TargetRow>(sql`
    SELECT kind, source, storage_identity, provider, snapshot_id, object_key, size_bytes, state
      FROM backup_erasure_targets WHERE subject_org_id = ${orgId}
     ORDER BY kind, snapshot_id, object_key
  `);
}

function clearHooks(): void {
  delete __backupGcTestHooks.beforeIdentityState;
  delete __backupGcTestHooks.afterFenceRead;
}

describe('erasure fence capture', () => {
  afterEach(clearHooks);

  runDb('captures snapshots, retirements, reservations and recovery media with sidecars — idempotently across a partial cascade re-run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'breeze-fence-'));
    const partnerId = await seedPartner();
    const a = await seedOrg(partnerId, root);

    const snapDbId = await insertSnapshot(a, 'CAP-S1');
    // A legacy row with no denormalised identity resolves through its config.
    await insertSnapshot(a, 'CAP-S2', { identity: null });
    await exec(sql`
      INSERT INTO backup_snapshot_retirements (org_id, config_id, device_id, snapshot_id, storage_identity, backup_type, reason)
      VALUES (${a.orgId}, ${a.configId}, ${a.deviceId}, 'CAP-RET', ${a.identity}, 'file', 'expired')
    `);
    await exec(sql`
      INSERT INTO backup_snapshot_id_reservations (snapshot_id, org_id, device_id, config_id, storage_identity, source, state)
      VALUES ('CAP-RES', ${a.orgId}, ${a.deviceId}, ${a.configId}, ${a.identity}, 'server_minted', 'reserved')
    `);
    const tokenId = await insertRecoveryToken(a, snapDbId);
    const bundleId = randomUUID();
    await exec(sql`
      INSERT INTO recovery_media_artifacts (id, org_id, token_id, snapshot_id, platform, architecture, status,
                                            storage_key, checksum_storage_key, signature_storage_key)
      VALUES (${bundleId}, ${a.orgId}, ${tokenId}, ${snapDbId}, 'linux', 'amd64', 'ready',
              'recovery-media/b/bundle.tar.gz', 'recovery-media/b/CHECKSUM.txt', 'recovery-media/b/bundle.tar.gz.minisig')
    `);
    await exec(sql`
      INSERT INTO recovery_boot_media_artifacts (org_id, token_id, snapshot_id, bundle_artifact_id, platform, architecture,
                                                 status, storage_key, checksum_storage_key)
      VALUES (${a.orgId}, ${tokenId}, ${snapDbId}, ${bundleId}, 'linux', 'amd64', 'ready',
              'recovery-boot-media/i/boot.iso', 'recovery-boot-media/i/boot.iso.sha256')
    `);

    const first = await captureBackupErasureFence(a.orgId, { erasureJobId: 'job-cap-1' });
    expect(first).toEqual({ snapshotPrefixes: 4, recoveryMediaKeys: 5, unresolvedIdentity: 0 });
    const second = await captureBackupErasureFence(a.orgId, { erasureJobId: 'job-cap-2' });
    expect(second).toEqual(first);
    const captured = await targetsFor(a.orgId);
    expect(captured).toHaveLength(9);
    expect(captured.every((t) => t.state === 'fenced' && t.storage_identity === a.identity && t.provider === 'local')).toBe(true);
    expect(captured.filter((t) => t.kind === 'snapshot_prefix').map((t) => `${t.source}:${t.snapshot_id}`).sort())
      .toEqual(['reservation:CAP-RES', 'retirement:CAP-RET', 'snapshot:CAP-S1', 'snapshot:CAP-S2']);
    expect(captured.filter((t) => t.kind === 'recovery_media_key').map((t) => t.object_key).sort()).toEqual([
      'recovery-boot-media/i/boot.iso',
      'recovery-boot-media/i/boot.iso.sha256',
      'recovery-media/b/CHECKSUM.txt',
      'recovery-media/b/bundle.tar.gz',
      'recovery-media/b/bundle.tar.gz.minisig',
    ]);
    expect(Number(captured.find((t) => t.snapshot_id === 'CAP-S1' && t.kind === 'snapshot_prefix')?.size_bytes)).toBe(4096);
    const [manifest] = await exec<{ erasure_job_id: string; subject_partner_id: string }>(sql`
      SELECT erasure_job_id, subject_partner_id FROM backup_erasure_manifests WHERE subject_org_id = ${a.orgId}
    `);
    expect(manifest).toEqual({ erasure_job_id: 'job-cap-1', subject_partner_id: partnerId });

    // A partial cascade already removed the media children and the
    // retirement (they precede backup_snapshots in the walk); the re-run must
    // neither lose those targets nor duplicate any.
    await exec(sql`DELETE FROM recovery_boot_media_artifacts WHERE org_id = ${a.orgId}`);
    await exec(sql`DELETE FROM recovery_media_artifacts WHERE org_id = ${a.orgId}`);
    await exec(sql`DELETE FROM backup_snapshot_retirements WHERE org_id = ${a.orgId}`);
    await cascadeDeleteOrg(a.orgId, PERFORMED_BY);

    expect(await targetsFor(a.orgId)).toEqual(captured);
    const [audit] = await exec<{ org_id: string | null; details: Record<string, unknown> }>(sql`
      SELECT org_id, details FROM audit_logs
       WHERE action = 'tenant.erasure.backup_manifest_captured' AND resource_id = ${a.orgId}
       ORDER BY timestamp DESC LIMIT 1
    `);
    expect(audit?.org_id).toBeNull();
    expect(audit?.details).toEqual({ objectsRetained: true, snapshotPrefixes: 4, recoveryMediaKeys: 5, unresolvedIdentity: 0 });
  });

  runDb('rows created after the up-front capture and deleted by a PARENT step\'s ON DELETE CASCADE are fenced', async () => {
    const root = await mkdtemp(join(tmpdir(), 'breeze-fence-'));
    const a = await seedOrg(await seedPartner(), root);
    const baseSnapDbId = await insertSnapshot(a, 'LATE-S0');
    const tokenId = await insertRecoveryToken(a, baseSnapDbId);
    const [job] = await exec<{ id: string }>(sql`
      INSERT INTO backup_jobs (org_id, config_id, device_id, status) VALUES (${a.orgId}, ${a.configId}, ${a.deviceId}, 'running') RETURNING id
    `);

    // Each row appears AFTER its own table's walk step has run, so only the
    // parent's cascade (backup_jobs → backup_snapshots, devices →
    // reservations, backup_snapshots → recovery media) can remove it.
    __tenantCascadeTestHooks.afterTableStep = async (table) => {
      if (table === 'backup_snapshots') {
        await exec(sql`
          INSERT INTO backup_snapshots (org_id, job_id, device_id, config_id, snapshot_id, storage_identity, backup_type)
          VALUES (${a.orgId}, ${job!.id}, ${a.deviceId}, ${a.configId}, 'LATE-S1', ${a.identity}, 'file')
        `);
      }
      if (table === 'backup_snapshot_id_reservations') {
        await exec(sql`
          INSERT INTO backup_snapshot_id_reservations (snapshot_id, org_id, device_id, config_id, storage_identity, source, state)
          VALUES ('LATE-RES', ${a.orgId}, ${a.deviceId}, ${a.configId}, ${a.identity}, 'server_minted', 'reserved')
        `);
      }
      if (table === 'recovery_media_artifacts') {
        await exec(sql`
          INSERT INTO recovery_media_artifacts (org_id, token_id, snapshot_id, platform, architecture, status, storage_key, checksum_storage_key)
          VALUES (${a.orgId}, ${tokenId}, ${baseSnapDbId}, 'linux', 'amd64', 'ready', 'late-media/bundle.tar.gz', 'late-media/CHECKSUM.txt')
        `);
      }
    };
    try {
      await cascadeDeleteOrg(a.orgId, PERFORMED_BY);
    } finally {
      delete __tenantCascadeTestHooks.afterTableStep;
    }

    expect(await exec(sql`SELECT id FROM organizations WHERE id = ${a.orgId}`)).toHaveLength(0);
    const targets = await targetsFor(a.orgId);
    expect(targets.filter((t) => t.kind === 'snapshot_prefix').map((t) => t.snapshot_id).sort())
      .toEqual(['LATE-RES', 'LATE-S0', 'LATE-S1']);
    expect(targets.filter((t) => t.kind === 'recovery_media_key').map((t) => t.object_key).sort())
      .toEqual(['late-media/CHECKSUM.txt', 'late-media/bundle.tar.gz']);
  });

  runDb('control: the on-delete trigger records nothing outside an erasure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'breeze-fence-'));
    const a = await seedOrg(await seedPartner(), root);
    await insertSnapshot(a, 'NOERASE-S1');
    await exec(sql`DELETE FROM backup_snapshots WHERE org_id = ${a.orgId}`);
    expect(await targetsFor(a.orgId)).toEqual([]);
    // …and only for the org the erasure names.
    await insertSnapshot(a, 'NOERASE-S2');
    await withSystemDbAccessContext(async () => {
      await setBackupErasureContext(randomUUID());
      await db.execute(sql`DELETE FROM backup_snapshots WHERE org_id = ${a.orgId}`);
    });
    expect(await targetsFor(a.orgId)).toEqual([]);
  });

  runDb('the walk deletes backup_snapshots before every table a policy-level hold lives in', async () => {
    const order = await topologicalCascadeOrder();
    const at = (t: string) => order.indexOf(t);
    expect(at('backup_snapshots')).toBeGreaterThanOrEqual(0);
    // config_policy_feature_links has no org_id: it goes with its
    // configuration_policies row (ON DELETE CASCADE), so that row's position
    // covers it.
    for (const later of ['backup_policies', 'configuration_policies', 'config_policy_backup_settings', 'backup_configs', 'devices']) {
      expect(at(later), later).toBeGreaterThan(at('backup_snapshots'));
    }
  });

  runDb('the mid-cascade recheck refuses when a backup-policy hold appears after the entry check', async () => {
    const root = await mkdtemp(join(tmpdir(), 'breeze-fence-'));
    const a = await seedOrg(await seedPartner(), root);
    await insertSnapshot(a, 'MID-S1');
    await exec(sql`
      INSERT INTO backup_policies (org_id, config_id, name, schedule, retention, targets, legal_hold)
      VALUES (${a.orgId}, ${a.configId}, 'held later', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, true)
    `);
    await expect(deleteBackupSnapshotsCascadeStep(a.orgId)).rejects.toThrow(TenantCascadeRefusalError);
    const rows = await exec(sql`SELECT id FROM backup_snapshots WHERE org_id = ${a.orgId}`);
    expect(rows).toHaveLength(1);
  });
});

describe('storage GC racing an erasure', () => {
  afterEach(clearHooks);

  runDb('an erasure landing after the run loaded its owners but before the org unit loads its state never lets that unit reclaim the org\'s prefixes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'breeze-fence-'));
    const partnerId = await seedPartner();
    const a = await seedOrg(partnerId, root);
    await seedOrg(partnerId, root);
    const aKeys = await writeSnapshotObjects(root, 'RACE-A1', THIRTY_DAYS_MS);
    await insertSnapshot(a, 'RACE-A1');

    let erased = false;
    let hookError: unknown = null;
    __backupGcTestHooks.beforeIdentityState = async (identity) => {
      if (identity.orgId !== a.orgId || erased) return;
      erased = true;
      try {
        await cascadeDeleteOrg(a.orgId, PERFORMED_BY);
      } catch (err) {
        hookError = err;
        throw err;
      }
    };
    await sweepUnreferencedBackupObjects();
    expect(erased).toBe(true);
    expect(hookError).toBeNull();
    expect(await exec(sql`SELECT id FROM organizations WHERE id = ${a.orgId}`)).toHaveLength(0);

    const remaining = await listAll(root);
    for (const key of aKeys) expect(remaining).toContain(key);
  });

  runDb('an erasure landing after the unit read its fences is caught by the pre-delete recheck', async () => {
    const root = await mkdtemp(join(tmpdir(), 'breeze-fence-'));
    const partnerId = await seedPartner();
    const a = await seedOrg(partnerId, root);
    await seedOrg(partnerId, root);
    await writeSnapshotObjects(root, 'RACE-LIVE', THIRTY_DAYS_MS);
    await insertSnapshot(a, 'RACE-LIVE');
    // A retired prefix the unit has already decided to reclaim.
    const retiredKeys = await writeSnapshotObjects(root, 'RACE-RET', THIRTY_DAYS_MS);
    await exec(sql`
      INSERT INTO backup_snapshot_retirements (org_id, config_id, device_id, snapshot_id, storage_identity, backup_type, reason)
      VALUES (${a.orgId}, ${a.configId}, ${a.deviceId}, 'RACE-RET', ${a.identity}, 'file', 'expired')
    `);

    let erased = false;
    let hookError: unknown = null;
    __backupGcTestHooks.afterFenceRead = async (identity) => {
      if (identity.orgId !== a.orgId || erased) return;
      erased = true;
      try {
        await cascadeDeleteOrg(a.orgId, PERFORMED_BY);
      } catch (err) {
        hookError = err;
        throw err;
      }
    };
    await sweepUnreferencedBackupObjects();
    expect(erased).toBe(true);
    expect(hookError).toBeNull();
    expect(await exec(sql`SELECT id FROM organizations WHERE id = ${a.orgId}`)).toHaveLength(0);

    const remaining = await listAll(root);
    for (const key of retiredKeys) expect(remaining).toContain(key);
  });

  runDb('control: without an erasure the same retired prefix IS reclaimed (the recheck scenario is not vacuous)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'breeze-fence-'));
    const a = await seedOrg(await seedPartner(), root);
    await writeSnapshotObjects(root, 'CTRL-LIVE', THIRTY_DAYS_MS);
    await insertSnapshot(a, 'CTRL-LIVE');
    const retiredKeys = await writeSnapshotObjects(root, 'CTRL-RET', THIRTY_DAYS_MS);
    await exec(sql`
      INSERT INTO backup_snapshot_retirements (org_id, config_id, device_id, snapshot_id, storage_identity, backup_type, reason)
      VALUES (${a.orgId}, ${a.configId}, ${a.deviceId}, 'CTRL-RET', ${a.identity}, 'file', 'expired')
    `);
    await sweepUnreferencedBackupObjects();
    const remaining = await listAll(root);
    for (const key of retiredKeys) expect(remaining).not.toContain(key);
  });
});

describe('org merge', () => {
  runDb('erasing a merge loser fences only what is still the loser\'s — never the survivor\'s moved snapshots', async () => {
    const prior = process.env.ORG_MERGE_FENCE_DRAIN_MS;
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
    try {
      const root = await mkdtemp(join(tmpdir(), 'breeze-fence-'));
      const partnerId = await seedPartner();
      const loser = await seedOrg(partnerId, root);
      const survivor = await seedOrg(partnerId, root);
      const movedKeys = await writeSnapshotObjects(root, 'MERGE-L1', THIRTY_DAYS_MS);
      await insertSnapshot(loser, 'MERGE-L1');
      const [actor] = await exec<{ id: string; email: string }>(sql`
        INSERT INTO users (partner_id, email, name, status, is_platform_admin)
        VALUES (${partnerId}, ${`merge-actor-${unique()}@example.test`}, 'Merge Actor', 'active', true)
        RETURNING id, email
      `);

      await orgMergeModule.executeOrgMerge({
        loserOrgId: loser.orgId,
        survivorOrgId: survivor.orgId,
        partnerId,
        performedBy: actor!.id,
        performedByEmail: actor!.email,
      });
      const [moved] = await exec<{ org_id: string }>(sql`SELECT org_id FROM backup_snapshots WHERE snapshot_id = 'MERGE-L1'`);
      expect(moved?.org_id).toBe(survivor.orgId);

      await cascadeDeleteOrg(loser.orgId, actor!.id);
      expect(await targetsFor(loser.orgId)).toEqual([]);
      const fencedAnywhere = await exec(sql`SELECT id FROM backup_erasure_targets WHERE snapshot_id = 'MERGE-L1'`);
      expect(fencedAnywhere).toHaveLength(0);

      // Still the survivor's live snapshot: GC keeps it as a root, as before.
      await sweepUnreferencedBackupObjects();
      const remaining = await listAll(root);
      for (const key of movedKeys) expect(remaining).toContain(key);
    } finally {
      if (prior === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
      else process.env.ORG_MERGE_FENCE_DRAIN_MS = prior;
    }
  });
});

describe('an erasure that aborts after the up-front capture', () => {
  afterEach(() => {
    clearHooks();
    delete __tenantCascadeTestHooks.afterTableStep;
  });

  runDb('leaves the still-existing org\'s own GC working, while sibling orgs still never touch its prefixes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'breeze-fence-'));
    const partnerId = await seedPartner();
    const a = await seedOrg(partnerId, root);
    await seedOrg(partnerId, root); // sibling B on the same identity

    const liveKeys = await writeSnapshotObjects(root, 'ABORT-LIVE', THIRTY_DAYS_MS);
    await insertSnapshot(a, 'ABORT-LIVE');
    // A legacy NULL-identity row: fenced, but still A's own — it must not
    // push A's unit into deferred mode.
    const nullKeys = await writeSnapshotObjects(root, 'ABORT-NULL', THIRTY_DAYS_MS);
    await insertSnapshot(a, 'ABORT-NULL', { identity: null });
    // A retired prefix A's own retention already expired.
    const retiredKeys = await writeSnapshotObjects(root, 'ABORT-RET', THIRTY_DAYS_MS);
    await exec(sql`
      INSERT INTO backup_snapshot_retirements (org_id, config_id, device_id, snapshot_id, storage_identity, backup_type, reason)
      VALUES (${a.orgId}, ${a.configId}, ${a.deviceId}, 'ABORT-RET', ${a.identity}, 'file', 'expired')
    `);
    // A retired prefix whose retirement row the aborted cascade had ALREADY
    // deleted: its only owner now is the fence, so it stays kept.
    const goneKeys = await writeSnapshotObjects(root, 'ABORT-GONE', THIRTY_DAYS_MS);
    await exec(sql`
      INSERT INTO backup_snapshot_retirements (org_id, config_id, device_id, snapshot_id, storage_identity, backup_type, reason)
      VALUES (${a.orgId}, ${a.configId}, ${a.deviceId}, 'ABORT-GONE', ${a.identity}, 'file', 'expired')
    `);

    // Abort the walk right after its first step.
    let aborted = false;
    __tenantCascadeTestHooks.afterTableStep = async () => {
      if (aborted) return;
      aborted = true;
      throw new Error('injected mid-cascade failure');
    };
    await expect(cascadeDeleteOrg(a.orgId, PERFORMED_BY)).rejects.toThrow(/injected mid-cascade failure/);
    delete __tenantCascadeTestHooks.afterTableStep;
    expect(await exec(sql`SELECT id FROM organizations WHERE id = ${a.orgId}`)).toHaveLength(1);
    expect((await targetsFor(a.orgId)).map((t) => t.snapshot_id).sort())
      .toEqual(['ABORT-GONE', 'ABORT-LIVE', 'ABORT-NULL', 'ABORT-RET']);
    await exec(sql`DELETE FROM backup_snapshot_retirements WHERE snapshot_id = 'ABORT-GONE'`);

    await sweepUnreferencedBackupObjects();

    const remaining = await listAll(root);
    for (const key of retiredKeys) expect(remaining).not.toContain(key); // A's own GC reclaimed its expired prefix
    for (const key of [...liveKeys, ...nullKeys, ...goneKeys]) expect(remaining).toContain(key);
    // The NULL-identity row resolved and self-healed: A's unit was not deferred.
    const [healed] = await exec<{ storage_identity: string | null }>(sql`
      SELECT storage_identity FROM backup_snapshots WHERE snapshot_id = 'ABORT-NULL'
    `);
    expect(healed?.storage_identity).toBe(a.identity);
  });
});

describe('referenced keys of fenced snapshots', () => {
  runDb('are resolved once and stored; later runs keep them even when the manifest is no longer readable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'breeze-fence-'));
    const partnerId = await seedPartner();
    const a = await seedOrg(partnerId, root);
    await seedOrg(partnerId, root);
    await writeAged(root, 'snapshots/REF-A0/manifest.json', THIRTY_DAYS_MS, JSON.stringify({
      files: [{ backupPath: 'snapshots/REF-A0/files/base.dat' }],
    }));
    await writeAged(root, 'snapshots/REF-A0/files/base.dat', THIRTY_DAYS_MS);
    await writeSnapshotObjects(root, 'REF-A2', THIRTY_DAYS_MS, ['snapshots/REF-A0/files/base.dat']);
    await insertSnapshot(a, 'REF-A2');
    await cascadeDeleteOrg(a.orgId, PERFORMED_BY);

    await sweepUnreferencedBackupObjects();
    const [stored] = await exec<{ state: string; referenced_keys: string[] }>(sql`
      SELECT state, referenced_keys FROM backup_erasure_fence_refs WHERE snapshot_id = 'REF-A2'
    `);
    expect(stored).toEqual({ state: 'resolved', referenced_keys: ['snapshots/REF-A0/files/base.dat'] });

    // The fenced manifest becomes unreadable; the stored set still protects
    // the base object, and the run neither fails nor defers.
    await writeAged(root, 'snapshots/REF-A2/manifest.json', THIRTY_DAYS_MS, '{not json');
    await writeAged(root, 'snapshots/REF-ORPHAN/manifest.json', TEN_DAYS_MS, JSON.stringify({ files: [] }));
    const result = await sweepUnreferencedBackupObjects();
    expect(result.blockedIdentities).toBe(0);
    const remaining = await listAll(root);
    expect(remaining).toContain('snapshots/REF-A0/files/base.dat');
    expect(remaining).not.toContain('snapshots/REF-ORPHAN/manifest.json');
  });

  runDb('an unreadable fenced manifest is retried with backoff and defers reclamation instead of failing sibling sweeps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'breeze-fence-'));
    const partnerId = await seedPartner();
    const a = await seedOrg(partnerId, root);
    const b = await seedOrg(partnerId, root);
    await writeAged(root, 'snapshots/BAD-A1/manifest.json', THIRTY_DAYS_MS, '{not json');
    await writeAged(root, 'snapshots/BAD-A1/files/a.dat', THIRTY_DAYS_MS);
    await insertSnapshot(a, 'BAD-A1');
    await cascadeDeleteOrg(a.orgId, PERFORMED_BY);
    // B's retired prefix would normally be reclaimed this run.
    const bRetired = await writeSnapshotObjects(root, 'BAD-BRET', THIRTY_DAYS_MS);
    await exec(sql`
      INSERT INTO backup_snapshot_retirements (org_id, config_id, device_id, snapshot_id, storage_identity, backup_type, reason)
      VALUES (${b.orgId}, ${b.configId}, ${b.deviceId}, 'BAD-BRET', ${b.identity}, 'file', 'expired')
    `);

    const result = await sweepUnreferencedBackupObjects();
    expect(result.blockedIdentities).toBe(0);
    expect(result.deferredIdentities).toBeGreaterThanOrEqual(1);
    const remaining = await listAll(root);
    expect(remaining).toContain('snapshots/BAD-A1/manifest.json');
    expect(remaining).toContain('snapshots/BAD-A1/files/a.dat');
    for (const key of bRetired) expect(remaining).toContain(key); // deferred, not reclaimed
    const [row] = await exec<{ state: string; attempts: number; next_attempt_at: Date }>(sql`
      SELECT state, attempts, next_attempt_at FROM backup_erasure_fence_refs WHERE snapshot_id = 'BAD-A1'
    `);
    expect(row?.state).toBe('unreadable');
    expect(row?.attempts).toBe(1);
    expect(new Date(row!.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 30 * 60 * 1000);

    // Within the backoff the manifest is not re-read (attempts unchanged).
    await sweepUnreferencedBackupObjects();
    const [again] = await exec<{ attempts: number }>(sql`
      SELECT attempts FROM backup_erasure_fence_refs WHERE snapshot_id = 'BAD-A1'
    `);
    expect(again?.attempts).toBe(1);
  });
});
