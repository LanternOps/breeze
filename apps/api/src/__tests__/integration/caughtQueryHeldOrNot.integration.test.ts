/**
 * #11225: code that runs with or without a held DB context and catches a query.
 *
 * Backup verification reaches the database through a local helper over
 * `withSystemDbAccessContext`. With no context held that opens its own
 * transaction and the catch already works. With one held (a request, an agent
 * socket's per-message wrap) it joins that transaction, so a caught failure
 * poisoned the commit. The outer write in `inHeldContext` is the proof: it only
 * survives if the failure did not reach the held transaction.
 *
 * `mlFeedbackEmitters.emitFeedbackBestEffort` and the release in
 * `dispatchDeviceCommand` had the same shape and were unverified until this file.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { db, withDbAccessContext } from '../../db';
import { backupJobs, backupVerifications, deviceCommands, devices, mlFeedbackEvents, recoveryReadiness, sites } from '../../db/schema';
import { isCriticalBackupDevice } from '../../routes/backup/criticality';
import { verificationHealthStatus } from '../../routes/backup/verification';
import {
  getBackupHealthSummary,
  getRecoveryReadinessForDevice,
  listRecoveryReadiness,
  persistRecoveryReadinessToDb,
  recomputeRecoveryReadinessForDevice,
} from '../../routes/backup/readinessCalculator';
import {
  ensurePostBackupIntegrityChecks,
  processBackupVerificationResult,
  recalculateReadinessScores,
  timeoutStaleVerifications,
} from '../../routes/backup/verificationScheduled';
import { listBackupVerifications, persistVerificationToDb } from '../../routes/backup/verificationService';
import type { BackupVerification, RecoveryReadiness } from '../../routes/backup/types';
import { dispatchDeviceCommand } from '../../services/dispatchDeviceCommand';
import { emitAlertStateFeedback } from '../../services/mlFeedbackEmitters';
import { clearStatementFaults, failStatementsOn, failWritesOn } from './caughtQueryFaults';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function tenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const [device] = await getTestDb().insert(devices).values({
    orgId: org.id,
    siteId: site.id,
    agentId: `held-or-not-${randomUUID()}`,
    hostname: `held-or-not-${randomUUID()}`,
    osType: 'linux',
    osVersion: 'test',
    architecture: 'amd64',
    agentVersion: '1.0.0-test',
    status: 'online',
    lastSeenAt: new Date(),
    enrolledAt: new Date(),
  }).returning();
  return { partnerId: partner.id, orgId: org.id, siteId: site.id, deviceId: device!.id };
}
type Tenant = Awaited<ReturnType<typeof tenant>>;

const orgContext = (t: Tenant) => ({
  scope: 'organization' as const,
  orgId: t.orgId,
  accessibleOrgIds: [t.orgId],
  accessiblePartnerIds: [],
  currentPartnerId: t.partnerId,
});

/** Run `fn` in a held org context, then write beside it and prove that write committed. */
async function inHeldContext<T>(t: Tenant, fn: () => Promise<T>): Promise<T> {
  const name = `kept-${randomUUID()}`;
  const result = await withDbAccessContext(orgContext(t), async () => {
    const value = await fn();
    await db.update(sites).set({ name }).where(eq(sites.id, t.siteId));
    return value;
  });
  const [site] = await getTestDb().select({ name: sites.name }).from(sites).where(eq(sites.id, t.siteId));
  expect(site!.name).toBe(name);
  return result;
}

const readinessRow = (t: Pick<Tenant, 'orgId' | 'deviceId'>): RecoveryReadiness => ({
  id: randomUUID(),
  orgId: t.orgId,
  deviceId: t.deviceId,
  readinessScore: 80,
  estimatedRtoMinutes: null,
  estimatedRpoMinutes: null,
  riskFactors: [],
  calculatedAt: new Date().toISOString(),
});

