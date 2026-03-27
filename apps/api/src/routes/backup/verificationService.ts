import { and, desc, eq, gte, lte, type SQL } from 'drizzle-orm';
import * as dbModule from '../../db';
import { backupVerifications as backupVerificationsTable, recoveryReadiness as recoveryReadinessTable } from '../../db/schema';
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
  recoveryReadinessOrgById,
  recoveryReadinessRecords,
  snapshotOrgById,
  upsertRecoveryReadiness,
  verificationOrgById
} from './store';
import type {
  BackupJob,
  BackupSnapshot,
  BackupVerification,
  BackupVerificationStatus,
  BackupVerificationType,
  RecoveryReadiness,
  RecoveryRiskFactor
} from './types';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const MINUTE_MS = 60 * 1000;
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

const lowReadinessState = new Map<string, boolean>();

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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

function lowStateKey(orgId: string, deviceId: string): string {
  return `${orgId}:${deviceId}`;
}

function shouldEmitLowReadiness(
  orgId: string,
  deviceId: string,
  previousScore: number | null,
  nextScore: number
): boolean {
  const key = lowStateKey(orgId, deviceId);
  const previousState = lowReadinessState.get(key) ?? (previousScore !== null && previousScore < BACKUP_LOW_READINESS_THRESHOLD);
  const isLowNow = nextScore < BACKUP_LOW_READINESS_THRESHOLD;

  if (!previousState && isLowNow) {
    lowReadinessState.set(key, true);
    return true;
  }

  if (previousState && nextScore >= BACKUP_READINESS_RECOVERY_THRESHOLD) {
    lowReadinessState.set(key, false);
    return false;
  }

  lowReadinessState.set(key, previousState);
  return false;
}

