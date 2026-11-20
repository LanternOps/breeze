import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recomputeRecoveryReadinessForDeviceMock = vi.fn(async () => undefined);
const persistVerificationToDbMock = vi.fn(async () => undefined);
const safePublishMock = vi.fn(async () => undefined);
const listBackupVerificationsMock = vi.fn(async () => []);
const runBackupVerificationMock = vi.fn(async () => ({ verification: null, readiness: null }));
const runScheduledBackupVerificationMock = vi.fn(async () => ({ verification: null, readiness: null }));
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
  withSystemDbAccessContextIsolated: vi.fn(async (fn: () => any) => fn()),
  withDbTransactionIfHeld: vi.fn(async (fn: () => any) => fn()),
}));

vi.mock('../../db/schema', () => ({
  RESTORABLE_BACKUP_JOB_STATUSES: ['completed', 'completed_with_errors', 'partial'],
  DEGRADED_BACKUP_JOB_STATUSES: ['completed_with_errors', 'partial'],
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
    executedAt: 'device_commands.executed_at',
    completedAt: 'device_commands.completed_at',
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
  runScheduledBackupVerification: (...args: unknown[]) => runScheduledBackupVerificationMock(...(args as [])),
  safePublish: (...args: unknown[]) => safePublishMock(...(args as [])),
}));

import { ensurePostBackupIntegrityChecks, processBackupVerificationResult, recalculateReadinessScores, runWeeklyTestRestore, timeoutStaleVerifications } from './verificationScheduled';
import { backupJobs, backupVerifications, jobOrgById, verificationOrgById } from './store';
import {
  LEGACY_VERIFICATION_TIMEOUT_REASON,
  VERIFICATION_TIMEOUT_GRACE_MS,
  VERIFICATION_TIMEOUT_REASON_CODE,
  verificationTimeoutReason,
} from './verificationTimeout';
import { PgDialect } from 'drizzle-orm/pg-core';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
/** Past the 2h base + grace. */
const PAST_BASE_MS = 2 * HOUR + VERIFICATION_TIMEOUT_GRACE_MS + MIN;

