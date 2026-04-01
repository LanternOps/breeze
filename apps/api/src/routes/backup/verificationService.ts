import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import * as dbModule from '../../db';
import {
  backupJobs as backupJobsTable,
  backupSnapshots as backupSnapshotsTable,
  backupVerifications as backupVerificationsTable,
} from '../../db/schema';
import { recordBackupDispatchFailure } from '../../services/backupMetrics';
import { queueCommandForExecution } from '../../services/commandQueue';
import { publishEvent } from '../../services/eventBus';
import {
  addBackupVerification,
  backupJobs,
  backupSnapshots,
  backupVerifications,
  jobOrgById,
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
import { normalizeBackupVerificationType } from './types';

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

export class BackupVerificationDispatchError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'BackupVerificationDispatchError';
    this.statusCode = statusCode;
  }
}

type VerificationFilters = {
  deviceId?: string;
  backupJobId?: string;
  verificationType?: BackupVerificationType;
  status?: BackupVerificationStatus;
  from?: number | null;
  to?: number | null;
  limit?: number;
  excludeSimulated?: boolean;
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

function isUuid(value?: string | null): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function supportsDbOrg(orgId: string): boolean {
  return isUuid(orgId);
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
    verificationType: normalizeBackupVerificationType(row.verificationType),
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

function normalizeDbBackupJobRow(row: {
  id: string;
  deviceId: string;
  configId: string;
  policyId: string | null;
  snapshotId: string | null;
  status: string;
  type: string;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  totalSize: number | null;
  fileCount: number | null;
  errorCount: number | null;
  errorLog: string | null;
}): BackupJob {
  return {
    id: row.id,
    type: row.type as BackupJob['type'],
    deviceId: row.deviceId,
    configId: row.configId,
    policyId: row.policyId,
    snapshotId: row.snapshotId,
    status: row.status as BackupJob['status'],
    startedAt: toIso(row.startedAt),
    completedAt: toIso(row.completedAt),
    createdAt: toIso(row.createdAt) ?? new Date().toISOString(),
    updatedAt: toIso(row.updatedAt) ?? new Date().toISOString(),
    totalSize: row.totalSize,
    fileCount: row.fileCount,
    errorCount: row.errorCount,
    errorLog: row.errorLog,
  };
}

function normalizeDbSnapshotRow(row: {
  id: string;
  deviceId: string;
  configId: string | null;
  jobId: string;
  snapshotId: string;
  timestamp: Date;
  size: number | null;
  fileCount: number | null;
  label: string | null;
  location: string | null;
}): BackupSnapshot {
  return {
    id: row.id,
    deviceId: row.deviceId,
    configId: row.configId,
    jobId: row.jobId,
    providerSnapshotId: row.snapshotId,
    createdAt: toIso(row.timestamp) ?? new Date().toISOString(),
    sizeBytes: row.size,
    fileCount: row.fileCount,
    label: row.label,
    location: row.location,
  };
}

function listBackupVerificationsFromMemory(orgId: string, filters: VerificationFilters = {}): BackupVerification[] {
  const from = filters.from ?? null;
  const to = filters.to ?? null;

  let rows = backupVerifications.filter((item) => verificationOrgById.get(item.id) === orgId);

  if (filters.deviceId) rows = rows.filter((item) => item.deviceId === filters.deviceId);
  if (filters.backupJobId) rows = rows.filter((item) => item.backupJobId === filters.backupJobId);
  if (filters.verificationType === 'integrity') {
    rows = rows.filter((item) => item.verificationType === 'integrity');
  } else if (filters.verificationType === 'test_restore') {
    rows = rows.filter((item) => item.verificationType === 'test_restore');
  }
  if (filters.status) rows = rows.filter((item) => item.status === filters.status);
  if (from) rows = rows.filter((item) => toEpoch(item.startedAt) >= from);
  if (to) rows = rows.filter((item) => toEpoch(item.startedAt) <= to);
  if (filters.excludeSimulated) {
    rows = rows.filter((item) => (item.details as Record<string, unknown> | null)?.simulated !== true);
  }

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
  if (filters.verificationType === 'integrity') {
    conditions.push(eq(backupVerificationsTable.verificationType, 'integrity'));
  } else if (filters.verificationType === 'test_restore') {
    conditions.push(eq(backupVerificationsTable.verificationType, 'test_restore'));
  }
  if (filters.status) conditions.push(eq(backupVerificationsTable.status, filters.status));
  if (filters.from) conditions.push(gte(backupVerificationsTable.startedAt, new Date(filters.from)));
  if (filters.to) conditions.push(lte(backupVerificationsTable.startedAt, new Date(filters.to)));
  if (filters.excludeSimulated) {
    conditions.push(sql`coalesce(${backupVerificationsTable.details}->>'simulated', 'false') <> 'true'`);
  }

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
    }).onConflictDoUpdate({
      target: backupVerificationsTable.id,
      set: {
        status: row.status,
        completedAt: row.completedAt ? new Date(row.completedAt) : null,
        restoreTimeSeconds: row.restoreTimeSeconds ?? null,
        filesVerified: row.filesVerified,
        filesFailed: row.filesFailed,
        sizeBytes: row.sizeBytes ?? null,
        details: row.details ?? null,
      }
    }));
  } catch (error) {
    console.warn('[backupVerification] DB verification write failed; keeping memory record only:', error);
  }
}

