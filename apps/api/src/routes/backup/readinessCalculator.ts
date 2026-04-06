import { and, desc, eq } from 'drizzle-orm';
import * as dbModule from '../../db';
import { backupJobs as backupJobsTable, recoveryReadiness as recoveryReadinessTable } from '../../db/schema';
import { publishEvent } from '../../services/eventBus';
import {
  backupJobs,
  jobOrgById,
  recoveryReadinessOrgById,
  recoveryReadinessRecords,
  upsertRecoveryReadiness
} from './store';
import { resolveAllBackupAssignedDevices, type BackupAssignedDevice } from '../../services/featureConfigResolver';
import type { RecoveryReadiness, RecoveryRiskFactor } from './types';
// NOTE: Circular import with verificationService is intentional and safe.
// listBackupVerifications is only called at function invocation time, not at module evaluation.
import {
  BACKUP_LOW_READINESS_THRESHOLD,
  BACKUP_MAX_RECENT_VERIFICATIONS,
  BACKUP_READINESS_RECOVERY_THRESHOLD,
  BACKUP_RECENT_COVERAGE_DAYS,
  listBackupVerifications
} from './verificationService';
import { isCriticalBackupDevice } from './criticality';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MISSING_RESTORE_PROOF_PENALTY = 20;

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

function isUuid(value?: string | null): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function supportsDbOrg(orgId: string): boolean {
  return isUuid(orgId);
}

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

function createNoHistoryReadiness(orgId: string, deviceId: string): RecoveryReadiness {
  return {
    id: `synthetic-readiness:${orgId}:${deviceId}`,
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
  };
}

async function addMissingAssignedDevicesToReadiness(
  orgId: string,
  rows: RecoveryReadiness[]
): Promise<RecoveryReadiness[]> {
  let assignedDevices: BackupAssignedDevice[] = [];

  try {
    assignedDevices = await resolveAllBackupAssignedDevices(orgId);
  } catch (error) {
    console.error(`[BackupReadiness] Failed to resolve assigned devices for readiness listing:`, error instanceof Error ? error.message : error);
    return rows;
  }

  if (assignedDevices.length === 0) {
    return rows;
  }

  const existingDeviceIds = new Set(rows.map((row) => row.deviceId));
  const syntheticRows = assignedDevices
    .filter((device) => !existingDeviceIds.has(device.deviceId))
    .map((device) => createNoHistoryReadiness(orgId, device.deviceId));

  if (syntheticRows.length === 0) {
    return rows;
  }

  return [...rows, ...syntheticRows].sort((a, b) => {
    const scoreDiff = a.readinessScore - b.readinessScore;
    if (scoreDiff !== 0) return scoreDiff;
    return a.deviceId.localeCompare(b.deviceId);
  });
}

// ---- Low readiness state tracking ----

const lowReadinessState = new Map<string, boolean>();

export function lowStateKey(orgId: string, deviceId: string): string {
  return `${orgId}:${deviceId}`;
}

