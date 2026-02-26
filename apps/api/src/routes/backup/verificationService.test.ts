import { beforeEach, describe, expect, it, vi } from 'vitest';
const publishEventMock = vi.fn(async () => 'event-id');

vi.mock('../../services/eventBus', () => ({
  publishEvent: (...args: unknown[]) => publishEventMock(...args),
}));

import { recomputeRecoveryReadinessForDevice, runBackupVerification } from './verificationService';

describe('backup verification service', () => {
  beforeEach(() => {
    publishEventMock.mockClear();
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
});
