import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';
import { processBackupVerificationResult, timeoutStaleVerifications } from '../../routes/backup/verificationService';
import {
  LEGACY_VERIFICATION_TIMEOUT_REASON,
  VERIFICATION_TIMEOUT_REASON_CODE,
  verificationTimeoutMs,
  verificationTimeoutReason,
} from '../../routes/backup/verificationTimeout';

// #11813 against real Postgres: the timeout scan's derived cutoff, the stable
// reason code it now writes, and the late-result lookup, which must match both
// new rows (by code) and rows written before the code existed (by old text).

async function fixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const siteId = randomUUID();
  const deviceId = randomUUID();
  const configId = randomUUID();
  const jobId = randomUUID();
  const db = getTestDb();
  await db.execute(sql`INSERT INTO sites (id, org_id, name) VALUES (${siteId}, ${org.id}, 'Main')`);
  await db.execute(sql`
    INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
    VALUES (${deviceId}, ${org.id}, ${siteId}, ${`agent-${randomUUID()}`}, 'verify-host', 'windows', '11', 'amd64', '2.0.0')
  `);
  await db.execute(sql`
    INSERT INTO backup_configs (id, org_id, name, type, provider, provider_config)
    VALUES (${configId}, ${org.id}, 'Timeout', 'file', 'local', '{}'::jsonb)
  `);
  await db.execute(sql`
    INSERT INTO backup_jobs (id, org_id, config_id, device_id, status, type)
    VALUES (${jobId}, ${org.id}, ${configId}, ${deviceId}, 'completed', 'manual')
  `);
  return { orgId: org.id, deviceId, jobId };
}

async function insertVerification(
  f: { orgId: string; deviceId: string; jobId: string },
  status: string,
  ageMs: number,
  details: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();
  const startedAt = new Date(Date.now() - ageMs).toISOString();
  await getTestDb().execute(sql`
    INSERT INTO backup_verifications (id, org_id, device_id, backup_job_id, verification_type, status, started_at, details)
    VALUES (${id}, ${f.orgId}, ${f.deviceId}, ${f.jobId}, 'integrity', ${status}, ${startedAt}::timestamptz, ${JSON.stringify(details)}::jsonb)
  `);
  return id;
}

async function insertCommand(deviceId: string): Promise<string> {
  const id = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO device_commands (id, device_id, type, payload, status, executed_at)
    VALUES (${id}, ${deviceId}, 'backup_verify', '{}'::jsonb, 'sent', now())
  `);
  return id;
}

async function verificationRow(id: string) {
  const rows = await getTestDb().execute(sql`SELECT status, files_verified, details FROM backup_verifications WHERE id = ${id}`);
  return (rows as unknown as Array<{ status: string; files_verified: number | null; details: Record<string, unknown> }>)[0];
}

async function commandRow(id: string) {
  const rows = await getTestDb().execute(sql`SELECT status, result FROM device_commands WHERE id = ${id}`);
  return (rows as unknown as Array<{ status: string; result: Record<string, unknown> | null }>)[0];
}

describe('backup verification timeout (#11813)', () => {
  it('leaves a verification inside its command budget running and fails one past it with the reason code', async () => {
    const f = await fixture();
    const healthyCommand = await insertCommand(f.deviceId);
    const staleCommand = await insertCommand(f.deviceId);
    const healthy = await insertVerification(f, 'running', 45 * 60 * 1000, { commandId: healthyCommand });
    const stale = await insertVerification(f, 'running', verificationTimeoutMs('integrity') + 60 * 1000, { commandId: staleCommand });

    await timeoutStaleVerifications();

    expect((await verificationRow(healthy))?.status).toBe('running');
    expect((await commandRow(healthyCommand))?.status).toBe('sent');

    const failed = await verificationRow(stale);
    expect(failed?.status).toBe('failed');
    expect(failed?.details).toMatchObject({
      commandId: staleCommand,
      reason: verificationTimeoutReason('integrity'),
      reasonCode: VERIFICATION_TIMEOUT_REASON_CODE,
    });
    const command = await commandRow(staleCommand);
    expect(command?.status).toBe('failed');
    expect(command?.result).toMatchObject({
      status: 'timeout',
      error: verificationTimeoutReason('integrity'),
      timedOutBy: 'verification-timeout-check',
    });
  });

  it.each([
    ['the old literal text only', { reason: LEGACY_VERIFICATION_TIMEOUT_REASON }],
    ['the reason code', { reason: 'Verification timed out after 125 minutes', reasonCode: VERIFICATION_TIMEOUT_REASON_CODE }],
  ])('applies a late agent result to a timed-out row marked by %s', async (_label, marker) => {
    const f = await fixture();
    const commandId = randomUUID();
    const id = await insertVerification(f, 'failed', 3 * 60 * 60 * 1000, { commandId, ...marker });

    await processBackupVerificationResult(commandId, {
      status: 'completed',
      stdout: JSON.stringify({ snapshotId: 'snap-late', status: 'passed', filesVerified: 7, filesFailed: 0 }),
    });

    const row = await verificationRow(id);
    expect(row?.status).toBe('passed');
    expect(row?.files_verified).toBe(7);
    expect(row?.details.reason).toBeUndefined();
    expect(row?.details.reasonCode).toBeUndefined();
  });

  it('does not reopen a row that failed for another reason', async () => {
    const f = await fixture();
    const commandId = randomUUID();
    const id = await insertVerification(f, 'failed', 3 * 60 * 60 * 1000, { commandId, reason: 'Agent unreachable' });

    await processBackupVerificationResult(commandId, {
      status: 'completed',
      stdout: JSON.stringify({ snapshotId: 'snap-other', status: 'passed', filesVerified: 7, filesFailed: 0 }),
    });

    const row = await verificationRow(id);
    expect(row?.status).toBe('failed');
    expect(row?.details.reason).toBe('Agent unreachable');
  });
});