async function verificationRow(t: Tenant): Promise<BackupVerification> {
  // Lineage only: the write under test is the verification row.
  const [config] = await getTestDb().execute(sql`
    INSERT INTO backup_configs (org_id, name, type, provider, provider_config)
    VALUES (${t.orgId}, ${`held-${randomUUID()}`}, 'file', 'local', '{"path":"/backups"}')
    RETURNING id`) as unknown as Array<{ id: string }>;
  const [job] = await getTestDb().insert(backupJobs).values({
    orgId: t.orgId, configId: config!.id, deviceId: t.deviceId, type: 'scheduled', status: 'completed', completedAt: new Date(),
  }).returning({ id: backupJobs.id });
  return {
    id: randomUUID(),
    orgId: t.orgId,
    deviceId: t.deviceId,
    backupJobId: job!.id,
    snapshotId: null,
    verificationType: 'integrity',
    status: 'passed',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    restoreTimeSeconds: null,
    filesVerified: 1,
    filesFailed: 0,
    sizeBytes: null,
    details: null,
    createdAt: new Date().toISOString(),
  };
}

describe('backup verification with a held context (real PostgreSQL)', () => {
  afterEach(clearStatementFaults);

  runDb('CONTROL: with nothing failing, the held write and the readiness row both commit', async () => {
    const t = await tenant();
    await inHeldContext(t, () => persistRecoveryReadinessToDb(readinessRow(t)));
    expect(await getTestDb().select().from(recoveryReadiness).where(eq(recoveryReadiness.deviceId, t.deviceId))).toHaveLength(1);
  });

  runDb('persistRecoveryReadinessToDb: a failed write keeps the memory record and the held commit', async () => {
    const t = await tenant();
    await failWritesOn('recovery_readiness');
    await inHeldContext(t, () => persistRecoveryReadinessToDb(readinessRow(t)));
    expect(await getTestDb().select().from(recoveryReadiness).where(eq(recoveryReadiness.deviceId, t.deviceId))).toEqual([]);
  });

  runDb('persistVerificationToDb: a failed write keeps the held commit; with nothing failing the row lands', async () => {
    const t = await tenant();
    const control = await verificationRow(t);
    await inHeldContext(t, () => persistVerificationToDb(control));
    const row = await verificationRow(t);
    await failWritesOn('backup_verifications');
    await inHeldContext(t, () => persistVerificationToDb(row));
    const rows = await getTestDb().select({ id: backupVerifications.id }).from(backupVerifications).where(eq(backupVerifications.deviceId, t.deviceId));
    expect(rows.map((r) => r.id)).toEqual([control.id]);
  });

  runDb('getRecoveryReadinessForDevice: a failed read falls back and keeps the held commit', async () => {
    const t = await tenant();
    await failStatementsOn('recovery_readiness');
    expect(await inHeldContext(t, () => getRecoveryReadinessForDevice(t.orgId, t.deviceId))).toBeNull();
  });

  runDb('listRecoveryReadiness: a failed read falls back and keeps the held commit', async () => {
    const t = await tenant();
    await failStatementsOn('recovery_readiness');
    expect(await inHeldContext(t, () => listRecoveryReadiness(t.orgId))).toEqual([]);
  });

  runDb('listBackupVerifications: a failed read falls back and keeps the held commit', async () => {
    const t = await tenant();
    await failStatementsOn('backup_verifications');
    expect(await inHeldContext(t, () => listBackupVerifications(t.orgId))).toEqual([]);
  });

  runDb('isCriticalBackupDevice: failed tag and config reads answer false and keep the held commit', async () => {
    const t = await tenant();
    await failStatementsOn('devices');
    expect(await inHeldContext(t, () => isCriticalBackupDevice(t.orgId, t.deviceId))).toBe(false);
  });

  runDb('getBackupHealthSummary CONTROL: with nothing failing, the verdict is healthy and no failure is flagged', async () => {
    const t = await tenant();
    const summary = await inHeldContext(t, () => getBackupHealthSummary(t.orgId));
    expect(summary.readFailed).toBe(false);
    expect(verificationHealthStatus(summary)).toBe('healthy');
  });

  runDb.each(['backup_verifications', 'recovery_readiness'])(
    'getBackupHealthSummary: a failed read of %s keeps the held commit and the verdict says unknown, not healthy',
    async (table) => {
      const t = await tenant();
      await failStatementsOn(table);
      const summary = await inHeldContext(t, () => getBackupHealthSummary(t.orgId));
      expect(summary.readFailed).toBe(true);
      expect(verificationHealthStatus(summary)).toBe('unknown');
    },
  );

  runDb('getBackupHealthSummary: a failed assigned-device read reports zero coverage and keeps the held commit', async () => {
    const t = await tenant();
    await failStatementsOn('config_policy_backup_settings');
    const summary = await inHeldContext(t, () => getBackupHealthSummary(t.orgId));
    expect(summary.verification.coveragePercent).toBe(0);
    // Missing assigned devices also mean missing no-history rows: not "healthy".
    expect(verificationHealthStatus(summary)).toBe('unknown');
  });

  runDb('getBackupHealthSummary: failed criticality checks, run in sequence, count the rows as non-critical and keep the held commit', async () => {
    const t = await tenant();
    const row = { ...(await verificationRow(t)), status: 'failed' as const };
    await persistVerificationToDb(row);
    await persistRecoveryReadinessToDb({ ...readinessRow(t), readinessScore: 10 });
    await failStatementsOn('devices');
    const summary = await inHeldContext(t, () => getBackupHealthSummary(t.orgId));
    expect(summary.escalations).toEqual({ verificationFailures: 1, criticalVerificationFailures: 0 });
    expect(summary.readiness).toMatchObject({ lowReadinessCount: 1, criticalDevicesAtRisk: 0 });
    // The failure may be on a critical device, so the verdict cannot claim less.
    expect(verificationHealthStatus(summary)).toBe('unknown');
  });

  runDb('getBackupHealthSummary: a failed criticality read alone, with a failed verification and no low readiness, does not read healthy', async () => {
    const t = await tenant();
    await persistVerificationToDb({ ...(await verificationRow(t)), status: 'failed' as const });
    await failStatementsOn('devices');
    const summary = await inHeldContext(t, () => getBackupHealthSummary(t.orgId));
    expect(summary.readiness.lowReadinessCount).toBe(0);
    expect(summary.readFailed).toBe(true);
    expect(verificationHealthStatus(summary)).toBe('unknown');
  });

  runDb('recomputeRecoveryReadinessForDevice: failed backup, bare-metal and readiness statements still score and keep the held commit', async () => {
    const t = await tenant();
    await failStatementsOn('backup_jobs');
    await failStatementsOn('bare_metal_recoveries');
    await failStatementsOn('recovery_readiness');
    const row = await inHeldContext(t, () => recomputeRecoveryReadinessForDevice(t.orgId, t.deviceId));
    expect(row.deviceId).toBe(t.deviceId);
  });

  runDb('listRecoveryReadiness: a failed site-scoped read fails closed and keeps the held commit', async () => {
    const t = await tenant();
    await failStatementsOn('devices');
    expect(await inHeldContext(t, () => listRecoveryReadiness(t.orgId, [t.siteId]))).toEqual([]);
  });

  runDb('processBackupVerificationResult: failed command lookups fall back and keep the held commit', async () => {
    const t = await tenant();
    await failStatementsOn('backup_verifications');
    await inHeldContext(t, () => processBackupVerificationResult(randomUUID(), { status: 'completed' }));
  });

  runDb('recomputeRecoveryReadinessForDevice: a failed verification read still scores and keeps the held commit', async () => {
    const t = await tenant();
    await failStatementsOn('backup_verifications');
    const row = await inHeldContext(t, () => recomputeRecoveryReadinessForDevice(t.orgId, t.deviceId));
    expect(row.deviceId).toBe(t.deviceId);
  });

  runDb('recalculateReadinessScores: a failed scan falls back and keeps the held commit', async () => {
    const t = await tenant();
    await failStatementsOn('backup_verifications');
    await inHeldContext(t, () => recalculateReadinessScores(t.orgId));
  });

  runDb('ensurePostBackupIntegrityChecks: a failed job read falls back and keeps the held commit', async () => {
    const t = await tenant();
    await failStatementsOn('backup_jobs');
    await inHeldContext(t, () => ensurePostBackupIntegrityChecks(t.orgId));
  });

  runDb('timeoutStaleVerifications: a failed scan falls back and keeps the held commit', async () => {
    const t = await tenant();
    await failStatementsOn('backup_verifications');
    expect(await inHeldContext(t, () => timeoutStaleVerifications())).toBe(0);
  });

  runDb('the held scope is unchanged: a foreign org stays denied, and that denial is caught', async () => {
    const t = await tenant();
    const foreign = await tenant();
    await inHeldContext(t, () => persistRecoveryReadinessToDb(readinessRow(foreign)));
    expect(await getTestDb().select().from(recoveryReadiness).where(eq(recoveryReadiness.deviceId, foreign.deviceId))).toEqual([]);
  });
});

