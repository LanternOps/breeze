import { and, desc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import * as dbModule from '../../db';
import {
  backupJobs as backupJobsTable,
  backupVerifications as backupVerificationsTable,
} from '../../db/schema';
import {
  backupJobs,
  backupVerifications,
  jobOrgById,
  verificationOrgById
} from './store';
import type { BackupJob, BackupVerification, BackupVerificationStatus } from './types';
import { recomputeRecoveryReadinessForDevice } from './readinessCalculator';
import {
  BACKUP_MAX_RECENT_VERIFICATIONS,
  BackupVerificationDispatchError,
  listBackupVerifications,
  persistVerificationToDb,
  runBackupVerification,
  safePublish
} from './verificationService';
import { normalizeBackupVerificationType } from './types';
import { isCriticalBackupDevice } from './criticality';
import { backupVerificationStructuredResultSchema } from '../../services/agentCommandResultValidation';

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

function toEpoch(value?: string | Date | null): number {
  if (!value) return 0;
  const asDate = value instanceof Date ? value : new Date(value);
  const epoch = asDate.getTime();
  return Number.isNaN(epoch) ? 0 : epoch;
}

function isUuid(value?: string | null): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function pickRotatingWindow<T>(items: T[], windowSize: number, bucket: number): T[] {
  if (items.length <= windowSize) return items;
  const start = (bucket * windowSize) % items.length;
  const rotated = items.slice(start).concat(items.slice(0, start));
  return rotated.slice(0, windowSize);
}

function normalizeDbVerificationRow(row: typeof backupVerificationsTable.$inferSelect): BackupVerification {
  return {
    id: row.id,
    orgId: row.orgId,
    deviceId: row.deviceId,
    backupJobId: row.backupJobId,
    snapshotId: row.snapshotId,
    verificationType: normalizeBackupVerificationType(row.verificationType),
    status: row.status as BackupVerificationStatus,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    restoreTimeSeconds: row.restoreTimeSeconds,
    filesVerified: row.filesVerified ?? 0,
    filesFailed: row.filesFailed ?? 0,
    sizeBytes: row.sizeBytes as number | null,
    details: (row.details as Record<string, unknown> | null) ?? {},
    createdAt: row.createdAt.toISOString(),
  };
}

async function listCompletedJobsFromDb(orgId?: string): Promise<Array<BackupJob & { orgId: string }> | null> {
  if (orgId && !isUuid(orgId)) return null;

  try {
    const conditions = [eq(backupJobsTable.status, 'completed')];
    if (orgId) conditions.push(eq(backupJobsTable.orgId, orgId));
    const rows = await runWithSystemDbAccess(() => db
      .select()
      .from(backupJobsTable)
      .where(and(...conditions))
      .orderBy(desc(backupJobsTable.completedAt), desc(backupJobsTable.createdAt)));

    return rows.map((row) => ({
      id: row.id,
      orgId: row.orgId,
      type: row.type as BackupJob['type'],
      deviceId: row.deviceId,
      configId: row.configId,
      policyId: row.policyId,
      snapshotId: row.snapshotId,
      status: row.status as BackupJob['status'],
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      totalSize: row.totalSize as number | null,
      fileCount: row.fileCount as number | null,
      errorCount: row.errorCount as number | null,
      errorLog: row.errorLog,
    }));
  } catch (error) {
    console.warn('[backupVerification] DB completed job read failed; falling back to memory:', error);
    return null;
  }
}

async function listTimedOutVerificationsFromDb(cutoff: Date): Promise<typeof backupVerifications> {
  try {
    const rows = await runWithSystemDbAccess(() => db
      .select()
      .from(backupVerificationsTable)
      .where(and(
        or(
          eq(backupVerificationsTable.status, 'pending'),
          eq(backupVerificationsTable.status, 'running'),
        )!,
        lte(backupVerificationsTable.startedAt, cutoff),
      )));

    return rows.map((row) => normalizeDbVerificationRow(row));
  } catch (error) {
    console.warn('[backupVerification] DB timeout scan failed; falling back to memory:', error);
    return [];
  }
}

async function findPendingVerificationByCommandId(commandId: string): Promise<BackupVerification | null> {
  if (!isUuid(commandId)) return null;

  try {
    const [row] = await runWithSystemDbAccess(() => db
      .select()
      .from(backupVerificationsTable)
      .where(and(
        sql`${backupVerificationsTable.details}->>'commandId' = ${commandId}`,
        or(
          eq(backupVerificationsTable.status, 'pending'),
          eq(backupVerificationsTable.status, 'running'),
        )!,
      ))
      .orderBy(desc(backupVerificationsTable.startedAt))
      .limit(1));

    if (!row) return null;

    const normalized = normalizeDbVerificationRow(row);
    verificationOrgById.set(normalized.id, normalized.orgId);
    const existing = backupVerifications.find((item) => item.id === normalized.id);
    if (existing) {
      Object.assign(existing, normalized);
      return existing;
    }
    backupVerifications.push(normalized);
    return normalized;
  } catch (error) {
    console.warn('[backupVerification] DB command lookup failed; falling back to memory:', error);
    return null;
  }
}

async function collectDevicesToRecompute(orgId?: string): Promise<Map<string, string> | null> {
  if (orgId && !isUuid(orgId)) return null;
  try {
    const [jobRows, verificationRows] = await Promise.all([
      runWithSystemDbAccess(() => db
        .select({ orgId: backupJobsTable.orgId, deviceId: backupJobsTable.deviceId })
        .from(backupJobsTable)
        .where(orgId ? eq(backupJobsTable.orgId, orgId) : undefined)),
      runWithSystemDbAccess(() => db
        .select({ orgId: backupVerificationsTable.orgId, deviceId: backupVerificationsTable.deviceId })
        .from(backupVerificationsTable)
        .where(orgId ? eq(backupVerificationsTable.orgId, orgId) : undefined)),
    ]);

    const map = new Map<string, string>();
    for (const row of [...jobRows, ...verificationRows]) {
      if (!map.has(row.deviceId)) map.set(row.deviceId, row.orgId);
    }
    return map;
  } catch (error) {
    console.warn('[backupVerification] DB readiness scan failed; falling back to memory:', error);
    return null;
  }
}

// ---- Async result processing ----

/**
 * Process an async backup verification result from the agent.
 * Called from agentWs.ts when a backup_verify or backup_test_restore command completes.
 */
export async function processBackupVerificationResult(
  commandId: string,
  commandResult: { status: string; stdout?: string; error?: string }
): Promise<void> {
  let pending = await findPendingVerificationByCommandId(commandId);
  if (!pending) {
    pending = backupVerifications.find(
      (v) =>
        v.details &&
        (v.details as Record<string, unknown>).commandId === commandId &&
        (v.status === 'pending' || v.status === 'running')
    );
  }
  if (!pending) {
    console.warn(`[backupVerification] No pending verification found for command ${commandId}`);
    return;
  }

  const orgId = verificationOrgById.get(pending.id);
  if (!orgId) return;

  const resultNow = new Date().toISOString();

  if (commandResult.status !== 'completed' || !commandResult.stdout) {
    pending.status = 'failed';
    pending.completedAt = resultNow;
    (pending.details as Record<string, unknown>).reason =
      commandResult.error || 'Agent command failed';
    await persistVerificationToDb(pending);
    await safePublish(
      'backup.verification_failed',
      orgId,
      {
        verificationId: pending.id,
        deviceId: pending.deviceId,
        verificationType: pending.verificationType,
        status: 'failed',
      },
      'agent.result'
    );
    return;
  }

  // Parse the agent result
  let agentResult: Record<string, unknown>;
  try {
    const parsed = JSON.parse(commandResult.stdout) as Record<string, unknown>;
    agentResult = backupVerificationStructuredResultSchema.parse(parsed) as Record<string, unknown>;
  } catch (parseErr) {
    console.error(`[backupVerification] Failed to parse agent result for command ${commandId}:`, parseErr);
    pending.status = 'failed';
    pending.completedAt = resultNow;
    (pending.details as Record<string, unknown>).reason = parseErr instanceof Error
      ? `Malformed verification result payload: ${parseErr.message}`
      : 'Failed to parse agent result';
    await persistVerificationToDb(pending);
    await safePublish(
      'backup.verification_failed',
      orgId,
      {
        verificationId: pending.id,
        deviceId: pending.deviceId,
        verificationType: pending.verificationType,
        status: 'failed',
      },
      'agent.result'
    );
    return;
  }

  // Map agent fields to verification record — validate status against allowed values
  const VALID_STATUSES = new Set<BackupVerificationStatus>(['passed', 'failed', 'partial']);
  const agentStatus = typeof agentResult.status === 'string' && VALID_STATUSES.has(agentResult.status as BackupVerificationStatus)
    ? (agentResult.status as BackupVerificationStatus)
    : 'failed';
  pending.status = agentStatus;
  pending.completedAt = resultNow;
  pending.filesVerified = (agentResult.filesVerified as number) ?? 0;
  pending.filesFailed = (agentResult.filesFailed as number) ?? 0;
  pending.sizeBytes = (agentResult.sizeBytes as number) ?? null;
  pending.restoreTimeSeconds = (agentResult.restoreTimeSeconds as number) ?? null;
  const details = pending.details as Record<string, unknown>;
  details.failedFiles = agentResult.failedFiles || [];
  details.cleanedUp = agentResult.cleanedUp;
  details.restorePath = agentResult.restorePath;

  await persistVerificationToDb(pending);

  // Publish event
  const eventName =
    pending.status === 'passed' ? 'backup.verification_passed' : 'backup.verification_failed';
  await safePublish(
    eventName,
    orgId,
    {
      verificationId: pending.id,
      deviceId: pending.deviceId,
      backupJobId: pending.backupJobId,
      verificationType: pending.verificationType,
      status: pending.status,
      filesVerified: pending.filesVerified,
      filesFailed: pending.filesFailed,
    },
    'agent.result'
  );

  // Recompute readiness
  await recomputeRecoveryReadinessForDevice(orgId, pending.deviceId);
}

const VERIFICATION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Mark stale pending/running verifications as failed.
 * Called by the verification-timeout-check BullMQ job.
 */
export async function timeoutStaleVerifications(): Promise<number> {
  const cutoff = Date.now() - VERIFICATION_TIMEOUT_MS;
  const cutoffDate = new Date(cutoff);
  let timedOut = 0;

  const dbRows = await listTimedOutVerificationsFromDb(cutoffDate);
  const pendingRows = dbRows.length > 0
    ? dbRows
    : backupVerifications.filter((v) => {
      if (v.status !== 'pending' && v.status !== 'running') return false;
      const startedMs = new Date(v.startedAt).getTime();
      return startedMs <= cutoff;
    });

  for (const v of pendingRows) {
    if (v.status !== 'pending' && v.status !== 'running') continue;
    const startedMs = new Date(v.startedAt).getTime();
    if (startedMs > cutoff) continue;

    v.status = 'failed';
    v.completedAt = new Date().toISOString();
    (v.details as Record<string, unknown>).reason = 'Verification timed out after 30 minutes';
    await persistVerificationToDb(v);

    const orgId = verificationOrgById.get(v.id);
    if (orgId) {
      await safePublish(
        'backup.verification_failed',
        orgId,
        {
          verificationId: v.id,
          deviceId: v.deviceId,
          verificationType: v.verificationType,
          status: 'failed',
        },
        'timeout-check'
      );
    }
    timedOut++;
  }
  return timedOut;
}

// ---- Scheduled job entry points ----

export async function ensurePostBackupIntegrityChecks(orgId?: string): Promise<number> {
  const dbCandidates = await listCompletedJobsFromDb(orgId);
  const candidates = dbCandidates ?? backupJobs
    .filter((job) => (!orgId || jobOrgById.get(job.id) === orgId))
    .filter((job) => job.status === 'completed');

  let created = 0;
  for (const job of candidates) {
    const effectiveOrgId = (job as BackupJob & { orgId?: string }).orgId ?? orgId ?? jobOrgById.get(job.id) ?? null;
    if (!effectiveOrgId) continue;
    const existing = await listBackupVerifications(effectiveOrgId, { backupJobId: job.id, verificationType: 'integrity', limit: 1 });
    if (existing.length > 0) continue;

    try {
      await runBackupVerification({
        orgId: effectiveOrgId,
        deviceId: job.deviceId,
        verificationType: 'integrity',
        backupJobId: job.id,
        snapshotId: job.snapshotId ?? undefined,
        source: 'post-backup-integrity-check'
      });
      created += 1;
    } catch (error) {
      if (error instanceof BackupVerificationDispatchError) {
        console.info('[backupVerification] Skipping post-backup integrity check because dispatch could not start', {
          orgId: effectiveOrgId,
          deviceId: job.deviceId,
          backupJobId: job.id,
          error: error.message,
        });
      } else {
        console.warn('[backupVerification] Integrity check hook failed:', error);
      }
    }
  }

  return created;
}

export async function runWeeklyTestRestore(orgId?: string): Promise<number> {
  const now = Date.now();
  const latestByDevice = new Map<string, BackupJob>();

  const dbCandidates = await listCompletedJobsFromDb(orgId);
  const jobsToScan = dbCandidates ?? backupJobs;

  for (const job of jobsToScan) {
    if (job.status !== 'completed' || !job.snapshotId) continue;
    if (!dbCandidates && orgId && jobOrgById.get(job.id) !== orgId) continue;
    const current = latestByDevice.get(job.deviceId);
    const jobTime = toEpoch(job.completedAt ?? job.startedAt ?? job.updatedAt);
    const currentTime = current ? toEpoch(current.completedAt ?? current.startedAt ?? current.updatedAt) : 0;
    if (!current || jobTime > currentTime) latestByDevice.set(job.deviceId, job);
  }

  const allCandidates = Array.from(latestByDevice.values())
    .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  const criticalCandidates = allCandidates.filter((job) => {
    const targetOrg = (job as BackupJob & { orgId?: string }).orgId ?? orgId ?? jobOrgById.get(job.id);
    return !!targetOrg && (!orgId || targetOrg === orgId);
  });
  const criticalFlags = await Promise.all(
    criticalCandidates.map((job) => {
      const targetOrg = (job as BackupJob & { orgId?: string }).orgId ?? orgId ?? jobOrgById.get(job.id);
      return targetOrg ? isCriticalBackupDevice(targetOrg, job.deviceId) : Promise.resolve(false);
    })
  );
  const prioritizedCritical = criticalCandidates.filter((_job, index) => criticalFlags[index]);
  const rotationBucket = Math.floor(now / (7 * DAY_MS));
  const candidates = prioritizedCritical.length > 0
    ? prioritizedCritical
    : pickRotatingWindow(allCandidates, 10, rotationBucket);

  let queued = 0;
  for (const job of candidates) {
    const targetOrg = (job as BackupJob & { orgId?: string }).orgId ?? orgId ?? jobOrgById.get(job.id);
    if (!targetOrg) continue;

    const recent = await listBackupVerifications(targetOrg, {
      deviceId: job.deviceId,
      limit: BACKUP_MAX_RECENT_VERIFICATIONS,
      excludeSimulated: true,
    });
    const hasRecentRestoreTest = recent.some((row) => (
      row.verificationType === 'test_restore'
      && (now - toEpoch(row.completedAt ?? row.startedAt)) <= (7 * DAY_MS)
    ));
    if (hasRecentRestoreTest) continue;

    try {
      await runBackupVerification({
        orgId: targetOrg,
        deviceId: job.deviceId,
        verificationType: 'test_restore',
        backupJobId: job.id,
        snapshotId: job.snapshotId ?? undefined,
        source: 'weekly-test-restore'
      });
      queued += 1;
    } catch (error) {
      if (error instanceof BackupVerificationDispatchError) {
        console.info('[backupVerification] Skipping weekly restore test because dispatch could not start', {
          orgId: targetOrg,
          deviceId: job.deviceId,
          backupJobId: job.id,
          error: error.message,
        });
      } else {
        console.warn('[backupVerification] Weekly restore test failed:', error);
      }
    }
  }

  return queued;
}

export async function recalculateReadinessScores(orgId?: string): Promise<number> {
  const devicesToOrg = await collectDevicesToRecompute(orgId) ?? new Map<string, string>();

  if (devicesToOrg.size === 0) {
    for (const job of backupJobs) {
      const targetOrg = jobOrgById.get(job.id);
      if (!targetOrg) continue;
      if (orgId && targetOrg !== orgId) continue;
      if (!devicesToOrg.has(job.deviceId)) devicesToOrg.set(job.deviceId, targetOrg);
    }

    for (const verification of backupVerifications) {
      const targetOrg = verificationOrgById.get(verification.id) ?? verification.orgId;
      if (!targetOrg) continue;
      if (orgId && targetOrg !== orgId) continue;
      if (!devicesToOrg.has(verification.deviceId)) devicesToOrg.set(verification.deviceId, targetOrg);
    }
  }

  let computed = 0;
  for (const [deviceId, targetOrg] of devicesToOrg.entries()) {
    await recomputeRecoveryReadinessForDevice(targetOrg, deviceId);
    computed += 1;
  }

  return computed;
}
