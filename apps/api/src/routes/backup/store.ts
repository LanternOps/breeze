import { randomUUID } from 'crypto';
import type { BackupVerification, RecoveryReadiness } from './types';
import {
  backupConfigs,
  backupSnapshots,
  backupJobs,
  restoreJobs,
  backupVerifications,
  recoveryReadinessRecords,
  snapshotContents
} from './storeSeedData';

export const DEFAULT_BACKUP_ORG_ID = 'org-123';

export {
  backupConfigs,
  backupSnapshots,
  backupJobs,
  restoreJobs,
  backupVerifications,
  recoveryReadinessRecords,
  snapshotContents
} from './storeSeedData';

export const configOrgById = new Map<string, string>(
  backupConfigs.map((config) => [config.id, DEFAULT_BACKUP_ORG_ID])
);

export const snapshotOrgById = new Map<string, string>(
  backupSnapshots.map((snapshot) => [snapshot.id, DEFAULT_BACKUP_ORG_ID])
);
export const restoreOrgById = new Map<string, string>(
  restoreJobs.map((restoreJob) => [restoreJob.id, DEFAULT_BACKUP_ORG_ID])
);
export const jobOrgById = new Map<string, string>(
  backupJobs.map((job) => [job.id, DEFAULT_BACKUP_ORG_ID])
);
export const verificationOrgById = new Map<string, string>(
  backupVerifications.map((verification) => [verification.id, DEFAULT_BACKUP_ORG_ID])
);
export const recoveryReadinessOrgById = new Map<string, string>(
  recoveryReadinessRecords.map((readiness) => [readiness.id, DEFAULT_BACKUP_ORG_ID])
);

export function addBackupVerification(
  verification: Omit<BackupVerification, 'id' | 'createdAt'> & { id?: string; createdAt?: string },
  orgId: string
): BackupVerification {
  const row: BackupVerification = {
    ...verification,
    id: verification.id ?? randomUUID(),
    createdAt: verification.createdAt ?? new Date().toISOString()
  };
  backupVerifications.push(row);
  verificationOrgById.set(row.id, orgId);
  return row;
}

export function upsertRecoveryReadiness(
  readiness: Omit<RecoveryReadiness, 'id'> & { id?: string },
  orgId: string
): RecoveryReadiness {
  const existing = recoveryReadinessRecords.find(
    (item) => item.deviceId === readiness.deviceId && recoveryReadinessOrgById.get(item.id) === orgId
  );

  if (existing) {
    existing.readinessScore = readiness.readinessScore;
    existing.estimatedRtoMinutes = readiness.estimatedRtoMinutes ?? null;
    existing.estimatedRpoMinutes = readiness.estimatedRpoMinutes ?? null;
    existing.riskFactors = readiness.riskFactors;
    existing.calculatedAt = readiness.calculatedAt;
    return existing;
  }

  const row: RecoveryReadiness = {
    id: readiness.id ?? randomUUID(),
    ...readiness
  };
  recoveryReadinessRecords.push(row);
  recoveryReadinessOrgById.set(row.id, orgId);
  return row;
}
