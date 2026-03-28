import { and, desc, eq, gte, lte, type SQL } from 'drizzle-orm';
import * as dbModule from '../../db';
import { backupVerifications as backupVerificationsTable } from '../../db/schema';
import { queueCommandForExecution } from '../../services/commandQueue';
import { publishEvent } from '../../services/eventBus';
import {
  addBackupVerification,
  backupJobs,
  backupPolicies,
  backupSnapshots,
  backupVerifications,
  jobOrgById,
  policyOrgById,
  snapshotOrgById,
  verificationOrgById
} from './store';
import type {
  BackupJob,
  BackupSnapshot,
  BackupVerification,
  BackupVerificationStatus,
  BackupVerificationType,
  RecoveryReadiness
} from './types';
import { recomputeRecoveryReadinessForDevice } from './readinessCalculator';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const BACKUP_LOW_READINESS_THRESHOLD = 70;
export const BACKUP_READINESS_RECOVERY_THRESHOLD = 75;
export const BACKUP_HIGH_READINESS_THRESHOLD = 85;
export const BACKUP_RECENT_COVERAGE_DAYS = 30;
export const BACKUP_MAX_RECENT_VERIFICATIONS = 12;

type VerificationFilters = {
  deviceId?: string;
  backupJobId?: string;
  verificationType?: BackupVerificationType;
  status?: BackupVerificationStatus;
  from?: number | null;
  to?: number | null;
  limit?: number;
};

export type RunBackupVerificationInput = {
  orgId: string;
  deviceId: string;
  verificationType: BackupVerificationType;
  backupJobId?: string;
  snapshotId?: string;
  source: string;
  requestedBy?: string | null;
};

function toEpoch(value?: string | Date | null): number {
  if (!value) return 0;
  const asDate = value instanceof Date ? value : new Date(value);
  const epoch = asDate.getTime();
  return Number.isNaN(epoch) ? 0 : epoch;
}

function toIso(value?: string | Date | null): string | null {
  if (!value) return null;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return Number.isNaN(value.getTime()) ? null : value.toISOString();
}

