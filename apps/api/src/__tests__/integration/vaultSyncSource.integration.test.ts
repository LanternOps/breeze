/**
 * #11858: Sync now reads a vault snapshot from the destination it was written
 * to, not the backup helper's default store.
 *
 *  - resolveVaultSyncSource, under a real organization-scoped RLS context (as
 *    the unprivileged app role), names the snapshot's own local destination by
 *    reference, names none for a snapshot that recorded no destination, and
 *    refuses when the recorded destination no longer resolves;
 *  - it never resolves another organization's snapshot;
 *  - the vault_sync delivery refresher turns the reference into the local path
 *    for the referenced organization's device only.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/vaultSyncSource.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { runOutsideDbContext, withDbAccessContext } from '../../db';
import { prepareClaimedCommandsForDelivery } from '../../services/commandDelivery';
import { resolveVaultSyncSource } from '../../services/vaultDeviceCommands';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const LAB_DESTINATION = { path: '/srv/lab-backups' };

async function seedOrgWithDevice() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const siteId = randomUUID();
  const deviceId = randomUUID();
  await getTestDb().execute(sql`INSERT INTO sites (id, org_id, name) VALUES (${siteId}, ${org.id}, 'Primary')`);
  await getTestDb().execute(sql`
    INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
    VALUES (${deviceId}, ${org.id}, ${siteId}, ${`agent-${randomUUID()}`}, ${`host-${randomUUID()}`}, 'windows', '11', 'amd64', '2.0.0')
  `);
  return { orgId: org.id, deviceId };
}

async function insertConfig(orgId: string, provider: string, providerConfig: Record<string, unknown>): Promise<string> {
  const configId = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO backup_configs (id, org_id, name, type, provider, provider_config)
    VALUES (${configId}, ${orgId}, 'Primary', 'file', ${provider}, ${JSON.stringify(providerConfig)}::jsonb)
  `);
  return configId;
}

/** A completed file backup whose snapshot recorded `snapshotConfigId` (NULL = never recorded). */
async function insertSnapshot(
  org: { orgId: string; deviceId: string },
  jobConfigId: string,
  snapshotConfigId: string | null,
  snapshotId: string,
  timestamp: Date,
): Promise<void> {
  const jobId = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO backup_jobs (id, org_id, config_id, device_id, status, type)
    VALUES (${jobId}, ${org.orgId}, ${jobConfigId}, ${org.deviceId}, 'completed', 'manual')
  `);
  await getTestDb().execute(sql`
    INSERT INTO backup_snapshots (org_id, job_id, device_id, config_id, snapshot_id, timestamp, backup_type)
    VALUES (${org.orgId}, ${jobId}, ${org.deviceId}, ${snapshotConfigId}, ${snapshotId}, ${timestamp.toISOString()}::timestamp, 'file')
  `);
}

function asOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() =>
    withDbAccessContext({ scope: 'organization', orgId, accessibleOrgIds: [orgId] }, fn),
  );
}

describe('vault sync source', () => {
  runDb("names the local destination the device's newest snapshot was written to, and delivers its path", async () => {
    const home = await seedOrgWithDevice();
    const foreign = await seedOrgWithDevice();
    const labConfig = await insertConfig(home.orgId, 'local', LAB_DESTINATION);
    await insertSnapshot(home, labConfig, labConfig, 'snap-older', new Date('2026-11-01T00:00:00Z'));
    await insertSnapshot(home, labConfig, labConfig, 'snap-newest', new Date('2026-11-02T00:00:00Z'));

    const source = await asOrg(home.orgId, () => resolveVaultSyncSource(home.deviceId, home.orgId));
    expect(source).toEqual({
      ok: true,
      snapshotId: 'snap-newest',
      destination: { provider: 'local', providerConfigRef: { configId: labConfig, orgId: home.orgId } },
    });
    if (!source.ok || !source.destination) throw new Error('unreachable');

    const stored = { vaultId: randomUUID(), vaultPath: 'D:/Vault', snapshotId: source.snapshotId, ...source.destination };
    const claimedAt = new Date();
    const homeId = randomUUID();
    const foreignId = randomUUID();
    const out = await asOrg(home.orgId, () => prepareClaimedCommandsForDelivery([
      { id: homeId, type: 'vault_sync', deviceId: home.deviceId, payload: stored, executedAt: claimedAt },
      { id: foreignId, type: 'vault_sync', deviceId: foreign.deviceId, payload: stored, executedAt: claimedAt },
    ]));

    const delivered = out.find((c) => c.id === homeId);
    expect(delivered?.payload).toEqual({
      vaultId: stored.vaultId,
      vaultPath: 'D:/Vault',
      snapshotId: 'snap-newest',
      provider: 'local',
      providerConfig: LAB_DESTINATION,
    });
    // Another organization's device is never handed this destination.
    expect(out.find((c) => c.id === foreignId)).toBeUndefined();
  });

  runDb('names no destination for a snapshot that recorded none (the helper reads its own store)', async () => {
    const home = await seedOrgWithDevice();
    const config = await insertConfig(home.orgId, 'local', LAB_DESTINATION);
    await insertSnapshot(home, config, null, 'snap-legacy', new Date());

    expect(await asOrg(home.orgId, () => resolveVaultSyncSource(home.deviceId, home.orgId))).toEqual({
      ok: true, snapshotId: 'snap-legacy', destination: null,
    });
  });

  runDb('refuses when the recorded destination does not resolve in this organization', async () => {
    const home = await seedOrgWithDevice();
    const foreign = await seedOrgWithDevice();
    const config = await insertConfig(home.orgId, 'local', LAB_DESTINATION);
    // backup_snapshots.config_id is a plain FK, so a snapshot can name a
    // configuration of another organization. It must not resolve.
    const foreignConfig = await insertConfig(foreign.orgId, 'local', { path: '/srv/foreign' });
    await insertSnapshot(home, config, foreignConfig, 'snap-orphan', new Date());

    expect(await asOrg(home.orgId, () => resolveVaultSyncSource(home.deviceId, home.orgId))).toEqual({
      ok: false, status: 422, error: 'Backup destination configuration not found for this snapshot',
    });
  });

  runDb("never resolves another organization's snapshot, even when named", async () => {
    const home = await seedOrgWithDevice();
    const foreign = await seedOrgWithDevice();
    const foreignConfig = await insertConfig(foreign.orgId, 'local', LAB_DESTINATION);
    await insertSnapshot(foreign, foreignConfig, foreignConfig, 'snap-foreign', new Date());

    // The home org asking about the foreign device, in its own context.
    expect(await asOrg(home.orgId, () => resolveVaultSyncSource(foreign.deviceId, home.orgId, 'snap-foreign'))).toEqual({
      ok: false, status: 404, error: 'Backup snapshot not found for this device',
    });
    // RLS hides the foreign row even when the foreign org id is passed.
    expect(await asOrg(home.orgId, () => resolveVaultSyncSource(foreign.deviceId, foreign.orgId, 'snap-foreign'))).toEqual({
      ok: false, status: 404, error: 'Backup snapshot not found for this device',
    });
  });
});
