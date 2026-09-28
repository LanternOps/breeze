/**
 * Shared real-Postgres fixtures for the brokered backup write suites
 * (backupSnapshotIdReservations / backupStorageWriteSessions integration
 * tests). Seeds through the superuser client; code under test runs as
 * breeze_app through `db` inside an access context.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DbAccessContext } from '../../db';
import { normalizeStorageIdentity } from '../../jobs/backupRetention';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

export const WRITE_DESTINATION = {
  bucket: 'shared-bucket',
  region: 'us-east-1',
  endpoint: 'https://storage.example',
  accessKey: 'AKIA-SYNTHETIC-ACCESS',
  secretKey: 'synthetic-secret-value',
};
/** The same physical bucket reached through another host name. */
export const WRITE_DESTINATION_ALIAS = { ...WRITE_DESTINATION, endpoint: 'https://alias.storage.example' };
export const WRITE_IDENTITY = normalizeStorageIdentity('s3', WRITE_DESTINATION);

export function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

export async function seedWriteDevice(orgId: string, siteId: string, writeProtocol = 1): Promise<string> {
  const id = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version,
                         backup_read_protocol_version, backup_write_protocol_version)
    VALUES (${id}, ${orgId}, ${siteId}, ${`agent-${randomUUID()}`}, ${`host-${randomUUID()}`}, 'windows', '11',
            'amd64', '2.0.0', 1, ${writeProtocol})
  `);
  return id;
}

export async function seedBackupJob(
  orgId: string,
  configId: string,
  deviceId: string,
  status: 'pending' | 'running' | 'completed' | 'failed' = 'running',
): Promise<string> {
  const id = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO backup_jobs (id, org_id, config_id, device_id, status, type, storage_identity)
    VALUES (${id}, ${orgId}, ${configId}, ${deviceId}, ${status}::backup_status, 'scheduled', ${WRITE_IDENTITY})
  `);
  return id;
}

export type WriteTenant = {
  partnerId: string;
  orgId: string;
  siteId: string;
  deviceId: string;
  configId: string;
  jobId: string;
};

export async function seedWriteTenant(
  opts: { destination?: Record<string, unknown>; writeProtocol?: number; jobStatus?: 'pending' | 'running' | 'completed' } = {},
): Promise<WriteTenant> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const siteId = randomUUID();
  await getTestDb().execute(sql`INSERT INTO sites (id, org_id, name) VALUES (${siteId}, ${org.id}, 'Primary')`);
  const deviceId = await seedWriteDevice(org.id, siteId, opts.writeProtocol ?? 1);
  const configId = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO backup_configs (id, org_id, name, type, provider, provider_config)
    VALUES (${configId}, ${org.id}, 'Primary', 'file', 's3', ${JSON.stringify(opts.destination ?? WRITE_DESTINATION)}::jsonb)
  `);
  const jobId = await seedBackupJob(org.id, configId, deviceId, opts.jobStatus ?? 'running');
  return { partnerId: partner.id, orgId: org.id, siteId, deviceId, configId, jobId };
}

export async function insertSnapshotRow(
  t: Pick<WriteTenant, 'orgId' | 'deviceId' | 'configId' | 'jobId'>,
  snapshotId: string,
  storageIdentity: string | null = WRITE_IDENTITY,
): Promise<string> {
  const id = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO backup_snapshots (id, org_id, job_id, device_id, config_id, snapshot_id, storage_identity)
    VALUES (${id}, ${t.orgId}, ${t.jobId}, ${t.deviceId}, ${t.configId}, ${snapshotId}, ${storageIdentity})
  `);
  return id;
}

export async function reservationRow(snapshotId: string): Promise<Record<string, unknown> | null> {
  const rows = (await getTestDb().execute(sql`
    SELECT * FROM backup_snapshot_id_reservations WHERE snapshot_id = ${snapshotId}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

export async function tombstoneReason(snapshotId: string): Promise<string | null> {
  const rows = (await getTestDb().execute(sql`
    SELECT reason FROM backup_snapshot_id_tombstones WHERE snapshot_id = ${snapshotId}
  `)) as unknown as Array<{ reason: string }>;
  return rows[0]?.reason ?? null;
}

/** Walks a thrown drizzle/postgres error to its SQLSTATE. */
export function sqlState(err: unknown): string | null {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

export async function expectSqlState(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
  } catch (err) {
    return sqlState(err) ?? 'thrown-without-code';
  }
  return null;
}
