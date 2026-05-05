import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {
    update: vi.fn(),
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  },

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  backupJobs: {
    id: 'backupJobs.id',
    status: 'backupJobs.status',
    configId: 'backupJobs.configId',
    backupType: 'backupJobs.backupType',
    featureLinkId: 'backupJobs.featureLinkId',
    policyId: 'backupJobs.policyId',
    deviceId: 'backupJobs.deviceId',
  },
  backupSnapshots: {
    id: 'backupSnapshots.id',
    jobId: 'backupSnapshots.jobId',
    snapshotId: 'backupSnapshots.snapshotId',
    legalHold: 'backupSnapshots.legalHold',
    legalHoldReason: 'backupSnapshots.legalHoldReason',
    isImmutable: 'backupSnapshots.isImmutable',
    immutableUntil: 'backupSnapshots.immutableUntil',
    immutabilityEnforcement: 'backupSnapshots.immutabilityEnforcement',
    requestedImmutabilityEnforcement: 'backupSnapshots.requestedImmutabilityEnforcement',
    immutabilityFallbackReason: 'backupSnapshots.immutabilityFallbackReason',
    encryptionKeyId: 'backupSnapshots.encryptionKeyId',
  },
  backupSnapshotFiles: {
    snapshotDbId: 'backupSnapshotFiles.snapshotDbId',
  },
  backupPolicies: {
    id: 'backupPolicies.id',
    legalHold: 'backupPolicies.legalHold',
    legalHoldReason: 'backupPolicies.legalHoldReason',
  },
  backupConfigs: {
    id: 'backupConfigs.id',
    provider: 'backupConfigs.provider',
    providerConfig: 'backupConfigs.providerConfig',
  },
  configPolicyBackupSettings: {
    featureLinkId: 'configPolicyBackupSettings.featureLinkId',
    retention: 'configPolicyBackupSettings.retention',
  },
}));

vi.mock('../db/schema/applicationBackup', () => ({
  backupChains: {
    id: 'backupChains.id',
    orgId: 'backupChains.orgId',
    deviceId: 'backupChains.deviceId',
    configId: 'backupChains.configId',
    chainType: 'backupChains.chainType',
    targetName: 'backupChains.targetName',
    targetId: 'backupChains.targetId',
    fullSnapshotId: 'backupChains.fullSnapshotId',
    chainMetadata: 'backupChains.chainMetadata',
  },
}));

vi.mock('../jobs/backupRetention', () => ({
  applyGfsTagsToSnapshot: vi.fn(),
  computeExpiresAt: vi.fn(),
  resolveGfsConfigForJob: vi.fn(),
}));

vi.mock('./backupSnapshotStorage', () => ({
  applyBackupSnapshotImmutability: vi.fn(),
  checkBackupProviderCapabilities: vi.fn(),
}));

const resolveBackupProtectionForDeviceMock = vi.fn();
vi.mock('./featureConfigResolver', () => ({
  resolveBackupProtectionForDevice: (...args: unknown[]) =>
    resolveBackupProtectionForDeviceMock(...(args as [])),
}));

import { db } from '../db';
import {
  applyBackupCommandResultToJob,
  markBackupJobFailedIfInFlight,
} from './backupResultPersistence';
import {
  applyGfsTagsToSnapshot,
  computeExpiresAt,
  resolveGfsConfigForJob,
} from '../jobs/backupRetention';
import { applyBackupSnapshotImmutability } from './backupSnapshotStorage';
import { checkBackupProviderCapabilities } from './backupSnapshotStorage';

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

