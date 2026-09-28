import { beforeEach, describe, expect, it, vi } from 'vitest';

const publishEventMock = vi.fn(async (..._args: any[]) => 'event-id');

vi.mock('../../services/eventBus', () => ({
  publishEvent: (...args: any[]) => publishEventMock(...args),
}));

import { recomputeRecoveryReadinessForDevice } from './readinessCalculator';
import { addBackupVerification, backupVerifications, verificationOrgById } from './store';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('recomputeRecoveryReadinessForDevice — restore-proof scoring (#3970)', () => {
  beforeEach(() => {
    publishEventMock.mockClear();
  });

  /**
   * Regression coverage for #3970: a device with no `test_restore` rows must
   * not be double-charged — once by zeroing the 30-point restoreQuality band,
   * and again by MISSING_RESTORE_PROOF_PENALTY. The penalty alone should
   * carry the cost of missing restore proof.
   */
  it.each([
    {
      name: 'no restore tests + perfect otherwise (integrity passed, fresh, no failures) -> 80',
      rows: [
        { verificationType: 'integrity' as const, status: 'passed' as const, ageDays: 0 },
      ],
      expectedScore: 80,
      expectMissingRestoreRisk: true,
    },
    {
      name: 'no restore tests + a failure -> well below the 70 threshold',
      rows: [
        { verificationType: 'integrity' as const, status: 'failed' as const, ageDays: 0 },
      ],
      expectedScore: 19,
      expectMissingRestoreRisk: true,
    },
    {
      name: 'restore test present, recent (within 30d) -> unchanged baseline (100)',
      rows: [
        { verificationType: 'test_restore' as const, status: 'passed' as const, ageDays: 0, restoreTimeSeconds: 240 },
      ],
      expectedScore: 100,
      expectMissingRestoreRisk: false,
    },
    {
      name: 'restore test present but stale (40d old) -> restoreQuality unaffected, penalty still applies -> 66',
      rows: [
        { verificationType: 'test_restore' as const, status: 'passed' as const, ageDays: 40, restoreTimeSeconds: 240 },
      ],
      expectedScore: 66,
      expectMissingRestoreRisk: true,
    },
  ])('$name', async ({ rows, expectedScore, expectMissingRestoreRisk }) => {
    const orgId = `org-restore-proof-${Date.now()}-${Math.random()}`;
    const deviceId = `dev-restore-proof-${Date.now()}-${Math.random()}`;
    const insertedIds: string[] = [];

    try {
      for (const row of rows) {
        const completedAt = new Date(Date.now() - row.ageDays * DAY_MS).toISOString();
        const inserted = addBackupVerification({
          orgId,
          deviceId,
          backupJobId: 'job-restore-proof',
          snapshotId: 'snap-restore-proof',
          verificationType: row.verificationType,
          status: row.status,
          startedAt: completedAt,
          completedAt,
          restoreTimeSeconds: 'restoreTimeSeconds' in row ? row.restoreTimeSeconds : undefined,
          filesVerified: row.status === 'passed' ? 10 : 0,
          filesFailed: row.status === 'failed' ? 1 : 0,
          details: { source: 'test' },
        }, orgId);
        insertedIds.push(inserted.id);
      }

      const readiness = await recomputeRecoveryReadinessForDevice(orgId, deviceId);

      expect(readiness.readinessScore).toBe(expectedScore);
      expect(
        readiness.riskFactors.some((factor) => factor.code === 'restore_test_missing')
      ).toBe(expectMissingRestoreRisk);
    } finally {
      for (const id of insertedIds) {
        const index = backupVerifications.findIndex((v) => v.id === id);
        if (index >= 0) backupVerifications.splice(index, 1);
        verificationOrgById.delete(id);
      }
    }
  });
});
