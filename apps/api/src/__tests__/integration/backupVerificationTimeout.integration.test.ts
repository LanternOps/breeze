import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';
import { processBackupVerificationResult, timeoutStaleVerifications } from '../../routes/backup/verificationService';
import {
  LEGACY_VERIFICATION_TIMEOUT_REASON,
  VERIFICATION_TIMEOUT_GRACE_MS,
  VERIFICATION_TIMEOUT_REASON_CODE,
  verificationTimeoutReason,
} from '../../routes/backup/verificationTimeout';

// #11813 against real Postgres: the timeout scan's clock (executed_at + the
// verification's scaled budget + grace), the compare-and-set on the observed
// command (executed_at written by JS at claim, compared back to the column),
// the stable reason code it writes, and the late-result lookup, which must
// match both new rows (by code) and rows written before the code existed.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

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

/**
 * executed_at is written as a millisecond JS Date, exactly as the delivery
 * claim writes it (commandDispatch.ts), so the scan's CAS on the observed
 * value is exercised against the real column type.
 */
async function insertCommand(deviceId: string, executedAgoMs: number | null, status = 'sent'): Promise<string> {
  const id = randomUUID();
  const executedAt = executedAgoMs === null ? null : new Date(Date.now() - executedAgoMs);
  await getTestDb().execute(sql`
    INSERT INTO device_commands (id, device_id, type, payload, status, executed_at)
    VALUES (${id}, ${deviceId}, 'backup_verify', '{}'::jsonb, ${status}, ${executedAt ? executedAt.toISOString() : null}::timestamp)
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
    const healthyCommand = await insertCommand(f.deviceId, 30 * MIN);
    const staleCommand = await insertCommand(f.deviceId, 2 * HOUR + VERIFICATION_TIMEOUT_GRACE_MS + MIN);
    const healthy = await insertVerification(f, 'running', 45 * MIN, { commandId: healthyCommand });
    const stale = await insertVerification(f, 'running', 2 * HOUR + 30 * MIN, { commandId: staleCommand });

    await timeoutStaleVerifications();

    expect((await verificationRow(healthy))?.status).toBe('running');
    expect((await commandRow(healthyCommand))?.status).toBe('sent');

    const failed = await verificationRow(stale);
    expect(failed?.status).toBe('failed');
    expect(failed?.details).toMatchObject({
      commandId: staleCommand,
      reason: verificationTimeoutReason(2 * HOUR),
      reasonCode: VERIFICATION_TIMEOUT_REASON_CODE,
    });
    const command = await commandRow(staleCommand);
    expect(command?.status).toBe('failed');
    expect(command?.result).toMatchObject({
      status: 'timeout',
      error: verificationTimeoutReason(2 * HOUR),
      timedOutBy: 'verification-timeout-check',
    });
  });

  // Delivery deferred while the file index hydrated: started 2h30m ago but
  // claimed 1h40m ago, inside its 2h budget. The old clock (started_at) failed it.
  it('does not count the wait before delivery against the budget', async () => {
    const f = await fixture();
    const command = await insertCommand(f.deviceId, HOUR + 40 * MIN);
    const id = await insertVerification(f, 'running', 2 * HOUR + 30 * MIN, { commandId: command });

    await timeoutStaleVerifications();

    expect((await verificationRow(id))?.status).toBe('running');
    expect((await commandRow(command))?.status).toBe('sent');
  });

  it('honours the scaled budget stored on the verification', async () => {
    const f = await fixture();
    const inside = await insertCommand(f.deviceId, 5 * HOUR);
    const past = await insertCommand(f.deviceId, 395 * MIN + VERIFICATION_TIMEOUT_GRACE_MS + MIN);
    const insideId = await insertVerification(f, 'running', 5 * HOUR + 10 * MIN, { commandId: inside, timeBudgetSeconds: 395 * 60 });
    const pastId = await insertVerification(f, 'running', 7 * HOUR, { commandId: past, timeBudgetSeconds: 395 * 60 });

    await timeoutStaleVerifications();

    expect((await verificationRow(insideId))?.status).toBe('running');
    expect((await commandRow(inside))?.status).toBe('sent');
    const failed = await verificationRow(pastId);
    expect(failed?.status).toBe('failed');
    expect(failed?.details).toMatchObject({ reason: 'Verification timed out after 400 minutes', timeBudgetSeconds: 395 * 60 });
    expect((await commandRow(past))?.status).toBe('failed');
  });

  it('fails a never-delivered command on the 2h clock from started_at (CAS on pending + NULL executed_at)', async () => {
    const f = await fixture();
    const command = await insertCommand(f.deviceId, null, 'pending');
    const id = await insertVerification(f, 'pending', 2 * HOUR + VERIFICATION_TIMEOUT_GRACE_MS + MIN, { commandId: command, timeBudgetSeconds: 12 * 3600 });

    await timeoutStaleVerifications();

    expect((await verificationRow(id))?.status).toBe('failed');
    expect((await commandRow(command))?.status).toBe('failed');
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
