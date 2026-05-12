import { beforeEach, describe, expect, it, vi } from 'vitest';

const recomputeRecoveryReadinessForDeviceMock = vi.fn(async () => undefined);
const persistVerificationToDbMock = vi.fn(async () => undefined);
const safePublishMock = vi.fn(async () => undefined);
const listBackupVerificationsMock = vi.fn(async () => []);
const runBackupVerificationMock = vi.fn(async () => ({ verification: null, readiness: null }));
const selectMock = vi.fn();

function selectChain(resolvedValue: unknown) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'orderBy', 'limit']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const updateMock = vi.fn();

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
}));

vi.mock('../../db/schema', () => ({
  backupJobs: {
    orgId: 'backup_jobs.org_id',
    deviceId: 'backup_jobs.device_id',
    completedAt: 'backup_jobs.completed_at',
    startedAt: 'backup_jobs.started_at',
    createdAt: 'backup_jobs.created_at',
    status: 'backup_jobs.status',
  },
  backupVerifications: {
    id: 'backup_verifications.id',
    orgId: 'backup_verifications.org_id',
    deviceId: 'backup_verifications.device_id',
    backupJobId: 'backup_verifications.backup_job_id',
    snapshotId: 'backup_verifications.snapshot_id',
    verificationType: 'backup_verifications.verification_type',
    status: 'backup_verifications.status',
    startedAt: 'backup_verifications.started_at',
    completedAt: 'backup_verifications.completed_at',
    restoreTimeSeconds: 'backup_verifications.restore_time_seconds',
    filesVerified: 'backup_verifications.files_verified',
    filesFailed: 'backup_verifications.files_failed',
    sizeBytes: 'backup_verifications.size_bytes',
    details: 'backup_verifications.details',
    createdAt: 'backup_verifications.created_at',
  },
  deviceCommands: {
    id: 'device_commands.id',
    status: 'device_commands.status',
  },
}));

vi.mock('../../services/backupMetrics', () => ({
  recordBackupCommandTimeout: vi.fn(),
  recordBackupVerificationResult: vi.fn(),
  recordBackupVerificationSkip: vi.fn(),
}));

vi.mock('../../services/eventBus', () => ({
  publishEvent: vi.fn(),
}));

vi.mock('./readinessCalculator', () => ({
  recomputeRecoveryReadinessForDevice: (...args: unknown[]) => recomputeRecoveryReadinessForDeviceMock(...(args as [])),
}));

vi.mock('./verificationService', () => ({
  BACKUP_MAX_RECENT_VERIFICATIONS: 12,
  BackupVerificationDispatchError: class BackupVerificationDispatchError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.name = 'BackupVerificationDispatchError';
      this.statusCode = statusCode;
    }
  },
  listBackupVerifications: (...args: unknown[]) => listBackupVerificationsMock(...(args as [])),
  persistVerificationToDb: (...args: unknown[]) => persistVerificationToDbMock(...(args as [])),
  runBackupVerification: (...args: unknown[]) => runBackupVerificationMock(...(args as [])),
  safePublish: (...args: unknown[]) => safePublishMock(...(args as [])),
}));

import { processBackupVerificationResult, recalculateReadinessScores, timeoutStaleVerifications } from './verificationScheduled';
import { backupJobs, backupVerifications, jobOrgById, verificationOrgById } from './store';