async function resolveSnapshot(orgId: string, snapshotId: string): Promise<BackupSnapshot> {
  if (supportsDbOrg(orgId) && isUuid(snapshotId)) {
    try {
      const [row] = await runWithSystemDbAccess(() => db
        .select()
        .from(backupSnapshotsTable)
        .where(and(
          eq(backupSnapshotsTable.id, snapshotId),
          eq(backupSnapshotsTable.orgId, orgId),
        ))
        .limit(1));
      if (row) {
        return normalizeDbSnapshotRow({
          ...row,
          size: row.size as number | null,
          fileCount: row.fileCount as number | null,
        });
      }
    } catch (error) {
      console.warn('[backupVerification] DB snapshot lookup failed; falling back to memory:', error);
    }
  }

  const snapshot = backupSnapshots.find(
    (row) => row.id === snapshotId && snapshotOrgById.get(row.id) === orgId
  );
  if (!snapshot) {
    throw new Error('Snapshot not found for organization');
  }
  return snapshot;
}

async function resolveBackupJob(
  orgId: string,
  deviceId: string,
  backupJobId?: string
): Promise<BackupJob> {
  if (supportsDbOrg(orgId) && isUuid(deviceId) && (!backupJobId || isUuid(backupJobId))) {
    try {
      if (backupJobId) {
        const [row] = await runWithSystemDbAccess(() => db
          .select()
          .from(backupJobsTable)
          .where(and(
            eq(backupJobsTable.id, backupJobId),
            eq(backupJobsTable.orgId, orgId),
          ))
          .limit(1));
        if (row) {
          const normalized = normalizeDbBackupJobRow({
            ...row,
            totalSize: row.totalSize as number | null,
            fileCount: row.fileCount as number | null,
            errorCount: row.errorCount as number | null,
          });
          if (normalized.deviceId !== deviceId) {
            throw new Error('backupJobId does not belong to requested device');
          }
          return normalized;
        }
      } else {
        const [row] = await runWithSystemDbAccess(() => db
          .select()
          .from(backupJobsTable)
          .where(and(
            eq(backupJobsTable.orgId, orgId),
            eq(backupJobsTable.deviceId, deviceId),
          ))
          .orderBy(desc(backupJobsTable.completedAt), desc(backupJobsTable.startedAt), desc(backupJobsTable.createdAt))
          .limit(1));
        if (row) {
          return normalizeDbBackupJobRow({
            ...row,
            totalSize: row.totalSize as number | null,
            fileCount: row.fileCount as number | null,
            errorCount: row.errorCount as number | null,
          });
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'backupJobId does not belong to requested device') {
        throw error;
      }
      console.warn('[backupVerification] DB backup job lookup failed; falling back to memory:', error);
    }
  }

  if (backupJobId) {
    const row = backupJobs.find((job) => job.id === backupJobId && jobOrgById.get(job.id) === orgId);
    if (!row) {
      throw new Error('Backup job not found for organization');
    }
    if (row.deviceId !== deviceId) {
      throw new Error('backupJobId does not belong to requested device');
    }
    return row;
  }

  const latest = backupJobs
    .filter((job) => jobOrgById.get(job.id) === orgId)
    .filter((job) => job.deviceId === deviceId)
    .sort((a, b) => toEpoch(b.completedAt ?? b.startedAt ?? b.updatedAt) - toEpoch(a.completedAt ?? a.startedAt ?? a.updatedAt));

  const row = latest[0];
  if (!row) {
    throw new Error('Backup job not found for requested device');
  }
  return row;
}

async function resolveSnapshotForBackupJob(
  orgId: string,
  backupJob: BackupJob,
): Promise<BackupSnapshot | null> {
  if (supportsDbOrg(orgId) && isUuid(backupJob.id)) {
    try {
      const rows = await runWithSystemDbAccess(() => db
        .select()
        .from(backupSnapshotsTable)
        .where(and(
          eq(backupSnapshotsTable.orgId, orgId),
          eq(backupSnapshotsTable.jobId, backupJob.id),
        ))
        .orderBy(desc(backupSnapshotsTable.timestamp))
        .limit(1));
      const [row] = rows;
      if (row) {
        return normalizeDbSnapshotRow({
          ...row,
          size: row.size as number | null,
          fileCount: row.fileCount as number | null,
        });
      }
    } catch (error) {
      console.warn('[backupVerification] DB snapshot lookup by job failed; falling back to memory:', error);
    }
  }

  const resolved = backupSnapshots.find(
    (row) => row.id === backupJob.snapshotId && snapshotOrgById.get(row.id) === orgId
  ) ?? null;
  return resolved;
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
    snapshot = await resolveSnapshot(input.orgId, input.snapshotId);
    if (snapshot.deviceId !== input.deviceId) {
      throw new Error('snapshotId does not belong to requested device');
    }
  }

  let backupJob = snapshot
    ? await resolveBackupJob(input.orgId, input.deviceId, snapshot.jobId)
    : await resolveBackupJob(input.orgId, input.deviceId, input.backupJobId);

  if (input.backupJobId) {
    backupJob = await resolveBackupJob(input.orgId, input.deviceId, input.backupJobId);
  }

  if (snapshot && snapshot.jobId !== backupJob.id) {
    throw new Error('snapshotId does not belong to backupJobId');
  }

  if (!snapshot && backupJob.snapshotId) {
    const resolved = await resolveSnapshotForBackupJob(input.orgId, backupJob);
    if (resolved && resolved.deviceId !== input.deviceId) {
      throw new Error('Backup job snapshot does not match requested device');
    }
    if (resolved && resolved.jobId !== backupJob.id) {
      throw new Error('Backup job snapshot linkage is inconsistent');
    }
    snapshot = resolved;
  }

  if (input.verificationType === 'test_restore' && !snapshot) {
    throw new Error('Snapshot is required for restore-based verification');
  }

  const snapshotId = snapshot?.id ?? null;
  const now = new Date().toISOString();
  const agentSnapshotId = snapshot?.providerSnapshotId ?? backupJob.snapshotId ?? snapshot?.id ?? undefined;

  const commandType = input.verificationType === 'integrity' ? 'backup_verify' : 'backup_test_restore';
  const dispatchResult = await queueCommandForExecution(
    input.deviceId,
    commandType,
    { snapshotId: agentSnapshotId, verificationType: input.verificationType },
    { userId: input.requestedBy || undefined }
  );

  if (dispatchResult.error) {
    recordBackupDispatchFailure(
      'backup_verification',
      dispatchResult.error.startsWith('Device is ') ? 'device_offline' : 'enqueue_failed'
    );
    throw new BackupVerificationDispatchError(
      dispatchResult.error,
      dispatchResult.error.startsWith('Device is ') ? 409 : 502
    );
  }

  if (!dispatchResult.command?.id) {
    recordBackupDispatchFailure('backup_verification', 'missing_command_id');
    throw new BackupVerificationDispatchError(
      'Verification command was queued without a command ID',
      502
    );
  }

  const verification = addBackupVerification({
    orgId: input.orgId,
    deviceId: input.deviceId,
    backupJobId: backupJob.id,
    snapshotId,
    verificationType: input.verificationType,
    status: dispatchResult.command.status === 'sent' ? 'running' : 'pending',
    startedAt: now,
    completedAt: null,
    filesVerified: 0,
    filesFailed: 0,
    details: {
      source: input.source,
      requestedBy: input.requestedBy ?? null,
      commandId: dispatchResult.command.id,
    }
  }, input.orgId);

  await persistVerificationToDb(verification);
  return { verification, readiness: null };
}

// Re-export for callers that import from this file
export { recomputeRecoveryReadinessForDevice } from './readinessCalculator';
export { listRecoveryReadiness, getBackupHealthSummary } from './readinessCalculator';
export { processBackupVerificationResult, timeoutStaleVerifications } from './verificationScheduled';
export { ensurePostBackupIntegrityChecks, runWeeklyTestRestore, recalculateReadinessScores } from './verificationScheduled';
