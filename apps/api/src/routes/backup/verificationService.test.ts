import { beforeEach, describe, expect, it, vi } from 'vitest';
const publishEventMock = vi.fn(async (..._args: any[]) => 'event-id');

vi.mock('../../services/eventBus', () => ({
  publishEvent: (...args: any[]) => publishEventMock(...args),
}));

vi.mock('../../services/commandQueue', () => ({
  queueCommandForExecution: vi.fn(),
}));

import { recomputeRecoveryReadinessForDevice, runBackupVerification, processBackupVerificationResult, timeoutStaleVerifications } from './verificationService';
import { backupVerifications, verificationOrgById } from './store';
import { queueCommandForExecution } from '../../services/commandQueue';

describe('backup verification service', () => {
  beforeEach(() => {
    publishEventMock.mockClear();
    vi.mocked(queueCommandForExecution).mockReset();
  });

  it('rejects backupJobId/deviceId mismatches', async () => {
    await expect(runBackupVerification({
      orgId: 'org-123',
      deviceId: 'dev-001',
      backupJobId: 'job-002', // belongs to dev-002
      verificationType: 'integrity',
      source: 'test'
    })).rejects.toThrow('backupJobId does not belong to requested device');
  });

  it('rejects snapshotId/deviceId mismatches', async () => {
    await expect(runBackupVerification({
      orgId: 'org-123',
      deviceId: 'dev-001',
      snapshotId: 'snap-003', // belongs to dev-004
      verificationType: 'test_restore',
      source: 'test'
    })).rejects.toThrow('snapshotId does not belong to requested device');
  });

  it('deduplicates repeated low readiness events', async () => {
    const orgId = 'org-123';
    const deviceId = 'dev-low-test';

    await recomputeRecoveryReadinessForDevice(orgId, deviceId);
    await recomputeRecoveryReadinessForDevice(orgId, deviceId);

    const lowEvents = publishEventMock.mock.calls
      .filter((call) => call[0] === 'backup.recovery_readiness_low')
      .length;
    expect(lowEvents).toBe(1);
    await recomputeRecoveryReadinessForDevice(orgId, deviceId);
    const lowEventsAfter = publishEventMock.mock.calls
      .filter((call) => call[0] === 'backup.recovery_readiness_low')
      .length;
    expect(lowEventsAfter).toBe(1);
  });

  it('ignores simulated verifications when computing readiness', async () => {
    const orgId = 'org-123';
    const deviceId = `dev-sim-only-${Date.now()}`;

    backupVerifications.push({
      id: `verify-sim-${Date.now()}`,
      orgId,
      deviceId,
      backupJobId: 'job-001',
      snapshotId: 'snap-001',
      verificationType: 'test_restore',
      status: 'passed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      restoreTimeSeconds: 240,
      filesVerified: 100,
      filesFailed: 0,
      details: { source: 'test', simulated: true },
      createdAt: new Date().toISOString(),
    });

    const readiness = await recomputeRecoveryReadinessForDevice(orgId, deviceId);
    expect(readiness.readinessScore).toBe(0);
    expect(readiness.riskFactors.some((factor) => factor.code === 'no_verification_history')).toBe(true);
  });

  it('fails verification startup instead of fabricating a simulated result when dispatch is unavailable', async () => {
    const priorCount = backupVerifications.length;
    vi.mocked(queueCommandForExecution).mockResolvedValueOnce({
      error: 'Device is offline, cannot execute command',
    });

    await expect(runBackupVerification({
      orgId: 'org-123',
      deviceId: 'dev-001',
      verificationType: 'integrity',
      source: 'test'
    })).rejects.toThrow('Device is offline, cannot execute command');

    expect(backupVerifications.length).toBe(priorCount);
  });
});

