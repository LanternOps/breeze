/**
 * Storage destinations for backup commands live only in the outgoing frame.
 *
 *  - the delivery refresher resolves a stored reference under a real
 *    organization-scoped RLS context (as the unprivileged app role), and
 *    refuses when the target device is not in the referenced organization —
 *    including under a system context (REST poll, heartbeat drain), where RLS
 *    does not hide the other organization's device;
 *  - a statement error while resolving one command inside a held delivery
 *    transaction withholds that command only: the transaction stays usable
 *    and its sibling commands are still delivered;
 *  - the cleanup migration removes stored destinations from TERMINAL
 *    device_commands rows only, removes credential-shaped keys from DR plan
 *    step configuration at any depth, and is a no-op on replay;
 *  - the device_commands pass walks the table in bounded batches and reaches
 *    every row across batch boundaries.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/backupCommandStoredDestination.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  backupReadCredentialPayload,
  materializeBackupStorageCredentials,
} from '../../services/backupCommandCredentials';
import { prepareClaimedCommandsForDelivery } from '../../services/commandDelivery';
import { CommandDeliveryRefusedError } from '../../services/commandDeliveryRefusal';
import { createOrganization, createPartner } from './db-utils';
import { replayMigration } from './replayMigration';
import { getTestDb } from './setup';

const MIGRATION = '2026-11-05-100500-backup-command-stored-destination-cleanup.sql';
const runDb = it.runIf(!!process.env.DATABASE_URL);

const S3_DESTINATION = {
  bucket: 'tenant-bucket',
  region: 'us-east-1',
  accessKey: 'AKIA-SYNTHETIC-ACCESS',
  secretKey: 'synthetic-secret-value',
};

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

async function insertCommand(
  deviceId: string,
  status: string,
  payload: Record<string, unknown>,
  id: string = randomUUID(),
): Promise<string> {
  await getTestDb().execute(sql`
    INSERT INTO device_commands (id, device_id, type, status, payload)
    VALUES (${id}, ${deviceId}, 'backup_restore', ${status}, ${JSON.stringify(payload)}::jsonb)
  `);
  return id;
}

async function insertClaimedCommand(
  deviceId: string,
  claimedAt: Date,
  payload: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO device_commands (id, device_id, type, status, payload, executed_at)
    VALUES (${id}, ${deviceId}, 'backup_verify', 'sent', ${JSON.stringify(payload)}::jsonb, ${claimedAt.toISOString()}::timestamp)
  `);
  return id;
}

async function commandStatus(id: string): Promise<string> {
  const rows = (await getTestDb().execute(
    sql`SELECT status FROM device_commands WHERE id = ${id}`,
  )) as unknown as Array<{ status: string }>;
  return rows[0]!.status;
}

// Read commands resolve only a LOCAL destination (an S3 read is served
// through a storage session), so the read-path tests below use one.
const LOCAL_DESTINATION = { path: '/srv/breeze-backups' };

async function insertLocalConfig(orgId: string): Promise<string> {
  const configId = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO backup_configs (id, org_id, name, type, provider, provider_config)
    VALUES (${configId}, ${orgId}, 'Primary', 'file', 'local', ${JSON.stringify(LOCAL_DESTINATION)}::jsonb)
  `);
  return configId;
}

async function insertS3Config(orgId: string): Promise<string> {
  const configId = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO backup_configs (id, org_id, name, type, provider, provider_config)
    VALUES (${configId}, ${orgId}, 'Primary', 'file', 's3', ${JSON.stringify(S3_DESTINATION)}::jsonb)
  `);
  return configId;
}

async function commandPayload(id: string): Promise<Record<string, unknown>> {
  const rows = (await getTestDb().execute(
    sql`SELECT payload FROM device_commands WHERE id = ${id}`,
  )) as unknown as Array<{ payload: Record<string, unknown> }>;
  return rows[0]!.payload;
}

describe('backup command storage destinations', () => {
  runDb('resolves a stored reference at delivery under the referenced organization only', async () => {
    const home = await seedOrgWithDevice();
    const foreign = await seedOrgWithDevice();
    const configId = await insertLocalConfig(home.orgId);

    const stored = { snapshotId: 'snap-1', ...backupReadCredentialPayload(configId, home.orgId, 'local') };

    const delivered = await runOutsideDbContext(() =>
      materializeBackupStorageCredentials(stored, {
        commandId: randomUUID(),
        deviceId: home.deviceId,
        type: 'backup_restore',
        claimedAt: new Date(),
      }),
    );
    expect(delivered).toEqual({ snapshotId: 'snap-1', provider: 'local', providerConfig: LOCAL_DESTINATION });

    // A device of another organization cannot be handed this destination,
    // whatever the stored reference says.
    await expect(
      runOutsideDbContext(() =>
        materializeBackupStorageCredentials(stored, {
          commandId: randomUUID(),
          deviceId: foreign.deviceId,
          type: 'backup_restore',
          claimedAt: new Date(),
        }),
      ),
    ).rejects.toBeInstanceOf(CommandDeliveryRefusedError);

    // Nor can a reference that names the foreign org reach the home config.
    await expect(
      runOutsideDbContext(() =>
        materializeBackupStorageCredentials(
          { ...backupReadCredentialPayload(configId, foreign.orgId, 'local') },
          { commandId: randomUUID(), deviceId: foreign.deviceId, type: 'backup_restore', claimedAt: new Date() },
        ),
      ),
    ).rejects.toBeInstanceOf(CommandDeliveryRefusedError);
  });

  runDb('refuses a device of another organization when delivery runs in a system context', async () => {
    // The REST poll and the heartbeat drain claim and deliver under a SYSTEM
    // context, where RLS shows every organization's devices. The refresher's
    // own device/org check is then the only thing binding the reference to
    // the target device.
    const home = await seedOrgWithDevice();
    const foreign = await seedOrgWithDevice();
    const configId = await insertLocalConfig(home.orgId);
    const stored = { snapshotId: 'snap-1', ...backupReadCredentialPayload(configId, home.orgId, 'local') };

    const inSystemContext = <T>(fn: () => Promise<T>) =>
      runOutsideDbContext(() => withSystemDbAccessContext(fn, 'backupCommandStoredDestination.test'));

    await expect(
      inSystemContext(() =>
        materializeBackupStorageCredentials(stored, {
          commandId: randomUUID(),
          deviceId: foreign.deviceId,
          type: 'backup_restore',
          claimedAt: new Date(),
        }),
      ),
    ).rejects.toBeInstanceOf(CommandDeliveryRefusedError);

    // Control: the same system context resolves the destination for the
    // referenced organization's own device.
    await expect(
      inSystemContext(() =>
        materializeBackupStorageCredentials(stored, {
          commandId: randomUUID(),
          deviceId: home.deviceId,
          type: 'backup_restore',
          claimedAt: new Date(),
        }),
      ),
    ).resolves.toEqual({ snapshotId: 'snap-1', provider: 'local', providerConfig: LOCAL_DESTINATION });
  });

  runDb('never resolves an S3 destination into a read command', async () => {
    const home = await seedOrgWithDevice();
    const configId = await insertS3Config(home.orgId);
    await expect(
      runOutsideDbContext(() =>
        materializeBackupStorageCredentials(
          { snapshotId: 'snap-1', ...backupReadCredentialPayload(configId, home.orgId, 's3') },
          { commandId: randomUUID(), deviceId: home.deviceId, type: 'backup_restore', claimedAt: new Date() },
        ),
      ),
    ).rejects.toBeInstanceOf(CommandDeliveryRefusedError);
  });

  runDb('a statement error resolving one command leaves the held delivery transaction usable', async () => {
    const home = await seedOrgWithDevice();
    const configId = await insertLocalConfig(home.orgId);
    const stored = { snapshotId: 'snap-1', ...backupReadCredentialPayload(configId, home.orgId, 'local') };
    // Millisecond precision so the release fence (executed_at = claim) matches.
    const claimedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 5000);
    const broken = await insertClaimedCommand(home.deviceId, claimedAt, stored);
    const healthy = await insertClaimedCommand(home.deviceId, claimedAt, stored);
    const foreign = await seedOrgWithDevice();
    const refused = await insertClaimedCommand(foreign.deviceId, claimedAt, stored);

    // The heartbeat claims and delivers inside its organization-scoped
    // transaction. A device id Postgres cannot parse makes the first
    // command's resolution fail with a real statement error (22P02).
    // Verification reads the same stored destination as a restore without the
    // restore integrity requirements (helper protocol, attested snapshot),
    // which this fixture does not seed.
    const delivered = await runOutsideDbContext(() =>
      withDbAccessContext(
        { scope: 'organization', orgId: home.orgId, accessibleOrgIds: [home.orgId] },
        async () => {
          const out = await prepareClaimedCommandsForDelivery([
            { id: broken, type: 'backup_verify', deviceId: 'unparseable-device-id', payload: stored, executedAt: claimedAt },
            { id: refused, type: 'backup_verify', deviceId: foreign.deviceId, payload: stored, executedAt: claimedAt },
            { id: healthy, type: 'backup_verify', deviceId: home.deviceId, payload: stored, executedAt: claimedAt },
          ]);
          // Later statements in the same transaction still run.
          await db.execute(sql`SELECT 1`);
          return out;
        },
      ),
    );

    expect(delivered.map((cmd) => cmd.id)).toEqual([healthy]);
    expect(delivered[0]!.payload).toEqual({ snapshotId: 'snap-1', provider: 'local', providerConfig: LOCAL_DESTINATION });
    // The failed command was released for a later attempt, and that release
    // committed with the outer transaction.
    expect(await commandStatus(broken)).toBe('pending');
    expect(await commandStatus(healthy)).toBe('sent');
    // A refusal still reaches the delivery seam as a refusal: the row is
    // expired (pending with a delivery deadline and the reason recorded), not released.
    const [refusedRow] = (await getTestDb().execute(sql`
      SELECT status, deliver_by IS NOT NULL AS expired, result FROM device_commands WHERE id = ${refused}
    `)) as unknown as Array<{ status: string; expired: boolean; result: Record<string, unknown> | null }>;
    expect(refusedRow).toMatchObject({ status: 'pending', expired: true });
    expect(refusedRow!.result).toHaveProperty('deliveryRefusal');
  });

  runDb('the cleanup migration strips terminal rows and DR plans, leaves in-flight rows, and replays as a no-op', async () => {
    const { orgId, deviceId } = await seedOrgWithDevice();
    const completed = await insertCommand(deviceId, 'completed', {
      restoreJobId: 'rj-1', provider: 's3', providerConfig: S3_DESTINATION,
    });
    const failed = await insertCommand(deviceId, 'failed', {
      restoreJobId: 'rj-2', providerConfigEnvelope: 'enc:v3:current:synthetic',
    });
    const pending = await insertCommand(deviceId, 'pending', {
      restoreJobId: 'rj-3', provider: 's3', providerConfig: S3_DESTINATION,
    });
    const sent = await insertCommand(deviceId, 'sent', {
      restoreJobId: 'rj-4', provider: 's3', providerConfig: S3_DESTINATION,
    });

    const planId = randomUUID();
    const dirtyGroup = randomUUID();
    const cleanGroup = randomUUID();
    await getTestDb().execute(sql`INSERT INTO dr_plans (id, org_id, name) VALUES (${planId}, ${orgId}, 'Plan')`);
    const cleanConfig = { commandType: 'vm_restore_from_backup', payload: { snapshotId: 'snap-1', vmName: 'VM' } };
    await getTestDb().execute(sql`
      INSERT INTO dr_plan_groups (id, plan_id, org_id, name, restore_config) VALUES
        (${dirtyGroup}, ${planId}, ${orgId}, 'Dirty', ${JSON.stringify({
          commandType: 'hyperv_restore',
          apiKey: 'synthetic-api-key',
          payload: {
            snapshotId: 'snap-1',
            vmName: 'VM',
            providerConfig: S3_DESTINATION,
            options: [{ password: 'synthetic-password', keep: true }],
            recoveryTokenId: '99999999-9999-4999-8999-999999999999',
          },
        })}::jsonb),
        (${cleanGroup}, ${planId}, ${orgId}, 'Clean', ${JSON.stringify(cleanConfig)}::jsonb)
    `);

    await replayMigration(MIGRATION);

    expect(await commandPayload(completed)).toEqual({ restoreJobId: 'rj-1', provider: 's3' });
    expect(await commandPayload(failed)).toEqual({ restoreJobId: 'rj-2' });
    // In-flight rows still need their inline destination to be delivered.
    expect(await commandPayload(pending)).toEqual({ restoreJobId: 'rj-3', provider: 's3', providerConfig: S3_DESTINATION });
    expect(await commandPayload(sent)).toEqual({ restoreJobId: 'rj-4', provider: 's3', providerConfig: S3_DESTINATION });

    const groups = (await getTestDb().execute(sql`
      SELECT id, restore_config FROM dr_plan_groups WHERE id IN (${dirtyGroup}, ${cleanGroup})
    `)) as unknown as Array<{ id: string; restore_config: unknown }>;
    const byId = new Map(groups.map((g) => [g.id, g.restore_config]));
    expect(byId.get(dirtyGroup)).toEqual({
      commandType: 'hyperv_restore',
      payload: {
        snapshotId: 'snap-1',
        vmName: 'VM',
        options: [{ keep: true }],
        recoveryTokenId: '99999999-9999-4999-8999-999999999999',
      },
    });
    expect(byId.get(cleanGroup)).toEqual(cleanConfig);

    await replayMigration(MIGRATION);
    expect(await commandPayload(completed)).toEqual({ restoreJobId: 'rj-1', provider: 's3' });
    expect(await commandPayload(pending)).toEqual({ restoreJobId: 'rj-3', provider: 's3', providerConfig: S3_DESTINATION });
  });

  runDb('the cleanup migration reaches every terminal row across batch boundaries', async () => {
    const text = await readFile(new URL(`../../../migrations/${MIGRATION}`, import.meta.url), 'utf8');
    const BATCH_LITERAL = 'batch_size constant integer := 5000;';
    expect(text).toContain(BATCH_LITERAL);

    const { deviceId } = await seedOrgWithDevice();
    // Ids straddle the whole key space so rows of this test sit between rows
    // of every other test, and a batch of two splits them many times over.
    const idsAt = (prefixes: string[]) => prefixes.map((p) => `${p}${randomUUID().slice(2)}`);
    const terminal = await Promise.all(
      idsAt(['00', '1f', '3a', '5c', '7e', '9d', 'bb', 'dd', 'ff']).map((id, i) =>
        insertCommand(deviceId, i % 2 ? 'failed' : 'completed', {
          restoreJobId: `rj-${i}`, provider: 's3', providerConfig: S3_DESTINATION,
        }, id),
      ),
    );
    const inFlight = await Promise.all(
      idsAt(['0f', '80', 'f0']).map((id, i) =>
        insertCommand(deviceId, i % 2 ? 'sent' : 'pending', {
          restoreJobId: `rj-live-${i}`, provider: 's3', providerConfig: S3_DESTINATION,
        }, id),
      ),
    );

    await getTestDb().execute(sql.raw(text.replace(BATCH_LITERAL, 'batch_size constant integer := 2;')));

    for (const [i, id] of terminal.entries()) {
      expect(await commandPayload(id)).toEqual({ restoreJobId: `rj-${i}`, provider: 's3' });
    }
    for (const [i, id] of inFlight.entries()) {
      expect(await commandPayload(id)).toEqual({
        restoreJobId: `rj-live-${i}`, provider: 's3', providerConfig: S3_DESTINATION,
      });
    }
  });
});