function compileWhere(whereArg: unknown) {
  return new PgDialect().sqlToQuery(whereArg as never);
}

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
    runScheduledBackupVerificationMock.mockClear();
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

  it('persists the agent error string as the failure reason (#6561)', async () => {
    const orgId = 'org-result-error';
    const deviceId = 'dev-result-error';
    const verificationId = 'verify-result-error';
    const commandId = '33333333-3333-4333-8333-333333333333';
    const startedAt = new Date();

    backupVerifications.push({
      id: verificationId,
      orgId,
      deviceId,
      backupJobId: 'job-result-error',
      snapshotId: 'snap-result-error',
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
        status: 'completed',
        stdout: JSON.stringify({
          snapshotId: 'snap-result-error',
          status: 'failed',
          filesVerified: 0,
          filesFailed: 0,
          error: 'no files in snapshot',
        }),
      });

      expect(persistVerificationToDbMock).toHaveBeenCalledWith(expect.objectContaining({
        id: verificationId,
        status: 'failed',
        details: expect.objectContaining({
          reason: 'no files in snapshot',
          source: 'agent.result',
        }),
      }));
    } finally {
      const index = backupVerifications.findIndex((row) => row.id === verificationId);
      if (index >= 0) {
        backupVerifications.splice(index, 1);
      }
      verificationOrgById.delete(verificationId);
    }
  });

  it('derives a count-only reason when the agent reports no error (#6561)', async () => {
    const cases = [
      {
        id: 'verify-derived-failed',
        commandId: '55555555-5555-4555-8555-555555555555',
        result: { status: 'failed', filesVerified: 0, filesFailed: 4 },
        expected: '4 file(s) failed verification',
      },
      {
        id: 'verify-derived-partial',
        commandId: '66666666-6666-4666-8666-666666666666',
        result: { status: 'partial', filesVerified: 6, filesFailed: 0, filesIncomplete: 2 },
        expected: '2 file(s) never uploaded during the backup run and are absent from this snapshot',
      },
      {
        id: 'verify-derived-both',
        commandId: '77777777-7777-4777-8777-777777777777',
        result: { status: 'partial', filesVerified: 5, filesFailed: 1, filesIncomplete: 3 },
        expected: '1 file(s) failed verification; 3 file(s) never uploaded during the backup run and are absent from this snapshot',
      },
    ];

    for (const testCase of cases) {
      const orgId = `org-${testCase.id}`;
      const startedAt = new Date();
      backupVerifications.push({
        id: testCase.id,
        orgId,
        deviceId: `dev-${testCase.id}`,
        backupJobId: `job-${testCase.id}`,
        snapshotId: `snap-${testCase.id}`,
        verificationType: 'integrity',
        status: 'pending',
        startedAt: startedAt.toISOString(),
        completedAt: null,
        restoreTimeSeconds: null,
        filesVerified: 0,
        filesFailed: 0,
        details: { source: 'test', commandId: testCase.commandId },
        createdAt: startedAt.toISOString(),
      });
      verificationOrgById.set(testCase.id, orgId);

      try {
        await processBackupVerificationResult(testCase.commandId, {
          status: 'completed',
          stdout: JSON.stringify({ snapshotId: `snap-${testCase.id}`, ...testCase.result }),
        });

        expect(persistVerificationToDbMock).toHaveBeenCalledWith(expect.objectContaining({
          id: testCase.id,
          details: expect.objectContaining({
            reason: testCase.expected,
            source: 'agent.result',
          }),
        }));
      } finally {
        const index = backupVerifications.findIndex((row) => row.id === testCase.id);
        if (index >= 0) backupVerifications.splice(index, 1);
        verificationOrgById.delete(testCase.id);
      }
    }
  });

  it('does not leave a stale failure reason on a later passing result (#6561)', async () => {
    const orgId = 'org-result-pass';
    const deviceId = 'dev-result-pass';
    const verificationId = 'verify-result-pass';
    const commandId = '44444444-4444-4444-8444-444444444444';
    const startedAt = new Date();

    backupVerifications.push({
      id: verificationId,
      orgId,
      deviceId,
      backupJobId: 'job-result-pass',
      snapshotId: 'snap-result-pass',
      verificationType: 'integrity',
      status: 'pending',
      startedAt: startedAt.toISOString(),
      completedAt: null,
      restoreTimeSeconds: null,
      filesVerified: 0,
      filesFailed: 0,
      details: { source: 'test', commandId, reason: 'stale reason from an earlier attempt' },
      createdAt: startedAt.toISOString(),
    });
    verificationOrgById.set(verificationId, orgId);

    try {
      await processBackupVerificationResult(commandId, {
        status: 'completed',
        stdout: JSON.stringify({
          snapshotId: 'snap-result-pass',
          status: 'passed',
          filesVerified: 3,
          filesFailed: 0,
        }),
      });

      const lastCall = persistVerificationToDbMock.mock.calls.at(-1) as unknown[] | undefined;
      const persisted = lastCall?.[0] as { details: Record<string, unknown> } | undefined;
      expect(persisted?.details.reason).toBeUndefined();
    } finally {
      const index = backupVerifications.findIndex((row) => row.id === verificationId);
      if (index >= 0) {
        backupVerifications.splice(index, 1);
      }
      verificationOrgById.delete(verificationId);
    }
  });

  it('persists filesUnchecked and the storage_session_lost code when the session ended mid-run', async () => {
    const orgId = 'org-session-lost';
    const verificationId = 'verify-session-lost';
    const commandId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const startedAt = new Date();
    const agentError = 'verification stopped: the storage session ended before every file was checked; '
      + 'checked 120 of 484887 files (120 ok, 0 failed), the remaining 484767 were not verified '
      + '(storage session: session is no longer usable: resolve rejected with status 410)';
    backupVerifications.push({
      id: verificationId,
      orgId,
      deviceId: 'dev-session-lost',
      backupJobId: 'job-session-lost',
      snapshotId: 'snap-session-lost',
      verificationType: 'integrity',
      status: 'running',
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
        status: 'completed',
        stdout: JSON.stringify({
          snapshotId: 'snap-session-lost',
          status: 'partial',
          filesVerified: 120,
          filesFailed: 0,
          filesUnchecked: 484_767,
          error: agentError,
          code: 'storage_session_lost',
        }),
      });

      const persisted = (persistVerificationToDbMock.mock.calls.at(-1) as unknown[] | undefined)?.[0] as
        | { id: string; status: string; filesFailed: number; details: Record<string, unknown> }
        | undefined;
      expect(persisted?.id).toBe(verificationId);
      expect(persisted?.status).toBe('partial');
      expect(persisted?.filesFailed).toBe(0);
      expect(persisted?.details.filesUnchecked).toBe(484_767);
      expect(persisted?.details.reasonCode).toBe('storage_session_lost');
      expect(persisted?.details.reason).toBe(agentError);
    } finally {
      const index = backupVerifications.findIndex((row) => row.id === verificationId);
      if (index >= 0) backupVerifications.splice(index, 1);
      verificationOrgById.delete(verificationId);
    }
  });

  it('persists how many failed files and warnings the result left out', async () => {
    const orgId = 'org-omitted';
    const verificationId = 'verify-omitted';
    const commandId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const startedAt = new Date();
    backupVerifications.push({
      id: verificationId,
      orgId,
      deviceId: 'dev-omitted',
      backupJobId: 'job-omitted',
      snapshotId: 'snap-omitted',
      verificationType: 'integrity',
      status: 'running',
      startedAt: startedAt.toISOString(),
      completedAt: null,
      restoreTimeSeconds: null,
      filesVerified: 0,
      filesFailed: 0,
      details: { source: 'test', commandId, failedFilesOmitted: 7, warningsOmitted: 7 },
      createdAt: startedAt.toISOString(),
    });
    verificationOrgById.set(verificationId, orgId);

    try {
      await processBackupVerificationResult(commandId, {
        status: 'completed',
        stdout: JSON.stringify({
          snapshotId: 'snap-omitted',
          status: 'failed',
          filesVerified: 10,
          filesFailed: 1_500,
          failedFiles: Array.from({ length: 1_500 }, (_, i) => `/data/file_${i}`),
          // One string, so no note can be appended: the count is the only signal.
          warnings: 'volatile entries changed during the backup',
        }),
      });

      const persisted = (persistVerificationToDbMock.mock.calls.at(-1) as unknown[] | undefined)?.[0] as
        | { id: string; filesFailed: number; details: Record<string, unknown> }
        | undefined;
      expect(persisted?.id).toBe(verificationId);
      expect(persisted?.filesFailed).toBe(1_500);
      expect((persisted?.details.failedFiles as string[]).length).toBe(1_000);
      expect(persisted?.details.failedFilesOmitted).toBe(500);
      // Overwritten on every result, so an earlier attempt's count cannot linger.
      expect(persisted?.details.warningsOmitted).toBe(0);
    } finally {
      const index = backupVerifications.findIndex((row) => row.id === verificationId);
      if (index >= 0) backupVerifications.splice(index, 1);
      verificationOrgById.delete(verificationId);
    }
  });

  // The usual production order: the timeout job fails the row and its
  // command, which revokes the read session; the agent then answers with a
  // storage_session_lost result. That answer replaces the timeout marker.
  it('replaces the timeout marker when a late result reports the session ended', async () => {
    const orgId = 'org-late-session-lost';
    const verificationId = 'verify-late-session-lost';
    const commandId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const startedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    backupVerifications.push({
      id: verificationId,
      orgId,
      deviceId: 'dev-late-session-lost',
      backupJobId: 'job-late-session-lost',
      snapshotId: 'snap-late-session-lost',
      verificationType: 'integrity',
      status: 'failed',
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      restoreTimeSeconds: null,
      filesVerified: 0,
      filesFailed: 0,
      details: { source: 'test', commandId, reason: verificationTimeoutReason(2 * HOUR), reasonCode: VERIFICATION_TIMEOUT_REASON_CODE },
      createdAt: startedAt.toISOString(),
    });
    verificationOrgById.set(verificationId, orgId);
    selectMock.mockImplementation(() => { throw new Error('db down'); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const agentError = 'verification stopped: the storage session ended before every file was checked; '
      + 'checked 10 of 40 files (10 ok, 0 failed), the remaining 30 were not verified (storage session: closed)';

    try {
      await processBackupVerificationResult(commandId, {
        status: 'completed',
        stdout: JSON.stringify({
          snapshotId: 'snap-late-session-lost',
          status: 'partial',
          filesVerified: 10,
          filesFailed: 0,
          filesUnchecked: 30,
          error: agentError,
          code: 'storage_session_lost',
        }),
      });

      const persisted = (persistVerificationToDbMock.mock.calls.at(-1) as unknown[] | undefined)?.[0] as
        | { id: string; status: string; details: Record<string, unknown> }
        | undefined;
      expect(persisted?.id).toBe(verificationId);
      expect(persisted?.status).toBe('partial');
      expect(persisted?.details.reasonCode).toBe('storage_session_lost');
      expect(persisted?.details.reason).toBe(agentError);
      expect(persisted?.details.filesUnchecked).toBe(30);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      selectMock.mockReset();
      const index = backupVerifications.findIndex((row) => row.id === verificationId);
      if (index >= 0) backupVerifications.splice(index, 1);
      verificationOrgById.delete(verificationId);
    }
  });

  it('keeps only allowlisted agent codes and resets filesUnchecked on every result', async () => {
    const orgId = 'org-other-code';
    const verificationId = 'verify-other-code';
    const commandId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const startedAt = new Date();
    backupVerifications.push({
      id: verificationId,
      orgId,
      deviceId: 'dev-other-code',
      backupJobId: 'job-other-code',
      snapshotId: 'snap-other-code',
      verificationType: 'integrity',
      status: 'pending',
      startedAt: startedAt.toISOString(),
      completedAt: null,
      restoreTimeSeconds: null,
      filesVerified: 0,
      filesFailed: 0,
      details: { source: 'test', commandId, filesUnchecked: 9, reasonCode: 'storage_session_lost' },
      createdAt: startedAt.toISOString(),
    });
    verificationOrgById.set(verificationId, orgId);

    try {
      await processBackupVerificationResult(commandId, {
        status: 'completed',
        stdout: JSON.stringify({
          snapshotId: 'snap-other-code',
          status: 'failed',
          filesVerified: 0,
          filesFailed: 2,
          code: 'integrity_mismatch',
        }),
      });

      const persisted = (persistVerificationToDbMock.mock.calls.at(-1) as unknown[] | undefined)?.[0] as
        | { id: string; details: Record<string, unknown> }
        | undefined;
      expect(persisted?.id).toBe(verificationId);
      expect(persisted?.details.reasonCode).toBeUndefined();
      expect(persisted?.details.filesUnchecked).toBe(0);
    } finally {
      const index = backupVerifications.findIndex((row) => row.id === verificationId);
      if (index >= 0) backupVerifications.splice(index, 1);
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
    // #11813: past the derived budget (command timeout + grace), not 30 min,
    // measured from the command's claim.
    const startedAt = new Date(Date.now() - PAST_BASE_MS - 20 * MIN);
    const commandId = '12121212-1212-4121-8121-121212121212';
    const executedAt = new Date(Date.now() - PAST_BASE_MS);

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
      details: { source: 'test', commandId },
      createdAt: startedAt,
    };

    selectMock
      .mockReturnValueOnce(selectChain([timedOutRow]))
      .mockReturnValueOnce(selectChain([{ id: commandId, status: 'sent', executedAt, completedAt: null }]));
    updateMock.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: commandId }]) })) })),
    });

    try {
      const count = await timeoutStaleVerifications();

      expect(count).toBe(1);
      expect(persistVerificationToDbMock).toHaveBeenCalledWith(expect.objectContaining({
        id: verificationId,
        status: 'failed',
        completedAt: expect.any(String),
        details: expect.objectContaining({
          reason: verificationTimeoutReason(2 * HOUR),
          reasonCode: VERIFICATION_TIMEOUT_REASON_CODE,
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

  // #11813: a large snapshot still verifying at 31 minutes is healthy — the
  // command's own budget is two hours, so the timeout job must leave it alone.
  it('does not time out a verification that is past 30 minutes but inside the command budget', async () => {
    const verificationId = 'verify-inside-budget';
    const startedAt = new Date(Date.now() - 31 * 60 * 1000);
    backupVerifications.push({
      id: verificationId,
      orgId: 'org-inside-budget',
      deviceId: 'dev-inside-budget',
      backupJobId: 'job-inside-budget',
      snapshotId: 'snap-inside-budget',
      verificationType: 'integrity',
      status: 'running',
      startedAt: startedAt.toISOString(),
      completedAt: null,
      restoreTimeSeconds: null,
      filesVerified: 0,
      filesFailed: 0,
      details: { source: 'test', commandId: '66666666-6666-4666-8666-666666666666' },
      createdAt: startedAt.toISOString(),
    });
    verificationOrgById.set(verificationId, 'org-inside-budget');

    try {
      const count = await timeoutStaleVerifications();

      expect(count).toBe(0);
      expect(updateMock).not.toHaveBeenCalled();
      expect(persistVerificationToDbMock).not.toHaveBeenCalled();
      expect(backupVerifications.find((row) => row.id === verificationId)?.status).toBe('running');
    } finally {
      const index = backupVerifications.findIndex((row) => row.id === verificationId);
      if (index >= 0) backupVerifications.splice(index, 1);
      verificationOrgById.delete(verificationId);
    }
  });

  // The timeout clock runs from the command's claim (executed_at) plus the
  // verification's own scaled budget (details.timeBudgetSeconds), and the
  // command write is a compare-and-set on what the scan observed.
  describe('timeout clock: executed_at + scaled budget, CAS on the observed command', () => {
    const ORG = 'org-clock';
    const COMMAND = '13131313-1313-4131-8131-131313131313';

    function dbVerificationRow(over: { startedAgoMs: number; details?: Record<string, unknown>; type?: 'integrity' | 'test_restore' }) {
      const startedAt = new Date(Date.now() - over.startedAgoMs);
      return {
        id: 'verify-clock',
        orgId: ORG,
        deviceId: 'dev-clock',
        backupJobId: 'job-clock',
        snapshotId: 'snap-clock',
        verificationType: over.type ?? 'integrity',
        status: 'running',
        startedAt,
        completedAt: null,
        restoreTimeSeconds: null,
        filesVerified: 0,
        filesFailed: 0,
        sizeBytes: null,
        details: { source: 'test', commandId: COMMAND, ...(over.details ?? {}) },
        createdAt: startedAt,
      };
    }

    function commandRow(over: { status: string; executedAgoMs: number | null; completedAgoMs?: number | null }) {
      return {
        id: COMMAND,
        status: over.status,
        executedAt: over.executedAgoMs === null ? null : new Date(Date.now() - over.executedAgoMs),
        completedAt: over.completedAgoMs == null ? null : new Date(Date.now() - over.completedAgoMs),
      };
    }

    function routeCommandUpdate(returning: unknown[]) {
      const where = vi.fn(() => ({ returning: vi.fn().mockResolvedValue(returning) }));
      const set = vi.fn(() => ({ where }));
      updateMock.mockReturnValue({ set });
      return { set, where };
    }

    afterEach(() => {
      verificationOrgById.delete('verify-clock');
      const index = backupVerifications.findIndex((row) => row.id === 'verify-clock');
      if (index >= 0) backupVerifications.splice(index, 1);
    });

    // The production failure: delivery deferred ~25 min while the file index
    // hydrated. Started 2h10m ago but claimed 1h45m ago: inside its 2h budget.
    it('does not count the wait before delivery against the budget', async () => {
      selectMock
        .mockReturnValueOnce(selectChain([dbVerificationRow({ startedAgoMs: 2 * HOUR + 10 * MIN })]))
        .mockReturnValueOnce(selectChain([commandRow({ status: 'sent', executedAgoMs: HOUR + 45 * MIN })]));

      expect(await timeoutStaleVerifications()).toBe(0);
      expect(updateMock).not.toHaveBeenCalled();
      expect(persistVerificationToDbMock).not.toHaveBeenCalled();
    });

    it('leaves a run inside its scaled budget alone long past the 2h base', async () => {
      selectMock
        .mockReturnValueOnce(selectChain([dbVerificationRow({ startedAgoMs: 5 * HOUR, details: { timeBudgetSeconds: 395 * 60 } })]))
        .mockReturnValueOnce(selectChain([commandRow({ status: 'sent', executedAgoMs: 4 * HOUR + 40 * MIN })]));

      expect(await timeoutStaleVerifications()).toBe(0);
      expect(updateMock).not.toHaveBeenCalled();
      expect(persistVerificationToDbMock).not.toHaveBeenCalled();
    });

    it('fails a run past its scaled budget with a CAS on the observed sent status and executed_at, and states the budget', async () => {
      const row = commandRow({ status: 'sent', executedAgoMs: 395 * MIN + VERIFICATION_TIMEOUT_GRACE_MS + MIN });
      selectMock
        .mockReturnValueOnce(selectChain([dbVerificationRow({ startedAgoMs: 7 * HOUR, details: { timeBudgetSeconds: 395 * 60 } })]))
        .mockReturnValueOnce(selectChain([row]));
      const { set, where } = routeCommandUpdate([{ id: COMMAND }]);

      expect(await timeoutStaleVerifications()).toBe(1);
      expect(set).toHaveBeenCalledWith(expect.objectContaining({
        status: 'failed',
        result: expect.objectContaining({ status: 'timeout', error: 'Verification timed out after 400 minutes' }),
      }));
      const { params, sql: sqlText } = compileWhere((where.mock.calls[0] as unknown[])[0]);
      expect(params).toEqual([
        'device_commands.id', COMMAND,
        'device_commands.status', 'sent',
        'device_commands.executed_at', row.executedAt,
      ]);
      expect(sqlText).not.toMatch(/ in \(/i);
      expect(persistVerificationToDbMock).toHaveBeenCalledWith(expect.objectContaining({
        id: 'verify-clock',
        status: 'failed',
        details: expect.objectContaining({
          reason: 'Verification timed out after 400 minutes',
          reasonCode: VERIFICATION_TIMEOUT_REASON_CODE,
          timeBudgetSeconds: 395 * 60,
        }),
      }));
    });

    // A successful result arriving between the scan and the write must win.
    it('does not fail the verification when the command CAS loses (claimed or completed in between)', async () => {
      selectMock
        .mockReturnValueOnce(selectChain([dbVerificationRow({ startedAgoMs: 4 * HOUR })]))
        .mockReturnValueOnce(selectChain([commandRow({ status: 'sent', executedAgoMs: PAST_BASE_MS })]));
      routeCommandUpdate([]);

      expect(await timeoutStaleVerifications()).toBe(0);
      expect(updateMock).toHaveBeenCalledTimes(1);
      expect(persistVerificationToDbMock).not.toHaveBeenCalled();
      expect(safePublishMock).not.toHaveBeenCalled();
    });

    it('fails a never-delivered command on the 2h undelivered clock with a CAS on pending + NULL executed_at', async () => {
      selectMock
        .mockReturnValueOnce(selectChain([dbVerificationRow({ startedAgoMs: PAST_BASE_MS, details: { timeBudgetSeconds: 12 * 3600 } })]))
        .mockReturnValueOnce(selectChain([commandRow({ status: 'pending', executedAgoMs: null })]));
      const { where } = routeCommandUpdate([{ id: COMMAND }]);

      expect(await timeoutStaleVerifications()).toBe(1);
      const { params, sql: sqlText } = compileWhere((where.mock.calls[0] as unknown[])[0]);
      expect(params).toEqual([
        'device_commands.id', COMMAND,
        'device_commands.status', 'pending',
        'device_commands.executed_at',
      ]);
      expect(sqlText).toMatch(/\$5 is null/i);
      expect(persistVerificationToDbMock).toHaveBeenCalledWith(expect.objectContaining({
        status: 'failed',
        details: expect.objectContaining({ reason: verificationTimeoutReason(2 * HOUR) }),
      }));
    });

    it('settles the verification of a command the reaper already failed, without writing the command', async () => {
      selectMock
        .mockReturnValueOnce(selectChain([dbVerificationRow({ startedAgoMs: 3 * HOUR })]))
        .mockReturnValueOnce(selectChain([commandRow({ status: 'failed', executedAgoMs: PAST_BASE_MS, completedAgoMs: 4 * MIN })]));

      expect(await timeoutStaleVerifications()).toBe(1);
      expect(updateMock).not.toHaveBeenCalled();
      expect(persistVerificationToDbMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'verify-clock', status: 'failed' }));
    });

    it('settles the verification of a missing command on the 2h clock from started_at', async () => {
      selectMock
        .mockReturnValueOnce(selectChain([dbVerificationRow({ startedAgoMs: PAST_BASE_MS, details: { timeBudgetSeconds: 12 * 3600 } })]))
        .mockReturnValueOnce(selectChain([]));

      expect(await timeoutStaleVerifications()).toBe(1);
      expect(updateMock).not.toHaveBeenCalled();
      expect(persistVerificationToDbMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'verify-clock', status: 'failed' }));
    });

    it('waits out the grace for a command that just completed (its result is being ingested), then settles', async () => {
      selectMock
        .mockReturnValueOnce(selectChain([dbVerificationRow({ startedAgoMs: 4 * HOUR })]))
        .mockReturnValueOnce(selectChain([commandRow({ status: 'completed', executedAgoMs: PAST_BASE_MS, completedAgoMs: MIN })]));
      expect(await timeoutStaleVerifications()).toBe(0);
      expect(persistVerificationToDbMock).not.toHaveBeenCalled();

      selectMock
        .mockReturnValueOnce(selectChain([dbVerificationRow({ startedAgoMs: 4 * HOUR })]))
        .mockReturnValueOnce(selectChain([commandRow({ status: 'completed', executedAgoMs: PAST_BASE_MS, completedAgoMs: VERIFICATION_TIMEOUT_GRACE_MS + MIN })]));
      expect(await timeoutStaleVerifications()).toBe(1);
      expect(updateMock).not.toHaveBeenCalled();
      expect(persistVerificationToDbMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'verify-clock', status: 'failed' }));
    });

    it('skips the pass when the command lookup fails (a failed lookup is not a missing command)', async () => {
      selectMock
        .mockReturnValueOnce(selectChain([dbVerificationRow({ startedAgoMs: 6 * HOUR })]))
        .mockImplementationOnce(() => { throw new Error('db down'); });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        expect(await timeoutStaleVerifications()).toBe(0);
        expect(updateMock).not.toHaveBeenCalled();
        expect(persistVerificationToDbMock).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it('loads every candidate command in one query', async () => {
      const second = '14141414-1414-4141-8141-141414141414';
      selectMock
        .mockReturnValueOnce(selectChain([
          dbVerificationRow({ startedAgoMs: 2 * HOUR + 10 * MIN }),
          { ...dbVerificationRow({ startedAgoMs: 2 * HOUR + 10 * MIN }), id: 'verify-clock-2', details: { commandId: second } },
        ]))
        .mockReturnValueOnce(selectChain([
          commandRow({ status: 'sent', executedAgoMs: HOUR }),
          { ...commandRow({ status: 'sent', executedAgoMs: HOUR }), id: second },
        ]));

      try {
        expect(await timeoutStaleVerifications()).toBe(0);
        expect(selectMock).toHaveBeenCalledTimes(2);
      } finally {
        verificationOrgById.delete('verify-clock-2');
      }
    });
  });

  // #11813: rows the timeout job failed before the reason code existed carry
  // only the old literal text. A late agent result must still find them, or
  // its counts are dropped as "No pending verification found".
  it.each([
    ['legacy text only', { reason: LEGACY_VERIFICATION_TIMEOUT_REASON }],
    ['reason code', { reason: 'Verification timed out after 125 minutes', reasonCode: VERIFICATION_TIMEOUT_REASON_CODE }],
  ])('applies a late agent result to a timed-out row identified by %s', async (_label, timeoutDetails) => {
    const orgId = 'org-late-result';
    const verificationId = 'verify-late-result';
    const commandId = '77777777-7777-4777-8777-777777777777';
    const startedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    backupVerifications.push({
      id: verificationId,
      orgId,
      deviceId: 'dev-late-result',
      backupJobId: 'job-late-result',
      snapshotId: 'snap-late-result',
      verificationType: 'integrity',
      status: 'failed',
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      restoreTimeSeconds: null,
      filesVerified: 0,
      filesFailed: 0,
      details: { source: 'test', commandId, ...timeoutDetails },
      createdAt: startedAt.toISOString(),
    });
    verificationOrgById.set(verificationId, orgId);
    // Force the in-memory fallback so the match logic itself is exercised.
    selectMock.mockImplementation(() => { throw new Error('db down'); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await processBackupVerificationResult(commandId, {
        status: 'completed',
        stdout: JSON.stringify({ snapshotId: 'snap-late-result', status: 'passed', filesVerified: 9, filesFailed: 0 }),
      });

      const persisted = (persistVerificationToDbMock.mock.calls.at(-1) as unknown[] | undefined)?.[0] as
        | { id: string; status: string; filesVerified: number; details: Record<string, unknown> }
        | undefined;
      expect(persisted?.id).toBe(verificationId);
      expect(persisted?.status).toBe('passed');
      expect(persisted?.filesVerified).toBe(9);
      // The authoritative result clears the timeout marker along with its text.
      expect(persisted?.details.reason).toBeUndefined();
      expect(persisted?.details.reasonCode).toBeUndefined();
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      selectMock.mockReset();
      const index = backupVerifications.findIndex((row) => row.id === verificationId);
      if (index >= 0) backupVerifications.splice(index, 1);
      verificationOrgById.delete(verificationId);
    }
  });

  it('writes the reason code on the no-orgId path too, and fails the command with the derived reason', async () => {
    const verificationId = 'verify-no-org';
    const commandId = '99999999-9999-4999-8999-999999999999';
    const startedAt = new Date(Date.now() - PAST_BASE_MS - 20 * MIN);
    backupVerifications.push({
      id: verificationId,
      orgId: '',
      deviceId: 'dev-no-org',
      backupJobId: 'job-no-org',
      snapshotId: 'snap-no-org',
      verificationType: 'test_restore',
      status: 'running',
      startedAt: startedAt.toISOString(),
      completedAt: null,
      restoreTimeSeconds: null,
      filesVerified: 0,
      filesFailed: 0,
      details: { source: 'test', commandId },
      createdAt: startedAt.toISOString(),
    });
    const setMock = vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: commandId }]) })),
    }));
    updateMock.mockReturnValue({ set: setMock });
    // No DB verification rows (memory path), then the command lookup.
    selectMock
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([
        { id: commandId, status: 'sent', executedAt: new Date(Date.now() - PAST_BASE_MS), completedAt: null },
      ]));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      expect(await timeoutStaleVerifications()).toBe(1);
      expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
        status: 'failed',
        result: expect.objectContaining({
          status: 'timeout',
          error: verificationTimeoutReason(2 * HOUR),
          timedOutBy: 'verification-timeout-check',
        }),
      }));
      expect(persistVerificationToDbMock).toHaveBeenCalledWith(expect.objectContaining({
        id: verificationId,
        status: 'failed',
        details: expect.objectContaining({
          reason: verificationTimeoutReason(2 * HOUR),
          reasonCode: VERIFICATION_TIMEOUT_REASON_CODE,
        }),
      }));
    } finally {
      warnSpy.mockRestore();
      const index = backupVerifications.findIndex((row) => row.id === verificationId);
      if (index >= 0) backupVerifications.splice(index, 1);
    }
  });

  it('clears the timeout code when a late agent result reports failure', async () => {
    const orgId = 'org-late-failure';
    const verificationId = 'verify-late-failure';
    const commandId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const startedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    backupVerifications.push({
      id: verificationId,
      orgId,
      deviceId: 'dev-late-failure',
      backupJobId: 'job-late-failure',
      snapshotId: 'snap-late-failure',
      verificationType: 'integrity',
      status: 'failed',
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      restoreTimeSeconds: null,
      filesVerified: 0,
      filesFailed: 0,
      details: { source: 'test', commandId, reason: verificationTimeoutReason(2 * HOUR), reasonCode: VERIFICATION_TIMEOUT_REASON_CODE },
      createdAt: startedAt.toISOString(),
    });
    verificationOrgById.set(verificationId, orgId);
    selectMock.mockImplementation(() => { throw new Error('db down'); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await processBackupVerificationResult(commandId, { status: 'failed', error: 'helper crashed' });

      const persisted = (persistVerificationToDbMock.mock.calls.at(-1) as unknown[] | undefined)?.[0] as
        | { id: string; details: Record<string, unknown> }
        | undefined;
      expect(persisted?.id).toBe(verificationId);
      expect(persisted?.details.reason).toBe('helper crashed');
      expect(persisted?.details.reasonCode).toBeUndefined();
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      selectMock.mockReset();
      const index = backupVerifications.findIndex((row) => row.id === verificationId);
      if (index >= 0) backupVerifications.splice(index, 1);
      verificationOrgById.delete(verificationId);
    }
  });

  it('does not treat a row failed for another reason as a timed-out one', async () => {
    const verificationId = 'verify-other-failure';
    const commandId = '88888888-8888-4888-8888-888888888888';
    const startedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    backupVerifications.push({
      id: verificationId,
      orgId: 'org-other-failure',
      deviceId: 'dev-other-failure',
      backupJobId: 'job-other-failure',
      snapshotId: 'snap-other-failure',
      verificationType: 'integrity',
      status: 'failed',
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      restoreTimeSeconds: null,
      filesVerified: 0,
      filesFailed: 0,
      details: { source: 'test', commandId, reason: 'Agent unreachable' },
      createdAt: startedAt.toISOString(),
    });
    verificationOrgById.set(verificationId, 'org-other-failure');
    selectMock.mockImplementation(() => { throw new Error('db down'); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await processBackupVerificationResult(commandId, {
        status: 'completed',
        stdout: JSON.stringify({ snapshotId: 'snap-other-failure', status: 'passed', filesVerified: 1, filesFailed: 0 }),
      });
      expect(persistVerificationToDbMock).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      selectMock.mockReset();
      const index = backupVerifications.findIndex((row) => row.id === verificationId);
      if (index >= 0) backupVerifications.splice(index, 1);
      verificationOrgById.delete(verificationId);
    }
  });

  it('post-backup checks call only the scheduled wrapper with the backup job ID', async () => {
    const orgId = 'org-scheduled-integrity';
    const jobId = 'job-scheduled-integrity';
    backupJobs.push({
      id: jobId,
      type: 'scheduled',
      deviceId: 'dev-scheduled-integrity',
      configId: 'cfg-1',
      snapshotId: 'provider-facing-snapshot-id',
      status: 'completed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    jobOrgById.set(jobId, orgId);

    try {
      await ensurePostBackupIntegrityChecks(orgId);

      expect(runScheduledBackupVerificationMock).toHaveBeenCalledWith({
        orgId,
        deviceId: 'dev-scheduled-integrity',
        verificationType: 'integrity',
        backupJobId: jobId,
        source: 'post-backup-integrity-check',
      });
      expect(runBackupVerificationMock).not.toHaveBeenCalled();
    } finally {
      backupJobs.splice(backupJobs.findIndex((job) => job.id === jobId), 1);
      jobOrgById.delete(jobId);
    }
  });

  it('weekly restore checks call only the scheduled wrapper and never pass provider snapshot IDs', async () => {
    const orgId = 'org-scheduled-restore';
    const jobId = 'job-scheduled-restore';
    backupJobs.push({
      id: jobId,
      type: 'scheduled',
      deviceId: 'dev-scheduled-restore',
      configId: 'cfg-1',
      snapshotId: 'provider-facing-snapshot-id',
      status: 'completed',
      completedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    jobOrgById.set(jobId, orgId);

    try {
      await runWeeklyTestRestore(orgId);

      expect(runScheduledBackupVerificationMock).toHaveBeenCalledWith({
        orgId,
        deviceId: 'dev-scheduled-restore',
        verificationType: 'test_restore',
        backupJobId: jobId,
        source: 'weekly-test-restore',
      });
      expect(runBackupVerificationMock).not.toHaveBeenCalled();
    } finally {
      backupJobs.splice(backupJobs.findIndex((job) => job.id === jobId), 1);
      jobOrgById.delete(jobId);
    }
  });
});