describe('processBackupVerificationResult', () => {
  const TEST_ORG_ID = 'org-123';

  beforeEach(() => {
    publishEventMock.mockClear();
  });

  it('marks verification as passed on successful result', async () => {
    const testCommandId = `cmd-test-pass-${Date.now()}`;
    const verificationId = `verify-proc-pass-${Date.now()}`;

    backupVerifications.push({
      id: verificationId,
      orgId: TEST_ORG_ID,
      deviceId: 'dev-001',
      backupJobId: 'job-001',
      snapshotId: 'snap-001',
      verificationType: 'integrity',
      status: 'pending',
      startedAt: new Date().toISOString(),
      completedAt: null,
      filesVerified: 0,
      filesFailed: 0,
      details: { source: 'test', commandId: testCommandId },
      createdAt: new Date().toISOString(),
    });
    verificationOrgById.set(verificationId, TEST_ORG_ID);

    await processBackupVerificationResult(testCommandId, {
      status: 'completed',
      stdout: JSON.stringify({ status: 'passed', filesVerified: 45678, filesFailed: 0, sizeBytes: 321987654 }),
    });

    const updated = backupVerifications.find((v) => v.id === verificationId);
    expect(updated?.status).toBe('passed');
    expect(updated?.filesVerified).toBe(45678);

    const passedEvents = publishEventMock.mock.calls.filter((call) => call[0] === 'backup.verification_passed');
    expect(passedEvents.length).toBe(1);
    expect(passedEvents[0]![1]).toBe(TEST_ORG_ID);
  });

  it('marks verification as failed on failed agent command', async () => {
    const testCommandId = `cmd-test-fail-${Date.now()}`;
    const verificationId = `verify-proc-fail-${Date.now()}`;

    backupVerifications.push({
      id: verificationId,
      orgId: TEST_ORG_ID,
      deviceId: 'dev-001',
      backupJobId: 'job-001',
      snapshotId: null,
      verificationType: 'integrity',
      status: 'pending',
      startedAt: new Date().toISOString(),
      completedAt: null,
      filesVerified: 0,
      filesFailed: 0,
      details: { source: 'test', commandId: testCommandId },
      createdAt: new Date().toISOString(),
    });
    verificationOrgById.set(verificationId, TEST_ORG_ID);

    await processBackupVerificationResult(testCommandId, {
      status: 'failed',
      error: 'Agent unreachable',
    });

    const updated = backupVerifications.find((v) => v.id === verificationId);
    expect(updated?.status).toBe('failed');
    expect((updated?.details as Record<string, unknown>)?.reason).toBe('Agent unreachable');

    const failedEvents = publishEventMock.mock.calls.filter((call) => call[0] === 'backup.verification_failed');
    expect(failedEvents.length).toBe(1);
  });

  it('marks verification as failed when stdout contains invalid JSON', async () => {
    const testCommandId = `cmd-test-json-${Date.now()}`;
    const verificationId = `verify-proc-json-${Date.now()}`;

    backupVerifications.push({
      id: verificationId,
      orgId: TEST_ORG_ID,
      deviceId: 'dev-001',
      backupJobId: 'job-001',
      snapshotId: null,
      verificationType: 'integrity',
      status: 'pending',
      startedAt: new Date().toISOString(),
      completedAt: null,
      filesVerified: 0,
      filesFailed: 0,
      details: { source: 'test', commandId: testCommandId },
      createdAt: new Date().toISOString(),
    });
    verificationOrgById.set(verificationId, TEST_ORG_ID);

    await processBackupVerificationResult(testCommandId, {
      status: 'completed',
      stdout: 'not json',
    });

    const updated = backupVerifications.find((v) => v.id === verificationId);
    expect(updated?.status).toBe('failed');
    expect(String((updated?.details as Record<string, unknown>)?.reason)).toContain('Malformed verification result payload');

    const failedEvents = publishEventMock.mock.calls.filter((call) => call[0] === 'backup.verification_failed');
    expect(failedEvents.length).toBe(1);
  });

  it('marks verification as failed when parsed stdout does not match the expected schema', async () => {
    const testCommandId = `cmd-test-schema-${Date.now()}`;
    const verificationId = `verify-proc-schema-${Date.now()}`;

    backupVerifications.push({
      id: verificationId,
      orgId: TEST_ORG_ID,
      deviceId: 'dev-001',
      backupJobId: 'job-001',
      snapshotId: null,
      verificationType: 'integrity',
      status: 'pending',
      startedAt: new Date().toISOString(),
      completedAt: null,
      filesVerified: 0,
      filesFailed: 0,
      details: { source: 'test', commandId: testCommandId },
      createdAt: new Date().toISOString(),
    });
    verificationOrgById.set(verificationId, TEST_ORG_ID);

    await processBackupVerificationResult(testCommandId, {
      status: 'completed',
      stdout: JSON.stringify({ filesVerified: 7 }),
    });

    const updated = backupVerifications.find((v) => v.id === verificationId);
    expect(updated?.status).toBe('failed');
    expect(String((updated?.details as Record<string, unknown>)?.reason)).toContain('Malformed verification result payload');
  });

  it('does not crash when no pending verification matches the commandId', async () => {
    await expect(
      processBackupVerificationResult('cmd-no-match-xyz', { status: 'completed', stdout: '{}' })
    ).resolves.toBeUndefined();
  });
});

describe('timeoutStaleVerifications', () => {
  const TEST_ORG_ID = 'org-123';

  beforeEach(() => {
    publishEventMock.mockClear();
  });

  it('times out a verification that has been pending for more than 30 minutes', async () => {
    const verificationId = `verify-timeout-stale-${Date.now()}`;
    const staleStartedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();

    backupVerifications.push({
      id: verificationId,
      orgId: TEST_ORG_ID,
      deviceId: 'dev-001',
      backupJobId: 'job-001',
      snapshotId: null,
      verificationType: 'integrity',
      status: 'pending',
      startedAt: staleStartedAt,
      completedAt: null,
      filesVerified: 0,
      filesFailed: 0,
      details: { source: 'test', commandId: `cmd-stale-${Date.now()}` },
      createdAt: staleStartedAt,
    });
    verificationOrgById.set(verificationId, TEST_ORG_ID);

    const count = await timeoutStaleVerifications();
    expect(count).toBeGreaterThanOrEqual(1);

    const updated = backupVerifications.find((v) => v.id === verificationId);
    expect(updated?.status).toBe('failed');
    expect((updated?.details as Record<string, unknown>)?.reason).toBe('Verification timed out after 30 minutes');
  });

  it('does not time out a verification that started only 5 minutes ago', async () => {
    const verificationId = `verify-timeout-recent-${Date.now()}`;
    const recentStartedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    backupVerifications.push({
      id: verificationId,
      orgId: TEST_ORG_ID,
      deviceId: 'dev-001',
      backupJobId: 'job-001',
      snapshotId: null,
      verificationType: 'integrity',
      status: 'pending',
      startedAt: recentStartedAt,
      completedAt: null,
      filesVerified: 0,
      filesFailed: 0,
      details: { source: 'test', commandId: `cmd-recent-${Date.now()}` },
      createdAt: recentStartedAt,
    });
    verificationOrgById.set(verificationId, TEST_ORG_ID);

    await timeoutStaleVerifications();

    const updated = backupVerifications.find((v) => v.id === verificationId);
    expect(updated?.status).toBe('pending');
  });
});