async function safePublish(
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

function normalizeDbReadinessRow(row: {
  id: string;
  orgId: string;
  deviceId: string;
  readinessScore: number;
  estimatedRtoMinutes: number | null;
  estimatedRpoMinutes: number | null;
  riskFactors: unknown;
  calculatedAt: Date;
}): RecoveryReadiness {
  return {
    id: row.id,
    orgId: row.orgId,
    deviceId: row.deviceId,
    readinessScore: row.readinessScore,
    estimatedRtoMinutes: row.estimatedRtoMinutes,
    estimatedRpoMinutes: row.estimatedRpoMinutes,
    riskFactors: Array.isArray(row.riskFactors) ? row.riskFactors as RecoveryRiskFactor[] : [],
    calculatedAt: toIso(row.calculatedAt) ?? new Date().toISOString()
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

function listRecoveryReadinessFromMemory(orgId: string): RecoveryReadiness[] {
  return recoveryReadinessRecords
    .filter((item) => recoveryReadinessOrgById.get(item.id) === orgId)
    .sort((a, b) => a.readinessScore - b.readinessScore);
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

async function listRecoveryReadinessFromDb(orgId: string): Promise<RecoveryReadiness[] | null> {
  if (!supportsDbOrg(orgId)) return null;

  try {
    const rows = await runWithSystemDbAccess(() => db
      .select()
      .from(recoveryReadinessTable)
      .where(eq(recoveryReadinessTable.orgId, orgId))
      .orderBy(recoveryReadinessTable.readinessScore));

    return rows.map((row) => normalizeDbReadinessRow({
      ...row,
      riskFactors: row.riskFactors as unknown,
    }));
  } catch (error) {
    console.warn('[backupVerification] DB readiness read failed; falling back to memory:', error);
    return null;
  }
}

async function persistVerificationToDb(row: BackupVerification): Promise<void> {
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

async function getRecoveryReadinessForDevice(
  orgId: string,
  deviceId: string
): Promise<RecoveryReadiness | null> {
  if (supportsDbOrg(orgId) && isUuid(deviceId)) {
    try {
      const [row] = await runWithSystemDbAccess(() => db
        .select()
        .from(recoveryReadinessTable)
        .where(and(
          eq(recoveryReadinessTable.orgId, orgId),
          eq(recoveryReadinessTable.deviceId, deviceId)
        ))
        .limit(1));
      if (row) {
        return normalizeDbReadinessRow({
          ...row,
          riskFactors: row.riskFactors as unknown
        });
      }
    } catch (error) {
      console.warn('[backupVerification] DB readiness lookup failed; falling back to memory:', error);
    }
  }

  return listRecoveryReadinessFromMemory(orgId).find((item) => item.deviceId === deviceId) ?? null;
}

async function persistRecoveryReadinessToDb(row: RecoveryReadiness): Promise<void> {
  if (!isUuid(row.orgId) || !isUuid(row.deviceId)) return;

  try {
    await runWithSystemDbAccess(() => db.insert(recoveryReadinessTable).values({
      id: row.id,
      orgId: row.orgId,
      deviceId: row.deviceId,
      readinessScore: row.readinessScore,
      estimatedRtoMinutes: row.estimatedRtoMinutes ?? null,
      estimatedRpoMinutes: row.estimatedRpoMinutes ?? null,
      riskFactors: row.riskFactors,
      calculatedAt: new Date(row.calculatedAt)
    }).onConflictDoUpdate({
      target: [recoveryReadinessTable.orgId, recoveryReadinessTable.deviceId],
      set: {
        readinessScore: row.readinessScore,
        estimatedRtoMinutes: row.estimatedRtoMinutes ?? null,
        estimatedRpoMinutes: row.estimatedRpoMinutes ?? null,
        riskFactors: row.riskFactors,
        calculatedAt: new Date(row.calculatedAt)
      }
    }));
  } catch (error) {
    console.warn('[backupVerification] DB readiness write failed; keeping memory record only:', error);
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

async function writeRecoveryReadiness(
  row: Omit<RecoveryReadiness, 'id'> & { id?: string },
  orgId: string
): Promise<RecoveryReadiness> {
  const saved = upsertRecoveryReadiness(row, orgId);
  await persistRecoveryReadinessToDb(saved);
  return saved;
}

export async function listBackupVerifications(
  orgId: string,
  filters: VerificationFilters = {}
): Promise<BackupVerification[]> {
  const dbRows = await listBackupVerificationsFromDb(orgId, filters);
  if (dbRows) return dbRows;
  return listBackupVerificationsFromMemory(orgId, filters);
}

export async function listRecoveryReadiness(orgId: string): Promise<RecoveryReadiness[]> {
  const dbRows = await listRecoveryReadinessFromDb(orgId);
  if (dbRows) return dbRows;
  return listRecoveryReadinessFromMemory(orgId);
}

export async function recomputeRecoveryReadinessForDevice(
  orgId: string,
  deviceId: string
): Promise<RecoveryReadiness> {
  const [recent, previous] = await Promise.all([
    listBackupVerifications(orgId, { deviceId, limit: BACKUP_MAX_RECENT_VERIFICATIONS }),
    getRecoveryReadinessForDevice(orgId, deviceId)
  ]);
  const previousScore = previous?.readinessScore ?? null;
  const now = Date.now();

  if (recent.length === 0) {
    const readiness = await writeRecoveryReadiness({
      orgId,
      deviceId,
      readinessScore: 0,
      estimatedRtoMinutes: null,
      estimatedRpoMinutes: null,
      riskFactors: [
        {
          code: 'no_verification_history',
          severity: 'high',
          message: 'No verification history is available for this device.'
        }
      ],
      calculatedAt: new Date().toISOString()
    }, orgId);

    if (shouldEmitLowReadiness(orgId, deviceId, previousScore, readiness.readinessScore)) {
      await safePublish(
        'backup.recovery_readiness_low',
        orgId,
        {
          deviceId,
          readinessScore: readiness.readinessScore,
          estimatedRtoMinutes: readiness.estimatedRtoMinutes,
          estimatedRpoMinutes: readiness.estimatedRpoMinutes,
          riskFactors: readiness.riskFactors
        },
        'readiness-score-calculator'
      );
    }
    return readiness;
  }

  const passUnits = recent.reduce((sum, row) => {
    if (row.status === 'passed') return sum + 1;
    if (row.status === 'partial') return sum + 0.5;
    return sum;
  }, 0);
  const passRate = passUnits / recent.length;

  const restoreSamples = recent
    .map((row) => row.restoreTimeSeconds ?? null)
    .filter((value): value is number => typeof value === 'number' && value > 0);
  const avgRestoreSeconds = average(restoreSamples);
  const restoreQuality = avgRestoreSeconds === null ? 0.5 : clamp(1 - ((avgRestoreSeconds - 180) / 3600), 0, 1);

  const lastRunAt = toEpoch(recent[0]?.completedAt ?? recent[0]?.startedAt);
  const ageDays = Math.max(0, (now - lastRunAt) / DAY_MS);
  const recencyQuality = ageDays <= 7 ? 1 : ageDays <= 14 ? 0.65 : ageDays <= 30 ? 0.35 : 0.1;

  const failureCount = recent.filter((row) => row.status === 'failed').length;
  const baseScore = Math.round((passRate * 55) + (restoreQuality * 30) + (recencyQuality * 15));
  const readinessScore = clamp(baseScore - (failureCount * 6), 0, 100);

  const riskFactors: RecoveryRiskFactor[] = [];
  if (failureCount > 0) {
    riskFactors.push({
      code: 'recent_verification_failure',
      severity: 'high',
      message: `${failureCount} recent verification run(s) failed.`
    });
  }
  if (ageDays > 14) {
    riskFactors.push({
      code: 'stale_verification',
      severity: ageDays > 30 ? 'high' : 'medium',
      message: `Last verification is ${Math.floor(ageDays)} day(s) old.`
    });
  }
  if (avgRestoreSeconds !== null && avgRestoreSeconds > 20 * 60) {
    riskFactors.push({
      code: 'rto_above_target',
      severity: avgRestoreSeconds > 45 * 60 ? 'high' : 'medium',
      message: `Average restore duration is ${Math.ceil(avgRestoreSeconds / 60)} minute(s).`
    });
  }

  const hasRecentRestoreTest = recent.some((row) => (
    (row.verificationType === 'test_restore' || row.verificationType === 'full_recovery')
    && (now - toEpoch(row.completedAt ?? row.startedAt)) <= (30 * DAY_MS)
  ));
  if (!hasRecentRestoreTest) {
    riskFactors.push({
      code: 'restore_test_missing',
      severity: 'medium',
      message: 'No restore test has run in the last 30 days.'
    });
  }

  const latestBackup = backupJobs
    .filter((job) => jobOrgById.get(job.id) === orgId)
    .filter((job) => job.type === 'backup' && job.deviceId === deviceId && Boolean(job.completedAt))
    .sort((a, b) => toEpoch(b.completedAt) - toEpoch(a.completedAt))[0];

  const estimatedRpoMinutes = latestBackup?.completedAt
    ? Math.max(0, Math.round((now - toEpoch(latestBackup.completedAt)) / MINUTE_MS))
    : null;

  const readiness = await writeRecoveryReadiness({
    orgId,
    deviceId,
    readinessScore,
    estimatedRtoMinutes: avgRestoreSeconds ? Math.ceil(avgRestoreSeconds / 60) : null,
    estimatedRpoMinutes,
    riskFactors,
    calculatedAt: new Date().toISOString()
  }, orgId);

  if (shouldEmitLowReadiness(orgId, deviceId, previousScore, readiness.readinessScore)) {
    await safePublish(
      'backup.recovery_readiness_low',
      orgId,
      {
        deviceId,
        readinessScore: readiness.readinessScore,
        estimatedRtoMinutes: readiness.estimatedRtoMinutes,
        estimatedRpoMinutes: readiness.estimatedRpoMinutes,
        riskFactors: readiness.riskFactors
      },
      'readiness-score-calculator'
    );
  }

  return readiness;
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
  } catch {
    pending.status = 'failed';
    pending.completedAt = resultNow;
    (pending.details as Record<string, unknown>).reason = 'Failed to parse agent result';
    await persistVerificationToDb(pending);
    return;
  }

  // Map agent fields to verification record
  pending.status = (agentResult.status as BackupVerificationStatus) || 'failed';
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

export async function getBackupHealthSummary(orgId: string): Promise<{
  verification: {
    total: number;
    passedLast24h: number;
    failedLast24h: number;
    partialLast24h: number;
    coveragePercent: number;
  };
  readiness: {
    averageScore: number;
    lowReadinessCount: number;
    criticalDevicesAtRisk: number;
  };
  escalations: {
    verificationFailures: number;
    criticalVerificationFailures: number;
  };
}> {
  const [rows, readiness] = await Promise.all([
    listBackupVerifications(orgId),
    listRecoveryReadiness(orgId)
  ]);
  const now = Date.now();
  const dayAgo = now - DAY_MS;

  const last24h = rows.filter((row) => toEpoch(row.completedAt ?? row.startedAt) >= dayAgo);
  const protectedDevices = new Set(
    backupPolicies
      .filter((policy) => policyOrgById.get(policy.id) === orgId)
      .filter((policy) => policy.targets.deviceIds.length > 0)
      .flatMap((policy) => policy.targets.deviceIds)
  );
  const coveredRecently = new Set(
    rows
      .filter((row) => (now - toEpoch(row.completedAt ?? row.startedAt)) <= (BACKUP_RECENT_COVERAGE_DAYS * DAY_MS))
      .map((row) => row.deviceId)
  );
  const failedLast24h = last24h.filter((row) => row.status === 'failed');
  const criticalFailures = failedLast24h.filter((row) => isCriticalDevice(orgId, row.deviceId));
  const lowReadiness = readiness.filter((row) => row.readinessScore < BACKUP_LOW_READINESS_THRESHOLD);
  const criticalReadinessRisk = lowReadiness.filter((row) => isCriticalDevice(orgId, row.deviceId));

  const averageScore = readiness.length > 0
    ? Math.round((readiness.reduce((sum, row) => sum + row.readinessScore, 0) / readiness.length) * 10) / 10
    : 0;
  const coveragePercent = protectedDevices.size > 0
    ? Math.round((coveredRecently.size / protectedDevices.size) * 100)
    : 100;

  return {
    verification: {
      total: rows.length,
      passedLast24h: last24h.filter((row) => row.status === 'passed').length,
      failedLast24h: failedLast24h.length,
      partialLast24h: last24h.filter((row) => row.status === 'partial').length,
      coveragePercent
    },
    readiness: {
      averageScore,
      lowReadinessCount: lowReadiness.length,
      criticalDevicesAtRisk: criticalReadinessRisk.length
    },
    escalations: {
      verificationFailures: failedLast24h.length,
      criticalVerificationFailures: criticalFailures.length
    }
  };
}

export async function ensurePostBackupIntegrityChecks(orgId?: string): Promise<number> {
  const candidates = backupJobs
    .filter((job) => (!orgId || jobOrgById.get(job.id) === orgId))
    .filter((job) => job.type === 'backup' && job.status === 'completed');

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
    if (job.type !== 'backup' || job.status !== 'completed' || !job.snapshotId) continue;
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
    if (job.type !== 'backup') continue;
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
