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

describe('recomputeRecoveryReadinessForDevice — in-flight verifications (#7495)', () => {
  const MINUTE_MS = 60 * 1000;

  async function scoreWith(
    rows: Array<{ verificationType: 'integrity' | 'test_restore'; status: 'passed' | 'failed' | 'pending' | 'running'; ageMs: number; restoreTimeSeconds?: number }>
  ) {
    const orgId = `org-inflight-${Date.now()}-${Math.random()}`;
    const deviceId = `dev-inflight-${Date.now()}-${Math.random()}`;
    const ids: string[] = [];
    try {
      for (const row of rows) {
        const startedAt = new Date(Date.now() - row.ageMs).toISOString();
        const inFlight = row.status === 'pending' || row.status === 'running';
        const inserted = addBackupVerification({
          orgId,
          deviceId,
          backupJobId: 'job-inflight',
          snapshotId: 'snap-inflight',
          verificationType: row.verificationType,
          status: row.status,
          startedAt,
          completedAt: inFlight ? undefined : startedAt,
          restoreTimeSeconds: row.restoreTimeSeconds,
          filesVerified: 0,
          filesFailed: row.status === 'failed' ? 1 : 0,
          details: { source: 'test' },
        }, orgId);
        ids.push(inserted.id);
      }
      return await recomputeRecoveryReadinessForDevice(orgId, deviceId);
    } finally {
      for (const id of ids) {
        const index = backupVerifications.findIndex((v) => v.id === id);
        if (index >= 0) backupVerifications.splice(index, 1);
        verificationOrgById.delete(id);
      }
    }
  }

  const history = [
    { verificationType: 'test_restore' as const, status: 'passed' as const, ageMs: 2 * DAY_MS, restoreTimeSeconds: 240 },
  ];

  it('pending/running verifications do not lower the score', async () => {
    const baseline = await scoreWith(history);
    const withInFlight = await scoreWith([
      { verificationType: 'integrity', status: 'pending', ageMs: 2 * MINUTE_MS },
      { verificationType: 'test_restore', status: 'running', ageMs: 2 * MINUTE_MS },
      ...history,
    ]);
    expect(withInFlight.readinessScore).toBe(baseline.readinessScore);
    expect(withInFlight.riskFactors.some((f) => f.code === 'recent_verification_failure')).toBe(false);
  });

  it('only in-flight rows -> no failure charged', async () => {
    const readiness = await scoreWith([
      { verificationType: 'integrity', status: 'pending', ageMs: 2 * MINUTE_MS },
    ]);
    expect(readiness.riskFactors.some((f) => f.code === 'recent_verification_failure')).toBe(false);
    expect(readiness.riskFactors.some((f) => f.code === 'no_verification_history')).toBe(true);
  });

  it('a stuck in-flight verification past the timeout counts as failed', async () => {
    const baseline = await scoreWith(history);
    const stuck = await scoreWith([
      { verificationType: 'integrity', status: 'pending', ageMs: 45 * MINUTE_MS },
      ...history,
    ]);
    expect(stuck.readinessScore).toBeLessThan(baseline.readinessScore);
    expect(stuck.riskFactors.some((f) => f.code === 'recent_verification_failure')).toBe(true);
  });
});