export function shouldEmitLowReadiness(
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

// ---- DB helpers ----

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

function listRecoveryReadinessFromMemory(orgId: string): RecoveryReadiness[] {
  return recoveryReadinessRecords
    .filter((item) => recoveryReadinessOrgById.get(item.id) === orgId)
    .sort((a, b) => a.readinessScore - b.readinessScore);
}

async function getLatestCompletedBackup(
  orgId: string,
  deviceId: string
): Promise<{ completedAt: Date | string | null } | null> {
  if (supportsDbOrg(orgId) && isUuid(deviceId)) {
    try {
      const [row] = await runWithSystemDbAccess(() => db
        .select({ completedAt: backupJobsTable.completedAt })
        .from(backupJobsTable)
        .where(and(
          eq(backupJobsTable.orgId, orgId),
          eq(backupJobsTable.deviceId, deviceId),
          eq(backupJobsTable.status, 'completed'),
        ))
        .orderBy(desc(backupJobsTable.completedAt))
        .limit(1));
      if (row) return row;
    } catch (error) {
      console.warn('[backupVerification] DB latest backup lookup failed; falling back to memory:', error);
    }
  }

  const latestBackup = backupJobs
    .filter((job) => jobOrgById.get(job.id) === orgId)
    .filter((job) => job.deviceId === deviceId && Boolean(job.completedAt))
    .sort((a, b) => toEpoch(b.completedAt) - toEpoch(a.completedAt))[0];

  return latestBackup ? { completedAt: latestBackup.completedAt ?? null } : null;
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

export async function getRecoveryReadinessForDevice(
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

export async function persistRecoveryReadinessToDb(row: RecoveryReadiness): Promise<void> {
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

async function writeRecoveryReadiness(
  row: Omit<RecoveryReadiness, 'id'> & { id?: string },
  orgId: string
): Promise<RecoveryReadiness> {
  const saved = upsertRecoveryReadiness(row, orgId);
  await persistRecoveryReadinessToDb(saved);
  return saved;
}

async function safePublish(
  type: 'backup.recovery_readiness_low',
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

// ---- Public readiness listing ----

export async function listRecoveryReadiness(orgId: string): Promise<RecoveryReadiness[]> {
  const dbRows = await listRecoveryReadinessFromDb(orgId);
  const rows = dbRows ?? listRecoveryReadinessFromMemory(orgId);
  return addMissingAssignedDevicesToReadiness(orgId, rows);
}

// ---- Main readiness computation ----

export async function recomputeRecoveryReadinessForDevice(
  orgId: string,
  deviceId: string
): Promise<RecoveryReadiness> {
  const [recent, previous] = await Promise.all([
    listBackupVerifications(orgId, { deviceId, limit: BACKUP_MAX_RECENT_VERIFICATIONS, excludeSimulated: true }),
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

  const hasRecentRestoreTest = recent.some((row) => (
    row.verificationType === 'test_restore'
    && (now - toEpoch(row.completedAt ?? row.startedAt)) <= (30 * DAY_MS)
  ));
  const weightedRows = recent.map((row) => ({
    row,
    weight: row.verificationType === 'integrity' ? 0.5 : 1,
  }));
  const maxUnits = weightedRows.reduce((sum, entry) => sum + entry.weight, 0);
  const passUnits = weightedRows.reduce((sum, entry) => {
    if (entry.row.status === 'passed') return sum + entry.weight;
    if (entry.row.status === 'partial') return sum + (entry.weight * 0.5);
    return sum;
  }, 0);
  const passRate = maxUnits > 0 ? passUnits / maxUnits : 0;

  const restoreSamples = recent
    .filter((row) => row.verificationType === 'test_restore')
    .map((row) => row.restoreTimeSeconds ?? null)
    .filter((value): value is number => typeof value === 'number' && value > 0);
  const avgRestoreSeconds = average(restoreSamples);
  const restoreQuality = avgRestoreSeconds === null ? 0 : clamp(1 - ((avgRestoreSeconds - 180) / 3600), 0, 1);

  const lastRunAt = toEpoch(recent[0]?.completedAt ?? recent[0]?.startedAt);
  const ageDays = Math.max(0, (now - lastRunAt) / DAY_MS);
  const recencyQuality = ageDays <= 7 ? 1 : ageDays <= 14 ? 0.65 : ageDays <= 30 ? 0.35 : 0.1;

  const failureCount = recent.filter((row) => row.status === 'failed').length;
  const baseScore = Math.round((passRate * 55) + (restoreQuality * 30) + (recencyQuality * 15));
  const readinessScore = clamp(baseScore - (failureCount * 6) - (hasRecentRestoreTest ? 0 : MISSING_RESTORE_PROOF_PENALTY), 0, 100);

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

  if (!hasRecentRestoreTest) {
    riskFactors.push({
      code: 'restore_test_missing',
      severity: 'medium',
      message: 'No restore test has run in the last 30 days.'
    });
  }

  const latestBackup = await getLatestCompletedBackup(orgId, deviceId);

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

// ---- Health summary ----

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
  const [rows, readiness, assignedResult] = await Promise.all([
    listBackupVerifications(orgId, { excludeSimulated: true }),
    listRecoveryReadiness(orgId),
    resolveAllBackupAssignedDevices(orgId)
      .then((assigned) => ({ assigned, failed: false as const }))
      .catch((err) => {
        console.error(`[BackupReadiness] Failed to resolve assigned devices:`, err instanceof Error ? err.message : err);
        return { assigned: [] as BackupAssignedDevice[], failed: true as const };
      })
  ]);
  const now = Date.now();
  const dayAgo = now - DAY_MS;

  const last24h = rows.filter((row) => toEpoch(row.completedAt ?? row.startedAt) >= dayAgo);
  const protectedDeviceIds = assignedResult.assigned.map((a) => a.deviceId);
  const protectedDevices = new Set(protectedDeviceIds);
  const coveredRecently = new Set(
    rows
      .filter((row) => row.status === 'passed')
      .filter((row) => (now - toEpoch(row.completedAt ?? row.startedAt)) <= (BACKUP_RECENT_COVERAGE_DAYS * DAY_MS))
      .filter((row) => protectedDevices.has(row.deviceId))
      .map((row) => row.deviceId)
  );
  const failedLast24h = last24h.filter((row) => row.status === 'failed');
  const lowReadiness = readiness.filter((row) => row.readinessScore < BACKUP_LOW_READINESS_THRESHOLD);
  const [criticalFailureFlags, criticalReadinessFlags] = await Promise.all([
    Promise.all(failedLast24h.map((row) => isCriticalBackupDevice(orgId, row.deviceId))),
    Promise.all(lowReadiness.map((row) => isCriticalBackupDevice(orgId, row.deviceId))),
  ]);
  const criticalFailures = failedLast24h.filter((_row, index) => criticalFailureFlags[index]);
  const criticalReadinessRisk = lowReadiness.filter((_row, index) => criticalReadinessFlags[index]);

  const averageScore = readiness.length > 0
    ? Math.round((readiness.reduce((sum, row) => sum + row.readinessScore, 0) / readiness.length) * 10) / 10
    : 0;
  const coveragePercent = assignedResult.failed
    ? 0
    : protectedDevices.size > 0
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
