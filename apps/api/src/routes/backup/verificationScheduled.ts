import {
  backupJobs,
  backupVerifications,
  jobOrgById,
  verificationOrgById
} from './store';
import type { BackupJob, BackupVerificationStatus } from './types';
import { recomputeRecoveryReadinessForDevice } from './readinessCalculator';
import {
  BACKUP_MAX_RECENT_VERIFICATIONS,
  listBackupVerifications,
  persistVerificationToDb,
  runBackupVerification,
  safePublish
} from './verificationService';

const DAY_MS = 24 * 60 * 60 * 1000;

function toEpoch(value?: string | Date | null): number {
  if (!value) return 0;
  const asDate = value instanceof Date ? value : new Date(value);
  const epoch = asDate.getTime();
  return Number.isNaN(epoch) ? 0 : epoch;
}

function isCriticalDevice(_orgId: string, _deviceId: string): boolean {
  // TODO: Determine criticality from config policy assignment level or device tags
  return false;
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
  // Find the pending verification by commandId in details
  const pending = backupVerifications.find(
    (v) =>
      v.details &&
      (v.details as Record<string, unknown>).commandId === commandId &&
      (v.status === 'pending' || v.status === 'running')
  );
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
    agentResult = JSON.parse(commandResult.stdout) as Record<string, unknown>;
  } catch (parseErr) {
    console.error(`[backupVerification] Failed to parse agent result for command ${commandId}:`, parseErr);
    pending.status = 'failed';
    pending.completedAt = resultNow;
    (pending.details as Record<string, unknown>).reason = 'Failed to parse agent result';
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
  let timedOut = 0;

  for (const v of backupVerifications) {
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
  const candidates = backupJobs
    .filter((job) => (!orgId || jobOrgById.get(job.id) === orgId))
    .filter((job) => job.status === 'completed');

  let created = 0;
  for (const job of candidates) {
    const targetOrg = orgId ?? jobOrgById.get(job.id);
    if (!targetOrg) continue;
    const existing = await listBackupVerifications(targetOrg, { backupJobId: job.id, verificationType: 'integrity', limit: 1 });
    if (existing.length > 0) continue;

    try {
      await runBackupVerification({
        orgId: targetOrg,
        deviceId: job.deviceId,
        verificationType: 'integrity',
        backupJobId: job.id,
        snapshotId: job.snapshotId ?? undefined,
        source: 'post-backup-integrity-check'
      });
      created += 1;
    } catch (error) {
      console.warn('[backupVerification] Integrity check hook failed:', error);
    }
  }

  return created;
}

export async function runWeeklyTestRestore(orgId?: string): Promise<number> {
  const now = Date.now();
  const latestByDevice = new Map<string, BackupJob>();

  for (const job of backupJobs) {
    if (job.status !== 'completed' || !job.snapshotId) continue;
    if (orgId && jobOrgById.get(job.id) !== orgId) continue;
    const current = latestByDevice.get(job.deviceId);
    const jobTime = toEpoch(job.completedAt ?? job.startedAt ?? job.updatedAt);
    const currentTime = current ? toEpoch(current.completedAt ?? current.startedAt ?? current.updatedAt) : 0;
    if (!current || jobTime > currentTime) latestByDevice.set(job.deviceId, job);
  }

  const criticalCandidates = Array.from(latestByDevice.values()).filter((job) => {
    const targetOrg = jobOrgById.get(job.id);
    if (!targetOrg) return false;
    if (orgId && targetOrg !== orgId) return false;
    return isCriticalDevice(targetOrg, job.deviceId);
  });
  const candidates = criticalCandidates.length > 0 ? criticalCandidates : Array.from(latestByDevice.values()).slice(0, 10);

  let queued = 0;
  for (const job of candidates) {
    const targetOrg = jobOrgById.get(job.id);
    if (!targetOrg) continue;

    const recent = await listBackupVerifications(targetOrg, {
      deviceId: job.deviceId,
      limit: BACKUP_MAX_RECENT_VERIFICATIONS
    });
    const hasRecentRestoreTest = recent.some((row) => (
      (row.verificationType === 'test_restore' || row.verificationType === 'full_recovery')
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
      console.warn('[backupVerification] Weekly restore test failed:', error);
    }
  }

  return queued;
}

export async function recalculateReadinessScores(orgId?: string): Promise<number> {
  const devicesToOrg = new Map<string, string>();

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

  let computed = 0;
  for (const [deviceId, targetOrg] of devicesToOrg.entries()) {
    await recomputeRecoveryReadinessForDevice(targetOrg, deviceId);
    computed += 1;
  }

  return computed;
}