describe('backup result persistence', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resolveBackupProtectionForDeviceMock.mockReset();
  });

  it('ignores stale backup job results when the job is no longer in flight', async () => {
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    const result = await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      result: {
        snapshotId: 'provider-snap-1',
        filesBackedUp: 4,
      },
    });

    expect(result).toEqual({
      applied: false,
      snapshotDbId: null,
      providerSnapshotId: 'provider-snap-1',
    });
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('marks a backup job failed only while it is still pending or running', async () => {
    const returning = vi.fn().mockResolvedValueOnce([{ id: 'job-1' }]).mockResolvedValueOnce([]);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning,
        }),
      }),
    } as any);

    await expect(markBackupJobFailedIfInFlight('job-1', 'boom')).resolves.toBe(true);
    await expect(markBackupJobFailedIfInFlight('job-1', 'boom')).resolves.toBe(false);
  });

  it('stamps snapshot protection settings from the winning backup feature link', async () => {
    resolveBackupProtectionForDeviceMock.mockResolvedValueOnce({
      legalHold: true,
      legalHoldReason: 'Regulatory hold',
      immutabilityMode: 'application',
      immutableDays: 45,
      sourceFeatureLinkIds: ['feature-1'],
    });
    vi.mocked(db.update)
      .mockReturnValueOnce(chainMock([{ id: 'job-1', configId: 'config-1', backupType: 'file' }]) as any)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([]) as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([{ featureLinkId: 'feature-1', policyId: null, deviceId: 'device-1' }]) as any);
    vi.mocked(db.insert).mockReturnValueOnce(chainMock([{
      id: 'snapshot-db-1',
      jobId: 'job-1',
      snapshotId: 'provider-snap-1',
    }]) as any);
    vi.mocked(applyGfsTagsToSnapshot).mockResolvedValue({ daily: true });
    vi.mocked(resolveGfsConfigForJob).mockResolvedValue(null);
    vi.mocked(computeExpiresAt).mockReturnValue(null);
    vi.mocked(checkBackupProviderCapabilities).mockResolvedValue({
      objectLock: {
        supported: true,
        error: null,
      },
    });

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      result: {
        snapshotId: 'provider-snap-1',
        filesBackedUp: 4,
        metadata: {
          encryptionKeyId: '11111111-1111-4111-8111-111111111111',
        },
      },
    });

    const insertValues = vi.mocked(db.insert).mock.results[0]?.value?.values;
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      encryptionKeyId: '11111111-1111-4111-8111-111111111111',
    }));

    expect(db.update).toHaveBeenNthCalledWith(2, expect.anything());
    const protectionSet = vi.mocked(db.update).mock.results[1]?.value?.set;
    expect(protectionSet).toHaveBeenCalledWith(expect.objectContaining({
      legalHold: true,
      legalHoldReason: 'Regulatory hold',
      isImmutable: true,
      immutabilityEnforcement: 'application',
      requestedImmutabilityEnforcement: 'application',
      immutabilityFallbackReason: null,
      immutableUntil: expect.any(Date),
      metadata: expect.objectContaining({
        snapshotProtection: expect.objectContaining({
          legalHoldSource: 'policy',
        }),
      }),
    }));
  });

  it('applies provider immutability when the winning feature link requests it', async () => {
    resolveBackupProtectionForDeviceMock.mockResolvedValueOnce({
      legalHold: false,
      legalHoldReason: null,
      immutabilityMode: 'provider',
      immutableDays: 14,
      sourceFeatureLinkIds: ['feature-1'],
    });
    vi.mocked(db.update)
      .mockReturnValueOnce(chainMock([{ id: 'job-1', configId: 'config-1', backupType: 'file' }]) as any)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([]) as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([{ featureLinkId: 'feature-1', policyId: null, deviceId: 'device-1' }]) as any)
      .mockReturnValueOnce(chainMock([{
        provider: 's3',
        providerConfig: { bucket: 'backups', region: 'us-east-1' },
      }]) as any);
    vi.mocked(db.insert).mockReturnValueOnce(chainMock([{
      id: 'snapshot-db-1',
      jobId: 'job-1',
      snapshotId: 'provider-snap-1',
    }]) as any);
    vi.mocked(applyGfsTagsToSnapshot).mockResolvedValue({ daily: true });
    vi.mocked(resolveGfsConfigForJob).mockResolvedValue(null);
    vi.mocked(computeExpiresAt).mockReturnValue(null);
    vi.mocked(checkBackupProviderCapabilities).mockResolvedValue({
      objectLock: {
        supported: true,
        error: null,
      },
    });
    vi.mocked(applyBackupSnapshotImmutability).mockResolvedValue({
      enforcement: 'provider',
      objectCount: 3,
    });

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      result: {
        snapshotId: 'provider-snap-1',
        filesBackedUp: 4,
      },
    });

    expect(applyBackupSnapshotImmutability).toHaveBeenCalledWith(expect.objectContaining({
      provider: 's3',
      snapshotId: 'provider-snap-1',
      retainUntil: expect.any(Date),
    }));
    const protectionSet = vi.mocked(db.update).mock.results[1]?.value?.set;
    expect(protectionSet).toHaveBeenCalledWith(expect.objectContaining({
      isImmutable: true,
      immutabilityEnforcement: 'provider',
      requestedImmutabilityEnforcement: 'provider',
      immutabilityFallbackReason: null,
      immutableUntil: expect.any(Date),
    }));
  });

  it('falls back to application immutability when provider locking fails', async () => {
    resolveBackupProtectionForDeviceMock.mockResolvedValueOnce({
      legalHold: false,
      legalHoldReason: null,
      immutabilityMode: 'provider',
      immutableDays: 30,
      sourceFeatureLinkIds: ['feature-1'],
    });
    vi.mocked(db.update)
      .mockReturnValueOnce(chainMock([{ id: 'job-1', configId: 'config-1', backupType: 'file' }]) as any)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([]) as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([{ featureLinkId: 'feature-1', policyId: null, deviceId: 'device-1' }]) as any)
      .mockReturnValueOnce(chainMock([{
        provider: 's3',
        providerConfig: { bucket: 'backups', region: 'us-east-1' },
      }]) as any);
    vi.mocked(db.insert).mockReturnValueOnce(chainMock([{
      id: 'snapshot-db-1',
      jobId: 'job-1',
      snapshotId: 'provider-snap-1',
    }]) as any);
    vi.mocked(applyGfsTagsToSnapshot).mockResolvedValue({ daily: true });
    vi.mocked(resolveGfsConfigForJob).mockResolvedValue(null);
    vi.mocked(computeExpiresAt).mockReturnValue(null);
    vi.mocked(checkBackupProviderCapabilities).mockResolvedValue({
      objectLock: {
        supported: true,
        error: null,
      },
    });
    vi.mocked(applyBackupSnapshotImmutability).mockRejectedValue(new Error('Object lock unavailable'));

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      result: {
        snapshotId: 'provider-snap-1',
        filesBackedUp: 4,
      },
    });

    const protectionSet = vi.mocked(db.update).mock.results[1]?.value?.set;
    expect(protectionSet).toHaveBeenCalledWith(expect.objectContaining({
      isImmutable: true,
      immutabilityEnforcement: 'application',
      requestedImmutabilityEnforcement: 'provider',
      immutabilityFallbackReason: 'Object lock unavailable',
      immutableUntil: expect.any(Date),
    }));
  });

  it('falls back immediately when the runtime capability re-check fails', async () => {
    resolveBackupProtectionForDeviceMock.mockResolvedValueOnce({
      legalHold: false,
      legalHoldReason: null,
      immutabilityMode: 'provider',
      immutableDays: 30,
      sourceFeatureLinkIds: ['feature-1'],
    });
    vi.mocked(db.update)
      .mockReturnValueOnce(chainMock([{ id: 'job-1', configId: 'config-1', backupType: 'file' }]) as any)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([]) as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([{ featureLinkId: 'feature-1', policyId: null, deviceId: 'device-1' }]) as any)
      .mockReturnValueOnce(chainMock([{
        provider: 's3',
        providerConfig: { bucket: 'backups', region: 'us-east-1' },
      }]) as any);
    vi.mocked(db.insert).mockReturnValueOnce(chainMock([{
      id: 'snapshot-db-1',
      jobId: 'job-1',
      snapshotId: 'provider-snap-1',
    }]) as any);
    vi.mocked(applyGfsTagsToSnapshot).mockResolvedValue({ daily: true });
    vi.mocked(resolveGfsConfigForJob).mockResolvedValue(null);
    vi.mocked(computeExpiresAt).mockReturnValue(null);
    vi.mocked(checkBackupProviderCapabilities).mockResolvedValue({
      objectLock: {
        supported: false,
        error: 'Bucket object lock no longer enabled',
      },
    });

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      result: {
        snapshotId: 'provider-snap-1',
        filesBackedUp: 4,
      },
    });

    expect(applyBackupSnapshotImmutability).not.toHaveBeenCalled();
    const protectionSet = vi.mocked(db.update).mock.results[1]?.value?.set;
    expect(protectionSet).toHaveBeenCalledWith(expect.objectContaining({
      isImmutable: true,
      immutabilityEnforcement: 'application',
      requestedImmutabilityEnforcement: 'provider',
      immutabilityFallbackReason: 'Bucket object lock no longer enabled',
      immutableUntil: expect.any(Date),
    }));
  });
});
