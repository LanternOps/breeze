import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectMock, resolveAssignedMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  resolveAssignedMock: vi.fn(),
}));

vi.mock('../../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db')>();
  return {
    ...actual,
    db: { ...actual.db, select: (...args: unknown[]) => selectMock(...args) },
    withSystemDbAccessContext: async (fn: () => unknown) => fn(),
  };
});

vi.mock('../../services/featureConfigResolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/featureConfigResolver')>();
  return {
    ...actual,
    resolveAllBackupAssignedDevices: (...args: unknown[]) => resolveAssignedMock(...args),
  };
});

vi.mock('../../services/eventBus', () => ({ publishEvent: vi.fn() }));

import {
  getBackupHealthSummary,
  listBackupVerifications,
  listRecoveryReadiness,
} from './verificationService';
import {
  backupVerifications,
  recoveryReadinessOrgById,
  recoveryReadinessRecords,
  verificationOrgById,
} from './store';

const orgId = '11111111-1111-4111-8111-111111111111';
const deviceId = '33333333-3333-4333-8333-333333333333';
const siteId = '55555555-5555-4555-8555-555555555555';

describe('backup verification selected-site database failure', () => {
  beforeEach(() => {
    selectMock.mockReset();
    selectMock.mockImplementation(() => {
      throw new Error('selected-site database unavailable');
    });
    resolveAssignedMock.mockReset();
    resolveAssignedMock.mockResolvedValue([{ deviceId }]);
  });

  it('does not fall back to in-memory verification rows', async () => {
    const verificationId = '22222222-2222-4222-8222-222222222222';
    backupVerifications.push({
      id: verificationId,
      orgId,
      deviceId,
      backupJobId: '44444444-4444-4444-8444-444444444444',
      verificationType: 'integrity',
      status: 'passed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      filesVerified: 1,
      filesFailed: 0,
      details: { restorePath: '/must-not-fallback' },
      createdAt: new Date().toISOString(),
    });
    verificationOrgById.set(verificationId, orgId);

    try {
      await expect(listBackupVerifications(orgId, { allowedSiteIds: [siteId] }))
        .resolves.toEqual([]);
    } finally {
      verificationOrgById.delete(verificationId);
      backupVerifications.splice(backupVerifications.findIndex((row) => row.id === verificationId), 1);
    }
  });

  it('does not fall back to in-memory readiness rows', async () => {
    const readinessId = '66666666-6666-4666-8666-666666666666';
    recoveryReadinessRecords.push({
      id: readinessId,
      orgId,
      deviceId,
      readinessScore: 99,
      estimatedRtoMinutes: null,
      estimatedRpoMinutes: null,
      riskFactors: [],
      calculatedAt: new Date().toISOString(),
    });
    recoveryReadinessOrgById.set(readinessId, orgId);

    try {
      await expect(listRecoveryReadiness(orgId, [siteId])).resolves.toEqual([]);
    } finally {
      recoveryReadinessOrgById.delete(readinessId);
      recoveryReadinessRecords.splice(recoveryReadinessRecords.findIndex((row) => row.id === readinessId), 1);
    }
  });

  it('returns a zero-safe health summary without leaking assigned devices', async () => {
    const health = await getBackupHealthSummary(orgId, [siteId]);

    expect(health).toEqual({
      verification: {
        total: 0,
        passedLast24h: 0,
        failedLast24h: 0,
        partialLast24h: 0,
        coveragePercent: 100,
      },
      readiness: {
        averageScore: 0,
        lowReadinessCount: 0,
        criticalDevicesAtRisk: 0,
      },
      escalations: {
        verificationFailures: 0,
        criticalVerificationFailures: 0,
      },
    });
  });
});