describe('verification timeout handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReturnValue(selectChain([]));
    updateMock.mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([]),
        })),
      })),
    });
  });

  it('recomputes readiness immediately when a verification result fails', async () => {
    const orgId = 'org-result-failed';
    const deviceId = 'dev-result-failed';
    const verificationId = 'verify-result-failed';
    const commandId = '11111111-1111-4111-8111-111111111111';
    const startedAt = new Date();

    backupVerifications.push({
      id: verificationId,
      orgId,
      deviceId,
      backupJobId: 'job-result-failed',
      snapshotId: 'snap-result-failed',
      verificationType: 'integrity',
      status: 'pending',
      startedAt: startedAt.toISOString(),
      completedAt: null,
      restoreTimeSeconds: null,
      filesVerified: 0,
      filesFailed: 0,
      details: { source: 'test', commandId },
      createdAt: startedAt.toISOString(),
    });
    verificationOrgById.set(verificationId, orgId);

    try {
      await processBackupVerificationResult(commandId, {
        status: 'failed',
        error: 'Agent unreachable',
      });

      expect(persistVerificationToDbMock).toHaveBeenCalledWith(expect.objectContaining({
        id: verificationId,
        status: 'failed',
        details: expect.objectContaining({
          reason: 'Agent unreachable',
        }),
      }));
      expect(safePublishMock).toHaveBeenCalledWith(
        'backup.verification_failed',
        orgId,
        expect.objectContaining({
          verificationId,
          deviceId,
          backupJobId: 'job-result-failed',
          verificationType: 'integrity',
          status: 'failed',
        }),
        'agent.result'
      );
      expect(recomputeRecoveryReadinessForDeviceMock).toHaveBeenCalledWith(orgId, deviceId);
    } finally {
      const index = backupVerifications.findIndex((row) => row.id === verificationId);
      if (index >= 0) {
        backupVerifications.splice(index, 1);
      }
      verificationOrgById.delete(verificationId);
    }
  });

  it('skips non-UUID orgIds during readiness recompute fallback', async () => {
    const validOrgId = '22222222-2222-4222-8222-222222222222';
    const validDeviceId = 'dev-valid-uuid';
    const invalidDeviceId = 'dev-bad-orgid';

    backupJobs.push(
      { id: 'job-bad-orgid', type: 'scheduled', deviceId: invalidDeviceId, configId: 'cfg', policyId: 'pol', snapshotId: 'snap', status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), totalSize: 0 },
      { id: 'job-good-orgid', type: 'scheduled', deviceId: validDeviceId, configId: 'cfg', policyId: 'pol', snapshotId: 'snap', status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), totalSize: 0 },
    );
    jobOrgById.set('job-bad-orgid', 'org-123');
    jobOrgById.set('job-good-orgid', validOrgId);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const count = await recalculateReadinessScores();

      expect(recomputeRecoveryReadinessForDeviceMock).toHaveBeenCalledWith(validOrgId, validDeviceId);
      expect(recomputeRecoveryReadinessForDeviceMock).not.toHaveBeenCalledWith('org-123', invalidDeviceId);
      expect(count).toBeGreaterThanOrEqual(1);
      expect(warnSpy).toHaveBeenCalledWith(
        '[backupVerification] Skipping job with non-UUID orgId during readiness recompute',
        expect.objectContaining({ jobId: 'job-bad-orgid', targetOrg: 'org-123' }),
      );
    } finally {
      warnSpy.mockRestore();
      const idxBad = backupJobs.findIndex((j) => j.id === 'job-bad-orgid');
      if (idxBad >= 0) backupJobs.splice(idxBad, 1);
      const idxGood = backupJobs.findIndex((j) => j.id === 'job-good-orgid');
      if (idxGood >= 0) backupJobs.splice(idxGood, 1);
      jobOrgById.delete('job-bad-orgid');
      jobOrgById.delete('job-good-orgid');
    }
  });

  it('marks DB-backed timed out verifications failed, emits a failure event, and recomputes readiness', async () => {
    const orgId = 'org-timeout-db';
    const deviceId = 'dev-timeout-db';
    const verificationId = 'verify-timeout-db';
    const startedAt = new Date(Date.now() - 31 * 60 * 1000);

    const timedOutRow = {
      id: verificationId,
      orgId,
      deviceId,
      backupJobId: 'job-timeout-db',
      snapshotId: 'snap-timeout-db',
      verificationType: 'integrity',
      status: 'pending',
      startedAt,
      completedAt: null,
      restoreTimeSeconds: null,
      filesVerified: 0,
      filesFailed: 0,
      sizeBytes: null,
      details: { source: 'test', commandId: 'cmd-timeout-db' },
      createdAt: startedAt,
    };

    selectMock.mockReturnValueOnce(selectChain([timedOutRow]));

    try {
      const count = await timeoutStaleVerifications();

      expect(count).toBe(1);
      expect(persistVerificationToDbMock).toHaveBeenCalledWith(expect.objectContaining({
        id: verificationId,
        status: 'failed',
        completedAt: expect.any(String),
        details: expect.objectContaining({
          reason: 'Verification timed out after 30 minutes',
        }),
      }));
      expect(safePublishMock).toHaveBeenCalledWith(
        'backup.verification_failed',
        orgId,
        expect.objectContaining({
          verificationId,
          deviceId,
          backupJobId: 'job-timeout-db',
          verificationType: 'integrity',
          status: 'failed',
        }),
        'timeout-check'
      );
      expect(recomputeRecoveryReadinessForDeviceMock).toHaveBeenCalledWith(orgId, deviceId);
      expect(verificationOrgById.get(verificationId)).toBe(orgId);
    } finally {
      verificationOrgById.delete(verificationId);
    }
  });
});