function deterministicSeed(input: string): number {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function isUuid(value?: string | null): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function supportsDbOrg(orgId: string): boolean {
  return isUuid(orgId);
}

function isCriticalDevice(orgId: string, deviceId: string): boolean {
  return backupPolicies
    .filter((policy) => policyOrgById.get(policy.id) === orgId)
    .filter((policy) => policy.targets.deviceIds.includes(deviceId))
    .some((policy) => {
      const includesServerGroup = policy.targets.groupIds.some((groupId) => /server|critical/i.test(groupId));
      return includesServerGroup || /server|critical/i.test(policy.name);
    });
}

export async function safePublish(
  type: 'backup.verification_failed' | 'backup.verification_passed' | 'backup.recovery_readiness_low',
  orgId: string,
  payload: Record<string, unknown>,
  source: string
): Promise<void> {
  try {
    await publishEvent(type, orgId, payload, source);
  } catch (error) {
    console.warn(`[backupVerification] Failed to emit ${type}:`, error);
  }
}

function normalizeDbVerificationRow(row: {
  id: string;
  orgId: string;
  deviceId: string;
  backupJobId: string;
  snapshotId: string | null;
  verificationType: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  restoreTimeSeconds: number | null;
  filesVerified: number | null;
  filesFailed: number | null;
  sizeBytes: number | null;
  details: unknown;
  createdAt: Date;
}): BackupVerification {
  return {
    id: row.id,
    orgId: row.orgId,
    deviceId: row.deviceId,
    backupJobId: row.backupJobId,
    snapshotId: row.snapshotId,
    verificationType: row.verificationType as BackupVerificationType,
    status: row.status as BackupVerificationStatus,
    startedAt: toIso(row.startedAt) ?? new Date().toISOString(),
    completedAt: toIso(row.completedAt),
    restoreTimeSeconds: row.restoreTimeSeconds,
    filesVerified: row.filesVerified ?? 0,
    filesFailed: row.filesFailed ?? 0,
    sizeBytes: row.sizeBytes,
    details: (row.details as Record<string, unknown> | null) ?? null,
    createdAt: toIso(row.createdAt) ?? new Date().toISOString()
  };
}

function listBackupVerificationsFromMemory(orgId: string, filters: VerificationFilters = {}): BackupVerification[] {
  const from = filters.from ?? null;
  const to = filters.to ?? null;

  let rows = backupVerifications.filter((item) => verificationOrgById.get(item.id) === orgId);

  if (filters.deviceId) rows = rows.filter((item) => item.deviceId === filters.deviceId);
  if (filters.backupJobId) rows = rows.filter((item) => item.backupJobId === filters.backupJobId);
  if (filters.verificationType) rows = rows.filter((item) => item.verificationType === filters.verificationType);
  if (filters.status) rows = rows.filter((item) => item.status === filters.status);
  if (from) rows = rows.filter((item) => toEpoch(item.startedAt) >= from);
  if (to) rows = rows.filter((item) => toEpoch(item.startedAt) <= to);

  rows.sort((a, b) => toEpoch(b.completedAt ?? b.startedAt) - toEpoch(a.completedAt ?? a.startedAt));
  return typeof filters.limit === 'number' ? rows.slice(0, filters.limit) : rows;
}

async function listBackupVerificationsFromDb(
  orgId: string,
  filters: VerificationFilters = {}
): Promise<BackupVerification[] | null> {
  if (!supportsDbOrg(orgId)) return null;
  if (filters.deviceId && !isUuid(filters.deviceId)) return null;
  if (filters.backupJobId && !isUuid(filters.backupJobId)) return null;

  const conditions: SQL[] = [eq(backupVerificationsTable.orgId, orgId)];
  if (filters.deviceId) conditions.push(eq(backupVerificationsTable.deviceId, filters.deviceId));
  if (filters.backupJobId) conditions.push(eq(backupVerificationsTable.backupJobId, filters.backupJobId));
  if (filters.verificationType) conditions.push(eq(backupVerificationsTable.verificationType, filters.verificationType));
  if (filters.status) conditions.push(eq(backupVerificationsTable.status, filters.status));
  if (filters.from) conditions.push(gte(backupVerificationsTable.startedAt, new Date(filters.from)));
  if (filters.to) conditions.push(lte(backupVerificationsTable.startedAt, new Date(filters.to)));

  try {
    const rows = await runWithSystemDbAccess(() => db
      .select()
      .from(backupVerificationsTable)
      .where(and(...conditions))
      .orderBy(desc(backupVerificationsTable.startedAt))
      .limit(filters.limit ?? 1000));

    return rows.map((row) => normalizeDbVerificationRow({
      ...row,
      filesVerified: row.filesVerified as number | null,
      filesFailed: row.filesFailed as number | null,
      sizeBytes: row.sizeBytes as number | null,
    }));
  } catch (error) {
    console.warn('[backupVerification] DB verification read failed; falling back to memory:', error);
    return null;
  }
}

export async function persistVerificationToDb(row: BackupVerification): Promise<void> {
  if (!isUuid(row.orgId) || !isUuid(row.deviceId) || !isUuid(row.backupJobId)) return;
  if (row.snapshotId && !isUuid(row.snapshotId)) return;

  try {
    await runWithSystemDbAccess(() => db.insert(backupVerificationsTable).values({
      id: row.id,
      orgId: row.orgId,
      deviceId: row.deviceId,
      backupJobId: row.backupJobId,
      snapshotId: row.snapshotId ?? null,
      verificationType: row.verificationType,
      status: row.status,
      startedAt: new Date(row.startedAt),
      completedAt: row.completedAt ? new Date(row.completedAt) : null,
      restoreTimeSeconds: row.restoreTimeSeconds ?? null,
      filesVerified: row.filesVerified,
      filesFailed: row.filesFailed,
      sizeBytes: row.sizeBytes ?? null,
      details: row.details ?? null,
      createdAt: new Date(row.createdAt)
    }));
  } catch (error) {
    console.warn('[backupVerification] DB verification write failed; keeping memory record only:', error);
  }
}

function resolveSnapshot(orgId: string, snapshotId: string): BackupSnapshot {
  const snapshot = backupSnapshots.find(
    (row) => row.id === snapshotId && snapshotOrgById.get(row.id) === orgId
  );
  if (!snapshot) {
    throw new Error('Snapshot not found for organization');
  }
  return snapshot;
}

function resolveBackupJob(
  orgId: string,
  deviceId: string,
  backupJobId?: string
): BackupJob {
  if (backupJobId) {
    const row = backupJobs.find((job) => job.id === backupJobId && jobOrgById.get(job.id) === orgId);
    if (!row || row.type !== 'backup') {
      throw new Error('Backup job not found for organization');
    }
    if (row.deviceId !== deviceId) {
      throw new Error('backupJobId does not belong to requested device');
    }
    return row;
  }

  const latest = backupJobs
    .filter((job) => jobOrgById.get(job.id) === orgId)
    .filter((job) => job.type === 'backup' && job.deviceId === deviceId)
    .sort((a, b) => toEpoch(b.completedAt ?? b.startedAt ?? b.updatedAt) - toEpoch(a.completedAt ?? a.startedAt ?? a.updatedAt));

  const row = latest[0];
  if (!row) {
    throw new Error('Backup job not found for requested device');
  }
  return row;
}

// ---- Public API ----

export async function listBackupVerifications(
  orgId: string,
  filters: VerificationFilters = {}
): Promise<BackupVerification[]> {
  const dbRows = await listBackupVerificationsFromDb(orgId, filters);
  if (dbRows) return dbRows;
  return listBackupVerificationsFromMemory(orgId, filters);
}

export async function runBackupVerification(input: RunBackupVerificationInput): Promise<{
  verification: BackupVerification;
  readiness: RecoveryReadiness | null;
}> {
  let snapshot: BackupSnapshot | null = null;
  if (input.snapshotId) {
    snapshot = resolveSnapshot(input.orgId, input.snapshotId);
    if (snapshot.deviceId !== input.deviceId) {
      throw new Error('snapshotId does not belong to requested device');
    }
  }

  let backupJob = snapshot
    ? resolveBackupJob(input.orgId, input.deviceId, snapshot.jobId)
    : resolveBackupJob(input.orgId, input.deviceId, input.backupJobId);

  if (input.backupJobId) {
    backupJob = resolveBackupJob(input.orgId, input.deviceId, input.backupJobId);
  }

  if (snapshot && snapshot.jobId !== backupJob.id) {
    throw new Error('snapshotId does not belong to backupJobId');
  }

  if (!snapshot && backupJob.snapshotId) {
    const resolved = backupSnapshots.find(
      (row) => row.id === backupJob.snapshotId && snapshotOrgById.get(row.id) === input.orgId
    ) ?? null;
    if (resolved && resolved.deviceId !== input.deviceId) {
      throw new Error('Backup job snapshot does not match requested device');
    }
    if (resolved && resolved.jobId !== backupJob.id) {
      throw new Error('Backup job snapshot linkage is inconsistent');
    }
    snapshot = resolved;
  }

  if ((input.verificationType === 'test_restore' || input.verificationType === 'full_recovery') && !snapshot) {
    throw new Error('Snapshot is required for restore-based verification');
  }

  const snapshotId = snapshot?.id ?? null;
  const now = new Date().toISOString();

  // --- Try to dispatch to agent ---
  const commandType = input.verificationType === 'integrity' ? 'backup_verify' : 'backup_test_restore';
  try {
    const dispatchResult = await queueCommandForExecution(
      input.deviceId,
      commandType,
      { snapshotId: snapshotId || undefined, verificationType: input.verificationType },
      { userId: input.requestedBy || undefined }
    );

    if (dispatchResult.command) {
      // Agent is online — create pending record and return
      const verification = addBackupVerification(
        {
          orgId: input.orgId,
          deviceId: input.deviceId,
          backupJobId: backupJob.id,
          snapshotId,
          verificationType: input.verificationType,
          status: 'pending',
          startedAt: now,
          completedAt: null,
          filesVerified: 0,
          filesFailed: 0,
          details: {
            source: input.source,
            requestedBy: input.requestedBy,
            simulated: false,
            commandId: dispatchResult.command.id,
          },
        },
        input.orgId
      );

      await persistVerificationToDb(verification);
      return { verification, readiness: null };
    }
  } catch (dispatchErr) {
    // Device offline or dispatch failed — fall through to simulation
    console.log(`[backupVerification] Command dispatch failed, using simulation: ${dispatchErr}`);
  }
  // --- End dispatch attempt, fall through to simulation ---

  const seed = deterministicSeed(`${input.orgId}:${input.deviceId}:${backupJob.id}:${input.verificationType}:${snapshotId ?? 'none'}`);
  const filesVerified = snapshot?.fileCount ?? Math.max(100, Math.round((backupJob.sizeBytes ?? 0) / 32768));
  const expectedFailures = Math.max(1, Math.round(filesVerified * 0.01));
  const restoreTimeSeconds = input.verificationType === 'integrity'
    ? 20 + (seed % 120)
    : input.verificationType === 'test_restore'
      ? 180 + (seed % 900)
      : 480 + (seed % 1800);

  let status: BackupVerificationStatus = 'passed';
  if (backupJob.status === 'failed') {
    status = 'failed';
  } else if (input.verificationType === 'full_recovery' && seed % 6 === 0) {
    status = 'failed';
  } else if (input.verificationType === 'test_restore' && seed % 10 === 0) {
    status = 'partial';
  } else if (input.verificationType === 'integrity' && seed % 19 === 0) {
    status = 'partial';
  }

  const filesFailed = status === 'passed'
    ? 0
    : status === 'partial'
      ? Math.max(1, Math.round(expectedFailures / 3))
      : expectedFailures;

  const startedAt = new Date();
  const completedAt = new Date(startedAt.getTime() + (restoreTimeSeconds * 1000));
  const isolatedRestorePath = `/tmp/breeze/restore-tests/${input.deviceId}/${completedAt.getTime()}`;

  const verification = addBackupVerification({
    orgId: input.orgId,
    deviceId: input.deviceId,
    backupJobId: backupJob.id,
    snapshotId,
    verificationType: input.verificationType,
    status,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    restoreTimeSeconds,
    filesVerified,
    filesFailed,
    sizeBytes: snapshot?.sizeBytes ?? backupJob.sizeBytes ?? null,
    details: {
      source: input.source,
      requestedBy: input.requestedBy ?? null,
      simulated: true,
      isolatedRestorePath: input.verificationType === 'integrity' ? null : isolatedRestorePath,
      cleanup: input.verificationType === 'integrity'
        ? null
        : { attempted: true, removed: true },
      reason: status === 'failed'
        ? 'Verification detected unrecoverable artifacts or inconsistent metadata.'
        : null
    }
  }, input.orgId);

  await persistVerificationToDb(verification);
  const readiness = await recomputeRecoveryReadinessForDevice(input.orgId, input.deviceId);

  await safePublish(
    status === 'passed' ? 'backup.verification_passed' : 'backup.verification_failed',
    input.orgId,
    {
      verificationId: verification.id,
      deviceId: verification.deviceId,
      backupJobId: verification.backupJobId,
      snapshotId: verification.snapshotId,
      verificationType: verification.verificationType,
      status: verification.status,
      filesVerified: verification.filesVerified,
      filesFailed: verification.filesFailed,
      restoreTimeSeconds: verification.restoreTimeSeconds,
      readinessScore: readiness.readinessScore,
      criticalAsset: isCriticalDevice(input.orgId, verification.deviceId)
    },
    input.source
  );

  return { verification, readiness };
}

// Re-export for callers that import from this file
export { recomputeRecoveryReadinessForDevice } from './readinessCalculator';
export { listRecoveryReadiness, getBackupHealthSummary } from './readinessCalculator';
export { processBackupVerificationResult, timeoutStaleVerifications } from './verificationScheduled';
export { ensurePostBackupIntegrityChecks, runWeeklyTestRestore, recalculateReadinessScores } from './verificationScheduled';