describe('backup verification with no context held (real PostgreSQL)', () => {
  afterEach(clearStatementFaults);

  runDb('CONTROL: a write opens its own system context', async () => {
    const t = await tenant();
    await persistRecoveryReadinessToDb(readinessRow(t));
    const rows = await getTestDb().select().from(recoveryReadiness).where(eq(recoveryReadiness.deviceId, t.deviceId));
    expect(rows).toHaveLength(1);
  });

  runDb('CONTROL: a failed read and a failed write both fall back', async () => {
    const t = await tenant();
    await failWritesOn('recovery_readiness');
    await expect(persistRecoveryReadinessToDb(readinessRow(t))).resolves.toBeUndefined();
    await clearStatementFaults();
    await failStatementsOn('recovery_readiness');
    await expect(getRecoveryReadinessForDevice(t.orgId, t.deviceId)).resolves.toBeNull();
  });
});

describe('the two sites #11224 left unchecked (real PostgreSQL)', () => {
  afterEach(clearStatementFaults);

  runDb('emitFeedbackBestEffort: with nothing failing the label lands; a failed insert keeps the held commit', async () => {
    const t = await tenant();
    const emit = () => inHeldContext(t, () => emitAlertStateFeedback({
      orgId: t.orgId,
      alertId: randomUUID(),
      eventType: 'alert.acknowledged',
      outcome: 'acknowledged',
    }));
    const labels = () => getTestDb().select({ id: mlFeedbackEvents.id }).from(mlFeedbackEvents).where(eq(mlFeedbackEvents.orgId, t.orgId));
    await emit();
    expect(await labels()).toHaveLength(1);
    await failWritesOn('ml_feedback_events');
    await emit();
    expect(await labels()).toHaveLength(1);
  });

  runDb('dispatchDeviceCommand: a failed release after a failed push answers queued_live and keeps the command', async () => {
    const t = await tenant();
    await failWritesOn('device_commands', { ops: 'UPDATE', when: `OLD.status = 'sent' AND NEW.status = 'pending'` });
    const result = await inHeldContext(t, () => dispatchDeviceCommand({
      deviceId: t.deviceId,
      type: 'list_processes',
      payload: {},
    } as Parameters<typeof dispatchDeviceCommand>[0]));
    expect(result).toMatchObject({ ok: true, delivery: 'queued_live' });
    const rows = await getTestDb().select().from(deviceCommands).where(eq(deviceCommands.deviceId, t.deviceId));
    expect(rows.map((row) => row.status)).toEqual(['sent']);
  });
});
